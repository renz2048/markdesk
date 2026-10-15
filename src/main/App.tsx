import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import type { EditorView } from "prosemirror-view";
import { TextSelection } from "prosemirror-state";
import { OutlinePanel } from "./components/OutlinePanel";
import { ReadView } from "./components/ReadView";
import { SourceEditor } from "./components/SourceEditor";
import { StatusBar } from "./components/StatusBar";
import {
  EditorViewContext,
  SetEditorSelectionContext,
  SetEditorViewContext,
  Toolbar,
} from "./components/Toolbar";
import { WysiwygEditor } from "./components/WysiwygEditor";
import { activeOutlinePosition, outlineFromDoc } from "./editor/outline";
import {
  useDocumentStore,
  type EditorMode,
  type ThemePreference,
} from "./state/documentStore";

const modeLabels = {
  wysiwyg: "所见即所得",
  source: "源码",
  read: "阅读",
} as const;

const modes = Object.keys(modeLabels) as EditorMode[];
const themeLabels: Record<ThemePreference, string> = {
  light: "浅色",
  dark: "深色",
  system: "跟随系统",
};

export default function App() {
  const doc = useDocumentStore((state) => state.doc);
  const fileName = useDocumentStore((state) => state.fileName);
  const dirty = useDocumentStore((state) => state.dirty);
  const mode = useDocumentStore((state) => state.mode);
  const sourceText = useDocumentStore((state) => state.sourceText);
  const sourceParseError = useDocumentStore(
    (state) => state.sourceParseError,
  );
  const sessionKey = useDocumentStore((state) => state.sessionKey);
  const themePreference = useDocumentStore(
    (state) => state.themePreference,
  );
  const setDocument = useDocumentStore((state) => state.setDocument);
  const setSourceText = useDocumentStore((state) => state.setSourceText);
  const transitionMode = useDocumentStore((state) => state.transitionMode);
  const setThemePreference = useDocumentStore(
    (state) => state.setThemePreference,
  );
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  const [selectionPosition, setSelectionPosition] = useState(0);
  const [systemPrefersDark, setSystemPrefersDark] = useState(false);

  useEffect(() => {
    setSelectionPosition(0);
  }, [mode, sessionKey]);

  useLayoutEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const updateSystemTheme = () => setSystemPrefersDark(mediaQuery.matches);
    updateSystemTheme();
    mediaQuery.addEventListener("change", updateSystemTheme);
    return () => mediaQuery.removeEventListener("change", updateSystemTheme);
  }, []);

  const resolvedTheme = themePreference === "system"
    ? systemPrefersDark
      ? "dark"
      : "light"
    : themePreference;

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme;
    root.dataset.themePreference = themePreference;
    root.classList.toggle("theme-light", resolvedTheme === "light");
    root.classList.toggle("theme-dark", resolvedTheme === "dark");
    root.style.colorScheme = resolvedTheme;
  }, [resolvedTheme, themePreference]);

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
            <ViewBar
              mode={mode}
              themePreference={themePreference}
              onModeChange={transitionMode}
              onThemeChange={setThemePreference}
            />
            <div className="workspace" data-testid="workspace">
              <OutlinePanel
                doc={doc}
                onJump={jumpToHeading}
                activePos={activeHeadingPos}
              />
              <section className="editor-pane" aria-label="编辑器">
                {sourceParseError ? (
                  <p
                    className="mode-error"
                    role="alert"
                    data-testid="source-parse-error"
                  >
                    {sourceParseError}
                  </p>
                ) : null}
                {mode === "wysiwyg" ? (
                  <WysiwygEditor
                    initialDoc={doc}
                    sessionKey={sessionKey}
                    onChange={setDocument}
                  />
                ) : mode === "source" ? (
                  <SourceEditor
                    initialValue={sourceText}
                    sessionKey={sessionKey}
                    onChange={setSourceText}
                  />
                ) : (
                  <ReadView doc={doc} />
                )}
              </section>
            </div>
          </SetEditorSelectionContext.Provider>
        </SetEditorViewContext.Provider>
      </EditorViewContext.Provider>

      <StatusBar fileName={fileName} dirty={dirty} mode={mode} />
    </main>
  );
}

function ViewBar({
  mode,
  themePreference,
  onModeChange,
  onThemeChange,
}: {
  mode: EditorMode;
  themePreference: ThemePreference;
  onModeChange(mode: EditorMode): void;
  onThemeChange(theme: ThemePreference): void;
}) {
  return (
    <div className="view-bar" data-testid="view-bar">
      <div
        className="mode-switcher"
        role="group"
        aria-label="编辑模式"
        data-testid="mode-switcher"
      >
        {modes.map((item) => (
          <button
            key={item}
            type="button"
            className="mode-button"
            aria-pressed={mode === item}
            data-active={mode === item ? "true" : "false"}
            data-testid={`mode-${item}`}
            onClick={() => onModeChange(item)}
          >
            {modeLabels[item]}
          </button>
        ))}
      </div>
      <label className="theme-select-label" htmlFor="theme-select">
        主题
        <select
          id="theme-select"
          value={themePreference}
          data-testid="theme-select"
          onChange={(event) =>
            onThemeChange(event.target.value as ThemePreference)
          }
        >
          {(Object.keys(themeLabels) as ThemePreference[]).map((theme) => (
            <option
              key={theme}
              value={theme}
              data-testid={`theme-option-${theme}`}
            >
              {themeLabels[theme]}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
