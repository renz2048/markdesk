import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discardRecoveryDraft,
  draftKeyForPath,
  listRecoveryDrafts,
  readRecoveryDraft,
  saveDraft,
  type RecoveryDraft,
} from "../../src/electron/drafts";

function draft(overrides: Partial<RecoveryDraft> = {}): RecoveryDraft {
  const path = overrides.path ?? "/tmp/note.md";
  return {
    key: draftKeyForPath(path),
    path,
    fileName: "note.md",
    markdown: "# Draft",
    mode: "wysiwyg",
    cursor: 2,
    scrollTop: 20,
    updatedAt: 1760000000000,
    ...overrides,
  };
}

describe("recovery draft keys", () => {
  it("uses a stable lowercase hexadecimal key for a file path", () => {
    const key = draftKeyForPath("/tmp/note.md");

    expect(key).toBe(draftKeyForPath("/tmp/note.md"));
    expect(key).toMatch(/^[0-9a-f]{64}$/u);
    expect(key).not.toBe(draftKeyForPath("/tmp/other.md"));
    expect(draftKeyForPath(null)).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("recovery drafts", () => {
  it("round-trips a draft at its keyed JSON path without temporary leftovers", async () => {
    const userData = await mkdtemp(join(tmpdir(), "markdesk-drafts-"));
    const value = draft();

    await saveDraft(userData, value);

    const files = await readdir(join(userData, "drafts"));
    expect(files).toEqual([`${value.key}.json`]);
    await expect(readRecoveryDraft(userData, value.key)).resolves.toEqual(value);
    await expect(listRecoveryDrafts(userData)).resolves.toEqual([{
      key: value.key,
      path: value.path,
      fileName: value.fileName,
      updatedAt: value.updatedAt,
    }]);
  });

  it("overwrites the same key atomically and lists summaries newest first", async () => {
    const userData = await mkdtemp(join(tmpdir(), "markdesk-drafts-"));
    const older = draft({ updatedAt: 1000 });
    const newer = draft({
      path: "/tmp/newer.md",
      fileName: "newer.md",
      markdown: "# Newer",
      updatedAt: 2000,
    });
    const replacement = draft({ markdown: "# Replaced", updatedAt: 3000 });

    await saveDraft(userData, older);
    await saveDraft(userData, newer);
    await saveDraft(userData, replacement);

    const summaries = await listRecoveryDrafts(userData);
    // updatedAt 最大（3000，覆盖后的 note.md 草稿）排在最前。
    expect(summaries.map((entry) => entry.path)).toEqual([
      "/tmp/note.md",
      "/tmp/newer.md",
    ]);
    await expect(readRecoveryDraft(userData, replacement.key)).resolves.toMatchObject({
      markdown: "# Replaced",
      updatedAt: 3000,
    });
    expect((await readdir(join(userData, "drafts"))).filter((name) =>
      name.includes("tmp")
    )).toEqual([]);
  });

  it("rejects malformed and semantically invalid drafts from reads and summaries", async () => {
    const userData = await mkdtemp(join(tmpdir(), "markdesk-drafts-"));
    const draftsDirectory = join(userData, "drafts");
    const valid = draft({
      path: "/tmp/valid.md",
      fileName: "valid.md",
      updatedAt: 20,
    });
    await saveDraft(userData, valid);

    const invalidKey = draftKeyForPath("/tmp/invalid.md");
    await writeFile(join(draftsDirectory, `${invalidKey}.json`), "{bad");
    await writeFile(
      join(draftsDirectory, `${draftKeyForPath("/tmp/mismatch.md")}.json`),
      JSON.stringify(draft({ path: "/tmp/other.md", updatedAt: 30 })),
    );
    await writeFile(
      join(draftsDirectory, `${draftKeyForPath("/tmp/extra.md")}.json`),
      JSON.stringify({ ...draft({ path: "/tmp/extra.md" }), extra: true }),
    );
    await writeFile(
      join(draftsDirectory, `${draftKeyForPath("/tmp/time.md")}.json`),
      `{"key":"${draftKeyForPath("/tmp/time.md")}","path":"/tmp/time.md","fileName":"time.md","markdown":"","mode":"read","cursor":0,"scrollTop":0,"updatedAt":1e309}`,
    );
    await writeFile(
      join(draftsDirectory, `${draftKeyForPath("/tmp/cursor.md")}.json`),
      JSON.stringify(draft({ path: "/tmp/cursor.md", cursor: -1 })),
    );
    await writeFile(join(draftsDirectory, "not-a-draft.json"), "{}");

    await expect(listRecoveryDrafts(userData)).resolves.toEqual([{
      key: valid.key,
      path: valid.path,
      fileName: valid.fileName,
      updatedAt: valid.updatedAt,
    }]);
    for (const key of [
      invalidKey,
      draftKeyForPath("/tmp/mismatch.md"),
      draftKeyForPath("/tmp/extra.md"),
      draftKeyForPath("/tmp/time.md"),
      draftKeyForPath("/tmp/cursor.md"),
      "not-safe",
    ]) {
      await expect(readRecoveryDraft(userData, key)).resolves.toBeNull();
    }
  });

  it("does not follow a keyed draft symlink outside the drafts directory", async () => {
    const userData = await mkdtemp(join(tmpdir(), "markdesk-drafts-"));
    const draftsDirectory = join(userData, "drafts");
    const outside = join(userData, "outside.json");
    await mkdir(draftsDirectory, { recursive: true });
    await writeFile(outside, JSON.stringify(draft()), "utf8");
    const key = draftKeyForPath("/tmp/symlinked.md");
    await symlink(outside, join(draftsDirectory, `${key}.json`));

    await expect(readRecoveryDraft(userData, key)).resolves.toBeNull();
    await expect(listRecoveryDrafts(userData)).resolves.toEqual([]);
    await expect(readFile(outside, "utf8")).resolves.toContain("/tmp/note.md");
  });

  it("deletes only an existing hexadecimal key file", async () => {
    const userData = await mkdtemp(join(tmpdir(), "markdesk-drafts-"));
    const draftsDirectory = join(userData, "drafts");
    const value = draft();
    const protectedFile = join(userData, "protected.json");
    const nestedProtected = join(draftsDirectory, "protected.json");
    await saveDraft(userData, value);
    await writeFile(protectedFile, "keep", "utf8");
    await writeFile(nestedProtected, "keep", "utf8");

    await expect(discardRecoveryDraft(userData, "not-safe")).resolves.toBeUndefined();
    await expect(discardRecoveryDraft(userData, `../${value.key}`)).resolves.toBeUndefined();
    await expect(stat(join(draftsDirectory, `${value.key}.json`))).resolves.toBeTruthy();
    await expect(readFile(protectedFile, "utf8")).resolves.toBe("keep");
    await expect(readFile(nestedProtected, "utf8")).resolves.toBe("keep");

    await discardRecoveryDraft(userData, value.key);
    await expect(stat(join(draftsDirectory, `${value.key}.json`))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(protectedFile, "utf8")).resolves.toBe("keep");
  });

  it("rejects an invalid draft without creating a final or temporary file", async () => {
    const userData = await mkdtemp(join(tmpdir(), "markdesk-drafts-"));
    const key = draftKeyForPath("/tmp/bad.md");

    await expect(saveDraft(userData, {
      key,
      path: "/tmp/different.md",
      fileName: "different.md",
      markdown: "# Bad",
      mode: "source",
      cursor: 0,
      scrollTop: 0,
      updatedAt: 1,
    })).rejects.toMatchObject({ code: "invalid-argument" });

    await expect(stat(join(userData, "drafts", `${key}.json`))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
