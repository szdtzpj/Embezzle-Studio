import { StyleSheet, Text, View } from 'react-native';
import { AnimatedPressable } from './AnimatedPressable';
import { ModelAvatar } from './ModelAvatar';
import { ModelTaskBadge } from './ModelTaskBadge';
import { MotionSwap } from './Motion';
import { useKelivoTheme, type KelivoTheme } from '../theme';
import type { ModelInfo } from '../../domain/types';

export interface CandidateModelRowProps {
  model: ModelInfo;
  providerName?: string;
  added: boolean;
  disabled?: boolean;
  onAdd: () => void;
}

export function CandidateModelRow({ model, providerName, added, disabled = false, onAdd }: CandidateModelRowProps) {
  const theme = useKelivoTheme();
  const styles = getStyles(theme);

  return (
    <View style={styles.root}>
      <ModelAvatar modelId={model.id} providerName={providerName} size={17} containerSize={26} />
      <View style={styles.textBlock}>
        <Text numberOfLines={1} style={styles.name}>
          {model.name ?? model.id}
        </Text>
        <Text numberOfLines={1} style={styles.meta}>
          {model.id}
        </Text>
        <ModelTaskBadge model={model} />
      </View>
      <AnimatedPressable
        accessibilityRole="button"
        accessibilityState={{ disabled: added || disabled }}
        disabled={added || disabled}
        onPress={onAdd}
        style={[styles.addButton, added && styles.addButtonAdded, disabled && styles.disabled]}
      >
        <MotionSwap
          motionKey={added ? 'added' : 'add'}
          style={styles.addButtonSwap}
        >
          <Text style={[styles.addButtonText, added && styles.addButtonTextAdded]}>
            {added ? '已添加' : '+'}
          </Text>
        </MotionSwap>
      </AnimatedPressable>
    </View>
  );
}

function createStyles(theme: KelivoTheme) {
  return StyleSheet.create({
  root: {
    minHeight: 60,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.outline,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: 14,
    paddingVertical: 12,
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
  meta: {
    marginTop: 4,
    color: theme.colors.textSecondary,
    fontSize: 12,
  },
  addButton: {
    minWidth: 48,
    height: 36,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  addButtonAdded: {
    backgroundColor: theme.colors.surfaceSunken,
    borderWidth: 1,
    borderColor: theme.colors.outline,
  },
  addButtonSwap: {
    minWidth: 30,
    minHeight: 18,
  },
  addButtonText: {
    color: theme.colors.textOnAccent,
    fontSize: 14,
    fontWeight: '700',
  },
  addButtonTextAdded: {
    color: theme.colors.textSecondary,
  },
  disabled: {
    opacity: 0.5,
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
