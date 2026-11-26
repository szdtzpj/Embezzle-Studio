import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { BackHandler, Platform, Pressable, StyleSheet, View } from 'react-native';

import { useKelivoTheme } from '../theme';
import { ConfirmDialogContent } from './ConfirmDialog';
import { NoticeDialogContent } from './NoticeDialog';
import {
  bindAppDialogHost,
  getDefaultOverlayPriority,
  getOverlayHostSnapshot,
  removeOverlayPortal,
  subscribeOverlayHost,
  upsertOverlayPortal,
  type DialogRequest,
  type OverlayHostSnapshot,
  type OverlayLayer,
} from './dialogService';

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export interface OverlayPortalProps {
  visible: boolean;
  layer?: OverlayLayer;
  priority?: number;
  onRequestClose?: () => void;
  children: ReactNode;
}

/**
 * 声明式顶层浮层传送门：将弹窗、底部抽屉与全屏模态统一挂载到根部 AppDialogHost，
 * 避免原生 Modal 创建独立 Window 导致的安全区失准与并发遮挡死锁。
 */
export function OverlayPortal({
  visible,
  layer = 'sheet',
  priority,
  onRequestClose,
  children,
}: OverlayPortalProps): null {
  const portalId = useId();
  const resolvedPriority = priority ?? getDefaultOverlayPriority(layer);
  const renderRef = useRef<() => ReactNode>(() => children);
  const onRequestCloseRef = useRef<(() => void) | undefined>(onRequestClose);
  const registeredRef = useRef(false);

  renderRef.current = () => children;
  onRequestCloseRef.current = onRequestClose;

  useIsomorphicLayoutEffect(() => {
    if (!visible) {
      if (registeredRef.current) {
        registeredRef.current = false;
        removeOverlayPortal(portalId);
      }
      return;
    }

    registeredRef.current = true;
    upsertOverlayPortal({
      id: portalId,
      layer,
      priority: resolvedPriority,
      onRequestClose: () => onRequestCloseRef.current?.(),
      render: () => renderRef.current(),
    });
  }, [visible, portalId, layer, resolvedPriority, children]);

  useIsomorphicLayoutEffect(() => {
    return () => {
      if (registeredRef.current) {
        registeredRef.current = false;
        removeOverlayPortal(portalId);
      }
    };
  }, [portalId]);

  return null;
}

interface HostRenderItem {
  key: string;
  priority: number;
  order: number;
  isDialog: boolean;
  onRequestClose?: () => void;
  render: () => ReactNode;
}

/**
 * 全局唯一顶层浮层与对话框宿主，需挂载于根 `<SafeAreaProvider>` 最末子节点。
 * 空闲态返回 `null`，激活态按 Sheet/Fullscreen 层与 Alert/Dialog 层独立调度、互不阻塞。
 */
export function AppDialogHost() {
  const theme = useKelivoTheme();
  const [request, setRequest] = useState<DialogRequest | null>(null);
  const [overlaySnapshot, setOverlaySnapshot] = useState<OverlayHostSnapshot>(() =>
    getOverlayHostSnapshot()
  );

  useEffect(() => {
    bindAppDialogHost(setRequest);
    const unsubscribeOverlay = subscribeOverlayHost(setOverlaySnapshot);
    return () => {
      unsubscribeOverlay();
      bindAppDialogHost(null);
    };
  }, []);

  const surfaceItems: HostRenderItem[] = [];
  const dialogItems: HostRenderItem[] = [];

  for (const portal of overlaySnapshot.portals) {
    const item: HostRenderItem = {
      key: `portal:${portal.id}`,
      priority: portal.priority,
      order: portal.order,
      isDialog: portal.layer === 'dialog',
      onRequestClose: portal.onRequestClose,
      render: portal.render,
    };
    if (portal.layer === 'dialog') {
      dialogItems.push(item);
    } else {
      surfaceItems.push(item);
    }
  }

  if (overlaySnapshot.activeSheet) {
    const sheet = overlaySnapshot.activeSheet;
    surfaceItems.push({
      key: `sheet:${sheet.id}`,
      priority: getDefaultOverlayPriority('sheet') + 5,
      order: sheet.order,
      isDialog: false,
      onRequestClose: () => {
        if (sheet.dismissible) {
          sheet.dismiss();
        }
      },
      render: () => (
        <View style={[styles.sheetBackdrop, { backgroundColor: theme.colors.scrim }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭弹层"
            style={StyleSheet.absoluteFill}
            onPress={() => {
              if (sheet.dismissible) {
                sheet.dismiss();
              }
            }}
          />
          <View style={styles.sheetContainer} pointerEvents="box-none">
            {sheet.render((result) => sheet.resolve(result))}
          </View>
        </View>
      ),
    });
  }

  if (request) {
    dialogItems.push({
      key: 'imperative-dialog',
      priority: 100,
      order: Number.MAX_SAFE_INTEGER,
      isDialog: true,
      onRequestClose: () => {
        if (request.kind === 'confirm') {
          request.resolve(false);
        } else {
          request.resolve();
        }
      },
      render: () =>
        request.kind === 'confirm' ? (
          <ConfirmDialogContent
            title={request.title}
            description={request.description}
            subject={request.subject}
            confirmLabel={request.confirmLabel}
            cancelLabel={request.cancelLabel}
            tone={request.tone}
            icon={request.icon}
            onConfirm={() => request.resolve(true)}
            onCancel={() => request.resolve(false)}
          />
        ) : (
          <NoticeDialogContent
            title={request.title}
            description={request.description}
            buttonLabel={request.buttonLabel}
            tone={request.tone}
            icon={request.icon}
            onClose={() => request.resolve()}
          />
        ),
    });
  }

  surfaceItems.sort((left, right) => left.priority - right.priority || left.order - right.order);
  dialogItems.sort((left, right) => left.priority - right.priority || left.order - right.order);

  const hasActiveOverlay = surfaceItems.length > 0 || dialogItems.length > 0;
  const topInteractableItem =
    dialogItems[dialogItems.length - 1] ?? surfaceItems[surfaceItems.length - 1] ?? null;

  const topCloseRef = useRef<(() => void) | undefined>(undefined);
  topCloseRef.current = topInteractableItem?.onRequestClose;

  useEffect(() => {
    if (!hasActiveOverlay) {
      return undefined;
    }

    const backSubscription = BackHandler.addEventListener('hardwareBackPress', () => {
      topCloseRef.current?.();
      return true;
    });

    let removeWebListener: (() => void) | undefined;
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key !== 'Escape') {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        topCloseRef.current?.();
      };
      window.addEventListener('keydown', handleKeyDown, true);
      removeWebListener = () => window.removeEventListener('keydown', handleKeyDown, true);
    }

    return () => {
      backSubscription.remove();
      removeWebListener?.();
    };
  }, [hasActiveOverlay]);

  if (!hasActiveOverlay) {
    return null;
  }

  const topKey = topInteractableItem?.key ?? null;

  return (
    <View style={styles.hostRoot} pointerEvents="box-none" testID="app-dialog-host">
      {surfaceItems.map((item) => (
        <View
          key={item.key}
          style={styles.layerContainer}
          pointerEvents={item.key === topKey ? 'box-none' : 'none'}
        >
          {item.render()}
        </View>
      ))}
      {dialogItems.map((item) => (
        <View
          key={item.key}
          style={[styles.layerContainer, styles.dialogLayer]}
          pointerEvents={item.key === topKey ? 'box-none' : 'none'}
        >
          {item.render()}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  hostRoot: {
    ...StyleSheet.absoluteFill,
    zIndex: 9999,
    elevation: 9999,
    ...(Platform.OS === 'web'
      ? ({
          position: 'fixed',
          inset: 0,
          zIndex: 9999,
        } as Record<string, unknown>)
      : {}),
  },
  layerContainer: {
    ...StyleSheet.absoluteFill,
  },
  dialogLayer: {
    zIndex: 20,
    elevation: 20,
  },
  sheetBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheetContainer: {
    width: '100%',
    maxHeight: '100%',
  },
});
