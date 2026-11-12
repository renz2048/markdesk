// WYSIWYG 视图中的 Mermaid 图表块：language=mermaid 的 code_block 使用
// 自定义 NodeView——光标不在块内时显示渲染出的图，进入块（点击/移动
// 光标/整块选中）切换为源码编辑，离开后自动按最终源码重渲染。
// 文档模型与序列化不参与，往返契约不受影响。
import type { Node } from "prosemirror-model";
import { NodeSelection, Plugin } from "prosemirror-state";
import type { EditorProps, EditorView, NodeView } from "prosemirror-view";
import { MERMAID_LANGUAGE, renderMermaidDiagram } from "./mermaidRender";

// 插件同步选区后，通过该事件通知离开编辑态的 NodeView 补一次渲染。
const REFRESH_EVENT = "markdesk-mermaid-refresh";
const RENDER_DEBOUNCE_MS = 200;

/** code_block 是否为 mermaid 图表块（语言大小写与空白宽容）。 */
export function isMermaidBlock(node: Node): boolean {
  return (
    node.type === node.type.schema.nodes.code_block &&
    node.attrs.language.trim().toLowerCase() === MERMAID_LANGUAGE
  );
}

class MermaidNodeView implements NodeView {
  readonly dom: HTMLDivElement;
  private readonly preview: HTMLDivElement;
  readonly contentDOM: HTMLElement;
  private node: Node;
  private renderTimer: number | null = null;
  private renderToken = 0;
  private destroyed = false;

  constructor(node: Node) {
    this.node = node;
    this.dom = document.createElement("div");
    this.dom.className = "markdesk-mermaid";
    this.dom.dataset.language = MERMAID_LANGUAGE;
    this.preview = document.createElement("div");
    this.preview.className = "markdesk-mermaid-preview";
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    pre.append(code);
    this.dom.append(this.preview, pre);
    this.contentDOM = code;
    this.dom.addEventListener(REFRESH_EVENT, this.handleRefresh);
    this.scheduleRender();
  }

  update(node: Node): boolean {
    if (!isMermaidBlock(node)) return false;
    this.node = node;
    // 编辑中预览隐藏，渲染推迟到离开块时的 refresh 事件。
    if (!this.isEditing()) this.scheduleRender();
    return true;
  }

  // 整块被 NodeSelection 选中（如全选后移动、结构拖拽）时按编辑态展示。
  selectNode(): void {
    this.setEditing(true);
  }

  deselectNode(): void {
    this.setEditing(false);
  }

  ignoreMutation(mutation: MutationRecord): boolean {
    // ProseMirror 自定义的 selection 变更不在 DOM MutationRecordType
    // 枚举里，按字符串比较。
    if ((mutation.type as string) === "selection") return true;
    if (mutation.type === "attributes" && mutation.target === this.dom) {
      return true;
    }
    // 渲染出的 SVG 与错误提示不属于文档模型，无需 ProseMirror 重解析。
    return this.preview.contains(mutation.target);
  }

  destroy(): void {
    this.destroyed = true;
    this.dom.removeEventListener(REFRESH_EVENT, this.handleRefresh);
    if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
  }

  private readonly handleRefresh = (): void => {
    this.scheduleRender();
  };

  private isEditing(): boolean {
    return this.dom.classList.contains("is-editing");
  }

  private setEditing(editing: boolean): void {
    this.dom.classList.toggle("is-editing", editing);
    if (!editing) this.scheduleRender();
  }

  private scheduleRender(): void {
    if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      void this.render();
    }, RENDER_DEBOUNCE_MS);
  }

  private async render(): Promise<void> {
    const token = (this.renderToken += 1);
    const source = this.node.textContent ?? "";
    if (!source.trim()) {
      this.showPlaceholder();
      return;
    }
    const result = await renderMermaidDiagram(source);
    // 等待期间节点可能被再次更新或销毁，过期结果直接丢弃。
    if (this.destroyed || token !== this.renderToken) return;
    if (result.kind === "svg") {
      // mermaid strict 模式已对标签消毒，应用内另有 CSP 兜底。
      this.preview.innerHTML = result.svg;
      this.dom.classList.add("is-rendered");
      this.dom.classList.remove("has-error");
    } else {
      this.preview.textContent = `图表渲染失败：${result.message}`;
      this.dom.classList.add("has-error");
      this.dom.classList.remove("is-rendered");
    }
  }

  private showPlaceholder(): void {
    this.preview.textContent = "Mermaid 图表：输入源码后自动渲染";
    this.dom.classList.remove("is-rendered", "has-error");
  }
}

// 每次事务后重算各 mermaid 块的“编辑中”状态（光标/选区进入块内）。
// ProseMirror 对 NodeView 只提供 NodeSelection 的 selectNode 回调，
// 文本光标进出需要在这里监听选区变化并直接切换 NodeView 的类名。
function syncEditingState(view: EditorView): void {
  const { selection, doc } = view.state;
  const nodeSelection = selection instanceof NodeSelection ? selection : null;
  doc.descendants((node, pos) => {
    if (!isMermaidBlock(node)) return true;
    const dom = view.nodeDOM(pos);
    if (
      !(dom instanceof HTMLElement) ||
      !dom.classList.contains("markdesk-mermaid")
    ) {
      return false;
    }
    const end = pos + node.nodeSize;
    const editing = nodeSelection
      ? nodeSelection.from === pos
      : selection.from > pos && selection.to < end;
    const wasEditing = dom.classList.contains("is-editing");
    dom.classList.toggle("is-editing", editing);
    if (wasEditing && !editing) {
      dom.dispatchEvent(new CustomEvent(REFRESH_EVENT));
    }
    return false;
  });
}

export function mermaidBlockPlugin(): Plugin {
  return new Plugin({
    props: {
      // 非 mermaid 代码块返回 null 交回默认渲染（prosemirror-view 的
      // ViewDesc.create 约定；类型签名未标出可空，这里整体断言一次）。
      nodeViews: {
        code_block: (node: Node) =>
          isMermaidBlock(node) ? new MermaidNodeView(node) : null,
      } as unknown as NonNullable<EditorProps["nodeViews"]>,
    },
    view(editorView: EditorView) {
      syncEditingState(editorView);
      return {
        update: (view: EditorView) => syncEditingState(view),
      };
    },
  });
}
