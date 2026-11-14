// @vitest-environment jsdom
// [toc] 目录块支持（#4）：解析与逐字往返、WYSIWYG NodeView 的实时
// 条目/点击跳转、HTML 导出中的锚点导航、[toc] + 回车的输入转换。
import { beforeAll, describe, expect, it } from "vitest";
import type { Node } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { parseMarkdown } from "../../src/markdown/parser";
import { roundTripMarkdown } from "../../src/markdown/roundTrip";
import { markdownSchema } from "../../src/markdown/schema";
import { buildExportHtml } from "../../src/main/editor/exportHtml";
import { isTocBlock, tocBlockPlugin } from "../../src/main/editor/tocBlock";
import { createEditorPlugins } from "../../src/main/components/WysiwygEditor";

// jsdom 的 Range/Text 没有 getClientRects；点击跳转的坐标计算补零桩。
const zeroRect = () => [
  { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
];
beforeAll(() => {
  for (const proto of [Range.prototype, Text.prototype]) {
    const record = proto as unknown as Record<string, unknown>;
    if (typeof record.getClientRects !== "function") {
      Object.defineProperty(proto, "getClientRects", {
        value: zeroRect,
        configurable: true,
      });
    }
    if (typeof record.getBoundingClientRect !== "function") {
      Object.defineProperty(proto, "getBoundingClientRect", {
        value: () => zeroRect()[0],
        configurable: true,
      });
    }
  }
});

const TOC_DOC = "[toc]\n\n# 一级标题\n\n## 二级标题\n\n正文\n";

function findTocBlock(doc: Node): { node: Node; pos: number } {
  let found: { node: Node; pos: number } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === "toc_block") {
      found = { node, pos };
      return false;
    }
    return true;
  });
  if (!found) throw new Error("toc_block not found");
  return found;
}

describe("toc block parsing", () => {
  it("parses a standalone [toc] paragraph into toc_block", () => {
    const { node } = findTocBlock(parseMarkdown(TOC_DOC));
    expect(isTocBlock(node)).toBe(true);
    expect(node.attrs.source).toBe("[toc]");
  });

  it("keeps the authored spelling ([toc] / [TOC]) in round trips", () => {
    expect(roundTripMarkdown(TOC_DOC)).toBe(TOC_DOC);
    const upper = "[TOC]\n\n# 标题\n";
    expect(findTocBlock(parseMarkdown(upper)).node.attrs.source).toBe("[TOC]");
    expect(roundTripMarkdown(upper)).toBe(upper);
  });

  it("leaves look-alike text as plain paragraphs", () => {
    for (const [source, canonical] of [
      // 普通文本里的方括号在序列化时按惯例转义（既有行为）。
      ["[toc ]\n", "\\[toc \\]\n"],
      ["[Toc]\n", "\\[Toc\\]\n"],
      ["前置 [toc]\n", "前置 \\[toc\\]\n"],
      ["[toc]x\n", "\\[toc\\]x\n"],
      ["> [toc]\n", "> \\[toc\\]\n"],
      ["- [toc]\n", "- \\[toc\\]\n"],
    ] as const) {
      const doc = parseMarkdown(source);
      let found = false;
      doc.descendants((node) => {
        if (node.type.name === "toc_block") found = true;
        return true;
      });
      expect(found).toBe(false);
      expect(roundTripMarkdown(source)).toBe(canonical);
    }
  });
});

function createTocView(source = TOC_DOC): EditorView {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return new EditorView(host, {
    state: EditorState.create({
      doc: parseMarkdown(source),
      plugins: [tocBlockPlugin()],
    }),
  });
}

describe("toc node view", () => {
  it("lists headings nested by level", () => {
    const view = createTocView();
    const wrapper = view.dom.querySelector(".markdesk-toc")!;
    expect(wrapper).not.toBeNull();
    const links = Array.from(wrapper.querySelectorAll("a"));
    expect(links.map((link) => link.textContent)).toEqual([
      "一级标题",
      "二级标题",
    ]);
    // 二级标题嵌套在一级标题的 <li> 内。
    const nested = wrapper.querySelectorAll("ul ul");
    expect(nested.length).toBe(1);
    expect(nested[0].querySelector("a")!.textContent).toBe("二级标题");
    view.destroy();
  });

  it("refreshes entries when the document changes", () => {
    const view = createTocView();
    view.dispatch(
      view.state.tr.insert(
        view.state.doc.content.size,
        markdownSchema.nodes.heading.create(
          { level: 3 },
          markdownSchema.text("三级标题"),
        ),
      ),
    );
    const links = Array.from(
      view.dom.querySelectorAll(".markdesk-toc a"),
    );
    expect(links.map((link) => link.textContent)).toContain("三级标题");
    view.destroy();
  });

  it("jumps to the heading when an entry is clicked", () => {
    const view = createTocView();
    const headingPos = (() => {
      let pos = -1;
      view.state.doc.descendants((node, at) => {
        if (pos >= 0) return false;
        if (node.type.name === "heading" && node.textContent === "二级标题") {
          pos = at;
          return false;
        }
        return true;
      });
      return pos;
    })();
    expect(headingPos).toBeGreaterThan(0);

    const link = Array.from(
      view.dom.querySelectorAll<HTMLAnchorElement>(".markdesk-toc a"),
    ).find((item) => item.textContent === "二级标题")!;
    link.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    // 选区落到目标标题处（跳转后光标在标题内部或紧邻）。
    const { from } = view.state.selection;
    expect(from).toBeGreaterThanOrEqual(headingPos);
    expect(from).toBeLessThanOrEqual(headingPos + 5);
    view.destroy();
  });

  it("shows a hint when the document has no headings", () => {
    const view = createTocView("[toc]\n\n只有正文\n");
    expect(view.dom.querySelector(".markdesk-toc")!.textContent).toContain(
      "暂无标题",
    );
    view.destroy();
  });
});

describe("toc HTML export", () => {
  it("expands [toc] into an anchored navigation list", async () => {
    const html = await buildExportHtml(parseMarkdown(TOC_DOC), "light");
    expect(html).toContain('class="markdesk-toc-export"');
    // 标题获得锚点 id，目录条目以 #fragment 链接到它们。
    expect(html).toContain('id="md-toc-h-0"');
    expect(html).toContain('href="#md-toc-h-0"');
    expect(html).toContain('href="#md-toc-h-1"');
    // 占位 div 不再出现。
    expect(html).not.toContain("data-markdesk-toc");
  });

  it("keeps headings unmodified when no [toc] is present", async () => {
    const html = await buildExportHtml(
      parseMarkdown("# 标题\n\n正文\n"),
      "light",
    );
    expect(html).not.toContain('class="markdesk-toc-export"');
    expect(html).not.toContain('id="md-toc-h-0"');
  });
});

// 无头视图 + 逐字符输入；回车经 pendingSyntax 拦截。
function createInputView(): EditorView {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const doc = markdownSchema.nodes.doc.createAndFill(
    {},
    markdownSchema.nodes.paragraph.create(),
  )!;
  return new EditorView(host, {
    state: EditorState.create({
      doc,
      selection: TextSelection.near(doc.resolve(1), 1),
      plugins: createEditorPlugins(),
    }),
  });
}

function typeText(view: EditorView, text: string): void {
  for (const ch of text) {
    const from = view.state.selection.from;
    const handled = view.someProp(
      "handleTextInput",
      (handler) => handler(view, from, from, ch) || false,
    );
    if (!handled) view.dispatch(view.state.tr.insertText(ch));
  }
}

function pressEnter(view: EditorView): boolean {
  return (
    view.someProp(
      "handleKeyDown",
      (handler) =>
        handler(
          view,
          ({ key: "Enter", isComposing: false, preventDefault() {} }) as never,
        ) || false,
    ) ?? false
  );
}

describe("toc input conversion", () => {
  it("turns [toc] + Enter into a toc block followed by a paragraph", () => {
    const view = createInputView();
    typeText(view, "[toc]");
    expect(pressEnter(view)).toBe(true);
    const { node, pos } = findTocBlock(view.state.doc);
    expect(node.attrs.source).toBe("[toc]");
    // 光标进入目录块后方的空段落。
    expect(view.state.selection.from).toBe(pos + node.nodeSize + 1);
    view.destroy();
  });

  it("keeps the [TOC] spelling and rejects trailing content", () => {
    const view = createInputView();
    typeText(view, "[TOC]");
    expect(pressEnter(view)).toBe(true);
    expect(findTocBlock(view.state.doc).node.attrs.source).toBe("[TOC]");
    view.destroy();

    // 行内除 [toc] 外还有内容时不转换：回车可能由 base keymap 兜底
    // 续行（pressEnter 仍为 true），但文档里不应出现目录块。
    const plain = createInputView();
    typeText(plain, "[toc] 备注");
    expect(pressEnter(plain)).toBe(true);
    let found = false;
    plain.state.doc.descendants((node) => {
      if (node.type.name === "toc_block") found = true;
      return true;
    });
    expect(found).toBe(false);
    plain.destroy();
  });
});
