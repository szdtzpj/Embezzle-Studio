import { describe, expect, it } from 'vitest';

import type { ChatMessage, MediaAttachment, ProviderProfile } from '../src/domain/types';
import {
  assertProviderWebSearchMessagesSupported,
  buildProviderWebSearchRequest,
  getProviderWebSearchEndpoint,
  parseProviderWebSearchResponse,
  resolveProviderWebSearchProtocol,
} from '../src/services/providerWebSearch';

function provider(
  kind: ProviderProfile['kind'],
  baseUrl: string,
  overrides: Partial<ProviderProfile> = {}
): ProviderProfile {
  return {
    id: `provider-${kind}`,
    name: kind,
    kind,
    baseUrl,
    capabilities: ['text', 'web-search'],
    models: [],
    ...overrides,
  };
}

function message(content = 'What changed today?', attachments?: MediaAttachment[]): ChatMessage {
  return {
    id: 'message-1',
    role: 'user',
    content,
    attachments,
    createdAt: 1,
    status: 'ready',
  };
}

const openAi = provider('custom', 'https://api.openai.com/v1/chat/completions');
const ark = provider('volcengine-ark', 'https://ark.cn-beijing.volces.com/api/v3');
const bailian = provider('bailian-compatible', 'https://dashscope.aliyuncs.com/compatible-mode/v1');

function completedResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'resp_test',
    status: 'completed',
    output: [
      {
        type: 'message',
        content: [{ type: 'output_text', text: 'No live search was needed.' }],
      },
    ],
    ...overrides,
  };
}

describe('provider Web Search request construction', () => {
  it('preflights non-OpenAI search transcripts before any attachment materialization', () => {
    expect(() => assertProviderWebSearchMessagesSupported(ark, [message()])).not.toThrow();
    expect(() => assertProviderWebSearchMessagesSupported(ark, [message('image', [{
      id: 'image-preflight',
      kind: 'image',
      uri: 'file:///private/image.png',
      name: 'image.png',
      mimeType: 'image/png',
    }])])).toThrow(/只允许纯文本/);
  });

  it('builds the official OpenAI Responses request with an optional context size', () => {
    const request = buildProviderWebSearchRequest({
      provider: openAi,
      modelId: ' gpt-5.6 ',
      messages: [message()],
      searchContextSize: 'medium',
      maxOutputTokens: 2048,
    });

    expect(request).toEqual({
      protocol: 'openai-official',
      url: 'https://api.openai.com/v1/responses',
      body: {
        model: 'gpt-5.6',
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: 'What changed today?' }],
          },
        ],
        tools: [{ type: 'web_search', search_context_size: 'medium' }],
        store: false,
        max_output_tokens: 2048,
      },
    });
    expect(request.body).not.toHaveProperty('max_completion_tokens');
    expect(request.body).not.toHaveProperty('max_tokens');
  });

  it('keeps OpenAI image input support through the existing Responses serializer', () => {
    const image: MediaAttachment = {
      id: 'image-1',
      kind: 'image',
      uri: 'https://images.example.com/news.png',
      name: 'news.png',
      mimeType: 'image/png',
    };
    const request = buildProviderWebSearchRequest({
      provider: openAi,
      modelId: 'gpt-5.6',
      messages: [message('Find this image.', [image])],
    });

    expect(request.body.input[0].content).toEqual([
      { type: 'input_text', text: 'Find this image.' },
      { type: 'input_image', image_url: 'https://images.example.com/news.png' },
    ]);
  });

  it('builds Ark Responses Web Search with conservative defaults', () => {
    expect(
      buildProviderWebSearchRequest({
        provider: ark,
        modelId: 'doubao-seed-2-1-pro-260628',
        messages: [message()],
        maxOutputTokens: 2048,
      })
    ).toEqual({
      protocol: 'volcengine-ark',
      url: 'https://ark.cn-beijing.volces.com/api/v3/responses',
      body: {
        model: 'doubao-seed-2-1-pro-260628',
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: 'What changed today?' }],
          },
        ],
        tools: [{ type: 'web_search', max_keyword: 3, limit: 10 }],
        max_output_tokens: 2048,
      },
    });
  });

  it('builds Bailian Responses Web Search for both legacy and workspace hosts', () => {
    const workspaceProvider = provider(
      'bailian-compatible',
      'https://llm-example.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/models'
    );
    const request = buildProviderWebSearchRequest({
      provider: workspaceProvider,
      modelId: 'qwen3.7-plus',
      messages: [message()],
      maxOutputTokens: 2048,
    });

    expect(request.protocol).toBe('bailian-compatible');
    expect(request.url).toBe(
      'https://llm-example.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/responses'
    );
    expect(request.body.tools).toEqual([{ type: 'web_search' }]);
    expect(request.body.max_output_tokens).toBe(2048);
    expect(request.body).not.toHaveProperty('max_completion_tokens');
    expect(request.body).not.toHaveProperty('max_tokens');
  });

  it('accepts the official Bailian US legacy host without broadening the allowlist', () => {
    const usProvider = provider(
      'bailian-compatible',
      'https://dashscope-us.aliyuncs.com/compatible-mode/v1/models'
    );
    const request = buildProviderWebSearchRequest({
      provider: usProvider,
      modelId: 'qwen-plus',
      messages: [message()],
      maxOutputTokens: 2048,
    });

    expect(resolveProviderWebSearchProtocol(usProvider)).toBe('bailian-compatible');
    expect(request.url).toBe('https://dashscope-us.aliyuncs.com/compatible-mode/v1/responses');
    expect(request.body.max_output_tokens).toBe(2048);
    expect(() =>
      resolveProviderWebSearchProtocol(
        provider(
          'bailian-compatible',
          'https://dashscope-us.aliyuncs.com.evil.example/compatible-mode/v1'
        )
      )
    ).toThrow();
  });

  it('rejects attachments for Ark and Bailian instead of guessing a multimodal wire shape', () => {
    const attachment: MediaAttachment = {
      id: 'image-1',
      kind: 'image',
      uri: 'https://images.example.com/news.png',
      name: 'news.png',
    };

    for (const currentProvider of [ark, bailian]) {
      expect(() =>
        buildProviderWebSearchRequest({
          provider: currentProvider,
          modelId: 'model',
          messages: [message('Inspect.', [attachment])],
        })
      ).toThrow(/只允许纯文本/);
    }
  });

  it('rejects OpenAI-only context controls on other protocols', () => {
    expect(() =>
      buildProviderWebSearchRequest({
        provider: ark,
        modelId: 'doubao-seed-2-1-pro-260628',
        messages: [message()],
        searchContextSize: 'high',
      })
    ).toThrow(/只适用于 OpenAI/);
  });

  it.each([
    ['OpenAI lookalike', provider('custom', 'https://api.openai.com.evil.example/v1')],
    ['OpenAI wrong kind', provider('new-api-relay', 'https://api.openai.com/v1')],
    ['Ark lookalike', provider('volcengine-ark', 'https://ark.cn-beijing.volces.com.evil.example/api/v3')],
    ['Ark custom kind', provider('custom', 'https://ark.cn-beijing.volces.com/api/v3')],
    ['Bailian lookalike', provider('bailian-compatible', 'https://dashscope.aliyuncs.com.evil.example/compatible-mode/v1')],
    ['plain HTTP', provider('custom', 'http://api.openai.com/v1')],
    ['unexpected path', provider('custom', 'https://api.openai.com/admin')],
    ['query-bearing URL', provider('custom', 'https://api.openai.com/v1?token=secret')],
  ])('fails closed for %s', (_label, currentProvider) => {
    expect(() => resolveProviderWebSearchProtocol(currentProvider)).toThrow();
  });

  it('normalizes only supported official endpoint forms', () => {
    expect(
      getProviderWebSearchEndpoint(
        provider('volcengine-ark', 'https://ark.cn-beijing.volcengineapi.com/api/v3/models/')
      )
    ).toBe('https://ark.cn-beijing.volcengineapi.com/api/v3/responses');
  });
});

describe('provider Web Search response parsing', () => {
  it('extracts content, reasoning, usage, HTTPS citations, and explicit call evidence', () => {
    const payload = completedResponse({
      output: [
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'Checked current sources.' }],
        },
        { type: 'web_search_call', id: 'ws_1', status: 'completed' },
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: 'Source A confirms it.',
              annotations: [
                {
                  type: 'url_citation',
                  start_index: 0,
                  end_index: 8,
                  url: 'https://Example.com/report',
                  title: 'Report',
                },
                {
                  type: 'url_citation',
                  start_index: 9,
                  end_index: 17,
                  url: 'https://example.com/report',
                  title: 'Duplicate',
                },
              ],
            },
          ],
        },
      ],
      usage: {
        input_tokens: 30,
        output_tokens: 8,
        total_tokens: 38,
        output_tokens_details: { reasoning_tokens: 3 },
      },
    });

    expect(parseProviderWebSearchResponse({ provider: openAi, payload })).toEqual({
      content: 'Source A confirms it.',
      reasoningContent: 'Checked current sources.',
      usage: {
        inputTokens: 30,
        outputTokens: 8,
        reasoningTokens: 3,
        cachedInputTokens: undefined,
        totalTokens: 38,
      },
      citations: [
        {
          url: 'https://example.com/report',
          title: 'Report',
          startIndex: 0,
          endIndex: 8,
        },
      ],
      webSearchTriggered: true,
    });
  });

  it('maps citation ranges onto the joined assistant output', () => {
    const payload = completedResponse({
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'First answer.' }],
        },
        {
          type: 'message',
          content: [
            { type: 'output_text', text: 'Then ' },
            {
              type: 'output_text',
              text: 'source.',
              annotations: [
                {
                  type: 'url_citation',
                  start_index: 0,
                  end_index: 6,
                  url: 'https://example.org/source',
                },
              ],
            },
          ],
        },
      ],
    });

    const result = parseProviderWebSearchResponse({ provider: ark, payload });
    expect(result.content).toBe('First answer.\n\nThen source.');
    expect(result.citations).toEqual([
      {
        url: 'https://example.org/source',
        startIndex: 20,
        endIndex: 26,
      },
    ]);
    expect(result.content.slice(result.citations[0].startIndex, result.citations[0].endIndex)).toBe(
      'source'
    );
  });

  it('does not claim that search ran without response evidence', () => {
    const result = parseProviderWebSearchResponse({ provider: openAi, payload: completedResponse() });
    expect(result.webSearchTriggered).toBe(false);
    expect(result.citations).toEqual([]);
  });

  it('treats a valid URL annotation as search evidence without a call item', () => {
    const payload = completedResponse({
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: 'Source',
              annotations: [
                {
                  type: 'url_citation',
                  start_index: 0,
                  end_index: 6,
                  url: 'https://example.com/',
                },
              ],
            },
          ],
        },
      ],
    });
    expect(parseProviderWebSearchResponse({ provider: openAi, payload }).webSearchTriggered).toBe(true);
  });

  it('does not mistake an ordinary hostname beginning with an IPv6-like prefix for a private address', () => {
    const payload = completedResponse({
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: 'Source',
              annotations: [
                {
                  type: 'url_citation',
                  start_index: 0,
                  end_index: 6,
                  url: 'https://fdic.gov/news/',
                },
              ],
            },
          ],
        },
      ],
    });
    expect(parseProviderWebSearchResponse({ provider: openAi, payload }).citations[0].url).toBe(
      'https://fdic.gov/news/'
    );
  });

  it('uses Bailian x_tools count as provider-specific evidence only', () => {
    const payload = completedResponse({
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        x_tools: { web_search: { count: 2 } },
      },
    });

    expect(parseProviderWebSearchResponse({ provider: bailian, payload }).webSearchTriggered).toBe(true);
    expect(parseProviderWebSearchResponse({ provider: openAi, payload }).webSearchTriggered).toBe(false);
  });

  it.each([
    ['plain HTTP', 'http://example.com/report'],
    ['credentials', 'https://user:password@example.com/report'],
    ['loopback', 'https://127.0.0.1/report'],
    ['local hostname', 'https://service.local/report'],
    ['single-label host', 'https://router/report'],
    ['internal suffix', 'https://svc.internal/report'],
    ['carrier-grade NAT', 'https://100.64.0.1/report'],
    ['documentation range', 'https://203.0.113.8/report'],
    ['IPv4-mapped IPv6', 'https://[::ffff:127.0.0.1]/report'],
  ])('discards malicious %s citation URLs without discarding the paid answer', (_label, url) => {
    const payload = completedResponse({
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: 'Source',
              annotations: [
                { type: 'url_citation', start_index: 0, end_index: 6, url },
              ],
            },
          ],
        },
      ],
    });
    expect(parseProviderWebSearchResponse({ provider: openAi, payload })).toMatchObject({
      content: 'Source',
      citations: [],
      webSearchTriggered: false,
    });
  });

  it.each([
    [-1, 2],
    [2, 2],
    [3, 2],
    [0, 7],
    [0.5, 2],
    [0, undefined],
  ])('discards invalid citation range %s..%s while preserving the answer', (start_index, end_index) => {
    const payload = completedResponse({
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: 'Source',
              annotations: [
                {
                  type: 'url_citation',
                  start_index,
                  end_index,
                  url: 'https://example.com/report',
                },
              ],
            },
          ],
        },
      ],
    });
    expect(parseProviderWebSearchResponse({ provider: openAi, payload })).toMatchObject({
      content: 'Source',
      citations: [],
      webSearchTriggered: false,
    });
  });

  it('rejects malformed Bailian tool evidence instead of guessing', () => {
    const payload = completedResponse({
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        x_tools: { web_search: { count: -1 } },
      },
    });
    expect(() => parseProviderWebSearchResponse({ provider: bailian, payload })).toThrow(/非负整数/);
  });

  it.each([
    [{ error: { message: 'provider rejected request' } }, /provider rejected request/],
    [{ status: 'failed', output: [] }, /Responses API/],
    [
      { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] },
      /max_output_tokens/,
    ],
    [{ status: 'queued', output: [] }, /Responses API/],
  ])('rejects unsuccessful response status %#', (payload, expected) => {
    expect(() => parseProviderWebSearchResponse({ provider: openAi, payload })).toThrow(expected);
  });
});
