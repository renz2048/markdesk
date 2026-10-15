import { useLayoutEffect, useMemo, useRef } from "react";
import { DOMSerializer } from "prosemirror-model";
import type { Node } from "prosemirror-model";
import { markdownSchema } from "../../markdown/schema";
import { isExternalHttpUrl } from "../../markdown/urlPolicy";

export function ReadView({ doc }: { doc: Node }) {
  const hostRef = useRef<HTMLElement | null>(null);
  const serializer = useMemo(
    () => DOMSerializer.fromSchema(markdownSchema),
    [],
  );

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.replaceChildren(serializer.serializeFragment(doc.content));
    host.querySelectorAll("a[href]").forEach((anchor) => {
      const href = anchor.getAttribute("href") ?? "";
      if (isExternalHttpUrl(href)) {
        anchor.setAttribute("target", "_blank");
        anchor.setAttribute("rel", "noopener noreferrer");
        return;
      }
      anchor.removeAttribute("href");
      anchor.setAttribute("aria-disabled", "true");
      anchor.setAttribute("data-inert-link", "true");
    });
    host.querySelectorAll("img[src]").forEach((image) => {
      if (!image.getAttribute("src")) image.removeAttribute("src");
    });
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
