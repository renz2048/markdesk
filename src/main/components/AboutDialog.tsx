// “关于”对话框：软件名称、版本/提交/构建日期、依赖组件版本，
// 以及在线更新（GitHub Release 按平台/架构匹配安装包）。
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import pkg from "../../../package.json";
import type {
  BuildInfo,
  DependencyVersion,
  LatestReleaseInfo,
  MarkDeskRendererApi,
  UpdateOutcome,
} from "../../shared/types";

/** 前端关键依赖（package.json 版本号，构建时静态内联）。 */
const rendererDeps: DependencyVersion[] = [
  { name: "React", version: pkg.dependencies.react },
  { name: "CodeMirror", version: pkg.dependencies.codemirror },
  { name: "ProseMirror", version: pkg.dependencies["prosemirror-model"] },
  { name: "markdown-it", version: pkg.dependencies["markdown-it"] },
  { name: "DOMPurify", version: pkg.dependencies.dompurify },
];

type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date"; version: string }
  | { kind: "available"; info: LatestReleaseInfo }
  | {
      kind: "downloading";
      info: LatestReleaseInfo;
      downloaded: number;
      total: number;
    }
  | { kind: "done"; outcome: UpdateOutcome }
  | { kind: "error"; message: string };

/** 从适配层错误（“code\n消息” 格式）还原用户可读文本。 */
function errorText(error: unknown): string {
  if (error instanceof Error) {
    const newline = error.message.indexOf("\n");
    const rest =
      newline > 0 ? error.message.slice(newline + 1) : error.message;
    return rest || error.message;
  }
  return String(error);
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

function outcomeMessage(outcome: UpdateOutcome): string {
  if (outcome === "installer-launched") {
    return "安装向导已启动，MarkDesk 即将退出，请按提示完成安装。";
  }
  if (outcome === "self-replaced") {
    return "已完成更新，MarkDesk 即将以新版本重启。";
  }
  return "安装包已打开，请按系统提示完成安装。";
}

export function AboutDialog({
  api,
  onClose,
}: {
  api: MarkDeskRendererApi;
  onClose: () => void;
}): ReactNode {
  const [info, setInfo] = useState<BuildInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<UpdateState>({ kind: "idle" });
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!api.getBuildInfo) return;
    void api
      .getBuildInfo()
      .then((value) => {
        if (!cancelled) setInfo(value);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(errorText(error));
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  // 下载进度事件（订阅一次，仅在下载态消费）。
  useEffect(() => {
    if (!api.onUpdateProgress) return;
    return api.onUpdateProgress((event) => {
      setUpdateState((previous) =>
        previous.kind === "downloading"
          ? { ...previous, downloaded: event.downloaded, total: event.total }
          : previous,
      );
    });
  }, [api]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = dialog.querySelector<HTMLButtonElement>(
      "button:not([disabled])",
    );
    (focusable ?? dialog).focus();

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = [
        ...dialog.querySelectorAll<HTMLElement>(
          "button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
        ),
      ].filter((element) => element.offsetParent !== null);
      if (controls.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || active === dialog)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [onClose]);

  const checkForUpdate = useCallback(async (): Promise<void> => {
    if (!api.checkLatestRelease) return;
    setUpdateState({ kind: "checking" });
    try {
      const release = await api.checkLatestRelease();
      if (release.updateAvailable) {
        setUpdateState({ kind: "available", info: release });
      } else {
        setUpdateState({ kind: "up-to-date", version: release.latestVersion });
      }
    } catch (error) {
      setUpdateState({ kind: "error", message: errorText(error) });
    }
  }, [api]);

  const startDownload = useCallback(async (): Promise<void> => {
    if (!api.downloadUpdate || updateState.kind !== "available") return;
    const { info: release } = updateState;
    setUpdateState({
      kind: "downloading",
      info: release,
      downloaded: 0,
      total: release.assetSize,
    });
    try {
      const outcome = await api.downloadUpdate(
        release.assetUrl,
        release.assetName,
      );
      setUpdateState({ kind: "done", outcome });
    } catch (error) {
      setUpdateState({ kind: "error", message: errorText(error) });
    }
  }, [api, updateState]);

  const dependencies: DependencyVersion[] = info
    ? [...info.dependencies, ...rendererDeps]
    : rendererDeps;

  return (
    <div className="dialog-backdrop" data-testid="about-backdrop">
      <div
        ref={dialogRef}
        className="about-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        data-testid="about-dialog"
        tabIndex={-1}
      >
        <h2 id="about-title" className="about-name">
          MarkDesk
        </h2>
        <p className="about-tagline">安全的单文件 Markdown 阅读器与编辑器</p>

        {loadError !== null ? (
          <p className="about-error" role="alert" data-testid="about-load-error">
            {loadError}
          </p>
        ) : null}
        <dl className="about-meta" data-testid="about-meta">
          <div className="about-meta-row">
            <dt>版本</dt>
            <dd data-testid="about-version">
              {info ? `v${info.version}` : "…"}
            </dd>
          </div>
          <div className="about-meta-row">
            <dt>Commit</dt>
            <dd data-testid="about-commit">{info ? info.commit : "…"}</dd>
          </div>
          <div className="about-meta-row">
            <dt>日期</dt>
            <dd data-testid="about-date">{info ? info.date : "…"}</dd>
          </div>
        </dl>

        <section
          className="about-deps"
          aria-labelledby="about-deps-title"
          data-testid="about-deps"
        >
          <h3 id="about-deps-title">组件版本</h3>
          <ul>
            {dependencies.map((dependency) => (
              <li key={dependency.name}>
                <span>{dependency.name}</span>
                <span>{dependency.version}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="about-update" data-testid="about-update">
          {updateState.kind === "idle" ? (
            <button
              type="button"
              className="primary-dialog-button"
              data-testid="about-check-update"
              disabled={!api.checkLatestRelease}
              onClick={() => void checkForUpdate()}
            >
              获取最新版本
            </button>
          ) : null}
          {updateState.kind === "checking" ? (
            <p data-testid="about-update-status">正在检查更新…</p>
          ) : null}
          {updateState.kind === "up-to-date" ? (
            <p data-testid="about-update-status">
              已是最新版本（v{updateState.version}）。
            </p>
          ) : null}
          {updateState.kind === "available" ? (
            <div
              className="about-update-available"
              data-testid="about-update-available"
            >
              <p data-testid="about-update-status">
                发现新版本 v{updateState.info.latestVersion}
                {updateState.info.assetSize > 0
                  ? `（${formatBytes(updateState.info.assetSize)}）`
                  : ""}
                ，当前 v{updateState.info.currentVersion}。
              </p>
              <button
                type="button"
                className="primary-dialog-button"
                data-testid="about-download"
                onClick={() => void startDownload()}
              >
                下载并安装
              </button>
            </div>
          ) : null}
          {updateState.kind === "downloading" ? (
            <div
              className="about-progress"
              data-testid="about-progress"
              role="status"
            >
              <p>正在下载 v{updateState.info.latestVersion}…</p>
              <progress
                max={updateState.total || undefined}
                value={updateState.downloaded || undefined}
              />
              <p className="about-progress-detail">
                {formatBytes(updateState.downloaded)}
                {updateState.total > 0
                  ? ` / ${formatBytes(updateState.total)}`
                  : ""}
              </p>
            </div>
          ) : null}
          {updateState.kind === "done" ? (
            <p data-testid="about-update-status" role="status">
              {outcomeMessage(updateState.outcome)}
            </p>
          ) : null}
          {updateState.kind === "error" ? (
            <p className="about-error" role="alert" data-testid="about-error">
              {updateState.message}
            </p>
          ) : null}
        </section>

        <div className="dialog-actions">
          <button
            type="button"
            data-testid="about-close"
            onClick={onClose}
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
