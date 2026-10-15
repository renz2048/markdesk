import { Schema } from "prosemirror-model";

export const markdownSchema = new Schema({
  nodes: {
    doc: { content: "block*" },
    paragraph: {
      content: "inline*",
      group: "block",
      toDOM() {
        return ["p", 0];
      },
    },
    heading: {
      content: "inline*",
      group: "block",
      attrs: { level: { default: 1 } },
      parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({
        tag: `h${level}`,
        attrs: { level },
      })),
      toDOM(node) {
        return [`h${node.attrs.level}`, 0];
      },
    },
    blockquote: {
      content: "block+",
      group: "block",
      toDOM() {
        return ["blockquote", 0];
      },
    },
    bullet_list: {
      content: "list_item+",
      group: "block",
      toDOM() {
        return ["ul", 0];
      },
    },
    ordered_list: {
      content: "list_item+",
      group: "block",
      attrs: { start: { default: 1 } },
      toDOM(node) {
        return [
          "ol",
          { start: node.attrs.start === 1 ? null : node.attrs.start },
          0,
        ];
      },
    },
    list_item: {
      content: "paragraph block*",
      toDOM() {
        return ["li", 0];
      },
    },
    code_block: {
      content: "text*",
      group: "block",
      code: true,
      attrs: { language: { default: "" } },
      toDOM(node) {
        return [
          "pre",
          { "data-language": node.attrs.language || null },
          ["code", 0],
        ];
      },
    },
    horizontal_rule: {
      group: "block",
      atom: true,
      toDOM() {
        return ["hr"];
      },
    },
    text: { group: "inline" },
    image: {
      inline: true,
      atom: true,
      attrs: {
        src: {},
        alt: { default: "" },
        title: { default: null },
      },
      toDOM(node) {
        return [
          "img",
          {
            src: node.attrs.src,
            alt: node.attrs.alt || null,
            title: node.attrs.title || null,
          },
        ];
      },
    },
    hard_break: {
      inline: true,
      group: "inline",
      selectable: false,
      toDOM() {
        return ["br"];
      },
    },
  },
  marks: {
    strong: {
      toDOM() {
        return ["strong", 0];
      },
    },
    em: {
      toDOM() {
        return ["em", 0];
      },
    },
    strikethrough: {
      toDOM() {
        return ["del", 0];
      },
    },
    code: {
      code: true,
      toDOM() {
        return ["code", 0];
      },
    },
    link: {
      attrs: { href: {}, title: { default: null } },
      inclusive: false,
      toDOM(mark) {
        return [
          "a",
          { href: mark.attrs.href, title: mark.attrs.title || null },
          0,
        ];
      },
    },
  },
});
