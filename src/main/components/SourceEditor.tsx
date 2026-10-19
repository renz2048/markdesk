import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { EditorState } from "@codemirror/state";
import { EditorView, basicSetup } from "codemirror";
import { useEffect, useRef } from "react";

interface Props {
  initialValue: string;
  sessionKey: string;
  initialCursor: number;
  onChange(value: string): void;
  onSelectionChange(cursor: number): void;
}

export function SourceEditor({
  initialValue,
  sessionKey,
  initialCursor,
  onChange,
  onSelectionChange,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const initialValueRef = useRef(initialValue);
  const initialCursorRef = useRef(initialCursor);
  const onChangeRef = useRef(onChange);
  const onSelectionChangeRef = useRef(onSelectionChange);

  useEffect(() => {
    initialValueRef.current = initialValue;
  }, [initialValue]);

  useEffect(() => {
    onChangeRef.current = onChange;
    onSelectionChangeRef.current = onSelectionChange;
  }, [onChange, onSelectionChange]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const state = EditorState.create({
      doc: initialValueRef.current,
      selection: {
        anchor: Math.min(
          Math.max(0, initialCursorRef.current),
          initialValueRef.current.length,
        ),
      },
      extensions: [
        basicSetup,
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          "aria-label": "Markdown 源代码编辑区",
          "data-testid": "source-editor-content",
          spellcheck: "false",
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
          if (update.docChanged || update.selectionSet) {
            onSelectionChangeRef.current(
              update.state.selection.main.head,
            );
          }
        }),
      ],
    });
    const view = new EditorView({ parent: host, state });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [sessionKey]);

  return (
    <div
      className="editor source-editor"
      ref={hostRef}
      data-testid="source-editor"
      data-session-key={sessionKey}
    />
  );
}
