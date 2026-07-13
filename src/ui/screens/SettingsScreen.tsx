import { forwardRef, useImperativeHandle, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SettingsMainScreen } from './settings/SettingsMainScreen';
import { ColorModeScreen } from './settings/ColorModeScreen';
import { ProviderListScreen } from './settings/ProviderListScreen';
import {
  ProviderDetailScreen,
  ProviderModelsScreen,
} from './settings/ProviderDetailScreen';
import { AboutScreen } from './settings/AboutScreen';
import { ToolsPanelScreen } from './settings/ToolsPanelScreen';
import {
  settingsToolsSectionTitles,
  type SettingsToolsSection,
} from './settings/toolsSections';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { MotionSwitch } from '../components/Motion';
import { useKelivoTheme, type KelivoTheme } from '../theme';
import type { AppUpdateInfo } from '../../services/updateChecker';
import type {
  Capability,
  ModelInfo,
  ModelTask,
  ProviderKind,
  ProviderProfile,
} from '../../domain/types';
import type { ModelCapabilityFilter } from '../../services/modelCapabilities';
import type { ProviderEndpointInspection } from '../../services/providerSetup';
import { isUserCreatedProvider } from '../../data/providerCatalog';

export type { SettingsToolsSection } from './settings/toolsSections';

export interface SettingsScreenProps {
  readOnly: boolean;
  colorMode: 'system' | 'light' | 'dark';
  onSetColorMode: (mode: 'system' | 'light' | 'dark') => void;
  onClose: () => void;
  providers: ProviderProfile[];
  activeProvider: ProviderProfile;
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
  checkingUpdate: boolean;
  updateInfo: AppUpdateInfo | null;
  updateNotice: string;
  notice: string;
  providerNameDraft: string;
  providerKindDraft: ProviderKind;
  providerBaseUrlDraft: string;
  providerApiKeyDraft: string;
  providerEndpointInspection: ProviderEndpointInspection;
  hasMoreCandidates?: boolean;
  /** Main-branch feature cards, keyed by settings section. */
  renderToolsSection?: (section: SettingsToolsSection) => ReactNode;
  onSelectProvider: (providerId: string) => void;
  onToggleProviderEnabled: (providerId: string) => void;
  onDeleteProvider: (providerId: string, onDeleted?: () => void) => void;
  onAddCustomProvider: () => void;
  onSetProviderNameDraft: (name: string) => void;
  onChangeProviderBindingDraft: (patch: { kind?: ProviderKind; baseUrl?: string }) => void;
  onSetProviderApiKeyDraft: (apiKey: string) => void;
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
  onCheckUpdates: () => void;
  onOpenUpdateTarget: (kind: 'release' | 'install') => void;
}

export interface SettingsScreenHandle {
  handleBack: () => boolean;
  resetNavigation: () => void;
  openProviders: () => void;
  openActiveProviderModels: () => void;
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

export const SettingsScreen = forwardRef<SettingsScreenHandle, SettingsScreenProps>(function SettingsScreen(
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
  const current = stack[stack.length - 1];

  const push = (screen: Exclude<ScreenState, { key: 'main' }>) => {
    setNavigationDirection('forward');
    setStack((s) => [...s, screen]);
  };

  const pop = () => {
    setNavigationDirection('backward');
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  };

  const navigateToProviderDetail = (providerId: string) => {
    const provider = props.providers.find((item) => item.id === providerId);
    if (!provider || provider.enabled === false) {
      return;
    }
    props.onSelectProvider(providerId);
    push({ key: 'providerDetail' });
  };

  const requestDeleteProvider = (providerId: string, onDeleted?: () => void) => {
    if (props.readOnly || props.providers.length <= 1) {
      return;
    }
    const provider = props.providers.find((item) => item.id === providerId);
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
    props.onDeleteProvider(deletion.providerId, deletion.onDeleted);
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
    openToolsSection: (section) => {
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
            colorMode={props.colorMode}
            activeProvider={props.activeProvider}
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
            checkingUpdate={props.checkingUpdate}
            updateInfo={props.updateInfo}
            updateNotice={props.updateNotice}
            onBack={pop}
            onCheckUpdates={props.onCheckUpdates}
            onOpenUpdateTarget={props.onOpenUpdateTarget}
          />
        );
      case 'colorMode':
        return (
          <ColorModeScreen
            readOnly={props.readOnly}
            colorMode={props.colorMode}
            onSetColorMode={props.onSetColorMode}
            onBack={pop}
          />
        );
      case 'tools':
        return (
          <ToolsPanelScreen
            title={settingsToolsSectionTitles[current.section]}
            onBack={pop}
          >
            {props.renderToolsSection?.(current.section) ?? null}
          </ToolsPanelScreen>
        );
      case 'providers':
        return (
          <ProviderListScreen
            readOnly={props.readOnly}
            providers={props.providers}
            activeProviderId={props.activeProvider.id}
            onBack={pop}
            onSelectProvider={navigateToProviderDetail}
            onToggleEnabled={props.onToggleProviderEnabled}
            onDeleteProvider={requestDeleteProvider}
            onAddProvider={props.onAddCustomProvider}
          />
        );
      case 'providerDetail':
        return (
          <ProviderDetailScreen
            readOnly={props.readOnly}
            provider={props.activeProvider}
            addedModelCount={props.addedModels.length}
            candidateModelCount={props.modelCandidates.length}
            refreshingModels={props.refreshingModels}
            notice={props.notice}
            nameDraft={props.providerNameDraft}
            kindDraft={props.providerKindDraft}
            baseUrlDraft={props.providerBaseUrlDraft}
            apiKeyDraft={props.providerApiKeyDraft}
            endpointInspection={props.providerEndpointInspection}
            onBack={pop}
            onOpenModels={() => push({ key: 'providerModels' })}
            onSetNameDraft={props.onSetProviderNameDraft}
            onChangeBindingDraft={props.onChangeProviderBindingDraft}
            onSetApiKeyDraft={props.onSetProviderApiKeyDraft}
            onSaveProviderDraft={props.onSaveProviderDraft}
            onRefreshModels={props.onRefreshModels}
            onDeleteProvider={
              props.providers.length > 1 && isUserCreatedProvider(props.activeProvider)
                ? () => requestDeleteProvider(props.activeProvider.id, pop)
                : undefined
            }
          />
        );
      case 'providerModels':
        return (
          <ProviderModelsScreen
            key={props.activeProvider.id}
            readOnly={props.readOnly}
            provider={props.activeProvider}
            activeModelId={props.activeModelId}
            activeModel={props.activeModel}
            addedModels={props.addedModels}
            addedModelIds={props.addedModelIds}
            modelCandidates={props.modelCandidates}
            filteredModelCandidates={props.filteredModelCandidates}
            renderedModelCandidates={props.renderedModelCandidates}
            modelSearchQuery={props.modelSearchQuery}
            modelCapabilityFilter={props.modelCapabilityFilter}
            candidateModelFilters={props.candidateModelFilters}
            manualModelId={props.manualModelId}
            refreshingModels={props.refreshingModels}
            hasMoreCandidates={props.hasMoreCandidates}
            onBack={pop}
            onRefreshModels={props.onRefreshModels}
            onSetModelSearchQuery={props.onSetModelSearchQuery}
            onSetModelCapabilityFilter={props.onSetModelCapabilityFilter}
            onAddCandidateModel={props.onAddCandidateModel}
            onClearCandidates={props.onClearCandidates}
            onSetManualModelId={props.onSetManualModelId}
            onAddManualModel={props.onAddManualModel}
            onSelectModel={props.onSelectModel}
            onRemoveModel={props.onRemoveModel}
            onSetActiveModelTask={props.onSetActiveModelTask}
            onToggleActiveModelCapability={props.onToggleActiveModelCapability}
            onLoadMoreCandidates={props.onLoadMoreCandidates}
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
      {props.notice && current.key !== 'providerDetail' ? (
        <View style={styles.noticeBanner}>
          <Text style={styles.noticeText}>{props.notice}</Text>
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
