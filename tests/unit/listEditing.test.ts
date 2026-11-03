// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { markdownSchema } from "../../src/markdown/schema";
import { parseMarkdown } from "../../src/markdown/parser";
import { createEditorPlugins } from "../../src/main/components/WysiwygEditor";

// jsdom 的 Range/Text 没有 getClientRects；splitListItem 等命令的
// scrollIntoView 会触发坐标计算，补零尺寸矩形桩。
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

function createView(source: string): EditorView {
  const host = document.createElement("div");
  document.body.appendChild(host);
  // parseMarkdown("") 是零块文档；真实应用里空文档靠 gap cursor 承接
  // 输入，测试里直接构造“单个空段落”文档更贴近打字起点。
  const doc =
    source === ""
      ? markdownSchema.topNodeType.create(null, [
          markdownSchema.nodes.paragraph.create(),
        ])
      : parseMarkdown(source);
  return new EditorView(host, {
    state: EditorState.create({
      schema: markdownSchema,
      doc,
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

function pressKey(view: EditorView, key: string, shift = false): boolean {
  return (
    view.someProp(
      "handleKeyDown",
      (handler) =>
        handler(
          view,
          ({
            key,
            shiftKey: shift,
            isComposing: false,
            preventDefault() {},
          }) as never,
        ) || false,
    ) ?? false
  );
}

/** 把光标放到指定列表项首段的末尾（itemIndex 从 0 起）。 */
function placeAtItemEnd(view: EditorView, itemIndex: number): void {
  const doc = view.state.doc;
  const list = doc.content.firstChild;
  if (!list || !list.child(itemIndex)) throw new Error("列表项不存在");
  let pos = 1; // 列表内容起点
  for (let i = 0; i < itemIndex; i += 1) pos += list.child(i).nodeSize;
  const item = list.child(itemIndex);
  const paragraphEnd = pos + 2 + item.child(0).content.size;
  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.near(doc.resolve(paragraphEnd), -1),
    ),
  );
}

function firstBlock(view: EditorView) {
  const node = view.state.doc.content.firstChild;
  if (!node) throw new Error("文档为空");
  return node;
}

/** 按文本定位列表项段落末尾并放置光标（文本需在文档中唯一）。 */
function placeCursorAtItemText(view: EditorView, text: string): void {
  let target = -1;
  view.state.doc.descendants((node, pos) => {
    if (target >= 0) return false;
    if (node.type.name === "paragraph" && node.textContent === text) {
      target = pos + 1 + node.content.size;
      return false;
    }
    return true;
  });
  if (target < 0) throw new Error(`未找到文本为 ${text} 的段落`);
  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.near(view.state.doc.resolve(target), -1),
    ),
  );
}

const scenarios = [
  { name: "无序列表", marker: "- ", listType: "bullet_list", nestedIndent: "  " },
  { name: "有序列表", marker: "1. ", listType: "ordered_list", nestedIndent: "   " },
];

for (const { name, marker, listType, nestedIndent } of scenarios) {
  describe(`${name}（需求3 场景）`, () => {
    it("场景1：行首 “" + marker + "” 立即成表，项内回车续出空项", () => {
      const view = createView("");
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.near(view.state.doc.resolve(1), 1),
        ),
      );
      typeText(view, `${marker}1`);
      const converted = firstBlock(view);
      expect(converted.type.name).toBe(listType);
      expect(converted.childCount).toBe(1);

      expect(pressKey(view, "Enter")).toBe(true);
      const list = firstBlock(view);
      expect(list.childCount).toBe(2);
      expect(list.child(0).child(0).textContent).toBe("1");
      expect(list.child(1).child(0).textContent).toBe("");
      // 光标落入新的空项。
      expect(view.state.selection.$from.node(-1)).toBe(list.child(1));
      view.destroy();
    });

    it("场景2：第二项 Tab 缩进为子列表，第一项 Tab 无效果", () => {
      const view = createView(`${marker}1\n${marker}2\n`);
      expect(firstBlock(view).type.name).toBe(listType);

      placeAtItemEnd(view, 1);
      expect(pressKey(view, "Tab")).toBe(true);
      const outer = firstBlock(view);
      expect(outer.childCount).toBe(1);
      const firstItem = outer.child(0);
      expect(firstItem.childCount).toBe(2);
      expect(firstItem.child(1).type.name).toBe(listType);
      expect(firstItem.child(1).child(0).child(0).textContent).toBe("2");

      // 第一项 Tab：无缩进目标，按键被吞但不改结构。
      placeAtItemEnd(view, 0);
      expect(pressKey(view, "Tab")).toBe(true);
      expect(firstBlock(view).childCount).toBe(1);
      view.destroy();
    });

    it("场景3：空项回车退出列表并落到新行", () => {
      const view = createView(`${marker}1\n${marker}2\n`);
      placeAtItemEnd(view, 1);
      expect(pressKey(view, "Enter")).toBe(true);
      // 续出第三项（空项）。
      expect(firstBlock(view).childCount).toBe(3);

      // 空项再次回车：退出列表，剩两项 + 列表后的普通段落。
      expect(pressKey(view, "Enter")).toBe(true);
      const doc = view.state.doc;
      expect(doc.childCount).toBe(2);
      const list = doc.child(0);
      expect(list.type.name).toBe(listType);
      expect(list.childCount).toBe(2);
      expect(doc.child(1).type.name).toBe("paragraph");
      expect(doc.child(1).content.size).toBe(0);
      // 光标在新段落开头。
      expect(view.state.selection.$from.parent).toBe(doc.child(1));
      view.destroy();
    });

    it("需求5.1：三层列表空项回车逐级退层（四连回车）", () => {
      const view = createView(
        `${marker}1\n${marker}2\n${nestedIndent}${marker}21\n` +
          `${nestedIndent}${marker}22\n${nestedIndent}${nestedIndent}${marker}221\n` +
          `${nestedIndent}${nestedIndent}${marker}222\n`,
      );
      placeCursorAtItemText(view, "222");

      const top = () => firstBlock(view);
      const second = () => top().child(1).child(1);
      const third = () => second().child(1).child(1);
      const cursorParentText = () =>
        view.state.selection.$from.parent.textContent;

      // 回车1：222 行尾续出 3 层空项。
      expect(pressKey(view, "Enter")).toBe(true);
      expect(third().childCount).toBe(3);
      expect(cursorParentText()).toBe("");

      // 回车2：空项原位升到 2 层（3 层列表收回 221/222），
      // 光标仍留在空项内等待输入。
      expect(pressKey(view, "Enter")).toBe(true);
      expect(third().childCount).toBe(2);
      expect(second().childCount).toBe(3);
      expect(second().child(2).child(0).content.size).toBe(0);
      expect(cursorParentText()).toBe("");

      // 回车3：空项升到 1 层。
      expect(pressKey(view, "Enter")).toBe(true);
      expect(second().childCount).toBe(2);
      expect(top().childCount).toBe(3);
      expect(top().child(2).child(0).content.size).toBe(0);
      expect(cursorParentText()).toBe("");

      // 回车4：顶层空项退出，落为列表后的普通段落。
      expect(pressKey(view, "Enter")).toBe(true);
      const doc = view.state.doc;
      expect(doc.childCount).toBe(2);
      expect(doc.child(0).type.name).toBe(listType);
      expect(doc.child(0).childCount).toBe(2);
      expect(doc.child(1).type.name).toBe("paragraph");
      expect(view.state.selection.$from.parent).toBe(doc.child(1));
      view.destroy();
    });

    it("需求4.2：两层嵌套列表空项回车逐级退出（三连回车）", () => {
      const view = createView(
        `${marker}1\n${marker}2\n${nestedIndent}${marker}21\n${nestedIndent}${marker}22\n`,
      );
      // 回车1：22 行尾续出 2 层空项。
      placeCursorAtItemText(view, "22");
      expect(pressKey(view, "Enter")).toBe(true);
      expect(firstBlock(view).child(1).child(1).childCount).toBe(3);

      // 回车2：空项原位升到 1 层，内层收回 21/22 两项。
      expect(pressKey(view, "Enter")).toBe(true);
      const outer = firstBlock(view);
      expect(outer.child(1).child(1).childCount).toBe(2);
      expect(outer.childCount).toBe(3);
      expect(outer.child(2).child(0).content.size).toBe(0);

      // 回车3：顶层空项退出，落为列表后的普通段落。
      expect(pressKey(view, "Enter")).toBe(true);
      const doc = view.state.doc;
      expect(doc.childCount).toBe(2);
      expect(doc.child(0).type.name).toBe(listType);
      expect(doc.child(0).childCount).toBe(2);
      expect(doc.child(1).type.name).toBe("paragraph");
      view.destroy();
    });

    it("内层唯一空项回车原位升为顶层项（内层列表保留）", () => {
      const view = createView(
        `${marker}1\n${marker}2\n${nestedIndent}${marker}21\n`,
      );
      placeCursorAtItemText(view, "21");
      pressKey(view, "Enter");
      // 内层现有 21 + 空项。
      expect(firstBlock(view).child(1).child(1).childCount).toBe(2);

      // 空项回车：升为顶层第三项，内层列表（仅 21）原样保留。
      expect(pressKey(view, "Enter")).toBe(true);
      const top = firstBlock(view);
      expect(top.childCount).toBe(3);
      expect(top.child(1).childCount).toBe(2); // 段“2” + 内层列表
      expect(top.child(1).child(1).childCount).toBe(1); // 仅 21
      expect(top.child(2).child(0).content.size).toBe(0);
      expect(view.state.selection.$from.parent.textContent).toBe("");
      view.destroy();
    });

    it("带子列表的项行尾回车：续出同级空项，子列表留在原项下", () => {
      const view = createView(
        `${marker}1\n${marker}2\n${nestedIndent}${marker}21\n` +
          `${nestedIndent}${marker}22\n${nestedIndent}${nestedIndent}${marker}221\n`,
      );
      placeCursorAtItemText(view, "22");
      expect(pressKey(view, "Enter")).toBe(true);
      const inner = firstBlock(view).child(1).child(1);
      // 22 的子列表（221）仍留在 22 之下。
      expect(inner.child(1).childCount).toBe(2); // 段 22 + 子列表
      // 新空项是 22 的同级后续项，光标落入其中。
      expect(inner.childCount).toBe(3);
      expect(inner.child(2).child(0).content.size).toBe(0);
      expect(view.state.selection.$from.parent.textContent).toBe("");
      view.destroy();
    });

    it("Shift-Tab 把缩进项提升回顶层", () => {
      const view = createView(`${marker}1\n${marker}2\n`);
      placeAtItemEnd(view, 1);
      pressKey(view, "Tab");

      // 内层列表首项段末（doc>list>item1>innerList>item2>para）。
      const outer = firstBlock(view);
      const innerStart = 1 + outer.child(0).child(0).nodeSize + 1;
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.near(
            view.state.doc.resolve(innerStart + 3),
            -1,
          ),
        ),
      );
      expect(pressKey(view, "Tab", true)).toBe(true);
      const restored = firstBlock(view);
      expect(restored.childCount).toBe(2);
      expect(restored.child(0).childCount).toBe(1);
      view.destroy();
    });
  });
}

describe("有序列表编号", () => {
  it("续项接续编号且 “3. ” 起始编号保留", () => {
    const view = createView("3. a\n3. b\n");
    const list = firstBlock(view);
    expect(list.type.name).toBe("ordered_list");
    expect(list.attrs.start).toBe(3);
    expect(list.childCount).toBe(2);

    placeAtItemEnd(view, 1);
    expect(pressKey(view, "Enter")).toBe(true);
    expect(firstBlock(view).childCount).toBe(3);
    view.destroy();
  });
});

describe("唯一空项", () => {
  it("仅一个空项时回车直接回到普通段落", () => {
    const view = createView("");
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.near(view.state.doc.resolve(1), 1),
      ),
    );
    typeText(view, "- ");
    const list = firstBlock(view);
    expect(list.type.name).toBe("bullet_list");
    expect(list.child(0).child(0).content.size).toBe(0);

    expect(pressKey(view, "Enter")).toBe(true);
    const doc = view.state.doc;
    expect(doc.childCount).toBe(1);
    expect(doc.child(0).type.name).toBe("paragraph");
    expect(doc.child(0).content.size).toBe(0);
    view.destroy();
  });
});
