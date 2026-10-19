import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _electron as electron,
  expect,
  test,
} from "@playwright/test";

type ElectronApplication = Awaited<ReturnType<typeof electron.launch>>;
type Page = Awaited<ReturnType<ElectronApplication["firstWindow"]>>;
let app: ElectronApplication;
let page: Page;

/**
 * 优雅关闭应用；若文档处于脏状态，关闭保护会拦截窗口关闭并使
 * app.close() 挂起，此时退回到 SIGKILL（测试环境的编辑内容可丢弃）。
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

test.beforeAll(async () => {
  // 每次运行使用独立的用户数据目录，避免残留的最近文件/恢复草稿
  // （尤其 SIGKILL 结束的脏文档会话）影响后续测试。
  const userData = await mkdtemp(join(tmpdir(), "markdesk-editor-modes-"));
  app = await electron.launch({
    args: [
      join(__dirname, "../.."),
      `--user-data-dir=${userData}`,
      // WSL/CI 等无硬件 GPU 环境下禁用 GPU 进程，避免其崩溃级联拖垮
      // network/zygote 服务；不影响任何安全配置。
      "--disable-gpu",
    ],
    env: { ...process.env, VITE_DEV_SERVER_URL: "" },
  });
  page = await app.firstWindow();
  await page.getByTestId("app-shell").waitFor();
});

test.afterAll(async () => {
  await closeMarkDesk(app);
});

test("source and read modes preserve identity, remount sessions, and render safely", async () => {
  await page.getByTestId("mode-source").click();
  const sourceContent = page.getByTestId("source-editor-content");
  await sourceContent.click();
  await page.keyboard.type("# Identity\n");

  const firstContent = await sourceContent.elementHandle();
  await page.keyboard.type("callback");
  const sameContent = await sourceContent.elementHandle();
  const identity = await page.evaluate(
    ([first, current]) => first === current,
    [firstContent, sameContent],
  );
  expect(identity).toBe(true);
  expect(await sourceContent.textContent()).toBe("# Identitycallback");

  await page.getByTestId("mode-read").click();
  const firstReadView = page.getByTestId("read-view");
  // 输入中的 "\n" 是回车：标题行到换行即止，"callback" 是下一段落。
  await expect(firstReadView.locator("h1")).toHaveText("Identity");
  await expect(firstReadView.locator("p").first()).toHaveText("callback");

  await page.getByTestId("mode-source").click();
  const remountedContent = await sourceContent.elementHandle();
  const remounted = await page.evaluate(
    ([first, current]) => first !== current,
    [firstContent, remountedContent],
  );
  expect(remounted).toBe(true);
  expect(await sourceContent.textContent()).toBe("# Identitycallback");

  await sourceContent.fill(
    [
      "| Name | Value |",
      "| --- | --- |",
      "| alpha | 1 |",
      "",
      "<!-- protected raw -->",
      "",
      "<script>alert(1)</script>",
      "",
      "[safe](https://example.com) [unsafe](foo:bar)",
      "",
      "![safe](data:image/png;base64,aGVsbG8=) ![unsafe](foo:bar)",
      "",
    ].join("\n"),
  );
  await page.getByTestId("mode-read").click();
  const readView = page.getByTestId("read-view");
  await expect(readView.locator("table th").first()).toHaveText("Name");
  await expect(
    readView.locator('pre[data-markdesk-raw="true"]'),
  ).toHaveCount(2);
  await expect(readView.locator("script")).toHaveCount(0);
  await expect(readView.locator('pre[data-markdesk-raw="true"]').first()).toHaveText(
    "protected raw",
  );
  await expect(readView.locator('pre[data-markdesk-raw="true"]').nth(1)).toHaveText(
    "<script>alert(1)</script>",
  );
  await expect(readView.locator("a[href]")).toHaveCount(1);
  await expect(readView.locator("a[href]")).toHaveAttribute(
    "href",
    "https://example.com",
  );
  await expect(readView.locator("a[href]")).toHaveAttribute(
    "target",
    "_blank",
  );
  await expect(readView.locator("a[href]")).toHaveAttribute(
    "rel",
    "noopener noreferrer",
  );
  await expect(readView.locator("img[src]")).toHaveCount(1);
  await expect(readView.locator("img:not([src])")).toHaveCount(1);
});

test("system theme follows emulated color scheme and manual selections update tokens", async () => {
  const root = page.locator("html");
  await page.getByTestId("theme-select").selectOption("system");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect(root).toHaveAttribute("data-theme-preference", "system");
  expect(
    await root.evaluate((element) => element.classList.contains("theme-dark")),
  ).toBe(true);

  await page.emulateMedia({ colorScheme: "light" });
  await expect(root).toHaveAttribute("data-theme", "light");

  await page.getByTestId("theme-select").selectOption("dark");
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect(root).toHaveAttribute("data-theme-preference", "dark");
  expect(
    await root.evaluate((element) => element.classList.contains("theme-dark")),
  ).toBe(true);
});
