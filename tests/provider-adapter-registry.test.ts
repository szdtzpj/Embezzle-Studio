import { describe, expect, it } from 'vitest';

import { createDefaultWorkspace } from '../src/data/providerCatalog';
import {
  ScriptedProviderAdapter,
  ScriptedProviderAdapterRegistry,
} from '../src/features/chat/orchestration/scriptedProviderAdapter';

describe('ProviderAdapterRegistry', () => {
  it('routes deterministic chat and task requests without production I/O', async () => {
    const provider = createDefaultWorkspace().providers[0];
    const adapter = new ScriptedProviderAdapter([
      { type: 'stream', content: 'hel' },
      { type: 'result', result: { content: 'hello', raw: { scripted: true } } },
      { type: 'result', result: { content: 'done', raw: { scripted: true } } },
    ]);
    const registry = new ScriptedProviderAdapterRegistry(adapter);
    const stream: string[] = [];

    const chat = registry.resolve({ provider, modelId: 'model-a' }, 'chat');
    const chatResult = await chat.run({
      provider,
      modelId: 'model-a',
      messages: [],
      reasoningEffort: 'default',
      onStreamUpdate: (update) => stream.push(update.content),
    });
    const taskResult = await registry
      .resolve({ provider, modelId: 'model-a' }, 'generation-task')
      .queryTask({
        provider,
        task: {
          kind: 'video',
          taskId: 'task-1',
          providerId: provider.id,
          modelId: 'model-a',
          status: 'submitted',
        },
      });

    expect(stream).toEqual(['hel']);
    expect(chatResult.content).toBe('hello');
    expect(taskResult.content).toBe('done');
    expect(registry.resolutions.map((item) => item.operation)).toEqual([
      'chat',
      'generation-task',
    ]);
    expect(adapter.chatRequests).toHaveLength(2);
    expect(adapter.taskRequests).toHaveLength(1);
  });
});
