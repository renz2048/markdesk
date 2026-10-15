import { randomBytes } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, posix, win32 } from "node:path";
import type { RecentFile } from "../shared/types";

export const RECENT_FILES_LIMIT = 10;

export interface RecentFileHandle {
  writeFile(data: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface RecentFileSystem {
  open(
    path: string,
    flags: "wx",
    mode?: number,
  ): Promise<RecentFileHandle>;
  readFile(path: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface RecentFilesDependencies {
  fileSystem?: RecentFileSystem;
}

const nodeRecentFileSystem: RecentFileSystem = {
  open: (path, flags, mode = 0o600) => open(path, flags, mode),
  readFile: (path) => readFile(path, "utf8"),
  rename,
  unlink,
};

const storageLocks = new Map<string, Promise<unknown>>();
const markdownExtensions = new Set([".md", ".markdown"]);

class RecentFileError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RecentFileError";
    this.code = code;
  }
}

function isAbsoluteMarkdownPath(path: string): boolean {
  if (
    path.length === 0 ||
    path.length > 4096 ||
    /[\0-\x1f\u007f]/u.test(path) ||
    (!posix.isAbsolute(path) && !win32.isAbsolute(path))
  ) {
    return false;
  }
  const extension = posix.extname(path).toLowerCase();
  const windowsExtension = win32.extname(path).toLowerCase();
  return markdownExtensions.has(extension) ||
    markdownExtensions.has(windowsExtension);
}

function queuedStorageOperation<TValue>(
  storagePath: string,
  operation: () => Promise<TValue>,
): Promise<TValue> {
  const previous = storageLocks.get(storagePath) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  storageLocks.set(
    storagePath,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

function isRecentFile(value: unknown): value is RecentFile {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RecentFile>;
  return (
    typeof candidate.path === "string" &&
    isAbsoluteMarkdownPath(candidate.path) &&
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    typeof candidate.lastOpenedAt === "number" &&
    Number.isFinite(candidate.lastOpenedAt) &&
    candidate.name === recentFileName(candidate.path)
  );
}

function normalizeRecentFiles(values: unknown[]): RecentFile[] {
  const filesByPath = new Map<string, RecentFile>();
  for (const value of values) {
    if (!isRecentFile(value)) continue;
    if (!filesByPath.has(value.path)) filesByPath.set(value.path, value);
  }
  return [...filesByPath.values()].slice(0, RECENT_FILES_LIMIT);
}

function recentFileName(path: string): string {
  return win32.basename(path) || basename(path) || "未命名.md";
}

async function syncContainingDirectory(
  path: string,
  dependencies: RecentFilesDependencies,
): Promise<void> {
  if (dependencies.fileSystem) return;
  let directory: Awaited<ReturnType<typeof open>> | null = null;
  try {
    directory = await open(dirname(path), "r");
    await directory.sync();
  } catch {
    // Windows and some filesystems do not permit opening directories. The
    // rename is still atomic; this best-effort fsync adds durability where it
    // is available.
  } finally {
    await directory?.close();
  }
}

async function writeJsonAtomically(
  storagePath: string,
  files: RecentFile[],
  dependencies: RecentFilesDependencies = {},
): Promise<void> {
  const fileSystem = dependencies.fileSystem ?? nodeRecentFileSystem;
  const temporaryPath = `${storagePath}.${randomBytes(12).toString("hex")}.markdesk-tmp`;
  let handle: RecentFileHandle | null = null;
  try {
    handle = await fileSystem.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(files, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await fileSystem.rename(temporaryPath, storagePath);
    await syncContainingDirectory(storagePath, dependencies);
  } finally {
    try {
      await handle?.close();
    } catch {
      // Ignore secondary close failure while preserving the original error.
    }
    await fileSystem.unlink(temporaryPath).catch(() => {
      // Cleanup is best-effort. A failed temporary-file cleanup must not mask
      // the write/rename error that caused it.
    });
  }
}

export async function loadRecentFiles(
  storagePath: string,
  dependencies: RecentFilesDependencies = {},
): Promise<RecentFile[]> {
  const fileSystem = dependencies.fileSystem ?? nodeRecentFileSystem;
  let serialized: string;
  try {
    serialized = await fileSystem.readFile(storagePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!Array.isArray(parsed)) return [];
    return normalizeRecentFiles(parsed);
  } catch {
    return [];
  }
}

export async function upsertRecentFile(
  storagePath: string,
  path: string,
  dependencies: RecentFilesDependencies = {},
): Promise<RecentFile[]> {
  if (!isAbsoluteMarkdownPath(path)) {
    throw new RecentFileError(
      "invalid-path",
      "Markdown 文件路径无效。",
    );
  }

  return queuedStorageOperation(storagePath, async () => {
    const files = await loadRecentFiles(storagePath, dependencies);
    const entry: RecentFile = {
      path,
      name: recentFileName(path),
      lastOpenedAt: Date.now(),
    };
    const nextFiles = [
      entry,
      ...files.filter((file) => file.path !== path),
    ].slice(0, RECENT_FILES_LIMIT);
    await writeJsonAtomically(storagePath, nextFiles, dependencies);
    return nextFiles;
  });
}

export async function clearRecentFiles(
  storagePath: string,
  dependencies: RecentFilesDependencies = {},
): Promise<void> {
  await queuedStorageOperation(storagePath, () =>
    writeJsonAtomically(storagePath, [], dependencies)
  );
}
