import { useEffect, useMemo, useState } from 'react';
import { Linking } from 'react-native';

import {
  useWorkspaceSelector,
  useWorkspaceSession,
  useWorkspaceStatus,
} from '../../../app/workspace/WorkspaceSessionProvider';
import { appInfo } from '../../../data/appInfo';
import type {
  Capability,
  ModelInfo,
  ModelTask,
  ProviderProfile,
} from '../../../domain/types';
import {
  useChatActivity,
  useChatConfigurationActions,
  useChatProjectNavigation,
} from '../../chat';
import { checkForAppUpdate } from '../../../services/updateChecker';
import { refreshProviderModels } from '../../../services/modelDiscovery';
import {
  createModelInfoFromId,
  inferModelTask,
  modelMatchesCapabilityFilter,
  modelSearchText,
  type ModelCapabilityFilter,
} from '../../../services/modelCapabilities';
import { isAbortError } from '../../../services/openAiCompatible';
import { removeProviderFromWorkspace } from '../../../services/providerLifecycle';
import {
  compareProviderEndpointBinding,
  inspectProviderEndpoint,
  providerEndpointFingerprint,
} from '../../../services/providerSetup';
import {
  isProviderEnabled,
  resolveEnabledProvider,
} from '../../../services/workspaceRuntime';
import { createId } from '../../../services/id';
import { useAppearance } from '../../../ui/appearance/AppearanceProvider';
import type { SettingsScreenModel } from './SettingsScreen';
import { useSettingsScreenDrafts } from './useSettingsDrafts';
import { SettingsWorkspaceRuntime } from './SettingsWorkspaceRuntime';

const candidateModelFilters: Array<{ key: ModelCapabilityFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'reasoning', label: '推理' },
  { key: 'vision', label: '视觉' },
  { key: 'web', label: '联网' },
  { key: 'free', label: 'Free / Trial 字样 ≠ 免费额度' },
  { key: 'embedding', label: '嵌入' },
  { key: 'rerank', label: '重排' },
  { key: 'tool', label: '工具' },
];

const candidateModelPageSize = 60;

function getSelectableModels(provider: ProviderProfile): ModelInfo[] {
  return provider.models.filter((model) => model.source !== 'remote');
}

function modelIndexText(model: ModelInfo): string {
  return modelSearchText(model);
}

function matchesCandidateModelFilter(
  model: ModelInfo,
  filter: ModelCapabilityFilter
): boolean {
  return modelMatchesCapabilityFilter(model, filter);
}

export function useSettingsScreenModel(onClose: () => void): SettingsScreenModel {
  const appearance = useAppearance();
  const session = useWorkspaceSession();
  const status = useWorkspaceStatus();
  const workspace = useWorkspaceSelector((snapshot) => snapshot);
  const runtime = useMemo(() => new SettingsWorkspaceRuntime(session), [session]);
  const execute = runtime.execute.bind(runtime);
  const activity = useChatActivity();
  const chatConfiguration = useChatConfigurationActions();
  const chatProjectNavigation = useChatProjectNavigation();
  const [notice, setNotice] = useState('');
  const drafts = useSettingsScreenDrafts(candidateModelPageSize);
  const {
    refreshingModels,
    setRefreshingModels,
    manualModelId,
    setManualModelId,
    providerNameDraft,
    setProviderNameDraft,
    providerKindDraft,
    setProviderKindDraft,
    providerBaseUrlDraft,
    setProviderBaseUrlDraft,
    providerApiKeyDraft,
    setProviderApiKeyDraft,
    providerKeyBindingFingerprint,
    setProviderKeyBindingFingerprint,
    modelSearchQuery,
    setModelSearchQuery,
    modelCapabilityFilter,
    setModelCapabilityFilter,
    candidateModelRenderLimit,
    setCandidateModelRenderLimit,
    checkingUpdate,
    setCheckingUpdate,
    updateNotice,
    setUpdateNotice,
    updateInfo,
    setUpdateInfo,
  } = drafts;

  const workspaceReadOnly = status.phase !== 'ready';
  const activeProvider = useMemo(
    () => resolveEnabledProvider(workspace.providers, workspace.activeProviderId),
    [workspace.activeProviderId, workspace.providers]
  );

  useEffect(() => {
    if (!activeProvider) return;
    setProviderNameDraft(activeProvider.name);
    setProviderKindDraft(activeProvider.kind);
    setProviderBaseUrlDraft(activeProvider.baseUrl);
    setProviderApiKeyDraft(activeProvider.apiKey ?? '');
    setProviderKeyBindingFingerprint(
      activeProvider.apiKey ? providerEndpointFingerprint(activeProvider) ?? null : null
    );
  }, [
    activeProvider,
    setProviderApiKeyDraft,
    setProviderBaseUrlDraft,
    setProviderKeyBindingFingerprint,
    setProviderKindDraft,
    setProviderNameDraft,
  ]);

  const addedModels = useMemo(
    () => (activeProvider ? getSelectableModels(activeProvider) : []),
    [activeProvider]
  );
  const savedActiveModelId = activeProvider
    ? workspace.activeModelIdByProvider[activeProvider.id]
    : '';
  const activeModelId = activeProvider
    ? addedModels.some((model) => model.id === savedActiveModelId)
      ? savedActiveModelId
      : addedModels[0]?.id ?? ''
    : '';
  const activeModel = addedModels.find((model) => model.id === activeModelId);
  const providerEndpointInspection = useMemo(
    () =>
      inspectProviderEndpoint(providerBaseUrlDraft, {
        kind: providerKindDraft,
        apiKey: providerApiKeyDraft,
      }),
    [providerApiKeyDraft, providerBaseUrlDraft, providerKindDraft]
  );
  const modelCandidates = useMemo(
    () => (activeProvider ? workspace.modelCandidatesByProvider[activeProvider.id] ?? [] : []),
    [activeProvider, workspace.modelCandidatesByProvider]
  );
  const addedModelIds = useMemo(
    () => new Set(addedModels.map((model) => model.id)),
    [addedModels]
  );
  const filteredModelCandidates = useMemo(() => {
    const query = modelSearchQuery.trim().toLowerCase();
    return modelCandidates.filter((model) => {
      const matchesQuery = !query || modelIndexText(model).includes(query);
      return matchesQuery && matchesCandidateModelFilter(model, modelCapabilityFilter);
    });
  }, [modelCandidates, modelCapabilityFilter, modelSearchQuery]);
  const renderedModelCandidates = useMemo(
    () => filteredModelCandidates.slice(0, candidateModelRenderLimit),
    [candidateModelRenderLimit, filteredModelCandidates]
  );

  useEffect(() => {
    setCandidateModelRenderLimit(candidateModelPageSize);
  }, [activeProvider?.id, modelCapabilityFilter, modelSearchQuery, setCandidateModelRenderLimit]);

  function ensureWritable(): boolean {
    const currentPhase = session.getStatus().phase;
    if (currentPhase === 'ready') return true;
    setNotice(
      currentPhase === 'replacing'
        ? '正在验证并导入备份，暂时不能修改设置。'
        : '工作区加载失败，当前为只读模式，无法保存更改。'
    );
    return false;
  }

  function ensureConfigurationIdle(): boolean {
    if (!activity.configurationLocked) return true;
    setNotice(`${activity.label ?? '服务商操作'}仍在进行中，请稍后修改配置。`);
    return false;
  }

  function providerFromDraft(): ProviderProfile | null {
    if (!activeProvider) return null;
    const inspection = inspectProviderEndpoint(providerBaseUrlDraft, {
      kind: providerKindDraft,
      apiKey: providerApiKeyDraft,
    });
    if (!inspection.valid || inspection.policy === 'blocked' || !inspection.normalizedBaseUrl) {
      setNotice(inspection.errors[0] ?? '服务商配置未通过本地安全检查。');
      return null;
    }
    const binding = compareProviderEndpointBinding(activeProvider, {
      kind: providerKindDraft,
      baseUrl: inspection.normalizedBaseUrl,
    });
    const finalFingerprint = providerEndpointFingerprint({
      kind: providerKindDraft,
      baseUrl: inspection.normalizedBaseUrl,
    });
    if (providerApiKeyDraft.trim() && providerKeyBindingFingerprint !== finalFingerprint) {
      setProviderApiKeyDraft('');
      setProviderKeyBindingFingerprint(null);
      setNotice('API Key 不是在当前最终端点下输入的；为防止跨端点发送，请确认地址后重新输入对应 Key。');
      return null;
    }
    return {
      ...activeProvider,
      name: providerNameDraft.trim() || activeProvider.name,
      kind: providerKindDraft,
      baseUrl: inspection.normalizedBaseUrl,
      apiKey: providerApiKeyDraft.trim() || undefined,
      models: binding.mustClearModels ? [] : activeProvider.models,
      capabilities: binding.mustClearModels ? ['text', 'streaming'] : activeProvider.capabilities,
    };
  }

  async function persistProviderDraft(): Promise<ProviderProfile | null> {
    if (!ensureWritable() || !ensureConfigurationIdle() || !activeProvider) return null;
    const currentWorkspace = session.getSnapshot();
    const currentProvider = resolveEnabledProvider(
      currentWorkspace.providers,
      currentWorkspace.activeProviderId
    );
    if (!currentProvider || currentProvider.id !== activeProvider.id) {
      setNotice('当前服务商已变化，请重新打开配置后再保存。');
      return null;
    }
    const nextProvider = providerFromDraft();
    if (!nextProvider) return null;
    const binding = compareProviderEndpointBinding(activeProvider, nextProvider);
    const apiKeyChanged = (activeProvider.apiKey ?? '') !== (nextProvider.apiKey ?? '');
    const accepted = await execute({
      type: 'provider.save',
      providerId: activeProvider.id,
      provider: nextProvider,
      binding,
      apiKeyChanged,
      now: Date.now(),
    });
    if (!accepted) {
      setNotice('工作区状态已变化，服务商配置未保存。');
      return null;
    }
    if (binding.changed || apiKeyChanged) chatProjectNavigation.discardPendingAttachments();
    setProviderBaseUrlDraft(nextProvider.baseUrl);
    setProviderKeyBindingFingerprint(
      nextProvider.apiKey ? providerEndpointFingerprint(nextProvider) ?? null : null
    );
    setNotice(
      binding.changed
        ? '已保存新端点，清除旧模型缓存与 MCP 授权；只有重新输入的凭据会绑定到新地址。'
        : apiKeyChanged
          ? '服务商 Key 已更新；绑定的 MCP 已关闭，请重新核对并授权后再启用。'
          : '服务商配置已安全保存在本机。'
    );
    return nextProvider;
  }

  function saveProviderDraft(): void {
    void persistProviderDraft().catch((error) => {
      setNotice(error instanceof Error ? error.message : '服务商配置保存失败。');
    });
  }

  function changeProviderBindingDraft(patch: {
    kind?: ProviderProfile['kind'];
    baseUrl?: string;
  }) {
    const nextKind = patch.kind ?? providerKindDraft;
    const nextBaseUrl = patch.baseUrl ?? providerBaseUrlDraft;
    if (patch.kind) setProviderKindDraft(patch.kind);
    if (patch.baseUrl !== undefined) setProviderBaseUrlDraft(patch.baseUrl);
    const nextFingerprint = providerEndpointFingerprint({ kind: nextKind, baseUrl: nextBaseUrl });
    if (providerApiKeyDraft && providerKeyBindingFingerprint !== nextFingerprint) {
      setProviderApiKeyDraft('');
      setProviderKeyBindingFingerprint(null);
    }
  }

  async function selectProvider(providerId: string): Promise<boolean> {
    if (!ensureWritable()) return false;
    const current = session.getSnapshot();
    const provider = current.providers.find((item) => item.id === providerId);
    if (!isProviderEnabled(provider)) {
      setNotice('请先启用该供应商。');
      return false;
    }
    if (resolveEnabledProvider(current.providers, current.activeProviderId)?.id === providerId) {
      return true;
    }
    if (!ensureConfigurationIdle()) return false;
    const accepted = await execute({ type: 'provider.select', providerId });
    if (!accepted) return false;
    chatProjectNavigation.discardPendingAttachments();
    setModelSearchQuery('');
    setModelCapabilityFilter('all');
    return true;
  }

  async function toggleProviderEnabled(providerId: string) {
    if (!ensureWritable() || !ensureConfigurationIdle()) return;
    const current = session.getSnapshot();
    const provider = current.providers.find((item) => item.id === providerId);
    if (!provider) return;
    if (isProviderEnabled(provider) && current.providers.filter(isProviderEnabled).length <= 1) {
      setNotice('至少需要保留一个已启用的供应商。');
      return;
    }
    const changesActiveTarget =
      resolveEnabledProvider(current.providers, current.activeProviderId)?.id === providerId &&
      isProviderEnabled(provider);
    const accepted = await execute({
      type: 'provider.toggle-enabled',
      providerId,
      now: Date.now(),
    });
    if (!accepted) return;
    if (changesActiveTarget) chatProjectNavigation.discardPendingAttachments();
    setNotice(isProviderEnabled(provider) ? '已禁用供应商并停止其运行时目标。' : '已启用供应商。');
  }

  async function addCustomProvider() {
    if (!ensureWritable()) return;
    const provider: ProviderProfile = {
      id: createId('provider'),
      name: 'Custom Provider',
      kind: 'custom',
      baseUrl: 'https://your-provider.example.com/v1',
      capabilities: ['text', 'image-input', 'streaming'],
      models: [],
    };
    const accepted = await execute({ type: 'provider.add', provider });
    if (!accepted) return;
    chatProjectNavigation.discardPendingAttachments();
    setManualModelId('');
    setModelSearchQuery('');
    setModelCapabilityFilter('all');
  }

  async function deleteProvider(providerId: string, onDeleted?: () => void) {
    if (!ensureWritable() || !ensureConfigurationIdle()) return;
    const current = session.getSnapshot();
    if (current.providers.length <= 1) {
      setNotice('至少需要保留一个服务商。');
      return;
    }
    const removal = removeProviderFromWorkspace(current, providerId, Date.now());
    if (!removal) return;
    const accepted = await execute({ type: 'provider.delete', providerId, now: Date.now() });
    if (!accepted) return;
    if (resolveEnabledProvider(current.providers, current.activeProviderId)?.id === providerId) {
      chatProjectNavigation.discardPendingAttachments();
    }
    try {
      await runtime.flush({ propagateFailure: true });
      setNotice(
        `已删除服务商、本地 API Key 及 ${removal.removedPluginIds.length} 个绑定 MCP 配置和授权。`
      );
      onDeleted?.();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '服务商已移除，但本机持久化失败。');
    }
  }

  async function selectModel(modelId: string): Promise<boolean> {
    if (!ensureWritable() || !activeProvider) return false;
    const current = session.getSnapshot();
    const currentProvider = resolveEnabledProvider(current.providers, current.activeProviderId);
    if (!currentProvider || currentProvider.id !== activeProvider.id) {
      setNotice('当前服务商已变化，请重新选择模型。');
      return false;
    }
    const selectableModels = getSelectableModels(currentProvider);
    const savedModelId = current.activeModelIdByProvider[currentProvider.id];
    const currentModelId = selectableModels.some((model) => model.id === savedModelId)
      ? savedModelId
      : selectableModels[0]?.id ?? '';
    if (currentModelId === modelId) return true;
    if (!ensureConfigurationIdle()) return false;
    const accepted = await execute({
      type: 'model.select',
      providerId: activeProvider.id,
      modelId,
    });
    if (accepted) chatProjectNavigation.discardPendingAttachments();
    return accepted;
  }

  async function addManualModel() {
    if (!ensureWritable() || !ensureConfigurationIdle() || !activeProvider) return;
    const modelId = manualModelId.trim();
    if (!modelId) {
      setNotice('请输入模型 ID。');
      return;
    }
    const accepted = await execute({
      type: 'model.add',
      providerId: activeProvider.id,
      model: createModelInfoFromId(activeProvider, modelId, 'manual'),
    });
    if (!accepted) return;
    chatProjectNavigation.discardPendingAttachments();
    setManualModelId('');
  }

  async function addCandidateModel(model: ModelInfo) {
    if (!ensureWritable() || !ensureConfigurationIdle() || !activeProvider) return;
    const accepted = await execute({
      type: 'model.add',
      providerId: activeProvider.id,
      model: {
        ...model,
        task: inferModelTask(model),
        source: model.source === 'preset' ? 'manual' : model.source,
      },
    });
    if (!accepted) return;
    chatProjectNavigation.discardPendingAttachments();
    setNotice(`已添加并启用 ${model.name ?? model.id}。`);
  }

  async function removeModel(modelId: string) {
    if (!ensureWritable() || !ensureConfigurationIdle() || !activeProvider) return;
    const changesActiveTarget = activeModelId === modelId;
    const accepted = await execute({
      type: 'model.remove',
      providerId: activeProvider.id,
      modelId,
      now: Date.now(),
    });
    if (!accepted) return;
    if (changesActiveTarget) chatProjectNavigation.discardPendingAttachments();
    setNotice('已移除模型。');
  }

  async function updateActiveModel(patch: Partial<ModelInfo>): Promise<boolean> {
    if (!ensureWritable() || !ensureConfigurationIdle() || !activeProvider || !activeModel) {
      return false;
    }
    return execute({
      type: 'model.update',
      providerId: activeProvider.id,
      modelId: activeModel.id,
      patch,
    });
  }

  async function setActiveModelTask(task: ModelTask): Promise<void> {
    if (!activeModel) return;
    const taskCapabilities: Partial<Record<ModelTask, Capability>> = {
      'image-generation': 'image-generation',
      'video-generation': 'video-generation',
      'audio-transcription': 'speech-to-text',
      'speech-generation': 'text-to-speech',
      embedding: 'embedding',
      rerank: 'rerank',
    };
    const taskCapabilitySet = new Set(
      Object.values(taskCapabilities).filter((value): value is Capability => Boolean(value))
    );
    const selectedCapability = taskCapabilities[task];
    const capabilities = activeModel.capabilities.filter(
      (capability) => !taskCapabilitySet.has(capability)
    );
    if (selectedCapability) capabilities.push(selectedCapability);
    const capabilityOverrides = { ...activeModel.capabilityOverrides };
    for (const capability of taskCapabilitySet) {
      capabilityOverrides[capability] = capability === selectedCapability;
    }
    if (await updateActiveModel({ task, capabilities, capabilityOverrides })) {
      chatProjectNavigation.discardPendingAttachments();
    }
  }

  async function toggleActiveModelCapability(capability: Capability): Promise<void> {
    if (!activeModel) return;
    const enabled = !activeModel.capabilities.includes(capability);
    const accepted = await updateActiveModel({
      capabilities: enabled
        ? [...activeModel.capabilities, capability]
        : activeModel.capabilities.filter((value) => value !== capability),
      capabilityOverrides: { ...activeModel.capabilityOverrides, [capability]: enabled },
    });
    if (
      accepted &&
      !enabled &&
      (capability === 'file-input' || capability === 'image-input' || capability === 'video-input')
    ) {
      chatProjectNavigation.discardPendingAttachments();
    }
  }

  async function refreshModels() {
    if (!ensureWritable() || !activeProvider) return;
    const configuredProvider = await persistProviderDraft();
    if (!configuredProvider) return;
    if (!configuredProvider.apiKey?.trim() && configuredProvider.kind !== 'volcengine-ark') {
      setNotice('连接检查需要该服务商自己的 API Key；不会发送生成请求，只请求模型目录。');
      return;
    }
    setRefreshingModels(true);
    setNotice('正在请求服务商模型目录；这不是模型生成测试，也不会由 Embezzle Studio 提供额度。');
    try {
      const activityResult = await chatConfiguration.run('模型列表刷新', (signal) =>
        refreshProviderModels(configuredProvider, signal)
      );
      if (!activityResult.ok) {
        if (activityResult.reason === 'busy') {
          setNotice(activityResult.notice.replace('稍后重试', '稍后刷新模型'));
          return;
        }
        throw activityResult.error;
      }
      const result = activityResult.value;
      await execute({
        type: 'model.set-candidates',
        providerId: configuredProvider.id,
        models: result.models,
      });
      setModelSearchQuery('');
      setModelCapabilityFilter('all');
      setNotice(result.notice);
    } catch (error) {
      if (!isAbortError(error)) {
        await execute({
          type: 'model.set-candidates',
          providerId: configuredProvider.id,
          models: [],
        });
        setNotice(error instanceof Error ? error.message : '模型列表获取失败。');
      }
    } finally {
      setRefreshingModels(false);
    }
  }

  async function checkUpdates() {
    if (checkingUpdate) return;
    setCheckingUpdate(true);
    setUpdateNotice('正在检查更新…');
    try {
      const info = await checkForAppUpdate();
      setUpdateInfo(info);
      setUpdateNotice(
        info.updateAvailable
          ? `发现新版本 v${info.latestVersion}`
          : info.installAsset
            ? '当前已是最新版本。'
            : '当前没有通过完整信任链校验的 Android 更新包。'
      );
    } catch (error) {
      setUpdateNotice(error instanceof Error ? error.message : '检查更新失败。');
    } finally {
      setCheckingUpdate(false);
    }
  }

  function openUpdateTarget(kind: 'release' | 'install') {
    const target =
      kind === 'install'
        ? updateInfo?.installAsset?.downloadUrl
        : updateInfo?.releaseUrl ?? appInfo.releasesUrl;
    if (target) void Linking.openURL(target);
  }

  if (!activeProvider) {
    throw new Error('Settings requires at least one enabled provider.');
  }

  return {
    onClose,
    status: {
      readOnly: workspaceReadOnly,
      notice: [notice, appearance.notice].filter(Boolean).join('\n'),
    },
    appearance: {
      colorMode: appearance.colorMode,
      onSetColorMode: appearance.setColorMode,
    },
    providers: {
      providers: workspace.providers,
      activeProvider,
      nameDraft: providerNameDraft,
      kindDraft: providerKindDraft,
      baseUrlDraft: providerBaseUrlDraft,
      apiKeyDraft: providerApiKeyDraft,
      endpointInspection: providerEndpointInspection,
      select: selectProvider,
      toggleEnabled: toggleProviderEnabled,
      delete: deleteProvider,
      addCustom: addCustomProvider,
      setNameDraft: setProviderNameDraft,
      changeBindingDraft: changeProviderBindingDraft,
      setApiKeyDraft: (apiKey) => {
        setProviderApiKeyDraft(apiKey);
        setProviderKeyBindingFingerprint(
          apiKey.trim()
            ? providerEndpointFingerprint({
                kind: providerKindDraft,
                baseUrl: providerBaseUrlDraft,
              }) ?? null
            : null
        );
      },
      saveDraft: saveProviderDraft,
    },
    models: {
      activeModelId,
      activeModel,
      addedModels,
      addedModelIds,
      candidates: modelCandidates,
      filteredCandidates: filteredModelCandidates,
      renderedCandidates: renderedModelCandidates,
      searchQuery: modelSearchQuery,
      capabilityFilter: modelCapabilityFilter,
      candidateFilters: candidateModelFilters,
      manualModelId,
      refreshing: refreshingModels,
      hasMoreCandidates: renderedModelCandidates.length < filteredModelCandidates.length,
      refresh: refreshModels,
      setSearchQuery: setModelSearchQuery,
      setCapabilityFilter: setModelCapabilityFilter,
      addCandidate: addCandidateModel,
      clearCandidates: () => {
        if (!ensureWritable()) return;
        void execute({
          type: 'model.set-candidates',
          providerId: activeProvider.id,
          models: [],
        });
        setModelSearchQuery('');
        setModelCapabilityFilter('all');
      },
      setManualModelId,
      addManual: addManualModel,
      select: selectModel,
      remove: removeModel,
      setActiveTask: setActiveModelTask,
      toggleActiveCapability: toggleActiveModelCapability,
      loadMore: () => setCandidateModelRenderLimit((current) => current + candidateModelPageSize),
    },
    updates: {
      checking: checkingUpdate,
      info: updateInfo,
      notice: updateNotice || `${appInfo.name} ${appInfo.version}`,
      check: checkUpdates,
      openTarget: openUpdateTarget,
    },
  };
}
