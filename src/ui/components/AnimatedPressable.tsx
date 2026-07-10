import { useEffect } from 'react';
import { Platform, Pressable } from 'react-native';
import type { PressableProps, StyleProp, ViewStyle } from 'react-native';
import type { ReactNode } from 'react';
import Reanimated, {
  Easing as ReanimatedEasing,
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';

export type HapticStyle = 'light' | 'medium' | 'heavy' | 'selection' | 'success' | 'warning' | 'none';

export function triggerHaptic(style: HapticStyle = 'light') {
  if (style === 'none' || Platform.OS === 'web') return;
  try {
    switch (style) {
      case 'selection':
        void Haptics.selectionAsync();
        break;
      case 'success':
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        break;
      case 'warning':
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        break;
      case 'medium':
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        break;
      case 'heavy':
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        break;
      case 'light':
      default:
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        break;
    }
  } catch {
    // ignore
  }
}

export interface AnimatedPressableProps extends PressableProps {
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
  pressScale?: number;
  pressOpacity?: number;
  pressTranslateY?: number;
  haptic?: HapticStyle;
}

const AnimatedPressableView = Reanimated.createAnimatedComponent(Pressable);
const webInteractiveStyle =
  Platform.OS === 'web'
    ? ({
        cursor: 'pointer',
        userSelect: 'none',
      } as unknown as ViewStyle)
    : undefined;

const PRESS_IN_CONFIG = { duration: 70, easing: ReanimatedEasing.out(ReanimatedEasing.quad) } as const;
const PRESS_OUT_SPRING = { damping: 17, stiffness: 340, mass: 0.5 } as const;
const DISABLED_FADE = { duration: 160, easing: ReanimatedEasing.out(ReanimatedEasing.quad) } as const;

export function AnimatedPressable({
  style,
  children,
  onPressIn,
  onPressOut,
  disabled,
  pressScale = 0.96,
  pressOpacity = 0.92,
  pressTranslateY = 0.6,
  haptic = 'light',
  ...rest
}: AnimatedPressableProps) {
  const pressed = useSharedValue(0);
  const disabledValue = useSharedValue(disabled ? 1 : 0);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    disabledValue.value = withTiming(disabled ? 1 : 0, DISABLED_FADE);
  }, [disabled, disabledValue]);

  const animatedStyle = useAnimatedStyle(() => {
    const scale = reducedMotion
      ? 1
      : interpolate(pressed.value, [0, 1], [1, pressScale], Extrapolation.CLAMP);
    const translateY = reducedMotion
      ? 0
      : interpolate(pressed.value, [0, 1], [0, pressTranslateY], Extrapolation.CLAMP);
    const pressDim = interpolate(pressed.value, [0, 1], [1, pressOpacity], Extrapolation.CLAMP);
    const disabledDim = interpolate(disabledValue.value, [0, 1], [1, 0.5], Extrapolation.CLAMP);

    return {
      transform: [{ translateY }, { scale }],
      opacity: pressDim * disabledDim,
    };
  });

  return (
    <AnimatedPressableView
      {...rest}
      disabled={disabled}
      onPressIn={(event) => {
        if (!disabled) {
          pressed.value = withTiming(1, PRESS_IN_CONFIG);
          triggerHaptic(haptic);
        }
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        pressed.value = withSpring(0, PRESS_OUT_SPRING);
        onPressOut?.(event);
      }}
      style={[style, webInteractiveStyle, animatedStyle]}
    >
      {children}
    </AnimatedPressableView>
  );
}
