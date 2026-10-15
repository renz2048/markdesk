import { parseMarkdown } from "./parser";
import { serializeMarkdown } from "./serializer";

export function roundTripMarkdown(source: string): string {
  return serializeMarkdown(parseMarkdown(source));
}
