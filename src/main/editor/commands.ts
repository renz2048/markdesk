import {
  setBlockType,
  toggleMark,
  wrapIn,
} from "prosemirror-commands";
import { wrapInList } from "prosemirror-schema-list";
import type { Mark, Node as PMNode, ResolvedPos } from "prosemirror-model";
import { TextSelection } from "prosemirror-state";
import type {
  Command,
  EditorState,
  Transaction,
} from "prosemirror-state";
import { findWrapping } from "prosemirror-transform";
import { markdownSchema } from "../../markdown/schema";
import { normalizeLinkHref } from "../../markdown/urlPolicy";

export { normalizeLinkHref };

export const formattingKeymap: Record<string, Command> = {
  "Mod-b": toggleMarkByName("strong"),
  "Mod-i": toggleMarkByName("em"),
  "Mod-e": toggleMarkByName("code"),
  "Mod-Shift-x": toggleMarkByName("strikethrough"),
  "Mod-Shift-8": toggleBulletList(),
  "Mod-Shift-9": toggleOrderedList(),
};

export function setHeading(level: number): Command {
  if (!Number.isInteger(level) || level < 1 || level > 6) {
    throw new RangeError(`Heading level must be between 1 and 6: ${level}`);
  }

  return setBlockType(markdownSchema.nodes.heading, { level });
}

export function toggleMarkByName(name: string): Command {
  const mark = markdownSchema.marks[name];
  if (!mark) throw new Error(`Unknown mark: ${name}`);
  return toggleMark(mark);
}

export function setLink(href: string): Command {
  // 先验证（非法方案在此抛出），通过后保留作者输入的形式，
  // 避免 URL API 规范化（如自动补结尾斜杠）改写链接。
  normalizeLinkHref(href);
  const normalizedHref = href.trim();

  return (state: EditorState, dispatch?: (transaction: Transaction) => void) => {
    if (dispatch) {
      const tr = state.tr;
      const createLinkMark = (title: string | null) =>
        markdownSchema.marks.link.create({ href: normalizedHref, title });

      if (state.selection.empty) {
        const existingRange = contiguousLinkRange(state.selection.$from);
        if (existingRange) {
          tr.addMark(
            existingRange.from,
            existingRange.to,
            createLinkMark(existingRange.title),
          );
        }
        tr.addStoredMark(
          createLinkMark(existingRange?.title ?? null),
        );
      } else {
        for (const range of state.selection.ranges) {
          const from = Math.min(range.$from.pos, range.$to.pos);
          const to = Math.max(range.$from.pos, range.$to.pos);
          let markedText = false;

          state.doc.nodesBetween(from, to, (node: PMNode, pos: number) => {
            if (!node.isText) return true;

            const start = Math.max(from, pos);
            const end = Math.min(to, pos + node.nodeSize);
            if (start >= end) return true;

            const existingLink = node.marks.find(
              (mark: Mark) => mark.type === markdownSchema.marks.link,
            );
            tr.addMark(
              start,
              end,
              createLinkMark(existingLink?.attrs.title ?? null),
            );
            markedText = true;
            return true;
          });

          if (!markedText) {
            tr.addMark(from, to, createLinkMark(null));
          }
        }
      }

      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

export function selectedLinkHref(state: EditorState): string | null {
  if (state.selection.empty) {
    const marks = state.storedMarks ?? state.selection.$from.marks();
    const link = marks.find((mark: Mark) => mark.type === markdownSchema.marks.link);
    return link?.attrs.href ?? null;
  }

  let href: string | null = null;
  state.doc.nodesBetween(state.selection.from, state.selection.to, (node: PMNode) => {
    const link = node.marks.find((mark: Mark) => mark.type === markdownSchema.marks.link);
    if (link && href === null) href = link.attrs.href as string;
    return href === null;
  });
  return href;
}

function contiguousLinkRange($position: ResolvedPos): {
  from: number;
  to: number;
  title: string | null;
} | null {
  const parent = $position.parent;
  const offsets: Array<{
    from: number;
    to: number;
    hasLink: boolean;
    title: string | null;
  }> = [];

  parent.forEach((node: PMNode, offset: number) => {
    const link = node.marks.find(
      (mark: Mark) => mark.type === markdownSchema.marks.link,
    );
    offsets.push({
      from: offset,
      to: offset + node.nodeSize,
      hasLink: Boolean(link),
      title: link?.attrs.title ?? null,
    });
  });

  const cursor = $position.parentOffset;
  const selected = offsets.find(
    ({ from, to, hasLink }) => hasLink && cursor >= from && cursor <= to,
  );
  if (!selected) return null;

  const selectedIndex = offsets.indexOf(selected);
  let startIndex = selectedIndex;
  let endIndex = selectedIndex;

  while (startIndex > 0 && offsets[startIndex - 1].hasLink) startIndex -= 1;
  while (endIndex < offsets.length - 1 && offsets[endIndex + 1].hasLink) {
    endIndex += 1;
  }

  const parentStart = $position.start();
  return {
    from: parentStart + offsets[startIndex].from,
    to: parentStart + offsets[endIndex].to,
    title: selected.title,
  };
}

export function toggleBulletList(): Command {
  return wrapInList(markdownSchema.nodes.bullet_list);
}

export function toggleOrderedList(): Command {
  return wrapInList(markdownSchema.nodes.ordered_list);
}

export function setBlockquote(): Command {
  return wrapIn(markdownSchema.nodes.blockquote);
}

export function setCodeBlock(): Command {
  return setBlockType(markdownSchema.nodes.code_block, { language: "" });
}

export function insertHorizontalRule(): Command {
  return (state: EditorState, dispatch?: (transaction: Transaction) => void) => {
    if (dispatch) {
      dispatch(
        state.tr
          .replaceSelectionWith(markdownSchema.nodes.horizontal_rule.create())
          .scrollIntoView(),
      );
    }
    return true;
  };
}

/** 提升标题级别（h2→h1）；在 h1 上无操作。Ctrl+= */
export function promoteHeading(): Command {
  return changeHeadingLevel(-1);
}

/** 降低标题级别（h1→h2）；h6 再降级回到普通段落（Typora 行为）。Ctrl+- */
export function demoteHeading(): Command {
  return changeHeadingLevel(1);
}

function changeHeadingLevel(delta: number): Command {
  return (state: EditorState, dispatch?: (tr: Transaction) => void) => {
    const { $from } = state.selection;
    if ($from.parent.type !== markdownSchema.nodes.heading) return false;
    const level = Number($from.parent.attrs.level) + delta;
    if (level < 1) return false;
    if (!dispatch) return true;
    if (level > 6) {
      dispatch(
        state.tr.setBlockType(
          $from.before(),
          $from.after(),
          markdownSchema.nodes.paragraph,
        ),
      );
      return true;
    }
    dispatch(
      state.tr.setBlockType($from.before(), $from.after(), markdownSchema.nodes.heading, {
        level,
      }),
    );
    return true;
  };
}

/**
 * 插入 columns 列 × rows 行表格（含表头行，默认 3×4，Ctrl+T 弹窗确认
 * 后调用），光标落入首个单元格。表格成为文档末块时在其后保留两个空
 * 段落作续写落点（plan.md：表格下方应保留两行空行）；空段落序列化不
 * 产生输出，不影响保存的 Markdown 规范形式。
 */
export function insertTable(columns = 3, rows = 4): Command {
  return (state: EditorState, dispatch?: (tr: Transaction) => void) => {
    const columnCount = Math.min(Math.max(Math.trunc(columns) || 1, 1), 64);
    const rowCount = Math.min(Math.max(Math.trunc(rows) || 1, 1), 64);
    const makeRow = (header: boolean) =>
      markdownSchema.nodes.table_row.create(
        null,
        Array.from({ length: columnCount }, () =>
          markdownSchema.nodes.table_cell.create({ header }),
        ),
      );
    const table = markdownSchema.nodes.table.create(null, [
      makeRow(true),
      ...Array.from({ length: rowCount - 1 }, () => makeRow(false)),
    ]);
    if (!dispatch) return true;
    const tr = state.tr.replaceSelectionWith(table);
    const tableStart = tr.selection.from - table.nodeSize;
    const tableEnd = tableStart + table.nodeSize;
    if (!tr.doc.resolve(tableEnd).nodeAfter) {
      for (let index = 0; index < 2; index += 1) {
        tr.insert(tableEnd, markdownSchema.nodes.paragraph.create());
      }
    }
    // doc > table > row > cell 的内容起点：+3。
    tr.setSelection(
      TextSelection.near(tr.doc.resolve(tableStart + 3), 1),
    );
    dispatch(tr);
    return true;
  };
}

/**
 * 切换任务列表：在无序列表项内切换该项的任务勾选属性；在普通段落
 * 上则包一层无序列表并把当前项标记为任务。
 */
export function toggleTaskList(): Command {
  return (state: EditorState, dispatch?: (tr: Transaction) => void) => {
    const { $from } = state.selection;

    const taskItemPosition = ($resolved: typeof $from): number => {
      for (let depth = $resolved.depth - 1; depth >= 1; depth -= 1) {
        if ($resolved.node(depth).type !== markdownSchema.nodes.bullet_list) {
          continue;
        }
        const item = $resolved.node(depth + 1);
        if (item.type === markdownSchema.nodes.list_item) {
          return $resolved.before(depth + 1);
        }
      }
      return -1;
    };

    const itemPos = taskItemPosition($from);
    if (itemPos >= 0) {
      const item = $from.doc.nodeAt(itemPos);
      if (!item) return false;
      if (!dispatch) return true;
      dispatch(
        state.tr.setNodeMarkup(itemPos, null, {
          ...item.attrs,
          task: item.attrs.task ? null : true,
        }),
      );
      return true;
    }

    const range = $from.blockRange();
    const wrapping =
      range && findWrapping(range, markdownSchema.nodes.bullet_list);
    if (!range || !wrapping || !dispatch) return range !== null;
    const tr = state.tr.wrap(range, wrapping);
    const $after = tr.doc.resolve(tr.mapping.map($from.pos));
    const wrappedItemPos = taskItemPosition($after);
    if (wrappedItemPos >= 0) {
      tr.setNodeMarkup(wrappedItemPos, null, { task: true });
    }
    dispatch(tr);
    return true;
  };
}

/** 清除选区内全部行内样式；光标态清除待应用样式。Ctrl+\ */
export function clearFormatting(): Command {
  return (state: EditorState, dispatch?: (tr: Transaction) => void) => {
    if (!dispatch) return true;
    const { from, to, empty } = state.selection;
    const tr = state.tr;
    if (empty) tr.setStoredMarks([]);
    else tr.removeMark(from, to);
    dispatch(tr);
    return true;
  };
}

/** 在选区处插入图片（来源由调用方决定：资源目录相对路径或 data URL）。 */
export function insertImage(src: string, alt = "图片"): Command {
  return (state: EditorState, dispatch?: (tr: Transaction) => void) => {
    if (!dispatch) return true;
    dispatch(
      state.tr.replaceSelectionWith(
        markdownSchema.nodes.image.create({ src, alt }),
      ),
    );
    return true;
  };
}

/** 当前块切换回普通段落（标题/代码块 → 段落）。Ctrl+0（Typora「段落」）。 */
export function setParagraph(): Command {
  return setBlockType(markdownSchema.nodes.paragraph);
}
