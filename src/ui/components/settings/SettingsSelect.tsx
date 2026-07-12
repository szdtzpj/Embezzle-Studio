import { useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Check, ChevronDown } from 'lucide-react-native';
import { AnimatedPressable } from '../AnimatedPressable';
import { MotionItem } from '../Motion';
import { useKelivoTheme, type KelivoTheme } from '../../theme';

export interface SettingsSelectOption<T extends string = string> {
  key: T;
  label: string;
}

export interface SettingsSelectProps<T extends string = string> {
  value: T;
  options: ReadonlyArray<SettingsSelectOption<T>>;
  placeholder?: string;
  disabled?: boolean;
  accessibilityLabel?: string;
  onChange: (value: T) => void;
}

export function SettingsSelect<T extends string>({
  value,
  options,
  placeholder = '请选择',
  disabled = false,
  accessibilityLabel,
  onChange,
}: SettingsSelectProps<T>) {
  const theme = useKelivoTheme();
  const styles = getStyles(theme);
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.key === value);
  const displayLabel = selected?.label ?? placeholder;

  const close = () => setOpen(false);

  const choose = (next: T) => {
    onChange(next);
    setOpen(false);
  };

  return (
    <>
      <AnimatedPressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? displayLabel}
        accessibilityState={{ disabled, expanded: open }}
        disabled={disabled}
        onPress={() => setOpen(true)}
        haptic="selection"
        pressScale={0.995}
        style={[styles.field, disabled && styles.fieldDisabled, open && styles.fieldOpen]}
      >
        <Text
          style={[styles.fieldText, !selected && styles.placeholder]}
          numberOfLines={1}
        >
          {displayLabel}
        </Text>
        <ChevronDown
          size={18}
          color={theme.colors.textSecondary}
          strokeWidth={2.1}
          style={open ? styles.chevronOpen : undefined}
        />
      </AnimatedPressable>

      <Modal
        visible={open}
        transparent
        statusBarTranslucent
        animationType="fade"
        onRequestClose={close}
      >
        <Pressable style={styles.scrim} onPress={close}>
          <MotionItem
            delay={16}
            distance={8}
            duration={180}
            scaleFrom={0.97}
            style={styles.menuMotion}
          >
            <Pressable
              accessible={false}
              accessibilityViewIsModal
              style={styles.menu}
              onPress={(event) => event.stopPropagation()}
            >
              {options.map((option, index) => {
                const isSelected = option.key === value;
                return (
                  <AnimatedPressable
                    key={option.key}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isSelected }}
                    onPress={() => choose(option.key)}
                    haptic="selection"
                    pressScale={0.99}
                    style={[
                      styles.option,
                      index < options.length - 1 && styles.optionBorder,
                      isSelected && styles.optionSelected,
                    ]}
                  >
                    <Text
                      style={[styles.optionLabel, isSelected && styles.optionLabelSelected]}
                      numberOfLines={1}
                    >
                      {option.label}
                    </Text>
                    {isSelected ? (
                      <Check size={18} color={theme.colors.primary} strokeWidth={2.5} />
                    ) : (
                      <View style={styles.checkPlaceholder} />
                    )}
                  </AnimatedPressable>
                );
              })}
            </Pressable>
          </MotionItem>
        </Pressable>
      </Modal>
    </>
  );
}

function createStyles(theme: KelivoTheme) {
  return StyleSheet.create({
    field: {
      minHeight: 44,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.colors.outline,
      backgroundColor: theme.colors.surface,
      paddingHorizontal: 12,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    fieldOpen: {
      borderColor: theme.colors.primary,
    },
    fieldDisabled: {
      opacity: 0.5,
    },
    fieldText: {
      flex: 1,
      color: theme.colors.text,
      fontSize: 15,
      fontWeight: '500',
    },
    placeholder: {
      color: theme.colors.textTertiary,
      fontWeight: '400',
    },
    chevronOpen: {
      transform: [{ rotate: '180deg' }],
    },
    scrim: {
      flex: 1,
      justifyContent: 'center',
      paddingHorizontal: 28,
      backgroundColor: theme.colors.scrim,
      ...(Platform.OS === 'web'
        ? ({
            position: 'fixed',
            inset: 0,
          } as any)
        : {}),
    },
    menuMotion: {
      width: '100%',
      maxWidth: 360,
      alignSelf: 'center',
    },
    menu: {
      borderRadius: 14,
      borderWidth: 0.7,
      borderColor: theme.colors.outline,
      backgroundColor: theme.colors.card,
      overflow: 'hidden',
      ...theme.shadows.medium,
    },
    option: {
      minHeight: 48,
      paddingHorizontal: 14,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    optionBorder: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.divider,
    },
    optionSelected: {
      backgroundColor: theme.colors.surfacePressed,
    },
    optionLabel: {
      flex: 1,
      color: theme.colors.text,
      fontSize: 15,
      fontWeight: '500',
    },
    optionLabelSelected: {
      color: theme.colors.primary,
      fontWeight: '600',
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
