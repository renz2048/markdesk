import { splitBlock } from "prosemirror-commands";
import type { NodeType } from "prosemirror-model";
import type { Command, EditorState } from "prosemirror-state";
import { Plugin, TextSelection } from "prosemirror-state";
import { findWrapping } from "prosemirror-transform";
import { Decoration, DecorationSet } from "prosemirror-view";

/**
 * Typora 式块级语法缓冲：行首输入 “# ” “> ” “- ” “1. ” ``` --- 等
 * 不立即转换，而是以浅色标记 + 预览样式提示；输入标记后的字符时标记
 * 变浅色、标题文字变粗体，按回车才把整行转换为对应块级结构。
 *
 * 实现上底层文本始终是普通段落（非破坏性预览），装饰随光标所在段落
 * 计算；回车由 handleKeyDown 在 base keymap 之前拦截并提交转换。
 */

// 列表（- / 1.）走即时转换（见 inputRules），不参与缓冲确认。
type PendingKind = "heading" | "quote" | "fence" | "hr";

export interface PendingSyntax {
  kind: PendingKind;
  // heading：标题级别。
  level: number;
  // 所在段落的块级范围与标记（含尾随空格）范围。
  blockFrom: number;
  blockTo: number;
  markerFrom: number;
  markerTo: number;
  contentEnd: number;
  // 是否已在标记后输入了其他字符（决定是否显示预览样式）。
  hasPreview: boolean;
}

// 分支顺序：标题、引用、代码围栏、两种分隔线写法。
// “* ” 的列表即时规则先于本插件消费该输入，“***” 仍按分隔线匹配。
const PENDING_BLOCK = /^(?:(#{1,6})\s|(>)\s|(```)|(---)|(\*\*\*))/;

/**
 * 匹配光标所在段落的待确认块级语法。仅普通段落参与（标题、代码块
 * 内不再嵌套待确认语法），且要求选区为空。
 */
export function matchPendingSyntax(
  state: EditorState,
): PendingSyntax | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const { $from } = selection;
  if (
    !$from.parent.isTextblock ||
    $from.parent.type !== state.schema.nodes.paragraph
  ) {
    return null;
  }
  const parentOffset = $from.parentOffset;
  if (parentOffset === 0) return null;
  const before = $from.parent.textBetween(0, parentOffset, null, "￼");
  const match = PENDING_BLOCK.exec(before);
  if (!match) return null;

  let kind: PendingKind;
  let level = 1;
  if (match[1]) {
    kind = "heading";
    level = match[1].length;
  } else if (match[2]) {
    kind = "quote";
  } else if (match[3]) {
    kind = "fence";
  } else {
    kind = "hr";
  }

  const blockFrom = $from.before();
  const blockTo = $from.after();
  const markerFrom = blockFrom + 1;
  return {
    kind,
    level,
    blockFrom,
    blockTo,
    markerFrom,
    markerTo: markerFrom + match[0].length,
    contentEnd: blockTo - 1,
    hasPreview: parentOffset > match[0].length,
  };
}

function pendingDecorations(state: EditorState): DecorationSet {
  const pending = matchPendingSyntax(state);
  // 只输入了标记（如 “# ”）时保持普通文本，输入字符后才出现预览。
  if (!pending || !pending.hasPreview) return DecorationSet.empty;

  const decorations: Decoration[] = [
    Decoration.inline(pending.markerFrom, pending.markerTo, {
      class: "md-syntax-marker",
    }),
  ];
  if (pending.contentEnd > pending.markerTo) {
    if (pending.kind === "heading") {
      decorations.push(
        Decoration.inline(pending.markerTo, pending.contentEnd, {
          class: "md-syntax-heading-preview",
        }),
      );
    } else if (pending.kind === "quote") {
      decorations.push(
        Decoration.inline(pending.markerTo, pending.contentEnd, {
          class: "md-syntax-quote-preview",
        }),
      );
    }
  }
  return DecorationSet.create(state.doc, decorations);
}

/**
 * 提交待确认语法：删除标记并把段落转换为对应结构；标题/引用/列表
 * 转换后与普通回车一致地落到下一行（列表新建一项），代码围栏与
 * 分隔线不额外续行。
 */
export const commitPendingSyntax: Command = (state, dispatch, view) => {
  const pending = matchPendingSyntax(state);
  if (!pending) return false;
  if (!dispatch) return true;

  const schema = state.schema;
  const tr = state.tr.delete(pending.markerFrom, pending.markerTo);
  const blockFrom = tr.mapping.map(pending.blockFrom, -1);
  const blockTo = tr.mapping.map(pending.blockTo, -1);
  const contentStart = tr.mapping.map(pending.markerTo, -1);
  const contentEnd = tr.mapping.map(pending.contentEnd, -1);

  // 结构可行性检查：目标块在当前位置是否可替换/包裹当前段落。
  // 例如本 schema 的列表项首子节点必须是段落，在列表项内把段落转为
  // 标题/引用会得到非法文档；此时不吞回车，交回普通 Enter 处理。
  const $inside = tr.doc.resolve(contentStart);
  const parentAllows = (nodeType: NodeType): boolean =>
    $inside.node(-1).canReplaceWith(
      $inside.index(-1),
      $inside.indexAfter(-1),
      nodeType,
    );

  switch (pending.kind) {
    case "heading":
      if (!parentAllows(schema.nodes.heading)) return false;
      tr.setBlockType(blockFrom, blockTo, schema.nodes.heading, {
        level: pending.level,
      });
      break;
    case "quote": {
      // findWrapping 校验结构可行性并补齐中间层级。
      const range = $inside.blockRange();
      const wrapping =
        range ? findWrapping(range, schema.nodes.blockquote) : null;
      if (!range || !wrapping) return false;
      tr.wrap(range, wrapping);
      break;
    }
    case "fence": {
      if (!parentAllows(schema.nodes.code_block)) return false;
      // CommonMark 信息字符串：光标之前的剩余文本是单个标识符（如
      // ```js）时作为语言并清掉，否则全部保留为代码内容。
      const infoEnd = tr.selection.from;
      const rest = tr.doc
        .textBetween(contentStart, infoEnd, "\n", " ")
        .trim();
      const language = /^[A-Za-z0-9_+#.-]+$/.test(rest) ? rest : "";
      tr.setBlockType(blockFrom, blockTo, schema.nodes.code_block, {
        language,
      });
      if (language && infoEnd > contentStart) {
        tr.delete(contentStart, infoEnd);
      }
      break;
    }
    case "hr":
      if (!parentAllows(schema.nodes.horizontal_rule)) return false;
      tr.replaceWith(blockFrom, blockTo, [
        schema.nodes.horizontal_rule.create(),
        schema.nodes.paragraph.create(),
      ]);
      break;
  }

  // 光标移到行内容末尾；分隔线则进入其后方的空段落。
  if (pending.kind === "hr") {
    tr.setSelection(
      TextSelection.near(tr.doc.resolve(tr.mapping.map(blockFrom + 1, -1)), 1),
    );
  } else {
    const cursor = tr.mapping.map(pending.contentEnd, -1);
    tr.setSelection(TextSelection.near(tr.doc.resolve(cursor), -1));
  }
  // 不显式 scrollIntoView：转换发生在光标处，选区本身会保持在视口
  // 内（且 jsdom 等无头环境不支持坐标计算）。
  dispatch(tr);

  if (!view) return true;
  if (pending.kind === "heading" || pending.kind === "quote") {
    splitBlock(view.state, view.dispatch, view);
  }
  return true;
};

export function pendingSyntaxPlugin(): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        return pendingDecorations(state);
      },
      // 必须在 base keymap 的 Enter（splitBlock）之前拿到回车；输入法
      // 组合期间的回车是确认候选词，不当作语法提交。
      handleKeyDown(view, event) {
        if (
          event.key !== "Enter" ||
          event.shiftKey ||
          event.ctrlKey ||
          event.altKey ||
          event.metaKey ||
          event.isComposing ||
          view.composing
        ) {
          return false;
        }
        return commitPendingSyntax(
          view.state,
          view.dispatch,
          view,
        );
      },
    },
  });
}
