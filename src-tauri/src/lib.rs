//! MarkDesk 主进程（Tauri 2 移植）：受限资源协议、菜单、关闭保护、
//! argv 文件打开与命令注册。安全模型对齐 Electron 版：
//! - 渲染端只能通过 invoke 命令访问文件，且必须先经对话框/最近打开授权
//! - markdesk-resource 协议只放行文档目录内的相对图片与显式授权的
//!   目录外绝对路径图片

mod commands;
mod export;
mod menu;
mod policy;
mod service;
mod state;
mod theme;
mod update;
mod watcher;
mod window;

use state::App;
use tauri::http::{header, StatusCode};
use tauri::{AppHandle, Emitter, Manager};

fn open_directories(handle: &AppHandle) -> Vec<String> {
    let read_grants = {
        let app = handle.state::<App>();
        let inner = app.inner.lock().unwrap();
        inner.read_grants.iter().cloned().collect::<Vec<_>>()
    };
    read_grants
        .iter()
        .filter_map(|path| {
            std::path::Path::new(path)
                .parent()
                .map(|parent| parent.to_string_lossy().to_string())
        })
        .collect()
}

fn resource_response(bytes: Vec<u8>, content_type: &str) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-store")
        .body(bytes)
        .unwrap_or_else(|_| {
            tauri::http::Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Vec::new())
                .unwrap()
        })
}

fn denied() -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(StatusCode::FORBIDDEN)
        .body(b"access denied".to_vec())
        .unwrap()
}

fn serve_export_doc(
    handle: &AppHandle,
    segments: &[&str],
) -> Option<tauri::http::Response<Vec<u8>>> {
    // export-html/<token>/rest…：index.html 是导出页本体，其余按相对图片解析。
    if segments.len() < 3 || segments[0] != "export-html" {
        return None;
    }
    let token = segments[1];
    let rest = segments[2..].join("/");
    let html_path = commands::peek_export_doc(handle, token)?;
    let dir = html_path.parent()?.to_path_buf();
    if rest == "index.html" {
        let bytes = std::fs::read(&html_path).ok()?;
        return Some(resource_response(bytes, "text/html; charset=utf-8"));
    }
    let resolved = policy::resolve_against(&dir.to_string_lossy(), &rest);
    let base = policy::resolve_against(&dir.to_string_lossy(), "");
    let separator = if base.contains('\\') { '\\' } else { '/' };
    if !resolved.starts_with(&format!("{base}{separator}")) {
        return Some(denied());
    }
    if !policy::is_image_path(&resolved) {
        return Some(denied());
    }
    match std::fs::read(&resolved) {
        Ok(bytes) => Some(resource_response(bytes, policy::media_type_for(&resolved))),
        Err(_) => Some(denied()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // MARKDESK_DATA_DIR 覆盖数据目录（冒烟/测试隔离用），
            // 默认为系统应用数据目录。
            let data_dir = std::env::var("MARKDESK_DATA_DIR")
                .ok()
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| {
                    app.path()
                        .app_data_dir()
                        .unwrap_or_else(|_| std::path::PathBuf::from("."))
                });
            app.manage(App::new(data_dir));
            app.manage(watcher::Watchers::default());

            let handle = app.handle().clone();
            menu::build(&handle);
            let preference = handle.state::<App>().inner.lock().unwrap().theme;
            theme::apply(&handle, preference);

            // tauri.conf.json 声明的首窗口也要挂关闭保护（与 create_main
            // 新建的窗口一致）。
            if let Some(main) = handle.get_webview_window("main") {
                let close_handle = handle.clone();
                let close_label = "main".to_string();
                main.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        let approved = {
                            let app = close_handle.state::<App>();
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

            // argv：双击 .md 或命令行传参直接打开。存入 pending_open，
            // 由渲染端挂载后主动拉取（take_argv_open_path），避免
            // “事件早于监听器就绪”的竞态。
            if let Some(argument) = std::env::args().nth(1) {
                let canonical = policy::canonicalize(&argument);
                if policy::is_markdown_path(&canonical) && service::file_exists(&canonical) {
                    {
                        let app_state = handle.state::<App>();
                        let mut inner = app_state.inner.lock().unwrap();
                        inner.read_grants.insert(canonical.clone());
                        inner.pending_open = Some(canonical.clone());
                    }
                    handle.state::<App>().upsert_recent(&canonical);
                }
            }
            Ok(())
        })
        .register_uri_scheme_protocol("markdesk-resource", |ctx, request| {
            let handle = ctx.app_handle();
            let uri = request.uri();
            // Windows：http://markdesk-resource.localhost/<path>；取 path 并
            // 去掉前导斜杠（保留百分号编码，由 policy 统一解码）。
            let encoded = uri.path().trim_start_matches('/').to_string();
            if encoded.is_empty() {
                return denied();
            }
            let segments: Vec<&str> = encoded.split('/').collect();
            if segments.first() == Some(&"export-html") {
                if let Some(response) = serve_export_doc(handle, &segments) {
                    return response;
                }
                return denied();
            }
            let granted = {
                let app = handle.state::<App>();
                let inner = app.inner.lock().unwrap();
                inner.granted_images.clone()
            };
            let directories = open_directories(handle);
            match policy::resolve_resource_path(&directories, &encoded, &granted) {
                Some(path) => match std::fs::read(&path) {
                    Ok(bytes) => {
                        resource_response(bytes, policy::media_type_for(&path))
                    }
                    Err(_) => denied(),
                },
                None => denied(),
            }
        })
        .on_menu_event(|handle, event| {
            menu::on_event(handle, event.id().as_ref());
        })
        .on_window_event(|_handle, _event| {
            // 关闭保护在各窗口自己的 on_window_event（见 window::create_main）。
        })
        .invoke_handler(tauri::generate_handler![
            commands::choose_markdown_file,
            commands::choose_save_location,
            commands::read_file,
            commands::write_file,
            commands::save_pasted_image,
            commands::pick_image_asset,
            commands::insert_dropped_image,
            commands::check_image_grants,
            commands::grant_image_paths,
            commands::get_recent_files,
            commands::read_recent_file,
            commands::clear_recent_files,
            commands::save_recovery_draft,
            commands::list_recovery_drafts,
            commands::read_recovery_draft,
            commands::discard_recovery_draft,
            commands::choose_export_location,
            commands::export_html,
            commands::export_rendered,
            commands::export_pandoc,
            commands::set_theme_preference,
            commands::get_theme_preference,
            commands::set_window_title,
            commands::request_close,
            commands::cancel_close,
            commands::take_argv_open_path,
            commands::export_rendered_to,
            commands::get_build_info,
            commands::check_latest_release,
            commands::download_update,
        ])
        .run(tauri::generate_context!())
        .expect("MarkDesk 启动失败");
}
