import type { ReactNode } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { AlertTriangle, CheckCircle2 } from 'lucide-react-native';
import { AnimatedPressable } from './AnimatedPressable';
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

export function NoticeDialog({
  visible,
  title,
  description,
  buttonLabel = '好的',
  tone = 'primary',
  icon,
  onClose,
}: NoticeDialogProps) {
  const theme = useKelivoTheme();
  const styles = getStyles(theme, tone);

  return (
    <Modal
      visible={visible}
      transparent
      statusBarTranslucent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.scrim} onPress={onClose}>
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
                {icon ?? <DefaultIcon tone={tone} />}
              </View>
              <Text style={styles.title}>{title}</Text>
              <Text style={styles.description}>{description}</Text>
            </View>
            <AnimatedPressable
              accessibilityRole="button"
              accessibilityLabel={buttonLabel}
              onPress={onClose}
              haptic="light"
              style={styles.button}
            >
              <Text style={styles.buttonText}>{buttonLabel}</Text>
            </AnimatedPressable>
          </Pressable>
        </MotionItem>
      </Pressable>
    </Modal>
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
      ? theme.colors.text
      : tone === 'danger'
        ? theme.colors.onError
        : theme.colors.onPrimary;

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
    button: {
      width: '100%',
      height: 42,
      marginTop: 19,
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
