import { useContext, useEffect, useRef, useState } from "react";
import { baseKeymap } from "prosemirror-commands";
import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";
import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import type { Node } from "prosemirror-model";
import { EditorState, Plugin, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { markdownSchema } from "../../markdown/schema";
import { formattingKeymap } from "../editor/commands";
import { selectedLinkHref } from "../editor/commands";
import { markdownInputRules } from "../editor/inputRules";
import { listEditingPlugin } from "../editor/listEditing";
import { pendingSyntaxPlugin } from "../editor/pendingSyntax";
import { SetEditorSelectionContext, SetEditorViewContext } from "./EditorContexts";
import { LinkPopover, type LinkDraft } from "./LinkPopover";

interface Props {
  initialDoc: Node;
  initialCursor: number;
  sessionKey: string;
  onChange(doc: Node): void;
  // 返回待插入的图片 src（相对路径或 data: URI）；null 表示放弃插入。
  onPasteImage?(file: File): Promise<string | null>;
  // 拖入本地图片的解析（文档目录内相对路径 / 目录外绝对路径 / 内嵌）。
  onDropImage?(file: File): Promise<string | null>;
}

// 从剪贴板条目中提取图片文件（截图通常没有名字，由调用方生成）。
export function imageFilesFromClipboard(
  items: DataTransferItemList | null,
): File[] {
  if (!items) return [];
  const files: File[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file && file.size > 0) files.push(file);
  }
  return files;
}

export function createPasteImagePlugin(
  getSource: (file: File) => Promise<string | null>,
): Plugin {
  return new Plugin({
    props: {
      handlePaste(view, event) {
        const files = imageFilesFromClipboard(
          event.clipboardData?.items ?? null,
        );
        if (files.length === 0) return false;
        event.preventDefault();
        // handlePaste 必须同步返回；图片落盘/转码是异步的，完成后再
        // 逐张 dispatch 插入。视图可能在等待期间被销毁（切换文档），
        // dispatch 失败即静默终止。
        void (async () => {
          for (const file of files) {
            const src = await getSource(file);
            if (!src) continue;
            const image = view.state.schema.nodes.image.create({
              src,
              alt: file.name || "图片",
            });
            const insertFrom = view.state.selection.from;
            const transaction = view.state.tr
              .replaceSelectionWith(image)
              .scrollIntoView();
            try {
              view.dispatch(transaction);
            } catch {
              return;
            }
            // Chromium 偶发不给新插入的 <img>（自定义协议）启动加载
            //（currentSrc 恒为空、complete 恒为 false），同步重设无效，
            // 跳出当前帧后再对仍未完成的图片原地重设 src 强制启动。
            setTimeout(() => {
              const dom = view.nodeDOM(insertFrom);
              if (
                dom instanceof HTMLImageElement &&
                !dom.complete &&
                !dom.currentSrc
              ) {
                const renderedSrc = dom.getAttribute("src");
                if (renderedSrc) dom.src = renderedSrc;
              }
            }, 150);
          }
        })();
        return true;
      },
    },
  });
}

export function createDropImagePlugin(
  getSource: (file: File) => Promise<string | null>,
): Plugin {
  return new Plugin({
    props: {
      // 从系统拖入图片文件：在落点插入（编辑区内部拖动 moved 不处理）。
      handleDrop(view, event) {
        if (event.dataTransfer === null) return false;
        const files = imageFilesFromClipboard(event.dataTransfer.items);
        if (files.length === 0) return false;
        event.preventDefault();
        // 落点计算在个别环境（jsdom）不可用，退回当前选区位置。
        let anchor = view.state.selection.from;
        try {
          const dropPos = view.posAtCoords({
            left: event.clientX,
            top: event.clientY,
          });
          if (dropPos) anchor = dropPos.pos;
        } catch {
          // 保持选区位置。
        }
        void (async () => {
          for (const file of files) {
            const src = await getSource(file);
            if (!src) continue;
            const image = view.state.schema.nodes.image.create({
              src,
              alt: file.name || "图片",
            });
            // 等待期间视图可能被销毁（切换文档），失败即静默终止。
            try {
              view.dispatch(view.state.tr.insert(anchor, image));
            } catch {
              return;
            }
          }
        })();
        return true;
      },
    },
  });
}

export function createEditorPlugins(
  getPasteImageSource?: (file: File) => Promise<string | null>,
  getDropImageSource?: (file: File) => Promise<string | null>,
): Plugin[] {
  return [
    history(),
    keymap({
      "Mod-z": undo,
      "Mod-y": redo,
      "Shift-Mod-z": redo,
    }),
    keymap(formattingKeymap),
    // Typora 式缓冲语法：块级标记（# / > / ``` / ---）浅色预览，
    // 回车确认转换；插件需排在 base keymap 之前以拦截回车。
    pendingSyntaxPlugin(),
    // 列表编辑：回车续项/空项退出、Tab 缩进、Shift-Tab 提升。
    // 必须在 pendingSyntax 之后（块级语法回车优先确认）、base keymap
    // 之前（先于普通 splitBlock）。
    listEditingPlugin(),
    keymap(baseKeymap),
    // 列表与行内样式即时转换：“- ”、“1. ” 立即成表，
    // **x**、*x*、`x`、~~x~~、[x](url) 闭合即应用。
    // 规则必须挂在 inputRules() 插件宿主上才会经 handleTextInput
    // 触发（此前块级规则失灵的根因就是缺宿主）。
    markdownInputRules(),
    dropCursor(),
    gapCursor(),
    ...(getPasteImageSource
      ? [createPasteImagePlugin(getPasteImageSource)]
      : []),
    ...(getDropImageSource
      ? [createDropImagePlugin(getDropImageSource)]
      : []),
  ];
}

export function WysiwygEditor({
  initialDoc,
  initialCursor,
  sessionKey,
  onChange,
  onPasteImage,
  onDropImage,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onChangeRef = useRef(onChange);
  const onPasteImageRef = useRef(onPasteImage);
  const onDropImageRef = useRef(onDropImage);
  const initialCursorRef = useRef(initialCursor);
  const [view, setView] = useState<EditorView | null>(null);
  const [linkDraft, setLinkDraft] = useState<LinkDraft | null>(null);
  const setEditorSelection = useContext(SetEditorSelectionContext);
  const setEditorView = useContext(SetEditorViewContext);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onPasteImageRef.current = onPasteImage;
  }, [onPasteImage]);

  useEffect(() => {
    onDropImageRef.current = onDropImage;
  }, [onDropImage]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const clampedCursor = Math.min(
      Math.max(0, initialCursorRef.current),
      initialDoc.content.size,
    );
    const state = EditorState.create({
      schema: markdownSchema,
      doc: initialDoc,
      selection: TextSelection.near(
        initialDoc.resolve(clampedCursor),
        1,
      ),
      plugins: createEditorPlugins(
        onPasteImageRef.current
          ? (file) =>
              onPasteImageRef.current?.(file) ?? Promise.resolve(null)
          : undefined,
        onDropImageRef.current
          ? (file) =>
              onDropImageRef.current?.(file) ?? Promise.resolve(null)
          : undefined,
      ),
    });
    const editorView = new EditorView(host, {
      state,
      attributes: {
        "aria-label": "Markdown 富文本编辑区",
        "data-testid": "wysiwyg-editor-content",
        // Electron 内置拼写检查只有 en-US 词典，中文与代码标识符会被
        // 整片标红波浪线，对中文文档场景是纯噪音，这里关闭。
        spellcheck: "false",
      },
      dispatchTransaction(transaction) {
        const nextState = editorView.state.apply(transaction);
        editorView.updateState(nextState);
        if (transaction.docChanged) onChangeRef.current(nextState.doc);
        if (transaction.selectionSet || transaction.docChanged) {
          setEditorSelection?.(nextState.selection.from);
        }
      },
    });

    setEditorView?.(editorView);
    setView(editorView);

    // Typora 的链接入口是 Ctrl/Cmd+K：以选区快照打开浮层。
    // 不经 keymap 插件而用原生监听，因为打开浮层需要 React 状态。
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();
        const selection = editorView.state.selection;
        const coords = editorView.coordsAtPos(selection.from);
        const left = Math.min(
          Math.max(coords.left, 12),
          Math.max(12, window.innerWidth - 380),
        );
        setLinkDraft({
          from: selection.from,
          to: selection.to,
          href: selectedLinkHref(editorView.state) ?? "",
          top: coords.bottom + 8,
          left,
        });
      }
    };
    editorView.dom.addEventListener("keydown", handleKeyDown);

    return () => {
      editorView.dom.removeEventListener("keydown", handleKeyDown);
      setLinkDraft(null);
      setEditorView?.((currentView) =>
        currentView === editorView ? null : currentView,
      );
      setView(null);
      editorView.destroy();
    };
  }, [sessionKey, setEditorSelection, setEditorView]);

  return (
    <>
      <div
        className="editor wysiwyg-editor"
        ref={hostRef}
        data-testid="wysiwyg-editor"
      />
      {linkDraft && view ? (
        <LinkPopover
          draft={linkDraft}
          view={view}
          onClose={() => setLinkDraft(null)}
        />
      ) : null}
    </>
  );
}
