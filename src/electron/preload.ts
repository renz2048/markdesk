import { contextBridge, ipcRenderer } from "electron";
import {
  markdeskChannels,
  type FileChangedEvent,
  type IpcResult,
  type MenuCommand,
  type FileFingerprint,
  type FileReadResult,
  type FileWriteResult,
  type MarkDeskRendererApi,
  type OpenRecentFileEvent,
  type RecentFileStatus,
  type RecoveryDraft,
  type RecoveryDraftInput,
  type RecoveryDraftSummary,
} from "../shared/types";

async function invokeResult<TValue>(
  channel: string,
  ...args: unknown[]
): Promise<TValue> {
  const result = (await ipcRenderer.invoke(
    channel,
    ...args,
  )) as IpcResult<TValue>;

  if (result && result.ok) return result.value;
  if (result && !result.ok) {
    // contextBridge 跨上下文传播异常时只保留 message，自定义属性
    // （如 code）会被剥离；因此把错误码编码为 message 的首行，
    // 由渲染器的 toFileActionError 解码。
    const error = new Error(
      `${result.error.code}\n${result.error.message}`,
    );
    error.name = "MarkDeskIpcError";
    throw error;
  }

  throw new Error("MarkDesk IPC 返回结果无效。");
}

const rendererApi: MarkDeskRendererApi = {
  chooseMarkdownFile: () =>
    invokeResult<string | null>(markdeskChannels.chooseMarkdownFile),
  chooseSaveLocation: (defaultName: string) =>
    invokeResult<string | null>(
      markdeskChannels.chooseSaveLocation,
      defaultName,
    ),
  readFile: (path: string): Promise<FileReadResult> =>
    invokeResult(markdeskChannels.readFile, path),
  writeFile: (
    path: string,
    content: string,
    expected?: FileFingerprint,
  ): Promise<FileWriteResult> =>
    invokeResult(markdeskChannels.writeFile, path, content, expected),
  getRecentFiles: (): Promise<RecentFileStatus[]> =>
    invokeResult(markdeskChannels.getRecentFiles),
  readRecentFile: (path: string): Promise<FileReadResult> =>
    invokeResult(markdeskChannels.readRecentFile, path),
  clearRecentFiles: (): Promise<void> =>
    invokeResult(markdeskChannels.clearRecentFiles),
  saveRecoveryDraft: (draft: RecoveryDraftInput): Promise<string> =>
    invokeResult(markdeskChannels.saveRecoveryDraft, draft),
  listRecoveryDrafts: (): Promise<RecoveryDraftSummary[]> =>
    invokeResult(markdeskChannels.listRecoveryDrafts),
  readRecoveryDraft: (key: string): Promise<RecoveryDraft | null> =>
    invokeResult(markdeskChannels.readRecoveryDraft, key),
  discardRecoveryDraft: (key: string): Promise<void> =>
    invokeResult(markdeskChannels.discardRecoveryDraft, key),
  requestClose: (): Promise<void> =>
    invokeResult(markdeskChannels.requestClose),
  cancelClose: (): Promise<void> =>
    invokeResult(markdeskChannels.cancelClose),
  onMenuCommand: (listener: (command: MenuCommand) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      command: MenuCommand,
    ) => {
      listener(command);
    };
    ipcRenderer.on(markdeskChannels.menuCommand, handler);
    return () => {
      ipcRenderer.removeListener(markdeskChannels.menuCommand, handler);
    };
  },
  onFileChanged: (listener: (event: FileChangedEvent) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      event: FileChangedEvent,
    ) => {
      listener(event);
    };
    ipcRenderer.on(markdeskChannels.fileChanged, handler);
    return () => {
      ipcRenderer.removeListener(markdeskChannels.fileChanged, handler);
    };
  },
  onOpenRecentFile: (listener: (event: OpenRecentFileEvent) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      event: unknown,
    ) => {
      if (
        typeof event === "object" && event !== null &&
        typeof (event as OpenRecentFileEvent).path === "string"
      ) {
        listener((event as OpenRecentFileEvent));
      }
    };
    ipcRenderer.on(markdeskChannels.openRecentFile, handler);
    return () => {
      ipcRenderer.removeListener(markdeskChannels.openRecentFile, handler);
    };
  },
  onRecentFilesChanged: (
    listener: (files: RecentFileStatus[]) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      files: unknown,
    ) => {
      if (
        Array.isArray(files) &&
        files.every((file) =>
          typeof file === "object" && file !== null &&
          typeof (file as RecentFileStatus).path === "string" &&
          typeof (file as RecentFileStatus).name === "string" &&
          typeof (file as RecentFileStatus).lastOpenedAt === "number" &&
          typeof (file as RecentFileStatus).exists === "boolean"
        )
      ) {
        listener(files as RecentFileStatus[]);
      }
    };
    ipcRenderer.on(markdeskChannels.recentFilesChanged, handler);
    return () => {
      ipcRenderer.removeListener(markdeskChannels.recentFilesChanged, handler);
    };
  },
  onCloseRequested: (listener: () => void) => {
    const handler = () => {
      listener();
    };
    ipcRenderer.on(markdeskChannels.closeRequested, handler);
    return () => {
      ipcRenderer.removeListener(markdeskChannels.closeRequested, handler);
    };
  },
};

contextBridge.exposeInMainWorld("markdesk", rendererApi);
