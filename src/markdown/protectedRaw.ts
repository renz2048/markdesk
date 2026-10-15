import { Node } from "prosemirror-model";
import { markdownSchema } from "./schema";

export function rawBlockFromSource(source: string): Node {
  return markdownSchema.nodes.raw_block.create({ source });
}

export function rawBlockSource(node: Node): string {
  if (node.type !== markdownSchema.nodes.raw_block) {
    throw new TypeError("Expected a raw_block node");
  }
  return String(node.attrs.source ?? "");
}
