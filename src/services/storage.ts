import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import { isArkStaticDoubaoModelId, isVolcengineArkProvider } from '../data/arkModels';
import type { AppWorkspace, ModelInfo, ProviderProfile } from '../domain/types';

const WORKSPACE_KEY = '@embezzle-studio/workspace-v1';
const SECRET_PREFIX = 'embezzle-studio.provider-key';

type PersistedProvider = Omit<ProviderProfile, 'apiKey'>;

interface PersistedWorkspace extends Omit<AppWorkspace, 'providers' | 'modelCandidatesByProvider'> {
  providers: PersistedProvider[];
  modelCandidatesByProvider?: Record<string, ModelInfo[]>;
}

let secureStoreAvailability: boolean | null = null;

async function canUseSecureStore(): Promise<boolean> {
  if (secureStoreAvailability !== null) {
    return secureStoreAvailability;
  }

  try {
    secureStoreAvailability = await SecureStore.isAvailableAsync();
  } catch {
    secureStoreAvailability = false;
  }

  return secureStoreAvailability;
}

function secretKey(providerId: string): string {
  return `${SECRET_PREFIX}.${providerId}`;
}

async function readSecret(providerId: string): Promise<string | undefined> {
  const key = secretKey(providerId);

  if (await canUseSecureStore()) {
    return (await SecureStore.getItemAsync(key)) ?? undefined;
  }

  return (await AsyncStorage.getItem(key)) ?? undefined;
}

async function writeSecret(providerId: string, value?: string): Promise<void> {
  const key = secretKey(providerId);

  if (!value) {
    if (await canUseSecureStore()) {
      await SecureStore.deleteItemAsync(key);
    } else {
      await AsyncStorage.removeItem(key);
    }
    return;
  }

  if (await canUseSecureStore()) {
    await SecureStore.setItemAsync(key, value);
  } else {
    await AsyncStorage.setItem(key, value);
  }
}

function stripSecret(provider: ProviderProfile): PersistedProvider {
  const { apiKey: _apiKey, ...persistedProvider } = provider;
  return persistedProvider;
}

function normalizeWorkspace(snapshot: PersistedWorkspace, providers: ProviderProfile[]): AppWorkspace {
  const modelCandidatesByProvider = { ...(snapshot.modelCandidatesByProvider ?? {}) };
  const normalizedProviders = providers.map((provider) => {
    const isArkProvider = isVolcengineArkProvider(provider);
    const addedModels = provider.models.filter(
      (model) => model.source !== 'preset' && !(isArkProvider && model.source !== 'remote' && isArkStaticDoubaoModelId(model.id))
    );

    const existingCandidates = modelCandidatesByProvider[provider.id] ?? [];
    const retainedCandidates = existingCandidates.filter(
      (model) => model.source !== 'preset' && !(isArkProvider && model.source !== 'remote' && isArkStaticDoubaoModelId(model.id))
    );

    modelCandidatesByProvider[provider.id] = retainedCandidates;

    return {
      ...provider,
      models: addedModels,
    };
  });

  const activeModelIdByProvider = { ...snapshot.activeModelIdByProvider };
  for (const provider of normalizedProviders) {
    const currentModelId = activeModelIdByProvider[provider.id];
    activeModelIdByProvider[provider.id] = provider.models.some((model) => model.id === currentModelId)
      ? currentModelId
      : provider.models[0]?.id ?? '';
  }

  return {
    ...snapshot,
    providers: normalizedProviders,
    activeModelIdByProvider,
    modelCandidatesByProvider,
  };
}

export async function loadWorkspace(): Promise<AppWorkspace | null> {
  const raw = await AsyncStorage.getItem(WORKSPACE_KEY);
  if (!raw) {
    return null;
  }

  const snapshot = JSON.parse(raw) as PersistedWorkspace;
  const providers = await Promise.all(
    snapshot.providers.map(async (provider) => ({
      ...provider,
      apiKey: await readSecret(provider.id),
    }))
  );

  return normalizeWorkspace(snapshot, providers);
}

export async function saveWorkspace(workspace: AppWorkspace): Promise<void> {
  const snapshot: PersistedWorkspace = {
    ...workspace,
    providers: workspace.providers.map(stripSecret),
  };

  await Promise.all(workspace.providers.map((provider) => writeSecret(provider.id, provider.apiKey)));
  await AsyncStorage.setItem(WORKSPACE_KEY, JSON.stringify(snapshot));
}
