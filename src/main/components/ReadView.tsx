import { useEffect, useMemo, useRef } from "react";
import { DOMSerializer } from "prosemirror-model";
import type { Node } from "prosemirror-model";
import { markdownSchema } from "../../markdown/schema";

export function ReadView({ doc }: { doc: Node }) {
  const hostRef = useRef<HTMLElement | null>(null);
  const serializer = useMemo(
    () => DOMSerializer.fromSchema(markdownSchema),
    [],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.replaceChildren(serializer.serializeFragment(doc.content));
  }, [doc, serializer]);

  return (
    <article
      className="editor read-view"
      ref={hostRef}
      data-testid="read-view"
      contentEditable={false}
      aria-readonly="true"
      aria-label="Markdown 阅读区"
    />
  );
}
