import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: { outDir: "dist", sourcemap: true },
  server: {
    watch: {
      // cargo 链接 target/debug 下的 exe 时会短暂锁定文件，vite 监视到
      // 该目录会 EBUSY 崩溃（dev 与 tauri build 并行时必现）。
      ignored: ["**/src-tauri/target/**"],
    },
  },
});
