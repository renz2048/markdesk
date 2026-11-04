// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { Fragment, Slice } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { markdownSchema } from "../../src/markdown/schema";
import { parseMarkdown } from "../../src/markdown/parser";
import {
  createPasteImagePlugin,
  imageFilesFromClipboard,
} from "../../src/main/components/WysiwygEditor";

// jsdom 未实现 DataTransfer 构造器；插件只读取 length/kind/type/
// getAsFile()，用最小假对象覆盖，传入前再断言为剪贴板类型。
interface FakeClipboardItem {
  kind: string;
  type: string;
  getAsFile(): File | null;
}

interface FakeTransfer {
  items: FakeClipboardItem[];
}

function clipboardWith(...files: File[]): FakeTransfer {
  const items: FakeClipboardItem[] = files.map((file) => ({
    kind: "file",
    type: file.type,
    getAsFile: () => file,
  }));
  items.push({ kind: "string", type: "text/plain", getAsFile: () => null });
  return { items };
}

function pngFile(name = "shot.png"): File {
  return new File([new Uint8Array([137, 80, 78, 71])], name, {
    type: "image/png",
  });
}

function createView(
  source: (file: File) => Promise<string | null>,
): EditorView {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return new EditorView(host, {
    state: EditorState.create({
      schema: markdownSchema,
      doc: parseMarkdown("正文\n"),
      plugins: [createPasteImagePlugin(source)],
    }),
  });
}

const emptySlice = new Slice(Fragment.empty, 0, 0);

function runHandlePaste(
  view: EditorView,
  transfer: FakeTransfer,
): { handled: boolean | undefined; preventDefault: ReturnType<typeof vi.fn> } {
  const preventDefault = vi.fn();
  const event = {
    preventDefault,
    clipboardData: transfer,
  } as unknown as ClipboardEvent;
  const handled = view.someProp(
    "handlePaste",
    (prop) => prop(view, event, emptySlice) === true,
  );
  return { handled, preventDefault };
}

function imageNodes(view: EditorView): Array<{ src: string; alt: string }> {
  const found: Array<{ src: string; alt: string }> = [];
  view.state.doc.descendants((node) => {
    if (node.type.name === "image") {
      found.push({ src: node.attrs.src, alt: node.attrs.alt });
    }
    return true;
  });
  return found;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("imageFilesFromClipboard", () => {
  it("collects only non-empty image files", () => {
    const transfer = clipboardWith(
      pngFile(),
      new File([], "empty.png", { type: "image/png" }),
    );
    const files = imageFilesFromClipboard(
      transfer.items as unknown as DataTransferItemList,
    );
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("shot.png");
    expect(imageFilesFromClipboard(null)).toEqual([]);
  });
});

describe("paste image plugin", () => {
  it("inserts the src returned by the paste source", async () => {
    const source = vi.fn(async () => "assets/paste-1.png");
    const view = createView(source);
    const run = runHandlePaste(view, clipboardWith(pngFile("photo.png")));
    expect(run.handled).toBe(true);
    expect(run.preventDefault).toHaveBeenCalledTimes(1);
    await flush();

    expect(source).toHaveBeenCalledTimes(1);
    expect(imageNodes(view)).toEqual([
      { src: "assets/paste-1.png", alt: "photo.png" },
    ]);
    view.destroy();
  });

  it("supports data URI fallbacks inline", async () => {
    const view = createView(async () => "data:image/png;base64,AAA");
    runHandlePaste(view, clipboardWith(pngFile()));
    await flush();

    expect(imageNodes(view)).toEqual([
      { src: "data:image/png;base64,AAA", alt: "shot.png" },
    ]);
    view.destroy();
  });

  it("leaves the document untouched when the source declines", async () => {
    const view = createView(async () => null);
    expect(runHandlePaste(view, clipboardWith(pngFile())).handled).toBe(true);
    await flush();

    expect(imageNodes(view)).toEqual([]);
    view.destroy();
  });

  it("passes text-only pastes to the default handler", () => {
    const source = vi.fn(async () => "assets/x.png");
    const view = createView(source);
    // someProp 对 false 的返回值会继续询问其他插件，最终得到
    // undefined，即 ProseMirror 会执行默认粘贴行为。
    const run = runHandlePaste(view, { items: [] });
    expect(run.handled).toBeFalsy();
    expect(run.preventDefault).not.toHaveBeenCalled();
    expect(source).not.toHaveBeenCalled();
    view.destroy();
  });
});
