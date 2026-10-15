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
  setDocument(doc: Node, dirty?: boolean): void;
  setMode(mode: EditorMode): void;
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
  setDocument: (doc, dirty = true) => set({ doc, dirty }),
  setMode: (mode) => set({ mode }),
  setFile: (filePath, fileName) => set({ filePath, fileName }),
  markSaved: () => set({ dirty: false }),
}));
