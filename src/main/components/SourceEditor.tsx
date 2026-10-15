import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { EditorState } from "@codemirror/state";
import { EditorView, basicSetup } from "codemirror";
import { useEffect, useRef } from "react";

interface Props {
  initialValue: string;
  sessionKey: string;
  onChange(value: string): void;
}

export function SourceEditor({ initialValue, sessionKey, onChange }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const initialValueRef = useRef(initialValue);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    initialValueRef.current = initialValue;
  }, [initialValue]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const state = EditorState.create({
      doc: initialValueRef.current,
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
