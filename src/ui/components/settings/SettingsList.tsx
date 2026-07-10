import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import { AnimatedPressable } from '../AnimatedPressable';
import { useKelivoTheme, type KelivoTheme } from '../../theme';

export interface TactileRowProps {
  icon?: React.ReactNode;
  label: string;
  detail?: string;
  detailNode?: React.ReactNode;
  interactive?: boolean;
  onPress?: () => void;
  children?: React.ReactNode;
  padding?: 'default' | 'compact';
  showChevron?: boolean;
}

export function TactileRow({
  icon,
  label,
  detail,
  detailNode,
  interactive = true,
  onPress,
  children,
  padding = 'default',
  showChevron = true,
}: TactileRowProps) {
  const theme = useKelivoTheme();
  const styles = getStyles(theme);
  const [pressed, setPressed] = useState(false);

  const handlePressIn = () => setPressed(true);
  const handlePressOut = () => setPressed(false);
  const handlePress = () => onPress?.();

  const vertical = padding === 'compact' ? 10 : 13;

  return (
    <AnimatedPressable
      accessibilityRole={interactive ? 'button' : undefined}
      onPress={interactive ? handlePress : undefined}
      onPressIn={interactive ? handlePressIn : undefined}
      onPressOut={interactive ? handlePressOut : undefined}
      haptic={interactive ? 'light' : 'none'}
      pressScale={0.995}
      pressOpacity={0.98}
      style={styles.pressable}
    >
      <View
        style={[
          styles.row,
          { paddingVertical: vertical },
          pressed && styles.rowPressed,
        ]}
      >
        {icon ? <View style={styles.iconSlot}>{icon}</View> : null}
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
        {children}
        {detailNode}
        {detail ? (
          <Text style={styles.detail} numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
        {interactive && showChevron ? (
          <ChevronRight size={18} color={theme.colors.textTertiary} strokeWidth={2} />
        ) : null}
      </View>
    </AnimatedPressable>
  );
}

export interface SectionHeaderProps {
  title: string;
  first?: boolean;
}

export function SectionHeader({ title, first }: SectionHeaderProps) {
  const theme = useKelivoTheme();
  const styles = getStyles(theme);

  return (
    <View style={[styles.header, first && styles.headerFirst]}>
      <Text style={styles.headerText}>{title}</Text>
    </View>
  );
}

export function SectionCard({ children }: { children: React.ReactNode }) {
  const theme = useKelivoTheme();
  const styles = getStyles(theme);

  return (
    <View style={styles.card}>
      {children}
    </View>
  );
}

export function RowDivider() {
  const theme = useKelivoTheme();
  const styles = getStyles(theme);
  return <View style={styles.divider} />;
}

function createStyles(theme: KelivoTheme) {
  return StyleSheet.create({
  pressable: {
    width: '100%',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    gap: 12,
    minHeight: 44,
  },
  rowPressed: {
    backgroundColor: theme.colors.surfacePressed,
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
  detail: {
    fontSize: 13,
    color: theme.colors.textTertiary,
    marginRight: 4,
  },
  header: {
    paddingHorizontal: 12,
    paddingTop: 18,
    paddingBottom: 6,
  },
  headerFirst: {
    paddingTop: 2,
  },
  headerText: {
    fontSize: 13,
    color: theme.colors.textSecondary,
    fontWeight: '600',
  },
  card: {
    backgroundColor: theme.colors.card,
    borderRadius: 12,
    borderWidth: 0.6,
    borderColor: theme.colors.outlineVariant,
    overflow: 'hidden',
    marginHorizontal: 12,
    ...theme.shadows.soft,
  },
  divider: {
    height: 0.6,
    backgroundColor: theme.colors.divider,
    marginLeft: 48,
    marginRight: 12,
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
