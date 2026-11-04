export interface FileFingerprint {
  hash: string;
  mtimeMs: number;
  size: number;
}

export type NewlinePreference = "lf" | "crlf";

export interface FileReadResult extends FileFingerprint {
  path: string;
  content: string;
  newline: NewlinePreference;
}

export interface FileWriteResult extends FileFingerprint {
  path: string;
}

export interface RecentFile {
  path: string;
  name: string;
  lastOpenedAt: number;
}

export interface RecentFileStatus extends RecentFile {
  exists: boolean;
}

export type RecoveryDraftMode = "wysiwyg" | "source" | "read";

export interface RecoveryDraft {
  key: string;
  path: string | null;
  fileName: string;
  markdown: string;
  mode: RecoveryDraftMode;
  cursor: number;
  scrollTop: number;
  updatedAt: number;
}

export type RecoveryDraftInput = Omit<RecoveryDraft, "key" | "updatedAt">;

export interface RecoveryDraftSummary {
  key: string;
  path: string | null;
  fileName: string;
  updatedAt: number;
}

export type MenuCommand =
  | "new"
  | "new-window"
  | "open"
  | "save"
  | "save-as"
  | "close-window"
  | "export-html"
  | "export-pdf"
  | "export-image"
  | "export-docx"
  | "export-odt"
  | "export-epub"
  | "export-latex"
  | "export-mediawiki"
  | "toggle-source"
  | "toggle-read"
  | "toggle-wysiwyg"
  | "theme-light"
  | "theme-dark"
  | "theme-system"
  | "format-bold"
  | "format-italic"
  | "format-strikethrough"
  | "format-code"
  | "format-clear"
  | "format-image"
  | "paragraph-paragraph"
  | "paragraph-heading-1"
  | "paragraph-heading-2"
  | "paragraph-heading-3"
  | "paragraph-heading-4"
  | "paragraph-heading-5"
  | "paragraph-heading-6"
  | "paragraph-heading-promote"
  | "paragraph-heading-demote"
  | "paragraph-quote"
  | "paragraph-code-block"
  | "paragraph-bullet-list"
  | "paragraph-ordered-list"
  | "paragraph-task-list"
  | "paragraph-horizontal-rule"
  | "paragraph-table";

export interface FileChangedEvent {
  path: string;
}

export interface OpenRecentFileEvent {
  path: string;
}

export type IpcErrorCode =
  | "invalid-path"
  | "invalid-fingerprint"
  | "invalid-encoding"
  | "file-too-large"
  | "file-changed"
  | "read-failed"
  | "write-failed"
  | "invalid-argument"
  | "pandoc-missing"
  | "unexpected-error";

export interface TypedIpcError {
  code: IpcErrorCode;
  message: string;
}

export type IpcResult<TValue> =
  | { ok: true; value: TValue }
  | { ok: false; error: TypedIpcError };

export const markdeskChannels = {
  chooseMarkdownFile: "markdesk:choose-markdown-file",
  chooseSaveLocation: "markdesk:choose-save-location",
  readFile: "markdesk:read-file",
  writeFile: "markdesk:write-file",
  getRecentFiles: "markdesk:get-recent-files",
  readRecentFile: "markdesk:read-recent-file",
  clearRecentFiles: "markdesk:clear-recent-files",
  saveRecoveryDraft: "markdesk:save-recovery-draft",
  listRecoveryDrafts: "markdesk:list-recovery-drafts",
  readRecoveryDraft: "markdesk:read-recovery-draft",
  discardRecoveryDraft: "markdesk:discard-recovery-draft",
  chooseExportLocation: "markdesk:choose-export-location",
  exportHtml: "markdesk:export-html",
  recentFilesChanged: "markdesk:recent-files-changed",
  openRecentFile: "markdesk:open-recent-file",
  menuCommand: "markdesk:menu-command",
  fileChanged: "markdesk:file-changed",
  closeRequested: "markdesk:close-requested",
  requestClose: "markdesk:request-close",
  cancelClose: "markdesk:cancel-close",
  savePastedImage: "markdesk:save-pasted-image",
  pickImageAsset: "markdesk:pick-image-asset",
  exportRendered: "markdesk:export-rendered",
  exportPandoc: "markdesk:export-pandoc",
  insertDroppedImage: "markdesk:insert-dropped-image",
  setThemePreference: "markdesk:set-theme-preference",
  checkImageGrants: "markdesk:check-image-grants",
  grantImagePaths: "markdesk:grant-image-paths",
} as const;

/**
 * 允许显示的本地图片扩展名（与主进程资源协议的白名单保持一致；
 * 渲染端据此过滤需要授权询问的绝对路径引用）。
 */
export const localImageExtensions: ReadonlySet<string> = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "avif",
]);

export interface SavedImageAsset {
  relativeSrc: string;
}

/** 「格式 → 图像」选中的图片文件（字节交由渲染端走既有资产流程）。 */
export interface PickedImageAsset {
  name: string;
  bytes: ArrayBuffer;
}

export type ExportRenderFormat = "pdf" | "png";

export type ThemePreferenceSetting = "light" | "dark" | "system";

/** Pandoc 导出目标（Word / OpenOffice / Epub / LaTeX / MediaWiki）。 */
export type PandocExportTargetName =
  | "docx"
  | "odt"
  | "epub"
  | "latex"
  | "mediawiki";

export interface MarkDeskRendererApi {
  chooseMarkdownFile(): Promise<string | null>;
  chooseSaveLocation(defaultName: string): Promise<string | null>;
  readFile(path: string): Promise<FileReadResult>;
  savePastedImage(
    docPath: string,
    fileName: string,
    data: ArrayBuffer,
  ): Promise<SavedImageAsset>;
  pickImageAsset(): Promise<PickedImageAsset | null>;
  exportRenderedDocument(
    format: ExportRenderFormat,
    html: string,
    defaultName: string,
    assetsDir: string | null,
  ): Promise<string | null>;
  exportViaPandoc(
    target: PandocExportTargetName,
    markdown: string,
    defaultName: string,
    docDir: string | null,
  ): Promise<string | null>;
  insertDroppedImage(
    docPath: string,
    imagePath: string,
  ): Promise<{ src: string }>;
  /** 查询哪些本地绝对路径图片尚未获得显示授权（返回未授权子集）。 */
  checkImageGrants(srcs: string[]): Promise<string[]>;
  /** 用户同意后授权一组本地绝对路径图片显示，主进程持久化记忆。 */
  grantImagePaths(srcs: string[]): Promise<string[]>;
  /** 拖放文件的路径在 WebView 中不可得，改由 onNativeDropPaths 提供。 */
  setThemePreference(theme: ThemePreferenceSetting): Promise<void>;
  writeFile(
    path: string,
    content: string,
    expected?: FileFingerprint,
  ): Promise<FileWriteResult>;
  getRecentFiles(): Promise<RecentFileStatus[]>;
  readRecentFile(path: string): Promise<FileReadResult>;
  clearRecentFiles(): Promise<void>;
  saveRecoveryDraft(draft: RecoveryDraftInput): Promise<string>;
  listRecoveryDrafts(): Promise<RecoveryDraftSummary[]>;
  readRecoveryDraft(key: string): Promise<RecoveryDraft | null>;
  discardRecoveryDraft(key: string): Promise<void>;
  chooseExportLocation(defaultName: string): Promise<string | null>;
  exportHtml(path: string, html: string): Promise<void>;
  onMenuCommand(listener: (command: MenuCommand) => void): () => void;
  onFileChanged(listener: (event: FileChangedEvent) => void): () => void;
  onOpenRecentFile(
    listener: (event: OpenRecentFileEvent) => void,
  ): () => void;
  onRecentFilesChanged(
    listener: (files: RecentFileStatus[]) => void,
  ): () => void;
  onCloseRequested(listener: () => void): () => void;
  requestClose(): Promise<void>;
  cancelClose(): Promise<void>;
  /** 拉取启动参数携带的待打开文档路径（一次性，argv 双击打开场景）。 */
  getStartupOpenPath?(): Promise<string | null>;
  /** Tauri 专用：同步原生窗口标题。 */
  setWindowTitle?(title: string): Promise<void>;
  /** Tauri 专用：原生文件拖放（WebView 拿不到 File 对象，只有路径+坐标）。 */
  onNativeDropPaths?(listener: (payload: {
    paths: string[];
    position: { x: number; y: number };
  }) => void): () => void;
}

declare global {
  interface Window {
    markdesk?: MarkDeskRendererApi;
  }
}
