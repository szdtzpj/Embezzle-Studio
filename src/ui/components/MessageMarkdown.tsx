import { useMemo } from 'react';
import { Linking, Platform, StyleSheet } from 'react-native';
import Markdown from 'react-native-markdown-display';

import type { WebCitation } from '../../domain/types';
import { resolveMessageMarkdownLink } from '../../services/externalSearch';
import { useKelivoTheme, type KelivoTheme } from '../theme';

export interface MessageMarkdownProps {
  content: string;
  /** Optional color override for body text (e.g. error state). */
  color?: string;
  citations?: readonly WebCitation[];
  /**
   * `muted` — smaller, secondary colors for thinking / process text.
   * `default` — full assistant body styling.
   */
  variant?: 'default' | 'muted';
}

const monoFont = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

/**
 * Renders assistant (and similar) message bodies as Markdown.
 * User bubbles stay plain text elsewhere — this is for model output.
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

  return (
    <Markdown
      style={markdownStyles}
      onLinkPress={(url) => {
        const target = resolveMessageMarkdownLink(url ?? '', citations);
        if (!target) return false;
        void Linking.openURL(target).catch(() => undefined);
        // Return false so the library does not also try to handle navigation.
        return false;
      }}
    >
      {content}
    </Markdown>
  );
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
    body: {
      color: bodyColor,
      fontSize: bodySize,
      lineHeight: bodyLine,
    },
    paragraph: {
      color: bodyColor,
      fontSize: bodySize,
      lineHeight: bodyLine,
      marginTop: 0,
      marginBottom: paraBottom,
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
    strong: {
      fontWeight: '700',
      color: bodyColor,
    },
    em: {
      fontStyle: 'italic',
      color: bodyColor,
    },
    s: {
      textDecorationLine: 'line-through',
      color: muted,
    },
    link: {
      color: link,
      textDecorationLine: 'underline',
    },
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
      paddingHorizontal: 4,
      paddingVertical: 1,
      borderRadius: 4,
    },
    fence: {
      fontFamily: monoFont,
      backgroundColor: codeBg,
      borderColor: border,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: 10,
      padding: 10,
      marginBottom: 10,
      color: bodyColor,
      fontSize: 13,
      lineHeight: 20,
    },
    code_block: {
      fontFamily: monoFont,
      backgroundColor: codeBg,
      borderColor: border,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: 10,
      padding: 10,
      marginBottom: 10,
      color: bodyColor,
      fontSize: 13,
      lineHeight: 20,
    },
    bullet_list: {
      marginBottom: 8,
    },
    ordered_list: {
      marginBottom: 8,
    },
    list_item: {
      marginBottom: 4,
      color: bodyColor,
    },
    bullet_list_icon: {
      color: bodyColor,
      marginLeft: 4,
      marginRight: 8,
    },
    ordered_list_icon: {
      color: bodyColor,
      marginLeft: 4,
      marginRight: 8,
    },
    hr: {
      backgroundColor: border,
      height: StyleSheet.hairlineWidth,
      marginVertical: 12,
    },
    table: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: border,
      borderRadius: 8,
      marginBottom: 10,
    },
    tr: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: border,
    },
    th: {
      padding: 8,
      fontWeight: '700',
      color: bodyColor,
      backgroundColor: theme.colors.surface,
    },
    td: {
      padding: 8,
      color: bodyColor,
    },
    text: {
      color: bodyColor,
    },
  });
}
