import {
  Command,
  setBlockType,
  toggleMark,
  wrapIn,
} from "prosemirror-commands";
import { wrapInList } from "prosemirror-schema-list";
import type { Mark, Node as PMNode } from "prosemirror-model";
import type { EditorState, ResolvedPos, Transaction } from "prosemirror-state";
import { markdownSchema } from "../../markdown/schema";

const controlCharacterPattern = /[\u0000-\u001f\u007f-\u009f]/;
const schemePattern = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

export function normalizeLinkHref(href: string): string {
  const trimmed = href.trim();
  if (!trimmed || controlCharacterPattern.test(trimmed)) {
    throw new Error("Unsafe or malformed link URL");
  }

  const schemeMatch = schemePattern.exec(trimmed);
  if (!schemeMatch) {
    try {
      new URL(trimmed, "https://markdesk.invalid/");
    } catch {
      throw new Error("Unsafe or malformed link URL");
    }
    return trimmed.replace(/^\.\//, "");
  }

  const scheme = schemeMatch[1].toLowerCase();
  if (!["http", "https", "mailto"].includes(scheme)) {
    throw new Error("Unsafe or malformed link URL");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Unsafe or malformed link URL");
  }

  if ((scheme === "http" || scheme === "https") && !parsed.hostname) {
    throw new Error("Unsafe or malformed link URL");
  }
  return parsed.href;
}

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
  const normalizedHref = normalizeLinkHref(href);

  return (state: EditorState, dispatch?: (transaction: Transaction) => void) => {
    if (dispatch) {
      const mark = markdownSchema.marks.link.create({ href: normalizedHref });
      const tr = state.tr;

      if (state.selection.empty) {
        const existingRange = contiguousLinkRange(state.selection.$from);
        if (existingRange) {
          tr.addMark(existingRange.from, existingRange.to, mark);
        }
        tr.addStoredMark(mark);
      } else {
        for (const range of state.selection.ranges) {
          const from = Math.min(range.from, range.to);
          const to = Math.max(range.from, range.to);
          tr.addMark(from, to, mark);
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
} | null {
  const parent = $position.parent;
  const offsets: Array<{ from: number; to: number; hasLink: boolean }> = [];

  parent.forEach((node: PMNode, offset: number) => {
    offsets.push({
      from: offset,
      to: offset + node.nodeSize,
      hasLink: node.marks.some(
        (mark: Mark) => mark.type === markdownSchema.marks.link,
      ),
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
