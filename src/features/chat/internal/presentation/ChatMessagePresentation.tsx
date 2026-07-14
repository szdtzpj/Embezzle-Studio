import { useState } from 'react';
import {
  Image,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  BookOpen,
  Brain,
  Check,
  Copy,
  FileText,
  GitBranch,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Share2,
  Trash2,
  Wrench,
  X,
} from 'lucide-react-native';

import type {
  ChatTokenUsage,
  GenerationTaskInfo,
  McpActivitySummary,
  MessageRole,
  WebCitation,
} from '../../../../domain/types';
import { ModelAvatar } from '../../../../ui/components/ModelAvatar';
import { useChatMessagePresentationTheme } from './ChatMessagePresentationStyles';
import { AnimatedPressable, IconCrossfade } from './ChatMotion';
function formatTokenCount(value?: number) {
  return typeof value === 'number' ? value.toLocaleString() : '-';
}


function formatMessageTime(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(timestamp));
}


function displayProviderName(providerName?: string) {
  const name = providerName?.trim();
  if (!name) {
    return 'Provider';
  }

  const text = name.toLowerCase();
  if (text.includes('new api')) {
    return 'New API';
  }
  if (text.includes('volc') || text.includes('ark')) {
    return 'Volcengine Ark';
  }
  if (text.includes('bailian') || text.includes('dashscope')) {
    return 'Bailian';
  }

  return name;
}


function capitalizeFirstSegment(value: string) {
  return value.replace(/^[a-z]/, (char) => char.toUpperCase());
}


function truncateModelLabel(value: string, maxLength = 18) {
  return value.length > maxLength ? `${value.slice(0, Math.max(1, maxLength - 3))}...` : value;
}


export function formatCompactModelName(modelId?: string, _providerName?: string, maxLength = 18) {
  const raw = (modelId ?? '').trim();
  if (!raw) {
    return 'Model';
  }

  const lower = raw.toLowerCase();
  let compact = raw;

  if (lower.length > maxLength && lower.startsWith('doubao-')) {
    compact = raw.slice('doubao-'.length);
  }

  compact = compact.replace(/[-_.]\d{6,8}$/u, '');

  return truncateModelLabel(capitalizeFirstSegment(compact), maxLength);
}


export function AssistantMessageHeader({
  modelId,
  providerName,
  createdAt,
}: {
  modelId: string;
  providerName: string;
  createdAt: number;
}) {
  const { styles } = useChatMessagePresentationTheme();
  return (
    <View style={styles.assistantMetaRow}>
      <ModelAvatar modelId={modelId} providerName={providerName} />
      <Text numberOfLines={1} style={styles.assistantModelName}>
        {modelId ? formatCompactModelName(modelId, providerName) : '模型'}
      </Text>
      <Text style={styles.assistantMetaDivider}>|</Text>
      <Text numberOfLines={1} style={styles.assistantProviderName}>
        {displayProviderName(providerName)}
      </Text>
      <Text style={styles.assistantTime}>{formatMessageTime(createdAt)}</Text>
    </View>
  );
}


export function MessageActions({
  role,
  copied,
  onCopy,
  onRetry,
  onEdit,
  onShare,
  onMore,
}: {
  role: MessageRole;
  copied?: boolean;
  onCopy: () => void;
  onRetry: () => void;
  onEdit: () => void;
  onShare: () => void;
  onMore: () => void;
}) {
  const { palette, styles } = useChatMessagePresentationTheme();
  return (
    <View style={[styles.messageActions, role === 'user' && styles.userMessageActions]}>
      <AnimatedPressable
        accessibilityRole="button"
        accessibilityLabel={copied ? '已复制' : '复制'}
        onPress={onCopy}
        haptic="none"
        style={styles.messageActionButton}
      >
        <IconCrossfade swapKey={copied ? 'copied' : 'copy'}>
          {copied ? (
            <Check size={16} color={palette.accentText} strokeWidth={2.6} />
          ) : (
            <Copy size={16} color={palette.textSecondary} strokeWidth={2} />
          )}
        </IconCrossfade>
      </AnimatedPressable>
      <AnimatedPressable accessibilityRole="button" accessibilityLabel="重新生成" onPress={onRetry} style={styles.messageActionButton}>
        <RefreshCw size={16} color={palette.textSecondary} strokeWidth={2} />
      </AnimatedPressable>
      {role === 'assistant' ? (
        <AnimatedPressable accessibilityRole="button" accessibilityLabel="分享消息" onPress={onShare} style={styles.messageActionButton}>
          <Share2 size={16} color={palette.textSecondary} strokeWidth={2} />
        </AnimatedPressable>
      ) : (
        <AnimatedPressable accessibilityRole="button" accessibilityLabel="编辑消息" onPress={onEdit} style={styles.messageActionButton}>
          <Pencil size={16} color={palette.textSecondary} strokeWidth={2} />
        </AnimatedPressable>
      )}
      <AnimatedPressable accessibilityRole="button" accessibilityLabel="更多消息操作" onPress={onMore} style={styles.messageActionButton}>
        <MoreHorizontal size={16} color={palette.textSecondary} strokeWidth={2} />
      </AnimatedPressable>
    </View>
  );
}


export function MessageInlineEditor({
  role,
  value,
  placeholder,
  primaryLabel,
  disabled,
  onChange,
  onCancel,
  onSave,
}: {
  role: MessageRole;
  value: string;
  placeholder: string;
  primaryLabel: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { palette, styles } = useChatMessagePresentationTheme();
  return (
    <View style={styles.messageInlineEditor}>
      <TextInput
        value={value}
        onChangeText={onChange}
        multiline
        autoFocus
        placeholder={placeholder}
        placeholderTextColor={palette.placeholder}
        style={[
          styles.messageInlineEditInput,
          role === 'user' ? styles.userInlineEditInput : styles.assistantInlineEditInput,
        ]}
      />
      <View style={styles.inlineEditActions}>
        <AnimatedPressable
          accessibilityRole="button"
          onPress={onCancel}
          style={styles.inlineEditSecondaryButton}
        >
          <Text style={styles.inlineEditSecondaryText}>取消</Text>
        </AnimatedPressable>
        <AnimatedPressable
          accessibilityRole="button"
          disabled={disabled}
          onPress={onSave}
          style={[styles.inlineEditPrimaryButton, disabled && styles.buttonDisabled]}
        >
          <Text style={styles.inlineEditPrimaryText}>{primaryLabel}</Text>
        </AnimatedPressable>
      </View>
    </View>
  );
}


export function MessageActionMenu({
  role,
  canSave,
  onEdit,
  onSaveArtifact,
  onSaveKnowledge,
  onBranch,
  onDelete,
}: {
  role: MessageRole;
  canSave: boolean;
  onEdit: () => void;
  onSaveArtifact: () => void;
  onSaveKnowledge: () => void;
  onBranch: () => void;
  onDelete: () => void;
}) {
  const { palette, styles } = useChatMessagePresentationTheme();
  return (
    <View style={[styles.messageActionMenu, role === 'user' && styles.userMessageActionMenu]}>
      {role === 'user' ? (
        <AnimatedPressable accessibilityRole="button" onPress={onEdit} style={styles.messageActionMenuRow}>
          <Text style={styles.messageActionMenuText}>编辑消息</Text>
          <Pencil size={15} color={palette.textSecondary} strokeWidth={2.2} />
        </AnimatedPressable>
      ) : null}
      {canSave ? (
        <>
          <AnimatedPressable accessibilityRole="button" onPress={onSaveArtifact} style={styles.messageActionMenuRow}>
            <Text style={styles.messageActionMenuText}>保存为成果</Text>
            <FileText size={15} color={palette.textSecondary} strokeWidth={2.2} />
          </AnimatedPressable>
          <AnimatedPressable accessibilityRole="button" onPress={onSaveKnowledge} style={styles.messageActionMenuRow}>
            <Text style={styles.messageActionMenuText}>保存为项目资料</Text>
            <BookOpen size={15} color={palette.textSecondary} strokeWidth={2.2} />
          </AnimatedPressable>
        </>
      ) : null}
      <AnimatedPressable accessibilityRole="button" onPress={onBranch} style={styles.messageActionMenuRow}>
        <Text style={styles.messageActionMenuText}>从这里创建分支</Text>
        <GitBranch size={15} color={palette.textSecondary} strokeWidth={2.2} />
      </AnimatedPressable>
      <AnimatedPressable
        accessibilityRole="button"
        onPress={onDelete}
        haptic="warning"
        style={[styles.messageActionMenuRow, styles.messageActionMenuDangerRow]}
      >
        <Text style={[styles.messageActionMenuText, styles.messageActionMenuDangerText]}>删除消息</Text>
        <Trash2 size={15} color={palette.danger} strokeWidth={2.2} />
      </AnimatedPressable>
    </View>
  );
}


function hostnameFromUrl(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^www\./i, '');
  } catch {
    return raw;
  }
}


function faviconUriForUrl(raw: string): string | null {
  try {
    const host = new URL(raw).hostname;
    if (!host) return null;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
  } catch {
    return null;
  }
}


/**
 * Collapsed citation chip (e.g. "47个引用"); tap opens a bottom sheet of sources.
 * Matches kelivo-style search result UX from the product reference.
 */
export function WebCitationList({ citations }: { citations: WebCitation[] }) {
  const { palette, styles } = useChatMessagePresentationTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const [open, setOpen] = useState(false);
  const count = citations.length;
  const preview = citations.slice(0, 3);
  const sheetMaxH = Math.round(windowHeight * 0.78);

  if (!count) return null;

  return (
    <>
      <AnimatedPressable
        accessibilityRole="button"
        accessibilityLabel={`${count}个引用，点按查看搜索结果`}
        testID="web-citation-chip"
        onPress={() => setOpen(true)}
        haptic="selection"
        style={styles.webCitationChip}
      >
        <View style={styles.webCitationFaviconStack}>
          {preview.map((citation, index) => {
            const favicon = faviconUriForUrl(citation.url);
            return (
              <View
                key={`${citation.url}:chip:${index}`}
                style={[
                  styles.webCitationFaviconWrap,
                  {
                    marginLeft: index === 0 ? 0 : -7,
                    zIndex: preview.length - index,
                  },
                ]}
              >
                {favicon ? (
                  <Image source={{ uri: favicon }} style={styles.webCitationFavicon} />
                ) : (
                  <View style={[styles.webCitationFavicon, styles.webCitationFaviconFallback]}>
                    <Text style={styles.webCitationFaviconLetter}>
                      {(hostnameFromUrl(citation.url)[0] ?? '?').toUpperCase()}
                    </Text>
                  </View>
                )}
              </View>
            );
          })}
        </View>
        <Text style={styles.webCitationChipText}>{count}个引用</Text>
      </AnimatedPressable>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setOpen(false)}
      >
        <View style={styles.webCitationSheetScrim} testID="web-citation-sheet">
          <Pressable
            style={StyleSheet.absoluteFill}
            accessibilityRole="button"
            accessibilityLabel="关闭搜索结果"
            onPress={() => setOpen(false)}
          />
          <View
            style={[
              styles.webCitationSheet,
              {
                maxHeight: sheetMaxH,
                paddingBottom: Math.max(insets.bottom, 16) + 8,
              },
            ]}
          >
            <View style={styles.webCitationSheetHandle} />
            <View style={styles.webCitationSheetHeader}>
              <Text style={styles.webCitationSheetTitle}>搜索结果 {count}</Text>
              <AnimatedPressable
                accessibilityRole="button"
                accessibilityLabel="关闭"
                onPress={() => setOpen(false)}
                style={styles.webCitationSheetClose}
                hitSlop={8}
              >
                <X size={18} color={palette.textSecondary} strokeWidth={2.2} />
              </AnimatedPressable>
            </View>
            <ScrollView
              bounces
              showsVerticalScrollIndicator
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.webCitationSheetList}
            >
              {citations.map((citation, index) => {
                const host = hostnameFromUrl(citation.url);
                const favicon = faviconUriForUrl(citation.url);
                return (
                  <AnimatedPressable
                    key={`${citation.url}:sheet:${index}`}
                    accessibilityRole="link"
                    accessibilityLabel={`打开来源 ${citation.title ?? host}`}
                    onPress={() => {
                      void Linking.openURL(citation.url);
                    }}
                    style={styles.webCitationSheetRow}
                  >
                    <View style={styles.webCitationSheetRowTop}>
                      <View style={styles.webCitationSheetHostGroup}>
                        {favicon ? (
                          <Image source={{ uri: favicon }} style={styles.webCitationSheetFavicon} />
                        ) : (
                          <View
                            style={[
                              styles.webCitationSheetFavicon,
                              styles.webCitationFaviconFallback,
                            ]}
                          >
                            <Text style={styles.webCitationFaviconLetter}>
                              {(host[0] ?? '?').toUpperCase()}
                            </Text>
                          </View>
                        )}
                        <Text style={styles.webCitationSheetHost} numberOfLines={1}>
                          {host}
                        </Text>
                      </View>
                      <View style={styles.webCitationSheetIndex}>
                        <Text style={styles.webCitationSheetIndexText}>{index + 1}</Text>
                      </View>
                    </View>
                    <Text style={styles.webCitationSheetItemTitle} numberOfLines={2}>
                      {citation.title?.trim() || host}
                    </Text>
                    {citation.text?.trim() ? (
                      <Text style={styles.webCitationSheetSnippet} numberOfLines={3}>
                        {citation.text.trim()}
                      </Text>
                    ) : null}
                  </AnimatedPressable>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}


export function McpActivityPanel({ activity }: { activity: McpActivitySummary }) {
  const { palette, styles } = useChatMessagePresentationTheme();
  const hasUnknownOutcome = activity.calls.some((call) => call.outcome === 'unknown');
  return (
    <View style={styles.mcpActivityPanel} testID="mcp-activity-panel">
      <View style={styles.mcpActivityHeader}>
        <View style={styles.mcpActivityTitleGroup}>
          <Wrench size={14} color={palette.textSecondary} strokeWidth={2.2} />
          <Text style={styles.mcpActivityTitle}>MCP 工具记录</Text>
        </View>
        <Text style={styles.mcpActivityRequestCount}>
          {activity.providerRequestCount} 次发送前登记的请求尝试
        </Text>
      </View>
      <Text selectable style={styles.mcpActivityServer}>服务标签：{activity.serverLabel}</Text>
      {!activity.approvals.length && !activity.calls.length ? (
        <Text style={styles.mcpActivityEmpty}>本轮没有请求执行工具。</Text>
      ) : null}
      {activity.approvals.map((approval, index) => (
        <View key={`approval:${approval.toolName}:${index}`} style={styles.mcpActivityRow}>
          <Text selectable style={styles.mcpActivityTool}>{approval.toolName}</Text>
          <Text style={approval.decision === 'approve' ? styles.mcpActivityApproved : styles.mcpActivityDenied}>
            {approval.decision === 'approve' ? '已批准一次' : '已拒绝'}
          </Text>
        </View>
      ))}
      {activity.calls.map((call, index) => (
        <View key={`call:${call.toolName}:${index}`} style={styles.mcpActivityRow}>
          <Text selectable style={styles.mcpActivityTool}>{call.toolName}</Text>
          <Text
            style={
              call.outcome === 'completed'
                ? styles.mcpActivityApproved
                : call.outcome === 'failed'
                  ? styles.mcpActivityDenied
                  : styles.mcpActivityUnknown
            }
          >
            {call.outcome === 'completed'
              ? '执行完成'
              : call.outcome === 'failed'
                ? '执行失败'
                : '结果不确定'}
          </Text>
        </View>
      ))}
      {hasUnknownOutcome ? (
        <Text style={styles.mcpActivityWarning}>
          请求在批准后中断；外部副作用可能已经发生，本应用无法确认或撤销。
        </Text>
      ) : null}
    </View>
  );
}


export function TokenUsageLine({ usage }: { usage: ChatTokenUsage }) {
  const { palette, styles } = useChatMessagePresentationTheme();
  const total =
    usage.totalTokens ??
    [usage.inputTokens, usage.outputTokens, usage.reasoningTokens]
      .filter((value): value is number => typeof value === 'number')
      .reduce((sum, value) => sum + value, 0);

  return (
    <View style={styles.tokenUsageRow}>
      <Text style={styles.tokenUsageText}>↑ {formatTokenCount(usage.inputTokens)}</Text>
      <Text style={styles.tokenUsageText}>↓ {formatTokenCount(usage.outputTokens)}</Text>
      {typeof usage.reasoningTokens === 'number' ? (
        <View style={styles.tokenUsageItem}>
          <Brain size={12} color={palette.textSecondary} strokeWidth={2} />
          <Text style={styles.tokenUsageText}>{formatTokenCount(usage.reasoningTokens)}</Text>
        </View>
      ) : null}
      <Text style={styles.tokenUsageText}>Σ{formatTokenCount(total || undefined)}</Text>
    </View>
  );
}


export function GenerationTaskPanel({
  task,
  busy,
  onRefresh,
}: {
  task: GenerationTaskInfo;
  busy: boolean;
  onRefresh: () => void;
}) {
  const { styles } = useChatMessagePresentationTheme();
  return (
    <View style={styles.generationTaskPanel}>
      <View style={styles.generationTaskInfo}>
        <Text style={styles.generationTaskTitle}>视频生成任务</Text>
        <Text numberOfLines={1} style={styles.generationTaskMeta}>
          {task.taskId}
        </Text>
        <Text style={styles.generationTaskStatus}>状态：{task.status ?? 'submitted'}</Text>
      </View>
      <AnimatedPressable
        accessibilityRole="button"
        disabled={busy}
        onPress={onRefresh}
        style={[styles.generationTaskButton, busy && styles.buttonDisabled]}
      >
        <Text style={styles.generationTaskButtonText}>{busy ? '查询中' : '查询结果'}</Text>
      </AnimatedPressable>
    </View>
  );
}
