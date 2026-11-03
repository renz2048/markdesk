import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { clickMenuItem } from "./helpers/menu";

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
  await clickMenuItem(app, "文件", "打开…");
  await expect(page).toHaveTitle("note.md - MarkDesk");
  await expect(page.getByTestId("wysiwyg-editor-content").locator("h1"))
    .toHaveText("起始标题");

  // Typora 式缓冲输入：行首键入 “# ” 不立即转换，回车确认转为一级
  // 标题并落到下方新段落，退格清掉续行空段后保存。
  const editor = page.getByTestId("wysiwyg-editor-content");
  await editor.locator("p").click();
  await page.keyboard.press("Home");
  await page.keyboard.type("# ");
  await expect(editor.locator("h1")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(editor.locator("h1")).toHaveCount(2);
  await page.keyboard.press("Backspace");
  await clickMenuItem(app, "文件", "保存");
  await expect(page).toHaveTitle("note.md - MarkDesk");
  expect(await readFile(markdownPath, "utf8")).toBe(
    "# 起始标题\n\n# 正文段落\n",
  );

  // 源码模式追加任务项，切回 WYSIWYG 后保存并重新打开。
  await clickMenuItem(app, "模式", "源码模式");
  const source = page.getByTestId("source-editor-content");
  await source.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n- [ ] 新任务");
  await clickMenuItem(app, "模式", "所见即所得模式");
  await expect(editor).toContainText("新任务");
  await clickMenuItem(app, "文件", "保存");
  await expect(page).toHaveTitle("note.md - MarkDesk");

  // 重新打开同一文件，任务项与结构保持稳定。
  await clickMenuItem(app, "文件", "新建");
  await expect(page.getByTestId("welcome-view")).toBeVisible();
  await page.getByTestId("open-recent-file").first().click();
  await expect(editor).toContainText("新任务");
  await expect(editor.locator("li")).toHaveCount(1);
  expect(await readFile(markdownPath, "utf8")).toBe(
    "# 起始标题\n\n# 正文段落\n\n- [ ] 新任务\n",
  );

  await closeMarkDesk(app);
});

test("打开文档时逐张或全部允许目录外本地图片", async () => {
  const userData = await mkdtemp(join(tmpdir(), "markdesk-imgdoc-"));
  const picDir = await mkdtemp(join(tmpdir(), "markdesk-imgpic-"));
  // 1×1 透明 PNG。
  const pixelPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  // 正斜杠绝对路径在 Windows/POSIX 都能被解析与访问。
  const firstPng = join(picDir, "first.png").split(/[\\/]/u).join("/");
  const secondPng = join(picDir, "second.png").split(/[\\/]/u).join("/");
  await writeFile(firstPng, pixelPng);
  await writeFile(secondPng, pixelPng);
  const markdownPath = join(userData, "images.md");
  await writeFile(
    markdownPath,
    `# 图片\n\n![第一张](${firstPng})\n\n![第二张](${secondPng})\n`,
    "utf8",
  );

  const naturalWidthOf = (target: Page, index: number) =>
    target.evaluate((itemIndex) => {
      const img = document.querySelectorAll<HTMLImageElement>(
        '[data-testid="wysiwyg-editor-content"] img:not(.ProseMirror-separator)',
      )[itemIndex];
      return img?.naturalWidth ?? -1;
    }, index);

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
  await app.evaluate(({ dialog }, selectedPath) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [selectedPath],
    });
  }, markdownPath);
  await clickMenuItem(app, "文件", "打开…");
  const editor = page.getByTestId("wysiwyg-editor-content");
  // ProseMirror 会在 inline 原子节点后补一个 ProseMirror-separator 辅助
  // img，选择器需排除。
  await expect(
    editor.locator("img:not(.ProseMirror-separator)"),
  ).toHaveCount(2);

  // 未授权：横幅列出两张待确认图片。
  const notice = page.getByTestId("local-images-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("2 张本地图片");
  await expect(page.getByTestId("local-images-item")).toHaveCount(2);

  // 只允许第一张：它加载成功，第二张仍被阻止，横幅剩 1 张。
  await page
    .getByTestId("local-images-item")
    .filter({ hasText: "first.png" })
    .getByTestId("local-images-allow-one")
    .click();
  await expect
    .poll(() => naturalWidthOf(page, 0))
    .toBeGreaterThan(0);
  await expect(page.getByTestId("local-images-item")).toHaveCount(1);
  await expect(notice).toContainText("1 张本地图片");
  expect(await naturalWidthOf(page, 1)).toBe(0);

  // 全部允许：剩下的一张也加载，横幅消失。
  await page.getByTestId("local-images-allow").click();
  await expect(notice).toBeHidden();
  await expect
    .poll(() => naturalWidthOf(page, 1))
    .toBeGreaterThan(0);

  // 授权持久化：同一用户数据目录重启后不再询问，两张直接显示。
  await closeMarkDesk(app);
  const reopened = await electron.launch({
    args: [
      join(__dirname, "../.."),
      `--user-data-dir=${userData}`,
      "--disable-gpu",
    ],
    env: { ...process.env, VITE_DEV_SERVER_URL: "" },
  });
  const secondPage: Page = await reopened.firstWindow();
  await secondPage.getByTestId("app-shell").waitFor();
  await reopened.evaluate(({ dialog }, selectedPath) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [selectedPath],
    });
  }, markdownPath);
  await clickMenuItem(reopened, "文件", "打开…");
  await expect(
    secondPage
      .getByTestId("wysiwyg-editor-content")
      .locator("img:not(.ProseMirror-separator)"),
  ).toHaveCount(2);
  await expect(secondPage.getByTestId("local-images-notice")).toBeHidden();
  await expect
    .poll(() => naturalWidthOf(secondPage, 0))
    .toBeGreaterThan(0);
  await expect
    .poll(() => naturalWidthOf(secondPage, 1))
    .toBeGreaterThan(0);

  await closeMarkDesk(reopened);
});

test("模式切换保持之前的视图位置（需求 5.2）", async () => {
  const userData = await mkdtemp(join(tmpdir(), "markdesk-view-"));
  const markdownPath = join(userData, "long.md");
  const paragraphs = Array.from(
    { length: 80 },
    (_, index) => `第 ${index + 1} 段内容`,
  ).join("\n\n");
  await writeFile(markdownPath, `# 长文档\n\n${paragraphs}\n`, "utf8");

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
  await app.evaluate(({ dialog }, selectedPath) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [selectedPath],
    });
  }, markdownPath);
  await clickMenuItem(app, "文件", "打开…");
  await expect(page.getByTestId("wysiwyg-editor-content")).toContainText(
    "第 80 段内容",
  );

  const scrollRatio = async (): Promise<number> => {
    return page.evaluate(() => {
      const el = document.querySelector<HTMLElement>(".editor");
      if (!el || el.scrollHeight <= el.clientHeight) return -1;
      return el.scrollTop / (el.scrollHeight - el.clientHeight);
    });
  };

  // 滚到中部。
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".editor");
    if (el) el.scrollTop = (el.scrollHeight - el.clientHeight) * 0.5;
  });
  await page.waitForTimeout(200);
  const wysiwygRatio = await scrollRatio();

  // 切到源码模式：视图不应回到顶部。
  await clickMenuItem(app, "模式", "源码模式");
  await page.waitForTimeout(400);
  const sourceRatio = await scrollRatio();
  expect(Math.abs(sourceRatio - wysiwygRatio)).toBeLessThan(0.2);

  // 切回所见即所得：同样保持在附近。
  await clickMenuItem(app, "模式", "所见即所得模式");
  await page.waitForTimeout(400);
  const backRatio = await scrollRatio();
  expect(Math.abs(backRatio - wysiwygRatio)).toBeLessThan(0.2);

  await closeMarkDesk(app);
});
