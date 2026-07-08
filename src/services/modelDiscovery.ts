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

function discoverArkModels(provider: ProviderProfile): ModelDiscoveryResult {
  const models = mergeModels(arkPresetModels, provider.models);

  return {
    models,
    notice:
      `火山方舟不能用普通 API Key 枚举模型。已加载 ${models.length} 个预置 Doubao 模型；控制台里的专属 Endpoint 或新 Model ID 请手动添加。`,
  };
}

export async function refreshProviderModels(provider: ProviderProfile): Promise<ModelDiscoveryResult> {
  if (isVolcengineArkProvider(provider)) {
    return discoverArkModels(provider);
  }

  const models = await fetchOpenAiCompatibleModels(provider);

  return {
    models,
    notice: `已获取 ${models.length} 个模型。`,
  };
}
