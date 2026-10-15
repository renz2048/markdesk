import type { EditorMode } from "../state/documentStore";

const labels: Record<EditorMode, string> = {
  wysiwyg: "所见即所得",
  source: "源码",
  read: "阅读",
};

export function StatusBar({
  fileName,
  dirty,
  mode,
}: {
  fileName: string;
  dirty: boolean;
  mode: EditorMode;
}) {
  return (
    <footer className="status-bar" data-testid="status-bar">
      <span data-testid="document-name">{fileName}</span>
      <span aria-live="polite" data-testid="document-dirty-status">
        {dirty ? "未保存" : "已保存"}
      </span>
      <span aria-live="polite" data-testid="editor-mode">
        {labels[mode]}
      </span>
    </footer>
  );
}
