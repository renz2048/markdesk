import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Dispatch, SetStateAction } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import type { Command } from "prosemirror-commands";
import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import {
  insertHorizontalRule,
  normalizeLinkHref,
  selectedLinkHref,
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
export const SetEditorSelectionContext = createContext<
  ((position: number) => void) | null
>(null);

interface ToolbarAction {
  id: string;
  label: string;
  title: string;
  command: Command;
}

interface LinkDraft {
  from: number;
  to: number;
  href: string;
  error: string;
}

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

const toolbarShortcuts: Record<string, string> = {
  bold: "Control+B Meta+B",
  italic: "Control+I Meta+I",
  "inline-code": "Control+E Meta+E",
  strikethrough: "Control+Shift+X Meta+Shift+X",
  "bullet-list": "Control+Shift+8 Meta+Shift+8",
  "ordered-list": "Control+Shift+9 Meta+Shift+9",
};

const buttonCount = actions.length + 1;

export function Toolbar() {
  const view = useContext(EditorViewContext);
  const [linkDraft, setLinkDraft] = useState<LinkDraft | null>(null);
  const [focusedButton, setFocusedButton] = useState(0);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const linkInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (linkDraft) linkInputRef.current?.focus();
  }, [linkDraft]);

  const selectRangeAndFocus = useCallback(
    (from: number, to: number) => {
      if (!view) return;
      const doc = view.state.doc;
      const boundedFrom = Math.max(0, Math.min(from, doc.content.size));
      const boundedTo = Math.max(boundedFrom, Math.min(to, doc.content.size));
      view.focus();
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(doc, boundedFrom, boundedTo),
        ),
      );
    },
    [view],
  );

  const runCommand = useCallback(
    (command: Command) => {
      if (!view) return;
      view.focus();
      command(view.state, view.dispatch, view);
    },
    [view],
  );

  const openLinkEditor = useCallback(() => {
    if (!view) return;
    const selection = view.state.selection;
    setLinkDraft({
      from: selection.from,
      to: selection.to,
      href: selectedLinkHref(view.state) ?? "",
      error: "",
    });
  }, [view]);

  const closeLinkEditor = useCallback(
    (draft: LinkDraft) => {
      setLinkDraft(null);
      selectRangeAndFocus(draft.from, draft.to);
    },
    [selectRangeAndFocus],
  );

  const submitLink = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!view || !linkDraft) return;

      try {
        const href = normalizeLinkHref(linkDraft.href);
        selectRangeAndFocus(linkDraft.from, linkDraft.to);
        setLink(href)(view.state, view.dispatch, view);
        setLinkDraft(null);
      } catch (error) {
        const message =
          error instanceof Error
            ? "链接地址无效，请输入 http、https、mailto 或相对链接"
            : "链接地址无效，请修改后重试";
        setLinkDraft({ ...linkDraft, error: message });
        linkInputRef.current?.focus();
      }
    },
    [linkDraft, selectRangeAndFocus, view],
  );

  const handleToolbarKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const currentIndex = Math.min(focusedButton, buttonCount - 1);
      let nextIndex = currentIndex;

      if (event.key === "ArrowRight") nextIndex = currentIndex + 1;
      else if (event.key === "ArrowLeft") nextIndex = currentIndex - 1;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = buttonCount - 1;
      else return;

      event.preventDefault();
      const boundedIndex = (nextIndex + buttonCount) % buttonCount;
      setFocusedButton(boundedIndex);
      buttonRefs.current[boundedIndex]?.focus();
    },
    [focusedButton],
  );

  return (
    <div className="toolbar-frame" data-testid="toolbar-container">
      <div
        className="toolbar"
        role="toolbar"
        aria-label="格式化工具栏"
        aria-orientation="horizontal"
        data-testid="toolbar"
        onKeyDown={handleToolbarKeyDown}
      >
        {actions.map(({ id, label, title, command }, index) => (
          <button
            key={id}
            ref={(element) => {
              buttonRefs.current[index] = element;
            }}
            type="button"
            className={`toolbar-button toolbar-${id}`}
            title={title}
            aria-label={title}
            aria-keyshortcuts={toolbarShortcuts[id]}
            data-testid={`toolbar-${id}`}
            tabIndex={index === focusedButton ? 0 : -1}
            disabled={!view}
            onMouseDown={(event) => event.preventDefault()}
            onFocus={() => setFocusedButton(index)}
            onClick={() => runCommand(command)}
          >
            {label}
          </button>
        ))}
        <button
          ref={(element) => {
            buttonRefs.current[actions.length] = element;
          }}
          type="button"
          className="toolbar-button toolbar-link"
          title="链接"
          aria-label="链接"
          data-testid="toolbar-link"
          tabIndex={focusedButton === actions.length ? 0 : -1}
          disabled={!view}
          onMouseDown={(event) => event.preventDefault()}
          onFocus={() => setFocusedButton(actions.length)}
          onClick={openLinkEditor}
        >
          Link
        </button>
      </div>

      {linkDraft ? (
        <form
          className="link-popover"
          role="dialog"
          aria-modal="false"
          aria-labelledby="link-dialog-title"
          data-testid="link-dialog"
          noValidate
          onSubmit={submitLink}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeLinkEditor(linkDraft);
            }
          }}
        >
          <h2 id="link-dialog-title">设置链接</h2>
          <label htmlFor="link-url-input">链接地址</label>
          <input
            ref={linkInputRef}
            id="link-url-input"
            name="url"
            type="url"
            autoComplete="url"
            value={linkDraft.href}
            aria-invalid={linkDraft.error ? "true" : undefined}
            aria-describedby={linkDraft.error ? "link-error" : undefined}
            data-testid="link-url-input"
            onChange={(event) =>
              setLinkDraft({ ...linkDraft, href: event.target.value })
            }
          />
          {linkDraft.error ? (
            <p id="link-error" role="alert" data-testid="link-error">
              {linkDraft.error}
            </p>
          ) : null}
          <div className="link-actions">
            <button type="submit" data-testid="link-confirm">
              确定
            </button>
            <button
              type="button"
              data-testid="link-cancel"
              onClick={() => closeLinkEditor(linkDraft)}
            >
              取消
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
