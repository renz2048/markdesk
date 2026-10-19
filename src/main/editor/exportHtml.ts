import DOMPurify from "dompurify";
import { DOMSerializer, Node } from "prosemirror-model";
import { markdownSchema } from "../../markdown/schema";

const allowedTags = [
  "article", "aside", "blockquote", "br", "code", "del", "em", "h1", "h2",
  "h3", "h4", "h5", "h6", "hr", "img", "li", "ol", "p", "pre", "strong",
  "table", "tbody", "td", "th", "thead", "tr", "ul", "a",
];

const allowedAttributes = ["href", "title", "src", "alt", "class"];

/**
 * 清理导出的 HTML：只保留文档结构所需的标签与属性。任何脚本、
 * 事件处理器或不安全的 URL 方案都会被移除。
 */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: allowedTags,
    ALLOWED_ATTR: allowedAttributes,
    ALLOW_DATA_ATTR: false,
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|data:image\/|assets\/|\.\/|\.\.\/|[^:/?#](?:[?#]|$))/iu,
  });
}

/**
 * 内部图片在编辑视图里通过 markdesk-resource: 协议加载；导出的
 * HTML 是独立文件，恢复为原始的相对路径。
 */
function exportImageSrc(src: string): string {
  return src.replace(/^markdesk-resource:/iu, "");
}

const exportSerializer = DOMSerializer.fromSchema(markdownSchema);

/**
 * 将文档模型序列化为完整的独立 HTML 文件：正文经过净化，图片保留
 * 相对路径，样式内联避免外部依赖。
 */
export function buildExportHtml(doc: Node, theme: "light" | "dark"): string {
  const fragment = exportSerializer.serializeFragment(doc.content);
  const host = document.createElement("article");
  host.append(fragment);

  for (const image of Array.from(host.querySelectorAll("img"))) {
    image.setAttribute("src", exportImageSrc(image.getAttribute("src") ?? ""));
  }

  const body = sanitizeHtml(host.innerHTML);
  return `<!doctype html>
<html lang="zh-CN" data-theme="${theme}">
<head><meta charset="utf-8"><title>MarkDesk exported document</title>
<style>body{max-width:860px;margin:48px auto;padding:0 24px;font-family:system-ui,sans-serif;line-height:1.65}img{max-width:100%}pre{overflow:auto;padding:16px}table{border-collapse:collapse}td,th{border:1px solid #888;padding:8px}html[data-theme="dark"]{background:#172033;color:#eef2f8}html[data-theme="dark"] td,html[data-theme="dark"] th{border-color:#555}</style>
</head><body>${body}</body></html>`;
}
