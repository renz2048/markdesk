import { useContext, useEffect, useRef } from "react";
import { baseKeymap } from "prosemirror-commands";
import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";
import { history, historyKeymap } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import type { Node } from "prosemirror-model";
import { EditorState, Plugin } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { markdownSchema } from "../../markdown/schema";
import { formattingKeymap } from "../editor/commands";
import { SetEditorSelectionContext, SetEditorViewContext } from "./Toolbar";

interface Props {
  initialDoc: Node;
  sessionKey: string;
  onChange(doc: Node): void;
}

export function createEditorPlugins(): Plugin[] {
  return [
    history(),
    keymap(historyKeymap),
    keymap(formattingKeymap),
    keymap(baseKeymap),
    dropCursor(),
    gapCursor(),
  ];
}

export function WysiwygEditor({ initialDoc, sessionKey, onChange }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onChangeRef = useRef(onChange);
  const setEditorSelection = useContext(SetEditorSelectionContext);
  const setEditorView = useContext(SetEditorViewContext);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const state = EditorState.create({
      schema: markdownSchema,
      doc: initialDoc,
      plugins: createEditorPlugins(),
    });
    const view = new EditorView(host, {
      state,
      attributes: {
        "aria-label": "Markdown 富文本编辑区",
        "data-testid": "wysiwyg-editor-content",
        spellcheck: "true",
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
