import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  _electron as electron,
  expect,
  test,
} from "@playwright/test";
import { markdeskChannels } from "../../src/shared/types";

type ElectronApplication = Awaited<ReturnType<typeof electron.launch>>;
type Page = Awaited<ReturnType<ElectronApplication["firstWindow"]>>;

test.describe.configure({ mode: "serial" });

let app: ElectronApplication;
let page: Page;
let alphaPath: string;
let betaPath: string;

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

async function launch(userData?: string): Promise<void> {
  app = await electron.launch({
    args: [
      join(__dirname, "../.."),
      ...(userData ? [`--user-data-dir=${userData}`] : []),
      // WSL/CI 等无硬件 GPU 环境下禁用 GPU 进程，避免其崩溃级联拖垮
      // network/zygote 服务；不影响任何安全配置。
      "--disable-gpu",
    ],
    env: { ...process.env, VITE_DEV_SERVER_URL: "" },
  });
  page = await app.firstWindow();
  await page.getByTestId("app-shell").waitFor();
}

async function openRecent(path: string): Promise<void> {
  await page.locator(`[data-testid="open-recent-file"][data-path="${path}"]`)
    .click();
  await expect(page.getByTestId("welcome-view")).toHaveCount(0);
}

test.beforeAll(async () => {
  alphaPath = join(tmpdir(), `markdesk-e2e-alpha-${Date.now()}.md`);
  betaPath = join(tmpdir(), `markdesk-e2e-beta-${Date.now()}.md`);
  // 每次运行使用独立的用户数据目录，避免与其他规范共享最近文件/草稿。
  const isolatedUserData = await mkdtemp(join(tmpdir(), "markdesk-recent-close-"));
  await launch(isolatedUserData);
  const userData = await app.evaluate(({ app: electronApp }) =>
    electronApp.getPath("userData")
  );
  await closeMarkDesk(app);

  await mkdir(userData, { recursive: true });
  await writeFile(alphaPath, "# Alpha\n", "utf8");
  await writeFile(
    betaPath,
    `${"Beta ".repeat(1_500_000)}# Beta end\n`,
    "utf8",
  );
  await writeFile(join(userData, "recent-files.json"), JSON.stringify([
    {
      path: alphaPath,
      name: basename(alphaPath),
      lastOpenedAt: 2,
    },
    {
      path: betaPath,
      name: basename(betaPath),
      lastOpenedAt: 1,
    },
  ]), "utf8");
  await launch(isolatedUserData);
});

test.afterAll(async () => {
  if (app) await closeMarkDesk(app);
});

test("clean new and recent opens execute without confirmation", async () => {
  await expect(page.getByTestId("welcome-view")).toBeVisible();
  await expect(page.getByTestId("close-protection-dialog")).toHaveCount(0);

  await page.getByTestId("file-new").click();
  await expect(page.getByTestId("welcome-view")).toBeVisible();
  await expect(page.getByTestId("close-protection-dialog")).toHaveCount(0);

  await app.evaluate(({ dialog }, selectedPath) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [selectedPath],
    });
  }, alphaPath);
  await page.getByTestId("file-open").click();
  await expect(page.getByTestId("document-name")).toHaveText(basename(alphaPath));
  await expect(page.getByTestId("document-dirty-status")).toHaveText("已保存");
  await page.getByTestId("file-new").click();
  await expect(page.getByTestId("welcome-view")).toBeVisible();

  await openRecent(alphaPath);
  await expect(page.getByTestId("document-name")).toHaveText(basename(alphaPath));
  await expect(page.getByTestId("document-dirty-status")).toHaveText("已保存");
});

test("dirty replacement supports cancel, save, and discard", async () => {
  await page.getByTestId("mode-source").click();
  await page.getByTestId("source-editor-content").fill("# Local edit\n");
  await expect(page.getByTestId("document-dirty-status")).toHaveText("未保存");

  await page.getByTestId("file-new").click();
  await expect(page.getByTestId("close-protection-dialog")).toBeVisible();
  await expect(page.getByTestId("app-shell")).toHaveAttribute("aria-busy", "true");
  await expect(page.getByTestId("app-shell")).toHaveAttribute("inert", "");
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("close-protection-discard")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByTestId("close-protection-save")).toBeFocused();
  await page.getByTestId("close-protection-cancel").click();
  await expect(page.getByTestId("close-protection-dialog")).toHaveCount(0);
  await expect(page.getByTestId("source-editor-content")).toContainText(
    "# Local edit",
  );

  await page.getByTestId("file-new").click();
  await page.getByTestId("close-protection-save").click();
  await expect(page.getByTestId("welcome-view")).toBeVisible();
  await expect(await readFile(alphaPath, "utf8")).toBe("# Local edit\n");

  await openRecent(alphaPath);
  await page.getByTestId("mode-source").click();
  await page.getByTestId("source-editor-content").fill("# Discarded edit\n");
  await page.getByTestId("file-new").click();
  await page.getByTestId("close-protection-discard").click();
  await expect(page.getByTestId("welcome-view")).toBeVisible();
  await expect(await readFile(alphaPath, "utf8")).toBe("# Local edit\n");
});

test("an opening document stays inert and a concurrent edit blocks replacement", async () => {
  await openRecent(alphaPath);
  await page.getByTestId("mode-wysiwyg").click();
  // 上一个用例已把 alpha 保存为 “# Local edit”；解析为 h1 标题后
  // WYSIWYG 视图渲染标题文本本身。
  await expect(
    page.getByTestId("wysiwyg-editor-content").locator("h1"),
  ).toHaveText("Local edit");
  await expect(page.getByTestId("app-shell")).toHaveAttribute(
    "aria-busy",
    "false",
  );

  // 打开流程的可见窗口只有几十毫秒；跨进程 evaluate 往返派发编辑事件
  // 可能错过，因此在页面内用 MutationObserver 在 aria-busy 变为 true 的
  // 同一帧同步派发，确保并发编辑可靠地打断打开。
  await page.evaluate(() => {
    const shell = document.querySelector('[data-testid="app-shell"]');
    if (!shell) throw new Error("app shell not found");
    const observer = new MutationObserver(() => {
      if (shell.getAttribute("aria-busy") === "true") {
        observer.disconnect();
        window.dispatchEvent(new CustomEvent("markdesk:document-edited"));
      }
    });
    observer.observe(shell, {
      attributes: true,
      attributeFilter: ["aria-busy"],
    });
  });
  await app.evaluate(
    ({ BrowserWindow }, recent) => {
      BrowserWindow.getFocusedWindow()?.webContents.send(
        recent.channel,
        { path: recent.path },
      );
    },
    { path: betaPath, channel: markdeskChannels.openRecentFile },
  );
  await expect(page.getByTestId("app-shell")).toHaveAttribute(
    "aria-busy",
    "true",
  );
  await expect(page.getByTestId("app-shell")).toHaveAttribute(
    "aria-live",
    "polite",
  );
  await expect(page.getByTestId("app-shell")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(page.getByTestId("file-error")).toHaveAttribute(
    "data-error-code",
    "file-changed",
  );
  await expect(page.getByTestId("document-name")).toHaveText(
    basename(alphaPath),
  );
  // 上一个用例已把 alpha 保存为 “# Local edit”；解析为 h1 标题后
  // WYSIWYG 视图渲染标题文本本身。
  await expect(
    page.getByTestId("wysiwyg-editor-content").locator("h1"),
  ).toHaveText("Local edit");
  await expect(page.getByTestId("wysiwyg-editor-content")).not.toContainText(
    "Beta end",
  );
});

test("intercepted window close honors cancel then save", async () => {
  // 前序用例结束时文档仍处于打开状态；先回到欢迎页再打开最近文件。
  if ((await page.getByTestId("welcome-view").count()) === 0) {
    await page.getByTestId("file-new").click();
    await expect(page.getByTestId("welcome-view")).toBeVisible();
  }
  await openRecent(alphaPath);
  await page.getByTestId("mode-source").click();
  await page.getByTestId("source-editor-content").fill("# Close me\n");

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.close());
  await expect(page.getByTestId("close-protection-dialog")).toBeVisible();
  await page.getByTestId("close-protection-cancel").click();
  await expect(page.getByTestId("close-protection-dialog")).toHaveCount(0);
  await expect(page.getByTestId("source-editor-content")).toContainText(
    "# Close me",
  );

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.close());
  await expect(page.getByTestId("close-protection-dialog")).toBeVisible();
  await page.getByTestId("close-protection-save").click();
  await page.waitForEvent("close", { timeout: 10_000 });
  await expect(await readFile(alphaPath, "utf8")).toBe("# Close me\n");
});
