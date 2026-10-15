import { Node } from "prosemirror-model";
import { create } from "zustand";
import { parseMarkdown } from "../../markdown/parser";

export type EditorMode = "wysiwyg" | "source" | "read";

export interface DocumentStoreState {
  filePath: string | null;
  fileName: string;
  doc: Node;
  dirty: boolean;
  mode: EditorMode;
  sessionKey: string;
  sessionGeneration: number;
  setDocument(doc: Node, dirty?: boolean): void;
  setMode(mode: EditorMode): void;
  replaceDocument(replacement: {
    doc: Node;
    filePath: string | null;
    fileName: string;
    dirty?: boolean;
  }): void;
  saveAs(path: string, name: string): void;
  setFile(path: string | null, name: string): void;
  markSaved(): void;
}

const initialDoc = parseMarkdown("");

export const useDocumentStore = create<DocumentStoreState>((set) => ({
  filePath: null,
  fileName: "未命名.md",
  doc: initialDoc,
  dirty: false,
  mode: "wysiwyg",
  sessionKey: "session-0",
  sessionGeneration: 0,
  setDocument: (doc, dirty = true) => set({ doc, dirty }),
  setMode: (mode) => set({ mode }),
  replaceDocument: ({ doc, filePath, fileName, dirty = false }) =>
    set((state) => {
      const sessionGeneration = state.sessionGeneration + 1;
      return {
        doc,
        filePath,
        fileName,
        dirty,
        sessionGeneration,
        sessionKey: `session-${sessionGeneration}`,
      };
    }),
  saveAs: (filePath, fileName) => set({ filePath, fileName }),
  setFile: (filePath, fileName) => set({ filePath, fileName }),
  markSaved: () => set({ dirty: false }),
}));
