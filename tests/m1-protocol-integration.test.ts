import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage, ModelInfo, ProviderProfile } from '../src/domain/types';
import { createModelInfoFromId } from '../src/services/modelCapabilities';
import {
  fetchOpenAiCompatibleModels,
  guardedApiFetch,
  queryGenerationTask,
  sendOpenAiCompatibleChat,
} from '../src/services/openAiCompatible';

const platform = vi.hoisted(() => ({ OS: 'android' }));
vi.mock('react-native', () => ({ Platform: platform }));

function makeProvider(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'p-m1',
    name: 'Test Provider',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-m1-test-key',
    capabilities: ['text', 'reasoning', 'streaming', 'web-search', 'tool-calling'],
    models: [],
    ...overrides,
  };
}

function makeModel(provider: ProviderProfile, modelId: string, overrides: Partial<ModelInfo> = {}): ModelInfo {
  const base = createModelInfoFromId(provider, modelId, 'manual');
  return {
    ...base,
    capabilities: Array.from(new Set([...base.capabilities, 'web-search', 'streaming'])),
    ...overrides,
  };
}

function userMsg(content = '你好'): ChatMessage {
  return {
    id: 'u1',
    role: 'user',
    content,
    createdAt: 1,
    status: 'ready',
  };
}

function sseResponse(frames: Array<{ event?: string; data: unknown | '[DONE]' }>): Response {
  const text = frames
    .map((frame) => {
      const eventLine = frame.event ? `event: ${frame.event}\n` : '';
      const dataStr = frame.data === '[DONE]' ? '[DONE]' : JSON.stringify(frame.data);
      return `${eventLine}data: ${dataStr}\n\n`;
    })
    .join('');
  return new Response(text, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
  });
}

afterEach(() => {
  platform.OS = 'android';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('M1.4 openAiCompatible auth headers and secret redaction', () => {
  it('applies authHeaderMode and safe customHeaders with case-insensitive deduplication', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const customAuthRelay = makeProvider({
      kind: 'new-api-relay',
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'sk-should-not-send-bearer',
      authHeaderMode: 'custom',
      customHeaders: [
        { key: 'X-Relay-Token', value: 'token-abc', enabled: true },
        { key: 'accept', value: 'application/vnd.custom+json', enabled: true },
        { key: 'X-Disabled', value: 'skip', enabled: false },
        { key: 'Host', value: 'evil.example', enabled: true },
        { key: 'X-Injected', value: 'v\r\nX-Evil: 1', enabled: true },
      ],
    });

    await sendOpenAiCompatibleChat({
      provider: customAuthRelay,
      modelId: 'gpt-4.1',
      model: makeModel(customAuthRelay, 'gpt-4.1'),
      messages: [userMsg()],
      reasoningEffort: 'default',
    });

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    expect(headers['X-Relay-Token']).toBe('token-abc');
    expect(headers.accept).toBe('application/vnd.custom+json');
    expect(headers.Accept).toBeUndefined();
    expect(headers['X-Disabled']).toBeUndefined();
    expect(headers.Host).toBeUndefined();
    expect(headers['X-Injected']).toBeUndefined();
  });

  it('redacts raw and URL-encoded apiKey across HTTP, JSON parse, and SSE stream error paths', async () => {
    const secretKey = 'sk-secret+key/with=chars9988';
    const encodedKey = encodeURIComponent(secretKey);
    const provider = makeProvider({ apiKey: secretKey });

    // 1. /models HTTP 错误（把 key 放在超过 260 字符截断边界前与尾部）
    const padding = 'x'.repeat(240);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(`${padding} bad key ${secretKey} and ${encodedKey}`, {
          status: 401,
          headers: { 'content-type': 'text/plain' },
        })
      )
    );
    await expect(fetchOpenAiCompatibleModels(provider)).rejects.toThrow(/\[REDACTED\]/);
    await fetchOpenAiCompatibleModels(provider).catch((err: Error) => {
      expect(err.message).not.toContain(secretKey);
      expect(err.message).not.toContain(encodedKey);
    });

    // 2. /chat/completions HTTP 500 错误脱敏
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(`upstream rejected token ${secretKey}`, { status: 500 })
      )
    );
    await sendOpenAiCompatibleChat({
      provider,
      modelId: 'gpt-4.1',
      model: makeModel(provider, 'gpt-4.1'),
      messages: [userMsg()],
      reasoningEffort: 'default',
    }).catch((err: Error) => {
      expect(err.message).toContain('[REDACTED]');
      expect(err.message).not.toContain(secretKey);
    });

    // 3. SSE 流内 error 事件脱敏
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse([{ data: { error: { message: `Invalid key ${secretKey}` } } }])
      )
    );
    await sendOpenAiCompatibleChat({
      provider,
      modelId: 'gpt-4.1',
      model: makeModel(provider, 'gpt-4.1'),
      messages: [userMsg()],
      reasoningEffort: 'default',
    }).catch((err: Error) => {
      expect(err.message).toContain('[REDACTED]');
      expect(err.message).not.toContain(secretKey);
    });
  });
});

describe('M1.4 multi-protocol /models discovery', () => {
  it('probes Anthropic, Gemini, and relay providers with protocol-native headers and payload normalization', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.anthropic.com/v1/models') {
        return new Response(
          JSON.stringify({
            data: [{ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', type: 'model' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url === 'https://generativelanguage.googleapis.com/v1beta/models') {
        return new Response(
          JSON.stringify({
            models: [
              {
                name: 'models/gemini-2.5-pro',
                displayName: 'Gemini 2.5 Pro',
                inputTokenLimit: 1048576,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const antModels = await fetchOpenAiCompatibleModels(
      makeProvider({
        kind: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant-key',
      })
    );
    expect(antModels.map((m) => m.id)).toEqual(['claude-sonnet-5-5']);
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      'x-api-key': 'sk-ant-key',
      'anthropic-version': '2023-06-01',
    });

    const gemModels = await fetchOpenAiCompatibleModels(
      makeProvider({
        kind: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiKey: 'AIza-key',
      })
    );
    expect(gemModels[0]).toMatchObject({
      id: 'gemini-2.5-pro',
      name: 'Gemini 2.5 Pro',
      contextWindow: 1048576,
    });
    expect(String(fetchMock.mock.calls[1][0])).not.toContain('AIza-key');
    expect((fetchMock.mock.calls[1][1] as RequestInit).headers).toMatchObject({
      'x-goog-api-key': 'AIza-key',
    });

    // 官方 kind + 第三方中转域名也可正常降级探测模型列表，且过滤缺失 id 脏条目
    const relayModels = await fetchOpenAiCompatibleModels(
      makeProvider({
        kind: 'anthropic',
        baseUrl: 'https://relay.example.com/v1',
        apiKey: 'sk-relay',
      })
    );
    expect(relayModels.map((m) => m.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    expect(fetchMock.mock.calls[2][0]).toBe('https://relay.example.com/v1/models');

    // OpenAI /models 缺失 id 的脏条目（如仅含 name）与重复空白 ID 应被清洗去重
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              { id: 'gpt-5' },
              { id: ' gpt-5 ' },
              { id: '' },
              { name: 'missing-id' },
              null,
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    );
    const cleaned = await fetchOpenAiCompatibleModels(makeProvider());
    expect(cleaned.map((m) => m.id)).toEqual(['gpt-5']);
  });
});

describe('M1.4 OpenAI Responses streaming bridge & Chat Completions citations', () => {
  it('streams OpenAI Responses-only models when onStreamUpdate is provided without adding a duplicate 120s timer', async () => {
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        {
          event: 'response.reasoning_summary_text.delta',
          data: { type: 'response.reasoning_summary_text.delta', delta: 'Thinking...' },
        },
        {
          event: 'response.output_text.delta',
          data: { type: 'response.output_text.delta', delta: 'Hello ' },
        },
        {
          event: 'response.output_text.delta',
          data: { type: 'response.output_text.delta', delta: 'World' },
        },
        {
          event: 'response.completed',
          data: {
            type: 'response.completed',
            response: {
              id: 'resp_pro_1',
              status: 'completed',
              output: [
                {
                  type: 'reasoning',
                  id: 'rs_1',
                  encrypted_content: 'enc_pro_123',
                  summary: [{ type: 'summary_text', text: 'Thinking...' }],
                },
                {
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: 'Hello World' }],
                },
              ],
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            },
          },
        },
      ])
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = makeProvider();
    const updates: Array<{ content: string; reasoningContent?: string }> = [];
    const result = await sendOpenAiCompatibleChat({
      provider,
      modelId: 'gpt-5.4-pro',
      model: makeModel(provider, 'gpt-5.4-pro'),
      messages: [userMsg()],
      reasoningEffort: 'high',
      onStreamUpdate: (u) => updates.push({ content: u.content, reasoningContent: u.reasoningContent }),
    });

    const reqBody = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(reqBody.stream).toBe(true);
    expect(reqBody.reasoning).toMatchObject({ effort: 'high', summary: 'auto' });
    expect(result.content).toBe('Hello World');
    expect(result.reasoningContent).toBe('Thinking...');
    expect(result.providerContinuations).toEqual([
      expect.objectContaining({
        provider: 'openai',
        type: 'reasoning_encrypted',
        encryptedContent: 'enc_pro_123',
      }),
    ]);
    expect(updates.at(-1)?.content).toBe('Hello World');
    // 确认没有创建多余的 120s providerFetch 定时器，仅有 10 分钟（600s）定时器
    const timeoutDelays = timeoutSpy.mock.calls.map((call) => call[1]);
    expect(timeoutDelays).toContain(10 * 60_000);
    expect(timeoutDelays).not.toContain(120_000);
  });

  it('handles guardedApiFetch with external AbortSignal without creating an extra 120s timer', async () => {
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    );
    const controller = new AbortController();
    const resp = await guardedApiFetch('https://api.x.ai/v1/responses', {
      method: 'POST',
      signal: controller.signal,
    });
    expect(resp.status).toBe(200);
    expect(timeoutSpy).not.toHaveBeenCalled();
  });

  it('routes gpt-4o-search-preview with web_search_options and parses Chat Completions annotations', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        {
          data: {
            choices: [
              {
                delta: {
                  content: 'See docs',
                  annotations: [
                    {
                      type: 'url_citation',
                      url_citation: {
                        url: 'https://docs.example.com/guide',
                        title: 'Official Guide',
                        start_index: 0,
                        end_index: 8,
                      },
                    },
                    {
                      type: 'url_citation',
                      url_citation: {
                        url: 'http://127.0.0.1/private',
                        title: 'Unsafe',
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
        { data: '[DONE]' },
      ])
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = makeProvider();
    const result = await sendOpenAiCompatibleChat({
      provider,
      modelId: 'gpt-4o-search-preview',
      model: makeModel(provider, 'gpt-4o-search-preview'),
      messages: [userMsg('search docs')],
      reasoningEffort: 'default',
      webSearch: { enabled: true, searchContextSize: 'high' },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(JSON.parse(String(init.body)).web_search_options).toEqual({
      search_context_size: 'high',
    });
    expect(result.webSearchTriggered).toBe(true);
    expect(result.citations).toEqual([
      {
        url: 'https://docs.example.com/guide',
        title: 'Official Guide',
        startIndex: 0,
        endIndex: 8,
      },
    ]);
  });
});

describe('M1.4 DeepSeek V4, native search streaming, and continuation isolation', () => {
  it('supports deepseek-flash thinking toggles and streams deepseek_web_search + multi-turn server_tool_calls', async () => {
    const dsServerTools = [
      {
        id: 'ds_ws_1',
        type: 'deepseek_web_search',
        input: { query: 'DeepSeek V4' },
        output: {
          results: [{ url: 'https://www.deepseek.com/v4', title: 'DeepSeek V4' }],
        },
      },
    ];

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        sseResponse([
          { data: { choices: [{ delta: { reasoning_content: 'Searching V4...' } }] } },
          // 纯 server_tool_calls chunk 不应被静默丢弃
          { data: { choices: [{ delta: { server_tool_calls: dsServerTools } }] } },
          { data: { choices: [{ delta: { content: 'DeepSeek V4 answer.' } }] } },
          { data: '[DONE]' },
        ])
      )
      .mockResolvedValueOnce(
        sseResponse([
          { data: { choices: [{ delta: { content: 'Follow-up answer.' } }] } },
          { data: '[DONE]' },
        ])
      )
      .mockResolvedValueOnce(
        sseResponse([
          { data: { choices: [{ delta: { content: 'Relay answer.' } }] } },
          { data: '[DONE]' },
        ])
      );
    vi.stubGlobal('fetch', fetchMock);

    const deepseek = makeProvider({
      id: 'ds',
      kind: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-ds-key',
    });
    const flashModel = makeModel(deepseek, 'deepseek-flash');
    const streamUpdates: Array<{ hasToolActivity: boolean }> = [];

    const r1 = await sendOpenAiCompatibleChat({
      provider: deepseek,
      modelId: 'deepseek-flash',
      model: flashModel,
      messages: [userMsg('查 DeepSeek V4')],
      reasoningEffort: 'high',
      webSearch: { enabled: true, searchContextSize: 'medium' },
      onStreamUpdate: (u) => {
        streamUpdates.push({ hasToolActivity: Boolean(u.toolActivity?.length) });
      },
    });

    const req1Body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(req1Body.thinking).toEqual({ type: 'enabled' });
    expect(req1Body.reasoning_effort).toBe('high');
    expect(req1Body.stream).toBe(true);
    expect(req1Body.tools).toEqual([
      { type: 'deepseek_web_search', name: 'deepseek_web_search' },
      { type: 'deepseek_read_url', name: 'deepseek_read_url' },
    ]);
    expect(streamUpdates.some((u) => u.hasToolActivity)).toBe(true);
    expect(r1.webSearchTriggered).toBe(true);
    expect(typeof r1.thinkingDurationMs).toBe('number');
    expect(r1.toolActivity?.[0]).toMatchObject({ id: 'ds_ws_1', toolName: 'web_search' });
    expect(r1.activityTimeline?.map((s) => s.kind)).toEqual(['thinking', 'tool']);
    expect(r1.citations?.[0]?.url).toBe('https://www.deepseek.com/v4');
    expect(r1.providerContinuations).toEqual([
      {
        provider: 'deepseek',
        type: 'server_tool_calls',
        serverToolCalls: dsServerTools,
      },
    ]);

    // 第 2 轮：官方 DeepSeek 普通对话回传 server_tool_calls，且 off 关闭 thinking
    const historyAssistant: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      content: r1.content,
      providerContinuations: [
        ...(r1.providerContinuations ?? []),
        {
          provider: 'anthropic',
          type: 'thinking',
          thinking: 'secret',
          signature: 'sig-ant',
        },
      ],
      createdAt: 2,
      status: 'ready',
    };

    await sendOpenAiCompatibleChat({
      provider: deepseek,
      modelId: 'deepseek-flash',
      model: flashModel,
      messages: [userMsg('查 DeepSeek V4'), historyAssistant, userMsg('继续')],
      reasoningEffort: 'off',
    });

    const req2Body = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(req2Body.thinking).toEqual({ type: 'disabled' });
    expect(req2Body.messages[1].server_tool_calls).toEqual(dsServerTools);
    expect(JSON.stringify(req2Body)).not.toContain('sig-ant');

    // 第 3 轮：中转站绝不透传 server_tool_calls 或任何私有续接块
    const relay = makeProvider({
      id: 'relay',
      kind: 'new-api-relay',
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'sk-relay',
    });
    await sendOpenAiCompatibleChat({
      provider: relay,
      modelId: 'deepseek-flash',
      model: makeModel(relay, 'deepseek-flash'),
      messages: [userMsg('查 DeepSeek V4'), historyAssistant, userMsg('继续')],
      reasoningEffort: 'default',
    });
    const req3Body = JSON.parse(String((fetchMock.mock.calls[2][1] as RequestInit).body));
    expect(req3Body.messages[1].server_tool_calls).toBeUndefined();
    expect(JSON.stringify(req3Body)).not.toContain('sig-ant');
  });
});

describe('M1.4 Iteration 2 regressions (D1, Minor 1, D3, D4, D5)', () => {
  function chunkedSseResponse(chunks: string[]): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
    });
  }

  it('D1 + Minor 1: redacts regex-special raw & URL-encoded apiKey across Ark tasks, image/video fetch errors, and Responses/WebSearch wrappers while preserving AbortError', async () => {
    const secretKey = 'sk-test+$1/?*secret99';
    const encodedKey = encodeURIComponent(secretKey);

    const arkProvider = makeProvider({
      id: 'ark',
      kind: 'volcengine-ark',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: secretKey,
    });

    // 1. queryGenerationTask failed status error.message 脱敏
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'task-1',
            status: 'failed',
            error: { message: `Ark rejected credentials ${secretKey} (${encodedKey})` },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    );
    await queryGenerationTask(arkProvider, {
      providerId: arkProvider.id,
      modelId: 'doubao-seedance-2-0',
      taskId: 'task-1',
      kind: 'video',
      status: 'submitted',
    })
      .then(() => {
        throw new Error('expected rejection');
      })
      .catch((err: Error) => {
        expect(err.message).toContain('[REDACTED]');
        expect(err.message).not.toContain(secretKey);
        expect(err.message).not.toContain(encodedKey);
      });

    // 2. sendArkVideoGenerationRequest submit failed status 脱敏
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'task-2',
            status: 'failed',
            error: { message: `Submit failed for key ${secretKey} and ${encodedKey}` },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    );
    await sendOpenAiCompatibleChat({
      provider: arkProvider,
      modelId: 'doubao-seedance-2-0',
      model: makeModel(arkProvider, 'doubao-seedance-2-0', {
        task: 'video-generation',
        capabilities: ['video-generation'],
      }),
      messages: [userMsg('generate video')],
      reasoningEffort: 'default',
    })
      .then(() => {
        throw new Error('expected rejection');
      })
      .catch((err: Error) => {
        expect(err.message).toContain('[REDACTED]');
        expect(err.message).not.toContain(secretKey);
        expect(err.message).not.toContain(encodedKey);
      });

    // 3. Minor 1: Ark / Image providerFetch 底层网络错误脱敏与 AbortError 保留
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error(`network error with ${secretKey} and ${encodedKey}`))
    );
    const openaiProvider = makeProvider({ apiKey: secretKey });
    await sendOpenAiCompatibleChat({
      provider: openaiProvider,
      modelId: 'dall-e-3',
      model: makeModel(openaiProvider, 'dall-e-3', {
        task: 'image-generation',
        capabilities: ['image-generation'],
      }),
      messages: [userMsg('draw a cat')],
      reasoningEffort: 'default',
    })
      .then(() => {
        throw new Error('expected rejection');
      })
      .catch((err: Error) => {
        expect(err.message).toContain('[REDACTED]');
        expect(err.message).not.toContain(secretKey);
        expect(err.message).not.toContain(encodedKey);
      });

    await queryGenerationTask(arkProvider, {
      providerId: arkProvider.id,
      modelId: 'doubao-seedance-2-0',
      taskId: 'task-net-err',
      kind: 'video',
      status: 'submitted',
    })
      .then(() => {
        throw new Error('expected rejection');
      })
      .catch((err: Error) => {
        expect(err.message).toContain('[REDACTED]');
        expect(err.message).not.toContain(secretKey);
        expect(err.message).not.toContain(encodedKey);
      });

    const abortController = new AbortController();
    abortController.abort();
    await sendOpenAiCompatibleChat({
      provider: openaiProvider,
      modelId: 'dall-e-3',
      model: makeModel(openaiProvider, 'dall-e-3', {
        task: 'image-generation',
        capabilities: ['image-generation'],
      }),
      messages: [userMsg('draw a cat')],
      reasoningEffort: 'default',
      signal: abortController.signal,
    })
      .then(() => {
        throw new Error('expected abort');
      })
      .catch((err: Error) => {
        expect(err.name).toBe('AbortError');
      });

    // 4. sendOpenAiResponsesChat 流式分支 HTTP 401 包含 encodedKey 脱敏
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(`invalid token ${secretKey} and ${encodedKey}`, {
          status: 401,
          headers: { 'content-type': 'text/plain' },
        })
      )
    );
    await sendOpenAiCompatibleChat({
      provider: openaiProvider,
      modelId: 'gpt-5.4-pro',
      model: makeModel(openaiProvider, 'gpt-5.4-pro'),
      messages: [userMsg()],
      reasoningEffort: 'default',
      onStreamUpdate: () => undefined,
    })
      .then(() => {
        throw new Error('expected rejection');
      })
      .catch((err: Error) => {
        expect(err.message).toContain('[REDACTED]');
        expect(err.message).not.toContain(secretKey);
        expect(err.message).not.toContain(encodedKey);
      });

    // 5. parseOpenAiResponsesResponse 非流分支 HTTP 200 { error } 脱敏
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'resp_err',
            status: 'failed',
            error: { message: `bad auth ${secretKey} ${encodedKey}` },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    );
    await sendOpenAiCompatibleChat({
      provider: openaiProvider,
      modelId: 'gpt-5.4-pro',
      model: makeModel(openaiProvider, 'gpt-5.4-pro'),
      messages: [userMsg()],
      reasoningEffort: 'default',
    })
      .then(() => {
        throw new Error('expected rejection');
      })
      .catch((err: Error) => {
        expect(err.message).toContain('[REDACTED]');
        expect(err.message).not.toContain(secretKey);
        expect(err.message).not.toContain(encodedKey);
      });

    // 6. parseProviderWebSearchResponse 非流分支 HTTP 200 { error } 脱敏
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'resp_ws_err',
            status: 'failed',
            error: { message: `search auth ${secretKey} ${encodedKey}` },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    );
    await sendOpenAiCompatibleChat({
      provider: openaiProvider,
      modelId: 'gpt-4.1',
      model: makeModel(openaiProvider, 'gpt-4.1'),
      messages: [userMsg()],
      reasoningEffort: 'default',
      webSearch: { enabled: true, searchContextSize: 'medium' },
    })
      .then(() => {
        throw new Error('expected rejection');
      })
      .catch((err: Error) => {
        expect(err.message).toContain('[REDACTED]');
        expect(err.message).not.toContain(secretKey);
        expect(err.message).not.toContain(encodedKey);
      });

    // 7. sendOpenAiResponsesChat 分支在 AbortError 时保留 AbortError
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        const abortErr = new Error('aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
      })
    );
    await sendOpenAiCompatibleChat({
      provider: openaiProvider,
      modelId: 'gpt-5.4-pro',
      model: makeModel(openaiProvider, 'gpt-5.4-pro'),
      messages: [userMsg()],
      reasoningEffort: 'default',
      onStreamUpdate: () => undefined,
    })
      .then(() => {
        throw new Error('expected abort');
      })
      .catch((err: Error) => {
        expect(err.name).toBe('AbortError');
      });
  });

  it('D3: handles SSE CRLF split across chunks, consecutive CR+CRLF, and trailing CR at EOF in both chat and tool-loop streams', async () => {
    const provider = makeProvider();

    // 1. 普通 Chat Completions 跨 chunk \r + \n 拆分与 EOF 孤立 \r
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        chunkedSseResponse([
          'data: {"choices":[{"delta":\r',
          '\ndata: {"content":"hello"}}]}\r\n\r\n',
          'data: {"choices":[{"delta":{"content":" world"}}]}\r',
          '\r\n',
          'data: [DONE]\r',
        ])
      )
    );
    const chatRes = await sendOpenAiCompatibleChat({
      provider,
      modelId: 'gpt-4.1',
      model: makeModel(provider, 'gpt-4.1'),
      messages: [userMsg()],
      reasoningEffort: 'default',
    });
    expect(chatRes.content).toBe('hello world');

    // 2. 外部搜索 Tool Loop SSE 跨 chunk \r + \n 拆分
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        chunkedSseResponse([
          'data: {"choices":[{"delta":\r',
          '\ndata: {"content":"tool-loop-ok"}}]}\r\n\r\n',
          'data: [DONE]\r\n\r\n',
        ])
      )
    );
    const toolLoopRes = await sendOpenAiCompatibleChat({
      provider,
      modelId: 'gpt-4.1',
      model: makeModel(provider, 'gpt-4.1'),
      messages: [userMsg()],
      reasoningEffort: 'default',
      externalSearch: {
        enabled: true,
        selectedServiceId: 'tavily-1',
        maxResults: 2,
        maxToolRounds: 1,
        services: [{ id: 'tavily-1', kind: 'tavily', name: 'Tavily', apiKey: 'tvly-key' }],
      },
    });
    expect(toolLoopRes.content).toBe('tool-loop-ok');
  });

  it('D4: normalizes uppercase Gemini OpenAI-compatible path variants to lowercase /v1beta/openai', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const geminiCompat = makeProvider({
      kind: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/V1BETA/OpenAI',
      apiKey: 'AIza-compat',
    });
    await sendOpenAiCompatibleChat({
      provider: geminiCompat,
      modelId: 'gemini-2.5-pro',
      model: makeModel(geminiCompat, 'gemini-2.5-pro'),
      messages: [userMsg()],
      reasoningEffort: 'default',
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
    );
  });

  it('D5: merges streaming DeepSeek server_tool_calls chunks by index when subsequent or all chunks omit id', async () => {
    const fetchMock = vi
      .fn()
      // 场景 1: 首包有 id 无 index，续包缺 id 仅传 index: 0
      .mockResolvedValueOnce(
        sseResponse([
          {
            data: {
              choices: [
                {
                  delta: {
                    server_tool_calls: [
                      {
                        id: 'ds_ws_1',
                        type: 'deepseek_web_search',
                        input: { query: 'DeepSeek V4' },
                      },
                    ],
                  },
                },
              ],
            },
          },
          {
            data: {
              choices: [
                {
                  delta: {
                    server_tool_calls: [
                      {
                        index: 0,
                        output: {
                          results: [{ url: 'https://www.deepseek.com/v4', title: 'DeepSeek V4' }],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
          { data: { choices: [{ delta: { content: 'Done 1' } }] } },
          { data: '[DONE]' },
        ])
      )
      // 场景 2: 首包与续包均缺 id，仅传 index: 0
      .mockResolvedValueOnce(
        sseResponse([
          {
            data: {
              choices: [
                {
                  delta: {
                    server_tool_calls: [
                      {
                        index: 0,
                        type: 'deepseek_web_search',
                        input: { query: 'DeepSeek Index Only' },
                      },
                    ],
                  },
                },
              ],
            },
          },
          {
            data: {
              choices: [
                {
                  delta: {
                    server_tool_calls: [
                      {
                        index: 0,
                        output: {
                          results: [{ url: 'https://www.deepseek.com/index', title: 'DeepSeek Index' }],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
          { data: { choices: [{ delta: { content: 'Done 2' } }] } },
          { data: '[DONE]' },
        ])
      );
    vi.stubGlobal('fetch', fetchMock);

    const deepseek = makeProvider({
      id: 'ds',
      kind: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-ds-key',
    });
    const flashModel = makeModel(deepseek, 'deepseek-flash');

    const res1 = await sendOpenAiCompatibleChat({
      provider: deepseek,
      modelId: 'deepseek-flash',
      model: flashModel,
      messages: [userMsg('q1')],
      reasoningEffort: 'default',
      webSearch: { enabled: true, searchContextSize: 'medium' },
    });
    expect(res1.toolActivity).toHaveLength(1);
    expect(res1.toolActivity?.[0]).toMatchObject({
      id: 'ds_ws_1',
      toolName: 'web_search',
    });
    expect(res1.citations?.[0]?.url).toBe('https://www.deepseek.com/v4');

    const res2 = await sendOpenAiCompatibleChat({
      provider: deepseek,
      modelId: 'deepseek-flash',
      model: flashModel,
      messages: [userMsg('q2')],
      reasoningEffort: 'default',
      webSearch: { enabled: true, searchContextSize: 'medium' },
    });
    expect(res2.toolActivity).toHaveLength(1);
    expect(res2.citations?.[0]?.url).toBe('https://www.deepseek.com/index');
  });

  it('enforces Web fail-closed defense-in-depth on direct sendOpenAiResponsesChat while preserving controlled dev proxy forwarding', async () => {
    const { sendOpenAiResponsesChat } = await import('../src/services/openAiResponses');
    const provider = makeProvider({
      id: 'openai',
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-prod-web-leak-test',
    });

    platform.OS = 'web';
    const spyFetch = vi.fn();

    // 1) Web 生产态（__DEV__ 为 false）直接调用，即使传入自定义 fetchImpl 也必须 fail-closed 拦截且零外发
    vi.stubGlobal('__DEV__', false);
    vi.stubEnv('EXPO_PUBLIC_ENABLE_WEB_DEV_PROXY', '1');
    vi.stubGlobal('window', { location: { protocol: 'http:', hostname: '127.0.0.1' } });
    await expect(
      sendOpenAiResponsesChat({
        provider,
        modelId: 'gpt-5.4',
        messages: [userMsg('Hello')],
        fetchImpl: spyFetch as unknown as typeof fetch,
      })
    ).rejects.toThrow(/正式 Web 构建不会发送 API Key/);
    expect(spyFetch).not.toHaveBeenCalled();

    // 2) __DEV__ = true 但处于非回环公网域名，同样必须拦截且零外发
    vi.stubGlobal('__DEV__', true);
    vi.stubGlobal('window', {
      location: { protocol: 'https:', hostname: 'app.embezzle-studio.example' },
    });
    await expect(
      sendOpenAiResponsesChat({
        provider,
        modelId: 'gpt-5.4',
        messages: [userMsg('Hello')],
        fetchImpl: spyFetch as unknown as typeof fetch,
      })
    ).rejects.toThrow(/正式 Web 构建不会发送 API Key/);
    expect(spyFetch).not.toHaveBeenCalled();

    // 3) 受控本机调试代理允许时，单层转发至 http://127.0.0.1:8787/proxy（非双重包装）
    vi.stubGlobal('window', { location: { protocol: 'http:', hostname: '127.0.0.1' } });
    const proxyFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('http://127.0.0.1:8787/proxy');
      const envelope = JSON.parse(String(init?.body)) as {
        url: string;
        method: string;
        headers: Record<string, string>;
        body: string;
      };
      expect(envelope.url).toBe('https://api.openai.com/v1/responses');
      expect(envelope.headers.Authorization).toBe('Bearer sk-prod-web-leak-test');
      const innerBody = JSON.parse(envelope.body) as { model: string };
      expect(innerBody.model).toBe('gpt-5.4');
      return new Response(
        JSON.stringify({
          id: 'resp_web_proxy',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Via dev proxy OK' }],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const directViaProxy = await sendOpenAiResponsesChat({
      provider,
      modelId: 'gpt-5.4',
      messages: [userMsg('Hello')],
      fetchImpl: proxyFetch as unknown as typeof fetch,
    });
    expect(directViaProxy.content).toBe('Via dev proxy OK');
    expect(proxyFetch).toHaveBeenCalledTimes(1);
  });
});
