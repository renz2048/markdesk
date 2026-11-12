import DOMPurify from "dompurify";
import { DOMSerializer, Node } from "prosemirror-model";
import { markdownSchema, sourceImageSrc } from "../../markdown/schema";
import { isMermaidBlock } from "./mermaidBlock";
import { renderMermaidDiagram } from "./mermaidRender";

const allowedTags = [
  "article", "aside", "blockquote", "br", "code", "del", "em", "h1", "h2",
  "h3", "h4", "h5", "h6", "hr", "img", "li", "ol", "p", "pre", "strong",
  "table", "tbody", "td", "th", "thead", "tr", "ul", "a",
];

// style 仅用于表格单元格的 text-align 对齐；进入净化器的 HTML 全部由
// 模型序列化生成（行内 HTML 禁用、原始块惰性渲染），不存在用户控制的
// style 值，因此放行是安全的。
const allowedAttributes = [
  "href", "title", "src", "alt", "class", "style", "data-language",
];

/**
 * 清理导出的 HTML：只保留文档结构所需的标签与属性。任何脚本、
 * 事件处理器或不安全的 URL 方案都会被移除。
 */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: allowedTags,
    ALLOWED_ATTR: allowedAttributes,
    ALLOW_DATA_ATTR: false,
    // 自定义 URI 白名单下 DOMPurify 会对未知属性（data-language）的
    // 值做 URL 校验；它是语言名不是链接，显式豁免。
    ADD_URI_SAFE_ATTR: ["data-language"],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|data:image\/|assets\/|\.\/|\.\.\/|[^:/?#](?:[?#]|$))/iu,
  });
}

/**
 * mermaid SVG 单独消毒：图表需要 svg/html 两套标签（htmlLabels 的
 * foreignObject 内是 HTML），策略上放行 svg+svgFilters+html profile
 * 与 <style>（mermaid 内联字体样式），脚本与事件处理器仍被剥除。
 */
function sanitizeMermaidSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
    ADD_TAGS: ["style"],
    ADD_ATTR: ["style"],
  });
}

/**
 * 渲染导出用的 mermaid 图：失败返回 null，调用方回退为保留源码代码
 * 块。消毒统一在其结果上进行，注入的渲染器（单测）也不例外。
 */
async function renderMermaidExportSvg(source: string): Promise<string | null> {
  const result = await renderMermaidDiagram(source);
  return result.kind === "svg" ? result.svg : null;
}

/** 单测可注入的 mermaid 渲染器：源码 → SVG 字符串（null 表示失败）。 */
export type MermaidSvgRenderer = (source: string) => Promise<string | null>;

/** 渲染并消毒单张图；空结果返回 null 以便回退源码展示。 */
async function renderSanitizedSvg(
  source: string,
  renderSvg: MermaidSvgRenderer,
): Promise<string | null> {
  const raw = await renderSvg(source);
  if (!raw) return null;
  const svg = sanitizeMermaidSvg(raw);
  return svg.includes("<svg") ? svg : null;
}

/**
 * 内部图片在编辑视图里通过 markdesk-resource: 协议加载；导出的
 * HTML 是独立文件，恢复为原始的相对路径或本地绝对路径。
 */
function exportImageSrc(src: string): string {
  return sourceImageSrc(src);
}

const exportSerializer = DOMSerializer.fromSchema(markdownSchema);

/** 收集文档里的 mermaid 源码（去掉 fence 的结尾换行）并渲染成 SVG。 */
async function renderMermaidMap(
  doc: Node,
  renderSvg: MermaidSvgRenderer,
): Promise<Map<string, string>> {
  const sources = new Set<string>();
  doc.descendants((node) => {
    if (!isMermaidBlock(node)) return true;
    const source = (node.textContent ?? "").replace(/\n$/u, "");
    if (source.trim()) sources.add(source);
    return false;
  });
  const entries = await Promise.all(
    Array.from(sources, async (source) => {
      const svg = await renderSanitizedSvg(source, renderSvg);
      return svg ? ([source, svg] as const) : null;
    }),
  );
  return new Map(entries.filter((entry): entry is readonly [string, string] =>
    Boolean(entry),
  ));
}

/**
 * 把已消毒正文里的 mermaid 代码块替换为渲染好的 SVG。渲染失败的块
 * 保留原代码展示。替换在主消毒之后进行——SVG 已单独消毒，避免为其
 * 放宽正文标签白名单。
 */
function replaceMermaidBlocks(body: string, svgBySource: Map<string, string>): string {
  if (svgBySource.size === 0) return body;
  const host = document.createElement("div");
  host.innerHTML = body;
  for (const pre of Array.from(
    host.querySelectorAll('pre[data-language="mermaid" i]'),
  )) {
    const svg = svgBySource.get((pre.textContent ?? "").replace(/\n$/u, ""));
    if (!svg) continue;
    const figure = document.createElement("div");
    figure.className = "markdesk-mermaid-export";
    figure.innerHTML = svg;
    pre.replaceWith(figure);
  }
  return host.innerHTML;
}

/**
 * 将文档模型序列化为完整的独立 HTML 文件：正文经过净化，图片保留
 * 相对路径，mermaid 图表以内联 SVG 嵌入，样式内联避免外部依赖。
 */
export async function buildExportHtml(
  doc: Node,
  theme: "light" | "dark",
  renderMermaid: MermaidSvgRenderer = renderMermaidExportSvg,
): Promise<string> {
  const svgBySource = await renderMermaidMap(doc, renderMermaid);
  const fragment = exportSerializer.serializeFragment(doc.content);
  const host = document.createElement("article");
  host.append(fragment);

  for (const image of Array.from(host.querySelectorAll("img"))) {
    image.setAttribute("src", exportImageSrc(image.getAttribute("src") ?? ""));
  }

  const body = replaceMermaidBlocks(sanitizeHtml(host.innerHTML), svgBySource);
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
/* 空单元格无行框，打印/PDF 里整行会塌陷成只剩 padding；注入零宽
   空格让它拥有与文本行相同的行高（应用内编辑器单元格必有段落节点，
   天然等高，仅导出需要）。 */
th:empty::after,td:empty::after{content:"\\200b"}
thead,tr:nth-child(2n){background:#f8f8f8}
.markdesk-mermaid-export{margin:.8em 0;text-align:center}
.markdesk-mermaid-export svg{max-width:100%;height:auto}
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
