import DOMPurify from "dompurify";
import { DOMSerializer, Node } from "prosemirror-model";
import { markdownSchema, sourceImageSrc } from "../../markdown/schema";

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
 * HTML 是独立文件，恢复为原始的相对路径或本地绝对路径。
 */
function exportImageSrc(src: string): string {
  return sourceImageSrc(src);
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
<style>
/* 导出样式与应用内一致：对齐 Typora github / night 主题。 */
body{max-width:860px;margin:48px auto;padding:0 30px;color:#333;font:16px/1.6 "Open Sans","Clear Sans","Segoe UI","Helvetica Neue",Helvetica,Arial,"PingFang SC","Microsoft YaHei",sans-serif}
h1,h2,h3,h4,h5,h6{margin:1rem 0;font-weight:bold;line-height:1.4}
h1{font-size:2.25em;border-bottom:1px solid #eee}
h2{font-size:1.75em;border-bottom:1px solid #eee}
h3{font-size:1.5em}
h4{font-size:1.25em}
h6{color:#777}
p,blockquote,ul,ol,table{margin:.8em 0}
ul,ol{padding-left:30px}
blockquote{padding:0 15px;border-left:4px solid #dfe2e5;color:#777}
a{color:#4183C4}
img{max-width:100%}
code,pre{border-radius:3px;font-family:"Lucida Console",Consolas,"Courier",monospace}
code{padding:2px 4px;background:#f3f4f4;font-size:.9em}
pre{overflow:auto;padding:8px 10px 6px;background:#f8f8f8;border:1px solid #e7eaed;white-space:pre}
pre code{padding:0;background:transparent}
hr{height:2px;border:0;margin:16px 0;background:#e7e7e7}
table{width:100%;border-collapse:collapse}
th,td{border:1px solid #dfe2e5;padding:6px 13px;vertical-align:top}
thead,tr:nth-child(2n){background:#f8f8f8}
html[data-theme="dark"]{background:#363B40;color:#b8bfc6}
html[data-theme="dark"] h1,html[data-theme="dark"] h2,html[data-theme="dark"] h3{color:#DEDEDE;border-bottom-color:transparent}
html[data-theme="dark"] h6{color:#9DA2A6}
html[data-theme="dark"] blockquote{border-left-color:#474d54;color:#9DA2A6}
html[data-theme="dark"] a{color:#e0e0e0}
html[data-theme="dark"] code{background:rgb(0 0 0 / 25%)}
html[data-theme="dark"] pre{background:#333;border-color:transparent}
html[data-theme="dark"] hr{background:#474d54}
html[data-theme="dark"] th,html[data-theme="dark"] td{border-color:#474d54}
html[data-theme="dark"] thead,html[data-theme="dark"] tr:nth-child(2n){background:transparent}
</style>
</head><body>${body}</body></html>`;
}
