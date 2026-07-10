import type { ProviderProfile } from '../domain/types';

export function isWorkspaceReadOnly(booting: boolean, persistenceReady: boolean): boolean {
  return !booting && !persistenceReady;
}

export function resolveMessageProvider(
  messageProviderId: string | undefined,
  providers: readonly ProviderProfile[],
  activeProvider: ProviderProfile | null | undefined
): ProviderProfile | null {
  if (messageProviderId) {
    return providers.find((provider) => provider.id === messageProviderId) ?? null;
  }

  return activeProvider ?? null;
}
