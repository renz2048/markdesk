import { useCallback, useEffect, useMemo, useState } from "react";
import type { EditorView } from "prosemirror-view";
import { TextSelection } from "prosemirror-state";
import { OutlinePanel } from "./components/OutlinePanel";
import {
  EditorViewContext,
  SetEditorSelectionContext,
  SetEditorViewContext,
  Toolbar,
} from "./components/Toolbar";
import { WysiwygEditor } from "./components/WysiwygEditor";
import { activeOutlinePosition, outlineFromDoc } from "./editor/outline";
import { useDocumentStore } from "./state/documentStore";

const modeLabels = {
  wysiwyg: "富文本",
  source: "源代码",
  read: "阅读",
} as const;

export default function App() {
  const doc = useDocumentStore((state) => state.doc);
  const fileName = useDocumentStore((state) => state.fileName);
  const dirty = useDocumentStore((state) => state.dirty);
  const mode = useDocumentStore((state) => state.mode);
  const setDocument = useDocumentStore((state) => state.setDocument);
  const sessionKey = useDocumentStore((state) => state.sessionKey);
  const [editorView, setEditorView] = useState<EditorView | null>(null);

  const [selectionPosition, setSelectionPosition] = useState(0);

  useEffect(() => {
    setSelectionPosition(0);
  }, [sessionKey]);

  const outlineItems = useMemo(() => outlineFromDoc(doc), [doc]);
  const activeHeadingPos = useMemo(
    () => activeOutlinePosition(outlineItems, selectionPosition),
    [outlineItems, selectionPosition],
  );

  const jumpToHeading = useCallback(
    (pos: number) => {
      if (!editorView) return;

      const resolvedPos = editorView.state.doc.resolve(
        Math.min(pos, editorView.state.doc.content.size),
      );
      const selection = TextSelection.near(resolvedPos, 1);
      editorView.dispatch(
        editorView.state.tr.setSelection(selection).scrollIntoView(),
      );
      editorView.focus();
    },
    [editorView],
  );

  return (
    <main className="app-shell" data-testid="app-shell">
      <EditorViewContext.Provider value={editorView}>
        <SetEditorViewContext.Provider value={setEditorView}>
          <SetEditorSelectionContext.Provider value={setSelectionPosition}>
            <Toolbar />
            <div className="workspace" data-testid="workspace">
              <OutlinePanel
                doc={doc}
                onJump={jumpToHeading}
                activePos={activeHeadingPos}
              />
              <section className="editor-pane" aria-label="编辑器">
                <WysiwygEditor
                  initialDoc={doc}
                  sessionKey={sessionKey}
                  onChange={setDocument}
                />
              </section>
            </div>
          </SetEditorSelectionContext.Provider>
        </SetEditorViewContext.Provider>
      </EditorViewContext.Provider>

      <footer className="status-bar" data-testid="status-bar">
        <span data-testid="document-name">{fileName}</span>
        <span aria-live="polite" data-testid="document-dirty-status">
          {dirty ? "未保存" : "已保存"}
        </span>
        <span data-testid="editor-mode">{modeLabels[mode]}</span>
      </footer>
    </main>
  );
}
