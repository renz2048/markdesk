import type { Node } from "prosemirror-model";
import { Plugin, TextSelection } from "prosemirror-state";
import type { Command, EditorState, Transaction } from "prosemirror-state";
import { keymap } from "prosemirror-keymap";
import { markdownSchema } from "../../markdown/schema";

/**
 * 表格编辑（Typora / Word 习惯），配 insertTable 的 3×2 起点：
 * - Tab / Shift-Tab：在单元格间前后移动；末行末格 Tab 追加表体行。
 * - Enter：移到正下方同列单元格；已在末行则追加表体行。
 *   序列化契约禁止单元格内出现硬换行，因此回车只移动/扩行，
 *   绝不在单元格内产生任何断行。
 * - 菜单命令：在当前行下方添加行、在当前列右侧添加列、删除行、
 *   删除列。列对齐由表头行（第一行）规范定义；新列固定左对齐
 *   （等价在源码里补一列 `---`）。
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

/** 在当前行下方插入表体行（菜单「添加行」，也是 Tab/Enter 末位扩行的实现）。 */
export function insertTableRowBelow(): Command {
  return (state: EditorState, dispatch?: (tr: Transaction) => void) => {
    const context = tableContext(state);
    if (!context) return false;
    if (!dispatch) return true;

    const { row, rowPos } = context;
    const insertAt = rowPos + row.nodeSize;
    const tr = state.tr.insert(insertAt, createBodyRow(context.table));
    // 行开标签 +1、首格开标签 +1，光标落到新行第一格内容起点。
    tr.setSelection(TextSelection.near(tr.doc.resolve(insertAt + 2), 1));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** 在当前列右侧插入左对齐空列；表头行的格保持表头语义。 */
export function insertTableColumnRight(): Command {
  return (state: EditorState, dispatch?: (tr: Transaction) => void) => {
    const context = tableContext(state);
    if (!context) return false;
    if (!dispatch) return true;

    const { table, tablePos, rowIndex, cellIndex } = context;
    const rows: Node[] = [];
    table.forEach((row) => {
      const cells: Node[] = [];
      row.forEach((cell) => cells.push(cell));
      // 参差行短于插入列位时，新格追加到行尾，不重排现有格。
      const insertIndex = Math.min(cellIndex + 1, cells.length);
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
    const nextRowPos = rowPosition(tablePos, nextTable, rowIndex);
    tr.setSelection(
      TextSelection.near(
        tr.doc.resolve(
          cellContentPosition(nextRowPos, rows[rowIndex], cellIndex + 1),
        ),
        1,
      ),
    );
    dispatch(tr.scrollIntoView());
    return true;
  };
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
    const nextRowPos = rowPosition(tablePos, nextTable, rowIndex);
    const targetIndex = Math.min(cellIndex, nextRow.childCount - 1);
    tr.setSelection(
      TextSelection.near(
        tr.doc.resolve(cellContentPosition(nextRowPos, nextRow, targetIndex)),
        1,
      ),
    );
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

  // 末行回车：追加表体行；其余：移到正下方同列单元格。
  if (rowIndex >= table.childCount - 1) {
    return insertTableRowBelow()(state, dispatch);
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

export function tableEditingPlugin(): Plugin {
  // 顺序要求：在 listEditing 之后（单元格不是列表项，会放行）、
  // base keymap（Enter→splitBlock）之前生效。
  return keymap({
    Enter: handleTableEnter,
    Tab: handleTableTab,
    "Shift-Tab": handleTableShiftTab,
  });
}
