import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ChatMessage,
  MediaAttachment,
  ProviderProfile,
  StreamChatCallbacks,
} from '../src/domain/types';
import type { ProviderAdapter } from '../src/features/chat/orchestration/ProviderAdapterRegistry';
import {
  AnthropicMessagesProviderAdapter,
  AnthropicProtocolError,
  buildAnthropicMessagesHeaders,
  buildAnthropicMessagesRequest,
  createAnthropicProviderAdapter,
  getAnthropicMessagesEndpoint,
  isAdaptiveThinkingClaudeModel,
  parseAnthropicMessagesResponse,
  sendAnthropicMessagesChat,
} from '../src/services/anthropicMessages';
import { parseSearchToolDetail } from '../src/services/messageActivity';
import { createModelInfoFromId } from '../src/services/modelCapabilities';
import { isAbortError } from '../src/services/openAiCompatible';

const platform = vi.hoisted(() => ({ OS: 'android' }));
vi.mock('react-native', () => ({ Platform: platform }));

function anthropicProvider(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'anthropic',
    name: 'Anthropic Claude',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    apiKey: 'sk-ant-secret-key',
    capabilities: ['text', 'image-input', 'file-input', 'reasoning', 'web-search', 'tool-calling', 'streaming'],
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

function makeChunkedStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function makeByteSplitStream(fullText: string, chunkSizes: number[]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(fullText);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let offset = 0;
      let idx = 0;
      while (offset < bytes.length) {
        const size = chunkSizes[idx % chunkSizes.length] ?? 7;
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

describe('Anthropic endpoint and headers', () => {
  it('normalizes official Anthropic, DeepSeek Anthropic-compat, and custom relay URLs', () => {
    expect(getAnthropicMessagesEndpoint({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com' })).toBe(
      'https://api.anthropic.com/v1/messages'
    );
    expect(getAnthropicMessagesEndpoint({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' })).toBe(
      'https://api.anthropic.com/v1/messages'
    );
    expect(getAnthropicMessagesEndpoint({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1/messages' })).toBe(
      'https://api.anthropic.com/v1/messages'
    );
    expect(getAnthropicMessagesEndpoint({ kind: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic' })).toBe(
      'https://api.deepseek.com/anthropic/v1/messages'
    );
    expect(
      getAnthropicMessagesEndpoint({ kind: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic/v1/messages' })
    ).toBe('https://api.deepseek.com/anthropic/v1/messages');
    expect(getAnthropicMessagesEndpoint({ kind: 'new-api-relay', baseUrl: 'https://relay.example.com' })).toBe(
      'https://relay.example.com/v1/messages'
    );
    expect(getAnthropicMessagesEndpoint({ kind: 'custom', baseUrl: 'http://127.0.0.1:8080/proxy/v1/messages' })).toBe(
      'http://127.0.0.1:8080/proxy/v1/messages'
    );
  });

  it('rejects credentials, query, hash, and non-loopback plain http URLs', () => {
    expect(() =>
      getAnthropicMessagesEndpoint({ kind: 'anthropic', baseUrl: 'https://user:pass@api.anthropic.com/v1' })
    ).toThrow(/用户名或密码/);
    expect(() =>
      getAnthropicMessagesEndpoint({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1?foo=1' })
    ).toThrow(/查询参数或片段/);
    expect(() =>
      getAnthropicMessagesEndpoint({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1#frag' })
    ).toThrow(/查询参数或片段/);
    expect(() =>
      getAnthropicMessagesEndpoint({ kind: 'custom', baseUrl: 'http://relay.example.com/v1' })
    ).toThrow(/HTTPS/);
  });

  it('builds auth headers, ensures anthropic-version fallback on relays, and deduplicates anthropic-beta', () => {
    const officialHeaders = buildAnthropicMessagesHeaders(
      anthropicProvider({
        customHeaders: [
          { key: 'Anthropic-Beta', value: 'beta-a, beta-b' },
          { key: 'x-trace-id', value: 'trace-123' },
          { key: 'Host', value: 'evil.example' },
        ],
      }),
      { extraBetas: ['beta-b', 'code-execution-web-tools-2026-02-09'] }
    );

    expect(officialHeaders['x-api-key']).toBe('sk-ant-secret-key');
    expect(officialHeaders['anthropic-version']).toBe('2023-06-01');
    expect(officialHeaders['anthropic-beta']).toBe('beta-a, beta-b, code-execution-web-tools-2026-02-09');
    expect(officialHeaders['x-trace-id']).toBe('trace-123');
    expect(officialHeaders.Host).toBeUndefined();
    expect(officialHeaders['Content-Type']).toBe('application/json');
    expect(officialHeaders.Accept).toBe('text/event-stream, application/json');

    const relayHeaders = buildAnthropicMessagesHeaders(
      anthropicProvider({
        kind: 'new-api-relay',
        baseUrl: 'https://relay.example.com/v1',
        authHeaderMode: 'x-api-key',
      }),
      { stream: false }
    );
    expect(relayHeaders['x-api-key']).toBe('sk-ant-secret-key');
    expect(relayHeaders['anthropic-version']).toBe('2023-06-01');
    expect(relayHeaders.Accept).toBe('application/json');
  });
});

describe('Anthropic Thinking dual-mode & sampling constraints', () => {
  it('identifies Claude 5.x and 4.6+ models as adaptive thinking models', () => {
    expect(isAdaptiveThinkingClaudeModel('claude-sonnet-5-5')).toBe(true);
    expect(isAdaptiveThinkingClaudeModel('claude-fable-5-2')).toBe(true);
    expect(isAdaptiveThinkingClaudeModel('claude-opus-4-6')).toBe(true);
    expect(isAdaptiveThinkingClaudeModel('claude-opus-4-7-20260401')).toBe(true);
    expect(isAdaptiveThinkingClaudeModel('claude-3-7-sonnet-20250219')).toBe(false);
    expect(isAdaptiveThinkingClaudeModel('claude-sonnet-4-5-20250929')).toBe(false);
    expect(isAdaptiveThinkingClaudeModel('claude-sonnet-4-20250514')).toBe(false);
  });

  it('uses adaptive thinking + output_config.effort without budget_tokens on newer models and strips temperature/top_p', async () => {
    const provider = anthropicProvider();
    const model = createModelInfoFromId(provider, 'claude-fable-5-2', 'manual');
    const req = await buildAnthropicMessagesRequest({
      provider,
      modelId: 'claude-fable-5-2',
      model,
      messages: [makeMessage('u1', 'user', 'Design a compiler.')],
      reasoningEffort: 'xhigh',
      parameterSettings: {
        enabled: true,
        temperature: 0.4,
        topP: 0.8,
        presencePenalty: 0.5,
        frequencyPenalty: 0.5,
      },
    });

    expect(req.body.thinking).toEqual({ type: 'adaptive' });
    expect((req.body.thinking as Record<string, unknown>).budget_tokens).toBeUndefined();
    expect(req.body.output_config).toEqual({ effort: 'xhigh' });
    expect(req.body.temperature).toBeUndefined();
    expect(req.body.top_p).toBeUndefined();
    expect((req.body as unknown as Record<string, unknown>).presence_penalty).toBeUndefined();
    expect((req.body as unknown as Record<string, unknown>).frequency_penalty).toBeUndefined();
  });

  it('uses budget_tokens on legacy models and guarantees max_tokens > budget_tokens', async () => {
    const provider = anthropicProvider();
    const model = createModelInfoFromId(provider, 'claude-3-7-sonnet-20250219', 'manual');
    const req = await buildAnthropicMessagesRequest({
      provider,
      modelId: 'claude-3-7-sonnet-20250219',
      model,
      messages: [makeMessage('u1', 'user', 'Prove it.')],
      reasoningEffort: 'high',
      maxOutputTokens: 2048,
    });

    expect(req.body.thinking).toEqual({ type: 'enabled', budget_tokens: 10240 });
    expect(req.body.output_config).toBeUndefined();
    expect(req.body.max_tokens).toBeGreaterThan(10240);
  });

  it('allows temperature when thinking is off and never sends penalty fields', async () => {
    const provider = anthropicProvider();
    const model = createModelInfoFromId(provider, 'claude-sonnet-5-5', 'manual');
    const req = await buildAnthropicMessagesRequest({
      provider,
      modelId: 'claude-sonnet-5-5',
      model,
      messages: [makeMessage('u1', 'user', 'Say hi.')],
      reasoningEffort: 'off',
      parameterSettings: {
        enabled: true,
        temperature: 0.3,
        topP: 0.9,
        presencePenalty: 1.2,
        frequencyPenalty: 0.8,
      },
    });

    expect(req.body.thinking).toBeUndefined();
    expect(req.body.temperature).toBe(0.3);
    expect(req.body.top_p).toBeUndefined();
    expect((req.body as unknown as Record<string, unknown>).presence_penalty).toBeUndefined();
    expect((req.body as unknown as Record<string, unknown>).frequency_penalty).toBeUndefined();
  });
});

describe('Anthropic SSE streaming, byte-split UTF-8, continuation round-trip & callbacks', () => {
  it('decodes byte-split multi-byte UTF-8 SSE without [DONE], handles signature_delta, and completes on message_stop', async () => {
    const events = [
      'event: message_start\r\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-5-5","usage":{"input_tokens":120,"cache_read_input_tokens":40}}}\r\n\r\n',
      'event: ping\r\ndata: {"type":"ping"}\r\n\r\n',
      'event: content_block_start\r\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\r\n\r\n',
      'event: content_block_delta\r\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"深度思考中文步骤一"}}\r\n\r\n',
      'event: content_block_delta\r\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_part1_"}}\r\n\r\n',
      'event: signature_delta\r\ndata: {"type":"signature_delta","index":0,"signature":"sig_part2"}\r\n\r\n',
      'event: content_block_stop\r\ndata: {"type":"content_block_stop","index":0}\r\n\r\n',
      'event: content_block_start\r\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"enc_redacted_blob"}}\r\n\r\n',
      'event: content_block_stop\r\ndata: {"type":"content_block_stop","index":1}\r\n\r\n',
      'event: content_block_start\r\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}\r\n\r\n',
      'event: content_block_delta\r\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"最终中文回答🎉"}}\r\n\r\n',
      'event: content_block_stop\r\ndata: {"type":"content_block_stop","index":2}\r\n\r\n',
      'event: message_delta\r\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":55}}\r\n\r\n',
      'event: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n',
    ].join('');

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(makeByteSplitStream(events, [5, 7, 11, 3]), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const thinkingCompleted: number[] = [];
    const streamUpdates: Array<{ content: string; reasoningContent?: string }> = [];
    const callbacks: StreamChatCallbacks = {
      onThinkingComplete: (durationMs) => thinkingCompleted.push(durationMs),
    };

    const result = await sendAnthropicMessagesChat({
      provider: anthropicProvider(),
      modelId: 'claude-sonnet-5-5',
      messages: [makeMessage('u1', 'user', '你好')],
      reasoningEffort: 'medium',
      callbacks,
      onStreamUpdate: (update) => streamUpdates.push({ content: update.content, reasoningContent: update.reasoningContent }),
    });

    expect(result.content).toBe('最终中文回答🎉');
    expect(result.reasoningContent).toBe('深度思考中文步骤一');
    expect(thinkingCompleted).toHaveLength(1);
    expect(result.thinkingDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.usage).toEqual({
      inputTokens: 120,
      cachedInputTokens: 40,
      outputTokens: 55,
      totalTokens: 175,
    });
    expect(result.providerContinuations).toEqual([
      {
        provider: 'anthropic',
        type: 'thinking',
        thinking: '深度思考中文步骤一',
        signature: 'sig_part1_sig_part2',
      },
      {
        provider: 'anthropic',
        type: 'redacted_thinking',
        data: 'enc_redacted_blob',
      },
    ]);
    expect(streamUpdates.at(-1)?.content).toBe('最终中文回答🎉');
  });

  it('extracts web search blocks and round-trips all 4 continuation blocks preserving order and tool_use_id', async () => {
    const stream = makeChunkedStream([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_s1","usage":{"input_tokens":80}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"srvtoolu_01","name":"web_search","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"Claude 5"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":" release\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result","tool_use_id":"srvtoolu_01","content":[{"type":"web_search_result","title":"Anthropic News","url":"https://www.anthropic.com/news","page_age":"2026-01-01"},{"type":"web_search_result","title":"Local SSRF","url":"http://127.0.0.1/secret"}]}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"Released in 2026."}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"citations_delta","citation":{"type":"web_search_result_location","url":"https://www.anthropic.com/news","title":"Anthropic News","cited_text":"Released"}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"citations_delta","citation":{"type":"web_search_result_location","url":"http://192.168.1.1/admin","title":"Blocked"}}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":2}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":30}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      )
    );

    const citationEvents: number[] = [];
    const result1 = await sendAnthropicMessagesChat({
      provider: anthropicProvider(),
      modelId: 'claude-sonnet-5-5',
      messages: [makeMessage('u1', 'user', 'When was Claude 5 released?')],
      reasoningEffort: 'off',
      webSearch: { enabled: true, searchContextSize: 'medium' },
      anthropicWebSearch: {
        enabled: true,
        toolType: 'web_search_20260209',
        allowedDomains: ['anthropic.com'],
      },
      callbacks: {
        onCitations: (citations) => citationEvents.push(citations.length),
      },
    });

    expect(result1.webSearchTriggered).toBe(true);
    expect(result1.citations).toEqual([
      {
        url: 'https://www.anthropic.com/news',
        title: 'Anthropic News',
        text: 'Released',
        index: 1,
      },
    ]);
    expect(citationEvents).toEqual([1]);
    expect(result1.toolActivity?.[0]?.status).toBe('completed');
    const parsedDetail = parseSearchToolDetail(result1.toolActivity?.[0]?.content);
    expect(parsedDetail.query).toBe('Claude 5 release');
    expect(parsedDetail.items).toHaveLength(1);
    expect(parsedDetail.items[0]?.url).toBe('https://www.anthropic.com/news');

    // 第二轮构造请求：验证 system 抽取、相邻同角色合并、4 类 continuation 块按原序回传且跳过缺签名 thinking
    const round2Req = await buildAnthropicMessagesRequest({
      provider: anthropicProvider(),
      modelId: 'claude-sonnet-5-5',
      messages: [
        makeMessage('s1', 'system', 'Be concise.'),
        makeMessage('u1', 'user', 'First part.'),
        makeMessage('u1b', 'user', 'Second part.'),
        makeMessage('a1', 'assistant', result1.content, {
          providerContinuations: [
            { provider: 'anthropic', type: 'thinking', thinking: 'no-sig', signature: '' },
            { provider: 'anthropic', type: 'thinking', thinking: 'valid', signature: 'sig_ok' },
            { provider: 'anthropic', type: 'redacted_thinking', data: 'redacted_blob' },
            ...(result1.providerContinuations ?? []),
          ],
        }),
        makeMessage('u2', 'user', 'Follow up.'),
      ],
      reasoningEffort: 'default',
    });

    expect(round2Req.body.system).toBe('Be concise.');
    expect(round2Req.body.messages).toHaveLength(3);
    expect(round2Req.body.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'First part.' },
        { type: 'text', text: 'Second part.' },
      ],
    });
    expect(round2Req.body.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'valid', signature: 'sig_ok' },
        { type: 'redacted_thinking', data: 'redacted_blob' },
        {
          type: 'server_tool_use',
          id: 'srvtoolu_01',
          name: 'web_search',
          input: { query: 'Claude 5 release' },
        },
        {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_01',
          content: [
            {
              type: 'web_search_result',
              title: 'Anthropic News',
              url: 'https://www.anthropic.com/news',
              page_age: '2026-01-01',
            },
            {
              type: 'web_search_result',
              title: 'Local SSRF',
              url: 'http://127.0.0.1/secret',
            },
          ],
        },
        { type: 'text', text: 'Released in 2026.' },
      ],
    });
  });

  it('rejects conflicting allowedDomains and blockedDomains before issuing network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      sendAnthropicMessagesChat({
        provider: anthropicProvider(),
        modelId: 'claude-sonnet-5-5',
        messages: [makeMessage('u1', 'user', 'Search')],
        reasoningEffort: 'off',
        anthropicWebSearch: {
          enabled: true,
          allowedDomains: ['anthropic.com'],
          blockedDomains: ['example.com'],
        },
      })
    ).rejects.toThrow(/allowedDomains.*blockedDomains/);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Anthropic non-streaming JSON fallback & multimodal attachments', () => {
  it('parses non-streaming JSON responses including citations, usage, and continuations', () => {
    const result = parseAnthropicMessagesResponse({
      id: 'msg_json',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Plan', signature: 'sig_json' },
        {
          type: 'text',
          text: 'Summary text.',
          citations: [
            {
              type: 'web_search_result_location',
              url: 'https://docs.anthropic.com/en/docs',
              title: 'Anthropic Docs',
              cited_text: 'Summary',
            },
          ],
        },
      ],
      usage: { input_tokens: 40, output_tokens: 12, cache_read_input_tokens: 10 },
    });

    expect(result.content).toBe('Summary text.');
    expect(result.reasoningContent).toBe('Plan');
    expect(result.providerContinuations).toEqual([
      { provider: 'anthropic', type: 'thinking', thinking: 'Plan', signature: 'sig_json' },
    ]);
    expect(result.citations?.[0]?.url).toBe('https://docs.anthropic.com/en/docs');
    expect(result.usage).toEqual({
      inputTokens: 40,
      outputTokens: 12,
      cachedInputTokens: 10,
      totalTokens: 52,
    });
  });

  it('converts image base64, public https image, and PDF attachments while rejecting oversized or unsafe media', async () => {
    const validReq = await buildAnthropicMessagesRequest({
      provider: anthropicProvider(),
      modelId: 'claude-sonnet-5-5',
      messages: [
        makeMessage('u1', 'user', 'Inspect these.', {
          attachments: [
            {
              id: 'img1',
              kind: 'image',
              uri: 'data:image/jpg;base64,YWJjZA==',
              name: 'photo.jpg',
              mimeType: 'image/jpg',
            },
            {
              id: 'img2',
              kind: 'image',
              uri: 'https://cdn.example.com/pic.png',
              name: 'pic.png',
              mimeType: 'image/png',
            },
            {
              id: 'pdf1',
              kind: 'file',
              uri: 'file:///spec.pdf',
              name: 'spec.pdf',
              mimeType: 'application/pdf',
              base64: 'JVBERi0xLjQK',
            },
          ],
        }),
      ],
      reasoningEffort: 'off',
    });

    expect(validReq.body.messages[0].content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'YWJjZA==' } },
      { type: 'image', source: { type: 'url', url: 'https://cdn.example.com/pic.png' } },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0xLjQK' } },
      { type: 'text', text: 'Inspect these.' },
    ]);

    // 超过 5MB base64 图片拦截
    const oversizedBase64 = 'A'.repeat(7_200_000);
    const badImage: MediaAttachment = {
      id: 'big',
      kind: 'image',
      uri: 'file:///big.png',
      name: 'big.png',
      mimeType: 'image/png',
      base64: oversizedBase64,
    };
    await expect(
      buildAnthropicMessagesRequest({
        provider: anthropicProvider(),
        modelId: 'claude-sonnet-5-5',
        messages: [makeMessage('u1', 'user', 'Too big', { attachments: [badImage] })],
        reasoningEffort: 'off',
      })
    ).rejects.toThrow(/5 MB/);

    // 不支持的图片格式
    await expect(
      buildAnthropicMessagesRequest({
        provider: anthropicProvider(),
        modelId: 'claude-sonnet-5-5',
        messages: [
          makeMessage('u1', 'user', 'BMP', {
            attachments: [
              {
                id: 'bmp',
                kind: 'image',
                uri: 'data:image/bmp;base64,Qk0=',
                name: 'bad.bmp',
                mimeType: 'image/bmp',
              },
            ],
          }),
        ],
        reasoningEffort: 'off',
      })
    ).rejects.toThrow(/不受 Anthropic 支持/);

    // 非 HTTPS / 内网图片拦截
    await expect(
      buildAnthropicMessagesRequest({
        provider: anthropicProvider(),
        modelId: 'claude-sonnet-5-5',
        messages: [
          makeMessage('u1', 'user', 'Local image', {
            attachments: [
              {
                id: 'ssrf',
                kind: 'image',
                uri: 'https://192.168.1.20/img.png',
                name: 'lan.png',
                mimeType: 'image/png',
              },
            ],
          }),
        ],
        reasoningEffort: 'off',
      })
    ).rejects.toThrow(/公网 HTTPS/);
  });
});

describe('Anthropic error handling, Web dev-proxy & ProviderAdapter contract', () => {
  it('maps HTTP 401/429/529, SSE error events, and premature EOF without message_stop, sanitizing secrets', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'rate_limit_error',
              message: 'Too many requests for key sk-ant-secret-key',
            },
          }),
          {
            status: 429,
            headers: { 'retry-after': '12', 'request-id': 'req_429' },
          }
        )
      )
    );

    const errors: Error[] = [];
    await expect(
      sendAnthropicMessagesChat({
        provider: anthropicProvider(),
        modelId: 'claude-sonnet-5-5',
        messages: [makeMessage('u1', 'user', 'Hi')],
        reasoningEffort: 'off',
        callbacks: { onError: (err) => errors.push(err) },
      })
    ).rejects.toThrow(/429.*12 秒.*\[REDACTED\].*req_429/);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).not.toContain('sk-ant-secret-key');

    // 缺少 message_stop 的提前 EOF
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          makeChunkedStream([
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_eof","usage":{"input_tokens":1}}}\n\n',
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"half"}}\n\n',
          ]),
          { status: 200, headers: { 'content-type': 'text/event-stream' } }
        )
      )
    );

    await expect(
      sendAnthropicMessagesChat({
        provider: anthropicProvider(),
        modelId: 'claude-sonnet-5-5',
        messages: [makeMessage('u1', 'user', 'Hi')],
        reasoningEffort: 'off',
      })
    ).rejects.toThrow(/message_stop/);

    // SSE error event
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          makeChunkedStream([
            'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
          ]),
          { status: 200, headers: { 'content-type': 'text/event-stream' } }
        )
      )
    );
    await expect(
      sendAnthropicMessagesChat({
        provider: anthropicProvider(),
        modelId: 'claude-sonnet-5-5',
        messages: [makeMessage('u1', 'user', 'Hi')],
        reasoningEffort: 'off',
      })
    ).rejects.toThrow(/overloaded_error/);

    // HTTP 529 & 404 & web_search_tool_result_error
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'overloaded_error', message: 'Server busy' },
          }),
          { status: 529 }
        )
      )
    );
    await expect(
      sendAnthropicMessagesChat({
        provider: anthropicProvider(),
        modelId: 'claude-sonnet-5-5',
        messages: [makeMessage('u1', 'user', 'Hi')],
        reasoningEffort: 'off',
      })
    ).rejects.toThrow(/过载/);

    const failedSearchRes = parseAnthropicMessagesResponse({
      id: 'msg_search_err',
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'server_tool_use',
          id: 'srv_err_1',
          name: 'web_search',
          input: { query: 'test' },
        },
        {
          type: 'web_search_tool_result',
          tool_use_id: 'srv_err_1',
          content: [{ type: 'web_search_tool_result_error', error_code: 'too_many_requests' }],
        },
        { type: 'text', text: 'Fallback answer without search.' },
      ],
    });
    expect(failedSearchRes.toolActivity?.[0]?.status).toBe('failed');
    expect(failedSearchRes.toolActivity?.[0]?.summary).toContain('too_many_requests');
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
      sendAnthropicMessagesChat({
        provider: anthropicProvider(),
        modelId: 'claude-sonnet-5-5',
        messages: [makeMessage('u1', 'user', 'Slow')],
        reasoningEffort: 'off',
        timeoutMs: 25,
        fetchImpl: fetchMock as unknown as typeof fetch,
      })
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('handles AbortSignal cancellation cleanly', async () => {
    const controller = new AbortController();
    controller.abort();

    try {
      await sendAnthropicMessagesChat({
        provider: anthropicProvider(),
        modelId: 'claude-sonnet-5-5',
        messages: [makeMessage('u1', 'user', 'Hi')],
        reasoningEffort: 'off',
        signal: controller.signal,
      });
      throw new Error('Expected AbortError');
    } catch (error) {
      expect(isAbortError(error)).toBe(true);
    }
  });

  it('enforces Web production fail-closed and routes via local dev-proxy when enabled', async () => {
    platform.OS = 'web';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('EXPO_PUBLIC_ENABLE_WEB_DEV_PROXY', '0');

    await expect(
      sendAnthropicMessagesChat({
        provider: anthropicProvider(),
        modelId: 'claude-sonnet-5-5',
        messages: [makeMessage('u1', 'user', 'Hi')],
        reasoningEffort: 'off',
      })
    ).rejects.toThrow(/正式 Web 构建不会发送/);
    expect(fetchMock).not.toHaveBeenCalled();

    // 启用 dev-proxy 并提供 loopback location
    vi.stubGlobal('__DEV__', true);
    vi.stubEnv('EXPO_PUBLIC_ENABLE_WEB_DEV_PROXY', '1');
    vi.stubGlobal('window', {
      location: { protocol: 'http:', hostname: '127.0.0.1' },
    });
    const proxyFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'msg_proxy',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Via proxy' }],
          usage: { input_tokens: 5, output_tokens: 3 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', proxyFetch);

    const res = await sendAnthropicMessagesChat({
      provider: anthropicProvider(),
      modelId: 'claude-sonnet-5-5',
      messages: [makeMessage('u1', 'user', 'Hi')],
      reasoningEffort: 'off',
      stream: false,
    });

    expect(res.content).toBe('Via proxy');
    expect(proxyFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = proxyFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('http://127.0.0.1:8787/proxy');
    const proxyPayload = JSON.parse(String(calledInit.body)) as {
      url: string;
      headers: Record<string, string>;
    };
    expect(proxyPayload.url).toBe('https://api.anthropic.com/v1/messages');
    expect(proxyPayload.headers['x-api-key']).toBe('sk-ant-secret-key');
    expect(proxyPayload.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('implements ProviderAdapter contract via AnthropicMessagesProviderAdapter', async () => {
    const adapter: ProviderAdapter = createAnthropicProviderAdapter();
    expect(adapter).toBeInstanceOf(AnthropicMessagesProviderAdapter);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          makeChunkedStream([
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_a","usage":{"input_tokens":10}}}\n\n',
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"Adapter OK"}}\n\n',
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ]),
          { status: 200, headers: { 'content-type': 'text/event-stream' } }
        )
      )
    );

    const res = await adapter.run({
      provider: anthropicProvider(),
      modelId: 'claude-sonnet-5-5',
      messages: [makeMessage('u1', 'user', 'Hi')],
      reasoningEffort: 'off',
    });
    expect(res.content).toBe('Adapter OK');

    await expect(
      adapter.queryTask({
        provider: anthropicProvider(),
        task: {
          providerId: 'anthropic',
          modelId: 'claude-sonnet-5-5',
          taskId: 't1',
          kind: 'video',
        },
      })
    ).rejects.toBeInstanceOf(AnthropicProtocolError);
  });
});

describe('Anthropic M1.2 regression fixes', () => {
  it('merges and deduplicates multiple case-variant anthropic-beta customHeaders with extraBetas', () => {
    const headers = buildAnthropicMessagesHeaders(
      anthropicProvider({
        kind: 'custom',
        baseUrl: 'https://relay.example.com/v1',
        authHeaderMode: 'x-api-key',
        customHeaders: [
          { key: 'anthropic-beta', value: 'beta-one, beta-two' },
          { key: 'Anthropic-Beta', value: 'beta-three, beta-one' },
          { key: 'anthropic-beta', value: 'disabled-beta', enabled: false },
          { key: 'anthropic-beta', value: 'bad\r\nbeta' },
        ],
      }),
      { extraBetas: ['beta-two', 'code-execution-web-tools-2026-02-09'] }
    );

    expect(headers['anthropic-beta']).toBe(
      'beta-one, beta-two, beta-three, code-execution-web-tools-2026-02-09'
    );
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('preserves multi-line data: and event: signature_delta when CRLF is split across SSE chunks', async () => {
    const chunks = [
      'event: message_start\r',
      '\ndata: {"type":"message_start","message":{"id":"msg_crlf","usage":{"input_tokens":5}}}\r\n\r',
      '\nevent: content_block_start\r\ndata: {"type":"content_block_start","index":0,\r',
      '\ndata: "content_block":{"type":"thinking","thinking":""}}\r\n\r\n',
      'event: content_block_delta\r\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Step"}}\r\n\r\n',
      // 故意在 event: signature_delta\r 与 \ndata: 之间切分 \r\n
      'event: signature_delta\r',
      '\ndata: {"index":0,"signature":"sig_split_crlf"}\r\n\r\n',
      'event: content_block_stop\r\ndata: {"type":"content_block_stop","index":0}\r\n\r\n',
      'event: content_block_start\r\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\r\n\r\n',
      // 故意在多行 data: 的 \r 与 \n 之间切分
      'event: content_block_delta\r\ndata: {"type":"content_block_delta","index":1,\r',
      '\ndata: "delta":{"type":"text_delta","text":"CRLF OK"}}\r\n\r\n',
      'event: content_block_stop\r\ndata: {"type":"content_block_stop","index":1}\r\n\r\n',
      'event: message_stop\r\ndata: {"type":"message_stop"}\r',
      '\n\r',
    ];

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(makeChunkedStream(chunks), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      )
    );

    const result = await sendAnthropicMessagesChat({
      provider: anthropicProvider(),
      modelId: 'claude-sonnet-5-5',
      messages: [makeMessage('u1', 'user', 'Test split CRLF')],
      reasoningEffort: 'low',
    });

    expect(result.content).toBe('CRLF OK');
    expect(result.reasoningContent).toBe('Step');
    expect(result.providerContinuations).toEqual([
      {
        provider: 'anthropic',
        type: 'thinking',
        thinking: 'Step',
        signature: 'sig_split_crlf',
      },
    ]);
  });

  it('skips empty-content placeholder text when replaying historical assistant messages', async () => {
    const req = await buildAnthropicMessagesRequest({
      provider: anthropicProvider(),
      modelId: 'claude-sonnet-5-5',
      messages: [
        makeMessage('u1', 'user', 'First'),
        makeMessage('a1', 'assistant', '模型返回了空内容。', {
          providerContinuations: [
            {
              provider: 'anthropic',
              type: 'thinking',
              thinking: 'Internal thought',
              signature: 'sig_only_thinking',
            },
          ],
        }),
        makeMessage('u2', 'user', 'Second'),
        makeMessage('a2', 'assistant', '模型返回了空内容。'),
        makeMessage('u3', 'user', 'Third'),
      ],
      reasoningEffort: 'off',
    });

    expect(req.body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'First' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Internal thought', signature: 'sig_only_thinking' },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Second' },
          { type: 'text', text: 'Third' },
        ],
      },
    ]);
  });

  it('redacts percent-encoded apiKey in HTTP 403 error responses and aborts hanging SSE streams cleanly without listener leaks', async () => {
    const secretKey = 'sk-ant+secret/key=9988';
    const mixedEncoded = encodeURIComponent(secretKey)
      .replace(/%2B/gi, '%2b')
      .replace(/%2F/gi, '%2F')
      .replace(/%3D/gi, '%3d');
    const provider = anthropicProvider({ apiKey: secretKey });

    const errors: Error[] = [];
    await expect(
      sendAnthropicMessagesChat({
        provider,
        modelId: 'claude-sonnet-5-5',
        messages: [makeMessage('u1', 'user', 'Hi')],
        reasoningEffort: 'off',
        callbacks: { onError: (err) => errors.push(err) },
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              type: 'error',
              error: {
                type: 'permission_error',
                message: `Forbidden key ${secretKey} / ${mixedEncoded}`,
              },
            }),
            { status: 403 }
          ),
      })
    ).rejects.toSatisfy((err: Error) => {
      return (
        err.message.includes('403') &&
        err.message.includes('[REDACTED]') &&
        !err.message.includes(secretKey) &&
        !err.message.includes(mixedEncoded)
      );
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).not.toContain(mixedEncoded);

    // 挂起 SSE 流体响应 AbortSignal 并清理 listener
    let cancelCount = 0;
    let markReadingStarted: (() => void) | undefined;
    let markCancelled: (() => void) | undefined;
    const readingStarted = new Promise<void>((resolve) => {
      markReadingStarted = resolve;
    });
    const cancelledPromise = new Promise<void>((resolve) => {
      markCancelled = resolve;
    });
    const hangingStream = new ReadableStream<Uint8Array>({
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
    const hangingResponse = new Response(hangingStream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });

    const abortCtrl = new AbortController();
    let added = 0;
    let removed = 0;
    const origAdd = abortCtrl.signal.addEventListener.bind(abortCtrl.signal);
    const origRemove = abortCtrl.signal.removeEventListener.bind(abortCtrl.signal);
    vi.spyOn(abortCtrl.signal, 'addEventListener').mockImplementation((...args) => {
      if (args[0] === 'abort') added += 1;
      return origAdd(...args);
    });
    vi.spyOn(abortCtrl.signal, 'removeEventListener').mockImplementation((...args) => {
      if (args[0] === 'abort') removed += 1;
      return origRemove(...args);
    });

    const pending = sendAnthropicMessagesChat({
      provider,
      modelId: 'claude-sonnet-5-5',
      messages: [makeMessage('u1', 'user', 'Hang')],
      reasoningEffort: 'off',
      signal: abortCtrl.signal,
      fetchImpl: async () => hangingResponse,
    });
    const expectAbort = expect(pending).rejects.toSatisfy((err: unknown) => isAbortError(err));
    await readingStarted;
    const t0 = Date.now();
    abortCtrl.abort();
    await expectAbort;
    expect(Date.now() - t0).toBeLessThan(250);
    await cancelledPromise;
    expect(cancelCount).toBeGreaterThanOrEqual(1);
    expect(hangingResponse.body?.locked).toBe(false);
    expect(removed).toBe(added);
  });

  it('sanitizes apiKey when parseAnthropicMessagesResponse receives malformed non-JSON text', () => {
    const secretKey = 'sk-ant-secret-parse-9999';
    const onError = vi.fn();
    let capturedError: unknown;
    try {
      parseAnthropicMessagesResponse(`invalid token ${secretKey} returned`, {
        apiKey: secretKey,
        callbacks: { onError },
      });
    } catch (error) {
      capturedError = error;
    }
    expect(capturedError).toBeInstanceOf(AnthropicProtocolError);
    expect((capturedError as Error).message).toContain('JSON 解析失败');
    expect((capturedError as Error).message).not.toContain(secretKey);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
