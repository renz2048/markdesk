import { createHash } from "node:crypto";
import {
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { extname, isAbsolute, win32 } from "node:path";
import type {
  FileFingerprint,
  FileReadResult,
  FileWriteResult,
  IpcErrorCode,
  NewlinePreference,
} from "../shared/types";

export const MAX_MARKDOWN_BYTES = 10 * 1024 * 1024;
const UTF8_BOM = "\uFEFF";
const temporarySuffix = ".markdesk-tmp";

interface FileStats {
  mtimeMs: number;
  size: number;
}

export interface MarkdownFileSystem {
  readFile(path: string): Promise<Buffer>;
  writeFile(
    path: string,
    data: string | Buffer,
    options?: { mode?: number },
  ): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  stat(path: string): Promise<FileStats>;
  unlink(path: string): Promise<void>;
}

const nodeFileSystem: MarkdownFileSystem = {
  readFile: (path) => readFile(path),
  writeFile: (path, data, options) => writeFile(path, data, options),
  rename,
  stat,
  unlink,
};

const utf8Decoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

export class FileServiceError extends Error {
  constructor(
    readonly code: IpcErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "FileServiceError";
  }
}

export class FileChangedError extends FileServiceError {
  constructor(message = "文件已在其他程序中修改，请重新打开后再保存。") {
    super("file-changed", message);
    this.name = "FileChangedError";
  }
}

const markdownExtensions = new Set([".md", ".markdown"]);

export function isMarkdownPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0) return false;
  if (/[\0\r\n]/u.test(path)) return false;
  if (!isAbsolute(path) && !win32.isAbsolute(path)) return false;

  const extension = extname(path).toLowerCase();
  const windowsExtension = win32.extname(path).toLowerCase();
  return (
    markdownExtensions.has(extension) ||
    markdownExtensions.has(windowsExtension)
  );
}

export function detectNewline(content: string): NewlinePreference {
  return content.includes("\r\n") ? "crlf" : "lf";
}

export function normalizeNewline(
  content: string,
  newline: NewlinePreference,
): string {
  const lfContent = content.replace(/\r\n?/gu, "\n");
  return newline === "crlf"
    ? lfContent.replace(/\n/gu, "\r\n")
    : lfContent;
}

function byteSize(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return utf8Decoder.decode(bytes);
  } catch (error) {
    throw new FileServiceError(
      "invalid-encoding",
      "文件不是有效的 UTF-8 Markdown。",
      error,
    );
  }
}

export function isFileFingerprint(value: unknown): value is FileFingerprint {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<FileFingerprint>;
  return (
    typeof candidate.hash === "string" &&
    /^[0-9a-f]{64}$/u.test(candidate.hash) &&
    typeof candidate.mtimeMs === "number" &&
    Number.isFinite(candidate.mtimeMs) &&
    candidate.mtimeMs >= 0 &&
    typeof candidate.size === "number" &&
    Number.isInteger(candidate.size) &&
    candidate.size >= 0
  );
}

export async function fingerprint(
  path: string,
  fileSystem: MarkdownFileSystem = nodeFileSystem,
): Promise<FileFingerprint> {
  if (!isMarkdownPath(path)) {
    throw new FileServiceError("invalid-path", "Markdown 文件路径无效。");
  }

  let bytes: Buffer;
  let info: FileStats;
  try {
    info = await fileSystem.stat(path);
    if (info.size > MAX_MARKDOWN_BYTES) {
      throw new FileServiceError(
        "file-too-large",
        "Markdown 文件不能超过 10 MiB。",
      );
    }
    bytes = await fileSystem.readFile(path);
    if (bytes.byteLength > MAX_MARKDOWN_BYTES) {
      throw new FileServiceError(
        "file-too-large",
        "Markdown 文件不能超过 10 MiB。",
      );
    }
  } catch (error) {
    if (error instanceof FileServiceError) throw error;
    throw new FileServiceError(
      "read-failed",
      "无法读取 Markdown 文件。",
      error,
    );
  }

  const decoded = decodeUtf8(bytes);
  const content = decoded.startsWith(UTF8_BOM)
    ? decoded.slice(UTF8_BOM.length)
    : decoded;
  return {
    hash: hashContent(content),
    mtimeMs: info.mtimeMs,
    size: byteSize(content),
  };
}

export async function readMarkdownFile(
  path: string,
  fileSystem: MarkdownFileSystem = nodeFileSystem,
): Promise<FileReadResult> {
  if (!isMarkdownPath(path)) {
    throw new FileServiceError("invalid-path", "Markdown 文件路径无效。");
  }

  let bytes: Buffer;
  let info: FileStats;
  try {
    info = await fileSystem.stat(path);
    if (info.size > MAX_MARKDOWN_BYTES) {
      throw new FileServiceError(
        "file-too-large",
        "Markdown 文件不能超过 10 MiB。",
      );
    }
    bytes = await fileSystem.readFile(path);
  } catch (error) {
    if (error instanceof FileServiceError) throw error;
    throw new FileServiceError("read-failed", "无法读取 Markdown 文件。", error);
  }

  if (bytes.byteLength > MAX_MARKDOWN_BYTES) {
    throw new FileServiceError(
      "file-too-large",
      "Markdown 文件不能超过 10 MiB。",
    );
  }

  const decoded = decodeUtf8(bytes);
  const content = decoded.startsWith(UTF8_BOM)
    ? decoded.slice(UTF8_BOM.length)
    : decoded;

  return {
    path,
    content,
    newline: detectNewline(content),
    hash: hashContent(content),
    mtimeMs: info.mtimeMs,
    size: byteSize(content),
  };
}

async function removeTemporary(path: string, fileSystem: MarkdownFileSystem) {
  try {
    await fileSystem.unlink(path);
  } catch {
    // A failed cleanup must not replace the original write error.
  }
}

export async function writeMarkdownFile(
  path: string,
  content: string,
  expected?: FileFingerprint,
  fileSystem: MarkdownFileSystem = nodeFileSystem,
): Promise<FileWriteResult> {
  if (!isMarkdownPath(path)) {
    throw new FileServiceError("invalid-path", "Markdown 文件路径无效。");
  }
  if (typeof content !== "string") {
    throw new FileServiceError("invalid-argument", "Markdown 内容无效。");
  }
  if (byteSize(content) > MAX_MARKDOWN_BYTES) {
    throw new FileServiceError(
      "file-too-large",
      "Markdown 文件不能超过 10 MiB。",
    );
  }
  if (expected !== undefined && !isFileFingerprint(expected)) {
    throw new FileServiceError("invalid-fingerprint", "文件校验信息无效。");
  }

  if (expected !== undefined) {
    const current = await fingerprint(path, fileSystem).catch((error) => {
      throw new FileChangedError();
    });
    if (
      current.hash !== expected.hash ||
      current.mtimeMs !== expected.mtimeMs ||
      current.size !== expected.size
    ) {
      throw new FileChangedError();
    }
  }

  const temporaryPath = `${path}${temporarySuffix}`;
  try {
    await fileSystem.writeFile(temporaryPath, content, { mode: 0o600 });
    await fileSystem.rename(temporaryPath, path);
  } catch (error) {
    await removeTemporary(temporaryPath, fileSystem);
    throw new FileServiceError(
      "write-failed",
      "保存 Markdown 文件失败。",
      error,
    );
  }

  let info: FileStats;
  try {
    info = await fileSystem.stat(path);
  } catch (error) {
    throw new FileServiceError(
      "write-failed",
      "已保存文件，但无法读取保存状态。",
      error,
    );
  }

  return {
    path,
    hash: hashContent(content),
    mtimeMs: info.mtimeMs,
    size: byteSize(content),
  };
}
