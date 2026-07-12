import { BookOpen, Check, Clock3, Download, FilePlus2, FileText, History, Plus, RotateCcw, Save, Search, Trash2, X } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { useKelivoTheme, type KelivoTheme } from '../ui/theme';
import { requestConfirm } from '../ui/components/dialogService';

import type {
  ProjectKnowledgeSource,
  WorkspaceArtifact,
  WorkspaceArtifactFormat,
} from '../domain/types';
import {
  buildProjectKnowledgeIndex,
  searchProjectKnowledgeIndex,
} from '../services/projectKnowledge';
import { summarizeWorkspaceArtifactRevisionDiff } from '../services/workspaceArtifacts';
import { createKnowledgeAndClearDraft } from './workspaceWorkbenchDraft';

interface WorkspaceWorkbenchProps {
  visible: boolean;
  projectName: string;
  artifacts: readonly WorkspaceArtifact[];
  knowledgeSources: readonly ProjectKnowledgeSource[];
  initialArtifactId?: string | null;
  readOnly?: boolean;
  onClose: () => void;
  onCreateArtifact: (format: WorkspaceArtifactFormat) => void;
  onSaveArtifact: (artifactId: string, title: string, content: string) => void;
  onRestoreArtifactRevision: (artifactId: string, revisionId: string) => void;
  onDeleteArtifact: (artifactId: string) => void;
  onExportArtifact: (artifactId: string) => void;
  onSaveArtifactAsKnowledge: (artifactId: string) => void;
  onCreateKnowledge: (title: string, content: string) => boolean;
  onSaveKnowledge: (sourceId: string, title: string, content: string) => void;
  onDeleteKnowledge: (sourceId: string) => void;
  onImportTextKnowledge: () => void;
}

type WorkbenchTab = 'artifacts' | 'knowledge';

const maxVisibleKnowledgeSources = 60;
const artifactCreateFormats: readonly WorkspaceArtifactFormat[] = [
  'markdown',
  'plain-text',
  'code',
  'json',
  'html',
];

function activeArtifactContent(artifact: WorkspaceArtifact | undefined): string {
  if (!artifact) return '';
  return artifact.revisions.find((revision) => revision.id === artifact.activeRevisionId)?.content ?? '';
}

function artifactFormatLabel(format: WorkspaceArtifactFormat): string {
  if (format === 'markdown') return 'Markdown';
  if (format === 'plain-text') return '纯文本';
  if (format === 'code') return '代码';
  if (format === 'json') return 'JSON';
  return 'HTML（仅文本）';
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

export function WorkspaceWorkbench({
  visible,
  projectName,
  artifacts,
  knowledgeSources,
  initialArtifactId,
  readOnly = false,
  onClose,
  onCreateArtifact,
  onSaveArtifact,
  onRestoreArtifactRevision,
  onDeleteArtifact,
  onExportArtifact,
  onSaveArtifactAsKnowledge,
  onCreateKnowledge,
  onSaveKnowledge,
  onDeleteKnowledge,
  onImportTextKnowledge,
}: WorkspaceWorkbenchProps) {
  const insets = useSafeAreaInsets();
  const theme = useKelivoTheme();
  const styles = getStyles(theme);
  const colors = themeColors(theme);

  const [tab, setTab] = useState<WorkbenchTab>('artifacts');
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [artifactTitle, setArtifactTitle] = useState('');
  const [artifactContent, setArtifactContent] = useState('');
  const [selectedKnowledgeId, setSelectedKnowledgeId] = useState<string | null>(null);
  const [knowledgeTitle, setKnowledgeTitle] = useState('');
  const [knowledgeContent, setKnowledgeContent] = useState('');
  const [knowledgeQuery, setKnowledgeQuery] = useState('');
  const [deferredKnowledgeQuery, setDeferredKnowledgeQuery] = useState('');
  const [newKnowledgeTitle, setNewKnowledgeTitle] = useState('');
  const [newKnowledgeContent, setNewKnowledgeContent] = useState('');

  const selectedArtifact = artifacts.find((artifact) => artifact.id === selectedArtifactId);
  const selectedKnowledge = knowledgeSources.find((source) => source.id === selectedKnowledgeId);
  const artifactDiff = useMemo(() => {
    if (!selectedArtifact || selectedArtifact.revisions.length < 2) return null;
    const activeIndex = selectedArtifact.revisions.findIndex(
      (revision) => revision.id === selectedArtifact.activeRevisionId
    );
    const beforeIndex = activeIndex > 0 ? activeIndex - 1 : 1;
    const before = selectedArtifact.revisions[beforeIndex];
    const after = selectedArtifact.revisions[activeIndex >= 0 ? activeIndex : 0];
    if (!before || !after || before.id === after.id) return null;
    return summarizeWorkspaceArtifactRevisionDiff(selectedArtifact, before.id, after.id, {
      maxLines: 120,
      maxEntries: 40,
      maxLineLength: 180,
    });
  }, [selectedArtifact]);
  useEffect(() => {
    const query = knowledgeQuery.normalize('NFKC').trim();
    if (!query) {
      setDeferredKnowledgeQuery('');
      return;
    }
    const timer = setTimeout(() => setDeferredKnowledgeQuery(query), 180);
    return () => clearTimeout(timer);
  }, [knowledgeQuery]);
  const knowledgeSearchEnabled = Boolean(deferredKnowledgeQuery);
  const knowledgeIndex = useMemo(() => {
    if (!knowledgeSearchEnabled) return null;
    const projectId = knowledgeSources[0]?.projectId;
    return projectId ? buildProjectKnowledgeIndex(knowledgeSources, projectId) : null;
  }, [knowledgeSearchEnabled, knowledgeSources]);
  const filteredKnowledge = useMemo(() => {
    const query = deferredKnowledgeQuery;
    if (!query) return knowledgeSources.slice(0, maxVisibleKnowledgeSources);
    if (!knowledgeIndex) return [];
    const sourceById = new Map(knowledgeSources.map((source) => [source.id, source]));
    const seen = new Set<string>();
    return searchProjectKnowledgeIndex(knowledgeIndex, query, {
      limit: maxVisibleKnowledgeSources,
      uniqueSources: true,
    }).flatMap((result) => {
      if (seen.has(result.sourceId)) return [];
      seen.add(result.sourceId);
      const source = sourceById.get(result.sourceId);
      return source ? [source] : [];
    });
  }, [deferredKnowledgeQuery, knowledgeIndex, knowledgeSources]);

  useEffect(() => {
    if (!visible) return;
    const preferred = artifacts.find((artifact) => artifact.id === initialArtifactId) ?? artifacts[0];
    setSelectedArtifactId(preferred?.id ?? null);
    if (initialArtifactId) setTab('artifacts');
  }, [artifacts, initialArtifactId, visible]);

  useEffect(() => {
    setArtifactTitle(selectedArtifact?.title ?? '');
    setArtifactContent(activeArtifactContent(selectedArtifact));
  }, [selectedArtifact]);

  useEffect(() => {
    setKnowledgeTitle(selectedKnowledge?.title ?? '');
    setKnowledgeContent(selectedKnowledge?.content ?? '');
  }, [selectedKnowledge]);

  useEffect(() => {
    if (!selectedKnowledgeId && filteredKnowledge[0]) {
      setSelectedKnowledgeId(filteredKnowledge[0].id);
    } else if (selectedKnowledgeId && !knowledgeSources.some((source) => source.id === selectedKnowledgeId)) {
      setSelectedKnowledgeId(filteredKnowledge[0]?.id ?? null);
    }
  }, [filteredKnowledge, knowledgeSources, selectedKnowledgeId]);

  const artifactDirty = Boolean(
    selectedArtifact &&
    (artifactTitle.trim() !== selectedArtifact.title || artifactContent !== activeArtifactContent(selectedArtifact))
  );
  const knowledgeDirty = Boolean(
    selectedKnowledge &&
    (knowledgeTitle.trim() !== selectedKnowledge.title || knowledgeContent !== selectedKnowledge.content)
  );
  const newKnowledgeDirty = Boolean(newKnowledgeTitle.trim() || newKnowledgeContent.trim());

  async function confirmDiscard(dirty: boolean, action: () => void) {
    if (!dirty) {
      action();
      return;
    }
    const confirmed = await requestConfirm({
      title: '放弃未保存修改？',
      description: '继续会放弃尚未保存的本地编辑。请先保存，或确认放弃。',
      confirmLabel: '放弃修改',
      cancelLabel: '继续编辑',
      tone: 'warning',
    });
    if (confirmed) {
      action();
    }
  }

  const requestClose = () => {
    void confirmDiscard(
      artifactDirty || knowledgeDirty || newKnowledgeDirty,
      onClose
    );
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={requestClose}
    >
      <SafeAreaView style={styles.root}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.title}>本地成果工作台</Text>
            <Text numberOfLines={1} style={styles.subtitle}>{projectName} · 不会自动调用模型</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="关闭成果工作台" onPress={requestClose} style={styles.iconButton}>
            <X size={20} color={colors.text} strokeWidth={2.2} />
          </Pressable>
        </View>

        <View style={styles.tabs}>
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === 'artifacts' }}
            onPress={() => setTab('artifacts')}
            style={[styles.tab, tab === 'artifacts' && styles.tabActive]}
          >
            <FileText size={16} color={tab === 'artifacts' ? colors.onAccent : colors.secondary} strokeWidth={2} />
            <Text style={[styles.tabText, tab === 'artifacts' && styles.tabTextActive]}>成果 {artifacts.length}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === 'knowledge' }}
            onPress={() => setTab('knowledge')}
            style={[styles.tab, tab === 'knowledge' && styles.tabActive]}
          >
            <BookOpen size={16} color={tab === 'knowledge' ? colors.onAccent : colors.secondary} strokeWidth={2} />
            <Text style={[styles.tabText, tab === 'knowledge' && styles.tabTextActive]}>资料 {knowledgeSources.length}</Text>
          </Pressable>
        </View>

        {tab === 'artifacts' ? (
          <ScrollView
            style={styles.body}
            contentContainerStyle={[styles.bodyContent, { paddingBottom: Math.max(28, insets.bottom + 20) }]}
            keyboardShouldPersistTaps="handled"
          >
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
              {artifacts.map((artifact) => (
                <Pressable
                  key={artifact.id}
                  accessibilityRole="button"
                  accessibilityLabel={`打开成果：${artifact.title}`}
                  accessibilityState={{ selected: artifact.id === selectedArtifactId }}
                  onPress={() => confirmDiscard(artifactDirty, () => setSelectedArtifactId(artifact.id))}
                  style={[styles.chip, artifact.id === selectedArtifactId && styles.chipActive]}
                >
                  <Text numberOfLines={1} style={[styles.chipText, artifact.id === selectedArtifactId && styles.chipTextActive]}>
                    {artifact.title}
                  </Text>
                </Pressable>
              ))}
              {artifactCreateFormats.map((format) => (
                <Pressable
                  key={`create:${format}`}
                  accessibilityRole="button"
                  accessibilityLabel={`新建${artifactFormatLabel(format)}成果`}
                  disabled={readOnly}
                  onPress={() => confirmDiscard(artifactDirty, () => onCreateArtifact(format))}
                  style={[styles.addChip, readOnly && styles.disabled]}
                >
                  <Plus size={15} color={colors.text} strokeWidth={2.3} />
                  <Text style={styles.addChipText}>{artifactFormatLabel(format)}</Text>
                </Pressable>
              ))}
            </ScrollView>

            {selectedArtifact ? (
              <>
                <View style={styles.card} testID="artifact-editor-card">
                  <View style={styles.cardHeader}>
                    <View>
                      <Text style={styles.cardTitle}>编辑成果</Text>
                      <Text style={styles.meta}>{artifactFormatLabel(selectedArtifact.format)} · 本机版本 {selectedArtifact.revisions.length}</Text>
                    </View>
                    {artifactDirty ? <Text style={styles.unsavedBadge}>未保存</Text> : <Check size={18} color={colors.secondary} strokeWidth={2.4} />}
                  </View>
                  <TextInput
                    value={artifactTitle}
                    editable={!readOnly}
                    onChangeText={setArtifactTitle}
                    placeholder="成果名称"
                    placeholderTextColor={colors.secondary}
                    style={styles.input}
                  />
                  <TextInput
                    value={artifactContent}
                    editable={!readOnly}
                    onChangeText={setArtifactContent}
                    multiline
                    textAlignVertical="top"
                    placeholder="在这里编写 Markdown、文本、代码或 JSON"
                    placeholderTextColor={colors.secondary}
                    style={styles.editor}
                  />
                  <Text style={styles.securityHint}>
                    HTML 和代码在 v1.3 中只作为文本保存与导出，不执行脚本、不联网预览。
                  </Text>
                  <View style={styles.actionRow}>
                    <Pressable
                      accessibilityRole="button"
                      disabled={readOnly || !artifactDirty || !artifactTitle.trim()}
                      onPress={() => onSaveArtifact(selectedArtifact.id, artifactTitle, artifactContent)}
                      style={[styles.primaryButton, (readOnly || !artifactDirty || !artifactTitle.trim()) && styles.disabled]}
                    >
                      <Save size={16} color={colors.onAccent} strokeWidth={2.2} />
                      <Text style={styles.primaryButtonText}>保存新版本</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      disabled={artifactDirty}
                      onPress={() => onExportArtifact(selectedArtifact.id)}
                      style={[styles.secondaryButton, artifactDirty && styles.disabled]}
                    >
                      <Download size={16} color={colors.text} strokeWidth={2.1} />
                      <Text style={styles.secondaryButtonText}>导出</Text>
                    </Pressable>
                  </View>
                  <View style={styles.actionRow}>
                    <Pressable
                      accessibilityRole="button"
                      disabled={readOnly || artifactDirty}
                      onPress={() => onSaveArtifactAsKnowledge(selectedArtifact.id)}
                      style={[styles.secondaryButton, (readOnly || artifactDirty) && styles.disabled]}
                    >
                      <BookOpen size={16} color={colors.text} strokeWidth={2.1} />
                      <Text style={styles.secondaryButtonText}>存为项目资料</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      disabled={readOnly}
                      onPress={() => confirmDiscard(artifactDirty, () => onDeleteArtifact(selectedArtifact.id))}
                      style={[styles.dangerButton, readOnly && styles.disabled]}
                    >
                      <Trash2 size={16} color={colors.danger} strokeWidth={2.1} />
                      <Text style={styles.dangerButtonText}>删除</Text>
                    </Pressable>
                  </View>
                </View>

                <View style={styles.card}>
                  <View style={styles.cardHeader}>
                    <View>
                      <Text style={styles.cardTitle}>版本历史</Text>
                      <Text style={styles.meta}>恢复会生成一个新版本，不覆盖历史</Text>
                    </View>
                    <History size={18} color={colors.secondary} strokeWidth={2.1} />
                  </View>
                  {artifactDiff ? (
                    <View style={styles.diffPanel} testID="artifact-version-diff">
                      <View style={styles.diffSummary}>
                        <Text style={styles.diffAdded}>+{artifactDiff.addedLines}</Text>
                        <Text style={styles.diffRemoved}>−{artifactDiff.removedLines}</Text>
                        <Text style={styles.meta}>{artifactDiff.truncated ? '有界预览，部分内容已省略' : '与上一版本比较'}</Text>
                      </View>
                      {artifactDiff.entries.slice(0, 16).map((entry, index) => (
                        <Text
                          key={`${entry.kind}:${entry.oldLineNumber ?? '-'}:${entry.newLineNumber ?? '-'}:${index}`}
                          numberOfLines={2}
                          style={entry.kind === 'added' ? styles.diffAddedLine : styles.diffRemovedLine}
                        >
                          {entry.kind === 'added' ? '+' : '−'} {entry.text}
                        </Text>
                      ))}
                    </View>
                  ) : null}
                  {[...selectedArtifact.revisions].reverse().map((revision) => {
                    const active = revision.id === selectedArtifact.activeRevisionId;
                    return (
                      <View key={revision.id} style={styles.versionRow}>
                        <View style={styles.versionIcon}>
                          <Clock3 size={14} color={colors.secondary} strokeWidth={2} />
                        </View>
                        <View style={styles.versionText}>
                          <Text style={styles.versionTitle}>{formatTime(revision.createdAt)} · {revision.author === 'assistant' ? '模型生成' : '用户编辑'}</Text>
                          <Text style={styles.meta}>{revision.content.length} 字符{active ? ' · 当前版本' : ''}</Text>
                        </View>
                        {!active ? (
                          <Pressable
                            accessibilityRole="button"
                            disabled={readOnly}
                            onPress={() => confirmDiscard(
                              artifactDirty,
                              () => onRestoreArtifactRevision(selectedArtifact.id, revision.id)
                            )}
                            style={[styles.restoreButton, readOnly && styles.disabled]}
                          >
                            <RotateCcw size={14} color={colors.text} strokeWidth={2.1} />
                            <Text style={styles.restoreText}>恢复</Text>
                          </Pressable>
                        ) : <Check size={16} color={colors.text} strokeWidth={2.4} />}
                      </View>
                    );
                  })}
                </View>
              </>
            ) : (
              <View style={styles.emptyCard}>
                <FilePlus2 size={28} color={colors.secondary} strokeWidth={1.8} />
                <Text style={styles.emptyTitle}>还没有成果</Text>
                <Text style={styles.emptyText}>可以新建空白成果，也可以从模型回答的更多菜单保存。</Text>
              </View>
            )}
          </ScrollView>
        ) : (
          <ScrollView
            style={styles.body}
            contentContainerStyle={[styles.bodyContent, { paddingBottom: Math.max(28, insets.bottom + 20) }]}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.searchBox}>
              <Search size={16} color={colors.secondary} strokeWidth={2} />
              <TextInput
                value={knowledgeQuery}
                onChangeText={setKnowledgeQuery}
                placeholder="本机搜索资料标题和正文"
                placeholderTextColor={colors.secondary}
                style={styles.searchInput}
              />
            </View>
            <Text style={styles.meta}>
              {knowledgeQuery.trim()
                ? knowledgeQuery.normalize('NFKC').trim() !== deferredKnowledgeQuery
                  ? '正在准备有界本机索引…'
                  : `本机索引命中 ${filteredKnowledge.length} 条资料（最多显示 ${maxVisibleKnowledgeSources} 条）`
                : `按最近更新显示 ${Math.min(knowledgeSources.length, maxVisibleKnowledgeSources)} / ${knowledgeSources.length} 条；输入关键词可检索正文`}
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
              {filteredKnowledge.map((source) => (
                <Pressable
                  key={source.id}
                  accessibilityRole="button"
                  accessibilityLabel={`打开项目资料：${source.title}`}
                  accessibilityState={{ selected: source.id === selectedKnowledgeId }}
                  onPress={() => confirmDiscard(knowledgeDirty, () => setSelectedKnowledgeId(source.id))}
                  style={[styles.chip, source.id === selectedKnowledgeId && styles.chipActive]}
                >
                  <Text numberOfLines={1} style={[styles.chipText, source.id === selectedKnowledgeId && styles.chipTextActive]}>
                    {source.title}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>

            <View style={styles.card} testID="knowledge-create-card">
              <View style={styles.cardHeader}>
                <View>
                  <Text style={styles.cardTitle}>新增本地资料</Text>
                  <Text style={styles.meta}>首版支持文本、Markdown、JSON 与代码文件</Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  disabled={readOnly}
                  onPress={onImportTextKnowledge}
                  style={[styles.compactButton, readOnly && styles.disabled]}
                >
                  <FilePlus2 size={15} color={colors.text} strokeWidth={2.1} />
                  <Text style={styles.compactButtonText}>导入文本文件</Text>
                </Pressable>
              </View>
              <TextInput
                value={newKnowledgeTitle}
                editable={!readOnly}
                onChangeText={setNewKnowledgeTitle}
                placeholder="资料名称"
                placeholderTextColor={colors.secondary}
                style={styles.input}
              />
              <TextInput
                value={newKnowledgeContent}
                editable={!readOnly}
                onChangeText={setNewKnowledgeContent}
                multiline
                textAlignVertical="top"
                placeholder="粘贴项目背景、术语、需求或参考内容"
                placeholderTextColor={colors.secondary}
                style={styles.knowledgeEditor}
              />
              <Pressable
                accessibilityRole="button"
                disabled={readOnly || !newKnowledgeTitle.trim() || !newKnowledgeContent.trim()}
                onPress={() => {
                  createKnowledgeAndClearDraft(
                    onCreateKnowledge,
                    newKnowledgeTitle,
                    newKnowledgeContent,
                    () => setNewKnowledgeTitle(''),
                    () => setNewKnowledgeContent('')
                  );
                }}
                style={[styles.primaryButton, (readOnly || !newKnowledgeTitle.trim() || !newKnowledgeContent.trim()) && styles.disabled]}
              >
                <Plus size={16} color={colors.onAccent} strokeWidth={2.2} />
                <Text style={styles.primaryButtonText}>保存到当前项目</Text>
              </Pressable>
            </View>

            {selectedKnowledge ? (
              <View style={styles.card} testID="knowledge-editor-card">
                <View style={styles.cardHeader}>
                  <View>
                    <Text style={styles.cardTitle}>编辑资料</Text>
                    <Text style={styles.meta}>{selectedKnowledge.kind} · {selectedKnowledge.content.length} 字符</Text>
                  </View>
                  {knowledgeDirty ? <Text style={styles.unsavedBadge}>未保存</Text> : <Check size={18} color={colors.secondary} strokeWidth={2.4} />}
                </View>
                <TextInput
                  value={knowledgeTitle}
                  editable={!readOnly}
                  onChangeText={setKnowledgeTitle}
                  style={styles.input}
                />
                <TextInput
                  value={knowledgeContent}
                  editable={!readOnly}
                  onChangeText={setKnowledgeContent}
                  multiline
                  textAlignVertical="top"
                  style={styles.editor}
                />
                <Text style={styles.securityHint}>
                  资料会在你勾选后标记为“不可信参考数据”；模型仍可能受提示注入诱导，请勿选择密钥或敏感资料。
                </Text>
                <View style={styles.actionRow}>
                  <Pressable
                    accessibilityRole="button"
                    disabled={readOnly || !knowledgeDirty || !knowledgeTitle.trim() || !knowledgeContent.trim()}
                    onPress={() => onSaveKnowledge(selectedKnowledge.id, knowledgeTitle, knowledgeContent)}
                    style={[styles.primaryButton, (readOnly || !knowledgeDirty || !knowledgeTitle.trim() || !knowledgeContent.trim()) && styles.disabled]}
                  >
                    <Save size={16} color={colors.onAccent} strokeWidth={2.2} />
                    <Text style={styles.primaryButtonText}>保存资料</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    disabled={readOnly}
                    onPress={() => confirmDiscard(
                      knowledgeDirty,
                      () => onDeleteKnowledge(selectedKnowledge.id)
                    )}
                    style={[styles.dangerButton, readOnly && styles.disabled]}
                  >
                    <Trash2 size={16} color={colors.danger} strokeWidth={2.1} />
                    <Text style={styles.dangerButtonText}>删除</Text>
                  </Pressable>
                </View>
              </View>
            ) : null}
          </ScrollView>
        )}
      </SafeAreaView>
    </Modal>
  );
}

function createStyles(theme: KelivoTheme) {
  const colors = themeColors(theme);
  return StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: { minHeight: 64, paddingHorizontal: 18, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, flexDirection: 'row', alignItems: 'center' },
  headerText: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: 19, fontWeight: '700' },
  subtitle: { color: colors.secondary, fontSize: 12 },
  iconButton: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.surfaceAlt, alignItems: 'center', justifyContent: 'center' },
  tabs: { padding: 10, flexDirection: 'row', gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  tab: { flex: 1, minHeight: 42, borderRadius: 13, backgroundColor: colors.surfaceAlt, flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center' },
  tabActive: { backgroundColor: colors.accent },
  tabText: { color: colors.secondary, fontSize: 13, fontWeight: '700' },
  tabTextActive: { color: colors.onAccent },
  body: { flex: 1 },
  bodyContent: { padding: 16, gap: 12 },
  chipRow: { gap: 8, paddingRight: 12 },
  chip: { maxWidth: 180, minHeight: 36, paddingHorizontal: 12, borderRadius: 12, backgroundColor: colors.surfaceAlt, justifyContent: 'center' },
  chipActive: { backgroundColor: colors.accent },
  chipText: { color: colors.secondary, fontSize: 12, fontWeight: '600' },
  chipTextActive: { color: colors.onAccent },
  addChip: { minHeight: 36, paddingHorizontal: 12, borderRadius: 12, backgroundColor: colors.surfaceStrong, flexDirection: 'row', gap: 5, alignItems: 'center' },
  addChipText: { color: colors.text, fontSize: 12, fontWeight: '700' },
  card: { padding: 15, borderRadius: 18, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, gap: 12 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  cardTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  meta: { color: colors.secondary, fontSize: 11, marginTop: 2 },
  unsavedBadge: { color: colors.text, fontSize: 10, backgroundColor: colors.surfaceAlt, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999, overflow: 'hidden' },
  input: { minHeight: 44, borderRadius: 12, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, color: colors.text, fontSize: 14 },
  editor: { minHeight: 260, maxHeight: 520, borderRadius: 13, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border, padding: 12, color: colors.text, fontSize: 14, lineHeight: 21 },
  knowledgeEditor: { minHeight: 120, maxHeight: 260, borderRadius: 13, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border, padding: 12, color: colors.text, fontSize: 14, lineHeight: 21 },
  securityHint: { color: colors.secondary, fontSize: 11, lineHeight: 17 },
  actionRow: { flexDirection: 'row', gap: 8 },
  primaryButton: { flex: 1.35, minHeight: 44, borderRadius: 13, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 7 },
  primaryButtonText: { color: colors.onAccent, fontWeight: '700', fontSize: 13 },
  secondaryButton: { flex: 1, minHeight: 44, borderRadius: 13, backgroundColor: colors.surfaceAlt, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 7 },
  secondaryButtonText: { color: colors.text, fontWeight: '700', fontSize: 13 },
  dangerButton: { flex: 1, minHeight: 44, borderRadius: 13, backgroundColor: '#FEF2F2', alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 7 },
  dangerButtonText: { color: colors.danger, fontWeight: '700', fontSize: 13 },
  versionRow: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  diffPanel: { padding: 10, borderRadius: 12, backgroundColor: colors.background, gap: 4 },
  diffSummary: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  diffAdded: { color: '#15803D', fontSize: 12, fontWeight: '700' },
  diffRemoved: { color: '#B91C1C', fontSize: 12, fontWeight: '700' },
  diffAddedLine: { color: '#166534', fontSize: 11, lineHeight: 16, fontFamily: 'monospace' },
  diffRemovedLine: { color: '#991B1B', fontSize: 11, lineHeight: 16, fontFamily: 'monospace' },
  versionIcon: { width: 30, height: 30, borderRadius: 10, backgroundColor: colors.surfaceAlt, alignItems: 'center', justifyContent: 'center' },
  versionText: { flex: 1 },
  versionTitle: { color: colors.text, fontSize: 12, fontWeight: '600' },
  restoreButton: { minHeight: 32, paddingHorizontal: 9, borderRadius: 10, backgroundColor: colors.surfaceAlt, flexDirection: 'row', gap: 5, alignItems: 'center' },
  restoreText: { color: colors.text, fontSize: 11, fontWeight: '700' },
  emptyCard: { minHeight: 240, borderRadius: 18, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24 },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  emptyText: { color: colors.secondary, fontSize: 12, lineHeight: 18, textAlign: 'center' },
  searchBox: { minHeight: 44, borderRadius: 13, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
  searchInput: { flex: 1, color: colors.text, fontSize: 13 },
  compactButton: { minHeight: 34, paddingHorizontal: 10, borderRadius: 10, backgroundColor: colors.surfaceAlt, flexDirection: 'row', gap: 5, alignItems: 'center' },
  compactButtonText: { color: colors.text, fontSize: 11, fontWeight: '700' },
  disabled: { opacity: 0.42 },
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

function themeColors(theme: KelivoTheme) {
  return {
    background: theme.colors.surface,
    surface: theme.colors.card,
    surfaceAlt: theme.colors.surfaceAlt,
    surfaceStrong: theme.colors.surfaceSunken,
    text: theme.colors.text,
    secondary: theme.colors.textSecondary,
    border: theme.colors.outline,
    accent: theme.colors.primary,
    danger: theme.colors.error,
    dangerBackground: theme.colors.errorContainer,
    warning: theme.colors.warning,
    warningBackground: theme.colors.warningContainer,
    onAccent: theme.colors.onPrimary,
    codeBg: theme.dark ? '#0E1015' : '#161616',
    codeText: theme.dark ? '#E5E7EF' : '#F2F2F2',
  } as const;
}
