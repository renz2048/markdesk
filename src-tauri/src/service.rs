//! Markdown 文件读写服务：UTF-8 校验、BOM 剥除、换行偏好检测、
//! 指纹（sha256 + mtime + size）与原子写入（自 file-service.ts 移植）。

use crate::policy;
use crate::state::{now_ms, Fingerprint};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

pub const MAX_MARKDOWN_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileReadResult {
    pub path: String,
    pub content: String,
    pub newline: String,
    pub hash: String,
    pub mtime_ms: f64,
    pub size: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileWriteResult {
    pub path: String,
    pub hash: String,
    pub mtime_ms: f64,
    pub size: f64,
}

#[derive(Debug)]
pub struct ServiceError {
    pub code: &'static str,
    pub message: String,
}

impl ServiceError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

pub fn content_hash(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn decode_utf8_strict(bytes: Vec<u8>) -> Result<String, ServiceError> {
    let has_bom = bytes.starts_with(&[0xEF, 0xBB, 0xBF]);
    let body = if has_bom { &bytes[3..] } else { &bytes[..] };
    String::from_utf8(body.to_vec()).map_err(|_| {
        ServiceError::new("invalid-encoding", "文件不是有效的 UTF-8 文本。")
    })
}

fn detect_newline(content: &str) -> &'static str {
    if content.contains("\r\n") {
        "crlf"
    } else {
        "lf"
    }
}

fn apply_newline(content: &str, newline: &str) -> String {
    if newline == "crlf" {
        content.replace("\r\n", "\n").replace('\n', "\r\n")
    } else {
        content.replace("\r\n", "\n")
    }
}

fn fingerprint_of(path: &Path, bytes: &[u8]) -> Fingerprint {
    let mtime_ms = fs::metadata(path)
        .ok()
        .and_then(|info| info.modified().ok())
        .and_then(|value| {
            value
                .duration_since(std::time::UNIX_EPOCH)
                .ok()
                .map(|span| span.as_millis() as f64)
        })
        .unwrap_or(0.0);
    let size = fs::metadata(path).map(|info| info.len() as f64).unwrap_or(bytes.len() as f64);
    Fingerprint {
        hash: content_hash(bytes),
        mtime_ms,
        size,
    }
}

pub fn read_markdown(path: &str) -> Result<FileReadResult, ServiceError> {
    let canonical = policy::canonicalize(path);
    if !policy::is_markdown_path(&canonical) {
        return Err(ServiceError::new("invalid-path", "Markdown 文件路径无效。"));
    }
    let metadata = fs::metadata(&canonical)
        .map_err(|_| ServiceError::new("read-failed", "无法读取文件，请确认文件存在。"))?;
    if !metadata.is_file() {
        return Err(ServiceError::new("invalid-path", "目标不是普通文件。"));
    }
    if metadata.len() > MAX_MARKDOWN_BYTES {
        return Err(ServiceError::new(
            "file-too-large",
            "文件超过 10 MB 上限，MarkDesk 只处理小型文本文档。",
        ));
    }
    let bytes = fs::read(&canonical)
        .map_err(|_| ServiceError::new("read-failed", "无法读取文件，请确认文件存在。"))?;
    let fingerprint = fingerprint_of(Path::new(&canonical), &bytes);
    let content = decode_utf8_strict(bytes)?;
    let newline = detect_newline(&content).to_string();
    Ok(FileReadResult {
        path: canonical,
        content,
        newline,
        hash: fingerprint.hash,
        mtime_ms: fingerprint.mtime_ms,
        size: fingerprint.size,
    })
}

/// 校验写入的 JSON 参数形态（来自渲染端，不可信）。
fn valid_fingerprint(value: &Option<serde_json::Value>) -> Result<Option<Fingerprint>, ServiceError> {
    match value {
        None => Ok(None),
        Some(raw) => {
            let parsed: Fingerprint = serde_json::from_value(raw.clone())
                .map_err(|_| ServiceError::new("invalid-fingerprint", "文件指纹无效。"))?;
            Ok(Some(parsed))
        }
    }
}

pub fn write_markdown(
    path: &str,
    content: &str,
    newline: &str,
    expected: Option<serde_json::Value>,
) -> Result<FileWriteResult, ServiceError> {
    let canonical = policy::canonicalize(path);
    if !policy::is_markdown_path(&canonical) {
        return Err(ServiceError::new("invalid-path", "保存路径无效。"));
    }
    let expected = valid_fingerprint(&expected)?;
    let target = Path::new(&canonical);
    if let Some(baseline) = expected {
        if target.exists() {
            let current = fs::read(target)
                .map_err(|_| ServiceError::new("write-failed", "写入前无法读取原文件。"))?;
            let now = fingerprint_of(target, &current);
            if now.hash != baseline.hash {
                return Err(ServiceError::new(
                    "file-changed",
                    "文件已被其他程序修改，请重新加载后再保存。",
                ));
            }
        }
    }
    let payload = apply_newline(content, newline);
    if payload.len() as u64 > MAX_MARKDOWN_BYTES {
        return Err(ServiceError::new(
            "file-too-large",
            "内容超过 10 MB 上限。",
        ));
    }
    if let Some(parent) = target.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let token = rand::random::<u64>();
    let temporary = target.with_extension(format!("{token:x}.markdesk-tmp"));
    fs::write(&temporary, payload.as_bytes())
        .map_err(|_| ServiceError::new("write-failed", "磁盘写入失败。"))?;
    if let Err(error) = fs::rename(&temporary, target) {
        let _ = fs::remove_file(&temporary);
        return Err(ServiceError::new(
            "write-failed",
            format!("磁盘写入失败：{error}"),
        ));
    }
    let bytes = fs::read(target).unwrap_or_default();
    let fingerprint = fingerprint_of(target, &bytes);
    Ok(FileWriteResult {
        path: canonical,
        hash: fingerprint.hash,
        mtime_ms: fingerprint.mtime_ms,
        size: fingerprint.size,
    })
}

pub fn file_exists(path: &str) -> bool {
    fs::metadata(path).map(|info| info.is_file()).unwrap_or(false)
}

pub fn now() -> f64 {
    now_ms()
}
