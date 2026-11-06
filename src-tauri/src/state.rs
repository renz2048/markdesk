//! 应用状态与持久化（最近文件、恢复草稿、图片授权表），数据文件落在
//! Tauri 的应用数据目录；写入采用临时文件 + 原子替换。

use crate::policy;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

pub const RECENT_LIMIT: usize = 10;
pub const IMAGE_GRANTS_LIMIT: usize = 200;
pub const DRAFT_MAX_BYTES: usize = 2 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    pub path: String,
    pub name: String,
    pub last_opened_at: f64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryDraft {
    pub key: String,
    pub path: Option<String>,
    pub file_name: String,
    pub markdown: String,
    pub mode: String,
    pub cursor: f64,
    pub scroll_top: f64,
    pub updated_at: f64,
}

// 字段与渲染端 FileFingerprint 契约一致（camelCase）；漏掉 rename_all
// 会让带指纹的保存整体失败（invalid-fingerprint）。
#[derive(Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Fingerprint {
    pub hash: String,
    pub mtime_ms: f64,
    pub size: f64,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ThemePreference {
    // 无记忆时默认浅色；用户选择过则以 theme.json 为准。
    #[default]
    Light,
    Dark,
    System,
}

impl ThemePreference {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "light" => Some(Self::Light),
            "dark" => Some(Self::Dark),
            "system" => Some(Self::System),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Light => "light",
            Self::Dark => "dark",
            Self::System => "system",
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecentFileStatus {
    pub path: String,
    pub name: String,
    pub last_opened_at: f64,
    pub exists: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryDraftSummary {
    pub key: String,
    pub path: Option<String>,
    pub file_name: String,
    pub updated_at: f64,
}

pub struct Inner {
    pub read_grants: HashSet<String>,
    pub write_grants: HashSet<String>,
    pub write_baselines: HashMap<String, Fingerprint>,
    pub recent: Vec<RecentFile>,
    pub drafts: Vec<RecoveryDraft>,
    pub granted_images: Vec<String>,
    pub theme: ThemePreference,
    pub pandoc_available: Option<bool>,
    /// 导出 PDF/PNG 时隐藏窗口加载的临时 HTML（token → 路径）。
    pub export_docs: HashMap<String, PathBuf>,
    /// 已批准关闭的窗口标签（关闭保护握手）。
    pub closing_windows: HashSet<String>,
    /// 启动参数携带的待打开文档（渲染端挂载后拉取，消除事件竞态）。
    pub pending_open: Option<String>,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            read_grants: HashSet::new(),
            write_grants: HashSet::new(),
            write_baselines: HashMap::new(),
            recent: Vec::new(),
            drafts: Vec::new(),
            granted_images: Vec::new(),
            // 默认浅色（与枚举 #[default] 一致；用户选择经 theme.json 覆盖）。
            theme: ThemePreference::Light,
            pandoc_available: None,
            export_docs: HashMap::new(),
            closing_windows: HashSet::new(),
            pending_open: None,
        }
    }
}

pub struct App {
    pub inner: std::sync::Mutex<Inner>,
    pub data_dir: PathBuf,
}

pub fn draft_key_for_path(path: Option<&str>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.unwrap_or(":untitled:").as_bytes());
    format!("{:x}", hasher.finalize())
}

fn file_name_of(path: &str) -> String {
    path.split(['/', '\\'])
        .filter(|part| !part.is_empty())
        .next_back()
        .unwrap_or("未命名.md")
        .to_string()
}

impl App {
    pub fn new(data_dir: PathBuf) -> Self {
        let app = Self {
            inner: std::sync::Mutex::new(Inner::default()),
            data_dir,
        };
        app.load_all();
        app
    }

    fn load_all(&self) {
        let _ = fs::create_dir_all(&self.data_dir);
        if let Ok(list) = self.load_json::<Vec<RecentFile>>("recent-files.json") {
            let mut inner = self.inner.lock().unwrap();
            inner.recent = list.into_iter().take(RECENT_LIMIT).collect();
        }
        if let Ok(list) = self.load_json::<Vec<RecoveryDraft>>("recovery-drafts.json") {
            let mut inner = self.inner.lock().unwrap();
            inner.drafts = list
                .into_iter()
                .filter(|draft| {
                    draft.markdown.len() <= DRAFT_MAX_BYTES && {
                        let expected = draft_key_for_path(draft.path.as_deref());
                        draft.key == expected
                    }
                })
                .collect();
        }
        if let Ok(list) = self.load_json::<Vec<String>>("image-grants.json") {
            let mut inner = self.inner.lock().unwrap();
            inner.granted_images = list
                .into_iter()
                .filter(|path| policy::is_local_absolute(path) && policy::is_image_path(path))
                .take(IMAGE_GRANTS_LIMIT)
                .collect();
        }
        if let Ok(value) = self.load_json::<ThemePreference>("theme.json") {
            self.inner.lock().unwrap().theme = value;
        }
    }

    fn load_json<T: for<'de> Deserialize<'de>>(&self, name: &str) -> Result<T, ()> {
        let text = fs::read_to_string(self.data_dir.join(name)).map_err(|_| ())?;
        serde_json::from_str(&text).map_err(|_| ())
    }

    fn save_json(&self, name: &str, value: &impl Serialize) {
        let target = self.data_dir.join(name);
        if let Err(error) = write_json_atomically(&target, value) {
            eprintln!("markdesk: 写入 {name} 失败：{error}");
        }
    }

    pub fn persist_recent(&self) {
        let list = self.inner.lock().unwrap().recent.clone();
        self.save_json("recent-files.json", &list);
    }

    pub fn persist_drafts(&self) {
        let list = self.inner.lock().unwrap().drafts.clone();
        self.save_json("recovery-drafts.json", &list);
    }

    pub fn persist_image_grants(&self) {
        let list = self.inner.lock().unwrap().granted_images.clone();
        self.save_json("image-grants.json", &list);
    }

    pub fn persist_theme(&self) {
        let theme = self.inner.lock().unwrap().theme;
        self.save_json("theme.json", &theme);
    }

    /// upsertRecentFile 的移植：置顶、去重、截断。
    pub fn upsert_recent(&self, path: &str) -> Vec<RecentFile> {
        let entry = RecentFile {
            path: path.to_string(),
            name: file_name_of(path),
            last_opened_at: now_ms(),
        };
        let mut inner = self.inner.lock().unwrap();
        inner.recent.retain(|file| file.path != entry.path);
        inner.recent.insert(0, entry);
        inner.recent.truncate(RECENT_LIMIT);
        let list = inner.recent.clone();
        drop(inner);
        self.persist_recent();
        list
    }

    pub fn recent_statuses(&self) -> Vec<RecentFileStatus> {
        let inner = self.inner.lock().unwrap();
        inner
            .recent
            .iter()
            .map(|file| RecentFileStatus {
                path: file.path.clone(),
                name: file.name.clone(),
                last_opened_at: file.last_opened_at,
                exists: Path::new(&file.path).is_file(),
            })
            .collect()
    }

    /// 授权一张目录外图片（去重、上限淘汰最早的）并持久化。
    pub fn grant_image(&self, path: &str) {
        let mut inner = self.inner.lock().unwrap();
        if inner.granted_images.iter().any(|item| item == path) {
            return;
        }
        inner.granted_images.push(path.to_string());
        if inner.granted_images.len() > IMAGE_GRANTS_LIMIT {
            inner.granted_images.remove(0);
        }
        drop(inner);
        self.persist_image_grants();
    }
}

pub fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as f64)
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_round_trips_camel_case() {
        // 渲染端 writeFile 携带的 expected 是 camelCase（mtimeMs），
        // 反序列化失败即 invalid-fingerprint（保存失败的回归）。
        let parsed: Fingerprint = serde_json::from_value(serde_json::json!({
            "hash": "abc",
            "mtimeMs": 12.5,
            "size": 34.0
        }))
        .expect("camelCase 指纹必须可反序列化");
        assert_eq!(parsed.mtime_ms, 12.5);
        assert_eq!(parsed.size, 34.0);
        let serialized = serde_json::to_value(&parsed).unwrap();
        assert_eq!(serialized["mtimeMs"], 12.5);
    }
}

/// 临时文件 + rename 的原子写（Windows 的 rename 支持覆盖既有目标）。
pub fn write_json_atomically(target: &Path, value: &impl Serialize) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(value).map_err(io_other)?;
    let token = rand::random::<u64>();
    let temporary = target.with_extension(format!("{token:x}.markdesk-tmp"));
    fs::write(&temporary, text.as_bytes())?;
    if let Err(error) = fs::rename(&temporary, target) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(())
}

fn io_other(error: serde_json::Error) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::Other, error.to_string())
}
