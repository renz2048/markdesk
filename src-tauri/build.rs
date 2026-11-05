//! 构建期信息采集：git 提交/日期与关键依赖版本（解析 Cargo.lock），
//! 经 rustc-env 注入，供“关于”对话框展示。
//!
//! 不声明 rerun-if 指令：默认随包内任一文件变化重跑，提交通常伴随
//! 文件变化，提交号因此保持新鲜；git 不可用时回退 "unknown"。

use std::process::Command;

fn git_output(args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8(output.stdout).ok()?.trim().to_string())
}

/// Cargo.lock 条目形如 `name = "tauri"` 的下一行 `version = "2.9.3"`。
fn lock_version(lock: &str, name: &str) -> String {
    let expected = format!("name = \"{name}\"");
    let mut lines = lock.lines().map(str::trim);
    while let Some(line) = lines.next() {
        if line != expected {
            continue;
        }
        if let Some(version_line) = lines.next() {
            if let Some(rest) = version_line.strip_prefix("version = ") {
                return rest.trim_matches('"').to_string();
            }
        }
    }
    "unknown".to_string()
}

fn main() {
    let commit = git_output(&["log", "-1", "--format=%h"]).unwrap_or_else(|| "unknown".into());
    let date = git_output(&["log", "-1", "--format=%cd", "--date=format:%Y-%m-%d"])
        .unwrap_or_else(|| "unknown".into());

    let lock = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.lock"))
        .unwrap_or_default();

    println!("cargo:rustc-env=MARKDESK_BUILD_COMMIT={commit}");
    println!("cargo:rustc-env=MARKDESK_BUILD_DATE={date}");
    println!("cargo:rustc-env=MARKDESK_DEP_TAURI={}", lock_version(&lock, "tauri"));
    println!("cargo:rustc-env=MARKDESK_DEP_WRY={}", lock_version(&lock, "wry"));
    println!("cargo:rustc-env=MARKDESK_DEP_TAO={}", lock_version(&lock, "tao"));
    println!("cargo:rustc-env=MARKDESK_DEP_NOTIFY={}", lock_version(&lock, "notify"));

    tauri_build::build()
}
