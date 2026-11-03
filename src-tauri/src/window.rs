//! 主窗口创建与关闭保护（对齐 Electron 版：未保存修改拦截窗口关闭，
//! 由渲染端决定保存/放弃/取消）。

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub fn create_main(handle: &AppHandle) {
    let mut index = handle.webview_windows().len() + 1;
    let mut label = if index == 1 {
        "main".to_string()
    } else {
        format!("main-{index}")
    };
    while handle.webview_windows().contains_key(&label) {
        index += 1;
        label = format!("main-{index}");
    }
    let close_handle = handle.clone();
    let close_label = label.clone();
    let builder = WebviewWindowBuilder::new(
        handle,
        &label,
        WebviewUrl::App("index.html".into()),
    )
    .title("MarkDesk")
    .inner_size(1280.0, 800.0)
    .min_inner_size(640.0, 480.0);
    match builder.build() {
        Ok(window) => {
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let approved = {
                        let app = close_handle.state::<crate::state::App>();
                        let inner = app.inner.lock().unwrap();
                        inner.closing_windows.contains(close_label.as_str())
                    };
                    if !approved {
                        api.prevent_close();
                        let _ = close_handle.emit_to(
                            close_label.clone(),
                            "close-requested",
                            (),
                        );
                    }
                }
            });
        }
        Err(error) => eprintln!("markdesk: 创建窗口失败：{error}"),
    }
}

/// 触发关闭保护：第一次走渲染端确认，批准后（closing_windows）才真正关闭。
pub fn on_close_requested(handle: &AppHandle, label: &str, api: &tauri::WindowEvent) {
    let _ = api;
    let approved = {
        let app = handle.state::<crate::state::App>();
        let inner = app.inner.lock().unwrap();
        inner.closing_windows.contains(label)
    };
    if approved {
        return; // 放行（不 prevent）
    }
    if let Some(window) = handle.webview_windows().get(label) {
        let _ = window.emit_to(label, "close-requested", ());
    }
}

pub fn request_close(handle: &AppHandle, window: &WebviewWindow) {
    {
        let app = handle.state::<crate::state::App>();
        app.inner
            .lock()
            .unwrap()
            .closing_windows
            .insert(window.label().to_string());
    }
    let _ = window.close();
}
