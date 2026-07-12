import type { ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { AnimatedPressable } from './AnimatedPressable';
import { MotionItem } from './Motion';
import { useKelivoTheme, type KelivoTheme } from '../theme';

export interface PromptDialogProps {
  visible: boolean;
  title: string;
  description?: string;
  value: string;
  placeholder?: string;
  maxLength?: number;
  confirmLabel?: string;
  cancelLabel?: string;
  autoFocus?: boolean;
  secureTextEntry?: boolean;
  icon?: ReactNode;
  onChangeText: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function PromptDialog({
  visible,
  title,
  description,
  value,
  placeholder,
  maxLength,
  confirmLabel = '保存',
  cancelLabel = '取消',
  autoFocus = true,
  secureTextEntry,
  icon,
  onChangeText,
  onConfirm,
  onCancel,
}: PromptDialogProps) {
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
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : Platform.OS === 'android' ? 'height' : undefined}
        style={styles.keyboard}
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
              {icon ? <View style={styles.iconWrap}>{icon}</View> : null}
              <Text style={styles.title}>{title}</Text>
              {description ? <Text style={styles.description}>{description}</Text> : null}
              <TextInput
                value={value}
                onChangeText={onChangeText}
                autoFocus={autoFocus}
                maxLength={maxLength}
                placeholder={placeholder}
                placeholderTextColor={theme.colors.placeholder}
                secureTextEntry={secureTextEntry}
                style={styles.input}
              />
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
                  haptic="medium"
                  style={styles.confirmButton}
                >
                  <Text style={styles.confirmText}>{confirmLabel}</Text>
                </AnimatedPressable>
              </View>
            </Pressable>
          </MotionItem>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function createStyles(theme: KelivoTheme) {
  return StyleSheet.create({
    keyboard: {
      flex: 1,
    },
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
      maxWidth: 360,
    },
    dialog: {
      width: '100%',
      minWidth: 0,
      alignItems: 'stretch',
      paddingHorizontal: 20,
      paddingTop: 22,
      paddingBottom: 18,
      borderRadius: 20,
      borderWidth: 0.7,
      borderColor: theme.colors.outline,
      backgroundColor: theme.colors.card,
      ...theme.shadows.medium,
    },
    iconWrap: {
      alignSelf: 'center',
      width: 46,
      height: 46,
      borderRadius: 23,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 12,
      borderWidth: 1,
      borderColor: theme.colors.outline,
      backgroundColor: theme.colors.surfaceSunken,
    },
    title: {
      color: theme.colors.text,
      fontSize: 18,
      lineHeight: 24,
      fontWeight: '700',
      textAlign: 'center',
    },
    description: {
      marginTop: 8,
      color: theme.colors.textSecondary,
      fontSize: 13,
      lineHeight: 19,
      textAlign: 'center',
    },
    input: {
      marginTop: 16,
      minHeight: 44,
      borderRadius: 12,
      borderWidth: 0.8,
      borderColor: theme.colors.outline,
      backgroundColor: theme.colors.surfaceSunken,
      color: theme.colors.text,
      fontSize: 15,
      paddingHorizontal: 12,
      paddingVertical: 10,
      ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
    },
    actions: {
      width: '100%',
      flexDirection: 'row',
      gap: 10,
      marginTop: 16,
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
      backgroundColor: theme.colors.primary,
    },
    confirmText: {
      color: theme.colors.onPrimary,
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
