import { createContext } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { EditorView } from "prosemirror-view";

// 编辑器视图桥：WysiwygEditor 挂载后把 ProseMirror 视图上报给应用
// 外层（App 用于大纲跳转等），外层不再渲染格式工具栏。
export const EditorViewContext = createContext<EditorView | null>(null);
export const SetEditorViewContext = createContext<
  Dispatch<SetStateAction<EditorView | null>> | null
>(null);
export const SetEditorSelectionContext = createContext<
  ((position: number) => void) | null
>(null);
