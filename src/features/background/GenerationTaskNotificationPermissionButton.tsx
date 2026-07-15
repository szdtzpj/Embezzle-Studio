import { Bell, BellOff, Check, Settings2 } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { AppState, Platform, StyleSheet, Text, View } from 'react-native';

import {
  getGenerationTaskNotificationPermission,
  openGenerationTaskNotificationSettings,
  requestGenerationTaskNotificationPermission,
  type GenerationTaskNotificationPermission,
} from '../../services/generationTaskNotifications';
import { AnimatedPressable } from '../../ui/components/AnimatedPressable';
import { useKelivoTheme, type KelivoTheme } from '../../ui/theme';

export interface GenerationTaskNotificationPermissionButtonProps {
  /** Render only the action row, without the explanatory subtitle. */
  compact?: boolean;
  onNotice?: (message: string) => void;
  onPermissionChange?: (permission: GenerationTaskNotificationPermission) => void;
}

function permissionLabel(permission: GenerationTaskNotificationPermission): string {
  if (permission === 'granted') return '任务通知已开启';
  if (permission === 'denied') return '前往系统设置开启通知';
  if (permission === 'undetermined') return '开启任务完成通知';
  return '当前平台不支持任务通知';
}

/**
 * Explicit, user-initiated notification permission entry point. It never
 * requests permission during render or app startup; denied users are sent to
 * the OS settings instead of being shown a repeated runtime prompt.
 */
export function GenerationTaskNotificationPermissionButton({
  compact = false,
  onNotice,
  onPermissionChange,
}: GenerationTaskNotificationPermissionButtonProps): React.ReactElement | null {
  const theme = useKelivoTheme();
  const styles = getStyles(theme);
  const [permission, setPermission] = useState<GenerationTaskNotificationPermission>(
    Platform.OS === 'web' ? 'unavailable' : 'undetermined'
  );
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const next = await getGenerationTaskNotificationPermission();
    setPermission(next);
    onPermissionChange?.(next);
  }, [onPermissionChange]);

  useEffect(() => {
    void refresh();
    if (Platform.OS === 'web') return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  if (permission === 'unavailable' && Platform.OS === 'web') return null;

  async function handlePress() {
    if (busy || permission === 'unavailable') return;
    setBusy(true);
    try {
      if (permission === 'denied') {
        const opened = await openGenerationTaskNotificationSettings();
        if (!opened) onNotice?.('无法打开系统通知设置，请在系统设置中手动允许通知。');
        return;
      }
      const next = await requestGenerationTaskNotificationPermission();
      setPermission(next);
      onPermissionChange?.(next);
      if (next === 'denied') {
        onNotice?.('通知权限未开启；你可以点此按钮前往系统设置。');
      } else if (next === 'unavailable') {
        onNotice?.('当前设备无法使用本地任务通知。');
      }
    } finally {
      setBusy(false);
    }
  }

  const granted = permission === 'granted';
  const denied = permission === 'denied';
  const icon = granted ? (
    <Check size={18} color={theme.colors.success} strokeWidth={2.3} />
  ) : denied ? (
    <Settings2 size={18} color={theme.colors.warning} strokeWidth={2.2} />
  ) : permission === 'undetermined' ? (
    <Bell size={18} color={theme.colors.primary} strokeWidth={2.2} />
  ) : (
    <BellOff size={18} color={theme.colors.textSecondary} strokeWidth={2.2} />
  );

  return (
    <View style={[styles.container, compact && styles.containerCompact]}>
      {!compact ? (
        <View style={styles.copy}>
          <Text style={styles.title}>后台生成任务通知</Text>
          <Text style={styles.subtitle}>
            长视频等任务完成或失败后，仅使用本机通知提醒；不会上传推送令牌，也不需要应用服务器。
          </Text>
        </View>
      ) : null}
      <AnimatedPressable
        accessibilityRole="button"
        accessibilityLabel={permissionLabel(permission)}
        accessibilityState={{ busy, disabled: busy || permission === 'unavailable' }}
        disabled={busy || permission === 'unavailable'}
        onPress={() => void handlePress()}
        haptic="light"
        style={[styles.button, compact && styles.buttonCompact, granted && styles.buttonGranted, denied && styles.buttonDenied, busy && styles.disabled]}
        testID="generation-task-notification-permission"
      >
        {icon}
        <Text style={[styles.buttonText, granted && styles.buttonTextGranted, denied && styles.buttonTextDenied]}>
          {busy ? '处理中…' : permissionLabel(permission)}
        </Text>
      </AnimatedPressable>
    </View>
  );
}

function createStyles(theme: KelivoTheme) {
  return StyleSheet.create({
    container: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 4,
    },
    containerCompact: { paddingVertical: 0 },
    copy: { flex: 1, minWidth: 0 },
    title: { color: theme.colors.text, fontSize: 14, lineHeight: 20, fontWeight: '700' },
    subtitle: { marginTop: 3, color: theme.colors.textSecondary, fontSize: 12, lineHeight: 18 },
    button: {
      minHeight: 44,
      maxWidth: 230,
      paddingHorizontal: 13,
      borderRadius: 12,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
      borderWidth: 0.8,
      borderColor: theme.colors.primary,
      backgroundColor: theme.colors.primaryContainer,
    },
    buttonCompact: { minHeight: 44, maxWidth: undefined, flexShrink: 1 },
    buttonGranted: { borderColor: theme.colors.success, backgroundColor: theme.colors.successContainer },
    buttonDenied: { borderColor: theme.colors.warning, backgroundColor: theme.colors.warningContainer },
    buttonText: { color: theme.colors.primary, fontSize: 12, lineHeight: 17, fontWeight: '700', flexShrink: 1 },
    buttonTextGranted: { color: theme.colors.success },
    buttonTextDenied: { color: theme.colors.warning },
    disabled: { opacity: 0.58 },
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
