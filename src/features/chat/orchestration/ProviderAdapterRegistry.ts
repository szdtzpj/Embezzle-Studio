import type {
  ChatCompletionResult,
  GenerationTaskInfo,
  ModelInfo,
  ProviderProfile,
} from '../../../domain/types';
import {
  queryGenerationTask,
  sendOpenAiCompatibleChat,
} from '../../../services/openAiCompatible';

export type ProviderOperation = 'chat' | 'generation-task';

export type ChatProviderRequest = Parameters<typeof sendOpenAiCompatibleChat>[0];

export interface GenerationTaskProviderRequest {
  provider: ProviderProfile;
  task: GenerationTaskInfo;
  signal?: AbortSignal;
}

export interface ProviderTarget {
  provider: ProviderProfile;
  modelId: string;
  model?: ModelInfo;
}

export interface ProviderAdapter {
  run(request: ChatProviderRequest): Promise<ChatCompletionResult>;
  queryTask(request: GenerationTaskProviderRequest): Promise<ChatCompletionResult>;
}

export interface ProviderAdapterRegistry {
  resolve(target: ProviderTarget, operation: ProviderOperation): ProviderAdapter;
}

class OpenAiCompatibleProviderAdapter implements ProviderAdapter {
  run(request: ChatProviderRequest): Promise<ChatCompletionResult> {
    return sendOpenAiCompatibleChat(request);
  }

  queryTask(request: GenerationTaskProviderRequest): Promise<ChatCompletionResult> {
    return queryGenerationTask(request.provider, request.task, request.signal);
  }
}

/**
 * Production registry keeps protocol selection behind the Chat Orchestration
 * seam. The first adapter intentionally wraps the existing protocol module;
 * this refactor does not rewrite provider wire behavior.
 */
export class ProductionProviderAdapterRegistry implements ProviderAdapterRegistry {
  private readonly openAiCompatible = new OpenAiCompatibleProviderAdapter();

  resolve(target: ProviderTarget, operation: ProviderOperation): ProviderAdapter {
    if (!target.provider || !target.modelId) {
      throw new Error(
        operation === 'generation-task'
          ? '生成任务缺少服务商或模型信息。'
          : '请先选择可用的服务商和模型。'
      );
    }
    return this.openAiCompatible;
  }
}

export function createProductionProviderAdapterRegistry(): ProviderAdapterRegistry {
  return new ProductionProviderAdapterRegistry();
}
