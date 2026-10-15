import { Node } from "prosemirror-model";
import { MarkdownSerializer } from "prosemirror-markdown";
import { markdownSchema } from "./schema";

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

type TableAlignment = "left" | "center" | "right";

function tableAlignment(value: unknown): TableAlignment {
  return value === "center" || value === "right" ? value : "left";
}

function tableCellMarkdown(cell: Node): string {
  const paragraph = markdownSchema.nodes.paragraph.createAndFill(
    {},
    cell.content,
  );
  if (!paragraph) return "";

  return markdownSerializer
    .serialize(paragraph, { hardBreakNodeName: "hard_break" })
    .replace(/\n$/, "");
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function alignmentMarker(alignment: TableAlignment): string {
  if (alignment === "center") return ":---:";
  if (alignment === "right") return "---:";
  return ":---";
}

function padTableCell(
  value: string,
  width: number,
  alignment: TableAlignment,
): string {
  const padding = " ".repeat(Math.max(0, width - value.length));
  if (alignment === "right") return `${padding}${value}`;
  if (alignment === "center") {
    const left = " ".repeat(Math.floor(padding.length / 2));
    const right = " ".repeat(padding.length - left.length);
    return `${left}${value}${right}`;
  }
  return `${value}${padding}`;
}

function paddedAlignmentMarker(
  alignment: TableAlignment,
  width: number,
): string {
  const hyphens = "-".repeat(Math.max(1, width - 2));
  if (alignment === "left") return `:${"-".repeat(Math.max(2, width - 1))}`;
  if (alignment === "center") return `:${hyphens}:`;
  return `${"-".repeat(Math.max(2, width - 1))}:`;
}

function tableMarkdown(table: Node): string {
  const rows: { content: string; alignment: TableAlignment }[][] = [];
  const alignments: TableAlignment[] = [];
  const widths: number[] = [];

  table.forEach((row) => {
    const cells: { content: string; alignment: TableAlignment }[] = [];
    row.forEach((cell, _offset, columnIndex) => {
      const alignment = tableAlignment(cell.attrs.alignment);
      const content = escapeTableCell(tableCellMarkdown(cell));
      cells.push({ content, alignment });

      if (row === table.child(0)) alignments[columnIndex] = alignment;
      if (!alignments[columnIndex]) alignments[columnIndex] = alignment;
    });
    rows.push(cells);
  });

  const columnCount = Math.max(1, ...rows.map((cells) => cells.length));
  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    widths[columnIndex] = Math.max(
      alignmentMarker(tableAlignment(alignments[columnIndex] ?? "left")).length,
      ...rows.map((cells) => cells[columnIndex]?.content.length ?? 0),
    );
  }

  const renderedRows = rows.map((cells) => {
    const renderedCells = Array.from({ length: columnCount }, (_, columnIndex) =>
      padTableCell(
        cells[columnIndex]?.content ?? "",
        widths[columnIndex] ?? 0,
        tableAlignment(alignments[columnIndex] ?? "left"),
      ),
    );
    return `| ${renderedCells.join(" | ")} |`;
  });

  const separatorCells = widths.map((width, columnIndex) =>
    paddedAlignmentMarker(
      tableAlignment(alignments[columnIndex] ?? "left"),
      width,
    ),
  );
  renderedRows.splice(1, 0, `| ${separatorCells.join(" | ")} |`);

  return renderedRows.join("\n");
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
      if (node.attrs.task === "done") {
        state.write("[x] ");
      } else if (node.attrs.task === "todo") {
        state.write("[ ] ");
      }
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
    table(state, node) {
      state.write(tableMarkdown(node));
      state.closeBlock(node);
    },
    raw_block(state, node) {
      state.write(String(node.attrs.source ?? ""));
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
