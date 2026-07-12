import { AlertTriangle, BookOpen, Check, EyeOff, FileText, Pin, Search, Send, X } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ChatMessage, ProjectKnowledgeSource } from '../domain/types';
import type { RequestContextInspection } from '../services/contextInspector';

interface ContextInspectorModalProps {
  visible: boolean;
  inspection: RequestContextInspection;
  messages: readonly ChatMessage[];
  knowledgeSources: readonly ProjectKnowledgeSource[];
  selectedKnowledgeSourceIds: readonly string[];
  readOnly?: boolean;
  canSend?: boolean;
  onClose: () => void;
  onSend?: () => void;
  onRequestCompression?: () => void;
  onToggleMessageExcluded: (messageId: string) => void;
  onToggleMessagePinned: (messageId: string) => void;
  onToggleKnowledgeSource: (sourceId: string) => void;
}

const colors = {
  background: '#F4F4F4',
  surface: '#FFFFFF',
  surfaceAlt: '#EAEAEA',
  text: '#0D0D0D',
  secondary: '#6E6E6E',
  border: '#D9D9D9',
  accent: '#0D0D0D',
  warning: '#B45309',
  warningBackground: '#FFF7ED',
} as const;

const pendingComposerMessageId = 'context-inspector-pending-user';
const initialMessageRenderLimit = 200;
const messageRenderPageSize = 200;
const maxVisibleKnowledgeSources = 100;

function roleLabel(role: ChatMessage['role']): string {
  if (role === 'system') return '系统';
  if (role === 'user') return '用户';
  return '模型';
}

export function ContextInspectorModal({
  visible,
  inspection,
  messages,
  knowledgeSources,
  selectedKnowledgeSourceIds,
  readOnly = false,
  canSend = false,
  onClose,
  onSend,
  onRequestCompression,
  onToggleMessageExcluded,
  onToggleMessagePinned,
  onToggleKnowledgeSource,
}: ContextInspectorModalProps) {
  const insets = useSafeAreaInsets();
  const [messageRenderLimit, setMessageRenderLimit] = useState(initialMessageRenderLimit);
  const [knowledgeQuery, setKnowledgeQuery] = useState('');
  const included = new Set(inspection.includedMessageIds);
  const excluded = new Set(inspection.excludedMessageIds);
  const trimmed = new Set(inspection.trimmedMessageIds);
  const pinned = new Set(inspection.pinnedMessageIds);
  const selectedKnowledge = useMemo(
    () => new Set(selectedKnowledgeSourceIds),
    [selectedKnowledgeSourceIds]
  );
  const includedKnowledge = useMemo(
    () => new Set(inspection.includedKnowledgeSourceIds),
    [inspection.includedKnowledgeSourceIds]
  );
  const missingKnowledge = useMemo(
    () => new Set(inspection.missingKnowledgeSourceIds),
    [inspection.missingKnowledgeSourceIds]
  );
  const omittedKnowledge = useMemo(
    () => new Set(inspection.omittedKnowledgeSourceIds),
    [inspection.omittedKnowledgeSourceIds]
  );
  const allInspectableMessages = useMemo(
    () => messages.filter(
      (message) => message.id !== 'welcome' && message.status === 'ready'
    ),
    [messages]
  );
  const inspectableMessages = useMemo(() => {
    const recent = allInspectableMessages.slice(-messageRenderLimit);
    const leadingSystems = allInspectableMessages
      .filter((message) => message.role === 'system')
      .slice(0, 20);
    const visibleIds = new Set([...leadingSystems, ...recent].map((message) => message.id));
    return allInspectableMessages.filter((message) => visibleIds.has(message.id));
  }, [allInspectableMessages, messageRenderLimit]);
  const visibleKnowledgeSources = useMemo(() => {
    const query = knowledgeQuery.normalize('NFKC').trim().toLowerCase();
    return [...knowledgeSources]
      .sort((left, right) =>
        Number(selectedKnowledge.has(right.id)) - Number(selectedKnowledge.has(left.id)) ||
        right.updatedAt - left.updatedAt ||
        left.id.localeCompare(right.id)
      )
      .filter((source) => !query ||
        `${source.title} ${source.fileName ?? ''}`.normalize('NFKC').toLowerCase().includes(query)
      )
      .slice(0, maxVisibleKnowledgeSources);
  }, [knowledgeQuery, knowledgeSources, selectedKnowledge]);

  useEffect(() => {
    if (!visible) return;
    setMessageRenderLimit(initialMessageRenderLimit);
    setKnowledgeQuery('');
  }, [visible]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.root}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.title}>本次请求上下文</Text>
            <Text style={styles.subtitle}>完全在本机预览；关闭不会发送任何请求</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="关闭上下文预览" onPress={onClose} style={styles.iconButton}>
            <X size={20} color={colors.text} strokeWidth={2.2} />
          </Pressable>
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.content, { paddingBottom: Math.max(24, insets.bottom + 16) }]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.summaryCard} testID="context-inspector-summary">
            <View style={styles.summaryRow}>
              <View style={styles.metric}>
                <Text style={styles.metricValue}>≈ {inspection.estimatedInputTokens}</Text>
                <Text style={styles.metricLabel}>文本 Token</Text>
              </View>
              <View style={styles.metric}>
                <Text style={styles.metricValue}>{inspection.includedMessageIds.length}</Text>
                <Text style={styles.metricLabel}>消息</Text>
              </View>
              <View style={styles.metric}>
                <Text style={styles.metricValue}>{selectedKnowledge.size}</Text>
                <Text style={styles.metricLabel}>资料</Text>
              </View>
            </View>
            <Text style={styles.disclaimer}>
              Token 为本机保守估算，不是服务商计费数据；图片、文件和服务商封装可能产生额外 Token。
            </Text>
            {inspection.exceedsRecommendedContextBudget ? (
              <View style={styles.warningRow}>
                <AlertTriangle size={16} color={colors.warning} strokeWidth={2.2} />
                <Text style={styles.warningText}>估算内容已超过模型上下文的 80%，建议排除或精简资料。</Text>
              </View>
            ) : null}
            {inspection.exceedsContextWindow ? (
              <View style={styles.warningRow}>
                <AlertTriangle size={16} color={colors.warning} strokeWidth={2.2} />
                <Text style={styles.warningText}>文本上下文已超过安全发送上限；发送已禁用，请先排除消息或减少资料。</Text>
              </View>
            ) : null}
            {inspection.unknownAttachmentTokenCount ? (
              <View style={styles.warningRow}>
                <AlertTriangle size={16} color={colors.warning} strokeWidth={2.2} />
                <Text style={styles.warningText}>
                  {inspection.unknownAttachmentTokenCount} 个附件的 Token 无法在本机可靠估算；剩余上下文窗口标记为不确定。
                </Text>
              </View>
            ) : null}
            {inspection.knowledgeTruncated || inspection.omittedKnowledgeSourceIds.length || inspection.missingKnowledgeSourceIds.length ? (
              <View style={styles.warningRow}>
                <AlertTriangle size={16} color={colors.warning} strokeWidth={2.2} />
                <Text style={styles.warningText}>
                  项目资料受 30,000 字符上限约束；{inspection.omittedKnowledgeSourceIds.length} 条省略，{inspection.missingKnowledgeSourceIds.length} 条引用失效。
                </Text>
              </View>
            ) : null}
            {onRequestCompression ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="生成上下文压缩提示草稿，不会自动发送"
                disabled={readOnly}
                onPress={onRequestCompression}
                style={[styles.compressionButton, readOnly && styles.disabled]}
              >
                <FileText size={15} color={colors.text} strokeWidth={2.1} />
                <View style={styles.compressionText}>
                  <Text style={styles.compressionTitle}>生成压缩提示草稿</Text>
                  <Text style={styles.compressionMeta}>只写入输入框；再次点发送才会调用你的服务商</Text>
                </View>
              </Pressable>
            ) : null}
          </View>

          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>对话消息</Text>
            <Text style={styles.sectionMeta}>
              显示 {inspectableMessages.length} / {allInspectableMessages.length} · 置顶保留整轮 · 排除用户消息会排除其回答
            </Text>
          </View>
          {inspectableMessages.map((message) => {
            const isIncluded = included.has(message.id);
            const isExcluded = excluded.has(message.id);
            const isTrimmed = trimmed.has(message.id);
            const isPinned = pinned.has(message.id);
            const isPendingComposerMessage = message.id === pendingComposerMessageId;
            return (
              <View key={message.id} style={[styles.itemCard, isExcluded && styles.itemCardMuted]}>
                <View style={styles.itemHeader}>
                  <Text style={styles.itemTitle}>
                    {isPendingComposerMessage ? '即将发送' : roleLabel(message.role)}
                  </Text>
                  <View style={styles.badgeRow}>
                    {isPendingComposerMessage ? <Text style={styles.activeBadge}>输入框草稿</Text> : null}
                    {isPinned ? <Text style={styles.activeBadge}>已置顶</Text> : null}
                    <Text style={isIncluded ? styles.activeBadge : styles.mutedBadge}>
                      {isIncluded ? '会发送' : isExcluded ? '已排除' : isTrimmed ? '被裁剪' : '不发送'}
                    </Text>
                  </View>
                </View>
                <Text numberOfLines={4} style={styles.itemSnippet}>
                  {message.content.trim() || `[${message.attachments?.length ?? 0} 个附件]`}
                </Text>
                <View style={styles.itemActions}>
                  <Pressable
                    accessibilityRole="button"
                    disabled={readOnly || isPendingComposerMessage}
                    onPress={() => onToggleMessagePinned(message.id)}
                    style={[
                      styles.smallButton,
                      isPinned && styles.smallButtonActive,
                      (readOnly || isPendingComposerMessage) && styles.disabled,
                    ]}
                  >
                    <Pin size={14} color={isPinned ? '#FFFFFF' : colors.secondary} strokeWidth={2.2} />
                    <Text style={[styles.smallButtonText, isPinned && styles.smallButtonTextActive]}>置顶</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    disabled={readOnly || isPendingComposerMessage}
                    onPress={() => onToggleMessageExcluded(message.id)}
                    style={[
                      styles.smallButton,
                      isExcluded && styles.smallButtonActive,
                      (readOnly || isPendingComposerMessage) && styles.disabled,
                    ]}
                  >
                    <EyeOff size={14} color={isExcluded ? '#FFFFFF' : colors.secondary} strokeWidth={2.2} />
                    <Text style={[styles.smallButtonText, isExcluded && styles.smallButtonTextActive]}>
                      {isExcluded ? '恢复' : '排除'}
                    </Text>
                  </Pressable>
                </View>
              </View>
            );
          })}
          {inspectableMessages.length < allInspectableMessages.length ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setMessageRenderLimit((current) => current + messageRenderPageSize)}
              style={styles.loadMoreButton}
            >
              <Text style={styles.loadMoreText}>再显示较早的 {messageRenderPageSize} 条消息</Text>
            </Pressable>
          ) : null}

          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>项目资料</Text>
            <Text style={styles.sectionMeta}>
              已选 {selectedKnowledge.size} · 实际纳入 {includedKnowledge.size} · 只有明确勾选的文本才可能进入请求
            </Text>
          </View>
          {knowledgeSources.length ? (
            <View style={styles.searchBox}>
              <Search size={15} color={colors.secondary} strokeWidth={2} />
              <TextInput
                value={knowledgeQuery}
                onChangeText={setKnowledgeQuery}
                placeholder="按资料名称搜索（最多显示 100 条）"
                placeholderTextColor={colors.secondary}
                style={styles.searchInput}
              />
            </View>
          ) : null}
          {visibleKnowledgeSources.length ? visibleKnowledgeSources.map((source) => {
            const selected = selectedKnowledge.has(source.id);
            const actuallyIncluded = includedKnowledge.has(source.id);
            const missing = missingKnowledge.has(source.id);
            const omitted = omittedKnowledge.has(source.id);
            return (
              <Pressable
                key={source.id}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: selected, disabled: readOnly }}
                disabled={readOnly}
                onPress={() => onToggleKnowledgeSource(source.id)}
                style={[styles.knowledgeRow, selected && styles.knowledgeRowSelected, readOnly && styles.disabled]}
              >
                <View style={[styles.checkBox, selected && styles.checkBoxSelected]}>
                  {selected ? <Check size={13} color="#FFFFFF" strokeWidth={2.8} /> : null}
                </View>
                <BookOpen size={16} color={colors.secondary} strokeWidth={2} />
                <View style={styles.knowledgeText}>
                  <Text numberOfLines={1} style={styles.knowledgeTitle}>{source.title}</Text>
                  <Text style={styles.knowledgeMeta}>
                    {source.kind} · {source.content.length} 字符 · {
                      !selected ? '未选择' : actuallyIncluded ? '本次会发送' : missing ? '引用失效' : omitted ? '因上限省略' : '未纳入'
                    }
                  </Text>
                </View>
              </Pressable>
            );
          }) : (
            <Text style={styles.empty}>当前项目还没有本地文本资料。</Text>
          )}
        </ScrollView>

        <View style={[styles.footer, { paddingBottom: Math.max(12, insets.bottom) }]}>
          <Pressable accessibilityRole="button" onPress={onClose} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>返回编辑</Text>
          </Pressable>
          {onSend ? (
            <Pressable
              accessibilityRole="button"
              disabled={!canSend || readOnly}
              onPress={onSend}
              style={[styles.primaryButton, (!canSend || readOnly) && styles.disabled]}
            >
              <Send size={16} color="#FFFFFF" strokeWidth={2.2} />
              <Text style={styles.primaryButtonText}>按此上下文发送</Text>
            </Pressable>
          ) : null}
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: { minHeight: 64, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  headerText: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: 19, fontWeight: '700' },
  subtitle: { color: colors.secondary, fontSize: 12 },
  iconButton: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceAlt },
  scroll: { flex: 1 },
  content: { padding: 16, gap: 10 },
  summaryCard: { padding: 16, borderRadius: 18, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, gap: 10 },
  summaryRow: { flexDirection: 'row', gap: 8 },
  metric: { flex: 1, padding: 10, borderRadius: 12, backgroundColor: colors.surfaceAlt },
  metricValue: { color: colors.text, fontSize: 17, fontWeight: '700' },
  metricLabel: { color: colors.secondary, fontSize: 11, marginTop: 2 },
  disclaimer: { color: colors.secondary, fontSize: 12, lineHeight: 18 },
  warningRow: { flexDirection: 'row', gap: 8, padding: 10, borderRadius: 12, backgroundColor: colors.warningBackground },
  warningText: { flex: 1, color: colors.warning, fontSize: 12, lineHeight: 18 },
  compressionButton: { minHeight: 52, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 12, backgroundColor: colors.surfaceAlt, flexDirection: 'row', alignItems: 'center', gap: 9 },
  compressionText: { flex: 1, gap: 1 },
  compressionTitle: { color: colors.text, fontSize: 12, fontWeight: '700' },
  compressionMeta: { color: colors.secondary, fontSize: 10, lineHeight: 15 },
  sectionHeader: { marginTop: 10, gap: 2 },
  sectionTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  sectionMeta: { color: colors.secondary, fontSize: 11 },
  itemCard: { padding: 14, borderRadius: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, gap: 8 },
  itemCardMuted: { opacity: 0.72 },
  itemHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  itemTitle: { color: colors.text, fontSize: 13, fontWeight: '700' },
  badgeRow: { flexDirection: 'row', gap: 5 },
  activeBadge: { color: colors.text, backgroundColor: colors.surfaceAlt, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 999, fontSize: 10, overflow: 'hidden' },
  mutedBadge: { color: colors.secondary, fontSize: 10 },
  itemSnippet: { color: colors.text, fontSize: 13, lineHeight: 19 },
  itemActions: { flexDirection: 'row', gap: 8 },
  smallButton: { minHeight: 32, paddingHorizontal: 10, borderRadius: 10, backgroundColor: colors.surfaceAlt, flexDirection: 'row', alignItems: 'center', gap: 5 },
  smallButtonActive: { backgroundColor: colors.accent },
  smallButtonText: { color: colors.secondary, fontSize: 12, fontWeight: '600' },
  smallButtonTextActive: { color: '#FFFFFF' },
  knowledgeRow: { minHeight: 56, padding: 12, borderRadius: 14, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, flexDirection: 'row', alignItems: 'center', gap: 9 },
  knowledgeRowSelected: { borderColor: colors.accent },
  checkBox: { width: 20, height: 20, borderRadius: 6, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  checkBoxSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
  knowledgeText: { flex: 1 },
  knowledgeTitle: { color: colors.text, fontSize: 13, fontWeight: '600' },
  knowledgeMeta: { color: colors.secondary, fontSize: 11, marginTop: 2 },
  searchBox: { minHeight: 42, paddingHorizontal: 11, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, flexDirection: 'row', alignItems: 'center', gap: 7 },
  searchInput: { flex: 1, color: colors.text, fontSize: 12 },
  loadMoreButton: { minHeight: 40, borderRadius: 12, backgroundColor: colors.surfaceAlt, alignItems: 'center', justifyContent: 'center' },
  loadMoreText: { color: colors.text, fontSize: 12, fontWeight: '600' },
  empty: { padding: 18, color: colors.secondary, textAlign: 'center', backgroundColor: colors.surface, borderRadius: 14 },
  footer: { paddingTop: 12, paddingHorizontal: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.surface, flexDirection: 'row', gap: 10 },
  secondaryButton: { flex: 1, minHeight: 46, borderRadius: 14, backgroundColor: colors.surfaceAlt, alignItems: 'center', justifyContent: 'center' },
  secondaryButtonText: { color: colors.text, fontWeight: '700' },
  primaryButton: { flex: 1.4, minHeight: 46, borderRadius: 14, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
  primaryButtonText: { color: '#FFFFFF', fontWeight: '700' },
  disabled: { opacity: 0.45 },
});
