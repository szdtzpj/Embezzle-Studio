import type { ReactNode } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Trash2 } from 'lucide-react-native';
import { AnimatedPressable } from './AnimatedPressable';
import { MotionItem } from './Motion';
import { useKelivoTheme, type KelivoTheme } from '../theme';

export interface ConfirmDialogProps {
  visible: boolean;
  title: string;
  description: string;
  subject?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  icon?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  visible,
  title,
  description,
  subject,
  confirmLabel = '确定',
  cancelLabel = '取消',
  icon,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const theme = useKelivoTheme();
  const styles = getStyles(theme);

  return (
    <Modal
      visible={visible}
      transparent
      statusBarTranslucent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <Pressable style={styles.scrim} onPress={onCancel}>
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
            <View
              accessible
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
              style={styles.messageBlock}
            >
              <View style={styles.iconWrap}>
                {icon ?? <Trash2 size={22} color={theme.colors.error} strokeWidth={2.25} />}
              </View>

              <Text style={styles.title}>{title}</Text>

              {subject ? (
                <View style={styles.subjectWrap}>
                  <Text style={styles.subject} numberOfLines={2}>
                    {subject}
                  </Text>
                </View>
              ) : null}

              <Text style={styles.description}>{description}</Text>
            </View>

            <View style={styles.actions}>
              <AnimatedPressable
                accessibilityRole="button"
                accessibilityLabel={cancelLabel}
                onPress={onCancel}
                haptic="light"
                style={styles.cancelButton}
              >
                <Text style={styles.cancelText}>{cancelLabel}</Text>
              </AnimatedPressable>
              <AnimatedPressable
                accessibilityRole="button"
                accessibilityLabel={confirmLabel}
                onPress={onConfirm}
                haptic="warning"
                style={styles.confirmButton}
              >
                <Text style={styles.confirmText}>{confirmLabel}</Text>
              </AnimatedPressable>
            </View>
          </Pressable>
        </MotionItem>
      </Pressable>
    </Modal>
  );
}

function createStyles(theme: KelivoTheme) {
  return StyleSheet.create({
  scrim: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    backgroundColor: theme.colors.scrim,
    ...(Platform.OS === 'web'
      ? ({
          position: 'fixed',
          inset: 0,
        } as any)
      : {}),
  },
  dialogMotion: {
    width: '100%',
    maxWidth: 348,
  },
  dialog: {
    width: '100%',
    minWidth: 0,
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 22,
    paddingBottom: 18,
    borderRadius: 20,
    borderWidth: 0.7,
    borderColor: theme.colors.outline,
    backgroundColor: theme.colors.card,
    ...theme.shadows.medium,
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
    borderColor: theme.colors.error,
    backgroundColor: theme.colors.errorContainer,
  },
  title: {
    color: theme.colors.text,
    fontSize: 18,
    lineHeight: 24,
    fontWeight: '700',
    textAlign: 'center',
  },
  subjectWrap: {
    maxWidth: '100%',
    marginTop: 10,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 10,
    backgroundColor: theme.colors.surfaceSunken,
  },
  subject: {
    color: theme.colors.text,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '600',
    textAlign: 'center',
  },
  description: {
    marginTop: 11,
    color: theme.colors.textSecondary,
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
  },
  actions: {
    width: '100%',
    flexDirection: 'row',
    gap: 10,
    marginTop: 19,
  },
  cancelButton: {
    flex: 1,
    height: 42,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 0.8,
    borderColor: theme.colors.outline,
    backgroundColor: theme.colors.surfaceSunken,
  },
  cancelText: {
    color: theme.colors.textSecondary,
    fontSize: 14,
    fontWeight: '600',
  },
  confirmButton: {
    flex: 1,
    height: 42,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.error,
  },
  confirmText: {
    color: theme.colors.onError,
    fontSize: 14,
    fontWeight: '700',
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
