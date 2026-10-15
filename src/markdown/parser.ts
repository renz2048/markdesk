import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import { MarkdownParser } from "prosemirror-markdown";
import { markdownSchema } from "./schema";

interface MarkdownTextToken {
  content: string;
  children?: readonly MarkdownTextToken[] | null;
}

function flattenImageAlt(tokens: readonly MarkdownTextToken[] | null | undefined): string {
  if (!tokens) return "";
  return tokens.reduce(
    (alt, token) => alt + (token.children?.length ? flattenImageAlt(token.children) : token.content),
    "",
  );
}

const markdownIt = MarkdownIt("zero", { html: false })
  .enable([
    "table",
    "strikethrough",
    "blockquote",
    "paragraph",
    "heading",
    "lheading",
    "code",
    "fence",
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
    "text_collapse",
  ])
  .use(taskLists, {
    enabled: false,
    label: true,
  });

export const markdownParser = new MarkdownParser(markdownSchema, markdownIt, {
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
  list_item: { block: "list_item" },
  fence: {
    block: "code_block",
    getAttrs(token) {
      return { language: token.info.trim() };
    },
  },
  code_block: { block: "code_block" },
  hr: { node: "horizontal_rule" },
  image: {
    node: "image",
    getAttrs(token) {
      return {
        src: token.attrGet("src") ?? "",
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
        href: token.attrGet("href") ?? "",
        title: token.attrGet("title"),
      };
    },
  },
});

export function parseMarkdown(source: string) {
  return markdownParser.parse(source, {});
}
