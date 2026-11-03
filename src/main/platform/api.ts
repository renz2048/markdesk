// 平台 API 解析：Tauri 构建走 invoke 适配层，Electron 构建走 preload
// 暴露的 window.markdesk。渲染端其余代码只依赖 MarkDeskRendererApi。
import type { MarkDeskRendererApi } from "../../shared/types";
import { createTauriApi } from "./tauriApi";

export const isTauriRuntime = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// 静态引入让两种构建共享同一 bundle；createTauriApi 仅在 Tauri 运行时
// 被调用（Electron 下 @tauri-apps/api 不产生副作用）。
const tauriApi = createTauriApi();

export function resolvePlatformApi(): MarkDeskRendererApi | undefined {
  if (isTauriRuntime()) {
    return tauriApi;
  }
  return typeof window === "undefined" ? undefined : window.markdesk;
}
