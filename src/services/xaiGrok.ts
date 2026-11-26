import { Platform } from 'react-native';

import type {
  ActivityTimelineStep,
  ChatCompletionResult,
  ChatMessage,
  ChatTokenUsage,
  ModelInfo,
  ModelParameterSettings,
  ProviderProfile,
  ReasoningEffort,
  StreamChatCallbacks,
  ToolActivityItem,
  WebCitation,
} from '../domain/types';
import type {
  ChatProviderRequest,
  GenerationTaskProviderRequest,
  ProviderAdapter,
} from '../features/chat/orchestration/ProviderAdapterRegistry';
import {
  extractLinksFromAnswerText,
  isWeakSearchTitle,
  titleFromSearchUrl,
} from './externalSearch';
import {
  completeOpenThinkingSteps,
  nextTimelineSequence,
  upsertTimelineStep,
  upsertToolActivity,
} from './messageActivity';
import { createModelInfoFromId, inferModelTask } from './modelCapabilities';
import { guardedApiFetch } from './openAiCompatible';
import { isWebDevelopmentProxyAllowed, transportFetch } from './networkTransport';
import {
  createSseEventParser,
  openAiResponsesLimits,
  readOpenAiResponsesStream,
  readResponseTextWithAbort,
  toOpenAiResponsesInputItems,
  validatedPublicHttpsUrl,
  type OpenAiResponsesInputItem,
} from './openAiResponses';
import {
  inspectProviderEndpoint,
  isExactOfficialXaiProvider,
  isRelayOrCustomProvider,
  resolveProviderAuthHeaders,
} from './providerSetup';

export type XaiReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface XaiGrokWebSearchOptions {
  enabled: boolean;
  enableWebSearch?: boolean;
  enableXSearch?: boolean;
}

export interface XaiGrokResponsesRequestBody {
  model: string;
  input: OpenAiResponsesInputItem[];
  store: false;
  stream: boolean;
  include?: string[];
  reasoning_effort?: XaiReasoningEffort;
  tools?: Array<{ type: 'web_search' } | { type: 'x_search' }>;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  prompt_cache_key?: string;
}

export interface XaiGrokChatMessagePayload {
  role: ChatMessage['role'];
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      >;
}

export interface XaiGrokChatCompletionsRequestBody {
  model: string;
  messages: XaiGrokChatMessagePayload[];
  stream: boolean;
  stream_options?: {
    include_usage: boolean;
  };
  reasoning_effort?: XaiReasoningEffort;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
}

export interface XaiGrokChatRequest {
  provider: ProviderProfile;
  modelId: string;
  model?: ModelInfo;
  messages: ChatMessage[];
  reasoningEffort?: ReasoningEffort;
  parameterSettings?: ModelParameterSettings;
  maxOutputTokens?: number;
  conversationId?: string;
  stream?: boolean;
  webSearch?: XaiGrokWebSearchOptions;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class XaiGrokProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XaiGrokProtocolError';
  }
}

const defaultXaiTimeoutMs = 120_000;
const maxXaiErrorResponseBytes = 64 * 1024;
const snapshotSuffix = /-\d{4}-\d{2}-\d{2}$/;

function xaiError(message: string): never {
  throw new XaiGrokProtocolError(message);
}

function canonicalXaiModelId(modelId: string): string {
  return modelId.trim().toLowerCase().replace(snapshotSuffix, '');
}

/**
 * 判断模型是否为 xAI Grok 生图或视频生成专用模型，此类模型禁止进入文本对话适配器。
 */
export function isXaiMediaGenerationModel(modelId: string): boolean {
  const canonical = canonicalXaiModelId(modelId);
  return /^grok-imagine-(?:image|video)/.test(canonical);
}

/**
 * 判断模型是否为支持 `reasoning_effort` 的 Grok 推理模型（覆盖 Grok 4.7/4.5/4.3/4 与 Grok 3 Mini）。
 */
export function isXaiReasoningModel(modelId: string): boolean {
  const canonical = canonicalXaiModelId(modelId);
  if (!canonical || isXaiMediaGenerationModel(canonical)) {
    return false;
  }
  return (
    /^grok-4(?:\.\d+)?(?:$|-)/.test(canonical) ||
    /^grok-3-mini(?:$|-)/.test(canonical) ||
    canonical.includes('reasoning')
  );
}

/**
 * 将应用内统一 `ReasoningEffort` 映射为 xAI API 顶层 `reasoning_effort` 参数。
 * 其中 `grok-4.7` 完整支持 `xhigh`，其余推理模型将 `xhigh`/`max` 映射为 `high`。
 */
export function resolveXaiReasoningEffort(
  modelId: string,
  effort: ReasoningEffort = 'default'
): XaiReasoningEffort | undefined {
  if (
    effort === 'default' ||
    effort === 'off' ||
    effort === 'none' ||
    !isXaiReasoningModel(modelId)
  ) {
    return undefined;
  }

  const canonical = canonicalXaiModelId(modelId);
  const supportsXhigh = /^grok-4\.7(?:$|-)/.test(canonical);

  if (effort === 'minimal' || effort === 'low') {
    return 'low';
  }
  if (effort === 'medium' || effort === 'high') {
    return effort;
  }
  if (effort === 'xhigh' || effort === 'max') {
    return supportsXhigh ? 'xhigh' : 'high';
  }
  return undefined;
}

function normalizedXaiBaseUrl(provider: Pick<ProviderProfile, 'kind' | 'baseUrl'>): string {
  const inspection = inspectProviderEndpoint(provider.baseUrl, { kind: provider.kind });
  if (!inspection.valid || !inspection.normalizedBaseUrl) {
    return xaiError(inspection.errors[0] ?? 'xAI Grok Base URL 无效。');
  }
  return inspection.normalizedBaseUrl;
}

/**
 * 获取 xAI Grok Responses API 端点地址（默认 `https://api.x.ai/v1/responses`）。
 */
export function getXaiGrokResponsesEndpoint(
  provider: Pick<ProviderProfile, 'kind' | 'baseUrl'>
): string {
  if (isExactOfficialXaiProvider(provider)) {
    return 'https://api.x.ai/v1/responses';
  }
  const baseUrl = normalizedXaiBaseUrl(provider);
  return `${baseUrl}/responses`;
}

/**
 * 获取 xAI Grok Chat Completions 兼容降级端点地址。
 */
export function getXaiGrokChatCompletionsEndpoint(
  provider: Pick<ProviderProfile, 'kind' | 'baseUrl'>
): string {
  const baseUrl = normalizedXaiBaseUrl(provider);
  return `${baseUrl}/chat/completions`;
}

function assertXaiTextChatModel(modelId: string, model?: ModelInfo): string {
  const normalized = modelId.trim();
  if (!normalized) {
    return xaiError('请先选择一个 xAI Grok 模型。');
  }
  if (isXaiMediaGenerationModel(normalized)) {
    return xaiError(`模型“${normalized}”是生图或视频专用模型，请通过生图入口调用，不能发起文本对话。`);
  }
  if (model) {
    const task = inferModelTask(model);
    if (task !== 'chat') {
      return xaiError(`模型“${normalized}”当前任务类型为 ${task}，不能作为文本对话调用。`);
    }
  }
  return normalized;
}

/**
 * 构造 xAI Grok `/v1/responses` 主路径请求体与 URL。
 * 强制启用 `store: false`、透传 `reasoning_encrypted` 多轮块、禁用已废弃并返回 410 的 `search_parameters`。
 */
export function buildXaiGrokResponsesRequest(args: {
  provider: Pick<ProviderProfile, 'kind' | 'baseUrl'>;
  modelId: string;
  model?: ModelInfo;
  messages: ChatMessage[];
  reasoningEffort?: ReasoningEffort;
  parameterSettings?: ModelParameterSettings;
  maxOutputTokens?: number;
  conversationId?: string;
  stream?: boolean;
  webSearch?: XaiGrokWebSearchOptions;
}): { url: string; body: XaiGrokResponsesRequestBody } {
  const model = assertXaiTextChatModel(args.modelId, args.model);
  const url = getXaiGrokResponsesEndpoint(args.provider);
  const input = toOpenAiResponsesInputItems(args.messages, {
    continuationProvider: 'xai',
  });
  const effort = resolveXaiReasoningEffort(model, args.reasoningEffort ?? 'default');

  const body: XaiGrokResponsesRequestBody = {
    model,
    input,
    store: false,
    stream: args.stream ?? true,
    include: ['reasoning.encrypted_content'],
  };

  if (effort) {
    body.reasoning_effort = effort;
  }

  if (args.webSearch?.enabled) {
    const tools: Array<{ type: 'web_search' } | { type: 'x_search' }> = [];
    if (args.webSearch.enableWebSearch !== false) {
      tools.push({ type: 'web_search' });
    }
    if (args.webSearch.enableXSearch !== false) {
      tools.push({ type: 'x_search' });
    }
    if (!tools.length) {
      tools.push({ type: 'web_search' }, { type: 'x_search' });
    }
    body.tools = tools;
  }

  if (args.maxOutputTokens !== undefined) {
    if (
      !Number.isInteger(args.maxOutputTokens) ||
      args.maxOutputTokens < 64 ||
      args.maxOutputTokens > 131_072
    ) {
      return xaiError('xAI Grok 最大输出 Token 必须是 64–131072 的整数。');
    }
    body.max_output_tokens = args.maxOutputTokens;
  }

  if (args.parameterSettings?.enabled && !effort) {
    if (Number.isFinite(args.parameterSettings.temperature)) {
      body.temperature = args.parameterSettings.temperature;
    }
    if (Number.isFinite(args.parameterSettings.topP)) {
      body.top_p = args.parameterSettings.topP;
    }
  }

  if (args.conversationId?.trim()) {
    body.prompt_cache_key = args.conversationId.trim();
  }

  // 防御性守卫：绝对不向 xAI 发送会返回 410 Gone 的 search_parameters
  if ('search_parameters' in (body as unknown as Record<string, unknown>)) {
    delete (body as unknown as Record<string, unknown>).search_parameters;
  }

  return { url, body };
}

function toChatCompletionsMessage(message: ChatMessage): XaiGrokChatMessagePayload {
  const imageParts: Array<{ type: 'image_url'; image_url: { url: string } }> = [];
  for (const att of message.attachments ?? []) {
    if (att.kind !== 'image') continue;
    const inline = att.base64?.trim();
    const url = inline
      ? inline.toLowerCase().startsWith('data:')
        ? inline
        : `data:${att.mimeType || 'image/jpeg'};base64,${inline}`
      : att.uri?.trim();
    if (url) {
      imageParts.push({ type: 'image_url', image_url: { url } });
    }
  }

  if (!imageParts.length) {
    return { role: message.role, content: message.content };
  }

  const parts: Array<
    { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
  > = [];
  if (message.content) {
    parts.push({ type: 'text', text: message.content });
  }
  parts.push(...imageParts);
  return { role: message.role, content: parts };
}

/**
 * 构造 xAI Grok `/v1/chat/completions` 兼容降级请求（供中转站或服务端返回 404/405/501 时回退使用）。
 */
export function buildXaiGrokChatCompletionsRequest(args: {
  provider: Pick<ProviderProfile, 'kind' | 'baseUrl' | 'apiKey' | 'authHeaderMode' | 'customHeaders'>;
  modelId: string;
  model?: ModelInfo;
  messages: ChatMessage[];
  reasoningEffort?: ReasoningEffort;
  parameterSettings?: ModelParameterSettings;
  maxOutputTokens?: number;
  conversationId?: string;
  stream?: boolean;
}): { url: string; headers: Record<string, string>; body: XaiGrokChatCompletionsRequestBody } {
  const model = assertXaiTextChatModel(args.modelId, args.model);
  const url = getXaiGrokChatCompletionsEndpoint(args.provider);
  const stream = args.stream ?? true;
  const effort = resolveXaiReasoningEffort(model, args.reasoningEffort ?? 'default');

  const headers: Record<string, string> = {
    ...resolveProviderAuthHeaders(args.provider),
    'Content-Type': 'application/json',
    Accept: 'text/event-stream, application/json',
  };
  if (args.conversationId?.trim()) {
    headers['x-grok-conv-id'] = args.conversationId.trim();
  }

  const body: XaiGrokChatCompletionsRequestBody = {
    model,
    messages: args.messages
      .filter((msg) => msg.status === 'ready')
      .map(toChatCompletionsMessage),
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  };

  if (effort) {
    body.reasoning_effort = effort;
  }
  if (args.maxOutputTokens !== undefined) {
    body.max_tokens = args.maxOutputTokens;
  }
  if (args.parameterSettings?.enabled && !effort) {
    if (Number.isFinite(args.parameterSettings.temperature)) {
      body.temperature = args.parameterSettings.temperature;
    }
    if (Number.isFinite(args.parameterSettings.topP)) {
      body.top_p = args.parameterSettings.topP;
    }
  }

  return { url, headers, body };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCitationTitle(rawTitle: string | undefined, url: string): string {
  const trimmed = rawTitle?.trim() ?? '';
  if (!trimmed || isWeakSearchTitle(trimmed, url)) {
    return titleFromSearchUrl(url);
  }
  return trimmed.slice(0, 300);
}

function mergeNormalizedCitation(
  byUrl: Map<string, WebCitation>,
  candidate: {
    url: unknown;
    title?: string;
    text?: string;
    startIndex?: number;
    endIndex?: number;
  },
  maxContentLength?: number
): void {
  const validUrl = validatedPublicHttpsUrl(candidate.url);
  if (!validUrl) return;
  const nextTitle = normalizeCitationTitle(candidate.title, validUrl);
  const nextText = candidate.text?.trim() ? candidate.text.trim().slice(0, 400) : undefined;
  const hasValidRange =
    candidate.startIndex !== undefined &&
    candidate.endIndex !== undefined &&
    Number.isInteger(candidate.startIndex) &&
    Number.isInteger(candidate.endIndex) &&
    candidate.startIndex >= 0 &&
    candidate.endIndex > candidate.startIndex &&
    (maxContentLength === undefined || candidate.endIndex <= maxContentLength);
  const startIndex = hasValidRange ? candidate.startIndex : undefined;
  const endIndex = hasValidRange ? candidate.endIndex : undefined;
  const existing = byUrl.get(validUrl);

  if (!existing) {
    byUrl.set(validUrl, {
      url: validUrl,
      title: nextTitle,
      ...(nextText ? { text: nextText } : {}),
      ...(startIndex !== undefined && endIndex !== undefined ? { startIndex, endIndex } : {}),
    });
    return;
  }

  const keepNewTitle =
    (!existing.title || isWeakSearchTitle(existing.title, validUrl)) &&
    !isWeakSearchTitle(nextTitle, validUrl);
  byUrl.set(validUrl, {
    ...existing,
    ...(keepNewTitle ? { title: nextTitle } : {}),
    ...(!existing.text && nextText ? { text: nextText } : {}),
    ...(existing.startIndex === undefined && startIndex !== undefined && endIndex !== undefined
      ? { startIndex, endIndex }
      : {}),
  });
}

/**
 * 合并去重 xAI 三路引用来源：
 * 1) 顶层 `citations`（URL 字符串数组或对象数组）；
 * 2) `output[].content[].annotations` (`url_citation`) 与流式阶段已提取引用；
 * 3) 正文 Markdown 行内引用 `[[1]](url)` / `[title](url)`；
 * 所有 URL 均经过公网 HTTPS 校验，弱标题（如 `"1"` / `"[2]"` / 空串）使用 `titleFromSearchUrl` 美化，并对 `end_index` 执行边界校验。
 */
export function mergeXaiCitations(args: {
  rawPayload?: unknown;
  streamCitations?: WebCitation[];
  content?: string;
}): WebCitation[] {
  const byUrl = new Map<string, WebCitation>();
  const maxContentLength = typeof args.content === 'string' ? args.content.length : undefined;

  // 1) 流式或基础 Responses 解析已收集到的引用（先规范化弱标题并校验区间边界）
  for (const item of args.streamCitations ?? []) {
    mergeNormalizedCitation(byUrl, item, maxContentLength);
  }

  if (isRecord(args.rawPayload)) {
    // 2) 顶层 citations（xAI 特有：字符串数组或对象数组）
    if (Array.isArray(args.rawPayload.citations)) {
      for (const entry of args.rawPayload.citations) {
        if (typeof entry === 'string') {
          mergeNormalizedCitation(byUrl, { url: entry });
        } else if (isRecord(entry)) {
          const text =
            typeof entry.snippet === 'string'
              ? entry.snippet
              : typeof entry.text === 'string'
                ? entry.text
                : typeof entry.description === 'string'
                  ? entry.description
                  : undefined;
          const title =
            typeof entry.title === 'string'
              ? entry.title
              : typeof entry.name === 'string'
                ? entry.name
                : undefined;
          mergeNormalizedCitation(byUrl, {
            url: entry.url ?? entry.uri,
            title,
            text,
          });
        }
      }
    }

    // 3) output[].content[].annotations
    if (Array.isArray(args.rawPayload.output)) {
      for (const item of args.rawPayload.output) {
        if (!isRecord(item) || item.type !== 'message' || !Array.isArray(item.content)) continue;
        for (const part of item.content) {
          if (!isRecord(part) || !Array.isArray(part.annotations)) continue;
          const partTextLen = typeof part.text === 'string' ? part.text.length : undefined;
          const effectiveMaxLen =
            maxContentLength !== undefined && partTextLen !== undefined
              ? Math.min(maxContentLength, partTextLen)
              : (maxContentLength ?? partTextLen);
          for (const ann of part.annotations) {
            if (!isRecord(ann)) continue;
            if (ann.type !== 'url_citation' && typeof ann.url !== 'string') continue;
            const start = Number.isInteger(ann.start_index) ? (ann.start_index as number) : undefined;
            const end = Number.isInteger(ann.end_index) ? (ann.end_index as number) : undefined;
            const validRange =
              start !== undefined &&
              end !== undefined &&
              start >= 0 &&
              end > start &&
              (effectiveMaxLen === undefined || end <= effectiveMaxLen);
            mergeNormalizedCitation(
              byUrl,
              {
                url: ann.url,
                title: typeof ann.title === 'string' ? ann.title : undefined,
                ...(validRange ? { startIndex: start, endIndex: end } : {}),
              },
              effectiveMaxLen
            );
          }
        }
      }
    }
  }

  // 4) 正文内嵌 Markdown 链接（如 **text**[[1]](https://...)）
  if (args.content?.trim()) {
    for (const inlineLink of extractLinksFromAnswerText(args.content)) {
      mergeNormalizedCitation(byUrl, {
        url: inlineLink.url,
        title: inlineLink.title,
      });
    }
  }

  return Array.from(byUrl.values()).map((citation, index) => ({
    ...citation,
    index: citation.index ?? index + 1,
  }));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildPercentEncodedSecretPattern(encodedValue: string): RegExp {
  const source = escapeRegExp(encodedValue).replace(/%([0-9a-f]{2})/gi, (_, hex: string) => {
    const upper = hex.toUpperCase();
    const lower = hex.toLowerCase();
    if (upper === '20') {
      return '(?:%20|\\+)';
    }
    const c0 = upper[0] === lower[0] ? upper[0] : `[${upper[0]}${lower[0]}]`;
    const c1 = upper[1] === lower[1] ? upper[1] : `[${upper[1]}${lower[1]}]`;
    return `%${c0}${c1}`;
  });
  return new RegExp(source, 'g');
}

function redactXaiSecrets(text: string, apiKey?: string): string {
  const trimmedKey = apiKey?.trim();
  if (!trimmedKey || trimmedKey.length < 4) {
    return text;
  }
  let sanitized = text.split(trimmedKey).join('[REDACTED]');
  const encodedKey = encodeURIComponent(trimmedKey);
  if (encodedKey && encodedKey !== trimmedKey) {
    sanitized = sanitized.replace(buildPercentEncodedSecretPattern(encodedKey), '[REDACTED]');
  }
  return sanitized;
}

function createXaiAbortError(message = '请求已取消。'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function resolveXaiAbortError(signal?: AbortSignal): Error {
  if (
    signal?.reason instanceof Error &&
    (signal.reason.name === 'AbortError' || signal.reason.name === 'TimeoutError')
  ) {
    return signal.reason;
  }
  return createXaiAbortError();
}

function sanitizeErrorSnippet(text: string, apiKey?: string): string {
  // 必须先全量替换 apiKey 再做空白压缩与截断，防止跨越 260 字符边界的半截密钥泄漏
  const redacted = redactXaiSecrets(text, apiKey);
  return redacted.replace(/\s+/g, ' ').trim().slice(0, 260);
}

function sanitizeXaiError(error: unknown, apiKey?: string): Error {
  const err = error instanceof Error ? error : new Error(String(error));
  const cleanMessage = redactXaiSecrets(err.message, apiKey);
  if (cleanMessage === err.message) {
    return err;
  }
  if (err instanceof XaiGrokProtocolError) {
    return new XaiGrokProtocolError(cleanMessage);
  }
  const sanitized = new Error(cleanMessage);
  sanitized.name = err.name;
  return sanitized;
}

function parseUsageNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function parseChatCompletionsUsage(rawUsage: unknown): ChatTokenUsage | undefined {
  if (!isRecord(rawUsage)) return undefined;
  const completionDetails = isRecord(rawUsage.completion_tokens_details)
    ? rawUsage.completion_tokens_details
    : {};
  const promptDetails = isRecord(rawUsage.prompt_tokens_details)
    ? rawUsage.prompt_tokens_details
    : {};
  const usage: ChatTokenUsage = {
    inputTokens: parseUsageNumber(rawUsage, 'prompt_tokens'),
    outputTokens: parseUsageNumber(rawUsage, 'completion_tokens'),
    reasoningTokens: parseUsageNumber(completionDetails, 'reasoning_tokens'),
    cachedInputTokens: parseUsageNumber(promptDetails, 'cached_tokens'),
    totalTokens: parseUsageNumber(rawUsage, 'total_tokens'),
  };
  return Object.values(usage).some((v) => typeof v === 'number') ? usage : undefined;
}

async function readXaiTextWithAbort(
  response: Response,
  signal?: AbortSignal
): Promise<string> {
  if (signal?.aborted) {
    void response.body?.cancel().catch(() => undefined);
    throw resolveXaiAbortError(signal);
  }
  if (!signal) {
    return response.text();
  }
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(resolveXaiAbortError(signal));
      void response.body?.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  abortPromise.catch(() => undefined);
  try {
    const text = await Promise.race([response.text(), abortPromise]);
    if (signal.aborted) {
      throw resolveXaiAbortError(signal);
    }
    return text;
  } finally {
    if (onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

async function readXaiChatCompletionsResponse(
  response: Response,
  callbacks?: StreamChatCallbacks,
  signal?: AbortSignal
): Promise<ChatCompletionResult> {
  if (signal?.aborted) {
    void response.body?.cancel().catch(() => undefined);
    throw resolveXaiAbortError(signal);
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('application/json') && !contentType.includes('text/event-stream')) {
    const text = await readXaiTextWithAbort(response, signal);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return xaiError('xAI Grok 兼容端点返回了无效 JSON。');
    }
    if (!isRecord(parsed)) {
      return xaiError('xAI Grok 兼容端点响应必须是 JSON 对象。');
    }
    const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
    const firstChoice = isRecord(choices[0]) ? choices[0] : {};
    const message = isRecord(firstChoice.message) ? firstChoice.message : {};
    const content = typeof message.content === 'string' ? message.content : '';
    const reasoningContent =
      typeof message.reasoning_content === 'string' ? message.reasoning_content : undefined;
    const usage = parseChatCompletionsUsage(parsed.usage);
    const citations = mergeXaiCitations({ rawPayload: parsed, content });

    if (reasoningContent) {
      callbacks?.onThinkingDelta?.(reasoningContent, reasoningContent);
      callbacks?.onThinkingComplete?.(0);
    }
    if (citations.length) {
      callbacks?.onCitations?.(citations, true);
    }
    if (content) {
      callbacks?.onTextDelta?.(content, content);
    }
    if (usage) {
      callbacks?.onUsage?.(usage);
    }
    const result: ChatCompletionResult = {
      content,
      ...(reasoningContent ? { reasoningContent } : {}),
      ...(usage ? { usage } : {}),
      ...(citations.length ? { citations, webSearchTriggered: true } : {}),
      raw: parsed,
    };
    callbacks?.onDone?.(result);
    return result;
  }

  const parser = createSseEventParser();
  let content = '';
  let reasoningContent = '';
  let thinkingStartedAt: number | undefined;
  let thinkingDurationMs: number | undefined;
  let thinkingDone = false;
  let usage: ChatTokenUsage | undefined;
  let lastRaw: unknown;
  let topLevelCitations: unknown[] = [];

  function completeThinking(): void {
    if (thinkingStartedAt !== undefined && !thinkingDone) {
      thinkingDone = true;
      thinkingDurationMs = Math.max(0, Date.now() - thinkingStartedAt);
      callbacks?.onThinkingComplete?.(thinkingDurationMs);
    }
  }

  function processFrame(dataText: string): boolean {
    const trimmed = dataText.trim();
    if (!trimmed) return false;
    if (trimmed === '[DONE]') return true;
    let payload: unknown;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      return false;
    }
    if (!isRecord(payload)) return false;
    lastRaw = payload;

    if (Array.isArray(payload.citations)) {
      topLevelCitations = payload.citations;
    }
    const nextUsage = parseChatCompletionsUsage(payload.usage);
    if (nextUsage) {
      usage = nextUsage;
      callbacks?.onUsage?.(nextUsage);
    }

    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const first = isRecord(choices[0]) ? choices[0] : undefined;
    const delta = first && isRecord(first.delta) ? first.delta : undefined;
    if (!delta) return false;

    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      thinkingStartedAt ??= Date.now();
      reasoningContent += delta.reasoning_content;
      if (content.length + reasoningContent.length > openAiResponsesLimits.maxOutputCharacters) {
        xaiError('xAI Grok 流式输出过长。');
      }
      callbacks?.onThinkingDelta?.(delta.reasoning_content, reasoningContent);
    }
    if (typeof delta.content === 'string' && delta.content) {
      completeThinking();
      content += delta.content;
      if (content.length + reasoningContent.length > openAiResponsesLimits.maxOutputCharacters) {
        xaiError('xAI Grok 流式输出过长。');
      }
      callbacks?.onTextDelta?.(delta.content, content);
    }
    return false;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const raw = await readXaiTextWithAbort(response, signal);
    for (const frame of [...parser.push(raw), ...parser.flush()]) {
      if (processFrame(frame.data)) break;
    }
  } else {
    let onAbort: (() => void) | undefined;
    const abortPromise = signal
      ? new Promise<never>((_, reject) => {
          onAbort = () => {
            reject(resolveXaiAbortError(signal));
            void reader.cancel().catch(() => undefined);
          };
          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener('abort', onAbort, { once: true });
          }
        })
      : undefined;
    abortPromise?.catch(() => undefined);

    try {
      let stopped = false;
      while (!stopped) {
        if (signal?.aborted) {
          await reader.cancel().catch(() => undefined);
          throw resolveXaiAbortError(signal);
        }
        const { value, done } = abortPromise
          ? await Promise.race([reader.read(), abortPromise])
          : await reader.read();
        if (signal?.aborted) {
          await reader.cancel().catch(() => undefined);
          throw resolveXaiAbortError(signal);
        }
        if (done) break;
        if (!value) continue;
        for (const frame of parser.push(value)) {
          if (processFrame(frame.data)) {
            stopped = true;
            await reader.cancel().catch(() => undefined);
            break;
          }
        }
      }
      if (signal?.aborted) {
        throw resolveXaiAbortError(signal);
      }
      if (!stopped) {
        for (const frame of parser.flush()) {
          if (processFrame(frame.data)) break;
        }
      }
    } finally {
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
      try {
        reader.releaseLock();
      } catch {
        // 流已释放或取消时忽略
      }
    }
  }

  completeThinking();

  if (!content.trim() && !reasoningContent.trim()) {
    return xaiError('xAI Grok 兼容端点未返回有效回复内容。');
  }

  const citations = mergeXaiCitations({
    rawPayload: topLevelCitations.length ? { citations: topLevelCitations } : lastRaw,
    content,
  });
  if (citations.length) {
    callbacks?.onCitations?.(citations, true);
  }

  const result: ChatCompletionResult = {
    content,
    ...(reasoningContent ? { reasoningContent } : {}),
    ...(thinkingDurationMs !== undefined ? { thinkingDurationMs } : {}),
    ...(usage ? { usage } : {}),
    ...(citations.length ? { citations, webSearchTriggered: true } : {}),
    raw: lastRaw ?? { content },
  };
  callbacks?.onDone?.(result);
  return result;
}

/**
 * 执行 xAI Grok 对话请求（官方直连优先使用 `/v1/responses` + `reasoning.encrypted_content` + `web_search`/`x_search`；
 * 中转端点或服务端返回 `404`/`405`/`501` 时自动降级至 `/v1/chat/completions`）。
 */
export async function sendXaiGrokChat(
  request: XaiGrokChatRequest,
  callbacks?: StreamChatCallbacks
): Promise<ChatCompletionResult> {
  const {
    provider,
    modelId,
    model,
    messages,
    reasoningEffort = 'default',
    parameterSettings,
    maxOutputTokens,
    conversationId,
    stream = true,
    webSearch,
    fetchImpl = guardedApiFetch,
    signal,
    timeoutMs = defaultXaiTimeoutMs,
  } = request;

  assertXaiTextChatModel(modelId, model);

  if (signal?.aborted) {
    const abortErr = resolveXaiAbortError(signal);
    callbacks?.onError?.(abortErr);
    throw abortErr;
  }

  // Web 非受控代理构建下即使调用方传入自定义 fetchImpl，也必须保持 fail-closed 安全边界
  if (Platform.OS === 'web' && !isWebDevelopmentProxyAllowed()) {
    const blockedErr = new XaiGrokProtocolError(
      '正式 Web 构建不会发送 API Key 或模型请求。仅可在本机通过 npm run web 显式启动受限调试代理。'
    );
    callbacks?.onError?.(blockedErr);
    throw blockedErr;
  }

  const executeXaiFetch = (url: string, init: RequestInit): Promise<Response> => {
    if (fetchImpl === guardedApiFetch) {
      return guardedApiFetch(url, init);
    }
    if (Platform.OS === 'web') {
      return transportFetch(url, init, fetchImpl);
    }
    return fetchImpl(url, init);
  };

  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => {
    const timeoutErr = new Error(`xAI Grok 请求超过 ${Math.round(timeoutMs / 1000)} 秒超时。`);
    timeoutErr.name = 'TimeoutError';
    controller.abort(timeoutErr);
  }, timeoutMs);

  let errorNotified = false;
  const notifyErrorOnce = (error: unknown): Error => {
    const sanitizedErr = sanitizeXaiError(error, provider.apiKey);
    if (!errorNotified) {
      errorNotified = true;
      callbacks?.onError?.(sanitizedErr);
    }
    return sanitizedErr;
  };

  const runChatCompletionsFallback = async (): Promise<ChatCompletionResult> => {
    const fallbackReq = buildXaiGrokChatCompletionsRequest({
      provider,
      modelId,
      model,
      messages,
      reasoningEffort,
      parameterSettings,
      maxOutputTokens,
      conversationId,
      stream,
    });
    const resp = await executeXaiFetch(fallbackReq.url, {
      method: 'POST',
      headers: fallbackReq.headers,
      body: JSON.stringify(fallbackReq.body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const errBody = await readResponseTextWithAbort(
        resp,
        controller.signal,
        maxXaiErrorResponseBytes
      ).catch((err) => {
        if (controller.signal.aborted) {
          throw err;
        }
        return '';
      });
      const cleanMsg = sanitizeErrorSnippet(errBody, provider.apiKey);
      throw new XaiGrokProtocolError(
        `xAI Grok 请求失败：HTTP ${resp.status}${cleanMsg ? ` ${cleanMsg}` : ''}`
      );
    }
    return readXaiChatCompletionsResponse(resp, callbacks, controller.signal);
  };

  try {
    // 第三方中转站或自定义兼容端点优先走 /v1/chat/completions
    if (isRelayOrCustomProvider(provider) && !isExactOfficialXaiProvider(provider)) {
      return await runChatCompletionsFallback();
    }

    const primaryReq = buildXaiGrokResponsesRequest({
      provider,
      modelId,
      model,
      messages,
      reasoningEffort,
      parameterSettings,
      maxOutputTokens,
      conversationId,
      stream,
      webSearch,
    });

    const headers: Record<string, string> = {
      ...resolveProviderAuthHeaders(provider),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream, application/json',
    };

    const response = await executeXaiFetch(primaryReq.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(primaryReq.body),
      signal: controller.signal,
    });

    if (response.status === 404 || response.status === 405 || response.status === 501) {
      await response.body?.cancel().catch(() => undefined);
      return await runChatCompletionsFallback();
    }

    if (!response.ok) {
      const errBody = await readResponseTextWithAbort(
        response,
        controller.signal,
        maxXaiErrorResponseBytes
      ).catch((err) => {
        if (controller.signal.aborted) {
          throw err;
        }
        return '';
      });
      const cleanMsg = sanitizeErrorSnippet(errBody, provider.apiKey);
      throw new XaiGrokProtocolError(
        `xAI Grok 请求失败：HTTP ${response.status}${cleanMsg ? ` ${cleanMsg}` : ''}`
      );
    }

    // 拦截流式回调，确保最终 Citations 经过三路合并去重、titleFromSearchUrl 美化，且异常错误经过 apiKey 脱敏
    let finalMergedResult: ChatCompletionResult | undefined;
    const wrappedCallbacks: StreamChatCallbacks = {
      onTextDelta: callbacks?.onTextDelta,
      onThinkingDelta: callbacks?.onThinkingDelta,
      onThinkingComplete: callbacks?.onThinkingComplete,
      onToolActivity: callbacks?.onToolActivity,
      onImageGenerated: callbacks?.onImageGenerated,
      onContinuationBlocks: callbacks?.onContinuationBlocks,
      onUsage: callbacks?.onUsage,
      onError: (err) => {
        notifyErrorOnce(err);
      },
      onCitations: (rawCitations, triggered) => {
        const normalized = mergeXaiCitations({ streamCitations: rawCitations });
        callbacks?.onCitations?.(normalized, triggered);
      },
      onDone: (rawResult) => {
        const mergedCitations = mergeXaiCitations({
          rawPayload: rawResult.raw,
          streamCitations: rawResult.citations,
          content: rawResult.content,
        });
        const hasSearchEvidence =
          Boolean(rawResult.webSearchTriggered) || mergedCitations.length > 0;
        finalMergedResult = {
          ...rawResult,
          ...(mergedCitations.length ? { citations: mergedCitations } : {}),
          ...(hasSearchEvidence ? { webSearchTriggered: true } : {}),
        };
        if (mergedCitations.length) {
          callbacks?.onCitations?.(mergedCitations, hasSearchEvidence);
        }
        callbacks?.onDone?.(finalMergedResult);
      },
    };

    const baseResult = await readOpenAiResponsesStream(response, wrappedCallbacks, {
      continuationProvider: 'xai',
      signal: controller.signal,
    });
    return finalMergedResult ?? baseResult;
  } catch (error) {
    throw notifyErrorOnce(error);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * xAI Grok 一等协议适配器（实现 `ProviderAdapter` 接口，供 `ProviderAdapterRegistry` 直接装配）。
 */
export class XaiGrokProviderAdapter implements ProviderAdapter {
  private readonly fetchImpl?: typeof fetch;

  constructor(options?: { fetchImpl?: typeof fetch }) {
    this.fetchImpl = options?.fetchImpl;
  }

  async run(request: ChatProviderRequest): Promise<ChatCompletionResult> {
    const requestModel =
      request.model ?? createModelInfoFromId(request.provider, request.modelId, 'manual');
    const task = inferModelTask(requestModel);
    const externalSearchActive = Boolean(request.externalSearch?.enabled);

    if ((request.webSearch?.enabled || externalSearchActive) && task !== 'chat') {
      throw new XaiGrokProtocolError('联网搜索只适用于聊天模型，已拒绝发起请求。');
    }
    if (request.webSearch?.enabled && externalSearchActive) {
      throw new XaiGrokProtocolError('服务商联网搜索与外部搜索不能同时启用。');
    }
    if (request.webSearch?.enabled) {
      if (!request.provider.apiKey?.trim()) {
        throw new XaiGrokProtocolError('联网搜索必须使用你在当前服务商中配置的 API Key。');
      }
      if (!requestModel.capabilities.includes('web-search')) {
        throw new XaiGrokProtocolError(
          '当前模型未明确标记为支持联网搜索，已拒绝发起可能计费的搜索请求。'
        );
      }
    }

    let contentSnapshot = '';
    let reasoningSnapshot: string | undefined;
    let usageSnapshot: ChatTokenUsage | undefined;
    let toolSnapshot: ToolActivityItem[] | undefined;
    let timelineSnapshot: ActivityTimelineStep[] | undefined;

    const emitStreamUpdate = (raw?: unknown) => {
      request.onStreamUpdate?.({
        content: contentSnapshot,
        ...(reasoningSnapshot ? { reasoningContent: reasoningSnapshot } : {}),
        ...(usageSnapshot ? { usage: usageSnapshot } : {}),
        ...(toolSnapshot?.length ? { toolActivity: toolSnapshot } : {}),
        ...(timelineSnapshot?.length ? { activityTimeline: timelineSnapshot } : {}),
        ...(raw !== undefined ? { raw } : {}),
      });
    };

    const callbacks: StreamChatCallbacks = {
      onThinkingDelta: (_delta, snapshot) => {
        reasoningSnapshot = snapshot ?? reasoningSnapshot;
        timelineSnapshot = upsertTimelineStep(timelineSnapshot, {
          id: 'thinking-main',
          kind: 'thinking',
          sequence: timelineSnapshot?.some((s) => s.id === 'thinking-main')
            ? timelineSnapshot.find((s) => s.id === 'thinking-main')!.sequence
            : nextTimelineSequence(timelineSnapshot ?? []),
          status: 'running',
          content: reasoningSnapshot,
        });
        emitStreamUpdate();
      },
      onThinkingComplete: () => {
        timelineSnapshot = completeOpenThinkingSteps(timelineSnapshot);
        emitStreamUpdate();
      },
      onToolActivity: (items, timeline) => {
        toolSnapshot = items.reduce<ToolActivityItem[]>(
          (acc, item) => upsertToolActivity(acc, item),
          []
        );
        if (timeline) {
          timelineSnapshot = timeline;
        }
        emitStreamUpdate();
      },
      onTextDelta: (_delta, snapshot) => {
        contentSnapshot = snapshot ?? contentSnapshot;
        emitStreamUpdate();
      },
      onUsage: (usage) => {
        usageSnapshot = usage;
        emitStreamUpdate();
      },
      onDone: (result) => {
        contentSnapshot = result.content;
        reasoningSnapshot = result.reasoningContent;
        usageSnapshot = result.usage;
        toolSnapshot = result.toolActivity;
        timelineSnapshot = result.activityTimeline;
        emitStreamUpdate(result.raw);
      },
    };

    return sendXaiGrokChat(
      {
        provider: request.provider,
        modelId: request.modelId,
        model: requestModel,
        messages: request.messages,
        reasoningEffort: request.reasoningEffort,
        parameterSettings: request.parameterSettings,
        maxOutputTokens: request.maxOutputTokens,
        webSearch: request.webSearch?.enabled
          ? { enabled: true, enableWebSearch: true, enableXSearch: true }
          : undefined,
        fetchImpl: this.fetchImpl,
        signal: request.signal,
      },
      callbacks
    );
  }

  async queryTask(_request: GenerationTaskProviderRequest): Promise<ChatCompletionResult> {
    throw new XaiGrokProtocolError('xAI Grok 不支持异步视频生成任务轮询。');
  }
}

/**
 * 创建 xAI Grok 一等协议适配器实例（供 M1.4 装配至 `ProviderAdapterRegistry`）。
 */
export function createXaiGrokProviderAdapter(options?: {
  fetchImpl?: typeof fetch;
}): ProviderAdapter {
  return new XaiGrokProviderAdapter(options);
}
