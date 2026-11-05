const controlCharacterPattern = /[\u0000-\u001f\u007f-\u009f]/;
const schemePattern = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const dataImagePattern = /^data:image\/[a-z0-9.+-]+(;[a-z0-9!#$&^_.~()%+=:-]*)?,/i;
const protocolRelativePattern = /^\/\//;

interface PreparedUrl {
  value: string;
  scheme: string | null;
}

function prepareUrl(raw: string, description: string): PreparedUrl {
  const value = raw.trim();
  if (
    !value ||
    controlCharacterPattern.test(raw) ||
    value.includes("\\") ||
    protocolRelativePattern.test(value)
  ) {
    throw new Error(`Unsafe or malformed ${description} URL`);
  }

  const schemeMatch = schemePattern.exec(value);
  return { value, scheme: schemeMatch?.[1]?.toLowerCase() ?? null };
}

function parseAbsoluteUrl(value: string, description: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`Unsafe or malformed ${description} URL`);
  }
}

function parseRelativeUrl(value: string, description: string): URL {
  try {
    return new URL(value, "https://markdesk.invalid/");
  } catch {
    throw new Error(`Unsafe or malformed ${description} URL`);
  }
}

export function normalizeLinkHref(href: string): string {
  const { value, scheme } = prepareUrl(href, "link");

  if (!scheme) {
    parseRelativeUrl(value, "link");
    return value.replace(/^\.\//, "");
  }

  if (!["http", "https", "mailto"].includes(scheme)) {
    throw new Error("Unsafe or malformed link URL");
  }

  const parsed = parseAbsoluteUrl(value, "link");
  if ((scheme === "http" || scheme === "https") && !parsed.hostname) {
    throw new Error("Unsafe or malformed link URL");
  }
  return parsed.href;
}

// 本地绝对路径形式的图片：Windows 盘符、UNC 与 POSIX 绝对路径
// （需求 4.5：拖入文档目录外的本地图片）。反斜杠不参与 URL 解析，
// 保留作者书写的形式；仅图片允许，链接仍走严格策略。
const absoluteImagePathPattern = /^(?:[a-zA-Z]:[\\/]|\\\\|\/[^\\/])/u;

export function normalizeImageSrc(src: string): string {
  const trimmed = src.trim();
  if (absoluteImagePathPattern.test(trimmed)) {
    if (controlCharacterPattern.test(trimmed) || trimmed.length > 1024) {
      throw new Error("Unsafe or malformed image URL");
    }
    return trimmed;
  }

  const { value, scheme } = prepareUrl(src, "image");

  if (!scheme) {
    parseRelativeUrl(value, "image");
    return value.replace(/^\.\//, "");
  }

  if (scheme === "data") {
    if (!dataImagePattern.test(value)) {
      throw new Error("Unsafe or malformed image URL");
    }
    parseAbsoluteUrl(value, "image");
    return value;
  }

  // markdesk-resource 协议的两种寻址形式（WebView2 的 http 形式与
  // WKWebView/WebKitGTK 的 scheme 形式）；路径逃逸一律拒绝。
  if (
    /^http:\/\/markdesk-resource\.localhost\//iu.test(value) ||
    /^markdesk-resource:\/\/localhost\//iu.test(value)
  ) {
    if (value.includes("/../") || value.endsWith("/..")) {
      throw new Error("Unsafe or malformed image URL");
    }
    parseAbsoluteUrl(value, "image");
    return value;
  }

  if (!["http", "https"].includes(scheme)) {
    throw new Error("Unsafe or malformed image URL");
  }

  const parsed = parseAbsoluteUrl(value, "image");
  if (!parsed.hostname) throw new Error("Unsafe or malformed image URL");
  return parsed.href;
}

export function safeLinkHref(href: string): string {
  try {
    normalizeLinkHref(href);
    // 解析边界只做验证并保留作者书写的形式（normalize 会经 URL API 规范化，
    // 例如自动补全结尾斜杠、编码空格），保证 Markdown 逐字往返。
    return href.trim();
  } catch {
    return "";
  }
}

export function safeImageSrc(src: string): string {
  try {
    normalizeImageSrc(src);
    return src.trim();
  } catch {
    return "";
  }
}

export function isExternalHttpUrl(url: string): boolean {
  try {
    const { value, scheme } = prepareUrl(url, "link");
    if (scheme !== "http" && scheme !== "https") return false;
    const parsed = parseAbsoluteUrl(value, "link");
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      Boolean(parsed.hostname)
    );
  } catch {
    return false;
  }
}
