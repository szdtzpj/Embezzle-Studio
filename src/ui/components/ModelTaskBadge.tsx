import { StyleSheet, Text, View } from 'react-native';
import { inferModelTask } from '../../services/modelCapabilities';
import { modelTaskLabel } from '../utils/modelDisplay';
import { useKelivoTheme, type KelivoTheme } from '../theme';
import type { ModelInfo } from '../../domain/types';

export interface ModelTaskBadgeProps {
  model: ModelInfo;
}

export function ModelTaskBadge({ model }: ModelTaskBadgeProps) {
  const theme = useKelivoTheme();
  const styles = getStyles(theme);
  const task = inferModelTask(model);

  return (
    <View style={styles.badge}>
      <Text style={styles.text}>{modelTaskLabel[task]}</Text>
    </View>
  );
}

function createStyles(theme: KelivoTheme) {
  return StyleSheet.create({
  badge: {
    alignSelf: 'flex-start',
    marginTop: 6,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.outline,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  text: {
    color: theme.colors.textSecondary,
    fontSize: 11,
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
