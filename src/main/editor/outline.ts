import { Node } from "prosemirror-model";

export interface OutlineItem {
  id: string;
  level: number;
  text: string;
  pos: number;
}

export function outlineFromDoc(doc: Node): OutlineItem[] {
  const items: OutlineItem[] = [];
  let headingIndex = 0;

  doc.descendants((node, pos) => {
    if (node.type.name !== "heading") return true;

    items.push({
      id: `h-${headingIndex++}`,
      level: Number(node.attrs.level),
      text: node.textContent,
      pos,
    });
    return true;
  });

  return items;
}

export function activeOutlinePosition(
  items: OutlineItem[],
  position: number,
): number | undefined {
  let activePosition: number | undefined;

  for (const item of items) {
    if (item.pos > position) break;
    activePosition = item.pos;
  }

  return activePosition;
}
