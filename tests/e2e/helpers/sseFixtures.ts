/**
 * 多协议标准 SSE / JSON / 联网搜索 / 生图响应夹具工厂。
 * 严格遵循各官方服务商协议结构，用于 E2E 测试（禁止与业务解析器共享私有实现）。
 */

/** 最小合法 1x1 透明 PNG Base64 常量 */
export const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/**
 * 格式化标准 SSE 事件帧（自动处理字符串与 JSON 对象序列化，以 `\n\n` 结尾）。
 */
export function formatSseEvent(eventName: string | undefined, data: unknown): string {
  const serialized = typeof data === 'string' ? data : JSON.stringify(data);
  const lines: string[] = [];
  if (eventName) {
    lines.push(`event: ${eventName}`);
  }
  for (const line of serialized.split(/\r?\n/)) {
    lines.push(`data: ${line}`);
  }
  return `${lines.join('\n')}\n\n`;
}

/**
 * 生成 OpenAI / DeepSeek 兼容协议标准的 SSE 终止帧。
 */
export function makeDoneChunk(): string {
  return 'data: [DONE]\n\n';
}

/**
 * 生成高频文本增量列表，用于 Tier 4 200+ chunks 主线程 Long Task 压力测试。
 */
export function generateHighFrequencyTextDeltas(
  totalChunks: number,
  tokenPrefix = 'token-'
): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < totalChunks; i += 1) {
    chunks.push(`${tokenPrefix}${i} `);
  }
  return chunks;
}

export interface OpenAiChatSseOptions {
  id?: string;
  model?: string;
  reasoningDeltas?: string[];
  textDeltas: string[];
  toolCalls?: Array<{
    index: number;
    id: string;
    name: string;
    argumentsJson: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  includeDone?: boolean;
}

export function buildOpenAiChatSseChunks(options: OpenAiChatSseOptions): string[] {
  const id = options.id ?? 'chatcmpl-e2e-1';
  const model = options.model ?? 'gpt-4.1';
  const chunks: string[] = [];

  for (const reasoning of options.reasoningDeltas ?? []) {
    chunks.push(
      formatSseEvent(undefined, {
        id,
        object: 'chat.completion.chunk',
        model,
        choices: [{ index: 0, delta: { reasoning_content: reasoning }, finish_reason: null }],
      })
    );
  }

  for (const call of options.toolCalls ?? []) {
    chunks.push(
      formatSseEvent(undefined, {
        id,
        object: 'chat.completion.chunk',
        model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: call.index,
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: call.argumentsJson },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })
    );
  }

  for (const delta of options.textDeltas) {
    chunks.push(
      formatSseEvent(undefined, {
        id,
        object: 'chat.completion.chunk',
        model,
        choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
      })
    );
  }

  chunks.push(
    formatSseEvent(undefined, {
      id,
      object: 'chat.completion.chunk',
      model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: options.toolCalls?.length ? 'tool_calls' : 'stop',
        },
      ],
      ...(options.usage ? { usage: options.usage } : {}),
    })
  );

  if (options.includeDone !== false) {
    chunks.push(makeDoneChunk());
  }
  return chunks;
}

export interface OpenAiResponsesCitation {
  url: string;
  title?: string;
  start_index?: number;
  end_index?: number;
}

export interface OpenAiResponsesOptions {
  responseId?: string;
  model?: string;
  reasoningSummaryDeltas?: string[];
  encryptedReasoningContent?: string;
  webSearchQuery?: string;
  webSearchActionType?: 'web_search_call' | 'x_search_call';
  citations?: OpenAiResponsesCitation[];
  imageGenerationCall?: {
    id?: string;
    b64Result: string;
    revisedPrompt?: string;
  };
  textDeltas: string[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    reasoning_tokens?: number;
    total_tokens?: number;
  };
  omitCompleted?: boolean;
}

export function buildOpenAiResponsesSseChunks(options: OpenAiResponsesOptions): string[] {
  const responseId = options.responseId ?? 'resp_e2e_1';
  const model = options.model ?? 'gpt-5';
  const chunks: string[] = [];
  const finalOutput: unknown[] = [];

  chunks.push(
    formatSseEvent('response.created', {
      type: 'response.created',
      response: { id: responseId, object: 'response', status: 'in_progress', model },
    })
  );

  if (options.webSearchQuery) {
    const searchItemId = 'ws_e2e_1';
    const isXSearch = options.webSearchActionType === 'x_search_call';
    const callType = isXSearch ? 'x_search_call' : 'web_search_call';
    chunks.push(
      formatSseEvent('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: finalOutput.length,
        item: { id: searchItemId, type: callType, status: 'in_progress' },
      }),
      formatSseEvent('response.web_search_call.in_progress', {
        type: 'response.web_search_call.in_progress',
        item_id: searchItemId,
      }),
      formatSseEvent('response.web_search_call.searching', {
        type: 'response.web_search_call.searching',
        item_id: searchItemId,
      }),
      formatSseEvent('response.web_search_call.completed', {
        type: 'response.web_search_call.completed',
        item_id: searchItemId,
      }),
      formatSseEvent('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: finalOutput.length,
        item: {
          id: searchItemId,
          type: callType,
          status: 'completed',
          action: { type: 'search', query: options.webSearchQuery },
        },
      })
    );
    finalOutput.push({
      id: searchItemId,
      type: callType,
      status: 'completed',
      action: { type: 'search', query: options.webSearchQuery },
    });
  }

  if (options.reasoningSummaryDeltas?.length || options.encryptedReasoningContent) {
    const reasoningId = 'rs_e2e_1';
    const reasoningItem = {
      id: reasoningId,
      type: 'reasoning',
      summary: (options.reasoningSummaryDeltas ?? []).map((text) => ({
        type: 'summary_text',
        text,
      })),
      ...(options.encryptedReasoningContent
        ? { encrypted_content: options.encryptedReasoningContent }
        : {}),
    };
    chunks.push(
      formatSseEvent('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: finalOutput.length,
        item: { id: reasoningId, type: 'reasoning', summary: [] },
      })
    );
    for (const delta of options.reasoningSummaryDeltas ?? []) {
      chunks.push(
        formatSseEvent('response.reasoning_summary_text.delta', {
          type: 'response.reasoning_summary_text.delta',
          item_id: reasoningId,
          summary_index: 0,
          delta,
        })
      );
    }
    chunks.push(
      formatSseEvent('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: finalOutput.length,
        item: reasoningItem,
      })
    );
    finalOutput.push(reasoningItem);
  }

  if (options.imageGenerationCall) {
    const imgId = options.imageGenerationCall.id ?? 'ig_e2e_1';
    const imgItem = {
      id: imgId,
      type: 'image_generation_call',
      status: 'completed',
      result: options.imageGenerationCall.b64Result,
      ...(options.imageGenerationCall.revisedPrompt
        ? { revised_prompt: options.imageGenerationCall.revisedPrompt }
        : {}),
    };
    chunks.push(
      formatSseEvent('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: finalOutput.length,
        item: { id: imgId, type: 'image_generation_call', status: 'in_progress' },
      }),
      formatSseEvent('response.image_generation_call.completed', {
        type: 'response.image_generation_call.completed',
        item_id: imgId,
        result: options.imageGenerationCall.b64Result,
      }),
      formatSseEvent('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: finalOutput.length,
        item: imgItem,
      })
    );
    finalOutput.push(imgItem);
  }

  const msgId = 'msg_e2e_1';
  const msgIdx = finalOutput.length;
  const fullText = options.textDeltas.join('');
  const annotations = (options.citations ?? []).map((c) => ({
    type: 'url_citation',
    url: c.url,
    title: c.title,
    start_index: c.start_index ?? 0,
    end_index: c.end_index ?? fullText.length,
  }));

  chunks.push(
    formatSseEvent('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: msgIdx,
      item: { id: msgId, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
    })
  );

  for (const delta of options.textDeltas) {
    chunks.push(
      formatSseEvent('response.output_text.delta', {
        type: 'response.output_text.delta',
        item_id: msgId,
        output_index: msgIdx,
        content_index: 0,
        delta,
      })
    );
  }

  for (const annotation of annotations) {
    chunks.push(
      formatSseEvent('response.output_text.annotation.added', {
        type: 'response.output_text.annotation.added',
        item_id: msgId,
        output_index: msgIdx,
        content_index: 0,
        annotation,
      })
    );
  }

  const messageItem = {
    id: msgId,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [
      {
        type: 'output_text',
        text: fullText,
        annotations,
      },
    ],
  };

  chunks.push(
    formatSseEvent('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: msgIdx,
      item: messageItem,
    })
  );
  finalOutput.push(messageItem);

  if (!options.omitCompleted) {
    chunks.push(
      formatSseEvent('response.completed', {
        type: 'response.completed',
        response: {
          id: responseId,
          object: 'response',
          status: 'completed',
          model,
          output_text: fullText,
          output: finalOutput,
          usage: options.usage ?? {
            input_tokens: 20,
            output_tokens: 15,
            total_tokens: 35,
          },
        },
      })
    );
  }

  return chunks;
}

export function buildOpenAiResponsesJson(options: OpenAiResponsesOptions): Record<string, unknown> {
  const fullText = options.textDeltas.join('');
  const output: unknown[] = [];

  if (options.webSearchQuery) {
    output.push({
      id: 'ws_e2e_1',
      type: options.webSearchActionType ?? 'web_search_call',
      status: 'completed',
      action: { type: 'search', query: options.webSearchQuery },
    });
  }

  if (options.reasoningSummaryDeltas?.length || options.encryptedReasoningContent) {
    output.push({
      id: 'rs_e2e_1',
      type: 'reasoning',
      summary: (options.reasoningSummaryDeltas ?? []).map((text) => ({
        type: 'summary_text',
        text,
      })),
      ...(options.encryptedReasoningContent
        ? { encrypted_content: options.encryptedReasoningContent }
        : {}),
    });
  }

  if (options.imageGenerationCall) {
    output.push({
      id: options.imageGenerationCall.id ?? 'ig_e2e_1',
      type: 'image_generation_call',
      status: 'completed',
      result: options.imageGenerationCall.b64Result,
      ...(options.imageGenerationCall.revisedPrompt
        ? { revised_prompt: options.imageGenerationCall.revisedPrompt }
        : {}),
    });
  }

  output.push({
    id: 'msg_e2e_1',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [
      {
        type: 'output_text',
        text: fullText,
        annotations: (options.citations ?? []).map((c) => ({
          type: 'url_citation',
          url: c.url,
          title: c.title,
          start_index: c.start_index ?? 0,
          end_index: c.end_index ?? fullText.length,
        })),
      },
    ],
  });

  return {
    id: options.responseId ?? 'resp_e2e_1',
    object: 'response',
    status: 'completed',
    model: options.model ?? 'gpt-5',
    output_text: fullText,
    output,
    usage: options.usage ?? {
      input_tokens: 20,
      output_tokens: 15,
      total_tokens: 35,
    },
  };
}

export interface AnthropicMessagesSseOptions {
  messageId?: string;
  model?: string;
  thinkingBlocks?: Array<{ thinking: string; signature: string }>;
  redactedThinkingData?: string;
  serverWebSearch?: {
    toolUseId?: string;
    query: string;
    results: Array<{ url: string; title: string; encrypted_content?: string }>;
  };
  textDeltas: string[];
  citations?: Array<{
    type: 'web_search_result_location';
    url: string;
    title: string;
    cited_text: string;
    encrypted_index?: string;
  }>;
  stopReason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  omitMessageStop?: boolean;
}

/**
 * 构造 Anthropic Claude `/v1/messages` 原生 SSE 流（严格不包含 `data: [DONE]`）。
 */
export function buildAnthropicMessagesSseChunks(options: AnthropicMessagesSseOptions): string[] {
  const messageId = options.messageId ?? 'msg_anthropic_e2e_1';
  const model = options.model ?? 'claude-sonnet-4-6';
  const chunks: string[] = [];
  let blockIndex = 0;

  chunks.push(
    formatSseEvent('message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: options.usage?.input_tokens ?? 25, output_tokens: 0 },
      },
    })
  );

  for (const tb of options.thinkingBlocks ?? []) {
    const idx = blockIndex++;
    chunks.push(
      formatSseEvent('content_block_start', {
        type: 'content_block_start',
        index: idx,
        content_block: { type: 'thinking', thinking: '' },
      }),
      formatSseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: idx,
        delta: { type: 'thinking_delta', thinking: tb.thinking },
      }),
      formatSseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: idx,
        delta: { type: 'signature_delta', signature: tb.signature },
      }),
      formatSseEvent('content_block_stop', {
        type: 'content_block_stop',
        index: idx,
      })
    );
  }

  if (options.redactedThinkingData) {
    const idx = blockIndex++;
    chunks.push(
      formatSseEvent('content_block_start', {
        type: 'content_block_start',
        index: idx,
        content_block: {
          type: 'redacted_thinking',
          data: options.redactedThinkingData,
        },
      }),
      formatSseEvent('content_block_stop', {
        type: 'content_block_stop',
        index: idx,
      })
    );
  }

  if (options.serverWebSearch) {
    const toolUseId = options.serverWebSearch.toolUseId ?? 'srvtoolu_e2e_1';
    const useIdx = blockIndex++;
    chunks.push(
      formatSseEvent('content_block_start', {
        type: 'content_block_start',
        index: useIdx,
        content_block: {
          type: 'server_tool_use',
          id: toolUseId,
          name: 'web_search',
          input: {},
        },
      }),
      formatSseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: useIdx,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify({ query: options.serverWebSearch.query }),
        },
      }),
      formatSseEvent('content_block_stop', {
        type: 'content_block_stop',
        index: useIdx,
      })
    );

    const resultIdx = blockIndex++;
    chunks.push(
      formatSseEvent('content_block_start', {
        type: 'content_block_start',
        index: resultIdx,
        content_block: {
          type: 'web_search_tool_result',
          tool_use_id: toolUseId,
          content: options.serverWebSearch.results.map((item) => ({
            type: 'web_search_result',
            url: item.url,
            title: item.title,
            ...(item.encrypted_content ? { encrypted_content: item.encrypted_content } : {}),
          })),
        },
      }),
      formatSseEvent('content_block_stop', {
        type: 'content_block_stop',
        index: resultIdx,
      })
    );
  }

  const textIdx = blockIndex++;
  chunks.push(
    formatSseEvent('content_block_start', {
      type: 'content_block_start',
      index: textIdx,
      content_block: { type: 'text', text: '' },
    })
  );

  for (const delta of options.textDeltas) {
    chunks.push(
      formatSseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: textIdx,
        delta: { type: 'text_delta', text: delta },
      })
    );
  }

  for (const citation of options.citations ?? []) {
    chunks.push(
      formatSseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: textIdx,
        delta: { type: 'citations_delta', citation },
      })
    );
  }

  chunks.push(
    formatSseEvent('content_block_stop', {
      type: 'content_block_stop',
      index: textIdx,
    }),
    formatSseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: options.stopReason ?? 'end_turn', stop_sequence: null },
      usage: { output_tokens: options.usage?.output_tokens ?? 18 },
    })
  );

  if (!options.omitMessageStop) {
    chunks.push(
      formatSseEvent('message_stop', {
        type: 'message_stop',
      })
    );
  }

  return chunks;
}

export interface GeminiSseOptions {
  modelVersion?: string;
  thoughtParts?: Array<{ text: string; thoughtSignature?: string }>;
  textDeltas: string[];
  finalThoughtSignature?: string;
  inlineImages?: Array<{ mimeType: string; data: string; thoughtSignature?: string }>;
  webSearchQueries?: string[];
  groundingChunks?: Array<{ uri: string; title: string }>;
  groundingSupports?: Array<Record<string, unknown>>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
}

/**
 * 构造 Google Gemini `streamGenerateContent?alt=sse` 响应帧（无 `event:` 前缀，无 `[DONE]`）。
 */
export function buildGeminiStreamSseChunks(options: GeminiSseOptions): string[] {
  const modelVersion = options.modelVersion ?? 'gemini-2.5-pro';
  const chunks: string[] = [];

  for (const thought of options.thoughtParts ?? []) {
    chunks.push(
      formatSseEvent(undefined, {
        modelVersion,
        candidates: [
          {
            index: 0,
            content: {
              role: 'model',
              parts: [
                {
                  text: thought.text,
                  thought: true,
                  ...(thought.thoughtSignature ? { thoughtSignature: thought.thoughtSignature } : {}),
                },
              ],
            },
          },
        ],
      })
    );
  }

  const hasGrounding = Boolean(options.groundingChunks?.length || options.webSearchQueries?.length);
  const groundingMetadata = hasGrounding
    ? {
        ...(options.webSearchQueries ? { webSearchQueries: options.webSearchQueries } : {}),
        groundingChunks: (options.groundingChunks ?? []).map((c) => ({
          web: { uri: c.uri, title: c.title },
        })),
        ...(options.groundingSupports ? { groundingSupports: options.groundingSupports } : {}),
      }
    : undefined;

  const hasInlineImages = Boolean(options.inlineImages?.length);

  for (let idx = 0; idx < options.textDeltas.length; idx += 1) {
    const isLastText = idx === options.textDeltas.length - 1;
    const isFinalStreamFrame = isLastText && !hasInlineImages;
    const part: Record<string, unknown> = { text: options.textDeltas[idx] };
    if (isLastText && options.finalThoughtSignature) {
      part.thoughtSignature = options.finalThoughtSignature;
    }
    const candidate: Record<string, unknown> = {
      index: 0,
      content: { role: 'model', parts: [part] },
    };

    if (isFinalStreamFrame) {
      candidate.finishReason = 'STOP';
      if (groundingMetadata) {
        candidate.groundingMetadata = groundingMetadata;
      }
    }

    chunks.push(
      formatSseEvent(undefined, {
        modelVersion,
        candidates: [candidate],
        ...(isFinalStreamFrame && options.usageMetadata
          ? { usageMetadata: options.usageMetadata }
          : {}),
      })
    );
  }

  if (options.inlineImages?.length) {
    const imageCandidate: Record<string, unknown> = {
      index: 0,
      finishReason: 'STOP',
      content: {
        role: 'model',
        parts: options.inlineImages.map((img) => ({
          inlineData: { mimeType: img.mimeType, data: img.data },
          ...(img.thoughtSignature ? { thoughtSignature: img.thoughtSignature } : {}),
        })),
      },
      ...(groundingMetadata ? { groundingMetadata } : {}),
    };

    chunks.push(
      formatSseEvent(undefined, {
        modelVersion,
        candidates: [imageCandidate],
        ...(options.usageMetadata ? { usageMetadata: options.usageMetadata } : {}),
      })
    );
  } else if (
    options.textDeltas.length === 0 &&
    (groundingMetadata || options.usageMetadata || options.finalThoughtSignature || options.thoughtParts?.length)
  ) {
    // 仅有 grounding / thought / usage 而无文本和图片时，补发终止帧承载 finishReason 与 groundingMetadata
    const tailCandidate: Record<string, unknown> = {
      index: 0,
      finishReason: 'STOP',
      content: {
        role: 'model',
        parts: [
          {
            text: '',
            ...(options.finalThoughtSignature ? { thoughtSignature: options.finalThoughtSignature } : {}),
          },
        ],
      },
      ...(groundingMetadata ? { groundingMetadata } : {}),
    };

    chunks.push(
      formatSseEvent(undefined, {
        modelVersion,
        candidates: [tailCandidate],
        ...(options.usageMetadata ? { usageMetadata: options.usageMetadata } : {}),
      })
    );
  }

  return chunks;
}

export function buildGeminiGenerateContentJson(options: GeminiSseOptions): Record<string, unknown> {
  const parts: Array<Record<string, unknown>> = [];

  for (const thought of options.thoughtParts ?? []) {
    parts.push({
      text: thought.text,
      thought: true,
      ...(thought.thoughtSignature ? { thoughtSignature: thought.thoughtSignature } : {}),
    });
  }

  const combinedText = options.textDeltas.join('');
  if (combinedText.length > 0) {
    parts.push({
      text: combinedText,
      ...(options.finalThoughtSignature ? { thoughtSignature: options.finalThoughtSignature } : {}),
    });
  }

  for (const img of options.inlineImages ?? []) {
    parts.push({
      inlineData: { mimeType: img.mimeType, data: img.data },
      ...(img.thoughtSignature ? { thoughtSignature: img.thoughtSignature } : {}),
    });
  }

  const candidate: Record<string, unknown> = {
    index: 0,
    finishReason: 'STOP',
    content: { role: 'model', parts },
  };

  if (options.groundingChunks?.length || options.webSearchQueries?.length) {
    candidate.groundingMetadata = {
      ...(options.webSearchQueries ? { webSearchQueries: options.webSearchQueries } : {}),
      groundingChunks: (options.groundingChunks ?? []).map((c) => ({
        web: { uri: c.uri, title: c.title },
      })),
      ...(options.groundingSupports ? { groundingSupports: options.groundingSupports } : {}),
    };
  }

  return {
    modelVersion: options.modelVersion ?? 'gemini-2.5-pro',
    candidates: [candidate],
    usageMetadata: options.usageMetadata ?? {
      promptTokenCount: 22,
      candidatesTokenCount: 16,
      totalTokenCount: 38,
    },
  };
}

/**
 * xAI Grok Responses API SSE / JSON 夹具（复用 Responses 协议，支持 web_search / x_search 与 encrypted_content）。
 */
export function buildXaiResponsesSseChunks(options: OpenAiResponsesOptions): string[] {
  return buildOpenAiResponsesSseChunks({
    model: 'grok-4.3',
    ...options,
  });
}

export function buildXaiResponsesJson(options: OpenAiResponsesOptions): Record<string, unknown> {
  return buildOpenAiResponsesJson({
    model: 'grok-4.3',
    ...options,
  });
}

/**
 * xAI 旧版 `search_parameters` 废弃 410 GONE 错误夹具。
 */
export function buildXaiDeprecatedSearchParameters410Response(): {
  error: string;
  code: string;
} {
  return {
    error:
      'Live search via search_parameters is deprecated. Please switch to the Agent Tools API (web_search / x_search) on /v1/responses.',
    code: 'GONE',
  };
}

export interface DeepSeekChatSseOptions {
  id?: string;
  model?: string;
  reasoningDeltas?: string[];
  serverToolCalls?: Array<{
    id: string;
    type: 'deepseek_web_search' | 'deepseek_read_url';
    input?: unknown;
    output?: unknown;
  }>;
  textDeltas: string[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  includeDone?: boolean;
}

/**
 * DeepSeek 官方流式聊天与内置工具（`deepseek_web_search` / `deepseek_read_url` / `server_tool_calls`）夹具。
 */
export function buildDeepSeekChatSseChunks(options: DeepSeekChatSseOptions): string[] {
  const id = options.id ?? 'ds-chatcmpl-e2e-1';
  const model = options.model ?? 'deepseek-v4-pro';
  const chunks: string[] = [];

  for (const reasoning of options.reasoningDeltas ?? []) {
    chunks.push(
      formatSseEvent(undefined, {
        id,
        object: 'chat.completion.chunk',
        model,
        choices: [{ index: 0, delta: { reasoning_content: reasoning }, finish_reason: null }],
      })
    );
  }

  if (options.serverToolCalls?.length) {
    chunks.push(
      formatSseEvent(undefined, {
        id,
        object: 'chat.completion.chunk',
        model,
        choices: [
          {
            index: 0,
            delta: {
              server_tool_calls: options.serverToolCalls,
            },
            finish_reason: null,
          },
        ],
      })
    );
  }

  for (const delta of options.textDeltas) {
    chunks.push(
      formatSseEvent(undefined, {
        id,
        object: 'chat.completion.chunk',
        model,
        choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
      })
    );
  }

  chunks.push(
    formatSseEvent(undefined, {
      id,
      object: 'chat.completion.chunk',
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      ...(options.usage ? { usage: options.usage } : {}),
    })
  );

  if (options.includeDone !== false) {
    chunks.push(makeDoneChunk());
  }

  return chunks;
}

export interface SearchResultFixtureItem {
  title: string;
  url: string;
  snippet: string;
  content?: string;
  date?: string;
  siteName?: string;
}

export function buildDeepSeekToolsSearchJson(
  results: SearchResultFixtureItem[]
): Record<string, unknown> {
  return {
    results: results.map((item, idx) => ({
      title: item.title,
      url: item.url,
      snippet: item.snippet,
      summary: item.snippet,
      content: item.content ?? item.snippet,
      date: item.date ?? '2026-11-20',
      authority: 'high',
      rerank_score: Math.max(0.1, 1 - idx * 0.1),
    })),
  };
}

export function buildBochaSearchJson(
  results: SearchResultFixtureItem[]
): Record<string, unknown> {
  return {
    code: 200,
    data: {
      webPages: {
        value: results.map((item) => ({
          name: item.title,
          url: item.url,
          snippet: item.snippet,
          summary: item.content ?? item.snippet,
          siteName: item.siteName ?? 'Example',
          dateLastCrawled: item.date ?? '2026-11-20T00:00:00Z',
        })),
      },
    },
  };
}

export function buildExaSearchJson(
  results: SearchResultFixtureItem[]
): Record<string, unknown> {
  return {
    requestId: 'exa-req-e2e-1',
    resolvedSearchType: 'neural',
    results: results.map((item, idx) => ({
      id: `exa-${idx + 1}`,
      title: item.title,
      url: item.url,
      publishedDate: item.date ?? '2026-11-20',
      author: item.siteName ?? 'Author',
      highlights: [item.snippet],
      text: item.content ?? item.snippet,
    })),
  };
}

export function buildSearxngSearchJson(
  query: string,
  results: SearchResultFixtureItem[]
): Record<string, unknown> {
  return {
    query,
    number_of_results: results.length,
    results: results.map((item) => ({
      title: item.title,
      url: item.url,
      content: item.content ?? item.snippet,
      engine: 'duckduckgo',
      category: 'general',
    })),
    unresponsive_engines: [],
  };
}

export interface ImageGenerationFixtureOptions {
  b64Json?: string;
  url?: string;
  revisedPrompt?: string;
  count?: number;
  mimeType?: string;
}

export function buildOpenAiImageGenerationJson(
  options: ImageGenerationFixtureOptions = {}
): Record<string, unknown> {
  const count = Math.max(1, options.count ?? 1);
  const b64 = options.b64Json ?? TINY_PNG_BASE64;
  const data = Array.from({ length: count }, (_, idx) => ({
    ...(options.url ? { url: options.url } : { b64_json: b64 }),
    ...(options.revisedPrompt
      ? { revised_prompt: count > 1 ? `${options.revisedPrompt} #${idx + 1}` : options.revisedPrompt }
      : {}),
  }));

  return {
    created: 1764000000,
    data,
    usage: { input_tokens: 12, output_tokens: 1024, total_tokens: 1036 },
  };
}

export function buildXaiImageGenerationJson(
  options: ImageGenerationFixtureOptions = {}
): Record<string, unknown> {
  const count = Math.max(1, options.count ?? 1);
  const b64 = options.b64Json ?? TINY_PNG_BASE64;
  const data = Array.from({ length: count }, () => ({
    ...(options.url ? { url: options.url } : { b64_json: b64 }),
    ...(options.revisedPrompt ? { revised_prompt: options.revisedPrompt } : {}),
    mime_type: options.mimeType ?? 'image/png',
  }));

  return {
    created: 1764000000,
    data,
    usage: { total_tokens: 1024 },
  };
}
