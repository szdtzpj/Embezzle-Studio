import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ChatMessage,
  MediaAttachment,
  ProviderProfile,
  StreamChatCallbacks,
} from '../src/domain/types';
import type { ProviderAdapter } from '../src/features/chat/orchestration/ProviderAdapterRegistry';
import {
  buildGeminiGenerationConfig,
  buildGeminiNativeHeaders,
  buildGeminiNativeRequest,
  cleanGeminiModelId,
  createGeminiNativeProviderAdapter,
  GeminiNativeProtocolError,
  GeminiNativeProviderAdapter,
  getGeminiNativeEndpoint,
  parseGeminiGenerateContentResponse,
  sendGeminiNativeChat,
} from '../src/services/geminiNative';
import { parseSearchToolDetail } from '../src/services/messageActivity';
import { createModelInfoFromId } from '../src/services/modelCapabilities';
import { isAbortError } from '../src/services/openAiCompatible';

const platform = vi.hoisted(() => ({ OS: 'android' }));
vi.mock('react-native', () => ({ Platform: platform }));

function geminiProvider(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'gemini',
    name: 'Google Gemini',
    kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: 'AIza-secret-gemini-key',
    capabilities: [
      'text',
      'image-input',
      'video-input',
      'file-input',
      'reasoning',
      'web-search',
      'tool-calling',
      'streaming',
    ],
    models: [],
    ...overrides,
  };
}

function makeMessage(
  id: string,
  role: ChatMessage['role'],
  content: string,
  extra: Partial<ChatMessage> = {}
): ChatMessage {
  return {
    id,
    role,
    content,
    createdAt: 1,
    status: 'ready',
    ...extra,
  };
}

function makeByteSplitStream(fullText: string, chunkSizes: number[]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(fullText);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let offset = 0;
      let idx = 0;
      while (offset < bytes.length) {
        const size = chunkSizes[idx % chunkSizes.length] ?? 9;
        controller.enqueue(bytes.slice(offset, offset + size));
        offset += size;
        idx += 1;
      }
      controller.close();
    },
  });
}

afterEach(() => {
  platform.OS = 'android';
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Gemini endpoint, model id cleaning, and header auth', () => {
  it('normalizes official Gemini base URLs and custom relays without appending ?key= in URL', () => {
    expect(cleanGeminiModelId('models/gemini-2.5-pro')).toBe('gemini-2.5-pro');

    expect(
      getGeminiNativeEndpoint(
        { kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com' },
        'gemini-3.1-pro',
        true
      )
    ).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro:streamGenerateContent?alt=sse');

    expect(
      getGeminiNativeEndpoint(
        { kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions' },
        'models/gemini-2.5-flash',
        false
      )
    ).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');

    expect(
      getGeminiNativeEndpoint(
        { kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1' },
        'gemini-2.5-pro',
        false
      )
    ).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent');

    expect(
      getGeminiNativeEndpoint(
        { kind: 'custom', baseUrl: 'https://proxy.example.com/gemini' },
        'gemini-2.5-flash',
        true
      )
    ).toBe('https://proxy.example.com/gemini/models/gemini-2.5-flash:streamGenerateContent?alt=sse');

    const endpoint = getGeminiNativeEndpoint(geminiProvider(), 'gemini-3.8-flash:preview', true);
    expect(endpoint).not.toContain('key=');
    expect(endpoint).not.toContain('AIza-secret-gemini-key');
    expect(endpoint).toContain('gemini-3.8-flash%3Apreview');
  });

  it('rejects credentials, query, hash, and non-loopback plain http URLs', () => {
    expect(() =>
      getGeminiNativeEndpoint({ kind: 'gemini', baseUrl: 'https://user:pass@generativelanguage.googleapis.com' }, 'gemini-2.5-pro')
    ).toThrow(/用户名或密码/);
    expect(() =>
      getGeminiNativeEndpoint({ kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta?key=leak' }, 'gemini-2.5-pro')
    ).toThrow(/查询参数或片段/);
    expect(() =>
      getGeminiNativeEndpoint({ kind: 'custom', baseUrl: 'http://remote.example.com/v1beta' }, 'gemini-2.5-pro')
    ).toThrow(/HTTPS/);
  });

  it('sends API key via x-goog-api-key header and applies safe customHeaders', () => {
    const headers = buildGeminiNativeHeaders(
      geminiProvider({
        customHeaders: [
          { key: 'x-client-tag', value: 'studio-mobile' },
          { key: 'Host', value: 'evil.example' },
          { key: 'x-bad', value: 'bad\r\nheader' },
        ],
      })
    );

    expect(headers['x-goog-api-key']).toBe('AIza-secret-gemini-key');
    expect(headers.Authorization).toBeUndefined();
    expect(headers['x-client-tag']).toBe('studio-mobile');
    expect(headers.Host).toBeUndefined();
    expect(headers['x-bad']).toBeUndefined();
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Accept).toBe('text/event-stream, application/json');
  });
});

describe('Gemini Web dev-proxy boundary', () => {
  it('fails closed on Web production and routes through dev-proxy when enabled', async () => {
    platform.OS = 'web';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('EXPO_PUBLIC_ENABLE_WEB_DEV_PROXY', '0');

    await expect(
      sendGeminiNativeChat({
        provider: geminiProvider(),
        modelId: 'gemini-2.5-flash',
        messages: [makeMessage('u1', 'user', 'Hello')],
        stream: false,
      })
    ).rejects.toThrow(/正式 Web 构建不会发送/);
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubGlobal('__DEV__', true);
    vi.stubEnv('EXPO_PUBLIC_ENABLE_WEB_DEV_PROXY', '1');
    vi.stubGlobal('window', {
      location: { protocol: 'http:', hostname: 'localhost' },
    });
    const proxyFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'Web proxy OK' }] }, finishReason: 'STOP' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', proxyFetch);

    const res = await sendGeminiNativeChat({
      provider: geminiProvider(),
      modelId: 'gemini-2.5-flash',
      messages: [makeMessage('u1', 'user', 'Hello')],
      stream: false,
    });
    expect(res.content).toBe('Web proxy OK');

    const [calledUrl, calledInit] = proxyFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('http://127.0.0.1:8787/proxy');
    const payload = JSON.parse(String(calledInit.body)) as {
      url: string;
      headers: Record<string, string>;
    };
    expect(payload.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect(payload.headers['x-goog-api-key']).toBe('AIza-secret-gemini-key');
  });
});

describe('Gemini request mapping, multimodal attachments, and thinkingConfig compatibility', () => {
  it('maps systemInstruction, inlineData, and public https fileData while rejecting unsafe or oversized attachments', async () => {
    const provider = geminiProvider();
    const req = await buildGeminiNativeRequest({
      provider,
      modelId: 'gemini-2.5-flash',
      messages: [
        makeMessage('s1', 'system', 'System prompt 1'),
        makeMessage('s2', 'system', 'System prompt 2'),
        makeMessage('u1', 'user', 'Analyze image and pdf.', {
          attachments: [
            {
              id: 'img1',
              kind: 'image',
              uri: 'data:image/jpg;base64,YWJjZA==',
              name: 'pic.jpg',
              mimeType: 'image/jpg',
            },
            {
              id: 'pdf1',
              kind: 'file',
              uri: 'https://docs.example.com/manual.pdf',
              name: 'manual.pdf',
              mimeType: 'application/pdf',
            },
          ],
        }),
      ],
      stream: false,
    });

    expect(req.body.systemInstruction).toEqual({
      parts: [{ text: 'System prompt 1\n\nSystem prompt 2' }],
    });
    expect(req.body.contents).toEqual([
      {
        role: 'user',
        parts: [
          { text: 'Analyze image and pdf.' },
          { inlineData: { mimeType: 'image/jpeg', data: 'YWJjZA==' } },
          { fileData: { mimeType: 'application/pdf', fileUri: 'https://docs.example.com/manual.pdf' } },
        ],
      },
    ]);

    // 拦截非安全本地 URL 附件
    const unsafeAtt: MediaAttachment = {
      id: 'bad-url',
      kind: 'image',
      uri: 'https://127.0.0.1/secret.png',
      name: 'secret.png',
      mimeType: 'image/png',
    };
    await expect(
      buildGeminiNativeRequest({
        provider,
        modelId: 'gemini-2.5-flash',
        messages: [makeMessage('u1', 'user', 'Check', { attachments: [unsafeAtt] })],
      })
    ).rejects.toThrow(/公网 HTTPS/);

    // 拦截非法 Base64
    await expect(
      buildGeminiNativeRequest({
        provider,
        modelId: 'gemini-2.5-flash',
        messages: [
          makeMessage('u1', 'user', 'Check', {
            attachments: [
              {
                id: 'bad-b64',
                kind: 'image',
                uri: 'data:image/png;base64,not!valid!',
                name: 'bad.png',
                mimeType: 'image/png',
              },
            ],
          }),
        ],
      })
    ).rejects.toThrow(/Base64/);
  });

  it('builds thinkingConfig cleanly without mixing thinkingLevel and thinkingBudget across 2.5 and 3.x/4.x', () => {
    const provider = geminiProvider();
    const g3 = createModelInfoFromId(provider, 'gemini-3.8-flash', 'manual');
    const g31Pro = createModelInfoFromId(provider, 'gemini-3.1-pro', 'manual');
    const g25Flash = createModelInfoFromId(provider, 'gemini-2.5-flash', 'manual');
    const g25Pro = createModelInfoFromId(provider, 'gemini-2.5-pro', 'manual');

    const cfg3High = buildGeminiGenerationConfig({
      modelId: 'gemini-3.8-flash',
      model: g3,
      reasoningEffort: 'xhigh',
    });
    expect(cfg3High.thinkingConfig).toEqual({ thinkingLevel: 'HIGH', includeThoughts: true });
    expect((cfg3High.thinkingConfig as Record<string, unknown>).thinkingBudget).toBeUndefined();

    const cfg3Off = buildGeminiGenerationConfig({
      modelId: 'gemini-3.8-flash',
      model: g3,
      reasoningEffort: 'off',
    });
    expect(cfg3Off.thinkingConfig).toEqual({ thinkingLevel: 'MINIMAL' });

    const cfg31ProOff = buildGeminiGenerationConfig({
      modelId: 'gemini-3.1-pro',
      model: g31Pro,
      reasoningEffort: 'off',
    });
    expect(cfg31ProOff.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });

    const cfg25FlashOff = buildGeminiGenerationConfig({
      modelId: 'gemini-2.5-flash',
      model: g25Flash,
      reasoningEffort: 'off',
    });
    expect(cfg25FlashOff.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect((cfg25FlashOff.thinkingConfig as Record<string, unknown>).thinkingLevel).toBeUndefined();

    const cfg25ProOff = buildGeminiGenerationConfig({
      modelId: 'gemini-2.5-pro',
      model: g25Pro,
      reasoningEffort: 'off',
    });
    // 2.5-pro 不得传 0，最低为 128
    expect(cfg25ProOff.thinkingConfig).toEqual({ thinkingBudget: 128 });

    const cfg25Medium = buildGeminiGenerationConfig({
      modelId: 'gemini-2.5-pro',
      model: g25Pro,
      reasoningEffort: 'medium',
      imageOptions: { aspectRatio: '16:9', resolution: '2k' },
    });
    expect(cfg25Medium.thinkingConfig).toEqual({ thinkingBudget: 8192, includeThoughts: true });
    expect(cfg25Medium.responseModalities).toEqual(['TEXT', 'IMAGE']);
    expect(cfg25Medium.imageConfig).toEqual({ aspectRatio: '16:9', imageSize: '2K' });
  });
});

describe('Gemini SSE streaming, thoughtSignature continuation, Grounding, and inline image output', () => {
  it('parses chunked UTF-8 SSE without [DONE], tracks thinking duration, usage, and handles residual buffer', async () => {
    const sseText = [
      'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"先分析问题。"}]}}]}\r\n\r\n',
      'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"再推导结论。"}]}}]}\r\n\r\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"最终中文答案✨","thoughtSignature":"sig_txt_1"}]},"finishReason":"STOP"}]}\r\n\r\n',
      'data: {"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":40,"thoughtsTokenCount":25,"cachedContentTokenCount":10,"totalTokenCount":165}}',
    ].join('');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(makeByteSplitStream(sseText, [4, 7, 13, 6]), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      )
    );

    const thinkingCompleteCalls: number[] = [];
    const updates: string[] = [];
    const callbacks: StreamChatCallbacks = {
      onThinkingComplete: (ms) => thinkingCompleteCalls.push(ms),
    };

    const result = await sendGeminiNativeChat({
      provider: geminiProvider(),
      modelId: 'gemini-3.1-pro',
      messages: [makeMessage('u1', 'user', '解释原因')],
      reasoningEffort: 'medium',
      callbacks,
      onStreamUpdate: (u) => updates.push(u.content),
    });

    expect(result.reasoningContent).toBe('先分析问题。再推导结论。');
    expect(result.content).toBe('最终中文答案✨');
    expect(thinkingCompleteCalls).toHaveLength(1);
    expect(result.thinkingDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      reasoningTokens: 25,
      cachedInputTokens: 10,
      totalTokens: 165,
    });
    expect(result.providerContinuations).toEqual([
      {
        provider: 'gemini',
        type: 'thought_signature',
        thoughtSignature: 'sig_txt_1',
        partRole: 'text',
      },
    ]);
    expect(updates.at(-1)).toBe('最终中文答案✨');
  });

  it('captures inline generated image + thoughtSignature and restores them losslessly on subsequent turns', async () => {
    const responsePayload = {
      candidates: [
        {
          content: {
            parts: [
              { text: 'Here is the image.', thoughtSignature: 'sig_text_turn1' },
              {
                inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' },
                thoughtSignature: 'sig_img_turn1',
              },
              {
                functionCall: { name: 'lookup', args: { id: 1 } },
                thoughtSignature: 'sig_fn_turn1',
              },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalThoughtTokens: 5 },
    };

    const generated: MediaAttachment[] = [];
    const parsed = parseGeminiGenerateContentResponse(responsePayload, {
      modelId: 'gemini-3.1-flash-image',
      callbacks: {
        onImageGenerated: (items) => generated.push(...items),
      },
    });

    expect(parsed.content).toBe('Here is the image.');
    expect(parsed.attachments).toHaveLength(1);
    expect(generated).toHaveLength(1);
    expect(parsed.attachments?.[0]?.mimeType).toBe('image/png');
    expect(parsed.attachments?.[0]?.base64).toBe('iVBORw0KGgo=');
    expect(parsed.usage?.reasoningTokens).toBe(5);

    const imgId = parsed.attachments![0].id;
    expect(parsed.providerContinuations).toEqual([
      { provider: 'gemini', type: 'thought_signature', thoughtSignature: 'sig_text_turn1', partRole: 'text' },
      {
        provider: 'gemini',
        type: 'thought_signature',
        thoughtSignature: 'sig_img_turn1',
        partRole: 'image',
        attachmentId: imgId,
      },
      {
        provider: 'gemini',
        type: 'thought_signature',
        thoughtSignature: 'sig_fn_turn1',
        partRole: 'function_call',
      },
    ]);

    // 多轮回传验证
    const nextReq = await buildGeminiNativeRequest({
      provider: geminiProvider(),
      modelId: 'gemini-3.1-flash-image',
      messages: [
        makeMessage('u1', 'user', 'Draw a cat'),
        makeMessage('a1', 'assistant', parsed.content, {
          attachments: parsed.attachments,
          providerContinuations: parsed.providerContinuations,
        }),
        makeMessage('u2', 'user', 'Make it wear a hat'),
      ],
    });

    expect(nextReq.body.contents).toEqual([
      { role: 'user', parts: [{ text: 'Draw a cat' }] },
      {
        role: 'model',
        parts: [
          { text: 'Here is the image.', thoughtSignature: 'sig_text_turn1' },
          {
            inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' },
            thoughtSignature: 'sig_img_turn1',
          },
          { text: '', thoughtSignature: 'sig_fn_turn1' },
        ],
      },
      { role: 'user', parts: [{ text: 'Make it wear a hat' }] },
    ]);
  });

  it('enables google_search tool, validates mutual exclusion, maps groundingMetadata, and filters unsafe citation URLs', async () => {
    const provider = geminiProvider();

    await expect(
      buildGeminiNativeRequest({
        provider,
        modelId: 'gemini-2.5-flash',
        messages: [makeMessage('u1', 'user', 'News')],
        webSearch: { enabled: true, searchContextSize: 'medium' },
        externalSearch: {
          enabled: true,
          maxResults: 5,
          maxToolRounds: 2,
          services: [],
        },
      })
    ).rejects.toThrow(/不能同时启用/);

    const ssePayload = [
      'data: {"candidates":[{"content":{"parts":[{"text":"Gemini 3.8 released today."}]},"groundingMetadata":{"webSearchQueries":["Gemini 3.8 release"],"groundingChunks":[{"web":{"uri":"https://blog.google/technology/ai/gemini","title":"Google Blog"}},{"web":{"uri":"http://10.0.0.1/internal","title":"Unsafe Internal"}}],"groundingSupports":[{"segment":{"startIndex":0,"endIndex":27,"text":"Gemini 3.8 released today."},"groundingChunkIndices":[0,1]}]},"finishReason":"STOP"}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(makeByteSplitStream(ssePayload, [32]), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await sendGeminiNativeChat({
      provider,
      modelId: 'gemini-2.5-flash',
      messages: [makeMessage('u1', 'user', 'Latest Gemini news')],
      webSearch: { enabled: true, searchContextSize: 'high' },
    });

    const sentBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      tools?: Array<Record<string, unknown>>;
    };
    expect(sentBody.tools).toEqual([{ google_search: {} }]);
    expect(res.webSearchTriggered).toBe(true);
    expect(res.citations).toEqual([
      {
        url: 'https://blog.google/technology/ai/gemini',
        title: 'Google Blog',
        index: 1,
        startIndex: 0,
        endIndex: 27,
        text: 'Gemini 3.8 released today.',
      },
    ]);
    const searchDetail = parseSearchToolDetail(res.toolActivity?.[0]?.content);
    expect(searchDetail.query).toBe('Gemini 3.8 release');
    expect(searchDetail.items).toHaveLength(1);
  });

  it('handles HTTP errors without leaking API key, safety blocks, MAX_TOKENS preservation, AbortSignal, and ProviderAdapter contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: 401,
              status: 'UNAUTHENTICATED',
              message: 'API key AIza-secret-gemini-key is invalid',
            },
          }),
          { status: 401 }
        )
      )
    );

    const errors: Error[] = [];
    await expect(
      sendGeminiNativeChat({
        provider: geminiProvider(),
        modelId: 'gemini-2.5-flash',
        messages: [makeMessage('u1', 'user', 'Hi')],
        callbacks: { onError: (err) => errors.push(err) },
      })
    ).rejects.toThrow(/401.*\[REDACTED\]/);
    expect(errors[0].message).not.toContain('AIza-secret-gemini-key');

    // SAFETY block with no output throws
    expect(() =>
      parseGeminiGenerateContentResponse({
        candidates: [{ finishReason: 'SAFETY' }],
      })
    ).toThrow(/SAFETY/);

    // promptFeedback.blockReason throws
    expect(() =>
      parseGeminiGenerateContentResponse({
        promptFeedback: { blockReason: 'PROHIBITED_CONTENT' },
      })
    ).toThrow(/PROHIBITED_CONTENT/);

    // HTTP 429 & 404
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'Quota exceeded' } }), { status: 429 })
      )
    );
    await expect(
      sendGeminiNativeChat({
        provider: geminiProvider(),
        modelId: 'gemini-2.5-flash',
        messages: [makeMessage('u1', 'user', 'Hi')],
      })
    ).rejects.toThrow(/429/);

    // Missing historical model image gracefully skipped without blocking multi-turn chat
    const reqWithMissingModelImg = await buildGeminiNativeRequest({
      provider: geminiProvider(),
      modelId: 'gemini-3.1-flash-image',
      messages: [
        makeMessage('u1', 'user', 'Draw'),
        makeMessage('a1', 'assistant', 'Done.', {
          attachments: [
            {
              id: 'missing-img',
              kind: 'image',
              uri: 'file:///missing/path/image.png',
              name: 'missing.png',
              mimeType: 'image/png',
            },
          ],
          providerContinuations: [
            {
              provider: 'gemini',
              type: 'thought_signature',
              thoughtSignature: 'sig_still_preserved',
              partRole: 'image',
              attachmentId: 'missing-img',
            },
          ],
        }),
        makeMessage('u2', 'user', 'Next turn'),
      ],
    });
    expect(reqWithMissingModelImg.body.contents[1]).toEqual({
      role: 'model',
      parts: [{ text: 'Done.', thoughtSignature: 'sig_still_preserved' }],
    });

    // MAX_TOKENS preserves partial content
    const maxTokensRes = parseGeminiGenerateContentResponse({
      candidates: [
        {
          content: { parts: [{ text: 'Partial content before limit' }] },
          finishReason: 'MAX_TOKENS',
        },
      ],
    });
    expect(maxTokensRes.content).toBe('Partial content before limit');

    // Empty stream fails cleanly
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(makeByteSplitStream('data: [DONE]\n\n', [64]), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      )
    );
    await expect(
      sendGeminiNativeChat({
        provider: geminiProvider(),
        modelId: 'gemini-2.5-flash',
        messages: [makeMessage('u1', 'user', 'Hi')],
      })
    ).rejects.toThrow(/未返回有效/);

    // AbortSignal
    const controller = new AbortController();
    controller.abort();
    try {
      await sendGeminiNativeChat({
        provider: geminiProvider(),
        modelId: 'gemini-2.5-flash',
        messages: [makeMessage('u1', 'user', 'Hi')],
        signal: controller.signal,
      });
      throw new Error('Expected AbortError');
    } catch (error) {
      expect(isAbortError(error)).toBe(true);
    }

    // ProviderAdapter contract
    const adapter: ProviderAdapter = createGeminiNativeProviderAdapter();
    expect(adapter).toBeInstanceOf(GeminiNativeProviderAdapter);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'Adapter Gemini OK' }] }, finishReason: 'STOP' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    );
    const adapterRes = await adapter.run({
      provider: geminiProvider(),
      modelId: 'gemini-2.5-flash',
      messages: [makeMessage('u1', 'user', 'Hi')],
      reasoningEffort: 'off',
    });
    expect(adapterRes.content).toBe('Adapter Gemini OK');

    await expect(
      adapter.queryTask({
        provider: geminiProvider(),
        task: {
          providerId: 'gemini',
          modelId: 'gemini-2.5-flash',
          taskId: 't1',
          kind: 'video',
        },
      })
    ).rejects.toBeInstanceOf(GeminiNativeProtocolError);
  });

  it('triggers TimeoutError when request exceeds configured timeoutMs', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          },
          { once: true }
        );
      });
    });

    await expect(
      sendGeminiNativeChat({
        provider: geminiProvider(),
        modelId: 'gemini-2.5-flash',
        messages: [makeMessage('u1', 'user', 'Slow')],
        timeoutMs: 25,
        fetchImpl: fetchMock as unknown as typeof fetch,
      })
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});

describe('Gemini M1.2 regression fixes', () => {
  it('redacts apiKey in HTTP 200 SSE error chunks and HTTP 200 non-streaming JSON error payloads', async () => {
    const secretKey = 'AIzaSySUPERSECRETGEMINIKEY987654';
    const provider = geminiProvider({ apiKey: secretKey });

    // 1. HTTP 200 SSE 流式 error 事件脱敏
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          makeByteSplitStream(
            `data: {"error":{"code":400,"status":"INVALID_ARGUMENT","message":"API key ${secretKey} expired"}}\n\n`,
            [32]
          ),
          { status: 200, headers: { 'content-type': 'text/event-stream' } }
        )
      )
    );

    const sseErrors: Error[] = [];
    let caughtSseError: unknown;
    try {
      await sendGeminiNativeChat({
        provider,
        modelId: 'gemini-2.5-flash',
        messages: [makeMessage('u1', 'user', 'Hi')],
        callbacks: { onError: (err) => sseErrors.push(err) },
      });
    } catch (error) {
      caughtSseError = error;
    }
    expect(caughtSseError).toBeInstanceOf(GeminiNativeProtocolError);
    expect((caughtSseError as Error).message).toContain('[REDACTED]');
    expect((caughtSseError as Error).message).not.toContain(secretKey);
    expect(sseErrors).toHaveLength(1);
    expect(sseErrors[0].message).toContain('[REDACTED]');
    expect(sseErrors[0].message).not.toContain(secretKey);

    // 2. HTTP 200 非流式 JSON 内嵌 error 脱敏
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: 400,
              status: 'INVALID_ARGUMENT',
              message: `Invalid key ${secretKey}`,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    );

    const jsonErrors: Error[] = [];
    let caughtJsonError: unknown;
    try {
      await sendGeminiNativeChat({
        provider,
        modelId: 'gemini-2.5-flash',
        messages: [makeMessage('u1', 'user', 'Hi')],
        stream: false,
        callbacks: { onError: (err) => jsonErrors.push(err) },
      });
    } catch (error) {
      caughtJsonError = error;
    }
    expect(caughtJsonError).toBeInstanceOf(GeminiNativeProtocolError);
    expect((caughtJsonError as Error).message).toContain('[REDACTED]');
    expect((caughtJsonError as Error).message).not.toContain(secretKey);
    expect(jsonErrors).toHaveLength(1);
    expect(jsonErrors[0].message).toContain('[REDACTED]');
    expect(jsonErrors[0].message).not.toContain(secretKey);

    // 3. parseGeminiGenerateContentResponse 直接调用传入 apiKey 脱敏
    expect(() =>
      parseGeminiGenerateContentResponse(
        { error: { code: 403, status: 'PERMISSION_DENIED', message: `Blocked ${secretKey}` } },
        { apiKey: secretKey }
      )
    ).toThrow(/\[REDACTED\]/);
  });

  it('preserves multi-line data: and event separators when CRLF is split across SSE chunks', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunks = [
          // 在多行 data: 的 \r 与 \n 之间切分
          'data: {"candidates":[{"content":\r',
          '\ndata: {"parts":[{"text":"Gemini CRLF OK","thoughtSignature":"sig_crlf_1"}]},\r',
          '\ndata: "finishReason":"STOP"}]}\r',
          '\n\r\n',
          'data: [DONE]\r\n\r',
          '\n',
        ];
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      )
    );

    const result = await sendGeminiNativeChat({
      provider: geminiProvider(),
      modelId: 'gemini-2.5-flash',
      messages: [makeMessage('u1', 'user', 'Split CRLF')],
    });

    expect(result.content).toBe('Gemini CRLF OK');
    expect(result.providerContinuations).toEqual([
      {
        provider: 'gemini',
        type: 'thought_signature',
        thoughtSignature: 'sig_crlf_1',
        partRole: 'text',
      },
    ]);
  });

  it('supports hyphenated gemini-2-5-pro and gemini-2-5-flash naming in thinkingConfig', () => {
    const provider = geminiProvider();

    const proOff = buildGeminiGenerationConfig({
      modelId: 'gemini-2-5-pro',
      model: createModelInfoFromId(provider, 'gemini-2-5-pro', 'manual'),
      reasoningEffort: 'off',
    });
    expect(proOff.thinkingConfig).toEqual({ thinkingBudget: 128 });

    const proHigh = buildGeminiGenerationConfig({
      modelId: 'gemini-2-5-pro',
      model: createModelInfoFromId(provider, 'gemini-2-5-pro', 'manual'),
      reasoningEffort: 'high',
    });
    expect(proHigh.thinkingConfig).toEqual({ thinkingBudget: 16384, includeThoughts: true });

    const flashOff = buildGeminiGenerationConfig({
      modelId: 'gemini-2-5-flash',
      model: createModelInfoFromId(provider, 'gemini-2-5-flash', 'manual'),
      reasoningEffort: 'off',
    });
    expect(flashOff.thinkingConfig).toEqual({ thinkingBudget: 0 });

    const flashMedium = buildGeminiGenerationConfig({
      modelId: 'gemini-2-5-flash',
      model: createModelInfoFromId(provider, 'gemini-2-5-flash', 'manual'),
      reasoningEffort: 'medium',
    });
    expect(flashMedium.thinkingConfig).toEqual({ thinkingBudget: 8192, includeThoughts: true });
  });

  it('sanitizes apiKey when parseGeminiGenerateContentResponse receives malformed non-JSON text', () => {
    const secretKey = 'AIza-secret-parse-9999';
    const onError = vi.fn();
    let capturedError: unknown;
    try {
      parseGeminiGenerateContentResponse(`sk-err ${secretKey} invalid`, {
        apiKey: secretKey,
        callbacks: { onError },
      });
    } catch (error) {
      capturedError = error;
    }
    expect(capturedError).toBeInstanceOf(GeminiNativeProtocolError);
    expect((capturedError as Error).message).toContain('JSON 解析失败');
    expect((capturedError as Error).message).not.toContain(secretKey);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
