import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_MARKDOWN_BYTES,
  MAX_MARKDOWN_PATH_LENGTH,
  detectNewline,
  fingerprint,
  isMarkdownPath,
  normalizeNewline,
  readMarkdownFile,
  writeMarkdownFile,
} from "../../src/electron/file-service";

interface MemoryStats {
  mtimeMs: number;
  size: number;
  mode: number;
  dev?: number;
  ino?: number;
}

interface MemoryEntry {
  bytes: Buffer;
  stats: MemoryStats;
  symlinkTo?: string;
}

class MemoryFileHandle {
  constructor(
    private readonly entry: MemoryEntry,
    private readonly fileSystem: MemoryFileSystem,
  ) {}

  async readFile(): Promise<Buffer> {
    this.fileSystem.handleReadCalls.push(this.entry);
    if (this.fileSystem.mutateDuringRead) {
      this.fileSystem.mutateDuringRead(this.entry);
    }
    return Buffer.from(this.entry.bytes);
  }

  async writeFile(data: string | Buffer): Promise<void> {
    this.fileSystem.handleWriteCalls.push({ data });
    if (this.fileSystem.failHandleWrite) {
      throw new Error("device out of space");
    }
    this.entry.bytes = Buffer.isBuffer(data)
      ? Buffer.from(data)
      : Buffer.from(data, "utf8");
    this.entry.stats.size = this.entry.bytes.byteLength;
    this.entry.stats.mtimeMs = 2;
  }

  async chmod(mode: number): Promise<void> {
    this.entry.stats.mode = mode;
  }

  async sync(): Promise<void> {
    this.fileSystem.handleSyncCalls.push(this.entry);
  }

  async stat(): Promise<MemoryStats> {
    return { ...this.entry.stats };
  }

  async close(): Promise<void> {
    this.fileSystem.handleCloseCalls.push(this.entry);
  }
}

class MemoryFileSystem {
  entries = new Map<string, MemoryEntry>();
  openCalls: Array<{ path: string; flags: string; mode?: number }> = [];
  handleReadCalls: MemoryEntry[] = [];
  handleWriteCalls: Array<{ data: string | Buffer }> = [];
  handleSyncCalls: MemoryEntry[] = [];
  handleCloseCalls: MemoryEntry[] = [];
  renameCalls: Array<{ from: string; to: string }> = [];
  unlinkCalls: string[] = [];
  failHandleWrite = false;
  failRename = false;
  mutateDuringRead: ((entry: MemoryEntry) => void) | null = null;

  private makeEntry(content: string | Buffer, mode = 0o644): MemoryEntry {
    const bytes = Buffer.isBuffer(content)
      ? Buffer.from(content)
      : Buffer.from(content, "utf8");
    return {
      bytes,
      stats: {
        mtimeMs: 1,
        size: bytes.byteLength,
        mode,
        dev: 1,
        ino: 1,
      },
    };
  }

  async open(
    path: string,
    flags: "r" | "wx",
    mode = 0o600,
  ): Promise<MemoryFileHandle> {
    this.openCalls.push({ path, flags, mode });
    const existing = this.entries.get(path);

    if (flags === "wx") {
      if (existing) {
        const error = new Error("EEXIST") as NodeJS.ErrnoException;
        error.code = "EEXIST";
        throw error;
      }
      const entry: MemoryEntry = {
        bytes: Buffer.alloc(0),
        stats: { mtimeMs: 1, size: 0, mode, dev: 2, ino: 2 },
      };
      this.entries.set(path, entry);
      return new MemoryFileHandle(entry, this);
    }

    if (!existing) {
      const isDirectoryForKnownFile = [...this.entries.keys()].some(
        (knownPath) => dirname(knownPath) === path,
      );
      if (isDirectoryForKnownFile) {
        const entry = this.makeEntry("", 0o755);
        this.entries.set(path, entry);
        return new MemoryFileHandle(entry, this);
      }
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    let current = existing;
    let hops = 0;
    while (current.symlinkTo) {
      hops += 1;
      if (hops > 16) throw new Error("ELOOP");
      const target = this.entries.get(current.symlinkTo);
      if (!target) {
        const error = new Error("ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      current = target;
    }
    return new MemoryFileHandle(current, this);
  }

  async stat(path: string): Promise<MemoryStats> {
    const entry = this.entries.get(path);
    if (!entry) {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    let current = entry;
    let hops = 0;
    while (current.symlinkTo) {
      hops += 1;
      if (hops > 16) throw new Error("ELOOP");
      const target = this.entries.get(current.symlinkTo);
      if (!target) {
        const error = new Error("ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      current = target;
    }
    return { ...current.stats };
  }

  async rename(from: string, to: string): Promise<void> {
    this.renameCalls.push({ from, to });
    if (this.failRename) throw new Error("rename unavailable");
    const source = this.entries.get(from);
    if (!source) {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    this.entries.set(to, source);
    this.entries.delete(from);
  }

  async unlink(path: string): Promise<void> {
    this.unlinkCalls.push(path);
    if (!this.entries.has(path)) return;
    this.entries.delete(path);
  }

  addFile(path: string, content: string | Buffer, mode = 0o644) {
    this.entries.set(path, this.makeEntry(content, mode));
    return this;
  }

  addSymlink(path: string, target: string) {
    this.entries.set(path, {
      bytes: Buffer.alloc(0),
      stats: { mtimeMs: 1, size: 0, mode: 0o777, dev: 1, ino: 1 },
      symlinkTo: target,
    });
    return this;
  }
}

function text(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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

  it("rejects all C0 and DEL controls and caps path length", () => {
    for (const character of ["\0", "\u0001", "\r", "\u001f", "\u007f"]) {
      expect(isMarkdownPath(`/tmp/a${character}b.md`)).toBe(false);
    }
    expect(
      isMarkdownPath(`${"/tmp".padEnd(MAX_MARKDOWN_PATH_LENGTH, "a")}.md`),
    ).toBe(false);
  });
});

describe("Markdown decoding", () => {
  it("strips one UTF-8 BOM and reports the newline preference", async () => {
    const fileSystem = new MemoryFileSystem().addFile(
      "/tmp/doc.md",
      "\uFEFF# Title\r\nBody\r\n",
    );
    fileSystem.entries.get("/tmp/doc.md")!.stats.mtimeMs = 12.5;

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
    const fileSystem = new MemoryFileSystem().addFile(
      "/tmp/bad.md",
      Buffer.from([0x23, 0xff]),
    );

    await expect(
      readMarkdownFile("/tmp/bad.md", fileSystem),
    ).rejects.toMatchObject({ code: "invalid-encoding" });
  });

  it("uses one opened descriptor and rejects metadata changed during read", async () => {
    const fileSystem = new MemoryFileSystem().addFile("/tmp/race.md", "# One\n");
    fileSystem.mutateDuringRead = (entry) => {
      entry.bytes = text("# External\n");
      entry.stats.size = entry.bytes.byteLength;
      entry.stats.mtimeMs = 9;
      entry.stats.ino = 99;
    };

    await expect(
      readMarkdownFile("/tmp/race.md", fileSystem),
    ).rejects.toMatchObject({ code: "file-changed" });
  });
});

describe("file size limits", () => {
  it("rejects a file over 10 MiB before reading its contents", async () => {
    const fileSystem = new MemoryFileSystem().addFile(
      "/tmp/large.md",
      Buffer.alloc(MAX_MARKDOWN_BYTES + 1, 0x61),
    );

    await expect(
      readMarkdownFile("/tmp/large.md", fileSystem),
    ).rejects.toMatchObject({ code: "file-too-large" });
    expect(fileSystem.handleReadCalls).toEqual([]);
  });

  it("rejects content that would write over 10 MiB", async () => {
    const fileSystem = new MemoryFileSystem().addFile("/tmp/new.md", "");

    await expect(
      writeMarkdownFile(
        "/tmp/new.md",
        "a".repeat(MAX_MARKDOWN_BYTES + 1),
        undefined,
        fileSystem,
      ),
    ).rejects.toMatchObject({ code: "file-too-large" });
    expect(fileSystem.openCalls.filter((call) => call.flags === "wx")).toEqual([]);
  });

  it("rejects unpaired JavaScript surrogates before write", async () => {
    const fileSystem = new MemoryFileSystem().addFile("/tmp/surrogate.md", "");

    await expect(
      writeMarkdownFile("/tmp/surrogate.md", "\uD800", undefined, fileSystem),
    ).rejects.toMatchObject({ code: "invalid-encoding" });
    expect(fileSystem.openCalls.filter((call) => call.flags === "wx")).toEqual([]);
  });
});

describe("fingerprints and collision detection", () => {
  it("supports the public content override and filesystem injection", async () => {
    const fileSystem = new MemoryFileSystem().addFile(
      "/tmp/fingerprint.md",
      "# Disk\r\n",
      0o600,
    );
    fileSystem.entries.get("/tmp/fingerprint.md")!.stats.mtimeMs = 44;

    await expect(
      fingerprint("/tmp/fingerprint.md", "# Supplied\n", fileSystem),
    ).resolves.toEqual({
      hash: sha256("# Supplied\n"),
      mtimeMs: 44,
      size: Buffer.byteLength("# Supplied\n", "utf8"),
    });
  });

  it("creates a SHA-256 fingerprint from actual canonical text by default", async () => {
    const fileSystem = new MemoryFileSystem().addFile(
      "/tmp/fingerprint.md",
      "\uFEFF# Same\n",
    );
    fileSystem.entries.get("/tmp/fingerprint.md")!.stats.mtimeMs = 44;

    await expect(
      fingerprint("/tmp/fingerprint.md", fileSystem),
    ).resolves.toEqual({
      hash: sha256("# Same\n"),
      mtimeMs: 44,
      size: Buffer.byteLength("# Same\n", "utf8"),
    });
  });

  it("rejects a save when disk content changed after open", async () => {
    const fileSystem = new MemoryFileSystem().addFile(
      "/tmp/changed.md",
      "# Opened\n",
    );
    const expected = await fingerprint("/tmp/changed.md", fileSystem);
    const entry = fileSystem.entries.get("/tmp/changed.md")!;
    entry.bytes = text("# Externally changed\n");
    entry.stats = {
      ...entry.stats,
      size: Buffer.byteLength("# Externally changed\n"),
      mtimeMs: 11,
    };

    await expect(
      writeMarkdownFile("/tmp/changed.md", "# Local\n", expected, fileSystem),
    ).rejects.toMatchObject({ code: "file-changed" });
    expect(fileSystem.openCalls.filter((call) => call.flags === "wx")).toEqual([]);
    expect(fileSystem.renameCalls).toEqual([]);
    expect(entry.bytes.toString("utf8")).toBe("# Externally changed\n");
  });

  it("treats an I/O failure while checking expected state as read failure", async () => {
    const fileSystem = new MemoryFileSystem();
    const expected = { hash: "a".repeat(64), mtimeMs: 1, size: 1 };

    await expect(
      writeMarkdownFile("/tmp/missing.md", "# Local\n", expected, fileSystem),
    ).rejects.toMatchObject({ code: "read-failed" });
    expect(fileSystem.openCalls.filter((call) => call.flags === "wx")).toEqual([]);
  });
});

describe("atomic Markdown writes", () => {
  it("creates an exclusive temp, preserves mode, syncs, and renames", async () => {
    const fileSystem = new MemoryFileSystem().addFile(
      "/tmp/atomic.md",
      "# Old\n",
      0o640,
    );
    const expected = await fingerprint("/tmp/atomic.md", fileSystem);
    const content = normalizeNewline("# New\r\nSaved\n", "crlf");

    const result = await writeMarkdownFile(
      "/tmp/atomic.md",
      content,
      expected,
      fileSystem,
    );

    const tempPath = "/tmp/atomic.md.markdesk-tmp";
    // 前两行分别来自测试自身的 fingerprint() 读取与 writeMarkdownFile
    // 对既有内容的冲突校验读取；测试替身的 open() 总是记录默认 mode 0o600。
    // Windows 不支持以 "r" 打开目录，syncDirectory 在 win32 上直接返回，
    // 因此目录打开及其 fsync 只出现在 POSIX 平台。
    const expectedOpenCalls: Array<{ path: string; flags: string; mode: number }> = [
      { path: "/tmp/atomic.md", flags: "r", mode: 0o600 },
      { path: "/tmp/atomic.md", flags: "r", mode: 0o600 },
      { path: tempPath, flags: "wx", mode: 0o600 },
    ];
    let minimumSyncCount = 1;
    if (process.platform !== "win32") {
      expectedOpenCalls.push({
        path: dirname("/tmp/atomic.md"),
        flags: "r",
        mode: 0o600,
      });
      minimumSyncCount += 1;
    }
    expect(fileSystem.openCalls).toEqual(expectedOpenCalls);
    expect(fileSystem.handleSyncCalls.length).toBeGreaterThanOrEqual(minimumSyncCount);
    expect(fileSystem.renameCalls).toEqual([
      { from: tempPath, to: "/tmp/atomic.md" },
    ]);
    expect(
      fileSystem.entries.get("/tmp/atomic.md")!.bytes.toString(),
    ).toBe(content);
    expect(fileSystem.entries.get("/tmp/atomic.md")!.stats.mode).toBe(0o640);
    expect(fileSystem.entries.has(tempPath)).toBe(false);
    expect(result).toEqual({
      path: "/tmp/atomic.md",
      hash: sha256(content),
      mtimeMs: 2,
      size: Buffer.byteLength(content, "utf8"),
    });
  });

  it("creates new targets with private mode 0600", async () => {
    const fileSystem = new MemoryFileSystem();

    await writeMarkdownFile("/tmp/new.md", "# New\n", undefined, fileSystem);

    expect(fileSystem.entries.get("/tmp/new.md")!.stats.mode).toBe(0o600);
  });

  it("does not overwrite or unlink a pre-existing regular temporary file", async () => {
    const fileSystem = new MemoryFileSystem().addFile("/tmp/a.md", "# Old\n");
    fileSystem.addFile("/tmp/a.md.markdesk-tmp", "# Not ours\n", 0o644);

    await expect(
      writeMarkdownFile("/tmp/a.md", "# New\n", undefined, fileSystem),
    ).rejects.toMatchObject({ code: "write-failed" });

    expect(fileSystem.unlinkCalls).toEqual([]);
    expect(
      fileSystem.entries.get("/tmp/a.md.markdesk-tmp")!.bytes.toString(),
    ).toBe("# Not ours\n");
  });

  it("does not follow or unlink a dangling temporary symlink", async () => {
    const fileSystem = new MemoryFileSystem().addFile("/tmp/a.md", "# Old\n");
    fileSystem.addSymlink("/tmp/a.md.markdesk-tmp", "/tmp/missing-target");

    await expect(
      writeMarkdownFile("/tmp/a.md", "# New\n", undefined, fileSystem),
    ).rejects.toMatchObject({ code: "write-failed" });

    expect(fileSystem.unlinkCalls).toEqual([]);
    expect(fileSystem.entries.has("/tmp/a.md.markdesk-tmp")).toBe(true);
    expect(fileSystem.entries.get("/tmp/a.md")!.bytes.toString()).toBe("# Old\n");
  });

  it("does not follow or unlink a temporary symlink to another file", async () => {
    const fileSystem = new MemoryFileSystem()
      .addFile("/tmp/a.md", "# Old\n")
      .addFile("/tmp/victim.md", "# Victim\n");
    fileSystem.addSymlink("/tmp/a.md.markdesk-tmp", "/tmp/victim.md");

    await expect(
      writeMarkdownFile("/tmp/a.md", "# New\n", undefined, fileSystem),
    ).rejects.toMatchObject({ code: "write-failed" });

    expect(fileSystem.unlinkCalls).toEqual([]);
    expect(fileSystem.entries.get("/tmp/victim.md")!.bytes.toString()).toBe(
      "# Victim\n",
    );
  });

  it("cleans an exclusively created temporary after handle write failure", async () => {
    const fileSystem = new MemoryFileSystem().addFile("/tmp/a.md", "# Old\n");
    fileSystem.failHandleWrite = true;

    await expect(
      writeMarkdownFile("/tmp/a.md", "# New\n", undefined, fileSystem),
    ).rejects.toMatchObject({ code: "write-failed" });
    expect(fileSystem.unlinkCalls).toEqual(["/tmp/a.md.markdesk-tmp"]);
    expect(fileSystem.entries.get("/tmp/a.md")!.bytes.toString()).toBe("# Old\n");
  });

  it("cleans an exclusively created temporary after rename failure", async () => {
    const fileSystem = new MemoryFileSystem().addFile("/tmp/a.md", "# Old\n");
    fileSystem.failRename = true;

    await expect(
      writeMarkdownFile("/tmp/a.md", "# New\n", undefined, fileSystem),
    ).rejects.toMatchObject({ code: "write-failed" });
    expect(fileSystem.unlinkCalls).toEqual(["/tmp/a.md.markdesk-tmp"]);
    expect(fileSystem.entries.get("/tmp/a.md")!.bytes.toString()).toBe("# Old\n");
  });
});
