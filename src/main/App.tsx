import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { EditorView } from "prosemirror-view";
import { TextSelection } from "prosemirror-state";
import { parseMarkdown } from "../markdown/parser";
import { serializeMarkdown } from "../markdown/serializer";
import { OutlinePanel } from "./components/OutlinePanel";
import { ReadView } from "./components/ReadView";
import { SourceEditor } from "./components/SourceEditor";
import { StatusBar } from "./components/StatusBar";
import {
  EditorViewContext,
  SetEditorSelectionContext,
  SetEditorViewContext,
  Toolbar,
} from "./components/Toolbar";
import { WysiwygEditor } from "./components/WysiwygEditor";
import { activeOutlinePosition, outlineFromDoc } from "./editor/outline";
import {
  useDocumentStore,
  type EditorMode,
  type ThemePreference,
} from "./state/documentStore";
import {
  FileLifecycleController,
  toFileActionError,
} from "./fileLifecycle";
import type {
  FileFingerprint,
  FileWriteResult,
  MenuCommand,
  NewlinePreference,
  RecentFileStatus,
} from "../shared/types";

const modeLabels = {
  wysiwyg: "所见即所得",
  source: "源码",
  read: "阅读",
} as const;

const modes = Object.keys(modeLabels) as EditorMode[];
type PendingFileAction =
  | { type: "new" }
  | { type: "open"; path?: string }
  | { type: "close" };

const themeLabels: Record<ThemePreference, string> = {
  light: "浅色",
  dark: "深色",
  system: "跟随系统",
};

function normalizeForSave(
  content: string,
  newline: NewlinePreference,
): string {
  const lfContent = content.replace(/\r\n?/gu, "\n");
  return newline === "crlf"
    ? lfContent.replace(/\n/gu, "\r\n")
    : lfContent;
}

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? "未命名.md";
}

export default function App() {
  const doc = useDocumentStore((state) => state.doc);
  const filePath = useDocumentStore((state) => state.filePath);
  const fileName = useDocumentStore((state) => state.fileName);
  const dirty = useDocumentStore((state) => state.dirty);
  const mode = useDocumentStore((state) => state.mode);
  const sourceText = useDocumentStore((state) => state.sourceText);
  const modeTransitionError = useDocumentStore(
    (state) => state.modeTransitionError,
  );
  const sessionKey = useDocumentStore((state) => state.sessionKey);
  const themePreference = useDocumentStore(
    (state) => state.themePreference,
  );
  const setDocument = useDocumentStore((state) => state.setDocument);
  const setSourceText = useDocumentStore((state) => state.setSourceText);
  const transitionMode = useDocumentStore((state) => state.transitionMode);
  const setThemePreference = useDocumentStore(
    (state) => state.setThemePreference,
  );
  const lifecycleRef = useRef(new FileLifecycleController());
  const pendingActionRef = useRef<PendingFileAction | null>(null);
  const api = typeof window === "undefined" ? undefined : window.markdesk;
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  const [selectionPosition, setSelectionPosition] = useState(0);
  const [systemPrefersDark, setSystemPrefersDark] = useState(false);
  const [fileFingerprint, setFileFingerprint] =
    useState<FileFingerprint | null>(null);
  const [newlinePreference, setNewlinePreference] =
    useState<NewlinePreference>("lf");
  const [fileBusy, setFileBusy] = useState(false);
  const [fileActionError, setFileActionError] = useState<
    ReturnType<typeof toFileActionError> | null
  >(null);
  const [recentFiles, setRecentFiles] = useState<RecentFileStatus[]>([]);
  const [pendingFileAction, setPendingFileAction] =
    useState<PendingFileAction | null>(null);

  useEffect(() => {
    setSelectionPosition(0);
  }, [mode, sessionKey]);

  useLayoutEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const updateSystemTheme = () => setSystemPrefersDark(mediaQuery.matches);
    updateSystemTheme();
    mediaQuery.addEventListener("change", updateSystemTheme);
    return () => mediaQuery.removeEventListener("change", updateSystemTheme);
  }, []);

  const resolvedTheme = themePreference === "system"
    ? systemPrefersDark
      ? "dark"
      : "light"
    : themePreference;

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme;
    root.dataset.themePreference = themePreference;
    root.classList.toggle("theme-light", resolvedTheme === "light");
    root.classList.toggle("theme-dark", resolvedTheme === "dark");
    root.style.colorScheme = resolvedTheme;
    return () => {
      delete root.dataset.theme;
      delete root.dataset.themePreference;
      root.classList.remove("theme-light", "theme-dark");
      root.style.removeProperty("color-scheme");
    };
  }, [resolvedTheme, themePreference]);

  const outlineItems = useMemo(() => outlineFromDoc(doc), [doc]);
  const activeHeadingPos = useMemo(
    () => activeOutlinePosition(outlineItems, selectionPosition),
    [outlineItems, selectionPosition],
  );

  const jumpToHeading = useCallback(
    (pos: number) => {
      if (!editorView) return;

      const resolvedPos = editorView.state.doc.resolve(
        Math.min(pos, editorView.state.doc.content.size),
      );
      const selection = TextSelection.near(resolvedPos, 1);
      editorView.dispatch(
        editorView.state.tr.setSelection(selection).scrollIntoView(),
      );
      editorView.focus();
    },
    [editorView],
  );

  const createUntitledDocument = useCallback((): boolean => {
    const revision = lifecycleRef.current.beginOperation();
    if (revision === null) return false;

    setFileBusy(true);
    setFileActionError(null);
    try {
      useDocumentStore.getState().replaceDocument({
        doc: parseMarkdown(""),
        filePath: null,
        fileName: "未命名.md",
        dirty: false,
      });
      setFileFingerprint(null);
      setNewlinePreference("lf");
      return lifecycleRef.current.isCurrent(revision);
    } finally {
      lifecycleRef.current.endOperation();
      setFileBusy(false);
    }
  }, []);

  const openDocument = useCallback(async (path?: string): Promise<boolean> => {
    const revision = lifecycleRef.current.beginOperation();
    if (revision === null) return false;

    setFileBusy(true);
    setFileActionError(null);
    try {
      if (!api) return false;
      const selectedPath = path ?? (await api.chooseMarkdownFile());
      if (!selectedPath) return false;

      const file = path
        ? await api.readRecentFile(path)
        : await api.readFile(selectedPath);

      let doc: ReturnType<typeof parseMarkdown>;
      try {
        doc = parseMarkdown(file.content);
      } catch (error) {
        setFileActionError(toFileActionError(error, "parse"));
        return false;
      }
      useDocumentStore.getState().replaceDocument({
        doc,
        filePath: file.path,
        fileName: fileNameFromPath(file.path),
        dirty: false,
      });
      setFileFingerprint({
        hash: file.hash,
        mtimeMs: file.mtimeMs,
        size: file.size,
      });
      setNewlinePreference(file.newline);
      return lifecycleRef.current.isCurrent(revision);
    } catch (error) {
      setFileActionError(toFileActionError(error));
      return false;
    } finally {
      lifecycleRef.current.endOperation();
      setFileBusy(false);
    }
  }, [api]);

  const persistCurrentDocument = useCallback(
    async (
      path: string,
      expected: FileFingerprint | undefined,
      revision: number,
    ): Promise<boolean> => {
      const state = useDocumentStore.getState();
      let source: string;
      try {
        source =
          state.mode === "source"
            ? state.sourceText
            : serializeMarkdown(state.doc);
      } catch (error) {
        setFileActionError(toFileActionError(error, "serialize"));
        return false;
      }

      const content = normalizeForSave(source, newlinePreference);
      let result: FileWriteResult | undefined;
      try {
        result = await api?.writeFile(path, content, expected);
      } catch (error) {
        setFileActionError(toFileActionError(error));
        return false;
      }
      if (!result) return false;

      const latestState = useDocumentStore.getState();
      latestState.saveAs(result.path, fileNameFromPath(result.path));
      if (lifecycleRef.current.isCurrent(revision)) {
        latestState.markSaved();
      }
      setFileFingerprint({
        hash: result.hash,
        mtimeMs: result.mtimeMs,
        size: result.size,
      });
      setNewlinePreference((current) =>
        content.includes("\r\n") ? "crlf" : current,
      );
      return lifecycleRef.current.isCurrent(revision);
    },
    [api, newlinePreference],
  );

  const saveDocument = useCallback(async (): Promise<boolean> => {
    const revision = lifecycleRef.current.beginOperation();
    if (revision === null) return false;

    setFileBusy(true);
    setFileActionError(null);
    try {
      const state = useDocumentStore.getState();
      if (!api) return false;
      if (!state.filePath) {
        const path = await api.chooseSaveLocation(state.fileName);
        if (!path) return false;
        return await persistCurrentDocument(
          path,
          fileFingerprint ?? undefined,
          revision,
        );
      }

      return await persistCurrentDocument(
        state.filePath,
        fileFingerprint ?? undefined,
        revision,
      );
    } catch (error) {
      setFileActionError(toFileActionError(error));
      return false;
    } finally {
      lifecycleRef.current.endOperation();
      setFileBusy(false);
    }
  }, [api, fileFingerprint, persistCurrentDocument]);

  const handleDocumentChange = useCallback(
    (nextDoc: Parameters<typeof setDocument>[0]) => {
      lifecycleRef.current.markEdited();
      setDocument(nextDoc);
    },
    [setDocument],
  );

  const handleSourceChange = useCallback(
    (nextSource: string) => {
      lifecycleRef.current.markEdited();
      setSourceText(nextSource);
    },
    [setSourceText],
  );

  const saveDocumentAs = useCallback(async (): Promise<boolean> => {
    const revision = lifecycleRef.current.beginOperation();
    if (revision === null) return false;

    setFileBusy(true);
    setFileActionError(null);
    try {
      const state = useDocumentStore.getState();
      if (!api) return false;
      const path = await api.chooseSaveLocation(state.fileName);
      if (!path) return false;

      return await persistCurrentDocument(
        path,
        fileFingerprint ?? undefined,
        revision,
      );
    } catch (error) {
      setFileActionError(toFileActionError(error));
      return false;
    } finally {
      lifecycleRef.current.endOperation();
      setFileBusy(false);
    }
  }, [api, fileFingerprint, persistCurrentDocument]);

  const finishPendingFileAction = useCallback(
    async (action: PendingFileAction): Promise<void> => {
      if (pendingActionRef.current !== action) return;
      pendingActionRef.current = null;
      setPendingFileAction(null);

      if (action.type === "close") {
        await api?.requestClose();
        return;
      }
      if (action.type === "new") {
        createUntitledDocument();
        return;
      }
      await openDocument(action.path);
    },
    [api, createUntitledDocument, openDocument],
  );

  const requestFileAction = useCallback(
    (action: PendingFileAction): void => {
      if (lifecycleRef.current.busy || pendingActionRef.current) return;
      if (useDocumentStore.getState().dirty) {
        pendingActionRef.current = action;
        setPendingFileAction(action);
        return;
      }
      void finishPendingFileAction(action);
    },
    [finishPendingFileAction],
  );

  const cancelPendingFileAction = useCallback((): void => {
    pendingActionRef.current = null;
    setPendingFileAction(null);
  }, []);

  const saveAndContinue = useCallback(async (): Promise<void> => {
    const action = pendingActionRef.current;
    if (!action || lifecycleRef.current.busy) return;

    const saved = await saveDocument();
    if (saved && pendingActionRef.current === action) {
      await finishPendingFileAction(action);
    }
  }, [finishPendingFileAction, saveDocument]);

  const handleMenuCommand = useCallback(
    (command: MenuCommand) => {
      if (lifecycleRef.current.busy || pendingActionRef.current) return;
      if (command === "new") requestFileAction({ type: "new" });
      else if (command === "open") requestFileAction({ type: "open" });
      else if (command === "save") void saveDocument();
      else if (command === "save-as") void saveDocumentAs();
      else if (command === "toggle-source") transitionMode("source");
      else if (command === "toggle-read") transitionMode("read");
      else if (command === "toggle-wysiwyg") transitionMode("wysiwyg");
    },
    [
      openDocument,
      requestFileAction,
      saveDocument,
      saveDocumentAs,
      transitionMode,
    ],
  );

  useEffect(() => {
    if (!api) return;
    return api.onMenuCommand(handleMenuCommand);
  }, [api, handleMenuCommand]);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;

    void api.getRecentFiles().then((files) => {
      if (!cancelled) setRecentFiles(files);
    }).catch((error) => {
      if (!cancelled) setFileActionError(toFileActionError(error));
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (!api) return;
    return api.onRecentFilesChanged(setRecentFiles);
  }, [api]);

  useEffect(() => {
    if (!api) return;
    return api.onOpenRecentFile((event) => {
      requestFileAction({ type: "open", path: event.path });
    });
  }, [api, requestFileAction]);

  useEffect(() => {
    if (!api) return;
    return api.onCloseRequested(() => {
      const currentAction = pendingActionRef.current;
      if (currentAction?.type === "close") return;
      const action: PendingFileAction = { type: "close" };
      pendingActionRef.current = action;
      setPendingFileAction(action);
    });
  }, [api]);

  useEffect(() => {
    if (!pendingFileAction || fileBusy) return;
    if (!useDocumentStore.getState().dirty) {
      void finishPendingFileAction(pendingFileAction);
    }
  }, [pendingFileAction, fileBusy, finishPendingFileAction]);

  useEffect(() => {
    if (!api) return;
    return api.onFileChanged((event) => {
      if (useDocumentStore.getState().filePath === event.path) {
        setFileActionError({
          code: "file-changed",
          message: "文件已在其他程序中修改，保存前会进行冲突检查。",
        });
      }
    });
  }, [api]);

  const clearRecentFiles = useCallback(async (): Promise<void> => {
    try {
      await api?.clearRecentFiles();
      setRecentFiles([]);
    } catch (error) {
      setFileActionError(toFileActionError(error));
    }
  }, [api]);

  const showWelcome = filePath === null && !dirty;

  return (
    <main className="app-shell" data-testid="app-shell">
      <EditorViewContext.Provider value={editorView}>
        <SetEditorViewContext.Provider value={setEditorView}>
          <SetEditorSelectionContext.Provider value={setSelectionPosition}>
            <Toolbar />
            <ViewBar
              mode={mode}
              themePreference={themePreference}
              onModeChange={transitionMode}
              onThemeChange={setThemePreference}
              onNewDocument={() => requestFileAction({ type: "new" })}
              onOpenDocument={() => requestFileAction({ type: "open" })}
              onSaveDocument={saveDocument}
              onSaveDocumentAs={saveDocumentAs}
              fileBusy={fileBusy}
              actionPending={pendingFileAction !== null}
            />
            <div className="workspace" data-testid="workspace">
              <OutlinePanel
                doc={doc}
                onJump={jumpToHeading}
                activePos={activeHeadingPos}
                disabled={mode !== "wysiwyg"}
              />
              <section className="editor-pane" aria-label="编辑器">
                {modeTransitionError ? (
                  <p
                    className="mode-error"
                    role="alert"
                    data-testid="mode-transition-error"
                    data-error-kind={modeTransitionError.kind}
                  >
                    {modeTransitionError.message}
                  </p>
                ) : null}
                {fileActionError ? (
                  <p
                    className="mode-error file-error"
                    role="alert"
                    data-testid="file-error"
                    data-error-code={fileActionError.code}
                  >
                    {fileActionError.message}
                  </p>
                ) : null}
                {showWelcome ? (
                  <WelcomeView
                    recentFiles={recentFiles}
                    fileBusy={fileBusy || pendingFileAction !== null}
                    onNewDocument={() => requestFileAction({ type: "new" })}
                    onOpenDocument={() => requestFileAction({ type: "open" })}
                    onOpenRecentFile={(path) =>
                      requestFileAction({ type: "open", path })}
                    onClearRecentFiles={clearRecentFiles}
                  />
                ) : mode === "wysiwyg" ? (
                  <WysiwygEditor
                    initialDoc={doc}
                    sessionKey={sessionKey}
                    onChange={handleDocumentChange}
                  />
                ) : mode === "source" ? (
                  <SourceEditor
                    initialValue={sourceText}
                    sessionKey={sessionKey}
                    onChange={handleSourceChange}
                  />
                ) : (
                  <ReadView doc={doc} />
                )}
              </section>
            </div>
          </SetEditorSelectionContext.Provider>
        </SetEditorViewContext.Provider>
      </EditorViewContext.Provider>

      <StatusBar fileName={fileName} dirty={dirty} mode={mode} />
      {pendingFileAction && dirty ? (
        <CloseProtectionDialog
          busy={fileBusy}
          fileName={fileName}
          onSave={() => void saveAndContinue()}
          onDiscard={() => void finishPendingFileAction(pendingFileAction)}
          onCancel={cancelPendingFileAction}
        />
      ) : null}
    </main>
  );
}

function ViewBar({
  mode,
  themePreference,
  onModeChange,
  onThemeChange,
  onNewDocument,
  onOpenDocument,
  onSaveDocument,
  onSaveDocumentAs,
  fileBusy,
  actionPending,
}: {
  mode: EditorMode;
  themePreference: ThemePreference;
  onModeChange(mode: EditorMode): void;
  onThemeChange(theme: ThemePreference): void;
  onNewDocument(): void;
  onOpenDocument(): void | Promise<void>;
  onSaveDocument(): void | Promise<void>;
  onSaveDocumentAs(): void | Promise<void>;
  fileBusy: boolean;
  actionPending: boolean;
}) {
  return (
    <div className="view-bar" data-testid="view-bar">
      <div className="view-actions">
        <div
          className="mode-switcher"
          role="group"
          aria-label="编辑模式"
          data-testid="mode-switcher"
        >
          {modes.map((item) => (
            <button
              key={item}
              type="button"
              className="mode-button"
              aria-pressed={mode === item}
              data-active={mode === item ? "true" : "false"}
              data-testid={`mode-${item}`}
              onClick={() => onModeChange(item)}
            >
              {modeLabels[item]}
            </button>
          ))}
        </div>
        <div className="file-actions" role="group" aria-label="文件操作">
          <button
            type="button"
            className="mode-button"
            data-testid="file-new"
            disabled={fileBusy || actionPending}
            onClick={onNewDocument}
          >
            新建
          </button>
          <button
            type="button"
            className="mode-button"
            data-testid="file-open"
            disabled={fileBusy || actionPending}
            onClick={() => void onOpenDocument()}
          >
            打开
          </button>
          <button
            type="button"
            className="mode-button"
            data-testid="file-save"
            disabled={fileBusy || actionPending}
            onClick={() => void onSaveDocument()}
          >
            保存
          </button>
          <button
            type="button"
            className="mode-button"
            data-testid="file-save-as"
            disabled={fileBusy || actionPending}
            onClick={() => void onSaveDocumentAs()}
          >
            另存为
          </button>
        </div>
      </div>
      <label className="theme-select-label" htmlFor="theme-select">
        主题
        <select
          id="theme-select"
          value={themePreference}
          data-testid="theme-select"
          onChange={(event) =>
            onThemeChange(event.target.value as ThemePreference)
          }
        >
          {(Object.keys(themeLabels) as ThemePreference[]).map((theme) => (
            <option
              key={theme}
              value={theme}
              data-testid={`theme-option-${theme}`}
            >
              {themeLabels[theme]}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function WelcomeView({
  recentFiles,
  fileBusy,
  onNewDocument,
  onOpenDocument,
  onOpenRecentFile,
  onClearRecentFiles,
}: {
  recentFiles: RecentFileStatus[];
  fileBusy: boolean;
  onNewDocument(): void;
  onOpenDocument(): void;
  onOpenRecentFile(path: string): void;
  onClearRecentFiles(): void | Promise<void>;
}) {
  return (
    <section
      className="welcome-view"
      aria-labelledby="welcome-title"
      data-testid="welcome-view"
    >
      <div className="welcome-card">
        <h1 id="welcome-title">欢迎使用 MarkDesk</h1>
        <p>创建一个新文档，或从最近的 Markdown 文件继续工作。</p>
        <div className="welcome-actions" role="group" aria-label="开始使用">
          <button
            type="button"
            className="mode-button"
            data-testid="welcome-new"
            disabled={fileBusy}
            onClick={onNewDocument}
          >
            新建文档
          </button>
          <button
            type="button"
            className="mode-button"
            data-testid="welcome-open"
            disabled={fileBusy}
            onClick={onOpenDocument}
          >
            打开文件
          </button>
        </div>

        <section className="recent-files" aria-labelledby="recent-files-title">
          <div className="recent-files-header">
            <h2 id="recent-files-title">最近打开</h2>
            <button
              type="button"
              className="mode-button"
              data-testid="clear-recent-files"
              disabled={fileBusy || recentFiles.length === 0}
              onClick={() => void onClearRecentFiles()}
            >
              清除最近文件
            </button>
          </div>
          {recentFiles.length === 0 ? (
            <p className="recent-empty" data-testid="recent-files-empty">
              暂无最近文件
            </p>
          ) : (
            <ul className="recent-files-list" data-testid="recent-files-list">
              {recentFiles.map((file) => (
                <li
                  key={file.path}
                  className="recent-file-item"
                  data-testid="recent-file-item"
                  data-missing={file.exists ? "false" : "true"}
                >
                  <button
                    type="button"
                    className="recent-file-button"
                    data-testid="open-recent-file"
                    data-path={file.path}
                    disabled={fileBusy || !file.exists}
                    onClick={() => onOpenRecentFile(file.path)}
                  >
                    <span className="recent-file-name">{file.name}</span>
                    <span className="recent-file-path">{file.path}</span>
                    {!file.exists ? (
                      <span
                        className="recent-file-missing"
                        data-testid="recent-file-missing"
                      >
                        文件不存在
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </section>
  );
}

function CloseProtectionDialog({
  busy,
  fileName,
  onSave,
  onDiscard,
  onCancel,
}: {
  busy: boolean;
  fileName: string;
  onSave(): void;
  onDiscard(): void;
  onCancel(): void;
}) {
  return (
    <div
      className="dialog-backdrop"
      data-testid="close-protection-backdrop"
    >
      <section
        className="close-protection-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="close-protection-title"
        aria-describedby="close-protection-description"
        data-testid="close-protection-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            onCancel();
          }
        }}
      >
        <h2 id="close-protection-title">未保存的更改</h2>
        <p id="close-protection-description">
          是否保存对“{fileName}”的更改？
        </p>
        <div
          className="dialog-actions"
          role="group"
          aria-label="关闭保护操作"
        >
          <button
            type="button"
            className="primary-dialog-button"
            data-testid="close-protection-save"
            disabled={busy}
            autoFocus
            onClick={onSave}
          >
            保存并继续
          </button>
          <button
            type="button"
            data-testid="close-protection-discard"
            disabled={busy}
            onClick={onDiscard}
          >
            放弃更改
          </button>
          <button
            type="button"
            data-testid="close-protection-cancel"
            onClick={onCancel}
          >
            取消
          </button>
        </div>
      </section>
    </div>
  );
}
