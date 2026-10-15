import { Node } from "prosemirror-model";
import { create } from "zustand";
import { parseMarkdown } from "../../markdown/parser";
import { serializeMarkdown } from "../../markdown/serializer";

export type EditorMode = "wysiwyg" | "source" | "read";
export type ThemePreference = "light" | "dark" | "system";

export interface DocumentStoreState {
  filePath: string | null;
  fileName: string;
  doc: Node;
  dirty: boolean;
  mode: EditorMode;
  sourceText: string;
  sourceParseError: string | null;
  sessionKey: string;
  sessionGeneration: number;
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
}

const initialDoc = parseMarkdown("");
const initialSourceText = serializeMarkdown(initialDoc);

function transitionDocumentState(
  state: Pick<
    DocumentStoreState,
    "doc" | "mode" | "sourceText" | "sourceParseError"
  >,
  nextMode: EditorMode,
): Partial<DocumentStoreState> {
  if (state.mode === nextMode) return {};

  if (nextMode === "source") {
    try {
      return {
        mode: nextMode,
        sourceText: serializeMarkdown(state.doc),
        sourceParseError: null,
      };
    } catch {
      return {
        mode: state.mode,
        sourceParseError: "Markdown 序列化失败",
      };
    }
  }

  if (state.mode === "source") {
    try {
      return {
        mode: nextMode,
        doc: parseMarkdown(state.sourceText),
        sourceParseError: null,
      };
    } catch {
      return {
        mode: "source",
        sourceParseError: "Markdown 解析失败",
      };
    }
  }

  return { mode: nextMode, sourceParseError: null };
}

export const useDocumentStore = create<DocumentStoreState>((set) => ({
  filePath: null,
  fileName: "未命名.md",
  doc: initialDoc,
  dirty: false,
  mode: "wysiwyg",
  sourceText: initialSourceText,
  sourceParseError: null,
  sessionKey: "session-0",
  sessionGeneration: 0,
  themePreference: "system",
  setDocument: (doc, dirty = true) => set({ doc, dirty }),
  setMode: (mode) =>
    set((state) => transitionDocumentState(state, mode)),
  setSourceText: (sourceText, dirty = true) =>
    set({ sourceText, dirty, sourceParseError: null }),
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
        sourceParseError: null,
        sessionGeneration,
        sessionKey: `session-${sessionGeneration}`,
      };
    }),
  saveAs: (filePath, fileName) => set({ filePath, fileName }),
  setFile: (filePath, fileName) => set({ filePath, fileName }),
  markSaved: () => set({ dirty: false }),
  setThemePreference: (themePreference) => set({ themePreference }),
}));
