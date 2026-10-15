import { contextBridge, ipcRenderer } from "electron";
import {
  markdeskChannels,
  type IpcResult,
  type MenuCommand,
  type FileChangedEvent,
  type FileFingerprint,
  type FileReadResult,
  type FileWriteResult,
  type MarkDeskRendererApi,
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
    const error = new Error(result.error.message);
    error.name = "MarkDeskIpcError";
    Object.assign(error, { code: result.error.code });
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
};

contextBridge.exposeInMainWorld("markdesk", rendererApi);
