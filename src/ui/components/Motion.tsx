import { useEffect, useState, type ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { Platform, StyleSheet, View } from 'react-native';
import { MotiView } from 'moti';
import Reanimated, {
  Easing,
  Extrapolation,
  LinearTransition,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

export type MotionDirection = 'forward' | 'backward' | 'up' | 'down' | 'none';

function directionOffset(direction: MotionDirection, distance: number) {
  switch (direction) {
    case 'forward':
      return { translateX: distance, translateY: 0 };
    case 'backward':
      return { translateX: -distance, translateY: 0 };
    case 'down':
      return { translateX: 0, translateY: -distance };
    case 'up':
      return { translateX: 0, translateY: distance };
    case 'none':
    default:
      return { translateX: 0, translateY: 0 };
  }
}

export interface MotionSwitchProps {
  motionKey: string;
  children: ReactNode;
  direction?: MotionDirection;
  distance?: number;
  duration?: number;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
}

/** Replaces full-page or full-panel content and glides the new view into place. */
export function MotionSwitch({
  ...props
}: MotionSwitchProps) {
  if (Platform.OS === 'android') {
    return <StaticMotionSwitch {...props} />;
  }

  return <AnimatedMotionSwitch {...props} />;
}

function StaticMotionSwitch({ children, style, contentStyle }: MotionSwitchProps) {
  return (
    <View style={[styles.switchRoot, style]}>
      <View style={[styles.switchContent, contentStyle]}>{children}</View>
    </View>
  );
}

function AnimatedMotionSwitch({
  motionKey,
  children,
  direction = 'forward',
  distance = 18,
  duration = 220,
  style,
  contentStyle,
}: MotionSwitchProps) {
  const reducedMotion = useReducedMotion();
  const offset = directionOffset(direction, distance);

  return (
    <View style={[styles.switchRoot, style]}>
      <MotiView
        key={motionKey}
        from={
          reducedMotion
            ? { opacity: 1, translateX: 0, translateY: 0, scale: 1 }
            : { opacity: 0.72, ...offset, scale: 0.998 }
        }
        animate={{ opacity: 1, translateX: 0, translateY: 0, scale: 1 }}
        transition={{
          type: 'timing',
          duration: reducedMotion ? 1 : duration,
        }}
        style={[styles.switchContent, contentStyle]}
      >
        {children}
      </MotiView>
    </View>
  );
}

export interface MotionItemProps {
  children: ReactNode;
  index?: number;
  delay?: number;
  distance?: number;
  duration?: number;
  scaleFrom?: number;
  style?: StyleProp<ViewStyle>;
}

/** Mount animation with a capped stagger, suitable for cards and list rows. */
export function MotionItem({
  ...props
}: MotionItemProps) {
  if (Platform.OS === 'android') {
    return <View style={props.style}>{props.children}</View>;
  }

  return <AnimatedMotionItem {...props} />;
}

function AnimatedMotionItem({
  children,
  index = 0,
  delay = 0,
  distance = 10,
  duration = 260,
  scaleFrom = 0.99,
  style,
}: MotionItemProps) {
  const reducedMotion = useReducedMotion();
  const staggerDelay = delay + Math.min(index, 8) * 34;

  return (
    <MotiView
      layout={reducedMotion ? undefined : LinearTransition.duration(180)}
      from={
        reducedMotion
          ? { opacity: 1, translateY: 0, scale: 1 }
          : { opacity: 0.4, translateY: distance, scale: scaleFrom }
      }
      animate={{ opacity: 1, translateY: 0, scale: 1 }}
      transition={{
        type: 'timing',
        duration: reducedMotion ? 1 : duration,
        delay: reducedMotion ? 0 : staggerDelay,
      }}
      style={style}
    >
      {children}
    </MotiView>
  );
}

export interface MotionPresenceProps {
  visible: boolean;
  children: ReactNode;
  direction?: MotionDirection;
  distance?: number;
  duration?: number;
  style?: StyleProp<ViewStyle>;
}

/** Keeps conditional content mounted until its exit animation has completed. */
export function MotionPresence({
  ...props
}: MotionPresenceProps) {
  if (Platform.OS === 'android') {
    return props.visible ? <View style={props.style}>{props.children}</View> : null;
  }

  return <AnimatedMotionPresence {...props} />;
}

function AnimatedMotionPresence({
  visible,
  children,
  direction = 'up',
  distance = 12,
  duration = 190,
  style,
}: MotionPresenceProps) {
  const reducedMotion = useReducedMotion();
  const [mounted, setMounted] = useState(visible);
  const progress = useSharedValue(visible ? 1 : 0);
  const offset = directionOffset(direction, distance);
  const animationDuration = reducedMotion ? 1 : duration;

  useEffect(() => {
    if (visible && !mounted) {
      setMounted(true);
      return;
    }

    if (visible) {
      progress.value = withTiming(1, {
        duration: animationDuration,
        easing: Easing.out(Easing.cubic),
      });
      return;
    }

    if (mounted) {
      progress.value = withTiming(
        0,
        {
          duration: animationDuration,
          easing: Easing.inOut(Easing.quad),
        },
        (finished) => {
          if (finished) {
            runOnJS(setMounted)(false);
          }
        },
      );
    }
  }, [animationDuration, mounted, progress, visible]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [
      {
        translateX: interpolate(
          progress.value,
          [0, 1],
          [offset.translateX, 0],
          Extrapolation.CLAMP,
        ),
      },
      {
        translateY: interpolate(
          progress.value,
          [0, 1],
          [offset.translateY, 0],
          Extrapolation.CLAMP,
        ),
      },
      {
        scale: interpolate(progress.value, [0, 1], [0.985, 1], Extrapolation.CLAMP),
      },
    ],
  }));

  if (!mounted) {
    return null;
  }

  return <Reanimated.View style={[style, animatedStyle]}>{children}</Reanimated.View>;
}

export interface MotionSwapProps {
  motionKey: string;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  duration?: number;
}

/** Animates compact state changes such as checks, icons, and trailing actions. */
export function MotionSwap({
  ...props
}: MotionSwapProps) {
  if (Platform.OS === 'android') {
    return (
      <View style={[styles.swapRoot, props.style]}>
        <View style={props.contentStyle}>{props.children}</View>
      </View>
    );
  }

  return <AnimatedMotionSwap {...props} />;
}

function AnimatedMotionSwap({
  motionKey,
  children,
  style,
  contentStyle,
  duration = 150,
}: MotionSwapProps) {
  const reducedMotion = useReducedMotion();

  return (
    <View style={[styles.swapRoot, style]}>
      <MotiView
        key={motionKey}
        from={
          reducedMotion
            ? { opacity: 1, scale: 1, translateY: 0 }
            : { opacity: 0.45, scale: 0.78, translateY: 2 }
        }
        animate={{ opacity: 1, scale: 1, translateY: 0 }}
        transition={{
          type: 'timing',
          duration: reducedMotion ? 1 : duration,
        }}
        style={contentStyle}
      >
        {children}
      </MotiView>
    </View>
  );
}

const styles = StyleSheet.create({
  switchRoot: {
    flex: 1,
    overflow: 'hidden',
  },
  switchContent: {
    flex: 1,
  },
  swapRoot: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
