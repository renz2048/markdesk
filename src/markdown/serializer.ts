import { Node } from "prosemirror-model";
import { MarkdownSerializer } from "prosemirror-markdown";

function longestCharacterRun(value: string, character: "`" | "~"): number {
  let longest = 0;
  let current = 0;

  for (const item of value) {
    if (item === character) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }

  return longest;
}

function inlineCodeContent(parent: Node | undefined, index: number): string {
  if (!parent || index < 0 || index >= parent.childCount) return "";

  const hasCodeMark = (node: Node) =>
    node.marks.some((mark) => mark.type.name === "code");
  if (!hasCodeMark(parent.child(index))) return parent.child(index).textContent;

  let first = index;
  while (first > 0 && hasCodeMark(parent.child(first - 1))) first -= 1;

  let last = index;
  while (last + 1 < parent.childCount && hasCodeMark(parent.child(last + 1))) {
    last += 1;
  }

  let content = "";
  for (let position = first; position <= last; position += 1) {
    content += parent.child(position).textContent;
  }
  return content;
}

function inlineCodeDelimiter(
  parent: Node | undefined,
  index: number,
  side: "open" | "close",
): string {
  const content = inlineCodeContent(parent, index);
  const delimiter = "`".repeat(longestCharacterRun(content, "`") + 1);

  const needsSpacePadding =
    (content.startsWith(" ") && content.endsWith(" ")) ||
    content.startsWith("`") ||
    content.endsWith("`");

  if (side === "open") {
    return `${delimiter}${needsSpacePadding ? " " : ""}`;
  }
  return `${needsSpacePadding ? " " : ""}${delimiter}`;
}

function normalizeFenceInfo(info: string): string {
  return info.replace(/\r\n?|\n/g, " ");
}

function fenceFor(content: string, rawInfo: string): {
  fence: string;
  info: string;
} {
  const info = normalizeFenceInfo(rawInfo || "");
  let character: "`" | "~";

  if (info.includes("`")) {
    character = "~";
  } else if (info.includes("~")) {
    character = "`";
  } else {
    const backtickLength = Math.max(3, longestCharacterRun(content, "`") + 1);
    const tildeLength = Math.max(3, longestCharacterRun(content, "~") + 1);
    character = backtickLength <= tildeLength ? "`" : "~";
  }

  const fence = character.repeat(
    Math.max(3, longestCharacterRun(content, character) + 1),
  );
  return { fence, info };
}

function hasBalancedParentheses(value: string): boolean {
  let depth = 0;
  for (const character of value) {
    if (character === "(") depth += 1;
    if (character === ")") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

function encodeLineSeparators(value: string): string {
  return value
    .replace(/\r\n/g, "&#13;&#10;")
    .replace(/\r/g, "&#13;")
    .replace(/\n/g, "&#10;");
}

function formatDestination(destination: string): string {
  const value = destination ?? "";
  const needsAngleDestination =
    value === "" ||
    /\s/.test(value) ||
    value.includes("\\") ||
    value.includes("<") ||
    value.includes(">") ||
    !hasBalancedParentheses(value);

  if (needsAngleDestination) {
    const escaped = value.replace(/[\\<>]/g, (character) => `\\${character}`);
    return `<${encodeLineSeparators(escaped)}>`;
  }
  return value;
}

function formatTitle(title: string | null | undefined): string {
  if (title === null || title === undefined) return "";
  const escaped = title.replace(/["\\]/g, (character) => `\\${character}`);
  return ` "${encodeLineSeparators(escaped)}"`;
}

function formatImageAlt(alt: string | null | undefined): string {
  const value = alt ?? "";
  return encodeLineSeparators(
    value.replace(/[\\[\]]/g, (character) => `\\${character}`),
  );
}

export const markdownSerializer = new MarkdownSerializer(
  {
    doc(state, node) {
      state.renderContent(node);
    },
    paragraph(state, node) {
      state.renderInline(node);
      state.closeBlock(node);
    },
    heading(state, node) {
      state.write(`${"#".repeat(node.attrs.level)} `);
      state.renderInline(node);
      state.closeBlock(node);
    },
    blockquote(state, node) {
      state.wrapBlock("> ", null, node, () => state.renderContent(node));
    },
    bullet_list(state, node) {
      state.renderList(node, "  ", () => "- ");
    },
    ordered_list(state, node) {
      const start = node.attrs.start ?? 1;
      const max = String(start + node.childCount - 1).length;
      const space = " ".repeat(max + 2);
      state.renderList(node, space, (index) => `${start + index}. `);
    },
    list_item(state, node) {
      state.renderContent(node);
    },
    code_block(state, node) {
      const { fence, info } = fenceFor(
        node.textContent,
        node.attrs.language || "",
      );
      state.write(`${fence}${info}\n`);
      state.text(node.textContent, false);
      state.ensureNewLine();
      state.write(fence);
      state.closeBlock(node);
    },
    horizontal_rule(state, node) {
      state.write("---");
      state.closeBlock(node);
    },
    image(state, node) {
      const destination = formatDestination(node.attrs.src ?? "");
      const title = formatTitle(node.attrs.title);
      state.write(
        `![${formatImageAlt(node.attrs.alt)}](${destination}${title})`,
      );
    },
    hard_break(state) {
      state.write("\\\n");
    },
  },
  {
    strong: { open: "**", close: "**", mixable: true },
    em: { open: "*", close: "*", mixable: true },
    strikethrough: { open: "~~", close: "~~", mixable: true },
    code: {
      open(_state, _mark, parent, index) {
        return inlineCodeDelimiter(parent, index, "open");
      },
      close(_state, _mark, parent, index) {
        return inlineCodeDelimiter(parent, index, "close");
      },
      escape: false,
    },
    link: {
      open() {
        return "[";
      },
      close(_state, mark) {
        const destination = formatDestination(mark.attrs.href ?? "");
        const title = formatTitle(mark.attrs.title);
        return `](${destination}${title})`;
      },
    },
  },
);

export function serializeMarkdown(doc: Node): string {
  return markdownSerializer.serialize(doc, {
    hardBreakNodeName: "hard_break",
  });
}
