import type { ProviderProfile } from '../domain/types';

export function isWorkspaceReadOnly(booting: boolean, persistenceReady: boolean): boolean {
  return !booting && !persistenceReady;
}

export function isProviderEnabled(
  provider: ProviderProfile | null | undefined
): provider is ProviderProfile {
  return Boolean(provider && provider.enabled !== false);
}

export function resolveEnabledProvider(
  providers: readonly ProviderProfile[],
  requestedProviderId: string | undefined
): ProviderProfile | null {
  const requested = requestedProviderId
    ? providers.find((provider) => provider.id === requestedProviderId)
    : undefined;
  return isProviderEnabled(requested)
    ? requested
    : providers.find(isProviderEnabled) ?? null;
}

export function resolveMessageProvider(
  messageProviderId: string | undefined,
  providers: readonly ProviderProfile[],
  activeProvider: ProviderProfile | null | undefined
): ProviderProfile | null {
  if (messageProviderId) {
    const provider = providers.find((candidate) => candidate.id === messageProviderId);
    return isProviderEnabled(provider) ? provider : null;
  }

  return isProviderEnabled(activeProvider) ? activeProvider : null;
}
