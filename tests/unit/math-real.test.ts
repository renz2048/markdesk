// @vitest-environment jsdom
// 真实 MathJax 管线集成验证（math.test.ts 全程 mock 渲染器，这里加载
// 真实 mathjax-full 以捕捉版本升级导致的集成断裂）。AllPackages 默认
// 启用 noerrors/noundefined：非法 TeX 不抛错，而是渲染为红色错误图。
import { describe, expect, it } from "vitest";
import { renderMathSvg } from "../../src/main/editor/mathRender";

describe("real mathjax render", () => {
  it("renders the issue's vmatrix example to a standalone svg", async () => {
    const result = await renderMathSvg(
      "\\mathbf{V}_1 \\times \\mathbf{V}_2 = \\begin{vmatrix} i & j & k \\\\ 1 & 2 & 3 \\\\ 4 & 5 & 6 \\end{vmatrix}",
    );
    expect(result.kind).toBe("svg");
    if (result.kind === "svg") {
      expect(result.svg).toContain("<svg");
      // fontCache:"local" 下字形路径内嵌，导出/打印不依赖外部字体。
      expect(result.svg).toContain("<path");
      expect(result.svg.length).toBeGreaterThan(500);
    }
  });

  it("renders invalid tex as an error image rather than throwing", async () => {
    const result = await renderMathSvg("\\undefinedmacro{x}");
    expect(result.kind).toBe("svg");
  });
});
