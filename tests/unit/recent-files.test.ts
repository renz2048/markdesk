import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearRecentFiles,
  loadRecentFiles,
  type RecentFileHandle,
  type RecentFileSystem,
  upsertRecentFile,
} from "../../src/electron/recent-files";

class FakeHandle implements RecentFileHandle {
  constructor(
    private readonly events: string[],
    private readonly onWrite: (data: string) => void,
    private readonly syncError?: Error,
  ) {}

  async writeFile(data: string): Promise<void> {
    this.events.push("write");
    this.onWrite(data);
  }

  async sync(): Promise<void> {
    this.events.push("sync");
    if (this.syncError) throw this.syncError;
  }

  async close(): Promise<void> {
    this.events.push("close");
  }
}

class FakeRecentFileSystem implements RecentFileSystem {
  readonly events: string[] = [];
  readonly opens: Array<{ path: string; mode: number }> = [];
  readonly renames: Array<{ from: string; to: string }> = [];
  readonly unlinks: string[] = [];
  private temporaryContent = new Map<string, string>();
  private handle?: FakeHandle;

  constructor(
    private storage: string,
    private readonly errors: {
      read?: NodeJS.ErrnoException;
      open?: NodeJS.ErrnoException;
      sync?: Error;
      rename?: Error;
    } = {},
  ) {}

  get value(): string {
    return this.storage;
  }

  async readFile(): Promise<string> {
    this.events.push("read");
    if (this.errors.read) throw this.errors.read;
    return this.storage;
  }

  async open(path: string, flags: "wx", mode: number): Promise<RecentFileHandle> {
    expect(flags).toBe("wx");
    this.events.push("open");
    this.opens.push({ path, mode });
    if (this.errors.open) throw this.errors.open;
    this.handle = new FakeHandle(
      this.events,
      (data) => this.captureTemporary(path, data),
      this.errors.sync,
    );
    return this.handle;
  }

  captureTemporary(path: string, data: string): void {
    this.temporaryContent.set(path, data);
  }

  async rename(from: string, to: string): Promise<void> {
    this.events.push("rename");
    if (this.errors.rename) throw this.errors.rename;
    this.renames.push({ from, to });
    this.storage = this.temporaryContent.get(from) ?? "";
  }

  async unlink(path: string): Promise<void> {
    this.events.push("unlink");
    this.unlinks.push(path);
  }
}

describe("recent files", () => {
  it("deduplicates, orders, and caps entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "markdesk-recent-"));
    const storage = join(dir, "recent.json");
    for (let i = 0; i < 12; i += 1) {
      await upsertRecentFile(storage, join(dir, `file-${i}.md`));
    }
    await upsertRecentFile(storage, join(dir, "file-11.md"));

    const files = await loadRecentFiles(storage);
    expect(files).toHaveLength(10);
    expect(files[0].name).toBe("file-11.md");
    expect(new Set(files.map((file) => file.path)).size).toBe(10);
  });

  it("recovers from malformed JSON by returning an empty list", async () => {
    const dir = await mkdtemp(join(tmpdir(), "markdesk-recent-"));
    const storage = join(dir, "recent.json");
    await writeFile(storage, "{bad", "utf8");

    await expect(loadRecentFiles(storage)).resolves.toEqual([]);
  });

  it("ignores malformed and duplicate persisted entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "markdesk-recent-"));
    const storage = join(dir, "recent.json");
    const valid = {
      path: "/tmp/valid.md",
      name: "valid.md",
      lastOpenedAt: 7,
    };
    await writeFile(
      storage,
      JSON.stringify([
        valid,
        valid,
        { path: "/tmp/missing-name.md", lastOpenedAt: 8 },
        { path: 3, name: "invalid.md", lastOpenedAt: 8 },
        {
          path: "/tmp/invalid-time.md",
          name: "invalid-time.md",
          lastOpenedAt: Number.POSITIVE_INFINITY,
        },
        null,
      ]),
      "utf8",
    );

    await expect(loadRecentFiles(storage)).resolves.toEqual([valid]);
  });

  it("persists JSON atomically and clears recent entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "markdesk-recent-"));
    const storage = join(dir, "recent.json");
    await upsertRecentFile(storage, join(dir, "notes.md"));

    const raw = await readFile(storage, "utf8");
    await expect(JSON.parse(raw)).toEqual([
      {
        path: join(dir, "notes.md"),
        name: "notes.md",
        lastOpenedAt: expect.any(Number),
      },
    ]);

    await clearRecentFiles(storage);
    await expect(loadRecentFiles(storage)).resolves.toEqual([]);
    await expect(readFile(storage, "utf8")).resolves.toBe("[]\n");
  });

  it("returns an empty list only for a missing recent-file store", async () => {
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });

    await expect(
      loadRecentFiles("/state/recent.json", {
        fileSystem: new FakeRecentFileSystem("[]", { read: missing }),
      }),
    ).resolves.toEqual([]);
    await expect(
      loadRecentFiles("/state/recent.json", {
        fileSystem: new FakeRecentFileSystem("[]", { read: denied }),
      }),
    ).rejects.toMatchObject({ code: "EACCES" });
  });

  it("uses exclusive mode and fsync-before-rename atomic ordering", async () => {
    const fileSystem = new FakeRecentFileSystem("[]");

    await upsertRecentFile("/state/recent.json", "/tmp/a.md", { fileSystem });

    expect(fileSystem.opens).toEqual([
      { path: expect.stringMatching(/\.markdesk-tmp$/u), mode: 0o600 },
    ]);
    expect(fileSystem.events).toEqual([
      "read",
      "open",
      "write",
      "sync",
      "close",
      "rename",
      "unlink",
    ]);
  });

  it("preserves the old list and removes temporary files on write failure", async () => {
    const oldJson = JSON.stringify([
      { path: "/tmp/old.md", name: "old.md", lastOpenedAt: 1 },
    ]);
    const openFailure = new FakeRecentFileSystem(oldJson, {
      open: Object.assign(new Error("exists"), { code: "EEXIST" }),
    });
    await expect(
      upsertRecentFile("/state/recent.json", "/tmp/new.md", {
        fileSystem: openFailure,
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(openFailure.value).toBe(oldJson);
    expect(openFailure.renames).toEqual([]);

    const syncFailure = new FakeRecentFileSystem(oldJson, {
      sync: new Error("fsync failed"),
    });
    await expect(
      upsertRecentFile("/state/recent.json", "/tmp/new.md", {
        fileSystem: syncFailure,
      }),
    ).rejects.toThrow("fsync failed");
    expect(syncFailure.value).toBe(oldJson);
    expect(syncFailure.renames).toEqual([]);
    expect(syncFailure.unlinks).toHaveLength(1);

    const renameFailure = new FakeRecentFileSystem(oldJson, {
      rename: new Error("rename failed"),
    });
    await expect(
      upsertRecentFile("/state/recent.json", "/tmp/new.md", {
        fileSystem: renameFailure,
      }),
    ).rejects.toThrow("rename failed");
    expect(renameFailure.value).toBe(oldJson);
    expect(renameFailure.unlinks).toHaveLength(1);
  });

  it("serializes concurrent upserts so both entries survive", async () => {
    const fileSystem = new FakeRecentFileSystem("[]");

    await Promise.all([
      upsertRecentFile("/state/recent.json", "/tmp/a.md", { fileSystem }),
      upsertRecentFile("/state/recent.json", "/tmp/b.md", { fileSystem }),
    ]);

    const files = JSON.parse(fileSystem.value) as Array<{ path: string }>;
    expect(new Set(files.map((file) => file.path))).toEqual(
      new Set(["/tmp/a.md", "/tmp/b.md"]),
    );
  });

  it("validates absolute Markdown paths and persisted filename consistency", async () => {
    const valid = {
      path: "/tmp/valid.md",
      name: "valid.md",
      lastOpenedAt: 1,
    };
    const fileSystem = new FakeRecentFileSystem(JSON.stringify([
      valid,
      { path: "relative.md", name: "relative.md", lastOpenedAt: 2 },
      { path: "/tmp/text.txt", name: "text.txt", lastOpenedAt: 3 },
      { path: "/tmp/wrong.md", name: "other.md", lastOpenedAt: 4 },
    ]));

    await expect(
      loadRecentFiles("/state/recent.json", { fileSystem }),
    ).resolves.toEqual([valid]);
    await expect(
      upsertRecentFile("/state/recent.json", "relative.md", { fileSystem }),
    ).rejects.toMatchObject({ code: "invalid-path" });
  });
});
