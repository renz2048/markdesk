// 平台 API：Tauri invoke 适配层（应用仅有 Tauri 一套外壳）。
// 渲染端其余代码只依赖 MarkDeskRendererApi。
import type { MarkDeskRendererApi } from "../../shared/types";
import { createTauriApi } from "./tauriApi";

// 无窗口环境（纯单测）下为 undefined；正常加载即 Tauri 运行时。
const tauriApi = createTauriApi();

export function resolvePlatformApi(): MarkDeskRendererApi | undefined {
  return typeof window === "undefined" ? undefined : tauriApi;
}
