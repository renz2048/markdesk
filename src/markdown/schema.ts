import { Schema } from "prosemirror-model";

/**
 * 相对图片路径在编辑/阅读视图中通过受限的 markdesk-resource: 协议
 * 加载（主进程确保不逃逸当前文档目录）；绝对 URL 与 data: URI 原样
 * 输出。导出 HTML 时由 exportHtml 反向剥离协议前缀。
 */
// 本地绝对路径（Windows 盘符 / UNC / POSIX）：显示时编码进资源协议的
// absolute/ 分支（需求 4.5，授权解析见主进程 resolveResourcePath）。
const absolutePathPattern = /^(?:[a-zA-Z]:[\\/]|\\\\|\/[^\\/])/u;

/** 图片 src 是否为本地绝对路径（Windows 盘符 / UNC / POSIX）。 */
export function isLocalAbsolutePath(src: string): boolean {
  return absolutePathPattern.test(src);
}

export function editorImageSrc(src: string): string {
  if (isLocalAbsolutePath(src)) {
    return `markdesk-resource:absolute/${encodeURIComponent(src)}`;
  }
  if (
    src.length === 0 ||
    src.startsWith("/") ||
    src.startsWith("markdesk-resource:") ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(src)
  ) {
    return src;
  }
  return `markdesk-resource:${src}`;
}

/** editorImageSrc 的逆变换：导出 HTML 时还原作者书写的路径。 */
export function sourceImageSrc(src: string): string {
  if (src.startsWith("markdesk-resource:absolute/")) {
    try {
      return decodeURIComponent(src.slice("markdesk-resource:absolute/".length));
    } catch {
      return src;
    }
  }
  if (src.startsWith("markdesk-resource:")) {
    return src.slice("markdesk-resource:".length);
  }
  return src;
}

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
      attrs: { task: { default: null } },
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
    table: {
      content: "table_row+",
      group: "block",
      tableRole: "table",
      toDOM() {
        return ["table", 0];
      },
    },
    table_row: {
      content: "table_cell+",
      group: "block",
      tableRole: "row",
      toDOM() {
        return ["tr", 0];
      },
    },
    table_cell: {
      content: "inline*",
      group: "block",
      attrs: {
        alignment: { default: "left" },
        header: { default: false },
      },
      tableRole: "cell",
      toDOM(node) {
        return [
          node.attrs.header ? "th" : "td",
          {
            style:
              node.attrs.alignment === "left"
                ? null
                : `text-align:${node.attrs.alignment}`,
          },
          0,
        ];
      },
    },
    raw_block: {
      group: "block",
      atom: true,
      code: true,
      attrs: { source: { default: "" } },
      toDOM(node) {
        const source = String(node.attrs.source ?? "");
        // HTML 注释展示内部文本（它是作者笔记）；其余受保护原文逐字展示。
        // attrs.source 始终保留完整原文，序列化往返不受此展示层影响。
        const comment = /^<!--\s*([\s\S]*?)\s*-->$/u.exec(source);
        return [
          "pre",
          { "data-markdesk-raw": "true" },
          comment ? comment[1] : source,
        ];
      },
    },
    text: { group: "inline" },
    image: {
      inline: true,
      group: "inline",
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
            src: editorImageSrc(String(node.attrs.src ?? "")),
            alt: node.attrs.alt ?? "",
            title: node.attrs.title ?? null,
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
          { href: mark.attrs.href, title: mark.attrs.title ?? null },
          0,
        ];
      },
    },
  },
});
