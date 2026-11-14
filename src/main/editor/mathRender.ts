// 数学公式渲染：MathJax（tex → SVG）的统一安全配置与错误处理。
// SVG 输出把字形路径内嵌进每张图（fontCache: "local"），应用内与导出
// 都不依赖外部字体或 CSS；渲染与 mermaid 一样只是显示层能力——文档
// 模型始终是 math_block（逐字往返不受影响）。
export type MathRenderResult =
  | { kind: "svg"; svg: string }
  | { kind: "error"; message: string };

// mathjax-full 的 MathDocument 泛型（N/T/D 适配器三件套）对本模块
// 无意义，这里按需声明用到的最小结构。
interface MathJaxDocument {
  convert(
    source: string,
    options: {
      display: boolean;
      em: number;
      ex: number;
      containerWidth: number;
    },
  ): unknown;
}

let mathDocumentPromise: Promise<MathJaxDocument> | null = null;

async function loadMathDocument(): Promise<MathJaxDocument> {
  // 惰性加载：mathjax 体积大，仅在首个公式出现时载入；也让注入了假
  // 渲染器的单测（jsdom）完全不必加载它。
  if (!mathDocumentPromise) {
    mathDocumentPromise = Promise.all([
      import("mathjax-full/js/mathjax.js"),
      import("mathjax-full/js/input/tex.js"),
      import("mathjax-full/js/input/tex/AllPackages.js"),
      import("mathjax-full/js/output/svg.js"),
      import("mathjax-full/js/adaptors/browserAdaptor.js"),
      import("mathjax-full/js/handlers/html.js"),
    ]).then(
      ([
        { mathjax },
        { TeX },
        { AllPackages },
        { SVG },
        { browserAdaptor },
        { RegisterHTMLHandler },
      ]) => {
        RegisterHTMLHandler(browserAdaptor());
        // bussproofs 在无 DOM 测量环境下初始化会抛错；html 包的
        // \href/\class/\style 是 HTML 透出入口，SVG 输出下既无意义
        // 又扩大攻击面，一并禁用。
        const packages = AllPackages.filter(
          (name) => name !== "bussproofs" && name !== "html",
        );
        return mathjax.document("", {
          InputJax: new TeX({ packages }),
          OutputJax: new SVG({ fontCache: "local" }),
        });
      },
    );
  }
  return mathDocumentPromise;
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/gu, " ").trim().slice(0, 300);
}

/**
 * 把一段 TeX 源码渲染成独立 SVG 字符串（display 模式）。源码非法时
 * 返回错误消息（不抛出），由调用方决定回退展示。
 */
export async function renderMathSvg(
  source: string,
): Promise<MathRenderResult> {
  try {
    const doc = await loadMathDocument();
    const container = doc.convert(source, {
      display: true,
      em: 16,
      ex: 8,
      containerWidth: 80 * 16,
    }) as unknown as HTMLElement;
    const svg = container.querySelector?.("svg");
    if (!svg) {
      return { kind: "error", message: "公式渲染结果为空" };
    }
    return { kind: "svg", svg: svg.outerHTML };
  } catch (error) {
    return { kind: "error", message: describeError(error) };
  }
}
