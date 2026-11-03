import {
  liftListItem,
  sinkListItem,
  splitListItem,
} from "prosemirror-schema-list";
import type { Command, EditorState } from "prosemirror-state";
import type { ResolvedPos } from "prosemirror-model";
import { Plugin, TextSelection } from "prosemirror-state";
import { keymap } from "prosemirror-keymap";

/**
 * 列表编辑（Typora 行为，配 inputRules 的列表即时转换）：
 * - Enter：非空项 → 续一个空项（有序列表自动接续编号）；
 *   空项 → 原位升一级（需求 5.1 逐级退层，光标留在空项内），
 *   顶层空项 → 移除空项，落为列表外的普通段落（需求 3 场景 3）。
 * - Tab：非首项 → 缩进为上一项的子列表；首项无缩进目标，吞掉按键
 *   保持焦点。
 * - Shift-Tab：提升当前项一级（Tab 的逆向操作）。
 */

interface ListContext {
  // 光标所在 list_item 的深度（ResolvedPos.node(depth) 取该项）。
  itemDepth: number;
  // 该项在其列表中的序号（0 起）与列表总项数。
  itemIndex: number;
  itemCount: number;
  // 空项判定：仅含一个空段落。
  isEmptyItem: boolean;
}

function listContext(state: EditorState): ListContext | null {
  const { $from } = state.selection;
  // 取最深一层列表项（嵌套列表时操作最内层）。
  for (let depth = $from.depth; depth >= 1; depth -= 1) {
    const node = $from.node(depth);
    if (node.type !== state.schema.nodes.list_item) continue;
    const list = $from.node(depth - 1);
    if (
      list.type !== state.schema.nodes.bullet_list &&
      list.type !== state.schema.nodes.ordered_list
    ) {
      continue;
    }
    return {
      itemDepth: depth,
      itemIndex: $from.index(depth - 1),
      itemCount: list.childCount,
      isEmptyItem:
        node.childCount === 1 &&
        node.child(0).type === state.schema.nodes.paragraph &&
        node.child(0).content.size === 0,
    };
  }
  return null;
}

function itemRange($from: ResolvedPos, itemDepth: number): {
  from: number;
  to: number;
} {
  return { from: $from.before(itemDepth), to: $from.after(itemDepth) };
}

/**
 * 空项回车：逐级退层（需求 5.1，覆盖 4.2/4.3）。
 * - 嵌套内层的空项：空项原位升一级（3 层 → 2 层 → 1 层），
 *   光标留在空项内等待用户输入；子列表原样保留在原父项下。
 * - 顶层列表的空项：移除空项，落为列表外的普通段落（需求 3 场景 3）；
 *   唯一项被替换会留下空列表壳，此时把整个列表范围替换掉。
 */
const handleListEnter: Command = (state, dispatch) => {
  const context = listContext(state);
  if (!context) return false;
  const { $from } = state.selection;

  if (context.isEmptyItem) {
    // 需求 5.1：嵌套空项回车 = 原位升一级（等价 Shift-Tab 的提升），
    // 空项本身保留，光标不动，用户可输入或继续回车再升一级。
    const nested =
      context.itemDepth >= 3 &&
      $from.node(context.itemDepth - 2).type ===
        state.schema.nodes.list_item;
    if (nested) {
      return liftListItem(state.schema.nodes.list_item)(state, dispatch);
    }

    if (!dispatch) return true;
    // 唯一空项替换后可能留下空列表壳，需扩大到整个列表范围。
    const replaceDepth =
      context.itemCount === 1 ? context.itemDepth - 1 : context.itemDepth;
    const { from, to } = itemRange($from, replaceDepth);
    const tr = state.tr.replaceWith(
      from,
      to,
      state.schema.nodes.paragraph.create(),
    );
    tr.setSelection(TextSelection.near(tr.doc.resolve(from + 1), 1));
    dispatch(tr);
    return true;
  }

  // 光标在“带子列表的项”首段末尾时，splitListItem 会把子列表挪进
  // 新项；改为在整个项之后插入新的空同级项（Typora 行为，子列表
  // 留在原项下）。
  const item = $from.node(context.itemDepth);
  if (
    item.childCount > 1 &&
    $from.index(context.itemDepth) === 0 &&
    $from.parentOffset === $from.parent.content.size
  ) {
    if (!dispatch) return true;
    const insertAt = $from.after(context.itemDepth);
    const tr = state.tr.insert(
      insertAt,
      state.schema.nodes.list_item.create(
        null,
        state.schema.nodes.paragraph.create(),
      ),
    );
    tr.setSelection(TextSelection.near(tr.doc.resolve(insertAt + 2), 1));
    dispatch(tr);
    return true;
  }

  return splitListItem(state.schema.nodes.list_item)(state, dispatch);
};

/** Tab：非首项缩进为上一项的子列表；首项吞掉按键保持焦点。 */
const handleListTab: Command = (state, dispatch) => {
  const context = listContext(state);
  if (!context) return false;
  if (context.itemIndex === 0) return true;
  return sinkListItem(state.schema.nodes.list_item)(state, dispatch);
};

/** Shift-Tab：把当前项提升一级。 */
const handleListShiftTab: Command = (state, dispatch) => {
  if (!listContext(state)) return false;
  return liftListItem(state.schema.nodes.list_item)(state, dispatch);
};

export function listEditingPlugin(): Plugin {
  // 顺序要求：在 pendingSyntax（块级语法回车确认）之后、base keymap
  // 的 Enter（splitBlock）之前生效。
  return keymap({
    Enter: handleListEnter,
    Tab: handleListTab,
    "Shift-Tab": handleListShiftTab,
  });
}
