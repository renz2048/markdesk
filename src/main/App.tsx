import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { EditorView } from "prosemirror-view";
import { TextSelection } from "prosemirror-state";
import type { Command } from "prosemirror-state";
import {
  clearFormatting,
  demoteHeading,
  insertHorizontalRule,
  insertImage,
  insertTable,
  promoteHeading,
  setBlockquote,
  setCodeBlock,
  setHeading,
  setParagraph,
  toggleBulletList,
  toggleMarkByName,
  toggleOrderedList,
  toggleTaskList,
} from "./editor/commands";
import { parseMarkdown } from "../markdown/parser";
import { serializeMarkdown } from "../markdown/serializer";
import { editorImageSrc, isLocalAbsolutePath } from "../markdown/schema";
import { ImageViewer, imageViewerTarget } from "./components/ImageViewer";
import {
  EditorViewContext,
  SetEditorSelectionContext,
  SetEditorViewContext,
} from "./components/EditorContexts";
import { OutlinePanel } from "./components/OutlinePanel";
import { ReadView } from "./components/ReadView";
import { SourceEditor } from "./components/SourceEditor";
import { StatusBar } from "./components/StatusBar";
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
  PandocExportTargetName,
  RecentFileStatus,
  RecoveryDraft,
  RecoveryDraftInput,
} from "../shared/types";
import { localImageExtensions } from "../shared/types";
import type { Node as ProseMirrorNode } from "prosemirror-model";

type PendingFileAction =
  | { type: "new" }
  | { type: "open"; path?: string }
  | { type: "close" };

const DRAFT_SAVE_DELAY_MS = 500;

// 侧栏宽度可拖拽调节，并在本地记忆（Typora 也记忆侧栏宽度）。
// 默认宽度约为旧版 250px 的五分之三（需求 4.1）。
const OUTLINE_WIDTH_STORAGE_KEY = "markdesk:outline-width";
const OUTLINE_MIN_WIDTH = 120;
const OUTLINE_MAX_WIDTH = 480;
const OUTLINE_DEFAULT_WIDTH = 150;

function loadOutlineWidth(): number {
  const stored = window.localStorage.getItem(OUTLINE_WIDTH_STORAGE_KEY);
  if (stored === null) return OUTLINE_DEFAULT_WIDTH;
  const value = Number(stored);
  if (!Number.isFinite(value)) return OUTLINE_DEFAULT_WIDTH;
  return Math.min(
    Math.max(Math.round(value), OUTLINE_MIN_WIDTH),
    OUTLINE_MAX_WIDTH,
  );
}

// 粘贴图片兜底内嵌的大小上限（原始字节）：base64 放大约 4/3，
// 需给 10MB 文档上限留出余量。
const MAX_EMBEDDED_IMAGE_BYTES = 2 * 1024 * 1024;

const imageTypeExtensions = new Map<string, string>([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/avif", "avif"],
]);

// 为粘贴的图片生成资源文件名：优先保留资源管理器复制带来的原始名，
// 截图等无名文件退回时间戳名。类型不在写入白名单（如 SVG）时返回
// null，由调用方直接降级内嵌。主进程会再做一次权威校验。
function pastedImageName(file: File): string | null {
  const extension = imageTypeExtensions.get(file.type);
  if (!extension) return null;
  const name = file.name ?? "";
  if (
    name.length > 0 &&
    name.length <= 200 &&
    !/[/\\]/u.test(name) &&
    !/[\0-\x1f\u007f<>:"|?*]/u.test(name) &&
    !/[. ]$/u.test(name) &&
    /\.(?:png|jpe?g|gif|webp|avif)$/iu.test(name)
  ) {
    return name;
  }
  const now = new Date();
  const pad = (value: number): string => `${value}`.padStart(2, "0");
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
    now.getDate(),
  )}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `paste-${timestamp}.${extension}`;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      resolve(typeof reader.result === "string" ? reader.result : "");
    });
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

interface DraftQueueState {
  queue: Promise<void>;
  version: number;
  activeKey: string | null;
}


// 原生菜单「格式/段落」命令到 ProseMirror 命令的映射，仅在
// 所见即所得模式下生效（源码/阅读模式没有富文本命令可应用）。
const menuFormattingCommands: Partial<Record<MenuCommand, Command>> = {
  "format-bold": toggleMarkByName("strong"),
  "format-italic": toggleMarkByName("em"),
  "format-strikethrough": toggleMarkByName("strikethrough"),
  "format-code": toggleMarkByName("code"),
  "format-clear": clearFormatting(),
  "paragraph-paragraph": setParagraph(),
  "paragraph-heading-1": setHeading(1),
  "paragraph-heading-2": setHeading(2),
  "paragraph-heading-3": setHeading(3),
  "paragraph-heading-4": setHeading(4),
  "paragraph-heading-5": setHeading(5),
  "paragraph-heading-6": setHeading(6),
  "paragraph-heading-promote": promoteHeading(),
  "paragraph-heading-demote": demoteHeading(),
  "paragraph-quote": setBlockquote(),
  "paragraph-code-block": setCodeBlock(),
  "paragraph-bullet-list": toggleBulletList(),
  "paragraph-ordered-list": toggleOrderedList(),
  "paragraph-task-list": toggleTaskList(),
  "paragraph-horizontal-rule": insertHorizontalRule(),
  "paragraph-table": insertTable(),
};

// Pandoc 导出目标（主进程转换；未安装 Pandoc 时报错提示）。
const pandocExportTargets = new Set<string>([
  "docx",
  "odt",
  "epub",
  "latex",
  "mediawiki",
]);

const isPandocTarget = (
  format: string,
): format is PandocExportTargetName => pandocExportTargets.has(format);

const menuThemeCommands: Partial<
  Record<MenuCommand, ThemePreference>
> = {
  "theme-light": "light",
  "theme-dark": "dark",
  "theme-system": "system",
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

function hasLocalImageExtension(src: string): boolean {
  const dot = src.lastIndexOf(".");
  if (dot < 0 || dot === src.length - 1) return false;
  return localImageExtensions.has(src.slice(dot + 1).toLowerCase());
}

/** 拆出文件名与所在目录（两种分隔符都接受），用于授权清单展示。 */
function splitLocalImagePath(src: string): { name: string; directory: string } {
  const index = Math.max(src.lastIndexOf("/"), src.lastIndexOf("\\"));
  if (index < 0) return { name: src, directory: "" };
  return { name: src.slice(index + 1), directory: src.slice(0, index) };
}

/**
 * 收集文档中引用的、位于文档目录外的本地绝对路径图片（需要用户
 * 显式授权后 markdesk-resource 协议才会放行）。
 */
function collectLocalImageSrcs(doc: ProseMirrorNode): string[] {
  const srcs: string[] = [];
  const seen = new Set<string>();
  doc.descendants((node) => {
    if (node.type.name !== "image") return true;
    const src = String(node.attrs.src ?? "");
    if (!isLocalAbsolutePath(src) || seen.has(src)) return true;
    if (!hasLocalImageExtension(src)) return true;
    seen.add(src);
    srcs.push(src);
    return true;
  });
  return srcs;
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
  // 需求 5.2：模式切换前记录滚动比例（各模式文档高度不同，像素值不可
  // 直接复用），切换后按比例恢复，避免视图回到顶部。
  const modeViewRatioRef = useRef<{
    ratio: number;
    targetMode: EditorMode;
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
  const [imageViewer, setImageViewer] = useState<{
    src: string;
    alt: string;
  } | null>(null);
  // 文档引用了未授权的目录外本地图片时向用户询问（打开文档时检测）。
  const [pendingLocalImages, setPendingLocalImages] = useState<string[]>([]);
  const [outlineWidth, setOutlineWidth] = useState(loadOutlineWidth);
  const [sidebarVisible, setSidebarVisible] = useState(true);

  // 拖拽分隔条调节侧栏宽度：指针捕获保证移出元素仍持续跟踪。
  const startOutlineResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      let latestWidth = outlineWidth;
      const onMove = (moveEvent: PointerEvent): void => {
        latestWidth = Math.min(
          Math.max(Math.round(moveEvent.clientX), OUTLINE_MIN_WIDTH),
          OUTLINE_MAX_WIDTH,
        );
        setOutlineWidth(latestWidth);
      };
      const finish = (): void => {
        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", finish);
        target.removeEventListener("pointercancel", finish);
        window.localStorage.setItem(
          OUTLINE_WIDTH_STORAGE_KEY,
          String(latestWidth),
        );
      };
      target.addEventListener("pointermove", onMove);
      target.addEventListener("pointerup", finish);
      target.addEventListener("pointercancel", finish);
    },
    [outlineWidth],
  );

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

  useEffect(() => {
    const pending = modeViewRatioRef.current;
    if (!pending) return;
    // 只在真正切换到目标模式时消费；切换被拒绝（模式未变）则丢弃，
    // 防止陈旧比例作用到之后打开的文档上。
    modeViewRatioRef.current = null;
    if (pending.targetMode !== mode) return;
    const workspace = workspaceRef.current;
    if (!workspace) return;
    // 新模式的 .editor 刚挂载（源码模式的 CodeMirror 还要异步测量），
    // 分帧多次应用才能拿到最终 scrollHeight。
    const apply = (): void => {
      const editor = workspace.querySelector<HTMLElement>(".editor");
      if (!editor) return;
      const scrollRange = editor.scrollHeight - editor.clientHeight;
      if (scrollRange > 0) editor.scrollTop = pending.ratio * scrollRange;
    };
    const raf = requestAnimationFrame(apply);
    const timers = [60, 200].map((delay) => window.setTimeout(apply, delay));
    return () => {
      cancelAnimationFrame(raf);
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [mode, sessionKey]);

  // 打开文档（sessionKey 变化）时检测目录外的本地绝对路径图片：
  // 已授权的直接显示，未授权的询问用户一次（授权持久化在主进程，
  // 跨会话记忆；拒绝仅本次不显示，下次打开再询问）。
  useEffect(() => {
    const srcs = collectLocalImageSrcs(useDocumentStore.getState().doc);
    if (srcs.length === 0 || !api) {
      setPendingLocalImages([]);
      return undefined;
    }
    let cancelled = false;
    void api
      .checkImageGrants(srcs)
      .then((missing) => {
        if (!cancelled) setPendingLocalImages(missing);
      })
      .catch(() => {
        // 查询失败不阻塞编辑，图片保持阻止状态。
      });
    return () => {
      cancelled = true;
    };
  }, [api, sessionKey]);

  // 图片此前已被资源协议拒绝（403）；对 absolute/ 形式的 img 重新赋值
  // src 触发重载，无需重建编辑器。指定 onlySrc 时只刷新那一张。
  const refreshAbsoluteImages = useCallback((onlySrc?: string): void => {
    requestAnimationFrame(() => {
      const shell = shellRef.current;
      if (!shell) return;
      const wanted =
        onlySrc === undefined ? null : editorImageSrc(onlySrc);
      for (const img of shell.querySelectorAll<HTMLImageElement>(
        'img[src^="markdesk-resource:absolute/"]',
      )) {
        if (wanted === null || img.getAttribute("src") === wanted) {
          img.setAttribute("src", img.getAttribute("src") ?? "");
        }
      }
    });
  }, []);

  const allowLocalImages = useCallback(async (): Promise<void> => {
    const srcs = pendingLocalImages;
    if (!api || srcs.length === 0) return;
    try {
      await api.grantImagePaths(srcs);
    } catch (error) {
      setFileActionError(toFileActionError(error));
      return;
    }
    setPendingLocalImages([]);
    refreshAbsoluteImages();
  }, [api, pendingLocalImages, refreshAbsoluteImages]);

  /** 允许单张图片：从清单移除并只刷新该图。 */
  const allowLocalImage = useCallback(
    async (src: string): Promise<void> => {
      if (!api) return;
      try {
        await api.grantImagePaths([src]);
      } catch (error) {
        setFileActionError(toFileActionError(error));
        return;
      }
      setPendingLocalImages((pending) =>
        pending.filter((item) => item !== src),
      );
      refreshAbsoluteImages(src);
    },
    [api, refreshAbsoluteImages],
  );

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

  // 主题选择移入原生菜单（单选状态），渲染端变更后同步主进程。
  useEffect(() => {
    void api?.setThemePreference(themePreference).catch(() => {
      // 菜单勾选状态同步失败不影响实际主题生效。
    });
  }, [api, themePreference]);

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

  // 事件委托：双击编辑区/阅读区中的图片打开原图查看浮层（源码模式没有
  // 渲染图片，无需处理）。
  const handleWorkspaceDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const target = imageViewerTarget(event.target);
      if (target) {
        event.preventDefault();
        setImageViewer(target);
      }
    },
    [],
  );

  // 粘贴图片：默认经主进程写入文档目录的 assets/ 并插入相对路径；
  // 文档未保存、类型不可落盘或写入失败时降级为 base64 内嵌。
  const handlePasteImage = useCallback(
    async (file: File): Promise<string | null> => {
      const reportTooLarge = (): null => {
        setFileActionError(
          toFileActionError(
            new Error(
              "file-too-large\n图片过大：无法写入文档目录，且超过可内嵌的大小上限。",
            ),
          ),
        );
        return null;
      };
      const embed = async (): Promise<string | null> => {
        if (file.size > MAX_EMBEDDED_IMAGE_BYTES) return reportTooLarge();
        return fileToDataUrl(file);
      };

      const docPath = useDocumentStore.getState().filePath;
      const fileName = docPath && pastedImageName(file);
      if (!api || !docPath || !fileName) return embed();
      try {
        const asset = await api.savePastedImage(
          docPath,
          fileName,
          await file.arrayBuffer(),
        );
        return asset.relativeSrc;
      } catch {
        // 目录只读或写入失败 → 降级内嵌。
        return embed();
      }
    },
    [api],
  );

  const jumpToHeading = useCallback(
    (pos: number) => {
      if (!editorView) return;

      const resolvedPos = editorView.state.doc.resolve(
        Math.min(pos, editorView.state.doc.content.size),
      );
      const selection = TextSelection.near(resolvedPos, 1);
      editorView.dispatch(editorView.state.tr.setSelection(selection));
      // scrollIntoView 只保证目标可见，标题会停在视口下缘；这里改为把
      // 标题滚到视口顶部（留少量呼吸间距），与 Typora 的目录跳转一致。
      const scroller = editorView.dom.closest<HTMLElement>(".editor");
      if (scroller) {
        const { top } = editorView.coordsAtPos(selection.from);
        scroller.scrollTop += top - scroller.getBoundingClientRect().top - 8;
      }
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

  // 导出：HTML 直接写文件；PDF/PNG 由主进程在隐藏窗口中渲染导出；
  // Word/OpenOffice/Epub/LaTeX/MediaWiki 经系统 Pandoc 转换。
  // 临时文件与文档同目录以解析相对图片路径，未保存文档传 null
  //（其图片此时均为 data URL，任何目录都能渲染）。
  const exportDocument = useCallback(
    async (
      format: "html" | "pdf" | "png" | PandocExportTargetName,
    ): Promise<void> => {
      if (!api) return;
      const revision = lifecycleRef.current.beginOperation();
      if (revision === null) return;

      setFileBusy(true);
      setFileActionError(null);
      try {
        const state = useDocumentStore.getState();
        const baseName = state.fileName.replace(/\.(md|markdown)$/iu, "");
        const savedPath = state.filePath;
        const docDir = savedPath
          ? savedPath.replace(/[\\/][^\\/]+$/u, "")
          : null;

        if (isPandocTarget(format)) {
          // Pandoc 目标：以 Markdown 文本为源。
          const markdown =
            state.mode === "source"
              ? state.sourceText
              : serializeMarkdown(state.doc);
          await api.exportViaPandoc(format, markdown, baseName, docDir);
        } else if (format === "html") {
          const doc = state.mode === "source"
            ? parseMarkdown(state.sourceText)
            : state.doc;
          const target = await api.chooseExportLocation(
            `${baseName}.html`,
          );
          if (!target) return;
          await api.exportHtml(
            target,
            buildExportHtml(doc, resolvedTheme === "dark" ? "dark" : "light"),
          );
        } else {
          const doc = state.mode === "source"
            ? parseMarkdown(state.sourceText)
            : state.doc;
          const html = buildExportHtml(
            doc,
            resolvedTheme === "dark" ? "dark" : "light",
          );
          await api.exportRenderedDocument(
            format,
            html,
            `${baseName}.${format === "pdf" ? "pdf" : "png"}`,
            docDir,
          );
        }
        // 导出是只读的旁路操作：不改变活动文档的脏状态。
      } catch (error) {
        setFileActionError(toFileActionError(error));
      } finally {
        lifecycleRef.current.endOperation();
        setFileBusy(false);
      }
    },
    [api, resolvedTheme],
  );

  // 拖入本地图片（需求 4.5）：已保存文档时由主进程判定路径归属
  //（文档目录内→相对路径；目录外→绝对路径并登记显示授权）；未保存
  // 文档复用粘贴流程内嵌 data URL。
  const handleDropImage = useCallback(
    async (file: File): Promise<string | null> => {
      const docPath = useDocumentStore.getState().filePath;
      let imagePath = "";
      try {
        imagePath = api?.getDroppedFilePath(file) ?? "";
      } catch {
        imagePath = "";
      }
      if (api && docPath && imagePath) {
        try {
          const { src } = await api.insertDroppedImage(docPath, imagePath);
          return src;
        } catch (error) {
          // 路径判定失败（如文档未授权）时降级为内嵌。
          setFileActionError(toFileActionError(error));
          return handlePasteImage(file);
        }
      }
      return handlePasteImage(file);
    },
    [api, handlePasteImage],
  );

  // 「格式 → 图像」：选择图片文件后复用粘贴图片的资产流程
  // （保存文档 → assets/ 相对路径；未保存 → data URL 内嵌）。
  const insertImageFromDialog = useCallback(async (): Promise<void> => {
    if (!api || !editorView || mode !== "wysiwyg") return;
    let picked: { name: string; bytes: ArrayBuffer } | null = null;
    try {
      picked = await api.pickImageAsset();
    } catch (error) {
      setFileActionError(toFileActionError(error));
      return;
    }
    if (!picked) return;
    const file = new File([picked.bytes], picked.name);
    const src = await handlePasteImage(file);
    if (!src) return;
    editorView.focus();
    insertImage(src, picked.name.replace(/\.[^.]+$/u, ""))(
      editorView.state,
      editorView.dispatch,
      editorView,
    );
  }, [api, editorView, handlePasteImage, mode]);

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
      // 需求 5.2：切换前记录当前滚动比例，恢复时按新模式的文档高度折算。
      const container = workspaceRef.current?.querySelector<HTMLElement>(
        ".editor",
      );
      if (container) {
        const scrollRange = container.scrollHeight - container.clientHeight;
        modeViewRatioRef.current = {
          ratio: scrollRange > 0 ? container.scrollTop / scrollRange : 0,
          targetMode: nextMode,
        };
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
      else if (command === "export-html") void exportDocument("html");
      else if (command === "export-pdf") void exportDocument("pdf");
      else if (command === "export-image") void exportDocument("png");
      else if (command === "export-docx") void exportDocument("docx");
      else if (command === "export-odt") void exportDocument("odt");
      else if (command === "export-epub") void exportDocument("epub");
      else if (command === "export-latex") void exportDocument("latex");
      else if (command === "export-mediawiki") {
        void exportDocument("mediawiki");
      }
      else if (command === "toggle-source") handleModeChange("source");
      else if (command === "toggle-read") handleModeChange("read");
      else if (command === "toggle-wysiwyg") handleModeChange("wysiwyg");
      else if (command === "format-image") {
        void insertImageFromDialog();
      } else {
        const theme = menuThemeCommands[command];
        if (theme) {
          setThemePreference(theme);
          return;
        }
        const formatting = menuFormattingCommands[command];
        if (formatting && mode === "wysiwyg" && editorView) {
          editorView.focus();
          formatting(editorView.state, editorView.dispatch, editorView);
        }
      }
    },
    [
      editorView,
      exportDocument,
      fileCollision,
      handleModeChange,
      insertImageFromDialog,
      mode,
      openDocument,
      recoveryDraft,
      requestFileAction,
      saveDocument,
      saveDocumentAs,
      setThemePreference,
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

  // 窗口标题栏（Electron 会把 document.title 同步到原生标题栏）：
  // 欢迎页仅显示应用名；打开的文档为 `文件名 - MarkDesk`，有未保存
  // 修改时在文件名后加一个醒目的圆点；未保存的新建文档显示 `未命名`。
  // 原生标题栏无法加粗局部文字，用最重的圆点字形（●）保证清晰可见。
  useEffect(() => {
    if (showWelcome) {
      document.title = "MarkDesk";
      return;
    }
    const dot = dirty ? "●" : "";
    document.title = filePath === null
      ? `未命名${dot} - MarkDesk`
      : `${fileName}${dot} - MarkDesk`;
  }, [dirty, fileName, filePath, showWelcome]);

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
            <div
              className={`workspace${sidebarVisible ? "" : " sidebar-collapsed"}`}
              data-testid="workspace"
              ref={workspaceRef}
              onDoubleClick={handleWorkspaceDoubleClick}
            >
              {sidebarVisible ? (
                <>
                  <OutlinePanel
                    doc={doc}
                    onJump={jumpToHeading}
                    activePos={activeHeadingPos}
                    disabled={mode !== "wysiwyg"}
                    width={outlineWidth}
                  />
                  <div
                    className="sidebar-resizer"
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="调整侧栏宽度"
                    data-testid="sidebar-resizer"
                    onPointerDown={startOutlineResize}
                  />
                </>
              ) : null}
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
                {pendingLocalImages.length > 0 ? (
                  <div
                    className="file-changed-notice local-images-notice"
                    role="status"
                    data-testid="local-images-notice"
                  >
                    <span>
                      此文档引用了 {pendingLocalImages.length} 张本地图片
                      （位于文档目录外），可逐张或全部允许显示：
                    </span>
                    <ul className="local-images-list">
                      {pendingLocalImages.map((src) => {
                        const { name, directory } = splitLocalImagePath(src);
                        return (
                          <li key={src} data-testid="local-images-item">
                            <span className="local-image-path" title={src}>
                              <strong>{name}</strong>
                              {directory ? ` — ${directory}` : ""}
                            </span>
                            <button
                              type="button"
                              className="mode-button"
                              data-testid="local-images-allow-one"
                              onClick={() => {
                                void allowLocalImage(src);
                              }}
                            >
                              允许
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                    <div className="local-images-actions">
                      <button
                        type="button"
                        className="mode-button"
                        data-testid="local-images-allow"
                        onClick={() => {
                          void allowLocalImages();
                        }}
                      >
                        全部允许
                      </button>
                      <button
                        type="button"
                        className="mode-button"
                        data-testid="local-images-block"
                        onClick={() => setPendingLocalImages([])}
                      >
                        保持阻止
                      </button>
                    </div>
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
                    onPasteImage={handlePasteImage}
                    onDropImage={handleDropImage}
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
                {/* 底栏只占编辑列宽度：侧栏直达窗口底部（Typora 布局）。 */}
                <StatusBar
                  mode={mode}
                  sidebarVisible={sidebarVisible}
                  onToggleSidebar={() =>
                    setSidebarVisible((visible) => !visible)
                  }
                  onToggleSourceMode={() =>
                    handleModeChange(mode === "source" ? "wysiwyg" : "source")
                  }
                />
              </section>
            </div>
          </SetEditorSelectionContext.Provider>
        </SetEditorViewContext.Provider>
      </EditorViewContext.Provider>
        {imageViewer !== null && (
          <ImageViewer
            src={imageViewer.src}
            alt={imageViewer.alt}
            onClose={() => setImageViewer(null)}
          />
        )}
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
