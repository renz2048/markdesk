// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import type { Command, Transaction } from "prosemirror-state";
import { DOMSerializer } from "prosemirror-model";
import { markdownSchema } from "../../src/markdown/schema";
import { parseMarkdown } from "../../src/markdown/parser";
import { serializeMarkdown } from "../../src/markdown/serializer";
import { insertTable } from "../../src/main/editor/commands";
import { buildExportHtml } from "../../src/main/editor/exportHtml";

function applyInsertTable(
  source = "",
  cursor?: number,
  columns?: number,
  rows?: number,
): EditorState {
  const command: Command = insertTable(columns, rows);
  const doc = parseMarkdown(source);
  const state = EditorState.create({
    schema: markdownSchema,
    doc,
    selection: TextSelection.near(
      doc.resolve(Math.min(Math.max(cursor ?? doc.content.size, 0), doc.content.size)),
      1,
    ),
  });
  let dispatched: Transaction | undefined;
  expect(command(state, (transaction) => { dispatched = transaction; })).toBe(
    true,
  );
  if (!dispatched) throw new Error("expected a command transaction");
  return state.apply(dispatched);
}

describe("insertTable command", () => {
  it("creates a 3x4 table with a header row and two landing paragraphs below", () => {
    const doc = applyInsertTable().doc;

    // 默认 3 列 × 4 行（含表头）；表格成为末块时补两个空段落
    // （plan.md：表格下方保留两行空行）。
    expect(doc.childCount).toBe(3);
    const table = doc.child(0);
    expect(table.type).toBe(markdownSchema.nodes.table);
    expect(table.childCount).toBe(4);
    for (const child of [doc.child(1), doc.child(2)]) {
      expect(child.type).toBe(markdownSchema.nodes.paragraph);
      expect(child.content.size).toBe(0);
    }

    const [header, body] = [table.child(0), table.child(1)];
    expect(header.childCount).toBe(3);
    expect(body.childCount).toBe(3);
    for (const cell of [header.child(0), header.child(1), header.child(2)]) {
      expect(cell.type).toBe(markdownSchema.nodes.table_cell);
      expect(cell.attrs.header).toBe(true);
    }
    for (const cell of [body.child(0), body.child(1), body.child(2)]) {
      expect(cell.attrs.header).toBe(false);
    }
  });

  it("honors explicit column and row counts from the size dialog", () => {
    const doc = applyInsertTable("", undefined, 2, 3).doc;
    const table = doc.child(0);
    expect(table.childCount).toBe(3);
    expect(table.child(0).childCount).toBe(2);
  });

  it("appends the landing paragraphs when inserting at the end of text", () => {
    // 光标在末段文字末尾：段落文字留在表格上方，表格成为末块 → 补两段落。
    const doc = applyInsertTable("前言\n", 3).doc;
    expect(doc.childCount).toBe(4);
    expect(doc.child(0).textContent).toBe("前言");
    expect(doc.child(1).type).toBe(markdownSchema.nodes.table);
    expect(doc.child(2).type).toBe(markdownSchema.nodes.paragraph);
    expect(doc.child(3).type).toBe(markdownSchema.nodes.paragraph);
  });

  it("does not add an extra paragraph when text follows the table", () => {
    // 光标在段落中间（“段|落”）：光标之后的文字成为表格后的段落，无需补。
    const doc = applyInsertTable("段落\n\n尾段\n", 2).doc;
    expect(doc.childCount).toBe(4);
    expect(doc.child(0).textContent).toBe("段");
    expect(doc.child(1).type).toBe(markdownSchema.nodes.table);
    expect(doc.child(2).textContent).toBe("落");
    expect(doc.child(3).textContent).toBe("尾段");
  });

  it("places the cursor in the first header cell", () => {
    const state = applyInsertTable();
    const { $from } = state.selection;
    const table = state.doc.child(0);

    expect(state.selection).toBeInstanceOf(TextSelection);
    expect($from.depth).toBe(3);
    expect($from.node(3)).toBe(table.child(0).child(0));
    expect($from.node(3).attrs.header).toBe(true);
  });

  it("serializes the inserted table back to a structurally identical one", () => {
    const markdown = serializeMarkdown(applyInsertTable().doc);
    const reparsed = parseMarkdown(markdown);

    const table = reparsed.child(0);
    expect(table.type).toBe(markdownSchema.nodes.table);
    expect(table.childCount).toBe(4);
    expect(table.child(0).childCount).toBe(3);
    expect(table.child(0).child(0).attrs.header).toBe(true);
    expect(table.child(1).child(0).attrs.header).toBe(false);
    expect(serializeMarkdown(reparsed)).toBe(markdown);
  });
});

describe("table DOM rendering", () => {
  it("renders th/td with alignment styles only for non-left columns", () => {
    const source = [
      "| L | C | R |",
      "| :--- | :---: | ---: |",
      "| a | b | c |",
      "",
    ].join("\n");
    const host = document.createElement("div");
    host.append(
      DOMSerializer.fromSchema(markdownSchema).serializeFragment(
        parseMarkdown(source).content,
      ),
    );

    expect(host.querySelector("table")).not.toBeNull();
    expect(host.querySelectorAll("tr")).toHaveLength(2);
    const headers = host.querySelectorAll("tr:first-child > *");
    expect(headers[0].tagName).toBe("TH");
    expect(headers[0].getAttribute("style")).toBeNull();
    expect(headers[1].getAttribute("style")).toBe("text-align:center");
    expect(headers[2].getAttribute("style")).toBe("text-align:right");
    const cells = host.querySelectorAll("tr:nth-child(2) > *");
    expect(cells[0].tagName).toBe("TD");
    expect(cells[1].getAttribute("style")).toBe("text-align:center");
  });
});

describe("table HTML export", () => {
  it("keeps table structure and cell content in the exported document", () => {
    const source = [
      "| 名称 | 数量 |",
      "| --- | ---: |",
      "| 苹果 | 3 |",
      "",
    ].join("\n");
    const html = buildExportHtml(parseMarkdown(source), "light");

    expect(html).toContain("<table>");
    expect(html).toContain("<th>名称</th>");
    expect(html).toContain("<td>苹果</td>");
    // style 已放行（值仅由 table_cell.toDOM 生成的 text-align 构成），
    // 导出的独立 HTML 保留列对齐。
    expect(html).toContain('<td style="text-align:right">3</td>');
  });
});

describe("table parsing edge cases", () => {
  it("parses tables without a leading pipe", () => {
    const doc = parseMarkdown("A | B\n--- | ---\n1 | 2\n");
    const table = doc.child(0);
    expect(table.type).toBe(markdownSchema.nodes.table);
    expect(table.childCount).toBe(2);
    expect(table.child(0).childCount).toBe(2);
  });

  it("parses tables without a trailing pipe", () => {
    const doc = parseMarkdown("| A | B\n| --- | ---\n| 1 | 2\n");
    expect(doc.child(0).type).toBe(markdownSchema.nodes.table);
    expect(doc.child(0).child(0).child(0).textContent).toBe("A");
  });
});

describe("table cell round-trips", () => {
  it("preserves inline marks and links inside cells", () => {
    const source = [
      "| **b** | `c` | [l](https://e.com) |",
      "| --- | --- | --- |",
      "",
    ].join("\n");
    // 分隔符按列宽填充是既定规范形式（见 markdown-complex 测试）。
    const expected = [
      "| **b** | `c` | [l](https://e.com) |",
      "| :---- | :--- | :----------------- |",
      "",
    ].join("\n");

    const once = serializeMarkdown(parseMarkdown(source));
    expect(once).toBe(expected);
    expect(serializeMarkdown(parseMarkdown(once))).toBe(once);

    const cell = parseMarkdown(once).child(0).child(0).child(0);
    expect(cell.child(0).marks[0].type.name).toBe("strong");
  });

  it("stays stable for empty cells", () => {
    const source = "|  |  |\n| --- | --- |\n";
    const once = serializeMarkdown(parseMarkdown(source));
    const twice = serializeMarkdown(parseMarkdown(once));
    expect(twice).toBe(once);
    expect(parseMarkdown(once).child(0).child(0).childCount).toBe(2);
  });

  it("stays stable for a table between paragraphs", () => {
    const source = [
      "Intro",
      "",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "Outro",
      "",
    ].join("\n");
    const once = serializeMarkdown(parseMarkdown(source));
    const twice = serializeMarkdown(parseMarkdown(once));
    expect(twice).toBe(once);
    expect(once.startsWith("Intro\n\n| A")).toBe(true);
  });
});
