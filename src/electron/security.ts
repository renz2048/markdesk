import { join } from "node:path";

export function secureWebPreferences(): Electron.WebPreferences {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    // 内置拼写检查仅含 en-US 词典，中文内容会被整片标红；关闭该服务。
    spellcheck: false,
    preload: join(__dirname, "preload.js"),
  };
}

export function contentSecurityPolicy(): string {
  // ipc:/http://ipc.localhost（Tauri IPC）与
  // http://markdesk-resource.localhost（Tauri 自定义协议的 http 形式）
  // 一并列入白名单：Electron 下这些来源不存在，无副作用；两套构建
  // 共享同一份 index.html meta（见 tests/unit/security.test.ts 的同步断言）。
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' markdesk-resource: http://markdesk-resource.localhost https: http: data:",
    "font-src 'self' data:",
    "connect-src 'self' ipc: http://ipc.localhost http://markdesk-resource.localhost",
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
