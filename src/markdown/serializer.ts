import { Node } from "prosemirror-model";
import { MarkdownSerializer } from "prosemirror-markdown";

export const markdownSerializer = new MarkdownSerializer(
  {
    doc(state, node) {
      state.renderContent(node);
    },
    paragraph(state, node) {
      state.renderInline(node);
      state.closeBlock(node);
    },
    heading(state, node) {
      state.write(`${"#".repeat(node.attrs.level)} `);
      state.renderInline(node);
      state.closeBlock(node);
    },
    blockquote(state, node) {
      state.wrapBlock("> ", null, node, () => state.renderContent(node));
    },
    bullet_list(state, node) {
      state.renderList(node, "  ", () => "- ");
    },
    ordered_list(state, node) {
      const start = node.attrs.start || 1;
      const max = String(start + node.childCount - 1).length;
      const space = " ".repeat(max + 2);
      state.renderList(node, space, (index) => `${start + index}. `);
    },
    list_item(state, node) {
      state.renderContent(node);
    },
    code_block(state, node) {
      const language = node.attrs.language || "";
      state.write(`\`\`\`${language}\n`);
      state.text(node.textContent, false);
      state.ensureNewLine();
      state.write("```");
      state.closeBlock(node);
    },
    horizontal_rule(state, node) {
      state.write("---");
      state.closeBlock(node);
    },
    image(state, node) {
      const title = node.attrs.title ? ` "${node.attrs.title}"` : "";
      state.write(`![${node.attrs.alt || ""}](${node.attrs.src}${title})`);
    },
    hard_break(state) {
      state.write("\\\n");
    },
  },
  {
    strong: { open: "**", close: "**", mixable: true },
    em: { open: "*", close: "*", mixable: true },
    strikethrough: { open: "~~", close: "~~", mixable: true },
    code: { open: "`", close: "`", escape: false },
    link: {
      open() {
        return "[";
      },
      close(_state, mark) {
        const title = mark.attrs.title ? ` "${mark.attrs.title}"` : "";
        return `](${mark.attrs.href}${title})`;
      },
    },
  },
);

export function serializeMarkdown(doc: Node): string {
  return markdownSerializer.serialize(doc, {
    hardBreakNodeName: "hard_break",
  });
}
