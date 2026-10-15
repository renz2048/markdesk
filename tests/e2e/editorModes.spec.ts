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

test.beforeAll(async () => {
  app = await electron.launch({
    args: [join(__dirname, "../..")],
    env: { ...process.env, VITE_DEV_SERVER_URL: "" },
  });
  page = await app.firstWindow();
  await page.getByTestId("app-shell").waitFor();
});

test.afterAll(async () => {
  await app.close();
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
  await expect(firstReadView.locator("h1")).toHaveText("Identitycallback");

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
