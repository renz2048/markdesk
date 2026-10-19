import { describe, expect, it } from "vitest";
import { markdownSchema } from "../../src/markdown/schema";
import { parseMarkdown } from "../../src/markdown/parser";
import {
  rawBlockFromSource,
  rawBlockSource,
} from "../../src/markdown/protectedRaw";
import { serializeMarkdown } from "../../src/markdown/serializer";

function tableDocument(source: string) {
  const document = parseMarkdown(source);
  const table = document.child(0);
  if (table.type !== markdownSchema.nodes.table) {
    throw new Error(`expected a table, received ${table.type.name}`);
  }
  return table;
}

describe("complex Markdown", () => {
  it("imports and initializes the parser with valid markdown-it rules", () => {
    expect(parseMarkdown("").childCount).toBe(0);
  });

  it("round-trips a table with alignment", () => {
    const source = [
      "| A | B |",
      "| --- | :---: |",
      "| 1 | 2 |",
      "",
    ].join("\n");
    const doc = parseMarkdown(source);
    expect(doc.child(0).type).toBe(markdownSchema.nodes.table);
    const once = serializeMarkdown(doc);
    expect(serializeMarkdown(parseMarkdown(once))).toBe(once);
    expect(once).toContain("| A | B |");
    expect(once).toContain(":---:");
  });

  it("preserves table structure, alignment, headers, and escaped pipes", () => {
    const source = [
      "| Left | Center | Right |",
      "| :--- | :---: | ---: |",
      "| a\\|b | long cell | x |",
      "| longer | c | done |",
      "",
    ].join("\n");
    const table = tableDocument(source);

    expect(table.childCount).toBe(3);
    expect(table.child(0).type).toBe(markdownSchema.nodes.table_row);
    expect(table.child(1).type).toBe(markdownSchema.nodes.table_row);
    expect(table.child(2).type).toBe(markdownSchema.nodes.table_row);

    const headers = table.child(0);
    expect(headers.childCount).toBe(3);
    expect(headers.child(0).type).toBe(markdownSchema.nodes.table_cell);
    expect(headers.child(0).attrs.header).toBe(true);
    expect(headers.child(1).attrs.header).toBe(true);
    expect(headers.child(2).attrs.header).toBe(true);
    expect(headers.child(0).attrs.alignment).toBe("left");
    expect(headers.child(1).attrs.alignment).toBe("center");
    expect(headers.child(2).attrs.alignment).toBe("right");

    const body = table.child(1);
    expect(body.child(0).attrs.header).toBe(false);
    expect(body.child(1).attrs.header).toBe(false);
    expect(body.child(2).attrs.header).toBe(false);
    expect(body.child(0).attrs.alignment).toBe("left");
    expect(body.child(1).attrs.alignment).toBe("center");
    expect(body.child(2).attrs.alignment).toBe("right");
    expect(body.child(0).textContent).toBe("a|b");

    const expected = [
      "| Left   |  Center   | Right |",
      "| :----- | :-------: | ----: |",
      "| a\\|b   | long cell |     x |",
      "| longer |     c     |  done |",
      "",
    ].join("\n");
    expect(serializeMarkdown(parseMarkdown(source))).toBe(expected);
    const once = serializeMarkdown(parseMarkdown(expected));
    expect(once).toBe(expected);
    expect(serializeMarkdown(parseMarkdown(once))).toBe(once);
  });

  it("round-trips task lists", () => {
    const source = "- [ ] alpha\n- [x] beta\n";
    const doc = parseMarkdown(source);
    const list = doc.child(0);
    expect(list.child(0).attrs.task).toBe("todo");
    expect(list.child(1).attrs.task).toBe("done");
    expect(serializeMarkdown(doc)).toBe(source);
  });

  it("normalizes ragged table rows to stable column widths", () => {
    const source = ["| A | B |", "| --- | --- |", "| only |", ""].join("\n");
    const table = tableDocument(source);
    expect(table.child(1).childCount).toBe(2);

    // 列宽只取各列单元格内容的最大显示宽度（与计划中
    // "round-trips a table with alignment" 的 "| A | B |" 约定一致），
    // 分隔符在窄列时保持最小形态，不反向撑宽列。
    const expected = [
      "| A    | B |",
      "| :--- | :--- |",
      "| only |   |",
      "",
    ].join("\n");
    expect(serializeMarkdown(parseMarkdown(source))).toBe(expected);
    const once = serializeMarkdown(parseMarkdown(expected));
    expect(once).toBe(expected);
    expect(serializeMarkdown(parseMarkdown(once))).toBe(once);
  });

  it("uses Unicode display width for CJK, emoji, and combining marks", () => {
    const combiningAcute = "e\u0301";
    const source = [
      "| A |",
      "| --- |",
      "| 中文 |",
      "| 👍 |",
      `| ${combiningAcute} |`,
      "",
    ].join("\n");
    const expected = [
      "| A    |",
      "| :--- |",
      "| 中文 |",
      "| 👍   |",
      `| ${combiningAcute}    |`,
      "",
    ].join("\n");

    expect(serializeMarkdown(parseMarkdown(source))).toBe(expected);
    const once = serializeMarkdown(parseMarkdown(expected));
    expect(once).toBe(expected);
    expect(serializeMarkdown(parseMarkdown(once))).toBe(once);
  });

  it("rejects hard breaks in table cells instead of emitting a broken row", () => {
    const cell = markdownSchema.nodes.table_cell.createAndFill({}, [
      markdownSchema.text("before"),
      markdownSchema.nodes.hard_break.create(),
      markdownSchema.text("after"),
    ]);
    if (!cell) throw new Error("expected a valid table cell");

    const row = markdownSchema.nodes.table_row.createAndFill({}, cell);
    if (!row) throw new Error("expected a valid table row");

    const table = markdownSchema.nodes.table.createAndFill({}, row);
    if (!table) throw new Error("expected a valid table");

    const doc = markdownSchema.nodes.doc.createAndFill({}, table);
    if (!doc) throw new Error("expected a valid document");

    expect(() => serializeMarkdown(doc)).toThrow(RangeError);
  });

  it("separates task state from ordinary list-item state", () => {
    const source = "- [ ] unfinished\n- ordinary\n";
    const list = parseMarkdown(source).child(0);
    expect(list.child(0).attrs.task).toBe("todo");
    expect(list.child(0).child(0).textContent).toBe("unfinished");
    expect(list.child(1).attrs.task).toBeNull();
    expect(list.child(1).child(0).textContent).toBe("ordinary");
    // 序列化入口以文档节点为根；对整篇文档往返的结果即列表的规范输出。
    expect(serializeMarkdown(parseMarkdown(source))).toBe(source);
  });

  it("round-trips nested task lists with exact indentation", () => {
    const source = "- [ ] outer\n  - [x] inner\n";
    const outerItem = parseMarkdown(source).child(0).child(0);
    const innerItem = outerItem.child(1).child(0);
    expect(outerItem.attrs.task).toBe("todo");
    expect(innerItem.attrs.task).toBe("done");

    const once = serializeMarkdown(parseMarkdown(source));
    expect(once).toBe(source);
    expect(serializeMarkdown(parseMarkdown(once))).toBe(once);
  });

  it("preserves HTML comments as raw blocks", () => {
    const source = "<!-- internal note -->\n\nParagraph\n";
    const doc = parseMarkdown(source);
    expect(doc.child(0).type).toBe(markdownSchema.nodes.raw_block);
    expect(doc.child(0).attrs.source).toBe("<!-- internal note -->");
    expect(doc.child(1).type).toBe(markdownSchema.nodes.paragraph);
    expect(serializeMarkdown(doc)).toBe(source);
  });

  it("preserves multiline HTML comments and keeps the protected text intact", () => {
    const source = "<!-- first line\nsecond line -->\n\nParagraph\n";
    const rawBlock = parseMarkdown(source).child(0);
    expect(rawBlock.type).toBe(markdownSchema.nodes.raw_block);
    expect(rawBlock.attrs.source).toBe("<!-- first line\nsecond line -->");
    expect(serializeMarkdown(parseMarkdown(source))).toBe(source);
  });

  it("preserves adjacent HTML comments as separate raw blocks", () => {
    const source = "<!-- first -->\n\n<!-- second -->\n";
    const doc = parseMarkdown(source);
    expect(doc.childCount).toBe(2);
    expect(doc.child(0).type).toBe(markdownSchema.nodes.raw_block);
    expect(doc.child(0).attrs.source).toBe("<!-- first -->");
    expect(doc.child(1).type).toBe(markdownSchema.nodes.raw_block);
    expect(doc.child(1).attrs.source).toBe("<!-- second -->");
    expect(serializeMarkdown(doc)).toBe(source);
    expect(serializeMarkdown(parseMarkdown(source))).toBe(source);
  });

  it("keeps inline HTML disabled when block HTML is enabled", () => {
    const source = "Inline <em>not markup</em> stays text\n";
    const paragraph = parseMarkdown(source).child(0);
    expect(paragraph.type).toBe(markdownSchema.nodes.paragraph);
    expect(paragraph.textContent).toBe(
      "Inline <em>not markup</em> stays text",
    );
    expect(paragraph.child(0).marks).toHaveLength(0);
  });

  it("provides typed protected-raw helpers", () => {
    const rawBlock = rawBlockFromSource("<!-- helper -->");
    expect(rawBlock.type).toBe(markdownSchema.nodes.raw_block);
    expect(rawBlockSource(rawBlock)).toBe("<!-- helper -->");
    expect(() => rawBlockSource(markdownSchema.nodes.paragraph.create())).toThrow(
      TypeError,
    );
  });

  it("keeps helper raw sources intact, including internal blank lines", () => {
    const source = "<!-- first\n\nsecond\r\nthird -->";
    const rawBlock = rawBlockFromSource(source);
    expect(rawBlockSource(rawBlock)).toBe(source);
    expect(rawBlock.attrs.source).toBe(source);
  });

  it("is idempotent for a representative document", () => {
    const source = [
      "# Demo",
      "",
      "- [x] complete",
      "- [ ] pending",
      "",
      "| Name | Value |",
      "| ---: | --- |",
      "| x | 1 |",
      "",
      "> quote",
      "",
      "```python",
      "print('hi')",
      "```",
      "",
      "<!-- keep -->",
      "",
    ].join("\n");
    const once = serializeMarkdown(parseMarkdown(source));
    const twice = serializeMarkdown(parseMarkdown(once));
    expect(twice).toBe(once);
  });
});
