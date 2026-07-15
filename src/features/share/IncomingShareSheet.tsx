import {
  BookOpen,
  Check,
  File,
  FileText,
  Image as ImageIcon,
  Link2,
  LoaderCircle,
  MessageCircle,
  Music2,
  Share2,
  Video,
  X,
} from 'lucide-react-native';
import { useMemo, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { IncomingShareItem, IncomingShareSnapshot } from '../../services/incomingShare';
import { useKelivoTheme, type KelivoTheme } from '../../ui/theme';
import { AnimatedPressable } from '../../ui/components/AnimatedPressable';

export type IncomingShareDestination = 'conversation' | 'knowledge' | 'artifact';

export interface IncomingShareSheetProps {
  visible: boolean;
  snapshot: IncomingShareSnapshot;
  isResolving?: boolean;
  /** Destination currently being committed, if any. */
  busyDestination?: IncomingShareDestination | null;
  error?: string;
  onClose: () => void;
  /** Resolves content:// and remote share payloads after explicit confirmation. */
  onResolve?: () => void | Promise<void>;
  /** Commits the reviewed payload to the selected local destination. */
  onSelectDestination: (destination: IncomingShareDestination) => void | Promise<void>;
}

function formatBytes(size: number | undefined): string | undefined {
  if (size === undefined || !Number.isFinite(size) || size < 0) return undefined;
  if (size < 1024) return `${Math.round(size)} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function itemIcon(item: IncomingShareItem, color: string): ReactNode {
  if (item.kind === 'image') return <ImageIcon size={18} color={color} strokeWidth={2.1} />;
  if (item.kind === 'video') return <Video size={18} color={color} strokeWidth={2.1} />;
  if (item.kind === 'audio') return <Music2 size={18} color={color} strokeWidth={2.1} />;
  if (item.kind === 'url') return <Link2 size={18} color={color} strokeWidth={2.1} />;
  if (item.kind === 'text') return <FileText size={18} color={color} strokeWidth={2.1} />;
  return <File size={18} color={color} strokeWidth={2.1} />;
}

function itemLabel(item: IncomingShareItem): string {
  if (item.kind === 'url') return '链接';
  if (item.kind === 'text') return '文字';
  if (item.kind === 'image') return '图片';
  if (item.kind === 'video') return '视频';
  if (item.kind === 'audio') return '音频';
  return '文件';
}

function compactPreview(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized.length > 460 ? `${normalized.slice(0, 460)}…` : normalized;
}

function DestinationButton({
  destination,
  title,
  description,
  icon,
  disabled,
  onPress,
}: {
  destination: IncomingShareDestination;
  title: string;
  description: string;
  icon: ReactNode;
  disabled: boolean;
  onPress: () => void;
}) {
  const theme = useKelivoTheme();
  const styles = getStyles(theme);
  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={`分享内容：${title}`}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      haptic="light"
      style={[styles.destination, disabled && styles.disabled]}
      testID={`incoming-share-destination-${destination}`}
    >
      <View style={styles.destinationIcon}>{icon}</View>
      <View style={styles.destinationText}>
        <Text style={styles.destinationTitle}>{title}</Text>
        <Text numberOfLines={2} style={styles.destinationDescription}>
          {description}
        </Text>
      </View>
      {disabled ? (
        <ActivityIndicator size="small" color={theme.colors.primary} />
      ) : (
        <Check size={18} color={theme.colors.textTertiary} strokeWidth={2.1} />
      )}
    </AnimatedPressable>
  );
}

/**
 * Review-first native share intake surface. It intentionally does not send a
 * model request or fetch a URL while rendering; the parent decides when to
 * resolve native attachment streams and commits only after the user chooses a
 * destination. Shared URL captions remain opaque text.
 */
export function IncomingShareSheet({
  visible,
  snapshot,
  isResolving = false,
  busyDestination = null,
  error,
  onClose,
  onResolve,
  onSelectDestination,
}: IncomingShareSheetProps): React.ReactElement | null {
  const theme = useKelivoTheme();
  const styles = getStyles(theme);
  const insets = useSafeAreaInsets();
  const hasUnresolvedAttachment = useMemo(
    () => snapshot.attachments.some((item) => !item.resolved),
    [snapshot.attachments]
  );
  const previewItems = snapshot.items.slice(0, 12);
  const moreCount = Math.max(0, snapshot.items.length - previewItems.length);
  const textPreview = snapshot.text.length ? snapshot.text.join('\n\n') : '';
  const urlPreview = snapshot.urls.length ? snapshot.urls.join('\n') : '';
  const actionDisabled = isResolving || busyDestination !== null;
  const destinationDisabled = actionDisabled || hasUnresolvedAttachment;
  const textOnlyDestinationDisabled = destinationDisabled || snapshot.attachments.length > 0;

  if (!visible || snapshot.items.length === 0) return null;

  return (
    <Modal
      visible
      transparent
      statusBarTranslucent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.root}>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭分享预览" style={styles.scrim} onPress={onClose} />
        <View
          accessibilityViewIsModal
          style={[styles.sheet, { paddingBottom: Math.max(insets.bottom + 12, 24) }]}
        >
          <View style={styles.handle} />
          <View style={styles.header}>
            <View style={styles.headerIcon}>
              <Share2 size={20} color={theme.colors.primary} strokeWidth={2.2} />
            </View>
            <View style={styles.headerText}>
              <Text style={styles.title}>收到系统分享</Text>
              <Text style={styles.subtitle}>先确认内容，再选择保存位置；不会自动发送给模型。</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="关闭分享预览" onPress={onClose} style={styles.closeButton}>
              <X size={20} color={theme.colors.textSecondary} strokeWidth={2.2} />
            </Pressable>
          </View>

          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {textPreview ? (
              <View style={styles.previewCard}>
                <View style={styles.previewHeading}>
                  <FileText size={16} color={theme.colors.primary} strokeWidth={2.1} />
                  <Text style={styles.previewHeadingText}>文字预览</Text>
                </View>
                <Text style={styles.previewText}>{compactPreview(textPreview)}</Text>
              </View>
            ) : null}

            {urlPreview ? (
              <View style={styles.previewCard}>
                <View style={styles.previewHeading}>
                  <Link2 size={16} color={theme.colors.primary} strokeWidth={2.1} />
                  <Text style={styles.previewHeadingText}>链接预览</Text>
                </View>
                <Text selectable style={styles.urlText}>{compactPreview(urlPreview)}</Text>
              </View>
            ) : null}

            {snapshot.attachments.length ? (
              <View style={styles.previewCard}>
                <View style={styles.previewHeading}>
                  <File size={16} color={theme.colors.primary} strokeWidth={2.1} />
                  <Text style={styles.previewHeadingText}>附件（{snapshot.attachments.length}）</Text>
                </View>
                {previewItems
                  .filter((item) => ['image', 'video', 'audio', 'file'].includes(item.kind))
                  .map((item) => {
                    const size = formatBytes(item.size);
                    return (
                      <View key={item.id} style={styles.attachmentRow}>
                        {item.kind === 'image' && item.uri ? (
                          <Image source={{ uri: item.uri }} resizeMode="cover" style={styles.thumbnail as any} />
                        ) : (
                          <View style={styles.attachmentIcon}>{itemIcon(item, theme.colors.primary)}</View>
                        )}
                        <View style={styles.attachmentText}>
                          <Text numberOfLines={1} style={styles.attachmentName}>
                            {item.name || itemLabel(item)}
                          </Text>
                          <Text numberOfLines={1} style={styles.attachmentMeta}>
                            {[itemLabel(item), item.mimeType, size].filter(Boolean).join(' · ')}
                            {!item.resolved ? ' · 待解析' : ''}
                          </Text>
                        </View>
                      </View>
                    );
                  })}
                {moreCount ? <Text style={styles.moreText}>还有 {moreCount} 项未展开</Text> : null}
              </View>
            ) : null}

            {hasUnresolvedAttachment && onResolve ? (
              <AnimatedPressable
                accessibilityRole="button"
                accessibilityLabel="解析分享附件"
                disabled={actionDisabled}
                onPress={() => void onResolve()}
                haptic="light"
                style={[styles.resolveButton, actionDisabled && styles.disabled]}
                testID="incoming-share-resolve"
              >
                {isResolving ? (
                  <ActivityIndicator size="small" color={theme.colors.primary} />
                ) : (
                  <LoaderCircle size={17} color={theme.colors.primary} strokeWidth={2.1} />
                )}
                <Text style={styles.resolveText}>{isResolving ? '正在解析附件…' : '解析附件后再导入'}</Text>
              </AnimatedPressable>
            ) : null}

            {error ? <Text accessibilityLiveRegion="assertive" style={styles.error}>{error}</Text> : null}

            <Text style={styles.destinationHeading}>保存到哪里？</Text>
            <DestinationButton
              destination="conversation"
              title="当前对话"
              description="作为一条本地用户消息加入当前会话，不会自动触发模型请求。"
              icon={<MessageCircle size={19} color={theme.colors.primary} strokeWidth={2.1} />}
              disabled={destinationDisabled}
              onPress={() => void onSelectDestination('conversation')}
            />
            <DestinationButton
              destination="knowledge"
              title="项目资料"
              description="仅文字和链接可保存为当前项目资料；包含附件时请先放入当前对话。"
              icon={<BookOpen size={19} color={theme.colors.primary} strokeWidth={2.1} />}
              disabled={textOnlyDestinationDisabled || (!textPreview && !urlPreview)}
              onPress={() => void onSelectDestination('knowledge')}
            />
            <DestinationButton
              destination="artifact"
              title="成果工作台"
              description="仅文字和链接可保存为可编辑的 Markdown 成果；附件请先放入当前对话。"
              icon={<FileText size={19} color={theme.colors.primary} strokeWidth={2.1} />}
              disabled={textOnlyDestinationDisabled || (!textPreview && !urlPreview)}
              onPress={() => void onSelectDestination('artifact')}
            />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function createStyles(theme: KelivoTheme) {
  return StyleSheet.create({
    root: { flex: 1, justifyContent: 'flex-end' },
    scrim: {
      ...StyleSheet.absoluteFill,
      backgroundColor: theme.colors.scrim,
      ...(Platform.OS === 'web' ? ({ position: 'fixed', inset: 0 } as any) : {}),
    },
    sheet: {
      maxHeight: '92%',
      borderTopLeftRadius: 28,
      borderTopRightRadius: 28,
      borderWidth: 0.7,
      borderColor: theme.colors.outline,
      backgroundColor: theme.colors.card,
      ...theme.shadows.sheet,
    },
    handle: {
      alignSelf: 'center',
      width: 38,
      height: 4,
      marginTop: 10,
      borderRadius: 2,
      backgroundColor: theme.colors.outline,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingTop: 16,
      paddingBottom: 12,
      gap: 12,
    },
    headerIcon: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.primaryContainer,
    },
    headerText: { flex: 1, minWidth: 0 },
    title: { color: theme.colors.text, fontSize: 18, lineHeight: 24, fontWeight: '700' },
    subtitle: { marginTop: 3, color: theme.colors.textSecondary, fontSize: 12, lineHeight: 18 },
    closeButton: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.surfaceSunken,
    },
    body: { flexShrink: 1 },
    bodyContent: { paddingHorizontal: 20, paddingBottom: 8, gap: 10 },
    previewCard: {
      borderRadius: 16,
      borderWidth: 0.8,
      borderColor: theme.colors.outline,
      backgroundColor: theme.colors.surfaceSunken,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    previewHeading: { flexDirection: 'row', alignItems: 'center', gap: 7 },
    previewHeadingText: { color: theme.colors.text, fontSize: 13, fontWeight: '700' },
    previewText: { marginTop: 8, color: theme.colors.text, fontSize: 14, lineHeight: 21 },
    urlText: { marginTop: 8, color: theme.colors.primary, fontSize: 13, lineHeight: 19 },
    attachmentRow: { flexDirection: 'row', alignItems: 'center', minHeight: 48, marginTop: 9, gap: 10 },
    thumbnail: { width: 48, height: 48, borderRadius: 10, backgroundColor: theme.colors.surface },
    attachmentIcon: {
      width: 48,
      height: 48,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.primaryContainer,
    },
    attachmentText: { flex: 1, minWidth: 0 },
    attachmentName: { color: theme.colors.text, fontSize: 14, fontWeight: '600' },
    attachmentMeta: { marginTop: 3, color: theme.colors.textSecondary, fontSize: 11, lineHeight: 16 },
    moreText: { marginTop: 8, color: theme.colors.textSecondary, fontSize: 12 },
    resolveButton: {
      minHeight: 42,
      borderRadius: 12,
      borderWidth: 0.8,
      borderColor: theme.colors.primary,
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'row',
      gap: 8,
    },
    resolveText: { color: theme.colors.primary, fontSize: 13, fontWeight: '600' },
    error: { color: theme.colors.error, fontSize: 12, lineHeight: 18 },
    destinationHeading: { marginTop: 4, color: theme.colors.text, fontSize: 14, fontWeight: '700' },
    destination: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: 66,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: 16,
      borderWidth: 0.8,
      borderColor: theme.colors.outline,
      backgroundColor: theme.colors.surface,
      gap: 10,
    },
    destinationIcon: {
      width: 38,
      height: 38,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.primaryContainer,
    },
    destinationText: { flex: 1, minWidth: 0 },
    destinationTitle: { color: theme.colors.text, fontSize: 14, fontWeight: '700' },
    destinationDescription: { marginTop: 2, color: theme.colors.textSecondary, fontSize: 11, lineHeight: 16 },
    disabled: { opacity: 0.52 },
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
