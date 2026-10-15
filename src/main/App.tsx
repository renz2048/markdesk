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
} from "../shared/types";

const modeLabels = {
  wysiwyg: "所见即所得",
  source: "源码",
  read: "阅读",
} as const;

const modes = Object.keys(modeLabels) as EditorMode[];
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

  const newDocument = useCallback(() => {
    if (lifecycleRef.current.beginOperation() === null) return;

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
    } finally {
      lifecycleRef.current.endOperation();
      setFileBusy(false);
    }
  }, []);

  const openDocument = useCallback(async () => {
    if (lifecycleRef.current.beginOperation() === null) return;

    setFileBusy(true);
    setFileActionError(null);
    try {
      const path = await api?.chooseMarkdownFile();
      if (!path) return;

      const file = await api?.readFile(path);
      if (!file) return;

      let doc: ReturnType<typeof parseMarkdown>;
      try {
        doc = parseMarkdown(file.content);
      } catch (error) {
        setFileActionError(toFileActionError(error, "parse"));
        return;
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
    } catch (error) {
      setFileActionError(toFileActionError(error));
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
    ): Promise<void> => {
      const state = useDocumentStore.getState();
      let source: string;
      try {
        source =
          state.mode === "source"
            ? state.sourceText
            : serializeMarkdown(state.doc);
      } catch (error) {
        setFileActionError(toFileActionError(error, "serialize"));
        return;
      }

      const content = normalizeForSave(source, newlinePreference);
      let result: FileWriteResult | undefined;
      try {
        result = await api?.writeFile(path, content, expected);
      } catch (error) {
        setFileActionError(toFileActionError(error));
        return;
      }
      if (!result) return;

      state.saveAs(result.path, fileNameFromPath(result.path));
      if (lifecycleRef.current.isCurrent(revision)) {
        state.markSaved();
      }
      setFileFingerprint({
        hash: result.hash,
        mtimeMs: result.mtimeMs,
        size: result.size,
      });
      setNewlinePreference((current) =>
        content.includes("\r\n") ? "crlf" : current,
      );
    },
    [api, newlinePreference],
  );

  const saveDocument = useCallback(async () => {
    const revision = lifecycleRef.current.beginOperation();
    if (revision === null) return;

    setFileBusy(true);
    setFileActionError(null);
    try {
      const state = useDocumentStore.getState();
      if (!state.filePath) {
        const path = await api?.chooseSaveLocation(state.fileName);
        if (!path) return;
        await persistCurrentDocument(
          path,
          fileFingerprint ?? undefined,
          revision,
        );
        return;
      }

      await persistCurrentDocument(
        state.filePath,
        fileFingerprint ?? undefined,
        revision,
      );
    } catch (error) {
      setFileActionError(toFileActionError(error));
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

  const saveDocumentAs = useCallback(async () => {
    const revision = lifecycleRef.current.beginOperation();
    if (revision === null) return;

    setFileBusy(true);
    setFileActionError(null);
    try {
      const state = useDocumentStore.getState();
      const path = await api?.chooseSaveLocation(state.fileName);
      if (!path) return;

      await persistCurrentDocument(
        path,
        fileFingerprint ?? undefined,
        revision,
      );
    } catch (error) {
      setFileActionError(toFileActionError(error));
    } finally {
      lifecycleRef.current.endOperation();
      setFileBusy(false);
    }
  }, [api, fileFingerprint, persistCurrentDocument]);

  const handleMenuCommand = useCallback(
    (command: MenuCommand) => {
      if (lifecycleRef.current.busy) return;
      if (command === "new") newDocument();
      else if (command === "open") void openDocument();
      else if (command === "save") void saveDocument();
      else if (command === "save-as") void saveDocumentAs();
      else if (command === "toggle-source") transitionMode("source");
      else if (command === "toggle-read") transitionMode("read");
      else if (command === "toggle-wysiwyg") transitionMode("wysiwyg");
    },
    [
      newDocument,
      openDocument,
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
    return api.onFileChanged((event) => {
      if (useDocumentStore.getState().filePath === event.path) {
        setFileActionError({
          code: "file-changed",
          message: "文件已在其他程序中修改，保存前会进行冲突检查。",
        });
      }
    });
  }, [api]);

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
              onNewDocument={newDocument}
              onOpenDocument={openDocument}
              onSaveDocument={saveDocument}
              onSaveDocumentAs={saveDocumentAs}
              fileBusy={fileBusy}
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
                {mode === "wysiwyg" ? (
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
            disabled={fileBusy}
            onClick={onNewDocument}
          >
            新建
          </button>
          <button
            type="button"
            className="mode-button"
            data-testid="file-open"
            disabled={fileBusy}
            onClick={() => void onOpenDocument()}
          >
            打开
          </button>
          <button
            type="button"
            className="mode-button"
            data-testid="file-save"
            disabled={fileBusy}
            onClick={() => void onSaveDocument()}
          >
            保存
          </button>
          <button
            type="button"
            className="mode-button"
            data-testid="file-save-as"
            disabled={fileBusy}
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
