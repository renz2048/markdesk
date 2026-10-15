import { describe, expect, it } from "vitest";
import { createSecureFileIpcController } from "../../src/electron/ipc";
import { FileServiceError } from "../../src/electron/file-service";
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
  readonly webContents: FakeWebContents;
  private closedListeners: Array<() => void> = [];

  constructor(id: number) {
    this.webContents = new FakeWebContents(id);
  }

  once(event: "closed", listener: () => void): void {
    this.closedListeners.push(listener);
  }

  close(): void {
    for (const listener of this.closedListeners.splice(0)) listener();
    this.webContents.destroy();
  }
}

class CloseProtectedWindow extends FakeWindow {
  closed = false;
  private authorizedClose = false;
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
    if (!prevented) this.closed = true;
    return prevented;
  }

  forceClose(): void {
    this.authorizedClose = true;
    this.emitClose();
  }

  get canClose(): boolean {
    return this.authorizedClose;
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

  const controller = createSecureFileIpcController({
    ipcMain,
    dialog: {
      showOpenDialog: async () => ({
        canceled: options.openPath === null,
        filePaths: options.openPath === null ? [] : [options.openPath],
      }),
      showSaveDialog: async () => ({
        canceled: options.savePath === null,
        filePath: options.savePath ?? null,
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
    fileExists: async () => true,
    readFile: async (path: string) => {
      reads.push(path);
      const content = disk.content;
      return {
        path,
        content,
        hash: `hash:${content}`,
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
        expected?.hash !== `hash:${disk.content}`
      ) {
        throw new FileServiceError("file-changed", "file changed after validation");
      }
      return {
        path,
        hash: `hash:${content}`,
        mtimeMs: 11,
        size: content.length,
      };
    },
  });

  controller.register();
  return { controller, ipcMain, windows, disk, writes, reads, recentFiles };
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
    const { ipcMain } = createController({
      windows: [window],
      openPath: "/tmp/a.md",
    });
    await ipcMain.invoke(markdeskChannels.chooseMarkdownFile, {
      sender: window.webContents,
    });
    await ipcMain.invoke(markdeskChannels.readFile, {
      sender: window.webContents,
    }, "/tmp/a.md");

    window.close();
    const afterWindowClose = await ipcMain.invoke(
      markdeskChannels.readFile,
      { sender: window.webContents },
      "/tmp/a.md",
    );
    expect(error(afterWindowClose)?.code).toBe("unexpected-error");

    window.webContents.destroy();
    const afterContentsDestroyed = await ipcMain.invoke(
      markdeskChannels.readFile,
      { sender: window.webContents },
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
    expect(error(secondWindow)?.code).toBe("invalid-path");
    expect(reads).toEqual(["/recent/actual.md"]);
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
    const { controller, ipcMain } = createController({ windows: [window] });
    controller.protectWindowClose(window);

    expect(window.emitClose()).toBe(true);
    expect(window.closed).toBe(false);
    expect(window.webContents.sent).toEqual([
      { channel: markdeskChannels.closeRequested, payload: undefined },
    ]);

    const result = await ipcMain.invoke(
      markdeskChannels.requestClose,
      { sender: window.webContents },
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
