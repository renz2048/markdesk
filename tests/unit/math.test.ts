// @vitest-environment jsdom
// 数学公式块支持（#5）：$$…$$ 的解析与逐字往返、WYSIWYG NodeView 的
// 编辑切换、HTML 导出中的 SVG 内嵌与消毒、$$ + 回车的输入转换。
// 真实渲染器在此整体 mock——单测无需加载约 1.5MB 的 mathjax。
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Node } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { parseMarkdown } from "../../src/markdown/parser";
import { roundTripMarkdown } from "../../src/markdown/roundTrip";
import { markdownSchema } from "../../src/markdown/schema";
import { serializeMarkdown } from "../../src/markdown/serializer";
import { buildExportHtml } from "../../src/main/editor/exportHtml";
import { isMathBlock, mathBlockPlugin } from "../../src/main/editor/mathBlock";
import { renderMathSvg } from "../../src/main/editor/mathRender";
import { createEditorPlugins } from "../../src/main/components/WysiwygEditor";

vi.mock("../../src/main/editor/mathRender", () => ({
  renderMathSvg: vi.fn(),
}));

const fakeRender = vi.mocked(renderMathSvg);

const MATH_DOC = "前文\n\n$$\n\\frac{a}{b}\n$$\n\n后文\n";

// issue #5 的原始示例（行列式）。
const ISSUE_EXAMPLE =
  "$$\n\\mathbf{V}_1 \\times \\mathbf{V}_2 =  \\begin{vmatrix}\n\\mathbf{i} & \\mathbf{j} & \\mathbf{k} \\\\\n\\frac{\\partial X}{\\partial u} &  \\frac{\\partial Y}{\\partial u} & 0 \\\\\n\\frac{\\partial X}{\\partial v} &  \\frac{\\partial Y}{\\partial v} & 0 \\\\\n\\end{vmatrix}\n$$\n";

// jsdom 的 Range/Text 没有 getClientRects；编辑器交互会触发坐标计算，
// 这里补零尺寸矩形桩（真实 Chromium 无此问题）。
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

function findMathBlock(doc: Node): { node: Node; pos: number } {
  let found: { node: Node; pos: number } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === "math_block") {
      found = { node, pos };
      return false;
    }
    return true;
  });
  if (!found) throw new Error("math_block not found");
  return found;
}

function countMathBlocks(doc: Node): number {
  let count = 0;
  doc.descendants((node) => {
    if (node.type.name === "math_block") count += 1;
    return true;
  });
  return count;
}

describe("math block parsing", () => {
  it("parses $$ blocks into math_block keeping the inner source verbatim", () => {
    const { node } = findMathBlock(parseMarkdown(MATH_DOC));
    expect(node.textContent).toBe("\n\\frac{a}{b}\n");
    expect(isMathBlock(node)).toBe(true);
  });

  it("round-trips the issue example character for character", () => {
    expect(roundTripMarkdown(ISSUE_EXAMPLE)).toBe(ISSUE_EXAMPLE);
  });

  it("round-trips multi-line, single-line, padded and empty forms", () => {
    for (const source of [
      "$$\nx\n$$\n",
      "$$x$$\n",
      "$$ x $$\n",
      "$$$$\n",
      "$$a$$b$$\n",
    ]) {
      expect(roundTripMarkdown(source)).toBe(source);
    }
  });

  it("leaves unterminated or embedded $$ text as plain paragraphs", () => {
    for (const source of [
      "$$\n",
      "$$x\n",
      "a$$x$$\n",
      "$$x$$ 后缀\n",
      "> $$x$$\n",
      "- $$x$$\n",
    ]) {
      const doc = parseMarkdown(source);
      expect(countMathBlocks(doc)).toBe(0);
      expect(roundTripMarkdown(source)).toBe(source);
    }
  });
});

function createMathView(source = MATH_DOC): EditorView {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return new EditorView(host, {
    state: EditorState.create({
      doc: parseMarkdown(source),
      plugins: [mathBlockPlugin()],
    }),
  });
}

describe("math node view", () => {
  beforeEach(() => {
    fakeRender.mockReset();
    fakeRender.mockResolvedValue({ kind: "svg", svg: "<svg><path/></svg>" });
  });

  it("renders the formula and switches to source while editing", async () => {
    vi.useFakeTimers();
    try {
      const view = createMathView();
      const wrapper = view.dom.querySelector(".markdesk-math");
      expect(wrapper).not.toBeNull();

      // 初始（光标在块外）经防抖后渲染出公式。
      await vi.advanceTimersByTimeAsync(250);
      expect(fakeRender).toHaveBeenCalledWith("\n\\frac{a}{b}\n");
      const preview = wrapper!.querySelector(".markdesk-math-preview");
      expect(preview!.innerHTML).toContain("<svg");

      // 光标进入块内 → 切换为源码编辑，预览隐藏。
      const { pos } = findMathBlock(view.state.doc);
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.near(view.state.doc.resolve(pos + 2)),
        ),
      );
      expect(wrapper!.classList.contains("is-editing")).toBe(true);

      // 光标移出 → 回到预览，并按最终源码补渲染。
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

  it("shows a placeholder for empty blocks and errors for invalid TeX", async () => {
    vi.useFakeTimers();
    try {
      const view = createMathView("$$$$\n");
      await vi.advanceTimersByTimeAsync(250);
      const wrapper = view.dom.querySelector(".markdesk-math")!;
      expect(wrapper.classList.contains("is-rendered")).toBe(false);
      expect(wrapper.textContent).toContain("数学公式");
      view.destroy();

      fakeRender.mockResolvedValue({
        kind: "error",
        message: "Undefined macro \\foo",
      });
      const errorView = createMathView("正文\n\n$$\\foo$$\n");
      await vi.advanceTimersByTimeAsync(250);
      const errorWrapper = errorView.dom.querySelector(".markdesk-math")!;
      expect(errorWrapper.classList.contains("has-error")).toBe(true);
      expect(errorWrapper.textContent).toContain("Undefined macro \\foo");
      errorView.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("math HTML export", () => {
  it("embeds the sanitized SVG instead of the source block", async () => {
    const html = await buildExportHtml(
      parseMarkdown(MATH_DOC),
      "light",
      async () => null,
      async () =>
        '<svg id="m"><script>alert(1)</script><path d="M0 0"/></svg>',
    );
    expect(html).toContain('class="markdesk-math-export"');
    expect(html).toContain("<svg");
    // SVG 内的脚本在导出中被剥除。
    expect(html).not.toContain("<script");
    expect(html).not.toContain('data-language="math"');
  });

  it("keeps the TeX source when rendering fails", async () => {
    const html = await buildExportHtml(
      parseMarkdown(MATH_DOC),
      "light",
      async () => null,
      async () => null,
    );
    expect(html).not.toContain('class="markdesk-math-export"');
    expect(html).toContain('data-language="math"');
    expect(html).toContain("\\frac{a}{b}");
  });

  it("leaves documents without formulas untouched", async () => {
    const html = await buildExportHtml(
      parseMarkdown("```js\nlet x;\n```\n"),
      "light",
    );
    expect(html).toContain('data-language="js"');
    expect(html).not.toContain('class="markdesk-math-export"');
  });
});

// 无头视图 + 逐字符输入，等价于真实键盘路径；回车经 pendingSyntax 拦截。
// 初始文档是一个空段落（markdown 不产生空段落，这里直接构造模型）。
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

describe("math input conversion", () => {
  beforeEach(() => {
    fakeRender.mockReset();
    fakeRender.mockResolvedValue({ kind: "svg", svg: "<svg><path/></svg>" });
  });

  it("turns $$ + Enter into an empty math block with the caret inside", () => {
    const view = createInputView();
    typeText(view, "$$");
    expect(pressEnter(view)).toBe(true);
    expect(countMathBlocks(view.state.doc)).toBe(1);
    const { node, pos } = findMathBlock(view.state.doc);
    expect(node.textContent).toBe("");
    expect(view.state.selection.from).toBeGreaterThan(pos);
    view.destroy();
  });

  it("turns $$source$$ + Enter into a math block with the source", () => {
    const view = createInputView();
    typeText(view, "$$\\frac{a}{b}$$");
    expect(pressEnter(view)).toBe(true);
    const { node } = findMathBlock(view.state.doc);
    expect(node.textContent).toBe("\\frac{a}{b}");
    expect(serializeMarkdown(view.state.doc)).toBe("$$\\frac{a}{b}$$\n");
    view.destroy();
  });

  it("does not swallow Enter when the line is not a complete math block", () => {
    const view = createInputView();
    typeText(view, "$$ 价格说明");
    // 回车由 base keymap 兜底续行（pressEnter 为 true），但内容仍是
    // 普通段落，不应出现公式块。
    expect(pressEnter(view)).toBe(true);
    expect(countMathBlocks(view.state.doc)).toBe(0);
    view.destroy();
  });
});
