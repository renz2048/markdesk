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
