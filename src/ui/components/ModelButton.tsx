import { StyleSheet, Text, View } from 'react-native';
import { AnimatedPressable } from './AnimatedPressable';
import { ModelAvatar } from './ModelAvatar';
import { ModelTaskBadge } from './ModelTaskBadge';
import { useKelivoTheme, type KelivoTheme } from '../theme';
import type { ModelInfo } from '../../domain/types';

export interface ModelButtonProps {
  model: ModelInfo;
  providerName?: string;
  active: boolean;
  onPress: () => void;
  onRemove: () => void;
}

export function ModelButton({ model, providerName, active, onPress, onRemove }: ModelButtonProps) {
  const theme = useKelivoTheme();
  const styles = getStyles(theme);

  return (
    <View style={[styles.root, active && styles.rootActive]}>
      <AnimatedPressable accessibilityRole="button" onPress={onPress} style={styles.selectArea}>
        <ModelAvatar modelId={model.id} providerName={providerName} size={17} containerSize={26} />
        <View style={styles.textBlock}>
          <Text numberOfLines={1} style={[styles.name, active && styles.nameActive]}>
            {model.name ?? model.id}
          </Text>
          <Text numberOfLines={1} style={styles.meta}>
            {model.id}
          </Text>
          <ModelTaskBadge model={model} />
        </View>
      </AnimatedPressable>
      <AnimatedPressable accessibilityRole="button" onPress={onRemove} style={styles.removeButton}>
        <Text style={styles.removeButtonText}>删除</Text>
      </AnimatedPressable>
    </View>
  );
}

function createStyles(theme: KelivoTheme) {
  return StyleSheet.create({
  root: {
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.outline,
    backgroundColor: theme.colors.surfaceAlt,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  rootActive: {
    borderColor: theme.colors.accentBorder,
    backgroundColor: theme.colors.accentSoft,
  },
  selectArea: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  textBlock: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    color: theme.colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  nameActive: {
    color: theme.colors.accentText,
  },
  meta: {
    marginTop: 4,
    color: theme.colors.textSecondary,
    fontSize: 12,
  },
  removeButton: {
    height: 36,
    minWidth: 52,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.borderStrong,
    backgroundColor: theme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  removeButtonText: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
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
