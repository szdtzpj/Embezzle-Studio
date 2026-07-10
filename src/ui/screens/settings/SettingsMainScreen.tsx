import { ArrowLeft, SunMoon, Boxes, BadgeInfo, Wrench } from 'lucide-react-native';
import { StyleSheet, Text, View } from 'react-native';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { MotionItem } from '../../components/Motion';
import { SectionHeader, SectionCard, TactileRow } from '../../components/settings/SettingsList';
import { useKelivoTheme, type KelivoTheme } from '../../theme';
import type { ProviderProfile } from '../../../domain/types';

export interface SettingsMainScreenProps {
  colorMode: 'system' | 'light' | 'dark';
  activeProvider: ProviderProfile;
  onBack: () => void;
  onColorMode: () => void;
  onProviders: () => void;
  onTools: () => void;
  onAbout: () => void;
}

function colorModeLabel(mode: 'system' | 'light' | 'dark') {
  switch (mode) {
    case 'light':
      return '浅色';
    case 'dark':
      return '深色';
    case 'system':
    default:
      return '跟随系统';
  }
}

export function SettingsMainScreen({
  colorMode,
  activeProvider,
  onBack,
  onColorMode,
  onProviders,
  onTools,
  onAbout,
}: SettingsMainScreenProps) {
  const theme = useKelivoTheme();
  const styles = getStyles(theme);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <AnimatedPressable accessibilityRole="button" onPress={onBack} style={styles.headerButton}>
          <ArrowLeft size={22} color={theme.colors.text} strokeWidth={2.2} />
        </AnimatedPressable>
        <Text style={styles.headerTitle}>设置</Text>
        <View style={styles.headerButton} />
      </View>

      <View style={styles.content}>
        <MotionItem index={0}>
          <SectionHeader title="通用设置" first />
          <SectionCard>
            <TactileRow
              icon={<SunMoon size={20} color={theme.colors.text} strokeWidth={2} />}
              label="颜色模式"
              detail={colorModeLabel(colorMode)}
              onPress={onColorMode}
            />
          </SectionCard>
        </MotionItem>

        <MotionItem index={1}>
          <SectionHeader title="模型与服务" />
          <SectionCard>
            <TactileRow
              icon={<Boxes size={20} color={theme.colors.text} strokeWidth={2} />}
              label="供应商"
              detail={activeProvider.name}
              onPress={onProviders}
            />
            <TactileRow
              icon={<Wrench size={20} color={theme.colors.text} strokeWidth={2} />}
              label="工作区与工具"
              detail="项目 / MCP / 备份等"
              onPress={onTools}
            />
          </SectionCard>
        </MotionItem>

        <MotionItem index={2}>
          <SectionHeader title="关于" />
          <SectionCard>
            <TactileRow
              icon={<BadgeInfo size={20} color={theme.colors.text} strokeWidth={2} />}
              label="关于"
              onPress={onAbout}
            />
          </SectionCard>
        </MotionItem>
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
      paddingBottom: 24,
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
