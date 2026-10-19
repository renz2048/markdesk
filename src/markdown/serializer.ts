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
  // 反引号围栏的 info 串中不允许出现反引号，此时改用波浪线围栏；
  // 其余情况一律使用反引号围栏，长度压过内容中最长的反引号连续段。
  const character: "`" | "~" = info.includes("`") ? "~" : "`";

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

function containsHardBreak(cell: Node): boolean {
  for (let index = 0; index < cell.childCount; index += 1) {
    if (cell.child(index).type === markdownSchema.nodes.hard_break) {
      return true;
    }
  }
  return false;
}

function tableCellMarkdown(cell: Node): string {
  // Markdown table cells cannot contain physical newlines. Fail closed rather
  // than emit a row that silently changes document structure when reparsed.
  if (containsHardBreak(cell)) {
    throw new RangeError("Table cells cannot contain hard breaks");
  }

  const paragraph = markdownSchema.nodes.paragraph.createAndFill(
    {},
    cell.content,
  );
  if (!paragraph) return "";

  return markdownSerializer
    .serialize(paragraph)
    .replace(/\n$/, "");
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

const zeroWidthCharacter = /^[\u200B\u200C\u200D\u2060\uFE00\uFE0F]$/u;
const combiningCharacter = /^\p{M}$/u;
const regionalIndicator = /^[\u{1F1E6}-\u{1F1FF}]$/u;
const extendedPictographic = /^\p{Extended_Pictographic}$/u;

function isWideCodePoint(codePoint: number): boolean {
  return (
    extendedPictographic.test(String.fromCodePoint(codePoint)) ||
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2329 && codePoint <= 0x232a) ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f680 && codePoint <= 0x1f6ff) ||
    (codePoint >= 0x1f7e0 && codePoint <= 0x1f7eb) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x1fa70 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x2fffd) ||
    (codePoint >= 0x30000 && codePoint <= 0x3fffd)
  );
}

function characterDisplayWidth(character: string): number {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return 0;
  if (zeroWidthCharacter.test(character) || combiningCharacter.test(character)) {
    return 0;
  }
  return isWideCodePoint(codePoint) ? 2 : 1;
}

function displayWidth(value: string): number {
  const characters = Array.from(value);
  let width = 0;
  let index = 0;

  while (index < characters.length) {
    if (regionalIndicator.test(characters[index])) {
      const isFlagPair =
        index + 1 < characters.length &&
        regionalIndicator.test(characters[index + 1]);
      width += isFlagPair ? 2 : 1;
      index += isFlagPair ? 2 : 1;
      continue;
    }

    let clusterWidth = characterDisplayWidth(characters[index]);
    index += 1;

    // Absorb combining marks and emoji modifiers into their base cluster.
    while (
      index < characters.length &&
      (combiningCharacter.test(characters[index]) ||
        (zeroWidthCharacter.test(characters[index]) &&
          characters[index] !== "\u200D") ||
        (characters[index].codePointAt(0) ?? 0) >= 0x1f3fb &&
          (characters[index].codePointAt(0) ?? 0) <= 0x1f3ff)
    ) {
      if (characters[index] === "\u20E3") clusterWidth = 2;
      index += 1;
    }

    // A ZWJ emoji sequence renders as one grapheme, not the sum of its parts.
    if (characters[index] === "\u200D" && index + 1 < characters.length) {
      index += 2;
      clusterWidth = Math.max(clusterWidth, 2);
      while (
        index < characters.length &&
        (combiningCharacter.test(characters[index]) ||
          zeroWidthCharacter.test(characters[index]))
      ) {
        index += 1;
      }
    }

    width += clusterWidth;
  }

  return width;
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
  const padding = " ".repeat(Math.max(0, width - displayWidth(value)));
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
  const base = alignmentMarker(alignment);
  if (width <= base.length) return base;
  if (alignment === "center") return `:${"-".repeat(width - 2)}:`;
  if (alignment === "right") return `${"-".repeat(width - 1)}:`;
  return `:${"-".repeat(width - 1)}`;
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
    // 列宽只由转义后的单元格内容决定；分隔符在窄列时保持最小形态。
    widths[columnIndex] = Math.max(
      1,
      ...rows.map(
        (cells) => displayWidth(cells[columnIndex]?.content ?? ""),
      ),
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
    text(state, node) {
      state.text(node.text ?? "");
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
      // 关闭侧的 index 指向代码文本之后的节点，与库默认实现一致回退一位。
      close(_state, _mark, parent, index) {
        return inlineCodeDelimiter(parent, index - 1, "close");
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
  // 紧凑列表是 MarkDesk 的规范序列化形式；模型中没有 loose/tight 之分。
  // 运行时 renderList 会读取 options.tightLists（prosemirror-markdown
  // 1.13.0 的构造器类型未声明该字段），因此这里做一次显式断言。
  { tightLists: true } as unknown as ConstructorParameters<
    typeof MarkdownSerializer
  >[2],
);

export function serializeMarkdown(doc: Node): string {
  const output = markdownSerializer.serialize(doc);
  if (output.length === 0) return output;
  // 保存的 Markdown 文件以单个换行符结尾，与测试规定的规范形式一致。
  return output.endsWith("\n") ? output : `${output}\n`;
}
