import { mkdir, readFile, writeFile } from "node:fs/promises";
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

async function launch(): Promise<void> {
  app = await electron.launch({
    args: [join(__dirname, "../..")],
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
  await launch();
  const userData = await app.evaluate(({ app: electronApp }) =>
    electronApp.getPath("userData")
  );
  await app.close();

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
  await launch();
});

test.afterAll(async () => {
  if (app) await app.close();
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
  await expect(page.getByTestId("document-name")).toHaveText("alpha.md");
  await expect(page.getByTestId("document-dirty-status")).toHaveText("已保存");
  await page.getByTestId("file-new").click();
  await expect(page.getByTestId("welcome-view")).toBeVisible();

  await openRecent(alphaPath);
  await expect(page.getByTestId("document-name")).toHaveText("alpha.md");
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
  await expect(page.getByTestId("wysiwyg-editor-content")).toContainText(
    "# Alpha",
  );
  await expect(page.getByTestId("app-shell")).toHaveAttribute(
    "aria-busy",
    "false",
  );

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
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("markdesk:document-edited"));
  });
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
  await expect(page.getByTestId("wysiwyg-editor-content")).toContainText(
    "# Alpha",
  );
  await expect(page.getByTestId("wysiwyg-editor-content")).not.toContainText(
    "Beta end",
  );
});

test("intercepted window close honors cancel then save", async () => {
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
