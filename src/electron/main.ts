import { BrowserWindow, app, protocol, shell } from "electron";
import { isAbsolute, join } from "node:path";
import { markdownPathFromArgv } from "./argv";
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

// Honor an explicit --user-data-dir switch so end-to-end tests can run the
// app against an isolated profile directory. Must run before any
// app.getPath("userData") read below.
const userDataSwitch = process.argv
  .slice(2)
  .find((argument) => argument.startsWith("--user-data-dir="));
if (userDataSwitch) {
  const overrideDir = userDataSwitch.slice("--user-data-dir=".length);
  if (isAbsolute(overrideDir)) {
    app.setPath("userData", overrideDir);
  }
}

// markdesk-resource 承载当前文档目录内的相对图片；特权注册（支持
// fetch 语义、独立 CSP 判定）必须在 app ready 之前完成。
protocol.registerSchemesAsPrivileged([
  {
    scheme: "markdesk-resource",
    privileges: { standard: false, supportFetchAPI: true, stream: false },
  },
]);

const fileIpcController = createSecureFileIpcController({
  recentStoragePath: join(app.getPath("userData"), "recent-files.json"),
  draftStoragePath: app.getPath("userData"),
  imageGrantsStoragePath: join(app.getPath("userData"), "image-grants.json"),
  onThemePreferenceChanged: (theme) => {
    currentThemePreference = theme;
    refreshApplicationMenu();
  },
});
let currentRecentFiles: RecentFileStatus[] = [];
let currentThemePreference = "system" as "light" | "dark" | "system";

function commandTarget(): BrowserWindow | null {
  return resolveFocusedMarkDeskWindow(BrowserWindow.getAllWindows());
}

// 单实例：资源管理器“打开方式”或命令行再次启动时，把文件路径转交给
// 已有实例，避免开出第二个窗口。
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();

function activeMarkDeskWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows();
  return (
    resolveFocusedMarkDeskWindow(windows) ??
    windows.find((window) => !window.isDestroyed()) ??
    null
  );
}

function openExternalMarkdown(path: string, target: BrowserWindow): void {
  fileIpcController.openExternalPath(path).then(
    (canonical) => {
      if (!target.isDestroyed()) sendOpenRecentFile(target, canonical);
    },
    (error) => {
      console.error("无法打开指定的 Markdown 文件", error);
    },
  );
}

app.on("second-instance", (_event, argv) => {
  const target = activeMarkDeskWindow();
  if (!target) return;
  target.focus();
  const path = markdownPathFromArgv(argv);
  if (path) openExternalMarkdown(path, target);
});

function refreshApplicationMenu(): void {
  createApplicationMenu({
    onMenuCommand: (command) => {
      // 窗口级命令在主进程直接处理，不进入渲染端命令循环。
      if (command === "new-window") {
        createMainWindow();
        return;
      }
      if (command === "close-window") {
        commandTarget()?.close();
        return;
      }
      const target = commandTarget();
      try {
        if (target) sendMenuCommand(target, command);
      } catch (error) {
        console.error("无法发送菜单命令", error);
      }
    },
    recentFiles: currentRecentFiles,
    theme: currentThemePreference,
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
  // 编译产物位于 dist-electron/electron/（tsconfig.electron.json 的 rootDir
  // 是 src），渲染端构建输出在 markdesk/dist/，因此要回退两级。
  else void win.loadFile(join(__dirname, "../../dist/index.html"));

  fileIpcController.protectWindowClose(win);
  return win;
}

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;
  fileIpcController.register();
  refreshApplicationMenu();
  const win = createMainWindow();
  const externalPath = markdownPathFromArgv(process.argv);
  if (externalPath) {
    // 渲染端完成加载前发送会被丢弃，等页面就绪后再转发打开请求。
    win.webContents.once("did-finish-load", () => {
      openExternalMarkdown(externalPath, win);
    });
  }
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
