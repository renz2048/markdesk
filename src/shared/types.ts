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

export type MenuCommand =
  | "new"
  | "open"
  | "save"
  | "save-as"
  | "export-html"
  | "toggle-source"
  | "toggle-read"
  | "toggle-wysiwyg";

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
  recentFilesChanged: "markdesk:recent-files-changed",
  openRecentFile: "markdesk:open-recent-file",
  menuCommand: "markdesk:menu-command",
  fileChanged: "markdesk:file-changed",
  closeRequested: "markdesk:close-requested",
  requestClose: "markdesk:request-close",
  cancelClose: "markdesk:cancel-close",
} as const;

export interface MarkDeskRendererApi {
  chooseMarkdownFile(): Promise<string | null>;
  chooseSaveLocation(defaultName: string): Promise<string | null>;
  readFile(path: string): Promise<FileReadResult>;
  writeFile(
    path: string,
    content: string,
    expected?: FileFingerprint,
  ): Promise<FileWriteResult>;
  getRecentFiles(): Promise<RecentFileStatus[]>;
  readRecentFile(path: string): Promise<FileReadResult>;
  clearRecentFiles(): Promise<void>;
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
}

declare global {
  interface Window {
    markdesk?: MarkDeskRendererApi;
  }
}
