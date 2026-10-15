import { describe, expect, it } from "vitest";
import { markdownSchema } from "../../src/markdown/schema";
import { parseMarkdown } from "../../src/markdown/parser";
import { serializeMarkdown } from "../../src/markdown/serializer";
import { roundTripMarkdown } from "../../src/markdown/roundTrip";

const canonicalCases = [
  ["# Title", "# Title\n"],
  ["Plain paragraph", "Plain paragraph\n"],
  [
    "**bold** and *italic* and ~~strike~~ and `code`",
    "**bold** and *italic* and ~~strike~~ and `code`\n",
  ],
  ["- alpha\n- beta", "- alpha\n- beta\n"],
  ["1. first\n2. second", "1. first\n2. second\n"],
  ["> quoted", "> quoted\n"],
  ["```ts\nconst x = 1;\n```", "```ts\nconst x = 1;\n```\n"],
  ["---", "---\n"],
] as const;

function firstParagraph(document: ReturnType<typeof parseMarkdown>) {
  return document.child(0);
}

function linkMark(node: ReturnType<typeof parseMarkdown>) {
  const paragraph = firstParagraph(node);
  const mark = paragraph.child(0).marks.find(
    (candidate) => candidate.type === markdownSchema.marks.link,
  );
  if (!mark) throw new Error("expected a link mark");
  return mark;
}

describe("basic Markdown round trip", () => {
  it.each(canonicalCases)("canonicalizes %j", (source, expected) => {
    expect(roundTripMarkdown(source)).toBe(expected);
    const once = roundTripMarkdown(source);
    expect(roundTripMarkdown(once)).toBe(once);
  });

  it("creates schema nodes", () => {
    const doc = parseMarkdown("# Title\n\nParagraph");
    expect(doc.child(0).type).toBe(markdownSchema.nodes.heading);
    expect(doc.child(0).attrs.level).toBe(1);
    expect(doc.child(1).type).toBe(markdownSchema.nodes.paragraph);
  });

  it.each([1, 2, 3, 4, 5, 6])("preserves heading level %i", (level) => {
    const source = `${"#".repeat(level)} Heading ${level}`;
    const heading = parseMarkdown(source).child(0);
    expect(heading.type).toBe(markdownSchema.nodes.heading);
    expect(heading.attrs.level).toBe(level);
    expect(roundTripMarkdown(source)).toBe(`${source}\n`);
  });

  it("preserves inline node and mark structure", () => {
    const paragraph = parseMarkdown(
      "**bold** and *italic* and ~~strike~~ and `code`",
    ).child(0);
    expect(paragraph.child(0).marks).toHaveLength(1);
    expect(paragraph.child(0).marks[0].type).toBe(markdownSchema.marks.strong);
    expect(paragraph.child(2).marks[0].type).toBe(markdownSchema.marks.em);
    expect(paragraph.child(4).marks[0].type).toBe(
      markdownSchema.marks.strikethrough,
    );
    expect(paragraph.child(6).marks[0].type).toBe(markdownSchema.marks.code);
    expect(paragraph.child(0).textContent).toBe("bold");
    expect(paragraph.child(2).textContent).toBe("italic");
    expect(paragraph.child(4).textContent).toBe("strike");
    expect(paragraph.child(6).textContent).toBe("code");
  });

  it("preserves fenced-code node attributes", () => {
    const codeBlock = parseMarkdown("```ts title=\"demo\"\nconst x = 1;\n```").child(0);
    expect(codeBlock.type).toBe(markdownSchema.nodes.code_block);
    expect(codeBlock.attrs.language).toBe("ts title=\"demo\"");
    expect(codeBlock.textContent).toBe("const x = 1;\n");
  });
});

describe("Markdown metadata serialization", () => {
  it.each([
    ["https://example.com", "https://example.com"],
    ["https://example.com/balanced(one)", "https://example.com/balanced(one)"],
    ["https://example.com/a b", "<https://example.com/a b>"],
    ["https://example.com/un(", "<https://example.com/un(>"],
    ["https://example.com/)", "<https://example.com/)>"],
    ["https://example.com/<angle>", "<https://example.com/\\<angle\\>>"],
    ["", "<>"],
  ])("serializes and restores destination %j", (href, expectedDestination) => {
    const text = markdownSchema.text("label", [
      markdownSchema.marks.link.create({ href, title: null }),
    ]);
    const paragraph = markdownSchema.nodes.paragraph.createAndFill({}, text);
    if (!paragraph) throw new Error("expected a valid paragraph");

    const markdown = serializeMarkdown(
      markdownSchema.nodes.doc.createAndFill({}, paragraph) ?? paragraph,
    );
    expect(markdown).toContain(`](${expectedDestination}`);

    const restoredMark = linkMark(parseMarkdown(markdown));
    expect(decodeURIComponent(restoredMark.attrs.href)).toBe(href);
  });

  it("escapes quoted link titles", () => {
    const href = "https://example.com/a b";
    const title = 'quoted "title" and \\ slash';
    const text = markdownSchema.text("label", [
      markdownSchema.marks.link.create({ href, title }),
    ]);
    const paragraph = markdownSchema.nodes.paragraph.createAndFill({}, text);
    if (!paragraph) throw new Error("expected a valid paragraph");

    const markdown = serializeMarkdown(
      markdownSchema.nodes.doc.createAndFill({}, paragraph) ?? paragraph,
    );
    expect(markdown).toContain(
      `](<${href}> "quoted \\"title\\" and \\\\ slash")`,
    );
    expect(linkMark(parseMarkdown(markdown)).attrs.title).toBe(title);
  });

  it("escapes link labels containing brackets", () => {
    const label = "label [inner] bracket";
    const text = markdownSchema.text(label, [
      markdownSchema.marks.link.create({
        href: "https://example.com/brackets",
        title: null,
      }),
    ]);
    const paragraph = markdownSchema.nodes.paragraph.createAndFill({}, text);
    if (!paragraph) throw new Error("expected a valid paragraph");

    const markdown = serializeMarkdown(
      markdownSchema.nodes.doc.createAndFill({}, paragraph) ?? paragraph,
    );
    expect(markdown).toContain(
      "[label \\[inner\\] bracket](https://example.com/brackets)",
    );
    expect(parseMarkdown(markdown).child(0).child(0).textContent).toBe(label);
  });

  it.each([
    ["simple", "simple"],
    ["", ""],
    ["[escaped]", "[escaped]"],
    ["back\\slash", "back\\slash"],
  ])("escapes image alt %j on output", (alt, _expected) => {
    const image = markdownSchema.nodes.image.create({
      src: "https://example.com/image.png",
      alt,
      title: null,
    });
    const paragraph = markdownSchema.nodes.paragraph.createAndFill({}, image);
    if (!paragraph) throw new Error("expected a valid paragraph");

    const markdown = serializeMarkdown(
      markdownSchema.nodes.doc.createAndFill({}, paragraph) ?? paragraph,
    );
    const restoredImage = parseMarkdown(markdown).child(0).child(0);
    expect(restoredImage.type).toBe(markdownSchema.nodes.image);
    expect(restoredImage.attrs.alt).toBe(alt);
    expect(restoredImage.attrs.src).toBe("https://example.com/image.png");
  });

  it("escapes image destination and title metadata", () => {
    const src = "https://example.com/images/my image (1).png";
    const title = "screenshot \"quoted\" and \\ slash";
    const image = markdownSchema.nodes.image.create({ src, alt: "alt", title });
    const paragraph = markdownSchema.nodes.paragraph.createAndFill({}, image);
    if (!paragraph) throw new Error("expected a valid paragraph");

    const markdown = serializeMarkdown(
      markdownSchema.nodes.doc.createAndFill({}, paragraph) ?? paragraph,
    );
    expect(markdown).toContain(
      `](<${src}> "screenshot \\"quoted\\" and \\\\ slash")`,
    );

    const restoredImage = parseMarkdown(markdown).child(0).child(0);
    expect(decodeURIComponent(restoredImage.attrs.src)).toBe(src);
    expect(restoredImage.attrs.title).toBe(title);
  });

  it.each([
    ["![alt](https://example.com/a.png)", "alt"],
    ["![](https://example.com/a.png)", ""],
    ["![\\[escaped\\]](https://example.com/a.png)", "[escaped]"],
    ["![plain *em* `code` \\[bracket\\]](https://example.com/a.png)", "plain em code [bracket]"],
  ])("flattens multipart image alt from %j", (source, alt) => {
    const image = parseMarkdown(source).child(0).child(0);
    expect(image.type).toBe(markdownSchema.nodes.image);
    expect(image.attrs.alt).toBe(alt);
  });

  it("preserves an intentional empty alt in DOM output", () => {
    const image = markdownSchema.nodes.image.create({
      src: "https://example.com/a.png",
      alt: "",
      title: null,
    });
    expect(image.type.spec.toDOM?.(image)).toEqual([
      "img",
      {
        src: "https://example.com/a.png",
        alt: "",
        title: null,
      },
    ]);
  });
});

describe("delimiter-safe Markdown serialization", () => {
  it("uses a longer inline-code delimiter when content contains backticks", () => {
    const source = "``code with `tick` inside``";
    const paragraph = parseMarkdown(source).child(0);
    const code = paragraph.child(0);
    expect(code.marks[0].type).toBe(markdownSchema.marks.code);
    expect(code.textContent).toBe("code with `tick` inside");

    const once = roundTripMarkdown(source);
    expect(once).toBe("``code with `tick` inside``\n");
    expect(parseMarkdown(once).child(0).child(0).textContent).toBe(
      "code with `tick` inside",
    );
  });

  it("pads code spans whose content starts and ends with spaces", () => {
    const text = markdownSchema.text(" padded ", [
      markdownSchema.marks.code.create(),
    ]);
    const paragraph = markdownSchema.nodes.paragraph.createAndFill({}, text);
    if (!paragraph) throw new Error("expected a valid paragraph");

    const markdown = serializeMarkdown(
      markdownSchema.nodes.doc.createAndFill({}, paragraph) ?? paragraph,
    );
    expect(markdown).toBe("`  padded  `\n");
    expect(parseMarkdown(markdown).child(0).child(0).textContent).toBe(
      " padded ",
    );
  });

  it("sizes an inline-code delimiter above every backtick run", () => {
    const source = "```code with ``double`` and `single` inside```";
    const expectedText = "code with ``double`` and `single` inside";
    const paragraph = parseMarkdown(source).child(0);
    expect(paragraph.child(0).textContent).toBe(expectedText);

    const once = roundTripMarkdown(source);
    expect(once).toBe("```code with ``double`` and `single` inside```\n");
    expect(parseMarkdown(once).child(0).child(0).textContent).toBe(expectedText);
  });

  it("chooses a longer fence around nested backtick fences", () => {
    const source = "````md\n```ts\nconst x = 1;\n```\n````";
    const codeBlock = parseMarkdown(source).child(0);
    expect(codeBlock.type).toBe(markdownSchema.nodes.code_block);
    expect(codeBlock.attrs.language).toBe("md");

    const once = roundTripMarkdown(source);
    expect(once).toBe("````md\n```ts\nconst x = 1;\n```\n````\n");
    expect(parseMarkdown(once).child(0).textContent).toBe(
      "```ts\nconst x = 1;\n```\n",
    );
  });

  it("uses a tilde fence when backticks occur in code or info text", () => {
    const backtickContent = "```ts\nconst x = 1;\n```";
    const once = roundTripMarkdown(`\`\`\`md\n${backtickContent}\n\`\`\``);

    expect(once).toBe(`~~~md\n${backtickContent}\n~~~\n`);
    expect(parseMarkdown(once).child(0).textContent).toBe(
      `${backtickContent}\n`,
    );

    const info = "js `tag`";
    const code = markdownSchema.nodes.code_block.createAndFill(
      { language: info },
      [markdownSchema.text("value")],
    );
    if (!code) throw new Error("expected a valid code block");
    const infoMarkdown = serializeMarkdown(
      markdownSchema.nodes.doc.createAndFill({}, code) ?? code,
    );
    expect(infoMarkdown).toContain(`~~~${info}\nvalue\n~~~`);
    expect(parseMarkdown(infoMarkdown).child(0).attrs.language).toBe(info);
  });

  it("flattens unsafe newlines in fenced-code info strings", () => {
    const code = markdownSchema.nodes.code_block.createAndFill(
      { language: "line one\nline two" },
      [markdownSchema.text("value")],
    );
    if (!code) throw new Error("expected a valid code block");

    const markdown = serializeMarkdown(
      markdownSchema.nodes.doc.createAndFill({}, code) ?? code,
    );
    expect(markdown).toBe("```line one line two\nvalue\n```\n");
    expect(parseMarkdown(markdown).child(0).attrs.language).toBe(
      "line one line two",
    );
  });

  it("uses a backtick fence when code contains tilde runs", () => {
    const source = "~~~text\ncontains ~~~ tildes\n~~~";
    const once = roundTripMarkdown(source);
    expect(once).toBe("```text\ncontains ~~~ tildes\n```\n");
    expect(parseMarkdown(once).child(0).textContent).toBe(
      "contains ~~~ tildes\n",
    );
  });
});

describe("round-trip preservation", () => {
  it("preserves a link and its title", () => {
    const source = '[label](https://example.com/a(b) "link title")';
    const paragraph = parseMarkdown(source).child(0);
    const mark = linkMark(parseMarkdown(source));
    expect(paragraph.child(0).textContent).toBe("label");
    expect(mark.attrs.href).toBe("https://example.com/a(b)");
    expect(mark.attrs.title).toBe("link title");
    expect(roundTripMarkdown(source)).toBe(
      '[label](https://example.com/a(b) "link title")\n',
    );
  });

  it("preserves autolinks", () => {
    const source = "<https://example.com/>";
    const mark = linkMark(parseMarkdown(source));
    expect(mark.attrs.href).toBe("https://example.com/");
    expect(firstParagraph(parseMarkdown(source)).child(0).textContent).toBe(
      "https://example.com/",
    );
    expect(roundTripMarkdown(source)).toBe(
      "[https://example.com/](https://example.com/)\n",
    );
  });

  it("preserves image alt and title", () => {
    const source =
      '![multipart *alt*](https://example.com/a%20b.png "image title")';
    const image = parseMarkdown(source).child(0).child(0);
    expect(image.type).toBe(markdownSchema.nodes.image);
    expect(image.attrs.alt).toBe("multipart alt");
    expect(image.attrs.src).toBe("https://example.com/a%20b.png");
    expect(image.attrs.title).toBe("image title");
    expect(roundTripMarkdown(source)).toBe(
      '![multipart alt](https://example.com/a%20b.png "image title")\n',
    );
  });

  it("preserves hard breaks as explicit hard-break nodes", () => {
    const source = "before\\\nafter";
    const paragraph = parseMarkdown(source).child(0);
    expect(paragraph.child(0).textContent).toBe("before");
    expect(paragraph.child(1).type).toBe(markdownSchema.nodes.hard_break);
    expect(paragraph.child(2).textContent).toBe("after");
    expect(roundTripMarkdown(source)).toBe("before\\\nafter\n");
  });

  it.each([
    ["3. third\n4. fourth", 3],
    ["0. zero\n1. one", 0],
  ])("preserves ordered-list start in %j", (source, start) => {
    const orderedList = parseMarkdown(source).child(0);
    expect(orderedList.type).toBe(markdownSchema.nodes.ordered_list);
    expect(orderedList.attrs.start).toBe(start);
    expect(roundTripMarkdown(source)).toBe(`${source}\n`);
  });

  it("preserves escaped literal characters", () => {
    const source = "\\\\ *emphasis* \\[not a link\\] \\`not code\\`";
    const paragraph = parseMarkdown(source).child(0);
    expect(paragraph.textContent).toBe("\\ *emphasis* [not a link] `not code`");
    const once = roundTripMarkdown(source);
    expect(parseMarkdown(once).child(0).textContent).toBe(
      "\\ *emphasis* [not a link] `not code`",
    );
    expect(roundTripMarkdown(once)).toBe(once);
  });
});
