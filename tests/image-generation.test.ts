import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ChatMessage,
  MediaAttachment,
  ProviderProfile,
} from '../src/domain/types';
import type { ProviderAdapter, ProviderAdapterRegistry } from '../src/features/chat/orchestration/ProviderAdapterRegistry';
import { ChatRequestExecution, type ChatRequestExecutionHost } from '../src/features/chat/internal/requests/ChatRequestExecution';
import { createDefaultWorkspace } from '../src/data/providerCatalog';
import { generateImages, resolveImageApiMode } from '../src/services/imageGeneration';
import { sendGeminiNativeChat } from '../src/services/geminiNative';
import { sendOpenAiCompatibleChat } from '../src/services/openAiCompatible';
import {
  parseOpenAiResponsesResponse,
  readOpenAiResponsesStream,
  sendOpenAiResponsesChat,
} from '../src/services/openAiResponses';

const mocks = vi.hoisted(() => ({
  platform: { OS: 'android' as 'android' | 'ios' | 'web' },
  storedFiles: new Map<string, string>(),
}));

vi.mock('react-native', () => ({ Platform: mocks.platform }));
vi.mock('expo-file-system', () => {
  class MockDirectory {
    readonly uri: string;
    constructor(base: { uri?: string } | string, name?: string) {
      const prefix = typeof base === 'string' ? base : base.uri ?? 'file:///mock-docs';
      this.uri = name ? `${prefix}/${name}` : prefix;
    }
    create(): void {
      // mock directory creation
    }
  }
  class MockFile {
    readonly uri: string;
    size = 0;
    get exists(): boolean {
      return mocks.storedFiles.has(this.uri);
    }
    constructor(base: { uri?: string } | string, name?: string) {
      const prefix = typeof base === 'string' ? base : base.uri ?? 'file:///mock-docs';
      this.uri = name ? `${prefix}/${name}` : prefix;
    }
    create(): void {
      mocks.storedFiles.set(this.uri, '');
    }
    write(content: string): void {
      mocks.storedFiles.set(this.uri, content);
      this.size = Buffer.from(content, 'base64').byteLength || content.length;
    }
    async base64(): Promise<string> {
      return mocks.storedFiles.get(this.uri) ?? '';
    }
    async copy(target: MockFile): Promise<void> {
      target.write(mocks.storedFiles.get(this.uri) ?? '');
    }
    delete(): void {
      mocks.storedFiles.delete(this.uri);
    }
    static async downloadFileAsync(url: string, destination: MockFile): Promise<MockFile> {
      const resp = await fetch(url);
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const arr = new Uint8Array(await resp.arrayBuffer());
      const b64 = Buffer.from(arr).toString('base64');
      destination.write(b64);
      return destination;
    }
  }
  return {
    Directory: MockDirectory,
    File: MockFile,
    EncodingType: { Base64: 'base64' },
    Paths: {
      document: { uri: 'file:///mock-docs' },
      cache: { uri: 'file:///mock-cache' },
    },
  };
});

// 标准 1x1 像素 PNG 字节
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2S8AAAAASUVORK5CYII=';
const TINY_PNG_BYTES = Buffer.from(TINY_PNG_BASE64, 'base64');
const nativeFetch = globalThis.fetch;

function installWebFileReaderPolyfill(): void {
  if (typeof globalThis.FileReader !== 'undefined') {
    return;
  }
  class NodeFileReader {
    result: string | null = null;
    error: unknown = null;
    onloadend: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    readAsDataURL(blob: Blob): void {
      blob
        .arrayBuffer()
        .then((buf) => {
          const mime = blob.type || 'application/octet-stream';
          const b64 = Buffer.from(buf).toString('base64');
          this.result = `data:${mime};base64,${b64}`;
          this.onloadend?.({});
        })
        .catch((err) => {
          this.error = err;
          this.onerror?.(err);
        });
    }
  }
  vi.stubGlobal('FileReader', NodeFileReader);
}

function makeProvider(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test-image-key-1234',
    capabilities: ['text', 'image-generation'],
    models: [],
    ...overrides,
  };
}

function makeReferenceImage(overrides: Partial<MediaAttachment> = {}): MediaAttachment {
  return {
    id: 'ref-img-1',
    kind: 'image',
    uri: `data:image/png;base64,${TINY_PNG_BASE64}`,
    name: 'ref.png',
    mimeType: 'image/png',
    base64: TINY_PNG_BASE64,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.platform.OS = 'android';
  mocks.storedFiles.clear();
  installWebFileReaderPolyfill();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('resolveImageApiMode routing matrix', () => {
  it('resolves protocol modes across official providers, relays, and overrides', () => {
    expect(resolveImageApiMode(makeProvider({ kind: 'openai-compatible' }), 'gpt-image-2.5-sunburst')).toBe('openai-images');
    expect(resolveImageApiMode(makeProvider({ kind: 'openai-compatible' }), 'gpt-5.4')).toBe('openai-responses');
    expect(
      resolveImageApiMode(makeProvider({ kind: 'openai-compatible', imageApiMode: 'openai-responses' }), 'gpt-5.4')
    ).toBe('openai-responses');
    expect(
      resolveImageApiMode(
        makeProvider({ kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }),
        'gemini-3.1-flash-image'
      )
    ).toBe('gemini-generate-content');
    expect(
      resolveImageApiMode(
        makeProvider({ kind: 'xai-grok', baseUrl: 'https://api.x.ai/v1' }),
        'grok-imagine-image-2.0'
      )
    ).toBe('xai-json');
    expect(
      resolveImageApiMode(
        makeProvider({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' }),
        'claude-sonnet-5-5'
      )
    ).toBe('unsupported');
    expect(
      resolveImageApiMode(
        makeProvider({ kind: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' }),
        'deepseek-v4-pro'
      )
    ).toBe('unsupported');
    expect(
      resolveImageApiMode(
        makeProvider({
          kind: 'new-api-relay',
          baseUrl: 'https://relay.example.com/v1',
          imageApiMode: 'auto',
        }),
        'gemini-3.1-flash-image'
      )
    ).toBe('openai-images');
  });
});

describe('pre-flight validation and security guards', () => {
  it('rejects unsupported providers, deprecated gpt-image-1, invalid prompts, counts, and reference attachments before any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      generateImages({
        provider: makeProvider({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' }),
        modelId: 'claude-sonnet-5-5',
        prompt: 'draw a mountain',
      })
    ).rejects.toThrow(/不支持.*生图.*(?:OpenAI|Gemini|xAI)/i);

    await expect(
      generateImages({
        provider: makeProvider({ kind: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' }),
        modelId: 'deepseek-v4-pro',
        prompt: 'draw a mountain',
      })
    ).rejects.toThrow(/不支持.*生图/i);

    await expect(
      generateImages({
        provider: makeProvider(),
        modelId: 'gpt-image-1',
        prompt: 'draw a cat',
      })
    ).rejects.toThrow(/gpt-image-1.*下线/);

    await expect(
      generateImages({
        provider: makeProvider(),
        modelId: 'gpt-image-2.5-sunburst',
        prompt: '   ',
      })
    ).rejects.toThrow(/提示词|prompt/i);

    await expect(
      generateImages({
        provider: makeProvider(),
        modelId: 'gpt-image-2.5-sunburst',
        prompt: 'valid',
        options: { count: 99 },
      })
    ).rejects.toThrow(/数量|count/i);

    await expect(
      generateImages({
        provider: makeProvider(),
        modelId: 'gpt-image-2.5-sunburst',
        prompt: 'valid',
        options: { count: 0 },
      })
    ).rejects.toThrow(/数量|count/i);

    await expect(
      generateImages({
        provider: makeProvider(),
        modelId: 'gpt-image-2.5-sunburst',
        prompt: 'valid',
        options: {
          referenceImages: Array.from({ length: 11 }, (_, idx) =>
            makeReferenceImage({ id: `ref-${idx}` })
          ),
        },
      })
    ).rejects.toThrow(/上限|最多/);

    await expect(
      generateImages({
        provider: makeProvider(),
        modelId: 'gpt-image-2.5-sunburst',
        prompt: 'valid',
        options: {
          referenceImages: [
            {
              id: 'pdf-1',
              kind: 'file',
              uri: 'file:///tmp/doc.pdf',
              name: 'doc.pdf',
              mimeType: 'application/pdf',
            },
          ],
        },
      })
    ).rejects.toThrow(/图片|格式|MIME/);

    const abortController = new AbortController();
    abortController.abort();
    await expect(
      generateImages({
        provider: makeProvider(),
        modelId: 'gpt-image-2.5-sunburst',
        prompt: 'valid',
        signal: abortController.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('enforces Web production fail-closed guard and allows explicit dev proxy with IndexedDB persistence', async () => {
    mocks.platform.OS = 'web';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('EXPO_PUBLIC_ENABLE_WEB_DEV_PROXY', '0');

    await expect(
      generateImages({
        provider: makeProvider(),
        modelId: 'gpt-image-2.5-sunburst',
        prompt: 'a neon studio',
      })
    ).rejects.toThrow(/正式 Web 构建不会发送 API Key 或模型请求/);
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubGlobal('__DEV__', true);
    vi.stubEnv('EXPO_PUBLIC_ENABLE_WEB_DEV_PROXY', '1');
    vi.stubGlobal('window', { location: { protocol: 'http:', hostname: 'localhost' } });

    const proxyFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('data:')) {
        return nativeFetch(input, init);
      }
      return new Response(JSON.stringify({ data: [{ b64_json: TINY_PNG_BASE64 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', proxyFetch);

    const result = await generateImages({
      provider: makeProvider(),
      modelId: 'gpt-image-2.5-sunburst',
      prompt: 'a neon studio',
      options: { aspectRatio: '16:9', quality: 'high', count: 1 },
    });

    const networkCalls = proxyFetch.mock.calls.filter(([url]) => !String(url).startsWith('data:'));
    expect(networkCalls).toHaveLength(1);
    expect(networkCalls[0]?.[0]).toBe('http://127.0.0.1:8787/proxy');
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments?.[0]?.uri).toMatch(/^embezzle-web-attachment:\/\//);
    expect(result.attachments?.[0]?.base64).toBeNull();
  });

  it('forwards FormData multipart /v1/images/edits via controlled Web dev proxy as base64 while keeping non-proxy Web fail-closed', async () => {
    mocks.platform.OS = 'web';
    const blockedFetch = vi.fn();
    vi.stubGlobal('fetch', blockedFetch);
    vi.stubEnv('EXPO_PUBLIC_ENABLE_WEB_DEV_PROXY', '0');

    await expect(
      generateImages({
        provider: makeProvider(),
        modelId: 'gpt-image-2.5-flare',
        prompt: 'add starry sky',
        options: { referenceImages: [makeReferenceImage()] },
      })
    ).rejects.toThrow(/正式 Web 构建不会发送 API Key 或模型请求/);
    expect(blockedFetch).not.toHaveBeenCalled();

    vi.stubGlobal('__DEV__', true);
    vi.stubEnv('EXPO_PUBLIC_ENABLE_WEB_DEV_PROXY', '1');
    vi.stubGlobal('window', { location: { protocol: 'http:', hostname: '127.0.0.1' } });

    const proxyFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('data:')) {
        return nativeFetch(input, init);
      }
      return new Response(JSON.stringify({ data: [{ b64_json: TINY_PNG_BASE64 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', proxyFetch);

    const result = await generateImages({
      provider: makeProvider({
        customHeaders: [
          { key: 'Content-Type', value: 'application/json', enabled: true },
          { key: 'x-custom-trace', value: 'web-edit-1', enabled: true },
        ],
      }),
      modelId: 'gpt-image-2.5-flare',
      prompt: 'add starry sky',
      options: { referenceImages: [makeReferenceImage()] },
    });

    const networkCalls = proxyFetch.mock.calls.filter(([url]) => !String(url).startsWith('data:'));
    expect(networkCalls).toHaveLength(1);
    expect(networkCalls[0]?.[0]).toBe('http://127.0.0.1:8787/proxy');

    const proxyInit = networkCalls[0]?.[1] as RequestInit;
    const envelope = JSON.parse(String(proxyInit.body)) as {
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string;
      bodyEncoding?: string;
    };
    expect(envelope.url).toBe('https://api.openai.com/v1/images/edits');
    expect(envelope.method).toBe('POST');
    expect(envelope.bodyEncoding).toBe('base64');
    expect(envelope.headers['Content-Type']).toMatch(/^multipart\/form-data;\s*boundary=/i);
    expect(envelope.headers['content-type']).toBeUndefined();
    expect(envelope.headers['x-custom-trace']).toBe('web-edit-1');

    const decodedBuffer = Buffer.from(envelope.body, 'base64');
    const reconstructed = new Request(envelope.url, {
      method: envelope.method,
      headers: envelope.headers,
      body: decodedBuffer,
    });
    const parsedForm = (await reconstructed.formData()) as unknown as FormData;
    expect(parsedForm.get('model')).toBe('gpt-image-2.5-flare');
    expect(parsedForm.get('prompt')).toBe('add starry sky');
    const uploadedImage = parsedForm.get('image') as Blob;
    expect(uploadedImage).toBeTruthy();
    expect(Buffer.from(await uploadedImage.arrayBuffer()).equals(TINY_PNG_BYTES)).toBe(true);

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments?.[0]?.uri).toMatch(/^embezzle-web-attachment:\/\//);
    expect(result.attachments?.[0]?.base64).toBeNull();
  });
});

describe('multi-protocol image generation and editing', () => {
  it('sends OpenAI /v1/images/generations without response_format for gpt-image-* and maps aspectRatio', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ b64_json: TINY_PNG_BASE64 }, { b64_json: TINY_PNG_BASE64 }],
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const result = await generateImages({
      provider: makeProvider(),
      modelId: 'gpt-image-2.5-sunburst',
      prompt: 'sunset skyline',
      options: { aspectRatio: '16:9', quality: 'high', count: 2 },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/images/generations');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe('gpt-image-2.5-sunburst');
    expect(body.size).toBe('1536x1024');
    expect(body.n).toBe(2);
    expect(body.quality).toBe('high');
    expect(body.output_format).toBe('png');
    expect(body.response_format).toBeUndefined();
    expect(result.attachments).toHaveLength(2);
    expect(result.attachments?.[0]?.uri).toMatch(/^file:\/\//);
    expect(result.attachments?.[0]?.base64).toBeNull();
  });

  it('sends lossless multipart/form-data to OpenAI /v1/images/edits with reference images', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: TINY_PNG_BASE64 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    const result = await generateImages({
      provider: makeProvider(),
      modelId: 'gpt-image-2.5-flare',
      prompt: 'add golden reflections',
      options: { referenceImages: [makeReferenceImage()] },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/images/edits');
    expect(init.body).toBeInstanceOf(FormData);
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBeUndefined();

    const formData = init.body as FormData;
    expect(formData.get('model')).toBe('gpt-image-2.5-flare');
    expect(formData.get('prompt')).toBe('add golden reflections');
    const imageFile = formData.get('image') as Blob;
    expect(imageFile).toBeTruthy();
    const sentBytes = Buffer.from(await imageFile.arrayBuffer());
    expect(sentBytes.equals(TINY_PNG_BYTES)).toBe(true);
    expect(result.attachments).toHaveLength(1);
  });

  it('supports OpenAI Responses image_generation tool (streaming & non-streaming) and preserves revised_prompt', async () => {
    const ssePayload = [
      'event: response.output_item.done\n',
      `data: ${JSON.stringify({
        type: 'response.output_item.done',
        item: {
          id: 'ig_1',
          type: 'image_generation_call',
          status: 'completed',
          revised_prompt: 'Minimalist studio emblem in amber lighting',
          result: TINY_PNG_BASE64,
        },
      })}\n\n`,
      'event: response.completed\n',
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_img_1',
          status: 'completed',
          output: [
            {
              id: 'ig_1',
              type: 'image_generation_call',
              status: 'completed',
              revised_prompt: 'Minimalist studio emblem in amber lighting',
              result: TINY_PNG_BASE64,
            },
          ],
        },
      })}\n\n`,
    ].join('');

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(ssePayload, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    );

    const result = await generateImages({
      provider: makeProvider({ imageApiMode: 'openai-responses' }),
      modelId: 'gpt-5.4',
      prompt: 'draw an emblem',
      options: { aspectRatio: '1:1', quality: 'medium' },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/responses');
    const body = JSON.parse(String(init.body)) as { tools?: Array<Record<string, unknown>> };
    expect(body.tools?.[0]?.type).toBe('image_generation');
    expect(result.attachments).toHaveLength(1);
    expect(result.content).toContain('已通过 Responses 工具完成绘图');
    expect(result.content).toContain('Minimalist studio emblem in amber lighting');

    // 非流式 parseOpenAiResponsesResponse 纯图片响应不应抛空输出错误
    const nonStreamingParsed = parseOpenAiResponsesResponse({
      id: 'resp_nonstream_img',
      status: 'completed',
      output: [
        {
          id: 'ig_2',
          type: 'image_generation_call',
          status: 'completed',
          revised_prompt: 'Studio badge',
          result: TINY_PNG_BASE64,
        },
      ],
    });
    expect(nonStreamingParsed.attachments).toHaveLength(1);
    expect(nonStreamingParsed.attachments?.[0]?.base64).toBe(TINY_PNG_BASE64);

    // 流式去重校验
    const dedupedStream = await readOpenAiResponsesStream(
      new Response(ssePayload, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    );
    expect(dedupedStream.attachments).toHaveLength(1);
  });

  it('supports Gemini generateContent image generation and multi-turn thoughtSignature round-trip', async () => {
    const geminiProvider = makeProvider({
      id: 'gemini',
      kind: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'AIza-gemini-img-key',
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    {
                      inlineData: { mimeType: 'image/png', data: TINY_PNG_BASE64 },
                      thoughtSignature: 'gem_thought_sig_round1',
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    {
                      inlineData: { mimeType: 'image/png', data: TINY_PNG_BASE64 },
                      thoughtSignature: 'gem_thought_sig_round2',
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );

    const round1 = await generateImages({
      provider: geminiProvider,
      modelId: 'gemini-3.1-flash-image',
      prompt: 'cyberpunk alley',
      options: { aspectRatio: '16:9', resolution: '2k' },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent'
    );
    const req1Body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(req1Body.generationConfig.responseModalities).toEqual(['TEXT', 'IMAGE']);
    expect(req1Body.generationConfig.imageConfig).toEqual({
      aspectRatio: '16:9',
      imageSize: '2K',
    });
    expect(round1.providerContinuations?.[0]).toMatchObject({
      provider: 'gemini',
      type: 'thought_signature',
      thoughtSignature: 'gem_thought_sig_round1',
    });

    const round2 = await generateImages({
      provider: geminiProvider,
      modelId: 'gemini-3.1-flash-image',
      prompt: 'make it rain',
      options: { referenceImages: round1.attachments },
      continuationBlocks: round1.providerContinuations,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const req2Raw = String((fetchMock.mock.calls[1]?.[1] as RequestInit).body);
    expect(req2Raw).toContain('gem_thought_sig_round1');
    expect(req2Raw).toContain('inlineData');
    expect(round2.attachments).toHaveLength(1);
  });

  it('supports xAI JSON image generation and JSON /v1/images/edits without multipart', async () => {
    const xaiProvider = makeProvider({
      id: 'xai-grok',
      kind: 'xai-grok',
      baseUrl: 'https://api.x.ai/v1',
      apiKey: 'xai-img-key',
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ b64_json: TINY_PNG_BASE64 }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ b64_json: TINY_PNG_BASE64 }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );

    await generateImages({
      provider: xaiProvider,
      modelId: 'grok-imagine-image-2.0',
      prompt: 'aurora over fjord',
      options: { aspectRatio: '16:9' },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.x.ai/v1/images/generations');

    await generateImages({
      provider: xaiProvider,
      modelId: 'grok-imagine-image-2.0',
      prompt: 'turn aurora pink',
      options: { referenceImages: [makeReferenceImage()] },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const [editUrl, editInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(editUrl).toBe('https://api.x.ai/v1/images/edits');
    expect((editInit.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(typeof editInit.body).toBe('string');
    const editPayload = JSON.parse(String(editInit.body)) as {
      image?: { url?: string };
      model?: string;
    };
    expect(editPayload.model).toBe('grok-imagine-image-2.0');
    expect(editPayload.image?.url).toContain(TINY_PNG_BASE64);
  });

  it('supports Volcengine Ark, Alibaba Bailian, and New-API relay with customHeaders filtering', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: [{ b64_json: TINY_PNG_BASE64 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    await generateImages({
      provider: makeProvider({
        id: 'ark',
        kind: 'volcengine-ark',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      }),
      modelId: 'doubao-seedream-4-5-251128',
      prompt: 'ink wash landscape',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://ark.cn-beijing.volces.com/api/v3/images/generations'
    );

    await generateImages({
      provider: makeProvider({
        id: 'bailian',
        kind: 'bailian-compatible',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      }),
      modelId: 'qwen-image-plus',
      prompt: 'ceramic teapot',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/images/generations'
    );

    await generateImages({
      provider: makeProvider({
        id: 'relay',
        kind: 'new-api-relay',
        baseUrl: 'https://relay.example.com/v1',
        imageApiMode: 'auto',
        customHeaders: [
          { key: 'x-relay-tenant', value: 'studio-unit', enabled: true },
          { key: 'x-disabled-header', value: 'ignored', enabled: false },
          { key: 'Host', value: 'evil.example', enabled: true },
        ],
      }),
      modelId: 'gemini-3.1-flash-image',
      prompt: 'abstract geometry',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const [relayUrl, relayInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(relayUrl).toBe('https://relay.example.com/v1/images/generations');
    const relayHeaders = relayInit.headers as Record<string, string>;
    expect(relayHeaders['x-relay-tenant']).toBe('studio-unit');
    expect(relayHeaders['x-disabled-header']).toBeUndefined();
    expect(relayHeaders.Host).toBeUndefined();
  });

  it('redacts secrets in HTTP errors, rejects empty image arrays, and degrades gracefully on remote 404', async () => {
    const secretKey = 'sk-secret-key?token=abc+123';
    const encodedKey = encodeURIComponent(secretKey);
    const provider = makeProvider({ apiKey: secretKey });

    const errorFetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: `bad ${secretKey} and ${encodedKey}` } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      })
    );
    await expect(
      generateImages({
        provider,
        modelId: 'gpt-image-2.5-sunburst',
        prompt: 'rate limit test',
        fetchImpl: errorFetch as unknown as typeof fetch,
      })
    ).rejects.toThrow(/429/);

    await generateImages({
      provider,
      modelId: 'gpt-image-2.5-sunburst',
      prompt: 'rate limit test',
      fetchImpl: errorFetch as unknown as typeof fetch,
    }).catch((err: Error) => {
      expect(err.message).toContain('[REDACTED]');
      expect(err.message).not.toContain(secretKey);
      expect(err.message).not.toContain(encodedKey);
    });

    const emptyFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    await expect(
      generateImages({
        provider,
        modelId: 'gpt-image-2.5-sunburst',
        prompt: 'empty response',
        fetchImpl: emptyFetch as unknown as typeof fetch,
      })
    ).rejects.toThrow(/未返回|空|图片/);

    const remote404Fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/images/generations')) {
        return new Response(
          JSON.stringify({ data: [{ url: 'https://cdn.example.com/expired.png' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('Not Found', { status: 404 });
    });
    vi.stubGlobal('fetch', remote404Fetch);

    const degraded = await generateImages({
      provider,
      modelId: 'gpt-image-2.5-sunburst',
      prompt: 'expired remote url',
    });
    expect(degraded.attachments?.[0]?.uri).toBe('https://cdn.example.com/expired.png');
    expect(degraded.content).toMatch(/未能复制|失效|导出/);
  });

  it('delegates sendOpenAiCompatibleChat image-generation and forwards imageOptions from ChatRequestExecution', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: TINY_PNG_BASE64 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const chatMsg: ChatMessage = {
      id: 'u-1',
      role: 'user',
      content: 'paint a lighthouse',
      createdAt: 1,
      status: 'ready',
    };
    const compatResult = await sendOpenAiCompatibleChat({
      provider: makeProvider(),
      modelId: 'gpt-image-2.5-sunburst',
      messages: [chatMsg],
      reasoningEffort: 'default',
      imageOptions: { aspectRatio: '16:9', quality: 'high', count: 1 },
    });
    expect(compatResult.attachments).toHaveLength(1);
    const sentCompatBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(sentCompatBody.size).toBe('1536x1024');

    const capturedRequests: Array<Record<string, unknown>> = [];
    const mockAdapter: ProviderAdapter = {
      async run(req) {
        capturedRequests.push(req as unknown as Record<string, unknown>);
        return { content: 'ok', attachments: [], raw: {} };
      },
      async queryTask() {
        return { content: 'ok', raw: {} };
      },
    };
    const registry: ProviderAdapterRegistry = {
      resolve: () => mockAdapter,
    };
    const workspace = createDefaultWorkspace();
    const host: ChatRequestExecutionHost = {
      readWorkspace: () => workspace,
      appState: () => 'active',
      streamUpdateDelayMs: () => 16,
      discardAttachments: async () => undefined,
      authorize: async () => true,
      persistUsageEvents: async () => undefined,
      finishUsageEvent: async () => undefined,
      requestMcpApproval: async () => 'deny',
      updateAssistantMessage: () => undefined,
      notify: () => undefined,
    };
    const execution = new ChatRequestExecution(
      registry,
      {
        current: () => null,
        begin: () => null,
        transition: () => false,
        finish: () => undefined,
        stop: () => undefined,
      },
      host
    );
    const assistantMessage: ChatMessage = {
      id: 'a-1',
      role: 'assistant',
      content: '',
      createdAt: 2,
      status: 'pending',
    };
    await execution.execute({
      assistantMessage,
      conversationId: 'c-1',
      transcript: [chatMsg],
      runtime: {
        provider: makeProvider(),
        model: {
          id: 'gpt-image-2.5-sunburst',
          name: 'GPT Image',
          capabilities: ['image-generation'],
          task: 'image-generation',
          source: 'manual',
        },
        modelId: 'gpt-image-2.5-sunburst',
        reasoningEffort: 'default',
      },
      controller: new AbortController(),
      usageEvent: {
        id: 'u-evt-1',
        kind: 'image-generation',
        status: 'started',
        providerRequestCount: 1,
        providerId: 'openai',
        modelId: 'gpt-image-2.5-sunburst',
        createdAt: 1,
        localDateKey: '2026-11-25',
        unknownCostComponents: [],
      },
      parameterSettings: workspace.parameterSettings,
      imageOptions: { aspectRatio: '9:16', quality: 'high', count: 2 },
    });

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]?.imageOptions).toEqual({
      aspectRatio: '9:16',
      quality: 'high',
      count: 2,
    });
  });

  it('strips case-insensitive Content-Type from customHeaders on multipart /v1/images/edits', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: TINY_PNG_BASE64 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    await generateImages({
      provider: makeProvider({
        customHeaders: [
          { key: 'Content-Type', value: 'application/json', enabled: true },
          { key: 'CONTENT-TYPE', value: 'text/plain', enabled: true },
          { key: 'x-tenant-id', value: 'alpha', enabled: true },
        ],
      }),
      modelId: 'gpt-image-2.5-flare',
      prompt: 'keep multipart boundary intact',
      options: { referenceImages: [makeReferenceImage()] },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeInstanceOf(FormData);
    const parsedHeaders = new Headers(init.headers);
    expect(parsedHeaders.get('content-type')).toBeNull();
    expect(parsedHeaders.get('x-tenant-id')).toBe('alpha');
  });

  it('redacts both raw and encodeURIComponent(apiKey) across openai-responses and gemini-generate-content errors', async () => {
    const openAiKey = 'sk-test+key/with=special&chars99';
    const encodedOpenAiKey = encodeURIComponent(openAiKey);
    const openAiErrFetch = vi.fn().mockResolvedValue(
      new Response(
        `Auth failed raw=${openAiKey} url=https://err.test?key=${encodedOpenAiKey}`,
        { status: 401, headers: { 'content-type': 'text/plain' } }
      )
    );

    const openAiCaught = await generateImages({
      provider: makeProvider({ apiKey: openAiKey, imageApiMode: 'openai-responses' }),
      modelId: 'gpt-5.4',
      prompt: 'test responses secret redaction',
      fetchImpl: openAiErrFetch as unknown as typeof fetch,
    }).catch((err: Error) => err);

    expect(openAiCaught).toBeInstanceOf(Error);
    expect((openAiCaught as Error).message).toContain('[REDACTED]');
    expect((openAiCaught as Error).message).not.toContain(openAiKey);
    expect((openAiCaught as Error).message).not.toContain(encodedOpenAiKey);

    const geminiKey = 'AIzaSy+Test/Key=With&Special99';
    const encodedGeminiKey = encodeURIComponent(geminiKey);
    const geminiErrFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 400,
            message: `Bad key raw=${geminiKey} encoded=${encodedGeminiKey}`,
          },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      )
    );

    const geminiCaught = await generateImages({
      provider: makeProvider({
        id: 'gemini',
        kind: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: geminiKey,
      }),
      modelId: 'gemini-3.1-flash-image',
      prompt: 'test gemini secret redaction',
      fetchImpl: geminiErrFetch as unknown as typeof fetch,
    }).catch((err: Error) => err);

    expect(geminiCaught).toBeInstanceOf(Error);
    expect((geminiCaught as Error).message).toContain('[REDACTED]');
    expect((geminiCaught as Error).message).not.toContain(geminiKey);
    expect((geminiCaught as Error).message).not.toContain(encodedGeminiKey);
  });

  it('enforces timeout and abort signal during response body streaming in guardedImageFetch', async () => {
    vi.useFakeTimers();

    const hangingBody = new ReadableStream<Uint8Array>({
      start() {
        // 永不发送 chunk，模拟响应头返回后响应体挂起
      },
    });
    const hangingFetch = vi.fn().mockResolvedValue(
      new Response(hangingBody, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    const pendingPromise = generateImages({
      provider: makeProvider(),
      modelId: 'gpt-image-2.5-sunburst',
      prompt: 'timeout during body read',
      fetchImpl: hangingFetch as unknown as typeof fetch,
    });
    const assertion = expect(pendingPromise).rejects.toMatchObject({ name: 'TimeoutError' });

    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;

    vi.useRealTimers();

    const controller = new AbortController();
    const abortableBody = new ReadableStream<Uint8Array>({
      start() {
        // 保持挂起等待 caller abort
      },
    });
    const abortFetch = vi.fn().mockResolvedValue(
      new Response(abortableBody, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    const abortedPromise = generateImages({
      provider: makeProvider(),
      modelId: 'gpt-image-2.5-sunburst',
      prompt: 'abort during body read',
      signal: controller.signal,
      fetchImpl: abortFetch as unknown as typeof fetch,
    });
    const abortAssertion = expect(abortedPromise).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    controller.abort();
    await abortAssertion;
  });

  it('aborts and cancels hanging 200 OK response streams across openai-responses, gemini-generate-content, openai-images, and xai-json', async () => {
    const createHangingFetch = (contentType: string, status = 200) => {
      let cancelCount = 0;
      let capturedResponse: Response | undefined;
      let markReadingStarted: (() => void) | undefined;
      let markCancelled: (() => void) | undefined;
      const readingStarted = new Promise<void>((resolve) => {
        markReadingStarted = resolve;
      });
      const cancelled = new Promise<void>((resolve) => {
        markCancelled = resolve;
      });
      const fetchMock = vi.fn().mockImplementation(async () => {
        const stream = new ReadableStream<Uint8Array>(
          {
            start() {
              // 响应头返回后流挂起，永不发送 chunk
            },
            pull() {
              markReadingStarted?.();
            },
            cancel() {
              cancelCount += 1;
              markCancelled?.();
            },
          },
          { highWaterMark: 0 }
        );
        capturedResponse = new Response(stream, {
          status,
          headers: { 'content-type': contentType },
        });
        return capturedResponse;
      });
      return {
        fetchMock,
        isCancelled: () => cancelCount >= 1,
        getCancelCount: () => cancelCount,
        getResponse: () => capturedResponse,
        waitUntilReading: () => readingStarted,
        waitUntilCancelled: () => cancelled,
      };
    };

    const cases = [
      {
        label: 'openai-images',
        provider: makeProvider(),
        modelId: 'gpt-image-2.5-sunburst',
        contentType: 'application/json',
      },
      {
        label: 'xai-json',
        provider: makeProvider({
          id: 'xai-grok',
          kind: 'xai-grok',
          baseUrl: 'https://api.x.ai/v1',
          apiKey: 'xai-img-key',
        }),
        modelId: 'grok-imagine-image-2.0',
        contentType: 'application/json',
      },
      {
        label: 'openai-responses',
        provider: makeProvider({ imageApiMode: 'openai-responses' }),
        modelId: 'gpt-5.4',
        contentType: 'text/event-stream',
      },
      {
        label: 'openai-responses-json-fallback',
        provider: makeProvider({ imageApiMode: 'openai-responses' }),
        modelId: 'gpt-5.4',
        contentType: 'application/json',
      },
      {
        label: 'gemini-generate-content',
        provider: makeProvider({
          id: 'gemini',
          kind: 'gemini',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
          apiKey: 'AIza-gemini-img-key',
        }),
        modelId: 'gemini-3.1-flash-image',
        contentType: 'application/json',
      },
    ];

    for (const item of cases) {
      const controller = new AbortController();
      const { fetchMock, getCancelCount, getResponse, waitUntilReading, waitUntilCancelled } =
        createHangingFetch(item.contentType);
      const pending = generateImages({
        provider: item.provider,
        modelId: item.modelId,
        prompt: `abort hanging ${item.label}`,
        signal: controller.signal,
        fetchImpl: fetchMock as unknown as typeof fetch,
      });
      const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      // 确定性等待 reader.read() 进入挂起状态后触发取消
      await waitUntilReading();
      const abortedAt = Date.now();
      controller.abort();
      await assertion;
      expect(Date.now() - abortedAt).toBeLessThan(200);
      await waitUntilCancelled();
      expect(getCancelCount()).toBeGreaterThanOrEqual(1);
      expect(getResponse()?.body?.locked).toBe(false);
    }

    // 补充验证 openai-responses 非流式 200 application/json 回退与 401 错误响应体挂起均可快速中断并取消底层流
    for (const status of [200, 401] as const) {
      const chatCtrl = new AbortController();
      const chatMock = createHangingFetch(
        status === 200 ? 'application/json' : 'text/plain',
        status
      );
      const chatPending = sendOpenAiResponsesChat({
        provider: makeProvider({ imageApiMode: 'openai-responses' }),
        modelId: 'gpt-5.4',
        messages: [
          {
            id: `u-resp-${status}`,
            role: 'user',
            content: 'hello',
            createdAt: 1,
            status: 'ready',
          },
        ],
        stream: true,
        signal: chatCtrl.signal,
        fetchImpl: chatMock.fetchMock as unknown as typeof fetch,
      });
      const chatAssertion = expect(chatPending).rejects.toMatchObject({ name: 'AbortError' });
      await chatMock.waitUntilReading();
      const chatAbortedAt = Date.now();
      chatCtrl.abort();
      await chatAssertion;
      expect(Date.now() - chatAbortedAt).toBeLessThan(200);
      await chatMock.waitUntilCancelled();
      expect(chatMock.getCancelCount()).toBeGreaterThanOrEqual(1);
      expect(chatMock.getResponse()?.body?.locked).toBe(false);

      if (status === 401) {
        const img401Ctrl = new AbortController();
        const img401Mock = createHangingFetch('text/plain', 401);
        const img401Pending = generateImages({
          provider: makeProvider({ imageApiMode: 'openai-responses' }),
          modelId: 'gpt-5.4',
          prompt: 'abort hanging 401 responses image',
          signal: img401Ctrl.signal,
          fetchImpl: img401Mock.fetchMock as unknown as typeof fetch,
        });
        const img401Assertion = expect(img401Pending).rejects.toMatchObject({ name: 'AbortError' });
        await img401Mock.waitUntilReading();
        const img401AbortedAt = Date.now();
        img401Ctrl.abort();
        await img401Assertion;
        expect(Date.now() - img401AbortedAt).toBeLessThan(200);
        await img401Mock.waitUntilCancelled();
        expect(img401Mock.getCancelCount()).toBeGreaterThanOrEqual(1);
        expect(img401Mock.getResponse()?.body?.locked).toBe(false);
      }
    }

    // 补充验证 Gemini SSE 流式挂起同样支持 AbortSignal 并取消底层流
    const geminiSseCtrl = new AbortController();
    const geminiSseMock = createHangingFetch('text/event-stream');
    const geminiSsePending = sendGeminiNativeChat({
      provider: makeProvider({
        id: 'gemini',
        kind: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'AIza-gemini-img-key',
      }),
      modelId: 'gemini-2.5-flash',
      messages: [
        {
          id: 'u-gem-sse',
          role: 'user',
          content: 'hello',
          createdAt: 1,
          status: 'ready',
        },
      ],
      stream: true,
      signal: geminiSseCtrl.signal,
      fetchImpl: geminiSseMock.fetchMock as unknown as typeof fetch,
    });
    const geminiSseAssertion = expect(geminiSsePending).rejects.toMatchObject({ name: 'AbortError' });
    await geminiSseMock.waitUntilReading();
    const gemAbortedAt = Date.now();
    geminiSseCtrl.abort();
    await geminiSseAssertion;
    expect(Date.now() - gemAbortedAt).toBeLessThan(200);
    await geminiSseMock.waitUntilCancelled();
    expect(geminiSseMock.getCancelCount()).toBeGreaterThanOrEqual(1);
    expect(geminiSseMock.getResponse()?.body?.locked).toBe(false);

    // 补充验证 readResponseTextWithAbort 对跨 chunk 多字节 UTF-8 JSON 回退响应的完整解码
    const utf8JsonBytes = new TextEncoder().encode(
      JSON.stringify({
        status: 'completed',
        output_text: '你好世界🚀测试跨块解码',
      })
    );
    const splitIndex = utf8JsonBytes.indexOf(0xf0) + 2; // 精确切分 4 字节 emoji 🚀 中间
    const chunkedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(utf8JsonBytes.slice(0, splitIndex));
        controller.enqueue(utf8JsonBytes.slice(splitIndex));
        controller.close();
      },
    });
    const chunkedResult = await readOpenAiResponsesStream(
      new Response(chunkedStream, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      undefined,
      { signal: new AbortController().signal }
    );
    expect(chunkedResult.content).toBe('你好世界🚀测试跨块解码');
  });

  it('redacts lowercase and mixed-case percent-encoded API keys (and URLSearchParams + space variants) across all image protocols', async () => {
    const openAiKey = 'sk-probe+key/with=special&chars99';
    const lowerEncodedOpenAiKey = encodeURIComponent(openAiKey).toLowerCase();
    expect(lowerEncodedOpenAiKey).toBe('sk-probe%2bkey%2fwith%3dspecial%26chars99');

    const responsesErrFetch = vi.fn().mockResolvedValue(
      new Response(`Auth failed lowerEnc=${lowerEncodedOpenAiKey}`, {
        status: 401,
        headers: { 'content-type': 'text/plain' },
      })
    );
    const responsesErr = await generateImages({
      provider: makeProvider({ apiKey: openAiKey, imageApiMode: 'openai-responses' }),
      modelId: 'gpt-5.4',
      prompt: 'redact lowercase responses',
      fetchImpl: responsesErrFetch as unknown as typeof fetch,
    }).catch((err: Error) => err);
    expect(responsesErr).toBeInstanceOf(Error);
    expect((responsesErr as Error).message).toContain('[REDACTED]');
    expect((responsesErr as Error).message).not.toContain(lowerEncodedOpenAiKey);

    const imagesErrFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: `lowerEnc=${lowerEncodedOpenAiKey}` } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    );
    const imagesErr = await generateImages({
      provider: makeProvider({ apiKey: openAiKey }),
      modelId: 'gpt-image-2.5-sunburst',
      prompt: 'redact lowercase images',
      fetchImpl: imagesErrFetch as unknown as typeof fetch,
    }).catch((err: Error) => err);
    expect(imagesErr).toBeInstanceOf(Error);
    expect((imagesErr as Error).message).toContain('[REDACTED]');
    expect((imagesErr as Error).message).not.toContain(lowerEncodedOpenAiKey);

    const geminiKey = 'AIzaSy+Test/Key=With&Space here';
    const mixedAndPlusGeminiKey = 'AIzaSy%2bTest%2FKey%3dWith%26Space+here';
    const geminiErrFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 400,
            message: `Bad key enc=${mixedAndPlusGeminiKey}`,
          },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      )
    );
    const geminiErr = await generateImages({
      provider: makeProvider({
        id: 'gemini',
        kind: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: geminiKey,
      }),
      modelId: 'gemini-3.1-flash-image',
      prompt: 'redact mixed-case gemini',
      fetchImpl: geminiErrFetch as unknown as typeof fetch,
    }).catch((err: Error) => err);
    expect(geminiErr).toBeInstanceOf(Error);
    expect((geminiErr as Error).message).toContain('[REDACTED]');
    expect((geminiErr as Error).message).not.toContain(mixedAndPlusGeminiKey);
  });

  it('enforces redirect: error and blocks private/IMDS URLs returned by image endpoints', async () => {
    const capturedInits: Array<RequestInit | undefined> = [];
    const globalFetchSpy = vi.fn();
    vi.stubGlobal('fetch', globalFetchSpy);

    const ssrfOpenAiFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInits.push(init);
      return new Response(
        JSON.stringify({
          data: [{ url: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });

    await expect(
      generateImages({
        provider: makeProvider(),
        modelId: 'gpt-image-2.5-sunburst',
        prompt: 'blocked imds url',
        fetchImpl: ssrfOpenAiFetch as unknown as typeof fetch,
      })
    ).rejects.toThrow(/未返回任何有效图片数据/);
    expect(capturedInits[0]?.redirect).toBe('error');
    expect(globalFetchSpy).not.toHaveBeenCalled();

    const ssrfXaiFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInits.push(init);
      return new Response(
        JSON.stringify({
          data: [{ url: 'https://[::ffff:169.254.169.254]/latest/meta-data/' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });

    await expect(
      generateImages({
        provider: makeProvider({
          id: 'xai-grok',
          kind: 'xai-grok',
          baseUrl: 'https://api.x.ai/v1',
          apiKey: 'xai-img-key',
        }),
        modelId: 'grok-imagine-image-2.0',
        prompt: 'blocked ipv6 mapped imds url',
        fetchImpl: ssrfXaiFetch as unknown as typeof fetch,
      })
    ).rejects.toThrow(/未返回任何有效图片数据/);
    expect(capturedInits[1]?.redirect).toBe('error');
    expect(globalFetchSpy).not.toHaveBeenCalled();

    // Native 端直接对 mediaStorage.persistAttachment 传入内网/IMDS URL 同样禁止调用 File.downloadFileAsync
    const { persistAttachment } = await import('../src/services/mediaStorage');
    await expect(
      persistAttachment(
        {
          id: 'native-ssrf-img',
          kind: 'image',
          uri: 'https://169.254.169.254/latest/meta-data/img.png',
          name: 'img.png',
        },
        { downloadRemote: true }
      )
    ).rejects.toThrow(/公开 HTTPS/);
    expect(globalFetchSpy).not.toHaveBeenCalled();
  });
});
