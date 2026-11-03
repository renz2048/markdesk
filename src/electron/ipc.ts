import {
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  protocol,
} from "electron";
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, win32 } from "node:path";
import { randomUUID } from "node:crypto";
import {
  fingerprint,
  FileServiceError,
  isFileFingerprint,
  isHtmlPath,
  isImagePath,
  isMarkdownPath,
  readMarkdownFile,
  writeExportFile,
  writeImageFile,
  writeMarkdownFile,
} from "./file-service";
import {
  discardRecoveryDraft,
  draftKeyForPath,
  listRecoveryDrafts,
  readRecoveryDraft,
  saveDraft,
} from "./drafts";
import {
  clearRecentFiles,
  loadRecentFiles,
  upsertRecentFile,
} from "./recent-files";
import {
  IMAGE_GRANTS_LIMIT,
  isGrantableImagePath,
  loadImageGrants,
  saveImageGrants,
} from "./image-grants";
import {
  markdeskChannels,
  type FileFingerprint,
  type FileReadResult,
  type FileWriteResult,
  type IpcResult,
  type MenuCommand,
  type RecentFile,
  type RecentFileStatus,
  type RecoveryDraft,
  type SavedImageAsset,
  type PickedImageAsset,
  type RecoveryDraftInput,
  type RecoveryDraftSummary,
  type ThemePreferenceSetting,
} from "../shared/types";

interface WebContentsLike {
  id: number;
  isDestroyed?(): boolean;
  once(event: "destroyed", listener: () => void): void;
  send(channel: string, payload: unknown): void;
}

interface BrowserWindowLike {
  webContents: WebContentsLike;
  once(event: "closed", listener: () => void): void;
}

interface CloseableWindowLike extends BrowserWindowLike {
  on(event: "close", listener: (event: {
    preventDefault(): void;
  }) => void): void;
  close(): void;
}

interface IpcMainLike {
  handle(
    channel: string,
    listener: (
      event: { sender: WebContentsLike },
      ...args: unknown[]
    ) => unknown,
  ): void;
}

interface DialogLike {
  showOpenDialog(
    window: BrowserWindowLike,
    options: {
      title: string;
      properties: string[];
      filters: Array<{ name: string; extensions: string[] }>;
    },
  ): Promise<{ canceled?: boolean; filePaths?: string[] }>;
  showSaveDialog(
    window: BrowserWindowLike,
    options: {
      title: string;
      defaultPath: string;
      filters: Array<{ name: string; extensions: string[] }>;
    },
  ): Promise<{ canceled?: boolean; filePath?: string }>;
}

export interface SecureFileIpcDependencies {
  ipcMain?: IpcMainLike;
  dialog?: DialogLike;
  getWindows?: () => BrowserWindowLike[];
  canonicalize?: (path: string) => Promise<string>;
  readFile?: (path: string) => Promise<FileReadResult>;
  writeFile?: (
    path: string,
    content: string,
    expected?: FileFingerprint,
  ) => Promise<FileWriteResult>;
  recentStoragePath?: string;
  loadRecentFiles?: (storagePath: string) => Promise<RecentFile[]>;
  upsertRecentFile?: (
    storagePath: string,
    path: string,
  ) => Promise<RecentFile[]>;
  clearRecentFiles?: (storagePath: string) => Promise<void>;
  fileExists?: (path: string) => Promise<boolean>;
  draftStoragePath?: string;
  saveDraft?: (userDataPath: string, draft: RecoveryDraft) => Promise<void>;
  listRecoveryDrafts?: (
    userDataPath: string,
  ) => Promise<RecoveryDraftSummary[]>;
  readRecoveryDraft?: (
    userDataPath: string,
    key: string,
  ) => Promise<RecoveryDraft | null>;
  discardRecoveryDraft?: (
    userDataPath: string,
    key: string,
  ) => Promise<void>;
  fingerprintFile?: (path: string) => Promise<FileFingerprint>;
  watch?: (
    path: string,
    listener: (eventType: string) => void,
  ) => FileWatcherLike;
  writeExport?: (path: string, html: string) => Promise<void>;
  writePastedImage?: (path: string, bytes: Uint8Array) => Promise<void>;
  writeFileBinary?: (path: string, data: Uint8Array) => Promise<void>;
  onThemePreferenceChanged?: (theme: ThemePreferenceSetting) => void;
  /** 调用 Pandoc（单测注入桩）；参数为 pandoc 命令行。 */
  runPandoc?: (args: string[]) => Promise<void>;
  ensureDirectory?: (path: string) => Promise<void>;
  protocolHandle?: (
    scheme: string,
    handler: (request: { url: string }) => Promise<Response>,
  ) => void;
  readResourceFile?: (path: string) => Promise<Buffer>;
  /** 图片授权表存储文件（未配置时授权仅存内存，重启失效）。 */
  imageGrantsStoragePath?: string;
  loadImageGrants?: (storagePath: string) => Promise<string[]>;
  saveImageGrants?: (storagePath: string, paths: string[]) => Promise<void>;
}

interface FileWatcherLike {
  once(event: "error", listener: () => void): void;
  close(): void;
}

interface WindowFileGrants {
  window: BrowserWindowLike;
  sender: WebContentsLike;
  readPaths: Set<string>;
  writePaths: Set<string>;
  writeBaselines: Map<string, FileFingerprint>;
}

interface CloseRequest {
  authorizeAndClose(): void;
  cancel(): void;
}

interface WatchedFileState {
  watcher: FileWatcherLike | null;
  owners: Set<number>;
  timeout: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

type RecentFilesListener = (files: RecentFileStatus[]) => void;

function success<TValue>(value: TValue): IpcResult<TValue> {
  return { ok: true, value };
}

function failure(error: unknown): IpcResult<never> {
  if (error instanceof FileServiceError) {
    if (error.code !== "invalid-path" && error.code !== "invalid-argument") {
      // 非参数类的失败在主进程留下上下文，便于诊断环境与竞态问题。
      console.error(
        `markdesk ${error.code}:`,
        error.cause ?? error.message,
      );
    }
    return { ok: false, error: { code: error.code, message: error.message } };
  }

  console.error("markdesk unexpected IPC error:", error);
  return {
    ok: false,
    error: {
      code: "unexpected-error",
      message: "操作失败，请稍后重试。",
    },
  };
}

async function guarded<TValue>(
  operation: () => Promise<TValue>,
): Promise<IpcResult<TValue>> {
  try {
    return success(await operation());
  } catch (error) {
    return failure(error);
  }
}

export function normalizeUnresolvedPath(path: string): string {
  // 只有盘符形式（C:\ 或 C:/）才按 win32 语义规范化（大小写不敏感、
  // 反斜杠分隔）。注意 win32.isAbsolute("/tmp/x") 在 Node 中返回 true，
  // 若据此分支会在 POSIX 上把 /tmp 规范化成 \tmp 并破坏文件访问。
  if (/^[a-zA-Z]:[\\/]/u.test(path)) {
    return win32.resolve(path).toLowerCase();
  }
  // UNC 路径（\\wsl.localhost\Ubuntu\...、\\server\share）同样按 win32
  // 语义规范化，但保留大小写：WSL 等 Linux 侧路径区分大小写，小写化
  // 会破坏后续访问；若落入 posix.resolve 会把整个路径当成单个相对
  // 组件拼上 cwd，导致无法读取。
  if (/^\\\\|^\/\//u.test(path)) {
    return win32.resolve(path);
  }
  return posix.resolve(path);
}

const resourceMediaTypes = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
  [".avif", "image/avif"],
]);

/**
 * 解析 markdesk-resource: 请求。仅当存在当前打开的 Markdown 文档、
 * 请求是相对路径、规范化后不逃逸文档目录、且扩展名在图片白名单内时
 * 返回绝对路径；否则返回 null（拒绝）。
 *
 * absolute/<编码路径> 形式（文档目录外的本地绝对路径图片）只在路径
 * 与扩展授权列表逐字匹配且扩展名为图片时放行。
 */
export function resolveResourcePath(
  openDirectories: readonly string[],
  requestUrl: string,
  grantedAbsolutePaths?: readonly string[],
): string | null {
  const match = /^markdesk-resource:(?!\/)/iu.exec(requestUrl);
  if (!match) return null;
  let relative: string;
  try {
    relative = decodeURIComponent(requestUrl.slice(match[0].length));
  } catch {
    return null;
  }

  if (relative.startsWith("absolute/")) {
    // 整段已在上文解码一次，这里直接截取，避免二次解码破坏原文。
    const absolute = relative.slice("absolute/".length);
    if (
      !grantedAbsolutePaths?.includes(absolute) ||
      !resourceMediaTypes.has(posix.extname(absolute).toLowerCase()) &&
        !resourceMediaTypes.has(win32.extname(absolute).toLowerCase())
    ) {
      return null;
    }
    return absolute;
  }

  if (
    relative.length === 0 ||
    relative.length > 1024 ||
    /[\0-\x1f\u007f]/u.test(relative) ||
    posix.isAbsolute(relative) ||
    win32.isAbsolute(relative) ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(relative)
  ) {
    return null;
  }
  if (!resourceMediaTypes.has(posix.extname(relative).toLowerCase())) {
    return null;
  }
  for (const directory of openDirectories) {
    // 盘符与 UNC（\\wsl.localhost\...、\\server\share）目录按 win32 语义
    // 解析；UNC 若走 posix 语义，反斜杠不是分隔符，整个路径会被拼上
    // cwd 变成无效路径，导致文档目录内的图片全部 404。
    const pathMod = /^([a-zA-Z]:[\\/]|\\\\|\/\/)/u.test(directory)
      ? win32
      : posix;
    const base = pathMod.resolve(directory);
    const resolved = pathMod.resolve(directory, relative);
    if (resolved.startsWith(`${base}${pathMod.sep}`)) {
      return resolved;
    }
  }
  return null;
}

function mediaTypeFor(path: string): string {
  return resourceMediaTypes.get(posix.extname(path).toLowerCase()) ??
    "application/octet-stream";
}

async function defaultCanonicalize(path: string): Promise<string> {
  try {
    const real = await realpath(path);
    return normalizeUnresolvedPath(real);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return normalizeUnresolvedPath(path);
    }
    throw error;
  }
}

async function defaultFileExists(path: string): Promise<boolean> {
  try {
    const information = await stat(path);
    return information.isFile();
  } catch {
    return false;
  }
}

function defaultWatchFile(
  path: string,
  listener: (eventType: string) => void,
): FileWatcherLike {
  const watcher = watch(path, { persistent: false }, (event) => {
    listener(event);
  });
  watcher.once("error", () => watcher.close());
  return watcher;
}

function defaultWindows(): BrowserWindowLike[] {
  return BrowserWindow.getAllWindows();
}

const RESOURCE_READ_TIMEOUT_MS = 2500;
const RESOURCE_READ_ATTEMPTS = 3;

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

// \\wsl.localhost 等 9P 共享上，紧跟在 mkdir/rename 之后的读取偶发长时间
// 挂起（libuv 请求不可取消）；带超时的重试让协议在短暂卡顿后仍能返回
// 图片，而不是让 <img> 永远等待。
async function readResourceWithRetry(path: string): Promise<Buffer> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RESOURCE_READ_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await delay(300);
    try {
      return await Promise.race([
        readFile(path),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`resource read timeout: ${path}`));
          }, RESOURCE_READ_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function windowsReservedName(value: string): boolean {
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(value);
}

// 渲染端最近一次同步的主题偏好（仅用于菜单单选状态展示）。
let currentThemePreference: ThemePreferenceSetting = "system";

// 在隐藏窗口中渲染导出的 HTML，产出 PDF 字节或 PNG 截图。临时 HTML
// 与文档同目录写入，保证相对图片路径（assets/...）可解析。
async function renderExportToBuffer(
  tempPath: string,
  format: "pdf" | "png",
): Promise<Uint8Array> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    await win.loadFile(tempPath);
    // 等待字体与图片完成首帧渲染。
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (format === "pdf") {
      return await win.webContents.printToPDF({
        printBackground: true,
        pageSize: "A4",
      });
    }
    const size = (await win.webContents.executeJavaScript(
      "({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight })",
    )) as { width?: unknown; height?: unknown };
    const width = Math.min(
      Math.max(Number(size.width) || 860, 400),
      4000,
    );
    const height = Math.min(
      Math.max(Number(size.height) || 600, 400),
      20000,
    );
    win.setContentSize(width, height);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const image = await win.webContents.capturePage();
    return image.toPNG();
  } finally {
    win.destroy();
  }
}

// Pandoc 导出目标：扩展名 + pandoc 写入格式（-t）。
export const pandocExportFormats = {
  docx: { ext: "docx", to: "docx" },
  odt: { ext: "odt", to: "odt" },
  epub: { ext: "epub", to: "epub" },
  latex: { ext: "tex", to: "latex" },
  mediawiki: { ext: "txt", to: "mediawiki" },
} as const;

export type PandocExportTarget = keyof typeof pandocExportFormats;

// 调用系统 Pandoc。ENOENT（未安装）以 reject 的形式返回。
function defaultRunPandoc(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("pandoc", args, { windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else {
        reject(
          new FileServiceError(
            "write-failed",
            `Pandoc 转换失败：${stderr.trim().slice(0, 200)}`,
          ),
        );
      }
    });
  });
}

function defaultSaveName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    /[/\\]/u.test(value) ||
    /[\0-\x1f\u007f]/u.test(value) ||
    /[<>:"|?*]/u.test(value) ||
    windowsReservedName(value) ||
    /[. ]$/u.test(value)
  ) {
    throw new FileServiceError("invalid-argument", "默认文件名无效。");
  }
  return isMarkdownPath(`/__markdesk_default__/${value}`)
    ? value
    : `${value}.md`;
}

// 粘贴图片的资源名：沿用 defaultSaveName 的字符约束，但扩展名必须是
// 图片白名单（无 .md 兜底），最终路径还会经 isImagePath 二次校验。
function safeImageName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 200 ||
    /[/\\]/u.test(value) ||
    /[\0-\x1f\u007f]/u.test(value) ||
    /[<>:"|?*]/u.test(value) ||
    windowsReservedName(value) ||
    /[. ]$/u.test(value) ||
    !isImagePath(`/__markdesk_assets__/${value}`)
  ) {
    throw new FileServiceError("invalid-argument", "图片文件名无效。");
  }
  return value;
}

export interface SecureFileIpcController {
  register(): void;
  notifyFileChanged(path: string): Promise<void>;
  protectWindowClose(window: CloseableWindowLike): void;
  openExternalPath(path: unknown): Promise<string>;
  refreshRecentFiles(): Promise<RecentFileStatus[]>;
  clearRecentFiles(): Promise<void>;
  onRecentFilesChanged(listener: RecentFilesListener): void;
}

export function createSecureFileIpcController(
  dependencies: SecureFileIpcDependencies = {},
): SecureFileIpcController {
  const ipc = dependencies.ipcMain ?? ipcMain;
  const dialogs = dependencies.dialog ?? dialog;
  const getWindows = dependencies.getWindows ?? defaultWindows;
  const canonicalize = dependencies.canonicalize ?? defaultCanonicalize;
  // Pandoc 转换（需求 4.6 的 Word/OpenOffice/Epub/LaTeX/MediaWiki 导出）。
  // 可用性按控制器缓存；单测经 runPandoc 依赖注入桩掉。
  const runPandoc = dependencies.runPandoc ?? defaultRunPandoc;
  let pandocAvailable: boolean | null = null;
  const ensurePandoc = async (): Promise<void> => {
    if (pandocAvailable === null) {
      pandocAvailable = await runPandoc(["--version"])
        .then(() => true)
        .catch(() => false);
    }
    if (!pandocAvailable) {
      throw new FileServiceError(
        "pandoc-missing",
        "未检测到 Pandoc。请先安装 Pandoc（https://pandoc.org/installing.html）并确保其在 PATH 中，再使用该导出格式。",
      );
    }
  };
  const read = dependencies.readFile ?? readMarkdownFile;
  const write = dependencies.writeFile ?? writeMarkdownFile;
  const recentStoragePath = dependencies.recentStoragePath;
  const loadRecent = dependencies.loadRecentFiles ?? loadRecentFiles;
  const upsertRecent = dependencies.upsertRecentFile ?? upsertRecentFile;
  const clearRecent = dependencies.clearRecentFiles ?? clearRecentFiles;
  const fileExists = dependencies.fileExists ?? defaultFileExists;
  const draftStoragePath = dependencies.draftStoragePath;
  const saveDraftFile = dependencies.saveDraft ?? saveDraft;
  const listDrafts = dependencies.listRecoveryDrafts ?? listRecoveryDrafts;
  const readDraft = dependencies.readRecoveryDraft ?? readRecoveryDraft;
  const discardDraft = dependencies.discardRecoveryDraft ?? discardRecoveryDraft;
  const fingerprintFile = dependencies.fingerprintFile ?? fingerprint;
  const watchFile = dependencies.watch ?? defaultWatchFile;
  const writeExport = dependencies.writeExport ?? writeExportFile;
  const writePastedImage = dependencies.writePastedImage ?? writeImageFile;
  const ensureDirectory = dependencies.ensureDirectory ??
    ((path: string) => mkdir(path, { recursive: true }));
  const handleProtocol = dependencies.protocolHandle ??
    ((scheme: string, handler: (request: { url: string }) => Promise<Response>) => {
      // 单元测试环境没有 Electron 运行时（protocol 为 undefined），此时
      // 跳过协议注册；路径解析逻辑由 resolveResourcePath 单测覆盖。
      const runtimeProtocol = protocol as
        | { handle?: (s: string, h: unknown) => void }
        | undefined;
      if (typeof runtimeProtocol?.handle === "function") {
        runtimeProtocol.handle(scheme, handler);
      }
    });
  const readResourceFile = dependencies.readResourceFile ??
    readResourceWithRetry;
  // 文档目录外本地图片的显示授权（需求 4.5 拖入 + 打开文档时的用户
  // 确认）。授权表启动时从磁盘恢复、变更时落盘，跨会话记忆。
  const imageGrantsStorage = dependencies.imageGrantsStoragePath;
  const loadImageGrantList = dependencies.loadImageGrants ?? loadImageGrants;
  const saveImageGrantList = dependencies.saveImageGrants ?? saveImageGrants;
  const grantedAbsoluteImages = new Set<string>();
  const imageGrantsReady = (async () => {
    if (!imageGrantsStorage) return;
    for (const path of await loadImageGrantList(imageGrantsStorage)) {
      grantedAbsoluteImages.add(path);
    }
  })();

  function persistImageGrants(): void {
    if (!imageGrantsStorage) return;
    // 超出上限时淘汰最早授权的路径。
    const paths = [...grantedAbsoluteImages].slice(-IMAGE_GRANTS_LIMIT);
    void saveImageGrantList(imageGrantsStorage, paths).catch((error) => {
      console.error("markdesk: 图片授权表写入失败", error);
    });
  }

  /** 登记一条显示授权（拖入或用户确认），并异步持久化。 */
  function grantAbsoluteImage(path: string): void {
    if (grantedAbsoluteImages.has(path)) return;
    grantedAbsoluteImages.add(path);
    persistImageGrants();
  }

  /** 校验渲染端传来的图片路径列表（空、非绝对、非图片、重复均拒绝）。 */
  function validateImageSrcList(value: unknown): string[] {
    const invalid = () =>
      new FileServiceError("invalid-argument", "图片路径列表无效。");
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.length > 200
    ) {
      throw invalid();
    }
    const seen = new Set<string>();
    for (const entry of value) {
      if (
        typeof entry !== "string" ||
        !isGrantableImagePath(entry) ||
        seen.has(entry)
      ) {
        throw invalid();
      }
      seen.add(entry);
    }
    return [...seen];
  }
  const grantsBySender = new Map<number, WindowFileGrants>();
  const closeRequests = new Map<number, CloseRequest>();
  const recentFilesListeners = new Set<RecentFilesListener>();
  const watchedFiles = new Map<string, WatchedFileState>();
  const latestFingerprints = new Map<string, FileFingerprint>();
  let recentOperation: Promise<unknown> = Promise.resolve();
  let registered = false;

  function windowForSender(sender: WebContentsLike): BrowserWindowLike | null {
    if (sender.isDestroyed?.()) return null;
    return getWindows().find((window) => window.webContents === sender) ?? null;
  }

  function revoke(senderId: number) {
    stopWatchingForSender(senderId);
    grantsBySender.delete(senderId);
  }

  function notifyWatchedFileChanged(canonical: string): void {
    for (const grants of grantsBySender.values()) {
      if (
        !grants.sender.isDestroyed?.() &&
        grants.readPaths.has(canonical)
      ) {
        grants.sender.send(markdeskChannels.fileChanged, {
          path: canonical,
        });
      }
    }
  }

  function closeWatchedFile(canonical: string, state: WatchedFileState): void {
    if (state.closed) return;
    state.closed = true;
    if (state.timeout) clearTimeout(state.timeout);
    watchedFiles.delete(canonical);
    state.watcher?.close();
  }

  function scheduleExternalCheck(canonical: string): void {
    const state = watchedFiles.get(canonical);
    if (!state || state.closed) return;
    if (state.timeout) clearTimeout(state.timeout);
    state.timeout = setTimeout(() => {
      if (!watchedFiles.has(canonical)) return;
      state.timeout = null;
      void checkExternalFile(canonical);
    }, 200);
  }

  async function checkExternalFile(canonical: string): Promise<void> {
    const expected = latestFingerprints.get(canonical);
    let current: FileFingerprint;
    try {
      current = await fingerprintFile(canonical);
    } catch {
      notifyWatchedFileChanged(canonical);
      return;
    }

    if (
      !expected ||
      current.hash !== expected.hash ||
      current.mtimeMs !== expected.mtimeMs ||
      current.size !== expected.size
    ) {
      notifyWatchedFileChanged(canonical);
    }
  }

  function startWatching(
    canonical: string,
    owner: WindowFileGrants,
    fingerprintValue: FileFingerprint,
  ): void {
    latestFingerprints.set(canonical, fingerprintValue);
    const existing = watchedFiles.get(canonical);
    if (existing) {
      existing.owners.add(owner.sender.id);
      return;
    }

    const state: WatchedFileState = {
      watcher: null,
      owners: new Set([owner.sender.id]),
      timeout: null,
      closed: false,
    };
    // 登记必须无条件完成：markdesk-resource 协议以 watchedFiles 的键
    // 推导文档目录。部分文件系统（如 \\wsl.localhost 等 UNC 路径）不
    // 支持目录事件，watch 失败只损失外部变更通知，读写安全仍由指纹
    // 校验兜底。
    watchedFiles.set(canonical, state);
    try {
      state.watcher = watchFile(
        canonical,
        () => scheduleExternalCheck(canonical),
      );
      state.watcher.once("error", () => {
        // 异步失败同样降级为“登记但不监听”，条目清理交给 sender
        // 撤销路径（stopWatchingForSender / revoke）。
        state.watcher?.close();
        state.watcher = null;
      });
      scheduleExternalCheck(canonical);
    } catch {
      state.watcher = null;
    }
  }

  function stopWatchingForSender(senderId: number): void {
    for (const [canonical, state] of watchedFiles) {
      state.owners.delete(senderId);
      if (state.owners.size === 0) closeWatchedFile(canonical, state);
    }
  }

  function grantsForSender(sender: WebContentsLike): WindowFileGrants {
    const window = windowForSender(sender);
    if (!window) {
      throw new FileServiceError(
        "unexpected-error",
        "无法识别发起操作的窗口。",
      );
    }

    const existing = grantsBySender.get(sender.id);
    if (existing) return existing;

    const grants: WindowFileGrants = {
      window,
      sender,
      readPaths: new Set(),
      writePaths: new Set(),
      writeBaselines: new Map(),
    };
    grantsBySender.set(sender.id, grants);
    sender.once("destroyed", () => revoke(sender.id));
    window.once("closed", () => revoke(sender.id));
    return grants;
  }

  async function canonicalMarkdownPath(path: unknown): Promise<string> {
    if (!isMarkdownPath(path)) {
      throw new FileServiceError("invalid-path", "Markdown 文件路径无效。");
    }

    const canonical = await canonicalize(path);
    if (!isMarkdownPath(canonical)) {
      throw new FileServiceError("invalid-path", "Markdown 文件路径无效。");
    }
    return canonical;
  }

  function requireReadGrant(
    grants: WindowFileGrants,
    canonicalPath: string,
  ): void {
    if (!grants.readPaths.has(canonicalPath)) {
      throw new FileServiceError(
        "invalid-path",
        "此文件尚未通过 MarkDesk 明确打开。",
      );
    }
  }

  function requireWriteGrant(
    grants: WindowFileGrants,
    canonicalPath: string,
  ): void {
    if (!grants.readPaths.has(canonicalPath) && !grants.writePaths.has(canonicalPath)) {
      throw new FileServiceError(
        "invalid-path",
        "此文件路径未获准保存。",
      );
    }
  }

  function requireRecentStorage(): string {
    if (!recentStoragePath) {
      throw new FileServiceError(
        "invalid-argument",
        "最近文件存储未配置。",
      );
    }
    return recentStoragePath;
  }

  function requireDraftStorage(): string {
    if (!draftStoragePath) {
      throw new FileServiceError(
        "invalid-argument",
        "恢复草稿存储未配置。",
      );
    }
    return draftStoragePath;
  }

  function isRecoveryDraftInput(
    value: unknown,
  ): value is RecoveryDraftInput {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value as Partial<RecoveryDraftInput>;
    return (
      Object.keys(value).length === 6 &&
      (candidate.path === null || typeof candidate.path === "string") &&
      typeof candidate.fileName === "string" &&
      typeof candidate.markdown === "string" &&
      (candidate.mode === "wysiwyg" ||
        candidate.mode === "source" ||
        candidate.mode === "read") &&
      typeof candidate.cursor === "number" &&
      typeof candidate.scrollTop === "number"
    );
  }

  function queueRecentOperation<TValue>(
    operation: () => Promise<TValue>,
  ): Promise<TValue> {
    const result = recentOperation.then(operation, operation);
    recentOperation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function recentStatuses(
    files: RecentFile[],
  ): Promise<RecentFileStatus[]> {
    return Promise.all(files.map(async (file) => ({
      ...file,
      exists: await fileExists(file.path),
    })));
  }

  function broadcastRecentFiles(files: RecentFileStatus[]): void {
    for (const listener of recentFilesListeners) listener(files);
    for (const window of getWindows()) {
      if (!window.webContents.isDestroyed?.()) {
        window.webContents.send(markdeskChannels.recentFilesChanged, files);
      }
    }
  }

  async function loadRecentStatuses(): Promise<RecentFileStatus[]> {
    return recentStatuses(
      await loadRecent(requireRecentStorage()),
    );
  }

  async function recordRecentFile(path: string): Promise<void> {
    await queueRecentOperation(async () => {
      const files = await upsertRecent(requireRecentStorage(), path);
      broadcastRecentFiles(await recentStatuses(files));
    });
  }

  async function recordRecentFileBestEffort(
    path: string,
  ): Promise<void> {
    try {
      await recordRecentFile(path);
    } catch {
      // Opening or saving the document must not fail solely because recent-file
      // metadata could not be updated.
    }
  }

  async function readGrantedFile(
    grants: WindowFileGrants,
    canonical: string,
  ): Promise<FileReadResult> {
    const file = await read(canonical);
    const fingerprintValue: FileFingerprint = {
      hash: file.hash,
      mtimeMs: file.mtimeMs,
      size: file.size,
    };
    grants.writePaths.add(canonical);
    grants.writeBaselines.set(canonical, fingerprintValue);
    startWatching(canonical, grants, fingerprintValue);
    await recordRecentFileBestEffort(canonical);
    return file;
  }

  function register(): void {
    if (registered) return;
    registered = true;

    // 受限的本地图片协议：只在存在已打开的 Markdown 文档时解析相对
    // 图片，且规范化后不得逃逸文档目录（详见 resolveResourcePath）；
    // 文档目录外的本地绝对路径图片仅在用户显式拖入并登记授权后可解析。
    handleProtocol("markdesk-resource", async (request) => {
      // 等待持久化授权表恢复完成，避免启动初期的请求被误判为未授权。
      await imageGrantsReady;
      const openDirectories = [...watchedFiles.keys()].map((canonical) =>
        dirname(canonical)
      );
      const target = resolveResourcePath(
        openDirectories,
        request.url,
        [...grantedAbsoluteImages],
      );
      if (!target) {
        return new Response("access denied", { status: 403 });
      }
      try {
        const bytes = await readResourceFile(target);
        return new Response(new Uint8Array(bytes), {
          headers: { "Content-Type": mediaTypeFor(target) },
        });
      } catch {
        return new Response("not found", { status: 404 });
      }
    });

    ipc.handle(
      markdeskChannels.chooseMarkdownFile,
      async (event): Promise<IpcResult<string | null>> =>
        guarded(async () => {
          const grants = grantsForSender(event.sender);
          const selection = await dialogs.showOpenDialog(grants.window, {
            title: "打开 Markdown",
            properties: ["openFile"],
            filters: [
              { name: "Markdown", extensions: ["md", "markdown"] },
            ],
          });
          const path = selection.filePaths?.[0];
          if (!path || !isMarkdownPath(path)) return null;

          const canonical = await canonicalMarkdownPath(path);
          grants.readPaths.add(canonical);
          return path;
        }),
    );

    ipc.handle(
      markdeskChannels.chooseSaveLocation,
      async (
        event,
        defaultName: unknown,
      ): Promise<IpcResult<string | null>> =>
        guarded(async () => {
          const grants = grantsForSender(event.sender);
          const safeDefaultName = defaultSaveName(defaultName);
          const selection = await dialogs.showSaveDialog(grants.window, {
            title: "保存 Markdown",
            defaultPath: safeDefaultName,
            filters: [
              { name: "Markdown", extensions: ["md", "markdown"] },
            ],
          });
          const path = selection.filePath;
          if (!path || !isMarkdownPath(path)) return null;

          const canonical = await canonicalMarkdownPath(path);
          grants.writePaths.add(canonical);
          return path;
        }),
    );

    ipc.handle(
      markdeskChannels.readFile,
      async (
        event,
        path: unknown,
      ): Promise<IpcResult<FileReadResult>> =>
        guarded(async () => {
          const grants = grantsForSender(event.sender);
          const canonical = await canonicalMarkdownPath(path);
          requireReadGrant(grants, canonical);

          return readGrantedFile(grants, canonical);
        }),
    );

    ipc.handle(
      markdeskChannels.writeFile,
      async (
        event,
        path: unknown,
        content: unknown,
        expected: unknown,
      ): Promise<IpcResult<FileWriteResult>> =>
        guarded(async () => {
          const grants = grantsForSender(event.sender);
          const canonical = await canonicalMarkdownPath(path);
          requireWriteGrant(grants, canonical);
          if (typeof content !== "string") {
            throw new FileServiceError("invalid-argument", "Markdown 内容无效。");
          }

          const expectedFingerprint =
            expected === undefined ? undefined : (expected as FileFingerprint);
          if (
            expectedFingerprint !== undefined &&
            !isFileFingerprint(expectedFingerprint)
          ) {
            throw new FileServiceError("invalid-fingerprint", "文件校验信息无效。");
          }

          const baseline = grants.writeBaselines.get(canonical);
          if (
            baseline &&
            (!isFileFingerprint(expectedFingerprint) ||
              expectedFingerprint.hash !== baseline.hash ||
              expectedFingerprint.mtimeMs !== baseline.mtimeMs ||
              expectedFingerprint.size !== baseline.size)
          ) {
            throw new FileServiceError(
              "invalid-fingerprint",
              "保存前必须提供打开文件时的校验信息。",
            );
          }

          // A save-dialog-only target may be new or intentionally overwritten,
          // so it does not inherit an unrelated document's expected fingerprint.
          const serviceExpected = baseline ? expectedFingerprint : undefined;
          const result = await write(
            canonical,
            content,
            serviceExpected,
          );
          const fingerprintValue: FileFingerprint = {
            hash: result.hash,
            mtimeMs: result.mtimeMs,
            size: result.size,
          };
          grants.writeBaselines.set(canonical, fingerprintValue);
          startWatching(canonical, grants, fingerprintValue);
          await recordRecentFileBestEffort(canonical);
          return result;
        }),
    );

    ipc.handle(
      markdeskChannels.getRecentFiles,
      async (event): Promise<IpcResult<RecentFileStatus[]>> =>
        guarded(async () => {
          grantsForSender(event.sender);
          return queueRecentOperation(loadRecentStatuses);
        }),
    );

    ipc.handle(
      markdeskChannels.readRecentFile,
      async (
        event,
        path: unknown,
      ): Promise<IpcResult<FileReadResult>> =>
        guarded(async () => {
          const grants = grantsForSender(event.sender);
          const canonical = await canonicalMarkdownPath(path);
          await queueRecentOperation(async () => {
            const files = await loadRecent(requireRecentStorage());
            if (!files.some((file) => file.path === canonical)) {
              throw new FileServiceError(
                "invalid-path",
                "此文件不在最近打开列表中。",
              );
            }
            if (!(await fileExists(canonical))) {
              throw new FileServiceError(
                "invalid-path",
                "文件不存在。",
              );
            }
          });
          grants.readPaths.add(canonical);
          try {
            const file = await readGrantedFile(grants, canonical);
            return file;
          } catch (error) {
            grants.readPaths.delete(canonical);
            throw error;
          }
        }),
    );

    ipc.handle(
      markdeskChannels.clearRecentFiles,
      async (event): Promise<IpcResult<void>> =>
        guarded(async () => {
          grantsForSender(event.sender);
          await queueRecentOperation(async () => {
            await clearRecent(requireRecentStorage());
            broadcastRecentFiles([]);
          });
        }),
    );

    ipc.handle(
      markdeskChannels.saveRecoveryDraft,
      async (
        event,
        input: unknown,
      ): Promise<IpcResult<string>> =>
        guarded(async () => {
          const grants = grantsForSender(event.sender);
          if (!isRecoveryDraftInput(input)) {
            throw new FileServiceError(
              "invalid-argument",
              "恢复草稿数据无效。",
            );
          }

          const canonical = input.path === null
            ? null
            : await canonicalMarkdownPath(input.path);
          if (
            canonical !== null &&
            !grants.readPaths.has(canonical) &&
            !grants.writePaths.has(canonical)
          ) {
            throw new FileServiceError(
              "invalid-path",
              "此文件路径未获准保存恢复草稿。",
            );
          }

          const draft: RecoveryDraft = {
            ...input,
            path: canonical,
            key: draftKeyForPath(canonical),
            updatedAt: Date.now(),
          };
          await saveDraftFile(requireDraftStorage(), draft);
          return draft.key;
        }),
    );

    ipc.handle(
      markdeskChannels.listRecoveryDrafts,
      async (event): Promise<IpcResult<RecoveryDraftSummary[]>> =>
        guarded(async () => {
          grantsForSender(event.sender);
          return listDrafts(requireDraftStorage());
        }),
    );

    ipc.handle(
      markdeskChannels.readRecoveryDraft,
      async (
        event,
        key: unknown,
      ): Promise<IpcResult<RecoveryDraft | null>> =>
        guarded(async () => {
          const grants = grantsForSender(event.sender);
          if (typeof key !== "string" || !/^[0-9a-f]{64}$/u.test(key)) {
            throw new FileServiceError(
              "invalid-argument",
              "恢复草稿键无效。",
            );
          }

          const draft = await readDraft(requireDraftStorage(), key);
          if (draft?.path !== null && draft?.path !== undefined) {
            const canonical = await canonicalMarkdownPath(draft.path);
            grants.readPaths.add(canonical);
          }
          return draft;
        }),
    );

    ipc.handle(
      markdeskChannels.discardRecoveryDraft,
      async (event, key: unknown): Promise<IpcResult<void>> =>
        guarded(async () => {
          grantsForSender(event.sender);
          if (typeof key !== "string" || !/^[0-9a-f]{64}$/u.test(key)) {
            throw new FileServiceError(
              "invalid-argument",
              "恢复草稿键无效。",
            );
          }
          await discardDraft(requireDraftStorage(), key);
        }),
    );

    ipc.handle(
      markdeskChannels.chooseExportLocation,
      async (
        event,
        defaultName: unknown,
      ): Promise<IpcResult<string | null>> =>
        guarded(async () => {
          const grants = grantsForSender(event.sender);
          const safeDefaultName = defaultSaveName(defaultName);
          const selection = await dialogs.showSaveDialog(grants.window, {
            title: "导出 HTML",
            defaultPath: safeDefaultName,
            filters: [{ name: "HTML", extensions: ["html", "htm"] }],
          });
          const path = selection.filePath;
          if (!path || !isHtmlPath(path)) return null;

          const canonical = await canonicalize(path);
          grants.writePaths.add(canonical);
          return path;
        }),
    );

    ipc.handle(
      markdeskChannels.exportHtml,
      async (
        event,
        path: unknown,
        html: unknown,
      ): Promise<IpcResult<void>> =>
        guarded(async () => {
          const grants = grantsForSender(event.sender);
          if (!isHtmlPath(path)) {
            throw new FileServiceError(
              "invalid-path",
              "HTML 导出路径无效。",
            );
          }
          if (typeof html !== "string") {
            throw new FileServiceError(
              "invalid-argument",
              "导出内容无效。",
            );
          }
          const canonical = await canonicalize(path);
          if (
            !grants.writePaths.has(canonical) &&
            !grants.readPaths.has(canonical)
          ) {
            throw new FileServiceError(
              "invalid-path",
              "此导出路径未获授权。",
            );
          }
          await writeExport(canonical, html);
        }),
    );

    ipc.handle(
      markdeskChannels.requestClose,
      async (event): Promise<IpcResult<void>> =>
        guarded(async () => {
          const grants = grantsForSender(event.sender);
          const request = closeRequests.get(grants.sender.id);
          if (!request) {
            throw new FileServiceError(
              "invalid-argument",
              "此窗口没有待处理的关闭请求。",
            );
          }
          request.authorizeAndClose();
        }),
    );

    ipc.handle(
      markdeskChannels.cancelClose,
      async (event): Promise<IpcResult<void>> =>
        guarded(async () => {
          grantsForSender(event.sender);
          closeRequests.get(event.sender.id)?.cancel();
          closeRequests.delete(event.sender.id);
        }),
    );

    ipc.handle(
      markdeskChannels.savePastedImage,
      async (
        event,
        docPath: unknown,
        fileName: unknown,
        data: unknown,
      ): Promise<IpcResult<SavedImageAsset>> =>
        guarded(async () => {
          const grants = grantsForSender(event.sender);
          const canonical = await canonicalMarkdownPath(docPath);
          if (
            !grants.readPaths.has(canonical) &&
            !grants.writePaths.has(canonical)
          ) {
            throw new FileServiceError(
              "invalid-path",
              "当前文档未在本窗口打开，无法写入图片资源。",
            );
          }
          const safeName = safeImageName(fileName);
          const bytes = data instanceof Uint8Array
            ? data
            : data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : null;
          if (!bytes || bytes.byteLength === 0) {
            throw new FileServiceError("invalid-argument", "图片内容无效。");
          }

          // 资产固定写入文档目录的 assets/ 子目录。safeName 已拒绝所有
          // 路径分隔符，join 结果不可能逃逸；包含校验仅作防御性兜底。
          const assetsDirectory = join(dirname(canonical), "assets");
          let candidate = safeName;
          for (
            let attempt = 2;
            await fileExists(join(assetsDirectory, candidate));
            attempt += 1
          ) {
            if (attempt > 100) {
              throw new FileServiceError(
                "write-failed",
                "无法为图片资源分配唯一文件名。",
              );
            }
            candidate = safeName.replace(/(\.[^.]+)$/u, `-${attempt}$1`);
          }
          const target = join(assetsDirectory, candidate);
          const separator = target.includes(win32.sep)
            ? win32.sep
            : posix.sep;
          if (!target.startsWith(assetsDirectory + separator)) {
            throw new FileServiceError("invalid-path", "图片资源路径越界。");
          }

          await ensureDirectory(assetsDirectory);
          await writePastedImage(target, bytes);
          return { relativeSrc: `assets/${candidate}` };
        }),
    );

    // 「格式 → 图像」：选择本地图片文件并读取字节。渲染端沿用粘贴
    // 图片的资产流程（保存文档时落盘 assets/，未保存时内嵌 data URL）。
    ipc.handle(
      markdeskChannels.pickImageAsset,
      async (event): Promise<IpcResult<PickedImageAsset | null>> =>
        guarded(async () => {
          const grants = grantsForSender(event.sender);
          const selection = await dialogs.showOpenDialog(grants.window, {
            title: "插入图片",
            properties: ["openFile"],
            filters: [
              {
                name: "图片",
                extensions: ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"],
              },
            ],
          });
          const picked = selection.filePaths?.[0];
          if (selection.canceled || !picked) return null;
          if (!isImagePath(picked)) {
            throw new FileServiceError("invalid-path", "所选文件不是图片。");
          }
          const canonical = await canonicalize(picked);
          grants.readPaths.add(canonical);
          const bytes = await readFile(canonical);
          return {
            name: basename(canonical),
            bytes: bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ),
          };
        }),
    );

    // 「文件 → 导出 → PDF/图像」：渲染端导出 HTML 在隐藏窗口中渲染，
    // 主进程打印为 PDF 或截取为 PNG。临时 HTML 写入文档目录以便相对
    // 图片路径可解析（未保存文档的图片本就是 data URL，任意目录均可）。
    ipc.handle(
      markdeskChannels.exportRendered,
      async (
        event,
        format: unknown,
        html: unknown,
        defaultName: unknown,
        assetsDir: unknown,
      ): Promise<IpcResult<string | null>> =>
        guarded(async () => {
          const grants = grantsForSender(event.sender);
          if (format !== "pdf" && format !== "png") {
            throw new FileServiceError("invalid-argument", "导出格式无效。");
          }
          if (typeof html !== "string" || html.length === 0) {
            throw new FileServiceError("invalid-argument", "导出内容无效。");
          }

          const extension = format === "pdf" ? "pdf" : "png";
          const safeDefaultName = defaultSaveName(defaultName);
          const selection = await dialogs.showSaveDialog(grants.window, {
            title: format === "pdf" ? "导出 PDF" : "导出图像",
            defaultPath: safeDefaultName.replace(/\.(html?|md|markdown)$/iu, "") +
              `.${extension}`,
            filters: [
              format === "pdf"
                ? { name: "PDF", extensions: ["pdf"] }
                : { name: "PNG 图像", extensions: ["png"] },
            ],
          });
          const target = selection.filePath;
          if (selection.canceled || !target) return null;
          if (!target.toLowerCase().endsWith(`.${extension}`)) {
            throw new FileServiceError("invalid-path", "导出路径扩展名无效。");
          }

          // 临时 HTML 的落点优先为文档目录（相对图片可解析），且必须
          // 是该窗口已获授权的路径；否则退回系统临时目录。
          let tempDirectory: string | null = null;
          if (typeof assetsDir === "string" && assetsDir.length > 0) {
            const canonicalDir = await canonicalize(assetsDir);
            if (
              grants.readPaths.has(canonicalDir) ||
              grants.writePaths.has(canonicalDir)
            ) {
              tempDirectory = canonicalDir;
            }
          }

          const tempPath = join(
            tempDirectory ?? tmpdir(),
            `.markdesk-export-${randomUUID()}.html`,
          );
          const writeFileBinary = dependencies.writeFileBinary ??
            (async (path: string, data: Uint8Array) => {
              await writeFile(path, data);
            });
          await writeFileBinary(tempPath, new TextEncoder().encode(html));

          const rendered = await renderExportToBuffer(tempPath, format);
          try {
            await writeFileBinary(target, rendered);
          } finally {
            await rm(tempPath, { force: true }).catch(() => undefined);
          }
          return target;
        }),
    );

    // 主题选择在渲染端生效；主进程据此重建菜单的单选勾选状态，并让
    // 原生标题栏/菜单栏/系统对话框跟随主题明暗（需求 4.4）。
    ipc.handle(
      markdeskChannels.setThemePreference,
      async (event, theme: unknown): Promise<IpcResult<void>> =>
        guarded(async () => {
          grantsForSender(event.sender);
          if (theme !== "light" && theme !== "dark" && theme !== "system") {
            throw new FileServiceError("invalid-argument", "主题设置无效。");
          }
          currentThemePreference = theme;
          // 单测（依赖注入、无真实 Electron）里 nativeTheme 为空，跳过。
          if (nativeTheme) nativeTheme.themeSource = theme;
          dependencies.onThemePreferenceChanged?.(theme);
        }),
    );

    // 拖入本地图片（需求 4.5）：文档目录内（含子目录）返回相对路径；
    // 目录外返回绝对路径并登记协议显示授权。字节不走本通道，显示由
    // markdesk-resource 的 absolute/ 分支按授权解析。
    ipc.handle(
      markdeskChannels.insertDroppedImage,
      async (
        event,
        docPath: unknown,
        imagePath: unknown,
      ): Promise<IpcResult<{ src: string }>> =>
        guarded(async () => {
          const grants = grantsForSender(event.sender);
          const canonicalDoc = await canonicalMarkdownPath(docPath);
          if (
            !grants.readPaths.has(canonicalDoc) &&
            !grants.writePaths.has(canonicalDoc)
          ) {
            throw new FileServiceError(
              "invalid-path",
              "当前文档未在本窗口打开，无法插入拖入的图片。",
            );
          }
          if (!isImagePath(imagePath)) {
            throw new FileServiceError("invalid-path", "拖入的文件不是图片。");
          }
          const canonicalImage = await canonicalize(imagePath);
          if (!(await fileExists(canonicalImage))) {
            throw new FileServiceError("invalid-path", "图片文件不存在。");
          }
          const docDir = dirname(canonicalDoc);
          const pathMod = /^([a-zA-Z]:[\\/]|\\\\|\/\/)/u.test(docDir)
            ? win32
            : posix;
          const resolved = pathMod.resolve(canonicalImage);
          if (resolved.startsWith(`${docDir}${pathMod.sep}`)) {
            const relative = pathMod
              .relative(docDir, resolved)
              .split(pathMod.sep)
              .join("/");
            return { src: relative };
          }
          grantAbsoluteImage(resolved);
          return { src: resolved };
        }),
    );

    // 打开文档时的本地图片授权：渲染端解析到目录外的绝对路径图片后
    // 先查询未授权项并询问用户，用户同意后经 grantImagePaths 授权。
    ipc.handle(
      markdeskChannels.checkImageGrants,
      async (event, srcs: unknown): Promise<IpcResult<string[]>> =>
        guarded(async () => {
          grantsForSender(event.sender);
          await imageGrantsReady;
          const requested = validateImageSrcList(srcs);
          return requested.filter((src) => !grantedAbsoluteImages.has(src));
        }),
    );

    ipc.handle(
      markdeskChannels.grantImagePaths,
      async (event, srcs: unknown): Promise<IpcResult<string[]>> =>
        guarded(async () => {
          grantsForSender(event.sender);
          await imageGrantsReady;
          const requested = validateImageSrcList(srcs);
          for (const src of requested) {
            grantAbsoluteImage(src);
          }
          return [...grantedAbsoluteImages];
        }),
    );

    // Pandoc 导出（需求 4.6）：markdown 文本经系统 Pandoc 转为目标
    // 格式。临时 md 与文档同目录以便相对图片可被 Pandoc 解析。
    ipc.handle(
      markdeskChannels.exportPandoc,
      async (
        event,
        target: unknown,
        markdown: unknown,
        defaultName: unknown,
        docDir: unknown,
      ): Promise<IpcResult<string | null>> =>
        guarded(async () => {
          const grants = grantsForSender(event.sender);
          const format =
            typeof target === "string" &&
              target in pandocExportFormats
              ? pandocExportFormats[target as PandocExportTarget]
              : null;
          if (!format) {
            throw new FileServiceError("invalid-argument", "导出格式无效。");
          }
          if (typeof markdown !== "string" || markdown.length === 0) {
            throw new FileServiceError("invalid-argument", "导出内容无效。");
          }

          const safeDefaultName = defaultSaveName(defaultName)
            .replace(/\.(md|markdown|html?)$/iu, "");
          const selection = await dialogs.showSaveDialog(grants.window, {
            title: "导出文档",
            defaultPath: `${safeDefaultName}.${format.ext}`,
            filters: [
              { name: format.ext.toUpperCase(), extensions: [format.ext] },
            ],
          });
          const targetPath = selection.filePath;
          if (selection.canceled || !targetPath) return null;
          if (!targetPath.toLowerCase().endsWith(`.${format.ext}`)) {
            throw new FileServiceError("invalid-path", "导出路径扩展名无效。");
          }

          await ensurePandoc();

          let tempDirectory: string | null = null;
          if (typeof docDir === "string" && docDir.length > 0) {
            const canonicalDir = await canonicalize(docDir);
            if (
              grants.readPaths.has(canonicalDir) ||
              grants.writePaths.has(canonicalDir)
            ) {
              tempDirectory = canonicalDir;
            }
          }
          const tempPath = join(
            tempDirectory ?? tmpdir(),
            `.markdesk-pandoc-${randomUUID()}.md`,
          );
          await (dependencies.writeExport ?? writeExportFile)(
            tempPath,
            markdown,
          );
          try {
            await runPandoc([
              tempPath,
              "-o",
              targetPath,
              "-t",
              format.to,
              "--resource-path",
              tempDirectory ?? dirname(targetPath),
            ]);
          } finally {
            await rm(tempPath, { force: true }).catch(() => undefined);
          }
          return targetPath;
        }),
    );
  }

  async function notifyFileChanged(path: string): Promise<void> {
    const canonical = await canonicalMarkdownPath(path);
    for (const grants of grantsBySender.values()) {
      if (grants.readPaths.has(canonical)) {
        grants.sender.send(markdeskChannels.fileChanged, {
          path: canonical,
        });
      }
    }
  }

  function protectWindowClose(window: CloseableWindowLike): void {
    // "closed" 触发时窗口已销毁，再访问 window.webContents 会抛
    // "Object has been destroyed"，因此先在窗口存活时捕获 id。
    const webContentsId = window.webContents.id;
    let authorizedClose = false;
    let closeRequest: CloseRequest | null = null;
    window.on("close", (event) => {
      if (authorizedClose || window.webContents.isDestroyed?.()) return;
      event.preventDefault();
      if (!closeRequest) {
        closeRequest = {
          authorizeAndClose: () => {
            if (window.webContents.isDestroyed?.()) return;
            authorizedClose = true;
            closeRequest = null;
            closeRequests.delete(window.webContents.id);
            window.close();
          },
          cancel: () => {
            closeRequest = null;
            closeRequests.delete(window.webContents.id);
          },
        };
        closeRequests.set(window.webContents.id, closeRequest);
      }
      window.webContents.send(markdeskChannels.closeRequested, undefined);
    });
    window.once("closed", () => {
      closeRequest = null;
      closeRequests.delete(webContentsId);
      revoke(webContentsId);
    });
  }

  // 处理命令行/文件关联传入的路径：校验并规范化后登记到最近文件，
  // 渲染端随后的 readRecentFile 依赖该记录完成受权读取。
  async function openExternalPath(path: unknown): Promise<string> {
    const canonical = await canonicalMarkdownPath(path);
    if (!(await fileExists(canonical))) {
      throw new FileServiceError("invalid-path", "文件不存在。");
    }
    await recordRecentFileBestEffort(canonical);
    return canonical;
  }

  async function refreshRecentFiles(): Promise<RecentFileStatus[]> {
    const files = await queueRecentOperation(async () => {
      const statuses = await loadRecentStatuses();
      broadcastRecentFiles(statuses);
      return statuses;
    });
    return files;
  }

  async function clearRecentFilesForApplication(): Promise<void> {
    await queueRecentOperation(async () => {
      await clearRecent(requireRecentStorage());
      broadcastRecentFiles([]);
    });
  }

  function onRecentFilesChanged(listener: RecentFilesListener): void {
    recentFilesListeners.add(listener);
  }

  return {
    register,
    notifyFileChanged,
    protectWindowClose,
    openExternalPath,
    refreshRecentFiles,
    clearRecentFiles: clearRecentFilesForApplication,
    onRecentFilesChanged,
  };
}

const menuCommands = new Set<MenuCommand>([
  "new",
  "open",
  "save",
  "save-as",
  "export-html",
  "toggle-source",
  "toggle-read",
  "toggle-wysiwyg",
  "format-bold",
  "format-italic",
  "format-strikethrough",
  "format-code",
  "paragraph-paragraph",
  "paragraph-heading-1",
  "paragraph-heading-2",
  "paragraph-heading-3",
  "paragraph-heading-4",
  "paragraph-heading-5",
  "paragraph-heading-6",
  "paragraph-quote",
  "paragraph-code-block",
  "paragraph-bullet-list",
  "paragraph-ordered-list",
  "paragraph-horizontal-rule",
]);

export function isMenuCommand(value: unknown): value is MenuCommand {
  return typeof value === "string" && menuCommands.has(value as MenuCommand);
}

export function sendMenuCommand(
  window: BrowserWindow,
  command: MenuCommand,
): void {
  window.webContents.send(markdeskChannels.menuCommand, command);
}

export function sendOpenRecentFile(
  window: BrowserWindow,
  path: string,
): void {
  window.webContents.send(markdeskChannels.openRecentFile, { path });
}
