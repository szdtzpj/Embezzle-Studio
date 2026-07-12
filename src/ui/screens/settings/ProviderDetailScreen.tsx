import { useEffect, useState } from 'react';
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
import { SettingsSelect } from '../../components/settings/SettingsSelect';
import { useKelivoTheme, type KelivoTheme } from '../../theme';
import type {
  Capability,
  ModelInfo,
  ModelTask,
  ProviderKind,
  ProviderProfile,
} from '../../../domain/types';
import {
  inferModelTask,
  type ModelCapabilityFilter,
} from '../../../services/modelCapabilities';
import type { ProviderEndpointInspection } from '../../../services/providerSetup';
import {
  configurableModelCapabilities,
  configurableModelTasks,
  modelTaskLabel,
} from '../../utils/modelDisplay';

const providerKindOptions: Array<{ key: ProviderKind; label: string }> = [
  { key: 'volcengine-ark', label: '火山方舟' },
  { key: 'bailian-compatible', label: '阿里百炼' },
  { key: 'openai-compatible', label: 'OpenAI' },
  { key: 'custom', label: '兼容接口' },
];

export interface ProviderDetailScreenProps {
  readOnly: boolean;
  provider: ProviderProfile;
  activeModelId: string;
  activeModel: ModelInfo | undefined;
  addedModels: ModelInfo[];
  addedModelIds: Set<string>;
  modelCandidates: ModelInfo[];
  filteredModelCandidates: ModelInfo[];
  renderedModelCandidates: ModelInfo[];
  modelSearchQuery: string;
  modelCapabilityFilter: ModelCapabilityFilter;
  candidateModelFilters: Array<{ key: ModelCapabilityFilter; label: string }>;
  manualModelId: string;
  refreshingModels: boolean;
  notice: string;
  /** Draft-based setup wizard fields (main v1.2+ binding flow). */
  nameDraft: string;
  kindDraft: ProviderKind;
  baseUrlDraft: string;
  apiKeyDraft: string;
  endpointInspection: ProviderEndpointInspection;
  hasMoreCandidates?: boolean;
  onBack: () => void;
  onSetNameDraft: (name: string) => void;
  onChangeBindingDraft: (patch: { kind?: ProviderKind; baseUrl?: string }) => void;
  onSetApiKeyDraft: (apiKey: string) => void;
  onSaveProviderDraft: () => void;
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
  onLoadMoreCandidates?: () => void;
  onDeleteProvider?: () => void;
}

export function ProviderDetailScreen({
  readOnly,
  provider,
  activeModelId,
  activeModel,
  addedModels,
  addedModelIds,
  modelCandidates,
  filteredModelCandidates,
  renderedModelCandidates,
  modelSearchQuery,
  modelCapabilityFilter,
  candidateModelFilters,
  manualModelId,
  refreshingModels,
  notice,
  nameDraft,
  kindDraft,
  baseUrlDraft,
  apiKeyDraft,
  endpointInspection,
  hasMoreCandidates = false,
  onBack,
  onSetNameDraft,
  onChangeBindingDraft,
  onSetApiKeyDraft,
  onSaveProviderDraft,
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
  onLoadMoreCandidates,
  onDeleteProvider,
}: ProviderDetailScreenProps) {
  const theme = useKelivoTheme();
  const styles = getStyles(theme);
  const [tab, setTab] = useState<'config' | 'models'>('config');
  const [tabDirection, setTabDirection] =
    useState<'forward' | 'backward' | 'none'>('none');
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    setTab('config');
    setTabDirection('none');
    setShowKey(false);
  }, [provider.id]);

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
        <AnimatedPressable
          accessibilityRole="button"
          accessibilityLabel="返回服务商列表"
          onPress={onBack}
          style={styles.headerButton}
        >
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
              accessibilityLabel={`删除服务商 ${provider.name}`}
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
            showKey={showKey}
            nameDraft={nameDraft}
            kindDraft={kindDraft}
            baseUrlDraft={baseUrlDraft}
            apiKeyDraft={apiKeyDraft}
            endpointInspection={endpointInspection}
            refreshingModels={refreshingModels}
            onToggleShowKey={() => setShowKey((v) => !v)}
            onSetNameDraft={onSetNameDraft}
            onChangeBindingDraft={onChangeBindingDraft}
            onSetApiKeyDraft={onSetApiKeyDraft}
            onSaveProviderDraft={onSaveProviderDraft}
            onRefreshModels={onRefreshModels}
          />
        ) : (
          <ModelsTab
            key={provider.id}
            readOnly={readOnly}
            providerName={provider.name}
            activeModelId={activeModelId}
            activeModel={activeModel}
            addedModels={addedModels}
            addedModelIds={addedModelIds}
            modelCandidates={modelCandidates}
            filteredModelCandidates={filteredModelCandidates}
            renderedModelCandidates={renderedModelCandidates}
            modelSearchQuery={modelSearchQuery}
            modelCapabilityFilter={modelCapabilityFilter}
            candidateModelFilters={candidateModelFilters}
            manualModelId={manualModelId}
            refreshingModels={refreshingModels}
            hasMoreCandidates={hasMoreCandidates}
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
            onLoadMoreCandidates={onLoadMoreCandidates}
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
      accessibilityLabel={`${label}选项卡`}
      accessibilityState={{ selected: active }}
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
  showKey,
  nameDraft,
  kindDraft,
  baseUrlDraft,
  apiKeyDraft,
  endpointInspection,
  refreshingModels,
  onToggleShowKey,
  onSetNameDraft,
  onChangeBindingDraft,
  onSetApiKeyDraft,
  onSaveProviderDraft,
  onRefreshModels,
}: {
  readOnly: boolean;
  showKey: boolean;
  nameDraft: string;
  kindDraft: ProviderKind;
  baseUrlDraft: string;
  apiKeyDraft: string;
  endpointInspection: ProviderEndpointInspection;
  refreshingModels: boolean;
  onToggleShowKey: () => void;
  onSetNameDraft: (name: string) => void;
  onChangeBindingDraft: (patch: { kind?: ProviderKind; baseUrl?: string }) => void;
  onSetApiKeyDraft: (apiKey: string) => void;
  onSaveProviderDraft: () => void;
  onRefreshModels: () => void;
}) {
  const theme = useKelivoTheme();
  const styles = getStyles(theme);

  return (
    <ScrollView
      style={styles.tabContent}
      contentContainerStyle={styles.tabContentInner}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      <MotionItem index={0} distance={8}>
        <View style={styles.card} testID="provider-setup-wizard-card">
          <View style={styles.cardHeader}>
            <Text style={styles.sectionLabel}>服务商配置向导</Text>
            <Text style={styles.badgeText}>
              {endpointInspection.valid ? '本地校验通过' : '等待修正'}
            </Text>
          </View>
          <Text style={styles.inputHint}>
            先在本机校验协议、地址和密钥绑定，再请求模型目录。模型目录请求不生成内容；不会使用 Embezzle Studio 的额度或服务器。
          </Text>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>名称</Text>
            <TextInput
              editable={!readOnly}
              value={nameDraft}
              onChangeText={onSetNameDraft}
              style={styles.input}
              placeholder="Provider name"
              placeholderTextColor={theme.colors.textTertiary}
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>协议类型</Text>
            <SettingsSelect
              value={kindDraft}
              options={providerKindOptions}
              disabled={readOnly}
              accessibilityLabel="协议类型"
              onChange={(kind) => onChangeBindingDraft({ kind })}
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Base URL</Text>
            <TextInput
              autoCapitalize="none"
              editable={!readOnly}
              value={baseUrlDraft}
              onChangeText={(baseUrl) => onChangeBindingDraft({ baseUrl })}
              style={styles.input}
              placeholder="https://api.example.com/v1"
              placeholderTextColor={theme.colors.textTertiary}
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>API Key</Text>
            <View style={styles.keyInputWrap}>
              <TextInput
                autoCapitalize="none"
                editable={!readOnly}
                secureTextEntry={!showKey}
                value={apiKeyDraft}
                onChangeText={onSetApiKeyDraft}
                style={[styles.input, styles.keyInput]}
                placeholder="服务商 API Key"
                placeholderTextColor={theme.colors.textTertiary}
              />
              <AnimatedPressable
                accessibilityRole="button"
                accessibilityLabel={showKey ? '隐藏 API Key' : '显示 API Key'}
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
                Web 端仅在当前标签页会话中保存密钥，关闭标签页后会清除；Android 使用系统安全存储。
              </Text>
            ) : null}
          </View>

          {endpointInspection.errors.map((error) => (
            <Text key={error} style={styles.errorText}>• {error}</Text>
          ))}
          {endpointInspection.warnings.map((warning) => (
            <Text key={warning} style={styles.warningText}>• {warning}</Text>
          ))}

          <AnimatedPressable
            accessibilityRole="button"
            accessibilityState={{ disabled: readOnly }}
            disabled={readOnly}
            onPress={onSaveProviderDraft}
            style={[styles.secondaryButton, readOnly && styles.buttonDisabled]}
          >
            <Text style={styles.secondaryButtonText}>保存并绑定此端点</Text>
          </AnimatedPressable>

          <AnimatedPressable
            accessibilityRole="button"
            accessibilityState={{ disabled: readOnly || refreshingModels, busy: refreshingModels }}
            disabled={readOnly || refreshingModels}
            onPress={onRefreshModels}
            style={[styles.primaryButton, (readOnly || refreshingModels) && styles.buttonDisabled]}
          >
            <Text style={styles.primaryButtonText}>
              {refreshingModels ? '请求中...' : '检查连接并获取模型目录'}
            </Text>
          </AnimatedPressable>
        </View>
      </MotionItem>
    </ScrollView>
  );
}

function ModelsTab({
  readOnly,
  providerName,
  activeModelId,
  activeModel,
  addedModels,
  addedModelIds,
  modelCandidates,
  filteredModelCandidates,
  renderedModelCandidates,
  modelSearchQuery,
  modelCapabilityFilter,
  candidateModelFilters,
  manualModelId,
  refreshingModels,
  hasMoreCandidates,
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
  onLoadMoreCandidates,
}: {
  readOnly: boolean;
  providerName: string;
  activeModelId: string;
  activeModel: ModelInfo | undefined;
  addedModels: ModelInfo[];
  addedModelIds: Set<string>;
  modelCandidates: ModelInfo[];
  filteredModelCandidates: ModelInfo[];
  renderedModelCandidates: ModelInfo[];
  modelSearchQuery: string;
  modelCapabilityFilter: ModelCapabilityFilter;
  candidateModelFilters: Array<{ key: ModelCapabilityFilter; label: string }>;
  manualModelId: string;
  refreshingModels: boolean;
  hasMoreCandidates: boolean;
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
  onLoadMoreCandidates?: () => void;
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
          <View style={styles.card} testID="model-capability-tags-card">
            <View style={styles.cardHeader}>
              <Text style={styles.sectionLabel}>已添加模型</Text>
              <Text style={styles.badgeText}>{addedModels.length} 个</Text>
            </View>
            <Text style={styles.inputHint}>
              标签展示用途与能力；点选可设为当前模型。
            </Text>
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
            {activeModel ? (
              <View style={styles.modelOverridePanel} testID="active-model-overrides-card">
                <View style={styles.modelOverrideHeader}>
                  <View style={styles.modelOverrideTitleBlock}>
                    <Text style={styles.modelOverrideTitle}>当前模型覆盖</Text>
                    <Text style={styles.modelOverrideModel} numberOfLines={1}>
                      {activeModel.name?.trim() || activeModel.id}
                    </Text>
                  </View>
                  <Text style={styles.modelOverrideBadge}>仅影响此模型</Text>
                </View>

                <View style={styles.overrideGroup}>
                  <Text style={styles.overrideLabel}>模型用途</Text>
                  <View style={styles.optionGrid}>
                    {configurableModelTasks.map((task) => {
                      const selected = inferModelTask(activeModel) === task;
                      const label = modelTaskLabel[task];
                      return (
                        <AnimatedPressable
                          key={task}
                          accessibilityRole="radio"
                          accessibilityLabel={`将 ${activeModel.id} 的用途设为${label}`}
                          accessibilityState={{ selected, disabled: readOnly }}
                          disabled={readOnly}
                          testID={`active-model-task-${task}`}
                          haptic="selection"
                          onPress={() => onSetActiveModelTask(task)}
                          style={[
                            styles.overrideChip,
                            selected && styles.overrideChipActive,
                            readOnly && styles.buttonDisabled,
                          ]}
                        >
                          <Text
                            style={[
                              styles.overrideChipText,
                              selected && styles.overrideChipTextActive,
                            ]}
                          >
                            {label}
                          </Text>
                        </AnimatedPressable>
                      );
                    })}
                  </View>
                </View>

                <View style={styles.overrideGroup}>
                  <Text style={styles.overrideLabel}>能力覆盖</Text>
                  <View style={styles.optionGrid}>
                    {configurableModelCapabilities.map((capability) => {
                      const selected = activeModel.capabilities.includes(capability.key);
                      return (
                        <AnimatedPressable
                          key={capability.key}
                          accessibilityRole="checkbox"
                          accessibilityLabel={`${activeModel.id} ${capability.label}`}
                          accessibilityState={{ checked: selected, disabled: readOnly }}
                          disabled={readOnly}
                          testID={`active-model-capability-${capability.key}`}
                          haptic="selection"
                          onPress={() => onToggleActiveModelCapability(capability.key)}
                          style={[
                            styles.overrideChip,
                            selected && styles.overrideChipActive,
                            readOnly && styles.buttonDisabled,
                          ]}
                        >
                          <Text
                            style={[
                              styles.overrideChipText,
                              selected && styles.overrideChipTextActive,
                            ]}
                          >
                            {capability.label}
                          </Text>
                        </AnimatedPressable>
                      );
                    })}
                  </View>
                </View>

                <Text style={styles.modelOverrideHint}>
                  当目录自动识别不准确时可手动覆盖；用途决定对应的专用入口，能力决定附件、工具与思考选项。
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {hasCandidates ? (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.sectionLabel}>可添加模型</Text>
              <AnimatedPressable
                accessibilityRole="button"
                accessibilityLabel="清空候选模型"
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
                testID="candidate-model-search"
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
                  accessibilityLabel="清空模型搜索"
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
                    testID={`candidate-model-filter-${filter.key}`}
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

            <Text testID="candidate-model-search-count" style={styles.countText}>
              显示 {renderedModelCandidates.length} / {filteredModelCandidates.length} 条匹配结果，共 {modelCandidates.length} 条
            </Text>

            <View style={styles.listGap}>
              {renderedModelCandidates.map((model, index) => (
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
              {hasMoreCandidates && onLoadMoreCandidates ? (
                <AnimatedPressable
                  accessibilityRole="button"
                  accessibilityLabel="加载更多候选模型"
                  onPress={onLoadMoreCandidates}
                  style={styles.secondaryButton}
                >
                  <Text style={styles.secondaryButtonText}>加载更多</Text>
                </AnimatedPressable>
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
          accessibilityLabel="添加手动模型"
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
          accessibilityLabel={showManualInput ? '收起手动添加模型' : '手动添加模型'}
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
          accessibilityLabel={`删除已选模型，共 ${selectedIds.size} 个`}
          accessibilityState={{ disabled: readOnly || selectedIds.size === 0 }}
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
  primaryButton: {
    height: 44,
    borderRadius: 12,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  primaryButtonText: {
    color: theme.colors.onPrimary,
    fontWeight: '700',
    fontSize: 14,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  badgeText: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  errorText: {
    color: theme.colors.error,
    fontSize: 12,
    lineHeight: 18,
  },
  warningText: {
    color: theme.colors.warning,
    fontSize: 12,
    lineHeight: 18,
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
  modelOverridePanel: {
    gap: 14,
    marginTop: 2,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: theme.colors.divider,
  },
  modelOverrideHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  modelOverrideTitleBlock: {
    flex: 1,
    gap: 2,
  },
  modelOverrideTitle: {
    color: theme.colors.text,
    fontSize: 14,
    fontWeight: '700',
  },
  modelOverrideModel: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
  modelOverrideBadge: {
    color: theme.colors.accentText,
    backgroundColor: theme.colors.accentSoft,
    borderRadius: theme.radius.pill,
    paddingHorizontal: 9,
    paddingVertical: 4,
    fontSize: 11,
    fontWeight: '600',
    overflow: 'hidden',
  },
  overrideGroup: {
    gap: 8,
  },
  overrideLabel: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  overrideChip: {
    minHeight: 34,
    paddingHorizontal: 13,
    paddingVertical: 7,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.outline,
    backgroundColor: theme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  overrideChipActive: {
    borderColor: theme.colors.accentBorder,
    backgroundColor: theme.colors.accentSoft,
  },
  overrideChipText: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  overrideChipTextActive: {
    color: theme.colors.accentText,
  },
  modelOverrideHint: {
    color: theme.colors.textTertiary,
    fontSize: 12,
    lineHeight: 18,
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
