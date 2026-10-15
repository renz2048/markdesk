import type { Node } from "prosemirror-model";
import { outlineFromDoc } from "../editor/outline";

export function OutlinePanel({
  doc,
  onJump,
  activePos,
}: {
  doc: Node;
  onJump(pos: number): void;
  activePos?: number;
}) {
  const items = outlineFromDoc(doc);

  return (
    <aside className="outline-panel" aria-label="文档大纲" data-testid="outline">
      {items.length === 0 ? (
        <p className="muted" data-testid="outline-empty">
          暂无标题
        </p>
      ) : (
        items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`outline-item level-${item.level}${
              item.pos === activePos ? " active" : ""
            }`}
            aria-current={item.pos === activePos ? "true" : undefined}
            data-testid={`outline-${item.id}`}
            onClick={() => onJump(item.pos)}
          >
            {item.text || "未命名标题"}
          </button>
        ))
      )}
    </aside>
  );
}
