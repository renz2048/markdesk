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
    // 监听的是父目录（覆盖 rename/replace 类事件），因此必须按路径
    // 过滤：只允许被监视文档本身的事件通过——导出临时文件
    //（.markdesk-export-*、.markdesk-pandoc-*）与保存的临时文件都写在
    // 同一目录，不能触发“已被外部修改”误报。
    let watched_normalized = crate::policy::normalize_unresolved(canonical);
    let app = handle.clone();
    let inner = move |event: Result<notify::Event, notify::Error>| {
        let Ok(event) = event else { return };
        let touches_doc = event.paths.iter().any(|event_path| {
            crate::policy::normalize_unresolved(&event_path.to_string_lossy())
                == watched_normalized
        });
        if !touches_doc {
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
