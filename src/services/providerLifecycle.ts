import type { AppWorkspace } from '../domain/types';

export interface ProviderRemovalResult {
  workspace: AppWorkspace;
  removedPluginIds: string[];
}

/**
 * Removes a provider and every provider-bound reference as one immutable state
 * transition, so persistence can never observe a dangling plugin.providerId.
 */
export function removeProviderFromWorkspace(
  current: AppWorkspace,
  providerId: string,
  now: number
): ProviderRemovalResult | null {
  const providers = current.providers.filter((provider) => provider.id !== providerId);
  if (providers.length === current.providers.length || !providers.length) {
    return null;
  }

  const removedPluginIds = current.plugins
    .filter((plugin) => plugin.providerId === providerId)
    .map((plugin) => plugin.id);
  const plugins = current.plugins.filter((plugin) => plugin.providerId !== providerId);
  const activeProviderId = current.activeProviderId === providerId
    ? providers[0].id
    : current.activeProviderId;
  const activeModelIdByProvider = { ...current.activeModelIdByProvider };
  const modelCandidatesByProvider = { ...current.modelCandidatesByProvider };
  delete activeModelIdByProvider[providerId];
  delete modelCandidatesByProvider[providerId];
  const reasoningEffortByModel = Object.fromEntries(
    Object.entries(current.reasoningEffortByModel).filter(([key]) => !key.startsWith(`${providerId}:`))
  );
  const comparisonTargets = current.comparisonTargets.filter(
    (target) => target.providerId !== providerId
  );
  const voice = { ...current.voice };
  if (voice.transcriptionTarget?.providerId === providerId) {
    delete voice.transcriptionTarget;
  }
  if (voice.speechTarget?.providerId === providerId) {
    delete voice.speechTarget;
  }

  return {
    removedPluginIds,
    workspace: {
      ...current,
      providers,
      plugins,
      activeProviderId,
      activeModelIdByProvider,
      modelCandidatesByProvider,
      reasoningEffortByModel,
      comparisonTargets,
      comparisonEnabled: current.comparisonEnabled && comparisonTargets.length >= 2,
      voice,
      projects: current.projects.map((project) =>
        project.defaultTarget?.providerId === providerId
          ? { ...project, defaultTarget: undefined, updatedAt: now }
          : project
      ),
      modelPricing: current.modelPricing.filter((pricing) => pricing.providerId !== providerId),
    },
  };
}
