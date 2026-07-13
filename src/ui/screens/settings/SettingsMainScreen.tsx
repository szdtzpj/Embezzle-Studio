import { useLayoutEffect, useRef } from 'react';
import {
  ArrowLeft,
  SunMoon,
  Boxes,
  BadgeInfo,
  Folder,
  Columns3,
  BookOpen,
  Video,
  Globe2,
  Wrench,
  Mic,
  ShieldCheck,
  ChartColumn,
  Download,
} from 'lucide-react-native';
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { MotionItem } from '../../components/Motion';
import { SectionHeader, SectionCard, TactileRow, RowDivider } from '../../components/settings/SettingsList';
import { useKelivoTheme, type KelivoTheme } from '../../theme';
import type { ProviderProfile } from '../../../domain/types';
import type { SettingsToolsSection } from './toolsSections';

export interface SettingsMainScreenProps {
  colorMode: 'system' | 'light' | 'dark';
  activeProvider: ProviderProfile;
  /** Restored when this screen remounts after a sub-page pop. */
  scrollOffsetY?: number;
  onScrollOffsetChange?: (offsetY: number) => void;
  onBack: () => void;
  onColorMode: () => void;
  onProviders: () => void;
  onToolsSection: (section: SettingsToolsSection) => void;
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
  scrollOffsetY = 0,
  onScrollOffsetChange,
  onBack,
  onColorMode,
  onProviders,
  onToolsSection,
  onAbout,
}: SettingsMainScreenProps) {
  const theme = useKelivoTheme();
  const styles = getStyles(theme);
  const iconColor = theme.colors.text;
  const scrollRef = useRef<ScrollView>(null);
  const restoreYRef = useRef(scrollOffsetY);
  const didRestoreRef = useRef(false);

  useLayoutEffect(() => {
    const y = restoreYRef.current;
    if (y <= 0 || didRestoreRef.current) {
      return;
    }
    // Wait one frame so content height is ready after remount.
    const frame = requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ y, animated: false });
      didRestoreRef.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    onScrollOffsetChange?.(event.nativeEvent.contentOffset.y);
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <AnimatedPressable accessibilityRole="button" onPress={onBack} style={styles.headerButton}>
          <ArrowLeft size={22} color={theme.colors.text} strokeWidth={2.2} />
        </AnimatedPressable>
        <Text style={styles.headerTitle}>设置</Text>
        <View style={styles.headerButton} />
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={16}
        onScroll={handleScroll}
      >
        <MotionItem index={0}>
          <SectionHeader title="通用设置" first />
          <SectionCard>
            <TactileRow
              icon={<SunMoon size={20} color={iconColor} strokeWidth={2} />}
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
              icon={<Boxes size={20} color={iconColor} strokeWidth={2} />}
              label="供应商"
              detail={activeProvider.name}
              onPress={onProviders}
            />
            <RowDivider />
            <TactileRow
              icon={<Globe2 size={20} color={iconColor} strokeWidth={2} />}
              label="搜索服务"
              onPress={() => onToolsSection('webSearch')}
            />
            <RowDivider />
            <TactileRow
              icon={<Wrench size={20} color={iconColor} strokeWidth={2} />}
              label="MCP 工具"
              onPress={() => onToolsSection('mcp')}
            />
            <RowDivider />
            <TactileRow
              icon={<Mic size={20} color={iconColor} strokeWidth={2} />}
              label="语音"
              onPress={() => onToolsSection('voice')}
            />
          </SectionCard>
        </MotionItem>

        <MotionItem index={2}>
          <SectionHeader title="工作区" />
          <SectionCard>
            <TactileRow
              icon={<Folder size={20} color={iconColor} strokeWidth={2} />}
              label="项目工作台"
              onPress={() => onToolsSection('workspace')}
            />
            <RowDivider />
            <TactileRow
              icon={<Columns3 size={20} color={iconColor} strokeWidth={2} />}
              label="多模型对比"
              onPress={() => onToolsSection('comparison')}
            />
            <RowDivider />
            <TactileRow
              icon={<BookOpen size={20} color={iconColor} strokeWidth={2} />}
              label="提示词与角色模板"
              onPress={() => onToolsSection('prompts')}
            />
            <RowDivider />
            <TactileRow
              icon={<Video size={20} color={iconColor} strokeWidth={2} />}
              label="媒体任务中心"
              onPress={() => onToolsSection('media')}
            />
          </SectionCard>
        </MotionItem>

        <MotionItem index={3}>
          <SectionHeader title="用量与安全" />
          <SectionCard>
            <TactileRow
              icon={<ShieldCheck size={20} color={iconColor} strokeWidth={2} />}
              label="费用保险丝"
              onPress={() => onToolsSection('costGuard')}
            />
            <RowDivider />
            <TactileRow
              icon={<ChartColumn size={20} color={iconColor} strokeWidth={2} />}
              label="用量与费用"
              onPress={() => onToolsSection('usage')}
            />
            <RowDivider />
            <TactileRow
              icon={<Download size={20} color={iconColor} strokeWidth={2} />}
              label="本地加密备份"
              onPress={() => onToolsSection('backup')}
            />
          </SectionCard>
        </MotionItem>

        <MotionItem index={4}>
          <SectionHeader title="关于" />
          <SectionCard>
            <TactileRow
              icon={<BadgeInfo size={20} color={iconColor} strokeWidth={2} />}
              label="关于"
              onPress={onAbout}
            />
          </SectionCard>
        </MotionItem>
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
      paddingBottom: 32,
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
