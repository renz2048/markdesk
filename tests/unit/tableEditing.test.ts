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
  copyTable,
  deleteTable,
  deleteTableColumn,
  deleteTableRow,
  formatTable,
  insertTableColumnLeft,
  insertTableColumnRight,
  insertTableRowAbove,
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

function pressKey(
  view: EditorView,
  key: string,
  shift = false,
  alt = false,
): boolean {
  return (
    view.someProp(
      "handleKeyDown",
      (handler) =>
        handler(
          view,
          ({
            key,
            shiftKey: shift,
            altKey: alt,
            isComposing: false,
            preventDefault() {},
          }) as never,
        ) || false,
    ) ?? false
  );
}

/** 第 tableIndex 块为表格时，第 row 行第 column 列单元格的内容起点。 */
function cellPos(
  doc: Node,
  row: number,
  column: number,
  tableIndex = 0,
): number {
  let base = 0;
  for (let index = 0; index < tableIndex; index += 1) {
    base += doc.child(index).nodeSize;
  }
  const table = doc.child(tableIndex);
  let pos = base + 1;
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

function focusCell(
  view: EditorView,
  row: number,
  column: number,
  tableIndex = 0,
): void {
  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.near(
        view.state.doc.resolve(
          cellPos(view.state.doc, row, column, tableIndex),
        ),
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

function rowText(row: Node): string {
  return row.textContent;
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
    // 光标落到新行的同列单元格。
    expect(view.state.selection.from).toBe(cellPos(view.state.doc, 3, 2));
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

  it("Enter moves down a row; in the last row it leaves the table like ArrowDown", () => {
    const view = createView(alignedTable);
    focusCell(view, 0, 1);
    const before = view.state.doc;
    expect(pressKey(view, "Enter")).toBe(true);
    expect(view.state.selection.from).toBe(
      cellPos(view.state.doc, 1, 1),
    );
    // 单元格内不允许硬换行：普通行内回车只移动，不改文档。
    expect(view.state.doc).toBe(before);

    // 末行回车 = 向下键行为：走出表格（末块时补空段落），不再追加行。
    const tableSize = view.state.doc.child(0).nodeSize;
    focusCell(view, 2, 0);
    expect(pressKey(view, "Enter")).toBe(true);
    expect(tableOf(view).childCount).toBe(3);
    expect(view.state.doc.childCount).toBe(2);
    expect(view.state.doc.child(1).type).toBe(markdownSchema.nodes.paragraph);
    expect(view.state.selection.from).toBe(tableSize + 1);
    view.destroy();
  });

  it("ArrowDown in a middle row moves to the cell below in the same column", () => {
    const view = createView(alignedTable);
    focusCell(view, 1, 1);
    const before = view.state.doc;

    expect(pressKey(view, "ArrowDown")).toBe(true);
    expect(view.state.selection.from).toBe(cellPos(view.state.doc, 2, 1));
    expect(view.state.doc).toBe(before);
    view.destroy();
  });

  it("ArrowUp in a middle row moves to the cell above in the same column", () => {
    const view = createView(alignedTable);
    focusCell(view, 2, 1);
    const before = view.state.doc;

    expect(pressKey(view, "ArrowUp")).toBe(true);
    expect(view.state.selection.from).toBe(cellPos(view.state.doc, 1, 1));
    expect(view.state.doc).toBe(before);
    view.destroy();
  });

  it("Backspace at a cell start jumps to the end of the previous cell", () => {
    const view = createView(alignedTable);
    focusCell(view, 1, 2);
    const before = view.state.doc;

    expect(pressKey(view, "Backspace")).toBe(true);
    // 落到 (1,1) 格内容末尾（“2”之后）。
    expect(view.state.selection.from).toBe(cellPos(view.state.doc, 1, 1) + 1);
    expect(view.state.doc).toBe(before);
    view.destroy();
  });

  it("Backspace at the first cell of a row wraps to the end of the previous row", () => {
    const view = createView(alignedTable);
    focusCell(view, 1, 0);
    const before = view.state.doc;

    expect(pressKey(view, "Backspace")).toBe(true);
    // 回绕到上一行（表头）末格“C”之后。
    expect(view.state.selection.from).toBe(cellPos(view.state.doc, 0, 2) + 1);
    expect(view.state.doc).toBe(before);
    view.destroy();
  });

  it("Backspace in the first cell of the first row is swallowed", () => {
    const view = createView(alignedTable);
    focusCell(view, 0, 0);
    const selectionBefore = view.state.selection.from;
    const before = view.state.doc;

    expect(pressKey(view, "Backspace")).toBe(true);
    expect(view.state.selection.from).toBe(selectionBefore);
    expect(view.state.doc).toBe(before);
    view.destroy();
  });

  it("Backspace mid-cell falls through to native deletion", () => {
    const view = createView("| A |\n| --- |\n| abc |\n");
    // 光标放到单元格文本中间：abc 的 “b” 前。
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, cellPos(view.state.doc, 1, 0) + 1),
      ),
    );

    expect(pressKey(view, "Backspace")).toBe(false);
    view.destroy();
  });

  it("Delete at the end of the first cell deletes the whole table", () => {
    const view = createView(`${alignedTable}\n下方段落\n`);
    // 首格末尾：“A” 之后。
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, cellPos(view.state.doc, 0, 0) + 1),
      ),
    );

    expect(pressKey(view, "Delete")).toBe(true);
    expect(view.state.doc.childCount).toBe(1);
    expect(view.state.doc.child(0).type).toBe(markdownSchema.nodes.paragraph);
    expect(view.state.selection.$from.parent.textContent).toBe("下方段落");
    view.destroy();
  });

  it("Delete elsewhere falls through to native forward deletion", () => {
    const view = createView(alignedTable);
    focusCell(view, 1, 1); // 非首格

    expect(pressKey(view, "Delete")).toBe(false);

    focusCell(view, 0, 1); // 首行但非首格
    expect(pressKey(view, "Delete")).toBe(false);
    view.destroy();
  });

  it("Alt+ArrowUp/Down moves the current row", () => {
    const view = createView(alignedTable);
    focusCell(view, 1, 1); // 表体第一行

    // Alt+↑：与表头交换 → 行序 1 / A / 4，光标留在移动后的行同列。
    expect(pressKey(view, "ArrowUp", false, true)).toBe(true);
    let table = tableOf(view);
    expect(rowText(table.child(0))).toBe("123");
    expect(rowText(table.child(1))).toBe("ABC");
    expect(view.state.selection.from).toBe(cellPos(view.state.doc, 0, 1));

    // Alt+↓：移回原位，光标同行同列。
    expect(pressKey(view, "ArrowDown", false, true)).toBe(true);
    table = tableOf(view);
    expect(rowText(table.child(0))).toBe("ABC");
    expect(rowText(table.child(1))).toBe("123");
    expect(view.state.selection.from).toBe(cellPos(view.state.doc, 1, 1));

    // 首行 Alt+↑、末行 Alt+↓ 无处可移：拒绝。
    focusCell(view, 0, 0);
    expect(pressKey(view, "ArrowUp", false, true)).toBe(false);
    focusCell(view, 2, 0);
    expect(pressKey(view, "ArrowDown", false, true)).toBe(false);
    view.destroy();
  });

  it("Alt+ArrowLeft/Right moves the current column", () => {
    const view = createView(alignedTable);
    focusCell(view, 1, 2); // “3”列

    expect(pressKey(view, "ArrowLeft", false, true)).toBe(true);
    let table = tableOf(view);
    expect(rowText(table.child(1))).toBe("132");
    expect(view.state.selection.from).toBe(cellPos(view.state.doc, 1, 1));

    // 右移一列移回原位。
    expect(pressKey(view, "ArrowRight", false, true)).toBe(true);
    table = tableOf(view);
    expect(rowText(table.child(1))).toBe("123");
    expect(view.state.selection.from).toBe(cellPos(view.state.doc, 1, 2));

    // 首列 Alt+←、末列 Alt+→ 无处可移：拒绝。
    focusCell(view, 1, 0);
    expect(pressKey(view, "ArrowLeft", false, true)).toBe(false);
    focusCell(view, 1, 2);
    expect(pressKey(view, "ArrowRight", false, true)).toBe(false);
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

describe("leaving a table (表格下方续写段落)", () => {
  it("ArrowDown in the last row appends a paragraph when the table is the last block", () => {
    // 序列化往返会丢弃尾随空段落，重新打开的文档表格即末块。
    const view = createView(alignedTable);
    focusCell(view, 2, 0);
    const tableSize = view.state.doc.child(0).nodeSize;

    expect(pressKey(view, "ArrowDown")).toBe(true);
    expect(view.state.doc.childCount).toBe(2);
    expect(view.state.doc.child(1).type).toBe(markdownSchema.nodes.paragraph);
    expect(view.state.doc.child(1).content.size).toBe(0);
    expect(view.state.selection.from).toBe(tableSize + 1);
    expect(view.state.selection.$from.parent.type).toBe(
      markdownSchema.nodes.paragraph,
    );
    view.destroy();
  });

  it("ArrowDown in the last row moves into an existing block below", () => {
    const view = createView(`${alignedTable}\n下方段落\n`);
    focusCell(view, 2, 0);
    const before = view.state.doc;

    expect(pressKey(view, "ArrowDown")).toBe(true);
    expect(view.state.doc).toBe(before);
    expect(view.state.selection.$from.parent.textContent).toBe("下方段落");
    view.destroy();
  });

  it("ArrowDown in a middle row moves to the cell below (native no longer relied on)", () => {
    // plan.md：向下键应在同列向下移动（旧版在 WebView 中表现得像向右键）。
    const view = createView(alignedTable);
    focusCell(view, 1, 0);
    const before = view.state.doc;

    expect(pressKey(view, "ArrowDown")).toBe(true);
    expect(view.state.selection.from).toBe(cellPos(view.state.doc, 2, 0));
    expect(view.state.doc).toBe(before);
    view.destroy();
  });

  it("ArrowUp in the first row moves to the end of the block above", () => {
    const view = createView(`上方段落\n\n${alignedTable}`);
    focusCell(view, 0, 1, 1);
    const before = view.state.doc;

    expect(pressKey(view, "ArrowUp")).toBe(true);
    expect(view.state.doc).toBe(before);
    expect(view.state.selection.$from.parent.textContent).toBe("上方段落");
    expect(view.state.selection.from).toBe("上方段落".length + 1);
    view.destroy();
  });

  it("ArrowUp in a first-row table without a block above falls through", () => {
    const view = createView(alignedTable);
    focusCell(view, 0, 1);

    expect(pressKey(view, "ArrowUp")).toBe(false);
    view.destroy();
  });

  it("clicking below a trailing table appends and focuses a paragraph", () => {
    // jsdom 无布局：表格矩形为全零，clientY 60 视为底边以下、0 视为表格内。
    const view = createView(alignedTable);
    const tableSize = view.state.doc.child(0).nodeSize;
    const handled = view.someProp("handleClick", (handler) =>
      handler(view, view.state.doc.content.size, {
        button: 0,
        clientY: 60,
      } as MouseEvent),
    );

    expect(handled).toBe(true);
    expect(view.state.doc.childCount).toBe(2);
    expect(view.state.doc.child(1).type).toBe(markdownSchema.nodes.paragraph);
    expect(view.state.selection.from).toBe(tableSize + 1);
    view.destroy();
  });

  it("clicks inside the table and non-primary clicks keep native behavior", () => {
    const view = createView(alignedTable);
    const before = view.state.doc;
    const inside = view.someProp("handleClick", (handler) =>
      handler(view, 3, { button: 0, clientY: 0 } as MouseEvent),
    );
    const secondary = view.someProp("handleClick", (handler) =>
      handler(view, view.state.doc.content.size, {
        button: 2,
        clientY: 60,
      } as MouseEvent),
    );

    expect(inside ?? false).toBe(false);
    expect(secondary ?? false).toBe(false);
    expect(view.state.doc).toBe(before);
    view.destroy();
  });

  it("keeps the trailing landing paragraph invisible in serialized markdown", () => {
    const view = createView(alignedTable);
    focusCell(view, 2, 0);
    pressKey(view, "ArrowDown");
    const once = serializeMarkdown(view.state.doc);
    const twice = serializeMarkdown(parseMarkdown(once));

    // 空段落序列化不产生输出，规范形式不受影响。
    expect(twice).toBe(once);
    expect(parseMarkdown(once).childCount).toBe(1);
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

describe("table menu commands (表格菜单)", () => {
  it("insertTableRowAbove inserts over the current row with the cursor in it", () => {
    const view = createView(alignedTable);
    focusCell(view, 1, 1);
    applyCommand(insertTableRowAbove(), view);

    const table = tableOf(view);
    expect(table.childCount).toBe(4);
    expect(table.child(1).child(1).content.size).toBe(0);
    expect(table.child(1).child(1).attrs.header).toBe(false);
    expect(view.state.selection.from).toBe(cellPos(view.state.doc, 1, 1));
    view.destroy();
  });

  it("insertTableColumnLeft adds an empty column before the current one", () => {
    const view = createView(alignedTable);
    focusCell(view, 1, 1);
    applyCommand(insertTableColumnLeft(), view);

    const table = tableOf(view);
    expect(table.child(0).childCount).toBe(4);
    // 新空列插到当前列（B）之前，原列保持次序。
    expect(table.child(0).child(0).textContent).toBe("A");
    expect(table.child(0).child(1).content.size).toBe(0);
    // 表头行的插入格保持表头语义。
    expect(table.child(0).child(1).attrs.header).toBe(true);
    expect(table.child(0).child(2).textContent).toBe("B");
    expect(view.state.selection.from).toBe(cellPos(view.state.doc, 1, 1));
    view.destroy();
  });

  it("deleteTable removes the whole table and lands in the next block", () => {
    const view = createView(`${alignedTable}\n下方段落\n`);
    focusCell(view, 2, 2);
    applyCommand(deleteTable(), view);

    expect(view.state.doc.childCount).toBe(1);
    expect(view.state.doc.child(0).textContent).toBe("下方段落");
    expect(view.state.selection.$from.parent.textContent).toBe("下方段落");
    view.destroy();
  });

  it("copyTable writes canonical markdown to the clipboard without doc changes", async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: (text: string) => { writes.push(text); return Promise.resolve(); } },
      configurable: true,
    });
    const view = createView(alignedTable);
    focusCell(view, 1, 0);
    const before = view.state.doc;

    // 复制不产生文档事务（无内容变化）。
    let dispatchedCount = 0;
    expect(
      copyTable()(view.state, () => { dispatchedCount += 1; }),
    ).toBe(true);
    await Promise.resolve();

    expect(dispatchedCount).toBe(0);
    expect(view.state.doc).toBe(before);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe(serializeMarkdown(before).trimEnd());
    view.destroy();
  });

  it("formatTable pads ragged rows to a uniform width", () => {
    // 参差表：表头 3 列，表体行 1–2 列不等（解析器会丢弃超出表头宽度
    // 的多余格，所以参差只出现在“短行”侧）。
    const ragged = [
      "| A | B | C |",
      "| --- | --- | --- |",
      "| 1 |",
      "| 1 | 2 |",
      "",
    ].join("\n");
    const view = createView(ragged);
    focusCell(view, 1, 0);
    applyCommand(formatTable(), view);

    const table = tableOf(view);
    table.forEach((row) => expect(row.childCount).toBe(3));
    expect(table.child(1).child(1).content.size).toBe(0);
    expect(table.child(1).child(2).content.size).toBe(0);
    expect(table.child(2).child(1).textContent).toBe("2");
    expect(table.child(2).child(2).content.size).toBe(0);
    expect(view.state.selection.from).toBe(cellPos(view.state.doc, 1, 0));

    // 幂等：再格式化无变化。
    const stable = view.state.doc;
    applyCommand(formatTable(), view);
    expect(serializeMarkdown(view.state.doc)).toBe(serializeMarkdown(stable));
    view.destroy();
  });
});
