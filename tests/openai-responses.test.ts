import { describe, expect, it, vi } from 'vitest';

import type {
  ChatMessage,
  MediaAttachment,
  ProviderProfile,
  StreamChatCallbacks,
} from '../src/domain/types';
import {
  buildOpenAiResponsesRequest,
  buildOpenAiResponsesStreamRequest,
  createSseEventParser,
  getOpenAiResponsesEndpoint,
  isOpenAiImageGenerationModel,
  isOpenAiModernChatModel,
  isOpenAiReasoningCapableModel,
  isOpenAiResponsesOnlyModel,
  openAiResponsesLimits,
  parseOpenAiResponsesResponse,
  parseOpenAiResponsesSseChunk,
  readOpenAiResponsesStream,
  resolveOpenAiResponsesReasoningOptions,
  sendOpenAiResponsesChat,
  supportsOpenAiResponsesStream,
  toOpenAiResponsesInput,
  toOpenAiResponsesInputItems,
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

  it('serializes the output limit only as max_output_tokens', () => {
    const request = buildOpenAiResponsesRequest({
      provider: provider(),
      modelId: 'gpt-5.2-pro',
      messages: [message('u1', 'user', 'Keep this bounded.')],
      maxOutputTokens: 4096,
    });

    expect(request.body.max_output_tokens).toBe(4096);
    expect(request.body).not.toHaveProperty('max_completion_tokens');
    expect(request.body).not.toHaveProperty('max_tokens');
    expect(() =>
      buildOpenAiResponsesRequest({
        provider: provider(),
        modelId: 'gpt-5.2-pro',
        messages: [message('u1', 'user', 'Invalid cap.')],
        maxOutputTokens: 63,
      })
    ).toThrow(/64–131072/);
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

function fullProvider(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-openai-test',
    capabilities: ['text', 'reasoning', 'web-search', 'streaming'],
    models: [],
    ...overrides,
  };
}

function makeSseStreamResponse(chunks: Array<string | Uint8Array>, headers: Record<string, string> = {}) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', ...headers },
  });
}

describe('modern OpenAI models, options, and encrypted continuation', () => {
  it('recognizes gpt-6/5/4.1/o3/o4 chat models and isolates gpt-image models', () => {
    expect(isOpenAiImageGenerationModel('gpt-image-2.5-sunburst')).toBe(true);
    expect(isOpenAiImageGenerationModel('gpt-image-2.6')).toBe(true);
    expect(isOpenAiImageGenerationModel('gpt-image-1.5')).toBe(true);
    expect(isOpenAiModernChatModel('gpt-image-2.5-sunburst')).toBe(false);
    expect(isOpenAiReasoningCapableModel('gpt-image-2.5-sunburst')).toBe(false);

    expect(isOpenAiModernChatModel('gpt-6.2-astra')).toBe(true);
    expect(isOpenAiModernChatModel('gpt-5.5')).toBe(true);
    expect(isOpenAiModernChatModel('gpt-4.1')).toBe(true);
    expect(isOpenAiModernChatModel('o3')).toBe(true);
    expect(isOpenAiModernChatModel('o4-mini')).toBe(true);

    expect(isOpenAiReasoningCapableModel('gpt-6.2-astra')).toBe(true);
    expect(isOpenAiReasoningCapableModel('gpt-4.1')).toBe(false);

    expect(supportsOpenAiResponsesStream(fullProvider(), 'gpt-6.2-astra')).toBe(true);
    expect(supportsOpenAiResponsesStream(fullProvider({ kind: 'new-api-relay' }), 'gpt-6.2-astra')).toBe(false);

    expect(resolveOpenAiResponsesReasoningOptions('gpt-6.2-astra', 'max', 'detailed')).toEqual({
      effort: 'xhigh',
      summary: 'detailed',
    });
    expect(resolveOpenAiResponsesReasoningOptions('gpt-4.1', 'high', 'auto')).toBeUndefined();
  });

  it('builds stream requests with web_search content types, include, and encrypted continuations', () => {
    const history: ChatMessage[] = [
      message('u1', 'user', 'Turn 1'),
      {
        ...message('a1', 'assistant', 'Answer 1'),
        providerContinuations: [
          {
            provider: 'openai',
            type: 'reasoning_encrypted',
            id: 'rs_enc_1',
            encryptedContent: 'enc_blob_abc',
            summary: ['Step 1'],
          },
          {
            provider: 'xai',
            type: 'reasoning_encrypted',
            encryptedContent: 'ignored_other_provider',
          },
        ],
      },
      message('u2', 'user', 'Turn 2'),
    ];

    const inputItems = toOpenAiResponsesInputItems(history, { continuationProvider: 'openai' });
    expect(inputItems).toHaveLength(4);
    expect(inputItems[1]).toEqual({
      type: 'reasoning',
      id: 'rs_enc_1',
      encrypted_content: 'enc_blob_abc',
      summary: [{ type: 'summary_text', text: 'Step 1' }],
    });
    expect(inputItems[2]).toEqual({
      role: 'assistant',
      content: [{ type: 'input_text', text: 'Answer 1' }],
    });

    const req = buildOpenAiResponsesStreamRequest({
      provider: fullProvider(),
      modelId: 'gpt-6.2-astra',
      messages: history,
      reasoningEffort: 'high',
      reasoningSummary: 'concise',
      webSearch: {
        enabled: true,
        searchContextSize: 'medium',
        searchContentTypes: ['text', 'image'],
      },
    });
    expect(req.url).toBe('https://api.openai.com/v1/responses');
    expect(req.body.stream).toBe(true);
    expect(req.body.reasoning).toEqual({ effort: 'high', summary: 'concise' });
    expect(req.body.tools).toEqual([
      {
        type: 'web_search',
        search_context_size: 'medium',
        search_content_types: ['text', 'image'],
      },
    ]);
    expect(req.body.include).toEqual(['web_search_call.results', 'reasoning.encrypted_content']);
  });
});

describe('OpenAI Responses SSE state machine and streaming', () => {
  it('parses SSE frames with ping comments and multi-byte UTF-8 split across chunks without [DONE]', async () => {
    const encoder = new TextEncoder();
    const chineseSummary = '正在检索实时信息并验证引用来源。';
    const summaryBytes = encoder.encode(chineseSummary);
    const splitPoint = 7; // 故意在多字节 UTF-8 字符中间切分

    const sseHead =
      ': ping - keep alive\n\n' +
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_sse_1","status":"in_progress"}}\n\n' +
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"rs_1","type":"reasoning","summary":[]}}\n\n' +
      'event: response.reasoning_summary_part.added\ndata: {"type":"response.reasoning_summary_part.added","item_id":"rs_1","summary_index":0}\n\n' +
      'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","item_id":"rs_1","delta":"';
    const sseMid = '"} \n\n';
    const sseTail =
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"id":"ws_1","type":"web_search_call","status":"in_progress"}}\n\n' +
      'event: response.web_search_call.searching\ndata: {"type":"response.web_search_call.searching","item_id":"ws_1","action":{"query":"OpenAI Responses SSE"}}\n\n' +
      'event: response.web_search_call.completed\ndata: {"type":"response.web_search_call.completed","item_id":"ws_1"}\n\n' +
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":1,"item":{"id":"ws_1","type":"web_search_call","status":"completed","action":{"query":"OpenAI Responses SSE"},"results":[{"title":"OpenAI Docs","url":"https://platform.openai.com/docs","snippet":"SSE guide"}]}}\n\n' +
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"rs_1","type":"reasoning","encrypted_content":"enc_xyz_999","summary":[{"type":"summary_text","text":"' +
      chineseSummary +
      '"}]}}\n\n' +
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","delta":"最终结论"}\n\n' +
      'event: response.output_text.annotation.added\ndata: {"type":"response.output_text.annotation.added","annotation":{"type":"url_citation","url":"https://platform.openai.com/docs","title":"OpenAI Docs","start_index":0,"end_index":4}}\n\n' +
      'event: response.output_text.annotation.added\ndata: {"type":"response.output_text.annotation.added","annotation":{"type":"url_citation","url":"http://127.0.0.1/evil","title":"Bad","start_index":0,"end_index":2}}\n\n' +
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_sse_1","status":"completed","output":[],"usage":{"input_tokens":18,"output_tokens":9,"total_tokens":27,"output_tokens_details":{"reasoning_tokens":5}}}}\n\n';

    const chunk1 = new Uint8Array([...encoder.encode(sseHead), ...summaryBytes.slice(0, splitPoint)]);
    const chunk2 = new Uint8Array([...summaryBytes.slice(splitPoint), ...encoder.encode(sseMid)]);
    const response = makeSseStreamResponse([chunk1, chunk2, sseTail]);

    const eventsOrder: string[] = [];
    const callbacks: StreamChatCallbacks = {
      onThinkingDelta: () => eventsOrder.push('thinkingDelta'),
      onThinkingComplete: () => eventsOrder.push('thinkingComplete'),
      onToolActivity: () => eventsOrder.push('toolActivity'),
      onTextDelta: () => eventsOrder.push('textDelta'),
      onCitations: () => eventsOrder.push('citations'),
      onContinuationBlocks: () => eventsOrder.push('continuationBlocks'),
      onUsage: () => eventsOrder.push('usage'),
      onDone: () => eventsOrder.push('done'),
    };

    const result = await readOpenAiResponsesStream(response, callbacks);
    expect(result.content).toBe('最终结论');
    expect(result.reasoningContent).toBe(chineseSummary);
    expect(result.thinkingDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.webSearchTriggered).toBe(true);
    expect(result.citations).toEqual([
      {
        url: 'https://platform.openai.com/docs',
        title: 'OpenAI Docs',
        startIndex: 0,
        endIndex: 4,
      },
    ]);
    expect(result.providerContinuations).toEqual([
      {
        provider: 'openai',
        type: 'reasoning_encrypted',
        id: 'rs_1',
        encryptedContent: 'enc_xyz_999',
        summary: [chineseSummary],
      },
    ]);
    expect(result.toolActivity?.[0]).toMatchObject({
      id: 'ws_1',
      toolName: 'web_search',
      status: 'completed',
    });
    expect(result.usage?.reasoningTokens).toBe(5);
    expect(eventsOrder).toContain('thinkingDelta');
    expect(eventsOrder).toContain('toolActivity');
    expect(eventsOrder).toContain('thinkingComplete');
    expect(eventsOrder).toContain('textDelta');
    expect(eventsOrder).toContain('citations');
    expect(eventsOrder).toContain('continuationBlocks');
    expect(eventsOrder).toContain('usage');
    expect(eventsOrder.at(-1)).toBe('done');
  });

  it('auto-falls back to JSON parsing when response Content-Type is application/json', async () => {
    const payload = {
      id: 'resp_json_fallback',
      status: 'completed',
      output: [
        {
          type: 'reasoning',
          encrypted_content: 'enc_json_1',
          summary: [{ type: 'summary_text', text: 'Thought in JSON' }],
        },
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'JSON answer' }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    };
    const response = new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    const onTextDelta = vi.fn();
    const onDone = vi.fn();
    const result = await readOpenAiResponsesStream(response, { onTextDelta, onDone });
    expect(result.content).toBe('JSON answer');
    expect(result.providerContinuations).toHaveLength(1);
    expect(onTextDelta).toHaveBeenCalledWith('JSON answer', 'JSON answer');
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('throws on response.failed, response.incomplete, premature EOF, and oversized SSE frame', async () => {
    expect(parseOpenAiResponsesSseChunk(': ping\n\n')).toEqual({ kind: 'comment' });
    expect(parseOpenAiResponsesSseChunk('data: [DONE]\n\n')).toEqual({ kind: 'done' });

    await expect(
      readOpenAiResponsesStream(
        makeSseStreamResponse([
          'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"message":"rate limit"}}}\n\n',
        ])
      )
    ).rejects.toThrow(/rate limit/);

    await expect(
      readOpenAiResponsesStream(
        makeSseStreamResponse([
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"halfway"}\n\n',
        ])
      )
    ).rejects.toThrow(/response\.completed/);

    const parser = createSseEventParser({ maxEventBytes: 32 });
    expect(() => parser.push(`data: ${'x'.repeat(64)}\n\n`)).toThrow(/上限/);
  });

  it('sends streaming request via sendOpenAiResponsesChat with injected fetchImpl', async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toBe('https://api.openai.com/v1/responses');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-openai-test');
      return makeSseStreamResponse([
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello!"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
      ]);
    };

    const result = await sendOpenAiResponsesChat({
      provider: fullProvider(),
      modelId: 'gpt-5.5',
      messages: [message('u1', 'user', 'Hi')],
      fetchImpl,
    });
    expect(result.content).toBe('Hello!');
  });

  it('merges CRLF split across chunk boundaries without prematurely splitting SSE frames', async () => {
    const parser = createSseEventParser();
    const framesA = parser.push('event: response.output_text.delta\r');
    const framesB = parser.push('\ndata: {"type":"response.output_text.delta",\r');
    const framesC = parser.push('\ndata: "delta":"你好"}\r\n\r\n');
    expect(framesA).toEqual([]);
    expect(framesB).toEqual([]);
    expect(framesC).toEqual([
      {
        event: 'response.output_text.delta',
        data: '{"type":"response.output_text.delta",\n"delta":"你好"}',
      },
    ]);

    const encoder = new TextEncoder();
    const crlfPayload = encoder.encode(
      'event: response.output_text.delta\r\ndata: {"delta":"跨越CRLF分片"}\r\n\r\n' +
        'event: response.completed\r\ndata: {"response":{"status":"completed","output":[]}}\r\n\r\n'
    );
    const twoByteChunks: Uint8Array[] = [];
    for (let i = 0; i < crlfPayload.length; i += 2) {
      twoByteChunks.push(crlfPayload.slice(i, i + 2));
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of twoByteChunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });
    const res = await readOpenAiResponsesStream(
      new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    );
    expect(res.content).toBe('跨越CRLF分片');
  });

  it('does not duplicate reasoning_summary on delta -> text.done -> part.done sequence', async () => {
    const response = makeSseStreamResponse([
      'event: response.reasoning_summary_part.added\ndata: {"type":"response.reasoning_summary_part.added"}\n\n',
      'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"第一段思考"}\n\n',
      'event: response.reasoning_summary_text.done\ndata: {"type":"response.reasoning_summary_text.done","text":"第一段思考"}\n\n',
      'event: response.reasoning_summary_part.done\ndata: {"type":"response.reasoning_summary_part.done","part":{"type":"summary_text","text":"第一段思考"}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"答案"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
    ]);

    const result = await readOpenAiResponsesStream(response);
    expect(result.reasoningContent).toBe('第一段思考');
    expect(result.content).toBe('答案');
  });

  it('does not trigger onThinkingComplete when reasoning item has no visible summary text', async () => {
    const onThinkingDelta = vi.fn();
    const onThinkingComplete = vi.fn();
    const response = makeSseStreamResponse([
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"rs_empty","type":"reasoning"}}\n\n',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"id":"rs_empty","type":"reasoning","encrypted_content":"enc_only"}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"直接回答"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
    ]);

    const result = await readOpenAiResponsesStream(response, {
      onThinkingDelta,
      onThinkingComplete,
    });
    expect(result.content).toBe('直接回答');
    expect(result.thinkingDurationMs).toBeUndefined();
    expect(onThinkingDelta).not.toHaveBeenCalled();
    expect(onThinkingComplete).not.toHaveBeenCalled();
    expect(result.providerContinuations).toHaveLength(1);
  });

  it('forwards assistant history message with empty content when reasoning_encrypted exists, while still rejecting truly empty messages', () => {
    const items = toOpenAiResponsesInputItems([
      message('u1', 'user', '问题 1'),
      {
        ...message('a1', 'assistant', ''),
        providerContinuations: [
          {
            provider: 'openai',
            type: 'reasoning_encrypted',
            id: 'rs_empty_text',
            encryptedContent: 'enc_only_payload',
          },
        ],
      },
      message('u2', 'user', '问题 2'),
    ]);

    expect(items).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: '问题 1' }] },
      { type: 'reasoning', id: 'rs_empty_text', encrypted_content: 'enc_only_payload' },
      { role: 'user', content: [{ type: 'input_text', text: '问题 2' }] },
    ]);

    expect(() =>
      toOpenAiResponsesInputItems([
        message('u1', 'user', '问题 1'),
        message('a1', 'assistant', ''),
      ])
    ).toThrow(/没有可发送的文本或附件/);
  });

  it('redacts apiKey across HTTP boundary, SSE error, and network errors in sendOpenAiResponsesChat', async () => {
    const secretKey = 'sk-openai-SECRET-KEY-BOUNDARY-987654321';
    const providerWithKey = fullProvider({ apiKey: secretKey });
    const paddedPrefix = 'X'.repeat(245);

    const onErrorHttp = vi.fn();
    await expect(
      sendOpenAiResponsesChat(
        {
          provider: providerWithKey,
          modelId: 'gpt-5.5',
          messages: [message('u1', 'user', 'Hi')],
          fetchImpl: async () => new Response(`${paddedPrefix} ${secretKey}`, { status: 401 }),
        },
        { onError: onErrorHttp }
      )
    ).rejects.toSatisfy((err: Error) => !err.message.includes(secretKey));
    expect(onErrorHttp).toHaveBeenCalledTimes(1);
    expect(onErrorHttp.mock.calls[0]?.[0]?.message).not.toContain('sk-openai-SECRET');

    const onErrorSse = vi.fn();
    await expect(
      sendOpenAiResponsesChat(
        {
          provider: providerWithKey,
          modelId: 'gpt-5.5',
          messages: [message('u1', 'user', 'Hi')],
          fetchImpl: async () =>
            makeSseStreamResponse([
              `event: error\ndata: {"error":{"message":"invalid token ${secretKey}"}}\n\n`,
            ]),
        },
        { onError: onErrorSse }
      )
    ).rejects.toSatisfy((err: Error) => !err.message.includes(secretKey));
    expect(onErrorSse).toHaveBeenCalledTimes(1);

    const onErrorNet = vi.fn();
    await expect(
      sendOpenAiResponsesChat(
        {
          provider: providerWithKey,
          modelId: 'gpt-5.5',
          messages: [message('u1', 'user', 'Hi')],
          fetchImpl: async () => {
            throw new Error(`network failure with ${secretKey}`);
          },
        },
        { onError: onErrorNet }
      )
    ).rejects.toSatisfy((err: Error) => !err.message.includes(secretKey));
    expect(onErrorNet).toHaveBeenCalledTimes(1);
  });

  it('aligns multi-part output_text annotation offsets and strips out-of-bounds indices in streaming', async () => {
    const response = makeSseStreamResponse([
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"PartA-"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"PartB"}\n\n',
      'event: response.output_text.annotation.added\ndata: {"type":"response.output_text.annotation.added","annotation":{"type":"url_citation","url":"https://docs.example.com/a","title":"DocA","start_index":0,"end_index":99999}}\n\n',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"PartA-","annotations":[{"type":"url_citation","url":"https://docs.example.com/a","title":"DocA","start_index":0,"end_index":5}]},{"type":"output_text","text":"PartB","annotations":[{"type":"url_citation","url":"https://docs.example.com/b","title":"DocB","start_index":0,"end_index":5}]}]}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"PartA-","annotations":[{"type":"url_citation","url":"https://docs.example.com/a","title":"DocA","start_index":0,"end_index":5}]},{"type":"output_text","text":"PartB","annotations":[{"type":"url_citation","url":"https://docs.example.com/b","title":"DocB","start_index":0,"end_index":5}]}]}]}}\n\n',
    ]);

    const result = await readOpenAiResponsesStream(response);
    expect(result.content).toBe('PartA-PartB');
    expect(result.citations).toEqual([
      { url: 'https://docs.example.com/a', title: 'DocA', startIndex: 0, endIndex: 5 },
      { url: 'https://docs.example.com/b', title: 'DocB', startIndex: 6, endIndex: 11 },
    ]);
  });

  it('cleans out-of-bounds citation indices even when SSE ends with [DONE] without response.completed', async () => {
    const response = makeSseStreamResponse([
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Short"}\n\n',
      'event: response.output_text.annotation.added\ndata: {"type":"response.output_text.annotation.added","annotation":{"type":"url_citation","url":"https://docs.example.com/done-only","title":"DoneOnly","start_index":0,"end_index":999}}\n\n',
      'data: [DONE]\n\n',
    ]);

    const citationUpdates: Array<Array<{ url: string; startIndex?: number; endIndex?: number }>> = [];
    const result = await readOpenAiResponsesStream(response, {
      onCitations: (items) => {
        citationUpdates.push(items);
      },
    });

    expect(result.content).toBe('Short');
    expect(result.citations).toEqual([
      { url: 'https://docs.example.com/done-only', title: 'DoneOnly' },
    ]);
    expect(result.citations?.[0]?.endIndex).toBeUndefined();
    expect(citationUpdates.at(-1)?.[0]?.endIndex).toBeUndefined();
  });
});
