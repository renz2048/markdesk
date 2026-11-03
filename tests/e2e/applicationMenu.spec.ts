import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { clickMenuItem, topLevelMenuLabels } from "./helpers/menu";

type ElectronApplication = Awaited<ReturnType<typeof electron.launch>>;
type Page = Awaited<ReturnType<ElectronApplication["firstWindow"]>>;
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  const userData = await mkdtemp(join(tmpdir(), "markdesk-app-menu-"));
  app = await electron.launch({
    args: [
      join(__dirname, "../.."),
      `--user-data-dir=${userData}`,
      "--disable-gpu",
    ],
    env: { ...process.env, VITE_DEV_SERVER_URL: "" },
  });
  page = await app.firstWindow();
  await page.getByTestId("app-shell").waitFor();
});

test.afterAll(async () => {
  const proc = app.process();
  const exited = new Promise<void>((resolve) => {
    proc.once("exit", () => resolve());
  });
  await Promise.race([
    app.close().catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (proc.exitCode === null && !proc.killed) proc.kill("SIGKILL");
  await exited;
});

test("原生菜单结构对齐 Typora：文件 编辑 段落 格式 模式 主题", async () => {
  expect(await topLevelMenuLabels(app)).toEqual([
    "文件",
    "编辑",
    "段落",
    "格式",
    "模式",
    "主题",
  ]);
});

test("段落菜单命令应用到所见即所得编辑器", async () => {
  await page.getByTestId("welcome-new").click();
  const editor = page.getByTestId("wysiwyg-editor-content");
  await editor.click();
  await page.keyboard.type("正文段落");

  // 段落 → 一级标题
  await clickMenuItem(app, "段落", "一级标题");
  await expect(editor.locator("h1")).toHaveText("正文段落");

  // 段落 → 降低标题级别：h1 → h2
  await clickMenuItem(app, "段落", "降低标题级别");
  await expect(editor.locator("h2")).toHaveText("正文段落");

  // 段落 → 段落（Ctrl+0）：标题切回普通段落（需求 5.3）
  await clickMenuItem(app, "段落", "段落");
  await expect(editor.locator("h2")).toHaveCount(0);
  await expect(editor.locator("p").first()).toHaveText("正文段落");

  // 回到标题态继续后续断言路径（再升为 h2 → 后续流程基于块结构）。
  await clickMenuItem(app, "段落", "二级标题");
  await expect(editor.locator("h2")).toHaveText("正文段落");

  // 段落 → 表格：插入 3×2 表格
  await page.keyboard.press("Enter");
  await clickMenuItem(app, "段落", "表格");
  await expect(editor.locator("table")).toHaveCount(1);
  await expect(editor.locator("tr")).toHaveCount(2);

  // 段落 → 任务列表：回到标题行尾回车出空段落，再转任务项
  await editor.locator("h2").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("任务项");
  await clickMenuItem(app, "段落", "任务列表");
  await expect(editor.locator("li")).toHaveCount(1);

  // 格式 → 加粗：对选中范围内的文本应用样式
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await clickMenuItem(app, "格式", "加粗");
  await expect(editor.locator("li strong")).toHaveText("任务项");

  // 格式 → 清除格式
  await clickMenuItem(app, "格式", "清除格式");
  await expect(editor.locator("li strong")).toHaveCount(0);
});

test("源码模式下格式与段落命令是安全空操作", async () => {
  await clickMenuItem(app, "模式", "源码模式");
  const source = page.getByTestId("source-editor-content");
  await source.click();
  const before = await source.textContent();

  await clickMenuItem(app, "段落", "二级标题");
  await clickMenuItem(app, "格式", "斜体");
  await page.waitForTimeout(200);

  expect(await source.textContent()).toBe(before);
  await clickMenuItem(app, "模式", "所见即所得模式");
});

test("主题菜单切换主题并更新菜单单选状态", async () => {
  await clickMenuItem(app, "主题", "深色");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const checked = await app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    const submenu = menu?.items.find((item) => item.label === "主题")
      ?.submenu;
    return submenu?.items.find((item) => item.checked)?.label ?? null;
  });
  expect(checked).toBe("深色");
  await clickMenuItem(app, "主题", "浅色");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});


test("底栏两个图标：切换侧栏显隐与源码模式", async () => {
  // 侧栏显隐（< 显示 / > 隐藏）
  await expect(page.getByTestId("outline")).toBeVisible();
  await page.getByTestId("toggle-sidebar").click();
  await expect(page.getByTestId("outline")).toHaveCount(0);
  await expect(page.getByTestId("toggle-sidebar")).toHaveText("<");
  await page.getByTestId("toggle-sidebar").click();
  await expect(page.getByTestId("outline")).toBeVisible();
  await expect(page.getByTestId("toggle-sidebar")).toHaveText(">");

  // 源码模式进出
  await page.getByTestId("toggle-source-mode").click();
  await expect(page.getByTestId("source-editor-content")).toBeVisible();
  await expect(page.getByTestId("toggle-source-mode")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByTestId("toggle-source-mode").click();
  await expect(page.getByTestId("wysiwyg-editor-content")).toBeVisible();
});

test("标题栏脏标记：未保存时文件名后加圆点", async () => {
  // 此前用例已在未命名文档中输入内容：标题带圆点。
  await expect(page).toHaveTitle("未命名● - MarkDesk");

  // 保存为具体文件后圆点消失，标题变为 `文件名 - MarkDesk`。
  const savedName = `markdesk-title-${Date.now()}.md`;
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p });
  }, join(tmpdir(), savedName));
  await clickMenuItem(app, "文件", "保存");
  await expect(page).toHaveTitle(`${savedName} - MarkDesk`);

  // 再次编辑 → 圆点回到新文件名后。
  await page.getByTestId("wysiwyg-editor-content").click();
  await page.keyboard.type("x");
  await expect(page).toHaveTitle(`${savedName}● - MarkDesk`);
});

test("侧栏直达窗口底部，底栏只占编辑列宽度", async () => {
  const outline = page.getByTestId("outline");
  const statusBar = page.getByTestId("status-bar");
  const outlineBox = await outline.boundingBox();
  const statusBarBox = await statusBar.boundingBox();
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  expect(outlineBox).not.toBeNull();
  expect(statusBarBox).not.toBeNull();
  if (!outlineBox || !statusBarBox) return;

  // 侧栏直达窗口底部；底栏左缘对齐编辑列（在侧栏右侧）。
  expect(outlineBox.y + outlineBox.height).toBeCloseTo(viewport.height, -1);
  expect(statusBarBox.x).toBeGreaterThan(outlineBox.x + outlineBox.width - 1);
});
