import { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  BookOpen,
  FileText,
  FolderKanban,
  MessageCircle,
  Plus,
  Settings,
  Sparkles,
  Video,
} from 'lucide-react-native';

import type { AppWorkspace } from '../../domain/types';
import { deriveGenerationTasks } from '../../services/generationTasks';
import { AnimatedPressable } from '../components/AnimatedPressable';
import { useKelivoTheme, type KelivoTheme } from '../theme';

export type MainWorkspaceTab = 'chat' | 'projects' | 'artifacts';

export interface WorkspaceHubProps {
  workspace: AppWorkspace;
  onOpenConversation: (conversationId: string) => void;
  onActivateProject: (projectId: string) => void;
  onOpenArtifact: (artifactId: string) => void;
  onOpenTasks: () => void;
  onUseTemplate: (templateId: string) => void;
  onNewConversation: () => void;
  onOpenSettings: () => void;
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

export function WorkspaceHub({
  workspace,
  onOpenConversation,
  onActivateProject,
  onOpenArtifact,
  onOpenTasks,
  onUseTemplate,
  onNewConversation,
  onOpenSettings,
}: WorkspaceHubProps): React.ReactElement {
  const theme = useKelivoTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const recentConversations = useMemo(
    () => [...workspace.conversations].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5),
    [workspace.conversations]
  );
  const recentArtifacts = useMemo(
    () => [...workspace.artifacts].sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || b.updatedAt - a.updatedAt).slice(0, 5),
    [workspace.artifacts]
  );
  const activeTasks = useMemo(
    () => deriveGenerationTasks(workspace.conversations).filter((task) => task.state === 'active').slice(0, 4),
    [workspace.conversations]
  );
  const templates = useMemo(
    () => [...workspace.promptTemplates].sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) || b.updatedAt - a.updatedAt).slice(0, 5),
    [workspace.promptTemplates]
  );
  const projectNameById = useMemo(
    () => new Map(workspace.projects.map((project) => [project.id, project.name])),
    [workspace.projects]
  );

  return (
    <View style={styles.root} testID="workspace-hub">
      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>本地工作区</Text>
          <Text style={styles.title}>项目</Text>
          <Text style={styles.subtitle}>最近对话、成果、任务和模板都在这里，不会自动调用模型。</Text>
        </View>
        <AnimatedPressable accessibilityRole="button" accessibilityLabel="打开设置" onPress={onOpenSettings} style={styles.iconButton}>
          <Settings size={20} color={theme.colors.text} strokeWidth={2.1} />
        </AnimatedPressable>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.projectRow}>
          {workspace.projects.map((project) => {
            const active = project.id === workspace.activeProjectId;
            return (
              <AnimatedPressable
                key={project.id}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => onActivateProject(project.id)}
                style={[styles.projectChip, active && styles.projectChipActive]}
              >
                <FolderKanban size={15} color={active ? theme.colors.accentText : theme.colors.textSecondary} strokeWidth={2} />
                <Text numberOfLines={1} style={[styles.projectChipText, active && styles.projectChipTextActive]}>{project.name}</Text>
              </AnimatedPressable>
            );
          })}
        </ScrollView>

        <AnimatedPressable accessibilityRole="button" onPress={onNewConversation} haptic="medium" style={styles.newConversation}>
          <Plus size={18} color={theme.colors.textOnAccent} strokeWidth={2.5} />
          <Text style={styles.newConversationText}>在当前项目开始新对话</Text>
        </AnimatedPressable>

        <HubSection title="最近对话" icon={<MessageCircle size={18} color={theme.colors.accent} strokeWidth={2.2} />} styles={styles}>
          {recentConversations.length ? recentConversations.map((conversation) => (
            <HubRow
              key={conversation.id}
              title={conversation.title}
              detail={`${projectNameById.get(conversation.projectId ?? '') ?? '未归类'} · ${formatTime(conversation.updatedAt)}`}
              onPress={() => onOpenConversation(conversation.id)}
              styles={styles}
            />
          )) : <EmptyText text="还没有历史对话" styles={styles} />}
        </HubSection>

        <HubSection title="最近成果" icon={<FileText size={18} color={theme.colors.accent} strokeWidth={2.2} />} styles={styles}>
          {recentArtifacts.length ? recentArtifacts.map((artifact) => (
            <HubRow
              key={artifact.id}
              title={`${artifact.favorite ? '★ ' : ''}${artifact.title}`}
              detail={`${projectNameById.get(artifact.projectId) ?? '未归类'} · ${artifact.format}${artifact.tags?.length ? ` · ${artifact.tags.join(' / ')}` : ''}`}
              onPress={() => onOpenArtifact(artifact.id)}
              styles={styles}
            />
          )) : <EmptyText text="还没有成果，可以从回答菜单保存" styles={styles} />}
        </HubSection>

        <HubSection title="媒体任务" icon={<Video size={18} color={theme.colors.accent} strokeWidth={2.2} />} styles={styles}>
          {activeTasks.length ? activeTasks.map((task) => (
            <HubRow
              key={task.key}
              title={task.title}
              detail={`${task.task.modelId} · ${task.task.status ?? '等待服务商处理'}`}
              onPress={onOpenTasks}
              styles={styles}
            />
          )) : <EmptyText text="当前没有进行中的长任务" styles={styles} />}
        </HubSection>

        <HubSection title="常用模板" icon={<Sparkles size={18} color={theme.colors.accent} strokeWidth={2.2} />} styles={styles}>
          {templates.length ? templates.map((template) => (
            <HubRow
              key={template.id}
              title={template.name}
              detail={template.mode === 'system' ? '项目指令模板' : '输入框模板'}
              onPress={() => onUseTemplate(template.id)}
              styles={styles}
            />
          )) : <EmptyText text="在成果与模板工具中保存常用提示词" styles={styles} />}
        </HubSection>
      </ScrollView>
    </View>
  );
}

function HubSection(props: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <View style={props.styles.section}>
      <View style={props.styles.sectionHeader}>{props.icon}<Text style={props.styles.sectionTitle}>{props.title}</Text></View>
      <View style={props.styles.sectionCard}>{props.children}</View>
    </View>
  );
}

function HubRow(props: { title: string; detail: string; onPress: () => void; styles: ReturnType<typeof createStyles> }) {
  return (
    <AnimatedPressable accessibilityRole="button" onPress={props.onPress} style={props.styles.row}>
      <View style={props.styles.rowCopy}>
        <Text numberOfLines={1} style={props.styles.rowTitle}>{props.title}</Text>
        <Text numberOfLines={2} style={props.styles.rowDetail}>{props.detail}</Text>
      </View>
      <Text style={props.styles.rowArrow}>›</Text>
    </AnimatedPressable>
  );
}

function EmptyText(props: { text: string; styles: ReturnType<typeof createStyles> }) {
  return <Text style={props.styles.empty}>{props.text}</Text>;
}

export function MainWorkspaceTabBar(props: {
  active: MainWorkspaceTab;
  onChange: (tab: MainWorkspaceTab) => void;
}): React.ReactElement {
  const theme = useKelivoTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const items: Array<{ key: MainWorkspaceTab; label: string; icon: typeof MessageCircle }> = [
    { key: 'chat', label: '对话', icon: MessageCircle },
    { key: 'projects', label: '项目', icon: FolderKanban },
    { key: 'artifacts', label: '成果', icon: BookOpen },
  ];
  return (
    <View style={styles.tabBar} accessibilityRole="tablist">
      {items.map((item) => {
        const selected = item.key === props.active;
        const Icon = item.icon;
        return (
          <AnimatedPressable
            key={item.key}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => props.onChange(item.key)}
            haptic="selection"
            style={[styles.tabItem, selected && styles.tabItemActive]}
          >
            <Icon size={19} color={selected ? theme.colors.accentText : theme.colors.textSecondary} strokeWidth={selected ? 2.5 : 2} />
            <Text style={[styles.tabLabel, selected && styles.tabLabelActive]}>{item.label}</Text>
          </AnimatedPressable>
        );
      })}
    </View>
  );
}

function createStyles(theme: KelivoTheme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: theme.colors.background },
    header: { minHeight: 94, paddingHorizontal: 18, paddingVertical: 13, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.outline },
    headerCopy: { flex: 1, minWidth: 0, gap: 2 },
    eyebrow: { color: theme.colors.accentText, fontSize: 11, lineHeight: 16, fontWeight: '800', letterSpacing: 0.5 },
    title: { color: theme.colors.text, fontSize: 24, lineHeight: 30, fontWeight: '800' },
    subtitle: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 18 },
    iconButton: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.card, borderWidth: 1, borderColor: theme.colors.outline },
    scroll: { flex: 1 },
    content: { padding: 16, paddingBottom: 28, gap: 14 },
    projectRow: { gap: 8, paddingRight: 8 },
    projectChip: { minHeight: 44, maxWidth: 180, paddingHorizontal: 13, borderRadius: 14, flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: theme.colors.card, borderWidth: 1, borderColor: theme.colors.outline },
    projectChipActive: { backgroundColor: theme.colors.accentSoft, borderColor: theme.colors.accentBorder },
    projectChipText: { flexShrink: 1, color: theme.colors.textSecondary, fontSize: 13, fontWeight: '700' },
    projectChipTextActive: { color: theme.colors.accentText },
    newConversation: { minHeight: 50, borderRadius: 16, backgroundColor: theme.colors.accent, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, paddingHorizontal: 16 },
    newConversationText: { color: theme.colors.textOnAccent, fontSize: 14, fontWeight: '800' },
    section: { gap: 8 },
    sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 2 },
    sectionTitle: { color: theme.colors.text, fontSize: 15, lineHeight: 22, fontWeight: '800' },
    sectionCard: { borderRadius: 17, backgroundColor: theme.colors.card, borderWidth: 1, borderColor: theme.colors.outline, overflow: 'hidden' },
    row: { minHeight: 62, paddingHorizontal: 14, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider },
    rowCopy: { flex: 1, minWidth: 0, gap: 3 },
    rowTitle: { color: theme.colors.text, fontSize: 14, lineHeight: 20, fontWeight: '700' },
    rowDetail: { color: theme.colors.textSecondary, fontSize: 11, lineHeight: 17 },
    rowArrow: { color: theme.colors.textSecondary, fontSize: 24, lineHeight: 28 },
    empty: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 20, padding: 16 },
    tabBar: { minHeight: 62, paddingHorizontal: 12, paddingTop: 7, paddingBottom: 7, flexDirection: 'row', gap: 6, backgroundColor: theme.colors.card, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.outline },
    tabItem: { flex: 1, minHeight: 48, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
    tabItemActive: { backgroundColor: theme.colors.accentSoft },
    tabLabel: { color: theme.colors.textSecondary, fontSize: 12, fontWeight: '700' },
    tabLabelActive: { color: theme.colors.accentText, fontWeight: '800' },
  });
}
