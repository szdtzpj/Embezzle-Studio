import { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import type {
  ImageAspectRatio,
  ImageGenerationOptions,
  ProviderProfile,
} from '../../domain/types';
import { resolveImageApiMode } from '../../services/imageGeneration';
import { useKelivoTheme, type KelivoTheme } from '../theme';
import { AnimatedPressable } from './AnimatedPressable';

export interface ImageGenParamsBarProps {
  provider: ProviderProfile;
  modelId: string;
  value: ImageGenerationOptions;
  onChange: (next: ImageGenerationOptions) => void;
  disabled?: boolean;
  onSwitchModelPress?: () => void;
}

const ASPECT_RATIOS: readonly ImageAspectRatio[] = [
  '1:1',
  '3:2',
  '2:3',
  '4:3',
  '3:4',
  '16:9',
  '9:16',
  '21:9',
];

const QUALITY_OPTIONS: ReadonlyArray<{
  key: NonNullable<ImageGenerationOptions['quality']>;
  label: string;
}> = [
  { key: 'auto', label: '自动' },
  { key: 'low', label: '标准' },
  { key: 'medium', label: '均衡' },
  { key: 'high', label: '高清' },
];

const RESOLUTION_OPTIONS: ReadonlyArray<{
  key: NonNullable<ImageGenerationOptions['resolution']>;
  label: string;
}> = [
  { key: '1k', label: '1K' },
  { key: '2k', label: '2K' },
  { key: '4k', label: '4K' },
];

const COUNT_OPTIONS = [1, 2, 4] as const;

/**
 * 对话内生图参数轻量控制条（挂载于 Composer `composerTopSlot`）：
 * - 总高度严格控制在 `<= 36px` 单行横向滚动，防止挤占移动端与横屏视口；
 * - 零原生 Modal、零嵌套 SafeAreaView；
 * - 按 `resolveImageApiMode` 自动切换 OpenAI 画质 / Gemini 分辨率 / 不支持提示。
 */
export function ImageGenParamsBar({
  provider,
  modelId,
  value,
  onChange,
  disabled = false,
  onSwitchModelPress,
}: ImageGenParamsBarProps) {
  const theme = useKelivoTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const mode = resolveImageApiMode(provider, modelId);

  if (mode === 'unsupported') {
    return (
      <View
        testID="image-gen-params-bar"
        style={[styles.container, styles.unsupportedRow, disabled && styles.disabled]}
      >
        <Text numberOfLines={1} style={styles.unsupportedText}>
          当前服务商不支持原生生图，请切换 OpenAI / Gemini / xAI 生图模型
        </Text>
        {onSwitchModelPress ? (
          <AnimatedPressable
            accessibilityRole="button"
            accessibilityLabel="切换生图模型"
            testID="image-params-switch-model"
            disabled={disabled}
            onPress={onSwitchModelPress}
            style={[styles.pill, styles.pillActive]}
          >
            <Text style={[styles.pillText, styles.pillTextActive]}>切换模型</Text>
          </AnimatedPressable>
        ) : null}
      </View>
    );
  }

  const activeRatio = value.aspectRatio ?? '1:1';
  const activeCount = value.count ?? 1;
  const showQuality = mode === 'openai-images' || mode === 'openai-responses';
  const showResolution = mode === 'gemini-generate-content';
  const showCount = mode !== 'gemini-generate-content';

  return (
    <View
      testID="image-gen-params-bar"
      style={[styles.container, disabled && styles.disabled]}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
      >
        <Text style={styles.groupLabel}>比例</Text>
        {ASPECT_RATIOS.map((ratio) => {
          const selected = activeRatio === ratio;
          return (
            <AnimatedPressable
              key={`ratio:${ratio}`}
              accessibilityRole="button"
              accessibilityLabel={`生图比例 ${ratio}`}
              accessibilityState={{ selected, disabled }}
              disabled={disabled}
              onPress={() => onChange({ ...value, aspectRatio: ratio })}
              haptic="selection"
              style={[styles.pill, selected && styles.pillActive]}
            >
              <Text style={[styles.pillText, selected && styles.pillTextActive]}>{ratio}</Text>
            </AnimatedPressable>
          );
        })}

        {showQuality ? (
          <>
            <View style={styles.divider} />
            <Text style={styles.groupLabel}>画质</Text>
            {QUALITY_OPTIONS.map((option) => {
              const selected = value.quality === option.key;
              return (
                <AnimatedPressable
                  key={`quality:${option.key}`}
                  accessibilityRole="button"
                  accessibilityLabel={`生图画质 ${option.label}`}
                  accessibilityState={{ selected, disabled }}
                  disabled={disabled}
                  onPress={() =>
                    onChange({
                      ...value,
                      quality: selected ? undefined : option.key,
                    })
                  }
                  haptic="selection"
                  style={[styles.pill, selected && styles.pillActive]}
                >
                  <Text style={[styles.pillText, selected && styles.pillTextActive]}>
                    {option.label}
                  </Text>
                </AnimatedPressable>
              );
            })}
          </>
        ) : null}

        {showResolution ? (
          <>
            <View style={styles.divider} />
            <Text style={styles.groupLabel}>分辨率</Text>
            {RESOLUTION_OPTIONS.map((option) => {
              const selected = value.resolution === option.key;
              return (
                <AnimatedPressable
                  key={`res:${option.key}`}
                  accessibilityRole="button"
                  accessibilityLabel={`生图分辨率 ${option.label}`}
                  accessibilityState={{ selected, disabled }}
                  disabled={disabled}
                  onPress={() =>
                    onChange({
                      ...value,
                      resolution: selected ? undefined : option.key,
                    })
                  }
                  haptic="selection"
                  style={[styles.pill, selected && styles.pillActive]}
                >
                  <Text style={[styles.pillText, selected && styles.pillTextActive]}>
                    {option.label}
                  </Text>
                </AnimatedPressable>
              );
            })}
          </>
        ) : null}

        {showCount ? (
          <>
            <View style={styles.divider} />
            <Text style={styles.groupLabel}>张数</Text>
            {COUNT_OPTIONS.map((count) => {
              const selected = activeCount === count;
              return (
                <AnimatedPressable
                  key={`count:${count}`}
                  accessibilityRole="button"
                  accessibilityLabel={`生图数量 ${count} 张`}
                  accessibilityState={{ selected, disabled }}
                  disabled={disabled}
                  onPress={() => onChange({ ...value, count })}
                  haptic="selection"
                  style={[styles.pill, selected && styles.pillActive]}
                >
                  <Text style={[styles.pillText, selected && styles.pillTextActive]}>{count}张</Text>
                </AnimatedPressable>
              );
            })}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

function createStyles(theme: KelivoTheme) {
  const { colors, radius } = theme;
  return StyleSheet.create({
    container: {
      height: 32,
      maxHeight: 36,
      justifyContent: 'center',
      paddingHorizontal: 10,
      paddingTop: 4,
    },
    disabled: {
      opacity: 0.55,
    },
    unsupportedRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
    },
    unsupportedText: {
      flex: 1,
      minWidth: 0,
      color: colors.textSecondary,
      fontSize: 11,
      lineHeight: 15,
    },
    scroll: {
      flexGrow: 0,
      height: 28,
    },
    scrollContent: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      paddingRight: 4,
    },
    groupLabel: {
      color: colors.textSecondary,
      fontSize: 11,
      fontWeight: '600',
      marginRight: 1,
    },
    divider: {
      width: 1,
      height: 14,
      backgroundColor: colors.outline,
      marginHorizontal: 3,
    },
    pill: {
      height: 24,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: colors.outline,
      backgroundColor: colors.card,
      paddingHorizontal: 8,
      alignItems: 'center',
      justifyContent: 'center',
    },
    pillActive: {
      borderColor: colors.accentBorder,
      backgroundColor: colors.accentSoft,
    },
    pillText: {
      color: colors.textSecondary,
      fontSize: 11,
      fontWeight: '600',
      lineHeight: 14,
    },
    pillTextActive: {
      color: colors.accentText,
      fontWeight: '700',
    },
  });
}
