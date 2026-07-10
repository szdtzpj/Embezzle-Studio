import type { ModelInfo, ProviderProfile } from '../domain/types';
import { arkPresetModels, isVolcengineArkProvider } from '../data/arkModels';
import { fetchOpenAiCompatibleModels } from './openAiCompatible';

interface ModelDiscoveryResult {
  models: ModelInfo[];
  notice: string;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }

  const error = new Error('模型列表刷新已取消。');
  error.name = 'AbortError';
  throw error;
}

function arkCatalogCandidates(): ModelInfo[] {
  return arkPresetModels.map((model) => ({
    ...model,
    capabilities: [...model.capabilities],
    // The existing model picker treats remote entries as addable candidates.
    // The notice below makes clear that these came from the public catalog and
    // were not discovered from the current account.
    source: 'remote',
  }));
}

export async function refreshProviderModels(
  provider: ProviderProfile,
  signal?: AbortSignal
): Promise<ModelDiscoveryResult> {
  if (isVolcengineArkProvider(provider)) {
    throwIfAborted(signal);
    const models = arkCatalogCandidates();

    return {
      models,
      notice: `已载入火山方舟官方模型目录中的 ${models.length} 个候选；目录不会校验当前账号权限，Endpoint ID 请手动添加。`,
    };
  }

  const models = await fetchOpenAiCompatibleModels(provider, signal);

  return {
    models,
    notice: `已获取 ${models.length} 个可添加模型。`,
  };
}
