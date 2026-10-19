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
import { buildExportHtml } from "./editor/exportHtml";
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
  RecoveryDraft,
  RecoveryDraftInput,
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

const DRAFT_SAVE_DELAY_MS = 500;

interface DraftQueueState {
  queue: Promise<void>;
  version: number;
  activeKey: string | null;
}

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
  const editorEngaged = useDocumentStore(
    (state) => state.editorEngaged,
  );
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
  const shellRef = useRef<HTMLElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const draftQueueRef = useRef<DraftQueueState>({
    queue: Promise.resolve(),
    version: 0,
    activeKey: null,
  });
  const restoreDraftViewRef = useRef<{
    mode: EditorMode;
    sessionKey: string;
    cursor: number;
    scrollTop: number;
  } | null>(null);
  const api = typeof window === "undefined" ? undefined : window.markdesk;
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  const [selectionPosition, setSelectionPosition] = useState(0);
  const [sourceCursorPosition, setSourceCursorPosition] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
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
  const [recoveryDraft, setRecoveryDraft] = useState<RecoveryDraft | null>(
    null,
  );
  const [externalFileChange, setExternalFileChange] = useState<string | null>(
    null,
  );
  const [fileCollision, setFileCollision] = useState<string | null>(null);

  useEffect(() => {
    setSelectionPosition(0);
    setSourceCursorPosition(0);
    setScrollTop(0);
  }, [mode, sessionKey]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    // scroll 事件不冒泡，这里用捕获阶段监听编辑器容器的滚动位置。
    const handleScroll = (event: Event): void => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.classList.contains("editor")
      ) {
        setScrollTop(target.scrollTop);
      }
    };
    document.addEventListener("scroll", handleScroll, true);
    return () => document.removeEventListener("scroll", handleScroll, true);
  }, []);

  useEffect(() => {
    const pending = restoreDraftViewRef.current;
    if (!pending || pending.sessionKey !== sessionKey) return;
    restoreDraftViewRef.current = null;
    const editor = workspaceRef.current?.querySelector<HTMLElement>(".editor");
    if (editor) editor.scrollTop = pending.scrollTop;
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

  useEffect(() => {
    // A deterministic concurrent-edit signal for lifecycle tests. It only
    // increments the same revision guard used by real editor changes and
    // provides no privileged file or IPC access.
    const markDocumentEdited = () => {
      lifecycleRef.current.markEdited();
    };
    window.addEventListener("markdesk:document-edited", markDocumentEdited);
    return () => {
      window.removeEventListener("markdesk:document-edited", markDocumentEdited);
    };
  }, []);

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
      if (!lifecycleRef.current.isCurrent(revision)) {
        setFileActionError({
          code: "file-changed",
          message: "文件已在打开过程中修改，已保留当前更改。",
        });
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

  const queueDraftSave = useCallback(
    (input: RecoveryDraftInput): void => {
      if (!api) return;
      const drafts = draftQueueRef.current;
      drafts.version += 1;
      const version = drafts.version;
      drafts.queue = drafts.queue
        .then(() => api.saveRecoveryDraft(input))
        .then((key) => {
          // 只有最新一次排队保存才能登记活动键，避免旧结果覆盖新状态。
          if (draftQueueRef.current.version === version) {
            draftQueueRef.current.activeKey = key;
          }
        })
        .catch(() => {
          // 恢复草稿是尽力而为的保障，失败不打断编辑。
        });
    },
    [api],
  );

  const discardActiveDraft = useCallback((): void => {
    if (!api) return;
    const drafts = draftQueueRef.current;
    const key = drafts.activeKey;
    drafts.activeKey = null;
    if (!key) return;
    const version = drafts.version;
    drafts.queue = drafts.queue
      .then(() => {
        // 丢弃之后若有新的草稿保存排队，则保留新草稿。
        if (draftQueueRef.current.version !== version) return;
        return api.discardRecoveryDraft(key);
      })
      .catch(() => {
        // 残留草稿只影响下次启动的恢复提示，不影响数据安全。
      });
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
        const actionError = toFileActionError(error);
        if (actionError.code === "file-changed") {
          // 磁盘内容与打开时不一致：交给冲突对话框选择处理方式。
          setFileCollision(path);
        } else {
          setFileActionError(actionError);
        }
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
      setExternalFileChange(null);
      discardActiveDraft();
      return lifecycleRef.current.isCurrent(revision);
    },
    [api, newlinePreference, discardActiveDraft],
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

  const exportDocument = useCallback(async (): Promise<void> => {
    if (!api) return;
    const revision = lifecycleRef.current.beginOperation();
    if (revision === null) return;

    setFileBusy(true);
    setFileActionError(null);
    try {
      const state = useDocumentStore.getState();
      const defaultName = state.fileName.replace(/\.(md|markdown)$/iu, "") +
        ".html";
      const target = await api.chooseExportLocation(defaultName);
      if (!target) return;

      const doc = state.mode === "source"
        ? parseMarkdown(state.sourceText)
        : state.doc;
      const html = buildExportHtml(doc, resolvedTheme === "dark" ? "dark" : "light");
      await api.exportHtml(target, html);
      // 导出是只读的旁路操作：不改变活动文档的脏状态。
    } catch (error) {
      setFileActionError(toFileActionError(error));
    } finally {
      lifecycleRef.current.endOperation();
      setFileBusy(false);
    }
  }, [api, resolvedTheme]);

  const reloadFromDisk = useCallback(async (): Promise<boolean> => {
    if (!api) return false;
    const path = useDocumentStore.getState().filePath;
    if (!path) return false;
    const revision = lifecycleRef.current.beginOperation();
    if (revision === null) return false;

    setFileBusy(true);
    setFileActionError(null);
    try {
      const file = await api.readFile(path);
      let parsed: ReturnType<typeof parseMarkdown>;
      try {
        parsed = parseMarkdown(file.content);
      } catch (error) {
        setFileActionError(toFileActionError(error, "parse"));
        return false;
      }
      if (!lifecycleRef.current.isCurrent(revision)) return false;
      useDocumentStore.getState().replaceDocument({
        doc: parsed,
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
      setExternalFileChange(null);
      discardActiveDraft();
      return true;
    } catch (error) {
      setFileActionError(toFileActionError(error));
      return false;
    } finally {
      lifecycleRef.current.endOperation();
      setFileBusy(false);
    }
  }, [api, discardActiveDraft]);

  const resolveFileCollision = useCallback(
    async (choice: "overwrite" | "reload" | "save-as"): Promise<void> => {
      const path = fileCollision;
      if (!path || !api) return;

      if (choice === "reload") {
        setFileCollision(null);
        await reloadFromDisk();
        return;
      }

      const revision = lifecycleRef.current.beginOperation();
      if (revision === null) return;

      setFileBusy(true);
      setFileActionError(null);
      try {
        if (choice === "overwrite") {
          // 先重新读取以刷新主进程的基线指纹，再用最新指纹覆盖写入。
          const file = await api.readFile(path);
          const saved = await persistCurrentDocument(
            path,
            {
              hash: file.hash,
              mtimeMs: file.mtimeMs,
              size: file.size,
            },
            revision,
          );
          if (saved) setFileCollision(null);
        } else {
          const state = useDocumentStore.getState();
          const target = await api.chooseSaveLocation(state.fileName);
          if (!target) return;
          const saved = await persistCurrentDocument(
            target,
            fileFingerprint ?? undefined,
            revision,
          );
          if (saved) setFileCollision(null);
        }
      } catch (error) {
        setFileActionError(toFileActionError(error));
        setFileCollision(null);
      } finally {
        lifecycleRef.current.endOperation();
        setFileBusy(false);
      }
    },
    [
      api,
      fileCollision,
      fileFingerprint,
      persistCurrentDocument,
      reloadFromDisk,
    ],
  );

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

  useEffect(() => {
    if (!api || !dirty) return;
    let markdown: string;
    try {
      markdown = mode === "source" ? sourceText : serializeMarkdown(doc);
    } catch {
      // 序列化失败时保留上一次草稿内容。
      return;
    }
    const cursor = mode === "source"
      ? sourceCursorPosition
      : mode === "wysiwyg"
        ? selectionPosition
        : 0;
    const timer = setTimeout(() => {
      queueDraftSave({
        path: filePath,
        fileName,
        markdown,
        mode,
        cursor,
        scrollTop,
      });
    }, DRAFT_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [
    api,
    dirty,
    doc,
    sourceText,
    mode,
    filePath,
    fileName,
    selectionPosition,
    sourceCursorPosition,
    scrollTop,
    queueDraftSave,
  ]);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void api.listRecoveryDrafts()
      .then(async (summaries) => {
        if (cancelled || summaries.length === 0) return;
        const draft = await api.readRecoveryDraft(summaries[0].key);
        if (cancelled || !draft) return;
        setRecoveryDraft(draft);
      })
      .catch(() => {
        // 草稿列表读取失败时静默跳过恢复提示。
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const restoreRecoveryDraft = useCallback(
    async (draft: RecoveryDraft): Promise<void> => {
      setRecoveryDraft(null);
      try {
        const parsed = parseMarkdown(draft.markdown);
        useDocumentStore.getState().replaceDocument({
          doc: parsed,
          filePath: draft.path,
          fileName: draft.fileName,
          dirty: true,
        });
        if (draft.mode !== "wysiwyg") {
          useDocumentStore.getState().transitionMode(draft.mode);
        }
        draftQueueRef.current.activeKey = draft.key;
        restoreDraftViewRef.current = {
          mode: draft.mode,
          sessionKey: useDocumentStore.getState().sessionKey,
          cursor: draft.cursor,
          scrollTop: draft.scrollTop,
        };
      } catch {
        setFileActionError({
          code: "parse",
          message: "恢复草稿解析失败，已忽略该草稿。",
        });
        void api?.discardRecoveryDraft(draft.key).catch(() => undefined);
      }
    },
    [api],
  );

  const skipRecoveryDraft = useCallback((): void => {
    const draft = recoveryDraft;
    setRecoveryDraft(null);
    if (!draft || !api) return;
    void api.discardRecoveryDraft(draft.key).catch(() => undefined);
  }, [api, recoveryDraft]);

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
        try {
          await api?.requestClose();
        } catch (error) {
          setFileActionError(toFileActionError(error));
        }
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
      pendingActionRef.current = action;
      setPendingFileAction(action);
      if (useDocumentStore.getState().dirty) {
        return;
      }
      void finishPendingFileAction(action);
    },
    [finishPendingFileAction],
  );

  const cancelPendingFileAction = useCallback((): void => {
    pendingActionRef.current = null;
    setPendingFileAction(null);
    void api?.cancelClose().catch((error) => {
      setFileActionError(toFileActionError(error));
    });
  }, [api]);

  const saveAndContinue = useCallback(async (): Promise<void> => {
    const action = pendingActionRef.current;
    if (!action || lifecycleRef.current.busy) return;

    const saved = await saveDocument();
    if (saved && pendingActionRef.current === action) {
      await finishPendingFileAction(action);
    }
  }, [finishPendingFileAction, saveDocument]);

  const handleModeChange = useCallback(
    (nextMode: EditorMode): void => {
      // 规范 9.2：应用以未命名空文档启动；从欢迎页切换编辑模式时
      // 先落一个未命名文档，再进入目标模式。
      const state = useDocumentStore.getState();
      if (state.filePath === null && !state.dirty) {
        createUntitledDocument();
      }
      transitionMode(nextMode);
    },
    [createUntitledDocument, transitionMode],
  );

  const handleMenuCommand = useCallback(
    (command: MenuCommand) => {
      if (
        lifecycleRef.current.busy ||
        pendingActionRef.current ||
        fileCollision !== null ||
        recoveryDraft !== null
      ) {
        return;
      }
      if (command === "new") requestFileAction({ type: "new" });
      else if (command === "open") requestFileAction({ type: "open" });
      else if (command === "save") void saveDocument();
      else if (command === "save-as") void saveDocumentAs();
      else if (command === "export-html") void exportDocument();
      else if (command === "toggle-source") handleModeChange("source");
      else if (command === "toggle-read") handleModeChange("read");
      else if (command === "toggle-wysiwyg") handleModeChange("wysiwyg");
    },
    [
      exportDocument,
      fileCollision,
      handleModeChange,
      openDocument,
      recoveryDraft,
      requestFileAction,
      saveDocument,
      saveDocumentAs,
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
        setExternalFileChange(event.path);
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

  // 欢迎页在干净且未进入编辑会话时显示；切换模式会建立未命名编辑会话
  // （规范 9.2），而“新建”始终回到欢迎页。
  const showWelcome =
    filePath === null && !dirty && !editorEngaged;
  const modalNoticeVisible =
    fileCollision !== null || recoveryDraft !== null;
  const closeProtectionVisible =
    pendingFileAction !== null && dirty && !modalNoticeVisible;
  const pendingRestoreView = restoreDraftViewRef.current;
  const restoredCursor =
    pendingRestoreView && pendingRestoreView.mode === mode
      ? pendingRestoreView.cursor
      : 0;

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const shouldInertBackground =
      fileBusy || closeProtectionVisible || modalNoticeVisible;
    if (shouldInertBackground) {
      if (
        !restoreFocusRef.current &&
        document.activeElement instanceof HTMLElement &&
        shell.contains(document.activeElement)
      ) {
        restoreFocusRef.current = document.activeElement;
      }
      shell.setAttribute("inert", "");
    } else {
      shell.removeAttribute("inert");
      const restoreFocus = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (restoreFocus?.isConnected) restoreFocus.focus();
    }
  }, [fileBusy, closeProtectionVisible, modalNoticeVisible]);

  return (
    <>
      <main
        ref={shellRef}
        className="app-shell"
        data-testid="app-shell"
        aria-busy={
          fileBusy || closeProtectionVisible || modalNoticeVisible
            ? "true"
            : "false"
        }
        aria-live="polite"
      >
      <EditorViewContext.Provider value={editorView}>
        <SetEditorViewContext.Provider value={setEditorView}>
          <SetEditorSelectionContext.Provider value={setSelectionPosition}>
            <Toolbar />
            <ViewBar
              mode={mode}
              themePreference={themePreference}
              onModeChange={handleModeChange}
              onThemeChange={setThemePreference}
              onNewDocument={() => requestFileAction({ type: "new" })}
              onOpenDocument={() => requestFileAction({ type: "open" })}
              onSaveDocument={() => void saveDocument()}
              onSaveDocumentAs={() => void saveDocumentAs()}
              fileBusy={fileBusy}
              actionPending={pendingFileAction !== null}
            />
            <div className="workspace" data-testid="workspace" ref={workspaceRef}>
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
                {externalFileChange !== null &&
                    externalFileChange === filePath ? (
                  <div
                    className="file-changed-notice"
                    role="status"
                    data-testid="file-changed-notice"
                  >
                    <span>文件已在其他程序中修改，保存前会进行冲突检查。</span>
                    <button
                      type="button"
                      className="mode-button"
                      data-testid="file-changed-reload"
                      disabled={fileBusy}
                      onClick={() => {
                        if (useDocumentStore.getState().dirty) {
                          setFileCollision(externalFileChange);
                        } else {
                          void reloadFromDisk();
                        }
                      }}
                    >
                      重新加载
                    </button>
                  </div>
                ) : null}
                {showWelcome ? (
                  <WelcomeView
                    recentFiles={recentFiles}
                    fileBusy={fileBusy || pendingFileAction !== null}
                    onNewDocument={() => {
                      // 欢迎页的“新建文档”直接进入编辑器开始写作；
                      // 视图栏的“新建”则保持在欢迎页。
                      requestFileAction({ type: "new" });
                      useDocumentStore.getState().beginEditorSession();
                    }}
                    onOpenDocument={() => requestFileAction({ type: "open" })}
                    onOpenRecentFile={(path) =>
                      requestFileAction({ type: "open", path })}
                    onClearRecentFiles={clearRecentFiles}
                  />
                ) : mode === "wysiwyg" ? (
                  <WysiwygEditor
                    initialDoc={doc}
                    initialCursor={restoredCursor}
                    sessionKey={sessionKey}
                    onChange={handleDocumentChange}
                  />
                ) : mode === "source" ? (
                  <SourceEditor
                    initialValue={sourceText}
                    initialCursor={restoredCursor}
                    sessionKey={sessionKey}
                    onChange={handleSourceChange}
                    onSelectionChange={setSourceCursorPosition}
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
      {closeProtectionVisible ? (
        <CloseProtectionDialog
          busy={fileBusy}
          fileName={fileName}
          onSave={() => void saveAndContinue()}
          onDiscard={() => void finishPendingFileAction(pendingFileAction)}
          onCancel={cancelPendingFileAction}
        />
      ) : null}
      {recoveryDraft !== null ? (
        <RecoveryDialog
          draft={recoveryDraft}
          onRestore={() => void restoreRecoveryDraft(recoveryDraft)}
          onSkip={skipRecoveryDraft}
        />
      ) : null}
      {fileCollision !== null ? (
        <FileCollisionDialog
          fileName={fileName}
          busy={fileBusy}
          onOverwrite={() => void resolveFileCollision("overwrite")}
          onReload={() => void resolveFileCollision("reload")}
          onSaveAs={() => void resolveFileCollision("save-as")}
          onCancel={() => setFileCollision(null)}
        />
      ) : null}
    </>
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
  onOpenDocument(): void;
  onSaveDocument(): void;
  onSaveDocumentAs(): void;
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
                    aria-disabled={file.exists ? undefined : "true"}
                    disabled={fileBusy}
                    onClick={() => {
                      if (file.exists) onOpenRecentFile(file.path);
                    }}
                  >
                    <span className="recent-file-name">{file.name}</span>
                    <span className="recent-file-path">{file.path}</span>
                  </button>
                  {!file.exists ? (
                    <span
                      className="recent-file-missing"
                      role="status"
                      data-testid="recent-file-missing"
                    >
                      文件不存在
                    </span>
                  ) : null}
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
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = dialog.querySelector<HTMLButtonElement>(
      "button:not([disabled])",
    );
    (focusable ?? dialog).focus();

    const handleKeyDown = (event: KeyboardEvent): void => {
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
  }, []);

  return (
    <div
      className="dialog-backdrop"
      data-testid="close-protection-backdrop"
    >
      <div
        ref={dialogRef}
        className="close-protection-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="close-protection-title"
        aria-describedby="close-protection-description"
        data-testid="close-protection-dialog"
        tabIndex={-1}
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
            disabled={busy}
            onClick={onCancel}
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

function RecoveryDialog({
  draft,
  onRestore,
  onSkip,
}: {
  draft: RecoveryDraft;
  onRestore(): void;
  onSkip(): void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  return (
    <div className="dialog-backdrop" data-testid="recovery-backdrop">
      <div
        ref={dialogRef}
        className="app-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="recovery-title"
        aria-describedby="recovery-description"
        data-testid="recovery-dialog"
        tabIndex={-1}
      >
        <h2 id="recovery-title">检测到未保存的恢复草稿</h2>
        <p id="recovery-description">
          上次编辑“{draft.fileName}”时可能未正常退出。是否恢复未保存的内容？
        </p>
        <div className="dialog-actions" role="group" aria-label="恢复草稿操作">
          <button
            type="button"
            className="primary-dialog-button"
            data-testid="recovery-restore"
            autoFocus
            onClick={onRestore}
          >
            恢复内容
          </button>
          <button
            type="button"
            data-testid="recovery-discard"
            onClick={onSkip}
          >
            放弃草稿
          </button>
        </div>
      </div>
    </div>
  );
}

function FileCollisionDialog({
  fileName,
  busy,
  onOverwrite,
  onReload,
  onSaveAs,
  onCancel,
}: {
  fileName: string;
  busy: boolean;
  onOverwrite(): void;
  onReload(): void;
  onSaveAs(): void;
  onCancel(): void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  return (
    <div className="dialog-backdrop" data-testid="file-collision-backdrop">
      <div
        ref={dialogRef}
        className="app-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="file-collision-title"
        aria-describedby="file-collision-description"
        data-testid="file-collision-dialog"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            onCancel();
          }
        }}
      >
        <h2 id="file-collision-title">文件已被外部修改</h2>
        <p id="file-collision-description">
          “{fileName}”在磁盘上的内容已变化。请选择如何处理本地未保存的更改。
        </p>
        <div className="dialog-actions" role="group" aria-label="冲突处理操作">
          <button
            type="button"
            className="primary-dialog-button"
            data-testid="file-collision-overwrite"
            disabled={busy}
            autoFocus
            onClick={onOverwrite}
          >
            覆盖外部版本
          </button>
          <button
            type="button"
            data-testid="file-collision-reload"
            disabled={busy}
            onClick={onReload}
          >
            重新加载文件
          </button>
          <button
            type="button"
            data-testid="file-collision-save-as"
            disabled={busy}
            onClick={onSaveAs}
          >
            另存为新文件
          </button>
          <button
            type="button"
            data-testid="file-collision-cancel"
            disabled={busy}
            onClick={onCancel}
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
