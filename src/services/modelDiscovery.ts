import type { ModelInfo, ProviderProfile } from '../domain/types';
import { isVolcengineArkProvider } from '../data/arkModels';
import { fetchOpenAiCompatibleModels } from './openAiCompatible';

interface ModelDiscoveryResult {
  models: ModelInfo[];
  notice: string;
}

export async function refreshProviderModels(provider: ProviderProfile): Promise<ModelDiscoveryResult> {
  if (isVolcengineArkProvider(provider)) {
    const remoteModels = await fetchOpenAiCompatibleModels(provider);

    return {
      models: remoteModels,
      notice: `已从火山方舟获取 ${remoteModels.length} 个可添加模型。`,
    };
  }

  const models = await fetchOpenAiCompatibleModels(provider);

  return {
    models,
    notice: `已获取 ${models.length} 个可添加模型。`,
  };
}
