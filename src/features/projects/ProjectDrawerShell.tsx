import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import Reanimated, {
  cancelAnimation,
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useKelivoTheme } from '../../ui/theme';

const AnimatedPressable = Reanimated.createAnimatedComponent(Pressable);

/**
 * 项目侧边栏抽屉动效与手势容器。
 * 复用根部唯一 `<GestureHandlerRootView>` 与 `<SafeAreaProvider>`，
 * 通过代际守卫与 UI 线程状态消除快速开关动画竞争及手势取消残影。
 */
export function ProjectDrawerShell(props: {
  open: boolean;
  onClose: () => void;
  onPanelLayout?: (height: number) => void;
  children: ReactNode;
}): React.ReactElement | null {
  const { open, onClose, onPanelLayout, children } = props;
  const { colors } = useKelivoTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const panelWidth = Math.min(320, Math.round(width * 0.8));
  const [mounted, setMounted] = useState(open);
  const progress = useSharedValue(open ? 1 : 0);
  const isOpenShared = useSharedValue(open);
  const closingByGesture = useSharedValue(false);
  const epochRef = useRef(0);
  const openRef = useRef(open);
  openRef.current = open;

  const finishClose = (epoch: number) => {
    if (epochRef.current === epoch && !openRef.current) {
      setMounted(false);
    }
  };

  useEffect(() => {
    cancelAnimation(progress);
    const epoch = ++epochRef.current;
    isOpenShared.value = open;

    if (open) {
      closingByGesture.value = false;
      setMounted(true);
      progress.value = withSpring(1, { damping: 22, stiffness: 220, mass: 0.9 });
    } else {
      progress.value = withTiming(0, { duration: 200 }, (finished) => {
        if (finished) {
          runOnJS(finishClose)(epoch);
        }
      });
    }
    // 抽屉挂载期间由手势驱动 progress，此处仅响应受控 open 状态切换。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const panGesture = Gesture.Pan()
    .activeOffsetX([-12, 12])
    .onStart(() => {
      'worklet';
      closingByGesture.value = false;
    })
    .onUpdate((event) => {
      'worklet';
      progress.value = Math.min(1, Math.max(0, 1 + event.translationX / panelWidth));
    })
    .onEnd((event) => {
      'worklet';
      if (event.translationX < -panelWidth * 0.35 || event.velocityX < -650) {
        closingByGesture.value = true;
        runOnJS(onClose)();
      } else {
        progress.value = withSpring(1, { damping: 22, stiffness: 220, mass: 0.9 });
      }
    })
    .onFinalize(() => {
      'worklet';
      // 若系统手势被打断或取消且未进入关闭流程，则安全回弹恢复打开态；已触发关闭时禁止回弹残影。
      if (!closingByGesture.value && isOpenShared.value) {
        progress.value = withSpring(1, { damping: 22, stiffness: 220, mass: 0.9 });
      }
    });

  const scrimStyle = useAnimatedStyle(() => ({ opacity: progress.value }), [progress]);
  const panelStyle = useAnimatedStyle(
    () => ({
      transform: [
        {
          translateX: interpolate(
            progress.value,
            [0, 1],
            [-panelWidth, 0],
            Extrapolation.CLAMP
          ),
        },
      ],
    }),
    [panelWidth, progress]
  );

  if (!mounted) return null;

  return (
    <View
      pointerEvents={open ? 'auto' : 'none'}
      style={styles.root}
      testID="project-drawer-shell"
    >
      <AnimatedPressable
        accessibilityRole="button"
        accessibilityLabel="关闭聊天记录遮罩"
        pointerEvents={open ? 'auto' : 'none'}
        onPress={onClose}
        style={[styles.scrim, { backgroundColor: colors.scrim }, scrimStyle]}
      />
      <GestureDetector gesture={panGesture}>
        <Reanimated.View
          style={[
            styles.panel,
            {
              width: panelWidth,
              backgroundColor: colors.background,
              paddingTop: Math.max(20, insets.top + 12),
              paddingBottom: Math.max(32, insets.bottom + 16),
              paddingLeft: Math.max(20, insets.left + 12),
              paddingRight: 20,
            },
            panelStyle,
          ]}
          onLayout={(event) => onPanelLayout?.(event.nativeEvent.layout.height)}
        >
          {children}
        </Reanimated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFill,
    flexDirection: 'row',
    zIndex: 40,
    elevation: 40,
    ...(Platform.OS === 'web'
      ? ({
          position: 'fixed',
          inset: 0,
        } as Record<string, unknown>)
      : {}),
  },
  scrim: {
    ...StyleSheet.absoluteFill,
  },
  panel: {
    maxWidth: 320,
    position: 'relative',
    overflow: 'hidden',
    paddingTop: 20,
    paddingHorizontal: 20,
    paddingBottom: 32,
  },
});
