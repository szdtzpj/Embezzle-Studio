import { BlurView } from 'expo-blur';
import { Check, Folder, MoreHorizontal, PenSquare, Pencil, Pin, Search, Share2, Trash2, X } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  InteractionManager,
  Platform,
  Pressable,
  ScrollView,
  Share as NativeShare,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  useWorkspaceSelector,
  useWorkspaceStatus,
} from '../../app/workspace/WorkspaceSessionProvider';
import type { ChatConversation } from '../../domain/types';
import { deletePersistedAttachments } from '../../services/mediaStorage';
import {
  buildWorkspaceSearchIndex,
  searchWorkspaceIndex,
  type WorkspaceSearchIndex,
  type WorkspaceSearchResult,
} from '../../services/workspaceSearch';
import { ActionSheetDialog } from '../../ui/components/ActionSheetDialog';
import { AnimatedPressable } from '../../ui/components/AnimatedPressable';
import { ConfirmDialog } from '../../ui/components/ConfirmDialog';
import { ModelAvatar } from '../../ui/components/ModelAvatar';
import { PromptDialog } from '../../ui/components/PromptDialog';
import { useKelivoTheme } from '../../ui/theme';
import {
  isConversationMessage,
  sortConversations,
} from './projectConversationHelpers';
import {
  applyProjectConversationChatEffects,
  type ProjectConversationResult,
} from './projectConversationResults';
import { ProjectDrawerShell } from './ProjectDrawerShell';
import { useProjectConversationNavigation } from './ProjectsConversationsProvider';

export interface ProjectDrawerChatPort {
  resetComposer(): void;
  clearTaskQueries(): void;
  revealMessage(messageId: string): void;
  applyPromptTemplate(templateId: string): void;
  showNotice(message: string): void;
}

const conversationActionMenuHeight = 198;

function dominantConversationModel(conversation: ChatConversation) {
  const counts = new Map<
    string,
    { modelId: string; providerName?: string; count: number; latestAt: number }
  >();
  for (const message of conversation.messages) {
    if (message.role !== 'assistant' || !message.modelId) continue;
    const key = `${message.providerId ?? message.providerName ?? ''}:${message.modelId}`;
    const current = counts.get(key);
    counts.set(key, {
      modelId: message.modelId,
      providerName: message.providerName,
      count: (current?.count ?? 0) + 1,
      latestAt: Math.max(current?.latestAt ?? 0, message.createdAt),
    });
  }
  return [...counts.values()].sort(
    (left, right) => right.count - left.count || right.latestAt - left.latestAt
  )[0] ?? null;
}

function formatConversationTime(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

function conversationShareText(conversation: ChatConversation): string {
  const lines = [`# ${conversation.title}`, ''];
  for (const message of conversation.messages.filter(isConversationMessage)) {
    const role = message.role === 'user' ? '我' : '模型';
    const model = message.role === 'assistant' && message.modelId ? `（${message.modelId}）` : '';
    lines.push(`${role}${model}: ${message.content.trim() || '[附件/空内容]'}`);
    if (message.reasoningContent?.trim()) lines.push(`思考过程: ${message.reasoningContent.trim()}`);
    if (message.attachments?.length) {
      lines.push(`附件: ${message.attachments.map((attachment) => attachment.name).join(', ')}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

/** Project-owned drawer, search, conversation menus and dialogs. */
export function ProjectDrawer(props: { chat: ProjectDrawerChatPort }): React.ReactElement {
  const { chat } = props;
  const theme = useKelivoTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const navigation = useProjectConversationNavigation();
  const status = useWorkspaceStatus();
  const workspace = useWorkspaceSelector((snapshot) => snapshot);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const readOnly = status.phase !== 'ready';
  const [searchQuery, setSearchQuery] = useState('');
  const [searchIndex, setSearchIndex] = useState<WorkspaceSearchIndex | null>(null);
  const [panelHeight, setPanelHeight] = useState(0);
  const [conversationActionId, setConversationActionId] = useState<string | null>(null);
  const [conversationActionMenuTop, setConversationActionMenuTop] = useState(12);
  const [renamingConversationId, setRenamingConversationId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [moveConversationId, setMoveConversationId] = useState<string | null>(null);
  const [deleteConversationId, setDeleteConversationId] = useState<string | null>(null);
  const actionIdRef = useRef(conversationActionId);
  actionIdRef.current = conversationActionId;

  useEffect(() => {
    if (!navigation.drawerOpen) {
      setConversationActionId(null);
      setSearchIndex(null);
      return;
    }
    let cancelled = false;
    const task = InteractionManager.runAfterInteractions(() => {
      if (cancelled) return;
      const snapshot = workspaceRef.current;
      setSearchIndex(
        buildWorkspaceSearchIndex({
          projects: snapshot.projects,
          conversations: snapshot.conversations,
          promptTemplates: snapshot.promptTemplates,
        })
      );
    });
    return () => {
      cancelled = true;
      task.cancel();
    };
  }, [
    navigation.drawerOpen,
    workspace.conversations,
    workspace.projects,
    workspace.promptTemplates,
  ]);

  useEffect(() => {
    if (deleteConversationId && renamingConversationId) {
      setRenamingConversationId(null);
      setRenameDraft('');
    }
  }, [deleteConversationId, renamingConversationId]);

  const activeProjectConversations = useMemo(
    () => sortConversations(
      workspace.conversations.filter(
        (conversation) => conversation.projectId === workspace.activeProjectId
      )
    ),
    [workspace.activeProjectId, workspace.conversations]
  );
  const searchResults = useMemo(
    () => (searchIndex && searchQuery.trim() ? searchWorkspaceIndex(searchIndex, searchQuery, { limit: 60 }) : []),
    [searchIndex, searchQuery]
  );
  const actionConversation = workspace.conversations.find(
    (conversation) => conversation.id === conversationActionId
  );
  const renamingConversation = workspace.conversations.find(
    (conversation) => conversation.id === renamingConversationId
  );
  const deletingConversation = workspace.conversations.find(
    (conversation) => conversation.id === deleteConversationId
  );

  function applyResult(result: ProjectConversationResult) {
    applyProjectConversationChatEffects(result, chat);
    if (result.ok && result.orphanedAttachments?.length) {
      void deletePersistedAttachments(result.orphanedAttachments).catch(() => {
        chat.showNotice('对话已删除，但部分本地附件清理失败；工作区记录不会恢复。');
      });
    }
  }

  async function execute(command: Parameters<typeof navigation.execute>[0]) {
    const result = await navigation.execute(command);
    applyResult(result);
    if (command.type === 'conversation.delete') {
      setDeleteConversationId(null);
    }
    if (result.ok) {
      switch (command.type) {
        case 'project.activate':
        case 'conversation.start':
        case 'conversation.activate':
        case 'conversation.fork':
          navigation.closeDrawer();
          break;
        case 'conversation.move':
          setMoveConversationId(null);
          break;
        case 'conversation.rename':
          setRenamingConversationId(null);
          setRenameDraft('');
          break;
        case 'conversation.pin':
          setConversationActionId(null);
          break;
        default:
          break;
      }
    }
    return result;
  }

  async function openSearchResult(result: WorkspaceSearchResult) {
    setSearchQuery('');
    if (result.kind === 'project' && result.projectId) {
      await execute({ type: 'project.activate', projectId: result.projectId });
      return;
    }
    if (result.kind === 'prompt-template') {
      chat.applyPromptTemplate(result.id.replace(/^prompt-template:/, ''));
      navigation.closeDrawer();
      return;
    }
    if (result.conversationId) {
      const opened = await execute({
        type: 'conversation.activate',
        conversationId: result.conversationId,
      });
      if (opened.ok && result.messageId) chat.revealMessage(result.messageId);
    }
  }

  function openActionMenu(conversationId: string, pageY: number) {
    if (actionIdRef.current === conversationId) {
      setConversationActionId(null);
      return;
    }
    const maxTop = panelHeight
      ? Math.max(12, panelHeight - conversationActionMenuHeight - 16)
      : pageY + 16;
    setConversationActionMenuTop(Math.min(Math.max(12, pageY + 16), maxTop));
    setConversationActionId(conversationId);
  }

  async function shareConversation(conversation: ChatConversation) {
    setConversationActionId(null);
    const text = conversationShareText(conversation);
    try {
      if (Platform.OS === 'web') {
        if (typeof navigator !== 'undefined' && navigator.share) {
          await navigator.share({ title: conversation.title, text });
          return;
        }
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          chat.showNotice('已复制对话内容。');
          return;
        }
      }
      await NativeShare.share({ title: conversation.title, message: text });
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) {
        chat.showNotice('分享对话失败，请稍后再试。');
      }
    }
  }

  return (
    <>
      <ProjectDrawerShell
        open={navigation.drawerOpen}
        onClose={navigation.closeDrawer}
        onPanelLayout={setPanelHeight}
      >
        <View style={styles.header}>
          <Text style={styles.brand}>Embezzle Studio</Text>
          <AnimatedPressable
            accessibilityRole="button"
            accessibilityLabel="关闭聊天记录"
            onPress={navigation.closeDrawer}
            style={styles.iconButton}
          >
            <X size={20} color={theme.colors.text} strokeWidth={2} />
          </AnimatedPressable>
        </View>

        <AnimatedPressable
          accessibilityRole="button"
          accessibilityState={{ disabled: readOnly }}
          disabled={readOnly}
          onPress={() => void execute({ type: 'conversation.start' })}
          haptic="medium"
          style={[styles.newChat, readOnly && styles.disabled]}
        >
          <PenSquare size={16} color={theme.colors.textOnAccent} strokeWidth={2} />
          <Text style={styles.newChatText}>新对话</Text>
        </AnimatedPressable>

        <View style={styles.projectBlock} testID="project-switcher">
          <Text style={styles.sectionLabel}>项目</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.projectRow}>
            {workspace.projects.map((project) => {
              const selected = project.id === workspace.activeProjectId;
              return (
                <AnimatedPressable
                  key={project.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  onPress={() => void execute({ type: 'project.activate', projectId: project.id })}
                  haptic="selection"
                  style={[styles.projectChip, selected && styles.projectChipActive]}
                >
                  <Folder size={12} color={selected ? theme.colors.accentText : theme.colors.textSecondary} strokeWidth={2} />
                  <Text numberOfLines={1} style={[styles.projectChipText, selected && styles.projectChipTextActive]}>
                    {project.name}
                  </Text>
                </AnimatedPressable>
              );
            })}
          </ScrollView>
        </View>

        <View style={styles.searchBox}>
          <Search size={16} color={theme.colors.textSecondary} strokeWidth={2} />
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="全局搜索项目、消息和模板"
            placeholderTextColor={theme.colors.placeholder}
            style={styles.searchInput}
          />
          {searchQuery ? (
            <AnimatedPressable accessibilityRole="button" accessibilityLabel="清除聊天记录搜索" onPress={() => setSearchQuery('')} style={styles.searchClear}>
              <X size={14} color={theme.colors.textSecondary} strokeWidth={2} />
            </AnimatedPressable>
          ) : null}
        </View>

        {searchQuery ? (
          <View style={styles.section} testID="global-search-results">
            <Text style={styles.sectionLabel}>{searchIndex ? `全局结果 · ${searchResults.length}` : '正在准备本地索引…'}</Text>
            {!searchIndex ? (
              <Text style={styles.empty}>只在本机整理内容，不会上传搜索文本</Text>
            ) : searchResults.length ? (
              <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
                {searchResults.map((result) => (
                  <AnimatedPressable key={result.id} accessibilityRole="button" onPress={() => void openSearchResult(result)} style={styles.searchResult}>
                    <View style={styles.searchResultHeader}>
                      <Text numberOfLines={1} style={styles.searchResultTitle}>{result.title}</Text>
                      <Text style={styles.searchResultKind}>{result.kind === 'project' ? '项目' : result.kind === 'prompt-template' ? '模板' : result.kind === 'message' ? '消息' : '对话'}</Text>
                    </View>
                    <Text numberOfLines={3} style={styles.searchResultSnippet}>{result.snippet}</Text>
                  </AnimatedPressable>
                ))}
              </ScrollView>
            ) : <Text style={styles.empty}>没有匹配的本地内容</Text>}
          </View>
        ) : (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>对话</Text>
            {activeProjectConversations.length ? (
              <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
                {activeProjectConversations.map((conversation) => {
                  const active = conversation.id === workspace.activeConversationId;
                  const dominant = dominantConversationModel(conversation);
                  return (
                    <View key={conversation.id} style={[styles.conversationItem, active && styles.conversationItemActive]}>
                      <View style={styles.conversationRow}>
                        <AnimatedPressable accessibilityRole="button" accessibilityLabel={`打开对话：${conversation.title}`} onPress={() => void execute({ type: 'conversation.activate', conversationId: conversation.id })} haptic="selection" style={styles.conversationContent}>
                          <View style={styles.conversationTitleRow}>
                            {conversation.pinnedAt ? <Pin size={12} color={theme.colors.accentText} strokeWidth={2.4} /> : null}
                            <Text numberOfLines={1} style={[styles.conversationTitle, active && styles.conversationTitleActive]}>{conversation.title}</Text>
                          </View>
                          <View style={styles.conversationMetaRow}>
                            {dominant ? <ModelAvatar modelId={dominant.modelId} providerName={dominant.providerName} size={18} containerSize={22} /> : null}
                            <Text numberOfLines={1} style={styles.conversationMeta}>{dominant ? `${dominant.modelId}${dominant.count > 1 ? ` x${dominant.count}` : ''} · ` : ''}{formatConversationTime(conversation.updatedAt)}</Text>
                          </View>
                        </AnimatedPressable>
                        <AnimatedPressable accessibilityRole="button" accessibilityLabel={`更多对话操作：${conversation.title}`} onPress={(event) => { event.stopPropagation?.(); openActionMenu(conversation.id, event.nativeEvent.pageY); }} style={[styles.moreButton, conversationActionId === conversation.id && styles.moreButtonActive]}>
                          <MoreHorizontal size={18} color={theme.colors.textSecondary} strokeWidth={2.4} />
                        </AnimatedPressable>
                      </View>
                    </View>
                  );
                })}
              </ScrollView>
            ) : <Text style={styles.empty}>暂无历史对话</Text>}
          </View>
        )}

        {actionConversation ? (
          <>
            <BlurView intensity={38} tint={theme.dark ? 'dark' : 'light'} blurMethod="dimezisBlurView" style={styles.frost}>
              <Pressable style={styles.frostTarget} onPress={() => setConversationActionId(null)} />
            </BlurView>
            <View style={[styles.actionMenu, { top: conversationActionMenuTop }]}>
              <AnimatedPressable accessibilityRole="button" onPress={() => void execute({ type: 'conversation.pin', conversationId: actionConversation.id, pinned: !actionConversation.pinnedAt })} style={styles.actionRow}>
                <Text style={styles.actionText}>{actionConversation.pinnedAt ? '取消置顶' : '置顶'}</Text>
                <Pin size={16} color={theme.colors.text} strokeWidth={2.4} />
              </AnimatedPressable>
              <AnimatedPressable accessibilityRole="button" onPress={() => { setRenamingConversationId(actionConversation.id); setRenameDraft(actionConversation.title); setConversationActionId(null); navigation.closeDrawer(); }} style={styles.actionRow}>
                <Text style={styles.actionText}>编辑名称</Text><Pencil size={16} color={theme.colors.primary} strokeWidth={2.4} />
              </AnimatedPressable>
              <AnimatedPressable accessibilityRole="button" onPress={() => void shareConversation(actionConversation)} style={styles.actionRow}>
                <Text style={styles.actionText}>分享对话</Text><Share2 size={16} color={theme.colors.success} strokeWidth={2.3} />
              </AnimatedPressable>
              <AnimatedPressable accessibilityRole="button" onPress={() => { setMoveConversationId(actionConversation.id); setConversationActionId(null); navigation.closeDrawer(); }} style={styles.actionRow}>
                <Text style={styles.actionText}>移动到项目</Text><Folder size={16} color={theme.colors.textSecondary} strokeWidth={2.3} />
              </AnimatedPressable>
              <AnimatedPressable accessibilityRole="button" onPress={() => { setDeleteConversationId(actionConversation.id); setConversationActionId(null); navigation.closeDrawer(); }} style={[styles.actionRow, styles.actionDangerRow]}>
                <Text style={[styles.actionText, styles.actionDangerText]}>删除</Text><Trash2 size={16} color={theme.colors.error} strokeWidth={2.4} />
              </AnimatedPressable>
            </View>
          </>
        ) : null}
      </ProjectDrawerShell>

      <PromptDialog visible={Boolean(renamingConversation)} title="编辑对话名称" value={renameDraft} onChangeText={setRenameDraft} maxLength={60} placeholder="输入对话名称" confirmLabel="保存" cancelLabel="取消" onConfirm={() => renamingConversationId ? void execute({ type: 'conversation.rename', conversationId: renamingConversationId, title: renameDraft }) : undefined} onCancel={() => { setRenamingConversationId(null); setRenameDraft(''); }} />
      <ActionSheetDialog visible={Boolean(moveConversationId)} title="移动到项目" description="只调整本地归类，不会发送请求或移动媒体文件。" icon={<Folder size={22} color={theme.colors.text} strokeWidth={2.2} />} onClose={() => setMoveConversationId(null)}>
        {workspace.projects.map((project) => (
          <AnimatedPressable key={`move:${project.id}`} accessibilityRole="button" onPress={() => moveConversationId ? void execute({ type: 'conversation.move', conversationId: moveConversationId, projectId: project.id }) : undefined} style={styles.moveRow}>
            <Folder size={16} color={theme.colors.textSecondary} strokeWidth={2} />
            <Text numberOfLines={1} style={styles.moveText}>{project.name}</Text>
            {workspace.conversations.find((conversation) => conversation.id === moveConversationId)?.projectId === project.id ? <Check size={16} color={theme.colors.accent} strokeWidth={2.4} /> : null}
          </AnimatedPressable>
        ))}
      </ActionSheetDialog>
      <ConfirmDialog visible={Boolean(deletingConversation)} title="删除聊天记录" subject={deletingConversation?.title} description="这会从本地移除该对话，并释放这条记录占用的本地存储。" confirmLabel="删除" cancelLabel="取消" tone="danger" onConfirm={() => deleteConversationId ? void execute({ type: 'conversation.delete', conversationId: deleteConversationId }) : undefined} onCancel={() => setDeleteConversationId(null)} />
    </>
  );
}

function createStyles(theme: ReturnType<typeof useKelivoTheme>) {
  const { colors, radius } = theme;
  return StyleSheet.create({
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
    brand: { color: colors.text, fontSize: 18, fontWeight: '700' },
    iconButton: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
    newChat: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 38, borderRadius: radius.pill, backgroundColor: colors.accent, paddingHorizontal: 14, marginBottom: 14 },
    newChatText: { color: colors.textOnAccent, fontSize: 14, fontWeight: '600' },
    disabled: { opacity: 0.5 },
    projectBlock: { marginBottom: 12, gap: 6 },
    projectRow: { gap: 6, paddingRight: 4 },
    projectChip: { maxWidth: 140, minHeight: 26, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 9, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.outline },
    projectChipActive: { backgroundColor: colors.accentSoft, borderColor: colors.accentBorder },
    projectChipText: { flexShrink: 1, color: colors.textSecondary, fontSize: 11, fontWeight: '600' },
    projectChipTextActive: { color: colors.accentText },
    searchBox: { height: 36, borderRadius: radius.md, borderWidth: 1, borderColor: colors.outline, backgroundColor: colors.card, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, marginBottom: 14 },
    searchInput: { flex: 1, minWidth: 0, color: colors.text, fontSize: 14, lineHeight: 20, paddingVertical: 0, outlineStyle: 'none' as never },
    searchClear: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
    section: { flex: 1 },
    sectionLabel: { color: colors.textSecondary, fontSize: 11, fontWeight: '600', marginBottom: 8, letterSpacing: 0.3 },
    list: { flex: 1 },
    listContent: { gap: 6, paddingBottom: 20 },
    empty: { color: colors.placeholder, fontSize: 14 },
    searchResult: { borderRadius: radius.md, borderWidth: 1, borderColor: colors.outline, backgroundColor: colors.card, paddingHorizontal: 11, paddingVertical: 10, gap: 5 },
    searchResultHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    searchResultTitle: { flex: 1, color: colors.text, fontSize: 13, fontWeight: '700' },
    searchResultKind: { color: colors.textSecondary, fontSize: 10, fontWeight: '800', textTransform: 'uppercase' },
    searchResultSnippet: { color: colors.textSecondary, fontSize: 11, lineHeight: 17 },
    conversationItem: { borderRadius: radius.md, paddingHorizontal: 8, paddingVertical: 8, gap: 6 },
    conversationItemActive: { backgroundColor: colors.surfaceAlt },
    conversationRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    conversationContent: { flex: 1, minWidth: 0, gap: 4, paddingVertical: 2 },
    conversationTitleRow: { minHeight: 20, flexDirection: 'row', alignItems: 'center', gap: 5 },
    conversationTitle: { flex: 1, minWidth: 0, color: colors.text, fontSize: 15, lineHeight: 20, fontWeight: '600' },
    conversationTitleActive: { color: colors.accentText },
    conversationMetaRow: { minHeight: 22, flexDirection: 'row', alignItems: 'center', gap: 7 },
    conversationMeta: { flex: 1, minWidth: 0, color: colors.textSecondary, fontSize: 12, lineHeight: 16 },
    moreButton: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.card },
    moreButtonActive: { backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.accentBorder },
    frost: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 30, elevation: 30, backgroundColor: colors.surfaceAlt },
    frostTarget: { flex: 1 },
    actionMenu: { position: 'absolute', right: 20, zIndex: 31, width: 184, borderRadius: radius.md, overflow: 'hidden', borderWidth: 1, borderColor: colors.outline, backgroundColor: colors.card, ...theme.shadows.medium },
    actionRow: { minHeight: 38, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: colors.outline },
    actionDangerRow: { borderBottomWidth: 0 },
    actionText: { flex: 1, minWidth: 0, color: colors.text, fontSize: 13, fontWeight: '700' },
    actionDangerText: { color: colors.error },
    moveRow: { minHeight: 42, flexDirection: 'row', alignItems: 'center', gap: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.outline },
    moveText: { flex: 1, color: colors.text, fontSize: 14, fontWeight: '700' },
  });
}
