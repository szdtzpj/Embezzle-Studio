import { useState } from 'react';
import {
  ArrowLeft,
  Boxes,
  Eye,
  EyeOff,
  Plus,
  Search,
  Settings2,
  Trash2,
  X,
} from 'lucide-react-native';
import {
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { CandidateModelRow } from '../../components/CandidateModelRow';
import { ModelAvatar } from '../../components/ModelAvatar';
import { ModelManageRow } from '../../components/ModelManageRow';
import { MotionItem, MotionPresence, MotionSwap, MotionSwitch } from '../../components/Motion';
import { useKelivoTheme, type KelivoTheme } from '../../theme';
import { inferModelTask } from '../../../services/modelCapabilities';
import type { Capability, ModelInfo, ModelTask, ProviderProfile } from '../../../domain/types';
import type { ModelCapabilityFilter } from '../../../services/modelCapabilities';
import { modelTaskLabel } from '../../utils/modelDisplay';

export interface ProviderDetailScreenProps {
  readOnly: boolean;
  provider: ProviderProfile;
  activeModel?: ModelInfo;
  activeModelId: string;
  addedModels: ModelInfo[];
  addedModelIds: Set<string>;
  modelCandidates: ModelInfo[];
  filteredModelCandidates: ModelInfo[];
  modelSearchQuery: string;
  modelCapabilityFilter: ModelCapabilityFilter;
  candidateModelFilters: Array<{ key: ModelCapabilityFilter; label: string }>;
  manualModelId: string;
  refreshingModels: boolean;
  configurableModelTasks: ModelTask[];
  configurableModelCapabilities: Array<{ key: Capability; label: string }>;
  notice: string;
  onBack: () => void;
  onUpdateProvider: (patch: Partial<ProviderProfile>) => void;
  onRefreshModels: () => void;
  onSetModelSearchQuery: (query: string) => void;
  onSetModelCapabilityFilter: (filter: ModelCapabilityFilter) => void;
  onAddCandidateModel: (model: ModelInfo) => void;
  onClearCandidates: () => void;
  onSetManualModelId: (id: string) => void;
  onAddManualModel: () => void;
  onSelectModel: (modelId: string) => void;
  onRemoveModel: (modelId: string) => void;
  onSetActiveModelTask: (task: ModelTask) => void;
  onToggleActiveModelCapability: (capability: Capability) => void;
  onDeleteProvider?: () => void;
}

export function ProviderDetailScreen({
  readOnly,
  provider,
  activeModel,
  activeModelId,
  addedModels,
  addedModelIds,
  modelCandidates,
  filteredModelCandidates,
  modelSearchQuery,
  modelCapabilityFilter,
  candidateModelFilters,
  manualModelId,
  refreshingModels,
  configurableModelTasks,
  configurableModelCapabilities,
  notice,
  onBack,
  onUpdateProvider,
  onRefreshModels,
  onSetModelSearchQuery,
  onSetModelCapabilityFilter,
  onAddCandidateModel,
  onClearCandidates,
  onSetManualModelId,
  onAddManualModel,
  onSelectModel,
  onRemoveModel,
  onSetActiveModelTask,
  onToggleActiveModelCapability,
  onDeleteProvider,
}: ProviderDetailScreenProps) {
  const theme = useKelivoTheme();
  const styles = getStyles(theme);
  const [tab, setTab] = useState<'config' | 'models'>('config');
  const [tabDirection, setTabDirection] =
    useState<'forward' | 'backward' | 'none'>('none');
  const [showKey, setShowKey] = useState(false);

  const selectTab = (nextTab: 'config' | 'models') => {
    if (nextTab === tab) {
      return;
    }
    setTabDirection(nextTab === 'models' ? 'forward' : 'backward');
    setTab(nextTab);
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <AnimatedPressable accessibilityRole="button" onPress={onBack} style={styles.headerButton}>
          <ArrowLeft size={22} color={theme.colors.text} strokeWidth={2.2} />
        </AnimatedPressable>
        <View style={styles.headerTitleBlock}>
          <ModelAvatar
            modelId={undefined}
            providerName={provider.name}
            size={20}
            containerSize={28}
          />
          <Text style={styles.headerTitle} numberOfLines={1}>{provider.name}</Text>
        </View>
        <View style={styles.headerActions}>
          {onDeleteProvider ? (
            <AnimatedPressable
              accessibilityRole="button"
              accessibilityState={{ disabled: readOnly }}
              disabled={readOnly}
              onPress={onDeleteProvider}
              style={styles.headerButton}
            >
              <Trash2 size={20} color={theme.colors.error} strokeWidth={2.2} />
            </AnimatedPressable>
          ) : (
            <View style={styles.headerButton} />
          )}
        </View>
      </View>

      <MotionPresence
        visible={Boolean(notice)}
        direction="down"
        distance={6}
        style={styles.noticeWrap}
      >
        <View accessibilityLiveRegion="polite" style={styles.noticeCard}>
          <Text style={styles.noticeText}>{notice}</Text>
        </View>
      </MotionPresence>

      <MotionSwitch
        motionKey={tab}
        direction={tabDirection}
        distance={14}
        duration={190}
        style={styles.body}
      >
        {tab === 'config' ? (
          <ConfigTab
            readOnly={readOnly}
            provider={provider}
            showKey={showKey}
            onToggleShowKey={() => setShowKey((v) => !v)}
            onUpdateProvider={onUpdateProvider}
          />
        ) : (
          <ModelsTab
            readOnly={readOnly}
            providerName={provider.name}
            activeModel={activeModel}
            activeModelId={activeModelId}
            addedModels={addedModels}
            addedModelIds={addedModelIds}
            modelCandidates={modelCandidates}
            filteredModelCandidates={filteredModelCandidates}
            modelSearchQuery={modelSearchQuery}
            modelCapabilityFilter={modelCapabilityFilter}
            candidateModelFilters={candidateModelFilters}
            manualModelId={manualModelId}
            refreshingModels={refreshingModels}
            configurableModelTasks={configurableModelTasks}
            configurableModelCapabilities={configurableModelCapabilities}
            onRefreshModels={onRefreshModels}
            onSetModelSearchQuery={onSetModelSearchQuery}
            onSetModelCapabilityFilter={onSetModelCapabilityFilter}
            onAddCandidateModel={onAddCandidateModel}
            onClearCandidates={onClearCandidates}
            onSetManualModelId={onSetManualModelId}
            onAddManualModel={onAddManualModel}
            onSelectModel={onSelectModel}
            onRemoveModel={onRemoveModel}
            onSetActiveModelTask={onSetActiveModelTask}
            onToggleActiveModelCapability={onToggleActiveModelCapability}
          />
        )}
      </MotionSwitch>

      <View style={styles.bottomTabs}>
        <TabButton
          icon={<Settings2 size={18} color={tab === 'config' ? theme.colors.primary : theme.colors.textSecondary} strokeWidth={2} />}
          label="配置"
          active={tab === 'config'}
          onPress={() => selectTab('config')}
        />
        <TabButton
          icon={<Boxes size={18} color={tab === 'models' ? theme.colors.primary : theme.colors.textSecondary} strokeWidth={2} />}
          label="模型"
          active={tab === 'models'}
          onPress={() => selectTab('models')}
        />
      </View>
    </View>
  );
}

function TabButton({
  icon,
  label,
  active,
  onPress,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const theme = useKelivoTheme();
  const styles = getStyles(theme);

  return (
    <AnimatedPressable
      accessibilityRole="button"
      onPress={onPress}
      haptic="selection"
      style={styles.tabButton}
    >
      <MotionSwap
        motionKey={active ? 'active' : 'idle'}
        style={styles.tabButtonSwap}
        contentStyle={styles.tabButtonContent}
      >
        {icon}
        <Text
          style={[
            styles.tabLabel,
            active && styles.tabLabelActive,
          ]}
        >
          {label}
        </Text>
      </MotionSwap>
    </AnimatedPressable>
  );
}

function ConfigTab({
  readOnly,
  provider,
  showKey,
  onToggleShowKey,
  onUpdateProvider,
}: {
  readOnly: boolean;
  provider: ProviderProfile;
  showKey: boolean;
  onToggleShowKey: () => void;
  onUpdateProvider: (patch: Partial<ProviderProfile>) => void;
}) {
  const theme = useKelivoTheme();
  const styles = getStyles(theme);

  return (
    <ScrollView
      style={styles.tabContent}
      contentContainerStyle={styles.tabContentInner}
      showsVerticalScrollIndicator={false}
    >
      <MotionItem index={0} distance={8}>
        <Text style={styles.sectionLabel}>管理</Text>
        <View style={styles.card}>
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>名称</Text>
            <TextInput
              editable={!readOnly}
              value={provider.name}
              onChangeText={(name) => onUpdateProvider({ name })}
              style={styles.input}
              placeholder="Provider name"
              placeholderTextColor={theme.colors.textTertiary}
            />
          </View>
        </View>
      </MotionItem>

      <MotionItem index={1} distance={8} style={styles.card}>
        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>API Key</Text>
          <View style={styles.keyInputWrap}>
            <TextInput
              autoCapitalize="none"
              editable={!readOnly}
              secureTextEntry={!showKey}
              value={provider.apiKey ?? ''}
              onChangeText={(apiKey) => onUpdateProvider({ apiKey })}
              style={[styles.input, styles.keyInput]}
              placeholder="留空则使用上层默认"
              placeholderTextColor={theme.colors.textTertiary}
            />
            <AnimatedPressable
              accessibilityRole="button"
              accessibilityState={{ disabled: readOnly }}
              disabled={readOnly}
              onPress={onToggleShowKey}
              style={styles.eyeButton}
            >
              <MotionSwap
                motionKey={showKey ? 'visible' : 'hidden'}
                style={styles.eyeIconSwap}
              >
                {showKey ? (
                  <EyeOff size={18} color={theme.colors.textSecondary} strokeWidth={2} />
                ) : (
                  <Eye size={18} color={theme.colors.textSecondary} strokeWidth={2} />
                )}
              </MotionSwap>
            </AnimatedPressable>
          </View>
          {Platform.OS === 'web' ? (
            <Text style={styles.inputHint}>
              Web 端仅在当前标签页会话中保存密钥；Android 使用系统安全存储。
            </Text>
          ) : null}
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>API Base URL</Text>
          <TextInput
            autoCapitalize="none"
            editable={!readOnly}
            value={provider.baseUrl}
            onChangeText={(baseUrl) => onUpdateProvider({ baseUrl })}
            style={styles.input}
            placeholder="https://api.example.com/v1"
            placeholderTextColor={theme.colors.textTertiary}
          />
        </View>
      </MotionItem>
    </ScrollView>
  );
}

function ModelsTab({
  readOnly,
  providerName,
  activeModel,
  activeModelId,
  addedModels,
  addedModelIds,
  modelCandidates,
  filteredModelCandidates,
  modelSearchQuery,
  modelCapabilityFilter,
  candidateModelFilters,
  manualModelId,
  refreshingModels,
  configurableModelTasks,
  configurableModelCapabilities,
  onSetModelSearchQuery,
  onSetModelCapabilityFilter,
  onAddCandidateModel,
  onClearCandidates,
  onSetManualModelId,
  onAddManualModel,
  onRefreshModels,
  onSelectModel,
  onRemoveModel,
  onSetActiveModelTask,
  onToggleActiveModelCapability,
}: {
  readOnly: boolean;
  providerName: string;
  activeModel?: ModelInfo;
  activeModelId: string;
  addedModels: ModelInfo[];
  addedModelIds: Set<string>;
  modelCandidates: ModelInfo[];
  filteredModelCandidates: ModelInfo[];
  modelSearchQuery: string;
  modelCapabilityFilter: ModelCapabilityFilter;
  candidateModelFilters: Array<{ key: ModelCapabilityFilter; label: string }>;
  manualModelId: string;
  refreshingModels: boolean;
  configurableModelTasks: ModelTask[];
  configurableModelCapabilities: Array<{ key: Capability; label: string }>;
  onSetModelSearchQuery: (query: string) => void;
  onSetModelCapabilityFilter: (filter: ModelCapabilityFilter) => void;
  onAddCandidateModel: (model: ModelInfo) => void;
  onClearCandidates: () => void;
  onSetManualModelId: (id: string) => void;
  onAddManualModel: () => void;
  onRefreshModels: () => void;
  onSelectModel: (modelId: string) => void;
  onRemoveModel: (modelId: string) => void;
  onSetActiveModelTask: (task: ModelTask) => void;
  onToggleActiveModelCapability: (capability: Capability) => void;
}) {
  const theme = useKelivoTheme();
  const styles = getStyles(theme);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showManualInput, setShowManualInput] = useState(false);

  const toggleSelect = (id: string) => {
    if (readOnly) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleDelete = () => {
    if (readOnly || selectedIds.size === 0) return;
    selectedIds.forEach((id) => onRemoveModel(id));
    setSelectedIds(new Set());
  };

  const handleAddManual = () => {
    if (readOnly || !manualModelId.trim()) return;
    onAddManualModel();
    setShowManualInput(false);
  };

  const hasModels = addedModels.length > 0;
  const hasCandidates = modelCandidates.length > 0;

  return (
    <View style={styles.tabContent}>
      <ScrollView
        contentContainerStyle={[
          styles.tabContentInner,
          (!hasModels && !hasCandidates) && styles.tabContentCenter,
        ]}
        showsVerticalScrollIndicator={false}
      >
        {hasModels ? (
          <View style={styles.card}>
            <Text style={styles.sectionLabel}>已添加模型</Text>
            <View style={styles.listGap}>
              {addedModels.map((model, index) => (
                <MotionItem key={model.id} index={index} distance={6} duration={220}>
                  <ModelManageRow
                    model={model}
                    providerName={providerName}
                    active={model.id === activeModelId}
                    selected={selectedIds.has(model.id)}
                    disabled={readOnly}
                    onActivate={() => onSelectModel(model.id)}
                    onToggleSelect={() => toggleSelect(model.id)}
                  />
                </MotionItem>
              ))}
            </View>
          </View>
        ) : null}

        {activeModel ? (
          <View style={styles.card}>
            <Text style={styles.sectionLabel}>当前模型覆盖</Text>
            <Text style={styles.inputHint}>
              仅在自动识别不准确时修改；用途和能力会随模型配置保存。
            </Text>
            <Text style={styles.inputLabel}>用途</Text>
            <View style={styles.optionGrid}>
              {configurableModelTasks.map((task) => {
                const selected = inferModelTask(activeModel) === task;
                return (
                  <AnimatedPressable
                    key={task}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: readOnly, selected }}
                    disabled={readOnly}
                    onPress={() => onSetActiveModelTask(task)}
                    style={[styles.filterChip, selected && styles.filterChipActive]}
                  >
                    <Text style={[styles.filterChipText, selected && styles.filterChipTextActive]}>
                      {modelTaskLabel[task]}
                    </Text>
                  </AnimatedPressable>
                );
              })}
            </View>
            <Text style={styles.inputLabel}>能力</Text>
            <View style={styles.optionGrid}>
              {configurableModelCapabilities.map((capability) => {
                const selected = activeModel.capabilities.includes(capability.key);
                return (
                  <AnimatedPressable
                    key={capability.key}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: selected, disabled: readOnly }}
                    disabled={readOnly}
                    onPress={() => onToggleActiveModelCapability(capability.key)}
                    style={[styles.filterChip, selected && styles.filterChipActive]}
                  >
                    <Text style={[styles.filterChipText, selected && styles.filterChipTextActive]}>
                      {capability.label}
                    </Text>
                  </AnimatedPressable>
                );
              })}
            </View>
          </View>
        ) : null}

        {hasCandidates ? (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.sectionLabel}>可添加模型</Text>
              <AnimatedPressable
                accessibilityRole="button"
                accessibilityState={{ disabled: readOnly }}
                disabled={readOnly}
                onPress={onClearCandidates}
                style={styles.iconButton}
              >
                <X size={16} color={theme.colors.textSecondary} strokeWidth={2} />
              </AnimatedPressable>
            </View>

            <View style={styles.searchRow}>
              <Search size={16} color={theme.colors.textTertiary} strokeWidth={2} />
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="搜索模型名称或 ID"
                placeholderTextColor={theme.colors.textTertiary}
                value={modelSearchQuery}
                onChangeText={onSetModelSearchQuery}
                style={styles.searchInput}
              />
              {modelSearchQuery ? (
                <AnimatedPressable
                  accessibilityRole="button"
                  onPress={() => onSetModelSearchQuery('')}
                  style={styles.clearButton}
                >
                  <X size={14} color={theme.colors.textTertiary} strokeWidth={2} />
                </AnimatedPressable>
              ) : null}
            </View>

            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.filterRow}
            >
              {candidateModelFilters.map((filter) => {
                const active = filter.key === modelCapabilityFilter;
                return (
                  <AnimatedPressable
                    key={filter.key}
                    accessibilityRole="button"
                    onPress={() => onSetModelCapabilityFilter(filter.key)}
                    haptic="selection"
                    style={[styles.filterChip, active && styles.filterChipActive]}
                  >
                    <Text
                      style={[
                        styles.filterChipText,
                        active && styles.filterChipTextActive,
                      ]}
                    >
                      {filter.label}
                    </Text>
                  </AnimatedPressable>
                );
              })}
            </ScrollView>

            <Text style={styles.countText}>
              显示 {filteredModelCandidates.length} / {modelCandidates.length}
            </Text>

            <View style={styles.listGap}>
              {filteredModelCandidates.map((model, index) => (
                <MotionItem key={model.id} index={index} distance={6} duration={220}>
                  <CandidateModelRow
                    model={model}
                    providerName={providerName}
                    added={addedModelIds.has(model.id)}
                    disabled={readOnly}
                    onAdd={() => onAddCandidateModel(model)}
                  />
                </MotionItem>
              ))}
              {!filteredModelCandidates.length ? (
                <View style={styles.emptyCard}>
                  <Text style={styles.emptyCardText}>没有匹配的模型</Text>
                </View>
              ) : null}
            </View>
          </View>
        ) : null}

        {!hasModels && !hasCandidates ? (
          <MotionItem distance={8} scaleFrom={0.98} style={styles.emptyContainer}>
            <Text style={styles.emptyTitle}>暂无模型</Text>
            <Text style={styles.emptySubtitle}>点击下方按钮添加模型</Text>
          </MotionItem>
        ) : null}
      </ScrollView>

      <MotionPresence
        visible={showManualInput}
        direction="up"
        distance={10}
        style={styles.manualInputBar}
      >
        <TextInput
          autoCapitalize="none"
          editable={!readOnly}
          placeholder="手动输入模型 ID"
          placeholderTextColor={theme.colors.textTertiary}
          value={manualModelId}
          onChangeText={onSetManualModelId}
          style={styles.manualInputBarInput}
          autoFocus
        />
        <AnimatedPressable
          accessibilityRole="button"
          accessibilityState={{ disabled: readOnly }}
          disabled={readOnly}
          onPress={handleAddManual}
          style={styles.manualInputBarButton}
        >
          <Text style={styles.manualInputBarButtonText}>添加</Text>
        </AnimatedPressable>
      </MotionPresence>

      <View style={styles.bottomActionBar}>
        <AnimatedPressable
          accessibilityRole="button"
          accessibilityLabel={refreshingModels ? '正在获取模型' : '获取模型'}
          accessibilityState={{ disabled: readOnly || refreshingModels, busy: refreshingModels }}
          disabled={readOnly || refreshingModels}
          onPress={onRefreshModels}
          style={styles.bottomAction}
        >
          <Boxes size={16} color={theme.colors.primary} strokeWidth={2} />
          <Text style={styles.bottomActionText}>{refreshingModels ? '获取中' : '获取'}</Text>
        </AnimatedPressable>
        <AnimatedPressable
          accessibilityRole="button"
          accessibilityState={{ disabled: readOnly }}
          disabled={readOnly}
          onPress={() => setShowManualInput((v) => !v)}
          style={styles.bottomAction}
        >
          <Plus size={16} color={theme.colors.primary} strokeWidth={2} />
          <Text style={styles.bottomActionText}>添加新...</Text>
        </AnimatedPressable>
        <AnimatedPressable
          accessibilityRole="button"
          disabled={readOnly || selectedIds.size === 0}
          onPress={handleDelete}
          style={[
            styles.bottomAction,
            (readOnly || selectedIds.size === 0) && styles.bottomActionDisabled,
          ]}
        >
          <Trash2 size={16} color={selectedIds.size === 0 ? theme.colors.textTertiary : theme.colors.error} strokeWidth={2} />
          <Text
            style={[
              styles.bottomActionText,
              selectedIds.size === 0 && styles.bottomActionTextDisabled,
            ]}
          >
            删除
          </Text>
        </AnimatedPressable>
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
  headerTitleBlock: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 8,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: theme.colors.text,
    maxWidth: 200,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  body: {
    flex: 1,
  },
  noticeWrap: {
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  noticeCard: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.warningBorder,
    backgroundColor: theme.colors.warningContainer,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  noticeText: {
    color: theme.colors.warning,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '500',
  },
  tabContent: {
    flex: 1,
  },
  tabContentInner: {
    padding: 12,
    paddingBottom: 24,
    gap: 12,
  },
  sectionLabel: {
    fontSize: 13,
    color: theme.colors.textSecondary,
    fontWeight: '600',
    marginLeft: 2,
    marginBottom: 4,
  },
  card: {
    backgroundColor: theme.colors.card,
    borderRadius: 12,
    borderWidth: 0.6,
    borderColor: theme.colors.outlineVariant,
    padding: 12,
    gap: 12,
    ...theme.shadows.soft,
  },
  inputGroup: {
    gap: 6,
  },
  inputLabel: {
    fontSize: 13,
    color: theme.colors.textSecondary,
    fontWeight: '600',
  },
  input: {
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.outline,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 12,
    color: theme.colors.text,
    fontSize: 15,
  },
  keyInputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.outline,
    backgroundColor: theme.colors.surface,
    paddingRight: 4,
  },
  keyInput: {
    flex: 1,
    borderWidth: 0,
    backgroundColor: 'transparent',
  },
  inputHint: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
  eyeButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  eyeIconSwap: {
    width: 18,
    height: 18,
  },
  secondaryButton: {
    height: 40,
    paddingHorizontal: 16,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.outline,
    backgroundColor: theme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: {
    color: theme.colors.text,
    fontWeight: '600',
    fontSize: 14,
  },
  manualRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  manualInput: {
    flex: 1,
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.outline,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 12,
    color: theme.colors.text,
    fontSize: 15,
  },
  listGap: {
    gap: 8,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  iconButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.outline,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 12,
    minHeight: 44,
  },
  searchInput: {
    flex: 1,
    color: theme.colors.text,
    fontSize: 15,
    minHeight: 42,
  },
  clearButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterRow: {
    gap: 8,
    paddingRight: 12,
    paddingVertical: 2,
  },
  optionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  filterChip: {
    height: 32,
    paddingHorizontal: 14,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.outline,
    backgroundColor: theme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterChipActive: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  filterChipText: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  filterChipTextActive: {
    color: theme.colors.textOnAccent,
  },
  countText: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  emptyCard: {
    minHeight: 70,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.outline,
    backgroundColor: theme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyCardText: {
    color: theme.colors.textTertiary,
    fontSize: 13,
    fontWeight: '600',
  },
  emptyContent: {
    flexGrow: 1,
    padding: 12,
    paddingBottom: 24,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 8,
    minHeight: 400,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: theme.colors.text,
  },
  emptySubtitle: {
    fontSize: 13,
    color: theme.colors.primary,
    fontWeight: '500',
  },
  emptyActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 16,
  },
  emptyManualRow: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
    marginTop: 12,
    width: '100%',
  },
  emptyManualInput: {
    flex: 1,
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.outline,
    backgroundColor: theme.colors.card,
    paddingHorizontal: 12,
    color: theme.colors.text,
    fontSize: 15,
  },
  emptyActionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 40,
    paddingHorizontal: 18,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.card,
  },
  emptyActionButtonPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 40,
    paddingHorizontal: 18,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.primary,
  },
  emptyActionText: {
    fontSize: 14,
    fontWeight: '600',
    color: theme.colors.primary,
  },
  emptyActionTextPrimary: {
    fontSize: 14,
    fontWeight: '600',
    color: theme.colors.textOnAccent,
  },
  bottomTabs: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingVertical: 8,
    borderTopWidth: 0.6,
    borderTopColor: theme.colors.outlineVariant,
    backgroundColor: theme.colors.card,
  },
  tabButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 70,
    paddingVertical: 4,
  },
  tabButtonSwap: {
    minWidth: 70,
    minHeight: 34,
  },
  tabButtonContent: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  tabLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: theme.colors.textSecondary,
  },
  tabLabelActive: {
    color: theme.colors.primary,
  },
  tabContentCenter: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  manualInputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: theme.colors.card,
    borderTopWidth: 0.6,
    borderTopColor: theme.colors.outlineVariant,
  },
  manualInputBarInput: {
    flex: 1,
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.outline,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 12,
    color: theme.colors.text,
    fontSize: 15,
  },
  manualInputBarButton: {
    height: 44,
    paddingHorizontal: 18,
    borderRadius: 10,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  manualInputBarButtonText: {
    color: theme.colors.textOnAccent,
    fontWeight: '600',
    fontSize: 14,
  },
  bottomActionBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    marginHorizontal: 16,
    marginBottom: 18,
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: theme.colors.card,
    borderRadius: 999,
    borderWidth: 0.6,
    borderColor: theme.colors.outlineVariant,
    ...theme.shadows.soft,
  },
  bottomAction: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 40,
    borderRadius: 999,
  },
  bottomActionDisabled: {
    opacity: 0.45,
  },
  bottomActionText: {
    fontSize: 14,
    fontWeight: '600',
    color: theme.colors.text,
  },
    bottomActionTextDisabled: {
      color: theme.colors.textTertiary,
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
