import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearRecentFiles,
  loadRecentFiles,
  upsertRecentFile,
} from "../../src/electron/recent-files";

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
});
