// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { markdownSchema } from "../../src/markdown/schema";
import { parseMarkdown } from "../../src/markdown/parser";
import { serializeMarkdown } from "../../src/markdown/serializer";
import { createEditorPlugins } from "../../src/main/components/WysiwygEditor";

// jsdom 的 Range/Text 没有 getClientRects；回车续行与撤销（splitBlock、
// scrollIntoView 等）会触发坐标计算，这里补零尺寸矩形桩（真实
// Chromium 无此问题）。
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

// 无头视图 + 逐字符触发 handleTextInput，等价于真实键盘输入路径
// （inputRules 插件正是经该 prop 驱动的）。
function createView(source = "正文\n"): EditorView {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return new EditorView(host, {
    state: EditorState.create({
      schema: markdownSchema,
      doc: parseMarkdown(source),
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

// 触发回车键（pendingSyntax 插件在 base keymap 之前拦截）。
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

function placeCursorAtParagraphStart(view: EditorView): void {
  // doc 内第一个块的内容起点（pos 1）。
  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.near(view.state.doc.resolve(1), 1),
    ),
  );
}

function firstBlock(view: EditorView): PMNode {
  const node = view.state.doc.content.firstChild;
  if (!node) throw new Error("document is empty");
  return node;
}

describe("行内 Markdown 规则（即时转换）", () => {
  it("输入 **文字** 应用加粗", () => {
    const view = createView();
    placeCursorAtParagraphStart(view);
    typeText(view, "**重点**");
    const text = firstBlock(view).content.firstChild;
    expect(text?.marks.map((mark) => mark.type.name)).toContain("strong");
    expect(text?.textContent).toBe("重点");
    view.destroy();
  });

  it("输入 *文字* 应用斜体且不误吞 ** 加粗", () => {
    const view = createView();
    placeCursorAtParagraphStart(view);
    typeText(view, "前缀 *斜体*");
    const emNodes: PMNode[] = [];
    firstBlock(view).content.forEach((node) => {
      if (node.marks.some((mark) => mark.type.name === "em")) {
        emNodes.push(node);
      }
    });
    expect(emNodes).toHaveLength(1);
    expect(emNodes[0].textContent).toBe("斜体");
    view.destroy();
  });

  it("输入 `代码` 与 ~~删除线~~ 应用对应样式", () => {
    const view = createView();
    placeCursorAtParagraphStart(view);
    typeText(view, "`x=y`");
    expect(
      firstBlock(view).content.firstChild?.marks.map((m) => m.type.name),
    ).toContain("code");

    const view2 = createView();
    placeCursorAtParagraphStart(view2);
    typeText(view2, "~~旧的~~");
    expect(
      firstBlock(view2).content.firstChild?.marks.map((m) => m.type.name),
    ).toContain("strikethrough");
    view.destroy();
    view2.destroy();
  });

  it("输入 [文字](地址) 创建链接，非法地址保持原文", () => {
    const view = createView();
    placeCursorAtParagraphStart(view);
    typeText(view, "[官网](https://example.com)");
    const text = firstBlock(view).content.firstChild;
    expect(text?.marks.map((mark) => mark.type.name)).toContain("link");
    expect(text?.textContent).toBe("官网");

    const view2 = createView();
    placeCursorAtParagraphStart(view2);
    typeText(view2, "[危险](javascript:alert(1))");
    expect(view2.state.doc.textContent).toContain(
      "[危险](javascript:alert(1))",
    );
    view.destroy();
    view2.destroy();
  });
});

describe("块级语法缓冲（回车确认）", () => {
  it("输入 “# 标题” 保持段落并显示预览，回车转为标题并续行", () => {
    const view = createView();
    placeCursorAtParagraphStart(view);
    typeText(view, "# 标题");

    // 缓冲：仍是段落，标记浅色 + 文字加粗预览。
    expect(firstBlock(view).type.name).toBe("paragraph");
    expect(firstBlock(view).textContent).toBe("# 标题正文");
    expect(view.dom.querySelector(".md-syntax-marker")).not.toBeNull();
    expect(view.dom.querySelector(".md-syntax-heading-preview")).not.toBeNull();

    expect(pressEnter(view)).toBe(true);
    expect(firstBlock(view).type.name).toBe("heading");
    expect(firstBlock(view).attrs.level).toBe(1);
    expect(firstBlock(view).textContent).toBe("标题正文");
    // 与普通回车一致：光标落在下方新段落。
    expect(view.state.doc.childCount).toBe(2);
    expect(view.state.doc.child(1).type.name).toBe("paragraph");
    expect(view.state.selection.$from.parent).toBe(view.state.doc.child(1));
    view.destroy();
  });

  it("仅输入 “# ”（无正文）不显示预览，回车仍转为空标题", () => {
    const view = createView();
    placeCursorAtParagraphStart(view);
    typeText(view, "# ");
    expect(view.dom.querySelector(".md-syntax-marker")).toBeNull();

    expect(pressEnter(view)).toBe(true);
    expect(firstBlock(view).type.name).toBe("heading");
    view.destroy();
  });

  it("“###### ” 支持到六级标题", () => {
    const view = createView();
    placeCursorAtParagraphStart(view);
    typeText(view, "###### 六级");
    expect(pressEnter(view)).toBe(true);
    expect(firstBlock(view).type.name).toBe("heading");
    expect(firstBlock(view).attrs.level).toBe(6);
    view.destroy();
  });

  it("“> 引用” 回车转为引用块，光标留在引用内新行", () => {
    const view = createView();
    placeCursorAtParagraphStart(view);
    typeText(view, "> 引用");
    expect(firstBlock(view).type.name).toBe("paragraph");
    expect(view.dom.querySelector(".md-syntax-quote-preview")).not.toBeNull();

    expect(pressEnter(view)).toBe(true);
    const quote = firstBlock(view);
    expect(quote.type.name).toBe("blockquote");
    expect(quote.childCount).toBe(2);
    expect(quote.child(0).textContent).toBe("引用正文");
    expect(quote.child(1).textContent).toBe("");
    view.destroy();
  });

  it("行首输入 “- ” 立即转为无序列表（含既有正文）", () => {
    const view = createView();
    placeCursorAtParagraphStart(view);
    typeText(view, "-");
    expect(firstBlock(view).type.name).toBe("paragraph");
    typeText(view, " ");
    const list = firstBlock(view);
    expect(list.type.name).toBe("bullet_list");
    expect(list.childCount).toBe(1);
    // 既有正文保留为列表项内容。
    expect(list.child(0).child(0).textContent).toBe("正文");
    view.destroy();
  });

  it("行首输入 “3. ” 立即转为有序列表并保留起始编号", () => {
    const view = createView();
    placeCursorAtParagraphStart(view);
    typeText(view, "3. ");
    const list = firstBlock(view);
    expect(list.type.name).toBe("ordered_list");
    expect(list.attrs.start).toBe(3);
    expect(list.child(0).child(0).textContent).toBe("正文");
    view.destroy();
  });

  it("段中输入 “- ” 不转为列表", () => {
    const view = createView();
    const end = view.state.doc.content.size;
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.near(view.state.doc.resolve(end - 1), 1),
      ),
    );
    typeText(view, "- ");
    expect(firstBlock(view).type.name).toBe("paragraph");
    view.destroy();
  });

  it("``` 单词 回车转为代码块并把单词识别为语言", () => {
    const view = createView();
    placeCursorAtParagraphStart(view);
    typeText(view, "```js");
    expect(pressEnter(view)).toBe(true);
    const block = firstBlock(view);
    expect(block.type.name).toBe("code_block");
    expect(block.attrs.language).toBe("js");
    // 标记与语言串被清除，原有正文保留为代码内容。
    expect(block.textContent).toBe("正文");
    // 代码围栏不续行。
    expect(view.state.doc.childCount).toBe(1);
    view.destroy();
  });

  it("“---” 回车转为分隔线，光标进入其后空段落", () => {
    const view = createView();
    placeCursorAtParagraphStart(view);
    typeText(view, "---");
    expect(pressEnter(view)).toBe(true);
    expect(firstBlock(view).type.name).toBe("horizontal_rule");
    expect(view.state.doc.child(1).type.name).toBe("paragraph");
    view.destroy();
  });

  it("缓冲提交后序列化为合法 Markdown", () => {
    const view = createView();
    placeCursorAtParagraphStart(view);
    typeText(view, "# 标题文本");
    expect(pressEnter(view)).toBe(true);
    expect(serializeMarkdown(view.state.doc)).toContain("# 标题文本");
    view.destroy();
  });

  it("段中输入 “# ” 不触发缓冲或转换", () => {
    const view = createView();
    const end = view.state.doc.content.size;
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.near(view.state.doc.resolve(end - 1), 1),
      ),
    );
    typeText(view, "# ");
    expect(firstBlock(view).type.name).toBe("paragraph");
    expect(view.dom.querySelector(".md-syntax-marker")).toBeNull();
    view.destroy();
  });

  it("列表项内结构不允许时不吞回车（schema 首子节点须为段落）", () => {
    const view = createView();
    placeCursorAtParagraphStart(view);
    typeText(view, "- 项目");
    expect(pressEnter(view)).toBe(true);
    // 光标在列表第二项的空段落里，输入 “> 引用” 后回车：
    // 引用无法作为列表项首子节点，回车交回普通 Enter 处理。
    typeText(view, "> 引用");
    pressEnter(view);
    // someProp 链会让 base keymap 的普通回车兜底，这里断言结果：
    // 不产生引用块，原文原样保留。
    expect(view.dom.querySelector("blockquote")).toBeNull();
    expect(view.state.doc.textContent).toContain("> 引用");
    view.destroy();
  });

  it("标题缓冲提交后 Ctrl+Z 一次可撤销转换", () => {
    const view = createView();
    placeCursorAtParagraphStart(view);
    typeText(view, "# 标题");
    expect(pressEnter(view)).toBe(true);
    expect(firstBlock(view).type.name).toBe("heading");

    const handled = view.someProp(
      "handleKeyDown",
      (handler) =>
        handler(
          view,
          ({
            key: "z",
            ctrlKey: true,
            isComposing: false,
            preventDefault() {},
          }) as never,
        ) || false,
    );
    expect(handled).toBe(true);
    expect(firstBlock(view).type.name).toBe("paragraph");
    view.destroy();
  });
});
