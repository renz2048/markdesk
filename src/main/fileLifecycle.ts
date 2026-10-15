export type FileActionFallbackCode = "parse" | "serialize" | "unexpected";

export interface FileActionError {
  code: string;
  message: string;
}

const messages: Record<string, string> = {
  "file-changed": "文件已被其他程序修改，请重新打开后再保存。",
  "file-too-large": "文件或内容超过 10 MiB 限制。",
  "invalid-path": "Markdown 文件路径未获授权或无效。",
  "invalid-encoding": "文件不是有效的 UTF-8 Markdown。",
  parse: "Markdown 解析失败，无法打开文件。",
  serialize: "Markdown 序列化失败，无法保存文件。",
};

export function toFileActionError(
  error: unknown,
  fallback: FileActionFallbackCode = "unexpected",
): FileActionError {
  const candidate =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  const code = candidate || fallback;

  return {
    code,
    message: messages[code] ?? "文件操作失败，请稍后重试。",
  };
}

export class FileLifecycleController {
  private operationInProgress = false;
  private revision = 0;

  get busy(): boolean {
    return this.operationInProgress;
  }

  get currentRevision(): number {
    return this.revision;
  }

  beginOperation(): number | null {
    if (this.operationInProgress) return null;
    this.operationInProgress = true;
    this.revision += 1;
    return this.revision;
  }

  endOperation(): void {
    this.operationInProgress = false;
  }

  markEdited(): void {
    this.revision += 1;
  }

  isCurrent(revision: number): boolean {
    return revision === this.revision;
  }
}
