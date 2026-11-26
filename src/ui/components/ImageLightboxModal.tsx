import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Download,
  Image as ImageIcon,
  Pencil,
  RotateCcw,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react-native';

import type { MediaAttachment } from '../../domain/types';
import { saveAttachmentToDevice } from '../../services/mediaExport';
import { resolveAttachmentDisplayUri } from '../../services/mediaStorage';
import { useKelivoTheme } from '../theme';
import { OverlayPortal } from './AppDialogHost';

const MIN_SCALE = 1;
const MAX_SCALE = 4;

export interface ImageLightboxModalProps {
  visible: boolean;
  attachment: MediaAttachment | null;
  onClose: () => void;
  onSave?: (attachment: MediaAttachment) => void | Promise<void>;
  onEditWithImage?: (attachment: MediaAttachment) => void | Promise<void>;
}

interface LightboxFeedback {
  tone: 'success' | 'muted' | 'error';
  text: string;
}

function clampScaleValue(value: number): number {
  'worklet';
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

function clampOffsetValue(value: number, maxExtent: number): number {
  'worklet';
  if (maxExtent <= 0) return 0;
  return Math.min(maxExtent, Math.max(-maxExtent, value));
}

function deriveInitialImageUri(attachment: MediaAttachment | null): string {
  if (!attachment) return '';
  const requiresWebResolution =
    Platform.OS === 'web' && attachment.uri.startsWith('embezzle-web-attachment://');
  if (requiresWebResolution) {
    if (attachment.base64) {
      return `data:${attachment.mimeType ?? 'image/png'};base64,${attachment.base64}`;
    }
    return '';
  }
  return attachment.uri;
}

/**
 * 全屏图片灯箱：
 * - 客户端通过 `<OverlayPortal layer="fullscreen">` 挂载到统一 `AppDialogHost`，零原生 `<Modal>` / `<SafeAreaView>`；
 * - Node 静态渲染测试（无宿主环境）自动内联输出内容以便契约测试捕获节点；
 * - 支持双指缩放、拖拽平移、双击复位、Web 鼠标滚轮与显式缩放控制，内置保存兜底与“以此图继续编辑”联动。
 */
export function ImageLightboxModal({
  visible,
  attachment,
  onClose,
  onSave,
  onEditWithImage,
}: ImageLightboxModalProps): ReactNode {
  const { colors } = useKelivoTheme();
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();

  const [displayUri, setDisplayUri] = useState<string>(() => deriveInitialImageUri(attachment));
  const [displayError, setDisplayError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<LightboxFeedback | null>(null);
  const [displayZoom, setDisplayZoom] = useState(1);
  const [viewportNode, setViewportNode] = useState<View | null>(null);

  const zoomRef = useRef(1);

  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);
  const viewportWidthShared = useSharedValue(windowWidth);
  const viewportHeightShared = useSharedValue(windowHeight);

  viewportWidthShared.value = windowWidth;
  viewportHeightShared.value = windowHeight;

  const syncZoomDisplay = useCallback((nextZoom: number) => {
    const rounded = Math.round(nextZoom * 100) / 100;
    zoomRef.current = rounded;
    setDisplayZoom(rounded);
  }, []);

  const resetZoomAndPan = useCallback(
    (animated: boolean) => {
      savedScale.value = 1;
      savedTranslateX.value = 0;
      savedTranslateY.value = 0;
      if (animated) {
        scale.value = withTiming(1, { duration: 160 });
        translateX.value = withTiming(0, { duration: 160 });
        translateY.value = withTiming(0, { duration: 160 });
      } else {
        scale.value = 1;
        translateX.value = 0;
        translateY.value = 0;
      }
      syncZoomDisplay(1);
    },
    [savedScale, savedTranslateX, savedTranslateY, scale, syncZoomDisplay, translateX, translateY]
  );

  const applyZoomLevel = useCallback(
    (nextScaleRaw: number) => {
      const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScaleRaw));
      savedScale.value = clamped;
      scale.value = withTiming(clamped, { duration: 150 });
      if (clamped <= 1.02) {
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
        translateX.value = withTiming(0, { duration: 150 });
        translateY.value = withTiming(0, { duration: 150 });
      }
      syncZoomDisplay(clamped);
    },
    [savedScale, savedTranslateX, savedTranslateY, scale, syncZoomDisplay, translateX, translateY]
  );

  // 每次打开灯箱或切换图片附件时复位缩放状态并清空提示反馈
  useEffect(() => {
    if (!visible) return;
    resetZoomAndPan(false);
    setFeedback(null);
    setSaving(false);
  }, [visible, attachment?.id, resetZoomAndPan]);

  // 解析图片预览 URI（含 Web IndexedDB blob URL 分配与释放）
  useEffect(() => {
    if (!visible || !attachment) {
      setDisplayUri('');
      setDisplayError(null);
      return;
    }

    let disposed = false;
    let temporaryBlobUri: string | undefined;
    setDisplayError(null);
    setDisplayUri(deriveInitialImageUri(attachment));

    void resolveAttachmentDisplayUri(attachment).then(
      (resolved) => {
        if (disposed) {
          if (Platform.OS === 'web' && resolved.startsWith('blob:')) {
            URL.revokeObjectURL(resolved);
          }
          return;
        }
        temporaryBlobUri = resolved.startsWith('blob:') ? resolved : undefined;
        setDisplayUri(resolved);
      },
      (error) => {
        if (!disposed) {
          setDisplayError(error instanceof Error ? error.message : '无法加载图片预览。');
        }
      }
    );

    return () => {
      disposed = true;
      if (Platform.OS === 'web' && temporaryBlobUri) {
        URL.revokeObjectURL(temporaryBlobUri);
      }
    };
  }, [visible, attachment]);

  // Web 端鼠标滚轮缩放监听（通过 callback ref 绑定原生 DOM 事件，确保经 OverlayPortal 异步挂载后仍能正确监听）
  useEffect(() => {
    if (!visible || !attachment || Platform.OS !== 'web') return;
    const node = viewportNode as unknown as {
      addEventListener?: (
        type: string,
        listener: (event: { deltaY: number; preventDefault: () => void }) => void,
        options?: { passive: boolean }
      ) => void;
      removeEventListener?: (
        type: string,
        listener: (event: { deltaY: number; preventDefault: () => void }) => void
      ) => void;
    } | null;

    if (!node || typeof node.addEventListener !== 'function') {
      return;
    }

    const handleWheel = (event: { deltaY: number; preventDefault: () => void }) => {
      if (!attachment) return;
      event.preventDefault();
      const step = event.deltaY < 0 ? 0.25 : -0.25;
      applyZoomLevel(zoomRef.current + step);
    };

    node.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      node.removeEventListener?.('wheel', handleWheel);
    };
  }, [visible, attachment, viewportNode, applyZoomLevel]);

  const pinchGesture = Gesture.Pinch()
    .onUpdate((event) => {
      'worklet';
      const next = Math.min(MAX_SCALE * 1.15, Math.max(MIN_SCALE * 0.8, savedScale.value * event.scale));
      scale.value = next;
    })
    .onEnd(() => {
      'worklet';
      const clamped = clampScaleValue(scale.value);
      savedScale.value = clamped;
      scale.value = withSpring(clamped, { damping: 20, stiffness: 220 });
      if (clamped <= 1.02) {
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
        translateX.value = withSpring(0, { damping: 20, stiffness: 220 });
        translateY.value = withSpring(0, { damping: 20, stiffness: 220 });
      }
      runOnJS(syncZoomDisplay)(clamped);
    })
    .onFinalize(() => {
      'worklet';
      const clamped = clampScaleValue(scale.value);
      savedScale.value = clamped;
      scale.value = withTiming(clamped, { duration: 120 });
      if (clamped <= 1.02) {
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
        translateX.value = withTiming(0, { duration: 120 });
        translateY.value = withTiming(0, { duration: 120 });
      }
      runOnJS(syncZoomDisplay)(clamped);
    });

  const panGesture = Gesture.Pan()
    .minPointers(1)
    .onUpdate((event) => {
      'worklet';
      if (scale.value <= 1.02) return;
      const maxX = ((scale.value - 1) * viewportWidthShared.value) / 2;
      const maxY = ((scale.value - 1) * viewportHeightShared.value) / 2;
      translateX.value = clampOffsetValue(savedTranslateX.value + event.translationX, maxX);
      translateY.value = clampOffsetValue(savedTranslateY.value + event.translationY, maxY);
    })
    .onEnd(() => {
      'worklet';
      const maxX = ((scale.value - 1) * viewportWidthShared.value) / 2;
      const maxY = ((scale.value - 1) * viewportHeightShared.value) / 2;
      savedTranslateX.value = clampOffsetValue(translateX.value, maxX);
      savedTranslateY.value = clampOffsetValue(translateY.value, maxY);
    })
    .onFinalize(() => {
      'worklet';
      if (scale.value <= 1.02) {
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
        translateX.value = withTiming(0, { duration: 120 });
        translateY.value = withTiming(0, { duration: 120 });
      } else {
        const maxX = ((scale.value - 1) * viewportWidthShared.value) / 2;
        const maxY = ((scale.value - 1) * viewportHeightShared.value) / 2;
        const clampedX = clampOffsetValue(translateX.value, maxX);
        const clampedY = clampOffsetValue(translateY.value, maxY);
        savedTranslateX.value = clampedX;
        savedTranslateY.value = clampedY;
        translateX.value = clampedX;
        translateY.value = clampedY;
      }
    });

  const doubleTapGesture = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      'worklet';
      if (scale.value > 1.05) {
        savedScale.value = 1;
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
        scale.value = withSpring(1, { damping: 20, stiffness: 220 });
        translateX.value = withSpring(0, { damping: 20, stiffness: 220 });
        translateY.value = withSpring(0, { damping: 20, stiffness: 220 });
        runOnJS(syncZoomDisplay)(1);
      } else {
        savedScale.value = 2;
        scale.value = withSpring(2, { damping: 20, stiffness: 220 });
        runOnJS(syncZoomDisplay)(2);
      }
    });

  const composedGesture = Gesture.Race(
    doubleTapGesture,
    Gesture.Simultaneous(pinchGesture, panGesture)
  );

  const imageTransformStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  const handleSave = useCallback(async () => {
    if (!attachment || saving) return;
    setSaving(true);
    setFeedback(null);
    try {
      if (onSave) {
        await onSave(attachment);
        setFeedback({ tone: 'success', text: '已保存' });
      } else {
        const result = await saveAttachmentToDevice(attachment);
        if (result.status === 'cancelled') {
          setFeedback({ tone: 'muted', text: '已取消保存' });
        } else if (result.status === 'shared') {
          setFeedback({ tone: 'success', text: '已调起分享导出' });
        } else {
          setFeedback({ tone: 'success', text: `已保存：${result.name}` });
        }
      }
    } catch (error) {
      setFeedback({
        tone: 'error',
        text: error instanceof Error ? error.message : '保存图片失败，请稍后重试。',
      });
    } finally {
      setSaving(false);
    }
  }, [attachment, onSave, saving]);

  const handleEdit = useCallback(() => {
    if (!attachment || !onEditWithImage) return;
    void onEditWithImage(attachment);
  }, [attachment, onEditWithImage]);

  if (!visible) {
    return null;
  }

  const topPad = Math.max(12, insets.top + 8);
  const bottomPad = Math.max(16, insets.bottom + 12);
  const leftPad = Math.max(12, insets.left);
  const rightPad = Math.max(12, insets.right);
  const imageWidth = Math.max(200, windowWidth - leftPad - rightPad - 16);
  const imageHeight = Math.max(220, windowHeight - topPad - bottomPad - 150);

  const content = (
    <View
      testID="image-lightbox-overlay"
      style={[
        styles.backdrop,
        {
          backgroundColor: 'rgba(10, 12, 16, 0.94)',
          paddingTop: topPad,
          paddingBottom: bottomPad,
          paddingLeft: leftPad,
          paddingRight: rightPad,
        },
      ]}
    >
      {/* 顶栏：文件名与关闭按钮 */}
      <View style={styles.topBar}>
        <Text numberOfLines={1} style={styles.titleText}>
          {attachment?.name || '图片预览'}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="关闭图片预览"
          testID="image-lightbox-close"
          hitSlop={10}
          onPress={onClose}
          style={({ pressed }) => [styles.closeButton, pressed && styles.buttonPressed]}
        >
          <X size={20} color="#FFFFFF" strokeWidth={2.2} />
        </Pressable>
      </View>

      {/* 中部缩放预览画布 */}
      <View ref={setViewportNode} style={styles.canvas}>
        {attachment ? (
          displayUri && !displayError ? (
            <GestureDetector gesture={composedGesture}>
              <Reanimated.View style={[styles.imageContainer, imageTransformStyle]}>
                <Image
                  source={{ uri: displayUri }}
                  resizeMode="contain"
                  onError={() => setDisplayError('图片加载失败或资源不可用。')}
                  style={{
                    width: imageWidth,
                    height: imageHeight,
                  }}
                />
              </Reanimated.View>
            </GestureDetector>
          ) : (
            <View style={styles.emptyState}>
              {displayError ? (
                <>
                  <ImageIcon size={36} color={colors.error} strokeWidth={1.8} />
                  <Text style={styles.emptyStateText}>{displayError}</Text>
                </>
              ) : (
                <>
                  <ActivityIndicator size="large" color="#FFFFFF" />
                  <Text style={styles.emptyStateText}>正在加载高清图片…</Text>
                </>
              )}
            </View>
          )
        ) : (
          <View style={styles.emptyState}>
            <ImageIcon size={36} color="rgba(255, 255, 255, 0.65)" strokeWidth={1.8} />
            <Text style={styles.emptyStateText}>暂无可预览的图片附件</Text>
          </View>
        )}
      </View>

      {/* 保存/操作反馈胶囊 */}
      {feedback ? (
        <View
          testID="image-lightbox-feedback"
          style={[
            styles.feedbackPill,
            feedback.tone === 'error'
              ? { backgroundColor: colors.errorContainer }
              : feedback.tone === 'success'
                ? { backgroundColor: colors.successContainer }
                : { backgroundColor: 'rgba(255, 255, 255, 0.14)' },
          ]}
        >
          <Text
            style={[
              styles.feedbackText,
              {
                color:
                  feedback.tone === 'error'
                    ? colors.error
                    : feedback.tone === 'success'
                      ? colors.success
                      : '#FFFFFF',
              },
            ]}
          >
            {feedback.text}
          </Text>
        </View>
      ) : null}

      {/* 底部控制栏：缩放步进 + 保存 + 以此图继续编辑 */}
      <View style={styles.bottomBar}>
        <View style={styles.zoomBar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="缩小预览"
            testID="image-lightbox-zoom-out"
            disabled={!attachment || displayZoom <= MIN_SCALE}
            onPress={() => applyZoomLevel(displayZoom - 0.5)}
            style={({ pressed }) => [
              styles.zoomButton,
              (!attachment || displayZoom <= MIN_SCALE) && styles.buttonDisabled,
              pressed && styles.buttonPressed,
            ]}
          >
            <ZoomOut size={16} color="#FFFFFF" strokeWidth={2} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="重置缩放倍率"
            testID="image-lightbox-zoom-reset"
            disabled={!attachment}
            onPress={() => resetZoomAndPan(true)}
            style={({ pressed }) => [
              styles.zoomResetButton,
              !attachment && styles.buttonDisabled,
              pressed && styles.buttonPressed,
            ]}
          >
            <RotateCcw size={13} color="#FFFFFF" strokeWidth={2} />
            <Text style={styles.zoomLabel}>{displayZoom.toFixed(1)}x</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="放大预览"
            testID="image-lightbox-zoom-in"
            disabled={!attachment || displayZoom >= MAX_SCALE}
            onPress={() => applyZoomLevel(displayZoom + 0.5)}
            style={({ pressed }) => [
              styles.zoomButton,
              (!attachment || displayZoom >= MAX_SCALE) && styles.buttonDisabled,
              pressed && styles.buttonPressed,
            ]}
          >
            <ZoomIn size={16} color="#FFFFFF" strokeWidth={2} />
          </Pressable>
        </View>

        <View style={styles.actionRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="保存图片"
            testID="image-lightbox-save"
            disabled={!attachment || saving}
            onPress={() => void handleSave()}
            style={({ pressed }) => [
              styles.secondaryActionButton,
              (!attachment || saving) && styles.buttonDisabled,
              pressed && styles.buttonPressed,
            ]}
          >
            <Download size={16} color="#FFFFFF" strokeWidth={2.2} />
            <Text style={styles.secondaryActionText}>{saving ? '保存中…' : '保存'}</Text>
          </Pressable>

          {onEditWithImage ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="以此图继续编辑"
              testID="image-lightbox-edit"
              disabled={!attachment}
              onPress={handleEdit}
              style={({ pressed }) => [
                styles.primaryActionButton,
                { backgroundColor: colors.accent },
                !attachment && styles.buttonDisabled,
                pressed && styles.buttonPressed,
              ]}
            >
              <Pencil size={16} color={colors.textOnAccent} strokeWidth={2.2} />
              <Text style={[styles.primaryActionText, { color: colors.textOnAccent }]}>
                以此图继续编辑
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );

  // Node 无真实浏览器 DOM 的静态渲染测试环境下直接内联返回，确保 renderToStaticMarkup 能捕获到控件树
  const isNativeRuntime =
    typeof navigator !== 'undefined' && navigator.product === 'ReactNative';
  const hasBrowserDom =
    typeof window !== 'undefined' &&
    typeof (window as { document?: { createElement?: unknown } }).document?.createElement ===
      'function';
  const shouldInlineForStaticRender = !hasBrowserDom && !isNativeRuntime;

  if (shouldInlineForStaticRender) {
    return content;
  }

  return (
    <OverlayPortal visible={visible} layer="fullscreen" onRequestClose={onClose}>
      {content}
    </OverlayPortal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'space-between',
  },
  topBar: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  titleText: {
    flex: 1,
    minWidth: 0,
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  closeButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.14)',
  },
  canvas: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  imageContainer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 24,
  },
  emptyStateText: {
    color: 'rgba(255, 255, 255, 0.78)',
    fontSize: 13,
    textAlign: 'center',
  },
  feedbackPill: {
    alignSelf: 'center',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 999,
    marginBottom: 8,
  },
  feedbackText: {
    fontSize: 12,
    fontWeight: '600',
  },
  bottomBar: {
    gap: 10,
  },
  zoomBar: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
  },
  zoomButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  zoomResetButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
  },
  zoomLabel: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  secondaryActionButton: {
    minHeight: 42,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.28)',
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 18,
  },
  secondaryActionText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  primaryActionButton: {
    minHeight: 42,
    borderRadius: 999,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 18,
  },
  primaryActionText: {
    fontSize: 13,
    fontWeight: '700',
  },
  buttonPressed: {
    opacity: 0.72,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
});
