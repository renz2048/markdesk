import { describe, expect, it } from "vitest";
import { markdownSchema } from "../../src/markdown/schema";
import { parseMarkdown } from "../../src/markdown/parser";
import { serializeMarkdown } from "../../src/markdown/serializer";

describe("basic Markdown round trip", () => {
  it.each([
    "# Title",
    "Plain paragraph",
    "**bold** and *italic* and ~~strike~~ and `code`",
    "- alpha\n- beta",
    "1. first\n2. second",
    "> quoted",
    "```ts\nconst x = 1;\n```",
    "---",
  ])("round-trips %j", (source) => {
    const once = serializeMarkdown(parseMarkdown(source));
    const twice = serializeMarkdown(parseMarkdown(once));
    expect(once).toBe(twice);
  });

  it("creates schema nodes", () => {
    const doc = parseMarkdown("# Title\n\nParagraph");
    expect(doc.child(0).type).toBe(markdownSchema.nodes.heading);
    expect(doc.child(0).attrs.level).toBe(1);
    expect(doc.child(1).type).toBe(markdownSchema.nodes.paragraph);
  });
});
