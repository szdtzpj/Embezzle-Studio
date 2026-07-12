import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react-native';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { useKelivoTheme, type KelivoTheme } from '../../theme';

export interface ToolsPanelScreenProps {
  title?: string;
  onBack: () => void;
  children: ReactNode;
}

/**
 * Shared chrome for main-branch feature panels inside the redesigned settings stack.
 * Content keeps functional handlers from App; only the page shell follows Kelivo UI.
 */
export function ToolsPanelScreen({
  title = '工作区与工具',
  onBack,
  children,
}: ToolsPanelScreenProps) {
  const theme = useKelivoTheme();
  const styles = getStyles(theme);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <AnimatedPressable accessibilityRole="button" onPress={onBack} style={styles.headerButton}>
          <ArrowLeft size={22} color={theme.colors.text} strokeWidth={2.2} />
        </AnimatedPressable>
        <Text style={styles.headerTitle}>{title}</Text>
        <View style={styles.headerButton} />
      </View>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardDismissMode={Platform.OS === 'android' ? 'on-drag' : 'interactive'}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
    </View>
  );
}

function createStyles(theme: KelivoTheme) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.surface,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 6,
      paddingTop: 8,
      paddingBottom: 6,
      borderBottomWidth: 0.6,
      borderBottomColor: theme.colors.outlineVariant,
    },
    headerButton: {
      width: 38,
      height: 38,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerTitle: {
      fontSize: 17,
      fontWeight: '600',
      color: theme.colors.text,
    },
    scroll: {
      flex: 1,
    },
    content: {
      paddingTop: 10,
      paddingBottom: 28,
      paddingHorizontal: 0,
      gap: 12,
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
