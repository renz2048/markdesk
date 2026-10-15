import { randomBytes } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, win32 } from "node:path";
import type { RecentFile } from "../shared/types";

export const RECENT_FILES_LIMIT = 10;

function isRecentFile(value: unknown): value is RecentFile {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RecentFile>;
  return (
    typeof candidate.path === "string" &&
    candidate.path.length > 0 &&
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    typeof candidate.lastOpenedAt === "number" &&
    Number.isFinite(candidate.lastOpenedAt)
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

async function syncContainingDirectory(path: string): Promise<void> {
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
): Promise<void> {
  const temporaryPath = `${storagePath}.${randomBytes(12).toString("hex")}.markdesk-tmp`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(files, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, storagePath);
    await syncContainingDirectory(storagePath);
  } finally {
    try {
      await handle?.close();
    } catch {
      // Ignore secondary close failure while preserving the original error.
    }
    await unlink(temporaryPath).catch(() => {
      // Cleanup is best-effort. A failed temporary-file cleanup must not mask
      // the write/rename error that caused it.
    });
  }
}

export async function loadRecentFiles(
  storagePath: string,
): Promise<RecentFile[]> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(storagePath, "utf8"),
    );
    if (!Array.isArray(parsed)) return [];
    return normalizeRecentFiles(parsed);
  } catch {
    return [];
  }
}

export async function upsertRecentFile(
  storagePath: string,
  path: string,
): Promise<RecentFile[]> {
  const files = await loadRecentFiles(storagePath);
  const entry: RecentFile = {
    path,
    name: recentFileName(path),
    lastOpenedAt: Date.now(),
  };
  const nextFiles = [
    entry,
    ...files.filter((file) => file.path !== path),
  ].slice(0, RECENT_FILES_LIMIT);
  await writeJsonAtomically(storagePath, nextFiles);
  return nextFiles;
}

export async function clearRecentFiles(storagePath: string): Promise<void> {
  await writeJsonAtomically(storagePath, []);
}
