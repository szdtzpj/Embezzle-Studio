import { useEffect, type ReactNode } from 'react';
import { Platform, Text, View } from 'react-native';
import type { LayoutChangeEvent, StyleProp, ViewStyle } from 'react-native';
import Reanimated, {
  Easing as ReanimatedEasing,
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { AnimatePresence, MotiView } from 'moti';
import { Check } from 'lucide-react-native';

import { useChatMotionTheme } from './ChatMotionStyles';
export { AnimatedPressable, triggerHaptic } from '../../../../ui/components/AnimatedPressable';


/**
 * 消息气泡入场动画：淡入 + 轻微上移。仅在首次挂载时播放一次。
 * 用 Reanimated 在 UI 线程执行——即使收到回复瞬间 JS 线程繁忙也不会卡顿。
 */
function AnimatedMessageSurface({
  style,
  children,
  onLayout,
}: {
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
  onLayout?: (event: LayoutChangeEvent) => void;
}) {
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withTiming(1, {
      duration: 340,
      easing: ReanimatedEasing.out(ReanimatedEasing.cubic),
    });
  }, [progress]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [
      { translateY: interpolate(progress.value, [0, 1], [12, 0], Extrapolation.CLAMP) },
    ],
  }));

  return <Reanimated.View onLayout={onLayout} style={[style, animatedStyle]}>{children}</Reanimated.View>;
}


export function AnimatedMessage({
  animate,
  style,
  children,
  onLayout,
}: {
  animate: boolean;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
  onLayout?: (event: LayoutChangeEvent) => void;
}) {
  if (!animate) {
    return <View onLayout={onLayout} style={style}>{children}</View>;
  }
  return <AnimatedMessageSurface onLayout={onLayout} style={style}>{children}</AnimatedMessageSurface>;
}


/**
 * 切换聊天 / 配置时的柔和淡入 + 轻微缩放过渡。
 */
function AnimatedScreenFade({ children }: { children?: ReactNode }) {
  const { styles } = useChatMotionTheme();
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withTiming(1, {
      duration: 260,
      easing: ReanimatedEasing.out(ReanimatedEasing.cubic),
    });
  }, [progress]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ scale: interpolate(progress.value, [0, 1], [0.99, 1], Extrapolation.CLAMP) }],
  }));

  return <Reanimated.View style={[styles.screenFade, animatedStyle]}>{children}</Reanimated.View>;
}


export function ScreenFade({ children }: { children?: ReactNode }) {
  const { styles } = useChatMotionTheme();
  if (Platform.OS === 'android') {
    return <View style={styles.screenFade}>{children}</View>;
  }
  return <AnimatedScreenFade>{children}</AnimatedScreenFade>;
}


/**
 * 图标 / 内容切换时的交叉淡入淡出：旧内容旋转淡出、新内容旋转淡入。
 * 用 moti 的 AnimatePresence 编排挂载 / 卸载，避免图标瞬间硬切。
 */
export function IconCrossfade({ swapKey, children }: { swapKey: string; children: ReactNode }) {
  const { styles } = useChatMotionTheme();
  return (
    <View style={styles.iconCrossfade}>
      <AnimatePresence exitBeforeEnter>
        <MotiView
          key={swapKey}
          from={{ opacity: 0, scale: 0.6, rotate: '-30deg' }}
          animate={{ opacity: 1, scale: 1, rotate: '0deg' }}
          exit={{ opacity: 0, scale: 0.6, rotate: '30deg' }}
          transition={{ type: 'timing', duration: 180 }}
          style={styles.iconCrossfadeLayer}
        >
          {children}
        </MotiView>
      </AnimatePresence>
    </View>
  );
}


/**
 * 豆包 / ChatGPT 风格的浮层轻提示：屏幕中央浮出一个圆角白框，
 * 内含对勾 + 文案（如“已复制”），短暂停留后自动淡出。
 * 用 pointerEvents="none" 让它不拦截任何点击，纯视觉反馈。
 */
export function Toast({ message }: { message: string | null }) {
  const { palette, styles } = useChatMotionTheme();
  return (
    <View pointerEvents="none" style={styles.toastRoot}>
      <AnimatePresence>
        {message ? (
          <MotiView
            key="toast"
            accessible
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            from={{ opacity: 0, translateY: 14, scale: 0.9 }}
            animate={{ opacity: 1, translateY: 0, scale: 1 }}
            exit={{ opacity: 0, translateY: 8, scale: 0.94 }}
            transition={{ type: 'timing', duration: 200 }}
            style={styles.toastCard}
          >
            <View style={styles.toastIconBadge}>
              <Check size={13} color={palette.textOnAccent} strokeWidth={3.2} />
            </View>
            <Text style={styles.toastText}>{message}</Text>
          </MotiView>
        ) : null}
      </AnimatePresence>
    </View>
  );
}
