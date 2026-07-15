import { Check, FileText, LoaderCircle, X } from 'lucide-react-native';
import { useMemo } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { KnowledgeImportDraft, KnowledgeImportSection } from '../services/documentImport';
import { useKelivoTheme } from '../ui/theme';

export interface KnowledgeImportPreviewProps {
  visible: boolean;
  draft: KnowledgeImportDraft | null;
  busy?: boolean;
  error?: string;
  ocrBusySectionId?: string | null;
  onChangeDraft: (draft: KnowledgeImportDraft) => void;
  onRequestOcr?: (section: KnowledgeImportSection) => void | Promise<void>;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}

export function KnowledgeImportPreview({
  visible,
  draft,
  busy = false,
  error,
  ocrBusySectionId,
  onChangeDraft,
  onRequestOcr,
  onConfirm,
  onClose,
}: KnowledgeImportPreviewProps): React.ReactElement | null {
  const theme = useKelivoTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(theme), [theme]);
  if (!visible || !draft) return null;

  const selectedCount = draft.selectedSectionIds.length;
  const canConfirm = selectedCount > 0 && draft.sections.some((section) => section.selected && section.content.trim());
  const toggleAll = (selected: boolean) => {
    onChangeDraft({
      ...draft,
      sections: draft.sections.map((section) => ({ ...section, selected })),
      selectedSectionIds: selected ? draft.sections.map((section) => section.id) : [],
    });
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.scrim}>
        <SafeAreaView style={styles.sheet}>
          <View style={styles.header}>
            <View style={styles.headerIcon}><FileText size={20} color={theme.colors.primary} strokeWidth={2.2} /></View>
            <View style={styles.headerCopy}>
              <Text style={styles.title}>预览并导入资料</Text>
              <Text numberOfLines={2} style={styles.subtitle}>{draft.fileName} · {draft.sections.length} 个分段</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="关闭资料导入预览" onPress={onClose} style={styles.closeButton}>
              <X size={20} color={theme.colors.textSecondary} strokeWidth={2.2} />
            </Pressable>
          </View>

          <ScrollView style={styles.body} contentContainerStyle={[styles.bodyContent, { paddingBottom: Math.max(24, insets.bottom + 18) }]}>
            <TextInput
              value={draft.title}
              onChangeText={(title) => {
                onChangeDraft({ ...draft, title });
              }}
              editable={!busy}
              placeholder="资料标题"
              placeholderTextColor={theme.colors.placeholder}
              style={styles.input}
            />
            {draft.warnings.map((warning) => <Text key={warning} style={styles.warning}>{warning}</Text>)}
            {draft.status !== 'ready' ? (
              <View style={styles.noticeCard}>
                <Text style={styles.noticeTitle}>{draft.status === 'needs-local-ocr' ? '需要本机 OCR' : draft.status === 'needs-provider-ocr' ? '需要显式选择服务商 OCR' : '当前平台暂不支持直接解析'}</Text>
                <Text style={styles.noticeText}>{draft.providerOcrReason ?? '请先完成可用的 OCR 或选择其他文件。不会在预览阶段自动上传。'}</Text>
              </View>
            ) : null}
            <View style={styles.toolbar}>
              <Text style={styles.selectionText}>已选 {selectedCount} / {draft.sections.length}</Text>
              <Pressable accessibilityRole="button" disabled={busy} onPress={() => toggleAll(selectedCount !== draft.sections.length)} style={styles.smallButton}>
                <Text style={styles.smallButtonText}>{selectedCount === draft.sections.length ? '取消全选' : '全选'}</Text>
              </Pressable>
            </View>
            {draft.sections.map((section) => (
              <View key={section.id} style={styles.sectionCard}>
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: section.selected, disabled: busy }}
                  disabled={busy}
                  onPress={() => onChangeDraft({
                    ...draft,
                    sections: draft.sections.map((candidate) => candidate.id === section.id ? { ...candidate, selected: !candidate.selected } : candidate),
                    selectedSectionIds: draft.sections.filter((candidate) => candidate.id === section.id ? !candidate.selected : candidate.selected).map((candidate) => candidate.id),
                  })}
                  style={styles.sectionHeader}
                >
                  <View style={[styles.checkbox, section.selected && styles.checkboxSelected]}>{section.selected ? <Check size={15} color={theme.colors.textOnAccent} strokeWidth={2.6} /> : null}</View>
                  <View style={styles.sectionHeadingCopy}>
                    <Text numberOfLines={1} style={styles.sectionLabel}>{section.label}</Text>
                    <Text style={styles.sectionMeta}>{section.kind} · {section.characterCount.toLocaleString()} 字符</Text>
                  </View>
                </Pressable>
                <Text numberOfLines={5} style={styles.sectionText}>{section.content || '暂无文字，需要 OCR。'}</Text>
                {!section.content.trim() && onRequestOcr ? (
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy || ocrBusySectionId === section.id}
                    onPress={() => void onRequestOcr(section)}
                    style={styles.ocrButton}
                  >
                    {ocrBusySectionId === section.id ? <ActivityIndicator size="small" color={theme.colors.primary} /> : <LoaderCircle size={16} color={theme.colors.primary} strokeWidth={2.1} />}
                    <Text style={styles.ocrButtonText}>{ocrBusySectionId === section.id ? 'OCR 中…' : '请求本机 OCR'}</Text>
                  </Pressable>
                ) : null}
              </View>
            ))}
            {error ? <Text accessibilityLiveRegion="assertive" style={styles.error}>{error}</Text> : null}
            <Pressable
              accessibilityRole="button"
              disabled={busy || !canConfirm}
              onPress={() => void onConfirm()}
              style={[styles.confirmButton, (busy || !canConfirm) && styles.disabled]}
            >
              {busy ? <ActivityIndicator size="small" color={theme.colors.textOnAccent} /> : null}
              <Text style={styles.confirmText}>{busy ? '正在保存…' : '保存选中资料'}</Text>
            </Pressable>
          </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

function createStyles(theme: ReturnType<typeof useKelivoTheme>) {
  return StyleSheet.create({
    scrim: { flex: 1, justifyContent: 'flex-end', backgroundColor: theme.colors.scrim },
    sheet: { maxHeight: '94%', borderTopLeftRadius: 26, borderTopRightRadius: 26, backgroundColor: theme.colors.card, borderWidth: 0.8, borderColor: theme.colors.outline },
    header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18, paddingTop: 14, paddingBottom: 10 },
    headerIcon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.primaryContainer },
    headerCopy: { flex: 1, minWidth: 0 },
    title: { color: theme.colors.text, fontSize: 18, lineHeight: 24, fontWeight: '800' },
    subtitle: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 18 },
    closeButton: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surfaceSunken },
    body: { flexShrink: 1 },
    bodyContent: { paddingHorizontal: 18, gap: 10 },
    input: { minHeight: 46, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.outline, color: theme.colors.text, backgroundColor: theme.colors.surface, paddingHorizontal: 12, fontSize: 14 },
    warning: { color: theme.colors.warning, fontSize: 12, lineHeight: 18 },
    noticeCard: { borderRadius: 14, padding: 12, backgroundColor: theme.colors.surfaceSunken, borderWidth: 1, borderColor: theme.colors.outline },
    noticeTitle: { color: theme.colors.text, fontSize: 13, fontWeight: '800' },
    noticeText: { marginTop: 4, color: theme.colors.textSecondary, fontSize: 12, lineHeight: 18 },
    toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    selectionText: { color: theme.colors.textSecondary, fontSize: 12, fontWeight: '700' },
    smallButton: { minHeight: 40, paddingHorizontal: 12, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surfaceSunken },
    smallButtonText: { color: theme.colors.primary, fontSize: 12, fontWeight: '800' },
    sectionCard: { borderRadius: 14, borderWidth: 1, borderColor: theme.colors.outline, backgroundColor: theme.colors.surface, padding: 11, gap: 8 },
    sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 9, minHeight: 44 },
    checkbox: { width: 24, height: 24, borderRadius: 7, borderWidth: 1.2, borderColor: theme.colors.outline, alignItems: 'center', justifyContent: 'center' },
    checkboxSelected: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
    sectionHeadingCopy: { flex: 1, minWidth: 0 },
    sectionLabel: { color: theme.colors.text, fontSize: 13, fontWeight: '800' },
    sectionMeta: { marginTop: 2, color: theme.colors.textSecondary, fontSize: 11 },
    sectionText: { color: theme.colors.text, fontSize: 13, lineHeight: 19 },
    ocrButton: { minHeight: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.primary },
    ocrButtonText: { color: theme.colors.primary, fontSize: 12, fontWeight: '800' },
    error: { color: theme.colors.error, fontSize: 12, lineHeight: 18 },
    confirmButton: { minHeight: 50, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: theme.colors.primary, paddingHorizontal: 16 },
    confirmText: { color: theme.colors.textOnAccent, fontSize: 14, fontWeight: '800' },
    disabled: { opacity: 0.48 },
  });
}
