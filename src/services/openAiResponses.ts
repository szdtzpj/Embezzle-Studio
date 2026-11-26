import type {
  ActivityTimelineStep,
  ChatCompletionResult,
  ChatMessage,
  ChatTokenUsage,
  MediaAttachment,
  ProviderContinuationBlock,
  ProviderProfile,
  ReasoningEffort,
  StreamChatCallbacks,
  ToolActivityItem,
  WebCitation,
} from '../domain/types';
import {
  completeOpenThinkingSteps,
  nextTimelineSequence,
  upsertTimelineStep,
  upsertToolActivity,
} from './messageActivity';
import { resolveProviderAuthHeaders } from './providerSetup';
import { isBlockedPublicHost } from './ssrfGuard';

export type OpenAiResponsesWireEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type OpenAiResponsesModernEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type OpenAiResponsesReasoningSummaryMode = 'auto' | 'concise' | 'detailed';

export interface OpenAiResponsesReasoningOptions {
  effort?: OpenAiResponsesModernEffort;
  summary?: OpenAiResponsesReasoningSummaryMode;
}

export type OpenAiResponsesInputContent =
  | {
      type: 'input_text';
      text: string;
    }
  | {
      type: 'input_image';
      image_url: string;
    }
  | {
      type: 'input_file';
      filename: string;
      file_data: string;
    };

export interface OpenAiResponsesInputMessage {
  role: ChatMessage['role'];
  content: OpenAiResponsesInputContent[];
}

/**
 * Responses API 多轮无状态对话（store: false）下回传的加密推理输入项。
 */
export interface OpenAiResponsesReasoningInputItem {
  type: 'reasoning';
  id?: string;
  encrypted_content: string;
  summary?: Array<{
    type: 'summary_text';
    text: string;
  }>;
}

export type OpenAiResponsesInputItem =
  | OpenAiResponsesInputMessage
  | OpenAiResponsesReasoningInputItem;

export interface OpenAiResponsesWebSearchTool {
  type: 'web_search';
  search_context_size?: 'low' | 'medium' | 'high';
  search_content_types?: Array<'text' | 'image'>;
  image_settings?: {
    max_results?: number;
  };
}

export interface OpenAiResponsesRequestBody {
  model: string;
  input: OpenAiResponsesInputMessage[];
  store: false;
  max_output_tokens?: number;
  reasoning?: {
    effort: OpenAiResponsesWireEffort;
  };
}

export interface OpenAiResponsesStreamRequestBody {
  model: string;
  input: OpenAiResponsesInputItem[];
  store: false;
  stream?: boolean;
  max_output_tokens?: number;
  reasoning?: OpenAiResponsesReasoningOptions;
  tools?: Array<OpenAiResponsesWebSearchTool | Record<string, unknown>>;
  include?: string[];
  temperature?: number;
  top_p?: number;
  prompt_cache_key?: string;
}

export interface OpenAiResponsesRequest {
  url: string;
  body: OpenAiResponsesRequestBody;
}

export interface OpenAiResponsesStreamRequest {
  url: string;
  body: OpenAiResponsesStreamRequestBody;
}

export interface BuildOpenAiResponsesRequestArgs {
  provider: Pick<ProviderProfile, 'baseUrl'>;
  modelId: string;
  messages: ChatMessage[];
  reasoningEffort?: ReasoningEffort;
  maxOutputTokens?: number;
}

export interface BuildOpenAiResponsesStreamRequestArgs {
  provider: Pick<ProviderProfile, 'kind' | 'baseUrl'>;
  modelId: string;
  messages: ChatMessage[];
  reasoningEffort?: ReasoningEffort;
  reasoningSummary?: OpenAiResponsesReasoningSummaryMode;
  maxOutputTokens?: number;
  stream?: boolean;
  webSearch?: {
    enabled: boolean;
    searchContextSize?: 'low' | 'medium' | 'high';
    searchContentTypes?: Array<'text' | 'image'>;
    imageMaxResults?: number;
  };
  include?: string[];
  tools?: Array<OpenAiResponsesWebSearchTool | Record<string, unknown>>;
  continuationProvider?: 'openai' | 'xai';
  promptCacheKey?: string;
  temperature?: number;
  topP?: number;
  allowCustomEndpoint?: boolean;
}

export interface SendOpenAiResponsesChatArgs extends BuildOpenAiResponsesStreamRequestArgs {
  provider: ProviderProfile;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface SseEventFrame {
  event?: string;
  data: string;
}

export interface ParsedOpenAiResponsesSseChunk {
  kind: 'comment' | 'done' | 'event';
  event?: string;
  payload?: Record<string, unknown>;
}

export const openAiResponsesLimits = Object.freeze({
  maxMessages: 1_000,
  maxInputTextCharacters: 2_000_000,
  maxInlineImageBytes: 20 * 1024 * 1024,
  maxInlineFileBytes: 20 * 1024 * 1024,
  maxResponseJsonBytes: 16 * 1024 * 1024,
  maxStreamEventBytes: 1024 * 1024,
  maxOutputCharacters: 2_000_000,
});

type ResponsesOnlyModelFamily = 'gpt-5-pro' | 'gpt-5-versioned-pro' | 'o-pro';

const snapshotSuffix = /-\d{4}-\d{2}-\d{2}$/;
const responsesOnlyVersionedProModels = new Set(['gpt-5.2-pro', 'gpt-5.4-pro', 'gpt-5.5-pro']);
const supportedImageMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export class OpenAiResponsesProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenAiResponsesProtocolError';
  }
}

function protocolError(message: string): never {
  throw new OpenAiResponsesProtocolError(message);
}

function parseUrl(value: string, label: string): URL {
  try {
    return new URL(value);
  } catch {
    return protocolError(`${label}不是有效网址。`);
  }
}

function officialOpenAiUrl(baseUrl: string): URL | undefined {
  try {
    const url = new URL(baseUrl.trim());
    if (
      url.protocol !== 'https:' ||
      url.hostname.toLowerCase().replace(/\.+$/, '') !== 'api.openai.com' ||
      url.username ||
      url.password
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function canonicalModelId(modelId: string): string {
  return modelId.trim().toLowerCase().replace(snapshotSuffix, '');
}

function responsesOnlyModelFamily(modelId: string): ResponsesOnlyModelFamily | undefined {
  const canonical = canonicalModelId(modelId);
  if (canonical === 'gpt-5-pro') {
    return 'gpt-5-pro';
  }
  if (responsesOnlyVersionedProModels.has(canonical)) {
    return 'gpt-5-versioned-pro';
  }
  if (/^o(?:1|3)-pro$/.test(canonical)) {
    return 'o-pro';
  }
  return undefined;
}

/**
 * 识别 OpenAI 生图专用模型（`gpt-image-2.5`、`gpt-image-2.6`、`gpt-image-1.5`、`gpt-image-1`、`dall-e-*`）。
 */
export function isOpenAiImageGenerationModel(modelId: string): boolean {
  const canonical = canonicalModelId(modelId);
  if (!canonical) return false;
  return /^(?:gpt-image-(?:1(?:\.5)?|2(?:\.\d+)?)|dall-e-[23])(?:$|-)/.test(canonical);
}

/**
 * 识别支持 OpenAI Responses API 现代特性的对话模型（`gpt-6.x`、`gpt-5.x`、`gpt-4.1`、`o1`/`o3`/`o4`）。
 */
export function isOpenAiModernChatModel(modelId: string): boolean {
  const canonical = canonicalModelId(modelId);
  if (!canonical) return false;
  if (isOpenAiImageGenerationModel(canonical)) return false;
  if (/(?:embedding|tts|whisper|transcribe|rerank|realtime|audio)/.test(canonical)) {
    return false;
  }
  return (
    /^gpt-6(?:$|[.-])/.test(canonical) ||
    /^gpt-5(?:$|[.-])/.test(canonical) ||
    /^gpt-4\.1(?:$|-)/.test(canonical) ||
    /^o[134](?:$|-)/.test(canonical)
  );
}

/**
 * 识别具备原生推理能力的 OpenAI 模型（排除 `gpt-4.1`、生图及音频模型）。
 */
export function isOpenAiReasoningCapableModel(modelId: string): boolean {
  const canonical = canonicalModelId(modelId);
  if (!canonical || isOpenAiImageGenerationModel(canonical)) return false;
  if (/(?:embedding|tts|whisper|transcribe|rerank|non-reasoning)/.test(canonical)) {
    return false;
  }
  return (
    /^gpt-6(?:$|[.-])/.test(canonical) ||
    /^gpt-5(?:$|[.-])/.test(canonical) ||
    /^o[134](?:$|-)/.test(canonical)
  );
}

/**
 * 判断服务商与模型是否支持使用 OpenAI Responses 流式协议。
 */
export function supportsOpenAiResponsesStream(
  provider: Pick<ProviderProfile, 'kind' | 'baseUrl'>,
  modelId: string
): boolean {
  if (provider.kind === 'new-api-relay') {
    return false;
  }
  return Boolean(officialOpenAiUrl(provider.baseUrl) && isOpenAiModernChatModel(modelId));
}

export function isOpenAiResponsesOnlyModel(
  provider: Pick<ProviderProfile, 'baseUrl'>,
  modelId: string
): boolean {
  return Boolean(officialOpenAiUrl(provider.baseUrl) && responsesOnlyModelFamily(modelId));
}

export function getOpenAiResponsesEndpoint(provider: Pick<ProviderProfile, 'baseUrl'>): string {
  const url = officialOpenAiUrl(provider.baseUrl);
  if (!url) {
    return protocolError('Responses API 仅允许使用 HTTPS api.openai.com。');
  }
  if (url.search || url.hash) {
    return protocolError('OpenAI Base URL 不能包含查询参数或片段。');
  }

  const path = url.pathname.replace(/\/+$/, '').toLowerCase();
  const supportedPaths = new Set([
    '',
    '/v1',
    '/v1/responses',
    '/v1/chat/completions',
    '/v1/models',
  ]);
  if (!supportedPaths.has(path)) {
    return protocolError('OpenAI Base URL 路径必须是 /v1 或受支持的 OpenAI 端点。');
  }

  return `${url.origin}/v1/responses`;
}

function getFlexibleResponsesEndpoint(
  provider: Pick<ProviderProfile, 'baseUrl'>,
  allowCustomEndpoint = false
): string {
  if (!allowCustomEndpoint) {
    return getOpenAiResponsesEndpoint(provider);
  }
  const url = parseUrl(provider.baseUrl.trim(), 'Base URL');
  const isLoopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(
    url.hostname.toLowerCase()
  );
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    return protocolError('Responses API 必须使用 HTTPS 地址。');
  }
  if (url.username || url.password || url.search || url.hash) {
    return protocolError('Responses Base URL 不能包含凭据、查询参数或片段。');
  }
  const cleanPath = url.pathname
    .replace(/\/+$/, '')
    .replace(/\/(?:chat\/completions|responses|models)$/i, '');
  const versionedPath = cleanPath ? cleanPath : '/v1';
  return `${url.origin}${versionedPath}/responses`;
}

function normalizeImageMimeType(value: string | undefined, attachmentName: string): string {
  const normalized = (value || 'image/jpeg').split(';', 1)[0].trim().toLowerCase();
  const canonical = normalized === 'image/jpg' ? 'image/jpeg' : normalized;
  if (!supportedImageMimeTypes.has(canonical)) {
    return protocolError(`图片“${attachmentName}”的格式 ${canonical || '未知'} 不受支持。`);
  }
  return canonical;
}

function validateBase64(payload: string, attachmentName: string): string {
  if (!payload || /\s/.test(payload)) {
    return protocolError(`图片“${attachmentName}”的 Base64 数据为空或包含非法空白。`);
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || payload.length % 4 === 1) {
    return protocolError(`图片“${attachmentName}”的 Base64 数据无效。`);
  }

  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  const estimatedBytes = Math.floor((payload.length * 3) / 4) - padding;
  if (estimatedBytes > openAiResponsesLimits.maxInlineImageBytes) {
    return protocolError(
      `图片“${attachmentName}”超过内联图片上限 ${Math.round(openAiResponsesLimits.maxInlineImageBytes / 1024 / 1024)} MB。`
    );
  }
  return payload;
}

function validatedDataImageUrl(value: string, attachmentName: string): string {
  const match = value.match(/^data:([^;,]+);base64,([\s\S]*)$/i);
  if (!match) {
    return protocolError(`图片“${attachmentName}”不是有效的 Base64 data URL。`);
  }
  const mimeType = normalizeImageMimeType(match[1], attachmentName);
  const payload = validateBase64(match[2], attachmentName);
  return `data:${mimeType};base64,${payload}`;
}

function unsafePublicHostname(hostname: string): boolean {
  return isBlockedPublicHost(hostname);
}

/**
 * 校验并规范化公网 HTTPS URL（过滤非 HTTPS、含凭据、内网/私网/保留地址），用于引用链接安全防护。
 */
export function validatedPublicHttpsUrl(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 8192 ||
    /[\u0000-\u0020\u007f]/.test(value)
  ) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !url.hostname ||
    unsafePublicHostname(url.hostname)
  ) {
    return undefined;
  }
  return url.href;
}

function localHostname(hostname: string): boolean {
  return isBlockedPublicHost(hostname);
}

function validatedRemoteImageUrl(value: string, attachmentName: string): string {
  const url = parseUrl(value, `图片“${attachmentName}”的 URL `);
  if (url.protocol !== 'https:') {
    return protocolError(`图片“${attachmentName}”必须使用 HTTPS 或 Base64 data URL。`);
  }
  if (url.username || url.password || url.hash) {
    return protocolError(`图片“${attachmentName}”的 URL 不能包含凭据或片段。`);
  }
  if (localHostname(url.hostname)) {
    return protocolError(`图片“${attachmentName}”使用了远程 OpenAI 无法访问的本地地址。`);
  }
  return url.toString();
}

function imageUrl(attachment: MediaAttachment): string {
  const attachmentName = attachment.name || '未命名图片';
  const inline = attachment.base64?.trim();
  if (inline) {
    if (inline.toLowerCase().startsWith('data:')) {
      return validatedDataImageUrl(inline, attachmentName);
    }
    const mimeType = normalizeImageMimeType(attachment.mimeType, attachmentName);
    return `data:${mimeType};base64,${validateBase64(inline, attachmentName)}`;
  }

  const uri = attachment.uri?.trim();
  if (!uri) {
    return protocolError(`图片“${attachmentName}”缺少可发送的 URL 或 Base64 数据。`);
  }
  return uri.toLowerCase().startsWith('data:')
    ? validatedDataImageUrl(uri, attachmentName)
    : validatedRemoteImageUrl(uri, attachmentName);
}

function fileData(attachment: MediaAttachment): string {
  const attachmentName = attachment.name || '未命名文件';
  const inline = attachment.base64?.trim();
  if (!inline) {
    return protocolError(`文件“${attachmentName}”缺少可发送的 Base64 数据。`);
  }
  const match = inline.match(/^data:([^;,]+);base64,([\s\S]*)$/i);
  const mimeType = (match?.[1] || attachment.mimeType || 'application/octet-stream').trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mimeType)) {
    return protocolError(`文件“${attachmentName}”的 MIME 类型无效。`);
  }
  const payload = (match?.[2] ?? inline).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || payload.length % 4 === 1) {
    return protocolError(`文件“${attachmentName}”的 Base64 数据无效。`);
  }
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  const estimatedBytes = Math.floor((payload.length * 3) / 4) - padding;
  if (estimatedBytes > openAiResponsesLimits.maxInlineFileBytes) {
    return protocolError(
      `文件“${attachmentName}”超过内联文件上限 ${Math.round(openAiResponsesLimits.maxInlineFileBytes / 1024 / 1024)} MB。`
    );
  }
  return `data:${mimeType};base64,${payload}`;
}

function serializeSingleInputMessage(
  message: ChatMessage,
  messageIndex: number,
  totalTextCharacters: { value: number }
): OpenAiResponsesInputMessage {
  if (!message || typeof message.content !== 'string') {
    return protocolError(`第 ${messageIndex + 1} 条消息的文本无效。`);
  }
  if (!['system', 'user', 'assistant'].includes(message.role)) {
    return protocolError(`第 ${messageIndex + 1} 条消息的角色无效。`);
  }
  if (message.status !== 'ready') {
    return protocolError(`第 ${messageIndex + 1} 条消息尚未完成，不能发送给 Responses API。`);
  }

  totalTextCharacters.value += message.content.length;
  if (totalTextCharacters.value > openAiResponsesLimits.maxInputTextCharacters) {
    return protocolError(
      `输入文本过长，上限为 ${openAiResponsesLimits.maxInputTextCharacters.toLocaleString()} 个字符。`
    );
  }

  const content: OpenAiResponsesInputContent[] = [];
  if (message.content.length > 0) {
    content.push({ type: 'input_text', text: message.content });
  }

  for (const attachment of message.attachments ?? []) {
    if (message.role !== 'user') {
      return protocolError(`附件“${attachment.name}”只能附加到用户消息。`);
    }
    if (attachment.kind === 'image') {
      content.push({ type: 'input_image', image_url: imageUrl(attachment) });
      continue;
    }
    if (attachment.kind === 'file') {
      content.push({
        type: 'input_file',
        filename: attachment.name || 'attachment',
        file_data: fileData(attachment),
      });
      continue;
    }
    return protocolError(`附件“${attachment.name}”的类型不受 Responses API 支持。`);
  }

  if (content.length === 0) {
    return protocolError(`第 ${messageIndex + 1} 条消息没有可发送的文本或附件。`);
  }
  return { role: message.role, content };
}

export function toOpenAiResponsesInput(messages: ChatMessage[]): OpenAiResponsesInputMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    return protocolError('Responses API 至少需要一条输入消息。');
  }
  if (messages.length > openAiResponsesLimits.maxMessages) {
    return protocolError(`输入消息过多，上限为 ${openAiResponsesLimits.maxMessages} 条。`);
  }

  const totalTextCharacters = { value: 0 };
  return messages.map((message, messageIndex) =>
    serializeSingleInputMessage(message, messageIndex, totalTextCharacters)
  );
}

function extractMessageReasoningContinuations(
  message: ChatMessage,
  continuationProvider: 'openai' | 'xai'
): OpenAiResponsesReasoningInputItem[] {
  if (message.role !== 'assistant' || !Array.isArray(message.providerContinuations)) {
    return [];
  }
  const items: OpenAiResponsesReasoningInputItem[] = [];
  for (const block of message.providerContinuations) {
    if (
      block &&
      block.provider === continuationProvider &&
      block.type === 'reasoning_encrypted' &&
      typeof block.encryptedContent === 'string' &&
      block.encryptedContent.trim()
    ) {
      items.push({
        type: 'reasoning',
        ...(typeof block.id === 'string' && block.id.trim() ? { id: block.id.trim() } : {}),
        encrypted_content: block.encryptedContent,
        ...(Array.isArray(block.summary) && block.summary.length
          ? {
              summary: block.summary
                .filter((line) => typeof line === 'string' && line.trim())
                .map((text) => ({ type: 'summary_text' as const, text })),
            }
          : {}),
      });
    }
  }
  return items;
}

/**
 * 将本地消息列表转换为支持多轮加密推理回传（`reasoning_encrypted`）的 Responses API 输入项数组。
 * 在 `store: false` 无状态模式下，会将历史 `assistant` 消息关联的 `reasoning_encrypted` 块原样插入该消息之前；
 * 若历史 `assistant` 消息仅含加密推理续接块而正文与附件为空，则仅透传推理续接项而不报错。
 */
export function toOpenAiResponsesInputItems(
  messages: ChatMessage[],
  options: { continuationProvider?: 'openai' | 'xai' } = {}
): OpenAiResponsesInputItem[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    return protocolError('Responses API 至少需要一条输入消息。');
  }
  if (messages.length > openAiResponsesLimits.maxMessages) {
    return protocolError(`输入消息过多，上限为 ${openAiResponsesLimits.maxMessages} 条。`);
  }

  const continuationProvider = options.continuationProvider ?? 'openai';
  const totalTextCharacters = { value: 0 };
  const items: OpenAiResponsesInputItem[] = [];

  messages.forEach((message, messageIndex) => {
    const continuationItems = extractMessageReasoningContinuations(message, continuationProvider);
    const hasEmptyBody =
      message &&
      typeof message.content === 'string' &&
      message.content.length === 0 &&
      !(message.attachments?.length);

    // 仅含 reasoning_encrypted 续接块但正文与附件均为空的历史 assistant 消息：保留续接项并跳过空消息项
    if (message?.role === 'assistant' && hasEmptyBody && continuationItems.length > 0) {
      if (message.status !== 'ready') {
        protocolError(`第 ${messageIndex + 1} 条消息尚未完成，不能发送给 Responses API。`);
      }
      items.push(...continuationItems);
      return;
    }

    const serialized = serializeSingleInputMessage(message, messageIndex, totalTextCharacters);
    items.push(...continuationItems, serialized);
  });

  return items;
}

function wireReasoningEffort(modelId: string, effort: ReasoningEffort): OpenAiResponsesWireEffort | undefined {
  if (effort === 'default') {
    return undefined;
  }
  const family = responsesOnlyModelFamily(modelId);
  if (!family) {
    return protocolError(`模型“${modelId}”不是受支持的 Responses-only Pro 模型。`);
  }
  if (effort === 'off' || effort === 'none' || effort === 'minimal') {
    return protocolError(`模型“${modelId}”不支持关闭推理。`);
  }

  if (family === 'gpt-5-pro') {
    return effort === 'high'
      ? 'high'
      : protocolError('GPT-5 Pro 仅支持 high 推理强度。');
  }
  if (family === 'gpt-5-versioned-pro') {
    if (effort === 'medium' || effort === 'high') {
      return effort;
    }
    return effort === 'xhigh' || effort === 'max'
      ? 'xhigh'
      : protocolError(`模型“${modelId}”仅支持 medium、high 和 xhigh。`);
  }

  if (effort === 'low' || effort === 'medium' || effort === 'high') {
    return effort;
  }
  return protocolError(`模型“${modelId}”不支持 xhigh 推理强度。`);
}

/**
 * 为现代 OpenAI Responses 模型解析 `reasoning` 请求配置（包含 `effort` 与 `summary`）。
 * 非推理模型（如 `gpt-4.1`）返回 `undefined`。
 */
export function resolveOpenAiResponsesReasoningOptions(
  modelId: string,
  effort: ReasoningEffort = 'default',
  summary?: OpenAiResponsesReasoningSummaryMode
): OpenAiResponsesReasoningOptions | undefined {
  if (!isOpenAiReasoningCapableModel(modelId)) {
    return undefined;
  }

  const proFamily = responsesOnlyModelFamily(modelId);
  if (proFamily) {
    const proEffort = wireReasoningEffort(modelId, effort);
    if (!proEffort && !summary) {
      return undefined;
    }
    return {
      ...(proEffort ? { effort: proEffort } : {}),
      ...(summary ? { summary } : {}),
    };
  }

  const canonical = canonicalModelId(modelId);
  let resolvedEffort: OpenAiResponsesModernEffort | undefined;

  if (effort !== 'default') {
    if (/^gpt-6(?:$|[.-])/.test(canonical) || /^gpt-5\.[2-9]/.test(canonical)) {
      if (effort === 'off' || effort === 'none') resolvedEffort = 'none';
      else if (effort === 'minimal') resolvedEffort = 'minimal';
      else if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh') {
        resolvedEffort = effort;
      } else if (effort === 'max') resolvedEffort = 'xhigh';
    } else if (/^gpt-5\.1(?:$|-)/.test(canonical)) {
      if (effort === 'off' || effort === 'none') resolvedEffort = 'none';
      else if (effort === 'minimal' || effort === 'low') resolvedEffort = 'low';
      else if (effort === 'medium' || effort === 'high') resolvedEffort = effort;
      else if (effort === 'xhigh' || effort === 'max') resolvedEffort = 'high';
    } else if (/^gpt-5(?:$|-)/.test(canonical)) {
      if (effort === 'off' || effort === 'none' || effort === 'minimal') resolvedEffort = 'minimal';
      else if (effort === 'low' || effort === 'medium' || effort === 'high') resolvedEffort = effort;
      else if (effort === 'xhigh' || effort === 'max') resolvedEffort = 'high';
    } else {
      // o1 / o3 / o4 系列
      if (effort === 'off' || effort === 'none' || effort === 'minimal' || effort === 'low') {
        resolvedEffort = 'low';
      } else if (effort === 'medium' || effort === 'high') {
        resolvedEffort = effort;
      } else if (effort === 'xhigh' || effort === 'max') {
        resolvedEffort = 'high';
      }
    }
  }

  if (!resolvedEffort && !summary) {
    return undefined;
  }
  return {
    ...(resolvedEffort ? { effort: resolvedEffort } : {}),
    ...(summary ? { summary } : {}),
  };
}

export function buildOpenAiResponsesRequest({
  provider,
  modelId,
  messages,
  reasoningEffort = 'default',
  maxOutputTokens,
}: BuildOpenAiResponsesRequestArgs): OpenAiResponsesRequest {
  if (!isOpenAiResponsesOnlyModel(provider, modelId)) {
    return protocolError(`模型“${modelId}”不是 api.openai.com 上的 Responses-only Pro 模型。`);
  }

  const effort = wireReasoningEffort(modelId, reasoningEffort);
  const body: OpenAiResponsesRequestBody = {
    model: modelId.trim(),
    input: toOpenAiResponsesInput(messages),
    // Responses application state is retained by default. This client sends
    // the full local transcript on every request, so server-side persistence
    // is neither required nor desirable.
    store: false,
  };
  if (effort) {
    body.reasoning = { effort };
  }
  if (maxOutputTokens !== undefined) {
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 64 || maxOutputTokens > 131_072) {
      return protocolError('Responses 最大输出 Token 必须是 64–131072 的整数。');
    }
    body.max_output_tokens = maxOutputTokens;
  }

  return {
    url: getOpenAiResponsesEndpoint(provider),
    body,
  };
}

/**
 * 构造支持 SSE 流式、内置 `web_search`（含 `search_content_types`）、`reasoning.summary` 与 `reasoning.encrypted_content` 续接的 Responses 请求。
 */
export function buildOpenAiResponsesStreamRequest({
  provider,
  modelId,
  messages,
  reasoningEffort = 'default',
  reasoningSummary,
  maxOutputTokens,
  stream = true,
  webSearch,
  include,
  tools,
  continuationProvider = 'openai',
  promptCacheKey,
  temperature,
  topP,
  allowCustomEndpoint = false,
}: BuildOpenAiResponsesStreamRequestArgs): OpenAiResponsesStreamRequest {
  const normalizedModel = modelId.trim();
  if (!normalizedModel) {
    return protocolError('Responses 请求必须指定模型 ID。');
  }
  if (isOpenAiImageGenerationModel(normalizedModel)) {
    return protocolError(`模型“${normalizedModel}”是生图模型，请使用生图服务通道。`);
  }

  const url = getFlexibleResponsesEndpoint(provider, allowCustomEndpoint);
  const input = toOpenAiResponsesInputItems(messages, { continuationProvider });

  const body: OpenAiResponsesStreamRequestBody = {
    model: normalizedModel,
    input,
    store: false,
    stream,
  };

  const reasoning = resolveOpenAiResponsesReasoningOptions(
    normalizedModel,
    reasoningEffort,
    reasoningSummary
  );
  if (reasoning) {
    body.reasoning = reasoning;
  }

  if (maxOutputTokens !== undefined) {
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 64 || maxOutputTokens > 131_072) {
      return protocolError('Responses 最大输出 Token 必须是 64–131072 的整数。');
    }
    body.max_output_tokens = maxOutputTokens;
  }

  const resolvedTools: Array<OpenAiResponsesWebSearchTool | Record<string, unknown>> = [
    ...(tools ?? []),
  ];
  if (webSearch?.enabled) {
    const wsTool: OpenAiResponsesWebSearchTool = {
      type: 'web_search',
      ...(webSearch.searchContextSize ? { search_context_size: webSearch.searchContextSize } : {}),
      ...(webSearch.searchContentTypes?.length
        ? { search_content_types: [...webSearch.searchContentTypes] }
        : {}),
      ...(webSearch.imageMaxResults !== undefined
        ? { image_settings: { max_results: webSearch.imageMaxResults } }
        : {}),
    };
    resolvedTools.push(wsTool);
  }
  if (resolvedTools.length) {
    body.tools = resolvedTools;
  }

  const includeSet = new Set<string>(include ?? []);
  if (webSearch?.enabled) {
    includeSet.add('web_search_call.results');
  }
  if (reasoning && !include?.length) {
    includeSet.add('reasoning.encrypted_content');
  }
  if (includeSet.size > 0) {
    body.include = Array.from(includeSet);
  }

  if (typeof temperature === 'number' && Number.isFinite(temperature) && !reasoning?.effort) {
    body.temperature = temperature;
  }
  if (typeof topP === 'number' && Number.isFinite(topP) && !reasoning?.effort) {
    body.top_p = topP;
  }
  if (promptCacheKey?.trim()) {
    body.prompt_cache_key = promptCacheKey.trim();
  }

  return { url, body };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function parsedResponsePayload(value: unknown): Record<string, unknown> {
  let payload = value;
  if (typeof value === 'string') {
    if (utf8Bytes(value) > openAiResponsesLimits.maxResponseJsonBytes) {
      return protocolError(
        `Responses JSON 超过 ${Math.round(openAiResponsesLimits.maxResponseJsonBytes / 1024 / 1024)} MB 上限。`
      );
    }
    try {
      payload = JSON.parse(value);
    } catch (error) {
      return protocolError(
        `Responses JSON 无法解析：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (!isRecord(payload)) {
    return protocolError('Responses 返回值必须是 JSON 对象。');
  }
  return payload;
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const message = value.message;
  if (typeof message === 'string' && message.trim()) {
    return message.trim();
  }
  const code = value.code;
  return typeof code === 'string' && code.trim() ? code.trim() : undefined;
}

function boundedOutput(text: string, label: string): string {
  if (text.length > openAiResponsesLimits.maxOutputCharacters) {
    return protocolError(
      `${label}过长，上限为 ${openAiResponsesLimits.maxOutputCharacters.toLocaleString()} 个字符。`
    );
  }
  return text;
}

function outputText(payload: Record<string, unknown>): string {
  const messages: string[] = [];
  if (Array.isArray(payload.output)) {
    for (const item of payload.output) {
      if (!isRecord(item) || item.type !== 'message' || !Array.isArray(item.content)) {
        continue;
      }
      const parts: string[] = [];
      for (const part of item.content) {
        if (!isRecord(part)) {
          continue;
        }
        if (part.type === 'output_text' && typeof part.text === 'string') {
          parts.push(part.text);
        } else if (part.type === 'refusal' && typeof part.refusal === 'string') {
          parts.push(part.refusal);
        }
      }
      if (parts.length) {
        messages.push(parts.join(''));
      }
    }
  }

  const text = messages.length
    ? messages.join('\n\n')
    : typeof payload.output_text === 'string'
      ? payload.output_text
      : '';
  return boundedOutput(text, 'Responses 输出文本');
}

function reasoningSummaryLines(item: Record<string, unknown>): string[] {
  if (!Array.isArray(item.summary)) {
    return [];
  }
  const lines: string[] = [];
  for (const summary of item.summary) {
    if (
      isRecord(summary) &&
      summary.type === 'summary_text' &&
      typeof summary.text === 'string' &&
      summary.text.trim()
    ) {
      lines.push(summary.text.trim());
    }
  }
  return lines;
}

function reasoningSummary(payload: Record<string, unknown>): string | undefined {
  if (!Array.isArray(payload.output)) {
    return undefined;
  }
  const summaries: string[] = [];
  for (const item of payload.output) {
    if (!isRecord(item) || item.type !== 'reasoning') {
      continue;
    }
    summaries.push(...reasoningSummaryLines(item));
  }
  if (!summaries.length) {
    return undefined;
  }
  return boundedOutput(summaries.join('\n\n'), 'Responses 推理摘要');
}

function extractEncryptedContinuations(
  payload: Record<string, unknown>,
  continuationProvider: 'openai' | 'xai'
): ProviderContinuationBlock[] {
  if (!Array.isArray(payload.output)) return [];
  const blocks: ProviderContinuationBlock[] = [];
  for (const item of payload.output) {
    if (!isRecord(item) || item.type !== 'reasoning') continue;
    if (typeof item.encrypted_content !== 'string' || !item.encrypted_content.trim()) continue;
    const summary = reasoningSummaryLines(item);
    blocks.push({
      provider: continuationProvider,
      type: 'reasoning_encrypted',
      ...(typeof item.id === 'string' && item.id.trim() ? { id: item.id.trim() } : {}),
      encryptedContent: item.encrypted_content,
      ...(summary.length ? { summary } : {}),
    });
  }
  return blocks;
}

function extractCitationsFromPayload(payload: Record<string, unknown>): WebCitation[] {
  const citations: WebCitation[] = [];
  const seenUrls = new Set<string>();
  const output = Array.isArray(payload.output) ? payload.output : [];
  let joinedTextLength = 0;
  let includedMessageCount = 0;

  for (const item of output) {
    if (!isRecord(item) || item.type !== 'message' || !Array.isArray(item.content)) continue;
    let messageText = '';
    let hasIncludedPart = false;
    const pending: Array<WebCitation & { partOffset: number }> = [];

    for (const part of item.content) {
      if (!isRecord(part)) continue;
      const partText =
        part.type === 'output_text' && typeof part.text === 'string'
          ? part.text
          : part.type === 'refusal' && typeof part.refusal === 'string'
            ? part.refusal
            : undefined;
      if (partText == null) continue;
      const partOffset = messageText.length;
      messageText += partText;
      hasIncludedPart = true;

      if (part.type !== 'output_text' || !Array.isArray(part.annotations)) continue;
      for (const annotation of part.annotations) {
        if (!isRecord(annotation) || annotation.type !== 'url_citation') continue;
        const url = validatedPublicHttpsUrl(annotation.url);
        if (!url) continue;
        const start = annotation.start_index;
        const end = annotation.end_index;
        const validRange =
          Number.isInteger(start) &&
          Number.isInteger(end) &&
          (start as number) >= 0 &&
          (end as number) > (start as number) &&
          (end as number) <= partText.length;
        pending.push({
          url,
          ...(typeof annotation.title === 'string' && annotation.title.trim()
            ? { title: annotation.title.trim() }
            : {}),
          ...(validRange
            ? { startIndex: start as number, endIndex: end as number }
            : {}),
          partOffset,
        });
      }
    }

    if (!hasIncludedPart) continue;
    const messageOffset = joinedTextLength + (includedMessageCount > 0 ? 2 : 0);
    for (const citation of pending) {
      if (seenUrls.has(citation.url)) continue;
      seenUrls.add(citation.url);
      citations.push({
        url: citation.url,
        ...(citation.title ? { title: citation.title } : {}),
        ...(citation.startIndex !== undefined && citation.endIndex !== undefined
          ? {
              startIndex: messageOffset + citation.partOffset + citation.startIndex,
              endIndex: messageOffset + citation.partOffset + citation.endIndex,
            }
          : {}),
      });
    }
    joinedTextLength = messageOffset + messageText.length;
    includedMessageCount += 1;
  }

  return citations;
}

function searchCallContentJson(item: Record<string, unknown>): {
  query?: string;
  content?: string;
  summary?: string;
} {
  const action = isRecord(item.action) ? item.action : undefined;
  const query =
    typeof action?.query === 'string' && action.query.trim()
      ? action.query.trim()
      : Array.isArray(action?.queries) && typeof action.queries[0] === 'string'
        ? action.queries[0].trim()
        : undefined;
  const rawResults = Array.isArray(item.results)
    ? item.results
    : Array.isArray(action?.results)
      ? action.results
      : [];
  const mappedItems: Array<{ title: string; url: string; text?: string }> = [];
  for (const row of rawResults) {
    if (!isRecord(row)) continue;
    const url = validatedPublicHttpsUrl(row.url);
    if (!url) continue;
    const title = typeof row.title === 'string' && row.title.trim() ? row.title.trim() : url;
    const snippet =
      typeof row.snippet === 'string'
        ? row.snippet.trim()
        : typeof row.content === 'string'
          ? row.content.trim()
          : undefined;
    mappedItems.push({ title, url, ...(snippet ? { text: snippet } : {}) });
  }
  const summary =
    mappedItems.length > 0
      ? `返回 ${mappedItems.length} 条结果`
      : query
        ? `已检索：${query}`
        : '检索完成';
  if (!query && !mappedItems.length) {
    return { summary };
  }
  return {
    ...(query ? { query } : {}),
    summary,
    content: JSON.stringify({
      ...(query ? { query } : {}),
      items: mappedItems,
    }),
  };
}

function extractSearchToolActivities(payload: Record<string, unknown>): {
  toolActivity: ToolActivityItem[];
  webSearchTriggered: boolean;
} {
  if (!Array.isArray(payload.output)) {
    return { toolActivity: [], webSearchTriggered: false };
  }
  const toolActivity: ToolActivityItem[] = [];
  let webSearchTriggered = false;

  payload.output.forEach((item, idx) => {
    if (!isRecord(item)) return;
    if (item.type !== 'web_search_call' && item.type !== 'x_search_call') return;
    webSearchTriggered = true;
    const toolName = item.type === 'x_search_call' ? 'x_search' : 'web_search';
    const { query, content, summary } = searchCallContentJson(item);
    const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `ws_${idx}`;
    const status = item.status === 'failed' ? 'failed' : 'completed';
    toolActivity.push({
      id,
      toolName,
      title: query ? `搜索「${query}」` : toolName === 'x_search' ? 'X 实时检索' : '联网检索',
      ...(query ? { arguments: { query } } : {}),
      status,
      ...(summary ? { summary } : {}),
      ...(content ? { content } : {}),
      sequence: idx,
    });
  });

  return { toolActivity, webSearchTriggered };
}

function buildGeneratedImageAttachment(
  item: Record<string, unknown>,
  fallbackIndex: number
): { attachment?: MediaAttachment; revisedPrompt?: string } {
  const revisedPrompt =
    typeof item.revised_prompt === 'string' && item.revised_prompt.trim()
      ? item.revised_prompt.trim()
      : undefined;
  const rawResult =
    typeof item.result === 'string' && item.result.trim()
      ? item.result.trim()
      : typeof item.b64_json === 'string' && item.b64_json.trim()
        ? item.b64_json.trim()
        : undefined;
  if (!rawResult) {
    return { revisedPrompt };
  }
  const id =
    typeof item.id === 'string' && item.id.trim()
      ? item.id.trim()
      : `img_${fallbackIndex}`;
  const rawFormat =
    typeof item.output_format === 'string' ? item.output_format.trim().toLowerCase() : 'png';
  const ext = rawFormat === 'jpeg' || rawFormat === 'jpg' ? 'jpg' : rawFormat === 'webp' ? 'webp' : 'png';
  const mimeType =
    ext === 'jpg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';

  if (/^https?:\/\//i.test(rawResult)) {
    return {
      revisedPrompt,
      attachment: {
        id,
        kind: 'image',
        uri: rawResult,
        name: `${id}.${ext}`,
        mimeType,
      },
    };
  }
  if (rawResult.startsWith('data:')) {
    const commaIdx = rawResult.indexOf(',');
    const b64 = commaIdx >= 0 ? rawResult.slice(commaIdx + 1).trim() : undefined;
    return {
      revisedPrompt,
      attachment: {
        id,
        kind: 'image',
        uri: rawResult,
        name: `${id}.${ext}`,
        mimeType,
        ...(b64 ? { base64: b64 } : {}),
      },
    };
  }
  return {
    revisedPrompt,
    attachment: {
      id,
      kind: 'image',
      uri: `data:${mimeType};base64,${rawResult}`,
      name: `${id}.${ext}`,
      mimeType,
      base64: rawResult,
    },
  };
}

function extractImageGenerationCalls(payload: Record<string, unknown>): MediaAttachment[] {
  if (!Array.isArray(payload.output)) {
    return [];
  }
  const attachments: MediaAttachment[] = [];
  const seenIds = new Set<string>();

  for (const item of payload.output) {
    if (!isRecord(item) || item.type !== 'image_generation_call') {
      continue;
    }
    const { attachment } = buildGeneratedImageAttachment(item, attachments.length + 1);
    if (!attachment || seenIds.has(attachment.id)) {
      continue;
    }
    seenIds.add(attachment.id);
    attachments.push(attachment);
  }
  return attachments;
}

function optionalUsageNumber(
  object: Record<string, unknown>,
  key: string,
  path: string
): number | undefined {
  const value = object[key];
  if (value == null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return protocolError(`${path}.${key} 必须是非负有限数字。`);
  }
  return value;
}

function tokenUsage(payload: Record<string, unknown>): ChatTokenUsage | undefined {
  if (payload.usage == null) {
    return undefined;
  }
  if (!isRecord(payload.usage)) {
    return protocolError('usage 必须是 JSON 对象。');
  }
  const inputDetails = isRecord(payload.usage.input_tokens_details)
    ? payload.usage.input_tokens_details
    : {};
  const outputDetails = isRecord(payload.usage.output_tokens_details)
    ? payload.usage.output_tokens_details
    : {};
  const usage: ChatTokenUsage = {
    inputTokens: optionalUsageNumber(payload.usage, 'input_tokens', 'usage'),
    outputTokens: optionalUsageNumber(payload.usage, 'output_tokens', 'usage'),
    reasoningTokens: optionalUsageNumber(outputDetails, 'reasoning_tokens', 'usage.output_tokens_details'),
    cachedInputTokens: optionalUsageNumber(inputDetails, 'cached_tokens', 'usage.input_tokens_details'),
    totalTokens: optionalUsageNumber(payload.usage, 'total_tokens', 'usage'),
  };
  return Object.values(usage).some((value) => typeof value === 'number') ? usage : undefined;
}

export function parseOpenAiResponsesResponse(
  payload: unknown,
  options?: { continuationProvider?: 'openai' | 'xai' }
): ChatCompletionResult {
  const parsed = parsedResponsePayload(payload);
  const apiError = errorMessage(parsed.error);
  if (apiError) {
    return protocolError(`Responses API 返回错误：${apiError}`);
  }

  const status = parsed.status;
  if (status === 'failed' || status === 'cancelled') {
    return protocolError(`Responses API 请求${status === 'failed' ? '失败' : '已取消'}。`);
  }
  if (status === 'incomplete') {
    const reason = isRecord(parsed.incomplete_details)
      ? errorMessage(parsed.incomplete_details.reason)
      : undefined;
    return protocolError(`Responses API 返回未完成结果${reason ? `：${reason}` : ''}。`);
  }
  if (status != null && status !== 'completed') {
    return protocolError(`Responses API 返回未知状态：${String(status)}。`);
  }
  if (parsed.output != null && !Array.isArray(parsed.output)) {
    return protocolError('Responses output 必须是数组。');
  }

  const content = outputText(parsed);
  const reasoningContent = reasoningSummary(parsed);
  const continuations = extractEncryptedContinuations(
    parsed,
    options?.continuationProvider ?? 'openai'
  );
  const citations = extractCitationsFromPayload(parsed);
  const { toolActivity, webSearchTriggered } = extractSearchToolActivities(parsed);
  const generatedImages = extractImageGenerationCalls(parsed);

  if (!content.trim() && !reasoningContent && !continuations.length && !generatedImages.length) {
    return protocolError('Responses API 没有返回输出文本或推理摘要。');
  }

  // 严格保持向后兼容：仅当扩展字段非空时才挂载，避免破坏既有精确 toEqual 断言
  return {
    content,
    reasoningContent,
    usage: tokenUsage(parsed),
    raw: parsed,
    ...(continuations.length ? { providerContinuations: continuations } : {}),
    ...(citations.length ? { citations } : {}),
    ...(webSearchTriggered || citations.length ? { webSearchTriggered: true } : {}),
    ...(toolActivity.length ? { toolActivity } : {}),
    ...(generatedImages.length ? { attachments: generatedImages } : {}),
  };
}

/**
 * 创建标准 SSE 增量分帧器，支持跨 chunk UTF-8 分片、跨 chunk `\r\n` 拆分、CRLF/LF 换行统一、注释心跳跳过与单块字节限制。
 */
export function createSseEventParser(options?: { maxEventBytes?: number }) {
  const maxEventBytes = options?.maxEventBytes ?? openAiResponsesLimits.maxStreamEventBytes;
  const decoder = new TextDecoder();
  let buffer = '';
  // 记录上一 chunk 是否以孤立 '\r' 结尾，防止跨包 '\r' | '\n' 被误拆为 '\n\n'
  let pendingCarriageReturn = false;

  function parseBlock(rawBlock: string): SseEventFrame | null {
    const lines = rawBlock.split('\n');
    let eventName: string | undefined;
    const dataLines: string[] = [];

    for (const line of lines) {
      if (!line || line.startsWith(':')) {
        continue;
      }
      if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim();
        continue;
      }
      if (line.startsWith('data:')) {
        const value = line.slice('data:'.length);
        dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
      }
    }

    if (!dataLines.length) {
      return null;
    }
    return {
      ...(eventName ? { event: eventName } : {}),
      data: dataLines.join('\n'),
    };
  }

  function assertBufferLimit(next: string): void {
    if (utf8Bytes(next) > maxEventBytes) {
      protocolError(`SSE 事件帧超过 ${Math.round(maxEventBytes / 1024)} KiB 上限。`);
    }
  }

  function appendDecodedChunk(decoded: string): void {
    if (!decoded) {
      return;
    }
    let text = decoded;
    if (pendingCarriageReturn) {
      pendingCarriageReturn = false;
      text = text.startsWith('\n') ? `\n${text.slice(1)}` : `\n${text}`;
    }
    if (text.endsWith('\r')) {
      pendingCarriageReturn = true;
      text = text.slice(0, -1);
    }
    if (text) {
      buffer += text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    }
  }

  return {
    push(chunk: Uint8Array | string): SseEventFrame[] {
      const decoded =
        typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      appendDecodedChunk(decoded);

      const frames: SseEventFrame[] = [];
      let separatorIndex = buffer.indexOf('\n\n');
      while (separatorIndex !== -1) {
        const block = buffer.slice(0, separatorIndex);
        assertBufferLimit(block);
        buffer = buffer.slice(separatorIndex + 2);
        const frame = parseBlock(block);
        if (frame) {
          frames.push(frame);
        }
        separatorIndex = buffer.indexOf('\n\n');
      }

      assertBufferLimit(buffer);
      return frames;
    },

    flush(): SseEventFrame[] {
      const tail = decoder.decode();
      appendDecodedChunk(tail);
      if (pendingCarriageReturn) {
        pendingCarriageReturn = false;
        buffer += '\n';
      }
      assertBufferLimit(buffer);
      const frames: SseEventFrame[] = [];
      if (buffer.trim()) {
        const frame = parseBlock(buffer);
        if (frame) {
          frames.push(frame);
        }
      }
      buffer = '';
      return frames;
    },
  };
}

/**
 * 解析单条 Responses SSE 文本块或事件载荷（兼容 `[DONE]`、注释心跳及标准 `response.*` JSON 事件）。
 */
export function parseOpenAiResponsesSseChunk(
  frameOrText: string | SseEventFrame
): ParsedOpenAiResponsesSseChunk {
  let frame: SseEventFrame;
  if (typeof frameOrText === 'string') {
    const parser = createSseEventParser();
    const frames = [...parser.push(frameOrText), ...parser.flush()];
    if (!frames.length) {
      return { kind: 'comment' };
    }
    frame = frames[0];
  } else {
    frame = frameOrText;
  }

  const trimmedData = frame.data.trim();
  if (!trimmedData) {
    return { kind: 'comment' };
  }
  if (trimmedData === '[DONE]') {
    return { kind: 'done' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmedData);
  } catch (error) {
    return protocolError(
      `Responses SSE 事件 JSON 无法解析：${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!isRecord(parsed)) {
    return protocolError('Responses SSE 事件载荷必须是 JSON 对象。');
  }

  const eventType =
    typeof parsed.type === 'string' && parsed.type.trim()
      ? parsed.type.trim()
      : frame.event;

  return {
    kind: 'event',
    ...(eventType ? { event: eventType } : {}),
    payload: parsed,
  };
}

function mergeContinuations(
  existing: ProviderContinuationBlock[],
  nextBlock: ProviderContinuationBlock
): ProviderContinuationBlock[] {
  if (nextBlock.type !== 'reasoning_encrypted') {
    return [...existing, nextBlock];
  }
  const index = existing.findIndex(
    (item) =>
      item.type === 'reasoning_encrypted' &&
      item.provider === nextBlock.provider &&
      ((nextBlock.id && item.id === nextBlock.id) ||
        item.encryptedContent === nextBlock.encryptedContent)
  );
  if (index >= 0) {
    const copy = [...existing];
    copy[index] = nextBlock;
    return copy;
  }
  return [...existing, nextBlock];
}

function appendCitationIfValid(
  citations: WebCitation[],
  seenUrls: Set<string>,
  rawAnnotation: Record<string, unknown>,
  options?: { baseOffset?: number; maxPartLength?: number }
): boolean {
  if (rawAnnotation.type !== 'url_citation' && typeof rawAnnotation.url !== 'string') {
    return false;
  }
  const url = validatedPublicHttpsUrl(rawAnnotation.url);
  if (!url || seenUrls.has(url)) {
    return false;
  }
  seenUrls.add(url);
  const start = rawAnnotation.start_index;
  const end = rawAnnotation.end_index;
  const baseOffset = options?.baseOffset ?? 0;
  const maxPartLength = options?.maxPartLength;
  const hasRange =
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    (start as number) >= 0 &&
    (end as number) > (start as number) &&
    (maxPartLength === undefined || (end as number) <= maxPartLength);
  citations.push({
    url,
    ...(typeof rawAnnotation.title === 'string' && rawAnnotation.title.trim()
      ? { title: rawAnnotation.title.trim() }
      : {}),
    ...(hasRange
      ? {
          startIndex: baseOffset + (start as number),
          endIndex: baseOffset + (end as number),
        }
      : {}),
  });
  return true;
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

function redactOpenAiSecrets(text: string, apiKey?: string): string {
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

function createResponsesAbortError(message = '请求已取消。'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function resolveResponsesAbortError(signal?: AbortSignal): Error {
  if (
    signal?.reason instanceof Error &&
    (signal.reason.name === 'AbortError' || signal.reason.name === 'TimeoutError')
  ) {
    return signal.reason;
  }
  return createResponsesAbortError();
}

/**
 * 在支持 `AbortSignal` 与字节上限保护的前提下读取响应文本：
 * 若 `response.body` 可用则优先通过 `getReader()` 逐块读取解码，避免 `response.text()` 锁定流导致无法 `cancel()`。
 */
export async function readResponseTextWithAbort(
  response: Response,
  signal?: AbortSignal,
  maxBytes: number = openAiResponsesLimits.maxResponseJsonBytes
): Promise<string> {
  if (signal?.aborted) {
    void response.body?.cancel().catch(() => undefined);
    throw resolveResponsesAbortError(signal);
  }

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    protocolError(`Responses 响应体过大（上限 ${Math.round(maxBytes / 1024 / 1024)} MB）。`);
  }

  const reader = response.body?.getReader();
  let onAbort: (() => void) | undefined;
  const abortPromise = signal
    ? new Promise<never>((_, reject) => {
        onAbort = () => {
          // 先 reject 竞态 Promise，避免取消流时唤醒 pending read() 返回 done: true
          reject(resolveResponsesAbortError(signal));
          if (reader) {
            void reader.cancel().catch(() => undefined);
          } else {
            void response.body?.cancel().catch(() => undefined);
          }
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      })
    : undefined;

  if (!reader) {
    try {
      const text = abortPromise
        ? await Promise.race([response.text(), abortPromise])
        : await response.text();
      if (signal?.aborted) {
        throw resolveResponsesAbortError(signal);
      }
      if (utf8Bytes(text) > maxBytes) {
        protocolError(`Responses 响应体过大（上限 ${Math.round(maxBytes / 1024 / 1024)} MB）。`);
      }
      return text;
    } finally {
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
    }
  }

  const decoder = new TextDecoder('utf-8');
  let totalBytes = 0;
  let text = '';
  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => undefined);
        throw resolveResponsesAbortError(signal);
      }
      const { value, done } = abortPromise
        ? await Promise.race([reader.read(), abortPromise])
        : await reader.read();
      if (signal?.aborted) {
        await reader.cancel().catch(() => undefined);
        throw resolveResponsesAbortError(signal);
      }
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        protocolError(`Responses 响应体过大（上限 ${Math.round(maxBytes / 1024 / 1024)} MB）。`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    if (signal?.aborted) {
      throw resolveResponsesAbortError(signal);
    }
    return text;
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

function sanitizeOpenAiErrorSnippet(text: string, apiKey?: string): string {
  const redacted = redactOpenAiSecrets(text, apiKey);
  return redacted.replace(/\s+/g, ' ').trim().slice(0, 260);
}

function sanitizeOpenAiError(error: unknown, apiKey?: string): Error {
  const err = error instanceof Error ? error : new Error(String(error));
  const cleanMessage = redactOpenAiSecrets(err.message, apiKey);
  if (cleanMessage === err.message) {
    return err;
  }
  if (err instanceof OpenAiResponsesProtocolError) {
    return new OpenAiResponsesProtocolError(cleanMessage);
  }
  const sanitized = new Error(cleanMessage);
  sanitized.name = err.name;
  return sanitized;
}

/**
 * 消费 OpenAI Responses API 流式响应（支持无 `[DONE]` 结束、心跳注释、跨块 UTF-8 分片与 `application/json` 回退），
 * 实时触发 `StreamChatCallbacks` 并返回完整 `ChatCompletionResult`。
 */
export async function readOpenAiResponsesStream(
  response: Response,
  callbacks?: StreamChatCallbacks,
  options?: {
    continuationProvider?: 'openai' | 'xai';
    maxEventBytes?: number;
    maxOutputCharacters?: number;
    signal?: AbortSignal;
  }
): Promise<ChatCompletionResult> {
  const signal = options?.signal;
  const continuationProvider = options?.continuationProvider ?? 'openai';
  const maxOutputCharacters =
    options?.maxOutputCharacters ?? openAiResponsesLimits.maxOutputCharacters;
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';

  if (signal?.aborted) {
    void response.body?.cancel().catch(() => undefined);
    const abortErr = resolveResponsesAbortError(signal);
    callbacks?.onError?.(abortErr);
    throw abortErr;
  }

  // 非流式 JSON 响应自动回退（中转站或关闭流式时）
  if (contentType.includes('application/json') && !contentType.includes('text/event-stream')) {
    try {
      const rawText = await readResponseTextWithAbort(response, signal);
      const result = parseOpenAiResponsesResponse(rawText, { continuationProvider });
      if (result.reasoningContent) {
        callbacks?.onThinkingDelta?.(result.reasoningContent, result.reasoningContent);
        callbacks?.onThinkingComplete?.(0);
      }
      if (result.toolActivity?.length) {
        callbacks?.onToolActivity?.(result.toolActivity, result.activityTimeline);
      }
      if (result.citations?.length || result.webSearchTriggered) {
        callbacks?.onCitations?.(result.citations ?? [], result.webSearchTriggered);
      }
      if (result.providerContinuations?.length) {
        callbacks?.onContinuationBlocks?.(result.providerContinuations);
      }
      if (result.attachments?.length) {
        callbacks?.onImageGenerated?.(result.attachments);
      }
      if (result.content) {
        callbacks?.onTextDelta?.(result.content, result.content);
      }
      if (result.usage) {
        callbacks?.onUsage?.(result.usage);
      }
      callbacks?.onDone?.(result);
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      callbacks?.onError?.(err);
      throw err;
    }
  }

  const parser = createSseEventParser({ maxEventBytes: options?.maxEventBytes });
  let content = '';
  let reasoningContent = '';
  let thinkingStartedAt: number | undefined;
  let thinkingDurationMs: number | undefined;
  let thinkingCompletedEmitted = false;
  let needReasoningPartSeparator = false;
  let sawSummaryDeltaInCurrentPart = false;
  let sawCompleted = false;
  let sawDoneMarker = false;
  let sawStreamPayload = false;
  let finalRaw: unknown;
  let finalUsage: ChatTokenUsage | undefined;
  let webSearchTriggered = false;
  let toolActivity: ToolActivityItem[] = [];
  let activityTimeline: ActivityTimelineStep[] = [];
  let continuations: ProviderContinuationBlock[] = [];
  const citations: WebCitation[] = [];
  const seenCitationUrls = new Set<string>();
  const generatedImages: MediaAttachment[] = [];
  const imageGenerationOutputItems: Record<string, unknown>[] = [];
  let completedMessageOffset = 0;
  let completedMessageCount = 0;

  function upsertGeneratedImageItem(item: Record<string, unknown>, emit = true): void {
    const { attachment, revisedPrompt } = buildGeneratedImageAttachment(
      item,
      generatedImages.length + 1
    );
    if (revisedPrompt || attachment) {
      const itemId =
        attachment?.id ??
        (typeof item.id === 'string' && item.id.trim() ? item.id.trim() : undefined);
      const existingRawIdx = itemId
        ? imageGenerationOutputItems.findIndex((entry) => entry.id === itemId)
        : -1;
      if (existingRawIdx >= 0) {
        imageGenerationOutputItems[existingRawIdx] = {
          ...imageGenerationOutputItems[existingRawIdx],
          ...item,
        };
      } else {
        imageGenerationOutputItems.push({ ...item });
      }
    }
    if (!attachment) {
      return;
    }
    const existingIdx = generatedImages.findIndex((entry) => entry.id === attachment.id);
    if (existingIdx >= 0) {
      generatedImages[existingIdx] = attachment;
    } else {
      generatedImages.push(attachment);
    }
    if (emit) {
      callbacks?.onImageGenerated?.([...generatedImages]);
    }
  }

  const thinkingTimelineId = 'thinking-main';

  function emitThinkingCompleteIfNeeded(): void {
    // 仅当实际产出非空思考摘要文本时才触发 onThinkingComplete 与记录思考耗时
    if (thinkingStartedAt === undefined || thinkingCompletedEmitted || !reasoningContent) {
      return;
    }
    thinkingCompletedEmitted = true;
    thinkingDurationMs = Math.max(0, Date.now() - thinkingStartedAt);
    activityTimeline = completeOpenThinkingSteps(activityTimeline, Date.now());
    callbacks?.onThinkingComplete?.(thinkingDurationMs);
  }

  function appendReasoning(delta: string): void {
    if (!delta) return;
    if (thinkingStartedAt === undefined) {
      thinkingStartedAt = Date.now();
    }
    let prefix = '';
    if (needReasoningPartSeparator && reasoningContent.length > 0 && !reasoningContent.endsWith('\n\n')) {
      prefix = '\n\n';
    }
    needReasoningPartSeparator = false;
    const combinedDelta = `${prefix}${delta}`;
    if (content.length + reasoningContent.length + combinedDelta.length > maxOutputCharacters) {
      protocolError(`Responses 流式输出超过 ${maxOutputCharacters.toLocaleString()} 字符上限。`);
    }
    reasoningContent += combinedDelta;
    activityTimeline = upsertTimelineStep(activityTimeline, {
      id: thinkingTimelineId,
      kind: 'thinking',
      sequence: activityTimeline.some((s) => s.id === thinkingTimelineId)
        ? activityTimeline.find((s) => s.id === thinkingTimelineId)!.sequence
        : nextTimelineSequence(activityTimeline),
      status: 'running',
      content: reasoningContent,
      startedAt: thinkingStartedAt,
    });
    callbacks?.onThinkingDelta?.(combinedDelta, reasoningContent);
  }

  function appendText(delta: string): void {
    if (!delta) return;
    emitThinkingCompleteIfNeeded();
    if (content.length + reasoningContent.length + delta.length > maxOutputCharacters) {
      protocolError(`Responses 流式输出超过 ${maxOutputCharacters.toLocaleString()} 字符上限。`);
    }
    content += delta;
    callbacks?.onTextDelta?.(delta, content);
  }

  function upsertSearchStep(
    id: string,
    toolName: 'web_search' | 'x_search',
    status: ToolActivityItem['status'],
    patch: Partial<ToolActivityItem> = {}
  ): void {
    emitThinkingCompleteIfNeeded();
    const existing = toolActivity.find((item) => item.id === id);
    const sequence = existing?.sequence ?? nextTimelineSequence(activityTimeline);
    const nextItem: ToolActivityItem = {
      ...existing,
      id,
      toolName,
      status,
      startedAt: existing?.startedAt ?? Date.now(),
      ...(status !== 'running'
        ? { finishedAt: patch.finishedAt ?? existing?.finishedAt ?? Date.now() }
        : {}),
      sequence,
      ...patch,
    };
    toolActivity = upsertToolActivity(toolActivity, nextItem);
    activityTimeline = upsertTimelineStep(activityTimeline, {
      id,
      kind: 'tool',
      sequence,
      status: nextItem.status,
      toolName: nextItem.toolName,
      ...(nextItem.title ? { title: nextItem.title } : {}),
      ...(nextItem.arguments ? { arguments: nextItem.arguments } : {}),
      ...(nextItem.summary ? { summary: nextItem.summary } : {}),
      ...(nextItem.content ? { content: nextItem.content } : {}),
      startedAt: nextItem.startedAt,
      ...(nextItem.finishedAt !== undefined ? { finishedAt: nextItem.finishedAt } : {}),
    });
    callbacks?.onToolActivity?.(toolActivity, activityTimeline);
  }

  function handleFrame(frame: SseEventFrame): void {
    const parsedFrame = parseOpenAiResponsesSseChunk(frame);
    if (parsedFrame.kind === 'comment') {
      return;
    }
    if (parsedFrame.kind === 'done') {
      sawDoneMarker = true;
      return;
    }

    const payload = parsedFrame.payload!;
    const eventType = parsedFrame.event ?? '';
    sawStreamPayload = true;

    if (eventType === 'error' || payload.error) {
      const msg = errorMessage(payload.error) ?? errorMessage(payload) ?? '未知流式错误';
      protocolError(`Responses API 流式错误：${msg}`);
    }

    if (eventType === 'response.failed') {
      const resp = isRecord(payload.response) ? payload.response : payload;
      const msg = errorMessage(resp.error) ?? 'Responses API 请求失败';
      protocolError(`Responses API 返回错误：${msg}`);
    }

    if (eventType === 'response.incomplete') {
      const resp = isRecord(payload.response) ? payload.response : payload;
      const reason = isRecord(resp.incomplete_details)
        ? errorMessage(resp.incomplete_details.reason)
        : undefined;
      protocolError(`Responses API 返回未完成结果${reason ? `：${reason}` : ''}。`);
    }

    if (eventType === 'response.created' || eventType === 'response.in_progress') {
      if (isRecord(payload.response)) {
        finalRaw = payload.response;
      }
      return;
    }

    if (eventType === 'response.output_item.added') {
      const item = isRecord(payload.item) ? payload.item : undefined;
      if (!item) return;
      if (item.type === 'reasoning') {
        thinkingStartedAt ??= Date.now();
      } else if (item.type === 'web_search_call' || item.type === 'x_search_call') {
        webSearchTriggered = true;
        const toolName = item.type === 'x_search_call' ? 'x_search' : 'web_search';
        const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : 'ws_0';
        upsertSearchStep(id, toolName, 'running', {
          title: toolName === 'x_search' ? '正在搜索 X…' : '正在联网检索…',
        });
      }
      return;
    }

    if (
      eventType === 'response.web_search_call.in_progress' ||
      eventType === 'response.web_search_call.searching' ||
      eventType === 'response.x_search_call.in_progress' ||
      eventType === 'response.x_search_call.searching'
    ) {
      webSearchTriggered = true;
      const isX = eventType.includes('x_search_call');
      const id =
        typeof payload.item_id === 'string' && payload.item_id.trim()
          ? payload.item_id.trim()
          : 'ws_0';
      const action = isRecord(payload.action) ? payload.action : undefined;
      const query = typeof action?.query === 'string' ? action.query.trim() : undefined;
      upsertSearchStep(id, isX ? 'x_search' : 'web_search', 'running', {
        title: query ? `正在搜索「${query}」` : isX ? '正在搜索 X…' : '正在联网检索…',
        ...(query ? { arguments: { query } } : {}),
      });
      return;
    }

    if (
      eventType === 'response.web_search_call.completed' ||
      eventType === 'response.x_search_call.completed'
    ) {
      webSearchTriggered = true;
      const isX = eventType.includes('x_search_call');
      const id =
        typeof payload.item_id === 'string' && payload.item_id.trim()
          ? payload.item_id.trim()
          : 'ws_0';
      const existing = toolActivity.find((item) => item.id === id);
      upsertSearchStep(id, isX ? 'x_search' : 'web_search', 'completed', {
        title: existing?.arguments?.query
          ? `搜索「${String(existing.arguments.query)}」`
          : isX
            ? 'X 实时检索'
            : '联网检索',
        summary: existing?.summary ?? '检索完成',
      });
      return;
    }

    if (eventType === 'response.reasoning_summary_part.added') {
      thinkingStartedAt ??= Date.now();
      sawSummaryDeltaInCurrentPart = false;
      if (reasoningContent.length > 0) {
        needReasoningPartSeparator = true;
      }
      return;
    }

    if (eventType === 'response.reasoning_summary_text.delta') {
      const delta = typeof payload.delta === 'string' ? payload.delta : '';
      if (delta) {
        sawSummaryDeltaInCurrentPart = true;
        appendReasoning(delta);
      }
      return;
    }

    if (
      eventType === 'response.reasoning_summary_text.done' ||
      eventType === 'response.reasoning_summary_part.done'
    ) {
      if (!sawSummaryDeltaInCurrentPart) {
        const partText =
          typeof payload.text === 'string'
            ? payload.text
            : isRecord(payload.part) && typeof payload.part.text === 'string'
              ? payload.part.text
              : '';
        if (partText.trim()) {
          appendReasoning(partText.trim());
          sawSummaryDeltaInCurrentPart = true;
        }
      }
      // 严禁在 text.done 时重置 sawSummaryDeltaInCurrentPart，仅在 part.done / part.added 重置
      if (eventType === 'response.reasoning_summary_part.done') {
        sawSummaryDeltaInCurrentPart = false;
      }
      return;
    }

    if (eventType === 'response.output_text.delta') {
      const delta = typeof payload.delta === 'string' ? payload.delta : '';
      appendText(delta);
      return;
    }

    if (eventType === 'response.output_text.annotation.added') {
      const annotation = isRecord(payload.annotation) ? payload.annotation : undefined;
      if (annotation && appendCitationIfValid(citations, seenCitationUrls, annotation)) {
        webSearchTriggered = true;
        callbacks?.onCitations?.([...citations], true);
      }
      return;
    }

    if (eventType === 'response.output_item.done') {
      const item = isRecord(payload.item) ? payload.item : undefined;
      if (!item) return;

      if (item.type === 'reasoning') {
        if (!reasoningContent.trim()) {
          const lines = reasoningSummaryLines(item);
          if (lines.length) {
            appendReasoning(lines.join('\n\n'));
          }
        }
        emitThinkingCompleteIfNeeded();
        if (typeof item.encrypted_content === 'string' && item.encrypted_content.trim()) {
          const summary = reasoningSummaryLines(item);
          const block: ProviderContinuationBlock = {
            provider: continuationProvider,
            type: 'reasoning_encrypted',
            ...(typeof item.id === 'string' && item.id.trim() ? { id: item.id.trim() } : {}),
            encryptedContent: item.encrypted_content,
            ...(summary.length ? { summary } : {}),
          };
          continuations = mergeContinuations(continuations, block);
          callbacks?.onContinuationBlocks?.([...continuations]);
        }
      } else if (item.type === 'web_search_call' || item.type === 'x_search_call') {
        webSearchTriggered = true;
        const toolName = item.type === 'x_search_call' ? 'x_search' : 'web_search';
        const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : 'ws_0';
        const { query, content: detailJson, summary } = searchCallContentJson(item);
        upsertSearchStep(id, toolName, item.status === 'failed' ? 'failed' : 'completed', {
          title: query
            ? `搜索「${query}」`
            : toolName === 'x_search'
              ? 'X 实时检索'
              : '联网检索',
          ...(query ? { arguments: { query } } : {}),
          ...(summary ? { summary } : {}),
          ...(detailJson ? { content: detailJson } : {}),
        });
      } else if (item.type === 'image_generation_call') {
        upsertGeneratedImageItem(item, true);
      } else if (item.type === 'message' && Array.isArray(item.content)) {
        let addedCitation = false;
        let messageText = '';
        let hasIncludedPart = false;
        const messageOffset = completedMessageOffset + (completedMessageCount > 0 ? 2 : 0);

        for (const part of item.content) {
          if (!isRecord(part)) continue;
          const partText =
            part.type === 'output_text' && typeof part.text === 'string'
              ? part.text
              : part.type === 'refusal' && typeof part.refusal === 'string'
                ? part.refusal
                : undefined;
          if (partText == null) continue;
          const partOffset = messageText.length;
          messageText += partText;
          hasIncludedPart = true;

          if (part.type === 'output_text' && Array.isArray(part.annotations)) {
            for (const annotation of part.annotations) {
              if (
                isRecord(annotation) &&
                appendCitationIfValid(citations, seenCitationUrls, annotation, {
                  baseOffset: messageOffset + partOffset,
                  maxPartLength: partText.length,
                })
              ) {
                addedCitation = true;
              }
            }
          }
        }
        if (hasIncludedPart) {
          completedMessageOffset = messageOffset + messageText.length;
          completedMessageCount += 1;
        }
        if (!content && messageText) {
          appendText(messageText);
        }
        if (addedCitation) {
          webSearchTriggered = true;
          callbacks?.onCitations?.([...citations], true);
        }
      }
      return;
    }

    if (eventType === 'response.completed') {
      sawCompleted = true;
      const resp = isRecord(payload.response) ? payload.response : payload;
      finalRaw = resp;

      const apiErr = errorMessage(resp.error);
      if (apiErr) {
        protocolError(`Responses API 返回错误：${apiErr}`);
      }
      if (resp.status === 'failed' || resp.status === 'cancelled') {
        protocolError(`Responses API 请求${resp.status === 'failed' ? '失败' : '已取消'}。`);
      }
      if (resp.status === 'incomplete') {
        const reason = isRecord(resp.incomplete_details)
          ? errorMessage(resp.incomplete_details.reason)
          : undefined;
        protocolError(`Responses API 返回未完成结果${reason ? `：${reason}` : ''}。`);
      }

      const usage = tokenUsage(resp);
      if (usage) {
        finalUsage = usage;
        callbacks?.onUsage?.(usage);
      }

      // 兜底补全未通过增量收到的文本、思考、续接块与引用
      if (!reasoningContent) {
        const summary = reasoningSummary(resp);
        if (summary) {
          appendReasoning(summary);
        }
      }
      emitThinkingCompleteIfNeeded();

      for (const block of extractEncryptedContinuations(resp, continuationProvider)) {
        const beforeLen = continuations.length;
        continuations = mergeContinuations(continuations, block);
        if (continuations.length !== beforeLen) {
          callbacks?.onContinuationBlocks?.([...continuations]);
        }
      }

      if (!content) {
        const text = outputText(resp);
        if (text) {
          appendText(text);
        }
      }

      if (Array.isArray(resp.output)) {
        for (const item of resp.output) {
          if (isRecord(item) && item.type === 'image_generation_call') {
            upsertGeneratedImageItem(item, false);
          }
        }
      }

      const extractedCitations = extractCitationsFromPayload(resp);
      let citationChanged = false;
      for (const item of extractedCitations) {
        const existingIndex = citations.findIndex((existing) => existing.url === item.url);
        if (existingIndex === -1) {
          seenCitationUrls.add(item.url);
          citations.push(item);
          citationChanged = true;
          continue;
        }
        const existing = citations[existingIndex];
        const shouldUpdateRange =
          item.startIndex !== undefined &&
          item.endIndex !== undefined &&
          (existing.startIndex !== item.startIndex || existing.endIndex !== item.endIndex);
        const shouldUpdateTitle = !existing.title && Boolean(item.title);
        if (shouldUpdateRange || shouldUpdateTitle) {
          citations[existingIndex] = {
            ...existing,
            ...(shouldUpdateTitle && item.title ? { title: item.title } : {}),
            ...(shouldUpdateRange
              ? { startIndex: item.startIndex, endIndex: item.endIndex }
              : {}),
          };
          citationChanged = true;
        }
      }

      // 校验流式阶段收集的引用区间，移除超出最终正文长度或无效的索引
      for (let i = 0; i < citations.length; i++) {
        const item = citations[i];
        if (
          item.endIndex !== undefined &&
          (item.startIndex === undefined ||
            item.startIndex < 0 ||
            item.endIndex <= item.startIndex ||
            item.endIndex > content.length)
        ) {
          const { startIndex: _start, endIndex: _end, ...rest } = item;
          citations[i] = rest;
          citationChanged = true;
        }
      }

      if (citationChanged) {
        webSearchTriggered = true;
        callbacks?.onCitations?.([...citations], true);
      }
    }
  }

  try {
    const reader = response.body?.getReader();
    if (!reader) {
      const rawText = await readResponseTextWithAbort(response, signal);
      for (const frame of parser.push(rawText)) {
        handleFrame(frame);
        if (sawDoneMarker) break;
      }
      if (!sawDoneMarker) {
        for (const frame of parser.flush()) {
          handleFrame(frame);
        }
      }
    } else {
      let onAbort: (() => void) | undefined;
      const abortPromise = signal
        ? new Promise<never>((_, reject) => {
            onAbort = () => {
              // 先 reject 竞态 Promise，避免 reader.cancel() 提前唤醒 pending read() 返回 done: true
              reject(resolveResponsesAbortError(signal));
              void reader.cancel().catch(() => undefined);
            };
            if (signal.aborted) {
              onAbort();
            } else {
              signal.addEventListener('abort', onAbort, { once: true });
            }
          })
        : undefined;

      try {
        while (true) {
          if (signal?.aborted) {
            await reader.cancel().catch(() => undefined);
            throw resolveResponsesAbortError(signal);
          }
          const { value, done } = abortPromise
            ? await Promise.race([reader.read(), abortPromise])
            : await reader.read();
          if (signal?.aborted) {
            await reader.cancel().catch(() => undefined);
            throw resolveResponsesAbortError(signal);
          }
          if (done) break;
          if (!value) continue;
          for (const frame of parser.push(value)) {
            handleFrame(frame);
            if (sawDoneMarker) break;
          }
          if (sawDoneMarker) {
            await reader.cancel().catch(() => undefined);
            break;
          }
        }
        if (signal?.aborted) {
          throw resolveResponsesAbortError(signal);
        }
        if (!sawDoneMarker) {
          for (const frame of parser.flush()) {
            handleFrame(frame);
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

    if (!sawCompleted && !sawDoneMarker) {
      if (!sawStreamPayload) {
        protocolError('Responses 流式响应为空，未收到任何有效事件。');
      }
      protocolError('Responses 流式响应未收到 response.completed 终止事件即意外中断。');
    }

    emitThinkingCompleteIfNeeded();

    // 无论流以 response.completed 还是直接以 [DONE] 结束，均统一清理越界或无效的引用区间
    let citationsCleaned = false;
    for (let i = 0; i < citations.length; i += 1) {
      const item = citations[i];
      if (
        item.endIndex !== undefined &&
        (item.startIndex === undefined ||
          item.startIndex < 0 ||
          item.endIndex <= item.startIndex ||
          item.endIndex > content.length)
      ) {
        const { startIndex: _start, endIndex: _end, ...rest } = item;
        citations[i] = rest;
        citationsCleaned = true;
      }
    }
    if (citationsCleaned) {
      webSearchTriggered = true;
      callbacks?.onCitations?.([...citations], true);
    }

    if (!content.trim() && !reasoningContent && !continuations.length && !generatedImages.length) {
      protocolError('Responses API 没有返回输出文本或推理摘要。');
    }

    const resolvedRaw = (() => {
      if (isRecord(finalRaw)) {
        const existingOutput = Array.isArray(finalRaw.output) ? finalRaw.output : [];
        if (imageGenerationOutputItems.length && existingOutput.length === 0) {
          return { ...finalRaw, output: imageGenerationOutputItems };
        }
        return finalRaw;
      }
      return {
        status: 'completed',
        output_text: content,
        ...(imageGenerationOutputItems.length ? { output: imageGenerationOutputItems } : {}),
      };
    })();

    const result: ChatCompletionResult = {
      content,
      ...(reasoningContent ? { reasoningContent } : {}),
      ...(thinkingDurationMs !== undefined ? { thinkingDurationMs } : {}),
      ...(continuations.length ? { providerContinuations: continuations } : {}),
      ...(finalUsage ? { usage: finalUsage } : {}),
      ...(citations.length ? { citations } : {}),
      ...(webSearchTriggered || citations.length ? { webSearchTriggered: true } : {}),
      ...(toolActivity.length ? { toolActivity } : {}),
      ...(activityTimeline.length ? { activityTimeline } : {}),
      ...(generatedImages.length ? { attachments: generatedImages } : {}),
      raw: resolvedRaw,
    };

    callbacks?.onDone?.(result);
    return result;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    callbacks?.onError?.(err);
    throw err;
  }
}

const responsesWebDevProxyUrl = 'http://127.0.0.1:8787/proxy';

function isResponsesLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

async function resolveRuntimePlatformOs(): Promise<string | undefined> {
  try {
    const rn = (await import('react-native')) as { Platform?: { OS?: string } };
    return rn?.Platform?.OS;
  } catch {
    return undefined;
  }
}

function isResponsesWebDevelopmentProxyAllowed(platformOs: string | undefined): boolean {
  const development = typeof __DEV__ !== 'undefined' && __DEV__ === true;
  const explicitlyEnabled = process.env.EXPO_PUBLIC_ENABLE_WEB_DEV_PROXY === '1';
  const location =
    typeof window !== 'undefined'
      ? { protocol: window.location.protocol, hostname: window.location.hostname }
      : undefined;
  return Boolean(
    platformOs === 'web' &&
    development &&
    explicitlyEnabled &&
    location &&
    (location.protocol === 'http:' || location.protocol === 'https:') &&
    isResponsesLoopbackHostname(location.hostname)
  );
}

/**
 * 发起 OpenAI Responses 对话请求（支持流式 SSE 与 JSON 回退，支持 `fetchImpl` 注入以避免模块循环依赖；
 * Web 生产态强制 fail-closed，本机调试仅经受限代理转发）。
 */
export async function sendOpenAiResponsesChat(
  args: SendOpenAiResponsesChatArgs,
  callbacks?: StreamChatCallbacks
): Promise<ChatCompletionResult> {
  const {
    provider,
    fetchImpl = fetch,
    signal,
    timeoutMs = 120_000,
    ...requestArgs
  } = args;

  if (signal?.aborted) {
    const abortErr = resolveResponsesAbortError(signal);
    callbacks?.onError?.(abortErr);
    throw abortErr;
  }

  const platformOs = await resolveRuntimePlatformOs();
  if (platformOs === 'web' && !isResponsesWebDevelopmentProxyAllowed(platformOs)) {
    const blockedErr = new OpenAiResponsesProtocolError(
      '正式 Web 构建不会发送 API Key 或模型请求。仅可在本机通过 npm run web 显式启动受限调试代理。'
    );
    callbacks?.onError?.(blockedErr);
    throw blockedErr;
  }

  const request = buildOpenAiResponsesStreamRequest({
    provider,
    ...requestArgs,
    stream: requestArgs.stream ?? true,
  });

  const headers: Record<string, string> = {
    ...resolveProviderAuthHeaders(provider),
    'Content-Type': 'application/json',
    Accept: 'text/event-stream, application/json',
  };

  const controller = new AbortController();
  const onAbort = () => controller.abort(resolveResponsesAbortError(signal));
  if (signal?.aborted) {
    const abortErr = resolveResponsesAbortError(signal);
    callbacks?.onError?.(abortErr);
    throw abortErr;
  }
  signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => {
    const timeoutErr = new Error(`OpenAI Responses 请求超过 ${Math.round(timeoutMs / 1000)} 秒超时。`);
    timeoutErr.name = 'TimeoutError';
    controller.abort(timeoutErr);
  }, timeoutMs);

  let errorNotified = false;
  const notifyErrorOnce = (error: unknown): Error => {
    const sanitizedErr = sanitizeOpenAiError(error, provider.apiKey);
    if (!errorNotified) {
      errorNotified = true;
      callbacks?.onError?.(sanitizedErr);
    }
    return sanitizedErr;
  };

  try {
    let response: Response;
    const serializedBody = JSON.stringify(request.body);
    if (platformOs === 'web') {
      try {
        response = await fetchImpl(responsesWebDevProxyUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url: request.url,
            method: 'POST',
            headers,
            body: serializedBody,
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          throw error;
        }
        throw new OpenAiResponsesProtocolError(
          'Web 调试代理未启动或不可访问。请用 npm run web 启动应用，或确认 127.0.0.1:8787 可访问。'
        );
      }
    } else {
      response = await fetchImpl(request.url, {
        method: 'POST',
        headers,
        body: serializedBody,
        signal: controller.signal,
        redirect: 'error',
      });
    }

    if (!response.ok) {
      const errText = await readResponseTextWithAbort(response, controller.signal).catch((err) => {
        if (controller.signal.aborted) {
          throw err;
        }
        return '';
      });
      const cleanSnippet = sanitizeOpenAiErrorSnippet(errText, provider.apiKey);
      throw new OpenAiResponsesProtocolError(
        `OpenAI Responses 请求失败：HTTP ${response.status}${cleanSnippet ? ` ${cleanSnippet}` : ''}`
      );
    }

    const wrappedCallbacks: StreamChatCallbacks | undefined = callbacks
      ? {
          ...callbacks,
          onError: (err) => {
            notifyErrorOnce(err);
          },
        }
      : undefined;

    return await readOpenAiResponsesStream(response, wrappedCallbacks, {
      continuationProvider: requestArgs.continuationProvider ?? 'openai',
      signal: controller.signal,
    });
  } catch (error) {
    if (signal?.aborted) {
      throw notifyErrorOnce(resolveResponsesAbortError(signal));
    }
    if (controller.signal.aborted) {
      throw notifyErrorOnce(resolveResponsesAbortError(controller.signal));
    }
    throw notifyErrorOnce(error);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}
