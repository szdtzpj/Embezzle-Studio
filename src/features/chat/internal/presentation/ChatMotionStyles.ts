import { useMemo } from 'react';
import { StyleSheet } from 'react-native';

import {
  radii,
  useChatPaneTheme,
  type AppPalette,
} from '../../chatPaneStyles';

function createChatMotionStyles(palette: AppPalette) {
  return StyleSheet.create({
    screenFade: {
      flex: 1,
    },
    iconCrossfade: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    iconCrossfadeLayer: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    toastRoot: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      alignItems: 'center',
      justifyContent: 'center',
    },
    toastCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingLeft: 12,
      paddingRight: 16,
      paddingVertical: 11,
      borderRadius: radii.pill,
      backgroundColor: palette.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
      shadowColor: '#000000',
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.14,
      shadowRadius: 16,
      elevation: 8,
    },
    toastIconBadge: {
      width: 20,
      height: 20,
      borderRadius: radii.pill,
      backgroundColor: palette.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    toastText: {
      color: palette.text,
      fontSize: 14,
      fontWeight: '600',
    }
  });
}

const chatMotionStylesByPalette = new WeakMap<AppPalette, ReturnType<typeof createChatMotionStyles>>();

function chatMotionStylesFor(palette: AppPalette) {
  const cached = chatMotionStylesByPalette.get(palette);
  if (cached) return cached;
  const styles = createChatMotionStyles(palette);
  chatMotionStylesByPalette.set(palette, styles);
  return styles;
}

export function useChatMotionTheme() {
  const base = useChatPaneTheme();
  const ownedStyles = chatMotionStylesFor(base.palette);
  const styles = useMemo(
    () => ({ ...base.styles, ...ownedStyles }),
    [base.styles, ownedStyles]
  );
  return { ...base, styles };
}
