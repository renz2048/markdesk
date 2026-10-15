import { BrowserWindow, Menu, app, shell } from "electron";
import { join } from "node:path";
import { registerSecureFileIpc, sendMenuCommand } from "./ipc";
import type { MenuCommand } from "../shared/types";
import {
  contentSecurityPolicy,
  preventInAppNavigation,
  secureWebPreferences,
  shouldOpenExternalUrl,
} from "./security";

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

function commandItem(window: BrowserWindow, item: CommandMenuItem) {
  return {
    label: item.label,
    accelerator: item.accelerator,
    click: () => sendMenuCommand(window, item.command),
  };
}

export function createApplicationMenu(
  window: BrowserWindow = createMainWindow(),
): Menu {
  const template: Array<Electron.MenuItemConstructorOptions> = [
    ...(process.platform === "darwin"
      ? [{ role: "appMenu" } satisfies Electron.MenuItemConstructorOptions]
      : []),
    {
      label: "文件",
      submenu: fileCommands.map((item) => commandItem(window, item)),
    },
    {
      label: "编辑",
      role: "editMenu",
    },
    {
      label: "模式",
      submenu: modeCommands.map((item) => commandItem(window, item)),
    },
    ...(process.platform === "darwin"
      ? [{ role: "windowMenu" } satisfies Electron.MenuItemConstructorOptions]
      : []),
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  return menu;
}

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 620,
    title: "MarkDesk",
    show: false,
    webPreferences: secureWebPreferences(),
  });

  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [contentSecurityPolicy()],
      },
    });
  });

  win.once("ready-to-show", () => win.show());
  win.webContents.on("will-navigate", preventInAppNavigation);
  win.webContents.on("will-redirect", preventInAppNavigation);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (shouldOpenExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) void win.loadURL(devServerUrl);
  else void win.loadFile(join(__dirname, "../dist/index.html"));

  return win;
}

app.whenReady().then(() => {
  registerSecureFileIpc();
  const mainWindow = createMainWindow();
  createApplicationMenu(mainWindow);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const reopenedWindow = createMainWindow();
      createApplicationMenu(reopenedWindow);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
