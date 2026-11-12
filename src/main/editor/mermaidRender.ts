// Mermaid 图表渲染：统一 mermaid.js 的安全配置、主题与错误处理。
// 渲染只是显示层能力——文档模型始终是 code_block（逐字往返不受影响），
// 仅在视图与导出时把 mermaid 源码画成 SVG。
import type { Mermaid } from "mermaid";

export const MERMAID_LANGUAGE = "mermaid";

export type MermaidRenderResult =
  | { kind: "svg"; svg: string }
  | { kind: "error"; message: string };

let mermaidPromise: Promise<Mermaid> | null = null;
let initializedTheme: "default" | "dark" | null = null;
let renderSeq = 0;

function currentMermaidTheme(): "default" | "dark" {
  return typeof document !== "undefined" &&
    document.documentElement.dataset.theme === "dark"
    ? "dark"
    : "default";
}

async function loadMermaid(): Promise<Mermaid> {
  // 惰性加载：mermaid 体积大，仅在首张图出现时载入；也让注入了假
  // 渲染器的单测（jsdom）完全不必加载它。
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((module) => module.default);
  }
  const mermaid = await mermaidPromise;
  const theme = currentMermaidTheme();
  if (initializedTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      // strict：图表标签按纯文本转义并消毒，禁用 click 跳转与 HTML 注入。
      securityLevel: "strict",
      theme,
    });
    initializedTheme = theme;
  }
  return mermaid;
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/gu, " ").trim().slice(0, 300);
}

/**
 * 把一段 mermaid 源码渲染成 SVG 字符串。源码非法时返回错误消息
 * （不抛出），由调用方决定回退展示。
 */
export async function renderMermaidDiagram(
  source: string,
): Promise<MermaidRenderResult> {
  const id = `markdesk-mermaid-${(renderSeq += 1)}`;
  try {
    const mermaid = await loadMermaid();
    const { svg } = await mermaid.render(id, source);
    return { kind: "svg", svg };
  } catch (error) {
    // mermaid 抛错时可能遗留临时测量节点，兜底清理。
    document.getElementById(`d${id}`)?.remove();
    return { kind: "error", message: describeError(error) };
  }
}
