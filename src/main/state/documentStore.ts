import { Node } from "prosemirror-model";
import { create } from "zustand";
import { parseMarkdown } from "../../markdown/parser";
import { serializeMarkdown } from "../../markdown/serializer";

export type EditorMode = "wysiwyg" | "source";
export type ThemePreference = "light" | "dark" | "system";
export type ModeTransitionErrorKind = "parse" | "serialize";

export interface ModeTransitionError {
  kind: ModeTransitionErrorKind;
  message: string;
}

export interface DocumentStoreState {
  filePath: string | null;
  fileName: string;
  doc: Node;
  dirty: boolean;
  mode: EditorMode;
  sourceText: string;
  modeTransitionError: ModeTransitionError | null;
  sessionKey: string;
  sessionGeneration: number;
  /** 用户是否已显式进入某个编辑会话（切换模式/打开文件/恢复草稿）。 */
  editorEngaged: boolean;
  themePreference: ThemePreference;
  setDocument(doc: Node, dirty?: boolean): void;
  setMode(mode: EditorMode): void;
  setSourceText(sourceText: string, dirty?: boolean): void;
  transitionMode(mode: EditorMode): void;
  replaceDocument(replacement: {
    doc: Node;
    filePath: string | null;
    fileName: string;
    dirty?: boolean;
  }): void;
  saveAs(path: string, name: string): void;
  setFile(path: string | null, name: string): void;
  markSaved(): void;
  setThemePreference(themePreference: ThemePreference): void;
  /** 从欢迎页显式开始写作（“新建文档”大按钮）。 */
  beginEditorSession(): void;
}

const initialDoc = parseMarkdown("");
const initialSourceText = serializeMarkdown(initialDoc);

function transitionDocumentState(
  state: Pick<
    DocumentStoreState,
    "doc" | "mode" | "sourceText" | "modeTransitionError"
  >,
  nextMode: EditorMode,
): Partial<DocumentStoreState> {
  if (state.mode === nextMode) return {};

  if (nextMode === "source") {
    try {
      return {
        mode: nextMode,
        sourceText: serializeMarkdown(state.doc),
        modeTransitionError: null,
        editorEngaged: true,
      };
    } catch {
      return {
        mode: state.mode,
            modeTransitionError: {
              kind: "serialize",
              message: "Markdown 序列化失败",
            },
      };
    }
  }

  if (state.mode === "source") {
    try {
      return {
        mode: nextMode,
        doc: parseMarkdown(state.sourceText),
        modeTransitionError: null,
        editorEngaged: true,
      };
    } catch {
      return {
        mode: "source",
            modeTransitionError: {
              kind: "parse",
              message: "Markdown 解析失败",
            },
      };
    }
  }

  return { mode: nextMode, modeTransitionError: null, editorEngaged: true };
}

export const useDocumentStore = create<DocumentStoreState>((set) => ({
  filePath: null,
  fileName: "未命名.md",
  doc: initialDoc,
  dirty: false,
  mode: "wysiwyg",
  sourceText: initialSourceText,
  modeTransitionError: null,
  sessionKey: "session-0",
  sessionGeneration: 0,
  editorEngaged: false,
  // 默认浅色；用户选择经主进程持久化，启动时回灌（App 挂载阶段）。
  themePreference: "light",
  setDocument: (doc, dirty = true) =>
    set((state) => (state.mode === "source" ? {} : { doc, dirty })),
  setMode: (mode) =>
    set((state) => transitionDocumentState(state, mode)),
  setSourceText: (sourceText, dirty = true) =>
    set({ sourceText, dirty, modeTransitionError: null }),
  transitionMode: (nextMode) =>
    set((state) => transitionDocumentState(state, nextMode)),
  replaceDocument: ({ doc, filePath, fileName, dirty = false }) =>
    set((state) => {
      const sessionGeneration = state.sessionGeneration + 1;
      return {
        doc,
        filePath,
        fileName,
        dirty,
        sourceText: serializeMarkdown(doc),
        modeTransitionError: null,
        sessionGeneration,
        sessionKey: `session-${sessionGeneration}`,
        // 新文档会话默认回到欢迎页；恢复草稿等显式进入编辑的路径
        // 通过 dirty/filePath/mode 切换自然隐藏欢迎页。
        editorEngaged: false,
      };
    }),
  saveAs: (filePath, fileName) => set({ filePath, fileName }),
  setFile: (filePath, fileName) => set({ filePath, fileName }),
  markSaved: () => set({ dirty: false }),
  setThemePreference: (themePreference) => set({ themePreference }),
  beginEditorSession: () => set({ editorEngaged: true }),
}));
