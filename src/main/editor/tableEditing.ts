import type { Node } from "prosemirror-model";
import { Plugin, TextSelection } from "prosemirror-state";
import type { Command, EditorState, Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { keydownHandler } from "prosemirror-keymap";
import { markdownSchema } from "../../markdown/schema";
import { renderTableMarkdown } from "../../markdown/serializer";

/**
 * 表格编辑（plan.md 契约）：
 * - Tab / Shift-Tab：单元格间前后移动；末行末格 Tab 追加表体行。
 * - Enter / ↑ / ↓：在当前列上下移动（Enter 等价 ↓）；首行 ↑ / 末行 ↓
 *   走出表格，表格是首/末块时按需补空段落（否则表格下方无法续写段落）。
 *   序列化契约禁止单元格内出现硬换行，回车绝不在单元格内断行。
 * - Backspace：单元格起点时等同向左键（跳到前一格末尾；行首格回绕到
 *   上一行末尾；首行首格吞掉）。
 * - Delete：首格末尾（无字符可删）删除整个表格；其余交还原生向前删除。
 * - Alt+↑/↓：上移/下移该行；Alt+←/→：左移/右移该列。
 * - 菜单命令：上方/下方插入行、左/右侧插入列、移动行列、删除行列、
 *   复制表格（规范 Markdown 源码入剪贴板）、格式化表格源码（参差行
 *   补齐到统一列数）、删除表格。列对齐由表头行规范定义；新列左对齐。
 * - 点击末尾表格下方空白区：补空段落并聚焦（表格下方的鼠标出口）。
 */

type TableAlignment = "left" | "center" | "right";

function normalizeAlignment(value: unknown): TableAlignment {
  return value === "center" || value === "right" ? value : "left";
}

interface TableContext {
  table: Node;
  // 表格节点在文档中的起点。
  tablePos: number;
  row: Node;
  rowIndex: number;
  rowPos: number;
  cellIndex: number;
}

function tableContext(state: EditorState): TableContext | null {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth >= 2; depth -= 1) {
    const row = $from.node(depth);
    if (row.type !== markdownSchema.nodes.table_row) continue;
    const table = $from.node(depth - 1);
    if (table.type !== markdownSchema.nodes.table) return null;
    return {
      table,
      tablePos: $from.before(depth - 1),
      row,
      rowIndex: $from.index(depth - 1),
      rowPos: $from.before(depth),
      // 参差行/节点选区下 index 可能越界，收敛到行内实际格数。
      cellIndex: Math.min($from.index(depth), row.childCount - 1),
    };
  }
  return null;
}

/** columnIndex 单元格内容起点（行内第 index 格的光标位置）。 */
function cellContentPosition(
  rowPos: number,
  row: Node,
  columnIndex: number,
): number {
  let pos = rowPos + 1;
  const clamped = Math.min(columnIndex, row.childCount - 1);
  for (let index = 0; index < clamped; index += 1) {
    pos += row.child(index).nodeSize;
  }
  return pos + 1;
}

/** rowIndex 行的文档起点。 */
function rowPosition(tablePos: number, table: Node, rowIndex: number): number {
  let pos = tablePos + 1;
  for (let index = 0; index < rowIndex; index += 1) {
    pos += table.child(index).nodeSize;
  }
  return pos;
}

/** 把光标落到 table 中第 row 行第 column 列单元格的内容起点。 */
function selectCell(
  tr: Transaction,
  tablePos: number,
  table: Node,
  row: number,
  column: number,
): void {
  const rowNode = table.child(row);
  tr.setSelection(
    TextSelection.near(
      tr.doc.resolve(cellContentPosition(rowPosition(tablePos, table, row), rowNode, column)),
      1,
    ),
  );
}

/** 按表头行各列对齐生成空表体行。 */
function createBodyRow(table: Node): Node {
  const headerRow = table.child(0);
  const cells: Node[] = [];
  headerRow.forEach((cell) => {
    cells.push(
      markdownSchema.nodes.table_cell.create({
        alignment: normalizeAlignment(cell.attrs.alignment),
        header: false,
      }),
    );
  });
  return markdownSchema.nodes.table_row.create(null, cells);
}

/** 光标移出表格下方：落到表格后首个文本块；表格是末块则先补空段落。 */
function exitTableBelow(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
): boolean {
  const context = tableContext(state);
  if (!context) return false;
  if (!dispatch) return true;

  const tableEnd = context.tablePos + context.table.nodeSize;
  const tr = state.tr;
  if (!tr.doc.resolve(tableEnd).nodeAfter) {
    tr.insert(tableEnd, markdownSchema.nodes.paragraph.create());
  }
  tr.setSelection(TextSelection.near(tr.doc.resolve(tableEnd), 1));
  dispatch(tr.scrollIntoView());
  return true;
}

/** 在当前行下方插入表体行（菜单「下方插入行」，也是末格 Tab 的实现）。 */
export function insertTableRowBelow(): Command {
  return (state: EditorState, dispatch?: (tr: Transaction) => void) => {
    const context = tableContext(state);
    if (!context) return false;
    if (!dispatch) return true;

    const { row, rowPos, rowIndex, cellIndex } = context;
    const insertAt = rowPos + row.nodeSize;
    const tr = state.tr.insert(insertAt, createBodyRow(context.table));
    // 光标落到新行同列单元格。
    const nextTable = tr.doc.nodeAt(context.tablePos);
    if (nextTable) selectCell(tr, context.tablePos, nextTable, rowIndex + 1, cellIndex);
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** 在当前行上方插入表体行，光标落到新行同列单元格。 */
export function insertTableRowAbove(): Command {
  return (state: EditorState, dispatch?: (tr: Transaction) => void) => {
    const context = tableContext(state);
    if (!context) return false;
    if (!dispatch) return true;

    const { row, rowPos, rowIndex, cellIndex } = context;
    const tr = state.tr.insert(rowPos, createBodyRow(context.table));
    const nextTable = tr.doc.nodeAt(context.tablePos);
    if (nextTable) selectCell(tr, context.tablePos, nextTable, rowIndex, cellIndex);
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** 在 columnIndex 位置插入左对齐空列；表头行的格保持表头语义。 */
function insertColumnAt(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  columnIndex: number,
): boolean {
  const context = tableContext(state);
  if (!context) return false;
  if (!dispatch) return true;

  const { table, tablePos, rowIndex } = context;
  const rows: Node[] = [];
  table.forEach((row) => {
    const cells: Node[] = [];
    row.forEach((cell) => cells.push(cell));
    // 参差行短于插入列位时，新格追加到行尾，不重排现有格。
    const insertIndex = Math.min(columnIndex, cells.length);
    cells.splice(
      insertIndex,
      0,
      markdownSchema.nodes.table_cell.create({
        alignment: "left",
        header: row.child(0).attrs.header === true,
      }),
    );
    rows.push(markdownSchema.nodes.table_row.create(null, cells));
  });

  const nextTable = markdownSchema.nodes.table.create(null, rows);
  const tr = state.tr.replaceWith(
    tablePos,
    tablePos + table.nodeSize,
    nextTable,
  );
  selectCell(tr, tablePos, nextTable, rowIndex, columnIndex);
  dispatch(tr.scrollIntoView());
  return true;
}

/** 在当前列右侧插入左对齐空列。 */
export function insertTableColumnRight(): Command {
  return (state, dispatch) => {
    const context = tableContext(state);
    return context
      ? insertColumnAt(state, dispatch, context.cellIndex + 1)
      : false;
  };
}

/** 在当前列左侧插入左对齐空列。 */
export function insertTableColumnLeft(): Command {
  return (state, dispatch) => {
    const context = tableContext(state);
    return context
      ? insertColumnAt(state, dispatch, context.cellIndex)
      : false;
  };
}

/** 上移/下移当前行（与相邻行交换位置），光标留在原单元格。 */
function moveTableRow(delta: -1 | 1): Command {
  return (state: EditorState, dispatch?: (tr: Transaction) => void) => {
    const context = tableContext(state);
    if (!context) return false;
    const targetIndex = context.rowIndex + delta;
    if (targetIndex < 0 || targetIndex >= context.table.childCount) {
      return false;
    }
    if (!dispatch) return true;

    const { table, tablePos, rowIndex, cellIndex } = context;
    const rows: Node[] = [];
    table.forEach((row) => rows.push(row));
    [rows[rowIndex], rows[targetIndex]] = [rows[targetIndex], rows[rowIndex]];

    const nextTable = markdownSchema.nodes.table.create(null, rows);
    const tr = state.tr.replaceWith(
      tablePos,
      tablePos + table.nodeSize,
      nextTable,
    );
    selectCell(tr, tablePos, nextTable, targetIndex, cellIndex);
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** 左移/右移当前列（与相邻列交换位置），参差行不动，光标留在原单元格。 */
function moveTableColumn(delta: -1 | 1): Command {
  return (state: EditorState, dispatch?: (tr: Transaction) => void) => {
    const context = tableContext(state);
    if (!context) return false;
    const { table, cellIndex } = context;
    // 规范列数取表头行。
    const columnCount = table.child(0).childCount;
    const targetIndex = cellIndex + delta;
    if (targetIndex < 0 || targetIndex >= columnCount) return false;
    if (!dispatch) return true;

    const { tablePos, rowIndex } = context;
    const rows: Node[] = [];
    table.forEach((row) => {
      const cells: Node[] = [];
      row.forEach((cell) => cells.push(cell));
      // 仅当两个待交换格都存在时交换，短行保持原样。
      if (cells.length > Math.max(cellIndex, targetIndex)) {
        [cells[cellIndex], cells[targetIndex]] = [
          cells[targetIndex],
          cells[cellIndex],
        ];
      }
      rows.push(markdownSchema.nodes.table_row.create(null, cells));
    });

    const nextTable = markdownSchema.nodes.table.create(null, rows);
    const tr = state.tr.replaceWith(
      tablePos,
      tablePos + table.nodeSize,
      nextTable,
    );
    selectCell(tr, tablePos, nextTable, rowIndex, targetIndex);
    dispatch(tr.scrollIntoView());
    return true;
  };
}

export function moveTableRowUp(): Command {
  return moveTableRow(-1);
}

export function moveTableRowDown(): Command {
  return moveTableRow(1);
}

export function moveTableColumnLeft(): Command {
  return moveTableColumn(-1);
}

export function moveTableColumnRight(): Command {
  return moveTableColumn(1);
}

/** 删除当前行；仅剩一行时拒绝（保持表格结构合法）。 */
export function deleteTableRow(): Command {
  return (state: EditorState, dispatch?: (tr: Transaction) => void) => {
    const context = tableContext(state);
    if (!context) return false;
    if (context.table.childCount <= 1) return false;
    if (!dispatch) return true;

    const { rowPos, row } = context;
    const cursor = state.selection.from;
    const tr = state.tr.delete(rowPos, rowPos + row.nodeSize);
    // 行删除后原光标映射到行起点，就近落到相邻行的单元格里。
    tr.setSelection(
      TextSelection.near(tr.doc.resolve(tr.mapping.map(cursor)), 1),
    );
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** 删除当前列；仅剩一列时拒绝。参差行不足该列时原样保留。 */
export function deleteTableColumn(): Command {
  return (state: EditorState, dispatch?: (tr: Transaction) => void) => {
    const context = tableContext(state);
    if (!context) return false;
    // 规范列数取表头行。
    if (context.table.child(0).childCount <= 1) return false;
    if (!dispatch) return true;

    const { table, tablePos, rowIndex, cellIndex } = context;
    const rows: Node[] = [];
    table.forEach((row) => {
      if (row.childCount <= cellIndex) {
        rows.push(row);
        return;
      }
      const cells: Node[] = [];
      row.forEach((cell, _offset, index) => {
        if (index !== cellIndex) cells.push(cell);
      });
      rows.push(markdownSchema.nodes.table_row.create(null, cells));
    });

    const nextTable = markdownSchema.nodes.table.create(null, rows);
    const tr = state.tr.replaceWith(
      tablePos,
      tablePos + table.nodeSize,
      nextTable,
    );
    const nextRow = rows[rowIndex];
    const targetIndex = Math.min(cellIndex, nextRow.childCount - 1);
    selectCell(tr, tablePos, nextTable, rowIndex, targetIndex);
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** 把整个表格的规范 Markdown 源码写入剪贴板（不改动文档）。 */
export function copyTable(): Command {
  return (state: EditorState, dispatch?: (tr: Transaction) => void) => {
    const context = tableContext(state);
    if (!context) return false;
    if (!dispatch) return true;

    const markdown = renderTableMarkdown(context.table);
    void copyTextToClipboard(markdown);
    return true;
  };
}

async function copyTextToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // 剪贴板 API 被拒时退回 execCommand（同源可靠、行为足够）。
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
    } catch {
      // 静默失败：复制是尽力而为的辅助操作。
    } finally {
      textarea.remove();
    }
  }
}

/**
 * 格式化表格源码：参差行补齐到统一列数（宽度取各行最大值），新格
 * 空内容、左对齐（表头行保持表头语义）。已是规整表格则无变化。
 */
export function formatTable(): Command {
  return (state: EditorState, dispatch?: (tr: Transaction) => void) => {
    const context = tableContext(state);
    if (!context) return false;
    if (!dispatch) return true;

    const { table, tablePos, rowIndex, cellIndex } = context;
    let width = 0;
    table.forEach((row) => {
      width = Math.max(width, row.childCount);
    });

    const rows: Node[] = [];
    table.forEach((row, rowOffset) => {
      const cells: Node[] = [];
      row.forEach((cell) => cells.push(cell));
      while (cells.length < width) {
        cells.push(
          markdownSchema.nodes.table_cell.create({
            alignment: "left",
            header: rowOffset === 0,
          }),
        );
      }
      rows.push(markdownSchema.nodes.table_row.create(null, cells));
    });

    const nextTable = markdownSchema.nodes.table.create(null, rows);
    const tr = state.tr.replaceWith(
      tablePos,
      tablePos + table.nodeSize,
      nextTable,
    );
    selectCell(tr, tablePos, nextTable, rowIndex, cellIndex);
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** 删除整个表格；光标就近落到表格前后的文本块。 */
export function deleteTable(): Command {
  return (state: EditorState, dispatch?: (tr: Transaction) => void) => {
    const context = tableContext(state);
    if (!context) return false;
    if (!dispatch) return true;

    const { table, tablePos } = context;
    const tr = state.tr.delete(tablePos, tablePos + table.nodeSize);
    tr.setSelection(TextSelection.near(tr.doc.resolve(tablePos), 1));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

const handleTableTab: Command = (state, dispatch) => {
  const context = tableContext(state);
  if (!context) return false;
  const { row, rowPos, cellIndex } = context;

  // 末格 Tab：追加表体行（Word/Typora 行为）。
  if (cellIndex >= row.childCount - 1) {
    return insertTableRowBelow()(state, dispatch);
  }
  if (!dispatch) return true;
  dispatch(
    state.tr.setSelection(
      TextSelection.near(
        state.doc.resolve(cellContentPosition(rowPos, row, cellIndex + 1)),
        1,
      ),
    ),
  );
  return true;
};

const handleTableShiftTab: Command = (state, dispatch) => {
  const context = tableContext(state);
  if (!context) return false;
  const { row, rowPos, cellIndex } = context;
  // 首格 Shift-Tab：吞掉按键保持焦点（与列表首项 Tab 行为一致）。
  if (cellIndex === 0) return true;
  if (!dispatch) return true;
  dispatch(
    state.tr.setSelection(
      TextSelection.near(
        state.doc.resolve(cellContentPosition(rowPos, row, cellIndex - 1)),
        1,
      ),
    ),
  );
  return true;
};

const handleTableEnter: Command = (state, dispatch) => {
  const context = tableContext(state);
  if (!context) return false;
  const { table, tablePos, rowIndex, cellIndex } = context;

  // 末行回车：走出表格（等价 ↓）；其余：移到正下方同列单元格。
  if (rowIndex >= table.childCount - 1) {
    return exitTableBelow(state, dispatch);
  }
  if (!dispatch) return true;
  const nextRowPos = rowPosition(tablePos, table, rowIndex + 1);
  const nextRow = table.child(rowIndex + 1);
  dispatch(
    state.tr.setSelection(
      TextSelection.near(
        state.doc.resolve(
          cellContentPosition(
            nextRowPos,
            nextRow,
            Math.min(cellIndex, nextRow.childCount - 1),
          ),
        ),
        1,
      ),
    ),
  );
  return true;
};

/**
 * ArrowDown：光标已在单元格最后一视觉行时，移到正下方同列单元格；
 * 末行则走出表格（表格是末块时补空段落）。
 */
const handleTableArrowDown: Command = (state, dispatch, view) => {
  const context = tableContext(state);
  if (!context) return false;
  if (!state.selection.empty) return false;
  // 光标不在单元格最后一视觉行时交还原生下移（多行单元格内换行）。
  if (view && !view.endOfTextblock("down", state)) return false;
  if (context.rowIndex >= context.table.childCount - 1) {
    return exitTableBelow(state, dispatch);
  }
  if (!dispatch) return true;

  const { table, tablePos, rowIndex, cellIndex } = context;
  const tr = state.tr;
  selectCell(
    tr,
    tablePos,
    table,
    rowIndex + 1,
    Math.min(cellIndex, table.child(rowIndex + 1).childCount - 1),
  );
  dispatch(tr.scrollIntoView());
  return true;
};

/**
 * ArrowUp：光标已在单元格第一视觉行时，移到正上方同列单元格；
 * 首行则移到表格上方相邻文本块末尾（表格是首块时无落点，交还原生）。
 */
const handleTableArrowUp: Command = (state, dispatch, view) => {
  const context = tableContext(state);
  if (!context) return false;
  if (!state.selection.empty) return false;
  if (view && !view.endOfTextblock("up", state)) return false;

  const { table, tablePos, rowIndex, cellIndex } = context;
  if (rowIndex === 0) {
    if (!state.doc.resolve(tablePos).nodeBefore) return false;
    if (!dispatch) return true;
    dispatch(
      state.tr
        .setSelection(TextSelection.near(state.doc.resolve(tablePos), -1))
        .scrollIntoView(),
    );
    return true;
  }
  if (!dispatch) return true;

  const tr = state.tr;
  selectCell(
    tr,
    tablePos,
    table,
    rowIndex - 1,
    Math.min(cellIndex, table.child(rowIndex - 1).childCount - 1),
  );
  dispatch(tr.scrollIntoView());
  return true;
};

/**
 * Backspace：单元格起点时等同向左键——跳到前一格末尾；行首格回绕到
 * 上一行末格的末尾；首行首格吞掉按键（向左无处可去，也不把整个表格
 * 选为节点，避免误删）。
 */
const handleTableBackspace: Command = (state, dispatch) => {
  const context = tableContext(state);
  if (!context) return false;
  if (!state.selection.empty) return false;
  if (state.selection.$from.parentOffset !== 0) return false;
  const { table, tablePos, row, rowPos, rowIndex, cellIndex } = context;
  if (!dispatch) return true;

  // 行首格 → 上一行末格末尾（跨行回绕）。
  if (cellIndex === 0) {
    if (rowIndex === 0) return true;
    const previousRowPos = rowPosition(tablePos, table, rowIndex - 1);
    const previousRow = table.child(rowIndex - 1);
    const lastCell = previousRow.child(previousRow.childCount - 1);
    dispatch(
      state.tr.setSelection(
        TextSelection.create(
          state.doc,
          cellContentPosition(
            previousRowPos,
            previousRow,
            previousRow.childCount - 1,
          ) + lastCell.content.size,
        ),
      ),
    );
    return true;
  }

  const previousCell = row.child(cellIndex - 1);
  dispatch(
    state.tr.setSelection(
      TextSelection.create(
        state.doc,
        cellContentPosition(rowPos, row, cellIndex - 1) +
          previousCell.content.size,
      ),
    ),
  );
  return true;
};

/**
 * Delete：首格末尾（单元格内无字符可删）删除整个表格；其余交还原生
 * 向前删除。
 */
const handleTableDelete: Command = (state, dispatch) => {
  const context = tableContext(state);
  if (!context) return false;
  if (!state.selection.empty) return false;
  if (context.rowIndex !== 0 || context.cellIndex !== 0) return false;
  const { $from } = state.selection;
  if ($from.parentOffset !== $from.parent.content.size) return false;
  return deleteTable()(state, dispatch);
};

/**
 * 点击末尾表格下方的空白区：表格下方没有可点击的落点时（序列化往返
 * 会丢弃尾随空段落，重新打开的文档表格即为末块），点击只会把光标送
 * 回最后一个单元格。这里把落在表格底边以下的点击改为在其后补一个
 * 空段落并聚焦。
 */
const handleBelowTableClick = (
  view: EditorView,
  event: MouseEvent,
): boolean => {
  const table = view.state.doc.lastChild;
  if (!table || table.type !== markdownSchema.nodes.table) return false;
  // 仅主键：右键（上下文菜单）等不插入段落。
  if (event.button !== 0) return false;
  const dom = view.nodeDOM(view.state.doc.content.size - table.nodeSize);
  if (!(dom instanceof Element)) return false;
  // 表格底边以内（含边框余量）的点击仍按原生行为落位。
  if (event.clientY <= dom.getBoundingClientRect().bottom + 4) return false;

  const paragraphPos = view.state.doc.content.size;
  const tr = view.state.tr.insert(
    paragraphPos,
    markdownSchema.nodes.paragraph.create(),
  );
  tr.setSelection(TextSelection.near(tr.doc.resolve(paragraphPos + 1), 1));
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
};

export function tableEditingPlugin(): Plugin {
  // 顺序要求：在 listEditing 之后（单元格不是列表项，会放行）、
  // base keymap（Enter→splitBlock、Backspace/Delete 连接块）之前生效；
  // gapCursor 的方向键绑定（仅 GapCursor 选区生效）依然在其后可用。
  return new Plugin({
    props: {
      handleKeyDown: keydownHandler({
        Enter: handleTableEnter,
        Tab: handleTableTab,
        "Shift-Tab": handleTableShiftTab,
        ArrowDown: handleTableArrowDown,
        ArrowUp: handleTableArrowUp,
        Backspace: handleTableBackspace,
        Delete: handleTableDelete,
        "Alt-ArrowUp": moveTableRowUp(),
        "Alt-ArrowDown": moveTableRowDown(),
        "Alt-ArrowLeft": moveTableColumnLeft(),
        "Alt-ArrowRight": moveTableColumnRight(),
      }),
      handleClick: (view, _pos, event) =>
        handleBelowTableClick(view, event),
    },
  });
}
