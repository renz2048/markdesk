import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSecureFileIpcController,
  normalizeUnresolvedPath,
  resolveResourcePath,
} from "../../src/electron/ipc";
import { FileServiceError } from "../../src/electron/file-service";
import { draftKeyForPath } from "../../src/electron/drafts";
import { createHash } from "node:crypto";

const contentHash = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
import { markdeskChannels } from "../../src/shared/types";

type IpcHandler = (
  event: { sender: FakeWebContents },
  ...args: unknown[]
) => Promise<unknown>;

class FakeIpcMain {
  handlers = new Map<string, IpcHandler>();

  handle(channel: string, handler: IpcHandler): void {
    this.handlers.set(channel, handler);
  }

  invoke(channel: string, event: { sender: FakeWebContents }, ...args: unknown[]) {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`unregistered channel: ${channel}`);
    return handler(event, ...args);
  }
}

class FakeWebContents {
  sent: Array<{ channel: string; payload: unknown }> = [];
  private destroyedListeners: Array<() => void> = [];
  private destroyedState = false;

  constructor(readonly id: number) {}

  isDestroyed(): boolean {
    return this.destroyedState;
  }

  once(event: "destroyed", listener: () => void): void {
    this.destroyedListeners.push(listener);
  }

  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload });
  }

  destroy(): void {
    this.destroyedState = true;
    for (const listener of this.destroyedListeners.splice(0)) listener();
  }
}

class FakeWindow {
  private readonly contents: FakeWebContents;
  private windowClosed = false;
  private closedListeners: Array<() => void> = [];

  constructor(id: number) {
    this.contents = new FakeWebContents(id);
  }

  // 真实 BrowserWindow 销毁后访问 webContents 会抛 "Object has been
  // destroyed"；这里保持一致，避免假实现掩盖销毁后的误用。
  get webContents(): FakeWebContents {
    if (this.windowClosed) throw new Error("Object has been destroyed");
    return this.contents;
  }

  once(event: "closed", listener: () => void): void {
    this.closedListeners.push(listener);
  }

  close(): void {
    // 真实 Electron 在触发 "closed" 之前就已销毁窗口与 webContents。
    if (this.windowClosed) return;
    this.windowClosed = true;
    this.contents.destroy();
    for (const listener of this.closedListeners.splice(0)) listener();
  }
}

class CloseProtectedWindow extends FakeWindow {
  closed = false;
  private closeListeners: Array<(event: {
    preventDefault(): void;
  }) => void> = [];

  on(event: "close", listener: (event: {
    preventDefault(): void;
  }) => void): void {
    if (event === "close") this.closeListeners.push(listener);
  }

  emitClose(): boolean {
    let prevented = false;
    // Electron keeps close listeners installed across repeated close attempts.
    for (const listener of this.closeListeners) {
      listener({
        preventDefault: () => {
          prevented = true;
        },
      });
    }
    if (!prevented) {
      this.closed = true;
      super.close();
    }
    return prevented;
  }

  close(): void {
    // 真实 Electron 中 close() 会再次触发 close 事件；已获得控制器授权时
    // 监听器不再 preventDefault，窗口随之真正关闭。
    this.emitClose();
  }

  get canClose(): boolean {
    return this.closed;
  }
}

class FakeWatcher {
  readonly closedAt: number | null = null;

  constructor(
    readonly path: string,
    private readonly listener: (eventType: string) => void,
    private readonly onClose: (watcher: FakeWatcher) => void,
  ) {}

  emit(eventType = "change"): void {
    this.listener(eventType);
  }

  once(_event: "error", _listener: () => void): void {
    // Watcher lifecycle is exercised through close() in these tests.
  }

  close(): void {
    this.onClose(this);
  }
}

interface ControllerOptions {
  windows?: FakeWindow[];
  openPath?: string | null;
  savePath?: string | null;
  disk?: string;
  aliases?: Record<string, string>;
  writeGuard?: boolean;
  fileExists?: (path: string) => Promise<boolean>;
  recentFiles?: Array<{
    path: string;
    name: string;
    lastOpenedAt: number;
  }>;
  draftStoragePath?: string | null;
  drafts?: Array<{
    key: string;
    path: string | null;
    fileName: string;
    markdown: string;
    mode: "wysiwyg" | "source" | "read";
    cursor: number;
    scrollTop: number;
    updatedAt: number;
  }>;
  fingerprint?: { hash: string; mtimeMs: number; size: number };
  writeExport?: (path: string, html: string) => Promise<void>;
}

function createController(options: ControllerOptions = {}) {
  const ipcMain = new FakeIpcMain();
  const windows = options.windows ?? [new FakeWindow(1)];
  const aliases = options.aliases ?? {};
  const disk = { content: options.disk ?? "# Open\n" };
  const reads: string[] = [];
  const writes: Array<{
    path: string;
    content: string;
    expected?: { hash: string; mtimeMs: number; size: number };
  }> = [];
  const recentFiles = [...(options.recentFiles ?? [])];
  const drafts = [...(options.drafts ?? [])];
  const watchers: FakeWatcher[] = [];
  const fingerprints = { ...(options.fingerprint ?? {
    hash: contentHash("#External\n"),
    mtimeMs: 12,
    size: 10,
  }) };
  const controller = createSecureFileIpcController({
    ipcMain,
    dialog: {
      showOpenDialog: async () => ({
        canceled: options.openPath === null,
        filePaths: options.openPath === null ? [] : [options.openPath ?? ""],
      }),
      showSaveDialog: async () => ({
        canceled: options.savePath === null,
        filePath: options.savePath ?? undefined,
      }),
    },
    getWindows: () => windows,
    canonicalize: async (path: string) => aliases[path] ?? path,
    recentStoragePath: "/state/recent-files.json",
    loadRecentFiles: async () => recentFiles.map((file) => ({ ...file })),
    upsertRecentFile: async (_storage, path) => {
      const entry = {
        path,
        name: path.split("/").at(-1) ?? path,
        lastOpenedAt: recentFiles.length + 1,
      };
      const nextFiles = [
        entry,
        ...recentFiles.filter((file) => file.path !== path),
      ].slice(0, 10);
      recentFiles.length = 0;
      recentFiles.push(...nextFiles);
      return nextFiles.map((file) => ({ ...file }));
    },
    clearRecentFiles: async () => {
      recentFiles.length = 0;
    },
    draftStoragePath: options.draftStoragePath === null
      ? undefined
      : (options.draftStoragePath ?? "/state/drafts"),
    saveDraft: async (userDataPath: string, draft: typeof drafts[number]) => {
      expect(userDataPath).toBe(options.draftStoragePath ?? "/state/drafts");
      const next = { ...draft, key: draftKeyForPath(draft.path) };
      const index = drafts.findIndex((entry) => entry.key === next.key);
      if (index >= 0) drafts.splice(index, 1, next);
      else drafts.push(next);
    },
    listRecoveryDrafts: async () => {
      const valid = drafts.filter((entry) => entry.path !== null);
      return valid.sort((left, right) => right.updatedAt - left.updatedAt)
        .map(({ key, path, fileName, updatedAt }) => ({
          key,
          path,
          fileName,
          updatedAt,
        }));
    },
    readRecoveryDraft: async (userDataPath: string, key: string) => {
      expect(userDataPath).toBe(options.draftStoragePath ?? "/state/drafts");
      return drafts.find((entry) => entry.key === key) ?? null;
    },
    discardRecoveryDraft: async (userDataPath: string, key: string) => {
      expect(userDataPath).toBe(options.draftStoragePath ?? "/state/drafts");
      const index = drafts.findIndex((entry) => entry.key === key);
      if (index >= 0) drafts.splice(index, 1);
    },
    fileExists: options.fileExists ?? (async () => true),
    readFile: async (path: string) => {
      reads.push(path);
      const content = disk.content;
      return {
        path,
        content,
        hash: contentHash(content),
        mtimeMs: 10,
        size: content.length,
        newline: "lf" as const,
      };
    },
    writeFile: async (
      path: string,
      content: string,
      expected?: unknown,
    ) => {
      writes.push({
        path,
        content,
        expected: expected as { hash: string; mtimeMs: number; size: number } |
          undefined,
      });
      if (
        options.writeGuard &&
        (expected as { hash?: string } | undefined)?.hash !==
          contentHash(disk.content)
      ) {
        throw new FileServiceError("file-changed", "file changed after validation");
      }
      return {
        path,
        hash: contentHash(content),
        mtimeMs: 11,
        size: content.length,
      };
    },
    fingerprintFile: async () => ({ ...fingerprints }),
    writeExport: options.writeExport,
    watch: (path: string, listener: (eventType: string) => void) => {
      const watcher = new FakeWatcher(
        path,
        listener,
        (closed) => {
          const index = watchers.indexOf(closed);
          if (index >= 0) watchers.splice(index, 1);
        },
      );
      watchers.push(watcher);
      return watcher;
    },
  });

  controller.register();
  return {
    controller,
    ipcMain,
    windows,
    disk,
    writes,
    reads,
    recentFiles,
    drafts,
    watchers,
    fingerprints,
  };
}

function error(result: unknown) {

  if (
    typeof result === "object" && result !== null && "error" in result &&
    (result as { error?: unknown }).error
  ) {
    return (result as { error: { code: string } }).error;
  }
  return null;
}

describe("normalizeUnresolvedPath", () => {
  it("normalizes drive-letter paths case-insensitively", () => {
    expect(normalizeUnresolvedPath("C:\\Docs\\Report.MD")).toBe(
      "c:\\docs\\report.md",
    );
  });

  it("canonicalizes UNC separators without changing case", () => {
    expect(
      normalizeUnresolvedPath(
        "\\\\wsl.localhost\\Ubuntu-26.04\\Home\\RenZheng\\Notes.md",
      ),
    ).toBe("\\\\wsl.localhost\\Ubuntu-26.04\\Home\\RenZheng\\Notes.md");
    expect(
      normalizeUnresolvedPath(
        "//wsl.localhost/Ubuntu-26.04/home/dev/todo.md",
      ),
    ).toBe("\\\\wsl.localhost\\Ubuntu-26.04\\home\\dev\\todo.md");
  });

  it("keeps POSIX paths on posix semantics", () => {
    expect(normalizeUnresolvedPath("/tmp/notes/a.md")).toBe("/tmp/notes/a.md");
  });
});

describe("secure file IPC grants", () => {
  it("validates the sender for every invoke handler", async () => {
    const { ipcMain } = createController({ windows: [] });
    const event = { sender: new FakeWebContents(99) };

    for (const channel of [
      markdeskChannels.chooseMarkdownFile,
      markdeskChannels.chooseSaveLocation,
      markdeskChannels.readFile,
      markdeskChannels.writeFile,
      markdeskChannels.getRecentFiles,
      markdeskChannels.readRecentFile,
      markdeskChannels.clearRecentFiles,
      markdeskChannels.saveRecoveryDraft,
      markdeskChannels.listRecoveryDrafts,
      markdeskChannels.readRecoveryDraft,
      markdeskChannels.discardRecoveryDraft,
      markdeskChannels.requestClose,
      markdeskChannels.cancelClose,
    ]) {
      const result = await ipcMain.invoke(channel, event);
      expect(error(result)?.code).toBe("unexpected-error");
    }
  });

  it("keeps grants isolated per BrowserWindow", async () => {
    const first = new FakeWindow(1);
    const second = new FakeWindow(2);
    const { ipcMain } = createController({
      windows: [first, second],
      openPath: "/tmp/a.md",
    });

    await ipcMain.invoke(
      markdeskChannels.chooseMarkdownFile,
      { sender: first.webContents },
    );
    const opened = await ipcMain.invoke(markdeskChannels.readFile, {
      sender: first.webContents,
    }, "/tmp/a.md");
    expect(opened).toMatchObject({ ok: true, value: { path: "/tmp/a.md" } });

    const denied = await ipcMain.invoke(markdeskChannels.readFile, {
      sender: second.webContents,
    }, "/tmp/a.md");
    expect(error(denied)?.code).toBe("invalid-path");
  });

  it("revokes grants when the window or webContents is destroyed", async () => {
    const window = new FakeWindow(1);
    const sender = window.webContents;
    const { ipcMain } = createController({
      windows: [window],
      openPath: "/tmp/a.md",
    });
    await ipcMain.invoke(markdeskChannels.chooseMarkdownFile, {
      sender,
    });
    await ipcMain.invoke(markdeskChannels.readFile, {
      sender,
    }, "/tmp/a.md");

    window.close();
    const afterWindowClose = await ipcMain.invoke(
      markdeskChannels.readFile,
      { sender },
      "/tmp/a.md",
    );
    expect(error(afterWindowClose)?.code).toBe("unexpected-error");

    sender.destroy();
    const afterContentsDestroyed = await ipcMain.invoke(
      markdeskChannels.readFile,
      { sender },
      "/tmp/a.md",
    );
    expect(error(afterContentsDestroyed)?.code).toBe("unexpected-error");
  });

  it("notifies only windows with a read grant for the canonical file", async () => {
    const first = new FakeWindow(1);
    const second = new FakeWindow(2);
    const { controller, ipcMain } = createController({
      windows: [first, second],
      openPath: "/tmp/a.md",
      aliases: { "/tmp/a.md": "/canonical.md" },
    });
    await ipcMain.invoke(markdeskChannels.chooseMarkdownFile, {
      sender: first.webContents,
    });
    await ipcMain.invoke(markdeskChannels.readFile, {
      sender: first.webContents,
    }, "/tmp/a.md");

    await controller.notifyFileChanged("/tmp/a.md");

    expect(first.webContents.sent).toEqual([
      {
        channel: markdeskChannels.recentFilesChanged,
        payload: [{
          path: "/canonical.md",
          name: "canonical.md",
          lastOpenedAt: 1,
          exists: true,
        }],
      },
      {
        channel: markdeskChannels.fileChanged,
        payload: { path: "/canonical.md" },
      },
    ]);
    expect(second.webContents.sent).toEqual([
      {
        channel: markdeskChannels.recentFilesChanged,
        payload: [{
          path: "/canonical.md",
          name: "canonical.md",
          lastOpenedAt: 1,
          exists: true,
        }],
      },
    ]);
  });

  it("authorizes a persisted recent path only for the requesting window", async () => {
    const first = new FakeWindow(1);
    const second = new FakeWindow(2);
    const { ipcMain, reads } = createController({
      windows: [first, second],
      aliases: { "/recent/alias.md": "/recent/actual.md" },
      recentFiles: [{
        path: "/recent/actual.md",
        name: "actual.md",
        lastOpenedAt: 20,
      }],
    });

    const denied = await ipcMain.invoke(
      markdeskChannels.readRecentFile,
      { sender: first.webContents },
      "/not-recent.md",
    );
    expect(error(denied)?.code).toBe("invalid-path");
    expect(reads).toEqual([]);

    const opened = await ipcMain.invoke(
      markdeskChannels.readRecentFile,
      { sender: first.webContents },
      "/recent/alias.md",
    );
    expect(opened).toMatchObject({
      ok: true,
      value: { path: "/recent/actual.md" },
    });

    const secondWindow = await ipcMain.invoke(
      markdeskChannels.readRecentFile,
      { sender: second.webContents },
      "/recent/actual.md",
    );
    // 最近文件列表是应用级状态：每个已识别的窗口都可以打开其中存在的
    // 文件（欢迎页的最近列表依赖这一点），但未列出的路径仍然拒绝。
    expect(secondWindow).toMatchObject({
      ok: true,
      value: { path: "/recent/actual.md" },
    });
    expect(reads).toEqual(["/recent/actual.md", "/recent/actual.md"]);
  });

  it("reports missing recent files without granting or reading them", async () => {
    const window = new FakeWindow(1);
    const { ipcMain, reads } = createController({
      windows: [window],
      recentFiles: [{
        path: "/recent/missing.md",
        name: "missing.md",
        lastOpenedAt: 20,
      }],
      fileExists: async (path: string) => path !== "/recent/missing.md",
    });

    const files = await ipcMain.invoke(
      markdeskChannels.getRecentFiles,
      { sender: window.webContents },
    );
    expect(files).toMatchObject({
      ok: true,
      value: [{ path: "/recent/missing.md", exists: false }],
    });

    const missing = await ipcMain.invoke(
      markdeskChannels.readRecentFile,
      { sender: window.webContents },
      "/recent/missing.md",
    );
    expect(error(missing)?.code).toBe("invalid-path");
    expect(reads).toEqual([]);
  });

  it("clears recent files for the requesting sender and broadcasts the result", async () => {
    const first = new FakeWindow(1);
    const second = new FakeWindow(2);
    const { ipcMain, recentFiles } = createController({
      windows: [first, second],
      recentFiles: [{
        path: "/recent/a.md",
        name: "a.md",
        lastOpenedAt: 20,
      }],
    });

    const result = await ipcMain.invoke(
      markdeskChannels.clearRecentFiles,
      { sender: first.webContents },
    );
    expect(result).toMatchObject({ ok: true, value: undefined });
    expect(recentFiles).toEqual([]);
    expect(first.webContents.sent).toEqual([
      {
        channel: markdeskChannels.recentFilesChanged,
        payload: [],
      },
    ]);
    expect(second.webContents.sent).toEqual([
      {
        channel: markdeskChannels.recentFilesChanged,
        payload: [],
      },
    ]);
  });

  it("routes window closing through a renderer close request", async () => {
    const window = new CloseProtectedWindow(1);
    const sender = window.webContents;
    const { controller, ipcMain } = createController({ windows: [window] });
    controller.protectWindowClose(window);

    expect(window.emitClose()).toBe(true);
    expect(window.closed).toBe(false);
    expect(sender.sent).toEqual([
      { channel: markdeskChannels.closeRequested, payload: undefined },
    ]);

    const result = await ipcMain.invoke(
      markdeskChannels.requestClose,
      { sender },
    );

    expect(result).toMatchObject({ ok: true, value: undefined });
    expect(window.canClose).toBe(true);
    expect(window.closed).toBe(true);
  });

  it("issues a close token only for an intercepted close and cancels it", async () => {
    const window = new CloseProtectedWindow(1);
    const { controller, ipcMain } = createController({ windows: [window] });
    controller.protectWindowClose(window);

    const beforeRequest = await ipcMain.invoke(
      markdeskChannels.requestClose,
      { sender: window.webContents },
    );
    expect(error(beforeRequest)?.code).toBe("invalid-argument");

    window.emitClose();
    const canceled = await ipcMain.invoke(
      markdeskChannels.cancelClose,
      { sender: window.webContents },
    );
    expect(canceled).toMatchObject({ ok: true, value: undefined });

    const afterCancel = await ipcMain.invoke(
      markdeskChannels.requestClose,
      { sender: window.webContents },
    );
    expect(error(afterCancel)?.code).toBe("invalid-argument");
    expect(window.closed).toBe(false);

    const retriedClose = window.emitClose();
    expect(retriedClose).toBe(true);
    expect(window.closed).toBe(false);
    expect(window.webContents.sent).toHaveLength(2);
    expect(window.webContents.sent[1]).toEqual({
      channel: markdeskChannels.closeRequested,
      payload: undefined,
    });
    const reopened = await ipcMain.invoke(
      markdeskChannels.requestClose,
      { sender: window.webContents },
    );
    expect(reopened).toMatchObject({ ok: true, value: undefined });
    expect(window.closed).toBe(true);
  });

  it("does not let one renderer close another protected window", async () => {
    const first = new CloseProtectedWindow(1);
    const second = new CloseProtectedWindow(2);
    const { controller, ipcMain } = createController({
      windows: [first, second],
    });
    controller.protectWindowClose(first);
    controller.protectWindowClose(second);
    first.emitClose();

    const denied = await ipcMain.invoke(
      markdeskChannels.requestClose,
      { sender: second.webContents },
    );
    expect(error(denied)?.code).toBe("invalid-argument");
    expect(first.closed).toBe(false);
    expect(second.closed).toBe(false);

    const allowed = await ipcMain.invoke(
      markdeskChannels.requestClose,
      { sender: first.webContents },
    );
    expect(allowed).toMatchObject({ ok: true, value: undefined });
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
  });

  it("registers externally opened paths so the renderer can read them", async () => {
    const window = new FakeWindow(1);
    const { controller, ipcMain } = createController({ windows: [window] });

    const canonical = await controller.openExternalPath("/tmp/external.md");

    expect(canonical).toBe("/tmp/external.md");
    const result = await ipcMain.invoke(
      markdeskChannels.readRecentFile,
      { sender: window.webContents },
      "/tmp/external.md",
    );
    expect(result).toMatchObject({ ok: true });
  });

  it("rejects external open requests for missing or non-markdown paths", async () => {
    const window = new FakeWindow(1);
    const { controller } = createController({
      windows: [window],
      fileExists: async () => false,
    });
    await expect(
      controller.openExternalPath("/tmp/gone.md"),
    ).rejects.toMatchObject({ code: "invalid-path" });
    await expect(
      controller.openExternalPath("/tmp/notes.txt"),
    ).rejects.toMatchObject({ code: "invalid-path" });
  });
});

describe("secure recovery-draft IPC", () => {
  it("saves, lists, restores, and discards only sender-validated drafts", async () => {
    const window = new FakeWindow(1);
    const { ipcMain, drafts } = createController({
      windows: [window],
      openPath: "/tmp/draft.md",
      draftStoragePath: "/state/drafts",
    });
    await ipcMain.invoke(markdeskChannels.chooseMarkdownFile, {
      sender: window.webContents,
    });
    await ipcMain.invoke(markdeskChannels.readFile, {
      sender: window.webContents,
    }, "/tmp/draft.md");

    const saved = await ipcMain.invoke(markdeskChannels.saveRecoveryDraft, {
      sender: window.webContents,
    }, {
      path: "/tmp/draft.md",
      fileName: "draft.md",
      markdown: "# Unsaved",
      mode: "wysiwyg",
      cursor: 4,
      scrollTop: 30,
    });

    const key = draftKeyForPath("/tmp/draft.md");
    expect(saved).toMatchObject({ ok: true, value: key });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      key,
      path: "/tmp/draft.md",
      markdown: "# Unsaved",
      cursor: 4,
      scrollTop: 30,
    });

    const listed = await ipcMain.invoke(markdeskChannels.listRecoveryDrafts, {
      sender: window.webContents,
    });
    expect(listed).toMatchObject({
      ok: true,
      value: [{
        key,
        path: "/tmp/draft.md",
        fileName: "draft.md",
        updatedAt: expect.any(Number),
      }],
    });

    const restored = await ipcMain.invoke(markdeskChannels.readRecoveryDraft, {
      sender: window.webContents,
    }, key);
    expect(restored).toMatchObject({
      ok: true,
      value: { key, markdown: "# Unsaved", cursor: 4 },
    });

    const discarded = await ipcMain.invoke(markdeskChannels.discardRecoveryDraft, {
      sender: window.webContents,
    }, key);
    expect(discarded).toMatchObject({ ok: true, value: undefined });
    expect(drafts).toEqual([]);
  });

  it("does not persist a file-backed draft for an ungranted path", async () => {
    const window = new FakeWindow(1);
    const { ipcMain, drafts } = createController({
      windows: [window],
      openPath: "/tmp/open.md",
      draftStoragePath: "/state/drafts",
    });
    await ipcMain.invoke(markdeskChannels.chooseMarkdownFile, {
      sender: window.webContents,
    });
    await ipcMain.invoke(markdeskChannels.readFile, {
      sender: window.webContents,
    }, "/tmp/open.md");

    const denied = await ipcMain.invoke(markdeskChannels.saveRecoveryDraft, {
      sender: window.webContents,
    }, {
      path: "/tmp/ungranted.md",
      fileName: "ungranted.md",
      markdown: "# Denied",
      mode: "source",
      cursor: 0,
      scrollTop: 0,
    });

    expect(error(denied)?.code).toBe("invalid-path");
    expect(drafts).toEqual([]);
  });

  it("requires configured draft storage", async () => {
    const window = new FakeWindow(1);
    const { ipcMain } = createController({
      windows: [window],
      draftStoragePath: null,
    });

    const result = await ipcMain.invoke(markdeskChannels.listRecoveryDrafts, {
      sender: window.webContents,
    });
    expect(error(result)?.code).toBe("invalid-argument");
  });
});

describe("external-file watching", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces a real external fingerprint change to granted renderers", async () => {
    const first = new FakeWindow(1);
    const second = new FakeWindow(2);
    const { ipcMain, watchers, fingerprints } = createController({
      windows: [first, second],
      openPath: "/tmp/watched.md",
      fingerprint: {
        hash: contentHash("#Open\n"),
        mtimeMs: 10,
        size: 7,
      },
    });
    await ipcMain.invoke(markdeskChannels.chooseMarkdownFile, {
      sender: first.webContents,
    });
    await ipcMain.invoke(markdeskChannels.readFile, {
      sender: first.webContents,
    }, "/tmp/watched.md");
    expect(watchers).toHaveLength(1);

    fingerprints.hash = contentHash("#External\n");
    watchers[0].emit("change");
    await vi.advanceTimersByTimeAsync(250);

    const changes = first.webContents.sent.filter((event) =>
      event.channel === markdeskChannels.fileChanged
    );
    expect(changes).toEqual([{
      channel: markdeskChannels.fileChanged,
      payload: { path: "/tmp/watched.md" },
    }]);
    expect(
      second.webContents.sent.some((event) =>
        event.channel === markdeskChannels.fileChanged
      ),
    ).toBe(false);
  });

  it("suppresses notifications for MarkDesk's own successful writes", async () => {
    const window = new FakeWindow(1);
    const { ipcMain, watchers, fingerprints } = createController({
      windows: [window],
      openPath: "/tmp/own-write.md",
      savePath: "/tmp/own-write.md",
      fingerprint: {
        hash: contentHash("#Open\n"),
        mtimeMs: 10,
        size: 7,
      },
    });
    await ipcMain.invoke(markdeskChannels.chooseMarkdownFile, {
      sender: window.webContents,
    });
    const read = await ipcMain.invoke(markdeskChannels.readFile, {
      sender: window.webContents,
    }, "/tmp/own-write.md") as { value: { hash: string; mtimeMs: number; size: number } };
    const write = await ipcMain.invoke(markdeskChannels.writeFile, {
      sender: window.webContents,
    }, "/tmp/own-write.md", "# Local\n", read.value) as { value: {
      hash: string;
      mtimeMs: number;
      size: number;
    } };
    fingerprints.hash = write.value.hash;
    fingerprints.mtimeMs = write.value.mtimeMs;
    fingerprints.size = write.value.size;

    watchers[0].emit("rename");
    await vi.advanceTimersByTimeAsync(250);

    expect(
      window.webContents.sent.filter((event) =>
        event.channel === markdeskChannels.fileChanged
      ),
    ).toEqual([]);
  });

  it("shares one watcher and closes it after the last grant is revoked", async () => {
    const first = new FakeWindow(1);
    const second = new FakeWindow(2);
    const { ipcMain, watchers } = createController({
      windows: [first, second],
      openPath: "/tmp/shared.md",
      fingerprint: {
        hash: contentHash("#Open\n"),
        mtimeMs: 10,
        size: 7,
      },
    });
    for (const window of [first, second]) {
      await ipcMain.invoke(markdeskChannels.chooseMarkdownFile, {
        sender: window.webContents,
      });
      await ipcMain.invoke(markdeskChannels.readFile, {
        sender: window.webContents,
      }, "/tmp/shared.md");
    }
    expect(watchers).toHaveLength(1);

    first.close();
    expect(watchers).toHaveLength(1);
    second.close();
    expect(watchers).toHaveLength(0);
  });
});

describe("canonical aliases and collision baselines", () => {
  it("rejects incomplete or reserved Windows default filenames", async () => {
    const window = new FakeWindow(1);
    const { ipcMain } = createController({
      windows: [window],
      savePath: "/tmp/save.md",
    });

    for (const defaultName of [
      "CON.md",
      "aux.md",
      "lpt1.markdown",
      "bad:name.md",
      "bad<name>.md",
      "trailing-dot.md.",
      "trailing-space.md ",
    ]) {
      const result = await ipcMain.invoke(
        markdeskChannels.chooseSaveLocation,
        { sender: window.webContents },
        defaultName,
      );
      expect(error(result)?.code).toBe("invalid-argument");
    }
  });

  it("passes the validated expected fingerprint into the write service", async () => {
    const window = new FakeWindow(1);
    const { ipcMain, writes, disk } = createController({
      windows: [window],
      openPath: "/tmp/real.md",
      aliases: { "/tmp/alias.md": "/tmp/real.md" },
      writeGuard: true,
    });
    await ipcMain.invoke(markdeskChannels.chooseMarkdownFile, {
      sender: window.webContents,
    });
    const read = await ipcMain.invoke(
      markdeskChannels.readFile,
      { sender: window.webContents },
      "/tmp/alias.md",
    ) as { value: { hash: string; mtimeMs: number; size: number } };

    disk.content = "# External race\n";
    const result = await ipcMain.invoke(
      markdeskChannels.writeFile,
      { sender: window.webContents },
      "/tmp/real.md",
      "# Local\n",
      read.value,
    );

    expect(error(result)?.code).toBe("file-changed");
    expect(writes).toHaveLength(1);
    expect(writes[0].expected).toEqual(read.value);
  });

  it("requires the opened-file fingerprint for an aliased save-as target", async () => {
    const window = new FakeWindow(1);
    const { ipcMain, writes } = createController({
      windows: [window],
      openPath: "/tmp/real.md",
      savePath: "/tmp/save-alias.md",
      aliases: {
        "/tmp/real.md": "/canonical.md",
        "/tmp/save-alias.md": "/canonical.md",
      },
    });
    await ipcMain.invoke(markdeskChannels.chooseMarkdownFile, {
      sender: window.webContents,
    });
    const read = await ipcMain.invoke(
      markdeskChannels.readFile,
      { sender: window.webContents },
      "/tmp/real.md",
    ) as { value: { hash: string; mtimeMs: number; size: number } };

    const denied = await ipcMain.invoke(
      markdeskChannels.writeFile,
      { sender: window.webContents },
      "/tmp/save-alias.md",
      "# Local\n",
    );
    expect(error(denied)?.code).toBe("invalid-fingerprint");
    expect(writes).toEqual([]);

    const allowed = await ipcMain.invoke(
      markdeskChannels.writeFile,
      { sender: window.webContents },
      "/tmp/save-alias.md",
      "# Local\n",
      read.value,
    );
    expect(allowed).toMatchObject({ ok: true });
    expect(writes[0].expected).toEqual(read.value);
  });

  it("allows an unrelated save-dialog target to omit a fingerprint", async () => {
    const window = new FakeWindow(1);
    const { ipcMain, writes } = createController({
      windows: [window],
      openPath: "/tmp/open.md",
      savePath: "/tmp/unrelated.md",
    });
    await ipcMain.invoke(markdeskChannels.chooseMarkdownFile, {
      sender: window.webContents,
    });
    await ipcMain.invoke(markdeskChannels.readFile, {
      sender: window.webContents,
    }, "/tmp/open.md");
    await ipcMain.invoke(markdeskChannels.chooseSaveLocation, {
      sender: window.webContents,
    }, "Untitled.md");

    const result = await ipcMain.invoke(
      markdeskChannels.writeFile,
      { sender: window.webContents },
      "/tmp/unrelated.md",
      "# New\n",
    );

    expect(result).toMatchObject({ ok: true });
    expect(writes[0].expected).toBeUndefined();
  });
});

describe("HTML export IPC", () => {
  it("exports only to authorized save-dialog paths with valid content", async () => {
    const window = new FakeWindow(1);
    const exports: Array<{ path: string; html: string }> = [];
    const { ipcMain } = createController(
      {
        windows: [window],
        savePath: "/tmp/out.html",
        writeExport: async (path, html) => {
          exports.push({ path, html });
        },
      },
    );

    const denied = await ipcMain.invoke(markdeskChannels.exportHtml, {
      sender: window.webContents,
    }, "/tmp/out.html", "<p>x</p>");
    expect(error(denied)?.code).toBe("invalid-path");
    expect(exports).toEqual([]);

    const chosen = await ipcMain.invoke(markdeskChannels.chooseExportLocation, {
      sender: window.webContents,
    }, "note.html");
    expect(chosen).toMatchObject({ ok: true, value: "/tmp/out.html" });

    const result = await ipcMain.invoke(markdeskChannels.exportHtml, {
      sender: window.webContents,
    }, "/tmp/out.html", "<p>clean</p>");
    expect(result).toMatchObject({ ok: true, value: undefined });
    expect(exports).toEqual([{ path: "/tmp/out.html", html: "<p>clean</p>" }]);

    const badExtension = await ipcMain.invoke(markdeskChannels.exportHtml, {
      sender: window.webContents,
    }, "/tmp/out.exe", "<p>x</p>");
    expect(error(badExtension)?.code).toBe("invalid-path");

    const notString = await ipcMain.invoke(markdeskChannels.exportHtml, {
      sender: window.webContents,
    }, "/tmp/out.html", 123);
    expect(error(notString)?.code).toBe("invalid-argument");
  });
});

describe("markdesk-resource path resolution", () => {
  const dirs = ["/docs"];

  it("resolves relative images inside the document directory", () => {
    expect(resolveResourcePath(dirs, "markdesk-resource:assets/pic.png"))
      .toBe("/docs/assets/pic.png");
    expect(resolveResourcePath(dirs, "markdesk-resource:photo.jpeg"))
      .toBe("/docs/photo.jpeg");
  });

  it("rejects escape attempts, absolute paths, and non-image extensions", () => {
    expect(resolveResourcePath(dirs, "markdesk-resource:../secret.png"))
      .toBeNull();
    expect(resolveResourcePath(dirs, "markdesk-resource:/etc/passwd.png"))
      .toBeNull();
    expect(resolveResourcePath(dirs, "markdesk-resource:file:///etc/passwd"))
      .toBeNull();
    expect(resolveResourcePath(dirs, "markdesk-resource:assets/app.js"))
      .toBeNull();
    expect(resolveResourcePath(dirs, "https://example.com/x.png")).toBeNull();
  });

  it("rejects everything when no document is open", () => {
    expect(resolveResourcePath([], "markdesk-resource:assets/pic.png"))
      .toBeNull();
  });
});
