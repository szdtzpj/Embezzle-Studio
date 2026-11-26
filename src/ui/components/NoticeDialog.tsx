import type { ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AlertTriangle, CheckCircle2 } from 'lucide-react-native';
import { AnimatedPressable } from './AnimatedPressable';
import { OverlayPortal } from './AppDialogHost';
import { MotionItem } from './Motion';
import { useKelivoTheme, type KelivoTheme } from '../theme';
import type { DialogTone } from './dialogService';

export interface NoticeDialogProps {
  visible: boolean;
  title: string;
  description: string;
  buttonLabel?: string;
  tone?: DialogTone;
  icon?: ReactNode;
  onClose: () => void;
}

export type NoticeDialogContentProps = Omit<NoticeDialogProps, 'visible'>;

function DefaultIcon({ tone }: { tone: DialogTone }) {
  const theme = useKelivoTheme();
  if (tone === 'warning') {
    return <AlertTriangle size={22} color={theme.colors.warning} strokeWidth={2.25} />;
  }
  if (tone === 'danger') {
    return <AlertTriangle size={22} color={theme.colors.error} strokeWidth={2.25} />;
  }
  return <CheckCircle2 size={22} color={theme.colors.success} strokeWidth={2.25} />;
}

/**
 * 通知弹窗纯内容组件：供 `AppDialogHost` 直接渲染以避免 Portal 循环注册。
 */
export function NoticeDialogContent({
  title,
  description,
  buttonLabel = '好的',
  tone = 'primary',
  icon,
  onClose,
}: NoticeDialogContentProps) {
  const theme = useKelivoTheme();
  const insets = useSafeAreaInsets();
  const styles = getStyles(theme, tone);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : Platform.OS === 'android' ? 'height' : undefined}
      style={styles.keyboard}
    >
      <Pressable
        style={[
          styles.scrim,
          {
            paddingTop: Math.max(24, insets.top + 12),
            paddingBottom: Math.max(24, insets.bottom + 12),
            paddingLeft: Math.max(24, insets.left + 12),
            paddingRight: Math.max(24, insets.right + 12),
          },
        ]}
        onPress={onClose}
      >
        <MotionItem
          delay={20}
          distance={12}
          duration={220}
          scaleFrom={0.94}
          style={styles.dialogMotion}
        >
          <Pressable
            accessible={false}
            accessibilityViewIsModal
            style={styles.dialog}
            onPress={(event) => event.stopPropagation()}
          >
            <ScrollView
              style={styles.contentScroll}
              contentContainerStyle={styles.contentScrollBody}
              bounces={false}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <View
                accessible
                accessibilityRole="alert"
                accessibilityLiveRegion="assertive"
                style={styles.messageBlock}
              >
                <View style={styles.iconWrap}>
                  {icon ?? <DefaultIcon tone={tone} />}
                </View>
                <Text style={styles.title}>{title}</Text>
                <Text style={styles.description}>{description}</Text>
              </View>
            </ScrollView>
            <View style={styles.footer}>
              <AnimatedPressable
                accessibilityRole="button"
                accessibilityLabel={buttonLabel}
                onPress={onClose}
                haptic="light"
                style={styles.button}
              >
                <Text style={styles.buttonText}>{buttonLabel}</Text>
              </AnimatedPressable>
            </View>
          </Pressable>
        </MotionItem>
      </Pressable>
    </KeyboardAvoidingView>
  );
}

/**
 * 声明式通知弹窗，经由 `OverlayPortal` 渲染于统一顶层宿主。
 */
export function NoticeDialog({
  visible,
  onClose,
  ...rest
}: NoticeDialogProps) {
  return (
    <OverlayPortal visible={visible} layer="dialog" onRequestClose={onClose}>
      <NoticeDialogContent onClose={onClose} {...rest} />
    </OverlayPortal>
  );
}

function createStyles(theme: KelivoTheme, tone: DialogTone) {
  const accent =
    tone === 'warning'
      ? theme.colors.warning
      : tone === 'danger'
        ? theme.colors.error
        : theme.colors.primary;
  const accentContainer =
    tone === 'warning'
      ? theme.colors.warningContainer
      : tone === 'danger'
        ? theme.colors.errorContainer
        : theme.colors.primaryContainer;
  const onAccent =
    tone === 'warning'
      ? theme.colors.onWarning
      : tone === 'danger'
        ? theme.colors.onError
        : theme.colors.onPrimary;

  return StyleSheet.create({
    keyboard: {
      flex: 1,
    },
    scrim: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 24,
      paddingVertical: 24,
      backgroundColor: theme.colors.scrim,
    },
    dialogMotion: {
      width: '100%',
      maxWidth: 348,
      maxHeight: '100%',
    },
    dialog: {
      width: '100%',
      maxHeight: '100%',
      minWidth: 0,
      alignItems: 'center',
      borderRadius: 20,
      borderWidth: 0.7,
      borderColor: theme.colors.outline,
      backgroundColor: theme.colors.card,
      ...theme.shadows.medium,
      overflow: 'hidden',
    },
    contentScroll: {
      width: '100%',
      flexShrink: 1,
    },
    contentScrollBody: {
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingTop: 22,
      paddingBottom: 8,
    },
    messageBlock: {
      width: '100%',
      alignItems: 'center',
    },
    iconWrap: {
      width: 46,
      height: 46,
      borderRadius: 23,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 13,
      borderWidth: 1,
      borderColor: accent,
      backgroundColor: accentContainer,
    },
    title: {
      color: theme.colors.text,
      fontSize: 18,
      lineHeight: 24,
      fontWeight: '700',
      textAlign: 'center',
    },
    description: {
      marginTop: 11,
      color: theme.colors.textSecondary,
      fontSize: 13,
      lineHeight: 20,
      textAlign: 'center',
    },
    footer: {
      width: '100%',
      paddingHorizontal: 20,
      paddingTop: 11,
      paddingBottom: 18,
    },
    button: {
      width: '100%',
      minHeight: 42,
      paddingVertical: 10,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: accent,
    },
    buttonText: {
      color: onAccent,
      fontSize: 14,
      fontWeight: '700',
    },
  });
}

const styleCache = new Map<string, ReturnType<typeof createStyles>>();

function getStyles(theme: KelivoTheme, tone: DialogTone) {
  const key = `${theme.scheme}:${tone}`;
  let styles = styleCache.get(key);
  if (!styles) {
    styles = createStyles(theme, tone);
    styleCache.set(key, styles);
  }
  return styles;
}
