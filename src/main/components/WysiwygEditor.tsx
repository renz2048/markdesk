import { useContext, useEffect, useRef } from "react";
import { baseKeymap } from "prosemirror-commands";
import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";
import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import type { Node } from "prosemirror-model";
import { EditorState, Plugin, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { markdownSchema } from "../../markdown/schema";
import { formattingKeymap } from "../editor/commands";
import { SetEditorSelectionContext, SetEditorViewContext } from "./Toolbar";

interface Props {
  initialDoc: Node;
  initialCursor: number;
  sessionKey: string;
  onChange(doc: Node): void;
}

export function createEditorPlugins(): Plugin[] {
  return [
    history(),
    keymap({
      "Mod-z": undo,
      "Mod-y": redo,
      "Shift-Mod-z": redo,
    }),
    keymap(formattingKeymap),
    keymap(baseKeymap),
    // 说明：曾尝试用 textblockTypeInputRule 让行首输入 “# ” 直接切换
    // 标题，但该规则在本应用的输入管线中未触发（原因未明），已移除；
    // Markdown 结构转换由工具栏命令与源码模式承担。
    dropCursor(),
    gapCursor(),
  ];
}

export function WysiwygEditor({
  initialDoc,
  initialCursor,
  sessionKey,
  onChange,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onChangeRef = useRef(onChange);
  const initialCursorRef = useRef(initialCursor);
  const setEditorSelection = useContext(SetEditorSelectionContext);
  const setEditorView = useContext(SetEditorViewContext);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const clampedCursor = Math.min(
      Math.max(0, initialCursorRef.current),
      initialDoc.content.size,
    );
    const state = EditorState.create({
      schema: markdownSchema,
      doc: initialDoc,
      selection: TextSelection.near(
        initialDoc.resolve(clampedCursor),
        1,
      ),
      plugins: createEditorPlugins(),
    });
    const view = new EditorView(host, {
      state,
      attributes: {
        "aria-label": "Markdown 富文本编辑区",
        "data-testid": "wysiwyg-editor-content",
        // Electron 内置拼写检查只有 en-US 词典，中文与代码标识符会被
        // 整片标红波浪线，对中文文档场景是纯噪音，这里关闭。
        spellcheck: "false",
      },
      dispatchTransaction(transaction) {
        const nextState = view.state.apply(transaction);
        view.updateState(nextState);
        if (transaction.docChanged) onChangeRef.current(nextState.doc);
        if (transaction.selectionSet || transaction.docChanged) {
          setEditorSelection?.(nextState.selection.from);
        }
      },
    });

    setEditorView?.(view);

    return () => {
      setEditorView?.((currentView) =>
        currentView === view ? null : currentView,
      );
      view.destroy();
    };
  }, [sessionKey, setEditorSelection, setEditorView]);

  return (
    <div
      className="editor wysiwyg-editor"
      ref={hostRef}
      data-testid="wysiwyg-editor"
    />
  );
}
