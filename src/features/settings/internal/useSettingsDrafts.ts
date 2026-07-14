import { useState } from 'react';

import type { AppWorkspace, ProviderProfile } from '../../../domain/types';
import type { AppUpdateInfo } from '../../../services/updateChecker';
import type { GenerationTaskFilter } from '../../../services/generationTasks';
import type { ModelCapabilityFilter } from '../../../services/modelCapabilities';

/** Provider/model/update drafts owned by the Settings screen model. */
export function useSettingsScreenDrafts(candidatePageSize: number) {
  const [refreshingModels, setRefreshingModels] = useState(false);
  const [manualModelId, setManualModelId] = useState('');
  const [providerNameDraft, setProviderNameDraft] = useState('');
  const [providerKindDraft, setProviderKindDraft] =
    useState<ProviderProfile['kind']>('custom');
  const [providerBaseUrlDraft, setProviderBaseUrlDraft] = useState('');
  const [providerApiKeyDraft, setProviderApiKeyDraft] = useState('');
  const [providerKeyBindingFingerprint, setProviderKeyBindingFingerprint] =
    useState<string | null>(null);
  const [modelSearchQuery, setModelSearchQuery] = useState('');
  const [modelCapabilityFilter, setModelCapabilityFilter] =
    useState<ModelCapabilityFilter>('all');
  const [candidateModelRenderLimit, setCandidateModelRenderLimit] =
    useState(candidatePageSize);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateNotice, setUpdateNotice] = useState('');
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);

  return {
    refreshingModels, setRefreshingModels,
    manualModelId, setManualModelId,
    providerNameDraft, setProviderNameDraft,
    providerKindDraft, setProviderKindDraft,
    providerBaseUrlDraft, setProviderBaseUrlDraft,
    providerApiKeyDraft, setProviderApiKeyDraft,
    providerKeyBindingFingerprint, setProviderKeyBindingFingerprint,
    modelSearchQuery, setModelSearchQuery,
    modelCapabilityFilter, setModelCapabilityFilter,
    candidateModelRenderLimit, setCandidateModelRenderLimit,
    checkingUpdate, setCheckingUpdate,
    updateNotice, setUpdateNotice,
    updateInfo, setUpdateInfo,
  };
}

/** Tool-section drafts; mounted only after Settings has first opened. */
export function useSettingsToolsDrafts(workspace: AppWorkspace) {
  const [promptTemplateName, setPromptTemplateName] = useState('');
  const [promptTemplateContent, setPromptTemplateContent] = useState('');
  const [promptTemplateMode, setPromptTemplateMode] =
    useState<'composer' | 'system'>('composer');
  const [pricingInputDraft, setPricingInputDraft] = useState('');
  const [pricingCachedDraft, setPricingCachedDraft] = useState('');
  const [pricingOutputDraft, setPricingOutputDraft] = useState('');
  const [costMaxOutputDraft, setCostMaxOutputDraft] = useState('4096');
  const [costDailyRequestDraft, setCostDailyRequestDraft] = useState('0');
  const [costDailyCnyDraft, setCostDailyCnyDraft] = useState('0');
  const [costDailyUsdDraft, setCostDailyUsdDraft] = useState('0');
  const [generationTaskFilter, setGenerationTaskFilter] =
    useState<GenerationTaskFilter>('all');
  const [backupPassword, setBackupPassword] = useState('');
  const [backupBusy, setBackupBusy] = useState(false);
  const [mcpName, setMcpName] = useState('');
  const [mcpEndpoint, setMcpEndpoint] = useState('');
  const [mcpDescription, setMcpDescription] = useState('');
  const [mcpAllowedTools, setMcpAllowedTools] = useState('');
  const [mcpAuthorization, setMcpAuthorization] = useState('');
  const [analyticsSnapshot, setAnalyticsSnapshot] = useState(() => ({
    conversations: workspace.conversations,
    modelPricing: workspace.modelPricing,
  }));

  return {
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
  };
}
