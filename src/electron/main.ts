import { BrowserWindow, app, shell } from "electron";
import { join } from "node:path";
import {
  createSecureFileIpcController,
  sendMenuCommand,
  sendOpenRecentFile,
} from "./ipc";
import { createApplicationMenu } from "./menu";
import { resolveFocusedMarkDeskWindow } from "./menu-target";
import type { RecentFileStatus } from "../shared/types";
import {
  contentSecurityPolicy,
  preventInAppNavigation,
  secureWebPreferences,
  shouldOpenExternalUrl,
} from "./security";

const fileIpcController = createSecureFileIpcController({
  recentStoragePath: join(app.getPath("userData"), "recent-files.json"),
});
let currentRecentFiles: RecentFileStatus[] = [];

function commandTarget(): BrowserWindow | null {
  return resolveFocusedMarkDeskWindow(BrowserWindow.getAllWindows());
}

function refreshApplicationMenu(): void {
  createApplicationMenu({
    onMenuCommand: (command) => {
      const target = commandTarget();
      try {
        if (target) sendMenuCommand(target, command);
      } catch (error) {
        console.error("无法发送菜单命令", error);
      }
    },
    recentFiles: currentRecentFiles,
    onOpenRecentFile: (path) => {
      const target = commandTarget();
      try {
        if (target) sendOpenRecentFile(target, path);
      } catch (error) {
        console.error("无法打开最近文件", error);
      }
    },
    onClearRecentFiles: () => {
      fileIpcController.clearRecentFiles().catch((error) => {
        console.error("无法清除最近文件", error);
      });
    },
  });
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

  fileIpcController.protectWindowClose(win);
  return win;
}

app.whenReady().then(() => {
  fileIpcController.register();
  refreshApplicationMenu();
  createMainWindow();
  fileIpcController.refreshRecentFiles().catch((error) => {
    console.error("无法读取最近文件", error);
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

fileIpcController.onRecentFilesChanged((files) => {
  currentRecentFiles = files;
  refreshApplicationMenu();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
