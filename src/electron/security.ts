import { join } from "node:path";

export function secureWebPreferences(): Electron.WebPreferences {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    preload: join(__dirname, "preload.js"),
  };
}

export function contentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' markdesk-resource: https: http: data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function shouldOpenExternalUrl(url: string): boolean {
  if (/[\u0000-\u001f\u007f-\u009f]/.test(url) || url.includes("\\")) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      Boolean(parsed.hostname)
    );
  } catch {
    return false;
  }
}

export function preventInAppNavigation(event: {
  preventDefault(): void;
}): void {
  event.preventDefault();
}
