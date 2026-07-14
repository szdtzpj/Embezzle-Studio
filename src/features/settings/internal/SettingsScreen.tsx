import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { Plus } from 'lucide-react-native';
import { StyleSheet, Text, View } from 'react-native';
import { SettingsMainScreen } from '../../../ui/screens/settings/SettingsMainScreen';
import { ColorModeScreen } from '../../../ui/screens/settings/ColorModeScreen';
import { ProviderListScreen } from '../../../ui/screens/settings/ProviderListScreen';
import {
  ProviderDetailScreen,
  ProviderModelsScreen,
} from '../../../ui/screens/settings/ProviderDetailScreen';
import { AboutScreen } from '../../../ui/screens/settings/AboutScreen';
import { ToolsPanelScreen } from '../../../ui/screens/settings/ToolsPanelScreen';
import { settingsToolsSectionTitles } from '../../../ui/screens/settings/toolsSections';
import type { SettingsToolsSection } from '../../../app/navigation/settingsNavigation';
import { ConfirmDialog } from '../../../ui/components/ConfirmDialog';
import { AnimatedPressable } from '../../../ui/components/AnimatedPressable';
import { MotionSwitch } from '../../../ui/components/Motion';
import type { SearchServicesPanelHandle } from '../../../ui/components/SearchServicesPanel';
import { useKelivoTheme, type KelivoTheme } from '../../../ui/theme';
import type { AppUpdateInfo } from '../../../services/updateChecker';
import type {
  Capability,
  ModelInfo,
  ModelTask,
  ProviderKind,
  ProviderProfile,
} from '../../../domain/types';
import type { ModelCapabilityFilter } from '../../../services/modelCapabilities';
import type { ProviderEndpointInspection } from '../../../services/providerSetup';
import { isUserCreatedProvider } from '../../../data/providerCatalog';
import { SettingsToolsSectionView } from './SettingsToolsSectionView';

export type { SettingsToolsSection } from '../../../app/navigation/settingsNavigation';

/**
 * Internal view-model for the settings navigation stack.
 * Not part of the public Settings Productivity seam — callers use SettingsPane.
 */
export interface SettingsScreenModel {
  onClose: () => void;
  status: {
    readOnly: boolean;
    notice: string;
  };
  appearance: {
    colorMode: 'system' | 'light' | 'dark';
    onSetColorMode: (mode: 'system' | 'light' | 'dark') => void;
  };
  providers: {
    providers: ProviderProfile[];
    activeProvider: ProviderProfile;
    nameDraft: string;
    kindDraft: ProviderKind;
    baseUrlDraft: string;
    apiKeyDraft: string;
    endpointInspection: ProviderEndpointInspection;
    select(providerId: string): Promise<boolean>;
    toggleEnabled(providerId: string): void;
    delete(providerId: string, onDeleted?: () => void): void;
    addCustom(): void;
    setNameDraft(name: string): void;
    changeBindingDraft(patch: { kind?: ProviderKind; baseUrl?: string }): void;
    setApiKeyDraft(apiKey: string): void;
    saveDraft(): void;
  };
  models: {
    activeModelId: string;
    activeModel: ModelInfo | undefined;
    addedModels: ModelInfo[];
    addedModelIds: Set<string>;
    candidates: ModelInfo[];
    filteredCandidates: ModelInfo[];
    renderedCandidates: ModelInfo[];
    searchQuery: string;
    capabilityFilter: ModelCapabilityFilter;
    candidateFilters: Array<{ key: ModelCapabilityFilter; label: string }>;
    manualModelId: string;
    refreshing: boolean;
    hasMoreCandidates?: boolean;
    refresh(): void;
    setSearchQuery(query: string): void;
    setCapabilityFilter(filter: ModelCapabilityFilter): void;
    addCandidate(model: ModelInfo): void;
    clearCandidates(): void;
    setManualModelId(id: string): void;
    addManual(): void;
    select(modelId: string): void;
    remove(modelId: string): void;
    setActiveTask(task: ModelTask): void;
    toggleActiveCapability(capability: Capability): void;
    loadMore?(): void;
  };
  updates: {
    checking: boolean;
    info: AppUpdateInfo | null;
    notice: string;
    check(): void;
    openTarget(kind: 'release' | 'install'): void;
  };
}

export interface SettingsScreenHandle {
  handleBack: () => boolean;
  resetNavigation: () => void;
  openProviders: () => void;
  openActiveProviderModels: () => void;
  /** Jump from composer (etc.) into a tools sub-page without manual drill-down. */
  openToolsSection: (section: SettingsToolsSection) => void;
}

type ScreenState =
  | { key: 'main' }
  | { key: 'colorMode' }
  | { key: 'providers' }
  | { key: 'providerDetail' }
  | { key: 'providerModels' }
  | { key: 'tools'; section: SettingsToolsSection }
  | { key: 'about' };

type PendingProviderDeletion = {
  providerId: string;
  providerName: string;
  onDeleted?: () => void;
};

export const SettingsScreen = forwardRef<SettingsScreenHandle, SettingsScreenModel>(function SettingsScreen(
  props,
  ref,
) {
  const theme = useKelivoTheme();
  const styles = getStyles(theme);
  const [stack, setStack] = useState<ScreenState[]>([{ key: 'main' }]);
  const [pendingProviderDeletion, setPendingProviderDeletion] =
    useState<PendingProviderDeletion | null>(null);
  const [navigationDirection, setNavigationDirection] =
    useState<'forward' | 'backward' | 'none'>('none');
  /** Survives sub-page remounts so "关于" 等返回后仍停在刚才的滚动位置. */
  const [mainScrollOffsetY, setMainScrollOffsetY] = useState(0);
  const searchServicesPanelRef = useRef<SearchServicesPanelHandle>(null);
  const current = stack[stack.length - 1];

  const push = (screen: Exclude<ScreenState, { key: 'main' }>) => {
    setNavigationDirection('forward');
    setStack((s) => [...s, screen]);
  };

  const pop = () => {
    setNavigationDirection('backward');
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  };

  const navigateToProviderDetail = async (providerId: string) => {
    const provider = props.providers.providers.find((item) => item.id === providerId);
    if (!provider || provider.enabled === false) {
      return;
    }
    if (!(await props.providers.select(providerId))) return;
    push({ key: 'providerDetail' });
  };

  const requestDeleteProvider = (providerId: string, onDeleted?: () => void) => {
    if (props.status.readOnly || props.providers.providers.length <= 1) {
      return;
    }
    const provider = props.providers.providers.find((item) => item.id === providerId);
    if (!provider || !isUserCreatedProvider(provider)) {
      return;
    }

    setPendingProviderDeletion({
      providerId: provider.id,
      providerName: provider.name,
      onDeleted,
    });
  };

  const confirmDeleteProvider = () => {
    if (!pendingProviderDeletion) {
      return;
    }

    const deletion = pendingProviderDeletion;
    setPendingProviderDeletion(null);
    props.providers.delete(deletion.providerId, deletion.onDeleted);
  };

  useImperativeHandle(ref, () => ({
    handleBack: () => {
      if (pendingProviderDeletion) {
        setPendingProviderDeletion(null);
        return true;
      }
      if (stack.length <= 1) {
        return false;
      }
      setNavigationDirection('backward');
      setStack((screens) => screens.slice(0, -1));
      return true;
    },
    resetNavigation: () => {
      setPendingProviderDeletion(null);
      setNavigationDirection('none');
      setStack([{ key: 'main' }]);
    },
    openProviders: () => {
      setPendingProviderDeletion(null);
      setNavigationDirection('forward');
      setStack([{ key: 'main' }, { key: 'providers' }]);
    },
    openActiveProviderModels: () => {
      setPendingProviderDeletion(null);
      setNavigationDirection('forward');
      setStack([
        { key: 'main' },
        { key: 'providers' },
        { key: 'providerDetail' },
        { key: 'providerModels' },
      ]);
    },
    openToolsSection: (section: SettingsToolsSection) => {
      setPendingProviderDeletion(null);
      setNavigationDirection('forward');
      setStack([{ key: 'main' }, { key: 'tools', section }]);
    },
  }), [pendingProviderDeletion, stack.length]);

  const renderScreen = () => {
    switch (current.key) {
      case 'main':
        return (
          <SettingsMainScreen
            colorMode={props.appearance.colorMode}
            activeProvider={props.providers.activeProvider}
            scrollOffsetY={mainScrollOffsetY}
            onScrollOffsetChange={setMainScrollOffsetY}
            onBack={props.onClose}
            onColorMode={() => push({ key: 'colorMode' })}
            onProviders={() => push({ key: 'providers' })}
            onToolsSection={(section) => push({ key: 'tools', section })}
            onAbout={() => push({ key: 'about' })}
          />
        );
      case 'about':
        return (
          <AboutScreen
            checkingUpdate={props.updates.checking}
            updateInfo={props.updates.info}
            updateNotice={props.updates.notice}
            onBack={pop}
            onCheckUpdates={props.updates.check}
            onOpenUpdateTarget={props.updates.openTarget}
          />
        );
      case 'colorMode':
        return (
          <ColorModeScreen
            readOnly={props.status.readOnly}
            colorMode={props.appearance.colorMode}
            onSetColorMode={props.appearance.onSetColorMode}
            onBack={pop}
          />
        );
      case 'tools':
        return (
          <ToolsPanelScreen
            title={settingsToolsSectionTitles[current.section]}
            onBack={pop}
            headerRight={
              current.section === 'webSearch' ? (
                <AnimatedPressable
                  accessibilityRole="button"
                  accessibilityLabel="添加搜索服务"
                  accessibilityState={{ disabled: props.status.readOnly }}
                  disabled={props.status.readOnly}
                  testID="search-service-add"
                  onPress={() => searchServicesPanelRef.current?.openAdd()}
                  haptic="light"
                  style={[
                    styles.headerAddButton,
                    props.status.readOnly && styles.headerAddButtonDisabled,
                  ]}
                >
                  <Plus size={22} color={theme.colors.text} strokeWidth={2.2} />
                </AnimatedPressable>
              ) : null
            }
          >
            <SettingsToolsSectionView
              section={current.section}
              searchServicesPanelRef={searchServicesPanelRef}
            />
          </ToolsPanelScreen>
        );
      case 'providers':
        return (
          <ProviderListScreen
            readOnly={props.status.readOnly}
            providers={props.providers.providers}
            activeProviderId={props.providers.activeProvider.id}
            onBack={pop}
            onSelectProvider={navigateToProviderDetail}
            onToggleEnabled={props.providers.toggleEnabled}
            onDeleteProvider={requestDeleteProvider}
            onAddProvider={props.providers.addCustom}
          />
        );
      case 'providerDetail':
        return (
          <ProviderDetailScreen
            readOnly={props.status.readOnly}
            provider={props.providers.activeProvider}
            addedModelCount={props.models.addedModels.length}
            candidateModelCount={props.models.candidates.length}
            refreshingModels={props.models.refreshing}
            notice={props.status.notice}
            nameDraft={props.providers.nameDraft}
            kindDraft={props.providers.kindDraft}
            baseUrlDraft={props.providers.baseUrlDraft}
            apiKeyDraft={props.providers.apiKeyDraft}
            endpointInspection={props.providers.endpointInspection}
            onBack={pop}
            onOpenModels={() => push({ key: 'providerModels' })}
            onSetNameDraft={props.providers.setNameDraft}
            onChangeBindingDraft={props.providers.changeBindingDraft}
            onSetApiKeyDraft={props.providers.setApiKeyDraft}
            onSaveProviderDraft={props.providers.saveDraft}
            onRefreshModels={props.models.refresh}
            onDeleteProvider={
              props.providers.providers.length > 1 && isUserCreatedProvider(props.providers.activeProvider)
                ? () => requestDeleteProvider(props.providers.activeProvider.id, pop)
                : undefined
            }
          />
        );
      case 'providerModels':
        return (
          <ProviderModelsScreen
            key={props.providers.activeProvider.id}
            readOnly={props.status.readOnly}
            provider={props.providers.activeProvider}
            activeModelId={props.models.activeModelId}
            activeModel={props.models.activeModel}
            addedModels={props.models.addedModels}
            addedModelIds={props.models.addedModelIds}
            modelCandidates={props.models.candidates}
            filteredModelCandidates={props.models.filteredCandidates}
            renderedModelCandidates={props.models.renderedCandidates}
            modelSearchQuery={props.models.searchQuery}
            modelCapabilityFilter={props.models.capabilityFilter}
            candidateModelFilters={props.models.candidateFilters}
            manualModelId={props.models.manualModelId}
            refreshingModels={props.models.refreshing}
            hasMoreCandidates={props.models.hasMoreCandidates}
            onBack={pop}
            onRefreshModels={props.models.refresh}
            onSetModelSearchQuery={props.models.setSearchQuery}
            onSetModelCapabilityFilter={props.models.setCapabilityFilter}
            onAddCandidateModel={props.models.addCandidate}
            onClearCandidates={props.models.clearCandidates}
            onSetManualModelId={props.models.setManualModelId}
            onAddManualModel={props.models.addManual}
            onSelectModel={props.models.select}
            onRemoveModel={props.models.remove}
            onSetActiveModelTask={props.models.setActiveTask}
            onToggleActiveModelCapability={props.models.toggleActiveCapability}
            onLoadMoreCandidates={props.models.loadMore}
          />
        );
      default:
        return null;
    }
  };

  const motionKey =
    current.key === 'tools' ? `tools:${current.section}` : current.key;

  return (
    <View style={styles.container}>
      <MotionSwitch motionKey={motionKey} direction={navigationDirection}>
        {renderScreen()}
      </MotionSwitch>
      {props.status.notice && current.key !== 'providerDetail' ? (
        <View style={styles.noticeBanner}>
          <Text style={styles.noticeText}>{props.status.notice}</Text>
        </View>
      ) : null}
      <ConfirmDialog
        visible={Boolean(pendingProviderDeletion)}
        title="删除供应商？"
        subject={pendingProviderDeletion?.providerName}
        description="相关配置、模型列表、本地 API Key，以及绑定 MCP 配置与授权将一并移除；历史消息仍会保留。"
        confirmLabel="删除"
        onCancel={() => setPendingProviderDeletion(null)}
        onConfirm={confirmDeleteProvider}
      />
    </View>
  );
});

function createStyles(theme: KelivoTheme) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.surface,
    },
    headerAddButton: {
      width: 38,
      height: 38,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerAddButtonDisabled: {
      opacity: 0.4,
    },
    noticeBanner: {
      marginHorizontal: 12,
      marginBottom: 10,
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
      fontWeight: '600',
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
