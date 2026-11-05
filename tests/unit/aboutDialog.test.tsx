// @vitest-environment jsdom
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AboutDialog } from "../../src/main/components/AboutDialog";
import type {
  LatestReleaseInfo,
  MarkDeskRendererApi,
  UpdateProgressEvent,
} from "../../src/shared/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

type ProgressListener = (event: UpdateProgressEvent) => void;

function createApi(overrides?: {
  release?: LatestReleaseInfo;
  outcome?: "installer-launched" | "self-replaced" | "opened";
}): { api: MarkDeskRendererApi; progress: { listener: ProgressListener | null } } {
  const progress = { listener: null as ProgressListener | null };
  const api = {
    getBuildInfo: vi.fn(async () => ({
      version: "0.5.1",
      commit: "abc1234",
      date: "2026-11-05",
      dependencies: [
        { name: "Tauri", version: "2.9.3" },
        { name: "notify", version: "8.2.0" },
      ],
    })),
    checkLatestRelease: vi.fn(async () =>
      overrides?.release ?? {
        currentVersion: "0.5.1",
        latestVersion: "0.5.1",
        updateAvailable: false,
        assetName: "MarkDesk_0.5.1_x64.exe",
        assetUrl: "https://example.test/MarkDesk_0.5.1_x64.exe",
        assetSize: 0,
        releaseUrl: "https://example.test/rel",
      },
    ),
    downloadUpdate: vi.fn(async () => overrides?.outcome ?? "installer-launched"),
    onUpdateProgress: vi.fn((listener: ProgressListener) => {
      progress.listener = listener;
      return () => {
        progress.listener = null;
      };
    }),
  };
  return { api: api as unknown as MarkDeskRendererApi, progress };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderDialog(api: MarkDeskRendererApi): void {
  act(() => {
    root.render(createElement(AboutDialog, { api, onClose: () => {} }));
  });
}

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

describe("AboutDialog", () => {
  it("renders build info and merges renderer dependencies", async () => {
    const { api } = createApi();
    renderDialog(api);

    expect(query("about-version")?.textContent).toBe("…");
    await act(async () => {});
    expect(query("about-version")?.textContent).toBe("v0.5.1");
    expect(query("about-commit")?.textContent).toBe("abc1234");
    expect(query("about-date")?.textContent).toBe("2026-11-05");

    const deps = query("about-deps")?.querySelectorAll("li") ?? [];
    const names = [...deps].map((row) => row.querySelector("span")?.textContent);
    expect(names).toContain("Tauri");
    expect(names).toContain("React");
  });

  it("reports up-to-date when the latest release matches", async () => {
    const { api } = createApi();
    renderDialog(api);
    await act(async () => {});

    await act(async () => {
      query("about-check-update")?.click();
    });
    expect(query("about-update-status")?.textContent).toContain(
      "已是最新版本（v0.5.1）",
    );
    expect(query("about-download")).toBeNull();
  });

  it("downloads the matched asset and shows progress, then outcome", async () => {
    const { api, progress } = createApi({
      release: {
        currentVersion: "0.5.1",
        latestVersion: "0.6.0",
        updateAvailable: true,
        assetName: "MarkDesk_0.6.0_x64.exe",
        assetUrl: "https://example.test/MarkDesk_0.6.0_x64.exe",
        assetSize: 2 * 1024 * 1024,
        releaseUrl: "https://example.test/rel",
      },
    });
    renderDialog(api);
    await act(async () => {});

    await act(async () => {
      query("about-check-update")?.click();
    });
    expect(query("about-update-available")?.textContent).toContain("v0.6.0");

    let finishDownload: (() => void) | null = null;
    const downloadGate = new Promise<void>((resolve) => {
      finishDownload = resolve;
    });
    (api.downloadUpdate as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        await downloadGate;
        return "installer-launched" as const;
      },
    );

    act(() => {
      query("about-download")?.click();
    });
    expect(query("about-progress")).not.toBeNull();

    act(() => {
      progress.listener?.({ downloaded: 1024 * 1024, total: 2 * 1024 * 1024 });
    });
    const bar = query("about-progress")?.querySelector("progress");
    expect(bar?.getAttribute("value")).toBe(String(1024 * 1024));
    expect(query("about-progress")?.textContent).toContain("1.0 MB / 2.0 MB");

    await act(async () => {
      finishDownload?.();
    });
    expect(api.downloadUpdate).toHaveBeenCalledWith(
      "https://example.test/MarkDesk_0.6.0_x64.exe",
      "MarkDesk_0.6.0_x64.exe",
    );
    expect(query("about-update-status")?.textContent).toContain(
      "安装向导已启动",
    );
  });

  it("surfaces check failures inline", async () => {
    const { api } = createApi();
    (api.checkLatestRelease as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("update-network\n无法访问 GitHub，请检查网络。"),
    );
    renderDialog(api);
    await act(async () => {});

    await act(async () => {
      query("about-check-update")?.click();
    });
    expect(query("about-error")?.textContent).toContain("无法访问 GitHub");
  });
});
