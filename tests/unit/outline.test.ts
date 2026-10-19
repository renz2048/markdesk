import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../../src/markdown/parser";
import { outlineFromDoc } from "../../src/main/editor/outline";
import { OutlinePanel } from "../../src/main/components/OutlinePanel";

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

  it("uses exact source positions after preceding blocks and invokes jump", () => {
    const source =
      "Intro\n\n```js\nconst x = 1\n```\n\n# First\n\nAfter\n\n## Second";
    const doc = parseMarkdown(source);
    expect(outlineFromDoc(doc)).toEqual([
      { id: "h-0", level: 1, text: "First", pos: 21 },
      { id: "h-1", level: 2, text: "Second", pos: 35 },
    ]);

    const jumped: number[] = [];
    const panel = OutlinePanel({ doc, onJump: (pos) => jumped.push(pos) });
    const items = panel.props.children as Array<{
      props: { onClick(): void };
    }>;
    items[1].props.onClick();
    expect(jumped).toEqual([35]);
  });

  it("marks the active outline heading accessibly and visually", () => {
    const doc = parseMarkdown("# First\n\n## Second");
    const panel = OutlinePanel({
      doc,
      onJump: () => undefined,
      // 第二个标题（## Second）在文档中的位置是 7。
      activePos: 7,
    });
    const items = panel.props.children as Array<{
      props: { "aria-current"?: string; className: string };
    }>;
    expect(items[1].props["aria-current"]).toBe("true");
    expect(items[1].props.className).toContain("active");
    expect(items[0].props["aria-current"]).toBeUndefined();
  });

  it("disables heading jumps in modes without an editor view", () => {
    const panel = OutlinePanel({
      doc: parseMarkdown("# First"),
      onJump: () => undefined,
      disabled: true,
    });
    const items = panel.props.children as Array<{
      props: { disabled?: boolean };
    }>;
    expect(items[0].props.disabled).toBe(true);
  });
});
