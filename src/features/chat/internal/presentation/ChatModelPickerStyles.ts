import { useMemo } from 'react';
import { Platform, StyleSheet } from 'react-native';

import {
  radii,
  serifFont,
  useChatPaneTheme,
  type AppPalette,
} from '../../chatPaneStyles';

function createChatModelPickerStyles(palette: AppPalette) {
  return StyleSheet.create({
    parameterSliderTrackArea: {
      height: 24,
      justifyContent: 'center',
    },
    parameterSliderTrack: {
      height: 4,
      borderRadius: 2,
      backgroundColor: palette.surfaceAlt,
    },
    parameterSliderFill: {
      position: 'absolute',
      left: 0,
      height: 4,
      borderRadius: 2,
      backgroundColor: palette.accent,
    },
    parameterSliderThumb: {
      position: 'absolute',
      width: 16,
      height: 16,
      marginLeft: -8,
      borderRadius: 8,
      backgroundColor: palette.bg,
      borderWidth: 2,
      borderColor: palette.accent,
    },
    parameterControl: {
      gap: 8,
    },
    parameterControlHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    parameterControlTitleBlock: {
      flex: 1,
      minWidth: 0,
    },
    parameterControlLabel: {
      color: palette.text,
      fontSize: 13,
      fontWeight: '700',
    },
    parameterControlHint: {
      marginTop: 2,
      color: palette.textSecondary,
      fontSize: 11,
      lineHeight: 15,
    },
    parameterValueInput: {
      width: 58,
      height: 32,
      borderRadius: radii.sm,
      borderWidth: 1,
      borderColor: palette.border,
      backgroundColor: palette.surface,
      color: palette.text,
      fontSize: 13,
      fontWeight: '700',
      textAlign: 'center',
      paddingHorizontal: 6,
      paddingVertical: 4,
      ...(Platform.OS === 'web' ? { outlineStyle: 'none' } as any : {}),
    },
    parameterRangeRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginTop: -4,
    },
    parameterRangeText: {
      color: palette.textMutedSolid,
      fontSize: 10,
      fontWeight: '600',
    },
    modelPickerModalRoot: {
      flex: 1,
      justifyContent: 'flex-end',
    },
    modelPickerBackdrop: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: palette.scrim,
    },
    modelPickerBackdropPressable: {
      flex: 1,
    },
    modelPickerSheet: {
      maxHeight: '82%',
      borderTopLeftRadius: radii.xl,
      borderTopRightRadius: radii.xl,
      backgroundColor: palette.surface,
      paddingTop: 8,
      shadowColor: '#2A2018',
      shadowOffset: { width: 0, height: -6 },
      shadowOpacity: 0.16,
      shadowRadius: 24,
      elevation: 16,
      overflow: 'hidden',
    },
    modelPickerHandle: {
      alignSelf: 'center',
      width: 40,
      height: 4,
      borderRadius: radii.pill,
      backgroundColor: palette.borderStrong,
      marginBottom: 6,
    },
    modelPickerSheetHeader: {
      minHeight: 58,
      paddingHorizontal: 18,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: palette.border,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
    },
    modelPickerTitleBlock: {
      flex: 1,
      minWidth: 0,
    },
    modelPickerTitle: {
      color: palette.text,
      fontSize: 18,
      fontWeight: '600',
      fontFamily: serifFont,
    },
    modelPickerSubtitle: {
      marginTop: 3,
      color: palette.textSecondary,
      fontSize: 12,
      fontWeight: '600',
    },
    modelPickerCloseButton: {
      width: 36,
      height: 36,
      borderRadius: radii.pill,
      borderWidth: 1,
      borderColor: palette.border,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: palette.surface,
    },
    modelPickerCloseText: {
      color: palette.textSecondary,
      fontSize: 20,
      lineHeight: 22,
      fontWeight: '600',
    },
    modelPickerScroll: {
      flexShrink: 1,
      minHeight: 0,
    },
    modelPickerList: {
      padding: 14,
      gap: 14,
    },
    modelPickerGroup: {
      gap: 8,
    },
    modelPickerGroupHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
    },
    modelPickerGroupName: {
      flex: 1,
      color: palette.textSecondary,
      fontSize: 13,
      fontWeight: '700',
    },
    modelPickerGroupCount: {
      minWidth: 24,
      height: 22,
      borderRadius: radii.pill,
      backgroundColor: palette.surfaceAlt,
      color: palette.textSecondary,
      overflow: 'hidden',
      textAlign: 'center',
      textAlignVertical: 'center',
      fontSize: 11,
      fontWeight: '700',
    },
    modelPickerRow: {
      minHeight: 56,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: palette.border,
      backgroundColor: palette.surface,
      paddingHorizontal: 14,
      paddingVertical: 10,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    modelPickerRowActive: {
      borderColor: palette.accentBorder,
      backgroundColor: palette.accentSoft,
    },
    modelPickerRowTextBlock: {
      flex: 1,
      minWidth: 0,
    },
    modelPickerRowName: {
      color: palette.text,
      fontSize: 14,
      fontWeight: '600',
    },
    modelPickerRowNameActive: {
      color: palette.accentText,
    },
    modelPickerRowMeta: {
      marginTop: 4,
      color: palette.textSecondary,
      fontSize: 12,
    },
    modelPickerSelectedText: {
      borderRadius: radii.pill,
      backgroundColor: palette.accent,
      color: palette.textOnAccent,
      overflow: 'hidden',
      paddingHorizontal: 10,
      paddingVertical: 5,
      fontSize: 12,
      fontWeight: '700',
    },
    modelPickerEmpty: {
      minHeight: 164,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: palette.border,
      backgroundColor: palette.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 16,
      gap: 8,
    },
    modelPickerEmptyText: {
      color: palette.text,
      fontSize: 15,
      fontWeight: '700',
    },
    modelPickerEmptyDescription: {
      color: palette.textSecondary,
      fontSize: 12,
      lineHeight: 17,
      textAlign: 'center',
    },
    modelPickerEmptyActions: {
      alignSelf: 'stretch',
      flexDirection: 'row',
      gap: 8,
      marginTop: 4,
    },
    modelPickerEmptyPrimaryButton: {
      flex: 1,
      minHeight: 40,
      borderRadius: radii.pill,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: palette.accent,
      paddingHorizontal: 12,
    },
    modelPickerEmptyPrimaryText: {
      color: palette.textOnAccent,
      fontSize: 13,
      fontWeight: '700',
    },
    modelPickerEmptySecondaryButton: {
      flex: 1,
      minHeight: 40,
      borderRadius: radii.pill,
      borderWidth: 1,
      borderColor: palette.border,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: palette.bg,
      paddingHorizontal: 12,
    },
    modelPickerEmptySecondaryText: {
      color: palette.text,
      fontSize: 13,
      fontWeight: '700',
    },
    modelTaskBadge: {
      alignSelf: 'flex-start',
      marginTop: 6,
      borderRadius: radii.pill,
      backgroundColor: palette.surfaceAlt,
      borderWidth: 1,
      borderColor: palette.border,
      paddingHorizontal: 9,
      paddingVertical: 4,
    },
    modelTaskBadgeText: {
      color: palette.textSecondary,
      fontSize: 11,
      fontWeight: '700',
    }
  });
}

const chatModelPickerStylesByPalette = new WeakMap<AppPalette, ReturnType<typeof createChatModelPickerStyles>>();

function chatModelPickerStylesFor(palette: AppPalette) {
  const cached = chatModelPickerStylesByPalette.get(palette);
  if (cached) return cached;
  const styles = createChatModelPickerStyles(palette);
  chatModelPickerStylesByPalette.set(palette, styles);
  return styles;
}

export function useChatModelPickerTheme() {
  const base = useChatPaneTheme();
  const ownedStyles = chatModelPickerStylesFor(base.palette);
  const styles = useMemo(
    () => ({ ...base.styles, ...ownedStyles }),
    [base.styles, ownedStyles]
  );
  return { ...base, styles };
}
