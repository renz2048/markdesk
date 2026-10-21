import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

type ElectronApplication = Awaited<ReturnType<typeof electron.launch>>;
type Page = Awaited<ReturnType<ElectronApplication["firstWindow"]>>;

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

test("open, edit, save, switch modes, and reload keep Markdown semantics", async () => {
  const userData = await mkdtemp(join(tmpdir(), "markdesk-lifecycle-"));
  const markdownPath = join(userData, "note.md");
  await writeFile(markdownPath, "# 起始标题\n\n正文段落\n", "utf8");

  const app = await electron.launch({
    args: [
      join(__dirname, "../.."),
      `--user-data-dir=${userData}`,
      "--disable-gpu",
    ],
    env: { ...process.env, VITE_DEV_SERVER_URL: "" },
  });
  const page: Page = await app.firstWindow();
  await page.getByTestId("app-shell").waitFor();

  // 通过桩住的打开对话框打开临时文档。
  await app.evaluate(({ dialog }, selectedPath) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [selectedPath],
    });
  }, markdownPath);
  await page.getByTestId("file-open").click();
  await expect(page.getByTestId("document-name")).toHaveText("note.md");
  await expect(page.getByTestId("wysiwyg-editor-content").locator("h1"))
    .toHaveText("起始标题");

  // 用 WYSIWYG 工具栏把段落转为一级标题，再保存。
  const editor = page.getByTestId("wysiwyg-editor-content");
  await editor.locator("p").click();
  await page.getByTestId("toolbar-heading-1").click();
  await expect(editor.locator("h1")).toHaveCount(2);
  await page.getByTestId("file-save").click();
  await expect(page.getByTestId("document-dirty-status")).toHaveText("已保存");
  expect(await readFile(markdownPath, "utf8")).toBe(
    "# 起始标题\n\n# 正文段落\n",
  );

  // 源码模式追加任务项，切回 WYSIWYG 后保存并重新打开。
  await page.getByTestId("mode-source").click();
  const source = page.getByTestId("source-editor-content");
  await source.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n- [ ] 新任务");
  await page.getByTestId("mode-wysiwyg").click();
  await expect(editor).toContainText("新任务");
  await page.getByTestId("file-save").click();
  await expect(page.getByTestId("document-dirty-status")).toHaveText("已保存");

  // 重新打开同一文件，任务项与结构保持稳定。
  await page.getByTestId("file-new").click();
  await expect(page.getByTestId("welcome-view")).toBeVisible();
  await page.getByTestId("open-recent-file").first().click();
  await expect(editor).toContainText("新任务");
  await expect(editor.locator("li")).toHaveCount(1);
  expect(await readFile(markdownPath, "utf8")).toBe(
    "# 起始标题\n\n# 正文段落\n\n- [ ] 新任务\n",
  );

  await closeMarkDesk(app);
});
