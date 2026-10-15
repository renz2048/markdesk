import { describe, expect, it } from "vitest";
import {
  isExternalHttpUrl,
  normalizeImageSrc,
  normalizeLinkHref,
} from "../../src/markdown/urlPolicy";

describe("shared Markdown URL policy", () => {
  it("accepts and normalizes safe links", () => {
    expect(normalizeLinkHref("./docs")).toBe("docs");
    expect(normalizeLinkHref("../references")).toBe("../references");
    expect(normalizeLinkHref("/absolute/path")).toBe("/absolute/path");
    expect(normalizeLinkHref("#section")).toBe("#section");
    expect(normalizeLinkHref("https://example.com/a")).toBe(
      "https://example.com/a",
    );
    expect(normalizeLinkHref("http://example.com")).toBe(
      "http://example.com/",
    );
    expect(normalizeLinkHref("mailto:user@example.com")).toBe(
      "mailto:user@example.com",
    );
  });

  it("rejects unsafe or malformed links", () => {
    for (const href of [
      "",
      " \t",
      "https://example.com/\u0000",
      "//example.com",
      "\\\\example.com",
      "\\path",
      "javascript:alert(1)",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "data:text/html;base64,PHNjcmlwdD4=",
      "markdesk-resource:image",
      "https://",
    ]) {
      expect(() => normalizeLinkHref(href)).toThrow(
        "Unsafe or malformed link URL",
      );
    }
  });

  it("accepts safe image sources", () => {
    expect(normalizeImageSrc("./images/a.png")).toBe("images/a.png");
    expect(normalizeImageSrc("/images/a.png")).toBe("/images/a.png");
    expect(normalizeImageSrc("https://example.com/a.png")).toBe(
      "https://example.com/a.png",
    );
    expect(normalizeImageSrc("http://example.com/a.png")).toBe(
      "http://example.com/a.png",
    );
    expect(
      normalizeImageSrc("data:image/png;base64,aGVsbG8="),
    ).toBe("data:image/png;base64,aGVsbG8=");
    expect(normalizeImageSrc("data:image/svg+xml,<svg></svg>")).toBe(
      "data:image/svg+xml,<svg></svg>",
    );
    expect(normalizeImageSrc("markdesk-resource:images/a.png")).toBe(
      "markdesk-resource:images/a.png",
    );
  });

  it("rejects unsafe or malformed image sources", () => {
    for (const src of [
      "",
      " ",
      "//example.com/a.png",
      "\\\\example.com/a.png",
      "images\u0007/a.png",
      "javascript:alert(1)",
      "vbscript:msgbox(1)",
      "file:///etc/passwd.png",
      "data:text/html,<script>alert(1)</script>",
      "markdesk-resource:/../outside.png",
      "https://",
    ]) {
      expect(() => normalizeImageSrc(src)).toThrow(
        "Unsafe or malformed image URL",
      );
    }
  });

  it("uses the same safety rules for external HTTP links", () => {
    expect(isExternalHttpUrl("https://example.com/docs")).toBe(true);
    expect(isExternalHttpUrl("http://example.com")).toBe(true);
    expect(isExternalHttpUrl("//example.com")).toBe(false);
    expect(isExternalHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isExternalHttpUrl("https://example.com/\u0000")).toBe(false);
  });
});
