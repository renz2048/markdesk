//! 导出：HTML 直接写文件；Word/OpenOffice/Epub/LaTeX/MediaWiki 走系统
//! Pandoc；PDF/图像经隐藏 WebView 加载导出 HTML 后调用 WebView2 的
//! CDP（Page.printToPDF / Page.captureScreenshot）渲染成文件。

use crate::service::ServiceError;
use rand::RngCore;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

const PANDOC_TARGETS: [(&str, &str, &str); 5] = [
    ("docx", "docx", "docx"),
    ("odt", "odt", "odt"),
    ("epub", "epub", "epub"),
    ("latex", "latex", "tex"),
    ("mediawiki", "mediawiki", "txt"),
];

fn err(code: &'static str, message: impl Into<String>) -> ServiceError {
    ServiceError::new(code, message.into())
}

fn resource_base() -> String {
    if cfg!(windows) {
        "http://markdesk-resource.localhost/".to_string()
    } else {
        "markdesk-resource://localhost/".to_string()
    }
}

#[cfg(windows)]
mod webview2 {
    use std::sync::mpsc;
    use std::time::Duration;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2CallDevToolsProtocolMethodCompletedHandler,
        ICoreWebView2CallDevToolsProtocolMethodCompletedHandler_Impl,
        ICoreWebView2ExecuteScriptCompletedHandler,
        ICoreWebView2ExecuteScriptCompletedHandler_Impl,
    };
    use windows_core::{implement, HRESULT, HSTRING, PCWSTR};

    #[implement(ICoreWebView2ExecuteScriptCompletedHandler)]
    pub struct ScriptHandler {
        sender: mpsc::Sender<Result<String, String>>,
    }

    impl ICoreWebView2ExecuteScriptCompletedHandler_Impl for ScriptHandler_Impl {
        fn Invoke(&self, errorcode: HRESULT, result: &PCWSTR) -> windows_core::Result<()> {
            let message = if errorcode.is_ok() {
                unsafe { Ok(result.to_string()?.to_string()) }
            } else {
                Err(format!("script failed: 0x{:x}", errorcode.0))
            };
            let _ = self.sender.send(message);
            Ok(())
        }
    }

    #[implement(ICoreWebView2CallDevToolsProtocolMethodCompletedHandler)]
    pub struct CdpHandler {
        sender: mpsc::Sender<Result<String, String>>,
    }

    impl ICoreWebView2CallDevToolsProtocolMethodCompletedHandler_Impl for CdpHandler_Impl {
        fn Invoke(&self, errorcode: HRESULT, returnjson: &PCWSTR) -> windows_core::Result<()> {
            let message = if errorcode.is_ok() {
                unsafe { Ok(returnjson.to_string()?.to_string()) }
            } else {
                Err(format!("cdp failed: 0x{:x}", errorcode.0))
            };
            let _ = self.sender.send(message);
            Ok(())
        }
    }

    pub fn execute_script(core: &ICoreWebView2, script: &str) -> Result<String, String> {
        let (sender, receiver) = mpsc::channel();
        let handler: ICoreWebView2ExecuteScriptCompletedHandler =
            ScriptHandler { sender }.into();
        unsafe {
            core.ExecuteScript(&HSTRING::from(script), &handler)
                .map_err(|error| error.to_string())?;
        }
        receiver
            .recv_timeout(Duration::from_secs(20))
            .map_err(|_| "script timeout".to_string())?
    }

    pub fn call_devtools(
        core: &ICoreWebView2,
        method: &str,
        parameters: &str,
    ) -> Result<String, String> {
        let (sender, receiver) = mpsc::channel();
        let handler: ICoreWebView2CallDevToolsProtocolMethodCompletedHandler =
            CdpHandler { sender }.into();
        unsafe {
            core.CallDevToolsProtocolMethod(
                &HSTRING::from(method),
                &HSTRING::from(parameters),
                &handler,
            )
            .map_err(|error| error.to_string())?;
        }
        receiver
            .recv_timeout(Duration::from_secs(90))
            .map_err(|_| "cdp timeout".to_string())?
    }
}

/// 取窗口的 ICoreWebView2 并执行回调（在主线程上）。
#[cfg(windows)]
fn with_core<R: Send + 'static>(
    window: &tauri::WebviewWindow,
    run: impl FnOnce(&webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2) -> R + Send + 'static,
) -> Result<R, String> {
    let (sender, receiver) = mpsc::channel::<R>();
    let sender = std::sync::Mutex::new(sender);
    window
        .with_webview(move |webview| {
            let controller = unsafe { webview.controller() };
            if let Ok(core) = unsafe { controller.CoreWebView2() } {
                let _ = sender.lock().unwrap().send(run(&core));
            }
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(100))
        .map_err(|_| "导出渲染超时".to_string())
}

pub async fn render(
    handle: &AppHandle,
    format: &str,
    html: &str,
    default_name: &str,
    assets_dir: Option<&str>,
) -> Result<Option<String>, ServiceError> {
    if format != "pdf" && format != "png" {
        return Err(err("invalid-argument", "导出格式无效。"));
    }
    let extension = if format == "pdf" { "pdf" } else { "png" };
    let target = pick_save_path(handle, default_name, extension);
    let Some(target) = target else {
        return Ok(None);
    };

    // 临时 HTML 与文档同目录，协议按目录解析相对图片。
    let base_dir = assets_dir
        .and_then(|value| Path::new(value).parent().map(|parent| parent.to_path_buf()))
        .unwrap_or_else(std::env::temp_dir);
    let token = format!("{:016x}", rand::thread_rng().next_u64());
    let html_path = base_dir.join(format!(".markdesk-export-{token}.html"));
    std::fs::write(&html_path, html.as_bytes())
        .map_err(|_| err("write-failed", "导出临时文件写入失败。"))?;

    let outcome = run_export_webview(handle, &html_path, &token, format == "pdf").await;
    let _ = std::fs::remove_file(&html_path);

    match outcome {
        Ok(bytes) => {
            std::fs::write(&target, &bytes)
                .map_err(|_| err("write-failed", "导出文件写入失败。"))?;
            Ok(Some(target.to_string_lossy().to_string()))
        }
        Err(message) => Err(err("unexpected-error", message)),
    }
}

async fn run_export_webview(
    handle: &AppHandle,
    html_path: &Path,
    token: &str,
    pdf: bool,
) -> Result<Vec<u8>, String> {
    crate::commands::register_export_doc(handle, token, html_path.to_path_buf());
    let label = format!("export-{token}");
    let url = format!("{}export-html/{}/index.html", resource_base(), token);
    let parsed: tauri::Url = url.parse().map_err(|_| "invalid url".to_string())?;
    let window = WebviewWindowBuilder::new(handle, &label, WebviewUrl::External(parsed))
        .visible(false)
        .inner_size(1200.0, 1600.0)
        .build()
        .map_err(|error| format!("创建导出窗口失败：{error}"))?;

    // 等待页面加载完成。
    let mut ready = false;
    for _ in 0..100 {
        let probe = with_core(&window, |core| {
            webview2::execute_script(core, "document.readyState")
        });
        if matches!(&probe, Ok(Ok(state)) if state.trim_matches('"') == "complete") {
            ready = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    if !ready {
        let _ = window.destroy();
        return Err("导出页面加载超时".to_string());
    }

    let result = with_core(&window, move |core| unsafe {
        if pdf {
            print_to_pdf(core)
        } else {
            screenshot(core)
        }
    });
    let _ = window.destroy();
    result.and_then(|inner| inner)
}

#[cfg(windows)]
unsafe fn print_to_pdf(
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
) -> Result<Vec<u8>, String> {
    let json = webview2::call_devtools(
        core,
        "Page.printToPDF",
        r#"{"printBackground":true,"paperWidth":8.27,"paperHeight":11.69,"marginTop":0.4,"marginBottom":0.4,"marginLeft":0.4,"marginRight":0.4}"#,
    )?;
    decode_base64_payload(&json)
}

#[cfg(windows)]
unsafe fn screenshot(
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
) -> Result<Vec<u8>, String> {
    let _ = webview2::call_devtools(core, "Page.enable", "{}")?;
    // captureBeyondViewport 让 Chromium 先按整页尺寸调整视口再截图。
    let json = webview2::call_devtools(
        core,
        "Page.captureScreenshot",
        r#"{"format":"png","captureBeyondViewport":true}"#,
    )?;
    decode_base64_payload(&json)
}

fn decode_base64_payload(json: &str) -> Result<Vec<u8>, String> {
    let parsed: serde_json::Value =
        serde_json::from_str(json).map_err(|_| "CDP 返回无效".to_string())?;
    let data = parsed["data"].as_str().ok_or("CDP 返回缺少 data 字段")?;
    base64_decode(data).ok_or_else(|| "base64 解码失败".to_string())
}

/// 简易 base64 解码（避免额外依赖）。
fn base64_decode(input: &str) -> Option<Vec<u8>> {
    let mut table = [0u8; 256];
    for (index, byte) in
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
            .iter()
            .enumerate()
    {
        table[*byte as usize] = index as u8;
    }
    let mut buffer = Vec::with_capacity(input.len() / 4 * 3);
    let mut chunk = [0u8; 4];
    let mut filled = 0;
    for character in input.bytes() {
        if character == b'=' || character == b'\n' || character == b'\r' {
            continue;
        }
        chunk[filled] = table[character as usize];
        filled += 1;
        if filled == 4 {
            let merged = (u32::from(chunk[0]) << 18)
                | (u32::from(chunk[1]) << 12)
                | (u32::from(chunk[2]) << 6)
                | u32::from(chunk[3]);
            buffer.extend_from_slice(&merged.to_be_bytes()[1..]);
            filled = 0;
        }
    }
    match filled {
        2 => {
            let merged = (u32::from(chunk[0]) << 18) | (u32::from(chunk[1]) << 12);
            buffer.extend_from_slice(&merged.to_be_bytes()[1..2]);
        }
        3 => {
            let merged = (u32::from(chunk[0]) << 18)
                | (u32::from(chunk[1]) << 12)
                | (u32::from(chunk[2]) << 6);
            buffer.extend_from_slice(&merged.to_be_bytes()[1..3]);
        }
        _ => {}
    }
    Some(buffer)
}

fn pick_save_path(handle: &AppHandle, default_name: &str, extension: &str) -> Option<PathBuf> {
    handle
        .dialog()
        .file()
        .add_filter(extension.to_uppercase().as_str(), &[extension])
        .set_file_name(default_name)
        .blocking_save_file()
        .map(|file| PathBuf::from(file.to_string()))
}

pub async fn pandoc(
    handle: &AppHandle,
    target: &str,
    markdown: &str,
    default_name: &str,
    doc_dir: Option<&str>,
) -> Result<Option<String>, ServiceError> {
    let Some((_, format, extension)) = PANDOC_TARGETS.iter().find(|(name, _, _)| *name == target)
    else {
        return Err(err("invalid-argument", "导出格式无效。"));
    };
    if markdown.is_empty() {
        return Err(err("invalid-argument", "导出内容无效。"));
    }
    if !pandoc_available(handle).await {
        return Err(err(
            "pandoc-missing",
            "未检测到 Pandoc。请先安装 Pandoc（https://pandoc.org/installing.html）并确保其在 PATH 中，再使用该导出格式。",
        ));
    }
    let safe_name = default_name
        .trim()
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(default_name)
        .trim()
        .to_string();
    let default_file = format!(
        "{}.{extension}",
        safe_name
            .trim_end_matches(".md")
            .trim_end_matches(".markdown")
    );
    let Some(save_path) = pick_save_path(handle, &default_file, extension) else {
        return Ok(None);
    };

    let work_dir = doc_dir.map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    let token = format!("{:016x}", rand::thread_rng().next_u64());
    let temp_md = work_dir.join(format!(".markdesk-pandoc-{token}.md"));
    std::fs::write(&temp_md, markdown.as_bytes())
        .map_err(|_| err("write-failed", "临时 Markdown 写入失败。"))?;

    let output = tokio::process::Command::new("pandoc")
        .arg(&temp_md)
        .arg("-o")
        .arg(&save_path)
        .arg("-t")
        .arg(format)
        .arg("--resource-path")
        .arg(&work_dir)
        .output()
        .await;

    let _ = std::fs::remove_file(&temp_md);
    match output {
        Ok(result) if result.status.success() => {
            Ok(Some(save_path.to_string_lossy().to_string()))
        }
        Ok(result) => Err(err(
            "unexpected-error",
            format!(
                "Pandoc 转换失败：{}",
                String::from_utf8_lossy(&result.stderr).trim()
            ),
        )),
        Err(_) => Err(err(
            "pandoc-missing",
            "未检测到 Pandoc。请先安装 Pandoc 并确保其在 PATH 中。",
        )),
    }
}

async fn pandoc_available(handle: &AppHandle) -> bool {
    let cached = handle.state::<crate::state::App>().inner.lock().unwrap().pandoc_available;
    if let Some(value) = cached {
        return value;
    }
    let available = tokio::process::Command::new("pandoc")
        .arg("--version")
        .output()
        .await
        .map(|result| result.status.success())
        .unwrap_or(false);
    handle.state::<crate::state::App>().inner.lock().unwrap().pandoc_available = Some(available);
    available
}
