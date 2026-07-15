import type {
  AppWorkspace,
  BackupPreferences,
  CloudSyncSettings,
  ExperienceMode,
  ExternalSearchProviderKind,
  ModelInfo,
  ModelPricing,
  ModelTargetRef,
  PluginManifest,
  ProviderProfile,
  VoiceSettings,
} from '../../../domain/types';
import {
  isWorkspaceCommitRejectedError,
  type WorkspaceCommitPort,
} from '../../../app/workspace/internal/WorkspaceCommitPort';
import type { WorkspaceSession } from '../../../app/workspace/WorkspaceSession';
import {
  DEFAULT_GROK_SEARCH_MODEL,
  externalSearchProviderLabels,
} from '../../../services/externalSearch';
import { inferModelTask } from '../../../services/modelCapabilities';
import {
  createPromptTemplate,
  deletePromptTemplate,
  setPromptTemplatePinned,
} from '../../../services/promptTemplates';
import { removeProviderFromWorkspace } from '../../../services/providerLifecycle';
import { isProviderEnabled } from '../../../services/workspaceRuntime';
import {
  normalizeBackupPreferences,
  normalizeCloudSyncSettings,
  normalizeExperienceMode,
  normalizeOnboardingState,
  hasUsableProviderConfiguration,
} from '../../../services/workspaceProductState';

type ProviderBindingChange = {
  changed: boolean;
  mustClearModelCandidates: boolean;
};

type ExternalSearchServiceInput = {
  serviceId?: string;
  kind: ExternalSearchProviderKind;
  name?: string;
  apiKey?: string;
  endpoint?: string;
  model?: string;
  newId: string;
};

export type SettingsWorkspaceCommand =
  | { type: 'provider.ensure-active-enabled' }
  | {
      type: 'provider.save';
      providerId: string;
      provider: ProviderProfile;
      binding: ProviderBindingChange;
      apiKeyChanged: boolean;
      now: number;
    }
  | { type: 'provider.toggle-enabled'; providerId: string; now: number }
  | { type: 'provider.select'; providerId: string }
  | { type: 'provider.add'; provider: ProviderProfile }
  | { type: 'provider.delete'; providerId: string; now: number }
  | { type: 'model.select'; providerId: string; modelId: string; activateProvider?: boolean }
  | { type: 'model.add'; providerId: string; model: ModelInfo }
  | { type: 'model.remove'; providerId: string; modelId: string; now: number }
  | {
      type: 'model.update';
      providerId: string;
      modelId: string;
      patch: Partial<ModelInfo>;
    }
  | { type: 'model.set-candidates'; providerId: string; models: ModelInfo[] }
  | { type: 'comparison.toggle-target'; target: ModelTargetRef }
  | { type: 'comparison.set-enabled'; enabled: boolean }
  | { type: 'search.update-provider'; patch: Partial<AppWorkspace['webSearch']> }
  | { type: 'search.update-external'; patch: Partial<AppWorkspace['externalSearch']> }
  | { type: 'external-search.upsert'; input: ExternalSearchServiceInput }
  | { type: 'external-search.remove'; serviceId: string }
  | {
      type: 'prompt.create';
      name: string;
      content: string;
      mode: 'system' | 'composer';
      id: string;
      now: number;
    }
  | { type: 'prompt.delete'; templateId: string }
  | { type: 'prompt.pin'; templateId: string; pinned: boolean; now: number }
  | {
      type: 'pricing.update';
      providerId: string;
      modelId: string;
      patch: Partial<ModelPricing>;
      now: number;
    }
  | { type: 'cost-guard.update'; patch: Partial<AppWorkspace['costGuard']> }
  | { type: 'plugin.add'; plugin: PluginManifest }
  | { type: 'plugin.set-enabled'; pluginId: string; enabled: boolean }
  | { type: 'plugin.remove'; pluginId: string }
  | {
      type: 'voice.set-target';
      kind: 'transcription' | 'speech';
      target: ModelTargetRef;
      protocol?: 'bailian-compatible' | 'openai-official';
    }
  | { type: 'voice.clear-target'; kind: 'transcription' | 'speech' }
  | { type: 'voice.update'; patch: Partial<VoiceSettings> }
  | { type: 'experience.set-mode'; mode: ExperienceMode }
  | {
      type: 'onboarding.update';
      patch: Partial<AppWorkspace['onboarding']>;
    }
  | { type: 'backup-preferences.update'; patch: Partial<BackupPreferences> }
  | { type: 'cloud-sync.update'; patch: Partial<CloudSyncSettings> };

export function reduceSettingsWorkspaceCommand(
  workspace: AppWorkspace,
  command: SettingsWorkspaceCommand
): { workspace: AppWorkspace; result: void } {
  switch (command.type) {
    case 'provider.ensure-active-enabled': {
      const active = workspace.providers.find(
        (provider) => provider.id === workspace.activeProviderId
      );
      if (isProviderEnabled(active)) return { workspace, result: undefined };
      const fallback = workspace.providers.find(isProviderEnabled);
      return {
        workspace: fallback
          ? { ...workspace, activeProviderId: fallback.id }
          : workspace,
        result: undefined,
      };
    }
    case 'provider.save': {
      const comparisonTargets = command.binding.mustClearModelCandidates
        ? workspace.comparisonTargets.filter((target) => target.providerId !== command.providerId)
        : workspace.comparisonTargets;
      const voice = { ...workspace.voice };
      if (command.binding.mustClearModelCandidates) {
        if (voice.transcriptionTarget?.providerId === command.providerId) delete voice.transcriptionTarget;
        if (voice.speechTarget?.providerId === command.providerId) delete voice.speechTarget;
      }
      return {
        result: undefined,
        workspace: {
          ...workspace,
          providers: workspace.providers.map((provider) =>
            provider.id === command.providerId ? command.provider : provider
          ),
          plugins: workspace.plugins.map((plugin) =>
            plugin.type === 'remote-mcp' &&
            plugin.providerId === command.providerId &&
            (command.binding.changed || command.apiKeyChanged)
              ? {
                  ...plugin,
                  enabled: false,
                  ...(command.binding.changed ? { authorization: undefined } : {}),
                }
              : plugin
          ),
          ...(command.binding.mustClearModelCandidates
            ? {
                modelCandidatesByProvider: {
                  ...workspace.modelCandidatesByProvider,
                  [command.providerId]: [],
                },
                activeModelIdByProvider: {
                  ...workspace.activeModelIdByProvider,
                  [command.providerId]: '',
                },
                comparisonTargets,
                comparisonEnabled: workspace.comparisonEnabled && comparisonTargets.length >= 2,
                voice,
                projects: workspace.projects.map((project) =>
                  project.defaultTarget?.providerId === command.providerId
                    ? { ...project, defaultTarget: undefined, updatedAt: command.now }
                    : project
                ),
                modelPricing: workspace.modelPricing.filter(
                  (pricing) => pricing.providerId !== command.providerId
                ),
                reasoningEffortByModel: Object.fromEntries(
                  Object.entries(workspace.reasoningEffortByModel).filter(
                    ([key]) => !key.startsWith(`${command.providerId}:`)
                  )
                ),
              }
            : {}),
        },
      };
    }
    case 'provider.toggle-enabled': {
      const providers = workspace.providers.map((provider) =>
        provider.id === command.providerId
          ? { ...provider, enabled: !(provider.enabled ?? true) }
          : provider
      );
      const toggledProvider = providers.find((provider) => provider.id === command.providerId);
      const disabling = !isProviderEnabled(toggledProvider);
      const fallbackProvider = providers.find(isProviderEnabled);
      const comparisonTargets = disabling
        ? workspace.comparisonTargets.filter((target) => target.providerId !== command.providerId)
        : workspace.comparisonTargets;
      const voice = { ...workspace.voice };
      if (disabling && voice.transcriptionTarget?.providerId === command.providerId) {
        delete voice.transcriptionTarget;
      }
      if (disabling && voice.speechTarget?.providerId === command.providerId) {
        delete voice.speechTarget;
      }
      return {
        result: undefined,
        workspace: {
          ...workspace,
          providers,
          activeProviderId:
            workspace.activeProviderId === command.providerId && disabling
              ? fallbackProvider?.id ?? workspace.activeProviderId
              : workspace.activeProviderId,
          comparisonTargets,
          comparisonEnabled: workspace.comparisonEnabled && comparisonTargets.length >= 2,
          voice,
          plugins: disabling
            ? workspace.plugins.map((plugin) =>
                plugin.type === 'remote-mcp' && plugin.providerId === command.providerId
                  ? { ...plugin, enabled: false }
                  : plugin
              )
            : workspace.plugins,
          projects: disabling
            ? workspace.projects.map((project) =>
                project.defaultTarget?.providerId === command.providerId
                  ? { ...project, defaultTarget: undefined, updatedAt: command.now }
                  : project
              )
            : workspace.projects,
        },
      };
    }
    case 'provider.select':
      return { result: undefined, workspace: { ...workspace, activeProviderId: command.providerId } };
    case 'provider.add':
      return {
        result: undefined,
        workspace: {
          ...workspace,
          providers: [...workspace.providers, command.provider],
          activeProviderId: command.provider.id,
          activeModelIdByProvider: {
            ...workspace.activeModelIdByProvider,
            [command.provider.id]: '',
          },
          modelCandidatesByProvider: {
            ...workspace.modelCandidatesByProvider,
            [command.provider.id]: [],
          },
        },
      };
    case 'provider.delete': {
      const removal = removeProviderFromWorkspace(workspace, command.providerId, command.now);
      return { result: undefined, workspace: removal?.workspace ?? workspace };
    }
    case 'model.select':
      return {
        result: undefined,
        workspace: {
          ...workspace,
          ...(command.activateProvider ? { activeProviderId: command.providerId } : {}),
          activeModelIdByProvider: {
            ...workspace.activeModelIdByProvider,
            [command.providerId]: command.modelId,
          },
        },
      };
    case 'model.add':
      return {
        result: undefined,
        workspace: {
          ...workspace,
          providers: workspace.providers.map((provider) =>
            provider.id === command.providerId
              ? {
                  ...provider,
                  models: [
                    ...provider.models.filter((existing) => existing.id !== command.model.id),
                    command.model,
                  ],
                }
              : provider
          ),
          activeModelIdByProvider: {
            ...workspace.activeModelIdByProvider,
            [command.providerId]: command.model.id,
          },
        },
      };
    case 'model.remove': {
      const provider = workspace.providers.find((item) => item.id === command.providerId);
      const nextModels = provider?.models.filter((model) => model.id !== command.modelId) ?? [];
      const removedTarget = (target: ModelTargetRef | undefined) =>
        target?.providerId === command.providerId && target.modelId === command.modelId;
      const comparisonTargets = workspace.comparisonTargets.filter((target) => !removedTarget(target));
      const voice = { ...workspace.voice };
      if (removedTarget(voice.transcriptionTarget)) delete voice.transcriptionTarget;
      if (removedTarget(voice.speechTarget)) delete voice.speechTarget;
      const reasoningEffortByModel = { ...workspace.reasoningEffortByModel };
      delete reasoningEffortByModel[`${command.providerId}:${command.modelId}`];
      return {
        result: undefined,
        workspace: {
          ...workspace,
          providers: workspace.providers.map((item) =>
            item.id === command.providerId ? { ...item, models: nextModels } : item
          ),
          activeModelIdByProvider: {
            ...workspace.activeModelIdByProvider,
            [command.providerId]:
              workspace.activeModelIdByProvider[command.providerId] === command.modelId
                ? nextModels[0]?.id ?? ''
                : workspace.activeModelIdByProvider[command.providerId],
          },
          comparisonTargets,
          comparisonEnabled: workspace.comparisonEnabled && comparisonTargets.length >= 2,
          voice,
          projects: workspace.projects.map((project) =>
            removedTarget(project.defaultTarget)
              ? { ...project, defaultTarget: undefined, updatedAt: command.now }
              : project
          ),
          modelPricing: workspace.modelPricing.filter(
            (pricing) =>
              pricing.providerId !== command.providerId || pricing.modelId !== command.modelId
          ),
          reasoningEffortByModel,
        },
      };
    }
    case 'model.update': {
      const provider = workspace.providers.find((item) => item.id === command.providerId);
      const model = provider?.models.find((item) => item.id === command.modelId);
      if (!provider || !model) return { workspace, result: undefined };
      const nextModel: ModelInfo = { ...model, ...command.patch, source: 'manual' };
      const nextTask = inferModelTask(nextModel);
      const matchesTarget = (target: ModelTargetRef | undefined) =>
        target?.providerId === provider.id && target.modelId === model.id;
      const comparisonTargets =
        nextTask === 'chat'
          ? workspace.comparisonTargets
          : workspace.comparisonTargets.filter((target) => !matchesTarget(target));
      const voice = { ...workspace.voice };
      if (
        matchesTarget(voice.transcriptionTarget) &&
        (nextTask !== 'audio-transcription' || !nextModel.capabilities.includes('speech-to-text'))
      ) delete voice.transcriptionTarget;
      if (
        matchesTarget(voice.speechTarget) &&
        (nextTask !== 'speech-generation' || !nextModel.capabilities.includes('text-to-speech'))
      ) delete voice.speechTarget;
      const reasoningEffortByModel = { ...workspace.reasoningEffortByModel };
      if (nextTask !== 'chat' || !nextModel.capabilities.includes('reasoning')) {
        delete reasoningEffortByModel[`${provider.id}:${model.id}`];
      }
      return {
        result: undefined,
        workspace: {
          ...workspace,
          providers: workspace.providers.map((item) =>
            item.id === provider.id
              ? {
                  ...item,
                  models: item.models.map((candidate) =>
                    candidate.id === model.id ? nextModel : candidate
                  ),
                }
              : item
          ),
          comparisonTargets,
          comparisonEnabled: workspace.comparisonEnabled && comparisonTargets.length >= 2,
          voice,
          reasoningEffortByModel,
        },
      };
    }
    case 'model.set-candidates':
      return {
        result: undefined,
        workspace: {
          ...workspace,
          modelCandidatesByProvider: {
            ...workspace.modelCandidatesByProvider,
            [command.providerId]: command.models,
          },
        },
      };
    case 'comparison.toggle-target': {
      const key = `${command.target.providerId}:${command.target.modelId}`;
      const exists = workspace.comparisonTargets.some(
        (target) => `${target.providerId}:${target.modelId}` === key
      );
      const comparisonTargets = exists
        ? workspace.comparisonTargets.filter(
            (target) => `${target.providerId}:${target.modelId}` !== key
          )
        : [...workspace.comparisonTargets, command.target];
      return {
        result: undefined,
        workspace: {
          ...workspace,
          comparisonTargets,
          comparisonEnabled: exists
            ? workspace.comparisonEnabled && comparisonTargets.length >= 2
            : workspace.comparisonEnabled,
        },
      };
    }
    case 'comparison.set-enabled':
      return { result: undefined, workspace: { ...workspace, comparisonEnabled: command.enabled } };
    case 'search.update-provider':
      return {
        result: undefined,
        workspace: { ...workspace, webSearch: { ...workspace.webSearch, ...command.patch } },
      };
    case 'search.update-external':
      return {
        result: undefined,
        workspace: {
          ...workspace,
          externalSearch: { ...workspace.externalSearch, ...command.patch },
        },
      };
    case 'external-search.upsert': {
      const { input } = command;
      const existing = input.serviceId
        ? workspace.externalSearch.services.find((service) => service.id === input.serviceId)
        : undefined;
      const sameKind =
        existing ??
        (!input.serviceId
          ? workspace.externalSearch.services.find((service) => service.kind === input.kind)
          : undefined);
      const apiKey = input.apiKey?.trim();
      const service = {
        id: sameKind?.id ?? input.newId,
        kind: input.kind,
        name: (input.name?.trim() || externalSearchProviderLabels[input.kind]).slice(0, 80),
        ...(apiKey ? { apiKey } : {}),
        ...(input.endpoint?.trim() ? { endpoint: input.endpoint.trim() } : {}),
        ...(input.kind === 'grok'
          ? { model: input.model?.trim() || DEFAULT_GROK_SEARCH_MODEL }
          : {}),
      };
      const services = sameKind
        ? workspace.externalSearch.services.map((item) =>
            item.id === sameKind.id ? service : item
          )
        : [...workspace.externalSearch.services, service].slice(0, 16);
      return {
        result: undefined,
        workspace: {
          ...workspace,
          externalSearch: {
            ...workspace.externalSearch,
            services,
            selectedServiceId: service.id,
          },
        },
      };
    }
    case 'external-search.remove': {
      const services = workspace.externalSearch.services.filter(
        (service) => service.id !== command.serviceId
      );
      return {
        result: undefined,
        workspace: {
          ...workspace,
          externalSearch: {
            ...workspace.externalSearch,
            services,
            selectedServiceId:
              workspace.externalSearch.selectedServiceId === command.serviceId
                ? services[0]?.id
                : workspace.externalSearch.selectedServiceId,
            enabled: services.length ? workspace.externalSearch.enabled : false,
          },
        },
      };
    }
    case 'prompt.create':
      return {
        result: undefined,
        workspace: {
          ...workspace,
          promptTemplates: createPromptTemplate(
            workspace.promptTemplates,
            { name: command.name, content: command.content, mode: command.mode },
            { id: command.id, now: command.now }
          ),
        },
      };
    case 'prompt.delete':
      return {
        result: undefined,
        workspace: {
          ...workspace,
          promptTemplates: deletePromptTemplate(workspace.promptTemplates, command.templateId),
        },
      };
    case 'prompt.pin':
      return {
        result: undefined,
        workspace: {
          ...workspace,
          promptTemplates: setPromptTemplatePinned(
            workspace.promptTemplates,
            command.templateId,
            command.pinned ? undefined : command.now
          ),
        },
      };
    case 'pricing.update': {
      const matching = workspace.modelPricing
        .filter(
          (pricing) =>
            pricing.providerId === command.providerId && pricing.modelId === command.modelId
        )
        .sort((left, right) => right.updatedAt - left.updatedAt)[0];
      const next: ModelPricing = {
        ...(matching ?? {}),
        ...command.patch,
        providerId: command.providerId,
        modelId: command.modelId,
        currency: command.patch.currency ?? matching?.currency ?? 'CNY',
        updatedAt: command.now,
      };
      const remaining = workspace.modelPricing.filter(
        (pricing) =>
          !(pricing.providerId === command.providerId && pricing.modelId === command.modelId)
      );
      const hasRate =
        next.inputPerMillion !== undefined ||
        next.cachedInputPerMillion !== undefined ||
        next.outputPerMillion !== undefined;
      return {
        result: undefined,
        workspace: { ...workspace, modelPricing: hasRate ? [...remaining, next] : remaining },
      };
    }
    case 'cost-guard.update':
      return {
        result: undefined,
        workspace: { ...workspace, costGuard: { ...workspace.costGuard, ...command.patch } },
      };
    case 'plugin.add':
      return {
        result: undefined,
        workspace: { ...workspace, plugins: [...workspace.plugins, command.plugin] },
      };
    case 'plugin.set-enabled': {
      const plugin = workspace.plugins.find((item) => item.id === command.pluginId);
      if (!plugin) return { workspace, result: undefined };
      return {
        result: undefined,
        workspace: {
          ...workspace,
          plugins: workspace.plugins.map((item) => {
            if (item.id === command.pluginId) return { ...item, enabled: command.enabled };
            if (
              command.enabled &&
              item.type === 'remote-mcp' &&
              item.providerId === plugin.providerId
            ) return { ...item, enabled: false };
            return item;
          }),
        },
      };
    }
    case 'plugin.remove':
      return {
        result: undefined,
        workspace: {
          ...workspace,
          plugins: workspace.plugins.filter((plugin) => plugin.id !== command.pluginId),
        },
      };
    case 'voice.set-target': {
      const voice = {
        ...workspace.voice,
        ...(command.kind === 'transcription'
          ? { transcriptionTarget: command.target }
          : { speechTarget: command.target }),
      };
      if (
        command.kind === 'speech' &&
        command.protocol === 'bailian-compatible' &&
        (!voice.speechVoice.trim() || voice.speechVoice === 'alloy')
      ) voice.speechVoice = 'Cherry';
      if (
        command.kind === 'speech' &&
        command.protocol === 'openai-official' &&
        (!voice.speechVoice.trim() || voice.speechVoice === 'Cherry')
      ) voice.speechVoice = 'alloy';
      return { result: undefined, workspace: { ...workspace, voice } };
    }
    case 'voice.clear-target': {
      const voice = { ...workspace.voice };
      if (command.kind === 'transcription') delete voice.transcriptionTarget;
      else delete voice.speechTarget;
      return { result: undefined, workspace: { ...workspace, voice } };
    }
    case 'voice.update':
      return {
        result: undefined,
        workspace: { ...workspace, voice: { ...workspace.voice, ...command.patch } },
      };
    case 'experience.set-mode':
      return {
        result: undefined,
        workspace: { ...workspace, experienceMode: normalizeExperienceMode(command.mode) },
      };
    case 'onboarding.update': {
      const configured = hasUsableProviderConfiguration(
        workspace.providers,
        workspace.activeModelIdByProvider
      );
      return {
        result: undefined,
        workspace: {
          ...workspace,
          onboarding: normalizeOnboardingState(
            { ...workspace.onboarding, ...command.patch },
            configured
          ),
        },
      };
    }
    case 'backup-preferences.update':
      return {
        result: undefined,
        workspace: {
          ...workspace,
          backupPreferences: normalizeBackupPreferences({
            ...workspace.backupPreferences,
            ...command.patch,
          }),
        },
      };
    case 'cloud-sync.update':
      return {
        result: undefined,
        workspace: {
          ...workspace,
          cloudSync: normalizeCloudSyncSettings(
            { ...workspace.cloudSync, ...command.patch },
            workspace.cloudSync.deviceId
          ),
        },
      };
    default: {
      const exhaustive: never = command;
      throw new Error(`Unknown Settings workspace command: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Settings-private closed command runtime. Settings visual modules submit
 * semantic commands and never receive a generic workspace mutation capability.
 */
export class SettingsWorkspaceRuntime {
  private readonly commit: WorkspaceCommitPort<SettingsWorkspaceCommand, void>;

  constructor(private readonly session: WorkspaceSession) {
    this.commit = session.bindCommitPort(reduceSettingsWorkspaceCommand);
  }

  async execute(command: SettingsWorkspaceCommand): Promise<boolean> {
    try {
      await this.commit.execute(command);
      return true;
    } catch (error) {
      if (isWorkspaceCommitRejectedError(error)) return false;
      throw error;
    }
  }

  flush(options: { propagateFailure?: boolean } = {}): Promise<void> {
    return this.session.flush({
      reason: 'settings',
      propagateFailure: options.propagateFailure,
    });
  }
}
