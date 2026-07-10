import { describe, expect, it } from 'vitest';

import type { ChatMessage, MediaAttachment, ProviderProfile } from '../src/domain/types';
import {
  buildOpenAiResponsesRequest,
  getOpenAiResponsesEndpoint,
  isOpenAiResponsesOnlyModel,
  openAiResponsesLimits,
  parseOpenAiResponsesResponse,
  toOpenAiResponsesInput,
} from '../src/services/openAiResponses';

function provider(baseUrl = 'https://api.openai.com/v1'): Pick<ProviderProfile, 'baseUrl'> {
  return { baseUrl };
}

function message(
  id: string,
  role: ChatMessage['role'],
  content: string,
  attachments?: MediaAttachment[]
): ChatMessage {
  return {
    id,
    role,
    content,
    attachments,
    createdAt: 1,
    status: 'ready',
  };
}

function image(overrides: Partial<MediaAttachment> = {}): MediaAttachment {
  return {
    id: 'image-1',
    kind: 'image',
    uri: 'https://images.example.com/cat.png',
    name: 'cat.png',
    mimeType: 'image/png',
    ...overrides,
  };
}

function file(overrides: Partial<MediaAttachment> = {}): MediaAttachment {
  return {
    id: 'file-1',
    kind: 'file',
    uri: 'file:///notes.pdf',
    name: 'notes.pdf',
    mimeType: 'application/pdf',
    base64: 'YWJjZA==',
    ...overrides,
  };
}

describe('OpenAI Responses-only routing', () => {
  it.each([
    'gpt-5-pro',
    'gpt-5-pro-2025-10-06',
    'gpt-5.2-pro',
    'gpt-5.4-pro-2026-03-05',
    'gpt-5.5-pro',
    'o1-pro',
    'o1-pro-2025-03-19',
    'o3-pro',
    'o3-pro-2025-06-10',
  ])('routes %s on the official OpenAI host', (modelId) => {
    expect(isOpenAiResponsesOnlyModel(provider(), modelId)).toBe(true);
  });

  it.each([
    'gpt-5',
    'gpt-5.2',
    'gpt-5.2-chat-latest',
    'gpt-5.3-codex',
    'gpt-5.6-pro',
    'gpt-5.2-proxy',
    'o1',
    'o3',
    'o4-mini',
  ])('does not misroute ordinary model %s', (modelId) => {
    expect(isOpenAiResponsesOnlyModel(provider(), modelId)).toBe(false);
  });

  it.each([
    'https://api.openai.com.evil.example/v1',
    'https://openai.example/v1',
    'http://api.openai.com/v1',
    'not a url',
  ])('does not route a Pro model through non-official base URL %s', (baseUrl) => {
    expect(isOpenAiResponsesOnlyModel(provider(baseUrl), 'gpt-5-pro')).toBe(false);
  });

  it('normalizes supported official Base URL forms to /v1/responses', () => {
    expect(getOpenAiResponsesEndpoint(provider('https://api.openai.com'))).toBe(
      'https://api.openai.com/v1/responses'
    );
    expect(getOpenAiResponsesEndpoint(provider('https://api.openai.com/v1/chat/completions'))).toBe(
      'https://api.openai.com/v1/responses'
    );
  });
});

describe('Responses input and request body', () => {
  it('maps text, images, and Base64 files to Responses input content', () => {
    const input = toOpenAiResponsesInput([
      message('s1', 'system', 'Follow the policy.'),
      message('u1', 'user', 'Compare these images.', [
        image(),
        image({
          id: 'image-2',
          name: 'inline.jpg',
          uri: 'file:///ignored.jpg',
          mimeType: 'image/jpeg',
          base64: 'YWJjZA==',
        }),
        file(),
      ]),
      message('a1', 'assistant', 'Prior answer.'),
    ]);

    expect(input).toEqual([
      {
        role: 'system',
        content: [{ type: 'input_text', text: 'Follow the policy.' }],
      },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Compare these images.' },
          { type: 'input_image', image_url: 'https://images.example.com/cat.png' },
          { type: 'input_image', image_url: 'data:image/jpeg;base64,YWJjZA==' },
          {
            type: 'input_file',
            filename: 'notes.pdf',
            file_data: 'data:application/pdf;base64,YWJjZA==',
          },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'input_text', text: 'Prior answer.' }],
      },
    ]);
  });

  it.each([
    ['file URL', 'file:///tmp/cat.png'],
    ['loopback URL', 'https://127.0.0.1/cat.png'],
    ['private URL', 'https://192.168.1.4/cat.png'],
    ['local hostname', 'https://photos.local/cat.png'],
    ['plain HTTP URL', 'http://images.example.com/cat.png'],
  ])('rejects %s image inputs', (_label, uri) => {
    expect(() => toOpenAiResponsesInput([message('u1', 'user', 'Analyze.', [image({ uri })])])).toThrow(
      /图片/
    );
  });

  it('rejects unsupported video attachments and unfinished messages', () => {
    expect(() =>
      toOpenAiResponsesInput([
        message('u1', 'user', 'Watch.', [image({ kind: 'video', name: 'clip.mp4' })]),
      ])
    ).toThrow(/类型不受/);

    const pending = message('u2', 'user', 'Pending');
    pending.status = 'pending';
    expect(() => toOpenAiResponsesInput([pending])).toThrow(/尚未完成/);
  });

  it('builds a sampling-free Responses body with nested reasoning effort', () => {
    const request = buildOpenAiResponsesRequest({
      provider: provider(),
      modelId: 'gpt-5.2-pro',
      messages: [message('u1', 'user', 'Solve this.')],
      reasoningEffort: 'max',
    });

    expect(request).toEqual({
      url: 'https://api.openai.com/v1/responses',
      body: {
        model: 'gpt-5.2-pro',
        store: false,
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: 'Solve this.' }],
          },
        ],
        reasoning: { effort: 'xhigh' },
      },
    });
    expect(request.body).not.toHaveProperty('stream');
    expect(request.body).not.toHaveProperty('temperature');
    expect(request.body).not.toHaveProperty('top_p');
  });

  it('enforces documented Pro effort matrices and rejects ordinary models', () => {
    const args = {
      provider: provider(),
      messages: [message('u1', 'user', 'Hello')],
    };
    expect(
      buildOpenAiResponsesRequest({ ...args, modelId: 'gpt-5-pro', reasoningEffort: 'high' }).body.reasoning
    ).toEqual({ effort: 'high' });
    expect(() =>
      buildOpenAiResponsesRequest({ ...args, modelId: 'gpt-5-pro', reasoningEffort: 'medium' })
    ).toThrow(/仅支持 high/);
    expect(() =>
      buildOpenAiResponsesRequest({ ...args, modelId: 'gpt-5.2-pro', reasoningEffort: 'low' })
    ).toThrow(/仅支持 medium、high 和 xhigh/);
    expect(() =>
      buildOpenAiResponsesRequest({ ...args, modelId: 'o3-pro', reasoningEffort: 'off' })
    ).toThrow(/不支持关闭推理/);
    expect(() =>
      buildOpenAiResponsesRequest({ ...args, modelId: 'gpt-5.2', reasoningEffort: 'high' })
    ).toThrow(/不是 api\.openai\.com/);
  });

  it('rejects oversized text before constructing a request', () => {
    expect(() =>
      toOpenAiResponsesInput([
        message('u1', 'user', 'x'.repeat(openAiResponsesLimits.maxInputTextCharacters + 1)),
      ])
    ).toThrow(/输入文本过长/);
  });
});

describe('non-streaming Responses parsing', () => {
  it('extracts output text, reasoning summaries, and token usage', () => {
    const payload = {
      id: 'resp_123',
      object: 'response',
      status: 'completed',
      output: [
        {
          id: 'rs_1',
          type: 'reasoning',
          summary: [
            { type: 'summary_text', text: 'Checked the constraints.' },
            { type: 'summary_text', text: 'Verified the result.' },
          ],
        },
        {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'output_text', text: 'The answer is ' },
            { type: 'output_text', text: '42.' },
          ],
        },
      ],
      usage: {
        input_tokens: 20,
        output_tokens: 12,
        total_tokens: 32,
        input_tokens_details: { cached_tokens: 5 },
        output_tokens_details: { reasoning_tokens: 7 },
      },
    };

    expect(parseOpenAiResponsesResponse(JSON.stringify(payload))).toEqual({
      content: 'The answer is 42.',
      reasoningContent: 'Checked the constraints.\n\nVerified the result.',
      usage: {
        inputTokens: 20,
        outputTokens: 12,
        reasoningTokens: 7,
        cachedInputTokens: 5,
        totalTokens: 32,
      },
      raw: payload,
    });
  });

  it('supports an SDK-style top-level output_text fallback', () => {
    expect(
      parseOpenAiResponsesResponse({
        object: 'response',
        status: 'completed',
        output_text: 'Fallback text',
        output: [],
      }).content
    ).toBe('Fallback text');
  });

  it.each([
    [{ error: { message: 'bad request' } }, /bad request/],
    [{ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }, /未完成结果/],
    [{ status: 'completed', output: 'not-an-array' }, /output 必须是数组/],
    [{ status: 'completed', output: [] }, /没有返回输出文本/],
    ['{not-json', /无法解析/],
  ])('rejects malformed or unsuccessful payload %#', (payload, expected) => {
    expect(() => parseOpenAiResponsesResponse(payload)).toThrow(expected);
  });

  it('rejects oversized raw JSON before parsing it', () => {
    const oversized = `{"output_text":"${'x'.repeat(openAiResponsesLimits.maxResponseJsonBytes)}"}`;
    expect(() => parseOpenAiResponsesResponse(oversized)).toThrow(/JSON 超过/);
  });
});
