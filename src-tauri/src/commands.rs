//! invoke 命令面：与渲染端 MarkDeskRendererApi 一一对应。错误以
//! { code, message } 序列化，适配层还原成 MarkDeskIpcError。

use crate::policy;
use crate::service::{self, ServiceError};
use crate::state::{
    draft_key_for_path, App, Inner, RecoveryDraft, RecoveryDraftSummary, RecentFileStatus,
};
use crate::watcher;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

#[derive(Serialize, Clone)]
pub struct IpcError {
    pub code: String,
    pub message: String,
}

impl From<ServiceError> for IpcError {
    fn from(error: ServiceError) -> Self {
        Self {
            code: error.code.to_string(),
            message: error.message,
        }
    }
}

impl IpcError {
    pub fn invalid_argument(message: &str) -> Self {
        Self {
            code: "invalid-argument".into(),
            message: message.into(),
        }
    }
    pub fn invalid_path(message: &str) -> Self {
        Self {
            code: "invalid-path".into(),
            message: message.into(),
        }
    }
}

type CommandResult<T> = Result<T, IpcError>;

fn with_inner<R>(handle: &AppHandle, operation: impl FnOnce(&mut Inner) -> R) -> R {
    let app: State<'_, App> = handle.state::<App>();
    let mut inner = app.inner.lock().unwrap();
    operation(&mut inner)
}

fn read_inner<R>(handle: &AppHandle, operation: impl FnOnce(&Inner) -> R) -> R {
    let app: State<'_, App> = handle.state::<App>();
    let inner = app.inner.lock().unwrap();
    operation(&inner)
}

fn require_read_grant(handle: &AppHandle, canonical: &str) -> Result<(), IpcError> {
    let granted = read_inner(handle, |inner| {
        inner.read_grants.contains(canonical) || inner.write_grants.contains(canonical)
    });
    if granted {
        return Ok(());
    }
    Err(IpcError::invalid_path(
        "当前文档未在本窗口打开，无法访问。",
    ))
}

fn broadcast_recent(handle: &AppHandle) {
    let statuses: Vec<RecentFileStatus> = handle.state::<App>().recent_statuses();
    let _ = handle.emit("recent-files-changed", statuses);
}

#[tauri::command]
pub fn choose_markdown_file(handle: AppHandle) -> CommandResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let picked = handle
        .dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown"])
        .blocking_pick_file();
    match picked {
        Some(file) => {
            let canonical = policy::canonicalize(&file.to_string());
            if !policy::is_markdown_path(&canonical) {
                return Err(IpcError::invalid_path("选择的文件不是 Markdown 文档。"));
            }
            with_inner(&handle, |inner| {
                inner.read_grants.insert(canonical.clone());
            });
            Ok(Some(canonical))
        }
        None => Ok(None),
    }
}

#[tauri::command]
pub fn choose_save_location(
    handle: AppHandle,
    default_name: String,
) -> CommandResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let picked = handle
        .dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown"])
        .set_file_name(&default_name)
        .blocking_save_file();
    match picked {
        Some(file) => {
            let canonical = policy::canonicalize(&file.to_string());
            if !policy::is_markdown_path(&canonical) {
                return Err(IpcError::invalid_path(
                    "保存位置必须以 .md 或 .markdown 结尾。",
                ));
            }
            with_inner(&handle, |inner| {
                inner.write_grants.insert(canonical.clone());
                inner.read_grants.insert(canonical.clone());
            });
            Ok(Some(canonical))
        }
        None => Ok(None),
    }
}

fn register_open(handle: &AppHandle, canonical: &str) {
    handle.state::<App>().upsert_recent(canonical);
    watcher::watch(handle.clone(), canonical);
    broadcast_recent(handle);
}

#[tauri::command]
pub fn read_file(handle: AppHandle, path: String) -> CommandResult<service::FileReadResult> {
    let canonical = policy::canonicalize(&path);
    require_read_grant(&handle, &canonical)?;
    let result = service::read_markdown(&canonical)?;
    with_inner(&handle, |inner| {
        inner.read_grants.insert(canonical.clone());
    });
    register_open(&handle, &canonical);
    Ok(result)
}

#[tauri::command]
pub fn write_file(
    handle: AppHandle,
    path: String,
    content: String,
    newline: Option<String>,
    expected: Option<serde_json::Value>,
) -> CommandResult<service::FileWriteResult> {
    let canonical = policy::canonicalize(&path);
    require_read_grant(&handle, &canonical)?;
    let newline = newline.unwrap_or_else(|| "lf".to_string());
    let result = service::write_markdown(&canonical, &content, &newline, expected)?;
    watcher::suppress_own_write(handle.clone(), &canonical);
    broadcast_recent(&handle);
    Ok(result)
}

#[tauri::command]
pub fn save_pasted_image(
    handle: AppHandle,
    doc_path: String,
    file_name: String,
    bytes: Vec<u8>,
) -> CommandResult<String> {
    let canonical_doc = policy::canonicalize(&doc_path);
    require_read_grant(&handle, &canonical_doc)?;
    let cleaned: String = file_name
        .chars()
        .filter(|character| !character.is_control())
        .collect();
    if cleaned.is_empty()
        || cleaned.contains(['/', '\\'])
        || cleaned == "."
        || cleaned == ".."
        || policy::extension_of(&cleaned) != ".png"
    {
        return Err(IpcError::invalid_argument("图片文件名无效。"));
    }
    let doc_dir = Path::new(&canonical_doc)
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();
    let assets = doc_dir.join("assets");
    std::fs::create_dir_all(&assets)
        .map_err(|_| IpcError::invalid_path("无法创建 assets 目录。"))?;
    let stem = cleaned.trim_end_matches(".png").to_string();
    let mut candidate = assets.join(&cleaned);
    let mut counter = 1;
    while candidate.exists() {
        counter += 1;
        candidate = assets.join(format!("{stem}-{counter}.png"));
    }
    std::fs::write(&candidate, &bytes).map_err(|_| {
        IpcError::from(ServiceError::new("write-failed", "图片写入失败。"))
    })?;
    let relative = candidate
        .strip_prefix(&doc_dir)
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| candidate.to_string_lossy().to_string());
    Ok(relative)
}

#[tauri::command]
pub fn pick_image_asset(handle: AppHandle) -> CommandResult<tauri::ipc::Response> {
    use tauri_plugin_dialog::DialogExt;
    let picked = handle
        .dialog()
        .file()
        .add_filter("图片", &["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"])
        .blocking_pick_file();
    match picked {
        Some(file) => {
            let path = PathBuf::from(file.to_string());
            let name = path
                .file_name()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_default();
            let bytes = std::fs::read(&path)
                .map_err(|_| IpcError::invalid_path("无法读取所选图片。"))?;
            // 首行文件名 + 原始字节，避免大数组走 JSON 序列化。
            let mut payload = name.into_bytes();
            payload.push(b'\n');
            payload.extend_from_slice(&bytes);
            Ok(tauri::ipc::Response::new(payload))
        }
        // 取消选择：空负载，适配层据此返回 null。
        None => Ok(tauri::ipc::Response::new(Vec::new())),
    }
}

#[tauri::command]
pub fn insert_dropped_image(
    handle: AppHandle,
    doc_path: String,
    image_path: String,
) -> CommandResult<String> {
    let canonical_doc = policy::canonicalize(&doc_path);
    require_read_grant(&handle, &canonical_doc)?;
    if !policy::is_image_path(&image_path) {
        return Err(IpcError::invalid_path("拖入的文件不是图片。"));
    }
    let canonical_image = policy::canonicalize(&image_path);
    if !service::file_exists(&canonical_image) {
        return Err(IpcError::invalid_path("图片文件不存在。"));
    }
    let doc_dir = Path::new(&canonical_doc)
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_string_lossy()
        .to_string();
    let resolved = policy::resolve_against(&canonical_image, "");
    let inside_doc_dir = if resolved.contains('\\') {
        resolved.starts_with(&format!("{}\\", doc_dir.trim_end_matches('\\')))
    } else {
        resolved.starts_with(&format!("{}/", doc_dir.trim_end_matches('/')))
    };
    if inside_doc_dir {
        let relative = resolved[doc_dir.len()..]
            .trim_start_matches(['/', '\\'])
            .replace('\\', "/");
        return Ok(relative);
    }
    handle.state::<App>().grant_image(&resolved);
    Ok(resolved)
}

fn validate_image_list(srcs: &Vec<String>) -> Result<(), IpcError> {
    if srcs.is_empty() || srcs.len() > 200 {
        return Err(IpcError::invalid_argument("图片路径列表无效。"));
    }
    let mut seen = HashSet::new();
    for src in srcs {
        if !policy::is_local_absolute(src) || !policy::is_image_path(src) || !seen.insert(src.clone()) {
            return Err(IpcError::invalid_argument("图片路径列表无效。"));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn check_image_grants(handle: AppHandle, srcs: Vec<String>) -> CommandResult<Vec<String>> {
    validate_image_list(&srcs)?;
    Ok(read_inner(&handle, |inner| {
        srcs.into_iter()
            .filter(|src| !inner.granted_images.iter().any(|granted| granted == src))
            .collect()
    }))
}

#[tauri::command]
pub fn grant_image_paths(handle: AppHandle, srcs: Vec<String>) -> CommandResult<Vec<String>> {
    validate_image_list(&srcs)?;
    for src in &srcs {
        handle.state::<App>().grant_image(src);
    }
    Ok(read_inner(&handle, |inner| inner.granted_images.clone()))
}

#[tauri::command]
pub fn get_recent_files(handle: AppHandle) -> CommandResult<Vec<RecentFileStatus>> {
    Ok(handle.state::<App>().recent_statuses())
}

#[tauri::command]
pub fn read_recent_file(handle: AppHandle, path: String) -> CommandResult<service::FileReadResult> {
    let canonical = policy::canonicalize(&path);
    if !policy::is_markdown_path(&canonical) {
        return Err(IpcError::invalid_path("最近文件路径无效。"));
    }
    if !service::file_exists(&canonical) {
        return Err(IpcError::invalid_path("文件已不存在。"));
    }
    with_inner(&handle, |inner| {
        inner.read_grants.insert(canonical.clone());
    });
    let result = service::read_markdown(&canonical)?;
    register_open(&handle, &canonical);
    Ok(result)
}

#[tauri::command]
pub fn clear_recent_files(handle: AppHandle) -> CommandResult<()> {
    with_inner(&handle, |inner| inner.recent.clear());
    handle.state::<App>().persist_recent();
    broadcast_recent(&handle);
    Ok(())
}

#[tauri::command]
pub fn save_recovery_draft(handle: AppHandle, draft: RecoveryDraft) -> CommandResult<String> {
    if draft.markdown.len() > crate::state::DRAFT_MAX_BYTES {
        return Err(IpcError::invalid_argument("草稿内容超过上限。"));
    }
    let key = draft_key_for_path(draft.path.as_deref());
    let record = RecoveryDraft {
        key: key.clone(),
        updated_at: crate::state::now_ms(),
        ..draft
    };
    with_inner(&handle, |inner| {
        inner.drafts.retain(|item| item.key != key);
        inner.drafts.insert(0, record);
    });
    handle.state::<App>().persist_drafts();
    Ok(key)
}

#[tauri::command]
pub fn list_recovery_drafts(handle: AppHandle) -> CommandResult<Vec<RecoveryDraftSummary>> {
    let mut list = read_inner(&handle, |inner| {
        inner
            .drafts
            .iter()
            .map(|draft| RecoveryDraftSummary {
                key: draft.key.clone(),
                path: draft.path.clone(),
                file_name: draft.file_name.clone(),
                updated_at: draft.updated_at,
            })
            .collect::<Vec<_>>()
    });
    list.sort_by(|left, right| {
        right
            .updated_at
            .partial_cmp(&left.updated_at)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(list)
}

#[tauri::command]
pub fn read_recovery_draft(
    handle: AppHandle,
    key: String,
) -> CommandResult<Option<RecoveryDraft>> {
    Ok(read_inner(&handle, |inner| {
        inner.drafts.iter().find(|draft| draft.key == key).cloned()
    }))
}

#[tauri::command]
pub fn discard_recovery_draft(handle: AppHandle, key: String) -> CommandResult<()> {
    with_inner(&handle, |inner| {
        inner.drafts.retain(|draft| draft.key != key);
    });
    handle.state::<App>().persist_drafts();
    Ok(())
}

#[tauri::command]
pub fn choose_export_location(
    handle: AppHandle,
    default_name: String,
) -> CommandResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let picked = handle
        .dialog()
        .file()
        .set_file_name(&default_name)
        .blocking_save_file();
    Ok(picked.map(|file| file.to_string()))
}

#[tauri::command]
pub fn export_html(_handle: AppHandle, path: String, html: String) -> CommandResult<()> {
    std::fs::write(&path, html.as_bytes())
        .map_err(|_| IpcError::from(ServiceError::new("write-failed", "HTML 导出失败。")))?;
    Ok(())
}

#[tauri::command]
pub async fn export_rendered(
    handle: AppHandle,
    format: String,
    html: String,
    default_name: String,
    assets_dir: Option<String>,
) -> CommandResult<Option<String>> {
    crate::export::render(&handle, &format, &html, &default_name, assets_dir.as_deref())
        .await
        .map_err(IpcError::from)
}

#[tauri::command]
pub async fn export_pandoc(
    handle: AppHandle,
    target: String,
    markdown: String,
    default_name: String,
    doc_dir: Option<String>,
) -> CommandResult<Option<String>> {
    crate::export::pandoc(&handle, &target, &markdown, &default_name, doc_dir.as_deref())
        .await
        .map_err(IpcError::from)
}

#[tauri::command]
pub fn set_theme_preference(handle: AppHandle, theme: String) -> CommandResult<()> {
    let parsed = crate::state::ThemePreference::parse(&theme)
        .ok_or_else(|| IpcError::invalid_argument("主题设置无效。"))?;
    with_inner(&handle, |inner| inner.theme = parsed);
    handle.state::<App>().persist_theme();
    crate::theme::apply(&handle, parsed);
    crate::menu::rebuild(&handle);
    Ok(())
}

#[tauri::command]
pub fn set_window_title(window: WebviewWindow, title: String) -> CommandResult<()> {
    let _ = window.set_title(&title);
    Ok(())
}

#[tauri::command]
pub fn request_close(handle: AppHandle, window: WebviewWindow) -> CommandResult<()> {
    crate::window::request_close(&handle, &window);
    Ok(())
}

#[tauri::command]
pub fn cancel_close(handle: AppHandle, window: WebviewWindow) -> CommandResult<()> {
    with_inner(&handle, |inner| {
        inner.closing_windows.remove(window.label());
    });
    Ok(())
}

/// 供导出临时 HTML 通过资源协议加载：登记 token → 文件路径。
pub fn register_export_doc(handle: &AppHandle, token: &str, path: PathBuf) {
    with_inner(handle, |inner| {
        inner.export_docs.insert(token.to_string(), path);
    });
}

pub fn take_export_doc(handle: &AppHandle, token: &str) -> Option<PathBuf> {
    with_inner(handle, |inner| inner.export_docs.remove(token))
}
