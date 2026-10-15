import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../../src/markdown/parser";
import { outlineFromDoc } from "../../src/main/editor/outline";

describe("outline", () => {
  it("collects headings with stable ids", () => {
    const doc = parseMarkdown("# One\n\n## Two\n\n# Three");
    expect(outlineFromDoc(doc)).toEqual([
      { id: "h-0", level: 1, text: "One", pos: expect.any(Number) },
      { id: "h-1", level: 2, text: "Two", pos: expect.any(Number) },
      { id: "h-2", level: 1, text: "Three", pos: expect.any(Number) },
    ]);
  });

  it("returns an empty outline without headings", () => {
    const doc = parseMarkdown("Just text");
    expect(outlineFromDoc(doc)).toEqual([]);
  });
});
