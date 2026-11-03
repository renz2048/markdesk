// 防止 Windows 发布构建弹控制台窗口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    markdesk_lib::run()
}
