// @vitest-environment jsdom
// mermaid 图表支持：解析/识别、WYSIWYG NodeView 的编辑切换，以及
// HTML 导出中的 SVG 内嵌与消毒。真实渲染器在此整体 mock——jsdom 无
// 布局能力，且单测无需加载约 2MB 的 mermaid。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Node } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { parseMarkdown } from "../../src/markdown/parser";
import { buildExportHtml } from "../../src/main/editor/exportHtml";
import {
  isMermaidBlock,
  mermaidBlockPlugin,
} from "../../src/main/editor/mermaidBlock";
import { renderMermaidDiagram } from "../../src/main/editor/mermaidRender";

vi.mock("../../src/main/editor/mermaidRender", () => ({
  MERMAID_LANGUAGE: "mermaid",
  renderMermaidDiagram: vi.fn(),
}));

const fakeRender = vi.mocked(renderMermaidDiagram);

const MERMAID_DOC = "前文\n\n```mermaid\ngraph TD\nA-->B\n```\n\n后文\n";

function findBlock(doc: Node, language: string): { node: Node; pos: number } {
  let found: { node: Node; pos: number } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === "code_block" && node.attrs.language === language) {
      found = { node, pos };
      return false;
    }
    return true;
  });
  if (!found) throw new Error(`code_block(${language}) not found`);
  return found;
}

function createMermaidView(): EditorView {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return new EditorView(host, {
    state: EditorState.create({
      doc: parseMarkdown(MERMAID_DOC),
      plugins: [mermaidBlockPlugin()],
    }),
  });
}

describe("mermaid block recognition", () => {
  it("parses a mermaid fence into a code_block keeping the language", () => {
    const { node } = findBlock(parseMarkdown(MERMAID_DOC), "mermaid");
    expect(node.textContent).toBe("graph TD\nA-->B\n");
    expect(isMermaidBlock(node)).toBe(true);
  });

  it("matches the language case-insensitively and ignores blanks", () => {
    const { node } = findBlock(
      parseMarkdown("```Mermaid \nx\n```\n"),
      "Mermaid",
    );
    expect(isMermaidBlock(node)).toBe(true);
  });

  it("does not treat ordinary code blocks as diagrams", () => {
    const { node } = findBlock(parseMarkdown("```js\nlet x;\n```\n"), "js");
    expect(isMermaidBlock(node)).toBe(false);
  });
});

describe("mermaid node view", () => {
  beforeEach(() => {
    fakeRender.mockReset();
    fakeRender.mockResolvedValue({ kind: "svg", svg: "<svg><g/></svg>" });
  });

  it("renders the diagram and switches to source while editing", async () => {
    vi.useFakeTimers();
    try {
      const view = createMermaidView();
      const wrapper = view.dom.querySelector(".markdesk-mermaid");
      expect(wrapper).not.toBeNull();
      // 非 mermaid 代码块不被接管：文档里没有额外的自定义视图。
      expect(view.dom.querySelectorAll(".markdesk-mermaid").length).toBe(1);

      // 初始（光标在块外）经防抖后渲染出图。
      await vi.advanceTimersByTimeAsync(250);
      expect(fakeRender).toHaveBeenCalledWith("graph TD\nA-->B\n");
      const preview = wrapper!.querySelector(".markdesk-mermaid-preview");
      expect(preview!.innerHTML).toContain("<svg");

      // 光标进入块内 → 切换为源码编辑，预览隐藏。
      const { pos, node } = findBlock(view.state.doc, "mermaid");
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.near(view.state.doc.resolve(pos + 2)),
        ),
      );
      expect(wrapper!.classList.contains("is-editing")).toBe(true);
      expect((node.textContent ?? "").length).toBeGreaterThan(0);

      // 光标移出 → 回到图形，并按最终源码补渲染。
      const after = view.state.doc.content.size;
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.near(view.state.doc.resolve(after - 2), -1),
        ),
      );
      expect(wrapper!.classList.contains("is-editing")).toBe(false);
      await vi.advanceTimersByTimeAsync(250);
      expect(fakeRender).toHaveBeenCalledTimes(2);
      view.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows an error state instead of throwing on invalid sources", async () => {
    vi.useFakeTimers();
    try {
      fakeRender.mockResolvedValue({
        kind: "error",
        message: "Parse error on line 2",
      });
      const view = createMermaidView();
      await vi.advanceTimersByTimeAsync(250);
      const wrapper = view.dom.querySelector(".markdesk-mermaid")!;
      expect(wrapper.classList.contains("has-error")).toBe(true);
      expect(wrapper.textContent).toContain("Parse error on line 2");
      view.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("mermaid HTML export", () => {
  it("embeds the sanitized SVG instead of the code block", async () => {
    const html = await buildExportHtml(
      parseMarkdown(MERMAID_DOC),
      "light",
      async () =>
        '<svg id="d"><script>alert(1)</script><path d="M0 0"/></svg>',
    );
    expect(html).toContain('class="markdesk-mermaid-export"');
    expect(html).toContain("<svg");
    // SVG 内的脚本在导出中被剥除。
    expect(html).not.toContain("<script");
    // 对应代码块被整体替换，不再以源码形式出现。
    expect(html).not.toContain('data-language="mermaid"');
  });

  it("keeps the source code block when rendering fails", async () => {
    const html = await buildExportHtml(
      parseMarkdown(MERMAID_DOC),
      "light",
      async () => null,
    );
    expect(html).not.toContain('class="markdesk-mermaid-export"');
    expect(html).toContain('data-language="mermaid"');
    expect(html).toContain("graph TD");
  });

  it("leaves documents without diagrams untouched", async () => {
    const html = await buildExportHtml(
      parseMarkdown("```js\nlet x;\n```\n"),
      "light",
    );
    expect(html).toContain('data-language="js"');
    expect(html).not.toContain('class="markdesk-mermaid-export"');
  });
});
