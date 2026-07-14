import type { ChatCompletionResult } from '../../../domain/types';
import type {
  ChatProviderRequest,
  GenerationTaskProviderRequest,
  ProviderAdapter,
  ProviderAdapterRegistry,
  ProviderOperation,
  ProviderTarget,
} from './ProviderAdapterRegistry';

export type ScriptedProviderStep =
  | { type: 'stream'; content: string }
  | { type: 'result'; result: ChatCompletionResult }
  | { type: 'throw'; message: string };

/** Deterministic adapter used by orchestration tests; it never performs I/O. */
export class ScriptedProviderAdapter implements ProviderAdapter {
  readonly chatRequests: ChatProviderRequest[] = [];
  readonly taskRequests: GenerationTaskProviderRequest[] = [];
  private cursor = 0;

  constructor(private readonly steps: ScriptedProviderStep[] = [
    { type: 'result', result: { content: 'ok', raw: undefined } },
  ]) {}

  async run(request: ChatProviderRequest): Promise<ChatCompletionResult> {
    this.chatRequests.push(request);
    while (this.cursor < this.steps.length) {
      const step = this.steps[this.cursor++];
      if (step.type === 'stream') {
        request.onStreamUpdate?.({ content: step.content });
        continue;
      }
      if (step.type === 'throw') {
        throw new Error(step.message);
      }
      return step.result;
    }
    return { content: '', raw: undefined };
  }

  async queryTask(request: GenerationTaskProviderRequest): Promise<ChatCompletionResult> {
    this.taskRequests.push(request);
    return this.run({
      provider: request.provider,
      modelId: request.task.modelId,
      messages: [],
      reasoningEffort: 'default',
      signal: request.signal,
    });
  }
}

export class ScriptedProviderAdapterRegistry implements ProviderAdapterRegistry {
  readonly resolutions: Array<{ target: ProviderTarget; operation: ProviderOperation }> = [];

  constructor(private readonly adapter: ProviderAdapter) {}

  resolve(target: ProviderTarget, operation: ProviderOperation): ProviderAdapter {
    this.resolutions.push({ target, operation });
    return this.adapter;
  }
}
