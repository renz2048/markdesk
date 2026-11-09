import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { EditorView } from "prosemirror-view";
import { insertTable } from "../editor/commands";

export interface TableSizeDraft {
  // 以选区坐标定位的浮层位置（视口坐标）。
  top: number;
  left: number;
}

interface Props {
  draft: TableSizeDraft;
  view: EditorView;
  onClose(): void;
}

/** 列/行输入的解析与收敛：非法输入回落默认值，范围 1–64。 */
function clampSize(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), 64);
}

/**
 * 「插入表格」弹窗（Ctrl+T）：选择列数（默认 3）与行数（默认 4，
 * 含表头行），确认后插入表格；表格成为末块时在其后保留两行空段落
 * （insertTable 命令内处理）。
 */
export function TableSizePopover({ draft, view, onClose }: Props) {
  const [columns, setColumns] = useState("3");
  const [rows, setRows] = useState("4");
  const columnsInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    columnsInputRef.current?.focus();
    columnsInputRef.current?.select();
  }, []);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    view.focus();
    insertTable(
      clampSize(columns, 3),
      clampSize(rows, 4),
    )(view.state, view.dispatch, view);
    onClose();
  };

  return (
    <form
      className="table-size-popover"
      style={{ top: draft.top, left: draft.left }}
      role="dialog"
      aria-modal="false"
      aria-labelledby="table-size-title"
      data-testid="table-size-dialog"
      noValidate
      onSubmit={handleSubmit}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          view.focus();
          onClose();
        }
      }}
    >
      <h2 id="table-size-title">插入表格</h2>
      <div className="table-size-fields">
        <label htmlFor="table-columns-input">列</label>
        <input
          ref={columnsInputRef}
          id="table-columns-input"
          name="columns"
          type="number"
          inputMode="numeric"
          min={1}
          max={64}
          step={1}
          value={columns}
          data-testid="table-columns-input"
          onChange={(event) => setColumns(event.target.value)}
        />
        <label htmlFor="table-rows-input">行</label>
        <input
          id="table-rows-input"
          name="rows"
          type="number"
          inputMode="numeric"
          min={1}
          max={64}
          step={1}
          value={rows}
          data-testid="table-rows-input"
          onChange={(event) => setRows(event.target.value)}
        />
      </div>
      <div className="table-size-actions">
        <button type="button" data-testid="table-size-cancel" onClick={() => {
          view.focus();
          onClose();
        }}>
          取消
        </button>
        <button type="submit" data-testid="table-size-confirm">
          确认
        </button>
      </div>
    </form>
  );
}
