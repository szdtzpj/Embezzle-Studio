import { useMemo } from 'react';
import { StyleSheet } from 'react-native';

import {
  radii,
  useChatPaneTheme,
  type AppPalette,
} from '../../chatPaneStyles';

function createChatAttachmentPresentationStyles(palette: AppPalette) {
  return StyleSheet.create({
    pendingAttachment: {
      width: 104,
      aspectRatio: 1,
      borderRadius: radii.md,
      backgroundColor: palette.surface,
      borderWidth: 1,
      borderColor: palette.border,
      overflow: 'hidden',
      position: 'relative',
    },
    pendingAttachmentImage: {
      width: '100%',
      height: '100%',
      backgroundColor: palette.surfaceAlt,
    },
    pendingAttachmentFallback: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: palette.surfaceAlt,
    },
    pendingAttachmentNameBar: {
      position: 'absolute',
      right: 0,
      bottom: 0,
      left: 0,
      minHeight: 28,
      justifyContent: 'center',
      paddingHorizontal: 8,
      paddingRight: 26,
      backgroundColor: 'rgba(13, 13, 13, 0.72)',
    },
    pendingAttachmentName: {
      color: palette.mediaOverlayText,
      fontSize: 11,
      fontWeight: '600',
    },
    pendingAttachmentRemove: {
      position: 'absolute',
      top: 6,
      right: 6,
      width: 24,
      height: 24,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(13, 13, 13, 0.82)',
    },
    buttonPressed: {
      opacity: 0.72,
    },
    attachmentVideoViewport: {
      width: '100%',
      aspectRatio: 16 / 9,
      position: 'relative',
      backgroundColor: '#0D0D0D',
    },
    attachmentVideoView: {
      width: '100%',
      height: '100%',
      backgroundColor: '#0D0D0D',
    },
    attachmentVideoStatusOverlay: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      paddingHorizontal: 16,
      backgroundColor: 'rgba(13, 13, 13, 0.72)',
    },
    attachmentVideoStatusText: {
      color: palette.mediaOverlayText,
      fontSize: 12,
      fontWeight: '600',
      textAlign: 'center',
    },
    attachmentImageFrame: {
      width: 104,
      aspectRatio: 1,
      borderRadius: radii.md,
      overflow: 'hidden',
      backgroundColor: palette.surfaceAlt,
    },
    attachmentImage: {
      width: '100%',
      height: '100%',
      backgroundColor: palette.surfaceAlt,
    },
    attachmentImageFallback: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: palette.surfaceAlt,
    },
    attachmentVideoCard: {
      width: '100%',
      maxWidth: 360,
      alignSelf: 'stretch',
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: palette.border,
      backgroundColor: palette.surfaceAlt,
      overflow: 'hidden',
    },
    attachmentVideoPlaceholder: {
      width: '100%',
      aspectRatio: 16 / 9,
      backgroundColor: palette.surfaceSunken,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
    },
    attachmentVideoPlaceholderText: {
      color: palette.textSecondary,
      fontSize: 12,
      fontWeight: '600',
    },
    attachmentVideoFooter: {
      paddingHorizontal: 12,
      paddingVertical: 10,
      gap: 8,
    },
    attachmentVideoTitleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    attachmentVideoFileName: {
      flex: 1,
      minWidth: 0,
      color: palette.text,
      fontSize: 12,
      fontWeight: '600',
    },
    attachmentVideoCollapseText: {
      color: palette.textSecondary,
      fontSize: 12,
      fontWeight: '700',
    },
    attachmentVideoActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    attachmentSaveButton: {
      flex: 1,
      minWidth: 0,
      minHeight: 40,
      borderRadius: radii.pill,
      backgroundColor: palette.accent,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingHorizontal: 10,
    },
    attachmentOpenButtonText: {
      color: palette.textOnAccent,
      fontSize: 12,
      fontWeight: '700',
    },
    attachmentShareButton: {
      flex: 1,
      minWidth: 0,
      minHeight: 40,
      borderRadius: radii.pill,
      borderWidth: 1,
      borderColor: palette.borderStrong,
      backgroundColor: palette.bg,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingHorizontal: 10,
    },
    attachmentShareButtonText: {
      color: palette.text,
      fontSize: 12,
      fontWeight: '700',
    },
    attachmentFile: {
      width: 120,
      minHeight: 74,
      borderRadius: radii.md,
      backgroundColor: palette.surfaceAlt,
      borderWidth: 1,
      borderColor: palette.border,
      padding: 12,
      justifyContent: 'space-between',
    },
    attachmentKind: {
      color: palette.accentText,
      fontSize: 11,
      fontWeight: '700',
    },
    attachmentFileName: {
      color: palette.text,
      fontSize: 12,
    }
  });
}

const chatAttachmentPresentationStylesByPalette = new WeakMap<AppPalette, ReturnType<typeof createChatAttachmentPresentationStyles>>();

function chatAttachmentPresentationStylesFor(palette: AppPalette) {
  const cached = chatAttachmentPresentationStylesByPalette.get(palette);
  if (cached) return cached;
  const styles = createChatAttachmentPresentationStyles(palette);
  chatAttachmentPresentationStylesByPalette.set(palette, styles);
  return styles;
}

export function useChatAttachmentPresentationTheme() {
  const base = useChatPaneTheme();
  const ownedStyles = chatAttachmentPresentationStylesFor(base.palette);
  const styles = useMemo(
    () => ({ ...base.styles, ...ownedStyles }),
    [base.styles, ownedStyles]
  );
  return { ...base, styles };
}
