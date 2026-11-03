import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { EditorView } from "prosemirror-view";
import { TextSelection } from "prosemirror-state";
import { normalizeLinkHref, setLink } from "../editor/commands";

export interface LinkDraft {
  // 弹层打开时的选区快照，确认后把链接应用到该范围。
  from: number;
  to: number;
  href: string;
  // 以选区坐标定位的浮层位置（视口坐标）。
  top: number;
  left: number;
}

interface Props {
  draft: LinkDraft;
  view: EditorView;
  onClose(): void;
}

/**
 * Typora 式链接编辑浮层（Ctrl+K 打开）：输入地址并应用到选区。
 * 验证与写回沿用工具栏时代的 setLink 命令，行为保持一致。
 */
export function LinkPopover({ draft, view, onClose }: Props) {
  const [href, setHref] = useState(draft.href);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const restoreSelection = () => {
    const doc = view.state.doc;
    const boundedFrom = Math.max(0, Math.min(draft.from, doc.content.size));
    const boundedTo = Math.max(boundedFrom, Math.min(draft.to, doc.content.size));
    view.focus();
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(doc, boundedFrom, boundedTo),
      ),
    );
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      normalizeLinkHref(href);
    } catch {
      setError("链接地址无效，请输入 http、https、mailto 或相对链接");
      inputRef.current?.focus();
      return;
    }
    restoreSelection();
    setLink(href.trim())(view.state, view.dispatch, view);
    onClose();
  };

  return (
    <form
      className="link-popover"
      style={{ top: draft.top, left: draft.left }}
      role="dialog"
      aria-modal="false"
      aria-labelledby="link-dialog-title"
      data-testid="link-dialog"
      noValidate
      onSubmit={handleSubmit}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          restoreSelection();
          onClose();
        }
      }}
    >
      <h2 id="link-dialog-title">设置链接</h2>
      <label htmlFor="link-url-input">链接地址</label>
      <input
        ref={inputRef}
        id="link-url-input"
        name="url"
        type="url"
        autoComplete="url"
        value={href}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={error ? "link-error" : undefined}
        data-testid="link-url-input"
        onChange={(event) => setHref(event.target.value)}
      />
      {error ? (
        <p id="link-error" role="alert" data-testid="link-error">
          {error}
        </p>
      ) : null}
      <div className="link-actions">
        <button type="submit" data-testid="link-confirm">
          确定
        </button>
        <button
          type="button"
          data-testid="link-cancel"
          onClick={() => {
            restoreSelection();
            onClose();
          }}
        >
          取消
        </button>
      </div>
    </form>
  );
}
