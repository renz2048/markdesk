import {
  BrowserWindow,
  dialog,
  ipcMain,
} from "electron";
import { watch } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import {
  fingerprint,
  FileServiceError,
  isFileFingerprint,
  isMarkdownPath,
  readMarkdownFile,
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
  markdeskChannels,
  type FileFingerprint,
  type FileReadResult,
  type FileWriteResult,
  type IpcResult,
  type MenuCommand,
  type RecentFile,
  type RecentFileStatus,
  type RecoveryDraft,
  type RecoveryDraftInput,
  type RecoveryDraftSummary,
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
  watcher: FileWatcherLike;
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

function normalizeUnresolvedPath(path: string): string {
  // 只有盘符形式（C:\ 或 C:/）才按 win32 语义规范化（大小写不敏感、
  // 反斜杠分隔）。注意 win32.isAbsolute("/tmp/x") 在 Node 中返回 true，
  // 若据此分支会在 POSIX 上把 /tmp 规范化成 \tmp 并破坏文件访问。
  if (/^[a-zA-Z]:[\\/]/u.test(path)) {
    return win32.resolve(path).toLowerCase();
  }
  return posix.resolve(path);
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

function windowsReservedName(value: string): boolean {
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(value);
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

export interface SecureFileIpcController {
  register(): void;
  notifyFileChanged(path: string): Promise<void>;
  protectWindowClose(window: CloseableWindowLike): void;
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
    state.watcher.close();
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

    try {
      const state: WatchedFileState = {
        watcher: watchFile(canonical, () => scheduleExternalCheck(canonical)),
        owners: new Set([owner.sender.id]),
        timeout: null,
        closed: false,
      };
      state.watcher.once("error", () => closeWatchedFile(canonical, state));
      watchedFiles.set(canonical, state);
      scheduleExternalCheck(canonical);
    } catch {
      // Watching is an enhancement; guarded reads and fingerprint-checked
      // writes remain the security and collision boundary.
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
      closeRequests.delete(window.webContents.id);
      revoke(window.webContents.id);
    });
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
