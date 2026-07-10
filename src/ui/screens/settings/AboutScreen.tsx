import { ArrowLeft, Download, ExternalLink, RefreshCw } from 'lucide-react-native';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { MotionItem } from '../../components/Motion';
import { SectionCard, SectionHeader, TactileRow } from '../../components/settings/SettingsList';
import { appInfo } from '../../../data/appInfo';
import { useKelivoTheme, type KelivoTheme } from '../../theme';
import type { AppUpdateInfo } from '../../../services/updateChecker';

export interface AboutScreenProps {
  checkingUpdate: boolean;
  updateInfo: AppUpdateInfo | null;
  updateNotice: string;
  onBack: () => void;
  onCheckUpdates: () => void;
  onOpenUpdateTarget: (kind: 'release' | 'install') => void;
}

function updateStatusTitle(
  checkingUpdate: boolean,
  updateInfo: AppUpdateInfo | null,
  updateNotice: string,
) {
  if (checkingUpdate) return '正在检查更新';
  if (updateInfo && !updateInfo.installAsset) return '暂无可用的可信更新';
  if (updateInfo?.updateAvailable) return `可更新到 v${updateInfo.latestVersion}`;
  if (updateInfo?.installAsset) return `最新版本 v${updateInfo.latestVersion}`;
  if (updateNotice.includes('暂未找到')) return '暂无可用 Release';
  if (updateNotice) return '检查更新失败';
  return '尚未检查';
}

export function AboutScreen({
  checkingUpdate,
  updateInfo,
  updateNotice,
  onBack,
  onCheckUpdates,
  onOpenUpdateTarget,
}: AboutScreenProps) {
  const theme = useKelivoTheme();
  const styles = getStyles(theme);
  const repoUrl = `https://github.com/${appInfo.githubOwner}/${appInfo.githubRepo}`;
  const hasTrustedAsset = Boolean(updateInfo?.installAsset);
  const statusTitle = updateStatusTitle(checkingUpdate, updateInfo, updateNotice);

  const openRepo = async () => {
    try {
      const supported = await Linking.canOpenURL(repoUrl);
      if (supported) {
        await Linking.openURL(repoUrl);
      }
    } catch {
      // ignore
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <AnimatedPressable accessibilityRole="button" onPress={onBack} style={styles.headerButton}>
          <ArrowLeft size={22} color={theme.colors.text} strokeWidth={2.2} />
        </AnimatedPressable>
        <Text style={styles.headerTitle}>关于</Text>
        <View style={styles.headerButton} />
      </View>

      <ScrollView
        style={styles.content}
        contentContainerStyle={styles.contentContainer}
        showsVerticalScrollIndicator={false}
      >
        <MotionItem index={0}>
          <SectionHeader title="版本" first />
          <SectionCard>
            <TactileRow
              icon={<RefreshCw size={20} color={theme.colors.text} strokeWidth={2} />}
              label="检查更新"
              detail={checkingUpdate ? '检查中...' : `当前 v${appInfo.version}`}
              interactive={!checkingUpdate}
              onPress={onCheckUpdates}
              showChevron={false}
            />
          </SectionCard>
        </MotionItem>

        <MotionItem index={1}>
          <SectionHeader title="更新状态" />
          <SectionCard>
            <View style={styles.updateSummary}>
              <Text style={styles.updateTitle}>{statusTitle}</Text>
              {updateInfo ? (
                <Text style={styles.updateMeta}>
                  当前 v{updateInfo.currentVersion} · 最新 v{updateInfo.latestVersion}
                </Text>
              ) : updateNotice ? (
                <Text style={styles.updateNotice}>{updateNotice}</Text>
              ) : (
                <Text style={styles.updateMeta}>点击上方按钮从 GitHub Releases 获取最新版本。</Text>
              )}
              {updateInfo && updateNotice ? (
                <Text style={styles.updateMeta}>{updateNotice}</Text>
              ) : null}
            </View>

            {hasTrustedAsset ? (
              <>
                <View style={styles.divider} />
                <TactileRow
                  icon={<Download size={20} color={theme.colors.primary} strokeWidth={2} />}
                  label="查看可信更新"
                  detail={updateInfo?.installAsset?.name}
                  onPress={() => onOpenUpdateTarget('release')}
                />
                {updateInfo?.installAsset?.sha256 ? (
                  <Text numberOfLines={1} style={styles.assetDigest}>
                    SHA-256 {updateInfo.installAsset.sha256}
                  </Text>
                ) : null}
              </>
            ) : null}

            <View style={styles.divider} />
            <TactileRow
              icon={<ExternalLink size={20} color={theme.colors.text} strokeWidth={2} />}
              label="查看发布页"
              detail="Releases"
              onPress={() => onOpenUpdateTarget('release')}
            />
          </SectionCard>
        </MotionItem>

        <MotionItem index={2}>
          <SectionHeader title="源码" />
          <SectionCard>
            <TactileRow
              icon={<ExternalLink size={20} color={theme.colors.text} strokeWidth={2} />}
              label="GitHub"
              detail={appInfo.githubRepo}
              onPress={openRepo}
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
  content: {
    flex: 1,
  },
  contentContainer: {
    paddingTop: 10,
    paddingBottom: 24,
  },
  updateSummary: {
    paddingHorizontal: 12,
    paddingVertical: 13,
    gap: 4,
  },
  updateTitle: {
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: '600',
    lineHeight: 21,
  },
  updateMeta: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
  updateNotice: {
    color: theme.colors.warning,
    fontSize: 12,
    lineHeight: 17,
  },
  assetDigest: {
    marginLeft: 48,
    marginRight: 12,
    marginBottom: 10,
    color: theme.colors.textSecondary,
    fontSize: 11,
  },
    divider: {
      height: 0.6,
      marginLeft: 48,
      marginRight: 12,
      backgroundColor: theme.colors.divider,
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
