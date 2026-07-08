import type { ModelInfo, ProviderProfile } from '../domain/types';
import { fetchOpenAiCompatibleModels } from './openAiCompatible';

interface ModelDiscoveryResult {
  models: ModelInfo[];
  notice: string;
}

const arkModelHints: ModelInfo[] = [
  {
    id: 'doubao-seed-evolving',
    name: 'Doubao Seed Evolving',
    capabilities: ['text', 'image-input', 'tool-calling', 'streaming'],
    source: 'preset',
  },
];

function mergeModels(existingModels: ModelInfo[], discoveredModels: ModelInfo[]): ModelInfo[] {
  const byId = new Map<string, ModelInfo>();

  for (const model of [...existingModels, ...discoveredModels]) {
    byId.set(model.id, model);
  }

  return Array.from(byId.values());
}

function discoverArkModels(provider: ProviderProfile): ModelDiscoveryResult {
  return {
    models: mergeModels(provider.models, arkModelHints),
    notice:
      '火山方舟不提供通用 OpenAI /models 拉取。已保留预置模型；如果你在控制台看到的是其他 Model ID，请在下方手动添加。',
  };
}

export async function refreshProviderModels(provider: ProviderProfile): Promise<ModelDiscoveryResult> {
  if (provider.kind === 'volcengine-ark') {
    return discoverArkModels(provider);
  }

  const models = await fetchOpenAiCompatibleModels(provider);

  return {
    models,
    notice: `已获取 ${models.length} 个模型。`,
  };
}
