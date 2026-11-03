import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { clickMenuItem } from "./helpers/menu";

type ElectronApplication = Awaited<ReturnType<typeof electron.launch>>;

async function launchMarkDesk(userData: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [
      join(__dirname, "../.."),
      `--user-data-dir=${userData}`,
      // WSL/CI 等无硬件 GPU 环境下禁用 GPU 进程，避免其崩溃级联拖垮
      // network/zygote 服务；不影响任何安全配置。
      "--disable-gpu",
    ],
    env: { ...process.env, VITE_DEV_SERVER_URL: "" },
  });
}

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

async function killMarkDesk(app: ElectronApplication): Promise<void> {
  const process = app.process();
  const exited = new Promise<void>((resolve) => {
    process.once("exit", () => resolve());
  });
  process.kill("SIGKILL");
  await exited;
}

test("restores a debounced unsaved draft after a forced shutdown", async () => {
  const userData = await mkdtemp(join(tmpdir(), "markdesk-recovery-"));
  const firstApp = await launchMarkDesk(userData);
  const firstPage = await firstApp.firstWindow();
  await firstPage.getByTestId("app-shell").waitFor();

  // 在源码模式输入草稿内容：Markdown 结构即输入文本本身，恢复后还能
  // 验证草稿记录的编辑模式一并还原。
  await firstPage.getByTestId("welcome-new").click();
  await clickMenuItem(firstApp, "模式", "源码模式");
  const source = firstPage.getByTestId("source-editor-content");
  await source.click();
  await firstPage.keyboard.type("# Draft recovery\n未保存内容");
  await expect(firstPage).toHaveTitle("未命名● - MarkDesk");
  await firstPage.waitForTimeout(800);

  await killMarkDesk(firstApp);

  const secondApp = await launchMarkDesk(userData);
  const secondPage = await secondApp.firstWindow();
  await secondPage.getByTestId("app-shell").waitFor();
  await expect(secondPage.getByTestId("recovery-dialog")).toBeVisible();
  await secondPage.getByTestId("recovery-restore").click();

  // 草稿保存了 source 模式；恢复后内容与模式一并还原。
  const restoredSource = secondPage.getByTestId("source-editor-content");
  await expect(restoredSource).toContainText("# Draft recovery");
  await expect(restoredSource).toContainText("未保存内容");
  await expect(secondPage).toHaveTitle("未命名● - MarkDesk");
  await expect(secondPage.getByTestId("recovery-dialog")).toHaveCount(0);

  // 切回 WYSIWYG 验证模型解析正常（标题成为 h1）。
  await clickMenuItem(secondApp, "模式", "所见即所得模式");
  await expect(
    secondPage.getByTestId("wysiwyg-editor-content").locator("h1"),
  ).toHaveText("Draft recovery");
  await expect(secondPage.getByTestId("wysiwyg-editor-content"))
    .toContainText("未保存内容");

  await closeMarkDesk(secondApp);
  await rm(userData, { recursive: true, force: true });
});

test("watches external changes and offers collision recovery choices", async () => {
  const userData = await mkdtemp(join(tmpdir(), "markdesk-external-"));
  const markdownPath = join(userData, "alpha.md");
  const bootstrapApp = await launchMarkDesk(userData);
  const actualUserData = await bootstrapApp.evaluate(({ app }) =>
    app.getPath("userData")
  );
  await closeMarkDesk(bootstrapApp);
  await writeFile(markdownPath, "# Local base\n", "utf8");
  await mkdir(actualUserData, { recursive: true });
  await writeFile(
    join(actualUserData, "recent-files.json"),
    JSON.stringify([{
      path: markdownPath,
      name: "alpha.md",
      lastOpenedAt: Date.now(),
    }], null, 2),
    "utf8",
  );

  const app = await launchMarkDesk(actualUserData);
  const page = await app.firstWindow();
  await page.getByTestId("app-shell").waitFor();
  await page.getByTestId("open-recent-file").first().click();
  await expect(page.getByTestId("wysiwyg-editor-content")).toContainText(
    "Local base",
  );

  await writeFile(markdownPath, "# External one\n", "utf8");
  await expect(page.getByTestId("file-changed-notice")).toBeVisible();

  const editor = page.getByTestId("wysiwyg-editor-content");
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" local edit");
  await writeFile(markdownPath, "# External two\n", "utf8");
  await expect(page.getByTestId("file-changed-notice")).toBeVisible();

  await clickMenuItem(app, "文件", "保存");
  await expect(page.getByTestId("file-collision-dialog")).toBeVisible();
  await expect(page.getByTestId("file-collision-overwrite")).toBeVisible();
  await expect(page.getByTestId("file-collision-reload")).toBeVisible();
  await expect(page.getByTestId("file-collision-save-as")).toBeVisible();

  await page.getByTestId("file-collision-reload").click();
  await expect(page.getByTestId("wysiwyg-editor-content")).toContainText(
    "External two",
  );
  await expect(page.getByTestId("file-collision-dialog")).toHaveCount(0);
  expect(await readFile(markdownPath, "utf8")).toBe("# External two\n");

  await closeMarkDesk(app);
  await rm(userData, { recursive: true, force: true });
});
