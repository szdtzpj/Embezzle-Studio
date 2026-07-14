import React, { useEffect, useState, type ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import Reanimated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';

import { useKelivoTheme } from '../../ui/theme';

const AnimatedPressable = Reanimated.createAnimatedComponent(Pressable);

/** Project-owned drawer motion and dismissal shell. */
export function ProjectDrawerShell(props: {
  open: boolean;
  onClose: () => void;
  onPanelLayout?: (height: number) => void;
  children: ReactNode;
}): React.ReactElement | null {
  const { open, onClose, onPanelLayout, children } = props;
  const { colors } = useKelivoTheme();
  const { width } = useWindowDimensions();
  const panelWidth = Math.min(320, Math.round(width * 0.8));
  const [mounted, setMounted] = useState(open);
  const progress = useSharedValue(open ? 1 : 0);

  useEffect(() => {
    if (open) {
      setMounted(true);
      progress.value = withSpring(1, { damping: 22, stiffness: 220, mass: 0.9 });
    } else {
      progress.value = withTiming(0, { duration: 200 }, (finished) => {
        if (finished) runOnJS(setMounted)(false);
      });
    }
    // The gesture owns progress while mounted; only visibility drives entrance/exit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const panGesture = Gesture.Pan()
    .activeOffsetX([-12, 12])
    .onUpdate((event) => {
      progress.value = Math.min(1, Math.max(0, 1 + event.translationX / panelWidth));
    })
    .onEnd((event) => {
      if (event.translationX < -panelWidth * 0.35 || event.velocityX < -650) {
        runOnJS(onClose)();
      } else {
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
    <Modal visible transparent animationType="none" onRequestClose={onClose}>
      <GestureHandlerRootView style={styles.root}>
        <AnimatedPressable
          accessibilityRole="button"
          accessibilityLabel="关闭聊天记录"
          onPress={onClose}
          style={[styles.scrim, { backgroundColor: colors.scrim }, scrimStyle]}
        />
        <GestureDetector gesture={panGesture}>
          <Reanimated.View
            style={[
              styles.panel,
              { width: panelWidth, backgroundColor: colors.background },
              panelStyle,
            ]}
            onLayout={(event) => onPanelLayout?.(event.nativeEvent.layout.height)}
          >
            {children}
          </Reanimated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row' },
  scrim: { position: 'absolute', inset: 0 },
  panel: {
    maxWidth: 320,
    position: 'relative',
    overflow: 'hidden',
    paddingTop: 20,
    paddingHorizontal: 20,
    paddingBottom: 32,
  },
});
