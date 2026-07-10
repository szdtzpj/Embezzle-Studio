import type {
  ChatCompletionResult,
  ChatMessage,
  ChatTokenUsage,
  GenerationTaskInfo,
  MediaAttachment,
  ModelParameterSettings,
  ModelInfo,
  ProviderProfile,
  ReasoningEffort,
} from '../domain/types';
import { Platform } from 'react-native';
import { isVolcengineArkProvider } from '../data/arkModels';
import {
  createModelInfoFromId,
  enrichDiscoveredModel,
  getBailianThinkingProfile,
  inferModelTask,
  isReasoningModel,
  isVideoInputModel,
  isVisionModel,
  type RemoteModelMetadata,
} from './modelCapabilities';
import { normalizeReasoningEffort } from './reasoningEfforts';
import { materializeAttachment, persistAttachment } from './mediaStorage';
import {
  buildOpenAiResponsesRequest,
  isOpenAiResponsesOnlyModel,
  openAiResponsesLimits,
  parseOpenAiResponsesResponse,
} from './openAiResponses';

interface ChatCompletionArgs {
  provider: ProviderProfile;
  modelId: string;
  model?: ModelInfo;
  messages: ChatMessage[];
  reasoningEffort: ReasoningEffort;
  parameterSettings?: ModelParameterSettings;
  onStreamUpdate?: (update: ChatStreamUpdate) => void;
  signal?: AbortSignal;
}

interface ChatStreamUpdate {
  content: string;
  reasoningContent?: string;
  usage?: ChatTokenUsage;
  raw?: unknown;
}

interface RemoteModel extends RemoteModelMetadata {
  id?: string;
  object?: string;
  owned_by?: string;
}

interface ArkVideoTaskResponse {
  id?: string;
  status?: string;
  content?: {
    video_url?: string;
    url?: string;
  };
  data?: {
    status?: string;
    content?: {
      video_url?: string;
      url?: string;
    };
  };
  error?: {
    message?: string;
  };
}

const webDevProxyUrl = 'http://127.0.0.1:8787/proxy';
const defaultRequestTimeoutMs = 120_000;
const openAiProRequestTimeoutMs = 10 * 60_000;
const discoveryRequestTimeoutMs = 30_000;
const maxJsonResponseBytes = 5 * 1024 * 1024;
const maxErrorResponseBytes = 64 * 1024;
const maxGeneratedImageResponseBytes = 30 * 1024 * 1024;
const maxStreamEventBytes = 1024 * 1024;
const maxStreamOutputCharacters = 2_000_000;
const bailianMaxInlineVideoDataUrlBytes = 10 * 1024 * 1024;
const responseAbortCleanups = new WeakMap<Response, () => void>();

function createAbortError(message = '请求已取消。'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function parseProviderBaseUrl(rawBaseUrl: string): URL {
  const value = rawBaseUrl.trim();
  if (!value) {
    throw new Error('请先填写当前服务商的 Base URL。');
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Base URL 不是有效网址，请填写完整的 https:// 地址。');
  }

  if (url.username || url.password) {
    throw new Error('Base URL 不能包含用户名或密码。');
  }
  if (url.hash || url.search) {
    throw new Error('Base URL 不能包含查询参数或片段。');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) {
    throw new Error('Base URL 必须使用 HTTPS；仅本机 localhost/127.0.0.1 调试服务可使用 HTTP。');
  }

  return url;
}

function shouldAppendOpenAiVersion(baseUrl: string, provider: ProviderProfile): boolean {
  if (!['custom', 'new-api-relay', 'openai-compatible'].includes(provider.kind)) {
    return false;
  }

  try {
    const url = parseProviderBaseUrl(baseUrl);
    const path = url.pathname.replace(/\/+$/, '').toLowerCase();
    return path === '';
  } catch {
    return false;
  }
}

function normalizeBaseUrl(baseUrl: string, provider: ProviderProfile): string {
  const url = parseProviderBaseUrl(baseUrl);
  url.pathname = url.pathname
    .replace(/\/+$/, '')
    .replace(/\/(?:chat\/completions|models)$/i, '') || '/';
  const normalized = url.toString().replace(/\/+$/, '');

  if (normalized && shouldAppendOpenAiVersion(normalized, provider)) {
    return `${normalized}/v1`;
  }

  return normalized;
}

function authHeaders(provider: ProviderProfile): HeadersInit {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  const apiKey = provider.apiKey?.trim();
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function assertBaseUrl(provider: ProviderProfile): string {
  const baseUrl = normalizeBaseUrl(provider.baseUrl, provider);
  return baseUrl;
}

async function readLimitedResponseText(
  response: Response,
  maxBytes: number,
  label: string
): Promise<string> {
  try {
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(`${label}响应过大（上限 ${Math.round(maxBytes / 1024 / 1024)} MB）。`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      const body = await response.text();
      if (new TextEncoder().encode(body).byteLength > maxBytes) {
        throw new Error(`${label}响应过大（上限 ${Math.round(maxBytes / 1024 / 1024)} MB）。`);
      }
      return body;
    }

    const decoder = new TextDecoder();
    let totalBytes = 0;
    let body = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        totalBytes += value?.byteLength ?? 0;
        if (totalBytes > maxBytes) {
          await reader.cancel();
          throw new Error(`${label}响应过大（上限 ${Math.round(maxBytes / 1024 / 1024)} MB）。`);
        }
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
      return body;
    } finally {
      reader.releaseLock();
    }
  } finally {
    responseAbortCleanups.get(response)?.();
    responseAbortCleanups.delete(response);
  }
}

function compactResponseText(body: string): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, 260);
}

function looksLikeHtmlResponse(body: string, contentType: string): boolean {
  const text = body.trim().toLowerCase();
  return contentType.includes('text/html') || text.startsWith('<!doctype') || text.startsWith('<html');
}

async function readJsonResponse<T>(response: Response, requestUrl: string, label: string): Promise<T> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  const body = await readLimitedResponseText(response, maxJsonResponseBytes, label);

  if (!response.ok) {
    throw new Error(`${label}失败：${response.status} ${compactResponseText(body)}`);
  }

  if (looksLikeHtmlResponse(body, contentType)) {
    throw new Error(
      `${label}返回的是 HTML 页面，不是 JSON。当前请求地址：${requestUrl}。请确认 Base URL 是 OpenAI/New API 兼容接口地址，例如 https://new-api.zxzt123.com/v1；如果只填主站域名，服务端通常会返回管理后台页面。`
    );
  }

  try {
    return JSON.parse(body) as T;
  } catch (error) {
    throw new Error(
      `${label}返回内容不是有效 JSON：${error instanceof Error ? error.message : String(error)}。当前请求地址：${requestUrl}。响应片段：${compactResponseText(body)}`
    );
  }
}

function headersToObject(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }

  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  return headers as Record<string, string>;
}

async function providerFetch(
  url: string,
  init: RequestInit,
  timeoutMs = defaultRequestTimeoutMs
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(init.signal?.reason ?? createAbortError());
  if (init.signal?.aborted) {
    throw createAbortError();
  }
  init.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(createAbortError('请求超时。'));
  }, timeoutMs);
  const cleanup = () => {
    clearTimeout(timeout);
    init.signal?.removeEventListener('abort', abortFromCaller);
  };

  try {
    let response: Response;
    if (Platform.OS !== 'web') {
      response = await fetch(url, { ...init, signal: controller.signal });
    } else {
      try {
        response = await fetch(webDevProxyUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url,
            method: init.method ?? 'GET',
            headers: headersToObject(init.headers),
            body: typeof init.body === 'string' ? init.body : undefined,
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) {
          throw error;
        }
        throw new Error('Web 调试代理未启动或不可访问。请用 npm run web 启动应用，或确认 127.0.0.1:8787 可访问。');
      }
    }

    responseAbortCleanups.set(response, cleanup);
    return response;
  } catch (error) {
    cleanup();
    if (timedOut) {
      const timeoutError = createAbortError(`请求超过 ${Math.round(timeoutMs / 1000)} 秒，已自动停止。`);
      timeoutError.name = 'TimeoutError';
      throw timeoutError;
    }
    if (init.signal?.aborted) {
      throw createAbortError();
    }
    throw error;
  }
}

function imageContent(attachment: MediaAttachment) {
  if (attachment.kind !== 'image') {
    throw new Error('当前通用适配器只支持图片附件；视频需要 provider-specific 适配器。');
  }

  const mimeType = attachment.mimeType || 'image/jpeg';
  const url = attachment.base64?.startsWith('data:')
    ? attachment.base64
    : attachment.base64
      ? `data:${mimeType};base64,${attachment.base64}`
      : attachment.uri;

  if (!url.startsWith('data:') && !safeExternalMediaUrl(url)) {
    throw new Error(`图片「${attachment.name}」只有本地地址，无法发送给远程模型。请通过“图片”入口重新选择。`);
  }

  return {
    type: 'image_url',
    image_url: {
      url,
    },
  };
}

function bailianInlineVideoPrefix(attachment: MediaAttachment): string {
  return `data:${attachment.mimeType || 'video/mp4'};base64,`;
}

function bailianMaxInlineVideoSourceBytes(attachment: MediaAttachment): number {
  const prefixBytes = new TextEncoder().encode(bailianInlineVideoPrefix(attachment)).byteLength;
  const availableBase64Bytes = Math.max(0, bailianMaxInlineVideoDataUrlBytes - prefixBytes);
  return Math.floor(availableBase64Bytes / 4) * 3;
}

function assertBailianInlineVideoSize(url: string, attachment: MediaAttachment): void {
  if (!url.toLowerCase().startsWith('data:')) {
    return;
  }
  const encodedBytes = new TextEncoder().encode(url).byteLength;
  if (encodedBytes > bailianMaxInlineVideoDataUrlBytes) {
    throw new Error(
      `视频「${attachment.name}」的 Base64 Data URL 编码后超过 10 MB；请改用公网 HTTPS URL。`
    );
  }
}

function videoContent(attachment: MediaAttachment, enforceBailianInlineLimit = false) {
  if (attachment.kind !== 'video') {
    throw new Error('当前附件不是视频，无法转换为 video_url。');
  }

  const mimeType = attachment.mimeType || 'video/mp4';
  const url = attachment.base64?.startsWith('data:')
    ? attachment.base64
    : attachment.base64
      ? `data:${mimeType};base64,${attachment.base64}`
      : attachment.uri;

  if (!url.startsWith('data:') && !safeExternalMediaUrl(url)) {
    throw new Error(`视频「${attachment.name}」只有本地地址，无法发送给远程模型。请重新选择或使用公网 URL。`);
  }
  if (enforceBailianInlineLimit) {
    assertBailianInlineVideoSize(url, attachment);
  }

  return {
    type: 'video_url',
    video_url: {
      url,
    },
  };
}

function fileContent(attachment: MediaAttachment) {
  if (attachment.kind !== 'file') {
    throw new Error('当前附件不是文件，无法转换为 file 内容。');
  }
  const inline = attachment.base64?.trim() || (attachment.uri.startsWith('data:') ? attachment.uri : '');
  if (!inline) {
    throw new Error(`文件「${attachment.name}」缺少 Base64 数据，无法发送给 OpenAI。`);
  }
  const match = inline.match(/^data:([^;,]+);base64,([\s\S]*)$/i);
  const mimeType = (match?.[1] || attachment.mimeType || 'application/octet-stream').trim().toLowerCase();
  const payload = (match?.[2] ?? inline).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || payload.length % 4 === 1) {
    throw new Error(`文件「${attachment.name}」的 Base64 数据无效。`);
  }
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  const estimatedBytes = Math.floor((payload.length * 3) / 4) - padding;
  if (estimatedBytes > openAiResponsesLimits.maxInlineFileBytes) {
    throw new Error(`文件「${attachment.name}」超过 20 MB 内联上限。`);
  }
  return {
    type: 'file',
    file: {
      filename: attachment.name || 'attachment',
      file_data: `data:${mimeType};base64,${payload}`,
    },
  };
}

function toOpenAiMessage(message: ChatMessage, provider?: ProviderProfile) {
  const mediaAttachments =
    message.attachments?.filter((attachment) => ['image', 'video', 'file'].includes(attachment.kind)) ?? [];
  if (message.role === 'user' && mediaAttachments.length) {
    return {
      role: message.role,
      content: [
        {
          type: 'text',
          text: message.content || '请分析附件。',
        },
        ...mediaAttachments.map((attachment) => {
          if (attachment.kind === 'image') return imageContent(attachment);
          if (attachment.kind === 'video') return videoContent(attachment, provider?.kind === 'bailian-compatible');
          return fileContent(attachment);
        }),
      ],
    };
  }

  return {
    role: message.role,
    content: message.content,
  };
}

async function materializeMessagesForRequest(
  messages: ChatMessage[],
  provider?: ProviderProfile
): Promise<ChatMessage[]> {
  return Promise.all(
    messages.map(async (message) => {
      if (message.role !== 'user' || !message.attachments?.length) {
        return message;
      }
      const attachments = await Promise.all(
        message.attachments.map((attachment) =>
          materializeAttachment(
            attachment,
            provider?.kind === 'bailian-compatible' &&
              attachment.kind === 'video' &&
              !attachment.base64 &&
              !attachment.uri.toLowerCase().startsWith('data:') &&
              !/^https?:\/\//i.test(attachment.uri)
              ? { maxSourceBytes: bailianMaxInlineVideoSourceBytes(attachment) }
              : undefined
          )
        )
      );
      return { ...message, attachments };
    })
  );
}

function readAssistantText(payload: any): string {
  const content = payload?.choices?.[0]?.message?.content;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        return part?.text ?? '';
      })
      .join('')
      .trim();
  }

  if (typeof payload?.output_text === 'string') {
    return payload.output_text;
  }

  return '模型返回了空内容。';
}

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readTextParts(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.trim() ? [value.trim()] : [];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }

      return (
        part?.text ??
        part?.content ??
        part?.reasoning_content ??
        part?.reasoningContent ??
        ''
      );
    })
    .filter((text) => typeof text === 'string' && text.trim())
    .map((text) => text.trim());
}

function readReasoningText(payload: any): string | undefined {
  const message = payload?.choices?.[0]?.message;
  const direct =
    nonEmptyText(message?.reasoning_content) ??
    nonEmptyText(message?.reasoningContent) ??
    nonEmptyText(message?.reasoning);

  if (direct) {
    return direct;
  }

  const contentParts = readTextParts(message?.reasoning_details ?? message?.thinking ?? message?.thoughts);
  if (contentParts.length) {
    return contentParts.join('\n\n');
  }

  const responseReasoning = Array.isArray(payload?.output)
    ? payload.output
        .filter((item: any) => item?.type === 'reasoning')
        .flatMap((item: any) => readTextParts(item?.summary ?? item?.content ?? item?.text))
    : [];

  if (responseReasoning.length) {
    return responseReasoning.join('\n\n');
  }

  return undefined;
}

function readDeltaText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const text = value
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }

      return part?.text ?? part?.content ?? '';
    })
    .join('');

  return text || undefined;
}

function readStreamContentUpdate(payload: any): { text: string; snapshot: boolean } | undefined {
  const choice = payload?.choices?.[0];
  const delta = choice?.delta;
  const deltaText = readDeltaText(delta?.content);
  if (typeof deltaText === 'string') {
    return { text: deltaText, snapshot: false };
  }

  const snapshotText = readDeltaText(choice?.message?.content);
  return typeof snapshotText === 'string' ? { text: snapshotText, snapshot: true } : undefined;
}

function readStreamReasoningDelta(payload: any): string | undefined {
  const choice = payload?.choices?.[0];
  const delta = choice?.delta;

  return (
    readDeltaText(delta?.reasoning_content) ??
    readDeltaText(delta?.reasoningContent) ??
    readDeltaText(delta?.reasoning) ??
    readDeltaText(delta?.thinking) ??
    readDeltaText(delta?.thoughts) ??
    readDeltaText(delta?.reasoning_details)
  );
}

function readFinalChatPayload(payload: any): ChatCompletionResult {
  return {
    content: readAssistantText(payload),
    reasoningContent: readReasoningText(payload),
    usage: readTokenUsage(payload),
    raw: payload,
  };
}

function applyStreamPayload(
  payload: any,
  state: {
    content: string;
    reasoningContent: string;
    usage?: ChatTokenUsage;
    lastPayload?: unknown;
    sawStreamPayload: boolean;
  },
  onStreamUpdate?: (update: ChatStreamUpdate) => void
) {
  state.sawStreamPayload = true;
  state.lastPayload = payload;

  const contentUpdate = readStreamContentUpdate(payload);
  const reasoningDelta = readStreamReasoningDelta(payload);
  const usage = readTokenUsage(payload);

  if (contentUpdate) {
    state.content = contentUpdate.snapshot ? contentUpdate.text : state.content + contentUpdate.text;
  }

  if (typeof reasoningDelta === 'string') {
    state.reasoningContent += reasoningDelta;
  }

  if (usage) {
    state.usage = usage;
  }

  if (state.content.length + state.reasoningContent.length > maxStreamOutputCharacters) {
    throw new Error('模型输出过长，已停止接收以保护应用内存。');
  }

  if (contentUpdate?.text || reasoningDelta || usage) {
    onStreamUpdate?.({
      content: state.content,
      reasoningContent: state.reasoningContent || undefined,
      usage: state.usage,
      raw: payload,
    });
  }
}

function processSseBlock(
  block: string,
  state: {
    content: string;
    reasoningContent: string;
    usage?: ChatTokenUsage;
    lastPayload?: unknown;
    sawStreamPayload: boolean;
    done: boolean;
  },
  onStreamUpdate?: (update: ChatStreamUpdate) => void
) {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
    .trim();

  if (!data) {
    return;
  }

  if (data === '[DONE]') {
    state.done = true;
    return;
  }

  if (new TextEncoder().encode(data).byteLength > maxStreamEventBytes) {
    throw new Error('模型返回的单个流事件过大，已停止接收。');
  }

  let payload: any;
  try {
    payload = JSON.parse(data);
  } catch (error) {
    throw new Error(`无法解析模型流事件：${error instanceof Error ? error.message : String(error)}`);
  }
  if (payload?.error) {
    const message =
      typeof payload.error?.message === 'string'
        ? payload.error.message
        : compactResponseText(JSON.stringify(payload.error));
    throw new Error(`对话流式请求失败：${message}`);
  }
  applyStreamPayload(payload, state, onStreamUpdate);
}

function finalizeStreamResult(
  state: {
    content: string;
    reasoningContent: string;
    usage?: ChatTokenUsage;
    lastPayload?: unknown;
    sawStreamPayload: boolean;
  }
): ChatCompletionResult {
  if (!state.sawStreamPayload) {
    throw new Error('模型没有返回有效的流式事件。');
  }

  return {
    content: state.content || (state.reasoningContent ? '' : '模型返回了空内容。'),
    reasoningContent: state.reasoningContent || undefined,
    usage: state.usage,
    raw: state.lastPayload,
  };
}

async function readStreamingChatCompletion(
  response: Response,
  onStreamUpdate?: (update: ChatStreamUpdate) => void
): Promise<ChatCompletionResult> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('application/json')) {
    const body = await readLimitedResponseText(response, maxJsonResponseBytes, '对话');
    if (looksLikeHtmlResponse(body, contentType)) {
      throw new Error('对话接口返回了 HTML 页面，请检查 Base URL。');
    }
    try {
      return readFinalChatPayload(JSON.parse(body));
    } catch (error) {
      throw new Error(`对话接口返回的 JSON 无法解析：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const state = {
    content: '',
    reasoningContent: '',
    usage: undefined as ChatTokenUsage | undefined,
    lastPayload: undefined as unknown,
    sawStreamPayload: false,
    done: false,
  };
  const decoder = new TextDecoder();
  let buffer = '';

  const consumeText = (text: string) => {
    buffer += text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    if (new TextEncoder().encode(buffer).byteLength > maxStreamEventBytes) {
      throw new Error('模型流缓冲区过大或事件分隔符无效，已停止接收。');
    }

    let separatorIndex = buffer.indexOf('\n\n');
    while (separatorIndex >= 0) {
      const block = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      processSseBlock(block, state, onStreamUpdate);
      separatorIndex = buffer.indexOf('\n\n');
    }
  };

  const reader = response.body?.getReader();

  try {
    if (!reader) {
      consumeText(await response.text());
    } else {
      while (!state.done) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        consumeText(decoder.decode(value, { stream: true }));
      }
      if (state.done) {
        await reader.cancel();
      }
      consumeText(decoder.decode());
    }

    if (buffer.trim() && !state.done) {
      processSseBlock(buffer, state, onStreamUpdate);
    }

    return finalizeStreamResult(state);
  } finally {
    reader?.releaseLock();
    responseAbortCleanups.get(response)?.();
    responseAbortCleanups.delete(response);
  }
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readTokenUsage(payload: any): ChatTokenUsage | undefined {
  const usage = payload?.usage;
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }

  const tokenUsage: ChatTokenUsage = {
    inputTokens: optionalNumber(usage.prompt_tokens) ?? optionalNumber(usage.input_tokens),
    outputTokens: optionalNumber(usage.completion_tokens) ?? optionalNumber(usage.output_tokens),
    reasoningTokens:
      optionalNumber(usage.completion_tokens_details?.reasoning_tokens) ??
      optionalNumber(usage.output_tokens_details?.reasoning_tokens),
    cachedInputTokens:
      optionalNumber(usage.prompt_tokens_details?.cached_tokens) ??
      optionalNumber(usage.input_tokens_details?.cached_tokens),
    totalTokens: optionalNumber(usage.total_tokens),
  };

  return Object.values(tokenUsage).some((value) => typeof value === 'number') ? tokenUsage : undefined;
}

function modelText(modelId: string): string {
  return modelId.toLowerCase();
}

function isOpenAiBaseUrl(provider: ProviderProfile): boolean {
  try {
    return parseProviderBaseUrl(provider.baseUrl).hostname.toLowerCase() === 'api.openai.com';
  } catch {
    return false;
  }
}

export function isOfficialOpenAiProvider(provider: ProviderProfile): boolean {
  return isOpenAiBaseUrl(provider);
}

function isDoubaoSeedModel(modelId: string): boolean {
  return modelText(modelId).includes('doubao-seed');
}

function supportsOpenAiNoneReasoning(modelId: string): boolean {
  const text = modelText(modelId).replace(/[:/_.\s]+/g, '-');
  const match = text.match(/(?:^|-)gpt-?5(?:-(\d+))?(?:\b|-)/);

  if (!match) {
    return false;
  }

  return Number(match[1] ?? '0') >= 1;
}

function supportsOpenAiMaxReasoning(modelId: string): boolean {
  const text = modelText(modelId).replace(/[:/_.\s]+/g, '-');
  const match = text.match(/(?:^|-)gpt-?5(?:-(\d+))?(?:\b|-)/);

  return Boolean(match && Number(match[1] ?? '0') >= 6);
}

function isOpenAiReasoningModelId(modelId: string): boolean {
  const text = modelText(modelId).replace(/[:/_.\s]+/g, '-');
  return /(?:^|-)(?:o1|o3|o4)(?:$|-)/.test(text) || /(?:^|-)gpt-?5(?:$|-)/.test(text);
}

function isDeepSeekV4Model(modelId: string): boolean {
  const text = modelText(modelId);
  return text.includes('deepseek-v4');
}

function bailianThinkingBudget(effort: ReasoningEffort): number | undefined {
  if (effort === 'low') {
    return 1024;
  }

  if (effort === 'medium') {
    return 4096;
  }

  if (effort === 'high') {
    return 8192;
  }

  if (effort === 'max') {
    return 16384;
  }

  return undefined;
}

function bailianReasoningEffort(
  family: ReturnType<typeof getBailianThinkingProfile>['reasoningEffortFamily'],
  effort: ReasoningEffort
): string | undefined {
  if (!family || effort === 'default' || effort === 'off') {
    return undefined;
  }

  if (family === 'deepseek-v4') {
    return effort === 'max' ? 'max' : 'high';
  }

  if (family === 'glm-5.1-or-5' && effort === 'max') {
    return 'xhigh';
  }

  return effort;
}

function arkReasoningEffort(effort: ReasoningEffort): string | undefined {
  if (effort === 'default') {
    return undefined;
  }

  return effort;
}

function doubaoReasoningEffort(effort: ReasoningEffort): string | undefined {
  if (effort === 'default' || effort === 'off') {
    return undefined;
  }

  return effort === 'max' ? 'high' : effort;
}

function openAiReasoningEffort(effort: ReasoningEffort, modelId: string): string | undefined {
  if (effort === 'default') {
    return undefined;
  }

  if (effort === 'off') {
    return supportsOpenAiNoneReasoning(modelId) ? 'none' : 'minimal';
  }

  if (effort === 'max') {
    return supportsOpenAiMaxReasoning(modelId) ? 'max' : 'xhigh';
  }

  return effort;
}

function compatibleReasoningEffort(effort: ReasoningEffort, modelId: string): string | undefined {
  if (effort === 'default') {
    return undefined;
  }

  if (effort === 'off') {
    return supportsOpenAiNoneReasoning(modelId) ? 'none' : 'minimal';
  }

  return effort === 'max' ? 'xhigh' : effort;
}

function deepSeekV4ReasoningEffort(effort: ReasoningEffort): string | undefined {
  if (effort === 'off' || effort === 'default') {
    return undefined;
  }

  return effort === 'max' ? 'max' : 'high';
}

function boundedNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundedParameter(value: number): number {
  return Math.round(value * 100) / 100;
}

function isAlibabaHostedKimiWithSampling(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  return /^kimi-k2\.(?:5|6)$/.test(id) ||
    id === 'kimi-k2.7-code' ||
    id === 'moonshot-kimi-k2-instruct';
}

function reasoningIsActiveForSampling(
  provider: ProviderProfile,
  model: ModelInfo,
  effort: ReasoningEffort
): boolean {
  if (!isReasoningModel(model) || effort === 'off' || effort === 'none') {
    return false;
  }

  if (provider.kind === 'bailian-compatible') {
    const profile = getBailianThinkingProfile(model.id);
    if (
      /^minimax-m2\.(?:1|5)$/i.test(model.id.trim()) ||
      isAlibabaHostedKimiWithSampling(model.id) ||
      profile.mode === 'mixed'
    ) {
      // Bailian mixed-thinking models keep their documented sampling surface;
      // Alibaba-hosted MiniMax and current Kimi aliases do as well.
      return false;
    }

    if (effort === 'default') {
      return true;
    }
  }

  return true;
}

export function supportsEditableModelParameters(provider: ProviderProfile, modelId: string): boolean {
  if (provider.kind !== 'bailian-compatible') {
    return true;
  }

  const id = modelId.trim().toLowerCase();
  if (id === 'kimi-k2-thinking' || id.startsWith('kimi/') || id.startsWith('minimax/')) {
    return false;
  }
  const profile = getBailianThinkingProfile(modelId);
  if (
    profile.mode === 'thinking-only' &&
    !profile.supportsThinkingBudget &&
    !/^minimax-m2\.(?:1|5)$/i.test(modelId.trim()) &&
    !isAlibabaHostedKimiWithSampling(modelId)
  ) {
    return false;
  }
  return true;
}

export type EditableModelParameterKey = Exclude<keyof ModelParameterSettings, 'enabled'>;

export interface ModelParameterConstraint {
  supported: boolean;
  min: number;
  max: number;
}

export function getModelParameterConstraint(
  provider: ProviderProfile,
  modelId: string,
  key: EditableModelParameterKey
): ModelParameterConstraint {
  const defaults: Record<EditableModelParameterKey, { min: number; max: number }> = {
    temperature: { min: 0, max: 2 },
    topP: { min: 0, max: 1 },
    presencePenalty: { min: -2, max: 2 },
    frequencyPenalty: { min: -2, max: 2 },
  };
  const range = { ...defaults[key] };
  if (!supportsEditableModelParameters(provider, modelId)) {
    return { supported: false, ...range };
  }

  if (
    isOpenAiBaseUrl(provider) &&
    isOpenAiReasoningModelId(modelId) &&
    (key === 'presencePenalty' || key === 'frequencyPenalty')
  ) {
    return { supported: false, ...range };
  }

  if (provider.kind === 'bailian-compatible') {
    const id = modelId.trim().toLowerCase();
    const profile = getBailianThinkingProfile(modelId);
    if (key === 'temperature') range.max = 1.99;
    if (key === 'topP') range.min = 0.01;
    if (
      (key === 'presencePenalty' || key === 'frequencyPenalty') &&
      (id.includes('deepseek-') || id.includes('glm-'))
    ) {
      return { supported: false, ...range };
    }
    if (key === 'presencePenalty' && profile.reasoningEffortFamily === 'stepfun') {
      return { supported: false, ...range };
    }
    if (key === 'frequencyPenalty' && (
      /^minimax-m2\.(?:1|5)$/i.test(modelId.trim()) ||
      isAlibabaHostedKimiWithSampling(modelId)
    )) return { supported: false, ...range };
    if (
      key === 'frequencyPenalty' &&
      profile.reasoningEffortFamily === 'stepfun'
    ) {
      range.min = 0;
      range.max = 1;
    }
  }

  return { supported: true, ...range };
}

export function modelParameterSettingsWillApply(
  provider: ProviderProfile,
  model: ModelInfo,
  effort: ReasoningEffort
): boolean {
  return supportsEditableModelParameters(provider, model.id) &&
    !reasoningIsActiveForSampling(provider, model, effort);
}

function applyModelParameterOptions(
  body: Record<string, unknown>,
  settings: ModelParameterSettings | undefined,
  provider: ProviderProfile,
  model: ModelInfo,
  effort: ReasoningEffort
) {
  if (!settings?.enabled) {
    return;
  }

  const reasoningModel = isReasoningModel(model);
  if (reasoningIsActiveForSampling(provider, model, effort)) {
    return;
  }
  if (!supportsEditableModelParameters(provider, model.id)) {
    return;
  }

  const temperatureConstraint = getModelParameterConstraint(provider, model.id, 'temperature');
  const topPConstraint = getModelParameterConstraint(provider, model.id, 'topP');
  const temperature = roundedParameter(
    boundedNumber(settings.temperature, temperatureConstraint.min, temperatureConstraint.max)
  );
  const topP = roundedParameter(
    boundedNumber(settings.topP, topPConstraint.min, topPConstraint.max)
  );
  if (temperatureConstraint.supported && temperature !== 1) {
    body.temperature = temperature;
  } else if (topPConstraint.supported && topP !== 1) {
    body.top_p = topP;
  }

  // Official GPT reasoning models do not document penalty parameters even
  // when effort=none, so keep those fields off the wire.
  if (!reasoningModel || !isOpenAiBaseUrl(provider)) {
    const presenceConstraint = getModelParameterConstraint(provider, model.id, 'presencePenalty');
    const frequencyConstraint = getModelParameterConstraint(provider, model.id, 'frequencyPenalty');
    const presencePenalty = roundedParameter(
      boundedNumber(settings.presencePenalty, presenceConstraint.min, presenceConstraint.max)
    );
    const frequencyPenalty = roundedParameter(
      boundedNumber(settings.frequencyPenalty, frequencyConstraint.min, frequencyConstraint.max)
    );
    if (presenceConstraint.supported && presencePenalty !== 0) body.presence_penalty = presencePenalty;
    if (frequencyConstraint.supported && frequencyPenalty !== 0) body.frequency_penalty = frequencyPenalty;
  }
}

function applyReasoningOptions(
  body: Record<string, unknown>,
  provider: ProviderProfile,
  modelId: string,
  effort: ReasoningEffort
) {
  if (effort === 'default') {
    return;
  }

  if (isVolcengineArkProvider(provider)) {
    if (effort === 'off') {
      body.thinking = { type: 'disabled' };
      return;
    }

    const value = arkReasoningEffort(effort);
    if (value) {
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = value;
    }
    return;
  }

  if (provider.kind === 'bailian-compatible') {
    const profile = getBailianThinkingProfile(modelId);
    if (profile.mode === 'none') {
      return;
    }

    if (effort === 'off') {
      if (profile.mode === 'mixed') {
        if (profile.control === 'thinking-object') {
          body.thinking = { type: 'disabled' };
        } else {
          body.enable_thinking = false;
        }
      }
      return;
    }

    if (profile.mode === 'mixed') {
      if (profile.control === 'thinking-object') {
        body.thinking = { type: 'adaptive' };
      } else {
        body.enable_thinking = true;
      }
    }

    const nativeEffort = bailianReasoningEffort(profile.reasoningEffortFamily, effort);
    if (nativeEffort) {
      body.reasoning_effort = nativeEffort;
    }

    if (profile.supportsThinkingBudget) {
      const budget = bailianThinkingBudget(effort);
      if (budget) body.thinking_budget = budget;
    }
    return;
  }

  if (isDoubaoSeedModel(modelId)) {
    body.thinking = { type: effort === 'off' ? 'disabled' : 'enabled' };
    const value = doubaoReasoningEffort(effort);
    if (value) {
      body.reasoning_effort = value;
    }
    return;
  }

  if (isDeepSeekV4Model(modelId)) {
    if (effort === 'off') {
      body.thinking = { type: 'disabled' };
      return;
    }

    body.thinking = { type: 'enabled' };
    const value = deepSeekV4ReasoningEffort(effort);
    if (value) {
      body.reasoning_effort = value;
    }
    return;
  }

  if (isOpenAiBaseUrl(provider)) {
    const value = openAiReasoningEffort(effort, modelId);
    if (value) {
      body.reasoning_effort = value;
    }
    return;
  }

  const value = compatibleReasoningEffort(effort, modelId);
  if (value) {
    body.reasoning_effort = value;
  }
}

export async function fetchOpenAiCompatibleModels(
  provider: ProviderProfile,
  signal?: AbortSignal
): Promise<ModelInfo[]> {
  const baseUrl = assertBaseUrl(provider);
  const requestUrl = `${baseUrl}/models`;
  const response = await providerFetch(requestUrl, {
    method: 'GET',
    headers: authHeaders(provider),
    signal,
  }, discoveryRequestTimeoutMs);

  let payload: { data?: RemoteModel[]; error?: unknown };
  try {
    payload = await readJsonResponse<{ data?: RemoteModel[]; error?: unknown }>(response, requestUrl, '模型列表获取');
  } catch (error) {
    if (
      provider.kind !== 'bailian-compatible' ||
      isAbortError(error) ||
      (error instanceof Error && error.name === 'TimeoutError')
    ) {
      throw error;
    }

    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `百炼的 OpenAI 兼容 /models 接口当前不可用。请在百炼模型目录或控制台确认 Model ID 后，使用“手动添加模型”继续。详情：${detail}`
    );
  }

  if ((payload as { error?: unknown }).error) {
    const detail = compactResponseText(JSON.stringify((payload as { error: unknown }).error));
    if (provider.kind === 'bailian-compatible') {
      throw new Error(
        `百炼的 OpenAI 兼容 /models 接口返回错误。请在百炼模型目录或控制台确认 Model ID 后，使用“手动添加模型”继续。详情：${detail}`
      );
    }
    throw new Error(`模型列表接口返回错误：${detail}`);
  }
  if (provider.kind === 'bailian-compatible' && !Array.isArray(payload.data)) {
    throw new Error(
      '百炼的 OpenAI 兼容 /models 响应未包含模型列表。请在百炼模型目录或控制台确认 Model ID 后，使用“手动添加模型”继续。'
    );
  }
  const remoteModels = Array.isArray(payload.data) ? payload.data : [];
  const seen = new Set<string>();

  return remoteModels
    .slice(0, 5000)
    .map((model) => ({ ...model, id: typeof model.id === 'string' ? model.id.trim() : model.id }))
    .filter((model) => {
      if (!model.id || seen.has(model.id)) {
        return false;
      }
      seen.add(model.id);
      return true;
    })
    .map((model) => enrichDiscoveredModel(provider, model))
    .filter((model): model is ModelInfo => Boolean(model));
}

function latestUserPrompt(messages: ChatMessage[]): string {
  const message = [...messages].reverse().find((item) => item.role === 'user' && item.content.trim());
  return message?.content.trim() ?? '';
}

function isDallEModel(modelId: string): boolean {
  return /(?:^|[/_-])dall[·._-]?e[._-]?(?:2|3)(?:$|[/_.-])/i.test(modelId);
}

function generatedImageUrls(payload: any): string[] {
  if (!Array.isArray(payload?.data)) {
    return [];
  }

  return payload.data
    .map((image: any) => nonEmptyText(image?.url) ?? nonEmptyText(image?.image_url?.url) ?? nonEmptyText(image?.b64_json))
    .filter((url: string | undefined): url is string => Boolean(url));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(createAbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function videoTaskStatus(task: ArkVideoTaskResponse): string | undefined {
  return task.status ?? task.data?.status;
}

function videoTaskUrl(task: ArkVideoTaskResponse): string | undefined {
  return nonEmptyText(task.content?.video_url) ??
    nonEmptyText(task.content?.url) ??
    nonEmptyText(task.data?.content?.video_url) ??
    nonEmptyText(task.data?.content?.url);
}

function safeExternalMediaUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHostname(url.hostname))) {
      return url.toString();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function retrieveArkVideoTask(
  provider: ProviderProfile,
  taskId: string,
  signal?: AbortSignal
): Promise<ArkVideoTaskResponse> {
  const baseUrl = assertBaseUrl(provider);
  const response = await providerFetch(`${baseUrl}/contents/generations/tasks/${encodeURIComponent(taskId)}`, {
    method: 'GET',
    headers: authHeaders(provider),
    signal,
  });

  if (!response.ok) {
    const body = await readLimitedResponseText(response, maxErrorResponseBytes, '视频生成任务查询');
    throw new Error(`视频生成任务查询失败：${response.status} ${body.slice(0, 240)}`);
  }

  const body = await readLimitedResponseText(response, maxJsonResponseBytes, '视频生成任务查询');
  return JSON.parse(body) as ArkVideoTaskResponse;
}

function videoTaskAttachment(taskId: string, modelId: string, videoUrl: string): MediaAttachment {
  return {
    id: `generated-video-${taskId}`,
    kind: 'video',
    uri: videoUrl,
    name: `${modelId}.mp4`,
  };
}

async function persistGeneratedAttachmentSafely(
  attachment: MediaAttachment
): Promise<{ attachment: MediaAttachment; durable: boolean }> {
  try {
    const persisted = await persistAttachment(attachment, { downloadRemote: true });
    return {
      attachment: persisted,
      durable: !/^https?:\/\//i.test(persisted.uri),
    };
  } catch {
    // Keep the provider URL usable when CORS, connectivity, or storage quota
    // prevents a durable copy; the caller must surface the expiry warning.
    return { attachment, durable: false };
  }
}

export async function queryGenerationTask(
  provider: ProviderProfile,
  task: GenerationTaskInfo,
  signal?: AbortSignal
): Promise<ChatCompletionResult> {
  if (task.kind !== 'video') {
    throw new Error('当前只支持查询视频生成任务。');
  }

  if (!isVolcengineArkProvider(provider)) {
    throw new Error('当前只适配了火山 Ark 的视频生成任务查询。');
  }

  const payload = await retrieveArkVideoTask(provider, task.taskId, signal);
  const status = (videoTaskStatus(payload) ?? task.status ?? 'submitted').toLowerCase();
  const videoUrl = safeExternalMediaUrl(videoTaskUrl(payload));
  const generationTask: GenerationTaskInfo = {
    ...task,
    status,
  };

  if (status === 'expired') {
    throw new Error(`视频生成任务已过期，请重新提交。任务 ID：${task.taskId}`);
  }
  if (status === 'cancelled' || status === 'canceled') {
    throw new Error(`视频生成任务已取消。任务 ID：${task.taskId}`);
  }
  if (status === 'failed') {
    throw new Error(`视频生成任务失败：${payload.error?.message ?? task.taskId}`);
  }

  if (videoUrl) {
    const persistedVideo = await persistGeneratedAttachmentSafely(
      videoTaskAttachment(task.taskId, task.modelId, videoUrl)
    );
    return {
      content: persistedVideo.durable
        ? `视频生成完成。任务 ID：${task.taskId}`
        : `视频生成完成，但未能复制到本地；该下载链接可能在 24 小时后失效，请尽快导出。任务 ID：${task.taskId}`,
      attachments: [persistedVideo.attachment],
      generationTask,
      raw: payload,
    };
  }

  return {
    content: `视频生成任务尚未完成，任务 ID：${task.taskId}，当前状态：${status}。`,
    generationTask,
    raw: payload,
  };
}

async function sendImageGenerationRequest(
  provider: ProviderProfile,
  modelId: string,
  messages: ChatMessage[],
  signal?: AbortSignal
): Promise<ChatCompletionResult> {
  const baseUrl = assertBaseUrl(provider);
  const prompt = latestUserPrompt(messages);

  if (!prompt) {
    throw new Error('请先输入图片生成提示词。');
  }
  if (messages.some((message) => message.attachments?.length)) {
    throw new Error('当前图片生成适配器只支持文本生图，尚未接入参考图编辑接口。');
  }

  const requestBody: Record<string, unknown> = {
    model: modelId,
    prompt,
    size: '1024x1024',
  };
  if (isDallEModel(modelId)) {
    // DALL-E download URLs expire quickly; base64 lets the native client move
    // the image into durable app storage before saving the conversation.
    requestBody.response_format = 'b64_json';
  } else if (/gpt[._-]?image/i.test(modelId)) {
    // GPT Image 系列固定返回 base64，不支持 response_format。
    requestBody.output_format = 'png';
  }

  const response = await providerFetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: authHeaders(provider),
    body: JSON.stringify(requestBody),
    signal,
  });

  if (!response.ok) {
    const body = await readLimitedResponseText(response, maxErrorResponseBytes, '图片生成');
    throw new Error(`图片生成请求失败：${response.status} ${body.slice(0, 320)}`);
  }

  const responseBody = await readLimitedResponseText(response, maxGeneratedImageResponseBytes, '图片生成');
  const payload = JSON.parse(responseBody);
  const persistedImages = await Promise.all(
    generatedImageUrls(payload).map((imageUrl, index) => persistGeneratedAttachmentSafely({
      id: `generated-image-${Date.now()}-${index}`,
      kind: 'image',
      uri: imageUrl.startsWith('data:') ? imageUrl : imageUrl.startsWith('http') ? imageUrl : `data:image/png;base64,${imageUrl}`,
      name: `${modelId}-${index + 1}.png`,
      mimeType: 'image/png',
    }))
  );
  const attachments = persistedImages.map((item) => item.attachment);
  const hasTemporaryImage = persistedImages.some((item) => !item.durable);

  return {
    content: attachments.length
      ? hasTemporaryImage
        ? '图片生成完成，但部分远程图片未能复制到本地，请尽快导出。'
        : '图片生成完成。'
      : '图片生成完成，但响应中没有可展示的图片 URL。',
    usage: readTokenUsage(payload),
    attachments,
    raw: payload,
  };
}

async function sendArkVideoGenerationRequest(
  provider: ProviderProfile,
  modelId: string,
  messages: ChatMessage[],
  signal?: AbortSignal
): Promise<ChatCompletionResult> {
  const baseUrl = assertBaseUrl(provider);
  const prompt = latestUserPrompt(messages);

  if (!prompt) {
    throw new Error('请先输入视频生成提示词。');
  }

  const requestMessages = await materializeMessagesForRequest(messages, provider);
  const latestUserMessage = [...requestMessages].reverse().find((message) => message.role === 'user');
  const referenceContent = (latestUserMessage?.attachments ?? []).map((attachment) => {
    if (attachment.kind === 'image') return imageContent(attachment);
    if (attachment.kind === 'video') return videoContent(attachment);
    throw new Error(`视频生成暂不支持附件「${attachment.name}」的文件类型。`);
  });

  const response = await providerFetch(`${baseUrl}/contents/generations/tasks`, {
    method: 'POST',
    headers: authHeaders(provider),
    body: JSON.stringify({
      model: modelId,
      content: [
        {
          type: 'text',
          text: prompt,
        },
        ...referenceContent,
      ],
    }),
    signal,
  });

  if (!response.ok) {
    const body = await readLimitedResponseText(response, maxErrorResponseBytes, '视频生成任务提交');
    throw new Error(`视频生成任务提交失败：${response.status} ${body.slice(0, 320)}`);
  }

  const responseBody = await readLimitedResponseText(response, maxJsonResponseBytes, '视频生成任务提交');
  const payload = JSON.parse(responseBody) as ArkVideoTaskResponse;
  const taskId = payload.id;

  if (!taskId) {
    return {
      content: '视频生成任务已提交，但响应中没有返回任务 ID。',
      raw: payload,
    };
  }

  const generationTask: GenerationTaskInfo = {
    providerId: provider.id,
    modelId,
    taskId,
    kind: 'video',
    status: 'submitted',
  };

  let task = payload;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const status = videoTaskStatus(task)?.toLowerCase();
    if (
      status === 'succeeded' ||
      status === 'failed' ||
      status === 'cancelled' ||
      status === 'canceled' ||
      status === 'expired'
    ) {
      break;
    }

    await sleep(2500, signal);
    task = await retrieveArkVideoTask(provider, taskId, signal);
  }

  const status = (videoTaskStatus(task) ?? 'submitted').toLowerCase();
  const videoUrl = safeExternalMediaUrl(videoTaskUrl(task));
  const updatedTask: GenerationTaskInfo = {
    ...generationTask,
    status,
  };

  if (status === 'expired') {
    throw new Error(`视频生成任务已过期，请重新提交。任务 ID：${taskId}`);
  }
  if (status === 'cancelled' || status === 'canceled') {
    throw new Error(`视频生成任务已取消。任务 ID：${taskId}`);
  }
  if (status === 'failed') {
    throw new Error(`视频生成任务失败：${task.error?.message ?? taskId}`);
  }

  if (videoUrl) {
    const persistedVideo = await persistGeneratedAttachmentSafely(
      videoTaskAttachment(taskId, modelId, videoUrl)
    );
    return {
      content: persistedVideo.durable
        ? `视频生成完成。任务 ID：${taskId}`
        : `视频生成完成，但未能复制到本地；该下载链接可能在 24 小时后失效，请尽快导出。任务 ID：${taskId}`,
      attachments: [persistedVideo.attachment],
      generationTask: updatedTask,
      raw: task,
    };
  }

  return {
    content: `视频生成任务已提交，任务 ID：${taskId}，当前状态：${status}。生成时间较长时需要稍后查询任务结果。`,
    generationTask: updatedTask,
    raw: task,
  };
}

export function assertChatAttachmentsSupported(
  attachments: MediaAttachment[],
  model: ModelInfo,
  provider?: ProviderProfile
): void {
  const hasImage = attachments.some((attachment) => attachment.kind === 'image');
  const hasVideo = attachments.some((attachment) => attachment.kind === 'video');
  const hasFile = attachments.some((attachment) => attachment.kind === 'file');

  if (hasImage && !isVisionModel(model)) {
    throw new Error(`当前模型「${model.name ?? model.id}」未标记为支持图片输入，请切换视觉模型或在模型能力中开启图片输入。`);
  }

  if (hasVideo) {
    if (!isVideoInputModel(model)) {
      throw new Error(`当前模型「${model.name ?? model.id}」未标记为支持视频输入，请切换视频模型。`);
    }
    const arkVideoGeneration = Boolean(
      provider && isVolcengineArkProvider(provider) && inferModelTask(model) === 'video-generation'
    );
    if (provider?.kind !== 'bailian-compatible' && !arkVideoGeneration) {
      throw new Error('当前只在阿里百炼兼容模式中实现了 video_url 对话附件。');
    }
  }

  if (hasFile) {
    if (!model.capabilities.includes('file-input')) {
      throw new Error(`当前模型「${model.name ?? model.id}」未标记为支持文件输入。`);
    }
    if (!provider || !isOpenAiBaseUrl(provider)) {
      throw new Error('文件附件只在 OpenAI 官方 API 中启用；兼容中转的文件协议需要单独适配。');
    }
  }
}

export async function sendOpenAiCompatibleChat({
  provider,
  modelId,
  model,
  messages,
  reasoningEffort,
  parameterSettings,
  onStreamUpdate,
  signal,
}: ChatCompletionArgs): Promise<ChatCompletionResult> {
  if (!modelId) {
    throw new Error('请先选择一个模型。');
  }

  const requestModel = model ?? createModelInfoFromId(provider, modelId, 'manual');
  const task = inferModelTask(requestModel);

  if (task === 'image-generation') {
    return sendImageGenerationRequest(provider, modelId, messages, signal);
  }

  if (task === 'video-generation') {
    if (!isVolcengineArkProvider(provider)) {
      throw new Error('当前只适配了火山 Ark 的视频生成任务接口。');
    }

    return sendArkVideoGenerationRequest(provider, modelId, messages, signal);
  }

  if (task === 'embedding' || task === 'rerank') {
    throw new Error('当前模型不是对话模型，不能在聊天窗口中调用。请切换到文本/多模态对话模型。');
  }

  const chatAttachments = messages.flatMap((message) => message.attachments ?? []);
  assertChatAttachmentsSupported(chatAttachments, requestModel, provider);

  if (isOpenAiResponsesOnlyModel(provider, modelId)) {
    const requestMessages = await materializeMessagesForRequest(messages, provider);
    const request = buildOpenAiResponsesRequest({
      provider,
      modelId,
      messages: requestMessages,
      reasoningEffort: normalizeReasoningEffort(provider, requestModel, reasoningEffort),
    });
    const response = await providerFetch(
      request.url,
      {
        method: 'POST',
        headers: authHeaders(provider),
        body: JSON.stringify(request.body),
        signal,
      },
      openAiProRequestTimeoutMs
    );
    const responseBody = await readLimitedResponseText(
      response,
      response.ok ? openAiResponsesLimits.maxResponseJsonBytes : maxErrorResponseBytes,
      'OpenAI Responses'
    );
    if (!response.ok) {
      throw new Error(`OpenAI Responses 请求失败：${response.status} ${compactResponseText(responseBody)}`);
    }
    return parseOpenAiResponsesResponse(responseBody);
  }

  const baseUrl = assertBaseUrl(provider);
  const requestMessages = await materializeMessagesForRequest(messages, provider);
  const body: Record<string, unknown> = {
    model: modelId,
    messages: requestMessages.map((message) => toOpenAiMessage(message, provider)),
    stream: true,
    stream_options: {
      include_usage: true,
    },
  };
  const normalizedEffort = normalizeReasoningEffort(provider, requestModel, reasoningEffort);
  applyModelParameterOptions(body, parameterSettings, provider, requestModel, normalizedEffort);
  applyReasoningOptions(body, provider, modelId, normalizedEffort);

  const response = await providerFetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      ...authHeaders(provider),
      Accept: 'text/event-stream, application/json',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const body = await readLimitedResponseText(response, maxErrorResponseBytes, '对话请求');
    if (response.status === 404 && body.includes('InvalidEndpointOrModel.NotFound')) {
      throw new Error(
        `对话请求失败：当前模型 ID「${modelId}」不存在或当前 API Key 无权调用。请在配置页点击“获取模型”，选择接口返回的可用模型；如果火山控制台显示的是专属 Endpoint ID，请手动添加那个 ID。`
      );
    }
    throw new Error(`对话请求失败：${response.status} ${body.slice(0, 320)}`);
  }

  return readStreamingChatCompletion(response, onStreamUpdate);
}
