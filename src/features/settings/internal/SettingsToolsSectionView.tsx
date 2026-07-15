import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, ScrollView, Text, TextInput, View } from 'react-native';
import {
  BookOpen,
  Download,
  FileText,
  HardDrive,
  KeyRound,
  MessageSquare,
  Pin,
  RefreshCw,
  ShieldCheck,
  Stethoscope,
  Trash2,
  Wrench,
  X,
} from 'lucide-react-native';

import {
  useWorkspaceSelector,
  useWorkspaceStatus,
} from '../../../app/workspace/WorkspaceSessionProvider';
import { useWorkspaceSession } from '../../../app/workspace/internal/WorkspaceSessionContext';
import { workspaceProjectPresets, type WorkspaceProjectPreset } from '../../../data/workspaceProjectPresets';
import type {
  ExternalSearchProviderKind,
  MediaAttachment,
  ModelInfo,
  ModelPricing,
  PricingCurrency,
  ProviderProfile,
} from '../../../domain/types';
import {
  useChatActivity,
  useChatConfigurationActions,
  useChatProjectNavigation,
  useChatTaskActions,
} from '../../chat';
import {
  applyProjectConversationChatEffects,
  type ProjectConversationResult,
  useProjectConversationNavigation,
} from '../../projects';
import {
  getProviderAudioReadiness,
  resolveConfiguredProviderAudioTarget,
  resolveProviderAudioProtocol,
} from '../../../services/providerAudio';
import {
  deriveGenerationTasks,
  filterGenerationTasks,
} from '../../../services/generationTasks';
import { createId } from '../../../services/id';
import {
  externalSearchProviderLabels,
  externalSearchProviderRequiresApiKey,
} from '../../../services/externalSearch';
import { resolveProviderWebSearchProtocol } from '../../../services/providerWebSearch';
import { inferModelTask } from '../../../services/modelCapabilities';
import { isProviderEnabled } from '../../../services/workspaceRuntime';
import {
  aggregateUsage,
} from '../../../services/usageAnalytics';
import { summarizeDailyProviderUsage } from '../../../services/costGuard';
import {
  exportEncryptedWorkspaceBackup,
  importEncryptedWorkspaceBackup,
  verifyEncryptedWorkspaceBackup,
} from '../../../services/workspaceBackup';
import {
  exportWorkspaceBackupFile,
  pickWorkspaceBackupFile,
} from '../../../services/workspaceBackupIO';
import { isWorkspaceReplacementError } from '../../../services/workspaceReplacement';
import { saveAttachmentToDevice } from '../../../services/mediaExport';
import {
  deletePersistedAttachments,
  cleanupOrphanedMediaStorage,
  flushPendingAttachmentDeletions,
} from '../../../services/mediaStorage';
import {
  createRedactedDiagnosticBundle,
  exportRedactedDiagnosticBundle,
  type RedactedDiagnosticBundle,
} from '../../../services/localDiagnostics';
import {
  cloudSyncSettingsAfterError,
  resolveCloudSyncConflict,
  synchronizeWorkspace,
} from '../../../services/cloudSync';
import {
  clearCloudSyncCredentials,
  readCloudSyncCredentials,
  writeCloudSyncCredentials,
  type CloudSyncCredentialRecord,
} from '../../../services/cloudSyncCredentials';
import { refreshProviderModels } from '../../../services/modelDiscovery';
import { classifyProviderConnectionError } from '../../../services/providerDiagnostics';
import { isAbortError } from '../../../services/openAiCompatible';
import { isBackupReminderDue } from '../../../services/workspaceProductState';
import { AnimatedPressable } from '../../../ui/components/AnimatedPressable';
import { GenerationTaskNotificationPermissionButton } from '../../background';
import {
  SearchServicesPanel,
  type SearchServicesPanelHandle,
} from '../../../ui/components/SearchServicesPanel';
import { requestConfirm } from '../../../ui/components/dialogService';
import { useKelivoTheme } from '../../../ui/theme';
import type { SettingsToolsSection } from '../../../app/navigation/settingsNavigation';
import { useSettingsLauncher } from '../useSettingsLauncher';
import { useSettingsToolsDrafts } from './useSettingsDrafts';
import { createSettingsToolsStyles } from './settingsToolsStyles';
import { SettingsWorkspaceRuntime } from './SettingsWorkspaceRuntime';
import { createRemoteMcpPlugin, prepareRemoteMcpEnable } from './settingsMcpPolicy';

function getSelectableModels(provider: ProviderProfile): ModelInfo[] {
  return provider.models.filter((model) => model.source !== 'remote');
}

function formatTokenCount(value?: number): string {
  return typeof value === 'number' ? value.toLocaleString() : '-';
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatCompactModelName(modelId?: string, _providerName?: string, maxLength = 18): string {
  const raw = (modelId ?? '').trim();
  if (!raw) return 'Model';
  const withoutDate = raw.replace(/[-_.]\d{6,8}$/u, '');
  return withoutDate.length > maxLength
    ? `${withoutDate.slice(0, Math.max(1, maxLength - 3))}...`
    : withoutDate;
}

export function SettingsToolsSectionView(props: {
  section: SettingsToolsSection;
}): React.ReactElement | null {
  const { section } = props;
  const theme = useKelivoTheme();
  const styles = useMemo(() => createSettingsToolsStyles(theme), [theme]);
  const palette = useMemo(
    () => ({
      accent: theme.colors.accent,
      danger: theme.colors.error,
      placeholder: theme.colors.placeholder,
      text: theme.colors.text,
      textOnAccent: theme.colors.textOnAccent,
      textSecondary: theme.colors.textSecondary,
    }),
    [theme]
  );
  const session = useWorkspaceSession();
  const status = useWorkspaceStatus();
  const workspace = useWorkspaceSelector((snapshot) => snapshot);
  const runtime = useMemo(() => new SettingsWorkspaceRuntime(session), [session]);
  const commitWorkspaceCommand = runtime.execute.bind(runtime);
  const chatActivity = useChatActivity();
  const chatConfiguration = useChatConfigurationActions();
  const chatProjectNavigation = useChatProjectNavigation();
  const chatActivityRef = useRef(chatActivity);
  chatActivityRef.current = chatActivity;
  const chatTasks = useChatTaskActions();
  const projectsNavigation = useProjectConversationNavigation();
  const settingsLauncher = useSettingsLauncher();
  const workspaceReadOnly = status.phase !== 'ready';
  const [notice, setNotice] = useState('');
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);
  const [diagnostics, setDiagnostics] = useState<RedactedDiagnosticBundle | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncProviderDraft, setSyncProviderDraft] = useState<'webdav' | 's3'>('webdav');
  const [syncEndpointDraft, setSyncEndpointDraft] = useState('');
  const [syncRemotePathDraft, setSyncRemotePathDraft] = useState('Embezzle-Studio');
  const [syncBucketDraft, setSyncBucketDraft] = useState('');
  const [syncRegionDraft, setSyncRegionDraft] = useState('');
  const [syncUsernameDraft, setSyncUsernameDraft] = useState('');
  const [syncPasswordDraft, setSyncPasswordDraft] = useState('');
  const [syncAccessKeyDraft, setSyncAccessKeyDraft] = useState('');
  const [syncSecretKeyDraft, setSyncSecretKeyDraft] = useState('');
  const [syncSessionTokenDraft, setSyncSessionTokenDraft] = useState('');
  const [syncEncryptionPasswordDraft, setSyncEncryptionPasswordDraft] = useState('');
  const syncBindingKeyRef = useRef('');
  const [comparisonConfigProviderId, setComparisonConfigProviderId] = useState<string | null>(null);
  const [projectNewName, setProjectNewName] = useState('');
  const [projectNameDraft, setProjectNameDraft] = useState('');
  const [projectSystemPromptDraft, setProjectSystemPromptDraft] = useState('');
  const queryingTaskByMessageId = chatTasks.queryingByMessageId;
  const searchServicesPanelRef = useRef<SearchServicesPanelHandle>(null);
  const drafts = useSettingsToolsDrafts(workspace);
  const {
    promptTemplateName, setPromptTemplateName,
    promptTemplateContent, setPromptTemplateContent,
    promptTemplateMode, setPromptTemplateMode,
    pricingInputDraft, setPricingInputDraft,
    pricingCachedDraft, setPricingCachedDraft,
    pricingOutputDraft, setPricingOutputDraft,
    costMaxOutputDraft, setCostMaxOutputDraft,
    costDailyRequestDraft, setCostDailyRequestDraft,
    costDailyCnyDraft, setCostDailyCnyDraft,
    costDailyUsdDraft, setCostDailyUsdDraft,
    generationTaskFilter, setGenerationTaskFilter,
    backupPassword, setBackupPassword,
    backupBusy, setBackupBusy,
    mcpName, setMcpName,
    mcpEndpoint, setMcpEndpoint,
    mcpDescription, setMcpDescription,
    mcpAllowedTools, setMcpAllowedTools,
    mcpAuthorization, setMcpAuthorization,
    analyticsSnapshot, setAnalyticsSnapshot,
  } = drafts;

  const activeProvider = useMemo(
    () =>
      workspace.providers.find(
        (provider) => provider.id === workspace.activeProviderId && provider.enabled !== false
      ) ?? workspace.providers.find((provider) => provider.enabled !== false),
    [workspace.activeProviderId, workspace.providers]
  );
  const activeProject = useMemo(
    () =>
      workspace.projects.find((project) => project.id === workspace.activeProjectId) ??
      workspace.projects[0],
    [workspace.activeProjectId, workspace.projects]
  );
  const addedModels = activeProvider ? getSelectableModels(activeProvider) : [];
  const activeModelId = activeProvider
    ? workspace.activeModelIdByProvider[activeProvider.id] || addedModels[0]?.id || ''
    : '';
  const activeModel = addedModels.find((model) => model.id === activeModelId);
  const activeModelPricing = workspace.modelPricing
    .filter(
      (pricing) =>
        pricing.providerId === activeProvider?.id && pricing.modelId === activeModelId
    )
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
  const comparisonRuntimes = useMemo(
    () =>
      workspace.comparisonTargets.flatMap((target) => {
        const provider = workspace.providers.find((item) => item.id === target.providerId);
        const model = provider?.models.find((item) => item.id === target.modelId);
        return provider && provider.enabled !== false && model && inferModelTask(model) === 'chat'
          ? [{ provider, model }]
          : [];
      }),
    [workspace.comparisonTargets, workspace.providers]
  );
  const comparisonActive = workspace.comparisonEnabled && comparisonRuntimes.length >= 2;
  const comparisonTargetLimit = workspace.costGuard.enabled
    ? workspace.costGuard.maxComparisonTargets
    : 4;
  const configuredTranscriptionTarget = resolveConfiguredProviderAudioTarget(
    workspace,
    'transcription'
  );
  const configuredSpeechTarget = resolveConfiguredProviderAudioTarget(workspace, 'speech');
  const activeAudioReadiness = activeProvider ? getProviderAudioReadiness(activeProvider) : null;
  const canSetActiveTranscriptionTarget = Boolean(
    Platform.OS === 'android' &&
      activeModel &&
      inferModelTask(activeModel) === 'audio-transcription' &&
      activeModel.capabilities.includes('speech-to-text') &&
      activeAudioReadiness?.canTranscribe
  );
  const canSetActiveSpeechTarget = Boolean(
    Platform.OS === 'android' &&
      activeModel &&
      inferModelTask(activeModel) === 'speech-generation' &&
      activeModel.capabilities.includes('text-to-speech') &&
      activeAudioReadiness?.canSynthesize
  );
  const configuredSpeechProtocol = useMemo(() => {
    if (!configuredSpeechTarget) return undefined;
    try {
      return resolveProviderAudioProtocol(configuredSpeechTarget.provider);
    } catch {
      return undefined;
    }
  }, [configuredSpeechTarget]);

  useEffect(() => {
    const settings = workspace.cloudSync;
    const binding = {
      provider: settings.provider,
      endpoint: settings.endpoint,
      remotePath: settings.remotePath,
      ...(settings.provider === 's3' && settings.bucket ? { bucket: settings.bucket } : {}),
      ...(settings.provider === 's3' && settings.region ? { region: settings.region } : {}),
    } as const;
    const bindingKey = JSON.stringify({ ...binding, enabled: settings.enabled });
    if (syncBindingKeyRef.current === bindingKey) return;
    syncBindingKeyRef.current = bindingKey;
    setSyncProviderDraft(settings.provider);
    setSyncEndpointDraft(settings.endpoint);
    setSyncRemotePathDraft(settings.remotePath || 'Embezzle-Studio');
    setSyncBucketDraft(settings.bucket ?? '');
    setSyncRegionDraft(settings.region ?? '');
    setSyncUsernameDraft('');
    setSyncPasswordDraft('');
    setSyncAccessKeyDraft('');
    setSyncSecretKeyDraft('');
    setSyncSessionTokenDraft('');
    setSyncEncryptionPasswordDraft('');
    if (!settings.enabled) return;
    let cancelled = false;
    void readCloudSyncCredentials(binding)
      .then((credentials) => {
        if (cancelled || !credentials) return;
        setSyncUsernameDraft(credentials.username ?? '');
        setSyncPasswordDraft(credentials.password ?? '');
        setSyncAccessKeyDraft(credentials.accessKeyId ?? '');
        setSyncSecretKeyDraft(credentials.secretAccessKey ?? '');
        setSyncSessionTokenDraft(credentials.sessionToken ?? '');
        setSyncEncryptionPasswordDraft(credentials.encryptionPassword);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [workspace.cloudSync]);
  const webSearchReady = Boolean(
    activeProvider?.apiKey?.trim() &&
      activeModel?.capabilities.includes('web-search') &&
      (() => {
        try {
          if (activeProvider && activeModel) {
            resolveProviderWebSearchProtocol(activeProvider);
            return true;
          }
        } catch {
          return false;
        }
        return false;
      })()
  );
  const webSearchContextSizeApplies = (() => {
    try {
      return activeProvider ? resolveProviderWebSearchProtocol(activeProvider) === 'openai-official' : false;
    } catch {
      return false;
    }
  })();
  const usageAggregation = useMemo(
    () => aggregateUsage(analyticsSnapshot.conversations, analyticsSnapshot.modelPricing),
    [analyticsSnapshot]
  );
  const costGuardToday = useMemo(
    () => summarizeDailyProviderUsage(workspace.providerUsageEvents, Date.now()),
    [workspace.providerUsageEvents]
  );
  const knownCostRequestCount = Math.max(
    0,
    usageAggregation.totals.requestCount - usageAggregation.totals.unknown.cost
  );
  const generationTasks = useMemo(
    () => deriveGenerationTasks(analyticsSnapshot.conversations),
    [analyticsSnapshot.conversations]
  );
  const visibleGenerationTasks = useMemo(
    () => filterGenerationTasks(generationTasks, generationTaskFilter),
    [generationTaskFilter, generationTasks]
  );
  const referencedAttachments = useMemo(
    () => workspace.conversations.flatMap((conversation) =>
      conversation.messages.flatMap((message) => message.attachments ?? [])
    ),
    [workspace.conversations]
  );

  useEffect(() => {
    if (activeProject) {
      setProjectNameDraft(activeProject.name);
      setProjectSystemPromptDraft(activeProject.systemPrompt ?? '');
    }
  }, [activeProject]);

  useEffect(() => {
    setPricingInputDraft(
      activeModelPricing?.inputPerMillion !== undefined
        ? String(activeModelPricing.inputPerMillion)
        : ''
    );
    setPricingCachedDraft(
      activeModelPricing?.cachedInputPerMillion !== undefined
        ? String(activeModelPricing.cachedInputPerMillion)
        : ''
    );
    setPricingOutputDraft(
      activeModelPricing?.outputPerMillion !== undefined
        ? String(activeModelPricing.outputPerMillion)
        : ''
    );
  }, [activeModelPricing, setPricingCachedDraft, setPricingInputDraft, setPricingOutputDraft]);

  useEffect(() => {
    setCostMaxOutputDraft(String(workspace.costGuard.maxOutputTokens));
    setCostDailyRequestDraft(String(workspace.costGuard.dailyRequestLimit));
    setCostDailyCnyDraft(String(workspace.costGuard.dailyCnyBudget));
    setCostDailyUsdDraft(String(workspace.costGuard.dailyUsdBudget));
  }, [
    setCostDailyCnyDraft,
    setCostDailyRequestDraft,
    setCostDailyUsdDraft,
    setCostMaxOutputDraft,
    workspace.costGuard,
  ]);

  useEffect(() => {
    if (settingsLauncher.isOpen && !chatActivity.configurationLocked) {
      setAnalyticsSnapshot({
        conversations: workspace.conversations,
        modelPricing: workspace.modelPricing,
      });
    }
  }, [
    chatActivity.configurationLocked,
    setAnalyticsSnapshot,
    settingsLauncher.isOpen,
    workspace.conversations,
    workspace.modelPricing,
  ]);

  function ensureWorkspaceWritable(): boolean {
    const currentPhase = session.getStatus().phase;
    if (currentPhase === 'ready') return true;
    setNotice(
      currentPhase === 'replacing'
        ? '正在验证并导入备份，暂时不能修改设置。'
        : '工作区当前只读，无法保存设置。'
    );
    return false;
  }

  function ensureProviderConfigurationIdle(): boolean {
    if (!chatActivity.configurationLocked) return true;
    setNotice(`${chatActivity.label ?? '服务商操作'}仍在进行中，请稍后修改配置。`);
    return false;
  }

  function syncBindingFromDraft() {
    return {
      provider: syncProviderDraft,
      endpoint: syncEndpointDraft,
      remotePath: syncRemotePathDraft,
      ...(syncProviderDraft === 's3' && syncBucketDraft.trim()
        ? { bucket: syncBucketDraft }
        : {}),
      ...(syncProviderDraft === 's3' && syncRegionDraft.trim()
        ? { region: syncRegionDraft }
        : {}),
    } as const;
  }

  function syncCredentialsFromDraft(): CloudSyncCredentialRecord {
    return {
      ...(syncProviderDraft === 'webdav'
        ? { username: syncUsernameDraft, password: syncPasswordDraft }
        : {
            accessKeyId: syncAccessKeyDraft,
            secretAccessKey: syncSecretKeyDraft,
            ...(syncSessionTokenDraft ? { sessionToken: syncSessionTokenDraft } : {}),
          }),
      encryptionPassword: syncEncryptionPasswordDraft,
    };
  }

  async function persistSyncConfiguration(): Promise<CloudSyncCredentialRecord | null> {
    if (!ensureWorkspaceWritable()) return null;
    if (!syncEncryptionPasswordDraft) {
      setNotice('请填写同步加密密码；它只保存在本机安全存储或当前 Web 标签页。');
      return null;
    }
    const binding = syncBindingFromDraft();
    const credentials = syncCredentialsFromDraft();
    let credentialsWritten = false;
    try {
      await writeCloudSyncCredentials(binding, credentials);
      credentialsWritten = true;
      const accepted = await commitWorkspaceCommand({
        type: 'cloud-sync.update',
        patch: {
          enabled: true,
          provider: syncProviderDraft,
          endpoint: syncEndpointDraft,
          remotePath: syncRemotePathDraft,
          ...(syncProviderDraft === 's3'
            ? { bucket: syncBucketDraft, region: syncRegionDraft }
            : { bucket: undefined, region: undefined }),
          lastStatus: 'idle',
          lastError: undefined,
        },
      });
      if (!accepted) {
        await clearCloudSyncCredentials();
        setNotice('工作区当前不可写，未保存同步配置。');
        return null;
      }
      return credentials;
    } catch (error) {
      if (credentialsWritten) {
        try {
          // A failed workspace commit must not leave a new credential bound to
          // an unapplied or stale sync target. The user can retry explicitly.
          await clearCloudSyncCredentials();
        } catch {
          // Preserve the original error; secure-store cleanup is best effort.
        }
      }
      setNotice(error instanceof Error ? error.message : '同步凭据保存失败。');
      return null;
    }
  }

  async function syncNow() {
    if (syncBusy) return;
    const credentials = await persistSyncConfiguration();
    if (!credentials) return;
    setSyncBusy(true);
    try {
      const revision = session.getRevision();
      const result = await synchronizeWorkspace({
        workspace: session.getSnapshot(),
        credentials,
      });
      if (session.getRevision() !== revision) {
        throw new Error('同步期间工作区发生了变化；为避免覆盖本地修改，本次同步未应用。');
      }
      await session.replace(async () => result.workspace);
      setNotice(
        result.outcome === 'conflict'
          ? '检测到同步冲突；请明确选择保留本机或远端版本。'
          : `同步完成：${result.outcome === 'pulled' ? '已拉取远端版本' : result.outcome === 'pushed' ? '已上传本机版本' : result.outcome === 'initialized' ? '已初始化远端' : '内容未变化'}。`
      );
    } catch (error) {
      const current = session.getSnapshot();
      await commitWorkspaceCommand({
        type: 'cloud-sync.update',
        patch: cloudSyncSettingsAfterError(current.cloudSync, error),
      });
      setNotice(error instanceof Error ? error.message : '同步失败，请检查 Endpoint、凭据和远端条件写入能力。');
    } finally {
      setSyncBusy(false);
    }
  }

  async function resolveSyncConflict(conflictId: string, strategy: 'keep-local' | 'keep-remote') {
    if (syncBusy) return;
    const credentials = await persistSyncConfiguration();
    if (!credentials) return;
    setSyncBusy(true);
    try {
      const revision = session.getRevision();
      const result = await resolveCloudSyncConflict({
        workspace: session.getSnapshot(),
        credentials,
        conflictId,
        strategy,
      });
      if (session.getRevision() !== revision) {
        throw new Error('冲突处理期间工作区发生了变化；本次选择未应用。');
      }
      await session.replace(async () => result.workspace);
      setNotice(strategy === 'keep-local' ? '已通过条件写入保留本机版本。' : '已验证并导入远端版本。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '冲突处理失败，请刷新远端状态后重试。');
    } finally {
      setSyncBusy(false);
    }
  }

  async function clearSyncConfiguration() {
    if (!ensureWorkspaceWritable() || syncBusy) return;
    setSyncBusy(true);
    try {
      const accepted = await commitWorkspaceCommand({
        type: 'cloud-sync.update',
        patch: { enabled: false, lastStatus: 'idle', lastError: undefined, conflicts: [] },
      });
      if (!accepted) {
        setNotice('工作区当前不可写，未停用同步。');
        return;
      }
      setSyncUsernameDraft('');
      setSyncPasswordDraft('');
      setSyncAccessKeyDraft('');
      setSyncSecretKeyDraft('');
      setSyncSessionTokenDraft('');
      setSyncEncryptionPasswordDraft('');
      await clearCloudSyncCredentials();
      setNotice('已停用同步并清除本机保存的同步凭据。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '清除同步凭据失败。');
    } finally {
      setSyncBusy(false);
    }
  }

  function applyProjectConversationResult(result: ProjectConversationResult) {
    applyProjectConversationChatEffects(result, {
      showNotice: setNotice,
      resetComposer: chatProjectNavigation.resetComposer,
      clearTaskQueries: chatProjectNavigation.clearTaskQueries,
    });
  }

  async function createProjectFromInput(
    input: { name: string; systemPrompt?: string },
    successNotice: string
  ) {
    if (!ensureWorkspaceWritable()) return;
    const result = await projectsNavigation.execute({ type: 'project.create', input, successNotice });
    applyProjectConversationResult(result);
    if (result.ok) setProjectNewName('');
  }

  function createCustomProject() {
    void createProjectFromInput(
      { name: projectNewName },
      '项目已在本机创建；创建本身不会调用模型或产生费用。'
    );
  }

  function createPresetProject(preset: WorkspaceProjectPreset) {
    void createProjectFromInput(
      { name: preset.suggestedName, systemPrompt: preset.systemPrompt },
      `已创建“${preset.title}”本地预设项目；尚未调用模型或产生费用。`
    );
  }

  async function saveActiveProject() {
    if (!ensureWorkspaceWritable() || !activeProject) return;
    applyProjectConversationResult(
      await projectsNavigation.execute({
        type: 'project.update',
        projectId: activeProject.id,
        patch: { name: projectNameDraft, systemPrompt: projectSystemPromptDraft },
      })
    );
  }

  async function setProjectDefaultToCurrentModel() {
    if (!ensureWorkspaceWritable() || !activeProject || !activeProvider || !activeModelId) {
      setNotice('请先选择一个已添加模型。');
      return;
    }
    applyProjectConversationResult(
      await projectsNavigation.execute({
        type: 'project.setDefaultTarget',
        projectId: activeProject.id,
        providerId: activeProvider.id,
        modelId: activeModelId,
      })
    );
  }

  async function removeActiveProject() {
    if (!ensureWorkspaceWritable() || !activeProject) return;
    const fallback = workspace.projects.find((project) => project.id !== activeProject.id);
    if (!fallback) {
      setNotice('至少需要保留一个项目。');
      return;
    }
    const confirmed = await requestConfirm({
      title: `删除项目“${activeProject.name}”？`,
      description: `项目名称、系统提示和默认模型将被删除；相关对话、成果和资料会完整迁移到“${fallback.name}”。`,
      confirmLabel: '删除',
      cancelLabel: '取消',
      tone: 'danger',
    });
    if (!confirmed) return;
    applyProjectConversationResult(
      await projectsNavigation.execute({
        type: 'project.delete',
        projectId: activeProject.id,
        fallbackProjectId: fallback.id,
      })
    );
  }

  async function selectProject(projectId: string) {
    applyProjectConversationResult(await projectsNavigation.execute({ type: 'project.activate', projectId }));
  }

  async function selectConversation(conversationId: string) {
    applyProjectConversationResult(
      await projectsNavigation.execute({ type: 'conversation.activate', conversationId })
    );
  }

  async function toggleComparisonTarget(providerId: string, modelId: string) {
    if (!ensureWorkspaceWritable()) return;
    const alreadySelected = workspace.comparisonTargets.some(
      (target) => target.providerId === providerId && target.modelId === modelId
    );
    if (!alreadySelected && workspace.comparisonTargets.length >= comparisonTargetLimit) {
      setNotice(`当前费用保险丝允许最多选择 ${comparisonTargetLimit} 个对比模型。`);
      return;
    }
    const accepted = await commitWorkspaceCommand({
      type: 'comparison.toggle-target',
      target: { providerId, modelId },
    });
    if (accepted && comparisonActive) chatProjectNavigation.discardPendingAttachments();
  }

  async function setComparisonEnabled(enabled: boolean) {
    if (!ensureWorkspaceWritable() || !ensureProviderConfigurationIdle()) return;
    if (enabled && comparisonRuntimes.length < 2) {
      setNotice('请先选择至少 2 个对话模型。');
      return;
    }
    const accepted = await commitWorkspaceCommand({ type: 'comparison.set-enabled', enabled });
    if (accepted) chatProjectNavigation.discardPendingAttachments();
  }

  function upsertExternalSearchService(input: {
    serviceId?: string;
    kind: ExternalSearchProviderKind;
    name?: string;
    apiKey?: string;
    endpoint?: string;
    model?: string;
  }) {
    if (!ensureWorkspaceWritable() || !ensureProviderConfigurationIdle()) return;
    const apiKey = input.apiKey?.trim();
    if (externalSearchProviderRequiresApiKey(input.kind, input.endpoint) && !apiKey) {
      setNotice(`请填写 ${externalSearchProviderLabels[input.kind]} 的 API Key。`);
      return;
    }
    void commitWorkspaceCommand({
      type: 'external-search.upsert',
      input: { ...input, apiKey, newId: createId('ext-search') },
    });
  }

  function removeExternalSearchService(serviceId: string) {
    if (!ensureWorkspaceWritable()) return;
    void commitWorkspaceCommand({ type: 'external-search.remove', serviceId });
  }

  async function savePromptTemplate() {
    if (!ensureWorkspaceWritable()) return;
    try {
      const saved = await commitWorkspaceCommand({
        type: 'prompt.create',
        name: promptTemplateName,
        content: promptTemplateContent,
        mode: promptTemplateMode,
        id: createId('prompt'),
        now: Date.now(),
      });
      if (!saved) return;
      setPromptTemplateName('');
      setPromptTemplateContent('');
      setNotice('提示词模板已保存在本机。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '提示词模板保存失败。');
    }
  }

  function applyPromptTemplate(templateId: string) {
    chatProjectNavigation.applyPromptTemplate(templateId);
  }

  async function removePromptTemplate(templateId: string) {
    if (!ensureWorkspaceWritable()) return;
    try {
      await commitWorkspaceCommand({ type: 'prompt.delete', templateId });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '模板删除失败。');
    }
  }

  async function togglePromptTemplatePinned(templateId: string, pinned: boolean) {
    if (!ensureWorkspaceWritable()) return;
    try {
      await commitWorkspaceCommand({ type: 'prompt.pin', templateId, pinned, now: Date.now() });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '模板置顶状态更新失败。');
    }
  }

  function updateActiveModelPricing(
    patch: Partial<
      Pick<ModelPricing, 'currency' | 'inputPerMillion' | 'cachedInputPerMillion' | 'outputPerMillion'>
    >
  ) {
    if (!ensureWorkspaceWritable() || !activeProvider || !activeModelId) return;
    void commitWorkspaceCommand({
      type: 'pricing.update',
      providerId: activeProvider.id,
      modelId: activeModelId,
      patch,
      now: Date.now(),
    });
  }

  function updatePricingText(
    key: 'inputPerMillion' | 'cachedInputPerMillion' | 'outputPerMillion',
    value: string
  ) {
    const trimmed = value.trim();
    const parsed = trimmed ? Number(trimmed) : undefined;
    if (parsed !== undefined && (!Number.isFinite(parsed) || parsed < 0)) return;
    updateActiveModelPricing({ [key]: parsed });
  }

  function setActivePricingCurrency(currency: PricingCurrency) {
    updateActiveModelPricing({ currency });
  }

  function parsedNonNegativeDraft(value: string, label: string, integer = false): number {
    const parsed = Number(value.trim() || '0');
    if (!Number.isFinite(parsed) || parsed < 0 || (integer && !Number.isInteger(parsed))) {
      throw new Error(`${label}必须是非负${integer ? '整数' : '数字'}。`);
    }
    return parsed;
  }

  function saveCostGuardDrafts() {
    if (!ensureWorkspaceWritable()) return;
    try {
      const maxOutputTokens = parsedNonNegativeDraft(costMaxOutputDraft, '最大输出 Token', true);
      if (maxOutputTokens < 64 || maxOutputTokens > 131_072) {
        throw new Error('最大输出 Token 必须在 64–131072 之间。');
      }
      void commitWorkspaceCommand({
        type: 'cost-guard.update',
        patch: {
          maxOutputTokens,
          dailyRequestLimit: parsedNonNegativeDraft(costDailyRequestDraft, '每日请求上限', true),
          dailyCnyBudget: parsedNonNegativeDraft(costDailyCnyDraft, '每日 CNY 预算'),
          dailyUsdBudget: parsedNonNegativeDraft(costDailyUsdDraft, '每日 USD 预算'),
        },
      });
      setNotice('费用保险丝设置已保存在本机。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '费用保险丝设置无效。');
    }
  }

  function refreshTaskCenterItem(conversationId: string, messageId: string) {
    const message = workspace.conversations
      .find((item) => item.id === conversationId)
      ?.messages.find((item) => item.id === messageId);
    if (!message?.generationTask) {
      setNotice('找不到这条媒体任务的本地记录。');
      return;
    }
    void chatTasks.refresh(message, message.generationTask).then((result) => {
      if (result.notice) setNotice(result.notice);
    });
  }

  async function exportTaskCenterAttachment(attachment: MediaAttachment) {
    try {
      const result = await saveAttachmentToDevice(attachment);
      setNotice(
        result.status === 'cancelled'
          ? '已取消保存。'
          : result.status === 'shared'
            ? '已打开系统分享面板。'
            : '媒体文件已保存。'
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '媒体文件导出失败。');
    }
  }

  async function refreshDiagnostics() {
    if (diagnosticsBusy) return;
    setDiagnosticsBusy(true);
    try {
      const bundle = await createRedactedDiagnosticBundle(
        session.getSnapshot(),
        session.getStatus()
      );
      setDiagnostics(bundle);
      setNotice('诊断状态已在本机刷新；没有发送任何网络请求。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '读取本地诊断状态失败。');
    } finally {
      setDiagnosticsBusy(false);
    }
  }

  async function checkActiveProviderConnection() {
    if (!activeProvider || diagnosticsBusy) return;
    if (!activeProvider.apiKey?.trim()) {
      setNotice('当前服务商尚未配置 API Key；请先前往供应商设置。');
      return;
    }
    setDiagnosticsBusy(true);
    setNotice('正在请求模型目录验证网络与鉴权；这不会发送对话，也不能证明具体模型可推理。');
    try {
      const result = await chatConfiguration.run('诊断服务商连接', (signal) =>
        refreshProviderModels(activeProvider, signal)
      );
      if (!result.ok) {
        if (result.reason === 'busy') throw new Error(result.notice);
        throw result.error;
      }
      setNotice(
        result.value.source === 'remote'
          ? `模型目录请求成功，共 ${result.value.models.length} 项；真实模型权限、配额和计费仍需以一次明确发送的请求及服务商账单为准。`
          : '只加载到了本地模型目录，尚未证明当前账号与 Endpoint 可以连接。'
      );
      setDiagnostics(
        await createRedactedDiagnosticBundle(session.getSnapshot(), session.getStatus())
      );
    } catch (error) {
      if (!isAbortError(error)) {
        const issue = classifyProviderConnectionError(error);
        setNotice(`${issue.title}：${issue.guidance}\n${issue.detail}`);
      }
    } finally {
      setDiagnosticsBusy(false);
    }
  }

  async function cleanupMediaCache() {
    if (diagnosticsBusy) return;
    const confirmed = await requestConfirm({
      title: '清理异常媒体缓存？',
      description: '只删除 Embezzle Studio 自有目录中未被任何对话引用的文件；仍在工作区中的附件不会删除。',
      confirmLabel: '检查并清理',
      cancelLabel: '取消',
      tone: 'warning',
    });
    if (!confirmed) return;
    setDiagnosticsBusy(true);
    try {
      const result = await cleanupOrphanedMediaStorage(referencedAttachments);
      setNotice(`已清理 ${result.deletedCount} 个未引用文件，释放 ${formatBytes(result.deletedBytes)}。`);
      setDiagnostics(await createRedactedDiagnosticBundle(session.getSnapshot(), session.getStatus()));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '媒体缓存清理失败。');
    } finally {
      setDiagnosticsBusy(false);
    }
  }

  async function exportDiagnostics() {
    if (diagnosticsBusy) return;
    const confirmed = await requestConfirm({
      title: '导出脱敏诊断包？',
      description: '诊断包包含版本、状态、数量、服务商域名和最近错误分类；不包含 API Key、同步凭据、消息正文或附件字节。请仍在分享前自行复核文件。',
      confirmLabel: '生成并导出',
      cancelLabel: '取消',
      tone: 'warning',
    });
    if (!confirmed) return;
    setDiagnosticsBusy(true);
    try {
      const bundle = await createRedactedDiagnosticBundle(session.getSnapshot(), session.getStatus());
      setDiagnostics(bundle);
      const result = await exportRedactedDiagnosticBundle(bundle);
      setNotice(result === 'downloaded' ? '脱敏诊断包已下载。' : '已打开系统分享面板。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '诊断包导出失败。');
    } finally {
      setDiagnosticsBusy(false);
    }
  }

  async function exportEncryptedBackup() {
    if (!ensureWorkspaceWritable() || backupBusy) return;
    setBackupBusy(true);
    setNotice('正在本机加密备份…');
    try {
      const serialized = await exportEncryptedWorkspaceBackup(session.getSnapshot(), backupPassword);
      await verifyEncryptedWorkspaceBackup(serialized, backupPassword);
      const result = await exportWorkspaceBackupFile(serialized);
      await commitWorkspaceCommand({
        type: 'backup-preferences.update',
        patch: { lastExportedAt: Date.now(), lastVerifiedAt: Date.now(), snoozedUntil: undefined },
      });
      setNotice(result === 'downloaded' ? '加密备份已下载。' : '已打开系统分享面板。');
      setBackupPassword('');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '加密备份导出失败。');
    } finally {
      setBackupBusy(false);
    }
  }

  async function verifyEncryptedBackupOnly() {
    if (!ensureWorkspaceWritable() || backupBusy) return;
    setBackupBusy(true);
    setNotice('');
    try {
      const serialized = await pickWorkspaceBackupFile();
      if (serialized === null) {
        setNotice('已取消选择备份文件。');
        return;
      }
      const envelope = await verifyEncryptedWorkspaceBackup(serialized, backupPassword);
      await commitWorkspaceCommand({
        type: 'backup-preferences.update',
        patch: { lastVerifiedAt: Date.now(), snoozedUntil: undefined },
      });
      setNotice(`备份可成功解密并通过结构校验；导出时间 ${new Date(envelope.exportedAt).toLocaleString()}。未替换当前工作区。`);
      setBackupPassword('');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '备份验证失败。');
    } finally {
      setBackupBusy(false);
    }
  }

  async function importEncryptedBackup() {
    if (!ensureWorkspaceWritable() || backupBusy) return;
    const hasInFlightWorkspaceOperation = () => chatActivityRef.current.phase !== 'idle';
    if (hasInFlightWorkspaceOperation()) {
      setNotice('仍有对话、语音或媒体任务请求进行中；请先停止或等待完成，再导入备份。');
      return;
    }
    setBackupBusy(true);
    setNotice('');
    try {
      const serialized = await pickWorkspaceBackupFile();
      if (serialized === null) {
        setNotice('已取消选择备份文件。');
        return;
      }
      const confirmed = await requestConfirm({
        title: '导入并替换本机工作区？',
        description:
          '将替换当前配置、模板与对话。API Key 不从备份导入；只有服务商 ID、类型和地址都一致时才会继续使用本机安全存储中的 Key，MCP 授权也必须端点一致。媒体文件不包含在备份中。',
        confirmLabel: '继续导入',
        cancelLabel: '取消',
        tone: 'warning',
      });
      if (!confirmed) {
        setNotice('已取消导入。');
        return;
      }
      if (hasInFlightWorkspaceOperation()) {
        setNotice('确认期间开始了新的请求；为避免旧响应写入新工作区，本次导入未执行。');
        return;
      }
      let importedAttachments: MediaAttachment[] = [];
      const replacement = await session.replace(async () => {
        const currentWorkspace = session.getSnapshot();
        const importedWorkspace = await importEncryptedWorkspaceBackup(
          serialized,
          backupPassword,
          currentWorkspace
        );
        importedAttachments = importedWorkspace.conversations.flatMap((conversation) =>
          conversation.messages.flatMap((message) => message.attachments ?? [])
        );
        const importedAttachmentUris = new Set(
          importedAttachments.map((attachment) => attachment.uri)
        );
        await deletePersistedAttachments(
          currentWorkspace.conversations.flatMap((conversation) =>
            conversation.messages.flatMap((message) => message.attachments ?? [])
          ).filter((attachment) => !importedAttachmentUris.has(attachment.uri))
        );
        return importedWorkspace;
      });
      await flushPendingAttachmentDeletions(importedAttachments);
      await commitWorkspaceCommand({
        type: 'backup-preferences.update',
        patch: { lastVerifiedAt: Date.now(), snoozedUntil: undefined },
      });
      chatProjectNavigation.resetComposer();
      setBackupPassword('');
      if (replacement.status === 'committed-with-postcommit-error') {
        setNotice(
          `备份工作区已写入并切换，但安全凭据或保存收尾失败：${replacement.error.message}。请重新核对 API Key 与 MCP 授权；重启前后的可用状态可能不同。`
        );
      } else {
        setNotice('加密备份已验证并导入；API Key 仍来自本机安全存储。');
      }
    } catch (error) {
      if (isWorkspaceReplacementError(error) && error.stage === 'flush-current') {
        setNotice(
          `当前工作区无法安全保存，备份导入已中止；备份未解密、现有工作区未替换：${error.message}`
        );
      } else {
        setNotice(
          `备份导入未完成，现有工作区未替换：${error instanceof Error ? error.message : String(error)}`
        );
      }
    } finally {
      setBackupBusy(false);
    }
  }

  function addRemoteMcpServer() {
    if (!ensureWorkspaceWritable() || !ensureProviderConfigurationIdle()) return;
    const created = createRemoteMcpPlugin(
      {
        name: mcpName,
        endpoint: mcpEndpoint,
        description: mcpDescription,
        allowedTools: mcpAllowedTools,
        authorization: mcpAuthorization,
      },
      activeProvider,
      createId('mcp')
    );
    if (!created.ok) {
      setNotice(created.notice);
      return;
    }
    void commitWorkspaceCommand({ type: 'plugin.add', plugin: created.value });
    setMcpName('');
    setMcpEndpoint('');
    setMcpDescription('');
    setMcpAllowedTools('');
    setMcpAuthorization('');
    setNotice('MCP 服务与精确工具白名单已安全保存，默认关闭且不会自动调用。');
  }

  async function toggleRemoteMcpServer(pluginId: string, enabled: boolean) {
    if (!ensureWorkspaceWritable() || !ensureProviderConfigurationIdle()) return;
    const plugin = workspace.plugins.find((item) => item.id === pluginId);
    if (!plugin) return;
    if (enabled) {
      const prepared = prepareRemoteMcpEnable(workspace, pluginId);
      if (!prepared.ok) {
        setNotice(prepared.notice);
        return;
      }
      const confirmed = await requestConfirm({
        title: prepared.value.title,
        description: prepared.value.description,
        confirmLabel: '启用',
        cancelLabel: '取消',
        tone: 'warning',
      });
      if (!confirmed) return;
      if (chatActivityRef.current.configurationLocked) {
        setNotice('确认期间开始了新的服务商操作；本次 MCP 启用未执行。');
        return;
      }
      const revalidated = prepareRemoteMcpEnable(session.getSnapshot(), pluginId);
      if (!revalidated.ok) {
        setNotice(`确认期间配置已变化，本次 MCP 启用未执行：${revalidated.notice}`);
        return;
      }
    }
    void commitWorkspaceCommand({ type: 'plugin.set-enabled', pluginId, enabled });
    setNotice(
      enabled
        ? 'OpenAI MCP 已启用；每次工具调用仍必须在完整参数预览页单独批准。'
        : 'MCP 服务已关闭。'
    );
  }

  function removeRemoteMcpServer(pluginId: string) {
    if (!ensureWorkspaceWritable() || !ensureProviderConfigurationIdle()) return;
    void commitWorkspaceCommand({ type: 'plugin.remove', pluginId });
    setNotice('MCP 配置及其本机安全存储授权已移除。');
  }

  function setVoiceTarget(kind: 'transcription' | 'speech') {
    if (!ensureWorkspaceWritable() || !activeModel || !activeProvider) return;
    const capability = kind === 'transcription' ? 'speech-to-text' : 'text-to-speech';
    const expectedTask = kind === 'transcription' ? 'audio-transcription' : 'speech-generation';
    if (inferModelTask(activeModel) !== expectedTask) {
      setNotice(
        `当前模型用途必须设为${kind === 'transcription' ? '语音转写' : '语音合成'}，不能只勾选能力标签。`
      );
      return;
    }
    if (!activeModel.capabilities.includes(capability)) {
      setNotice(`当前模型未明确标记为${kind === 'transcription' ? '语音转写' : '语音合成'}能力。`);
      return;
    }
    const readiness = getProviderAudioReadiness(activeProvider);
    if (kind === 'transcription' ? !readiness.canTranscribe : !readiness.canSynthesize) {
      setNotice(readiness.message ?? '当前服务商尚未接通这个语音协议。');
      return;
    }
    const target = { providerId: activeProvider.id, modelId: activeModel.id };
    void commitWorkspaceCommand({
      type: 'voice.set-target',
      kind,
      target,
      protocol:
        readiness.protocol === 'bailian-compatible' || readiness.protocol === 'openai-official'
          ? readiness.protocol
          : undefined,
    });
    setNotice(`已将当前模型设为${kind === 'transcription' ? '语音输入转写' : '回答朗读'}目标。`);
  }

  function clearVoiceTarget(kind: 'transcription' | 'speech') {
    if (!ensureWorkspaceWritable()) return;
    void commitWorkspaceCommand({ type: 'voice.clear-target', kind });
  }

  function closeSettings() {
    settingsLauncher.close();
  }

  function settingsToolContent(section: SettingsToolsSection) {
      if (!activeProvider) {
        return null;
      }
      const comparisonConfigProvider = workspace.providers.find(
        (provider) => provider.id === comparisonConfigProviderId && isProviderEnabled(provider)
      ) ?? activeProvider;
      const comparisonConfigModels = getSelectableModels(comparisonConfigProvider);
      switch (section) {
        case 'workspace':
          return (
            <>
  <View style={styles.settingsCard} testID="project-workspace-settings-card">
                  <View style={styles.settingsCardHeader}>
                    <Text style={styles.settingsCardTitle}>项目工作区</Text>
                    <Text style={styles.modelOverrideHint}>{workspace.projects.length}/50</Text>
                  </View>
                  <Text style={styles.modelOverrideHint}>
                    项目、分支和搜索完全在本机运行。项目系统提示只在你主动发送消息时随正常请求交给所选服务商，不会额外调用模型。
                  </Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.providerRow}>
                    {workspace.projects.map((project) => (
                      <AnimatedPressable
                        key={`settings-project:${project.id}`}
                        accessibilityRole="button"
                        onPress={() => selectProject(project.id)}
                        style={[styles.providerChip, project.id === workspace.activeProjectId && styles.providerChipActive]}
                      >
                        <Text style={[styles.providerChipText, project.id === workspace.activeProjectId && styles.providerChipTextActive]}>
                          {project.name}
                        </Text>
                      </AnimatedPressable>
                    ))}
                  </ScrollView>
                  <View style={styles.fieldGroup}>
                    <Text style={styles.fieldLabel}>从本地预设开始</Text>
                    <View style={styles.projectPresetGrid}>
                      {workspaceProjectPresets.map((preset) => (
                        <AnimatedPressable
                          key={preset.id}
                          accessibilityRole="button"
                          accessibilityLabel={`创建${preset.title}预设项目`}
                          accessibilityState={{ disabled: workspaceReadOnly }}
                          disabled={workspaceReadOnly}
                          onPress={() => createPresetProject(preset)}
                          style={[styles.projectPresetCard, workspaceReadOnly && styles.buttonDisabled]}
                        >
                          <Text style={styles.projectPresetTitle}>{preset.title}</Text>
                          <Text style={styles.projectPresetDescription}>{preset.description}</Text>
                        </AnimatedPressable>
                      ))}
                    </View>
                    <Text style={styles.modelOverrideHint}>
                      预设只写入本机项目指令，不绑定模型、联网搜索或 MCP；只有你主动发送消息时才会交给所选服务商。
                    </Text>
                  </View>
                  <View style={styles.fieldGroup}>
                    <Text style={styles.fieldLabel}>创建空白项目</Text>
                    <TextInput
                      value={projectNewName}
                      editable={!workspaceReadOnly}
                      onChangeText={setProjectNewName}
                      placeholder="例如：产品研究"
                      placeholderTextColor={palette.placeholder}
                      style={styles.input}
                    />
                  </View>
                  <AnimatedPressable
                    accessibilityRole="button"
                    disabled={workspaceReadOnly || !projectNewName.trim()}
                    onPress={createCustomProject}
                    style={[styles.secondaryButton, (workspaceReadOnly || !projectNewName.trim()) && styles.buttonDisabled]}
                  >
                    <Text style={styles.secondaryButtonText}>创建本地项目</Text>
                  </AnimatedPressable>
                  <View style={styles.fieldGroup}>
                    <Text style={styles.fieldLabel}>当前项目名称</Text>
                    <TextInput
                      value={projectNameDraft}
                      editable={!workspaceReadOnly}
                      onChangeText={setProjectNameDraft}
                      style={styles.input}
                    />
                  </View>
                  <View style={styles.fieldGroup}>
                    <Text style={styles.fieldLabel}>新对话系统提示（可选）</Text>
                    <TextInput
                      value={projectSystemPromptDraft}
                      editable={!workspaceReadOnly}
                      multiline
                      onChangeText={setProjectSystemPromptDraft}
                      placeholder="仅为之后的新对话保存一份本地快照"
                      placeholderTextColor={palette.placeholder}
                      style={[styles.input, styles.promptTemplateContentInput]}
                    />
                  </View>
                  <Text style={styles.modelOverrideHint}>
                    默认模型：{activeProject?.defaultTarget
                      ? `${activeProject.defaultTarget.providerId} / ${activeProject.defaultTarget.modelId}`
                      : '未设置'}
                  </Text>
                  <AnimatedPressable accessibilityRole="button" onPress={saveActiveProject} style={styles.primaryButton}>
                    <Text style={styles.primaryButtonText}>保存当前项目</Text>
                  </AnimatedPressable>
                  <AnimatedPressable accessibilityRole="button" onPress={setProjectDefaultToCurrentModel} style={styles.secondaryButton}>
                    <Text style={styles.secondaryButtonText}>将当前模型设为项目默认</Text>
                  </AnimatedPressable>
                  {workspace.projects.length > 1 ? (
                    <AnimatedPressable accessibilityRole="button" onPress={removeActiveProject} style={styles.providerDeleteButton}>
                      <Trash2 size={15} color={palette.danger} strokeWidth={2.2} />
                      <Text style={styles.providerDeleteButtonText}>删除项目并迁移其中对话</Text>
                    </AnimatedPressable>
                  ) : null}
                </View>

            </>
          );
        case 'comparison':
          return (
            <>
  <View style={styles.settingsCard} testID="comparison-settings-card">
                  <View style={styles.settingsCardHeader}>
                    <Text style={styles.settingsCardTitle}>多模型同问对比</Text>
                    <Text style={styles.modelOverrideHint}>{workspace.comparisonTargets.length}/{comparisonTargetLimit}</Text>
                  </View>
                  <Text style={styles.modelOverrideHint}>
                    在各服务商标签间切换并选择 2–{comparisonTargetLimit} 个聊天模型。发送一次会产生同等数量的独立调用，费用由你的服务商账户结算。
                  </Text>
                  <View style={styles.fieldGroup}>
                    <Text style={styles.fieldLabel}>服务商</Text>
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={styles.providerRow}
                    >
                      {workspace.providers.filter(isProviderEnabled).map((provider) => (
                        <AnimatedPressable
                          key={`compare-provider:${provider.id}`}
                          accessibilityRole="button"
                          accessibilityState={{ selected: provider.id === comparisonConfigProvider.id }}
                          onPress={() => setComparisonConfigProviderId(provider.id)}
                          style={[
                            styles.providerChip,
                            provider.id === comparisonConfigProvider.id && styles.providerChipActive,
                          ]}
                        >
                          <Text
                            numberOfLines={1}
                            style={[
                              styles.providerChipText,
                              provider.id === comparisonConfigProvider.id && styles.providerChipTextActive,
                            ]}
                          >
                            {provider.name}
                          </Text>
                        </AnimatedPressable>
                      ))}
                    </ScrollView>
                  </View>
                  <View style={styles.fieldGroup}>
                    <Text style={styles.fieldLabel}>{comparisonConfigProvider.name} 的聊天模型</Text>
                    {comparisonConfigModels.some((model) => inferModelTask(model) === 'chat') ? (
                      <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={styles.providerRow}
                      >
                        {comparisonConfigModels
                          .filter((model) => inferModelTask(model) === 'chat')
                          .map((model) => {
                            const selected = workspace.comparisonTargets.some(
                              (target) => target.providerId === comparisonConfigProvider.id && target.modelId === model.id
                            );
                            return (
                              <AnimatedPressable
                                key={`compare:${comparisonConfigProvider.id}:${model.id}`}
                                accessibilityRole="checkbox"
                                accessibilityState={{ checked: selected }}
                                onPress={() => toggleComparisonTarget(comparisonConfigProvider.id, model.id)}
                                style={[styles.providerChip, selected && styles.providerChipActive]}
                              >
                                <Text
                                  numberOfLines={1}
                                  style={[styles.providerChipText, selected && styles.providerChipTextActive]}
                                >
                                  {formatCompactModelName(model.id, activeProvider.name)}
                                </Text>
                              </AnimatedPressable>
                            );
                          })}
                      </ScrollView>
                    ) : (
                      <View style={styles.settingsEmptyState}>
                        <Text style={styles.modelOverrideHint}>这个服务商尚未添加聊天模型，请先到模型配置中添加。</Text>
                      </View>
                    )}
                  </View>
                  <AnimatedPressable
                    accessibilityRole="switch"
                    accessibilityState={{ checked: comparisonActive }}
                    disabled={comparisonRuntimes.length < 2 || workspaceReadOnly}
                    onPress={() => setComparisonEnabled(!comparisonActive)}
                    style={[
                      styles.primaryButton,
                      (comparisonRuntimes.length < 2 || workspaceReadOnly) && styles.buttonDisabled,
                    ]}
                  >
                    <Text style={styles.primaryButtonText}>
                      {comparisonActive ? '关闭对比模式' : '开启对比模式'}
                    </Text>
                  </AnimatedPressable>
                </View>

            </>
          );
        case 'webSearch':
          return (
            <>
              <View style={styles.settingsCard}>
                <AnimatedPressable
                  accessibilityRole="button"
                  accessibilityLabel="添加搜索服务"
                  testID="search-service-add"
                  disabled={workspaceReadOnly}
                  onPress={() => searchServicesPanelRef.current?.openAdd()}
                  style={[styles.primaryButton, workspaceReadOnly && styles.buttonDisabled]}
                >
                  <Text style={styles.primaryButtonText}>添加搜索服务</Text>
                </AnimatedPressable>
              </View>
              <SearchServicesPanel
                ref={searchServicesPanelRef}
                readOnly={workspaceReadOnly}
                webSearch={workspace.webSearch}
                externalSearch={workspace.externalSearch}
                webSearchReady={webSearchReady}
                webSearchContextSizeApplies={webSearchContextSizeApplies}
                onSetSearchContextSize={(size) => {
                  if (!ensureWorkspaceWritable()) return;
                  void commitWorkspaceCommand({
                    type: 'search.update-provider',
                    patch: { searchContextSize: size },
                  });
                }}
                onRemoveExternalService={removeExternalSearchService}
                onAddExternalService={(input) => {
                  upsertExternalSearchService(input);
                }}
                onSetMaxResults={(count) => {
                  if (!ensureWorkspaceWritable()) return;
                  void commitWorkspaceCommand({
                    type: 'search.update-external',
                    patch: { maxResults: count },
                  });
                }}
                onSetMaxToolRounds={(count) => {
                  if (!ensureWorkspaceWritable()) return;
                  void commitWorkspaceCommand({
                    type: 'search.update-external',
                    patch: { maxToolRounds: count },
                  });
                }}
              />
            </>
          );
        case 'prompts':
          return (
            <>
  <View style={styles.settingsCard} testID="prompt-library-settings-card">
                  <View style={styles.settingsCardHeader}>
                    <Text style={styles.settingsCardTitle}>本地提示词与角色模板</Text>
                    <Text style={styles.modelOverrideHint}>{workspace.promptTemplates.length}/100</Text>
                  </View>
                  <Text style={styles.modelOverrideHint}>
                    仅保存在本机。输入模板插入草稿但不会自动发送；会话指令作为 system 消息加入当前对话。
                  </Text>
                  <View style={styles.fieldGroup}>
                    <Text style={styles.fieldLabel}>模板名称</Text>
                    <TextInput
                      value={promptTemplateName}
                      editable={!workspaceReadOnly}
                      onChangeText={setPromptTemplateName}
                      placeholder="例如：代码审查"
                      placeholderTextColor={palette.placeholder}
                      style={styles.input}
                    />
                  </View>
                  <View style={styles.toolSegmentRow}>
                    {(['composer', 'system'] as const).map((mode) => {
                      const selected = promptTemplateMode === mode;
                      return (
                        <AnimatedPressable
                          key={mode}
                          accessibilityRole="button"
                          onPress={() => setPromptTemplateMode(mode)}
                          style={[styles.toolSegment, selected && styles.toolSegmentActive]}
                        >
                          <Text style={[styles.toolSegmentText, selected && styles.toolSegmentTextActive]}>
                            {mode === 'composer' ? '插入输入框' : '会话指令'}
                          </Text>
                        </AnimatedPressable>
                      );
                    })}
                  </View>
                  <TextInput
                    value={promptTemplateContent}
                    editable={!workspaceReadOnly}
                    multiline
                    onChangeText={setPromptTemplateContent}
                    placeholder="填写模板正文；可保留 {{变量}} 供发送前编辑"
                    placeholderTextColor={palette.placeholder}
                    style={[styles.input, styles.promptTemplateContentInput]}
                  />
                  <AnimatedPressable
                    accessibilityRole="button"
                    disabled={workspaceReadOnly}
                    onPress={savePromptTemplate}
                    style={[styles.primaryButton, workspaceReadOnly && styles.buttonDisabled]}
                  >
                    <Text style={styles.primaryButtonText}>保存模板</Text>
                  </AnimatedPressable>
                  {workspace.promptTemplates.map((template) => (
                    <View key={template.id} style={styles.promptTemplateRow}>
                      <AnimatedPressable
                        accessibilityRole="button"
                        onPress={() => applyPromptTemplate(template.id)}
                        style={styles.promptTemplateMain}
                      >
                        <BookOpen size={16} color={palette.text} strokeWidth={2} />
                        <View style={styles.promptTemplateTextBlock}>
                          <Text numberOfLines={1} style={styles.promptTemplateName}>{template.name}</Text>
                          <Text numberOfLines={1} style={styles.modelOverrideHint}>
                            {template.mode === 'system' ? '会话指令' : '输入模板'} · {template.content}
                          </Text>
                        </View>
                      </AnimatedPressable>
                      <AnimatedPressable
                        accessibilityRole="button"
                        accessibilityLabel={template.pinnedAt ? '取消置顶模板' : '置顶模板'}
                        onPress={() => togglePromptTemplatePinned(template.id, Boolean(template.pinnedAt))}
                        style={styles.iconButton}
                      >
                        <Pin
                          size={15}
                          color={template.pinnedAt ? palette.accent : palette.textSecondary}
                          fill={template.pinnedAt ? palette.accent : 'transparent'}
                          strokeWidth={2}
                        />
                      </AnimatedPressable>
                      <AnimatedPressable
                        accessibilityRole="button"
                        accessibilityLabel="删除提示词模板"
                        onPress={() => removePromptTemplate(template.id)}
                        style={styles.iconButton}
                      >
                        <Trash2 size={15} color={palette.danger} strokeWidth={2} />
                      </AnimatedPressable>
                    </View>
                  ))}
                </View>

            </>
          );
        case 'costGuard':
          return (
            <>
  <View style={styles.settingsCard} testID="cost-guard-settings-card">
                  <View style={styles.settingsCardHeader}>
                    <View style={styles.costGuardTitleRow}>
                      <ShieldCheck size={18} color={palette.text} strokeWidth={2.2} />
                      <Text style={styles.settingsCardTitle}>费用保险丝</Text>
                    </View>
                    <Text style={styles.modelOverrideHint}>{workspace.costGuard.enabled ? '已开启' : '未开启'}</Text>
                  </View>
                  <Text style={styles.modelOverrideHint}>
                    只依据本机请求台账和用户填写的价格进行提醒或阻断，不是服务商账单，也无法覆盖其他设备、控制台调用或服务商未返回的费用。未知费用永远不会按 0 处理。
                  </Text>
                  <AnimatedPressable
                    accessibilityRole="switch"
                    accessibilityState={{ checked: workspace.costGuard.enabled }}
                    onPress={() => void commitWorkspaceCommand({
                      type: 'cost-guard.update',
                      patch: { enabled: !workspace.costGuard.enabled },
                    })}
                    style={styles.primaryButton}
                  >
                    <Text style={styles.primaryButtonText}>{workspace.costGuard.enabled ? '关闭费用保险丝' : '开启费用保险丝'}</Text>
                  </AnimatedPressable>
                  <View style={styles.fieldGroup}>
                    <Text style={styles.fieldLabel}>单次最大输出 Token</Text>
                    <TextInput value={costMaxOutputDraft} onChangeText={setCostMaxOutputDraft} keyboardType="numeric" style={styles.input} />
                    <Text style={styles.modelOverrideHint}>聊天/Responses 会按官方协议发送对应上限；推理模型的思考 Token 也可能占用上限。图片和视频生成不受该 Token 字段保护。</Text>
                  </View>
                  <View style={styles.fieldGroup}>
                    <Text style={styles.fieldLabel}>每日本机请求次数（0 为关闭）</Text>
                    <TextInput value={costDailyRequestDraft} onChangeText={setCostDailyRequestDraft} keyboardType="numeric" style={styles.input} />
                  </View>
                  <View style={styles.usagePricingGrid}>
                    <View style={styles.usagePricingField}>
                      <Text style={styles.fieldLabel}>每日 CNY 已知累计阈值（0 关闭）</Text>
                      <TextInput value={costDailyCnyDraft} onChangeText={setCostDailyCnyDraft} keyboardType="decimal-pad" style={styles.input} />
                    </View>
                    <View style={styles.usagePricingField}>
                      <Text style={styles.fieldLabel}>每日 USD 已知累计阈值（0 关闭）</Text>
                      <TextInput value={costDailyUsdDraft} onChangeText={setCostDailyUsdDraft} keyboardType="decimal-pad" style={styles.input} />
                    </View>
                  </View>
                  <Text style={styles.modelOverrideHint}>
                    本机无法可靠预测本次输入、输出和工具的最终费用；CNY/USD 阈值只会在已完成请求的已知累计达到后，对下一次请求提醒或阻断。
                  </Text>
                  <Text style={styles.fieldLabel}>最多对比模型</Text>
                  <View style={styles.toolSegmentRow}>
                    {([2, 3, 4] as const).map((count) => (
                      <AnimatedPressable
                        key={`guard-compare:${count}`}
                        accessibilityRole="button"
                        onPress={() => void commitWorkspaceCommand({
                          type: 'cost-guard.update',
                          patch: { maxComparisonTargets: count },
                        })}
                        style={[styles.toolSegment, workspace.costGuard.maxComparisonTargets === count && styles.toolSegmentActive]}
                      >
                        <Text style={[styles.toolSegmentText, workspace.costGuard.maxComparisonTargets === count && styles.toolSegmentTextActive]}>{count}</Text>
                      </AnimatedPressable>
                    ))}
                  </View>
                  <Text style={styles.fieldLabel}>达到次数或已知预算时</Text>
                  <View style={styles.toolSegmentRow}>
                    {(['warn', 'block'] as const).map((action) => (
                      <AnimatedPressable
                        key={`limit-action:${action}`}
                        accessibilityRole="button"
                        onPress={() => void commitWorkspaceCommand({
                          type: 'cost-guard.update',
                          patch: { limitAction: action },
                        })}
                        style={[styles.toolSegment, workspace.costGuard.limitAction === action && styles.toolSegmentActive]}
                      >
                        <Text style={[styles.toolSegmentText, workspace.costGuard.limitAction === action && styles.toolSegmentTextActive]}>{action === 'warn' ? '提醒确认' : '直接阻断'}</Text>
                      </AnimatedPressable>
                    ))}
                  </View>
                  <Text style={styles.fieldLabel}>存在未知费用时</Text>
                  <View style={styles.toolSegmentRow}>
                    {(['warn', 'block'] as const).map((action) => (
                      <AnimatedPressable
                        key={`unknown-action:${action}`}
                        accessibilityRole="button"
                        onPress={() => void commitWorkspaceCommand({
                          type: 'cost-guard.update',
                          patch: { unknownCostAction: action },
                        })}
                        style={[styles.toolSegment, workspace.costGuard.unknownCostAction === action && styles.toolSegmentActive]}
                      >
                        <Text style={[styles.toolSegmentText, workspace.costGuard.unknownCostAction === action && styles.toolSegmentTextActive]}>{action === 'warn' ? '提醒确认' : '直接阻断'}</Text>
                      </AnimatedPressable>
                    ))}
                  </View>
                  <AnimatedPressable
                    accessibilityRole="switch"
                    accessibilityState={{ checked: workspace.costGuard.confirmPotentialMultipleCharges }}
                    onPress={() => void commitWorkspaceCommand({
                      type: 'cost-guard.update',
                      patch: {
                        confirmPotentialMultipleCharges:
                          !workspace.costGuard.confirmPotentialMultipleCharges,
                      },
                    })}
                    style={styles.secondaryButton}
                  >
                    <Text style={styles.secondaryButtonText}>
                      {workspace.costGuard.confirmPotentialMultipleCharges ? '多项潜在计费：发送前确认' : '多项潜在计费：不额外确认'}
                    </Text>
                  </AnimatedPressable>
                  <View style={styles.costGuardTodayRow}>
                    <Text style={styles.modelOverrideHint}>今日 {costGuardToday.requestCount} 次请求</Text>
                    <Text style={styles.modelOverrideHint}>CNY {costGuardToday.knownCostByCurrency.CNY.toFixed(6)}</Text>
                    <Text style={styles.modelOverrideHint}>USD {costGuardToday.knownCostByCurrency.USD.toFixed(6)}</Text>
                    <Text style={styles.modelOverrideHint}>未知 {costGuardToday.unknownEventCount} 次</Text>
                  </View>
                  <AnimatedPressable accessibilityRole="button" onPress={saveCostGuardDrafts} style={styles.primaryButton}>
                    <Text style={styles.primaryButtonText}>保存保险丝数值</Text>
                  </AnimatedPressable>
                </View>

            </>
          );
        case 'usage':
          return (
            <>
  <View style={styles.settingsCard} testID="usage-dashboard-card">
                  <View style={styles.settingsCardHeader}>
                    <Text style={styles.settingsCardTitle}>本机用量与费用估算</Text>
                    <Text style={styles.modelOverrideHint}>当前保留对话</Text>
                  </View>
                  <View style={styles.usageSummaryGrid}>
                    <View style={styles.usageSummaryItem}>
                      <Text style={styles.usageSummaryValue}>{usageAggregation.totals.requestCount}</Text>
                      <Text style={styles.usageSummaryLabel}>请求</Text>
                    </View>
                    <View style={styles.usageSummaryItem}>
                      <Text style={styles.usageSummaryValue}>
                        {formatTokenCount(usageAggregation.totals.totalTokens || undefined)}
                      </Text>
                      <Text style={styles.usageSummaryLabel}>Token</Text>
                    </View>
                    <View style={styles.usageSummaryItem}>
                      <Text style={styles.usageSummaryValue}>
                        {usageAggregation.totals.averageDurationMs !== undefined
                          ? `${(usageAggregation.totals.averageDurationMs / 1000).toFixed(1)}s`
                          : '—'}
                      </Text>
                      <Text style={styles.usageSummaryLabel}>平均耗时</Text>
                    </View>
                  </View>
                  <View style={styles.usageCostRow}>
                    <Text style={styles.modelOverrideHint}>
                      {usageAggregation.totals.costSampleCountByCurrency.CNY > 0
                        ? `CNY 已知小计 ¥${usageAggregation.totals.costByCurrency.CNY.toFixed(6)}`
                        : 'CNY 费用未知'}
                    </Text>
                    <Text style={styles.modelOverrideHint}>
                      {usageAggregation.totals.costSampleCountByCurrency.USD > 0
                        ? `USD 已知小计 $${usageAggregation.totals.costByCurrency.USD.toFixed(6)}`
                        : 'USD 费用未知'}
                    </Text>
                  </View>
                  <Text style={styles.modelOverrideHint}>
                    已知费用覆盖 {knownCostRequestCount}/{usageAggregation.totals.requestCount} 次请求；其余 {usageAggregation.totals.unknown.cost} 次未知。价格完全由你本地填写，不调用价格或汇率服务；推理 Token 不重复计费。
                  </Text>
                  <Text style={styles.modelOverrideHint}>
                    小计不包含联网搜索工具费、语音、媒体任务或服务商其他附加费，最终账单以你的服务商控制台为准。
                  </Text>
                  {activeModelId ? (
                    <>
                      <Text style={styles.fieldLabel}>
                        {formatCompactModelName(activeModelId, activeProvider.name)} · 每百万 Token
                      </Text>
                      <View style={styles.toolSegmentRow}>
                        {(['CNY', 'USD'] as const).map((currency) => {
                          const selected = (activeModelPricing?.currency ?? 'CNY') === currency;
                          return (
                            <AnimatedPressable
                              key={currency}
                              accessibilityRole="button"
                              onPress={() => setActivePricingCurrency(currency)}
                              style={[styles.toolSegment, selected && styles.toolSegmentActive]}
                            >
                              <Text style={[styles.toolSegmentText, selected && styles.toolSegmentTextActive]}>
                                {currency}
                              </Text>
                            </AnimatedPressable>
                          );
                        })}
                      </View>
                      <View style={styles.pricingInputRow}>
                        <View style={styles.pricingInputGroup}>
                          <Text style={styles.usageSummaryLabel}>输入</Text>
                          <TextInput
                            value={pricingInputDraft}
                            onChangeText={setPricingInputDraft}
                            onBlur={() => updatePricingText('inputPerMillion', pricingInputDraft)}
                            keyboardType="decimal-pad"
                            placeholder="未设置"
                            placeholderTextColor={palette.placeholder}
                            style={styles.input}
                          />
                        </View>
                        <View style={styles.pricingInputGroup}>
                          <Text style={styles.usageSummaryLabel}>缓存输入</Text>
                          <TextInput
                            value={pricingCachedDraft}
                            onChangeText={setPricingCachedDraft}
                            onBlur={() => updatePricingText('cachedInputPerMillion', pricingCachedDraft)}
                            keyboardType="decimal-pad"
                            placeholder="同输入价"
                            placeholderTextColor={palette.placeholder}
                            style={styles.input}
                          />
                        </View>
                        <View style={styles.pricingInputGroup}>
                          <Text style={styles.usageSummaryLabel}>输出</Text>
                          <TextInput
                            value={pricingOutputDraft}
                            onChangeText={setPricingOutputDraft}
                            onBlur={() => updatePricingText('outputPerMillion', pricingOutputDraft)}
                            keyboardType="decimal-pad"
                            placeholder="未设置"
                            placeholderTextColor={palette.placeholder}
                            style={styles.input}
                          />
                        </View>
                      </View>
                    </>
                  ) : null}
                </View>

            </>
          );
        case 'media':
          return (
            <>
  <View style={styles.settingsCard} testID="media-task-center-card">
                  <View style={styles.settingsCardHeader}>
                    <Text style={styles.settingsCardTitle}>媒体任务中心</Text>
                    <Text style={styles.modelOverrideHint}>{generationTasks.length} 项</Text>
                  </View>
                  <Text style={styles.modelOverrideHint}>
                    任务直接从本机对话记录派生，不上传到我们的服务器；前台会自动恢复查询，Android 后台以系统允许的最短周期尽力检查，强制停止或厂商省电可能延迟。
                  </Text>
                  <GenerationTaskNotificationPermissionButton onNotice={setNotice} />
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.providerRow}>
                    {(['all', 'active', 'completed', 'failed'] as const).map((filter) => {
                      const selected = generationTaskFilter === filter;
                      return (
                        <AnimatedPressable
                          key={filter}
                          accessibilityRole="button"
                          onPress={() => setGenerationTaskFilter(filter)}
                          style={[styles.providerChip, selected && styles.providerChipActive]}
                        >
                          <Text style={[styles.providerChipText, selected && styles.providerChipTextActive]}>
                            {filter === 'all' ? '全部' : filter === 'active' ? '进行中' : filter === 'completed' ? '已完成' : '失败'}
                          </Text>
                        </AnimatedPressable>
                      );
                    })}
                  </ScrollView>
                  {visibleGenerationTasks.length ? (
                    visibleGenerationTasks.slice(0, 20).map((item) => (
                      <View key={item.key} style={styles.mediaTaskRow}>
                        <View style={styles.mediaTaskInfo}>
                          <Text numberOfLines={1} style={styles.promptTemplateName}>{item.title}</Text>
                          <Text numberOfLines={1} style={styles.modelOverrideHint}>
                            {item.task.modelId} · {item.task.status ?? 'submitted'}
                          </Text>
                        </View>
                        <Text
                          style={[
                            styles.mediaTaskState,
                            item.state === 'failed' && styles.messageErrorText,
                          ]}
                        >
                          {item.state === 'active' ? '进行中' : item.state === 'completed' ? '已完成' : '失败'}
                        </Text>
                        {item.attachment ? (
                          <AnimatedPressable
                            accessibilityRole="button"
                            accessibilityLabel="导出媒体任务结果"
                            onPress={() => void exportTaskCenterAttachment(item.attachment!)}
                            style={styles.iconButton}
                          >
                            <Download size={15} color={palette.text} strokeWidth={2} />
                          </AnimatedPressable>
                        ) : item.state === 'active' ? (
                          <AnimatedPressable
                            accessibilityRole="button"
                            accessibilityLabel="刷新媒体任务"
                            disabled={Boolean(queryingTaskByMessageId[item.messageId])}
                            onPress={() => refreshTaskCenterItem(item.conversationId, item.messageId)}
                            style={styles.iconButton}
                          >
                            <RefreshCw size={15} color={palette.text} strokeWidth={2} />
                          </AnimatedPressable>
                        ) : null}
                        <AnimatedPressable
                          accessibilityRole="button"
                          accessibilityLabel="打开任务所在对话"
                          onPress={() => {
                            selectConversation(item.conversationId);
                            closeSettings();
                          }}
                          style={styles.iconButton}
                        >
                          <MessageSquare size={15} color={palette.text} strokeWidth={2} />
                        </AnimatedPressable>
                      </View>
                    ))
                  ) : (
                    <Text style={styles.modelOverrideHint}>当前筛选下暂无媒体任务。</Text>
                  )}
                </View>

            </>
          );
        case 'diagnostics':
          return (
            <>
              <View style={styles.settingsCard} testID="local-diagnostics-card">
                <View style={styles.settingsCardHeader}>
                  <View style={styles.mediaTaskInfo}>
                    <Text style={styles.settingsCardTitle}>本地诊断中心</Text>
                    <Text style={styles.modelOverrideHint}>只读检查 · 默认不联网</Text>
                  </View>
                  <AnimatedPressable
                    accessibilityRole="button"
                    disabled={diagnosticsBusy}
                    onPress={() => void refreshDiagnostics()}
                    style={[styles.iconButton, diagnosticsBusy && styles.buttonDisabled]}
                  >
                    <RefreshCw size={16} color={palette.text} strokeWidth={2.2} />
                  </AnimatedPressable>
                </View>
                <Text style={styles.modelOverrideHint}>
                  检查 Workspace 保存状态、服务商本地配置、媒体缓存、最近失败和草稿。只有“检查当前服务商连接”会请求用户自己的模型目录。
                </Text>

                <View style={styles.mediaTaskRow}>
                  <Stethoscope size={18} color={palette.text} strokeWidth={2.1} />
                  <View style={styles.mediaTaskInfo}>
                    <Text style={styles.promptTemplateName}>Workspace 保存</Text>
                    <Text style={styles.modelOverrideHint}>
                      {status.phase === 'ready'
                        ? status.dirty ? '存在等待持久化的本机修改' : '当前快照已提交或没有待保存修改'
                        : status.phase === 'read-only' ? '只读恢复状态' : status.phase === 'replacing' ? '正在替换工作区' : '正在加载'}
                    </Text>
                    {status.issue ? <Text style={styles.settingsNotice}>{status.issue}</Text> : null}
                  </View>
                </View>

                <View style={styles.mediaTaskRow}>
                  <KeyRound size={18} color={palette.text} strokeWidth={2.1} />
                  <View style={styles.mediaTaskInfo}>
                    <Text style={styles.promptTemplateName}>当前服务商 · {activeProvider.name}</Text>
                    <Text style={styles.modelOverrideHint}>
                      {diagnostics?.providers.find((provider) => provider.id === activeProvider.id)?.summary
                        ?? '点击刷新读取本地配置状态。'}
                    </Text>
                  </View>
                  <AnimatedPressable
                    accessibilityRole="button"
                    disabled={diagnosticsBusy}
                    onPress={() => void checkActiveProviderConnection()}
                    style={[styles.providerChip, diagnosticsBusy && styles.buttonDisabled]}
                  >
                    <Text style={styles.providerChipText}>检查连接</Text>
                  </AnimatedPressable>
                </View>

                <View style={styles.mediaTaskRow}>
                  <HardDrive size={18} color={palette.text} strokeWidth={2.1} />
                  <View style={styles.mediaTaskInfo}>
                    <Text style={styles.promptTemplateName}>媒体存储</Text>
                    <Text style={styles.modelOverrideHint}>
                      {diagnostics
                        ? `${diagnostics.mediaStorage.fileCount} 个文件 · ${formatBytes(diagnostics.mediaStorage.totalBytes)} · ${diagnostics.mediaStorage.orphanCount} 个未引用`
                        : '点击刷新统计本机自有媒体目录。'}
                    </Text>
                  </View>
                  <AnimatedPressable
                    accessibilityRole="button"
                    disabled={diagnosticsBusy}
                    onPress={() => void cleanupMediaCache()}
                    style={[styles.providerChip, diagnosticsBusy && styles.buttonDisabled]}
                  >
                    <Text style={styles.providerChipText}>清理异常缓存</Text>
                  </AnimatedPressable>
                </View>

                <View style={styles.mediaTaskRow}>
                  <MessageSquare size={18} color={palette.text} strokeWidth={2.1} />
                  <View style={styles.mediaTaskInfo}>
                    <Text style={styles.promptTemplateName}>最近失败</Text>
                    <Text style={styles.modelOverrideHint}>
                      {diagnostics ? `诊断包内保留最近 ${diagnostics.recentFailures.length} 条脱敏失败记录` : '尚未刷新'}
                    </Text>
                  </View>
                </View>

                <View style={styles.fieldGroup}>
                  <Text style={styles.fieldLabel}>可恢复草稿 · {workspace.composerDrafts.length}</Text>
                  {workspace.composerDrafts.slice(0, 8).map((draft) => {
                    const conversation = workspace.conversations.find((item) => item.id === draft.conversationId);
                    return (
                      <AnimatedPressable
                        key={draft.conversationId}
                        accessibilityRole="button"
                        onPress={() => {
                          void selectConversation(draft.conversationId).then(() => settingsLauncher.close());
                        }}
                        style={styles.mediaTaskRow}
                      >
                        <View style={styles.mediaTaskInfo}>
                          <Text numberOfLines={1} style={styles.promptTemplateName}>{conversation?.title ?? '已保留草稿'}</Text>
                          <Text numberOfLines={2} style={styles.modelOverrideHint}>{draft.text}</Text>
                        </View>
                        <MessageSquare size={16} color={palette.text} strokeWidth={2} />
                      </AnimatedPressable>
                    );
                  })}
                  {!workspace.composerDrafts.length ? <Text style={styles.modelOverrideHint}>没有未发送草稿。</Text> : null}
                </View>

                <AnimatedPressable
                  accessibilityRole="button"
                  disabled={diagnosticsBusy}
                  onPress={() => void exportDiagnostics()}
                  style={[styles.primaryButton, diagnosticsBusy && styles.buttonDisabled]}
                >
                  <Download size={16} color={palette.textOnAccent} strokeWidth={2.1} />
                  <Text style={styles.primaryButtonText}>确认并导出脱敏诊断包</Text>
                </AnimatedPressable>
              </View>
              {notice ? <Text accessibilityLiveRegion="assertive" style={styles.settingsNotice}>{notice}</Text> : null}
            </>
          );
        case 'backup':
          return (
            <>
  <View style={styles.settingsCard} testID="encrypted-backup-card">
                  <Text style={styles.settingsCardTitle}>本地加密备份</Text>
                  <Text style={styles.modelOverrideHint}>
                    使用密码在本机完成认证加密。专用 API Key/MCP 授权字段、媒体文件、本机费用账本和 MCP 活动摘要不会导出；普通对话、提示词和错误文字会原样备份，请勿在其中粘贴密钥。
                  </Text>
                  <Text style={styles.modelOverrideHint}>
                    {isBackupReminderDue(workspace.backupPreferences)
                      ? '备份提醒已到期：建议导出并验证一份新备份。'
                      : `最近导出：${workspace.backupPreferences.lastExportedAt ? new Date(workspace.backupPreferences.lastExportedAt).toLocaleString() : '尚无'} · 最近验证：${workspace.backupPreferences.lastVerifiedAt ? new Date(workspace.backupPreferences.lastVerifiedAt).toLocaleString() : '尚无'}`}
                  </Text>
                  <View style={styles.toolSegmentRow}>
                    {([0, 7, 14, 30] as const).map((days) => {
                      const selected = workspace.backupPreferences.reminderIntervalDays === days;
                      return (
                        <AnimatedPressable
                          key={`backup-reminder:${days}`}
                          accessibilityRole="button"
                          accessibilityState={{ selected }}
                          disabled={workspaceReadOnly}
                          onPress={() => void commitWorkspaceCommand({
                            type: 'backup-preferences.update',
                            patch: { reminderIntervalDays: days, snoozedUntil: undefined },
                          })}
                          style={[styles.toolSegment, selected && styles.toolSegmentActive]}
                        >
                          <Text style={[styles.toolSegmentText, selected && styles.toolSegmentTextActive]}>
                            {days === 0 ? '关闭提醒' : `${days} 天`}
                          </Text>
                        </AnimatedPressable>
                      );
                    })}
                  </View>
                  {isBackupReminderDue(workspace.backupPreferences) ? (
                    <AnimatedPressable
                      accessibilityRole="button"
                      onPress={() => void commitWorkspaceCommand({
                        type: 'backup-preferences.update',
                        patch: { snoozedUntil: Date.now() + 86_400_000 },
                      })}
                      style={styles.providerChip}
                    >
                      <Text style={styles.providerChipText}>提醒我明天再处理</Text>
                    </AnimatedPressable>
                  ) : null}
                  <View style={styles.fieldGroup}>
                    <Text style={styles.fieldLabel}>备份密码（至少 8 个字符）</Text>
                    <TextInput
                      value={backupPassword}
                      editable={!backupBusy && !workspaceReadOnly}
                      onChangeText={setBackupPassword}
                      secureTextEntry
                      autoCapitalize="none"
                      placeholder="密码不会保存，遗失后无法找回"
                      placeholderTextColor={palette.placeholder}
                      style={styles.input}
                    />
                  </View>
                  <View style={styles.updateActionRow}>
                    <AnimatedPressable
                      accessibilityRole="button"
                      disabled={backupBusy || workspaceReadOnly}
                      onPress={() => void exportEncryptedBackup()}
                      style={[styles.secondaryButton, styles.updateActionButton, (backupBusy || workspaceReadOnly) && styles.buttonDisabled]}
                    >
                      <Download size={16} color={palette.text} strokeWidth={2} />
                      <Text style={styles.secondaryButtonText}>{backupBusy ? '处理中' : '导出备份'}</Text>
                    </AnimatedPressable>
                    <AnimatedPressable
                      accessibilityRole="button"
                      disabled={backupBusy || workspaceReadOnly}
                      onPress={() => void verifyEncryptedBackupOnly()}
                      style={[styles.secondaryButton, styles.updateActionButton, (backupBusy || workspaceReadOnly) && styles.buttonDisabled]}
                    >
                      <ShieldCheck size={16} color={palette.text} strokeWidth={2} />
                      <Text style={styles.secondaryButtonText}>{backupBusy ? '处理中' : '只验证，不导入'}</Text>
                    </AnimatedPressable>
                    <AnimatedPressable
                      accessibilityRole="button"
                      disabled={backupBusy || workspaceReadOnly}
                      onPress={() => void importEncryptedBackup()}
                      style={[styles.primaryButton, styles.updateActionButton, (backupBusy || workspaceReadOnly) && styles.buttonDisabled]}
                    >
                      <FileText size={16} color={palette.textOnAccent} strokeWidth={2} />
                      <Text style={styles.primaryButtonText}>{backupBusy ? '处理中' : '验证并导入'}</Text>
                    </AnimatedPressable>
                  </View>
                </View>

            </>
          );
        case 'sync':
          return (
            <>
              <View style={styles.settingsCard} testID="cloud-sync-settings-card">
                <View style={styles.settingsCardHeader}>
                  <Text style={styles.settingsCardTitle}>用户自有存储同步</Text>
                  <Text style={styles.modelOverrideHint}>{workspace.cloudSync.lastStatus}</Text>
                </View>
                <Text style={styles.modelOverrideHint}>
                  只同步加密后的文本、配置和项目状态；媒体文件、API Key、同步凭据与费用账本不会上传。同步由你的 WebDAV 或 S3 账户承担，Embezzle Studio 不提供服务器或额度。
                </Text>
                <View style={styles.toolSegmentRow}>
                  {(['webdav', 's3'] as const).map((provider) => (
                    <AnimatedPressable
                      key={provider}
                      accessibilityRole="button"
                      accessibilityState={{ selected: syncProviderDraft === provider }}
                      disabled={syncBusy}
                      onPress={() => setSyncProviderDraft(provider)}
                      style={[styles.toolSegment, syncProviderDraft === provider && styles.toolSegmentActive]}
                    >
                      <Text style={[styles.toolSegmentText, syncProviderDraft === provider && styles.toolSegmentTextActive]}>
                        {provider === 'webdav' ? 'WebDAV' : 'S3 兼容存储'}
                      </Text>
                    </AnimatedPressable>
                  ))}
                </View>
                <View style={styles.fieldGroup}>
                  <Text style={styles.fieldLabel}>HTTPS Endpoint</Text>
                  <TextInput
                    value={syncEndpointDraft}
                    editable={!syncBusy && !workspaceReadOnly}
                    onChangeText={setSyncEndpointDraft}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder="https://dav.example.com 或 S3 网关"
                    placeholderTextColor={palette.placeholder}
                    style={styles.input}
                  />
                </View>
                <View style={styles.fieldGroup}>
                  <Text style={styles.fieldLabel}>远端目录</Text>
                  <TextInput
                    value={syncRemotePathDraft}
                    editable={!syncBusy && !workspaceReadOnly}
                    onChangeText={setSyncRemotePathDraft}
                    autoCapitalize="none"
                    placeholder="Embezzle-Studio"
                    placeholderTextColor={palette.placeholder}
                    style={styles.input}
                  />
                </View>
                {syncProviderDraft === 's3' ? (
                  <View style={styles.updateActionRow}>
                    <TextInput
                      value={syncBucketDraft}
                      editable={!syncBusy && !workspaceReadOnly}
                      onChangeText={setSyncBucketDraft}
                      autoCapitalize="none"
                      placeholder="Bucket"
                      placeholderTextColor={palette.placeholder}
                      style={[styles.input, styles.updateActionButton]}
                    />
                    <TextInput
                      value={syncRegionDraft}
                      editable={!syncBusy && !workspaceReadOnly}
                      onChangeText={setSyncRegionDraft}
                      autoCapitalize="none"
                      placeholder="Region"
                      placeholderTextColor={palette.placeholder}
                      style={[styles.input, styles.updateActionButton]}
                    />
                  </View>
                ) : (
                  <View style={styles.updateActionRow}>
                    <TextInput
                      value={syncUsernameDraft}
                      editable={!syncBusy && !workspaceReadOnly}
                      onChangeText={setSyncUsernameDraft}
                      autoCapitalize="none"
                      placeholder="WebDAV 用户名"
                      placeholderTextColor={palette.placeholder}
                      style={[styles.input, styles.updateActionButton]}
                    />
                    <TextInput
                      value={syncPasswordDraft}
                      editable={!syncBusy && !workspaceReadOnly}
                      onChangeText={setSyncPasswordDraft}
                      secureTextEntry
                      autoCapitalize="none"
                      placeholder="WebDAV 密码"
                      placeholderTextColor={palette.placeholder}
                      style={[styles.input, styles.updateActionButton]}
                    />
                  </View>
                )}
                {syncProviderDraft === 's3' ? (
                  <>
                    <TextInput
                      value={syncAccessKeyDraft}
                      editable={!syncBusy && !workspaceReadOnly}
                      onChangeText={setSyncAccessKeyDraft}
                      autoCapitalize="none"
                      placeholder="Access Key ID"
                      placeholderTextColor={palette.placeholder}
                      style={styles.input}
                    />
                    <TextInput
                      value={syncSecretKeyDraft}
                      editable={!syncBusy && !workspaceReadOnly}
                      onChangeText={setSyncSecretKeyDraft}
                      secureTextEntry
                      autoCapitalize="none"
                      placeholder="Secret Access Key"
                      placeholderTextColor={palette.placeholder}
                      style={styles.input}
                    />
                    <TextInput
                      value={syncSessionTokenDraft}
                      editable={!syncBusy && !workspaceReadOnly}
                      onChangeText={setSyncSessionTokenDraft}
                      secureTextEntry
                      autoCapitalize="none"
                      placeholder="可选 Session Token"
                      placeholderTextColor={palette.placeholder}
                      style={styles.input}
                    />
                  </>
                ) : null}
                <View style={styles.fieldGroup}>
                  <Text style={styles.fieldLabel}>同步加密密码（至少 8 个字符）</Text>
                  <TextInput
                    value={syncEncryptionPasswordDraft}
                    editable={!syncBusy && !workspaceReadOnly}
                    onChangeText={setSyncEncryptionPasswordDraft}
                    secureTextEntry
                    autoCapitalize="none"
                    placeholder="不会上传到远端"
                    placeholderTextColor={palette.placeholder}
                    style={styles.input}
                  />
                </View>
                <Text style={styles.modelOverrideHint}>
                  首次同步会留下一个很小的 CAS 探测对象，用于确认远端真正支持 If-Match / If-None-Match；不支持条件写入时会 fail-closed，不覆盖 manifest。
                </Text>
                <View style={styles.updateActionRow}>
                  <AnimatedPressable
                    accessibilityRole="button"
                    disabled={syncBusy || workspaceReadOnly}
                    onPress={() => void syncNow()}
                    style={[styles.primaryButton, styles.updateActionButton, (syncBusy || workspaceReadOnly) && styles.buttonDisabled]}
                  >
                    <RefreshCw size={16} color={palette.textOnAccent} strokeWidth={2.1} />
                    <Text style={styles.primaryButtonText}>{syncBusy ? '同步中' : '保存并同步'}</Text>
                  </AnimatedPressable>
                  <AnimatedPressable
                    accessibilityRole="button"
                    disabled={syncBusy || workspaceReadOnly}
                    onPress={() => void clearSyncConfiguration()}
                    style={[styles.secondaryButton, styles.updateActionButton, (syncBusy || workspaceReadOnly) && styles.buttonDisabled]}
                  >
                    <Trash2 size={16} color={palette.text} strokeWidth={2.1} />
                    <Text style={styles.secondaryButtonText}>停用并清除凭据</Text>
                  </AnimatedPressable>
                </View>
                {workspace.cloudSync.lastError ? (
                  <Text accessibilityLiveRegion="assertive" style={styles.settingsNotice}>{workspace.cloudSync.lastError}</Text>
                ) : null}
                {workspace.cloudSync.conflicts.length ? (
                  <View style={styles.fieldGroup}>
                    <Text style={styles.fieldLabel}>待处理冲突（不会静默覆盖）</Text>
                    {workspace.cloudSync.conflicts.map((conflict) => (
                      <View key={conflict.id} style={styles.mediaTaskRow}>
                        <View style={styles.mediaTaskInfo}>
                          <Text style={styles.promptTemplateName}>本机 {conflict.localDigest.slice(0, 12)}… / 远端 {conflict.remoteDigest.slice(0, 12)}…</Text>
                          <Text style={styles.modelOverrideHint}>{new Date(conflict.detectedAt).toLocaleString()}</Text>
                        </View>
                        <AnimatedPressable
                          accessibilityRole="button"
                          disabled={syncBusy || workspaceReadOnly}
                          onPress={() => void resolveSyncConflict(conflict.id, 'keep-local')}
                          style={[styles.providerChip, (syncBusy || workspaceReadOnly) && styles.buttonDisabled]}
                        >
                          <Text style={styles.providerChipText}>保留本机</Text>
                        </AnimatedPressable>
                        <AnimatedPressable
                          accessibilityRole="button"
                          disabled={syncBusy || workspaceReadOnly}
                          onPress={() => void resolveSyncConflict(conflict.id, 'keep-remote')}
                          style={[styles.providerChip, (syncBusy || workspaceReadOnly) && styles.buttonDisabled]}
                        >
                          <Text style={styles.providerChipText}>保留远端</Text>
                        </AnimatedPressable>
                      </View>
                    ))}
                  </View>
                ) : null}
              </View>
              {notice ? <Text accessibilityLiveRegion="assertive" style={styles.settingsNotice}>{notice}</Text> : null}
            </>
          );
        case 'voice':
          return (
            <>
  <View style={styles.settingsCard} testID="voice-settings-card">
                  <View style={styles.settingsCardHeader}>
                    <Text style={styles.settingsCardTitle}>用户服务商语音</Text>
                    <Text style={styles.modelOverrideHint}>Android 请求式 · BYOK</Text>
                  </View>
                  <Text style={styles.modelOverrideHint}>
                    录音和朗读仅调用你配置的 OpenAI 或阿里百炼账号，可能产生的费用由对应服务商从你的账户结算；我们不提供语音 API、不设中转服务器。正式 Web 端保持关闭。
                  </Text>
                  <View style={styles.voiceTargetRow}>
                    <View style={styles.mediaTaskInfo}>
                      <Text style={styles.fieldLabel}>语音输入转写</Text>
                      <Text numberOfLines={1} style={styles.modelOverrideHint}>
                        {workspace.voice.transcriptionTarget
                          ? `${workspace.voice.transcriptionTarget.providerId} · ${workspace.voice.transcriptionTarget.modelId}${configuredTranscriptionTarget ? '' : '（已失效）'}`
                          : '未配置'}
                      </Text>
                    </View>
                    {workspace.voice.transcriptionTarget ? (
                      <AnimatedPressable
                        accessibilityRole="button"
                        onPress={() => clearVoiceTarget('transcription')}
                        style={styles.iconButton}
                      >
                        <X size={15} color={palette.textSecondary} strokeWidth={2} />
                      </AnimatedPressable>
                    ) : null}
                    <AnimatedPressable
                      accessibilityRole="button"
                      disabled={!canSetActiveTranscriptionTarget}
                      onPress={() => setVoiceTarget('transcription')}
                      style={[
                        styles.providerChip,
                        !canSetActiveTranscriptionTarget && styles.buttonDisabled,
                      ]}
                    >
                      <Text style={styles.providerChipText}>使用当前模型</Text>
                    </AnimatedPressable>
                  </View>
                  <View style={styles.voiceTargetRow}>
                    <View style={styles.mediaTaskInfo}>
                      <Text style={styles.fieldLabel}>回答朗读</Text>
                      <Text numberOfLines={1} style={styles.modelOverrideHint}>
                        {workspace.voice.speechTarget
                          ? `${workspace.voice.speechTarget.providerId} · ${workspace.voice.speechTarget.modelId}${configuredSpeechTarget ? '' : '（已失效）'}`
                          : '未配置'}
                      </Text>
                    </View>
                    {workspace.voice.speechTarget ? (
                      <AnimatedPressable
                        accessibilityRole="button"
                        onPress={() => clearVoiceTarget('speech')}
                        style={styles.iconButton}
                      >
                        <X size={15} color={palette.textSecondary} strokeWidth={2} />
                      </AnimatedPressable>
                    ) : null}
                    <AnimatedPressable
                      accessibilityRole="button"
                      disabled={!canSetActiveSpeechTarget}
                      onPress={() => setVoiceTarget('speech')}
                      style={[
                        styles.providerChip,
                        !canSetActiveSpeechTarget && styles.buttonDisabled,
                      ]}
                    >
                      <Text style={styles.providerChipText}>使用当前模型</Text>
                    </AnimatedPressable>
                  </View>
                  <View style={styles.fieldGroup}>
                    <Text style={styles.fieldLabel}>服务商 Voice ID</Text>
                    <TextInput
                      value={workspace.voice.speechVoice}
                      editable={!workspaceReadOnly}
                      onChangeText={(speechVoice) => {
                        if (!ensureWorkspaceWritable()) return;
                        void commitWorkspaceCommand({
                          type: 'voice.update',
                          patch: { speechVoice },
                        });
                      }}
                      autoCapitalize="none"
                      placeholder="alloy / Cherry / 服务商音色 ID"
                      placeholderTextColor={palette.placeholder}
                      style={styles.input}
                    />
                  </View>
                  {configuredSpeechProtocol === 'bailian-compatible' ? (
                    <Text style={styles.modelOverrideHint}>
                      百炼语音格式由服务商响应决定；上方格式选项只适用于 OpenAI 官方语音接口。
                    </Text>
                  ) : (
                    <View style={styles.toolSegmentRow}>
                      {(['mp3', 'aac', 'wav', 'opus'] as const).map((format) => {
                        const selected = workspace.voice.speechFormat === format;
                        return (
                          <AnimatedPressable
                            key={format}
                            accessibilityRole="button"
                            disabled={workspaceReadOnly}
                            onPress={() => {
                              if (!ensureWorkspaceWritable()) return;
                              void commitWorkspaceCommand({
                                type: 'voice.update',
                                patch: { speechFormat: format },
                              });
                            }}
                            style={[styles.toolSegment, selected && styles.toolSegmentActive]}
                          >
                            <Text style={[styles.toolSegmentText, selected && styles.toolSegmentTextActive]}>
                              {format.toUpperCase()}
                            </Text>
                          </AnimatedPressable>
                        );
                      })}
                    </View>
                  )}
                  <Text style={styles.modelOverrideHint}>朗读音频为 AI 合成语音，并非真人录音。</Text>
                </View>

            </>
          );
        case 'mcp':
          return (
            <>
  <View style={styles.settingsCard} testID="mcp-tool-center-card">
                  <View style={styles.settingsCardHeader}>
                    <Text style={styles.settingsCardTitle}>MCP 工具中心</Text>
                    <Text style={styles.modelOverrideHint}>默认关闭 · 逐次审批</Text>
                  </View>
                  <Text style={styles.modelOverrideHint}>
                    v1.4 仅对官方 OpenAI Responses 开放真实执行，并强制非空工具白名单与逐次审批。火山方舟等待真实账号验证无存储续接，百炼 Responses 缺少执行前审批，因此两者仍只保存配置。
                  </Text>
                  <View style={styles.fieldGroup}>
                    <Text style={styles.fieldLabel}>服务名称</Text>
                    <TextInput
                      value={mcpName}
                      onChangeText={setMcpName}
                      placeholder="例如：我的知识库"
                      placeholderTextColor={palette.placeholder}
                      style={styles.input}
                    />
                  </View>
                  <View style={styles.fieldGroup}>
                    <Text style={styles.fieldLabel}>HTTPS Endpoint</Text>
                    <TextInput
                      value={mcpEndpoint}
                      onChangeText={setMcpEndpoint}
                      autoCapitalize="none"
                      placeholder="https://mcp.example.com/mcp"
                      placeholderTextColor={palette.placeholder}
                      style={styles.input}
                    />
                  </View>
                  <View style={styles.fieldGroup}>
                    <Text style={styles.fieldLabel}>服务描述（可选）</Text>
                    <TextInput
                      value={mcpDescription}
                      onChangeText={setMcpDescription}
                      multiline
                      placeholder="这台 MCP 服务的用途与信任来源"
                      placeholderTextColor={palette.placeholder}
                      style={[styles.input, styles.multilineInput]}
                    />
                  </View>
                  <View style={styles.fieldGroup}>
                    <Text style={styles.fieldLabel}>允许的精确工具名</Text>
                    <TextInput
                      testID="mcp-allowed-tools-input"
                      value={mcpAllowedTools}
                      onChangeText={setMcpAllowedTools}
                      autoCapitalize="none"
                      autoCorrect={false}
                      multiline
                      placeholder={'例如：search_docs, get_page\n使用逗号或换行分隔'}
                      placeholderTextColor={palette.placeholder}
                      style={[styles.input, styles.multilineInput]}
                    />
                    <Text style={styles.modelOverrideHint}>必须至少填写一个工具名；不支持 *、自动导入全部工具或模糊匹配。</Text>
                  </View>
                  <View style={styles.fieldGroup}>
                    <Text style={styles.fieldLabel}>Authorization（可选）</Text>
                    <TextInput
                      value={mcpAuthorization}
                      onChangeText={setMcpAuthorization}
                      autoCapitalize="none"
                      secureTextEntry
                      placeholder={
                        Platform.OS === 'web'
                          ? 'Web 仅当前标签页保存；不进入备份'
                          : 'Android 系统安全存储；不进入备份'
                      }
                      placeholderTextColor={palette.placeholder}
                      style={styles.input}
                    />
                  </View>
                  <AnimatedPressable
                    accessibilityRole="button"
                    disabled={workspaceReadOnly}
                    onPress={addRemoteMcpServer}
                    style={[styles.primaryButton, workspaceReadOnly && styles.buttonDisabled]}
                  >
                    <Wrench size={16} color={palette.textOnAccent} strokeWidth={2} />
                    <Text style={styles.primaryButtonText}>添加为关闭状态</Text>
                  </AnimatedPressable>
                  {workspace.plugins.filter((plugin) => plugin.type === 'remote-mcp').map((plugin) => (
                    <View key={plugin.id} style={styles.mediaTaskRow}>
                      <Wrench size={16} color={palette.text} strokeWidth={2} />
                      <View style={styles.mediaTaskInfo}>
                        <Text numberOfLines={1} style={styles.promptTemplateName}>{plugin.name}</Text>
                        <Text numberOfLines={1} style={styles.modelOverrideHint}>{plugin.endpoint}</Text>
                        <Text numberOfLines={2} style={styles.modelOverrideHint}>
                          工具：{plugin.allowedTools.length ? plugin.allowedTools.join(', ') : '未配置（不可执行）'}
                        </Text>
                      </View>
                      <AnimatedPressable
                        accessibilityRole="switch"
                        accessibilityState={{ checked: plugin.enabled === true }}
                        onPress={() => void toggleRemoteMcpServer(plugin.id, plugin.enabled !== true)}
                        style={[styles.providerChip, plugin.enabled && styles.providerChipActive]}
                      >
                        <Text style={[styles.providerChipText, plugin.enabled && styles.providerChipTextActive]}>
                          {plugin.enabled ? '已授权' : '关闭'}
                        </Text>
                      </AnimatedPressable>
                      <AnimatedPressable
                        accessibilityRole="button"
                        accessibilityLabel="删除 MCP 配置"
                        onPress={() => removeRemoteMcpServer(plugin.id)}
                        style={styles.iconButton}
                      >
                        <Trash2 size={15} color={palette.danger} strokeWidth={2} />
                      </AnimatedPressable>
                    </View>
                  ))}
                </View>

                {notice ? <Text style={styles.settingsNotice}>{notice}</Text> : null}

            </>
          );
        default:
          return null;
      }
    }

  if (!activeProvider || !activeProject) return null;
  return <>{settingsToolContent(section)}</>;
}
