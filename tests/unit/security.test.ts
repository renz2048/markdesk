import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, secureWebPreferences } from "../../src/electron/security";

describe("Electron security configuration", () => {
  it("uses a locked-down web preference set", () => {
    expect(secureWebPreferences()).toEqual({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: expect.any(String),
    });
  });

  it("sets a restrictive CSP", () => {
    const policy = contentSecurityPolicy();
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).not.toContain("unsafe-eval");
  });
});
