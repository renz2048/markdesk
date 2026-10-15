import { describe, expect, it } from "vitest";
import { EditorState, TextSelection, Transaction } from "prosemirror-state";
import { Node } from "prosemirror-model";
import type { Command } from "prosemirror-commands";
import { parseMarkdown } from "../../src/markdown/parser";
import { markdownSchema } from "../../src/markdown/schema";
import {
  insertHorizontalRule,
  setBlockquote,
  setCodeBlock,
  setHeading,
  setLink,
  toggleBulletList,
  toggleOrderedList,
  toggleMarkByName,
} from "../../src/main/editor/commands";

function stateFor(source: string, selectAllText = false): EditorState {
  const doc = parseMarkdown(source);
  const firstBlockSize = doc.firstChild?.nodeSize ?? 0;
  const selection = selectAllText
    ? TextSelection.create(doc, 1, Math.max(1, firstBlockSize - 1))
    : undefined;
  return EditorState.create({ schema: markdownSchema, doc, selection });
}

function applyCommand(command: Command, state: EditorState): EditorState {
  let dispatched: Transaction | undefined;
  const result = command(state, (transaction) => {
    dispatched = transaction;
  });
  expect(result).toBe(true);
  if (!dispatched) throw new Error("expected a command transaction");
  return state.apply(dispatched);
}

function firstChild(doc: Node) {
  const child = doc.firstChild;
  expect(child).toBeDefined();
  return child as Node;
}

describe("editor commands", () => {
  it("changes the current block to a heading", () => {
    const next = applyCommand(setHeading(2), stateFor("Paragraph"));
    expect(firstChild(next.doc).type.name).toBe("heading");
    expect(firstChild(next.doc).attrs.level).toBe(2);
  });

  it("toggles marks by schema name", () => {
    const next = applyCommand(
      toggleMarkByName("strong"),
      stateFor("Important", true),
    );
    expect(
      firstChild(next.doc).firstChild?.marks.map((mark) => mark.type.name),
    ).toEqual(["strong"]);
  });

  it("rejects unknown mark names before dispatch", () => {
    expect(() => toggleMarkByName("unknown")).toThrow("Unknown mark: unknown");
  });

  it("rejects invalid heading levels and empty links", () => {
    expect(() => setHeading(0)).toThrow(RangeError);
    expect(() => setLink("")).toThrow("Link href cannot be empty");
  });

  it("wraps blocks in list types", () => {
    const bullet = applyCommand(toggleBulletList(), stateFor("Paragraph"));
    expect(firstChild(bullet.doc).type.name).toBe("bullet_list");

    const ordered = applyCommand(toggleOrderedList(), stateFor("Paragraph"));
    expect(firstChild(ordered.doc).type.name).toBe("ordered_list");
  });

  it("wraps blocks in a blockquote and code block", () => {
    const quote = applyCommand(setBlockquote(), stateFor("Paragraph"));
    expect(firstChild(quote.doc).type.name).toBe("blockquote");

    const code = applyCommand(setCodeBlock(), stateFor("Paragraph"));
    expect(firstChild(code.doc).type.name).toBe("code_block");
  });

  it("adds a link with caller-supplied href", () => {
    const next = applyCommand(
      setLink("https://example.com/docs"),
      stateFor("Docs", true),
    );
    expect(
      firstChild(next.doc).firstChild?.marks.map((mark) => mark.attrs.href),
    ).toEqual(["https://example.com/docs"]);
  });

  it("inserts a horizontal rule", () => {
    const next = applyCommand(insertHorizontalRule(), stateFor("Paragraph"));
    expect(next.doc.firstChild?.type.name).toBe("horizontal_rule");
  });
});
