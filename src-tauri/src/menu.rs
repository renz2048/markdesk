//! 原生应用菜单（文件/编辑/段落/格式/主题 + 导出与最近打开子菜单；
//! 「段落 > 表格」为表格操作子菜单，模式切换经 Ctrl+/ 与状态栏入口）。

use crate::state::ThemePreference;
use tauri::menu::{
    CheckMenuItem, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

enum MenuNode {
    Item(Entry),
    Separator,
}

struct Entry {
    id: &'static str,
    text: &'static str,
    accelerator: Option<&'static str>,
}

const fn item(id: &'static str, text: &'static str, accelerator: Option<&'static str>) -> MenuNode {
    MenuNode::Item(Entry {
        id,
        text,
        accelerator,
    })
}

const fn separator() -> MenuNode {
    MenuNode::Separator
}

fn file_entries() -> Vec<MenuNode> {
    vec![
        item("new", "新建", Some("CmdOrCtrl+N")),
        item("new-window", "新窗口", Some("CmdOrCtrl+Shift+N")),
        item("open", "打开…", Some("CmdOrCtrl+O")),
        item("save", "保存", Some("CmdOrCtrl+S")),
        item("save-as", "另存为…", Some("CmdOrCtrl+Shift+S")),
    ]
}

fn export_entries() -> Vec<MenuNode> {
    vec![
        item("export-html", "HTML", None),
        item("export-pdf", "PDF", None),
        item("export-image", "图像", None),
        item("export-docx", "Word (.docx)", None),
        item("export-odt", "OpenOffice (.odt)", None),
        item("export-epub", "Epub", None),
        item("export-latex", "LaTeX", None),
        item("export-mediawiki", "MediaWiki", None),
    ]
}

/// 段落菜单前半段（plan.md 顺序）：标题 → 段落 → 级别调整；
/// 后接「表格」子菜单，再接 paragraph_entries_tail。
fn paragraph_entries_head() -> Vec<MenuNode> {
    vec![
        item("paragraph-heading-1", "一级标题", Some("CmdOrCtrl+1")),
        item("paragraph-heading-2", "二级标题", Some("CmdOrCtrl+2")),
        item("paragraph-heading-3", "三级标题", Some("CmdOrCtrl+3")),
        item("paragraph-heading-4", "四级标题", Some("CmdOrCtrl+4")),
        item("paragraph-heading-5", "五级标题", Some("CmdOrCtrl+5")),
        item("paragraph-heading-6", "六级标题", Some("CmdOrCtrl+6")),
        separator(),
        item("paragraph-paragraph", "段落", Some("CmdOrCtrl+0")),
        separator(),
        item("paragraph-heading-promote", "提升标题级别", Some("CmdOrCtrl+=")),
        item("paragraph-heading-demote", "降低标题级别", Some("CmdOrCtrl+-")),
    ]
}

/// 段落菜单后半段：「表格」子菜单之后的代码块/引用块、列表、水平分割线。
fn paragraph_entries_tail() -> Vec<MenuNode> {
    vec![
        item("paragraph-code-block", "代码块", Some("CmdOrCtrl+Shift+K")),
        item("paragraph-quote", "引用块", Some("CmdOrCtrl+Shift+Q")),
        separator(),
        item("paragraph-ordered-list", "有序列表", Some("CmdOrCtrl+Shift+O")),
        item("paragraph-bullet-list", "无序列表", Some("CmdOrCtrl+Shift+U")),
        item("paragraph-task-list", "任务列表", None),
        separator(),
        item("paragraph-horizontal-rule", "水平分割线", Some("CmdOrCtrl+Shift+-")),
    ]
}

/// 表格子菜单：「表格」菜单项指向的子菜单（plan.md）。除「插入表格」
/// 外仅在所见即所得模式且光标位于表格内时生效（渲染端命令自行判定，
/// 否则静默无操作）。
fn table_entries() -> Vec<MenuNode> {
    vec![
        item("table-insert", "插入表格", Some("CmdOrCtrl+T")),
        separator(),
        item("table-insert-row-above", "上方插入行", None),
        item("table-insert-row-below", "下方插入行", Some("CmdOrCtrl+Enter")),
        separator(),
        item("table-insert-column-left", "左侧插入列", None),
        item("table-insert-column-right", "右侧插入列", None),
        separator(),
        item("table-move-row-up", "上移该行", Some("Alt+ArrowUp")),
        item("table-move-row-down", "下移该行", Some("Alt+ArrowDown")),
        item("table-move-column-left", "左移该列", Some("Alt+ArrowLeft")),
        item("table-move-column-right", "右移该列", Some("Alt+ArrowRight")),
        separator(),
        item("table-delete-row", "删除行", Some("CmdOrCtrl+Shift+Backspace")),
        item("table-delete-column", "删除列", None),
        separator(),
        item("table-copy", "复制表格", None),
        item("table-format", "格式化表格源码", None),
        separator(),
        item("table-delete", "删除表格", None),
    ]
}

fn format_entries() -> Vec<MenuNode> {
    vec![
        item("format-bold", "加粗", Some("CmdOrCtrl+B")),
        item("format-italic", "斜体", Some("CmdOrCtrl+I")),
        item("format-strikethrough", "删除线", Some("CmdOrCtrl+Shift+X")),
        item("format-code", "代码", Some("CmdOrCtrl+Shift+`")),
        item("format-image", "图像…", Some("CmdOrCtrl+Shift+I")),
        item("format-clear", "清除格式", Some("CmdOrCtrl+\\")),
    ]
}

fn help_entries() -> Vec<MenuNode> {
    vec![item("about", "关于", None)]
}

fn push_entries<'a, R: Runtime, M: Manager<R>>(
    handle: &'a M,
    builder: SubmenuBuilder<'a, R, M>,
    entries: &[MenuNode],
) -> SubmenuBuilder<'a, R, M> {
    entries.iter().fold(builder, |builder, node| match node {
        MenuNode::Separator => builder.separator(),
        MenuNode::Item(entry) => {
            let mut menu_item = MenuItemBuilder::with_id(entry.id, entry.text);
            if let Some(accelerator) = entry.accelerator {
                menu_item = menu_item.accelerator(accelerator);
            }
            builder
                .item(&menu_item.build(handle).expect("菜单项创建失败"))
        }
    })
}

pub fn build(handle: &AppHandle) {
    let theme = handle
        .state::<crate::state::App>()
        .inner
        .lock()
        .unwrap()
        .theme;

    let file_menu = push_entries(handle, SubmenuBuilder::new(handle, "文件"), &file_entries());
    let export_menu = push_entries(handle, SubmenuBuilder::new(handle, "导出"), &export_entries());

    // 最近打开子菜单。
    let recent: Vec<crate::state::RecentFileStatus> =
        handle.state::<crate::state::App>().recent_statuses();
    let mut recent_menu = SubmenuBuilder::new(handle, "最近打开");
    if recent.is_empty() {
        recent_menu = recent_menu.item(
            &MenuItemBuilder::with_id("recent-none", "暂无最近文件")
                .enabled(false)
                .build(handle)
                .expect("菜单项创建失败"),
        );
    } else {
        for (index, file) in recent.iter().enumerate() {
            let label = if file.exists {
                file.name.clone()
            } else {
                format!("{}（文件不存在）", file.name)
            };
            recent_menu = recent_menu.item(
                &MenuItemBuilder::with_id(format!("recent-open:{}:{}", index, file.path), label)
                    .enabled(file.exists)
                    .build(handle)
                    .expect("菜单项创建失败"),
            );
        }
    }
    recent_menu = recent_menu.separator().item(
        &MenuItemBuilder::with_id("recent-clear", "清除最近文件")
            .enabled(!recent.is_empty())
            .build(handle)
            .expect("菜单项创建失败"),
    );

    let file_menu = file_menu
        .separator()
        .item(&export_menu.build().expect("导出子菜单创建失败"))
        .separator()
        .item(&recent_menu.build().expect("最近打开子菜单创建失败"))
        .separator()
        .item(
            &MenuItemBuilder::with_id("close-window", "关闭")
                .accelerator("CmdOrCtrl+W")
                .build(handle)
                .expect("菜单项创建失败"),
        )
        .build()
        .expect("文件菜单创建失败");

    let edit_menu = SubmenuBuilder::new(handle, "编辑")
        .item(&PredefinedMenuItem::undo(handle, None).expect("undo"))
        .item(&PredefinedMenuItem::redo(handle, None).expect("redo"))
        .separator()
        .item(&PredefinedMenuItem::cut(handle, None).expect("cut"))
        .item(&PredefinedMenuItem::copy(handle, None).expect("copy"))
        .item(&PredefinedMenuItem::paste(handle, None).expect("paste"))
        .item(&PredefinedMenuItem::select_all(handle, None).expect("select all"))
        .build()
        .expect("编辑菜单创建失败");

    let table_menu = push_entries(handle, SubmenuBuilder::new(handle, "表格"), &table_entries())
        .build()
        .expect("表格子菜单创建失败");
    let paragraph_menu = push_entries(
        handle,
        push_entries(
            handle,
            SubmenuBuilder::new(handle, "段落"),
            &paragraph_entries_head(),
        )
        .separator()
        .item(&table_menu)
        .separator(),
        &paragraph_entries_tail(),
    )
    .build()
    .expect("段落菜单创建失败");
    let format_menu = push_entries(handle, SubmenuBuilder::new(handle, "格式"), &format_entries())
        .build()
        .expect("格式菜单创建失败");
    // 帮助菜单固定在最右（最后加入 MenuBuilder）。
    let help_menu = push_entries(handle, SubmenuBuilder::new(handle, "帮助"), &help_entries())
        .build()
        .expect("帮助菜单创建失败");

    let theme_light = CheckMenuItem::with_id(handle, "theme-light", "浅色", true, theme == ThemePreference::Light, None::<&str>)
        .expect("主题项创建失败");
    let theme_dark = CheckMenuItem::with_id(handle, "theme-dark", "深色", true, theme == ThemePreference::Dark, None::<&str>)
        .expect("主题项创建失败");
    let theme_system = CheckMenuItem::with_id(handle, "theme-system", "跟随系统", true, theme == ThemePreference::System, None::<&str>)
        .expect("主题项创建失败");
    let theme_menu = SubmenuBuilder::new(handle, "主题")
        .item(&theme_light)
        .item(&theme_dark)
        .item(&theme_system)
        .build()
        .expect("主题菜单创建失败");

    let menu = MenuBuilder::new(handle)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&paragraph_menu)
        .item(&format_menu)
        .item(&theme_menu)
        .item(&help_menu)
        .build()
        .expect("应用菜单创建失败");

    handle
        .set_menu(menu)
        .expect("应用菜单设置失败");
}

/// 最近文件或主题变化后重建菜单。
pub fn rebuild(handle: &AppHandle) {
    build(handle);
}

/// 菜单事件分发：普通命令发渲染端；新窗口/关闭/最近打开在主进程处理。
pub fn on_event(handle: &AppHandle, id: &str) {
    if id == "new-window" {
        crate::window::create_main(handle);
        return;
    }
    if id == "close-window" {
        if let Some(window) = handle.webview_windows().values().next() {
            crate::window::request_close(handle, window);
        }
        return;
    }
    if let Some(path) = id.strip_prefix("recent-open:") {
        let path = path.split_once(':').map(|(_, rest)| rest).unwrap_or(path);
        let canonical = crate::policy::canonicalize(path);
        if crate::service::file_exists(&canonical) {
            handle.state::<crate::state::App>().inner.lock().unwrap().read_grants.insert(canonical.clone());
            handle
                .state::<crate::state::App>()
                .upsert_recent(&canonical);
            let _ = handle.emit("open-recent-file", serde_json::json!({ "path": canonical }));
            rebuild(handle);
            let statuses = handle.state::<crate::state::App>().recent_statuses();
            let _ = handle.emit("recent-files-changed", statuses);
        }
        return;
    }
    if id == "recent-clear" {
        handle.state::<crate::state::App>().inner.lock().unwrap().recent.clear();
        handle.state::<crate::state::App>().persist_recent();
        rebuild(handle);
        let statuses = handle.state::<crate::state::App>().recent_statuses();
        let _ = handle.emit("recent-files-changed", statuses);
        return;
    }
    let _ = handle.emit("menu-command", serde_json::json!({ "command": id }));
}
