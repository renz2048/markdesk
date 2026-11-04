// Tauri 版冒烟测试：启动打包后的应用（开启 WebView2 远程调试端口），
// 用 Playwright CDP 连接验证核心链路：argv 打开、窗口标题、即输即转、
// 授权横幅与受限协议图片加载。
//
// 前置：npm run dist（生成 src-tauri/target/release/markdesk.exe）
// 运行：npm run smoke [exe路径]
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";

const exe =
  process.argv[2] ?? "src-tauri/target/release/markdesk.exe";
const docDir = await mkdtemp(join(tmpdir(), "markdesk-smoke-"));
const picDir = await mkdtemp(join(tmpdir(), "markdesk-smokepic-"));
const pngPath = join(picDir, "pixel.png").split(/[\\/]/u).join("/");
await writeFile(
  pngPath,
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const markdownPath = join(docDir, "smoke.md");
await writeFile(
  markdownPath,
  `# 冒烟\n\n![像素](${pngPath})\n\n正文\n`,
  "utf8",
);

const child = spawn(exe, [markdownPath], {
  env: {
    ...process.env,
    MARKDESK_DATA_DIR: join(docDir, "appdata"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9223",
  },
  stdio: "ignore",
});

let browser = null;
for (let attempt = 0; attempt < 40 && !browser; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
  } catch {
    browser = null;
  }
}
if (!browser) {
  child.kill("SIGKILL");
  console.error("FAIL: 无法连接 WebView2 调试端口");
  process.exit(1);
}

const context = browser.contexts()[0];
const page = context.pages()[0] ?? (await context.newPage());
await page.getByTestId("app-shell").waitFor({ timeout: 20000 });

const results = [];
const check = (name, pass) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
};

// 1. argv 打开的文档内容渲染（渲染端就绪后拉取启动路径，轮询等待）。
let heading = 0;
for (let i = 0; i < 20 && heading === 0; i += 1) {
  await page.waitForTimeout(500);
  heading = await page
    .getByTestId("wysiwyg-editor-content")
    .locator("h1", { hasText: "冒烟" })
    .count();
}
check("argv 打开文档渲染", heading === 1);

// 2. 窗口标题（setWindowTitle 命令）。
let title = "";
for (let i = 0; i < 10 && title !== "smoke.md - MarkDesk"; i += 1) {
  title = await page.title();
  if (title !== "smoke.md - MarkDesk") {
    await page.waitForTimeout(400);
  }
}
check(`窗口标题（${title}）`, title === "smoke.md - MarkDesk");

// 3. 即输即转列表（渲染端管线在 WebView2 下同样工作）。
await page.getByTestId("wysiwyg-editor-content").locator("p").last().click();
await page.keyboard.press("End");
await page.keyboard.type("\n- 列表项");
await page.waitForTimeout(300);
const listCount = await page
  .getByTestId("wysiwyg-editor-content")
  .locator("ul > li")
  .count();
check("“- ” 即时转列表", listCount >= 1);

// 4. 目录外图片 → 授权横幅出现；全部允许后经受限协议真实加载。
try {
  await page.getByTestId("local-images-notice").waitFor({ timeout: 5000 });
  await page.getByTestId("local-images-allow").click();
  let width = 0;
  for (let i = 0; i < 20 && width <= 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    width = await page.evaluate(() => {
      const img = document.querySelector(
        '[data-testid="wysiwyg-editor-content"] img:not(.ProseMirror-separator)',
      );
      return img?.naturalWidth ?? -1;
    });
  }
  check(`受限协议图片加载（naturalWidth=${width}）`, width > 0);
} catch {
  check("授权横幅未出现", false);
}

// 5. 保存链路：读取 → 携带 expected 指纹写入 → 磁盘内容验证
//（覆盖“文件指纹无效”回归：指纹字段为 camelCase）。
const invoke = (command, args) =>
  page.evaluate(
    async ({ command, args }) => {
      try {
        const value = await window.__TAURI_INTERNALS__.invoke(command, args);
        return { ok: true, value };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    },
    { command, args },
  );
const readBack = await invoke("read_file", { path: markdownPath });
if (!readBack.ok) {
  check("保存链路（read_file）", false);
} else {
  const saved = await invoke("write_file", {
    path: markdownPath,
    content: "# 冒烟\n\n保存验证\n",
    newline: "lf",
    expected: {
      hash: readBack.value.hash,
      mtimeMs: readBack.value.mtimeMs,
      size: readBack.value.size,
    },
  });
  const onDisk = await readFile(markdownPath, "utf8");
  check(
    `保存链路（指纹写入，${saved.ok ? "ok" : saved.error}）`,
    saved.ok && onDisk.includes("保存验证"),
  );
}

await browser.close();
child.kill("SIGKILL");
const failed = results.filter((item) => !item.pass);
console.log(
  `\n${results.length - failed.length}/${results.length} passed`,
);
process.exit(failed.length > 0 ? 1 : 0);
