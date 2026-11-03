//! 文档外部修改监听：notify 监听文件，事件去抖后发往渲染端；
//! MarkDesk 自己的写入在短期内不通知（避免自我误报）。

use notify::Watcher;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
pub struct Watchers {
    handles: Mutex<HashMap<String, notify::RecommendedWatcher>>,
    suppressed: Mutex<HashMap<String, Instant>>,
}

#[derive(Serialize, Clone)]
struct FileChangedEvent {
    path: String,
}

pub fn watch(handle: AppHandle, canonical: &str) {
    let watchers = handle.state::<Watchers>();
    {
        let map = watchers.handles.lock().unwrap();
        if map.contains_key(canonical) {
            return;
        }
    }
    let path = PathBuf::from(canonical);
    let event_path = canonical.to_string();
    let app = handle.clone();
    let inner = move |event: Result<notify::Event, notify::Error>| {
        if event.is_err() {
            return;
        }
        // 去抖 300ms：编辑器保存常触发多个事件。
        std::thread::sleep(Duration::from_millis(300));
        let watchers = app.state::<Watchers>();
        let suppressed = watchers.suppressed.lock().unwrap();
        if let Some(until) = suppressed.get(&event_path) {
            if Instant::now() < *until {
                return;
            }
        }
        drop(suppressed);
        let _ = app.emit(
            "file-changed",
            FileChangedEvent {
                path: event_path.clone(),
            },
        );
    };
    if let Ok(mut watcher) = notify::recommended_watcher(inner) {
        // 监听父目录以覆盖 rename/replace 类事件。
        let watch_target = path
            .parent()
            .map(|parent| parent.to_path_buf())
            .unwrap_or(path);
        if watcher.watch(&watch_target, notify::RecursiveMode::NonRecursive).is_ok() {
            watchers
                .handles
                .lock()
                .unwrap()
                .insert(canonical.to_string(), watcher);
        }
    }
}

/// MarkDesk 自己写入后 2 秒内的事件不通知。
pub fn suppress_own_write(handle: AppHandle, canonical: &str) {
    let watchers = handle.state::<Watchers>();
    watchers.suppressed.lock().unwrap().insert(
        canonical.to_string(),
        Instant::now() + Duration::from_secs(2),
    );
}
