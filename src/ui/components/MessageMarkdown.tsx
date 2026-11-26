import * as Clipboard from 'expo-clipboard';
import { Check, Copy } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { WebCitation } from '../../domain/types';
import { resolveMessageMarkdownLink } from '../../services/externalSearch';
import { useKelivoTheme, type KelivoTheme } from '../theme';

export interface MessageMarkdownProps {
  content: string;
  /** Optional color override for body text (e.g. error state). */
  color?: string;
  citations?: readonly WebCitation[];
  /** `muted` uses smaller secondary text for thinking/process content. */
  variant?: 'default' | 'muted';
  /** 内联引用角标 [n] 点击回调（1-based 索引）。 */
  onCitationPress?: (citationIndex: number, citation?: WebCitation) => void;
}

export type MarkdownBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'blockquote'; text: string }
  | { kind: 'code'; language?: string; text: string }
  | { kind: 'latex'; text: string; display: true }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'hr' };

export interface InlineRichSegment {
  kind: 'text' | 'strong' | 'em' | 'strike' | 'code' | 'latex' | 'link' | 'citation';
  text: string;
  index?: number;
  citation?: WebCitation;
  url?: string;
}

export type CodeTokenType =
  | 'keyword'
  | 'string'
  | 'number'
  | 'comment'
  | 'type'
  | 'operator'
  | 'punctuation'
  | 'identifier'
  | 'whitespace'
  | 'plain';

export interface CodeHighlightToken {
  text: string;
  tokenType: CodeTokenType;
}

const MAX_MARKDOWN_RENDER_CHARS = 300_000;
const MAX_MARKDOWN_BLOCKS = 1_500;
const MAX_INLINE_SEGMENTS = 2_000;
const MAX_INLINE_LATEX_LENGTH = 200;
const MAX_TABLE_COLUMNS = 12;
const MAX_TABLE_ROWS = 200;

const monoFont = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

const CODE_KEYWORDS = new Set([
  'as',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'def',
  'default',
  'defer',
  'delete',
  'do',
  'elif',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'False',
  'final',
  'finally',
  'fn',
  'for',
  'from',
  'func',
  'function',
  'go',
  'if',
  'impl',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'is',
  'lambda',
  'let',
  'match',
  'mod',
  'mut',
  'new',
  'none',
  'None',
  'not',
  'null',
  'of',
  'or',
  'package',
  'pass',
  'private',
  'protected',
  'pub',
  'public',
  'raise',
  'readonly',
  'return',
  'select',
  'self',
  'static',
  'struct',
  'super',
  'switch',
  'this',
  'throw',
  'trait',
  'true',
  'True',
  'try',
  'type',
  'typeof',
  'undefined',
  'use',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'SELECT',
  'FROM',
  'WHERE',
  'INSERT',
  'INTO',
  'VALUES',
  'UPDATE',
  'SET',
  'DELETE',
  'JOIN',
  'LEFT',
  'RIGHT',
  'INNER',
  'ON',
  'GROUP',
  'BY',
  'ORDER',
  'LIMIT',
  'CREATE',
  'TABLE',
  'ALTER',
  'DROP',
  'AS',
  'AND',
  'OR',
  'NOT',
  'NULL',
]);

const CODE_TYPES = new Set([
  'any',
  'Array',
  'bigint',
  'bool',
  'boolean',
  'char',
  'dict',
  'double',
  'Error',
  'f32',
  'f64',
  'float',
  'i32',
  'i64',
  'int',
  'list',
  'Map',
  'never',
  'number',
  'object',
  'Promise',
  'ReactNode',
  'Record',
  'Set',
  'set',
  'str',
  'string',
  'symbol',
  'tuple',
  'u32',
  'u64',
  'unknown',
  'usize',
  'Vec',
  'Option',
  'Result',
]);

const DOUBLE_DASH_COMMENT_LANGS = new Set(['sql', 'postgresql', 'mysql', 'sqlite', 'lua', 'haskell', 'ada']);
const HASH_COMMENT_LANGS = new Set([
  'py',
  'python',
  'bash',
  'sh',
  'zsh',
  'shell',
  'yaml',
  'yml',
  'toml',
  'ini',
  'ruby',
  'rb',
  'perl',
  'pl',
  'r',
  'dockerfile',
  'makefile',
]);

/**
 * Renders a bounded, non-HTML Markdown subset without a third-party parser.
 * User bubbles stay plain text elsewhere; this is for model output.
 */
export function MessageMarkdown({
  content,
  color,
  citations,
  variant = 'default',
  onCitationPress,
}: MessageMarkdownProps) {
  const theme = useKelivoTheme();
  const markdownStyles = useMemo(
    () => createMarkdownStyles(theme, color, variant),
    [theme, color, variant]
  );
  const blocks = useMemo(() => parseMarkdownBlocks(content), [content]);
  const truncated = content.length > MAX_MARKDOWN_RENDER_CHARS;

  return (
    <View>
      {blocks.map((block, index) =>
        renderMarkdownBlock(block, index, markdownStyles, theme, color, citations, onCitationPress)
      )}
      {truncated ? (
        <Text selectable style={markdownStyles.truncated}>
          内容过长，已截断当前显示；原始回答仍保存在对话中。
        </Text>
      ) : null}
    </View>
  );
}

interface LatexScanState {
  noCloseEnd: number;
}

/**
 * 解析受限子集 Markdown 为块级 AST，入口执行 300,000 字符与 1,500 块双层有界保护。
 * 支持多反引号嵌套围栏代码块与块级 `$$...$$` LaTeX 公式（未闭合 `$$` 自动退化为普通文本，且通过扫描记忆化保持 O(L) 线性时间）。
 */
export function parseMarkdownBlocks(input: string): MarkdownBlock[] {
  const bounded = input.slice(0, MAX_MARKDOWN_RENDER_CHARS);
  const lines = bounded.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  const latexScanState: LatexScanState = { noCloseEnd: -1 };
  let index = 0;

  while (index < lines.length && blocks.length < MAX_MARKDOWN_BLOCKS) {
    const line = lines[index] ?? '';
    if (!line.trim()) {
      index += 1;
      continue;
    }

    // 匹配 3 个及以上反引号围栏，确保内嵌代码块不会被过早闭合或污染为公式/引用
    const fence = /^\s{0,3}(`{3,})\s*([^`]*)$/.exec(line);
    if (fence) {
      const fenceTicks = fence[1].length;
      const closeFenceRegex = new RegExp(`^\\s{0,3}\`{${fenceTicks},}\\s*$`);
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !closeFenceRegex.test(lines[index] ?? '')) {
        codeLines.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({
        kind: 'code',
        ...(fence[2]?.trim() ? { language: fence[2].trim().slice(0, 40) } : {}),
        text: codeLines.join('\n'),
      });
      continue;
    }

    // 单行块级公式 `$$...$$`
    const singleLatex = /^\s{0,3}\$\$(.+?)\$\$\s*$/.exec(line);
    if (singleLatex && singleLatex[1].trim()) {
      blocks.push({
        kind: 'latex',
        text: singleLatex[1].trim(),
        display: true,
      });
      index += 1;
      continue;
    }

    // 多行块级公式 `$$ ... $$`：仅当下方存在闭合 `$$` 时才解析为 latex 块，否则退化为普通段落
    const multilineLatex = tryParseMultilineLatexBlock(lines, index, latexScanState);
    if (multilineLatex) {
      blocks.push({
        kind: 'latex',
        text: multilineLatex.text,
        display: true,
      });
      index = multilineLatex.nextIndex;
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() });
      index += 1;
      continue;
    }

    if (/^\s{0,3}((\*|-|_)\s*){3,}$/.test(line)) {
      blocks.push({ kind: 'hr' });
      index += 1;
      continue;
    }

    if (line.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1] ?? '')) {
      const header = splitTableRow(line);
      const rows: string[][] = [];
      index += 2;
      while (
        index < lines.length &&
        rows.length < MAX_TABLE_ROWS &&
        (lines[index] ?? '').includes('|') &&
        (lines[index] ?? '').trim()
      ) {
        rows.push(splitTableRow(lines[index] ?? ''));
        index += 1;
      }
      if (header.length) blocks.push({ kind: 'table', header, rows });
      continue;
    }

    if (/^\s{0,3}>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s{0,3}>\s?/.test(lines[index] ?? '')) {
        quote.push((lines[index] ?? '').replace(/^\s{0,3}>\s?/, ''));
        index += 1;
      }
      blocks.push({ kind: 'blockquote', text: quote.join('\n') });
      continue;
    }

    const firstListItem = parseListItem(line);
    if (firstListItem) {
      const items = [firstListItem.text];
      const ordered = firstListItem.ordered;
      index += 1;
      while (index < lines.length && items.length < 500) {
        const next = parseListItem(lines[index] ?? '');
        if (!next || next.ordered !== ordered) break;
        items.push(next.text);
        index += 1;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    const paragraph: string[] = [line.trim()];
    index += 1;
    while (index < lines.length && (lines[index] ?? '').trim()) {
      const next = lines[index] ?? '';
      if (isBlockStart(next, lines[index + 1], lines, index, latexScanState)) break;
      paragraph.push(next.trim());
      index += 1;
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
  }

  return blocks;
}

/**
 * 尝试从指定行解析多行 `$$...$$` 块级公式；若未找到闭合行则返回 `null` 以退化为普通文本，
 * 并通过 `scanState.noCloseEnd` 记忆无闭合区间以彻底消除连续未闭合 `$$` 的 $O(L^2)$ 回溯。
 */
function tryParseMultilineLatexBlock(
  lines: readonly string[],
  startIndex: number,
  scanState?: LatexScanState
): { text: string; nextIndex: number } | null {
  if (scanState && startIndex < scanState.noCloseEnd) {
    return null;
  }

  const firstLine = lines[startIndex] ?? '';
  const openMatch = /^\s{0,3}\$\$(.*)$/.exec(firstLine);
  if (!openMatch) return null;
  const trailing = openMatch[1] ?? '';
  if (trailing.includes('$$')) return null;

  const collected: string[] = [];
  if (trailing.trim()) {
    collected.push(trailing.trim());
  }

  let cursor = startIndex + 1;
  while (cursor < lines.length) {
    const candidate = lines[cursor] ?? '';
    // 若遇到代码块围栏，终止查找避免跨代码块误配对；记录当前无闭合区间的截止行号
    if (/^\s{0,3}`{3,}/.test(candidate)) {
      if (scanState && cursor > scanState.noCloseEnd) {
        scanState.noCloseEnd = cursor;
      }
      return null;
    }
    const closeMatch = /^(.*?)\$\$\s*$/.exec(candidate);
    if (closeMatch) {
      const beforeClose = closeMatch[1]?.trim();
      if (beforeClose) {
        collected.push(beforeClose);
      }
      const merged = collected.join('\n').trim();
      if (!merged) {
        if (scanState && cursor > scanState.noCloseEnd) {
          scanState.noCloseEnd = cursor;
        }
        return null;
      }
      return {
        text: merged,
        nextIndex: cursor + 1,
      };
    }
    collected.push(candidate);
    cursor += 1;
  }

  if (scanState && cursor > scanState.noCloseEnd) {
    scanState.noCloseEnd = cursor;
  }
  return null;
}

function isBlockStart(
  line: string,
  following?: string,
  allLines?: readonly string[],
  lineIndex?: number,
  latexScanState?: LatexScanState
): boolean {
  if (/^\s{0,3}\$\$(.+?)\$\$\s*$/.test(line)) {
    return true;
  }
  if (
    allLines !== undefined &&
    lineIndex !== undefined &&
    /^\s{0,3}\$\$/.test(line) &&
    tryParseMultilineLatexBlock(allLines, lineIndex, latexScanState) !== null
  ) {
    return true;
  }
  return Boolean(
    /^\s{0,3}`{3,}/.test(line) ||
      /^\s{0,3}#{1,6}\s+/.test(line) ||
      /^\s{0,3}>\s?/.test(line) ||
      /^\s{0,3}((\*|-|_)\s*){3,}$/.test(line) ||
      parseListItem(line) ||
      (line.includes('|') && following !== undefined && isTableSeparator(following))
  );
}

function parseListItem(line: string): { ordered: boolean; text: string } | null {
  const unordered = /^\s{0,6}[-+*]\s+(.+)$/.exec(line);
  if (unordered) return { ordered: false, text: unordered[1].trim() };
  const ordered = /^\s{0,6}\d{1,6}[.)]\s+(.+)$/.exec(line);
  return ordered ? { ordered: true, text: ordered[1].trim() } : null;
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line);
  return Boolean(
    cells.length &&
      cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')))
  );
}

function splitTableRow(line: string): string[] {
  const value = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let current = '';
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '|') {
      cells.push(current.trim());
      current = '';
      if (cells.length >= MAX_TABLE_COLUMNS) break;
      continue;
    }
    current += character;
  }
  if (cells.length < MAX_TABLE_COLUMNS) cells.push(current.trim());
  return cells.slice(0, MAX_TABLE_COLUMNS);
}

const MAX_LINK_TARGET_LENGTH = 2_048;
const MAX_LINK_PAREN_DEPTH = 16;

/**
 * 判断指定索引处的字符是否未被前面的连续反斜杠转义。
 */
function isUnescapedAt(text: string, pos: number): boolean {
  let slashCount = 0;
  let cursor = pos - 1;
  while (cursor >= 0 && text[cursor] === '\\') {
    slashCount += 1;
    cursor -= 1;
  }
  return (slashCount & 1) === 0;
}

/**
 * 按 1-based 索引查找引用条目：优先匹配显式 `citation.index`，未显式指定有效 `index` 的条目按数组位置 `idx + 1` 回退映射。
 */
function findCitationByIndex(
  citations: readonly WebCitation[] | undefined,
  targetIndex: number
): WebCitation | undefined {
  if (!citations?.length || targetIndex < 1) return undefined;
  const explicit = citations.find((item) => item.index === targetIndex);
  if (explicit) return explicit;
  return citations.find(
    (item, idx) =>
      !(typeof item.index === 'number' && item.index > 0) && idx + 1 === targetIndex
  );
}

/**
 * 使用平衡括号计数查找 Markdown 链接 `[label](url)` 目标区的闭合 `)` 索引，支持如 Wikipedia 含配对括号的 URL，
 * 并通过 `MAX_LINK_PAREN_DEPTH` 限制最大嵌套深度以防止恶意连续 `(` 触发重复扫描。
 */
function findMarkdownLinkTargetEnd(text: string, targetStart: number): number {
  let parenDepth = 0;
  let cursor = targetStart;
  const limit = Math.min(text.length, targetStart + MAX_LINK_TARGET_LENGTH);

  while (cursor < limit) {
    const ch = text[cursor];
    if (ch === '\n' || ch === '\r') {
      return -1;
    }
    if (ch === '\\' && cursor + 1 < limit) {
      cursor += 2;
      continue;
    }
    if (ch === '(') {
      parenDepth += 1;
      if (parenDepth > MAX_LINK_PAREN_DEPTH) {
        return -1;
      }
    } else if (ch === ')') {
      if (parenDepth === 0) {
        return cursor;
      }
      parenDepth -= 1;
    }
    cursor += 1;
  }

  return -1;
}

/**
 * 在同一行内寻找行内 `$...$` 公式的闭合位置：
 * - 自动防止 `$100` / `$19.99` / `$100+tax=$` 等货币串位误判；
 * - 支持 `$a$$b$` 紧邻公式正确在第一个 `$` 闭合。
 */
function findInlineLatexClose(text: string, openIndex: number): number {
  const afterOpen = text[openIndex + 1];
  if (!afterOpen || afterOpen === '$' || /\s/.test(afterOpen)) {
    return -1;
  }

  // 货币金额防误伤（使用 sticky 正则零切片检查）
  const currencyRegex = /\d+(?:[.,]\d+)?(?=\s|[,.;:!?，。；：！？)）\]\u4e00-\u9fff]|$)/y;
  currencyRegex.lastIndex = openIndex + 1;
  if (currencyRegex.test(text)) {
    return -1;
  }

  const startsWithDigit = /\d/.test(afterOpen);
  let cursor = openIndex + 1;

  while (cursor < text.length) {
    if (cursor - openIndex - 1 > MAX_INLINE_LATEX_LENGTH) {
      return -1;
    }
    const ch = text[cursor];
    if (ch === '\n' || ch === '\r') {
      return -1;
    }
    if (ch === '\\' && cursor + 1 < text.length) {
      cursor += 2;
      continue;
    }
    if (ch === '$') {
      const next = text[cursor + 1] ?? '';
      // 若紧随其后还是 `$`，仅当第二个 `$` 可开启下一条有效行内表达式时才在此处闭合当前公式（如 `$a$$b$`）
      if (next === '$') {
        const afterSecond = text[cursor + 2] ?? '';
        if (!afterSecond || afterSecond === '$' || /[\s,.;:!?，。；：！？)）\]]/.test(afterSecond)) {
          return -1;
        }
      }

      const prev = text[cursor - 1] ?? '';
      if (/\s/.test(prev)) {
        return -1;
      }
      // 防止 `$100+tax=$x+1$` 或 `$100+$x$` 等以运算符/标点结尾并紧邻新表达式的货币串位
      if (prev === '=' || prev === ',' || prev === ';' || prev === ':') {
        return -1;
      }
      if ((prev === '+' || prev === '-' || prev === '*' || prev === '/') && /[A-Za-z0-9$]/.test(next)) {
        return -1;
      }
      if (/\d/.test(next) || (startsWithDigit && /[A-Za-z0-9]/.test(next))) {
        return -1;
      }

      const inner = text.slice(openIndex + 1, cursor);
      if (
        inner.length > 0 &&
        inner.length <= MAX_INLINE_LATEX_LENGTH &&
        !/[\u4e00-\u9fff]/.test(inner)
      ) {
        return cursor;
      }
      return -1;
    }
    cursor += 1;
  }
  return -1;
}

/**
 * 查找单字符强调（`*` / `_`）的合法闭合位置：
 * - `*` 要求开星号后非空白且闭星号前非空白；
 * - `_` 额外要求开下划线左侧与闭下划线右侧均不在 `[A-Za-z0-9_]` 单词内部（保护 `my_variable_name`）。
 */
function findSingleEmphasisClose(
  text: string,
  openIndex: number,
  marker: '*' | '_',
  requireWordBoundary: boolean
): { end: number; reachedEndWithoutCandidate: boolean } {
  const afterOpen = text[openIndex + 1] ?? '';
  if (!afterOpen || afterOpen === marker || /\s/.test(afterOpen)) {
    return { end: -1, reachedEndWithoutCandidate: false };
  }
  if (requireWordBoundary) {
    const prevOpen = openIndex > 0 ? text[openIndex - 1] ?? '' : '';
    if (/[A-Za-z0-9_]/.test(prevOpen)) {
      return { end: -1, reachedEndWithoutCandidate: false };
    }
  }

  let cursor = openIndex + 1;
  while (cursor < text.length) {
    const ch = text[cursor];
    if (ch === '\\' && cursor + 1 < text.length) {
      cursor += 2;
      continue;
    }
    if (ch === marker) {
      const prev = text[cursor - 1] ?? '';
      const next = text[cursor + 1] ?? '';
      const validPrev = !/\s/.test(prev);
      const validBoundary = !requireWordBoundary || !/[A-Za-z0-9_]/.test(next);
      if (cursor > openIndex + 1 && validPrev && validBoundary) {
        return { end: cursor, reachedEndWithoutCandidate: false };
      }
    }
    cursor += 1;
  }

  return { end: -1, reachedEndWithoutCandidate: true };
}

/**
 * 解析行内富文本片段，统一输出 `{ kind, text, index?, citation?, url? }` 结构。
 * 防护规则：O(N) 线性位置缓存与 sticky 匹配、转义 `\$` 与货币 `$100` 防误判、紧邻公式 `$a$$b$`、词内下划线/算术乘号隔离、配对括号 URL、越界 `[99]` 退化与危险链接过滤。
 */
export function parseInlineRichSegments(
  text: string,
  citations?: readonly WebCitation[]
): InlineRichSegment[] {
  const segments: InlineRichSegment[] = [];
  const citeRegex = /\[(\d+(?:\s*,\s*\d+)*)\](?!\()/y;
  let plain = '';
  let index = 0;

  // 单调向前位置缓存（-2 表示尚未搜索，-1 表示全文后续已无目标标记）
  let nextBacktickPos = -2;
  let nextLinkMidPos = -2;
  let deadLinkMidPos = -1;
  let nextNewlinePos = -2;
  let nextOpenBracketPos = -2;
  let nextCloseBracketPos = -2;
  let nextCloseParenPos = -2;
  let invalidLinkOpenUntil = 0;
  let cachedLinkMidPos = -1;
  let cachedLinkValidOpenPos = -1;
  let nextDoubleStarPos = -2;
  let nextDoubleUnderPos = -2;
  let nextDoubleTildePos = -2;
  let hasNoMoreValidStar = false;
  let hasNoMoreValidUnder = false;

  const findCached = (cachedPos: number, needle: string, fromIndex: number): number => {
    if (cachedPos === -1 || cachedPos >= fromIndex) {
      return cachedPos;
    }
    return text.indexOf(needle, fromIndex);
  };

  const pushText = (chunk: string) => {
    if (!chunk) return;
    plain += chunk;
  };

  const flushPlain = () => {
    if (!plain) return;
    const prev = segments[segments.length - 1];
    if (prev?.kind === 'text') {
      prev.text += plain;
    } else {
      segments.push({ kind: 'text', text: plain });
    }
    plain = '';
  };

  while (index < text.length && segments.length < MAX_INLINE_SEGMENTS) {
    const character = text[index] ?? '';

    if (character === '\\' && index + 1 < text.length) {
      pushText(text[index + 1] ?? '');
      index += 2;
      continue;
    }

    if (character === '`') {
      nextBacktickPos = findCached(nextBacktickPos, '`', index + 1);
      if (nextBacktickPos > index + 1) {
        flushPlain();
        segments.push({ kind: 'code', text: text.slice(index + 1, nextBacktickPos) });
        index = nextBacktickPos + 1;
        continue;
      }
    }

    if (character === '[') {
      // 优先解析 Markdown 链接 [label](url)，全程使用单调缓存与括号栈记忆化确保严格 O(N) 线性复杂度
      let consumedLink = false;
      nextLinkMidPos = findCached(nextLinkMidPos, '](', index + 1);
      if (
        nextLinkMidPos >= 0 &&
        nextLinkMidPos !== deadLinkMidPos &&
        index >= invalidLinkOpenUntil
      ) {
        const labelEnd = nextLinkMidPos;
        nextNewlinePos = findCached(nextNewlinePos, '\n', index + 1);
        const hasCrossNewline = nextNewlinePos >= 0 && nextNewlinePos < labelEnd;

        if (!hasCrossNewline) {
          let canMatchLabel = false;

          if (cachedLinkMidPos === labelEnd) {
            canMatchLabel = index === cachedLinkValidOpenPos;
          } else {
            nextOpenBracketPos = findCached(nextOpenBracketPos, '[', index + 1);
            nextCloseBracketPos = findCached(nextCloseBracketPos, ']', index + 1);
            const hasInnerOpen = nextOpenBracketPos >= 0 && nextOpenBracketPos < labelEnd;
            const hasInnerClose = nextCloseBracketPos >= 0 && nextCloseBracketPos < labelEnd;

            if (!hasInnerOpen && !hasInnerClose) {
              canMatchLabel = isUnescapedAt(text, labelEnd);
              if (!canMatchLabel) {
                deadLinkMidPos = labelEnd;
              }
            } else if (
              hasInnerOpen &&
              !hasInnerClose &&
              isUnescapedAt(text, nextOpenBracketPos)
            ) {
              // 在 labelEnd 前遇到内部未闭合 `[`（如 `[` 连写），O(1) 拒绝外层 `[`
              canMatchLabel = false;
            } else if (
              hasInnerClose &&
              (!hasInnerOpen || nextCloseBracketPos < nextOpenBracketPos) &&
              isUnescapedAt(text, nextCloseBracketPos)
            ) {
              // 在遇到下一个 `[` 前当前 `[` 已提前闭合（如 `[1] and [Docs](url)`），防止吞并前序引用或标签
              if (nextCloseBracketPos + 1 > invalidLinkOpenUntil) {
                invalidLinkOpenUntil = nextCloseBracketPos + 1;
              }
              canMatchLabel = false;
            } else {
              // 含嵌套方括号或转义括号（如 `[outer [inner] text](url)` 或 `[a [b]] and [c](url)`）：
              // 对同一个 `labelEnd` 最多扫描一次括号平衡状态并缓存唯一合法起点
              const openStack: number[] = [index];
              let cursor = index + 1;
              let closedEarly = false;

              while (cursor < labelEnd) {
                const ch = text[cursor];
                if (ch === '\n' || ch === '\r') {
                  if (cursor + 1 > invalidLinkOpenUntil) {
                    invalidLinkOpenUntil = cursor + 1;
                  }
                  closedEarly = true;
                  break;
                }
                if (ch === '\\' && cursor + 1 < labelEnd) {
                  cursor += 2;
                  continue;
                }
                if (ch === '[') {
                  openStack.push(cursor);
                } else if (ch === ']') {
                  openStack.pop();
                  if (openStack.length === 0) {
                    if (cursor + 1 > invalidLinkOpenUntil) {
                      invalidLinkOpenUntil = cursor + 1;
                    }
                    closedEarly = true;
                    break;
                  }
                }
                cursor += 1;
              }

              if (!closedEarly) {
                if (!isUnescapedAt(text, labelEnd)) {
                  deadLinkMidPos = labelEnd;
                  canMatchLabel = false;
                } else {
                  const validOpenPos = openStack[openStack.length - 1] ?? -1;
                  cachedLinkMidPos = labelEnd;
                  cachedLinkValidOpenPos = validOpenPos;
                  canMatchLabel = index === validOpenPos;
                }
              }
            }
          }

          if (canMatchLabel) {
            const targetStart = labelEnd + 2;
            nextCloseParenPos = findCached(nextCloseParenPos, ')', targetStart);
            const hasNoCloseParenInScope =
              nextCloseParenPos === -1 ||
              (nextNewlinePos >= 0 && nextCloseParenPos > nextNewlinePos) ||
              nextCloseParenPos >= targetStart + MAX_LINK_TARGET_LENGTH;

            if (hasNoCloseParenInScope) {
              // 当前行及目标长度窗口内无任何 `)`，O(1) 标记失效避免重复扫描
              deadLinkMidPos = labelEnd;
            } else {
              const targetEnd = findMarkdownLinkTargetEnd(text, targetStart);
              if (targetEnd >= 0) {
                const rawTarget = text.slice(targetStart, targetEnd);
                const target = resolveMessageMarkdownLink(rawTarget, citations);
                if (target) {
                  const label = text.slice(index + 1, labelEnd);
                  flushPlain();
                  segments.push({
                    kind: 'link',
                    text: label || target,
                    url: target,
                  });
                  index = targetEnd + 1;
                  consumedLink = true;
                } else {
                  // 该 `](` 对应无效/危险 URL，记录失效以免前置 `[` 重复校验
                  deadLinkMidPos = labelEnd;
                }
              } else {
                deadLinkMidPos = labelEnd;
              }
            }
          }
        }
      }
      if (consumedLink) {
        continue;
      }

      // 其次使用 sticky 正则原位解析内联引用角标 [1] 或 [1, 2]，消除 slice 拷贝
      citeRegex.lastIndex = index;
      const citeMatch = citeRegex.exec(text);
      if (citeMatch) {
        const rawIndices = citeMatch[1]
          .split(',')
          .map((part) => Number.parseInt(part.trim(), 10))
          .filter((value) => Number.isFinite(value));
        const matched = rawIndices.map((idx) => ({
          idx,
          citation: findCitationByIndex(citations, idx),
        }));
        if (matched.some((item) => item.citation !== undefined)) {
          flushPlain();
          for (const item of matched) {
            if (item.citation) {
              segments.push({
                kind: 'citation',
                text: `[${item.idx}]`,
                index: item.idx,
                citation: item.citation,
              });
            } else {
              segments.push({
                kind: 'text',
                text: `[${item.idx}]`,
              });
            }
          }
          index += citeMatch[0].length;
          continue;
        }
        pushText(citeMatch[0]);
        index += citeMatch[0].length;
        continue;
      }
    }

    if (character === '$') {
      if (text[index + 1] === '$') {
        pushText('$$');
        index += 2;
        continue;
      }
      const prevChar = index > 0 ? text[index - 1] ?? '' : '';
      if (!/[A-Za-z0-9]/.test(prevChar)) {
        const closeIndex = findInlineLatexClose(text, index);
        if (closeIndex > index + 1) {
          flushPlain();
          segments.push({
            kind: 'latex',
            text: text.slice(index + 1, closeIndex),
          });
          index = closeIndex + 1;
          continue;
        }
      }
      pushText('$');
      index += 1;
      continue;
    }

    const nextChar = text[index + 1] ?? '';
    if (character === '*' && nextChar === '*') {
      const afterOpen = text[index + 2] ?? '';
      if (afterOpen && !/\s/.test(afterOpen)) {
        nextDoubleStarPos = findCached(nextDoubleStarPos, '**', index + 2);
        if (nextDoubleStarPos > index + 2 && !/\s/.test(text[nextDoubleStarPos - 1] ?? '')) {
          flushPlain();
          segments.push({
            kind: 'strong',
            text: text.slice(index + 2, nextDoubleStarPos),
          });
          index = nextDoubleStarPos + 2;
          continue;
        }
      }
    } else if (character === '_' && nextChar === '_') {
      const prevOpen = index > 0 ? text[index - 1] ?? '' : '';
      const afterOpen = text[index + 2] ?? '';
      if (!/[A-Za-z0-9_]/.test(prevOpen) && afterOpen && !/\s/.test(afterOpen)) {
        nextDoubleUnderPos = findCached(nextDoubleUnderPos, '__', index + 2);
        if (
          nextDoubleUnderPos > index + 2 &&
          !/\s/.test(text[nextDoubleUnderPos - 1] ?? '') &&
          !/[A-Za-z0-9_]/.test(text[nextDoubleUnderPos + 2] ?? '')
        ) {
          flushPlain();
          segments.push({
            kind: 'strong',
            text: text.slice(index + 2, nextDoubleUnderPos),
          });
          index = nextDoubleUnderPos + 2;
          continue;
        }
      }
    } else if (character === '~' && nextChar === '~') {
      nextDoubleTildePos = findCached(nextDoubleTildePos, '~~', index + 2);
      if (nextDoubleTildePos > index + 2) {
        flushPlain();
        segments.push({
          kind: 'strike',
          text: text.slice(index + 2, nextDoubleTildePos),
        });
        index = nextDoubleTildePos + 2;
        continue;
      }
    }

    if (character === '*' && !hasNoMoreValidStar) {
      const res = findSingleEmphasisClose(text, index, '*', false);
      if (res.end > index + 1) {
        flushPlain();
        segments.push({
          kind: 'em',
          text: text.slice(index + 1, res.end),
        });
        index = res.end + 1;
        continue;
      }
      if (res.reachedEndWithoutCandidate) {
        hasNoMoreValidStar = true;
      }
    } else if (character === '_' && !hasNoMoreValidUnder) {
      const res = findSingleEmphasisClose(text, index, '_', true);
      if (res.end > index + 1) {
        flushPlain();
        segments.push({
          kind: 'em',
          text: text.slice(index + 1, res.end),
        });
        index = res.end + 1;
        continue;
      }
      if (res.reachedEndWithoutCandidate) {
        hasNoMoreValidUnder = true;
      }
    }

    pushText(character);
    index += 1;
  }

  if (index < text.length) {
    pushText(text.slice(index));
  }
  flushPlain();
  return segments;
}

/**
 * O(n) 单次扫描代码语法高亮分词器。
 * 保证 `tokens.map(t => t.text).join('') === code` 恒成立，且永不产出 `latex` 或 `citation` 类型。
 */
export function highlightCodeTokens(
  code: string,
  language?: string
): CodeHighlightToken[] {
  if (!code) return [];

  const lang = (language ?? '').trim().toLowerCase();
  const enableHashComment = HASH_COMMENT_LANGS.has(lang);
  const enableDoubleDashComment = DOUBLE_DASH_COMMENT_LANGS.has(lang);
  const tokens: CodeHighlightToken[] = [];
  let cursor = 0;

  const pushToken = (tokenType: CodeTokenType, text: string) => {
    if (!text) return;
    const prev = tokens[tokens.length - 1];
    if (prev && prev.tokenType === tokenType) {
      prev.text += text;
    } else {
      tokens.push({ tokenType, text });
    }
  };

  while (cursor < code.length) {
    const ch = code[cursor] ?? '';

    // 1. 空白字符
    if (/\s/.test(ch)) {
      let end = cursor + 1;
      while (end < code.length && /\s/.test(code[end] ?? '')) {
        end += 1;
      }
      pushToken('whitespace', code.slice(cursor, end));
      cursor = end;
      continue;
    }

    // 2. 单行注释 //
    if (ch === '/' && code[cursor + 1] === '/') {
      const newlineIndex = code.indexOf('\n', cursor + 2);
      const end = newlineIndex === -1 ? code.length : newlineIndex;
      pushToken('comment', code.slice(cursor, end));
      cursor = end;
      continue;
    }

    // 3. 块级注释 /* ... */
    if (ch === '/' && code[cursor + 1] === '*') {
      const closeIndex = code.indexOf('*/', cursor + 2);
      const end = closeIndex === -1 ? code.length : closeIndex + 2;
      pushToken('comment', code.slice(cursor, end));
      cursor = end;
      continue;
    }

    // 4. 脚本语言 # 注释或 SQL/Lua -- 注释
    if (
      (ch === '#' && (enableHashComment || !lang)) ||
      (enableDoubleDashComment && ch === '-' && code[cursor + 1] === '-')
    ) {
      const newlineIndex = code.indexOf('\n', cursor + 1);
      const end = newlineIndex === -1 ? code.length : newlineIndex;
      pushToken('comment', code.slice(cursor, end));
      cursor = end;
      continue;
    }

    // 5. 字符串字面量（单引号、双引号、模板反引号）
    if (ch === '"' || ch === "'" || ch === '`') {
      let end = cursor + 1;
      while (end < code.length) {
        const current = code[end] ?? '';
        if (current === '\\' && end + 1 < code.length) {
          end += 2;
          continue;
        }
        if (current === ch) {
          end += 1;
          break;
        }
        if (ch !== '`' && current === '\n') {
          break;
        }
        end += 1;
      }
      pushToken('string', code.slice(cursor, end));
      cursor = end;
      continue;
    }

    // 6. 数字字面量（含十六进制/二进制/小数/科学计数）
    if (/[0-9]/.test(ch)) {
      const numMatch = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)/.exec(
        code.slice(cursor)
      );
      if (numMatch) {
        pushToken('number', numMatch[0]);
        cursor += numMatch[0].length;
        continue;
      }
    }

    // 7. 标识符 / 关键字 / 类型
    if (/[A-Za-z_$]/.test(ch)) {
      const idMatch = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(code.slice(cursor));
      if (idMatch) {
        const word = idMatch[0];
        let tokenType: CodeTokenType = 'identifier';
        if (CODE_KEYWORDS.has(word)) {
          tokenType = 'keyword';
        } else if (CODE_TYPES.has(word) || /^[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*$/.test(word)) {
          tokenType = 'type';
        }
        pushToken(tokenType, word);
        cursor += word.length;
        continue;
      }
    }

    // 8. 标点符号
    if ('()[]{}.,;'.includes(ch)) {
      pushToken('punctuation', ch);
      cursor += 1;
      continue;
    }

    // 9. 运算符
    const opMatch = /^(?:===|!==|=>|==|!=|<=|>=|&&|\|\||\?\?|\?\.|\+\+|--|\+=|-=|\*=|\/=|[+\-*/%=<>!&|^~?:])/.exec(
      code.slice(cursor)
    );
    if (opMatch) {
      pushToken('operator', opMatch[0]);
      cursor += opMatch[0].length;
      continue;
    }

    // 10. 兜底普通字符（保证无遗漏）
    pushToken('plain', ch);
    cursor += 1;
  }

  return tokens;
}

/**
 * 仅在 UI 显示阶段把常见 LaTeX 符号转换为更易读的 Unicode 数学排版，绝不修改解析层原始文本。
 */
function formatLatexForDisplay(raw: string): string {
  return raw
    .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '($1)/($2)')
    .replace(/\\sqrt\{([^{}]+)\}/g, '√($1)')
    .replace(/\\infty/g, '∞')
    .replace(/\\pi/g, 'π')
    .replace(/\\alpha/g, 'α')
    .replace(/\\beta/g, 'β')
    .replace(/\\gamma/g, 'γ')
    .replace(/\\delta/g, 'δ')
    .replace(/\\theta/g, 'θ')
    .replace(/\\lambda/g, 'λ')
    .replace(/\\sigma/g, 'σ')
    .replace(/\\omega/g, 'ω')
    .replace(/\\sum/g, '∑')
    .replace(/\\int/g, '∫')
    .replace(/\\times/g, '×')
    .replace(/\\cdot/g, '·')
    .replace(/\\leq/g, '≤')
    .replace(/\\geq/g, '≥')
    .replace(/\\neq/g, '≠')
    .replace(/\\approx/g, '≈')
    .replace(/\\rightarrow/g, '→')
    .replace(/\\left|\\right/g, '');
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (
    Platform.OS === 'web' &&
    typeof navigator !== 'undefined' &&
    navigator.clipboard?.writeText
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // 回退至 expo-clipboard
    }
  }
  await Clipboard.setStringAsync(text);
}

function getTokenHighlightColors(theme: KelivoTheme, bodyColor: string): Record<CodeTokenType, string> {
  if (theme.scheme === 'dark') {
    return {
      keyword: '#C084FC',
      string: '#86EFAC',
      number: '#FDBA74',
      comment: '#8B949E',
      type: '#7DD3FC',
      operator: '#9CA3AF',
      punctuation: '#9CA3AF',
      identifier: bodyColor,
      whitespace: bodyColor,
      plain: bodyColor,
    };
  }
  return {
    keyword: '#7C3AED',
    string: '#0F766E',
    number: '#B45309',
    comment: '#6B7280',
    type: '#0369A1',
    operator: '#4B5563',
    punctuation: '#4B5563',
    identifier: bodyColor,
    whitespace: bodyColor,
    plain: bodyColor,
  };
}

/**
 * 独立代码块渲染组件：展示语言标签、一键复制按钮（带定时器清理）以及语法高亮横向滚动内容区。
 */
function MarkdownCodeBlock({
  language,
  code,
  styles,
  theme,
  bodyColor,
}: {
  language?: string;
  code: string;
  styles: MarkdownStyles;
  theme: KelivoTheme;
  bodyColor: string;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const tokens = useMemo(() => highlightCodeTokens(code, language), [code, language]);
  const tokenColors = useMemo(
    () => getTokenHighlightColors(theme, bodyColor),
    [theme, bodyColor]
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const handleCopy = () => {
    void copyTextToClipboard(code)
      .then(() => {
        if (!mountedRef.current) return;
        setCopied(true);
        if (timerRef.current) {
          clearTimeout(timerRef.current);
        }
        timerRef.current = setTimeout(() => {
          if (!mountedRef.current) return;
          setCopied(false);
          timerRef.current = null;
        }, 1600);
      })
      .catch(() => undefined);
  };

  return (
    <View style={styles.fence}>
      <View style={styles.codeHeader}>
        <Text style={styles.codeLabel}>{language || 'CODE'}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copied ? '已复制代码' : '复制代码'}
          onPress={handleCopy}
          hitSlop={6}
          style={({ pressed }) => [styles.codeCopyButton, pressed && styles.codeCopyButtonPressed]}
        >
          {copied ? (
            <Check size={13} color={theme.colors.success} strokeWidth={2.4} />
          ) : (
            <Copy size={13} color={theme.colors.textSecondary} strokeWidth={2} />
          )}
          <Text style={[styles.codeCopyText, copied && { color: theme.colors.success }]}>
            {copied ? '已复制' : '复制'}
          </Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator style={styles.codeScroll}>
        <Text selectable style={styles.codeBlockText}>
          {tokens.map((token, idx) => (
            <Text key={`tok-${idx}`} style={{ color: tokenColors[token.tokenType] }}>
              {token.text}
            </Text>
          ))}
        </Text>
      </ScrollView>
    </View>
  );
}

type MarkdownStyles = ReturnType<typeof createMarkdownStyles>;

function renderMarkdownBlock(
  block: MarkdownBlock,
  index: number,
  styles: MarkdownStyles,
  theme: KelivoTheme,
  color?: string,
  citations?: readonly WebCitation[],
  onCitationPress?: (citationIndex: number, citation?: WebCitation) => void
): ReactNode {
  const key = `md-block-${index}`;
  if (block.kind === 'heading') {
    const headingStyle =
      block.level === 1
        ? styles.heading1
        : block.level === 2
          ? styles.heading2
          : block.level === 3
            ? styles.heading3
            : block.level === 4
              ? styles.heading4
              : block.level === 5
                ? styles.heading5
                : styles.heading6;
    return (
      <Text key={key} selectable style={headingStyle}>
        {renderInlineMarkdown(block.text, key, styles, citations, onCitationPress)}
      </Text>
    );
  }
  if (block.kind === 'paragraph') {
    return (
      <Text key={key} selectable style={styles.paragraph}>
        {renderInlineMarkdown(block.text, key, styles, citations, onCitationPress)}
      </Text>
    );
  }
  if (block.kind === 'blockquote') {
    return (
      <View key={key} style={styles.blockquote}>
        <Text selectable style={styles.paragraphCompact}>
          {renderInlineMarkdown(block.text, key, styles, citations, onCitationPress)}
        </Text>
      </View>
    );
  }
  if (block.kind === 'code') {
    const bodyColor = color ?? theme.colors.text;
    return (
      <MarkdownCodeBlock
        key={key}
        language={block.language}
        code={block.text}
        styles={styles}
        theme={theme}
        bodyColor={bodyColor}
      />
    );
  }
  if (block.kind === 'latex') {
    return (
      <View key={key} style={styles.latexBlock}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <Text selectable style={styles.latexBlockText}>
            {formatLatexForDisplay(block.text)}
          </Text>
        </ScrollView>
      </View>
    );
  }
  if (block.kind === 'list') {
    return (
      <View key={key} style={block.ordered ? styles.ordered_list : styles.bullet_list}>
        {block.items.map((item, itemIndex) => (
          <View key={`${key}-item-${itemIndex}`} style={styles.listItemRow}>
            <Text style={block.ordered ? styles.ordered_list_icon : styles.bullet_list_icon}>
              {block.ordered ? `${itemIndex + 1}.` : '•'}
            </Text>
            <Text selectable style={styles.list_item}>
              {renderInlineMarkdown(item, `${key}-item-${itemIndex}`, styles, citations, onCitationPress)}
            </Text>
          </View>
        ))}
      </View>
    );
  }
  if (block.kind === 'table') {
    const rows = [block.header, ...block.rows];
    return (
      <ScrollView key={key} horizontal showsHorizontalScrollIndicator style={styles.tableScroll}>
        <View style={styles.table}>
          {rows.map((row, rowIndex) => (
            <View key={`${key}-row-${rowIndex}`} style={styles.tableRow}>
              {block.header.map((_, columnIndex) => (
                <Text
                  key={`${key}-cell-${rowIndex}-${columnIndex}`}
                  selectable
                  style={[styles.tableCell, rowIndex === 0 && styles.tableHeaderCell]}
                >
                  {renderInlineMarkdown(
                    row[columnIndex] ?? '',
                    `${key}-cell-${rowIndex}-${columnIndex}`,
                    styles,
                    citations,
                    onCitationPress
                  )}
                </Text>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    );
  }
  return <View key={key} style={styles.hr} />;
}

function renderInlineMarkdown(
  text: string,
  keyPrefix: string,
  styles: MarkdownStyles,
  citations?: readonly WebCitation[],
  onCitationPress?: (citationIndex: number, citation?: WebCitation) => void,
  depth = 0
): ReactNode[] {
  const segments = parseInlineRichSegments(text, citations);
  return segments.map((segment, idx) => {
    const segKey = `${keyPrefix}-seg-${depth}-${idx}`;
    if (segment.kind === 'text') {
      return segment.text;
    }
    if (segment.kind === 'code') {
      return (
        <Text key={segKey} style={styles.code_inline}>
          {segment.text}
        </Text>
      );
    }
    if (segment.kind === 'latex') {
      return (
        <Text key={segKey} style={styles.latexInline}>
          {formatLatexForDisplay(segment.text)}
        </Text>
      );
    }
    if (segment.kind === 'link' && segment.url) {
      const targetUrl = segment.url;
      return (
        <Text
          key={segKey}
          accessibilityRole="link"
          style={styles.link}
          onPress={() => void Linking.openURL(targetUrl).catch(() => undefined)}
        >
          {segment.text}
        </Text>
      );
    }
    if (segment.kind === 'citation' && typeof segment.index === 'number') {
      const citationIndex = segment.index;
      const citationItem = segment.citation;
      return (
        <Text
          key={segKey}
          accessibilityRole="button"
          accessibilityLabel={`查看第 ${citationIndex} 条引用来源`}
          style={styles.citationBadge}
          onPress={() => {
            if (onCitationPress) {
              onCitationPress(citationIndex, citationItem);
              return;
            }
            const safeUrl = citationItem?.url
              ? resolveMessageMarkdownLink(citationItem.url, citations)
              : null;
            if (safeUrl) {
              void Linking.openURL(safeUrl).catch(() => undefined);
            }
          }}
        >
          {` ${citationIndex} `}
        </Text>
      );
    }
    if (segment.kind === 'strong' || segment.kind === 'em' || segment.kind === 'strike') {
      const style =
        segment.kind === 'strike'
          ? styles.s
          : segment.kind === 'strong'
            ? styles.strong
            : styles.em;
      return (
        <Text key={segKey} style={style}>
          {depth < 3
            ? renderInlineMarkdown(
                segment.text,
                segKey,
                styles,
                citations,
                onCitationPress,
                depth + 1
              )
            : segment.text}
        </Text>
      );
    }
    return segment.text;
  });
}

function createMarkdownStyles(
  theme: KelivoTheme,
  color?: string,
  variant: 'default' | 'muted' = 'default'
) {
  const mutedMode = variant === 'muted';
  const bodyColor = color ?? (mutedMode ? theme.colors.textSecondary : theme.colors.text);
  const muted = theme.colors.textTertiary;
  const border = theme.colors.outline;
  const codeBg = theme.colors.surfaceSunken;
  const link = theme.colors.accentText;
  const bodySize = mutedMode ? 13 : 15;
  const bodyLine = mutedMode ? 19 : 24;
  const paraBottom = mutedMode ? 6 : 10;

  return StyleSheet.create({
    paragraph: {
      color: bodyColor,
      fontSize: bodySize,
      lineHeight: bodyLine,
      marginBottom: paraBottom,
    },
    paragraphCompact: {
      color: bodyColor,
      fontSize: bodySize,
      lineHeight: bodyLine,
    },
    heading1: {
      color: bodyColor,
      fontSize: mutedMode ? 16 : 20,
      fontWeight: '700',
      lineHeight: mutedMode ? 22 : 28,
      marginTop: 4,
      marginBottom: mutedMode ? 6 : 8,
    },
    heading2: {
      color: bodyColor,
      fontSize: mutedMode ? 15 : 18,
      fontWeight: '700',
      lineHeight: mutedMode ? 21 : 26,
      marginTop: 4,
      marginBottom: mutedMode ? 6 : 8,
    },
    heading3: {
      color: bodyColor,
      fontSize: mutedMode ? 14 : 16,
      fontWeight: '700',
      lineHeight: mutedMode ? 20 : 24,
      marginTop: 4,
      marginBottom: 6,
    },
    heading4: {
      color: bodyColor,
      fontSize: mutedMode ? 13 : 15,
      fontWeight: '700',
      lineHeight: mutedMode ? 19 : 22,
      marginTop: 2,
      marginBottom: 6,
    },
    heading5: {
      color: bodyColor,
      fontSize: mutedMode ? 13 : 14,
      fontWeight: '700',
      lineHeight: 20,
      marginBottom: 4,
    },
    heading6: {
      color: muted,
      fontSize: 12,
      fontWeight: '700',
      lineHeight: 18,
      marginBottom: 4,
    },
    strong: { fontWeight: '700', color: bodyColor },
    em: { fontStyle: 'italic', color: bodyColor },
    s: { textDecorationLine: 'line-through', color: muted },
    link: { color: link, textDecorationLine: 'underline' },
    blockquote: {
      backgroundColor: theme.colors.surface,
      borderLeftWidth: 3,
      borderLeftColor: theme.colors.primary,
      paddingHorizontal: 10,
      paddingVertical: 6,
      marginBottom: 10,
    },
    code_inline: {
      fontFamily: monoFont,
      backgroundColor: codeBg,
      color: bodyColor,
      fontSize: 13,
    },
    fence: {
      backgroundColor: codeBg,
      borderColor: border,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: 10,
      paddingHorizontal: 10,
      paddingTop: 8,
      paddingBottom: 10,
      marginBottom: 10,
      gap: 6,
    },
    codeHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingBottom: 4,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: border,
      gap: 8,
    },
    codeLabel: {
      color: muted,
      fontFamily: monoFont,
      fontSize: 11,
      textTransform: 'uppercase',
    },
    codeCopyButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 6,
      backgroundColor: theme.colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: border,
    },
    codeCopyButtonPressed: {
      opacity: 0.72,
    },
    codeCopyText: {
      color: theme.colors.textSecondary,
      fontSize: 11,
      fontWeight: '600',
    },
    codeScroll: {
      flexGrow: 0,
    },
    codeBlockText: {
      fontFamily: monoFont,
      color: bodyColor,
      fontSize: 13,
      lineHeight: 20,
    },
    latexBlock: {
      backgroundColor: codeBg,
      borderColor: border,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      marginBottom: 10,
    },
    latexBlockText: {
      fontFamily: monoFont,
      color: bodyColor,
      fontSize: 14,
      lineHeight: 22,
    },
    latexInline: {
      fontFamily: monoFont,
      backgroundColor: codeBg,
      color: bodyColor,
      fontSize: mutedMode ? 12 : 14,
    },
    citationBadge: {
      backgroundColor: theme.colors.citationBadge,
      color: theme.colors.accentText,
      fontSize: 11,
      fontWeight: '700',
      borderRadius: 6,
      overflow: 'hidden',
    },
    bullet_list: { marginBottom: 8, gap: 4 },
    ordered_list: { marginBottom: 8, gap: 4 },
    listItemRow: { flexDirection: 'row', alignItems: 'flex-start' },
    list_item: { flex: 1, color: bodyColor, fontSize: bodySize, lineHeight: bodyLine },
    bullet_list_icon: { color: bodyColor, width: 20, marginLeft: 4 },
    ordered_list_icon: { color: bodyColor, minWidth: 26, marginLeft: 4, marginRight: 4 },
    hr: {
      backgroundColor: border,
      height: StyleSheet.hairlineWidth,
      marginVertical: 12,
    },
    tableScroll: { marginBottom: 10 },
    table: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: border,
      borderRadius: 8,
      overflow: 'hidden',
    },
    tableRow: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: border },
    tableCell: {
      width: 160,
      padding: 8,
      color: bodyColor,
      fontSize: mutedMode ? 12 : 13,
      lineHeight: mutedMode ? 18 : 20,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderColor: border,
    },
    tableHeaderCell: { fontWeight: '700', backgroundColor: theme.colors.surface },
    truncated: { color: muted, fontSize: 12, lineHeight: 18, marginBottom: 8 },
  });
}
