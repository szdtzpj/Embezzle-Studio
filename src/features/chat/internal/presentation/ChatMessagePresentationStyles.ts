import { useMemo } from 'react';
import { Platform, StyleSheet } from 'react-native';

import {
  radii,
  useChatPaneTheme,
  type AppPalette,
} from '../../chatPaneStyles';

function createChatMessagePresentationStyles(palette: AppPalette) {
  return StyleSheet.create({
    assistantMetaRow: {
      minHeight: 26,
      flexDirection: 'row',
      alignItems: 'center',
      minWidth: 0,
      gap: 7,
    },
    assistantModelName: {
      flexShrink: 1,
      minWidth: 0,
      maxWidth: 140,
      color: palette.text,
      fontSize: 14,
      lineHeight: 18,
      fontWeight: '600',
    },
    assistantMetaDivider: {
      color: palette.textSecondary,
      fontSize: 12,
      lineHeight: 16,
    },
    assistantProviderName: {
      maxWidth: 100,
      color: palette.textSecondary,
      fontSize: 12,
      lineHeight: 16,
      fontWeight: '400',
    },
    assistantTime: {
      color: palette.textSecondary,
      fontSize: 11,
      lineHeight: 16,
    },
    userMessageActions: {
      marginTop: 8,
      marginRight: 8,
    },
    messageInlineEditor: {
      width: '100%',
      minWidth: 0,
      gap: 10,
    },
    messageInlineEditInput: {
      width: '100%',
      minHeight: 76,
      maxHeight: 150,
      borderRadius: radii.sm,
      borderWidth: 1,
      color: palette.text,
      fontSize: 15,
      lineHeight: 22,
      paddingHorizontal: 10,
      paddingVertical: 8,
      textAlignVertical: 'top',
      ...(Platform.OS === 'web' ? { outlineStyle: 'none' } as any : {}),
    },
    userInlineEditInput: {
      borderColor: palette.userEditBorder,
      backgroundColor: palette.userEditBubble,
    },
    assistantInlineEditInput: {
      borderColor: palette.border,
      backgroundColor: palette.surfaceAlt,
    },
    inlineEditActions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: 8,
    },
    inlineEditSecondaryButton: {
      minWidth: 66,
      height: 34,
      borderRadius: radii.sm,
      borderWidth: 1,
      borderColor: palette.border,
      backgroundColor: palette.surface,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 12,
    },
    inlineEditSecondaryText: {
      color: palette.textSecondary,
      fontSize: 13,
      fontWeight: '700',
    },
    inlineEditPrimaryButton: {
      minWidth: 88,
      height: 34,
      borderRadius: radii.sm,
      backgroundColor: palette.accent,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 12,
    },
    inlineEditPrimaryText: {
      color: palette.textOnAccent,
      fontSize: 13,
      fontWeight: '800',
    },
    messageActionMenu: {
      alignSelf: 'flex-start',
      minWidth: 150,
      maxWidth: 190,
      marginTop: 6,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: palette.border,
      backgroundColor: palette.surface,
      overflow: 'hidden',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.1,
      shadowRadius: 18,
      elevation: 10,
    },
    userMessageActionMenu: {
      alignSelf: 'flex-end',
      marginRight: 6,
    },
    messageActionMenuRow: {
      minHeight: 36,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      paddingHorizontal: 12,
      borderBottomWidth: 1,
      borderBottomColor: palette.border,
    },
    messageActionMenuText: {
      flex: 1,
      minWidth: 0,
      color: palette.text,
      fontSize: 13,
      fontWeight: '700',
    },
    messageActionMenuDangerRow: {
      borderBottomWidth: 0,
    },
    messageActionMenuDangerText: {
      color: palette.danger,
    },
    webCitationChip: {
      alignSelf: 'flex-start',
      minHeight: 30,
      borderRadius: radii.pill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
      backgroundColor: palette.surface,
      paddingHorizontal: 10,
      paddingVertical: 5,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    webCitationFaviconStack: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    webCitationFaviconWrap: {
      borderRadius: 9,
      borderWidth: 1.5,
      borderColor: palette.surface,
      overflow: 'hidden',
    },
    webCitationFavicon: {
      width: 16,
      height: 16,
      borderRadius: 8,
      backgroundColor: palette.surfaceAlt,
    },
    webCitationFaviconFallback: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    webCitationFaviconLetter: {
      fontSize: 9,
      fontWeight: '800',
      color: palette.textSecondary,
    },
    webCitationChipText: {
      color: palette.text,
      fontSize: 12,
      fontWeight: '600',
    },
    webCitationSheetScrim: {
      flex: 1,
      justifyContent: 'flex-end',
      backgroundColor: palette.scrim,
    },
    webCitationSheet: {
      backgroundColor: palette.bg,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      paddingHorizontal: 16,
      paddingTop: 10,
      width: '100%',
    },
    webCitationSheetHandle: {
      alignSelf: 'center',
      width: 40,
      height: 4,
      borderRadius: 2,
      backgroundColor: palette.border,
      marginBottom: 12,
    },
    webCitationSheetHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 8,
      minHeight: 36,
    },
    webCitationSheetTitle: {
      color: palette.text,
      fontSize: 17,
      fontWeight: '700',
    },
    webCitationSheetClose: {
      width: 32,
      height: 32,
      alignItems: 'center',
      justifyContent: 'center',
    },
    webCitationSheetList: {
      paddingBottom: 8,
      gap: 4,
    },
    webCitationSheetRow: {
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: palette.border,
      gap: 6,
    },
    webCitationSheetRowTop: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
    },
    webCitationSheetHostGroup: {
      flex: 1,
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    webCitationSheetFavicon: {
      width: 16,
      height: 16,
      borderRadius: 4,
      backgroundColor: palette.surfaceAlt,
    },
    webCitationSheetHost: {
      flex: 1,
      color: palette.textSecondary,
      fontSize: 12,
      fontWeight: '500',
    },
    webCitationSheetIndex: {
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: palette.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
    },
    webCitationSheetIndexText: {
      color: palette.textSecondary,
      fontSize: 11,
      fontWeight: '700',
    },
    webCitationSheetItemTitle: {
      color: palette.text,
      fontSize: 15,
      fontWeight: '600',
      lineHeight: 21,
    },
    webCitationSheetSnippet: {
      color: palette.textSecondary,
      fontSize: 13,
      lineHeight: 18,
    },
    mcpActivityPanel: {
      borderWidth: 1,
      borderColor: palette.border,
      borderRadius: radii.md,
      backgroundColor: palette.surface,
      padding: 10,
      gap: 7,
    },
    mcpActivityHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
    },
    mcpActivityTitleGroup: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    mcpActivityTitle: {
      color: palette.textSecondary,
      fontSize: 11,
      fontWeight: '800',
    },
    mcpActivityRequestCount: {
      color: palette.textSecondary,
      fontSize: 10,
    },
    mcpActivityServer: {
      color: palette.textSecondary,
      fontSize: 10,
      lineHeight: 15,
    },
    mcpActivityEmpty: {
      color: palette.textSecondary,
      fontSize: 11,
      lineHeight: 16,
    },
    mcpActivityRow: {
      minHeight: 26,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
    },
    mcpActivityTool: {
      flex: 1,
      color: palette.text,
      fontSize: 11,
      lineHeight: 16,
      fontWeight: '600',
    },
    mcpActivityApproved: {
      color: palette.success,
      fontSize: 10,
      fontWeight: '700',
    },
    mcpActivityDenied: {
      color: palette.danger,
      fontSize: 10,
      fontWeight: '700',
    },
    mcpActivityUnknown: {
      color: palette.warning,
      fontSize: 10,
      fontWeight: '700',
    },
    mcpActivityWarning: {
      color: palette.warning,
      fontSize: 10,
      lineHeight: 15,
    },
    tokenUsageRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: 8,
    },
    tokenUsageItem: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
    },
    generationTaskPanel: {
      marginTop: 12,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: palette.border,
      backgroundColor: palette.surfaceAlt,
      padding: 12,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    generationTaskInfo: {
      flex: 1,
      minWidth: 0,
    },
    generationTaskTitle: {
      color: palette.text,
      fontSize: 12,
      fontWeight: '700',
    },
    generationTaskMeta: {
      marginTop: 4,
      color: palette.textSecondary,
      fontSize: 12,
    },
    generationTaskStatus: {
      marginTop: 4,
      color: palette.textSecondary,
      fontSize: 12,
      fontWeight: '600',
    },
    generationTaskButton: {
      height: 36,
      borderRadius: radii.pill,
      backgroundColor: palette.accent,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 14,
    },
    generationTaskButtonText: {
      color: palette.textOnAccent,
      fontSize: 12,
      fontWeight: '700',
    }
  });
}

const chatMessagePresentationStylesByPalette = new WeakMap<AppPalette, ReturnType<typeof createChatMessagePresentationStyles>>();

function chatMessagePresentationStylesFor(palette: AppPalette) {
  const cached = chatMessagePresentationStylesByPalette.get(palette);
  if (cached) return cached;
  const styles = createChatMessagePresentationStyles(palette);
  chatMessagePresentationStylesByPalette.set(palette, styles);
  return styles;
}

export function useChatMessagePresentationTheme() {
  const base = useChatPaneTheme();
  const ownedStyles = chatMessagePresentationStylesFor(base.palette);
  const styles = useMemo(
    () => ({ ...base.styles, ...ownedStyles }),
    [base.styles, ownedStyles]
  );
  return { ...base, styles };
}
