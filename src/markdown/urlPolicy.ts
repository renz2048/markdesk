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

export function normalizeImageSrc(src: string): string {
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

  if (scheme === "markdesk-resource") {
    if (value.startsWith("markdesk-resource:/")) {
      throw new Error("Unsafe or malformed image URL");
    }
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
    return normalizeLinkHref(href);
  } catch {
    return "";
  }
}

export function safeImageSrc(src: string): string {
  try {
    return normalizeImageSrc(src);
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
