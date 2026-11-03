import { randomBytes } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { localImageExtensions } from "../shared/types";

/** 持久化授权的图片路径上限，超出时按加入顺序淘汰最早的授权。 */
export const IMAGE_GRANTS_LIMIT = 200;

/**
 * 可授权的本地图片路径：绝对路径 + 图片扩展名（与资源协议白名单一致）。
 * 渲染端传来的路径在主进程逐条校验，杜绝任意路径写入授权表。
 */
export function isGrantableImagePath(path: string): boolean {
  if (path.length === 0 || path.length > 1024) return false;
  if (/[\0-\x1f\u007f]/u.test(path)) return false;
  if (!posix.isAbsolute(path) && !win32.isAbsolute(path)) return false;
  return (
    localImageExtensions.has(posix.extname(path).slice(1).toLowerCase()) ||
    localImageExtensions.has(win32.extname(path).slice(1).toLowerCase())
  );
}

/**
 * 读取持久化的图片授权表（JSON 字符串数组）。文件不存在或内容损坏
 * 时返回空表：授权只是显示便利，宁可重问一次也不放宽校验。
 */
export async function loadImageGrants(
  storagePath: string,
): Promise<string[]> {
  let serialized: string;
  try {
    serialized = await readFile(storagePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const paths: string[] = [];
    for (const value of parsed) {
      if (
        typeof value !== "string" ||
        !isGrantableImagePath(value) ||
        seen.has(value)
      ) {
        continue;
      }
      seen.add(value);
      paths.push(value);
    }
    return paths.slice(0, IMAGE_GRANTS_LIMIT);
  } catch {
    return [];
  }
}

// 单文件顺序写：与最近文件存储一致，避免并发写相互覆盖。
let writeQueue: Promise<unknown> = Promise.resolve();

/** 原子写入授权表（临时文件 + rename）。 */
export function saveImageGrants(
  storagePath: string,
  paths: string[],
): Promise<void> {
  const operation = async (): Promise<void> => {
    const temporaryPath = `${storagePath}.${randomBytes(12).toString("hex")}.markdesk-tmp`;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(paths, null, 2)}\n`);
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporaryPath, storagePath);
    } finally {
      try {
        await handle?.close();
      } catch {
        // 二次关闭失败不掩盖原始错误。
      }
      await unlink(temporaryPath).catch(() => undefined);
    }
  };
  const result = writeQueue.then(operation, operation);
  writeQueue = result.catch(() => undefined);
  return result;
}
