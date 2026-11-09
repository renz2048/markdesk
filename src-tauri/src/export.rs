//! 导出：HTML 直接写文件；Word/OpenOffice/Epub/LaTeX/MediaWiki 走系统
//! Pandoc；PDF/图像经隐藏 WebView 加载导出 HTML 后调用 WebView2 的
//! CDP（Page.printToPDF / Page.captureScreenshot）渲染成文件。

use crate::service::ServiceError;
use rand::RngCore;
use std::path::{Path, PathBuf};
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
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;
    use webview2_com::{
        CallDevToolsProtocolMethodCompletedHandler, ExecuteScriptCompletedHandler,
    };
    use windows_core::HSTRING;

    /// 在主线程上对 ICoreWebView2 发起操作。闭包绝不能阻塞：COM 完成
    /// 回调依赖主线程消息泵，在主线程里等待回调 = 死锁（这正是此前
    /// “导出页面加载超时”的根因）。
    pub fn kick_core(
        window: &tauri::WebviewWindow,
        run: impl FnOnce(&ICoreWebView2) + Send + 'static,
    ) -> Result<(), String> {
        window
            .with_webview(move |webview| {
                let controller = webview.controller();
                if let Ok(core) = unsafe { controller.CoreWebView2() } {
                    run(&core);
                }
            })
            .map_err(|error| error.to_string())
    }

    pub fn execute_script(
        window: &tauri::WebviewWindow,
        script: &str,
    ) -> Result<String, String> {
        let (sender, receiver) = mpsc::channel();
        let script = script.to_string();
        kick_core(window, move |core| {
            let handler = ExecuteScriptCompletedHandler::create(Box::new(
                move |error: windows_core::Result<()>, result: String| {
                    let message = if error.is_ok() {
                        Ok(result)
                    } else {
                        Err(format!("script failed: {error:?}"))
                    };
                    let _ = sender.send(message);
                    Ok(())
                },
            ));
            let _ = unsafe { core.ExecuteScript(&HSTRING::from(script.as_str()), &handler) };
        })?;
        receiver
            .recv_timeout(Duration::from_secs(20))
            .map_err(|_| "script timeout".to_string())?
    }

    pub fn call_devtools(
        window: &tauri::WebviewWindow,
        method: &str,
        parameters: &str,
    ) -> Result<String, String> {
        let (sender, receiver) = mpsc::channel();
        let method = method.to_string();
        let parameters = parameters.to_string();
        kick_core(window, move |core| {
            let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                move |error: windows_core::Result<()>, json: String| {
                    let message = if error.is_ok() {
                        Ok(json)
                    } else {
                        Err(format!("cdp failed: {error:?}"))
                    };
                    let _ = sender.send(message);
                    Ok(())
                },
            ));
            let _ = unsafe {
                core.CallDevToolsProtocolMethod(
                    &HSTRING::from(method.as_str()),
                    &HSTRING::from(parameters.as_str()),
                    &handler,
                )
            };
        })?;
        receiver
            .recv_timeout(Duration::from_secs(120))
            .map_err(|_| "cdp timeout".to_string())?
    }
}

/// 取窗口的 ICoreWebView2 并执行回调（在主线程上）。
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

    // 临时 HTML 与文档同目录（assets_dir 即文档目录），协议据此解析
    // 相对图片；曾误取 parent() 导致写入上一级目录、图片全部失配。
    let base_dir = assets_dir
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let token = format!("{:016x}", rand::thread_rng().next_u64());
    let html_path = base_dir.join(format!(".markdesk-export-{token}.html"));
    std::fs::write(&html_path, html.as_bytes())
        .map_err(|_| err("write-failed", "导出临时文件写入失败。"))?;

    let outcome = run_export_webview(handle, &html_path, &token, format == "pdf").await;
    let _ = std::fs::remove_file(&html_path);
    crate::commands::remove_export_doc(handle, &token);

    match outcome {
        Ok(bytes) => {
            std::fs::write(&target, &bytes)
                .map_err(|_| err("write-failed", "导出文件写入失败。"))?;
            Ok(Some(target.to_string_lossy().to_string()))
        }
        Err(message) => Err(err("unexpected-error", message)),
    }
}

/// 免对话框的导出（自动化验证用）：与 render 相同的渲染管线，
/// 直接写入指定路径。
pub async fn render_to_path(
    handle: &AppHandle,
    format: &str,
    html: &str,
    target: &Path,
    assets_dir: Option<&str>,
) -> Result<(), ServiceError> {
    let base_dir = assets_dir
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let token = format!("{:016x}", rand::thread_rng().next_u64());
    let html_path = base_dir.join(format!(".markdesk-export-{token}.html"));
    std::fs::write(&html_path, html.as_bytes())
        .map_err(|_| err("write-failed", "导出临时文件写入失败。"))?;

    let outcome = run_export_webview(handle, &html_path, &token, format == "pdf").await;
    let _ = std::fs::remove_file(&html_path);
    crate::commands::remove_export_doc(handle, &token);

    let bytes = outcome.map_err(|message| err("unexpected-error", message))?;
    std::fs::write(target, &bytes)
        .map_err(|_| err("write-failed", "导出文件写入失败。"))?;
    Ok(())
}

// 隐藏 WebView + 引擎原生渲染接口的导出：Windows 走 WebView2 的 CDP
//（printToPDF / captureScreenshot）。macOS（WKWebView）与 Linux
//（WebKitGTK）缺少对应的静默打印 API，暂不支持，返回明确错误。
#[cfg(windows)]
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
        // 完全隐藏会被 Chromium 挂起渲染，因此“隐藏创建 → 显式定位到
        // 屏幕外 → 再显示”，既不闪现又保持渲染器活跃。
        .visible(false)
        .decorations(false)
        .skip_taskbar(true)
        .focused(false)
        .position(-32000.0, -32000.0)
        .inner_size(1200.0, 1600.0)
        .build()
        .map_err(|error| format!("创建导出窗口失败：{error}"))?;
    let _ = window.set_position(tauri::LogicalPosition::new(-32000.0, -32000.0));
    let _ = window.show();

    // 等待页面加载完成（90 秒绝对时限；探测 20 秒超时）。
    let deadline = std::time::Instant::now() + Duration::from_secs(90);
    let mut ready = false;
    while std::time::Instant::now() < deadline {
        let probe = webview2::execute_script(&window, "document.readyState");
        if matches!(&probe, Ok(state) if state.trim_matches('"') == "complete") {
            ready = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    if !ready {
        let _ = window.destroy();
        return Err("导出页面加载超时".to_string());
    }

    let result = if pdf { print_to_pdf(&window) } else { screenshot(&window) };
    let _ = window.destroy();
    result
}

#[cfg(not(windows))]
async fn run_export_webview(
    _handle: &AppHandle,
    _html_path: &Path,
    _token: &str,
    _pdf: bool,
) -> Result<Vec<u8>, String> {
    Err("PDF/图像导出当前仅支持 Windows，其他平台请使用 HTML 或 Pandoc 导出。".to_string())
}

#[cfg(windows)]
fn print_to_pdf(window: &tauri::WebviewWindow) -> Result<Vec<u8>, String> {
    let json = webview2::call_devtools(
        window,
        "Page.printToPDF",
        r#"{"printBackground":true,"paperWidth":8.27,"paperHeight":11.69,"marginTop":0.4,"marginBottom":0.4,"marginLeft":0.4,"marginRight":0.4}"#,
    )?;
    decode_base64_payload(&json)
}

#[cfg(windows)]
fn screenshot(window: &tauri::WebviewWindow) -> Result<Vec<u8>, String> {
    let _ = webview2::call_devtools(window, "Page.enable", "{}")?;
    // captureBeyondViewport 让 Chromium 先按整页尺寸调整视口再截图。
    let json = webview2::call_devtools(
        window,
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
