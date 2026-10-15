import { createContext, useCallback, useContext } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Command } from "prosemirror-commands";
import type { EditorView } from "prosemirror-view";
import {
  insertHorizontalRule,
  setBlockquote,
  setCodeBlock,
  setHeading,
  setLink,
  toggleBulletList,
  toggleMarkByName,
  toggleOrderedList,
} from "../editor/commands";

export const EditorViewContext = createContext<EditorView | null>(null);
export const SetEditorViewContext = createContext<
  Dispatch<SetStateAction<EditorView | null>> | null
>(null);

interface ToolbarAction {
  id: string;
  label: string;
  title: string;
  command: Command;
}

export function Toolbar() {
  const view = useContext(EditorViewContext);

  const runCommand = useCallback(
    (command: Command) => {
      if (!view) return;
      view.focus();
      command(view.state, view.dispatch, view);
    },
    [view],
  );

  const addLink = useCallback(() => {
    const href = window.prompt("链接地址", "https://");
    if (href === null || href.trim() === "") return;
    runCommand(setLink(href.trim()));
  }, [runCommand]);

  const actions: ToolbarAction[] = [
    { id: "heading-1", label: "H1", title: "一级标题", command: setHeading(1) },
    { id: "heading-2", label: "H2", title: "二级标题", command: setHeading(2) },
    { id: "heading-3", label: "H3", title: "三级标题", command: setHeading(3) },
    { id: "bold", label: "B", title: "加粗", command: toggleMarkByName("strong") },
    { id: "italic", label: "I", title: "斜体", command: toggleMarkByName("em") },
    {
      id: "strikethrough",
      label: "S",
      title: "删除线",
      command: toggleMarkByName("strikethrough"),
    },
    {
      id: "inline-code",
      label: "</>",
      title: "行内代码",
      command: toggleMarkByName("code"),
    },
    {
      id: "bullet-list",
      label: "•",
      title: "无序列表",
      command: toggleBulletList(),
    },
    {
      id: "ordered-list",
      label: "1.",
      title: "有序列表",
      command: toggleOrderedList(),
    },
    { id: "quote", label: "❝", title: "引用", command: setBlockquote() },
    { id: "code-block", label: "{}", title: "代码块", command: setCodeBlock() },
    {
      id: "horizontal-rule",
      label: "—",
      title: "分隔线",
      command: insertHorizontalRule(),
    },
  ];

  return (
    <div
      className="toolbar"
      role="toolbar"
      aria-label="格式化工具栏"
      data-testid="toolbar"
    >
      {actions.map(({ id, label, title, command }) => (
        <button
          key={id}
          type="button"
          className={`toolbar-button toolbar-${id}`}
          title={title}
          aria-label={title}
          data-testid={`toolbar-${id}`}
          disabled={!view}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => runCommand(command)}
        >
          {label}
        </button>
      ))}
      <button
        type="button"
        className="toolbar-button toolbar-link"
        title="链接"
        aria-label="链接"
        data-testid="toolbar-link"
        disabled={!view}
        onMouseDown={(event) => event.preventDefault()}
        onClick={addLink}
      >
        Link
      </button>
    </div>
  );
}
