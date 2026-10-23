import { useContext, useEffect, useRef } from "react";
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
import { SetEditorSelectionContext, SetEditorViewContext } from "./Toolbar";

interface Props {
  initialDoc: Node;
  initialCursor: number;
  sessionKey: string;
  onChange(doc: Node): void;
  // 返回待插入的图片 src（相对路径或 data: URI）；null 表示放弃插入。
  onPasteImage?(file: File): Promise<string | null>;
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

export function createEditorPlugins(
  getPasteImageSource?: (file: File) => Promise<string | null>,
): Plugin[] {
  return [
    history(),
    keymap({
      "Mod-z": undo,
      "Mod-y": redo,
      "Shift-Mod-z": redo,
    }),
    keymap(formattingKeymap),
    keymap(baseKeymap),
    // 说明：曾尝试用 textblockTypeInputRule 让行首输入 “# ” 直接切换
    // 标题，但该规则在本应用的输入管线中未触发（原因未明），已移除；
    // Markdown 结构转换由工具栏命令与源码模式承担。
    dropCursor(),
    gapCursor(),
    ...(getPasteImageSource
      ? [createPasteImagePlugin(getPasteImageSource)]
      : []),
  ];
}

export function WysiwygEditor({
  initialDoc,
  initialCursor,
  sessionKey,
  onChange,
  onPasteImage,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onChangeRef = useRef(onChange);
  const onPasteImageRef = useRef(onPasteImage);
  const initialCursorRef = useRef(initialCursor);
  const setEditorSelection = useContext(SetEditorSelectionContext);
  const setEditorView = useContext(SetEditorViewContext);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onPasteImageRef.current = onPasteImage;
  }, [onPasteImage]);

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
      ),
    });
    const view = new EditorView(host, {
      state,
      attributes: {
        "aria-label": "Markdown 富文本编辑区",
        "data-testid": "wysiwyg-editor-content",
        // Electron 内置拼写检查只有 en-US 词典，中文与代码标识符会被
        // 整片标红波浪线，对中文文档场景是纯噪音，这里关闭。
        spellcheck: "false",
      },
      dispatchTransaction(transaction) {
        const nextState = view.state.apply(transaction);
        view.updateState(nextState);
        if (transaction.docChanged) onChangeRef.current(nextState.doc);
        if (transaction.selectionSet || transaction.docChanged) {
          setEditorSelection?.(nextState.selection.from);
        }
      },
    });

    setEditorView?.(view);

    return () => {
      setEditorView?.((currentView) =>
        currentView === view ? null : currentView,
      );
      view.destroy();
    };
  }, [sessionKey, setEditorSelection, setEditorView]);

  return (
    <div
      className="editor wysiwyg-editor"
      ref={hostRef}
      data-testid="wysiwyg-editor"
    />
  );
}
