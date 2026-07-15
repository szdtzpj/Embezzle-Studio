import { StyleSheet, View, type ViewStyle } from 'react-native';
import { useKelivoTheme, type KelivoTheme } from '../theme';
import { AnimatedPressable } from './AnimatedPressable';
import type { ReactNode } from 'react';

export interface IconButtonProps {
  children: ReactNode;
  onPress?: () => void;
  size?: number;
  variant?: 'default' | 'ghost' | 'filled';
  style?: ViewStyle;
  disabled?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}

export function IconButton({
  children,
  onPress,
  size = 20,
  variant = 'default',
  style,
  disabled,
  accessibilityLabel,
  testID,
}: IconButtonProps) {
  const theme = useKelivoTheme();
  const styles = getStyles(theme);
  const touchSize = Math.max(44, (size ?? 20) + 20);
  const buttonStyles = [
    styles.base,
    { width: touchSize, height: touchSize },
    variant === 'default' && styles.default,
    variant === 'ghost' && styles.ghost,
    variant === 'filled' && styles.filled,
    style,
  ];

  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      disabled={disabled}
      onPress={onPress}
      style={buttonStyles}
      haptic="light"
    >
      <View style={styles.center}>{children}</View>
    </AnimatedPressable>
  );
}

function createStyles(theme: KelivoTheme) {
  return StyleSheet.create({
  base: {
    borderRadius: theme.radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  default: {
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.outline,
  },
  ghost: {
    backgroundColor: 'transparent',
  },
  filled: {
    backgroundColor: theme.colors.primary,
  },
  });
}

const styleCache = new WeakMap<KelivoTheme, ReturnType<typeof createStyles>>();

function getStyles(theme: KelivoTheme) {
  let styles = styleCache.get(theme);
  if (!styles) {
    styles = createStyles(theme);
    styleCache.set(theme, styles);
  }
  return styles;
}
