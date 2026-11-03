import {
  InputRule,
  inputRules,
  wrappingInputRule,
} from "prosemirror-inputrules";
import type { MarkType } from "prosemirror-model";
import type { Plugin, Transaction } from "prosemirror-state";
import { markdownSchema } from "../../markdown/schema";
import { normalizeLinkHref } from "./commands";

/**
 * 即时转换的 Markdown 规则：
 * - 列表：行首 “- ” “1. ” + 空格立即转为列表（Typora 行为），后续的
 *   回车续项 / 空项回车退出 / Tab 缩进由 listEditing 插件负责；
 * - 行内样式：输入闭合定界符时立即应用。
 *
 * 其余块级语法（# 标题、> 引用、``` 代码块、--- 分隔线）不走
 * 即时转换，而是由 pendingSyntax 插件提供缓冲式预览，回车确认。
 * 全部规则由 inputRules() 插件宿主驱动（经 handleTextInput 触发），
 * 缺少该插件宿主时规则不会生效。
 */
export function markdownInputRules(): Plugin {
  return inputRules({ rules: [...listRules, ...inlineRules] });
}

const listRules = [
  // 行首 “- ” “* ” “+ ” → 立即转为无序列表
  wrappingInputRule(/^\s*[-*+]\s$/, markdownSchema.nodes.bullet_list),
  // 行首 “1. ” → 立即转为有序列表（保留起始编号，续号并入既有列表）
  wrappingInputRule(
    /^\s*(\d+)\.\s$/,
    markdownSchema.nodes.ordered_list,
    (match: RegExpMatchArray) => ({ start: Number(match[1]) }),
    (match: RegExpMatchArray, node) =>
      node.childCount + node.attrs.start === Number(match[1]),
  ),
];

/** 行内规则：输入闭合定界符时把定界符内的文本替换为带样式的文本。 */
function markInputRule(
  regexp: RegExp,
  markType: MarkType,
  contentGroup = 1,
): InputRule {
  return new InputRule(regexp, (state, match, start, end) => {
    const text = match[contentGroup];
    if (!text) return null;
    return state.tr.replaceWith(
      start,
      end,
      state.schema.text(text, [markType.create()]),
    );
  });
}

const inlineRules = [
  // **粗体**
  markInputRule(
    /\*\*([^\s*](?:[^*]*[^\s*])?)\*\*$/,
    markdownSchema.marks.strong,
  ),
  // *斜体*（排除 ** 的组成部分）
  markInputRule(
    /(?<!\S)\*([^\s*](?:[^*]*[^\s*])?)\*(?!\*)$/,
    markdownSchema.marks.em,
  ),
  // `行内代码`
  markInputRule(/`([^`\s](?:[^`]*[^`\s])?)`$/, markdownSchema.marks.code),
  // ~~删除线~~
  markInputRule(
    /~~([^\s~](?:[^~]*[^\s~])?)~~$/,
    markdownSchema.marks.strikethrough,
  ),
  // [文字](地址) → 链接；地址不合法时保持原文
  new InputRule(
    /\[([^\]\s][^\]]*)\]\(([^()\s]+)\)$/,
    (state, match, start, end): Transaction | null => {
      const text = match[1];
      const href = match[2];
      if (!text || !href) return null;
      try {
        normalizeLinkHref(href);
      } catch {
        return null;
      }
      return state.tr.replaceWith(
        start,
        end,
        state.schema.text(text, [markdownSchema.marks.link.create({ href })]),
      );
    },
  ),
];
