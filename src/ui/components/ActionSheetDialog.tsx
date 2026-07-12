import type { ReactNode } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MotionItem } from './Motion';
import { useKelivoTheme, type KelivoTheme } from '../theme';

export interface ActionSheetDialogProps {
  visible: boolean;
  title: string;
  description?: string;
  icon?: ReactNode;
  children: ReactNode;
  onClose: () => void;
}

/** Themed selection/list dialog shell matching ConfirmDialog aesthetics. */
export function ActionSheetDialog({
  visible,
  title,
  description,
  icon,
  children,
  onClose,
}: ActionSheetDialogProps) {
  const theme = useKelivoTheme();
  const styles = getStyles(theme);

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
            {icon ? <View style={styles.iconWrap}>{icon}</View> : null}
            <Text style={styles.title}>{title}</Text>
            {description ? <Text style={styles.description}>{description}</Text> : null}
            <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
              {children}
            </ScrollView>
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
      maxWidth: 360,
    },
    dialog: {
      width: '100%',
      minWidth: 0,
      alignItems: 'stretch',
      paddingHorizontal: 16,
      paddingTop: 20,
      paddingBottom: 14,
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
      marginBottom: 4,
      paddingHorizontal: 8,
      color: theme.colors.textSecondary,
      fontSize: 13,
      lineHeight: 19,
      textAlign: 'center',
    },
    list: {
      maxHeight: 300,
      marginTop: 10,
    },
    listContent: {
      paddingBottom: 4,
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
