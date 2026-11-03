//! 窗口标题栏/菜单随主题变化（对应 Electron 的 nativeTheme.themeSource）。

use crate::state::ThemePreference;
use tauri::{AppHandle, Manager, WebviewWindow};

pub fn apply(handle: &AppHandle, preference: ThemePreference) {
    let resolved = match preference {
        ThemePreference::Light => Some(tauri::Theme::Light),
        ThemePreference::Dark => Some(tauri::Theme::Dark),
        ThemePreference::System => None,
    };
    for window in handle.webview_windows().values() {
        match resolved {
            Some(theme) => {
                let _ = window.set_theme(Some(theme));
            }
            None => {
                let _ = window.set_theme(None);
            }
        }
    }
}

/// 当前系统是否深色（供菜单勾选初始状态；渲染端自行用 matchMedia）。
pub fn system_prefers_dark(handle: &AppHandle) -> bool {
    handle
        .webview_windows()
        .values()
        .find_map(|window: &WebviewWindow| window.theme().ok())
        .map(|theme| theme == tauri::Theme::Dark)
        .unwrap_or(false)
}
