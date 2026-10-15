import { createHash } from "node:crypto";
import { open, rename, stat, unlink } from "node:fs/promises";
import { dirname, extname, isAbsolute, posix, win32 } from "node:path";
import type {
  FileFingerprint,
  FileReadResult,
  FileWriteResult,
  IpcErrorCode,
  NewlinePreference,
} from "../shared/types";

export const MAX_MARKDOWN_BYTES = 10 * 1024 * 1024;
export const MAX_MARKDOWN_PATH_LENGTH = 4096;
const UTF8_BOM = "\uFEFF";
const temporarySuffix = ".markdesk-tmp";

export interface FileStats {
  mtimeMs: number;
  size: number;
  mode: number;
  dev?: number;
  ino?: number;
}

export interface MarkdownFileHandle {
  readFile(): Promise<Buffer>;
  writeFile(data: string | Buffer): Promise<void>;
  chmod(mode: number): Promise<void>;
  sync(): Promise<void>;
  stat(): Promise<FileStats>;
  close(): Promise<void>;
}

export interface MarkdownFileSystem {
  open(
    path: string,
    flags: "r" | "wx",
    mode?: number,
  ): Promise<MarkdownFileHandle>;
  rename(from: string, to: string): Promise<void>;
  stat(path: string): Promise<FileStats>;
  unlink(path: string): Promise<void>;
}

const nodeFileSystem: MarkdownFileSystem = {
  open: (path, flags, mode = 0o600) => open(path, flags, mode),
  rename,
  stat,
  unlink,
};

const utf8Decoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

const unpairedSurrogate =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

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

function isWindowsStylePath(path: string): boolean {
  return win32.isAbsolute(path);
}

function parentDirectory(path: string): string {
  return isWindowsStylePath(path) ? win32.dirname(path) : posix.dirname(path);
}

export function isMarkdownPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0) return false;
  if (path.length > MAX_MARKDOWN_PATH_LENGTH) return false;
  if (/[\0-\x1f\u007f]/u.test(path)) return false;
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

function canonicalText(bytes: Buffer): string {
  const decoded = decodeUtf8(bytes);
  return decoded.startsWith(UTF8_BOM)
    ? decoded.slice(UTF8_BOM.length)
    : decoded;
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

function sameIdentity(left: FileStats, right: FileStats): boolean {
  const leftDev = left.dev ?? null;
  const rightDev = right.dev ?? null;
  const leftIno = left.ino ?? null;
  const rightIno = right.ino ?? null;
  return (
    leftDev === rightDev &&
    leftIno === rightIno &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

interface CoherentRead {
  bytes: Buffer;
  before: FileStats;
  after: FileStats;
}

async function readFromHandle(
  handle: MarkdownFileHandle,
): Promise<CoherentRead> {
  const before = await handle.stat();
  if (before.size > MAX_MARKDOWN_BYTES) {
    throw new FileServiceError(
      "file-too-large",
      "Markdown 文件不能超过 10 MiB。",
    );
  }

  const bytes = await handle.readFile();
  const after = await handle.stat();
  if (!sameIdentity(before, after)) {
    throw new FileChangedError("文件在读取过程中发生变化。");
  }
  if (after.size > MAX_MARKDOWN_BYTES || bytes.byteLength > MAX_MARKDOWN_BYTES) {
    throw new FileServiceError(
      "file-too-large",
      "Markdown 文件不能超过 10 MiB。",
    );
  }
  return { bytes, before, after };
}

async function readCoherently(
  path: string,
  fileSystem: MarkdownFileSystem,
): Promise<CoherentRead & { handle: MarkdownFileHandle }> {
  let handle: MarkdownFileHandle;
  try {
    handle = await fileSystem.open(path, "r");
  } catch (error) {
    throw new FileServiceError("read-failed", "无法读取 Markdown 文件。", error);
  }

  try {
    const read = await readFromHandle(handle);
    await handle.close();
    return { ...read, handle };
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (error instanceof FileServiceError) throw error;
    throw new FileServiceError("read-failed", "无法读取 Markdown 文件。", error);
  }
}

function resolveFileSystem(
  contentOrFileSystem?: string | MarkdownFileSystem,
  fileSystemOverride?: MarkdownFileSystem,
): {
  content?: string;
  fileSystem: MarkdownFileSystem;
} {
  return {
    content: typeof contentOrFileSystem === "string"
      ? contentOrFileSystem
      : undefined,
    fileSystem: fileSystemOverride ??
      (typeof contentOrFileSystem === "object"
        ? contentOrFileSystem
        : nodeFileSystem),
  };
}

export async function fingerprint(
  path: string,
  contentOrFileSystem?: string | MarkdownFileSystem,
  fileSystemOverride?: MarkdownFileSystem,
): Promise<FileFingerprint> {
  if (!isMarkdownPath(path)) {
    throw new FileServiceError("invalid-path", "Markdown 文件路径无效。");
  }

  const { content, fileSystem } = resolveFileSystem(
    contentOrFileSystem,
    fileSystemOverride,
  );
  const read = await readCoherently(path, fileSystem);
  const source = content ?? canonicalText(read.bytes);
  return {
    hash: hashContent(source),
    mtimeMs: read.after.mtimeMs,
    size: byteSize(source),
  };
}

export async function readMarkdownFile(
  path: string,
  fileSystem: MarkdownFileSystem = nodeFileSystem,
): Promise<FileReadResult> {
  if (!isMarkdownPath(path)) {
    throw new FileServiceError("invalid-path", "Markdown 文件路径无效。");
  }

  const read = await readCoherently(path, fileSystem);
  const content = canonicalText(read.bytes);
  return {
    path,
    content,
    newline: detectNewline(content),
    hash: hashContent(content),
    mtimeMs: read.after.mtimeMs,
    size: byteSize(content),
  };
}

async function closeQuietly(handle: MarkdownFileHandle | undefined) {
  if (!handle) return;
  await handle.close().catch(() => undefined);
}

async function removeOwnedTemporary(
  path: string,
  fileSystem: MarkdownFileSystem,
) {
  try {
    await fileSystem.unlink(path);
  } catch {
    // Cleanup must not replace the operation's original error.
  }
}

async function syncDirectory(
  path: string,
  fileSystem: MarkdownFileSystem,
): Promise<void> {
  if (process.platform === "win32") return;

  const handle = await fileSystem.open(parentDirectory(path), "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
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
  if (unpairedSurrogate.test(content)) {
    throw new FileServiceError(
      "invalid-encoding",
      "Markdown 内容包含无法编码的独立 Unicode 代理项。",
    );
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

  let existingHandle: MarkdownFileHandle | undefined;
  let existingStats: FileStats | undefined;
  let temporaryHandle: MarkdownFileHandle | undefined;
  let ownsTemporary = false;
  let renamed = false;
  let temporaryStats: FileStats | undefined;
  const temporaryPath = `${path}${temporarySuffix}`;

  try {
    if (expected !== undefined) {
      try {
        existingHandle = await fileSystem.open(path, "r");
        const read = await readFromHandle(existingHandle);
        const actual: FileFingerprint = {
          hash: hashContent(canonicalText(read.bytes)),
          mtimeMs: read.after.mtimeMs,
          size: byteSize(canonicalText(read.bytes)),
        };
        if (
          actual.hash !== expected.hash ||
          actual.mtimeMs !== expected.mtimeMs ||
          actual.size !== expected.size
        ) {
          throw new FileChangedError();
        }
        existingStats = read.after;
      } catch (error) {
        if (error instanceof FileServiceError) throw error;
        throw new FileServiceError(
          "read-failed",
          "无法读取 Markdown 文件。",
          error,
        );
      }
    } else {
      try {
        existingStats = await fileSystem.stat(path);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code !== "ENOENT") {
          throw new FileServiceError(
            "read-failed",
            "无法读取 Markdown 文件。",
            error,
          );
        }
      }
    }

    const targetMode = (existingStats?.mode ?? 0o600) & 0o7777;
    temporaryHandle = await fileSystem.open(temporaryPath, "wx", 0o600);
    ownsTemporary = true;
    await temporaryHandle.writeFile(content);
    await temporaryHandle.chmod(targetMode);
    await temporaryHandle.sync();
    temporaryStats = await temporaryHandle.stat();

    if (existingHandle) {
      const heldNow = await existingHandle.stat();
      const namedNow = await fileSystem.stat(path);
      if (
        !sameIdentity(heldNow, existingStats ?? heldNow) ||
        !sameIdentity(namedNow, existingStats ?? namedNow)
      ) {
        throw new FileChangedError();
      }
      await existingHandle.close();
      existingHandle = undefined;
    }

    await temporaryHandle.close();
    temporaryHandle = undefined;
    await fileSystem.rename(temporaryPath, path);
    ownsTemporary = false;
    renamed = true;
  } catch (error) {
    await closeQuietly(temporaryHandle);
    if (ownsTemporary) {
      await removeOwnedTemporary(temporaryPath, fileSystem);
    }
    if (error instanceof FileServiceError) throw error;
    throw new FileServiceError(
      "write-failed",
      "保存 Markdown 文件失败。",
      error,
    );
  } finally {
    await closeQuietly(existingHandle);
  }

  if (renamed) {
    try {
      await syncDirectory(path, fileSystem);
    } catch (error) {
      throw new FileServiceError(
        "write-failed",
        "已保存文件，但目录同步失败。",
        error,
      );
    }
  }

  const info = temporaryStats;
  if (!info) {
    throw new FileServiceError("write-failed", "保存 Markdown 文件失败。");
  }

  return {
    path,
    hash: hashContent(content),
    mtimeMs: info.mtimeMs,
    size: byteSize(content),
  };
}
