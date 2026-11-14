// WYSIWYG 视图中的 [toc] 目录块：toc_block 是 atom 节点，条目列表由
// 当前文档的标题实时计算（outlineFromDoc），文档任何变动后由插件统一
// 通知重算——Typora 的“目录随文档自动更新”。点击条目跳转到对应标题。
// attrs.source 保留作者原文（[toc]/[TOC]），序列化逐字往返。
import type { Node } from "prosemirror-model";
import { Plugin, TextSelection } from "prosemirror-state";
import type { EditorProps, EditorView, NodeView } from "prosemirror-view";
import { outlineFromDoc } from "./outline";

// 文档变动后，通过该事件通知各目录块重算条目。
const REFRESH_EVENT = "markdesk-toc-refresh";

/** 节点是否为目录块。 */
export function isTocBlock(node: Node): boolean {
  return node.type === node.type.schema.nodes.toc_block;
}

interface TocEntry {
  text: string;
  level: number;
  pos: number;
}

export interface TocTreeNode<T> {
  entry: T;
  children: TocTreeNode<T>[];
}

/** 标题列表 → 树：级别更深是上一个条目的子项，跳级时挂到最近的祖先。 */
export function buildTocTree<T extends { level: number }>(
  entries: readonly T[],
): TocTreeNode<T>[] {
  const roots: TocTreeNode<T>[] = [];
  const stack: { level: number; children: TocTreeNode<T>[] }[] = [
    { level: 0, children: roots },
  ];
  for (const entry of entries) {
    while (stack.length > 1 && stack[stack.length - 1].level >= entry.level) {
      stack.pop();
    }
    const node: TocTreeNode<T> = { entry, children: [] };
    stack[stack.length - 1].children.push(node);
    stack.push({ level: entry.level, children: node.children });
  }
  return roots;
}

function renderTocList(nodes: readonly TocTreeNode<TocEntry>[]): HTMLUListElement {
  const ul = document.createElement("ul");
  for (const { entry, children } of nodes) {
    const li = document.createElement("li");
    const link = document.createElement("a");
    link.href = "#";
    link.textContent = entry.text;
    link.dataset.pos = String(entry.pos);
    li.append(link);
    if (children.length > 0) li.append(renderTocList(children));
    ul.append(li);
  }
  return ul;
}

class TocNodeView implements NodeView {
  readonly dom: HTMLDivElement;
  private readonly listHost: HTMLDivElement;
  private readonly view: EditorView;

  constructor(node: Node, view: EditorView) {
    this.view = view;
    this.dom = document.createElement("div");
    this.dom.className = "markdesk-toc";
    const title = document.createElement("div");
    title.className = "markdesk-toc-title";
    title.textContent = "目录";
    this.listHost = document.createElement("div");
    this.listHost.className = "markdesk-toc-list";
    this.dom.append(title, this.listHost);
    this.dom.addEventListener(REFRESH_EVENT, this.handleRefresh);
    this.listHost.addEventListener("click", this.handleClick);
    this.renderList();
  }

  update(node: Node): boolean {
    // 条目取决于整个文档的标题，重算由插件的 refresh 事件统一驱动。
    return isTocBlock(node);
  }

  selectNode(): void {
    this.dom.classList.add("is-selected");
  }

  deselectNode(): void {
    this.dom.classList.remove("is-selected");
  }

  // 目录内容完全是派生 DOM（非文档模型），全部忽略。
  ignoreMutation(): boolean {
    return true;
  }

  stopEvent(event: Event): boolean {
    // 目录条目的点击（跳转）由本视图处理，不交给 ProseMirror 选区逻辑。
    return (
      event.target instanceof Element && this.listHost.contains(event.target)
    );
  }

  destroy(): void {
    this.dom.removeEventListener(REFRESH_EVENT, this.handleRefresh);
    this.listHost.removeEventListener("click", this.handleClick);
  }

  private readonly handleRefresh = (): void => {
    this.renderList();
  };

  private readonly handleClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    const link = target?.closest("a");
    const pos = Number(link?.dataset.pos ?? Number.NaN);
    if (!link || !Number.isFinite(pos)) return;
    event.preventDefault();
    this.jumpTo(pos);
  };

  // 与 App.jumpToHeading 一致：置选区并把标题滚到视口顶部。
  private jumpTo(pos: number): void {
    const doc = this.view.state.doc;
    const selection = TextSelection.near(
      doc.resolve(Math.min(pos, doc.content.size)),
      1,
    );
    this.view.dispatch(this.view.state.tr.setSelection(selection));
    try {
      const scroller = this.view.dom.closest<HTMLElement>(".editor");
      if (scroller) {
        const { top } = this.view.coordsAtPos(selection.from);
        scroller.scrollTop += top - scroller.getBoundingClientRect().top - 8;
      }
    } catch {
      // jsdom 等无头环境没有坐标信息，跳过滚动。
    }
    this.view.focus();
  }

  private renderList(): void {
    const entries: TocEntry[] = outlineFromDoc(this.view.state.doc).map(
      (item) => ({ text: item.text, level: item.level, pos: item.pos }),
    );
    this.listHost.replaceChildren();
    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "markdesk-toc-empty";
      empty.textContent = "（文档暂无标题）";
      this.listHost.append(empty);
      return;
    }
    this.listHost.append(renderTocList(buildTocTree(entries)));
  }
}

// 每次事务后通知所有目录块按最新文档重算条目。
function refreshTocViews(view: EditorView): void {
  const { doc } = view.state;
  doc.descendants((node, pos) => {
    if (!isTocBlock(node)) return true;
    const dom = view.nodeDOM(pos);
    if (dom instanceof HTMLElement) {
      dom.dispatchEvent(new CustomEvent(REFRESH_EVENT));
    }
    return false;
  });
}

export function tocBlockPlugin(): Plugin {
  return new Plugin({
    props: {
      nodeViews: {
        toc_block: (node: Node, view: EditorView) =>
          isTocBlock(node) ? new TocNodeView(node, view) : null,
      } as unknown as NonNullable<EditorProps["nodeViews"]>,
    },
    view(editorView: EditorView) {
      refreshTocViews(editorView);
      return {
        update: (view: EditorView) => refreshTocViews(view),
      };
    },
  });
}
