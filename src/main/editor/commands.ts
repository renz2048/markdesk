import { Command, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import { wrapInList } from "prosemirror-schema-list";
import { markdownSchema } from "../../markdown/schema";

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
  if (!href) throw new Error("Link href cannot be empty");
  return toggleMark(markdownSchema.marks.link, { href });
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
  return (state, dispatch) => {
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
