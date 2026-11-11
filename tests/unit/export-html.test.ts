// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../../src/markdown/parser";
import {
  buildExportHtml,
  sanitizeHtml,
} from "../../src/main/editor/exportHtml";

describe("HTML export", () => {
  it("removes scripts and javascript URLs", () => {
    const dirty = `<p onclick="steal()">x</p><script>alert(1)</script><a href="javascript:alert(2)">link</a>`;
    const clean = sanitizeHtml(dirty);
    expect(clean).not.toContain("<script");
    expect(clean).not.toContain("javascript:");
    expect(clean).not.toContain("onclick");
  });

  it("creates a complete themed document", () => {
    const html = buildExportHtml(parseMarkdown("# Title"), "light");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("MarkDesk exported document");
  });

  it("keeps only allowlisted tags and attributes", () => {
    const clean = sanitizeHtml(
      `<p><strong>keep</strong><iframe src="https://evil.example"></iframe>` +
        `<img src="x.png" onerror="steal()" alt="ok"></p>`,
    );
    expect(clean).toContain("<strong>keep</strong>");
    expect(clean).not.toContain("<iframe");
    expect(clean).not.toContain("onerror");
    expect(clean).toContain('alt="ok"');
  });

  it("sanitizes the serialized document body", () => {
    const html = buildExportHtml(
      parseMarkdown("# Head\n\n[link](https://example.com)"),
      "dark",
    );
    expect(html).toContain('<a href="https://example.com">link</a>');
    expect(html).not.toContain("<script");
    // 主题写入 data-theme，浅色与深色可区分。
    expect(html).toContain('data-theme="dark"');
  });

  it("exports internal images with their original relative source", () => {
    const html = buildExportHtml(
      parseMarkdown("![pic](assets/pic.png)"),
      "light",
    );
    // 导出的 HTML 独立于应用打开，内部图片保留相对路径而不是
    // 依赖应用协议。
    expect(html).toContain('src="assets/pic.png"');
  });

  it("gives empty table cells a line box so rows keep full height", () => {
    const html = buildExportHtml(
      parseMarkdown("| A | B |\n| --- | --- |\n| 有内容 |  |\n|  |  |\n"),
      "light",
    );
    // 空单元格序列化为 <td></td>：无行框，打印/PDF 中整行塌陷成
    // 纯 padding 高度（issue #1）。CSS 注入零宽空格恢复行高。
    expect(html).toContain("<td></td>");
    expect(html).toContain('th:empty::after,td:empty::after{content:"\\200b"}');
  });
});
