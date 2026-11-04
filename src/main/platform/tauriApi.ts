// Tauri 版平台 API：实现与 Electron preload 相同的 MarkDeskRendererApi
// 接口（invoke 命令 + 事件桥接），App 层无感切换。错误还原为
// MarkDeskIpcError（code 占 message 首行），与 Electron 版错误解码兼容。
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type {
  FileFingerprint,
  FileReadResult,
  FileWriteResult,
  MarkDeskRendererApi,
  MenuCommand,
  PandocExportTargetName,
  PickedImageAsset,
  RecentFileStatus,
  RecoveryDraft,
  RecoveryDraftInput,
  RecoveryDraftSummary,
  ThemePreferenceSetting,
} from "../../shared/types";

/** Tauri 拖放事件载荷（文件在 WebView 中拿不到 File 对象，只有路径+坐标）。 */
interface NativeDropPayload {
  paths: string[];
  position: { x: number; y: number };
}

type NativeDropListener = (payload: NativeDropPayload) => void;

function toIpcError(raw: unknown): Error {
  let code = "unexpected-error";
  let message = "操作失败，请稍后重试。";
  if (typeof raw === "object" && raw !== null && "code" in raw) {
    const candidate = raw as { code?: unknown; message?: unknown };
    if (typeof candidate.code === "string") code = candidate.code;
    if (typeof candidate.message === "string") message = candidate.message;
  } else if (typeof raw === "string" && raw.length > 0) {
    message = raw;
  }
  const error = new Error(`${code}\n${message}`);
  error.name = "MarkDeskIpcError";
  return error;
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return (await invoke<T>(command, args)) as T;
  } catch (raw) {
    throw toIpcError(raw);
  }
}

export function createTauriApi(): MarkDeskRendererApi {
  return {
    chooseMarkdownFile: () => call<string | null>("choose_markdown_file"),
    chooseSaveLocation: (defaultName) =>
      call<string | null>("choose_save_location", { defaultName }),
    readFile: (path: string): Promise<FileReadResult> =>
      call("read_file", { path }),
    writeFile: (path, content, expected?: FileFingerprint) =>
      call<FileWriteResult>("write_file", { path, content, expected }),
    savePastedImage: async (docPath, fileName, data) => {
      const bytes = Array.from(new Uint8Array(data));
      const relativeSrc = await call<string>("save_pasted_image", {
        docPath,
        fileName,
        bytes,
      });
      return { relativeSrc };
    },
    pickImageAsset: async (): Promise<PickedImageAsset | null> => {
      // Rust 端返回「首行文件名 + 原始字节」的原始负载；空负载表示取消。
      const payload = await call<ArrayBuffer | number[]>("pick_image_asset");
      const bytes =
        payload instanceof ArrayBuffer
          ? new Uint8Array(payload)
          : new Uint8Array(payload ?? []);
      if (bytes.length === 0) return null;
      const separator = bytes.indexOf(0x0a);
      const name = new TextDecoder().decode(bytes.slice(0, separator)).trim();
      return { name, bytes: bytes.slice(separator + 1).buffer };
    },
    exportRenderedDocument: (format, html, defaultName, assetsDir) =>
      call<string | null>("export_rendered", {
        format,
        html,
        defaultName,
        assetsDir,
      }),
    setThemePreference: (theme: ThemePreferenceSetting) =>
      call<void>("set_theme_preference", { theme }),
    exportViaPandoc: (target: PandocExportTargetName, markdown, defaultName, docDir) =>
      call<string | null>("export_pandoc", {
        target,
        markdown,
        defaultName,
        docDir,
      }),
    insertDroppedImage: async (docPath, imagePath) => {
      // Rust 命令返回纯字符串（相对或绝对路径），包装回 { src } 契约；
      // 此前直接解构会把 undefined 传给 ProseMirror 的必需属性 src。
      const src = await call<string>("insert_dropped_image", {
        docPath,
        imagePath,
      });
      return { src };
    },
    checkImageGrants: (srcs: string[]) =>
      call<string[]>("check_image_grants", { srcs }),
    grantImagePaths: (srcs: string[]) =>
      call<string[]>("grant_image_paths", { srcs }),
    getRecentFiles: () => call<RecentFileStatus[]>("get_recent_files"),
    readRecentFile: (path: string) =>
      call<FileReadResult>("read_recent_file", { path }),
    clearRecentFiles: () => call<void>("clear_recent_files"),
    saveRecoveryDraft: (draft: RecoveryDraftInput) =>
      call<string>("save_recovery_draft", { draft }),
    listRecoveryDrafts: () =>
      call<RecoveryDraftSummary[]>("list_recovery_drafts"),
    readRecoveryDraft: (key: string) =>
      call<RecoveryDraft | null>("read_recovery_draft", { key }),
    discardRecoveryDraft: (key: string) =>
      call<void>("discard_recovery_draft", { key }),
    chooseExportLocation: (defaultName: string) =>
      call<string | null>("choose_export_location", { defaultName }),
    exportHtml: (path: string, html: string) =>
      call<void>("export_html", { path, html }),
    onMenuCommand: (listener: (command: MenuCommand) => void) => {
      let dispose: UnlistenFn | null = null;
      let active = true;
      void listen<{ command: MenuCommand }>("menu-command", (event) => {
        listener(event.payload.command);
      }).then((unlisten) => {
        if (active) dispose = unlisten;
        else unlisten();
      });
      return () => {
        active = false;
        dispose?.();
      };
    },
    onFileChanged: (listener) => {
      let dispose: UnlistenFn | null = null;
      let active = true;
      void listen<{ path: string }>("file-changed", (event) => {
        listener({ path: event.payload.path });
      }).then((unlisten) => {
        if (active) dispose = unlisten;
        else unlisten();
      });
      return () => {
        active = false;
        dispose?.();
      };
    },
    onOpenRecentFile: (listener) => {
      let dispose: UnlistenFn | null = null;
      let active = true;
      void listen<{ path: string }>("open-recent-file", (event) => {
        listener({ path: event.payload.path });
      }).then((unlisten) => {
        if (active) dispose = unlisten;
        else unlisten();
      });
      return () => {
        active = false;
        dispose?.();
      };
    },
    onRecentFilesChanged: (listener) => {
      let dispose: UnlistenFn | null = null;
      let active = true;
      void listen<RecentFileStatus[]>("recent-files-changed", (event) => {
        listener(event.payload);
      }).then((unlisten) => {
        if (active) dispose = unlisten;
        else unlisten();
      });
      return () => {
        active = false;
        dispose?.();
      };
    },
    onCloseRequested: (listener) => {
      let dispose: UnlistenFn | null = null;
      let active = true;
      void listen("close-requested", () => {
        listener();
      }).then((unlisten) => {
        if (active) dispose = unlisten;
        else unlisten();
      });
      return () => {
        active = false;
        dispose?.();
      };
    },
    requestClose: () => call<void>("request_close"),
    cancelClose: () => call<void>("cancel_close"),
    getStartupOpenPath: () => call<string | null>("take_argv_open_path"),
    setWindowTitle: (title: string) =>
      call<void>("set_window_title", { title }),
    onNativeDropPaths: (listener: NativeDropListener) => {
      let dispose: UnlistenFn | null = null;
      let active = true;
      void getCurrentWebviewWindow()
        .onDragDropEvent((event) => {
          if (event.payload.type === "drop") {
            listener({
              paths: event.payload.paths,
              position: {
                x: event.payload.position.x,
                y: event.payload.position.y,
              },
            });
          }
        })
        .then((unlisten) => {
          if (active) dispose = unlisten;
          else unlisten();
        });
      return () => {
        active = false;
        dispose?.();
      };
    },
  };
}
