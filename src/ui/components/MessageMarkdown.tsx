import { useMemo, type ReactNode } from 'react';
import { Linking, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

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
}

type MarkdownBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'blockquote'; text: string }
  | { kind: 'code'; language?: string; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'hr' };

const MAX_MARKDOWN_RENDER_CHARS = 300_000;
const MAX_MARKDOWN_BLOCKS = 1_500;
const MAX_TABLE_COLUMNS = 12;
const MAX_TABLE_ROWS = 200;

const monoFont = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

/**
 * Renders a bounded, non-HTML Markdown subset without a third-party parser.
 * User bubbles stay plain text elsewhere; this is for model output.
 */
export function MessageMarkdown({
  content,
  color,
  citations,
  variant = 'default',
}: MessageMarkdownProps) {
  const theme = useKelivoTheme();
  const markdownStyles = useMemo(
    () => createMarkdownStyles(theme, color, variant),
    [theme, color, variant]
  );
  const boundedContent = content.slice(0, MAX_MARKDOWN_RENDER_CHARS);
  const blocks = useMemo(() => parseMarkdownBlocks(boundedContent), [boundedContent]);
  const truncated = content.length > boundedContent.length;

  return (
    <View>
      {blocks.map((block, index) =>
        renderMarkdownBlock(block, index, markdownStyles, citations)
      )}
      {truncated ? (
        <Text selectable style={markdownStyles.truncated}>
          内容过长，已截断当前显示；原始回答仍保存在对话中。
        </Text>
      ) : null}
    </View>
  );
}

function parseMarkdownBlocks(input: string): MarkdownBlock[] {
  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length && blocks.length < MAX_MARKDOWN_BLOCKS) {
    const line = lines[index] ?? '';
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = /^\s{0,3}```\s*([^`]*)$/.exec(line);
    if (fence) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s{0,3}```\s*$/.test(lines[index] ?? '')) {
        codeLines.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({
        kind: 'code',
        ...(fence[1]?.trim() ? { language: fence[1].trim().slice(0, 40) } : {}),
        text: codeLines.join('\n'),
      });
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
      if (isBlockStart(next, lines[index + 1])) break;
      paragraph.push(next.trim());
      index += 1;
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
  }

  return blocks;
}

function isBlockStart(line: string, following?: string): boolean {
  return Boolean(
    /^\s{0,3}```/.test(line) ||
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

type MarkdownStyles = ReturnType<typeof createMarkdownStyles>;

function renderMarkdownBlock(
  block: MarkdownBlock,
  index: number,
  styles: MarkdownStyles,
  citations?: readonly WebCitation[]
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
        {renderInlineMarkdown(block.text, key, styles, citations)}
      </Text>
    );
  }
  if (block.kind === 'paragraph') {
    return (
      <Text key={key} selectable style={styles.paragraph}>
        {renderInlineMarkdown(block.text, key, styles, citations)}
      </Text>
    );
  }
  if (block.kind === 'blockquote') {
    return (
      <View key={key} style={styles.blockquote}>
        <Text selectable style={styles.paragraphCompact}>
          {renderInlineMarkdown(block.text, key, styles, citations)}
        </Text>
      </View>
    );
  }
  if (block.kind === 'code') {
    return (
      <View key={key} style={styles.fence}>
        {block.language ? <Text style={styles.codeLabel}>{block.language}</Text> : null}
        <Text selectable style={styles.codeBlockText}>
          {block.text}
        </Text>
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
              {renderInlineMarkdown(item, `${key}-item-${itemIndex}`, styles, citations)}
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
                    citations
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
  depth = 0
): ReactNode[] {
  const output: ReactNode[] = [];
  let plain = '';
  let index = 0;
  let nodeIndex = 0;
  const flush = () => {
    if (!plain) return;
    output.push(plain);
    plain = '';
  };
  const addStyled = (style: object, value: string, marker: string) => {
    flush();
    output.push(
      <Text key={`${keyPrefix}-${marker}-${nodeIndex++}`} style={style}>
        {depth < 3
          ? renderInlineMarkdown(value, `${keyPrefix}-${marker}-${nodeIndex}`, styles, citations, depth + 1)
          : value}
      </Text>
    );
  };

  while (index < text.length && nodeIndex < 2_000) {
    const character = text[index];
    if (character === '\\' && index + 1 < text.length) {
      plain += text[index + 1];
      index += 2;
      continue;
    }
    if (character === '[') {
      const labelEnd = text.indexOf('](', index + 1);
      const targetEnd = labelEnd >= 0 ? text.indexOf(')', labelEnd + 2) : -1;
      if (labelEnd >= 0 && targetEnd >= 0) {
        const label = text.slice(index + 1, labelEnd);
        const rawTarget = text.slice(labelEnd + 2, targetEnd);
        const target = resolveMessageMarkdownLink(rawTarget, citations);
        if (target) {
          flush();
          output.push(
            <Text
              key={`${keyPrefix}-link-${nodeIndex++}`}
              accessibilityRole="link"
              style={styles.link}
              onPress={() => void Linking.openURL(target).catch(() => undefined)}
            >
              {label || target}
            </Text>
          );
          index = targetEnd + 1;
          continue;
        }
      }
    }
    if (character === '`') {
      const end = text.indexOf('`', index + 1);
      if (end > index + 1) {
        flush();
        output.push(
          <Text key={`${keyPrefix}-code-${nodeIndex++}`} style={styles.code_inline}>
            {text.slice(index + 1, end)}
          </Text>
        );
        index = end + 1;
        continue;
      }
    }
    const pair = text.slice(index, index + 2);
    if (pair === '**' || pair === '__' || pair === '~~') {
      const end = text.indexOf(pair, index + 2);
      if (end > index + 2) {
        addStyled(pair === '~~' ? styles.s : styles.strong, text.slice(index + 2, end), pair);
        index = end + 2;
        continue;
      }
    }
    if (character === '*' || character === '_') {
      const end = text.indexOf(character, index + 1);
      if (end > index + 1) {
        addStyled(styles.em, text.slice(index + 1, end), character);
        index = end + 1;
        continue;
      }
    }
    plain += character;
    index += 1;
  }
  if (index < text.length) plain += text.slice(index);
  flush();
  return output;
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
      padding: 10,
      marginBottom: 10,
      gap: 6,
    },
    codeLabel: {
      color: muted,
      fontFamily: monoFont,
      fontSize: 11,
      textTransform: 'uppercase',
    },
    codeBlockText: {
      fontFamily: monoFont,
      color: bodyColor,
      fontSize: 13,
      lineHeight: 20,
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
