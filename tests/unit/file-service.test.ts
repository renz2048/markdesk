import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_MARKDOWN_BYTES,
  detectNewline,
  fingerprint,
  isMarkdownPath,
  normalizeNewline,
  readMarkdownFile,
  writeMarkdownFile,
} from "../../src/electron/file-service";

interface MemoryStats {
  mtimeMs: number;
}

class MemoryFileSystem {
  files = new Map<string, Buffer>();
  stats = new Map<string, MemoryStats>();
  readFileCalls: string[] = [];
  writeFileCalls: Array<{ path: string; data: Buffer | string }> = [];
  writeFileOptions: Array<{ mode?: number } | undefined> = [];
  renameCalls: Array<{ from: string; to: string }> = [];
  unlinkCalls: string[] = [];
  failWrite = false;
  failRename = false;

  async readFile(path: string): Promise<Buffer> {
    this.readFileCalls.push(path);
    const file = this.files.get(path);
    if (!file) {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return Buffer.from(file);
  }

  async writeFile(
    path: string,
    data: Buffer | string,
    options?: { mode?: number },
  ): Promise<void> {
    this.writeFileCalls.push({ path, data });
    this.writeFileOptions.push(options);
    if (this.failWrite) throw new Error("disk unavailable");
    this.files.set(path, Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8"));
    this.stats.set(path, { mtimeMs: 1 });
  }

  async rename(from: string, to: string): Promise<void> {
    this.renameCalls.push({ from, to });
    if (this.failRename) throw new Error("rename unavailable");
    const source = this.files.get(from);
    if (!source) {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    const sourceStats = this.stats.get(from);
    this.files.set(to, Buffer.from(source));
    this.files.delete(from);
    this.stats.set(to, { mtimeMs: sourceStats?.mtimeMs ?? 1 });
    this.stats.delete(from);
  }

  async stat(path: string): Promise<{ mtimeMs: number; size: number }> {
    const file = this.files.get(path);
    if (!file) {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return {
      mtimeMs: this.stats.get(path)?.mtimeMs ?? 1,
      size: file.byteLength,
    };
  }

  async unlink(path: string): Promise<void> {
    this.unlinkCalls.push(path);
    if (!this.files.has(path)) return;
    this.files.delete(path);
    this.stats.delete(path);
  }
}

function text(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function addFile(
  fileSystem: MemoryFileSystem,
  path: string,
  content: string,
  mtimeMs = 1,
): Promise<void> {
  fileSystem.files.set(path, text(content));
  fileSystem.stats.set(path, { mtimeMs });
}

describe("file path validation", () => {
  it.each(["/tmp/a.md", "/tmp/a.markdown", "C:\\Docs\\a.md"])(
    "accepts Markdown path %s",
    (value) => expect(isMarkdownPath(value)).toBe(true),
  );

  it.each([null, 123, "", "/tmp/a.txt", "/tmp/exe.md.exe"])(
    "rejects invalid path %j",
    (value) => expect(isMarkdownPath(value)).toBe(false),
  );

  it("rejects paths containing control characters", () => {
    expect(isMarkdownPath("/tmp/a\nb.md")).toBe(false);
    expect(isMarkdownPath("/tmp/a\0b.md")).toBe(false);
  });
});

describe("Markdown decoding", () => {
  it("strips one UTF-8 BOM and reports the newline preference", async () => {
    const fileSystem = new MemoryFileSystem();
    await addFile(fileSystem, "/tmp/doc.md", "\uFEFF# Title\r\nBody\r\n", 12.5);

    const result = await readMarkdownFile("/tmp/doc.md", fileSystem);

    expect(result).toEqual({
      path: "/tmp/doc.md",
      content: "# Title\r\nBody\r\n",
      hash: sha256("# Title\r\nBody\r\n"),
      mtimeMs: 12.5,
      size: Buffer.byteLength("# Title\r\nBody\r\n", "utf8"),
      newline: "crlf",
    });
  });

  it("reports LF and normalizes mixed line endings", () => {
    expect(detectNewline("# One\n# Two\n")).toBe("lf");
    expect(normalizeNewline("# One\r\nTwo\rThree\n", "crlf")).toBe(
      "# One\r\nTwo\r\nThree\r\n",
    );
    expect(normalizeNewline("# One\r\nTwo\rThree\n", "lf")).toBe(
      "# One\nTwo\nThree\n",
    );
  });

  it("rejects invalid UTF-8 with a typed error", async () => {
    const fileSystem = new MemoryFileSystem();
    fileSystem.files.set("/tmp/bad.md", Buffer.from([0x23, 0xff]));
    fileSystem.stats.set("/tmp/bad.md", { mtimeMs: 1 });

    await expect(readMarkdownFile("/tmp/bad.md", fileSystem)).rejects.toMatchObject({
      code: "invalid-encoding",
    });
  });
});

describe("file size limits", () => {
  it("rejects a file over 10 MiB before reading its contents", async () => {
    const fileSystem = new MemoryFileSystem();
    fileSystem.stats.set("/tmp/large.md", { mtimeMs: 1 });
    fileSystem.files.set(
      "/tmp/large.md",
      Buffer.alloc(MAX_MARKDOWN_BYTES + 1, 0x61),
    );

    await expect(readMarkdownFile("/tmp/large.md", fileSystem)).rejects.toMatchObject(
      {
        code: "file-too-large",
      },
    );
    expect(fileSystem.readFileCalls).toEqual([]);
  });

  it("rejects content that would write over 10 MiB", async () => {
    const fileSystem = new MemoryFileSystem();
    await addFile(fileSystem, "/tmp/new.md", "");

    await expect(
      writeMarkdownFile(
        "/tmp/new.md",
        "a".repeat(MAX_MARKDOWN_BYTES + 1),
        undefined,
        fileSystem,
      ),
    ).rejects.toMatchObject({ code: "file-too-large" });
    expect(fileSystem.writeFileCalls).toEqual([]);
  });
});

describe("fingerprints and collision detection", () => {
  it("creates a SHA-256 fingerprint from canonical text content", async () => {
    const fileSystem = new MemoryFileSystem();
    await addFile(fileSystem, "/tmp/fingerprint.md", "# Same\n", 44);

    await expect(fingerprint("/tmp/fingerprint.md", fileSystem)).resolves.toEqual({
      hash: sha256("# Same\n"),
      mtimeMs: 44,
      size: Buffer.byteLength("# Same\n", "utf8"),
    });
  });

  it("rejects a save when disk content changed after open", async () => {
    const fileSystem = new MemoryFileSystem();
    const path = "/tmp/changed.md";
    await addFile(fileSystem, path, "# Opened\n", 10);
    const expected = await fingerprint(path, fileSystem);
    await addFile(fileSystem, path, "# Externally changed\n", 11);

    await expect(
      writeMarkdownFile(path, "# Local\n", expected, fileSystem),
    ).rejects.toMatchObject({ code: "file-changed" });
    expect(fileSystem.writeFileCalls).toEqual([]);
    expect(fileSystem.renameCalls).toEqual([]);
    expect(fileSystem.files.get(path)?.toString("utf8")).toBe(
      "# Externally changed\n",
    );
  });

  it("rejects a save when only the expected mtime changed", async () => {
    const fileSystem = new MemoryFileSystem();
    const path = "/tmp/touched.md";
    await addFile(fileSystem, path, "# Same\n", 10);
    const expected = await fingerprint(path, fileSystem);
    fileSystem.stats.set(path, { mtimeMs: 11 });

    await expect(
      writeMarkdownFile(path, "# Local\n", expected, fileSystem),
    ).rejects.toMatchObject({ code: "file-changed" });
    expect(fileSystem.files.get(path)?.toString("utf8")).toBe("# Same\n");
  });

  it("rejects malformed expected fingerprints before touching the disk", async () => {
    const fileSystem = new MemoryFileSystem();
    await addFile(fileSystem, "/tmp/guard.md", "# Guard\n");

    await expect(
      writeMarkdownFile(
        "/tmp/guard.md",
        "# Local\n",
        { hash: "nope", mtimeMs: 1, size: 1 },
        fileSystem,
      ),
    ).rejects.toMatchObject({ code: "invalid-fingerprint" });
    expect(fileSystem.writeFileCalls).toEqual([]);
    expect(fileSystem.renameCalls).toEqual([]);
  });
});

describe("atomic Markdown writes", () => {
  it("writes a private temporary file and renames it over the target", async () => {
    const fileSystem = new MemoryFileSystem();
    const path = "/tmp/atomic.md";
    const expected = {
      hash: sha256("# Old\n"),
      mtimeMs: 5,
      size: Buffer.byteLength("# Old\n", "utf8"),
    };
    await addFile(fileSystem, path, "# Old\n", 5);
    const content = normalizeNewline("# New\r\nSaved\n", "crlf");

    const result = await writeMarkdownFile(path, content, expected, fileSystem);

    expect(fileSystem.writeFileCalls).toEqual([
      { path: `${path}.markdesk-tmp`, data: content },
    ]);
    expect(fileSystem.writeFileOptions).toEqual([{ mode: 0o600 }]);
    expect(fileSystem.renameCalls).toEqual([
      { from: `${path}.markdesk-tmp`, to: path },
    ]);
    expect(fileSystem.files.get(path)?.toString("utf8")).toBe(content);
    expect(fileSystem.files.has(`${path}.markdesk-tmp`)).toBe(false);
    expect(result).toEqual({
      path,
      hash: sha256(content),
      mtimeMs: 1,
      size: Buffer.byteLength(content, "utf8"),
    });
  });

  it("removes the temporary file when writing fails", async () => {
    const fileSystem = new MemoryFileSystem();
    await addFile(fileSystem, "/tmp/write-failure.md", "# Old\n");
    fileSystem.failWrite = true;

    await expect(
      writeMarkdownFile("/tmp/write-failure.md", "# New\n", undefined, fileSystem),
    ).rejects.toMatchObject({ code: "write-failed" });
    expect(fileSystem.unlinkCalls).toEqual([
      "/tmp/write-failure.md.markdesk-tmp",
    ]);
  });

  it("removes the temporary file when rename fails and keeps the target", async () => {
    const fileSystem = new MemoryFileSystem();
    const path = "/tmp/rename-failure.md";
    await addFile(fileSystem, path, "# Old\n");
    fileSystem.failRename = true;

    await expect(
      writeMarkdownFile(path, "# New\n", undefined, fileSystem),
    ).rejects.toMatchObject({ code: "write-failed" });
    expect(fileSystem.unlinkCalls).toEqual([`${path}.markdesk-tmp`]);
    expect(fileSystem.files.get(path)?.toString("utf8")).toBe("# Old\n");
  });
});
