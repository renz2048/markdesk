import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  contentSecurityPolicy,
  preventInAppNavigation,
  secureWebPreferences,
  shouldOpenExternalUrl,
} from "../../src/electron/security";

describe("Electron security configuration", () => {
  beforeEach(() => {
    vi.stubGlobal("__dirname", "/dist-electron");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses a locked-down web preference set", () => {
    expect(secureWebPreferences()).toEqual({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      preload: expect.any(String),
    });
  });

  it("sets a restrictive CSP", () => {
    const policy = contentSecurityPolicy();
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).not.toContain("unsafe-eval");
  });

  it("keeps the index.html meta CSP in sync with the code policy", async () => {
    // 生产构建经 file:// 加载时 onHeadersReceived 不生效，index.html 的
    // meta CSP 才是实际生效的那份；少了 markdesk-resource: 会让文档相对
    // 图片全部被 CSP 拦截（渲染成裂图）。
    const html = await readFile(
      join(__dirname, "../../index.html"),
      "utf8",
    );
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/u
      .exec(html)?.[1];
    expect(meta).toBe(contentSecurityPolicy());
  });

  it("allows only HTTP(S) URLs to leave through the external-window boundary", () => {
    expect(shouldOpenExternalUrl("https://example.com")).toBe(true);
    expect(shouldOpenExternalUrl("http://example.com/docs")).toBe(true);
    for (const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "markdesk-resource:image.png",
      "relative.md",
      "//example.com",
      "https://",
      "https://example.com/\u0000",
      "https://example.com\\path",
    ]) {
      expect(shouldOpenExternalUrl(url)).toBe(false);
    }
  });

  it("prevents in-window navigation events", () => {
    const event = { preventDefault: vi.fn() };
    preventInAppNavigation(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });
});
