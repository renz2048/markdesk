import { describe, expect, it } from "vitest";
import { EditorState, TextSelection, Transaction } from "prosemirror-state";
import type { Command } from "prosemirror-state";
import type { Node } from "prosemirror-model";
import { parseMarkdown } from "../../src/markdown/parser";
import { markdownSchema } from "../../src/markdown/schema";
import { createEditorPlugins } from "../../src/main/components/WysiwygEditor";
import {
  formattingKeymap,
  insertHorizontalRule,
  normalizeLinkHref,
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
  const result = command(state, (transaction: Transaction) => {
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

function stateWithTextRange(source: string, text: string): EditorState {
  const doc = parseMarkdown(source);
  let range: { from: number; to: number } | undefined;
  doc.descendants((node, pos) => {
    if (node.isText && node.textContent === text && !range) {
      range = { from: pos, to: pos + node.nodeSize };
    }
    return true;
  });
  if (!range) throw new Error(`text fixture not found: ${text}`);
  return EditorState.create({
    schema: markdownSchema,
    doc,
    selection: TextSelection.create(doc, range.from, range.to),
  });
}

function cursorInText(source: string, text: string): EditorState {
  const doc = parseMarkdown(source);
  let position: number | undefined;
  doc.descendants((node, pos) => {
    if (node.isText && node.textContent === text && position === undefined) {
      position = pos + Math.floor(text.length / 2);
    }
    return true;
  });
  if (position === undefined) throw new Error(`text fixture not found: ${text}`);
  return EditorState.create({
    schema: markdownSchema,
    doc,
    selection: TextSelection.create(doc, position),
  });
}

function stateForEntireDocumentText(source: string): EditorState {
  const doc = parseMarkdown(source);
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  doc.descendants((node, pos) => {
    if (node.isText) {
      from = Math.min(from, pos);
      to = Math.max(to, pos + node.nodeSize);
    }
    return true;
  });
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    throw new Error("text fixture has no text nodes");
  }
  return EditorState.create({
    schema: markdownSchema,
    doc,
    selection: TextSelection.create(doc, from, to),
  });
}

function linkHrefs(doc: Node): (string | undefined)[] {
  const hrefs: (string | undefined)[] = [];
  doc.descendants((node) => {
    if (node.isText) {
      hrefs.push(node.marks.find((mark) => mark.type.name === "link")?.attrs.href);
    }
    return true;
  });
  return hrefs;
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
    expect(() => setLink("")).toThrow("Unsafe or malformed link URL");
  });

  it("binds explicit formatting shortcuts and installs them before base keys", () => {
    expect(Object.keys(formattingKeymap)).toEqual([
      "Mod-b",
      "Mod-i",
      "Mod-e",
      "Mod-Shift-x",
      "Mod-Shift-8",
      "Mod-Shift-9",
    ]);
    // history/undo keymap、formatting keymap、pending syntax、
    // list editing、table editing、base keymap、input rules、
    // drop cursor、gap cursor 共 10 个插件。
    expect(createEditorPlugins()).toHaveLength(10);

    const bold = applyCommand(
      formattingKeymap["Mod-b"],
      stateFor("Important", true),
    );
    expect(
      firstChild(bold.doc).firstChild?.marks.map((mark) => mark.type.name),
    ).toContain("strong");
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

  it("replaces an existing link while preserving unrelated marks", () => {
    const source =
      '[**bold link**](https://old.example/docs "Existing title")';
    const next = applyCommand(
      setLink("https://new.example/latest"),
      stateWithTextRange(source, "bold link"),
    );
    const text = firstChild(next.doc).firstChild;
    expect(text?.marks.map((mark) => mark.type.name)).toEqual(
      expect.arrayContaining(["strong", "link"]),
    );
    expect(text?.marks.find((mark) => mark.type.name === "link")?.attrs.href).toBe(
      "https://new.example/latest",
    );
    expect(
      text?.marks.find((mark) => mark.type.name === "link")?.attrs.title,
    ).toBe("Existing title");
  });

  it("sets one href over multiple ranges and plain text in a selection", () => {
    const source =
      "[First](https://one.example) middle [Second](https://two.example)";
    const doc = parseMarkdown(source);
    const next = applyCommand(
      setLink("https://shared.example"),
      stateForEntireDocumentText(source),
    );
    // 三个文本段都被赋予同一个链接 mark 后，ProseMirror 会把携带相同
    // mark 的相邻文本节点合并为一个，因此只收集到一个 href。
    expect(linkHrefs(next.doc)).toEqual(["https://shared.example"]);
  });

  it("updates and extends an existing link from an empty cursor", () => {
    const next = applyCommand(
      setLink("https://updated.example"),
      cursorInText("[Linked](https://old.example)", "Linked"),
    );
    expect(linkHrefs(next.doc)).toEqual(["https://updated.example"]);
    // 文档变更会清除 storedMarks（prosemirror-state 语义）；链接的延续
    // 由光标所在位置的 marks 保证。
    expect(
      next.selection.$from.marks().map((mark) => mark.type.name),
    ).toContain("link");
  });

  it("stores a new link mark for typing from an empty cursor", () => {
    const next = applyCommand(
      setLink("https://typed.example"),
      stateFor("Paragraph"),
    );
    expect(next.storedMarks?.map((mark) => mark.type.name)).toContain("link");
  });

  it("inserts a horizontal rule", () => {
    const next = applyCommand(insertHorizontalRule(), stateFor("Paragraph"));
    expect(next.doc.firstChild?.type.name).toBe("horizontal_rule");
  });

  it("normalizes safe URLs and rejects unsafe or malformed URLs", () => {
    expect(normalizeLinkHref("  HTTPS://Example.com/path?x=1  ")).toBe(
      "https://example.com/path?x=1",
    );
    expect(normalizeLinkHref("docs/page.md")).toBe("docs/page.md");
    expect(normalizeLinkHref("  ./docs/page.md  ")).toBe("docs/page.md");
    expect(normalizeLinkHref("#section")).toBe("#section");
    expect(normalizeLinkHref("mailto:user@example.com")).toBe(
      "mailto:user@example.com",
    );

    for (const unsafe of [
      "javascript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "vbscript:msgbox(1)",
      "https://example.com/\u0000",
      "https://[malformed",
      "http://",
      "//example.com/path",
      "\\\\example.com\\path",
      "/\\example.com/path",
      "\\/example.com/path",
    ]) {
      expect(() => normalizeLinkHref(unsafe)).toThrow(/unsafe or malformed/i);
    }
  });
});
