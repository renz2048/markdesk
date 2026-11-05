//! 路径分类、规范化与 markdesk-resource 协议解析（自 src/electron/ipc.ts
//! 与 src/markdown/urlPolicy.ts 逐条移植；语义必须与 Electron 版一致）。

use std::path::Path;

const IMAGE_EXTENSIONS: [&str; 7] = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"];
const MARKDOWN_EXTENSIONS: [&str; 2] = [".md", ".markdown"];

pub fn has_control_chars(value: &str) -> bool {
    value.chars().any(|c| (c as u32) < 0x20 || (c as u32) == 0x7f || (0x80..=0x9f).contains(&(c as u32)))
}

/// 末段扩展名（小写、含点）。反斜杠视为 Windows 分隔符。
pub fn extension_of(value: &str) -> String {
    let file_name = value
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(value);
    match file_name.rfind('.') {
        Some(index) => file_name[index..].to_lowercase(),
        None => String::new(),
    }
}

pub fn is_image_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && !has_control_chars(value)
        && IMAGE_EXTENSIONS.contains(&extension_of(value).as_str())
}

pub fn is_markdown_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && !has_control_chars(value)
        && (is_win_absolute(value) || is_posix_absolute(value))
        && MARKDOWN_EXTENSIONS.contains(&extension_of(value).as_str())
}

/// 本地绝对路径：Windows 盘符 / UNC / POSIX（与渲染端 absolutePathPattern 一致）。
pub fn is_local_absolute(value: &str) -> bool {
    is_drive_path(value) || value.starts_with("\\\\") || value.starts_with("//") || {
        let mut chars = value.chars();
        matches!(chars.next(), Some('/')) && !matches!(chars.next(), Some('/') | None)
    }
}

fn is_drive_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\')
}

pub fn is_win_absolute(value: &str) -> bool {
    is_drive_path(value) || value.starts_with("\\\\") || value.starts_with("//")
}

pub fn is_posix_absolute(value: &str) -> bool {
    value.starts_with('/')
        && !value.starts_with("//")
        && std::env::consts::OS != "windows"
}

/// 目录按哪种语义解析（盘符 / UNC → win32，其余 posix）。
fn uses_win32(directory: &str) -> bool {
    is_drive_path(directory) || directory.starts_with("\\\\") || directory.starts_with("//")
}

/// 规范化一个已解析的路径段序列：消解 `.` 与 `..`，统一分隔符。
/// base 为空（POSIX 根）、盘符前缀（“c:”）或 UNC 根（“\\\\”，不可
/// 裁剪成单分隔符，否则 \\server\share 会变成 \server\share）。
fn normalize_parts(base: &str, parts: Vec<String>, separator: char, lower: bool) -> String {
    let mut stack: Vec<String> = Vec::new();
    for part in parts {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            stack.pop();
            continue;
        }
        stack.push(part);
    }
    let joined = stack.join(&separator.to_string());
    let mut result = if base == "\\\\" {
        // UNC 根：保留双反斜杠前缀。
        format!(r"\\{joined}")
    } else {
        let prefix = base.trim_end_matches(['/', '\\']);
        if prefix.is_empty() {
            format!("{}{}", separator, joined)
        } else {
            format!("{}{}{}", prefix, separator, joined)
        }
    };
    if lower {
        result = result.to_lowercase();
    }
    result
}

fn split_path(value: &str) -> (String, Vec<String>) {
    let normalized = value.replace('\\', "/");
    let mut parts: Vec<String> = normalized
        .split('/')
        .filter(|part| !part.is_empty())
        .map(String::from)
        .collect();
    if let Some(first) = parts.first() {
        // 盘符前缀（"c:"）作为根保留。
        if first.len() == 2 && first.as_bytes()[1] == b':' {
            let base = parts.remove(0).to_lowercase();
            return (base, parts);
        }
    }
    (String::new(), parts)
}

/// Node path.resolve(base, rel) 的移植：base 必须是绝对路径。
pub fn resolve_against(base: &str, rel: &str) -> String {
    let win32 = uses_win32(base);
    let is_absolute_rel = if win32 { is_win_absolute(rel) } else { rel.starts_with('/') };
    let (root, start_parts) = if is_absolute_rel {
        split_path(rel)
    } else {
        let (root, mut parts) = split_path(base);
        parts.extend(split_path(rel).1);
        (root, parts)
    };
    if win32 {
        let prefix = if root.is_empty() { "\\\\".to_string() } else { root };
        normalize_parts(&prefix, start_parts, '\\', false)
    } else {
        normalize_parts("", start_parts, '/', false)
    }
}

/// normalizeUnresolvedPath 的移植：盘符路径小写化（Windows 不区分大小写），
/// UNC 保留大小写（WSL 等区分大小写），其余走 POSIX 语义。
pub fn normalize_unresolved(path: &str) -> String {
    if is_drive_path(path) {
        return resolve_against(path, "").to_lowercase();
    }
    if path.starts_with("\\\\") || path.starts_with("//") {
        return resolve_against(path, "");
    }
    resolve_against_posix_rooted(path)
}

fn resolve_against_posix_rooted(path: &str) -> String {
    // POSIX：直接以 / 为根规范化。
    let parts: Vec<String> = path
        .replace('\\', "/")
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .map(String::from)
        .collect();
    normalize_parts("", parts, '/', false)
}

/// canonicalize 的移植：先 realpath（解析符号链接）再规范化；目标不存在时
/// 仅规范化。Windows 的 \\?\ 前缀剥除。
pub fn canonicalize(path: &str) -> String {
    match std::fs::canonicalize(Path::new(path)) {
        Ok(real) => normalize_unresolved(&strip_verbatim(&real.to_string_lossy())),
        Err(_) => normalize_unresolved(path),
    }
}

/// Windows 的 canonicalize 返回 verbatim 形态：盘符 → \\?\C:\…，UNC →
/// \\?\UNC\server\share\…。UNC 必须还原成 \\server\share\… 再规范化，
/// 否则剥掉 \\?\ 后剩余的 “UNC\server\…” 不再以 \\ 开头，会被当作
/// POSIX 路径解析，导致 WSL（\\wsl.localhost\…）等网络路径被
/// is_markdown_path 误拒。
fn strip_verbatim(text: &str) -> String {
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else {
        text.strip_prefix(r"\\?\").unwrap_or(text).to_string()
    }
}

/// resolveResourcePath 的移植。入参是协议路径（已剥掉 scheme 与 host，
/// 未做百分号解码）。返回磁盘路径，或 None（拒绝）。
pub fn resolve_resource_path(
    open_directories: &[String],
    encoded: &str,
    granted_absolute: &[String],
) -> Option<String> {
    let relative = percent_encoding::percent_decode_str(encoded)
        .decode_utf8()
        .ok()?;

    if let Some(absolute) = relative.strip_prefix("absolute/") {
        // 整段只解码一次；授权逐字匹配 + 图片扩展名。
        if !granted_absolute.iter().any(|granted| granted == absolute) {
            return None;
        }
        if !is_image_path(absolute) {
            return None;
        }
        return Some(absolute.to_string());
    }

    if relative.is_empty()
        || relative.len() > 1024
        || has_control_chars(&relative)
        || relative.starts_with('/')
        || relative.starts_with('\\')
        || is_drive_path(&relative)
        || relative.starts_with("\\\\")
        || relative.starts_with("//")
        || {
            // scheme: 形式（mailto: 等）一律拒绝。
            let bytes = relative.as_bytes();
            bytes.len() >= 2
                && bytes[0].is_ascii_alphabetic()
                && relative.contains(':')
                && relative
                    .chars()
                    .take_while(|c| *c != ':')
                    .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.')
        }
        || !is_image_path(&relative)
    {
        return None;
    }

    for directory in open_directories {
        let win32 = uses_win32(directory);
        let separator = if win32 { '\\' } else { '/' };
        let base = if win32 {
            resolve_against(directory, "")
        } else {
            resolve_against_posix_rooted(directory)
        };
        let resolved = resolve_against(directory, &relative);
        if resolved.starts_with(&format!("{}{}", base, separator)) {
            return Some(resolved);
        }
    }
    None
}

pub fn media_type_for(path: &str) -> &'static str {
    match extension_of(path).as_str() {
        ".png" => "image/png",
        ".jpg" | ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".svg" => "image/svg+xml",
        ".avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_relative_images_inside_doc_directory() {
        let dirs = vec![r#"C:\Docs\notes"#.to_string()];
        // 盘符路径按 win32 语义小写化（与 Electron 版 canonicalize 一致）。
        assert_eq!(
            resolve_resource_path(&dirs, "assets/pic.png", &[]),
            Some(r#"c:\Docs\notes\assets\pic.png"#.to_string())
        );
    }

    #[test]
    fn rejects_traversal_and_non_images() {
        let dirs = vec![r#"C:\Docs\notes"#.to_string()];
        assert_eq!(resolve_resource_path(&dirs, "../secret.png", &[]), None);
        assert_eq!(resolve_resource_path(&dirs, "assets/pic.js", &[]), None);
        assert_eq!(resolve_resource_path(&dirs, "mailto:x@y.z", &[]), None);
    }

    #[test]
    fn grants_only_exact_absolute_matches() {
        let dirs = vec![r#"C:\Docs\notes"#.to_string()];
        let granted = vec![r#"C:\Pictures\outside.png"#.to_string()];
        let encoded = "absolute/".to_string()
            + &percent_encoding::utf8_percent_encode(
                r#"C:\Pictures\outside.png"#,
                percent_encoding::NON_ALPHANUMERIC,
            )
            .to_string();
        assert_eq!(
            resolve_resource_path(&dirs, &encoded, &granted),
            Some(r#"C:\Pictures\outside.png"#.to_string())
        );
        assert_eq!(resolve_resource_path(&dirs, &encoded, &[]), None);
    }

    #[test]
    fn normalizes_drive_letter_case() {
        assert_eq!(
            normalize_unresolved(r#"c:\Users\Notes\a.md"#),
            r#"c:\users\notes\a.md"#
        );
    }

    #[test]
    fn strips_verbatim_prefixes_from_canonicalize() {
        // 盘符 verbatim 形态。
        assert_eq!(strip_verbatim(r"\\?\C:\Users\Notes\a.md"), r"C:\Users\Notes\a.md");
        // UNC verbatim 形态（WSL）：必须还原前导 \\，否则不再是绝对路径。
        assert_eq!(
            strip_verbatim(r"\\?\UNC\wsl.localhost\Ubuntu-26.04\home\renzheng\a.md"),
            r"\\wsl.localhost\Ubuntu-26.04\home\renzheng\a.md"
        );
        // 非 verbatim 输入原样返回。
        assert_eq!(strip_verbatim(r"\\wsl$\Ubuntu-26.04\home\a.md"), r"\\wsl$\Ubuntu-26.04\home\a.md");
    }

    #[test]
    fn accepts_wsl_unc_markdown_path() {
        // 还原后的 WSL UNC 路径是合法的 win32 绝对路径（且保留大小写）。
        let restored = strip_verbatim(
            r"\\?\UNC\wsl.localhost\Ubuntu-26.04\home\renzheng\plans\2026-11-05-elb-dp-l3.md",
        );
        assert_eq!(
            normalize_unresolved(&restored),
            r"\\wsl.localhost\Ubuntu-26.04\home\renzheng\plans\2026-11-05-elb-dp-l3.md"
        );
        assert!(is_markdown_path(&restored));
    }

    #[test]
    fn normalizes_plain_unc_inputs() {
        // 未走 canonicalize 的 UNC 输入（正/反斜杠两种形态）也要保住双前缀。
        assert_eq!(
            normalize_unresolved(r"\\wsl.localhost\Ubuntu-26.04\home\renzheng\a.md"),
            r"\\wsl.localhost\Ubuntu-26.04\home\renzheng\a.md"
        );
        assert_eq!(
            normalize_unresolved("//wsl.localhost/Ubuntu-26.04/home/renzheng/../renzheng/a.md"),
            r"\\wsl.localhost\Ubuntu-26.04\home\renzheng\a.md"
        );
    }
}
