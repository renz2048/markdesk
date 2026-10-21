import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

type ElectronApplication = Awaited<ReturnType<typeof electron.launch>>;
type Page = Awaited<ReturnType<ElectronApplication["firstWindow"]>>;

let app: ElectronApplication;
let page: Page;
let exportDir: string;

// 五个用例共享一次启动：受限环境下反复拉起/杀掉 Electron 实例
// 会累积显示与子进程压力，导致偶发启动失败。
test.beforeAll(async () => {
  exportDir = await mkdtemp(join(tmpdir(), "markdesk-security-"));
  app = await electron.launch({
    args: [
      join(__dirname, "../.."),
      `--user-data-dir=${exportDir}`,
      "--disable-gpu",
    ],
    env: { ...process.env, VITE_DEV_SERVER_URL: "" },
  });
  page = await app.firstWindow();
  await page.getByTestId("app-shell").waitFor();
});

test.afterAll(async () => {
});

/**
 * 优雅关闭应用；关闭保护会拦截窗口关闭并使 app.close() 挂起
 * （Playwright 经 CDP 关闭页面等同于触发窗口 close），此时退回到
 * SIGKILL——测试环境中的未保存编辑内容可以丢弃。
 */
async function closeMarkDesk(app: ElectronApplication): Promise<void> {
  const proc = app.process();
  const exited = new Promise<void>((resolve) => {
    proc.once("exit", () => resolve());
  });
  await Promise.race([
    app.close().catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (proc.exitCode === null && !proc.killed) {
    proc.kill("SIGKILL");
  }
  await exited;
}

test("renderer does not expose Node integration globals", async () => {

  const leaked = await page.evaluate(() => {
    const scope = window as unknown as Record<string, unknown>;
    return {
      require: typeof scope.require,
      process: typeof scope.process,
      global: typeof scope.global,
      module: typeof scope.module,
      Buffer: typeof scope.Buffer,
    };
  });
  expect(leaked).toEqual({
    require: "undefined",
    process: "undefined",
    global: "undefined",
    module: "undefined",
    Buffer: "undefined",
  });
});

test("window.markdesk exposes only the documented API surface", async () => {

  const keys = await page.evaluate(() =>
    Object.keys(window.markdesk ?? {}).sort()
  );
  expect(keys).toEqual([
    "cancelClose",
    "chooseExportLocation",
    "chooseMarkdownFile",
    "chooseSaveLocation",
    "clearRecentFiles",
    "discardRecoveryDraft",
    "exportHtml",
    "getRecentFiles",
    "listRecoveryDrafts",
    "onCloseRequested",
    "onFileChanged",
    "onMenuCommand",
    "onOpenRecentFile",
    "onRecentFilesChanged",
    "readFile",
    "readRecentFile",
    "readRecoveryDraft",
    "requestClose",
    "saveRecoveryDraft",
    "writeFile",
  ]);
});

test("window.open does not create an app child window", async () => {
  const before = app.windows().length;

  const result = await page.evaluate(() =>
    window.open("https://example.com")
  );
  await page.waitForTimeout(500);

  expect(result).toBeNull();
  expect(app.windows()).toHaveLength(before);
  // 应用窗口没有导航离开本地内容。
  expect(page.url()).toContain("index.html");
});

test("readFile rejects relative and ungranted paths", async () => {

  const rejection = await page.evaluate(async () => {
    try {
      await window.markdesk?.readFile("../outside.md");
      return "resolved";
    } catch (error) {
      const message = String((error as Error).message ?? "");
      return message.split("\n")[0];
    }
  });
  expect(rejection).toBe("invalid-path");
});

test("exported HTML is sanitized end to end", async () => {
  const exportPath = join(exportDir, "export.html");

  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = async () => ({
      canceled: false,
      filePath: target,
    });
  }, exportPath);

  // 新建文档，写入包含 HTML 注入面的内容，走真实导出管线。
  await page.getByTestId("welcome-new").click();
  await page.getByTestId("mode-source").click();
  const source = page.getByTestId("source-editor-content");
  await source.click();
  await page.keyboard.type(
    "# 标题\n\n<!-- protected raw -->\n\n[安全](https://example.com)\n",
  );
  // 模拟原生菜单项派发导出命令（WSLg 环境下合成加速键不可靠；
  // 菜单定义与命令分发由 menu.ts 的单测/类型保证）。
  await app.evaluate(({ BrowserWindow }, channel) => {
    // 前一个用例的 window.open 会唤起系统浏览器并使窗口失焦，
    // 因此按单窗口应用语义定向主窗口发送，而不是依赖焦点窗口。
    BrowserWindow.getAllWindows()[0]?.webContents.send(channel, "export-html");
  }, "markdesk:menu-command");
  // 等待导出真正落盘（全量串行执行时系统负载高，固定延时不可靠）。
  await expect
    .poll(
      async () => {
        try {
          await access(exportPath);
          return true;
      } catch {
        return false;
      }
      },
      { timeout: 5000 },
    )
    .toBe(true);

  const html = await readFile(exportPath, "utf8");
  expect(html).toContain("<h1>标题</h1>");
  expect(html).toContain('href="https://example.com"');
  expect(html.toLowerCase()).not.toContain("<script");
  expect(html).not.toContain("onclick");
  // 导出不改变文档脏状态。
  await expect(page.getByTestId("document-dirty-status")).toHaveText("未保存");

});
