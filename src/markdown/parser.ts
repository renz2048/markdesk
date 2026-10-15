import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import { MarkdownParser } from "prosemirror-markdown";
import { markdownSchema } from "./schema";
import { safeImageSrc, safeLinkHref } from "./urlPolicy";

interface MarkdownTextToken {
  content: string;
  children?: readonly MarkdownTextToken[] | null;
}

interface MutableMarkdownToken {
  type: string;
  content: string;
  children?: MutableMarkdownToken[] | null;
  attrSet(name: string, value: string): void;
}

interface MarkdownCoreState {
  tokens: MutableMarkdownToken[];
}

function flattenImageAlt(
  tokens: readonly MarkdownTextToken[] | null | undefined,
): string {
  if (!tokens) return "";
  return tokens.reduce(
    (alt, token) =>
      alt +
      (token.children?.length
        ? flattenImageAlt(token.children)
        : token.content),
    "",
  );
}

const taskListMarker = /^\[([ xX])\]\s+/;

function alignmentFromStyle(
  style: string | null,
): "left" | "center" | "right" {
  if (style?.includes("text-align:center")) return "center";
  if (style?.includes("text-align:right")) return "right";
  return "left";
}

function recognizeTaskLists(state: MarkdownCoreState) {
  state.tokens.forEach((token, index) => {
    if (token.type !== "list_item_open") return;

    // A list item's first inline token is normally two positions after
    // list_item_open: list_item_open, paragraph_open, inline.
    const inline = state.tokens[index + 2];
    if (!inline || inline.type !== "inline" || !inline.children?.length) return;

    const firstChild = inline.children[0];
    const marker =
      firstChild.type === "text"
        ? firstChild.content.match(taskListMarker)
        : null;
    if (!marker) return;

    token.attrSet("task", marker[1].trim() ? "done" : "todo");
    firstChild.content = firstChild.content.slice(marker[0].length);
    if (firstChild.content === "") {
      inline.children.splice(0, 1);
    }
  });
}

function unwrapTableSections(state: MarkdownCoreState) {
  state.tokens = state.tokens.filter((token) => {
    return !token.type.startsWith("thead_") && !token.type.startsWith("tbody_");
  });
}

function rawBlockSourceFromToken(content: string): string {
  return content.endsWith("\n") ? content.slice(0, -1) : content;
}

const markdownIt = MarkdownIt("zero", { html: true }).enable([
  "table",
  "strikethrough",
  "blockquote",
  "paragraph",
  "heading",
  "lheading",
  "code",
  "fence",
  "html_block",
  "hr",
  "list",
  "newline",
  "escape",
  "backticks",
  "emphasis",
  "link",
  "image",
  "autolink",
  "entity",
  "text",
  "balance_pairs",
  "text_join",
  ]);

markdownIt.core.ruler.after("block", "markdesk_tables", unwrapTableSections);

const taskMarkdownIt = markdownIt.use(taskLists, {
  enabled: false,
  label: true,
}).disable("html_inline");
// markdown-it's built-in scheme filter runs before MarkdownParser attrs.
// Keep destinations tokenized here and apply MarkDesk's context-sensitive
// link/image allowlists at the model boundary below.
taskMarkdownIt.validateLink = () => true;
// Insert before the task-list renderer plugin's own inline transformation so
// MarkDesk can move the source marker into list_item.attrs without depending
// on plugin-specific checkbox token shapes.
taskMarkdownIt.core.ruler.after(
  "inline",
  "markdesk_task_lists",
  recognizeTaskLists,
);

export const markdownParser = new MarkdownParser(markdownSchema, taskMarkdownIt, {
  blockquote: { block: "blockquote" },
  paragraph: { block: "paragraph" },
  heading: {
    block: "heading",
    getAttrs(token) {
      return { level: Number(token.tag.slice(1)) };
    },
  },
  bullet_list: { block: "bullet_list" },
  ordered_list: {
    block: "ordered_list",
    getAttrs(token) {
      return { start: Number(token.attrGet("start") ?? 1) };
    },
  },
  list_item: {
    block: "list_item",
    getAttrs(token) {
      const task = token.attrGet("task");
      return {
        task: task === "todo" || task === "done" ? task : null,
      };
    },
  },
  fence: {
    block: "code_block",
    noCloseToken: true,
    getAttrs(token) {
      return { language: token.info.trim() };
    },
  },
  code_block: { block: "code_block", noCloseToken: true },
  hr: { node: "horizontal_rule" },
  table: { block: "table" },
  tr: { block: "table_row" },
  th: {
    block: "table_cell",
    getAttrs(token) {
      return {
        alignment: alignmentFromStyle(token.attrGet("style")),
        header: true,
      };
    },
  },
  td: {
    block: "table_cell",
    getAttrs(token) {
      return {
        alignment: alignmentFromStyle(token.attrGet("style")),
        header: false,
      };
    },
  },
  html_block: {
    node: "raw_block",
    getAttrs(token) {
      return { source: rawBlockSourceFromToken(token.content) };
    },
  },
  image: {
    node: "image",
    getAttrs(token) {
      return {
        src: safeImageSrc(token.attrGet("src") ?? ""),
        alt: flattenImageAlt(token.children),
        title: token.attrGet("title"),
      };
    },
  },
  hardbreak: { node: "hard_break" },
  strong: { mark: "strong" },
  em: { mark: "em" },
  s: { mark: "strikethrough" },
  code_inline: { mark: "code" },
  link_open: {
    mark: "link",
    getAttrs(token) {
      return {
        href: safeLinkHref(token.attrGet("href") ?? ""),
        title: token.attrGet("title"),
      };
    },
  },
});

export function parseMarkdown(source: string) {
  return markdownParser.parse(source, {});
}
