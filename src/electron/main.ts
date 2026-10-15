import { BrowserWindow, app, shell } from "electron";
import type { Menu } from "electron";
import { join } from "node:path";
import {
  createSecureFileIpcController,
  sendOpenRecentFile,
} from "./ipc";
import { createApplicationMenu } from "./menu";
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
const menusByWindow = new Map<BrowserWindow, Menu>();
let currentRecentFiles: RecentFileStatus[] = [];

function refreshApplicationMenu(window: BrowserWindow): void {
  menusByWindow.set(
    window,
    createApplicationMenu({
      window,
      recentFiles: currentRecentFiles,
      onOpenRecentFile: (path) => sendOpenRecentFile(window, path),
      onClearRecentFiles: () => void fileIpcController.clearRecentFiles(),
    }),
  );
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
  refreshApplicationMenu(win);
  win.once("closed", () => {
    menusByWindow.delete(win);
  });
  return win;
}

app.whenReady().then(() => {
  fileIpcController.register();
  createMainWindow();
  void fileIpcController.refreshRecentFiles();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

fileIpcController.onRecentFilesChanged((files) => {
  currentRecentFiles = files;
  for (const window of menusByWindow.keys()) {
    if (window.isDestroyed()) menusByWindow.delete(window);
    else refreshApplicationMenu(window);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
