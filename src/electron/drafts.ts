import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, win32 } from "node:path";
import {
  FileServiceError,
  isMarkdownPath,
} from "./file-service";
import type {
  RecoveryDraft,
  RecoveryDraftSummary,
} from "../shared/types";

export type {
  RecoveryDraft,
  RecoveryDraftInput,
  RecoveryDraftSummary,
} from "../shared/types";

const MAX_DRAFT_BYTES = 10 * 1024 * 1024;
const keyPattern = /^[0-9a-f]{64}$/u;
const draftModes = new Set(["wysiwyg", "source", "read"]);
const draftFields = new Set([
  "key",
  "path",
  "fileName",
  "markdown",
  "mode",
  "cursor",
  "scrollTop",
  "updatedAt",
]);
const unpairedSurrogate =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const storageLocks = new Map<string, Promise<unknown>>();

interface DraftHandle {
  writeFile(data: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

function isSafeFileName(value: string): boolean {
  return value.length > 0 &&
    value.length <= 255 &&
    !/[/\\]/u.test(value) &&
    !/[\0-\x1f\u007f]/u.test(value) &&
    !/^[.]$|[.]$/u.test(value) &&
    !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(value);
}

function draftFileName(path: string): string {
  return win32.basename(path) || basename(path) || "未命名.md";
}

function isDraft(value: object): value is RecoveryDraft {
  if (Object.keys(value).length !== draftFields.size) return false;
  const candidate = value as Partial<RecoveryDraft>;
  return (
    typeof candidate.key === "string" &&
    keyPattern.test(candidate.key) &&
    (candidate.path === null ||
      (isMarkdownPath(candidate.path) &&
        candidate.key === draftKeyForPath(candidate.path))) &&
    typeof candidate.fileName === "string" &&
    isSafeFileName(candidate.fileName) &&
    (candidate.path === null || candidate.fileName === draftFileName(candidate.path)) &&
    typeof candidate.markdown === "string" &&
    !unpairedSurrogate.test(candidate.markdown) &&
    Buffer.byteLength(candidate.markdown, "utf8") <= MAX_DRAFT_BYTES &&
    typeof candidate.mode === "string" &&
    draftModes.has(candidate.mode) &&
    typeof candidate.cursor === "number" &&
    Number.isInteger(candidate.cursor) &&
    candidate.cursor >= 0 &&
    candidate.cursor <= Number.MAX_SAFE_INTEGER &&
    typeof candidate.scrollTop === "number" &&
    Number.isFinite(candidate.scrollTop) &&
    candidate.scrollTop >= 0 &&
    typeof candidate.updatedAt === "number" &&
    Number.isInteger(candidate.updatedAt) &&
    candidate.updatedAt >= 0 &&
    candidate.updatedAt <= Number.MAX_SAFE_INTEGER &&
    (candidate.path !== null || candidate.key === draftKeyForPath(null))
  );
}

function validateDraft(value: RecoveryDraft): RecoveryDraft {
  if (!isDraft(value)) {
    throw new FileServiceError(
      "invalid-argument",
      "恢复草稿数据无效。",
    );
  }
  return value;
}

function validateStoragePath(userDataPath: string): string {
  if (
    typeof userDataPath !== "string" ||
    userDataPath.length === 0 ||
    userDataPath.length > 4096 ||
    /[\0-\x1f\u007f]/u.test(userDataPath) ||
    !isAbsolute(userDataPath)
  ) {
    throw new FileServiceError(
      "invalid-argument",
      "恢复草稿存储位置无效。",
    );
  }
  return resolve(userDataPath);
}

function draftsDirectory(userDataPath: string): string {
  return join(validateStoragePath(userDataPath), "drafts");
}

function draftTarget(userDataPath: string, key: string): string {
  if (typeof key !== "string" || !keyPattern.test(key)) {
    throw new FileServiceError(
      "invalid-argument",
      "恢复草稿键无效。",
    );
  }
  return `${join(draftsDirectory(userDataPath), key)}.json`;
}

function keyFromFileName(fileName: string): string | null {
  const match = /^([0-9a-f]{64})\.json$/u.exec(fileName);
  return match?.[1] ?? null;
}

function queuedDraftOperation<TValue>(
  directory: string,
  operation: () => Promise<TValue>,
): Promise<TValue> {
  const previous = storageLocks.get(directory) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  storageLocks.set(
    directory,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // Directory fsync is unavailable on some platforms. Atomic rename still
    // protects readers from partial JSON.
  } finally {
    await handle?.close();
  }
}

async function writeDraftAtomically(
  target: string,
  draft: RecoveryDraft,
): Promise<void> {
  const temporaryPath = `${target}.${randomBytes(12).toString("hex")}.markdesk-tmp`;
  let handle: DraftHandle | null = null;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(draft, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, target);
    await syncDirectory(dirname(target));
  } finally {
    try {
      await handle?.close();
    } catch {
      // Preserve the original write error over secondary close failures.
    }
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function readDraftFile(
  target: string,
  expectedKey: string,
): Promise<RecoveryDraft | null> {
  let information;
  try {
    information = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (!information.isFile()) return null;

  try {
    const parsed: unknown = JSON.parse(await readFile(target, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    if (!isDraft(parsed) || parsed.key !== expectedKey) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function draftKeyForPath(path: string | null): string {
  return createHash("sha256")
    .update(path ?? ":untitled:", "utf8")
    .digest("hex");
}

export async function saveDraft(
  userDataPath: string,
  draft: RecoveryDraft,
): Promise<void> {
  const validated = validateDraft(draft);
  const target = draftTarget(userDataPath, validated.key);
  const directory = dirname(target);
  await queuedDraftOperation(directory, async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeDraftAtomically(target, validated);
  });
}

export async function listRecoveryDrafts(
  userDataPath: string,
): Promise<RecoveryDraftSummary[]> {
  const directory = draftsDirectory(userDataPath);
  return queuedDraftOperation(directory, async () => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const drafts: RecoveryDraft[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const key = keyFromFileName(entry.name);
      if (!key) continue;
      const draft = await readDraftFile(`${join(directory, key)}.json`, key);
      if (draft) drafts.push(draft);
    }
    return drafts
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(({ key, path, fileName, updatedAt }) => ({
        key,
        path,
        fileName,
        updatedAt,
      }));
  });
}

export async function readRecoveryDraft(
  userDataPath: string,
  key: string,
): Promise<RecoveryDraft | null> {
  // 非十六进制键（包括路径穿越形式）不指向任何草稿文件，直接返回 null。
  if (typeof key !== "string" || !keyPattern.test(key)) return null;
  const target = draftTarget(userDataPath, key);
  return queuedDraftOperation(dirname(target), () => readDraftFile(target, key));
}

export async function discardRecoveryDraft(
  userDataPath: string,
  key: string,
): Promise<void> {
  // 与读取相同：非法键是安全的无操作，不会删除任何文件。
  if (typeof key !== "string" || !keyPattern.test(key)) return;
  const target = draftTarget(userDataPath, key);
  await queuedDraftOperation(dirname(target), async () => {
    try {
      const information = await lstat(target);
      if (!information.isFile()) return;
      await unlink(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        return;
      }
      throw error;
    }
  });
}
