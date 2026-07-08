import type { ModelInfo, ProviderProfile } from '../domain/types';
import { arkPresetModels, isVolcengineArkProvider } from '../data/arkModels';
import { fetchOpenAiCompatibleModels } from './openAiCompatible';

interface ModelDiscoveryResult {
  models: ModelInfo[];
  notice: string;
}

function mergeModels(existingModels: ModelInfo[], discoveredModels: ModelInfo[]): ModelInfo[] {
  const byId = new Map<string, ModelInfo>();

  for (const model of [...existingModels, ...discoveredModels]) {
    byId.set(model.id, model);
  }

  return Array.from(byId.values());
}

function remoteModelsWithManualAdditions(remoteModels: ModelInfo[], existingModels: ModelInfo[]): ModelInfo[] {
  const remoteModelIds = new Set(remoteModels.map((model) => model.id));
  const manualModels = existingModels.filter(
    (model) => model.source === 'manual' && !remoteModelIds.has(model.id)
  );

  return [...remoteModels, ...manualModels];
}

function formatDiscoveryError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function discoverArkModels(provider: ProviderProfile, error?: unknown): ModelDiscoveryResult {
  const models = mergeModels(arkPresetModels, provider.models);
  const reason = error ? `远程 /models 请求失败：${formatDiscoveryError(error)} ` : '';

  return {
    models,
    notice: `${reason}已临时加载 ${models.length} 个预置 Doubao 模型；控制台里的专属 Endpoint 或新 Model ID 也可以手动添加。`,
  };
}

export async function refreshProviderModels(provider: ProviderProfile): Promise<ModelDiscoveryResult> {
  if (isVolcengineArkProvider(provider)) {
    try {
      const remoteModels = await fetchOpenAiCompatibleModels(provider);
      const models = remoteModelsWithManualAdditions(remoteModels, provider.models);

      return {
        models,
        notice: `已从火山方舟获取 ${remoteModels.length} 个可用模型；已隐藏预置模型，避免误选当前 API Key 无权调用的 ID。`,
      };
    } catch (error) {
      return discoverArkModels(provider, error);
    }
  }

  const models = await fetchOpenAiCompatibleModels(provider);

  return {
    models,
    notice: `已获取 ${models.length} 个模型。`,
  };
}
