// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import type { Command, Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import type { Node } from "prosemirror-model";
import { markdownSchema } from "../../src/markdown/schema";
import { parseMarkdown } from "../../src/markdown/parser";
import { serializeMarkdown } from "../../src/markdown/serializer";
import { createEditorPlugins } from "../../src/main/components/WysiwygEditor";
import {
  deleteTableColumn,
  deleteTableRow,
  insertTableColumnRight,
  insertTableRowBelow,
} from "../../src/main/editor/tableEditing";

// jsdom 的 Range/Text 没有 getClientRects；命令的 scrollIntoView 会触发
// 坐标计算，补零尺寸矩形桩。
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

// 对齐列：表头行 + 两行表体，列对齐分别为 left/center/right。
const alignedTable = [
  "| A | B | C |",
  "| :--- | :---: | ---: |",
  "| 1 | 2 | 3 |",
  "| 4 | 5 | 6 |",
  "",
].join("\n");

function createView(source: string): EditorView {
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

/** 文档首块为表格时，第 row 行第 column 列单元格的内容起点。 */
function cellPos(doc: Node, row: number, column: number): number {
  const table = doc.child(0);
  let pos = 1;
  for (let index = 0; index < row; index += 1) {
    pos += table.child(index).nodeSize;
  }
  pos += 1;
  const rowNode = table.child(row);
  for (let index = 0; index < column; index += 1) {
    pos += rowNode.child(index).nodeSize;
  }
  return pos + 1;
}

function focusCell(view: EditorView, row: number, column: number): void {
  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.near(
        view.state.doc.resolve(cellPos(view.state.doc, row, column)),
        1,
      ),
    ),
  );
}

function applyCommand(
  command: Command,
  view: EditorView,
): void {
  let dispatched: Transaction | undefined;
  expect(command(view.state, (tr) => { dispatched = tr; })).toBe(true);
  if (!dispatched) throw new Error("expected a command transaction");
  view.dispatch(dispatched);
}

function tableOf(view: EditorView): Node {
  const table = view.state.doc.child(0);
  expect(table.type).toBe(markdownSchema.nodes.table);
  return table;
}

describe("table editing keymap", () => {
  it("Tab moves the cursor to the next cell without changing the doc", () => {
    const view = createView(alignedTable);
    focusCell(view, 1, 0);
    const before = view.state.doc;

    expect(pressKey(view, "Tab")).toBe(true);
    expect(view.state.selection.from).toBe(
      cellPos(view.state.doc, 1, 1),
    );
    expect(view.state.doc).toBe(before);
    view.destroy();
  });

  it("Tab in the last cell appends a body row and enters it", () => {
    const view = createView(alignedTable);
    focusCell(view, 2, 2);

    expect(pressKey(view, "Tab")).toBe(true);
    const table = tableOf(view);
    expect(table.childCount).toBe(4);
    const newRow = table.child(3);
    expect(newRow.childCount).toBe(3);
    for (const cell of [newRow.child(0), newRow.child(1), newRow.child(2)]) {
      expect(cell.attrs.header).toBe(false);
    }
    // 新行列对齐沿用表头行的规范对齐。
    expect(newRow.child(0).attrs.alignment).toBe("left");
    expect(newRow.child(1).attrs.alignment).toBe("center");
    expect(newRow.child(2).attrs.alignment).toBe("right");
    expect(view.state.selection.from).toBe(cellPos(view.state.doc, 3, 0));
    view.destroy();
  });

  it("Shift-Tab moves back a cell; in the first cell it swallows the key", () => {
    const view = createView(alignedTable);
    focusCell(view, 1, 2);
    expect(pressKey(view, "Tab", true)).toBe(true);
    expect(view.state.selection.from).toBe(
      cellPos(view.state.doc, 1, 1),
    );

    focusCell(view, 1, 0);
    const selectionBefore = view.state.selection.from;
    expect(pressKey(view, "Tab", true)).toBe(true);
    expect(view.state.selection.from).toBe(selectionBefore);
    view.destroy();
  });

  it("Enter moves down a row; in the last row it appends one", () => {
    const view = createView(alignedTable);
    focusCell(view, 0, 1);
    const before = view.state.doc;
    expect(pressKey(view, "Enter")).toBe(true);
    expect(view.state.selection.from).toBe(
      cellPos(view.state.doc, 1, 1),
    );
    // 单元格内不允许硬换行：普通行内回车只移动，不改文档。
    expect(view.state.doc).toBe(before);

    focusCell(view, 2, 0);
    expect(pressKey(view, "Enter")).toBe(true);
    expect(tableOf(view).childCount).toBe(4);
    expect(view.state.selection.from).toBe(cellPos(view.state.doc, 3, 0));
    view.destroy();
  });

  it("leaves Tab untouched outside tables", () => {
    // 普通段落里回车由 baseKeymap 的 splitBlock 正常处理，表格插件
    // 不应抢按键；这里验证表格上下文外 Tab 完全放行。
    const view = createView("普通段落\n");
    expect(pressKey(view, "Tab")).toBe(false);
    view.destroy();
  });
});

describe("table editing commands", () => {
  it("insertTableRowBelow inserts under the current row", () => {
    const view = createView(alignedTable);
    focusCell(view, 0, 0);
    applyCommand(insertTableRowBelow(), view);

    const table = tableOf(view);
    expect(table.childCount).toBe(4);
    expect(table.child(1).child(0).attrs.header).toBe(false);
    expect(table.child(1).child(1).attrs.alignment).toBe("center");
    expect(view.state.selection.from).toBe(cellPos(view.state.doc, 1, 0));
    view.destroy();
  });

  it("insertTableColumnRight adds a left-aligned column with header semantics", () => {
    const view = createView(alignedTable);
    focusCell(view, 1, 1);
    applyCommand(insertTableColumnRight(), view);

    const table = tableOf(view);
    expect(table.child(0).childCount).toBe(4);
    expect(table.child(1).childCount).toBe(4);
    expect(table.child(0).child(2).attrs.header).toBe(true);
    expect(table.child(1).child(2).attrs.header).toBe(false);
    expect(table.child(1).child(2).attrs.alignment).toBe("left");
    // 原有列的对齐不受影响。
    expect(table.child(0).child(3).attrs.alignment).toBe("right");
    // 光标落到当前行的新列。
    expect(view.state.selection.from).toBe(cellPos(view.state.doc, 1, 2));
    view.destroy();
  });

  it("deleteTableRow removes the current row and keeps the cursor in a cell", () => {
    const view = createView(alignedTable);
    focusCell(view, 1, 1);
    applyCommand(deleteTableRow(), view);

    const table = tableOf(view);
    expect(table.childCount).toBe(2);
    expect(table.child(1).child(0).textContent).toBe("4");
    expect(
      view.state.selection.$from.node(3).type,
    ).toBe(markdownSchema.nodes.table_cell);
    view.destroy();
  });

  it("deleteTableRow refuses to remove the only row", () => {
    const view = createView("| A | B |\n| --- | --- |\n");
    focusCell(view, 0, 0);
    let dispatched: Transaction | undefined;
    expect(
      deleteTableRow()(view.state, (tr) => { dispatched = tr; }),
    ).toBe(false);
    expect(dispatched).toBeUndefined();
    view.destroy();
  });

  it("deleteTableColumn removes the current column", () => {
    const view = createView(alignedTable);
    focusCell(view, 1, 2);
    applyCommand(deleteTableColumn(), view);

    const table = tableOf(view);
    expect(table.child(0).childCount).toBe(2);
    expect(table.child(1).child(0).textContent).toBe("1");
    expect(table.child(0).child(1).attrs.alignment).toBe("center");
    expect(view.state.selection.from).toBe(cellPos(view.state.doc, 1, 1));
    view.destroy();
  });

  it("deleteTableColumn refuses to remove the only column", () => {
    const view = createView("| A |\n| --- |\n| 1 |\n");
    focusCell(view, 1, 0);
    let dispatched: Transaction | undefined;
    expect(
      deleteTableColumn()(view.state, (tr) => { dispatched = tr; }),
    ).toBe(false);
    expect(dispatched).toBeUndefined();
    view.destroy();
  });

  it("keeps documents round-trippable after row and column edits", () => {
    const view = createView(alignedTable);
    focusCell(view, 2, 2);
    pressKey(view, "Tab"); // 追加一行
    focusCell(view, 0, 2);
    applyCommand(insertTableColumnRight(), view); // 追加一列
    focusCell(view, 1, 0);
    applyCommand(deleteTableRow(), view); // 删除原表体第一行

    const markdown = serializeMarkdown(view.state.doc);
    const reparsed = parseMarkdown(markdown);
    const table = reparsed.child(0);
    expect(table.type).toBe(markdownSchema.nodes.table);
    // 3 行（表头 + 原 6 行剩一行 + 新空行）× 4 列。
    expect(table.childCount).toBe(3);
    expect(table.child(0).childCount).toBe(4);
    expect(serializeMarkdown(reparsed)).toBe(markdown);
    view.destroy();
  });
});
