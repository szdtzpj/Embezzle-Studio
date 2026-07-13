import type { ModelInfo, ProviderProfile } from '../domain/types';
import {
  arkPresetModels,
  isVolcengineArkDataPlaneHost,
  isVolcengineArkProvider,
} from '../data/arkModels';
import { fetchOpenAiCompatibleModels, isAbortError } from './openAiCompatible';

export interface ModelDiscoveryResult {
  models: ModelInfo[];
  notice: string;
  tone: 'success' | 'warning';
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

function enrichArkRemoteCandidates(models: ModelInfo[]): ModelInfo[] {
  const presets = new Map(arkPresetModels.map((model) => [model.id.toLowerCase(), model]));

  return models.flatMap((model) => {
    const preset = presets.get(model.id.trim().toLowerCase());
    if (!preset) {
      return [model];
    }
    if (preset.task && model.task && preset.task !== model.task) {
      return [];
    }

    return [{
      ...model,
      name: model.name && model.name !== model.id ? model.name : preset.name,
      capabilities: [...new Set([...preset.capabilities, ...model.capabilities])],
      contextWindow: model.contextWindow ?? preset.contextWindow,
      task: model.task ?? preset.task,
      source: 'remote',
    }];
  });
}

export async function refreshProviderModels(
  provider: ProviderProfile,
  signal?: AbortSignal
): Promise<ModelDiscoveryResult> {
  if (isVolcengineArkProvider(provider)) {
    throwIfAborted(signal);
    const canProbeCompatibleModels = isVolcengineArkDataPlaneHost(provider.baseUrl);

    if (canProbeCompatibleModels) {
      try {
        const remoteModels = await fetchOpenAiCompatibleModels(provider, signal);
        if (remoteModels.length > 0) {
          const models = enrichArkRemoteCandidates(remoteModels);
          if (models.length > 0) {
            return {
              models,
              notice: `已通过未列入官方 API 参考的兼容 /models 响应获取 ${models.length} 个模型候选；结果不保证当前账号均可调用，控制台 Endpoint ID 仍可手动添加。`,
              tone: 'warning',
            };
          }
        }
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
      }
    }

    throwIfAborted(signal);
    const models = arkCatalogCandidates();

    return {
      models,
      notice: `${canProbeCompatibleModels
        ? '火山方舟兼容 /models 响应暂不可用'
        : '当前 Base URL 不是火山方舟精确官方数据面主机，未发送 API Key 做兼容模型探测'}，已回退到根据官方模型目录维护的 ${models.length} 个本地精选候选（可能滞后）；目录不会校验当前账号权限，Endpoint ID 请手动添加。`,
      tone: 'warning',
    };
  }

  const models = await fetchOpenAiCompatibleModels(provider, signal);

  return {
    models,
    notice: `已获取 ${models.length} 个可添加模型。`,
    tone: 'success',
  };
}
