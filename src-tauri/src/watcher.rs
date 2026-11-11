//! 文档外部修改监听：notify 监听文件，事件去抖后发往渲染端；
//! MarkDesk 自己的写入在短期内不通知（避免自我误报）。
//!
//! notify 的 Windows 后端（ReadDirectoryChangesW）在 9P 文件系统
//!（\\wsl.localhost\…）与部分网络盘上 watch 成功却静默不派发事件，
//! 因此额外跑一条 mtime+size 轮询线程兜底：任何路径上的外部修改
//! 都能在轮询周期内被发现。

use notify::Watcher;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// 轮询周期：对外部修改提示的感知延迟上限。
const POLL_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Default)]
pub struct Watchers {
    handles: Mutex<HashMap<String, notify::RecommendedWatcher>>,
    suppressed: Mutex<HashMap<String, Instant>>,
    baselines: Mutex<HashMap<String, (f64, f64)>>,
    poller_started: AtomicBool,
}

#[derive(Serialize, Clone)]
struct FileChangedEvent {
    path: String,
}

/// mtime(ms)+size 指纹；文件不可访问时返回 None。
fn poll_fingerprint(path: &str) -> Option<(f64, f64)> {
    let metadata = std::fs::metadata(path).ok()?;
    let mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|span| span.as_millis() as f64)
        .unwrap_or(0.0);
    Some((mtime_ms, metadata.len() as f64))
}

fn is_suppressed(watchers: &Watchers, canonical: &str) -> bool {
    let suppressed = watchers.suppressed.lock().unwrap();
    suppressed
        .get(canonical)
        .is_some_and(|until| Instant::now() < *until)
}

/// 记录当前指纹并按需发出外部修改事件。返回 true 表示已发出事件。
fn record_fingerprint(handle: &AppHandle, canonical: &str, fingerprint: (f64, f64)) -> bool {
    let watchers = handle.state::<Watchers>();
    let mut baselines = watchers.baselines.lock().unwrap();
    let Some(baseline) = baselines.get_mut(canonical) else {
        return false;
    };
    if *baseline == fingerprint {
        return false;
    }
    *baseline = fingerprint;
    drop(baselines);
    if is_suppressed(&watchers, canonical) {
        return false;
    }
    let _ = handle.emit(
        "file-changed",
        FileChangedEvent {
            path: canonical.to_string(),
        },
    );
    true
}

/// 轮询兜底线程：全量 stat 各监听文档的 mtime+size，变化即通知。
/// notify 原生事件在 NTFS 上更即时，轮询只做网络/9P 文件系统的补位。
fn start_poller(handle: AppHandle) {
    let watchers = handle.state::<Watchers>();
    if watchers.poller_started.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || loop {
        std::thread::sleep(POLL_INTERVAL);
        let paths: Vec<String> = handle
            .state::<Watchers>()
            .baselines
            .lock()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        for canonical in paths {
            if let Some(fingerprint) = poll_fingerprint(&canonical) {
                record_fingerprint(&handle, &canonical, fingerprint);
            }
        }
    });
}

pub fn watch(handle: AppHandle, canonical: &str) {
    let watchers = handle.state::<Watchers>();
    {
        let map = watchers.handles.lock().unwrap();
        if map.contains_key(canonical) {
            // 重复打开同一文档：原生 watcher 已就位，但基线必须刷新，
            // 否则上次打开与本次打开之间的外部改动会被误报。
            if let Some(fingerprint) = poll_fingerprint(canonical) {
                watchers
                    .baselines
                    .lock()
                    .unwrap()
                    .insert(canonical.to_string(), fingerprint);
            }
            return;
        }
    }
    // 先登记轮询基线再启动原生监听：两条通道都能独立发现变化。
    if let Some(fingerprint) = poll_fingerprint(canonical) {
        watchers
            .baselines
            .lock()
            .unwrap()
            .insert(canonical.to_string(), fingerprint);
    }
    start_poller(handle.clone());
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
    // 同步重置轮询基线：否则下一次轮询会把这次自家写入当成外部修改。
    if let Some(fingerprint) = poll_fingerprint(canonical) {
        watchers
            .baselines
            .lock()
            .unwrap()
            .insert(canonical.to_string(), fingerprint);
    }
}
