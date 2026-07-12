import { Check, SlidersHorizontal } from 'lucide-react-native';
import { StyleSheet, Text, View } from 'react-native';
import { AnimatedPressable } from './AnimatedPressable';
import { ModelAvatar } from './ModelAvatar';
import { MotionSwap } from './Motion';
import { useKelivoTheme, type KelivoTheme } from '../theme';
import { modelCapabilityTags } from '../utils/modelDisplay';
import type { ModelInfo } from '../../domain/types';

export interface ModelManageRowProps {
  model: ModelInfo;
  providerName: string;
  active: boolean;
  selected: boolean;
  disabled?: boolean;
  onActivate: () => void;
  onToggleSelect: () => void;
}

export function ModelManageRow({
  model,
  providerName,
  active,
  selected,
  disabled = false,
  onActivate,
  onToggleSelect,
}: ModelManageRowProps) {
  const theme = useKelivoTheme();
  const styles = getStyles(theme);
  const badges = modelCapabilityTags(model, { max: 8 });

  return (
    <View style={[styles.row, active && styles.rowActive]}>
      <AnimatedPressable
        accessibilityRole="button"
        accessibilityLabel={active ? `${model.name ?? model.id}，当前模型` : `切换到 ${model.name ?? model.id}`}
        accessibilityState={{ disabled, selected: active }}
        disabled={disabled}
        onPress={onActivate}
        haptic="selection"
        pressScale={0.99}
        style={styles.main}
      >
        <ModelAvatar
          modelId={model.id}
          providerName={providerName}
          size={18}
          containerSize={30}
        />
        <View style={styles.info}>
          <Text style={styles.name} numberOfLines={1}>
            {model.name ?? model.id}
          </Text>
          <View style={styles.badgeRow}>
            {active ? (
              <View style={styles.activeBadge}>
                <Text style={styles.activeBadgeText}>当前</Text>
              </View>
            ) : null}
            {badges.map((badge) => (
              <View key={badge} style={styles.badge}>
                <Text style={styles.badgeText}>{badge}</Text>
              </View>
            ))}
          </View>
        </View>
      </AnimatedPressable>

      <AnimatedPressable
        accessibilityRole="button"
        accessibilityLabel={selected ? `取消删除 ${model.name ?? model.id}` : `选择删除 ${model.name ?? model.id}`}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onToggleSelect}
        haptic="light"
        style={[styles.action, selected && styles.actionSelected, disabled && styles.disabled]}
      >
        <MotionSwap
          motionKey={selected ? 'selected' : 'idle'}
          style={styles.actionIconSwap}
        >
          {selected ? (
            <Check size={16} color={theme.colors.textOnAccent} strokeWidth={2.5} />
          ) : (
            <SlidersHorizontal size={16} color={theme.colors.textSecondary} strokeWidth={2} />
          )}
        </MotionSwap>
      </AnimatedPressable>
    </View>
  );
}

function createStyles(theme: KelivoTheme) {
  return StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingHorizontal: 12,
    minHeight: 60,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  rowActive: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.surfacePressed,
  },
  main: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  info: {
    flex: 1,
    gap: 5,
  },
  name: {
    fontSize: 15,
    fontWeight: '600',
    color: theme.colors.text,
  },
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  badge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: theme.colors.primaryContainer,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '600',
    color: theme.colors.onPrimaryContainer,
  },
  activeBadge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: theme.colors.primary,
  },
  activeBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: theme.colors.textOnPrimary,
  },
  action: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surfaceSunken,
    marginLeft: 10,
  },
  disabled: {
    opacity: 0.5,
  },
  actionSelected: {
    backgroundColor: theme.colors.primary,
  },
  actionIconSwap: {
    width: 16,
    height: 16,
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
