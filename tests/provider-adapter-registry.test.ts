import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultWorkspace } from '../src/data/providerCatalog';
import type { ChatMessage, ExternalSearchSettings, ModelInfo, ProviderProfile } from '../src/domain/types';
import { createProductionProviderAdapterRegistry } from '../src/features/chat/orchestration/ProviderAdapterRegistry';
import {
  ScriptedProviderAdapter,
  ScriptedProviderAdapterRegistry,
} from '../src/features/chat/orchestration/scriptedProviderAdapter';

const platform = vi.hoisted(() => ({ OS: 'android' }));
vi.mock('react-native', () => ({ Platform: platform }));

function makeProvider(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'p-test',
    name: 'Test Provider',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test-key',
    capabilities: ['text', 'streaming', 'web-search', 'tool-calling'],
    models: [],
    ...overrides,
  };
}

function makeModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: 'gpt-4.1',
    name: 'GPT 4.1',
    capabilities: ['text', 'streaming', 'web-search', 'tool-calling'],
    task: 'chat',
    source: 'manual',
    ...overrides,
  };
}

const userMessage: ChatMessage = {
  id: 'u1',
  role: 'user',
  content: 'hello',
  createdAt: 1,
  status: 'ready',
};

afterEach(() => {
  platform.OS = 'android';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

describe('ProductionProviderAdapterRegistry', () => {
  it('routes official Anthropic to /v1/messages and Anthropic relays to /chat/completions', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/messages')) {
        return new Response(
          JSON.stringify({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'anthropic native' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'openai compat' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const registry = createProductionProviderAdapterRegistry();

    const official = makeProvider({
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-1',
    });
    const officialRes = await registry
      .resolve({ provider: official, modelId: 'claude-sonnet-5-5' }, 'chat')
      .run({
        provider: official,
        modelId: 'claude-sonnet-5-5',
        model: makeModel({ id: 'claude-sonnet-5-5' }),
        messages: [userMessage],
        reasoningEffort: 'default',
      });
    expect(officialRes.content).toBe('anthropic native');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages');

    const relay = makeProvider({
      kind: 'anthropic',
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'sk-relay-1',
    });
    const relayRes = await registry
      .resolve({ provider: relay, modelId: 'claude-sonnet-5-5' }, 'chat')
      .run({
        provider: relay,
        modelId: 'claude-sonnet-5-5',
        model: makeModel({ id: 'claude-sonnet-5-5' }),
        messages: [userMessage],
        reasoningEffort: 'default',
      });
    expect(relayRes.content).toBe('openai compat');
    expect(fetchMock.mock.calls[1][0]).toBe('https://relay.example.com/v1/chat/completions');
  });

  it('routes official Gemini native to generateContent, Gemini /v1beta/openai and relays to OpenAI-compatible', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('streamGenerateContent') || url.includes('generateContent')) {
        return new Response(
          JSON.stringify({
            candidates: [{ content: { role: 'model', parts: [{ text: 'gemini native' }] }, finishReason: 'STOP' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'gemini openai compat' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const registry = createProductionProviderAdapterRegistry();

    const nativeGemini = makeProvider({
      kind: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'AIza-test',
    });
    const nativeRes = await registry
      .resolve({ provider: nativeGemini, modelId: 'gemini-2.5-pro' }, 'chat')
      .run({
        provider: nativeGemini,
        modelId: 'gemini-2.5-pro',
        model: makeModel({ id: 'gemini-2.5-pro' }),
        messages: [userMessage],
        reasoningEffort: 'default',
      });
    expect(nativeRes.content).toBe('gemini native');
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent'
    );

    const compatGemini = makeProvider({
      kind: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKey: 'AIza-test',
    });
    const compatRes = await registry
      .resolve({ provider: compatGemini, modelId: 'gemini-2.5-pro' }, 'chat')
      .run({
        provider: compatGemini,
        modelId: 'gemini-2.5-pro',
        model: makeModel({ id: 'gemini-2.5-pro' }),
        messages: [userMessage],
        reasoningEffort: 'default',
      });
    expect(compatRes.content).toBe('gemini openai compat');
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
    );

    const relayGemini = makeProvider({
      kind: 'gemini',
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'sk-relay',
    });
    await registry
      .resolve({ provider: relayGemini, modelId: 'gemini-2.5-pro' }, 'chat')
      .run({
        provider: relayGemini,
        modelId: 'gemini-2.5-pro',
        model: makeModel({ id: 'gemini-2.5-pro' }),
        messages: [userMessage],
        reasoningEffort: 'default',
      });
    expect(fetchMock.mock.calls[2][0]).toBe('https://relay.example.com/v1/chat/completions');
  });

  it('routes official Gemini image-generation models to Gemini native generateContent', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ inlineData: { mimeType: 'image/png', data: 'AQID' } }],
              },
              finishReason: 'STOP',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    const registry = createProductionProviderAdapterRegistry();
    const gemini = makeProvider({
      kind: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'AIza-img',
    });
    const imgModel = makeModel({
      id: 'gemini-2.5-flash-image',
      capabilities: ['text', 'image-generation'],
      task: 'image-generation',
    });
    const res = await registry
      .resolve({ provider: gemini, modelId: imgModel.id, model: imgModel }, 'chat')
      .run({
        provider: gemini,
        modelId: imgModel.id,
        model: imgModel,
        messages: [userMessage],
        reasoningEffort: 'default',
      });
    expect(String(fetchMock.mock.calls[0][0])).toMatch(
      /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-2\.5-flash-image:(?:stream)?generateContent/i
    );
    expect(res.attachments?.[0].kind).toBe('image');
  });

  it('routes official xAI Grok chat to /v1/responses, media models and externalSearch/relays to openAiCompatible', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://api.tavily.com/search') {
        return new Response(
          JSON.stringify({ results: [{ title: 'T', url: 'https://example.com/t', content: 'ok' }] }),
          { status: 200 }
        );
      }
      if (url.endsWith('/images/generations')) {
        return new Response(JSON.stringify({ data: [{ b64_json: 'AQID' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/v1/responses')) {
        return new Response(
          JSON.stringify({
            id: 'resp_xai',
            status: 'completed',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'grok ok' }] }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'compat ok' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const registry = createProductionProviderAdapterRegistry();

    const officialXai = makeProvider({
      kind: 'xai-grok',
      baseUrl: 'https://api.x.ai/v1',
      apiKey: 'xai-key',
    });
    const chatRes = await registry
      .resolve({ provider: officialXai, modelId: 'grok-4.7' }, 'chat')
      .run({
        provider: officialXai,
        modelId: 'grok-4.7',
        model: makeModel({ id: 'grok-4.7' }),
        messages: [userMessage],
        reasoningEffort: 'default',
      });
    expect(chatRes.content).toBe('grok ok');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.x.ai/v1/responses');

    const imgModel = makeModel({
      id: 'grok-imagine-image-2.0',
      capabilities: ['text', 'image-generation'],
      task: 'image-generation',
    });
    const imgRes = await registry
      .resolve({ provider: officialXai, modelId: imgModel.id, model: imgModel }, 'chat')
      .run({
        provider: officialXai,
        modelId: imgModel.id,
        model: imgModel,
        messages: [userMessage],
        reasoningEffort: 'default',
      });
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.x.ai/v1/images/generations');
    expect(imgRes.attachments?.[0].kind).toBe('image');

    const externalSearch: ExternalSearchSettings = {
      enabled: true,
      selectedServiceId: 'tavily-1',
      maxResults: 2,
      maxToolRounds: 1,
      services: [{ id: 'tavily-1', kind: 'tavily', name: 'Tavily', apiKey: 'tvly-key' }],
    };
    const extRes = await registry
      .resolve({ provider: officialXai, modelId: 'grok-4.7' }, 'chat')
      .run({
        provider: officialXai,
        modelId: 'grok-4.7',
        model: makeModel({ id: 'grok-4.7', capabilities: ['text', 'tool-calling'] }),
        messages: [userMessage],
        reasoningEffort: 'default',
        externalSearch,
      });
    expect(extRes.content).toBe('compat ok');
    expect(fetchMock.mock.calls[2][0]).toBe('https://api.x.ai/v1/chat/completions');

    const relayXai = makeProvider({
      kind: 'xai-grok',
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'relay-key',
    });
    await registry
      .resolve({ provider: relayXai, modelId: 'grok-4.7' }, 'chat')
      .run({
        provider: relayXai,
        modelId: 'grok-4.7',
        model: makeModel({ id: 'grok-4.7' }),
        messages: [userMessage],
        reasoningEffort: 'default',
      });
    expect(fetchMock.mock.calls[3][0]).toBe('https://relay.example.com/v1/chat/completions');
  });

  it('rejects mismatched official hosts and routes all remaining ProviderKinds plus generation-task to openAiCompatible', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/contents/generations/tasks/')) {
        return new Response(JSON.stringify({ id: 'task-1', status: 'running' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const registry = createProductionProviderAdapterRegistry();

    expect(() =>
      registry.resolve(
        {
          provider: makeProvider({ kind: 'anthropic', baseUrl: 'https://api.openai.com/v1' }),
          modelId: 'claude-sonnet-5-5',
        },
        'chat'
      )
    ).toThrow(/类型与端点协议不一致/);

    expect(() =>
      registry.resolve(
        {
          provider: makeProvider({ kind: 'gemini', baseUrl: 'https://api.anthropic.com/v1' }),
          modelId: 'gemini-2.5-pro',
        },
        'chat'
      )
    ).toThrow(/类型与端点协议不一致/);

    const compatCases: Array<{ kind: ProviderProfile['kind']; baseUrl: string; modelId: string }> = [
      { kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', modelId: 'gpt-4.1' },
      { kind: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', modelId: 'deepseek-v4-pro' },
      { kind: 'volcengine-ark', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', modelId: 'doubao-seed-2-0-pro' },
      { kind: 'bailian-compatible', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', modelId: 'qwen-plus' },
      { kind: 'new-api-relay', baseUrl: 'https://relay.example.com/v1', modelId: 'gpt-4.1' },
      { kind: 'custom', baseUrl: 'https://custom.example.com/v1', modelId: 'custom-model' },
    ];

    for (const item of compatCases) {
      const p = makeProvider({ kind: item.kind, baseUrl: item.baseUrl });
      const res = await registry
        .resolve({ provider: p, modelId: item.modelId }, 'chat')
        .run({
          provider: p,
          modelId: item.modelId,
          model: makeModel({ id: item.modelId }),
          messages: [userMessage],
          reasoningEffort: 'default',
        });
      expect(res.content).toBe('ok');
    }

    const ark = makeProvider({
      kind: 'volcengine-ark',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    });
    const taskRes = await registry
      .resolve({ provider: ark, modelId: 'doubao-seedance-2-0' }, 'generation-task')
      .queryTask({
        provider: ark,
        task: {
          providerId: ark.id,
          modelId: 'doubao-seedance-2-0',
          taskId: 'task-1',
          kind: 'video',
          status: 'submitted',
        },
      });
    expect(taskRes.generationTask?.status).toBe('running');
  });

  it('blocks mismatched official hosts across all kinds/operations/tasks and blocked Bailian plan domains without calling fetch', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('fetch should not be called');
    });
    vi.stubGlobal('fetch', fetchMock);
    const registry = createProductionProviderAdapterRegistry();

    const mismatchCases: Array<{
      provider: ProviderProfile;
      model: ModelInfo;
      operation: 'chat' | 'generation-task';
    }> = [
      {
        provider: makeProvider({ kind: 'openai-compatible', baseUrl: 'https://api.anthropic.com/v1' }),
        model: makeModel({ id: 'claude-sonnet-5-5' }),
        operation: 'chat',
      },
      {
        provider: makeProvider({ kind: 'openai-compatible', baseUrl: 'https://api.anthropic.com/v1' }),
        model: makeModel({ id: 'sora-2', task: 'video-generation', capabilities: ['video-generation'] }),
        operation: 'generation-task',
      },
      {
        provider: makeProvider({ kind: 'deepseek', baseUrl: 'https://api.openai.com/v1' }),
        model: makeModel({ id: 'deepseek-v4-pro' }),
        operation: 'chat',
      },
      {
        provider: makeProvider({ kind: 'volcengine-ark', baseUrl: 'https://api.openai.com/v1' }),
        model: makeModel({ id: 'doubao-seedance-2-0', task: 'video-generation', capabilities: ['video-generation'] }),
        operation: 'generation-task',
      },
      {
        provider: makeProvider({ kind: 'bailian-compatible', baseUrl: 'https://api.deepseek.com/v1' }),
        model: makeModel({ id: 'qwen-plus' }),
        operation: 'chat',
      },
      {
        provider: makeProvider({ kind: 'anthropic', baseUrl: 'https://api.openai.com/v1' }),
        model: makeModel({ id: 'dall-e-3', task: 'image-generation', capabilities: ['image-generation'] }),
        operation: 'chat',
      },
      {
        provider: makeProvider({ kind: 'gemini', baseUrl: 'https://api.openai.com/v1' }),
        model: makeModel({ id: 'dall-e-3', task: 'image-generation', capabilities: ['image-generation'] }),
        operation: 'chat',
      },
    ];

    for (const item of mismatchCases) {
      expect(() =>
        registry.resolve(
          { provider: item.provider, modelId: item.model.id, model: item.model },
          item.operation
        )
      ).toThrow(/类型与端点协议不一致/);
    }

    expect(() =>
      registry.resolve(
        {
          provider: makeProvider({
            kind: 'bailian-compatible',
            baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
          }),
          modelId: 'qwen-plus',
        },
        'chat'
      )
    ).toThrow(/Coding Plan/);

    expect(() =>
      registry.resolve(
        {
          provider: makeProvider({
            kind: 'bailian-compatible',
            baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
          }),
          modelId: 'qwen-plus',
        },
        'generation-task'
      )
    ).toThrow(/Token Plan/);

    expect(fetchMock).not.toHaveBeenCalled();

    // 确认 custom / new-api-relay / 合法第三方中转 / 本地回环调试地址不被误伤
    expect(() =>
      registry.resolve(
        {
          provider: makeProvider({ kind: 'custom', baseUrl: 'https://api.anthropic.com/v1' }),
          modelId: 'claude-sonnet-5-5',
        },
        'chat'
      )
    ).not.toThrow();
    expect(() =>
      registry.resolve(
        {
          provider: makeProvider({ kind: 'new-api-relay', baseUrl: 'https://api.openai.com/v1' }),
          modelId: 'gpt-4.1',
        },
        'chat'
      )
    ).not.toThrow();
    expect(() =>
      registry.resolve(
        {
          provider: makeProvider({ kind: 'deepseek', baseUrl: 'https://relay.example.com/v1' }),
          modelId: 'deepseek-v4-pro',
        },
        'chat'
      )
    ).not.toThrow();
    expect(() =>
      registry.resolve(
        {
          provider: makeProvider({ kind: 'anthropic', baseUrl: 'http://127.0.0.1:8080/v1' }),
          modelId: 'claude-sonnet-5-5',
        },
        'chat'
      )
    ).not.toThrow();
  });

  it('normalizes uppercase Gemini /V1BETA/OpenAI path when routed through registry to openAiCompatible', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'gemini compat ok' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    const registry = createProductionProviderAdapterRegistry();
    const geminiCompat = makeProvider({
      kind: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/V1BETA/OpenAI/',
      apiKey: 'AIza-compat',
    });

    const result = await registry
      .resolve({ provider: geminiCompat, modelId: 'gemini-2.5-pro' }, 'chat')
      .run({
        provider: geminiCompat,
        modelId: 'gemini-2.5-pro',
        model: makeModel({ id: 'gemini-2.5-pro' }),
        messages: [userMessage],
        reasoningEffort: 'default',
      });

    expect(result.content).toBe('gemini compat ok');
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
    );
  });
});
