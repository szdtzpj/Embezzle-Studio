import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage, ModelInfo, ProviderProfile } from '../src/domain/types';
import {
  buildXaiGrokChatCompletionsRequest,
  buildXaiGrokResponsesRequest,
  createXaiGrokProviderAdapter,
  getXaiGrokResponsesEndpoint,
  isXaiMediaGenerationModel,
  isXaiReasoningModel,
  mergeXaiCitations,
  resolveXaiReasoningEffort,
  sendXaiGrokChat,
  XaiGrokProtocolError,
  XaiGrokProviderAdapter,
} from '../src/services/xaiGrok';
import { isWeakSearchTitle } from '../src/services/externalSearch';

const platform = vi.hoisted(() => ({ OS: 'android' }));

vi.mock('react-native', () => ({ Platform: platform }));

function xaiProvider(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'xai-grok',
    name: 'xAI Grok',
    kind: 'xai-grok',
    baseUrl: 'https://api.x.ai/v1',
    apiKey: 'xai-secret-key-999',
    capabilities: ['text', 'reasoning', 'web-search', 'streaming'],
    models: [],
    ...overrides,
  };
}

function message(id: string, role: ChatMessage['role'], content: string): ChatMessage {
  return {
    id,
    role,
    content,
    createdAt: 1,
    status: 'ready',
  };
}

function sseResponse(chunks: string[], status = 200) {
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
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

afterEach(() => {
  platform.OS = 'android';
  delete process.env.EXPO_PUBLIC_ENABLE_WEB_DEV_PROXY;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('xAI Grok model classification and request building', () => {
  it('identifies reasoning models and rejects grok-imagine-* media models from text chat', () => {
    expect(isXaiMediaGenerationModel('grok-imagine-image-2.0')).toBe(true);
    expect(isXaiMediaGenerationModel('grok-imagine-video-1.5')).toBe(true);
    expect(isXaiReasoningModel('grok-4.7')).toBe(true);
    expect(isXaiReasoningModel('grok-4.3')).toBe(true);
    expect(isXaiReasoningModel('grok-3-mini')).toBe(true);
    expect(isXaiReasoningModel('grok-imagine-image-2.0')).toBe(false);

    expect(resolveXaiReasoningEffort('grok-4.7', 'xhigh')).toBe('xhigh');
    expect(resolveXaiReasoningEffort('grok-4.7', 'max')).toBe('xhigh');
    expect(resolveXaiReasoningEffort('grok-4.3', 'xhigh')).toBe('high');
    expect(resolveXaiReasoningEffort('grok-3-mini', 'minimal')).toBe('low');
    expect(resolveXaiReasoningEffort('grok-4.5', 'off')).toBeUndefined();

    expect(() =>
      buildXaiGrokResponsesRequest({
        provider: xaiProvider(),
        modelId: 'grok-imagine-image-2.0',
        messages: [message('u1', 'user', 'draw')],
      })
    ).toThrow(/生图或视频/);
  });

  it('builds /v1/responses request with top-level reasoning_effort, web_search + x_search, and never search_parameters', () => {
    const req = buildXaiGrokResponsesRequest({
      provider: xaiProvider(),
      modelId: 'grok-4.7',
      messages: [message('u1', 'user', 'Latest SpaceX news')],
      reasoningEffort: 'xhigh',
      conversationId: 'conv-xai-1',
      webSearch: { enabled: true },
    });

    expect(getXaiGrokResponsesEndpoint(xaiProvider())).toBe('https://api.x.ai/v1/responses');
    expect(req.url).toBe('https://api.x.ai/v1/responses');
    expect(req.body.store).toBe(false);
    expect(req.body.stream).toBe(true);
    expect(req.body.reasoning_effort).toBe('xhigh');
    expect(req.body.include).toEqual(['reasoning.encrypted_content']);
    expect(req.body.tools).toEqual([{ type: 'web_search' }, { type: 'x_search' }]);
    expect(req.body.prompt_cache_key).toBe('conv-xai-1');
    expect(JSON.stringify(req.body)).not.toContain('search_parameters');
  });

  it('forwards encrypted reasoning continuation blocks on multi-turn requests', () => {
    const req = buildXaiGrokResponsesRequest({
      provider: xaiProvider(),
      modelId: 'grok-4.3',
      messages: [
        message('u1', 'user', 'Turn 1'),
        {
          ...message('a1', 'assistant', 'Answer 1'),
          providerContinuations: [
            {
              provider: 'xai',
              type: 'reasoning_encrypted',
              id: 'rs_xai_1',
              encryptedContent: 'enc_xai_opaque',
              summary: ['Checked X posts'],
            },
          ],
        },
        message('u2', 'user', 'Turn 2'),
      ],
    });

    expect(req.body.input).toHaveLength(4);
    expect(req.body.input[1]).toEqual({
      type: 'reasoning',
      id: 'rs_xai_1',
      encrypted_content: 'enc_xai_opaque',
      summary: [{ type: 'summary_text', text: 'Checked X posts' }],
    });
  });

  it('builds /v1/chat/completions fallback with x-grok-conv-id and no search_parameters', () => {
    const req = buildXaiGrokChatCompletionsRequest({
      provider: xaiProvider({ kind: 'new-api-relay', baseUrl: 'https://relay.example.com/v1' }),
      modelId: 'grok-3-mini',
      messages: [message('u1', 'user', 'Hi')],
      reasoningEffort: 'high',
      conversationId: 'conv-relay-1',
    });

    expect(req.url).toBe('https://relay.example.com/v1/chat/completions');
    expect(req.headers['x-grok-conv-id']).toBe('conv-relay-1');
    expect(req.body.reasoning_effort).toBe('high');
    expect(JSON.stringify(req.body)).not.toContain('search_parameters');
  });
});

describe('xAI Grok streaming, citation enrichment, fallback, and error boundaries', () => {
  it('streams /v1/responses without [DONE], extracts xai encrypted blocks, and enriches weak citation titles', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return sseResponse([
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_xai_1","status":"in_progress"}}\n\n',
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"xs_1","type":"x_search_call","status":"in_progress"}}\n\n',
        'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"id":"xs_1","type":"x_search_call","status":"completed","action":{"query":"SpaceX Starship"}}}\n\n',
        'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"id":"rs_x1","type":"reasoning","encrypted_content":"enc_xai_round1"}}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Starship launched [[1]](https://www.spacex.com/launches/starship-flight-10)."}\n\n',
        'event: response.output_text.annotation.added\ndata: {"type":"response.output_text.annotation.added","annotation":{"type":"url_citation","url":"https://www.spacex.com/launches/starship-flight-10","title":"1","start_index":0,"end_index":8}}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_xai_1","status":"completed","citations":["https://x.ai/news/grok-4-7","http://127.0.0.1/private"],"output":[]}}\n\n',
      ]);
    };

    const onContinuationBlocks = vi.fn();
    const result = await sendXaiGrokChat(
      {
        provider: xaiProvider(),
        modelId: 'grok-4.7',
        messages: [message('u1', 'user', 'Starship?')],
        reasoningEffort: 'xhigh',
        webSearch: { enabled: true },
        fetchImpl,
      },
      { onContinuationBlocks }
    );

    expect(calls[0]?.url).toBe('https://api.x.ai/v1/responses');
    expect(result.webSearchTriggered).toBe(true);
    expect(result.providerContinuations).toEqual([
      {
        provider: 'xai',
        type: 'reasoning_encrypted',
        id: 'rs_x1',
        encryptedContent: 'enc_xai_round1',
      },
    ]);
    expect(onContinuationBlocks).toHaveBeenCalled();

    const urls = result.citations?.map((c) => c.url) ?? [];
    expect(urls).toEqual([
      'https://www.spacex.com/launches/starship-flight-10',
      'https://x.ai/news/grok-4-7',
    ]);
    const spacexCitation = result.citations?.[0];
    expect(spacexCitation?.title).not.toBe('1');
    expect(isWeakSearchTitle(spacexCitation?.title ?? '', spacexCitation?.url ?? '')).toBe(false);
  });

  it('merges top-level citations, annotations, and inline markdown links while dropping unsafe URLs', () => {
    const merged = mergeXaiCitations({
      rawPayload: {
        citations: ['https://example.com/top-level', 'https://192.168.1.1/lan'],
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'Answer',
                annotations: [
                  {
                    type: 'url_citation',
                    url: 'https://example.com/annotated-page',
                    title: '[2]',
                    start_index: 0,
                    end_index: 6,
                  },
                ],
              },
            ],
          },
        ],
      },
      content: 'See [[3]](https://docs.x.ai/docs/guides/live-search)',
    });

    expect(merged.map((c) => c.url)).toEqual([
      'https://example.com/top-level',
      'https://example.com/annotated-page',
      'https://docs.x.ai/docs/guides/live-search',
    ]);
    expect(merged[1]?.title).toBe('annotated page');
  });

  it('falls back to /v1/chat/completions on relay or 404/405 and streams grok-3-mini reasoning_content', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/responses')) {
        return new Response('Not Found', { status: 404 });
      }
      return sseResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"Step by step"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Final reply"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}\n\n',
        'data: [DONE]\n\n',
      ]);
    };

    const result = await sendXaiGrokChat({
      provider: xaiProvider(),
      modelId: 'grok-3-mini',
      messages: [message('u1', 'user', 'Reason this')],
      reasoningEffort: 'medium',
      conversationId: 'conv-3mini',
      fetchImpl,
    });

    expect(calls).toEqual([
      'https://api.x.ai/v1/responses',
      'https://api.x.ai/v1/chat/completions',
    ]);
    expect(result.reasoningContent).toBe('Step by step');
    expect(result.content).toBe('Final reply');
    expect(result.usage?.totalTokens).toBe(8);
  });

  it('surfaces 410/401/429 errors without leaking API key', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          error: 'Gone: xai-secret-key-999 rejected',
          code: 'GONE',
        }),
        { status: 410 }
      );

    let capturedError: unknown;
    try {
      await sendXaiGrokChat({
        provider: xaiProvider(),
        modelId: 'grok-4.3',
        messages: [message('u1', 'user', 'hello')],
        fetchImpl,
      });
    } catch (error) {
      capturedError = error;
    }

    expect(capturedError).toBeInstanceOf(XaiGrokProtocolError);
    expect((capturedError as Error).message).toContain('410');
    expect((capturedError as Error).message).not.toContain('xai-secret-key-999');
  });

  it('fails closed on production web builds and forwards through dev proxy when explicitly enabled', async () => {
    platform.OS = 'web';
    const fetchSpy = vi.fn(async () => sseResponse([]));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      sendXaiGrokChat({
        provider: xaiProvider(),
        modelId: 'grok-4.3',
        messages: [message('u1', 'user', 'web test')],
      })
    ).rejects.toThrow(/正式 Web 构建不会发送/);
    expect(fetchSpy).not.toHaveBeenCalled();

    process.env.EXPO_PUBLIC_ENABLE_WEB_DEV_PROXY = '1';
    vi.stubGlobal('__DEV__', true);
    vi.stubGlobal('window', { location: { protocol: 'http:', hostname: '127.0.0.1' } });
    const proxySpy = vi.fn(async () =>
      sseResponse([
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Proxied OK"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
      ])
    );
    vi.stubGlobal('fetch', proxySpy);

    const res = await sendXaiGrokChat({
      provider: xaiProvider(),
      modelId: 'grok-4.3',
      messages: [message('u1', 'user', 'web proxy test')],
    });
    expect(proxySpy).toHaveBeenCalledTimes(1);
    expect(String((proxySpy.mock.calls[0] as unknown[])[0])).toBe('http://127.0.0.1:8787/proxy');
    expect(res.content).toBe('Proxied OK');
  });

  it('implements ProviderAdapter via XaiGrokProviderAdapter and rejects queryTask', async () => {
    const adapter = createXaiGrokProviderAdapter({
      fetchImpl: async () =>
        sseResponse([
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Adapter OK"}\n\n',
          'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
        ]),
    });
    expect(adapter).toBeInstanceOf(XaiGrokProviderAdapter);

    const updates: string[] = [];
    const model: ModelInfo = {
      id: 'grok-4.3',
      name: 'Grok 4.3',
      capabilities: ['text', 'web-search', 'streaming'],
      source: 'preset',
    };
    const result = await adapter.run({
      provider: xaiProvider(),
      modelId: 'grok-4.3',
      model,
      messages: [message('u1', 'user', 'Adapter test')],
      reasoningEffort: 'medium',
      webSearch: { enabled: true, searchContextSize: 'medium' },
      onStreamUpdate: (update) => updates.push(update.content),
    });

    expect(result.content).toBe('Adapter OK');
    expect(updates).toContain('Adapter OK');
    await expect(
      adapter.queryTask({
        provider: xaiProvider(),
        task: { providerId: 'xai-grok', modelId: 'grok-4.3', taskId: 't1', kind: 'video' },
      })
    ).rejects.toThrow(/不支持异步视频/);
  });

  it('redacts apiKey across >260 char HTTP boundary, SSE error events, and network throws with single onError call', async () => {
    const secretKey = 'xai-secret-KEY-9876543210-LEAKCHECK';
    const provider = xaiProvider({ apiKey: secretKey });
    const padded = 'A'.repeat(245);

    const onErrorHttp = vi.fn();
    await expect(
      sendXaiGrokChat(
        {
          provider,
          modelId: 'grok-4.3',
          messages: [message('u1', 'user', 'hi')],
          fetchImpl: async () => new Response(`${padded} ${secretKey}`, { status: 401 }),
        },
        { onError: onErrorHttp }
      )
    ).rejects.toSatisfy((err: Error) => !err.message.includes('xai-secret-KEY'));
    expect(onErrorHttp).toHaveBeenCalledTimes(1);

    const onErrorSse = vi.fn();
    await expect(
      sendXaiGrokChat(
        {
          provider,
          modelId: 'grok-4.3',
          messages: [message('u1', 'user', 'hi')],
          fetchImpl: async () =>
            sseResponse([
              `event: error\ndata: {"error":{"message":"bad key ${secretKey}"}}\n\n`,
            ]),
        },
        { onError: onErrorSse }
      )
    ).rejects.toSatisfy((err: Error) => !err.message.includes(secretKey));
    expect(onErrorSse).toHaveBeenCalledTimes(1);

    const onErrorNet = vi.fn();
    await expect(
      sendXaiGrokChat(
        {
          provider,
          modelId: 'grok-4.3',
          messages: [message('u1', 'user', 'hi')],
          fetchImpl: async () => {
            throw new Error(`connect failed with key ${secretKey}`);
          },
        },
        { onError: onErrorNet }
      )
    ).rejects.toSatisfy((err: Error) => !err.message.includes(secretKey));
    expect(onErrorNet).toHaveBeenCalledTimes(1);
  });

  it('cancels 404/405/501 response body before falling back to /v1/chat/completions', async () => {
    const cancelSpy = vi.fn(async () => undefined);
    const fake404Response = {
      status: 404,
      ok: false,
      headers: new Headers(),
      body: { cancel: cancelSpy } as unknown as ReadableStream<Uint8Array>,
    } as Response;

    const result = await sendXaiGrokChat({
      provider: xaiProvider(),
      modelId: 'grok-3-mini',
      messages: [message('u1', 'user', 'hi')],
      fetchImpl: async (input) => {
        if (String(input).endsWith('/responses')) {
          return fake404Response;
        }
        return sseResponse([
          'data: {"choices":[{"delta":{"content":"Fallback OK"}}]}\n\n',
          'data: [DONE]\n\n',
        ]);
      },
    });
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(result.content).toBe('Fallback OK');
  });

  it('beautifies root URL weak titles without trailing slash and drops out-of-bounds end_index', () => {
    const merged = mergeXaiCitations({
      rawPayload: {
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'Short text',
                annotations: [
                  {
                    type: 'url_citation',
                    url: 'https://example.com',
                    title: 'https://example.com',
                    start_index: 0,
                    end_index: 99999,
                  },
                ],
              },
            ],
          },
        ],
      },
      content: 'Short text',
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]?.url).toBe('https://example.com/');
    expect(merged[0]?.title).toBe('example.com');
    expect(merged[0]?.endIndex).toBeUndefined();
    expect(merged[0]?.startIndex).toBeUndefined();
  });

  it('redacts percent-encoded apiKey across HTTP 410/403 responses in both /responses and /chat/completions fallback', async () => {
    const secretKey = 'xai-key+slash/eq=42';
    const mixedEncoded = encodeURIComponent(secretKey)
      .replace(/%2B/gi, '%2b')
      .replace(/%2F/gi, '%2F')
      .replace(/%3D/gi, '%3d');
    const provider = xaiProvider({ apiKey: secretKey });

    const onErrorPrimary = vi.fn();
    await expect(
      sendXaiGrokChat(
        {
          provider,
          modelId: 'grok-4.3',
          messages: [message('u1', 'user', 'hi')],
          fetchImpl: async () =>
            new Response(`Deprecated field with key ${secretKey} and ${mixedEncoded}`, { status: 410 }),
        },
        { onError: onErrorPrimary }
      )
    ).rejects.toSatisfy((err: Error) => {
      return (
        err.message.includes('410') &&
        err.message.includes('[REDACTED]') &&
        !err.message.includes(secretKey) &&
        !err.message.includes(mixedEncoded)
      );
    });
    expect(onErrorPrimary).toHaveBeenCalledTimes(1);

    const onErrorFallback = vi.fn();
    await expect(
      sendXaiGrokChat(
        {
          provider: xaiProvider({
            kind: 'custom',
            baseUrl: 'https://relay.example.com/v1',
            apiKey: secretKey,
          }),
          modelId: 'grok-4.3',
          messages: [message('u1', 'user', 'hi')],
          fetchImpl: async () =>
            new Response(`Forbidden ${mixedEncoded} (${secretKey})`, { status: 403 }),
        },
        { onError: onErrorFallback }
      )
    ).rejects.toSatisfy((err: Error) => {
      return (
        err.message.includes('403') &&
        err.message.includes('[REDACTED]') &&
        !err.message.includes(secretKey) &&
        !err.message.includes(mixedEncoded)
      );
    });
    expect(onErrorFallback).toHaveBeenCalledTimes(1);
  });

  it('aborts hanging SSE streams immediately in both /responses and /chat/completions fallback without leaking listeners', async () => {
    const makeHangingSseResponse = () => {
      let cancelCount = 0;
      let markReadingStarted: (() => void) | undefined;
      let markCancelled: (() => void) | undefined;
      const readingStarted = new Promise<void>((resolve) => {
        markReadingStarted = resolve;
      });
      const cancelled = new Promise<void>((resolve) => {
        markCancelled = resolve;
      });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(': keep-alive\n\n'));
        },
        pull() {
          markReadingStarted?.();
        },
        cancel() {
          cancelCount += 1;
          markCancelled?.();
        },
      });
      const response = new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
      return {
        response,
        getCancelCount: () => cancelCount,
        waitUntilReading: () => readingStarted,
        waitUntilCancelled: () => cancelled,
      };
    };

    // 1) /v1/responses 挂起流
    const ctrlPrimary = new AbortController();
    let addedPrimary = 0;
    let removedPrimary = 0;
    const origAddPrimary = ctrlPrimary.signal.addEventListener.bind(ctrlPrimary.signal);
    const origRemovePrimary = ctrlPrimary.signal.removeEventListener.bind(ctrlPrimary.signal);
    vi.spyOn(ctrlPrimary.signal, 'addEventListener').mockImplementation((...args) => {
      if (args[0] === 'abort') addedPrimary += 1;
      return origAddPrimary(...args);
    });
    vi.spyOn(ctrlPrimary.signal, 'removeEventListener').mockImplementation((...args) => {
      if (args[0] === 'abort') removedPrimary += 1;
      return origRemovePrimary(...args);
    });

    const primaryHang = makeHangingSseResponse();
    const primaryPending = sendXaiGrokChat({
      provider: xaiProvider(),
      modelId: 'grok-4.3',
      messages: [message('u1', 'user', 'hi')],
      signal: ctrlPrimary.signal,
      fetchImpl: async () => primaryHang.response,
    });
    const primaryExpect = expect(primaryPending).rejects.toMatchObject({ name: 'AbortError' });
    await primaryHang.waitUntilReading();
    const t0 = Date.now();
    ctrlPrimary.abort();
    await primaryExpect;
    expect(Date.now() - t0).toBeLessThan(250);
    await primaryHang.waitUntilCancelled();
    expect(primaryHang.getCancelCount()).toBeGreaterThanOrEqual(1);
    expect(primaryHang.response.body?.locked).toBe(false);
    expect(removedPrimary).toBe(addedPrimary);

    // 2) /v1/chat/completions 降级路径挂起流
    const ctrlFallback = new AbortController();
    let addedFallback = 0;
    let removedFallback = 0;
    const origAddFallback = ctrlFallback.signal.addEventListener.bind(ctrlFallback.signal);
    const origRemoveFallback = ctrlFallback.signal.removeEventListener.bind(ctrlFallback.signal);
    vi.spyOn(ctrlFallback.signal, 'addEventListener').mockImplementation((...args) => {
      if (args[0] === 'abort') addedFallback += 1;
      return origAddFallback(...args);
    });
    vi.spyOn(ctrlFallback.signal, 'removeEventListener').mockImplementation((...args) => {
      if (args[0] === 'abort') removedFallback += 1;
      return origRemoveFallback(...args);
    });

    const fallbackHang = makeHangingSseResponse();
    const fallbackPending = sendXaiGrokChat({
      provider: xaiProvider({ kind: 'custom', baseUrl: 'https://relay.example.com/v1' }),
      modelId: 'grok-4.3',
      messages: [message('u1', 'user', 'hi')],
      signal: ctrlFallback.signal,
      fetchImpl: async () => fallbackHang.response,
    });
    const fallbackExpect = expect(fallbackPending).rejects.toMatchObject({ name: 'AbortError' });
    await fallbackHang.waitUntilReading();
    const t1 = Date.now();
    ctrlFallback.abort();
    await fallbackExpect;
    expect(Date.now() - t1).toBeLessThan(250);
    await fallbackHang.waitUntilCancelled();
    expect(fallbackHang.getCancelCount()).toBeGreaterThanOrEqual(1);
    expect(fallbackHang.response.body?.locked).toBe(false);
    expect(removedFallback).toBe(addedFallback);
  });

  it('fails closed on Web production even when custom fetchImpl is provided and aborts hanging non-200 error bodies immediately', async () => {
    platform.OS = 'web';
    const customSpy = vi.fn(async () => sseResponse([]));

    await expect(
      sendXaiGrokChat({
        provider: xaiProvider(),
        modelId: 'grok-4.3',
        messages: [message('u1', 'user', 'web custom fetch')],
        fetchImpl: customSpy,
      })
    ).rejects.toThrow(/正式 Web 构建不会发送/);
    expect(customSpy).not.toHaveBeenCalled();

    platform.OS = 'android';
    let cancelled = false;
    let markReadingStarted: (() => void) | undefined;
    let markCancelled: (() => void) | undefined;
    const readingStarted = new Promise<void>((resolve) => {
      markReadingStarted = resolve;
    });
    const streamCancelled = new Promise<void>((resolve) => {
      markCancelled = resolve;
    });
    const hanging500Stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"error":'));
      },
      pull() {
        markReadingStarted?.();
      },
      cancel() {
        cancelled = true;
        markCancelled?.();
      },
    });
    const abortCtrl = new AbortController();
    const pending = sendXaiGrokChat({
      provider: xaiProvider(),
      modelId: 'grok-4.3',
      messages: [message('u1', 'user', '500 hang')],
      signal: abortCtrl.signal,
      fetchImpl: async () => new Response(hanging500Stream, { status: 500 }),
    });
    const expectAbort = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await readingStarted;
    const t0 = Date.now();
    abortCtrl.abort();
    await expectAbort;
    expect(Date.now() - t0).toBeLessThan(200);
    await streamCancelled;
    expect(cancelled).toBe(true);
  });
});
