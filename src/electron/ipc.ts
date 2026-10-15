import { BrowserWindow, dialog, ipcMain } from "electron";
import {
  FileServiceError,
  isFileFingerprint,
  isMarkdownPath,
  readMarkdownFile,
  writeMarkdownFile,
} from "./file-service";
import {
  markdeskChannels,
  type FileReadResult,
  type FileFingerprint,
  type FileWriteResult,
  type IpcResult,
  type MenuCommand,
} from "../shared/types";

const allowedReadPaths = new Set<string>();
const allowedWritePaths = new Set<string>();
const requiredWriteFingerprints = new Map<string, FileFingerprint>();
let registered = false;

function windowForSender(sender: Electron.WebContents): BrowserWindow | null {
  return (
    BrowserWindow.getAllWindows().find(
      (window) => window.webContents.id === sender.id,
    ) ?? null
  );
}

function success<TValue>(value: TValue): IpcResult<TValue> {
  return { ok: true, value };
}

function failure(error: unknown): IpcResult<never> {
  if (error instanceof FileServiceError) {
    return { ok: false, error: { code: error.code, message: error.message } };
  }

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

function requireAllowedReadPath(path: unknown): string {
  if (!isMarkdownPath(path)) {
    throw new FileServiceError("invalid-path", "Markdown 文件路径无效。");
  }
  if (!allowedReadPaths.has(path)) {
    throw new FileServiceError(
      "invalid-path",
      "此文件尚未通过 MarkDesk 明确打开。",
    );
  }
  return path;
}

function requireAllowedWritePath(path: unknown): string {
  if (!isMarkdownPath(path)) {
    throw new FileServiceError("invalid-path", "Markdown 文件路径无效。");
  }
  if (!allowedReadPaths.has(path) && !allowedWritePaths.has(path)) {
    throw new FileServiceError(
      "invalid-path",
      "此文件路径未获准保存。",
    );
  }
  return path;
}

function defaultSaveName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    /[/\\]/u.test(value) ||
    /[\0-\x1f\u007f]/u.test(value)
  ) {
    throw new FileServiceError("invalid-argument", "默认文件名无效。");
  }
  return isMarkdownPath(`/__markdesk_default__/${value}`)
    ? value
    : `${value}.md`;
}

export function registerSecureFileIpc(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle(
    markdeskChannels.chooseMarkdownFile,
    async (event): Promise<IpcResult<string | null>> =>
      guarded(async () => {
        const window = windowForSender(event.sender);
        if (!window) throw new Error("unrecognized renderer");

        const selection = await dialog.showOpenDialog(window, {
          title: "打开 Markdown",
          properties: ["openFile"],
          filters: [
            { name: "Markdown", extensions: ["md", "markdown"] },
          ],
        });
        const path = selection.filePaths[0];
        if (!path || !isMarkdownPath(path)) return null;

        allowedReadPaths.add(path);
        return path;
      }),
  );

  ipcMain.handle(
    markdeskChannels.chooseSaveLocation,
    async (
      event,
      defaultName: unknown,
    ): Promise<IpcResult<string | null>> =>
      guarded(async () => {
        const window = windowForSender(event.sender);
        if (!window) throw new Error("unrecognized renderer");
        const safeDefaultName = defaultSaveName(defaultName);

        const selection = await dialog.showSaveDialog(window, {
          title: "保存 Markdown",
          defaultPath: safeDefaultName,
          filters: [
            { name: "Markdown", extensions: ["md", "markdown"] },
          ],
        });
        const path = selection.filePath;
        if (!path || !isMarkdownPath(path)) return null;

        allowedWritePaths.add(path);
        return path;
      }),
  );

  ipcMain.handle(
    markdeskChannels.readFile,
    async (_event, path: unknown): Promise<IpcResult<FileReadResult>> =>
      guarded(async () => {
        const allowedPath = requireAllowedReadPath(path);
        const file = await readMarkdownFile(allowedPath);
        allowedWritePaths.add(allowedPath);
        requiredWriteFingerprints.set(allowedPath, {
          hash: file.hash,
          mtimeMs: file.mtimeMs,
          size: file.size,
        });
        return file;
      }),
  );

  ipcMain.handle(
    markdeskChannels.writeFile,
    async (
      _event,
      path: unknown,
      content: unknown,
      expected: unknown,
    ): Promise<IpcResult<FileWriteResult>> =>
      guarded(async () => {
        const allowedPath = requireAllowedWritePath(path);
        if (typeof content !== "string") {
          throw new FileServiceError("invalid-argument", "Markdown 内容无效。");
        }
        const expectedFingerprint =
          expected === undefined ? undefined : (expected as FileFingerprint);
        const requiredFingerprint = requiredWriteFingerprints.get(allowedPath);
        if (
          requiredFingerprint &&
          (!isFileFingerprint(expectedFingerprint) ||
            expectedFingerprint.hash !== requiredFingerprint.hash ||
            expectedFingerprint.mtimeMs !== requiredFingerprint.mtimeMs ||
            expectedFingerprint.size !== requiredFingerprint.size)
        ) {
          throw new FileServiceError(
            "invalid-fingerprint",
            "保存前必须提供打开文件时的校验信息。",
          );
        }

        const result = await writeMarkdownFile(
          allowedPath,
          content,
        );
        requiredWriteFingerprints.set(allowedPath, {
          hash: result.hash,
          mtimeMs: result.mtimeMs,
          size: result.size,
        });
        return result;
      }),
  );
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

export function notifyFileChanged(path: string): void {
  if (!isMarkdownPath(path) || !allowedReadPaths.has(path)) return;
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(markdeskChannels.fileChanged, { path });
  }
}
