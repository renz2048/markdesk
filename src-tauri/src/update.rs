//! 在线更新：查询 GitHub Release、匹配当前平台/架构的安装包、下载并
//! 启动安装。全部网络访问在主进程完成，不经过 WebView（与 CSP 无关）。
//!
//! 各平台的“安装”语义：
//! - Windows（NSIS）：启动安装向导后退出应用（旧 exe 会被覆盖，必须先退）
//! - Linux AppImage：下载新镜像覆盖自身并重启（无感更新）
//! - Linux deb / macOS dmg：交给系统默认处理器（软件中心 / Finder 挂载）

use crate::service::ServiceError;
use serde::Serialize;
use std::io::Read;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub const REPO: &str = "renz2048/markdesk";
const USER_AGENT: &str = "markdesk-updater";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseInfo {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub asset_name: String,
    pub asset_url: String,
    pub asset_size: u64,
    pub release_url: String,
}

/// 下载完成后的处理结果，渲染端据此提示。
/// 各平台仅构造自己的变体（Windows 编译会看到另两个变体未使用）。
#[allow(dead_code)]
#[derive(Serialize, Clone)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateOutcome {
    /// 已启动安装向导并即将退出（Windows NSIS）。
    InstallerLaunched,
    /// 已用新镜像替换自身并重启（AppImage）。
    SelfReplaced,
    /// 已交给系统默认处理器（deb / dmg）。
    Opened,
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .build()
}

/// "v0.5.1" / "0.5.1" → 数字段向量，逐段比较（缺省为 0）。
pub fn version_parts(tag: &str) -> Vec<u64> {
    tag.trim_start_matches('v')
        .split('.')
        .map(|part| {
            part.chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse::<u64>()
                .unwrap_or(0)
        })
        .collect()
}

pub fn is_newer(candidate: &str, current: &str) -> bool {
    let (a, b) = (version_parts(candidate), version_parts(current));
    for index in 0..a.len().max(b.len()) {
        let left = a.get(index).copied().unwrap_or(0);
        let right = b.get(index).copied().unwrap_or(0);
        if left != right {
            return left > right;
        }
    }
    false
}

/// 产物命名与 release.yml / scripts/rename-bundle.mjs 对应：
/// NSIS `…_<arch>.exe` 用 x64/arm64；deb 与 AppImage 用 amd64/arm64；
/// dmg 用 x64/aarch64。
pub fn asset_suffix(os: &str, arch: &str, appimage: bool) -> Option<String> {
    if os == "windows" {
        match arch {
            "x86_64" => Some("_x64.exe".into()),
            "aarch64" => Some("_arm64.exe".into()),
            _ => None,
        }
    } else if os == "macos" {
        match arch {
            "x86_64" => Some("_x64.dmg".into()),
            "aarch64" => Some("_aarch64.dmg".into()),
            _ => None,
        }
    } else if os == "linux" {
        let ext = if appimage { ".AppImage" } else { ".deb" };
        match arch {
            "x86_64" => Some(format!("_amd64{ext}")),
            "aarch64" => Some(format!("_arm64{ext}")),
            _ => None,
        }
    } else {
        None
    }
}

fn pick_asset<'a>(
    assets: &'a [serde_json::Value],
    suffix: &str,
) -> Option<(&'a str, &'a str, u64)> {
    let lowered = suffix.to_lowercase();
    for asset in assets {
        let name = asset.get("name")?.as_str()?;
        if !name.to_lowercase().ends_with(&lowered) {
            continue;
        }
        let url = asset.get("browser_download_url")?.as_str()?;
        let size = asset.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
        return Some((name, url, size));
    }
    None
}

pub fn fetch_latest_release() -> Result<ReleaseInfo, ServiceError> {
    let api = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let response: serde_json::Value = agent()
        .get(&api)
        .set("User-Agent", USER_AGENT)
        .set("Accept", "application/vnd.github+json")
        .call()
        .map_err(|_| ServiceError::new("update-network", "无法访问 GitHub，请检查网络。"))?
        .into_json()
        .map_err(|_| ServiceError::new("update-network", "Release 信息解析失败。"))?;

    let tag = response
        .get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ServiceError::new("update-network", "Release 缺少版本号。"))?;
    let release_url = response
        .get("html_url")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let empty = Vec::new();
    let assets = response
        .get("assets")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty);

    let suffix = asset_suffix(
        std::env::consts::OS,
        std::env::consts::ARCH,
        std::env::var("APPIMAGE").is_ok(),
    )
    .ok_or_else(|| {
        ServiceError::new(
            "update-unsupported",
            "当前平台或架构没有对应的发布产物。",
        )
    })?;
    let (name, url, size) = pick_asset(assets, &suffix).ok_or_else(|| {
        ServiceError::new(
            "update-no-asset",
            format!("最新 Release 未提供匹配的安装包（{suffix}）。"),
        )
    })?;

    let current = env!("CARGO_PKG_VERSION");
    Ok(ReleaseInfo {
        current_version: current.to_string(),
        latest_version: tag.trim_start_matches('v').to_string(),
        update_available: is_newer(tag, current),
        asset_name: name.to_string(),
        asset_url: url.to_string(),
        asset_size: size,
        release_url,
    })
}

fn emit_progress(handle: &AppHandle, downloaded: u64, total: u64) {
    let _ = handle.emit(
        "update-progress",
        serde_json::json!({ "downloaded": downloaded, "total": total }),
    );
}

fn download_to(handle: &AppHandle, url: &str, target: &std::path::Path) -> Result<(), ServiceError> {
    let response = agent()
        .get(url)
        .set("User-Agent", USER_AGENT)
        .call()
        .map_err(|_| ServiceError::new("update-network", "下载失败，请检查网络。"))?;
    let total = response
        .header("Content-Length")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let mut reader = response.into_reader();
    let mut file = std::fs::File::create(target)
        .map_err(|_| ServiceError::new("write-failed", "无法写入下载文件。"))?;
    let mut buffer = [0u8; 64 * 1024];
    let mut downloaded: u64 = 0;
    let mut since_event: u64 = 0;
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|_| ServiceError::new("update-network", "下载中断。"))?;
        if read == 0 {
            break;
        }
        std::io::Write::write_all(&mut file, &buffer[..read])
            .map_err(|_| ServiceError::new("write-failed", "下载写入失败。"))?;
        downloaded += read as u64;
        // 每 512 KiB 上报一次进度，避免事件风暴。
        since_event += read as u64;
        if since_event >= 512 * 1024 || downloaded == total {
            since_event = 0;
            emit_progress(handle, downloaded, total);
        }
    }
    if total > 0 && downloaded != total {
        return Err(ServiceError::new("update-network", "下载不完整，请重试。"));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn set_executable(path: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).is_ok()
}

/// 下载并安装。阻塞（含网络下载），调用方需放入后台线程；
/// Windows 下启动安装器后约 1 秒退出应用，给渲染端留出提示时间。
pub fn download_and_install(handle: AppHandle, url: &str, asset_name: &str) -> Result<UpdateOutcome, ServiceError> {
    if !is_safe_asset_name(asset_name) {
        return Err(ServiceError::new("invalid-argument", "安装包文件名无效。"));
    }
    let target = std::env::temp_dir().join(asset_name);
    download_to(&handle, url, &target)?;

    #[cfg(target_os = "windows")]
    {
        // NSIS 安装向导接管；旧 exe 将被覆盖，先退出应用。
        let installer = target.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(1));
            if std::process::Command::new(&installer).spawn().is_ok() {
                handle.exit(0);
            }
        });
        return Ok(UpdateOutcome::InstallerLaunched);
    }

    #[cfg(target_os = "linux")]
    {
        if std::env::var("APPIMAGE").is_ok() {
            // AppImage：用新镜像覆盖自身后重启（同文件系统 rename 保证原子性）。
            let current = std::env::current_exe()
                .map_err(|_| ServiceError::new("update-failed", "无法定位当前程序。"))?;
            let staged = current.with_extension("appimage-new");
            std::fs::rename(&target, &staged)
                .or_else(|_| std::fs::copy(&target, &staged).map(|_| ()))
                .map_err(|_| ServiceError::new("write-failed", "无法暂存新版本。"))?;
            if !set_executable(&staged) {
                return Err(ServiceError::new("update-failed", "无法设置可执行权限。"));
            }
            std::fs::rename(&staged, &current)
                .map_err(|_| ServiceError::new("update-failed", "无法替换当前版本。"))?;
            let app = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(500));
                if std::process::Command::new(&current).spawn().is_ok() {
                    app.exit(0);
                }
            });
            return Ok(UpdateOutcome::SelfReplaced);
        }
        // deb：交给系统包安装器。
        std::process::Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map_err(|_| ServiceError::new("update-failed", "无法打开安装包。"))?;
        return Ok(UpdateOutcome::Opened);
    }

    #[cfg(target_os = "macos")]
    {
        // dmg：Finder 挂载，用户拖入 Applications。
        std::process::Command::new("open")
            .arg(&target)
            .spawn()
            .map_err(|_| ServiceError::new("update-failed", "无法打开安装包。"))?;
        return Ok(UpdateOutcome::Opened);
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        Err(ServiceError::new("update-unsupported", "当前平台不支持在线更新。"))
    }
}

/// 下载落盘的文件名只允许安全字符（防路径穿越/控制字符）。
fn is_safe_asset_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.contains(['/', '\\', ':'])
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_versions_numerically() {
        assert!(is_newer("v0.6.0", "0.5.9"));
        assert!(is_newer("0.5.10", "v0.5.9"));
        assert!(!is_newer("v0.5.1", "0.5.1"));
        assert!(!is_newer("v0.5.2", "0.5.10"));
        assert!(is_newer("v1.0.0-rc.1", "0.9.9"));
    }

    #[test]
    fn maps_asset_suffixes_per_platform_and_arch() {
        assert_eq!(asset_suffix("windows", "x86_64", false), Some("_x64.exe".into()));
        assert_eq!(asset_suffix("windows", "aarch64", false), Some("_arm64.exe".into()));
        assert_eq!(asset_suffix("macos", "x86_64", false), Some("_x64.dmg".into()));
        assert_eq!(asset_suffix("macos", "aarch64", false), Some("_aarch64.dmg".into()));
        assert_eq!(asset_suffix("linux", "x86_64", true), Some("_amd64.AppImage".into()));
        assert_eq!(asset_suffix("linux", "x86_64", false), Some("_amd64.deb".into()));
        assert_eq!(asset_suffix("linux", "aarch64", false), Some("_arm64.deb".into()));
        assert_eq!(asset_suffix("plan9", "x86_64", false), None);
        assert_eq!(asset_suffix("windows", "riscv64", false), None);
    }

    #[test]
    fn picks_case_insensitive_asset_with_size() {
        let assets = serde_json::json!([
            { "name": "MarkDesk_0.6.0_amd64.deb", "browser_download_url": "https://x/deb", "size": 100 },
            { "name": "MarkDesk_0.6.0_x64.exe", "browser_download_url": "https://x/exe", "size": 200 },
        ]);
        let array = assets.as_array().unwrap();
        assert_eq!(
            pick_asset(array, "_x64.exe"),
            Some(("MarkDesk_0.6.0_x64.exe", "https://x/exe", 200))
        );
        assert_eq!(pick_asset(array, "_arm64.exe"), None);
    }

    #[test]
    fn validates_asset_names() {
        assert!(is_safe_asset_name("MarkDesk_0.6.0_x64.exe"));
        assert!(!is_safe_asset_name("../evil.exe"));
        assert!(!is_safe_asset_name(""));
        assert!(!is_safe_asset_name("a/b.exe"));
        assert!(!is_safe_asset_name("a:b.exe"));
    }

    /// 真实 GitHub API 冒烟（opt-in）：cargo test -- --ignored。
    /// 依赖网络与已发布的 Release；断言按当前平台/架构匹配到产物。
    #[test]
    #[ignore = "live: 需要 GitHub 网络与已发布 Release"]
    fn fetches_live_release() {
        let info = fetch_latest_release().expect("release 查询失败");
        assert!(
            info.latest_version
                .chars()
                .all(|c| c.is_ascii_digit() || c == '.'),
            "版本号应为纯数字段：{}",
            info.latest_version
        );
        assert!(info.asset_url.starts_with("https://"));
        assert!(!info.asset_name.is_empty());
        println!(
            "current={} latest={} asset={} update_available={}",
            info.current_version, info.latest_version, info.asset_name, info.update_available
        );
    }
}
