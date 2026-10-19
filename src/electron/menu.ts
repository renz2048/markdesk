import { Menu } from "electron";
import type { MenuCommand, RecentFileStatus } from "../shared/types";

interface CommandMenuItem {
  command: MenuCommand;
  label: string;
  accelerator?: string;
}

const fileCommands: CommandMenuItem[] = [
  { command: "new", label: "新建", accelerator: "CmdOrCtrl+N" },
  { command: "open", label: "打开…", accelerator: "CmdOrCtrl+O" },
  { command: "save", label: "保存", accelerator: "CmdOrCtrl+S" },
  {
    command: "save-as",
    label: "另存为…",
    accelerator: "CmdOrCtrl+Shift+S",
  },
  {
    command: "export-html",
    label: "导出 HTML…",
    accelerator: "CmdOrCtrl+Shift+E",
  },
];

const modeCommands: CommandMenuItem[] = [
  {
    command: "toggle-wysiwyg",
    label: "所见即所得模式",
    accelerator: "CmdOrCtrl+1",
  },
  { command: "toggle-source", label: "源码模式", accelerator: "CmdOrCtrl+2" },
  { command: "toggle-read", label: "阅读模式", accelerator: "CmdOrCtrl+3" },
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

export interface ApplicationMenuOptions {
  onMenuCommand(command: MenuCommand): void;
  recentFiles?: RecentFileStatus[];
  onOpenRecentFile?(path: string): void;
  onClearRecentFiles?(): void;
}

export function createApplicationMenu({
  onMenuCommand,
  recentFiles = [],
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
        ...fileCommands.map((item) => commandItem(onMenuCommand, item)),
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
      ],
    },
    {
      label: "编辑",
      role: "editMenu",
    },
    {
      label: "模式",
      submenu: modeCommands.map((item) => commandItem(onMenuCommand, item)),
    },
    ...(process.platform === "darwin"
      ? [{ role: "windowMenu" } satisfies Electron.MenuItemConstructorOptions]
      : []),
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  return menu;
}
