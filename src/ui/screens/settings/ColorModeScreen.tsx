import { ArrowLeft, Check, Monitor, Sun, Moon } from 'lucide-react-native';
import { StyleSheet, Text, View } from 'react-native';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { MotionItem, MotionSwap } from '../../components/Motion';
import { SectionCard } from '../../components/settings/SettingsList';
import { useKelivoTheme, type KelivoTheme } from '../../theme';

export interface ColorModeScreenProps {
  readOnly: boolean;
  colorMode: 'system' | 'light' | 'dark';
  onSetColorMode: (mode: 'system' | 'light' | 'dark') => void;
  onBack: () => void;
}

type ModeOption = { key: 'system' | 'light' | 'dark'; label: string; icon: React.ReactNode };

export function ColorModeScreen({ readOnly, colorMode, onSetColorMode, onBack }: ColorModeScreenProps) {
  const theme = useKelivoTheme();
  const styles = getStyles(theme);
  const options: ModeOption[] = [
    {
      key: 'system',
      label: '跟随系统',
      icon: <Monitor size={20} color={theme.colors.text} strokeWidth={2} />,
    },
    {
      key: 'light',
      label: '浅色',
      icon: <Sun size={20} color={theme.colors.text} strokeWidth={2} />,
    },
    {
      key: 'dark',
      label: '深色',
      icon: <Moon size={20} color={theme.colors.text} strokeWidth={2} />,
    },
  ];

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <AnimatedPressable accessibilityRole="button" onPress={onBack} style={styles.headerButton}>
          <ArrowLeft size={22} color={theme.colors.text} strokeWidth={2.2} />
        </AnimatedPressable>
        <Text style={styles.headerTitle}>颜色模式</Text>
        <View style={styles.headerButton} />
      </View>

      <View style={styles.content}>
        <SectionCard>
          {options.map((option, index) => {
            const selected = option.key === colorMode;
            return (
              <MotionItem key={option.key} index={index} distance={7}>
                <AnimatedPressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: readOnly, selected }}
                  disabled={readOnly}
                  onPress={() => onSetColorMode(option.key)}
                  haptic="selection"
                  pressScale={0.99}
                >
                  <View
                    style={[
                      styles.row,
                      index !== options.length - 1 && styles.rowBorder,
                    ]}
                  >
                    <View style={styles.iconSlot}>{option.icon}</View>
                    <Text style={styles.label}>{option.label}</Text>
                    <MotionSwap
                      motionKey={selected ? 'selected' : 'idle'}
                      style={styles.checkSlot}
                    >
                      {selected ? (
                        <Check size={18} color={theme.colors.primary} strokeWidth={2.5} />
                      ) : (
                        <View style={styles.checkPlaceholder} />
                      )}
                    </MotionSwap>
                  </View>
                </AnimatedPressable>
              </MotionItem>
            );
          })}
        </SectionCard>
      </View>
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
    content: {
      flex: 1,
      paddingTop: 10,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      paddingVertical: 13,
      gap: 12,
      minHeight: 48,
    },
    rowBorder: {
      borderBottomWidth: 0.6,
      borderBottomColor: theme.colors.divider,
    },
    iconSlot: {
      width: 24,
      alignItems: 'center',
      justifyContent: 'center',
    },
    label: {
      flex: 1,
      fontSize: 15,
      color: theme.colors.text,
      fontWeight: '500',
    },
    checkSlot: {
      width: 18,
      height: 18,
    },
    checkPlaceholder: {
      width: 18,
      height: 18,
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
