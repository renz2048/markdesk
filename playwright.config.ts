import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  // Electron 端到端测试对显示/资源敏感：多个实例并行会在受限环境
  // （如 WSLg）中偶发崩溃，串行执行换取稳定。
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
  },
});
