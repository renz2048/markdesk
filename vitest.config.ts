import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // tests/e2e 是 Playwright 规范，由 `npm run e2e` 运行。
    exclude: ["**/node_modules/**", "tests/e2e/**"],
  },
});
