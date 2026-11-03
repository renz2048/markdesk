import { Menu } from "electron";
import type {
  MenuCommand,
  RecentFileStatus,
  ThemePreferenceSetting,
} from "../shared/types";

interface CommandMenuItem {
  command: MenuCommand;
  label: string;
  accelerator?: string;
}

// 菜单项之间允许穿插分隔线（用字符串字面量判别）。
type MenuEntry = CommandMenuItem | "separator";

const fileCommands: MenuEntry[] = [
  { command: "new", label: "新建", accelerator: "CmdOrCtrl+N" },
  {
    command: "new-window",
    label: "新窗口",
    accelerator: "CmdOrCtrl+Shift+N",
  },
  { command: "open", label: "打开…", accelerator: "CmdOrCtrl+O" },
];

// HTML/PDF/图像 由应用自身渲染导出；其余格式经系统 Pandoc 转换
//（未安装 Pandoc 时点击会提示安装）。
const exportCommands: MenuEntry[] = [
  { command: "export-html", label: "HTML" },
  { command: "export-pdf", label: "PDF" },
  { command: "export-image", label: "图像" },
  "separator",
  { command: "export-docx", label: "Word (.docx)" },
  { command: "export-odt", label: "OpenOffice (.odt)" },
  { command: "export-epub", label: "Epub" },
  { command: "export-latex", label: "LaTeX" },
  { command: "export-mediawiki", label: "MediaWiki" },
];

const windowCommands: MenuEntry[] = [
  { command: "close-window", label: "关闭", accelerator: "CmdOrCtrl+W" },
];

const modeCommands: MenuEntry[] = [
  { command: "toggle-wysiwyg", label: "所见即所得模式" },
  // Typora 的源码模式快捷键是 Ctrl+/。
  { command: "toggle-source", label: "源码模式", accelerator: "CmdOrCtrl+/" },
  { command: "toggle-read", label: "阅读模式" },
];

// 块级结构（对齐 Typora「段落」菜单及快捷键）。
const paragraphCommands: MenuEntry[] = [
  {
    command: "paragraph-paragraph",
    label: "段落",
    accelerator: "CmdOrCtrl+0",
  },
  "separator",
  {
    command: "paragraph-heading-1",
    label: "一级标题",
    accelerator: "CmdOrCtrl+1",
  },
  {
    command: "paragraph-heading-2",
    label: "二级标题",
    accelerator: "CmdOrCtrl+2",
  },
  {
    command: "paragraph-heading-3",
    label: "三级标题",
    accelerator: "CmdOrCtrl+3",
  },
  {
    command: "paragraph-heading-4",
    label: "四级标题",
    accelerator: "CmdOrCtrl+4",
  },
  {
    command: "paragraph-heading-5",
    label: "五级标题",
    accelerator: "CmdOrCtrl+5",
  },
  {
    command: "paragraph-heading-6",
    label: "六级标题",
    accelerator: "CmdOrCtrl+6",
  },
  "separator",
  {
    command: "paragraph-heading-promote",
    label: "提升标题级别",
    accelerator: "CmdOrCtrl+=",
  },
  {
    command: "paragraph-heading-demote",
    label: "降低标题级别",
    accelerator: "CmdOrCtrl+-",
  },
  "separator",
  { command: "paragraph-table", label: "表格", accelerator: "CmdOrCtrl+T" },
  {
    command: "paragraph-code-block",
    label: "代码块",
    accelerator: "CmdOrCtrl+Shift+K",
  },
  {
    command: "paragraph-quote",
    label: "引用块",
    accelerator: "CmdOrCtrl+Shift+Q",
  },
  {
    command: "paragraph-ordered-list",
    label: "有序列表",
    accelerator: "CmdOrCtrl+Shift+O",
  },
  {
    command: "paragraph-bullet-list",
    label: "无序列表",
    accelerator: "CmdOrCtrl+Shift+U",
  },
  { command: "paragraph-task-list", label: "任务列表" },
  {
    command: "paragraph-horizontal-rule",
    label: "水平分割线",
    accelerator: "CmdOrCtrl+Shift+-",
  },
];

// 行内格式（对齐 Typora「格式」菜单及快捷键；下划线/高亮在
// Markdown 语法中不存在，未提供）。
const formatCommands: MenuEntry[] = [
  { command: "format-bold", label: "加粗", accelerator: "CmdOrCtrl+B" },
  { command: "format-italic", label: "斜体", accelerator: "CmdOrCtrl+I" },
  {
    command: "format-strikethrough",
    label: "删除线",
    accelerator: "CmdOrCtrl+Shift+X",
  },
  {
    command: "format-code",
    label: "代码",
    accelerator: "CmdOrCtrl+Shift+`",
  },
  "separator",
  { command: "format-image", label: "图像…", accelerator: "CmdOrCtrl+Shift+I" },
  "separator",
  { command: "format-clear", label: "清除格式", accelerator: "CmdOrCtrl+\\" },
];

const themeCommands: Array<{
  command: MenuCommand;
  label: string;
  theme: ThemePreferenceSetting;
}> = [
  { command: "theme-light", label: "浅色", theme: "light" },
  { command: "theme-dark", label: "深色", theme: "dark" },
  { command: "theme-system", label: "跟随系统", theme: "system" },
];

function commandItem(
  sendCommand: (command: MenuCommand) => void,
  item: CommandMenuItem,
) {
  return {
    label: item.label,
    accelerator: item.accelerator,
    click: () => sendCommand(item.command),
  };
}

function entryItems(
  sendCommand: (command: MenuCommand) => void,
  entries: MenuEntry[],
): Electron.MenuItemConstructorOptions[] {
  return entries.map((entry) =>
    entry === "separator"
      ? { type: "separator" }
      : commandItem(sendCommand, entry),
  );
}

export interface ApplicationMenuOptions {
  onMenuCommand(command: MenuCommand): void;
  recentFiles?: RecentFileStatus[];
  theme?: ThemePreferenceSetting;
  onOpenRecentFile?(path: string): void;
  onClearRecentFiles?(): void;
}

export function createApplicationMenu({
  onMenuCommand,
  recentFiles = [],
  theme = "system",
  onOpenRecentFile,
  onClearRecentFiles,
}: ApplicationMenuOptions): Menu {
  const recentItems: Electron.MenuItemConstructorOptions[] =
    recentFiles.length === 0
      ? [{ label: "暂无最近文件", enabled: false }]
      : recentFiles.map((file) => ({
          label: file.exists ? file.name : `${file.name}（文件不存在）`,
          enabled: file.exists,
          click: file.exists
            ? () => onOpenRecentFile?.(file.path)
            : undefined,
        }));

  const template: Array<Electron.MenuItemConstructorOptions> = [
    ...(process.platform === "darwin"
      ? [{ role: "appMenu" } satisfies Electron.MenuItemConstructorOptions]
      : []),
    {
      label: "文件",
      submenu: [
        ...entryItems(onMenuCommand, fileCommands),
        {
          label: "保存",
          accelerator: "CmdOrCtrl+S",
          click: () => onMenuCommand("save"),
        },
        { type: "separator" },
        {
          label: "导出",
          submenu: entryItems(onMenuCommand, exportCommands),
        },
        { type: "separator" },
        {
          label: "最近打开",
          submenu: [
            ...recentItems,
            { type: "separator" },
            {
              label: "清除最近文件",
              enabled: recentFiles.length > 0,
              click: onClearRecentFiles
                ? () => onClearRecentFiles()
                : undefined,
            },
          ],
        },
        { type: "separator" },
        ...entryItems(onMenuCommand, windowCommands),
      ],
    },
    {
      label: "编辑",
      role: "editMenu",
    },
    {
      label: "段落",
      submenu: entryItems(onMenuCommand, paragraphCommands),
    },
    {
      label: "格式",
      submenu: entryItems(onMenuCommand, formatCommands),
    },
    {
      label: "模式",
      submenu: entryItems(onMenuCommand, modeCommands),
    },
    {
      label: "主题",
      submenu: themeCommands.map((item) => ({
        label: item.label,
        type: "radio",
        checked: theme === item.theme,
        click: () => onMenuCommand(item.command),
      })),
    },
    ...(process.platform === "darwin"
      ? [{ role: "windowMenu" } satisfies Electron.MenuItemConstructorOptions]
      : []),
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  return menu;
}
