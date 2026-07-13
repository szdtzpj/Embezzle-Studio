import type {
  ActivityTimelineStep,
  ChatCompletionResult,
  ChatMessage,
  ChatTokenUsage,
  ExternalSearchSettings,
  GenerationTaskInfo,
  MediaAttachment,
  ModelParameterSettings,
  ModelInfo,
  PluginManifest,
  ProviderProfile,
  ReasoningEffort,
  ToolActivityItem,
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
  getOpenAiResponsesEndpoint,
  isOpenAiResponsesOnlyModel,
  openAiResponsesLimits,
  parseOpenAiResponsesResponse,
  toOpenAiResponsesInput,
} from './openAiResponses';
import {
  assertProviderWebSearchMessagesSupported,
  buildProviderWebSearchRequest,
  parseProviderWebSearchResponse,
  resolveProviderWebSearchProtocol,
  type OpenAiWebSearchContextSize,
} from './providerWebSearch';
import {
  citationsFromExternalSearchResults,
  EXTERNAL_SEARCH_TOOL_NAME,
  formatExternalSearchToolResult,
  getExternalSearchSystemPrompt,
  getExternalSearchToolDefinition,
  parseSearchWebToolArguments,
  reindexExternalSearchResult,
  resolveActiveExternalSearchService,
  runExternalSearch,
  type ExternalSearchResult,
} from './externalSearch';
import {
  completeOpenThinkingSteps,
  nextTimelineSequence,
  toolActivityTitle,
  upsertTimelineStep,
  upsertToolActivity,
} from './messageActivity';
import { getRemoteMcpExecutableReadiness } from '../plugins/contracts';
import { isExactOfficialOpenAiProvider } from './providerSetup';
import {
  providerMcpLimits,
  runOpenAiProviderMcp,
  type ProviderMcpApprovalDecision,
  type ProviderMcpApprovalRequest,
  type ProviderMcpApprovalContext,
  type ProviderMcpContinuationContext,
  type ProviderMcpSendContext,
} from './providerMcp';

export interface ChatMcpOptions {
  plugin: PluginManifest;
  requestApproval: (
    request: ProviderMcpApprovalRequest,
    context: ProviderMcpApprovalContext
  ) => Promise<ProviderMcpApprovalDecision> | ProviderMcpApprovalDecision;
  beforeContinuation?: (
    context: ProviderMcpContinuationContext
  ) => Promise<void> | void;
  beforeProviderRequest?: (
    context: ProviderMcpSendContext
  ) => Promise<void> | void;
  onProviderRequestStarted?: (context: ProviderMcpSendContext) => void;
}

export interface ExternalSearchProviderRequestContext {
  requestNumber: number;
  signal?: AbortSignal;
}

interface ChatCompletionArgs {
  provider: ProviderProfile;
  modelId: string;
  model?: ModelInfo;
  messages: ChatMessage[];
  reasoningEffort: ReasoningEffort;
  parameterSettings?: ModelParameterSettings;
  maxOutputTokens?: number;
  onStreamUpdate?: (update: ChatStreamUpdate) => void;
  webSearch?: {
    enabled: boolean;
    searchContextSize: OpenAiWebSearchContextSize;
  };
  externalSearch?: ExternalSearchSettings;
  beforeExternalSearchProviderRequest?: (
    context: ExternalSearchProviderRequestContext
  ) => Promise<void> | void;
  mcp?: ChatMcpOptions;
  signal?: AbortSignal;
}

interface ChatStreamUpdate {
  content: string;
  reasoningContent?: string;
  usage?: ChatTokenUsage;
  toolActivity?: ToolActivityItem[];
  activityTimeline?: ActivityTimelineStep[];
  raw?: unknown;
}

interface ToolLoopModelResult {
  content: string;
  reasoningContent?: string;
  usage?: ChatTokenUsage;
  toolCalls: Array<Record<string, any>>;
  raw: unknown;
}

interface StreamToolCallAccumulator {
  index: number;
  id?: string;
  type?: string;
  name: string;
  arguments: string;
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

interface WebDevelopmentProxyRuntime {
  platform?: string;
  development?: boolean;
  explicitlyEnabled?: boolean;
  location?: {
    protocol: string;
    hostname: string;
  };
}

function createAbortError(message = '请求已取消。'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

export function isWebDevelopmentProxyAllowed({
  platform = Platform.OS,
  development = typeof __DEV__ !== 'undefined' && __DEV__ === true,
  explicitlyEnabled = process.env.EXPO_PUBLIC_ENABLE_WEB_DEV_PROXY === '1',
  location = typeof window !== 'undefined'
    ? { protocol: window.location.protocol, hostname: window.location.hostname }
    : undefined,
}: WebDevelopmentProxyRuntime = {}): boolean {
  return Boolean(
    platform === 'web' &&
    development &&
    explicitlyEnabled &&
    location &&
    (location.protocol === 'http:' || location.protocol === 'https:') &&
    isLoopbackHostname(location.hostname)
  );
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
      `${label}返回的是 HTML 页面，不是 JSON。当前请求地址：${requestUrl}。请确认 Base URL 是 OpenAI/New API 兼容接口地址，例如 https://your-relay.example.com/v1；如果只填主站域名，服务端通常会返回管理后台页面。`
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
      if (!isWebDevelopmentProxyAllowed()) {
        throw new Error(
          '正式 Web 构建不会发送 API Key 或模型请求。仅可在本机通过 npm run web 显式启动受限调试代理。'
        );
      }
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

/**
 * Shared API transport for direct native requests and the explicitly enabled
 * local Web development proxy. Production Web builds fail closed.
 */
export const guardedApiFetch: typeof fetch = async (input, init) => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url;
  return providerFetch(url, init ?? {});
};

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

function appendStreamFragment(current: string, fragment: unknown): string {
  if (typeof fragment !== 'string' || !fragment) return current;
  if (!current || fragment.startsWith(current)) return fragment;
  return current + fragment;
}

function collectStreamToolCalls(
  payload: any,
  calls: Map<number, StreamToolCallAccumulator>
): void {
  const choice = payload?.choices?.[0];
  const snapshotCalls = Array.isArray(choice?.message?.tool_calls)
    ? choice.message.tool_calls
    : undefined;
  const deltaCalls = Array.isArray(choice?.delta?.tool_calls)
    ? choice.delta.tool_calls
    : undefined;
  const rows = snapshotCalls ?? deltaCalls ?? [];
  const snapshot = Boolean(snapshotCalls);

  rows.forEach((row: any, position: number) => {
    const index = Number.isSafeInteger(row?.index) ? row.index : position;
    const current = calls.get(index) ?? {
      index,
      name: '',
      arguments: '',
    };
    const nextName = row?.function?.name ?? row?.name;
    const nextArguments = row?.function?.arguments ?? row?.arguments;
    calls.set(index, {
      ...current,
      ...(typeof row?.id === 'string' && row.id ? { id: row.id } : {}),
      ...(typeof row?.type === 'string' && row.type ? { type: row.type } : {}),
      name: snapshot
        ? (typeof nextName === 'string' ? nextName : current.name)
        : appendStreamFragment(current.name, nextName),
      arguments: snapshot
        ? (typeof nextArguments === 'string' ? nextArguments : current.arguments)
        : appendStreamFragment(current.arguments, nextArguments),
    });
  });

  const legacy = choice?.delta?.function_call;
  if (legacy && typeof legacy === 'object') {
    const current = calls.get(0) ?? { index: 0, name: '', arguments: '' };
    calls.set(0, {
      ...current,
      name: appendStreamFragment(current.name, legacy.name),
      arguments: appendStreamFragment(current.arguments, legacy.arguments),
    });
  }
}

function materializeStreamToolCalls(
  calls: ReadonlyMap<number, StreamToolCallAccumulator>
): Array<Record<string, any>> {
  return Array.from(calls.values())
    .sort((left, right) => left.index - right.index)
    .map((call) => ({
      id: call.id || `call_stream_${call.index}`,
      type: call.type || 'function',
      function: {
        name: call.name,
        arguments: call.arguments,
      },
    }));
}

function readToolLoopJsonPayload(payload: any): ToolLoopModelResult {
  const message = payload?.choices?.[0]?.message ?? {};
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const content = readAssistantText(payload);
  return {
    content: content === '模型返回了空内容。' && toolCalls.length ? '' : content,
    reasoningContent: readReasoningText(payload),
    usage: readTokenUsage(payload),
    toolCalls,
    raw: payload,
  };
}

async function readStreamingToolLoopCompletion(
  response: Response,
  onStreamUpdate?: (update: ChatStreamUpdate) => void
): Promise<ToolLoopModelResult> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (
    contentType.includes('application/json') ||
    !contentType.includes('text/event-stream')
  ) {
    const body = await readLimitedResponseText(response, maxJsonResponseBytes, '外部联网搜索对话');
    if (looksLikeHtmlResponse(body, contentType)) {
      throw new Error('外部联网搜索对话返回了 HTML 页面，请检查 Base URL。');
    }
    try {
      return readToolLoopJsonPayload(JSON.parse(body));
    } catch (error) {
      throw new Error(
        `外部联网搜索对话返回的 JSON 无法解析：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const state = {
    content: '',
    reasoningContent: '',
    usage: undefined as ChatTokenUsage | undefined,
    lastPayload: undefined as unknown,
    sawStreamPayload: false,
    done: false,
    toolCalls: new Map<number, StreamToolCallAccumulator>(),
  };
  const decoder = new TextDecoder();
  let buffer = '';

  const processBlock = (block: string) => {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (!data) return;
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
      throw new Error(`外部联网搜索流式请求失败：${message}`);
    }
    state.sawStreamPayload = true;
    state.lastPayload = payload;
    const contentUpdate = readStreamContentUpdate(payload);
    const reasoningDelta = readStreamReasoningDelta(payload);
    const usage = readTokenUsage(payload);
    if (contentUpdate) {
      state.content = contentUpdate.snapshot
        ? contentUpdate.text
        : state.content + contentUpdate.text;
    }
    if (typeof reasoningDelta === 'string') {
      state.reasoningContent += reasoningDelta;
    }
    if (usage) state.usage = usage;
    collectStreamToolCalls(payload, state.toolCalls);
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
  };

  const consumeText = (text: string) => {
    buffer += text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (new TextEncoder().encode(buffer).byteLength > maxStreamEventBytes) {
      throw new Error('模型流缓冲区过大或事件分隔符无效，已停止接收。');
    }
    let separatorIndex = buffer.indexOf('\n\n');
    while (separatorIndex >= 0) {
      const block = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      processBlock(block);
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
        if (done) break;
        consumeText(decoder.decode(value, { stream: true }));
      }
      if (state.done) await reader.cancel();
      consumeText(decoder.decode());
    }
    if (buffer.trim() && !state.done) processBlock(buffer);
    if (!state.sawStreamPayload) {
      throw new Error('模型没有返回有效的流式事件。');
    }
    const toolCalls = materializeStreamToolCalls(state.toolCalls);
    return {
      content: state.content || (toolCalls.length || state.reasoningContent ? '' : '模型返回了空内容。'),
      reasoningContent: state.reasoningContent || undefined,
      usage: state.usage,
      toolCalls,
      raw: state.lastPayload,
    };
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
    return parseProviderBaseUrl(provider.baseUrl).hostname.toLowerCase().replace(/\.+$/, '') === 'api.openai.com';
  } catch {
    return false;
  }
}

export function isOfficialOpenAiProvider(provider: ProviderProfile): boolean {
  return isExactOfficialOpenAiProvider(provider);
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

function applyOutputTokenLimit(
  body: Record<string, unknown>,
  provider: ProviderProfile,
  maxOutputTokens: number | undefined
): void {
  if (maxOutputTokens === undefined) {
    return;
  }
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 64 || maxOutputTokens > 131_072) {
    throw new Error('最大输出 Token 必须是 64–131072 的整数。');
  }
  if (isOpenAiBaseUrl(provider)) {
    body.max_completion_tokens = maxOutputTokens;
    return;
  }
  // Ark's ordinary ChatCompletions reference and Bailian's broadly compatible
  // model families both document max_tokens. New API/custom relays receive the
  // same best-effort OpenAI-compatible field and may choose to reject it.
  body.max_tokens = maxOutputTokens;
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
    mimeType: 'video/mp4',
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

function mergeTokenUsage(a?: ChatTokenUsage, b?: ChatTokenUsage): ChatTokenUsage | undefined {
  if (!a && !b) return undefined;
  const sum = (left?: number, right?: number) =>
    left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
  return {
    ...(sum(a?.inputTokens, b?.inputTokens) !== undefined
      ? { inputTokens: sum(a?.inputTokens, b?.inputTokens) }
      : {}),
    ...(sum(a?.outputTokens, b?.outputTokens) !== undefined
      ? { outputTokens: sum(a?.outputTokens, b?.outputTokens) }
      : {}),
    ...(sum(a?.reasoningTokens, b?.reasoningTokens) !== undefined
      ? { reasoningTokens: sum(a?.reasoningTokens, b?.reasoningTokens) }
      : {}),
    ...(sum(a?.cachedInputTokens, b?.cachedInputTokens) !== undefined
      ? { cachedInputTokens: sum(a?.cachedInputTokens, b?.cachedInputTokens) }
      : {}),
    ...(sum(a?.totalTokens, b?.totalTokens) !== undefined
      ? { totalTokens: sum(a?.totalTokens, b?.totalTokens) }
      : {}),
  };
}

async function sendExternalSearchToolChat({
  provider,
  modelId,
  requestModel,
  messages,
  reasoningEffort,
  parameterSettings,
  maxOutputTokens,
  externalSearch,
  beforeProviderRequest,
  onStreamUpdate,
  signal,
}: {
  provider: ProviderProfile;
  modelId: string;
  requestModel: ModelInfo;
  messages: ChatMessage[];
  reasoningEffort: ReasoningEffort;
  parameterSettings?: ModelParameterSettings;
  maxOutputTokens?: number;
  externalSearch: ExternalSearchSettings;
  beforeProviderRequest?: (
    context: ExternalSearchProviderRequestContext
  ) => Promise<void> | void;
  onStreamUpdate?: (update: ChatStreamUpdate) => void;
  signal?: AbortSignal;
}): Promise<ChatCompletionResult> {
  if (!provider.apiKey?.trim()) {
    throw new Error('外部联网搜索需要当前聊天服务商的 API Key（用于主模型 tool 循环）。');
  }
  if (!requestModel.capabilities.includes('tool-calling')) {
    throw new Error('外部联网搜索需要明确标记 tool-calling 能力的聊天模型。');
  }
  const service = resolveActiveExternalSearchService(externalSearch);
  if (!service) {
    throw new Error('外部联网搜索未就绪：请配置并选择 Tavily / Brave / Grok 服务及 API Key。');
  }

  const requestMessages = await materializeMessagesForRequest(messages, provider);
  const openAiMessages: Array<Record<string, unknown>> = requestMessages.map((message) =>
    toOpenAiMessage(message, provider)
  );
  const systemPrompt = getExternalSearchSystemPrompt();
  if (openAiMessages[0]?.role === 'system' && typeof openAiMessages[0].content === 'string') {
    openAiMessages[0] = {
      ...openAiMessages[0],
      content: `${openAiMessages[0].content}\n\n${systemPrompt}`,
    };
  } else {
    openAiMessages.unshift({ role: 'system', content: systemPrompt });
  }

  const baseUrl = assertBaseUrl(provider);
  const tools = [getExternalSearchToolDefinition()];
  const maxRounds = Math.max(1, Math.min(4, externalSearch.maxToolRounds || 3));
  const reasoningActivityEnabled = reasoningEffort !== 'off';

  let aggregatedUsage: ChatTokenUsage | undefined;
  const collectedSearches: ExternalSearchResult[] = [];
  let toolActivity: ToolActivityItem[] = [];
  let activityTimeline: ActivityTimelineStep[] = [];
  let lastPayload: unknown;
  let finalContent = '';
  let finalReasoning: string | undefined;
  let webSearchTriggered = false;
  let thinkingSegment = 0;
  let providerRequestCount = 0;

  const requestProviderCompletion = async (
    body: Record<string, unknown>,
    label: string,
    onPartial?: (update: ChatStreamUpdate) => void
  ): Promise<ToolLoopModelResult> => {
    const context: ExternalSearchProviderRequestContext = {
      requestNumber: providerRequestCount + 1,
      ...(signal ? { signal } : {}),
    };
    await beforeProviderRequest?.(context);
    if (signal?.aborted) {
      throw createAbortError();
    }
    providerRequestCount = context.requestNumber;
    const response = await providerFetch(
      `${baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: {
          ...authHeaders(provider),
          Accept: 'text/event-stream, application/json',
        },
        body: JSON.stringify(body),
        signal,
      },
      openAiProRequestTimeoutMs
    );
    if (!response.ok) {
      const responseBody = await readLimitedResponseText(response, maxErrorResponseBytes, label);
      throw new Error(`${label}失败：${response.status} ${compactResponseText(responseBody)}`);
    }
    return readStreamingToolLoopCompletion(response, onPartial);
  };

  const publish = (extra?: Partial<ChatStreamUpdate>) => {
    onStreamUpdate?.({
      content: finalContent,
      reasoningContent: finalReasoning,
      usage: aggregatedUsage,
      toolActivity,
      activityTimeline,
      ...extra,
    });
  };

  const noteThinking = (reasoning: string | undefined, running: boolean) => {
    const text = reasoning?.trim() ?? '';
    if (!text && !running) return;
    // Open a new thinking segment when the previous one was completed by tools.
    const openThinking = activityTimeline.find(
      (step) => step.kind === 'thinking' && step.status === 'running'
    );
    const needNewSegment = !openThinking;
    if (needNewSegment) {
      thinkingSegment += 1;
    }
    const id = openThinking?.id ?? `thinking-r${thinkingSegment}`;
    const sequence = openThinking?.sequence ?? nextTimelineSequence(activityTimeline);
    const startedAt = openThinking?.startedAt ?? Date.now();
    const finishedAt = running ? undefined : Date.now();
    activityTimeline = upsertTimelineStep(activityTimeline, {
      id,
      kind: 'thinking',
      sequence,
      status: running ? 'running' : 'completed',
      title: running ? '深度思考' : '深度思考',
      content: text || openThinking?.content || '',
      startedAt,
      ...(finishedAt !== undefined ? { finishedAt } : {}),
    });
  };

  for (let round = 0; round < maxRounds; round += 1) {
    if (signal?.aborted) {
      throw createAbortError();
    }
    finalContent = '';
    // Only show an idle thinking row when reasoning was not explicitly disabled.
    if (reasoningActivityEnabled) {
      noteThinking(undefined, true);
      publish();
    }

    const body: Record<string, unknown> = {
      model: modelId,
      messages: openAiMessages,
      tools,
      tool_choice: 'auto',
      stream: true,
      stream_options: { include_usage: true },
    };
    const normalizedEffort = normalizeReasoningEffort(provider, requestModel, reasoningEffort);
    applyModelParameterOptions(body, parameterSettings, provider, requestModel, normalizedEffort);
    applyOutputTokenLimit(body, provider, maxOutputTokens);
    applyReasoningOptions(body, provider, modelId, normalizedEffort);

    const usageBeforeRound = aggregatedUsage;
    let streamedReasoning: string | undefined;
    const result = await requestProviderCompletion(
      body,
      '外部联网搜索对话',
      (update) => {
        finalContent = update.content;
        if (update.reasoningContent !== undefined) {
          streamedReasoning = update.reasoningContent;
          if (reasoningActivityEnabled) {
            finalReasoning = update.reasoningContent;
            noteThinking(update.reasoningContent, true);
          }
        }
        publish({
          usage: mergeTokenUsage(usageBeforeRound, update.usage),
          raw: update.raw,
        });
      }
    );
    lastPayload = result.raw;
    aggregatedUsage = mergeTokenUsage(aggregatedUsage, result.usage);

    const toolCalls = result.toolCalls;
    const content = result.content;
    const reasoning = result.reasoningContent ?? streamedReasoning;
    if (content && content !== '模型返回了空内容。') {
      finalContent = content;
    }
    if (reasoningActivityEnabled && reasoning) finalReasoning = reasoning;
    // Keep thinking open if tools will follow; complete when this is the final answer.
    if (reasoningActivityEnabled) {
      noteThinking(reasoning, toolCalls.length > 0);
    }
    if (!toolCalls.length) {
      activityTimeline = completeOpenThinkingSteps(activityTimeline);
      publish({ raw: result.raw });
      break;
    }
    publish({ raw: result.raw });

    openAiMessages.push({
      role: 'assistant',
      content: content === '模型返回了空内容。' || !content ? null : content,
      tool_calls: toolCalls,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
    });

    // Thought finished for this round; tools begin next on the timeline.
    activityTimeline = completeOpenThinkingSteps(activityTimeline);
    publish();

    for (let toolIndex = 0; toolIndex < toolCalls.length; toolIndex += 1) {
      const call = toolCalls[toolIndex];
      const id = typeof call?.id === 'string' && call.id.trim() ? call.id : `call_${round}_${toolIndex}`;
      const name =
        typeof call?.function?.name === 'string'
          ? call.function.name
          : typeof call?.name === 'string'
            ? call.name
            : '';
      let args: Record<string, unknown> = {};
      try {
        const rawArgs = call?.function?.arguments ?? call?.arguments;
        if (typeof rawArgs === 'string' && rawArgs.trim()) {
          const parsed = JSON.parse(rawArgs) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>;
          }
        } else if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
          args = rawArgs as Record<string, unknown>;
        }
      } catch {
        args = {};
      }
      const startedAt = Date.now();
      const sequence = nextTimelineSequence(activityTimeline);
      const title = toolActivityTitle(name || 'tool', args);
      toolActivity = upsertToolActivity(toolActivity, {
        id,
        toolName: name || 'tool',
        title,
        arguments: args,
        status: 'running',
        summary: '正在调用工具…',
        startedAt,
        sequence,
      });
      activityTimeline = upsertTimelineStep(activityTimeline, {
        id,
        kind: 'tool',
        sequence,
        status: 'running',
        toolName: name || 'tool',
        title,
        arguments: args,
        summary: '正在调用工具…',
        startedAt,
      });
      publish();

      let toolContent: string;
      let toolStatus: ToolActivityItem['status'] = 'completed';
      let toolSummary = '';
      if (name !== EXTERNAL_SEARCH_TOOL_NAME) {
        toolContent = JSON.stringify({ error: `Unsupported tool: ${name || '(missing)'}` });
        toolStatus = 'failed';
        toolSummary = '不支持的工具';
      } else {
        try {
          const query = parseSearchWebToolArguments(call?.function?.arguments ?? call?.arguments);
          const result = reindexExternalSearchResult(
            await runExternalSearch({
              query,
              service,
              maxResults: externalSearch.maxResults,
              fetchImpl: guardedApiFetch,
              signal,
            }),
            collectedSearches.reduce((total, search) => total + search.items.length, 0)
          );
          collectedSearches.push(result);
          webSearchTriggered = true;
          toolContent = formatExternalSearchToolResult(result);
          toolSummary = `返回 ${result.items.length} 条结果`;
          args = { query };
        } catch (error) {
          toolContent = JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          });
          toolStatus = 'failed';
          toolSummary = error instanceof Error ? error.message : '搜索失败';
        }
      }
      const finishedAt = Date.now();
      toolActivity = upsertToolActivity(toolActivity, {
        id,
        toolName: name || EXTERNAL_SEARCH_TOOL_NAME,
        title: toolActivityTitle(name || EXTERNAL_SEARCH_TOOL_NAME, args),
        arguments: args,
        status: toolStatus,
        summary: toolSummary,
        content: toolContent,
        startedAt,
        finishedAt,
        sequence,
      });
      activityTimeline = upsertTimelineStep(activityTimeline, {
        id,
        kind: 'tool',
        sequence,
        status: toolStatus,
        toolName: name || EXTERNAL_SEARCH_TOOL_NAME,
        title: toolActivityTitle(name || EXTERNAL_SEARCH_TOOL_NAME, args),
        arguments: args,
        summary: toolSummary,
        content: toolContent,
        startedAt,
        finishedAt,
      });
      publish();
      openAiMessages.push({
        role: 'tool',
        tool_call_id: id,
        content: toolContent,
      });
    }

    if (round === maxRounds - 1) {
      // Force one last answer without tools when the budget is exhausted.
      finalContent = '';
      if (reasoningActivityEnabled) {
        noteThinking(undefined, true);
        publish();
      }
      const finalBody: Record<string, unknown> = {
        model: modelId,
        messages: openAiMessages,
        stream: true,
        stream_options: { include_usage: true },
      };
      applyModelParameterOptions(
        finalBody,
        parameterSettings,
        provider,
        requestModel,
        normalizeReasoningEffort(provider, requestModel, reasoningEffort)
      );
      applyOutputTokenLimit(finalBody, provider, maxOutputTokens);
      applyReasoningOptions(
        finalBody,
        provider,
        modelId,
        normalizeReasoningEffort(provider, requestModel, reasoningEffort)
      );
      const usageBeforeFinal = aggregatedUsage;
      let streamedFinalReasoning: string | undefined;
      const finalResult = await requestProviderCompletion(
        finalBody,
        '外部联网搜索收尾',
        (update) => {
          finalContent = update.content;
          if (update.reasoningContent !== undefined) {
            streamedFinalReasoning = update.reasoningContent;
            if (reasoningActivityEnabled) {
              finalReasoning = update.reasoningContent;
              noteThinking(update.reasoningContent, true);
            }
          }
          publish({
            usage: mergeTokenUsage(usageBeforeFinal, update.usage),
            raw: update.raw,
          });
        }
      );
      lastPayload = finalResult.raw;
      aggregatedUsage = mergeTokenUsage(aggregatedUsage, finalResult.usage);
      finalContent = finalResult.content;
      const finalRoundReasoning = finalResult.reasoningContent ?? streamedFinalReasoning;
      if (reasoningActivityEnabled && finalRoundReasoning) {
        finalReasoning = finalRoundReasoning;
      }
      if (reasoningActivityEnabled) {
        noteThinking(finalRoundReasoning, false);
      }
      activityTimeline = completeOpenThinkingSteps(activityTimeline);
      publish({ raw: finalResult.raw });
      break;
    }
  }

  activityTimeline = completeOpenThinkingSteps(activityTimeline);

  return {
    content: finalContent || '模型未返回文本内容。',
    ...(finalReasoning ? { reasoningContent: finalReasoning } : {}),
    ...(aggregatedUsage ? { usage: aggregatedUsage } : {}),
    citations: citationsFromExternalSearchResults(collectedSearches),
    webSearchTriggered,
    ...(toolActivity.length ? { toolActivity } : {}),
    ...(activityTimeline.length ? { activityTimeline } : {}),
    raw: lastPayload,
  };
}

export async function sendOpenAiCompatibleChat({
  provider,
  modelId,
  model,
  messages,
  reasoningEffort,
  parameterSettings,
  maxOutputTokens,
  onStreamUpdate,
  webSearch,
  externalSearch,
  beforeExternalSearchProviderRequest,
  mcp,
  signal,
}: ChatCompletionArgs): Promise<ChatCompletionResult> {
  if (!modelId) {
    throw new Error('请先选择一个模型。');
  }

  const requestModel = model ?? createModelInfoFromId(provider, modelId, 'manual');
  const task = inferModelTask(requestModel);
  const externalSearchActive = Boolean(externalSearch?.enabled);

  if ((webSearch?.enabled || externalSearchActive) && task !== 'chat') {
    throw new Error('联网搜索只适用于聊天模型，已拒绝发起请求。');
  }
  if (webSearch?.enabled && externalSearchActive) {
    throw new Error('服务商联网搜索与外部搜索不能同时启用。');
  }

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
  if (task === 'audio-transcription' || task === 'speech-generation') {
    throw new Error('当前是语音专用模型，请使用语音输入或朗读入口。');
  }

  const chatAttachments = messages.flatMap((message) => message.attachments ?? []);
  assertChatAttachmentsSupported(chatAttachments, requestModel, provider);

  if (mcp) {
    if (webSearch?.enabled || externalSearchActive) {
      throw new Error('MCP 与联网搜索不能在同一轮启用，已拒绝发起请求。');
    }
    if (!provider.apiKey?.trim()) {
      throw new Error('MCP 必须使用你在 OpenAI 官方服务商中配置的 API Key。');
    }
    if (!isOfficialOpenAiProvider(provider)) {
      throw new Error('MCP 执行仅允许精确的 OpenAI 官方 api.openai.com Responses 路由。');
    }
    if (!requestModel.capabilities.includes('mcp')) {
      throw new Error('当前模型未明确标记 MCP 能力，已拒绝发起工具请求。');
    }
    const readiness = getRemoteMcpExecutableReadiness(
      mcp.plugin,
      new Set([provider.id])
    );
    if (!readiness.executable || readiness.providerId !== provider.id) {
      throw new Error('MCP 配置未通过端点、服务商绑定、白名单与逐次审批安全检查。');
    }
    const requestMessages = await materializeMessagesForRequest(messages, provider);
    const input = toOpenAiResponsesInput(requestMessages);
    const endpoint = getOpenAiResponsesEndpoint(provider);
    const normalizedEffort = normalizeReasoningEffort(
      provider,
      requestModel,
      reasoningEffort
    );
    const wireReasoningEffort = normalizedEffort === 'default' || normalizedEffort === 'off'
      ? undefined
      : normalizedEffort;
    const run = await runOpenAiProviderMcp({
      modelId,
      input,
      server: {
        serverLabel: readiness.serverLabel,
        serverUrl: readiness.endpoint,
        allowedTools: readiness.allowedTools,
        ...(readiness.authorization ? { authorization: readiness.authorization } : {}),
      },
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      requestApproval: mcp.requestApproval,
      beforeContinuation: mcp.beforeContinuation,
      signal,
      sendRequest: async (body, context) => {
        await mcp.beforeProviderRequest?.(context);
        if (context.signal?.aborted || signal?.aborted) {
          throw createAbortError('MCP 请求已取消；不会向服务商发送请求。');
        }
        const responsePromise = providerFetch(
          endpoint,
          {
            method: 'POST',
            headers: authHeaders(provider),
            body: JSON.stringify({
              ...body,
              ...(wireReasoningEffort
                ? { reasoning: { effort: wireReasoningEffort } }
                : {}),
            }),
            signal,
            redirect: 'error',
          },
          openAiProRequestTimeoutMs
        );
        mcp.onProviderRequestStarted?.(context);
        const response = await responsePromise;
        const responseBody = await readLimitedResponseText(
          response,
          response.ok ? providerMcpLimits.maxResponseJsonBytes : maxErrorResponseBytes,
          'OpenAI MCP'
        );
        if (!response.ok) {
          // A provider error page may reflect request fields. Do not include it
          // in UI errors because the MCP authorization is part of the JSON body.
          throw new Error(`OpenAI MCP 请求失败：HTTP ${response.status}。`);
        }
        return responseBody;
      },
    });
    return {
      ...run.result,
      mcpActivity: {
        serverLabel: run.receipt.serverLabel,
        providerRequestCount: run.providerRequestCount,
        approvals: run.receipt.approvals.map((approval) => ({
          toolName: approval.toolName,
          decision: approval.decision,
        })),
        calls: run.receipt.calls.map((call) => ({
          toolName: call.toolName,
          outcome: call.outcome,
        })),
      },
    };
  }

  if (webSearch?.enabled) {
    if (!provider.apiKey?.trim()) {
      throw new Error('联网搜索必须使用你在当前服务商中配置的 API Key。');
    }
    if (!requestModel.capabilities.includes('web-search')) {
      throw new Error('当前模型未明确标记为支持联网搜索，已拒绝发起可能计费的搜索请求。');
    }
    assertProviderWebSearchMessagesSupported(provider, messages);
    const requestMessages = await materializeMessagesForRequest(messages, provider);
    const searchProtocol = resolveProviderWebSearchProtocol(provider);
    const request = buildProviderWebSearchRequest({
      provider,
      modelId,
      messages: requestMessages,
      ...(searchProtocol === 'openai-official'
        ? { searchContextSize: webSearch.searchContextSize }
        : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
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
      '联网搜索'
    );
    if (!response.ok) {
      throw new Error(`联网搜索请求失败：${response.status} ${compactResponseText(responseBody)}`);
    }
    const result = parseProviderWebSearchResponse({ provider, payload: responseBody });
    return {
      content: result.content,
      reasoningContent: result.reasoningContent,
      usage: result.usage,
      citations: result.citations,
      webSearchTriggered: result.webSearchTriggered,
      raw: result,
    };
  }

  if (externalSearchActive && externalSearch) {
    if (isOpenAiResponsesOnlyModel(provider, modelId)) {
      throw new Error('当前 Responses-only 模型暂不支持外部 search_web 工具循环，请切换其他聊天模型。');
    }
    return sendExternalSearchToolChat({
      provider,
      modelId,
      requestModel,
      messages,
      reasoningEffort,
      parameterSettings,
      maxOutputTokens,
      externalSearch,
      beforeProviderRequest: beforeExternalSearchProviderRequest,
      onStreamUpdate,
      signal,
    });
  }

  if (isOpenAiResponsesOnlyModel(provider, modelId)) {
    const requestMessages = await materializeMessagesForRequest(messages, provider);
    const request = buildOpenAiResponsesRequest({
      provider,
      modelId,
      messages: requestMessages,
      reasoningEffort: normalizeReasoningEffort(provider, requestModel, reasoningEffort),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
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
  applyOutputTokenLimit(body, provider, maxOutputTokens);
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
