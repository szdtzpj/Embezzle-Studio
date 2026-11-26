import { Platform } from 'react-native';

import type {
  ActivityTimelineStep,
  ChatCompletionResult,
  ChatTokenUsage,
  MediaAttachment,
  ModelInfo,
  ModelParameterSettings,
  ProviderContinuationBlock,
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
import { materializeAttachment } from './mediaStorage';
import {
  completeOpenThinkingSteps,
  formatSearchActivityTitle,
  formatThinkingRowTitle,
  nextTimelineSequence,
  upsertTimelineStep,
  upsertToolActivity,
} from './messageActivity';
import { createModelInfoFromId, inferModelTask } from './modelCapabilities';
import { isAbortError, isWebDevelopmentProxyAllowed } from './openAiCompatible';
import {
  inspectProviderEndpoint,
  isExactOfficialAnthropicProvider,
  resolveProviderAuthHeaders,
} from './providerSetup';
import { isBlockedPublicHost } from './ssrfGuard';

const webDevProxyUrl = 'http://127.0.0.1:8787/proxy';
const defaultAnthropicVersion = '2023-06-01';
const emptyContentPlaceholder = '模型返回了空内容。';
const anthropicCodeExecutionBeta = 'code-execution-web-tools-2026-02-09';
const supportedImageMimeTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

/** Anthropic Messages 协议资源与边界限制常量。 */
export const anthropicMessagesLimits = Object.freeze({
  maxMessages: 1_000,
  maxInputTextCharacters: 2_000_000,
  maxImageBytes: 5 * 1024 * 1024,
  maxDocumentBytes: 32 * 1024 * 1024,
  maxJsonResponseBytes: 16 * 1024 * 1024,
  maxErrorResponseBytes: 64 * 1024,
  maxStreamEventBytes: 1024 * 1024,
  maxStreamOutputCharacters: 2_000_000,
  defaultMaxTokens: 8_192,
  maxAllowedOutputTokens: 131_072,
  defaultTimeoutMs: 600_000,
});

/** Anthropic 协议层专属异常，携带 HTTP 状态码、服务端错误类型及请求追踪 ID。 */
export class AnthropicProtocolError extends Error {
  status?: number;
  errorType?: string;
  requestId?: string;

  constructor(
    message: string,
    options: { status?: number; errorType?: string; requestId?: string } = {}
  ) {
    super(message);
    this.name = 'AnthropicProtocolError';
    this.status = options.status;
    this.errorType = options.errorType;
    this.requestId = options.requestId;
  }
}

/** Anthropic 原生服务端 Web Search 工具配置。 */
export interface AnthropicWebSearchOptions {
  enabled: boolean;
  toolType?: 'web_search_20250305' | 'web_search_20260209';
  maxUses?: number;
  allowedDomains?: string[];
  blockedDomains?: string[];
  userLocation?: {
    type: 'approximate';
    city?: string;
    region?: string;
    country?: string;
    timezone?: string;
  };
}

/** 与现有 ChatRequestExecution 对齐的流式增量快照结构。 */
export interface AnthropicStreamUpdate {
  content: string;
  reasoningContent?: string;
  usage?: ChatTokenUsage;
  toolActivity?: ToolActivityItem[];
  activityTimeline?: ActivityTimelineStep[];
  raw?: unknown;
}

/** Anthropic Messages 请求体数据结构。 */
export interface AnthropicMessagesRequestBody {
  model: string;
  max_tokens: number;
  messages: Array<{
    role: 'user' | 'assistant';
    content: Array<Record<string, unknown>>;
  }>;
  stream: boolean;
  system?: string;
  thinking?: { type: 'adaptive' } | { type: 'enabled'; budget_tokens: number };
  output_config?: { effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' };
  temperature?: number;
  top_p?: number;
  tools?: Array<Record<string, unknown>>;
}

/** 调用 Anthropic Messages 原生接口的完整参数（兼容 ChatProviderRequest）。 */
export interface AnthropicMessagesChatArgs extends ChatProviderRequest {
  callbacks?: StreamChatCallbacks;
  stream?: boolean;
  anthropicWebSearch?: AnthropicWebSearchOptions;
  extraBetas?: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface ActiveThinkingBlockState {
  kind: 'thinking';
  index: number;
  startedAt: number;
  thinking: string;
  signature: string;
  stepId: string;
  completed: boolean;
}

interface ActiveRedactedThinkingBlockState {
  kind: 'redacted_thinking';
  index: number;
  data: string;
  recorded: boolean;
}

interface ActiveTextBlockState {
  kind: 'text';
  index: number;
  text: string;
}

interface ActiveServerToolUseBlockState {
  kind: 'server_tool_use';
  index: number;
  id: string;
  name: string;
  input: Record<string, unknown>;
  partialJson: string;
  startedAt: number;
}

interface ActiveWebSearchToolResultBlockState {
  kind: 'web_search_tool_result';
  index: number;
  toolUseId: string;
  content: unknown[];
}

type ActiveAnthropicBlockState =
  | ActiveThinkingBlockState
  | ActiveRedactedThinkingBlockState
  | ActiveTextBlockState
  | ActiveServerToolUseBlockState
  | ActiveWebSearchToolResultBlockState;

interface AnthropicSseState {
  messageId?: string;
  model?: string;
  stopReason?: string;
  content: string;
  reasoningContent: string;
  totalThinkingDurationMs: number;
  usage: ChatTokenUsage;
  hasUsage: boolean;
  continuationBlocks: ProviderContinuationBlock[];
  citations: WebCitation[];
  citationUrls: Set<string>;
  toolActivity: ToolActivityItem[];
  activityTimeline: ActivityTimelineStep[];
  activeBlocks: Map<number, ActiveAnthropicBlockState>;
  lastThinkingIndex?: number;
  webSearchTriggered: boolean;
  stopped: boolean;
  sawMessageStart: boolean;
  rawEvents: unknown[];
  lastPayload: unknown;
}

/** 构造可被 isAbortError 识别的中止错误。 */
function createAbortError(message = '请求已取消。'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function protocolError(
  message: string,
  options: { status?: number; errorType?: string; requestId?: string } = {}
): never {
  throw new AnthropicProtocolError(message, options);
}

function compactResponseText(body: string): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, 320);
}

function looksLikeHtmlResponse(body: string, contentType: string): boolean {
  const text = body.trim().toLowerCase();
  return contentType.includes('text/html') || text.startsWith('<!doctype') || text.startsWith('<html');
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

function sanitizeErrorMessage(message: string, apiKey?: string): string {
  const trimmedKey = apiKey?.trim();
  if (!trimmedKey || trimmedKey.length < 4) {
    return message;
  }
  let sanitized = message.split(trimmedKey).join('[REDACTED]');
  const encodedKey = encodeURIComponent(trimmedKey);
  if (encodedKey && encodedKey !== trimmedKey) {
    sanitized = sanitized.replace(buildPercentEncodedSecretPattern(encodedKey), '[REDACTED]');
  }
  return sanitized;
}

function hasHeaderCaseInsensitive(headers: Record<string, string>, targetKey: string): boolean {
  const lowerTarget = targetKey.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lowerTarget);
}

function getHeaderCaseInsensitive(headers: Record<string, string>, targetKey: string): string | undefined {
  const lowerTarget = targetKey.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerTarget) {
      return value;
    }
  }
  return undefined;
}

function setHeaderCaseInsensitive(headers: Record<string, string>, key: string, value: string): void {
  const lowerTarget = key.toLowerCase();
  for (const existingKey of Object.keys(headers)) {
    if (existingKey.toLowerCase() === lowerTarget && existingKey !== key) {
      delete headers[existingKey];
    }
  }
  headers[key] = value;
}

/** 校验远程图片/引用 URL 是否为安全的公网 HTTPS 地址（拦截内网与回环地址）。 */
function isUnsafePublicHostname(hostname: string): boolean {
  return isBlockedPublicHost(hostname);
}

function validatedHttpsPublicUrl(value: unknown): string | undefined {
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
    isUnsafePublicHostname(url.hostname)
  ) {
    return undefined;
  }
  return url.toString();
}

/**
 * 规范化并校验 Anthropic Messages `/v1/messages` 请求端点 URL。
 * 支持官方 `api.anthropic.com`、DeepSeek `/anthropic` 兼容路径以及通用中转地址。
 */
export function getAnthropicMessagesEndpoint(
  provider: Pick<ProviderProfile, 'kind' | 'baseUrl'>
): string {
  const rawBaseUrl = provider.baseUrl.trim();
  if (!rawBaseUrl) {
    return protocolError('请先填写 Anthropic 服务商的 Base URL。');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    return protocolError('Anthropic Base URL 不是有效网址，请填写完整的 https:// 地址。');
  }

  if (parsed.username || parsed.password) {
    return protocolError('Anthropic Base URL 不能包含用户名或密码。');
  }
  if (parsed.search || parsed.hash) {
    return protocolError('Anthropic Base URL 不能包含查询参数或片段。');
  }
  if (
    parsed.protocol !== 'https:' &&
    !(parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname))
  ) {
    return protocolError('Anthropic Base URL 必须使用 HTTPS；只有本机回环调试地址可以使用 HTTP。');
  }

  if (isExactOfficialAnthropicProvider(provider)) {
    return 'https://api.anthropic.com/v1/messages';
  }

  const host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  const cleanPath = parsed.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  const lowerPath = cleanPath.toLowerCase();

  // DeepSeek 官方 Anthropic 兼容接口位于 /anthropic/v1/messages
  if (host === 'api.deepseek.com') {
    if (parsed.port) {
      return protocolError('官方服务商地址不能使用自定义端口。');
    }
    if (
      lowerPath === '/anthropic' ||
      lowerPath === '/anthropic/v1' ||
      lowerPath === '/anthropic/v1/messages'
    ) {
      return 'https://api.deepseek.com/anthropic/v1/messages';
    }
  }

  // 若用户对官方主机使用了错误类型（如 custom/new-api-relay），但域名仍是官方域名，保持按路径安全规范化
  const inspection = inspectProviderEndpoint(rawBaseUrl, { kind: provider.kind });
  if (inspection.family === 'anthropic-official' && parsed.port) {
    return protocolError('官方服务商地址不能使用自定义端口。');
  }

  let basePath = cleanPath.replace(/\/(?:messages|models)$/i, '');
  if (!basePath || basePath === '/') {
    basePath = '/v1';
  }
  return `${parsed.origin}${basePath}/messages`;
}

/**
 * 判断 Claude 模型是否属于新一代 Adaptive Thinking（`thinking: { type: 'adaptive' }` + `output_config.effort`）家族。
 * 覆盖 Claude 5.x（包括 `claude-fable-5-*`）及 Claude 4.6/4.7/4.8+；3.7 与 4.0~4.5 返回 false。
 */
export function isAdaptiveThinkingClaudeModel(modelId: string): boolean {
  const normalized = modelId
    .trim()
    .toLowerCase()
    .replace(/[:/_.\s]+/g, '-')
    // 剔除结尾日期快照后缀（例如 -20250514 或 -2026-01-01）
    .replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, '');

  if (!normalized) {
    return false;
  }

  // Claude 5.x 全系列（Opus / Sonnet / Haiku / Fable 等）
  if (/(?:^|-)claude-(?:opus|sonnet|haiku|fable)-5(?:-|$)/.test(normalized)) {
    return true;
  }

  // Claude 4.6 及以上（4.6 / 4.7 / 4.8 / 4.9 / 4.10+）
  if (/(?:^|-)claude-(?:opus|sonnet|haiku|fable)-4-(?:[6-9]|\d{2,})(?:-|$)/.test(normalized)) {
    return true;
  }

  return false;
}

/**
 * 构造 Anthropic Messages 请求头，包含鉴权、`anthropic-version` 兜底、
 * `anthropic-beta` 逗号去重合并以及 `Content-Type`/`Accept`。
 */
export function buildAnthropicMessagesHeaders(
  provider: Pick<ProviderProfile, 'kind' | 'baseUrl' | 'apiKey' | 'authHeaderMode' | 'customHeaders'>,
  options: { stream?: boolean; extraBetas?: string[] } = {}
): Record<string, string> {
  const headers = resolveProviderAuthHeaders(provider);

  if (!hasHeaderCaseInsensitive(headers, 'anthropic-version')) {
    headers['anthropic-version'] = defaultAnthropicVersion;
  }

  // 合并默认/工具所需的 beta 与用户自定义头中的所有 anthropic-beta（避免多条自定义头被覆盖，去重并保持顺序）
  const existingBetaHeader = getHeaderCaseInsensitive(headers, 'anthropic-beta');
  const mergedBetas: string[] = [];
  const seenBetas = new Set<string>();

  const pushBetaValues = (raw: string | undefined) => {
    if (!raw) return;
    for (const part of raw.split(',')) {
      const token = part.trim();
      if (!token || /[\r\n\0]/.test(token) || seenBetas.has(token)) {
        continue;
      }
      seenBetas.add(token);
      mergedBetas.push(token);
    }
  };

  for (const customHeader of provider.customHeaders ?? []) {
    if (!customHeader || customHeader.enabled === false) {
      continue;
    }
    if (typeof customHeader.key !== 'string' || typeof customHeader.value !== 'string') {
      continue;
    }
    if (customHeader.key.trim().toLowerCase() !== 'anthropic-beta') {
      continue;
    }
    if (/[\r\n\0]/.test(customHeader.value)) {
      continue;
    }
    pushBetaValues(customHeader.value);
  }

  pushBetaValues(existingBetaHeader);
  for (const beta of options.extraBetas ?? []) {
    pushBetaValues(beta);
  }
  if (mergedBetas.length > 0) {
    setHeaderCaseInsensitive(headers, 'anthropic-beta', mergedBetas.join(', '));
  }

  setHeaderCaseInsensitive(headers, 'Content-Type', 'application/json');
  setHeaderCaseInsensitive(
    headers,
    'Accept',
    options.stream === false ? 'application/json' : 'text/event-stream, application/json'
  );

  return headers;
}

function assertHasAuthHeaders(
  provider: Pick<ProviderProfile, 'kind' | 'baseUrl' | 'apiKey' | 'authHeaderMode'>,
  headers: Record<string, string>
): void {
  if (provider.authHeaderMode === 'custom') {
    return;
  }
  const hasAuth =
    hasHeaderCaseInsensitive(headers, 'x-api-key') ||
    hasHeaderCaseInsensitive(headers, 'authorization') ||
    hasHeaderCaseInsensitive(headers, 'x-goog-api-key');

  if (!hasAuth && isExactOfficialAnthropicProvider(provider)) {
    protocolError('请先配置 Anthropic API Key。');
  }
}

function normalizeImageMimeType(mimeType: string | undefined, attachmentName: string): string {
  const raw = (mimeType || 'image/jpeg').split(';', 1)[0].trim().toLowerCase();
  const canonical = raw === 'image/jpg' ? 'image/jpeg' : raw;
  if (!supportedImageMimeTypes.has(canonical)) {
    return protocolError(
      `图片「${attachmentName}」格式 ${canonical || '未知'} 不受 Anthropic 支持，请使用 JPEG、PNG、GIF 或 WebP。`
    );
  }
  return canonical;
}

function validateAndStripBase64(
  rawData: string,
  maxBytes: number,
  attachmentName: string,
  expectedMimePrefix?: string
): { mimeType?: string; data: string } {
  const trimmed = rawData.trim();
  const dataUrlMatch = trimmed.match(/^data:([^;,]+);base64,([\s\S]*)$/i);
  const mimeFromDataUrl = dataUrlMatch?.[1]?.trim().toLowerCase();
  if (expectedMimePrefix && mimeFromDataUrl && !mimeFromDataUrl.startsWith(expectedMimePrefix)) {
    // 交由外层进一步校验格式
  }
  const payload = (dataUrlMatch?.[2] ?? trimmed).replace(/\s+/g, '');
  if (!payload || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || payload.length % 4 === 1) {
    return protocolError(`附件「${attachmentName}」的 Base64 数据无效。`);
  }
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  const decodedBytes = Math.floor((payload.length * 3) / 4) - padding;
  if (decodedBytes > maxBytes) {
    return protocolError(
      `附件「${attachmentName}」体积超过 Anthropic 单项限制（上限 ${Math.round(maxBytes / 1024 / 1024)} MB）。`
    );
  }
  return {
    ...(mimeFromDataUrl ? { mimeType: mimeFromDataUrl } : {}),
    data: payload,
  };
}

async function convertUserAttachmentToBlock(
  attachment: MediaAttachment
): Promise<Record<string, unknown>> {
  const name = attachment.name || attachment.id || '未命名附件';
  if (attachment.kind === 'video') {
    return protocolError(`Anthropic Messages 协议暂不支持视频附件「${name}」。`);
  }

  const maxBytes =
    attachment.kind === 'image'
      ? anthropicMessagesLimits.maxImageBytes
      : anthropicMessagesLimits.maxDocumentBytes;
  const materialized = await materializeAttachment(attachment, { maxSourceBytes: maxBytes });

  if (materialized.kind === 'image') {
    const inline = materialized.base64?.trim();
    if (inline) {
      const parsed = validateAndStripBase64(inline, anthropicMessagesLimits.maxImageBytes, name, 'image/');
      const mediaType = normalizeImageMimeType(parsed.mimeType ?? materialized.mimeType, name);
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: parsed.data,
        },
      };
    }

    const uri = materialized.uri?.trim();
    if (!uri) {
      return protocolError(`图片「${name}」缺少可用的 Base64 数据或 URL。`);
    }
    if (uri.toLowerCase().startsWith('data:')) {
      const parsed = validateAndStripBase64(uri, anthropicMessagesLimits.maxImageBytes, name, 'image/');
      const mediaType = normalizeImageMimeType(parsed.mimeType ?? materialized.mimeType, name);
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: parsed.data,
        },
      };
    }

    const safeUrl = validatedHttpsPublicUrl(uri);
    if (!safeUrl) {
      return protocolError(
        `图片「${name}」仅支持 Base64 或公网 HTTPS URL，已拒绝非安全或本地私有地址。`
      );
    }
    return {
      type: 'image',
      source: {
        type: 'url',
        url: safeUrl,
      },
    };
  }

  // 文件附件仅支持 PDF document block
  const declaredMime = (materialized.mimeType || '').split(';', 1)[0].trim().toLowerCase();
  const isPdf = declaredMime === 'application/pdf' || name.toLowerCase().endsWith('.pdf');
  if (!isPdf) {
    return protocolError(`Anthropic 仅支持 PDF 文档附件，暂不支持「${name}」（${declaredMime || '未知类型'}）。`);
  }

  const inline = materialized.base64?.trim();
  if (inline) {
    const parsed = validateAndStripBase64(inline, anthropicMessagesLimits.maxDocumentBytes, name);
    return {
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: parsed.data,
      },
    };
  }

  const uri = materialized.uri?.trim();
  if (uri && uri.toLowerCase().startsWith('data:')) {
    const parsed = validateAndStripBase64(uri, anthropicMessagesLimits.maxDocumentBytes, name);
    return {
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: parsed.data,
      },
    };
  }

  const safeUrl = uri ? validatedHttpsPublicUrl(uri) : undefined;
  if (!safeUrl) {
    return protocolError(`PDF 附件「${name}」缺少可读的 Base64 数据或公网 HTTPS 地址。`);
  }
  return {
    type: 'document',
    source: {
      type: 'url',
      url: safeUrl,
    },
  };
}

function continuationBlockToAnthropicWire(
  block: ProviderContinuationBlock
): Record<string, unknown> | undefined {
  if (block.provider !== 'anthropic') {
    return undefined;
  }
  if (block.type === 'thinking') {
    // 缺少签名的 thinking 块回传会触发 Anthropic 400 Invalid signature，安全跳过
    if (!block.signature.trim()) {
      return undefined;
    }
    return {
      type: 'thinking',
      thinking: block.thinking,
      signature: block.signature,
    };
  }
  if (block.type === 'redacted_thinking') {
    return {
      type: 'redacted_thinking',
      data: block.data,
    };
  }
  if (block.type === 'server_tool_use') {
    return {
      type: 'server_tool_use',
      id: block.id,
      name: block.name,
      input: block.input,
    };
  }
  if (block.type === 'web_search_tool_result') {
    // 域模型使用驼峰 toolUseId，Anthropic 线协议使用 tool_use_id
    return {
      type: 'web_search_tool_result',
      tool_use_id: block.toolUseId,
      content: block.content,
    };
  }
  return undefined;
}

function mapAdaptiveEffort(effort: ReasoningEffort): 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  if (effort === 'minimal' || effort === 'low') return 'low';
  if (effort === 'medium') return 'medium';
  if (effort === 'xhigh') return 'xhigh';
  if (effort === 'max') return 'max';
  return 'high';
}

function mapBudgetTokensForEffort(effort: ReasoningEffort): number {
  if (effort === 'minimal' || effort === 'low') return 1_024;
  if (effort === 'medium') return 4_096;
  if (effort === 'high') return 10_240;
  return 16_384;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function buildAnthropicThinkingAndSampling(args: {
  modelId: string;
  model: ModelInfo;
  reasoningEffort: ReasoningEffort;
  parameterSettings?: ModelParameterSettings;
  maxOutputTokens?: number;
}): {
  maxTokens: number;
  thinking?: { type: 'adaptive' } | { type: 'enabled'; budget_tokens: number };
  outputConfig?: { effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' };
  temperature?: number;
  topP?: number;
} {
  const { modelId, model, reasoningEffort, parameterSettings, maxOutputTokens } = args;
  let maxTokens: number = anthropicMessagesLimits.defaultMaxTokens;
  if (maxOutputTokens !== undefined) {
    if (
      !Number.isInteger(maxOutputTokens) ||
      maxOutputTokens < 64 ||
      maxOutputTokens > anthropicMessagesLimits.maxAllowedOutputTokens
    ) {
      protocolError(`最大输出 Token 必须是 64–${anthropicMessagesLimits.maxAllowedOutputTokens} 的整数。`);
    }
    maxTokens = maxOutputTokens;
  }

  const reasoningDisabled =
    model.capabilityOverrides?.reasoning === false ||
    !model.capabilities.includes('reasoning') ||
    reasoningEffort === 'off' ||
    reasoningEffort === 'none';

  let thinking: { type: 'adaptive' } | { type: 'enabled'; budget_tokens: number } | undefined;
  let outputConfig: { effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' } | undefined;

  if (!reasoningDisabled) {
    if (isAdaptiveThinkingClaudeModel(modelId)) {
      thinking = { type: 'adaptive' };
      if (reasoningEffort !== 'default') {
        outputConfig = { effort: mapAdaptiveEffort(reasoningEffort) };
      }
    } else if (reasoningEffort !== 'default') {
      const budgetTokens = mapBudgetTokensForEffort(reasoningEffort);
      thinking = { type: 'enabled', budget_tokens: budgetTokens };
      // Anthropic 强制要求 max_tokens 严格大于 budget_tokens
      if (maxTokens <= budgetTokens) {
        maxTokens = Math.min(
          anthropicMessagesLimits.maxAllowedOutputTokens,
          budgetTokens + 4_096
        );
      }
    }
  }

  // 开启 thinking 时绝不发送 temperature / top_p，避免 Anthropic 返回 400
  let temperature: number | undefined;
  let topP: number | undefined;
  if (!thinking && parameterSettings?.enabled) {
    const roundedTemp = Math.round(clampNumber(parameterSettings.temperature, 0, 1) * 100) / 100;
    const roundedTopP = Math.round(clampNumber(parameterSettings.topP, 0, 1) * 100) / 100;
    if (roundedTemp !== 1) {
      temperature = roundedTemp;
    } else if (roundedTopP !== 1) {
      topP = roundedTopP;
    }
  }

  return {
    maxTokens,
    ...(thinking ? { thinking } : {}),
    ...(outputConfig ? { outputConfig } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}),
  };
}

function buildAnthropicWebSearchTools(args: {
  provider: ProviderProfile;
  model: ModelInfo;
  task: ReturnType<typeof inferModelTask>;
  webSearch?: AnthropicMessagesChatArgs['webSearch'];
  anthropicWebSearch?: AnthropicWebSearchOptions;
  externalSearch?: AnthropicMessagesChatArgs['externalSearch'];
}): {
  tools?: Array<Record<string, unknown>>;
  extraBetas: string[];
} {
  const nativeEnabled = Boolean(args.webSearch?.enabled || args.anthropicWebSearch?.enabled);
  if (!nativeEnabled) {
    return { extraBetas: [] };
  }
  if (args.externalSearch?.enabled) {
    protocolError('服务商原生联网搜索与外部搜索不能同时启用。');
  }
  if (args.task !== 'chat') {
    protocolError('联网搜索仅适用于对话模型，已拒绝发起请求。');
  }
  if (!args.model.capabilities.includes('web-search')) {
    protocolError('当前模型未标记支持联网搜索能力，已拒绝发起可能计费的搜索请求。');
  }

  const options = args.anthropicWebSearch;
  const allowedDomains = options?.allowedDomains?.map((item) => item.trim()).filter(Boolean);
  const blockedDomains = options?.blockedDomains?.map((item) => item.trim()).filter(Boolean);
  if (allowedDomains?.length && blockedDomains?.length) {
    protocolError('Anthropic Web Search 的 allowedDomains 与 blockedDomains 不能同时配置。');
  }

  const toolType = options?.toolType ?? 'web_search_20250305';
  const rawMaxUses = options?.maxUses ?? 5;
  const maxUses = Math.min(20, Math.max(1, Math.trunc(rawMaxUses)));

  const tool: Record<string, unknown> = {
    type: toolType,
    name: 'web_search',
    max_uses: maxUses,
    ...(allowedDomains?.length ? { allowed_domains: allowedDomains } : {}),
    ...(blockedDomains?.length ? { blocked_domains: blockedDomains } : {}),
    ...(options?.userLocation ? { user_location: options.userLocation } : {}),
  };

  const extraBetas =
    toolType === 'web_search_20260209' ? [anthropicCodeExecutionBeta] : [];

  return {
    tools: [tool],
    extraBetas,
  };
}

/**
 * 构造 Anthropic `/v1/messages` 完整请求（包含端点、Headers、Thinking 配置、
 * 消息合并、多模态附件实体化、多轮续接块还原与 Web Search 工具定义）。
 */
export async function buildAnthropicMessagesRequest(
  args: AnthropicMessagesChatArgs
): Promise<{
  url: string;
  headers: Record<string, string>;
  body: AnthropicMessagesRequestBody;
}> {
  const modelId = args.modelId.trim();
  if (!modelId) {
    return protocolError('请先选择一个 Anthropic 模型。');
  }
  if (!Array.isArray(args.messages) || args.messages.length === 0) {
    return protocolError('Anthropic Messages 请求至少需要一条输入消息。');
  }
  if (args.messages.length > anthropicMessagesLimits.maxMessages) {
    return protocolError(`输入消息过多，上限为 ${anthropicMessagesLimits.maxMessages} 条。`);
  }

  if (args.mcp) {
    return protocolError('Anthropic 原生协议暂不支持 OpenAI Remote MCP。');
  }
  if (args.externalSearch?.enabled && !args.webSearch?.enabled && !args.anthropicWebSearch?.enabled) {
    return protocolError('Anthropic 原生适配器暂不支持外部搜索工具循环，请改用原生联网搜索或兼容适配器。');
  }

  const requestModel = args.model ?? createModelInfoFromId(args.provider, modelId, 'manual');
  const task = inferModelTask(requestModel);
  if (task !== 'chat') {
    return protocolError(`当前模型任务类型为 ${task}，Anthropic Messages 仅支持对话模型。`);
  }

  const url = getAnthropicMessagesEndpoint(args.provider);

  const searchSetup = buildAnthropicWebSearchTools({
    provider: args.provider,
    model: requestModel,
    task,
    webSearch: args.webSearch,
    anthropicWebSearch: args.anthropicWebSearch,
    externalSearch: args.externalSearch,
  });

  const stream = args.stream !== false;
  const allBetas = [...(args.extraBetas ?? []), ...searchSetup.extraBetas];
  const headers = buildAnthropicMessagesHeaders(args.provider, {
    stream,
    extraBetas: allBetas,
  });
  assertHasAuthHeaders(args.provider, headers);

  const systemParts: string[] = [];
  const wireMessages: Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }> = [];
  let totalInputCharacters = 0;

  for (const msg of args.messages) {
    if (msg.status !== 'ready') {
      continue;
    }

    if (msg.role === 'system') {
      const trimmed = msg.content.trim();
      if (trimmed) {
        totalInputCharacters += trimmed.length;
        systemParts.push(trimmed);
      }
      continue;
    }

    const contentBlocks: Array<Record<string, unknown>> = [];

    if (msg.role === 'user') {
      for (const attachment of msg.attachments ?? []) {
        contentBlocks.push(await convertUserAttachmentToBlock(attachment));
      }
      if (msg.content.trim() || contentBlocks.length === 0) {
        if (msg.content) {
          totalInputCharacters += msg.content.length;
          contentBlocks.push({ type: 'text', text: msg.content });
        }
      }
    } else {
      // assistant 消息：先按原序还原 providerContinuations，再附加有效文本回复（跳过空内容占位符）
      for (const continuation of msg.providerContinuations ?? []) {
        const wireBlock = continuationBlockToAnthropicWire(continuation);
        if (wireBlock) {
          contentBlocks.push(wireBlock);
        }
      }
      const usableContent =
        msg.content && msg.content !== emptyContentPlaceholder ? msg.content : '';
      if (usableContent) {
        totalInputCharacters += usableContent.length;
        contentBlocks.push({ type: 'text', text: usableContent });
      }
    }

    if (contentBlocks.length === 0) {
      continue;
    }

    if (totalInputCharacters > anthropicMessagesLimits.maxInputTextCharacters) {
      return protocolError(
        `输入文本总长度超过上限（${anthropicMessagesLimits.maxInputTextCharacters} 字符）。`
      );
    }

    const role = msg.role;
    const previous = wireMessages[wireMessages.length - 1];
    if (previous && previous.role === role) {
      previous.content.push(...contentBlocks);
    } else {
      wireMessages.push({ role, content: contentBlocks });
    }
  }

  if (wireMessages.length === 0 || wireMessages[0].role !== 'user') {
    return protocolError('Anthropic Messages 请求必须至少包含一条有效的用户消息，且首条对话消息必须为 user。');
  }

  const thinkingAndSampling = buildAnthropicThinkingAndSampling({
    modelId,
    model: requestModel,
    reasoningEffort: args.reasoningEffort,
    parameterSettings: args.parameterSettings,
    maxOutputTokens: args.maxOutputTokens,
  });

  const body: AnthropicMessagesRequestBody = {
    model: modelId,
    max_tokens: thinkingAndSampling.maxTokens,
    messages: wireMessages,
    stream,
    ...(systemParts.length > 0 ? { system: systemParts.join('\n\n') } : {}),
    ...(thinkingAndSampling.thinking ? { thinking: thinkingAndSampling.thinking } : {}),
    ...(thinkingAndSampling.outputConfig ? { output_config: thinkingAndSampling.outputConfig } : {}),
    ...(thinkingAndSampling.temperature !== undefined
      ? { temperature: thinkingAndSampling.temperature }
      : {}),
    ...(thinkingAndSampling.topP !== undefined ? { top_p: thinkingAndSampling.topP } : {}),
    ...(searchSetup.tools ? { tools: searchSetup.tools } : {}),
  };

  return { url, headers, body };
}

function extractUsageFromAnthropicRecord(
  current: ChatTokenUsage,
  rawUsage: unknown
): { usage: ChatTokenUsage; changed: boolean } {
  if (!isRecord(rawUsage)) {
    return { usage: current, changed: false };
  }
  const next: ChatTokenUsage = { ...current };
  let changed = false;

  if (typeof rawUsage.input_tokens === 'number' && Number.isFinite(rawUsage.input_tokens)) {
    next.inputTokens = rawUsage.input_tokens;
    changed = true;
  }
  if (typeof rawUsage.output_tokens === 'number' && Number.isFinite(rawUsage.output_tokens)) {
    next.outputTokens = rawUsage.output_tokens;
    changed = true;
  }
  if (
    typeof rawUsage.cache_read_input_tokens === 'number' &&
    Number.isFinite(rawUsage.cache_read_input_tokens)
  ) {
    next.cachedInputTokens = rawUsage.cache_read_input_tokens;
    changed = true;
  }
  if (next.inputTokens !== undefined || next.outputTokens !== undefined) {
    next.totalTokens = (next.inputTokens ?? 0) + (next.outputTokens ?? 0);
  }
  return { usage: next, changed };
}

function appendCitation(state: AnthropicSseState, rawCitation: unknown): boolean {
  if (!isRecord(rawCitation)) {
    return false;
  }
  const type = typeof rawCitation.type === 'string' ? rawCitation.type : '';
  if (type && type !== 'web_search_result_location') {
    return false;
  }
  const safeUrl = validatedHttpsPublicUrl(rawCitation.url);
  if (!safeUrl || state.citationUrls.has(safeUrl)) {
    return false;
  }
  state.citationUrls.add(safeUrl);
  const title =
    typeof rawCitation.title === 'string' && rawCitation.title.trim()
      ? rawCitation.title.trim()
      : undefined;
  const citedText =
    typeof rawCitation.cited_text === 'string' && rawCitation.cited_text.trim()
      ? rawCitation.cited_text.trim()
      : undefined;
  state.citations.push({
    url: safeUrl,
    ...(title ? { title } : {}),
    ...(citedText ? { text: citedText } : {}),
    index: state.citations.length + 1,
  });
  return true;
}

function parseSearchToolResultsFromContent(
  content: unknown[],
  query: string | undefined
): {
  errorCode?: string;
  items: Array<{ title: string; url: string; text?: string }>;
} {
  let errorCode: string | undefined;
  const items: Array<{ title: string; url: string; text?: string }> = [];

  for (const entry of content) {
    if (!isRecord(entry)) continue;
    if (entry.type === 'web_search_tool_result_error') {
      errorCode = typeof entry.error_code === 'string' ? entry.error_code : 'web_search_error';
      continue;
    }
    if (entry.type === 'web_search_result' || typeof entry.url === 'string') {
      const safeUrl = validatedHttpsPublicUrl(entry.url);
      if (!safeUrl) continue;
      const title =
        typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim() : safeUrl;
      const snippet =
        typeof entry.page_age === 'string' && entry.page_age.trim()
          ? entry.page_age.trim()
          : typeof entry.encrypted_content === 'string'
            ? undefined
            : typeof entry.text === 'string' && entry.text.trim()
              ? entry.text.trim()
              : undefined;
      items.push({
        title,
        url: safeUrl,
        ...(snippet ? { text: snippet } : {}),
      });
    }
  }

  void query;
  return { errorCode, items };
}

function closeOpenThinkingBlocks(
  state: AnthropicSseState,
  callbacks?: StreamChatCallbacks,
  now = Date.now()
): void {
  for (const block of state.activeBlocks.values()) {
    if (block.kind === 'thinking' && !block.completed) {
      block.completed = true;
      const elapsed = Math.max(0, now - block.startedAt);
      state.totalThinkingDurationMs += elapsed;
      state.activityTimeline = upsertTimelineStep(state.activityTimeline, {
        id: block.stepId,
        kind: 'thinking',
        sequence: nextTimelineSequence(state.activityTimeline),
        status: 'completed',
        title: formatThinkingRowTitle('completed', block.startedAt, now),
        content: block.thinking,
        startedAt: block.startedAt,
        finishedAt: now,
      });
      callbacks?.onThinkingComplete?.(elapsed);
    }
  }
  state.activityTimeline = completeOpenThinkingSteps(state.activityTimeline, now);
}

function emitStreamUpdate(
  state: AnthropicSseState,
  onStreamUpdate?: (update: AnthropicStreamUpdate) => void
): void {
  if (!onStreamUpdate) return;
  onStreamUpdate({
    content: state.content,
    ...(state.reasoningContent ? { reasoningContent: state.reasoningContent } : {}),
    ...(state.hasUsage ? { usage: { ...state.usage } } : {}),
    ...(state.toolActivity.length ? { toolActivity: [...state.toolActivity] } : {}),
    ...(state.activityTimeline.length ? { activityTimeline: [...state.activityTimeline] } : {}),
    raw: state.lastPayload,
  });
}

function buildResultFromSseState(state: AnthropicSseState): ChatCompletionResult {
  const hasOutput =
    Boolean(state.content) ||
    Boolean(state.reasoningContent) ||
    state.continuationBlocks.length > 0;
  return {
    content: state.content || (hasOutput ? '' : emptyContentPlaceholder),
    ...(state.reasoningContent ? { reasoningContent: state.reasoningContent } : {}),
    ...(state.totalThinkingDurationMs > 0 || state.reasoningContent
      ? { thinkingDurationMs: state.totalThinkingDurationMs }
      : {}),
    ...(state.continuationBlocks.length
      ? { providerContinuations: [...state.continuationBlocks] }
      : {}),
    ...(state.hasUsage ? { usage: { ...state.usage } } : {}),
    ...(state.citations.length ? { citations: [...state.citations] } : {}),
    ...(state.webSearchTriggered ? { webSearchTriggered: true } : {}),
    ...(state.toolActivity.length ? { toolActivity: [...state.toolActivity] } : {}),
    ...(state.activityTimeline.length ? { activityTimeline: [...state.activityTimeline] } : {}),
    raw: state.lastPayload ?? state.rawEvents,
  };
}

function buildHttpStatusError(
  status: number,
  rawBody: string,
  headers: Headers,
  apiKey?: string
): AnthropicProtocolError {
  const requestId =
    headers.get('request-id')?.trim() || headers.get('x-request-id')?.trim() || undefined;
  const retryAfter = headers.get('retry-after')?.trim();

  let errorType: string | undefined;
  let errorMessage = '';
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (isRecord(parsed) && isRecord(parsed.error)) {
      errorType = typeof parsed.error.type === 'string' ? parsed.error.type : undefined;
      errorMessage = typeof parsed.error.message === 'string' ? parsed.error.message.trim() : '';
    }
  } catch {
    errorMessage = compactResponseText(rawBody);
  }

  if (!errorMessage) {
    errorMessage = compactResponseText(rawBody);
  }
  const safeDetail = sanitizeErrorMessage(errorMessage, apiKey);
  const requestIdSuffix = requestId ? `（request-id: ${requestId}）` : '';

  if (status === 401 || status === 403) {
    return new AnthropicProtocolError(
      `Anthropic 鉴权失败（${status}）：API Key 无效、已过期或无权访问该模型。${safeDetail ? ` 详情：${safeDetail}` : ''}${requestIdSuffix}`,
      { status, errorType, requestId }
    );
  }
  if (status === 404) {
    return new AnthropicProtocolError(
      `Anthropic 接口或模型不存在（404）：请检查模型 ID 与 Base URL。${safeDetail ? ` 详情：${safeDetail}` : ''}${requestIdSuffix}`,
      { status, errorType, requestId }
    );
  }
  if (status === 429) {
    const retryHint = retryAfter ? ` 请在约 ${retryAfter} 秒后重试。` : ' 请稍后重试。';
    return new AnthropicProtocolError(
      `Anthropic 请求触发速率或配额限制（429）。${retryHint}${safeDetail ? ` 详情：${safeDetail}` : ''}${requestIdSuffix}`,
      { status, errorType, requestId }
    );
  }
  if (status === 529 || errorType === 'overloaded_error') {
    return new AnthropicProtocolError(
      `Anthropic 服务当前过载（${status}），请稍后重试。${safeDetail ? ` 详情：${safeDetail}` : ''}${requestIdSuffix}`,
      { status, errorType, requestId }
    );
  }
  if (status >= 500) {
    return new AnthropicProtocolError(
      `Anthropic 服务端暂时不可用（${status}）。${safeDetail ? ` 详情：${safeDetail}` : ''}${requestIdSuffix}`,
      { status, errorType, requestId }
    );
  }
  return new AnthropicProtocolError(
    `Anthropic 请求失败（${status}${errorType ? `/${errorType}` : ''}）：${safeDetail || '请检查请求参数。'}${requestIdSuffix}`,
    { status, errorType, requestId }
  );
}

/**
 * 创建可独立单测的 Anthropic SSE 流式事件处理器。
 * 严格遵循无 `[DONE]` 的 Anthropic 事件生命周期：`message_start` -> `content_block_*` -> `message_delta` -> `message_stop`。
 */
export function createAnthropicSseProcessor(
  callbacks?: StreamChatCallbacks,
  onStreamUpdate?: (update: AnthropicStreamUpdate) => void,
  options: { apiKey?: string } = {}
): {
  processBlock: (rawBlock: string) => void;
  consumeText: (chunkText: string) => void;
  finish: () => ChatCompletionResult;
  isStopped: () => boolean;
} {
  const state: AnthropicSseState = {
    content: '',
    reasoningContent: '',
    totalThinkingDurationMs: 0,
    usage: {},
    hasUsage: false,
    continuationBlocks: [],
    citations: [],
    citationUrls: new Set<string>(),
    toolActivity: [],
    activityTimeline: [],
    activeBlocks: new Map<number, ActiveAnthropicBlockState>(),
    webSearchTriggered: false,
    stopped: false,
    sawMessageStart: false,
    rawEvents: [],
    lastPayload: undefined,
  };

  let buffer = '';
  let pendingTrailingCr = false;

  const applySearchToolResult = (
    toolUseId: string,
    rawContent: unknown[],
    queryHint?: string
  ) => {
    const relatedTool = state.toolActivity.find((item) => item.id === toolUseId);
    const query =
      queryHint ??
      (typeof relatedTool?.arguments?.query === 'string'
        ? relatedTool.arguments.query
        : undefined);
    const parsed = parseSearchToolResultsFromContent(rawContent, query);
    const now = Date.now();

    state.webSearchTriggered = true;
    const status: ToolActivityItem['status'] = parsed.errorCode ? 'failed' : 'completed';
    const summary = parsed.errorCode
      ? `搜索失败：${parsed.errorCode}`
      : `返回 ${parsed.items.length} 条结果`;
    const title = formatSearchActivityTitle({
      status,
      query,
      resultCount: parsed.errorCode ? undefined : parsed.items.length,
    });
    const detail = parsed.errorCode
      ? JSON.stringify({ error: parsed.errorCode })
      : JSON.stringify({ ...(query ? { query } : {}), items: parsed.items });

    state.toolActivity = upsertToolActivity(state.toolActivity, {
      id: toolUseId,
      toolName: relatedTool?.toolName ?? 'web_search',
      title,
      ...(relatedTool?.arguments ? { arguments: relatedTool.arguments } : {}),
      status,
      summary,
      content: detail,
      startedAt: relatedTool?.startedAt ?? now,
      finishedAt: now,
    });

    state.activityTimeline = upsertTimelineStep(state.activityTimeline, {
      id: `tool:${toolUseId}`,
      kind: 'tool',
      sequence: nextTimelineSequence(state.activityTimeline),
      status,
      toolName: relatedTool?.toolName ?? 'web_search',
      title,
      ...(relatedTool?.arguments ? { arguments: relatedTool.arguments } : {}),
      summary,
      content: detail,
      startedAt: relatedTool?.startedAt ?? now,
      finishedAt: now,
    });

    callbacks?.onToolActivity?.([...state.toolActivity], [...state.activityTimeline]);
  };

  const handleParsedEvent = (eventName: string | undefined, payload: Record<string, unknown>) => {
    const eventType =
      (typeof payload.type === 'string' && payload.type) || eventName || '';
    state.lastPayload = payload;
    state.rawEvents.push(payload);

    if (eventType === 'ping') {
      return;
    }

    if (eventType === 'error') {
      const errorRecord = isRecord(payload.error) ? payload.error : {};
      const errType = typeof errorRecord.type === 'string' ? errorRecord.type : undefined;
      const rawMsg =
        typeof errorRecord.message === 'string'
          ? errorRecord.message
          : 'Anthropic 流式响应返回了未知错误。';
      const err = new AnthropicProtocolError(
        `Anthropic 流式错误${errType ? `（${errType}）` : ''}：${sanitizeErrorMessage(rawMsg, options.apiKey)}`,
        { errorType: errType }
      );
      callbacks?.onError?.(err);
      throw err;
    }

    if (eventType === 'message_start') {
      state.sawMessageStart = true;
      if (isRecord(payload.message)) {
        if (typeof payload.message.id === 'string') {
          state.messageId = payload.message.id;
        }
        if (typeof payload.message.model === 'string') {
          state.model = payload.message.model;
        }
        const usageRes = extractUsageFromAnthropicRecord(state.usage, payload.message.usage);
        if (usageRes.changed) {
          state.usage = usageRes.usage;
          state.hasUsage = true;
          callbacks?.onUsage?.({ ...state.usage });
          emitStreamUpdate(state, onStreamUpdate);
        }
      }
      return;
    }

    if (eventType === 'content_block_start') {
      const index = typeof payload.index === 'number' ? payload.index : state.activeBlocks.size;
      const block = isRecord(payload.content_block) ? payload.content_block : {};
      const blockType = typeof block.type === 'string' ? block.type : '';
      const now = Date.now();

      if (blockType === 'thinking') {
        const initialThinking = typeof block.thinking === 'string' ? block.thinking : '';
        const initialSignature = typeof block.signature === 'string' ? block.signature : '';
        const stepId = `thinking:${index}`;
        state.activeBlocks.set(index, {
          kind: 'thinking',
          index,
          startedAt: now,
          thinking: initialThinking,
          signature: initialSignature,
          stepId,
          completed: false,
        });
        state.lastThinkingIndex = index;
        state.activityTimeline = upsertTimelineStep(state.activityTimeline, {
          id: stepId,
          kind: 'thinking',
          sequence: nextTimelineSequence(state.activityTimeline),
          status: 'running',
          title: formatThinkingRowTitle('running', now),
          content: initialThinking,
          startedAt: now,
        });
        if (initialThinking) {
          state.reasoningContent += initialThinking;
          callbacks?.onThinkingDelta?.(initialThinking, state.reasoningContent);
        }
        emitStreamUpdate(state, onStreamUpdate);
      } else if (blockType === 'redacted_thinking') {
        const data = typeof block.data === 'string' ? block.data : '';
        const recorded = Boolean(data);
        state.activeBlocks.set(index, {
          kind: 'redacted_thinking',
          index,
          data,
          recorded,
        });
        if (data) {
          state.continuationBlocks.push({
            provider: 'anthropic',
            type: 'redacted_thinking',
            data,
          });
          callbacks?.onContinuationBlocks?.([...state.continuationBlocks]);
        }
      } else if (blockType === 'text') {
        closeOpenThinkingBlocks(state, callbacks, now);
        const initialText = typeof block.text === 'string' ? block.text : '';
        state.activeBlocks.set(index, {
          kind: 'text',
          index,
          text: initialText,
        });
        if (initialText) {
          state.content += initialText;
          callbacks?.onTextDelta?.(initialText, state.content);
        }
        if (Array.isArray(block.citations)) {
          let citationsChanged = false;
          for (const citation of block.citations) {
            if (appendCitation(state, citation)) {
              citationsChanged = true;
            }
          }
          if (citationsChanged) {
            callbacks?.onCitations?.([...state.citations], true);
          }
        }
        emitStreamUpdate(state, onStreamUpdate);
      } else if (blockType === 'server_tool_use') {
        closeOpenThinkingBlocks(state, callbacks, now);
        const toolId = typeof block.id === 'string' ? block.id : `server-tool-${index}`;
        const toolName = typeof block.name === 'string' ? block.name : 'web_search';
        const input = isRecord(block.input) ? { ...block.input } : {};
        state.activeBlocks.set(index, {
          kind: 'server_tool_use',
          index,
          id: toolId,
          name: toolName,
          input,
          partialJson: '',
          startedAt: now,
        });
        const query = typeof input.query === 'string' ? input.query : undefined;
        const title =
          toolName === 'web_search'
            ? formatSearchActivityTitle({ status: 'running', query })
            : `工具: ${toolName}`;

        state.toolActivity = upsertToolActivity(state.toolActivity, {
          id: toolId,
          toolName,
          title,
          ...(Object.keys(input).length ? { arguments: input } : {}),
          status: 'running',
          startedAt: now,
        });
        state.activityTimeline = upsertTimelineStep(state.activityTimeline, {
          id: `tool:${toolId}`,
          kind: 'tool',
          sequence: nextTimelineSequence(state.activityTimeline),
          status: 'running',
          toolName,
          title,
          ...(Object.keys(input).length ? { arguments: input } : {}),
          startedAt: now,
        });
        callbacks?.onToolActivity?.([...state.toolActivity], [...state.activityTimeline]);
        emitStreamUpdate(state, onStreamUpdate);
      } else if (blockType === 'web_search_tool_result') {
        const toolUseId =
          typeof block.tool_use_id === 'string' ? block.tool_use_id : `web-search-${index}`;
        const content = Array.isArray(block.content) ? [...block.content] : [];
        state.activeBlocks.set(index, {
          kind: 'web_search_tool_result',
          index,
          toolUseId,
          content,
        });
      }
      return;
    }

    // 同时支持 content_block_delta 与顶层 signature_delta 兼容包
    if (eventType === 'signature_delta') {
      const targetIndex =
        typeof payload.index === 'number' ? payload.index : state.lastThinkingIndex;
      const sig = typeof payload.signature === 'string' ? payload.signature : '';
      if (targetIndex !== undefined && sig) {
        const active = state.activeBlocks.get(targetIndex);
        if (active?.kind === 'thinking') {
          active.signature += sig;
        }
      }
      return;
    }

    if (eventType === 'content_block_delta') {
      const index = typeof payload.index === 'number' ? payload.index : undefined;
      const delta = isRecord(payload.delta) ? payload.delta : {};
      const deltaType = typeof delta.type === 'string' ? delta.type : '';
      const active = index !== undefined ? state.activeBlocks.get(index) : undefined;
      const now = Date.now();

      if (deltaType === 'thinking_delta') {
        const fragment = typeof delta.thinking === 'string' ? delta.thinking : '';
        if (fragment) {
          if (state.content.length + state.reasoningContent.length + fragment.length > anthropicMessagesLimits.maxStreamOutputCharacters) {
            protocolError('Anthropic 流式输出总字符数超过安全上限。');
          }
          if (active?.kind === 'thinking') {
            active.thinking += fragment;
            state.activityTimeline = upsertTimelineStep(state.activityTimeline, {
              id: active.stepId,
              kind: 'thinking',
              sequence: nextTimelineSequence(state.activityTimeline),
              status: 'running',
              title: formatThinkingRowTitle('running', active.startedAt),
              content: active.thinking,
              startedAt: active.startedAt,
            });
          }
          state.reasoningContent += fragment;
          callbacks?.onThinkingDelta?.(fragment, state.reasoningContent);
          emitStreamUpdate(state, onStreamUpdate);
        }
      } else if (deltaType === 'signature_delta') {
        const sig = typeof delta.signature === 'string' ? delta.signature : '';
        if (sig) {
          if (active?.kind === 'thinking') {
            active.signature += sig;
          } else if (state.lastThinkingIndex !== undefined) {
            const fallbackThinking = state.activeBlocks.get(state.lastThinkingIndex);
            if (fallbackThinking?.kind === 'thinking') {
              fallbackThinking.signature += sig;
            }
          }
        }
      } else if (deltaType === 'text_delta') {
        closeOpenThinkingBlocks(state, callbacks, now);
        const fragment = typeof delta.text === 'string' ? delta.text : '';
        if (fragment) {
          if (state.content.length + state.reasoningContent.length + fragment.length > anthropicMessagesLimits.maxStreamOutputCharacters) {
            protocolError('Anthropic 流式输出总字符数超过安全上限。');
          }
          if (active?.kind === 'text') {
            active.text += fragment;
          }
          state.content += fragment;
          callbacks?.onTextDelta?.(fragment, state.content);
          emitStreamUpdate(state, onStreamUpdate);
        }
      } else if (deltaType === 'input_json_delta') {
        const partial = typeof delta.partial_json === 'string' ? delta.partial_json : '';
        if (active?.kind === 'server_tool_use' && partial) {
          active.partialJson += partial;
        }
      } else if (deltaType === 'citations_delta') {
        if (appendCitation(state, delta.citation)) {
          state.webSearchTriggered = true;
          callbacks?.onCitations?.([...state.citations], true);
        }
      }
      return;
    }

    if (eventType === 'content_block_stop') {
      const index = typeof payload.index === 'number' ? payload.index : undefined;
      const active = index !== undefined ? state.activeBlocks.get(index) : undefined;
      if (!active) {
        return;
      }
      const now = Date.now();

      if (active.kind === 'thinking') {
        if (!active.completed) {
          active.completed = true;
          const elapsed = Math.max(0, now - active.startedAt);
          state.totalThinkingDurationMs += elapsed;
          state.activityTimeline = upsertTimelineStep(state.activityTimeline, {
            id: active.stepId,
            kind: 'thinking',
            sequence: nextTimelineSequence(state.activityTimeline),
            status: 'completed',
            title: formatThinkingRowTitle('completed', active.startedAt, now),
            content: active.thinking,
            startedAt: active.startedAt,
            finishedAt: now,
          });
          callbacks?.onThinkingComplete?.(elapsed);
        }
        if (active.signature) {
          state.continuationBlocks.push({
            provider: 'anthropic',
            type: 'thinking',
            thinking: active.thinking,
            signature: active.signature,
          });
          callbacks?.onContinuationBlocks?.([...state.continuationBlocks]);
        }
        emitStreamUpdate(state, onStreamUpdate);
      } else if (active.kind === 'redacted_thinking') {
        if (!active.recorded && active.data) {
          active.recorded = true;
          state.continuationBlocks.push({
            provider: 'anthropic',
            type: 'redacted_thinking',
            data: active.data,
          });
          callbacks?.onContinuationBlocks?.([...state.continuationBlocks]);
        }
      } else if (active.kind === 'server_tool_use') {
        let finalInput = active.input;
        if (active.partialJson.trim()) {
          try {
            const parsed = JSON.parse(active.partialJson) as unknown;
            if (isRecord(parsed)) {
              finalInput = { ...active.input, ...parsed };
            }
          } catch {
            // 保留已解析字段，防止局部异常 JSON 破坏整轮输出
          }
        }
        active.input = finalInput;
        state.continuationBlocks.push({
          provider: 'anthropic',
          type: 'server_tool_use',
          id: active.id,
          name: active.name,
          input: finalInput,
        });
        const query = typeof finalInput.query === 'string' ? finalInput.query : undefined;
        const title =
          active.name === 'web_search'
            ? formatSearchActivityTitle({ status: 'running', query })
            : `工具: ${active.name}`;
        state.toolActivity = upsertToolActivity(state.toolActivity, {
          id: active.id,
          toolName: active.name,
          title,
          arguments: finalInput,
          status: 'running',
          startedAt: active.startedAt,
        });
        state.activityTimeline = upsertTimelineStep(state.activityTimeline, {
          id: `tool:${active.id}`,
          kind: 'tool',
          sequence: nextTimelineSequence(state.activityTimeline),
          status: 'running',
          toolName: active.name,
          title,
          arguments: finalInput,
          startedAt: active.startedAt,
        });
        callbacks?.onContinuationBlocks?.([...state.continuationBlocks]);
        callbacks?.onToolActivity?.([...state.toolActivity], [...state.activityTimeline]);
        emitStreamUpdate(state, onStreamUpdate);
      } else if (active.kind === 'web_search_tool_result') {
        state.continuationBlocks.push({
          provider: 'anthropic',
          type: 'web_search_tool_result',
          toolUseId: active.toolUseId,
          content: active.content,
        });
        callbacks?.onContinuationBlocks?.([...state.continuationBlocks]);
        applySearchToolResult(active.toolUseId, active.content);
        emitStreamUpdate(state, onStreamUpdate);
      }
      return;
    }

    if (eventType === 'message_delta') {
      if (isRecord(payload.delta) && typeof payload.delta.stop_reason === 'string') {
        state.stopReason = payload.delta.stop_reason;
      }
      const usageRes = extractUsageFromAnthropicRecord(state.usage, payload.usage);
      if (usageRes.changed) {
        state.usage = usageRes.usage;
        state.hasUsage = true;
        callbacks?.onUsage?.({ ...state.usage });
        emitStreamUpdate(state, onStreamUpdate);
      }
      return;
    }

    if (eventType === 'message_stop') {
      state.stopped = true;
      closeOpenThinkingBlocks(state, callbacks);
      // 兜底：若搜索已触发返回结果但正文未下发 citations_delta，从结果条目补充安全链接
      if (state.webSearchTriggered && state.citations.length === 0) {
        for (const block of state.continuationBlocks) {
          if (block.provider === 'anthropic' && block.type === 'web_search_tool_result') {
            for (const entry of block.content) {
              if (isRecord(entry) && entry.type === 'web_search_result') {
                appendCitation(state, entry);
              }
            }
          }
        }
        if (state.citations.length > 0) {
          callbacks?.onCitations?.([...state.citations], true);
        }
      }
    }
  };

  const processBlock = (rawBlock: string) => {
    if (!rawBlock.trim()) {
      return;
    }
    let eventName: string | undefined;
    const dataLines: string[] = [];

    for (const rawLine of rawBlock.split('\n')) {
      const line = rawLine.trimEnd();
      if (!line || line.startsWith(':')) {
        continue;
      }
      if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trimStart());
      }
    }

    if (dataLines.length === 0) {
      return;
    }
    const rawJson = dataLines.join('\n').trim();
    if (!rawJson) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch (error) {
      const parseErr = new AnthropicProtocolError(
        `Anthropic 流式事件 JSON 解析失败：${sanitizeErrorMessage(error instanceof Error ? error.message : String(error), options.apiKey)}`
      );
      callbacks?.onError?.(parseErr);
      throw parseErr;
    }

    if (!isRecord(parsed)) {
      return;
    }
    handleParsedEvent(eventName, parsed);
  };

  const drainCompleteBlocks = () => {
    let separatorIndex = buffer.indexOf('\n\n');
    while (separatorIndex >= 0) {
      const block = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      processBlock(block);
      separatorIndex = buffer.indexOf('\n\n');
    }
  };

  const flushPendingCr = () => {
    if (!pendingTrailingCr) {
      return;
    }
    pendingTrailingCr = false;
    buffer += '\n';
  };

  const consumeText = (chunkText: string) => {
    if (!chunkText) {
      return;
    }

    // 保留跨 chunk 边界的末尾 \r，防止将 \r + \n 误拼接为 \n\n 破坏 SSE 事件边界
    let chunk = chunkText;
    if (pendingTrailingCr) {
      pendingTrailingCr = false;
      if (!chunk.startsWith('\n')) {
        buffer += '\n';
      }
    }

    if (chunk.endsWith('\r')) {
      pendingTrailingCr = true;
      chunk = chunk.slice(0, -1);
    }

    if (chunk) {
      buffer += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    }

    if (new TextEncoder().encode(buffer).byteLength > anthropicMessagesLimits.maxStreamEventBytes) {
      const sizeErr = new AnthropicProtocolError('Anthropic SSE 缓冲区超过安全上限，已停止接收。');
      callbacks?.onError?.(sizeErr);
      throw sizeErr;
    }

    drainCompleteBlocks();
  };

  const finish = (): ChatCompletionResult => {
    flushPendingCr();
    drainCompleteBlocks();
    if (buffer.trim() && !state.stopped) {
      processBlock(buffer);
      buffer = '';
    }
    if (!state.stopped) {
      const eofErr = new AnthropicProtocolError('Anthropic 流式响应在收到 message_stop 前意外中断。');
      callbacks?.onError?.(eofErr);
      throw eofErr;
    }
    const result = buildResultFromSseState(state);
    callbacks?.onDone?.(result);
    return result;
  };

  return {
    processBlock,
    consumeText,
    finish,
    isStopped: () => state.stopped,
  };
}

/**
 * 解析 Anthropic 非流式 JSON 响应（`stream: false` 或服务端降级返回 `application/json`）。
 */
export function parseAnthropicMessagesResponse(
  payload: unknown,
  options: {
    callbacks?: StreamChatCallbacks;
    onStreamUpdate?: (update: AnthropicStreamUpdate) => void;
    apiKey?: string;
  } = {}
): ChatCompletionResult {
  let parsed: unknown = payload;
  if (typeof payload === 'string') {
    try {
      parsed = JSON.parse(payload) as unknown;
    } catch (error) {
      const safeDetail = sanitizeErrorMessage(
        error instanceof Error ? error.message : String(error),
        options.apiKey
      );
      const err = new AnthropicProtocolError(`Anthropic 响应 JSON 解析失败：${safeDetail}`);
      options.callbacks?.onError?.(err);
      throw err;
    }
  }
  if (!isRecord(parsed)) {
    return protocolError('Anthropic 响应内容必须是 JSON 对象。');
  }
  if (parsed.type === 'error' && isRecord(parsed.error)) {
    const errType = typeof parsed.error.type === 'string' ? parsed.error.type : undefined;
    const msg =
      typeof parsed.error.message === 'string'
        ? parsed.error.message
        : 'Anthropic 返回了错误响应。';
    const err = new AnthropicProtocolError(
      `Anthropic 请求错误${errType ? `（${errType}）` : ''}：${sanitizeErrorMessage(msg, options.apiKey)}`,
      { errorType: errType }
    );
    options.callbacks?.onError?.(err);
    throw err;
  }

  const contentBlocks = Array.isArray(parsed.content) ? parsed.content : [];
  let content = '';
  let reasoningContent = '';
  const continuationBlocks: ProviderContinuationBlock[] = [];
  const citations: WebCitation[] = [];
  const seenCitationUrls = new Set<string>();
  let toolActivity: ToolActivityItem[] = [];
  let activityTimeline: ActivityTimelineStep[] = [];
  let webSearchTriggered = false;

  for (let idx = 0; idx < contentBlocks.length; idx += 1) {
    const block = contentBlocks[idx];
    if (!isRecord(block)) continue;
    const blockType = typeof block.type === 'string' ? block.type : '';

    if (blockType === 'thinking') {
      const thinkingText = typeof block.thinking === 'string' ? block.thinking : '';
      const signature = typeof block.signature === 'string' ? block.signature : '';
      if (thinkingText) {
        reasoningContent += thinkingText;
        options.callbacks?.onThinkingDelta?.(thinkingText, reasoningContent);
      }
      if (signature) {
        continuationBlocks.push({
          provider: 'anthropic',
          type: 'thinking',
          thinking: thinkingText,
          signature,
        });
      }
      activityTimeline = upsertTimelineStep(activityTimeline, {
        id: `thinking:${idx}`,
        kind: 'thinking',
        sequence: nextTimelineSequence(activityTimeline),
        status: 'completed',
        title: '深度思考',
        content: thinkingText,
      });
    } else if (blockType === 'redacted_thinking') {
      const data = typeof block.data === 'string' ? block.data : '';
      if (data) {
        continuationBlocks.push({
          provider: 'anthropic',
          type: 'redacted_thinking',
          data,
        });
      }
    } else if (blockType === 'server_tool_use') {
      const toolId = typeof block.id === 'string' ? block.id : `server-tool-${idx}`;
      const toolName = typeof block.name === 'string' ? block.name : 'web_search';
      const input = isRecord(block.input) ? { ...block.input } : {};
      continuationBlocks.push({
        provider: 'anthropic',
        type: 'server_tool_use',
        id: toolId,
        name: toolName,
        input,
      });
      const query = typeof input.query === 'string' ? input.query : undefined;
      toolActivity = upsertToolActivity(toolActivity, {
        id: toolId,
        toolName,
        title: formatSearchActivityTitle({ status: 'running', query }),
        arguments: input,
        status: 'running',
      });
    } else if (blockType === 'web_search_tool_result') {
      const toolUseId =
        typeof block.tool_use_id === 'string' ? block.tool_use_id : `web-search-${idx}`;
      const rawContent = Array.isArray(block.content) ? [...block.content] : [];
      webSearchTriggered = true;
      continuationBlocks.push({
        provider: 'anthropic',
        type: 'web_search_tool_result',
        toolUseId,
        content: rawContent,
      });
      const related = toolActivity.find((item) => item.id === toolUseId);
      const query =
        typeof related?.arguments?.query === 'string' ? related.arguments.query : undefined;
      const parsedResult = parseSearchToolResultsFromContent(rawContent, query);
      const status: ToolActivityItem['status'] = parsedResult.errorCode ? 'failed' : 'completed';
      const title = formatSearchActivityTitle({
        status,
        query,
        resultCount: parsedResult.errorCode ? undefined : parsedResult.items.length,
      });
      const summary = parsedResult.errorCode
        ? `搜索失败：${parsedResult.errorCode}`
        : `返回 ${parsedResult.items.length} 条结果`;
      const detail = parsedResult.errorCode
        ? JSON.stringify({ error: parsedResult.errorCode })
        : JSON.stringify({ ...(query ? { query } : {}), items: parsedResult.items });

      toolActivity = upsertToolActivity(toolActivity, {
        id: toolUseId,
        toolName: related?.toolName ?? 'web_search',
        title,
        ...(related?.arguments ? { arguments: related.arguments } : {}),
        status,
        summary,
        content: detail,
      });
      activityTimeline = upsertTimelineStep(activityTimeline, {
        id: `tool:${toolUseId}`,
        kind: 'tool',
        sequence: nextTimelineSequence(activityTimeline),
        status,
        toolName: related?.toolName ?? 'web_search',
        title,
        ...(related?.arguments ? { arguments: related.arguments } : {}),
        summary,
        content: detail,
      });
    } else if (blockType === 'text') {
      const text = typeof block.text === 'string' ? block.text : '';
      if (text) {
        content += text;
        options.callbacks?.onTextDelta?.(text, content);
      }
      if (Array.isArray(block.citations)) {
        for (const item of block.citations) {
          if (!isRecord(item)) continue;
          const itemType = typeof item.type === 'string' ? item.type : '';
          if (itemType && itemType !== 'web_search_result_location') continue;
          const safeUrl = validatedHttpsPublicUrl(item.url);
          if (!safeUrl || seenCitationUrls.has(safeUrl)) continue;
          seenCitationUrls.add(safeUrl);
          citations.push({
            url: safeUrl,
            ...(typeof item.title === 'string' && item.title.trim()
              ? { title: item.title.trim() }
              : {}),
            ...(typeof item.cited_text === 'string' && item.cited_text.trim()
              ? { text: item.cited_text.trim() }
              : {}),
            index: citations.length + 1,
          });
        }
      }
    }
  }

  if (webSearchTriggered && citations.length === 0) {
    for (const block of continuationBlocks) {
      if (block.provider === 'anthropic' && block.type === 'web_search_tool_result') {
        for (const entry of block.content) {
          if (!isRecord(entry) || entry.type !== 'web_search_result') continue;
          const safeUrl = validatedHttpsPublicUrl(entry.url);
          if (!safeUrl || seenCitationUrls.has(safeUrl)) continue;
          seenCitationUrls.add(safeUrl);
          citations.push({
            url: safeUrl,
            ...(typeof entry.title === 'string' && entry.title.trim()
              ? { title: entry.title.trim() }
              : {}),
            index: citations.length + 1,
          });
        }
      }
    }
  }

  const usageResult = extractUsageFromAnthropicRecord({}, parsed.usage);
  const usage = usageResult.changed ? usageResult.usage : undefined;

  if (reasoningContent) {
    options.callbacks?.onThinkingComplete?.(0);
  }
  if (continuationBlocks.length > 0) {
    options.callbacks?.onContinuationBlocks?.([...continuationBlocks]);
  }
  if (toolActivity.length > 0) {
    options.callbacks?.onToolActivity?.([...toolActivity], [...activityTimeline]);
  }
  if (citations.length > 0 || webSearchTriggered) {
    options.callbacks?.onCitations?.([...citations], webSearchTriggered);
  }
  if (usage) {
    options.callbacks?.onUsage?.({ ...usage });
  }

  options.onStreamUpdate?.({
    content,
    ...(reasoningContent ? { reasoningContent } : {}),
    ...(usage ? { usage } : {}),
    ...(toolActivity.length ? { toolActivity } : {}),
    ...(activityTimeline.length ? { activityTimeline } : {}),
    raw: parsed,
  });

  const hasOutput =
    Boolean(content) || Boolean(reasoningContent) || continuationBlocks.length > 0;
  const result: ChatCompletionResult = {
    content: content || (hasOutput ? '' : emptyContentPlaceholder),
    ...(reasoningContent ? { reasoningContent } : {}),
    ...(reasoningContent ? { thinkingDurationMs: 0 } : {}),
    ...(continuationBlocks.length ? { providerContinuations: continuationBlocks } : {}),
    ...(usage ? { usage } : {}),
    ...(citations.length ? { citations } : {}),
    ...(webSearchTriggered ? { webSearchTriggered: true } : {}),
    ...(toolActivity.length ? { toolActivity } : {}),
    ...(activityTimeline.length ? { activityTimeline } : {}),
    raw: parsed,
  };

  options.callbacks?.onDone?.(result);
  return result;
}

function resolveAnthropicAbortError(signal?: AbortSignal): Error {
  if (
    signal?.reason instanceof Error &&
    (signal.reason.name === 'AbortError' || signal.reason.name === 'TimeoutError')
  ) {
    return signal.reason;
  }
  return createAbortError();
}

async function readLimitedTextWithMaxBytes(
  response: Response,
  maxBytes: number,
  label: string,
  signal?: AbortSignal
): Promise<string> {
  if (signal?.aborted) {
    void response.body?.cancel().catch(() => undefined);
    throw resolveAnthropicAbortError(signal);
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    protocolError(`${label}响应体过大（上限 ${Math.round(maxBytes / 1024 / 1024)} MB）。`);
  }
  const reader = response.body?.getReader();
  let onAbort: (() => void) | undefined;
  const abortPromise = signal
    ? new Promise<never>((_, reject) => {
        onAbort = () => {
          reject(resolveAnthropicAbortError(signal));
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
  abortPromise?.catch(() => undefined);

  if (!reader) {
    try {
      const body = abortPromise
        ? await Promise.race([response.text(), abortPromise])
        : await response.text();
      if (signal?.aborted) {
        throw resolveAnthropicAbortError(signal);
      }
      if (new TextEncoder().encode(body).byteLength > maxBytes) {
        protocolError(`${label}响应体过大（上限 ${Math.round(maxBytes / 1024 / 1024)} MB）。`);
      }
      return body;
    } finally {
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
    }
  }

  const decoder = new TextDecoder();
  let totalBytes = 0;
  let body = '';
  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => undefined);
        throw resolveAnthropicAbortError(signal);
      }
      const { value, done } = abortPromise
        ? await Promise.race([reader.read(), abortPromise])
        : await reader.read();
      if (signal?.aborted) {
        await reader.cancel().catch(() => undefined);
        throw resolveAnthropicAbortError(signal);
      }
      if (done) break;
      totalBytes += value?.byteLength ?? 0;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        protocolError(`${label}响应体过大（上限 ${Math.round(maxBytes / 1024 / 1024)} MB）。`);
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    if (signal?.aborted) {
      throw resolveAnthropicAbortError(signal);
    }
    return body;
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

/**
 * Anthropic 专用安全传输函数：
 * 复用 `isWebDevelopmentProxyAllowed` 做 Web 生产态 fail-closed 拦截，
 * 支持长程推理可配置 `timeoutMs`（默认 600_000 ms）并在结束后彻底释放定时器与监听。
 */
async function anthropicFetch(
  url: string,
  init: {
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
    timeoutMs: number;
    fetchImpl?: typeof fetch;
  },
  consumeResponse: (response: Response, requestSignal: AbortSignal) => Promise<ChatCompletionResult>,
  apiKey?: string
): Promise<ChatCompletionResult> {
  const controller = new AbortController();
  let timedOut = false;

  if (init.signal?.aborted) {
    throw createAbortError();
  }
  const onCallerAbort = () => {
    controller.abort(init.signal?.reason ?? createAbortError());
  };
  init.signal?.addEventListener('abort', onCallerAbort, { once: true });

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    controller.abort(createAbortError('Anthropic 请求超时。'));
  }, init.timeoutMs);

  const performFetch = init.fetchImpl ?? fetch;

  try {
    let response: Response;
    if (Platform.OS !== 'web') {
      response = await performFetch(url, {
        method: 'POST',
        headers: init.headers,
        body: init.body,
        signal: controller.signal,
        redirect: 'error',
      });
    } else {
      if (!isWebDevelopmentProxyAllowed()) {
        throw new AnthropicProtocolError(
          '正式 Web 构建不会发送 API Key 或模型请求。仅可在本机通过 npm run web 显式启动受限调试代理。'
        );
      }
      try {
        response = await performFetch(webDevProxyUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url,
            method: 'POST',
            headers: init.headers,
            body: init.body,
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) {
          throw error;
        }
        throw new AnthropicProtocolError(
          'Web 调试代理未启动或不可访问。请用 npm run web 启动应用，或确认 127.0.0.1:8787 可访问。'
        );
      }
    }

    return await consumeResponse(response, controller.signal);
  } catch (error) {
    if (timedOut) {
      const timeoutError = new AnthropicProtocolError(
        `Anthropic 请求超过 ${Math.round(init.timeoutMs / 1000)} 秒，已自动停止。`
      );
      timeoutError.name = 'TimeoutError';
      throw timeoutError;
    }
    if (init.signal?.aborted || isAbortError(error)) {
      throw createAbortError();
    }
    if (error instanceof AnthropicProtocolError) {
      throw error;
    }
    const rawMsg = error instanceof Error ? error.message : String(error);
    throw new AnthropicProtocolError(sanitizeErrorMessage(rawMsg, apiKey));
  } finally {
    clearTimeout(timeoutHandle);
    init.signal?.removeEventListener('abort', onCallerAbort);
  }
}

/**
 * 发送 Anthropic `/v1/messages` 对话请求，支持 SSE 流式状态机与非流式 JSON 降级，
 * 同时驱动 `StreamChatCallbacks` 与 `onStreamUpdate`。
 */
export async function sendAnthropicMessagesChat(
  args: AnthropicMessagesChatArgs
): Promise<ChatCompletionResult> {
  let errorNotified = false;
  const notifyErrorOnce = (error: unknown) => {
    if (errorNotified || isAbortError(error)) {
      return;
    }
    errorNotified = true;
    const errObj = error instanceof Error ? error : new Error(String(error));
    args.callbacks?.onError?.(errObj);
  };

  try {
    const prepared = await buildAnthropicMessagesRequest(args);
    const timeoutMs =
      typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
        ? args.timeoutMs
        : anthropicMessagesLimits.defaultTimeoutMs;

    const wrappedCallbacks: StreamChatCallbacks = {
      ...args.callbacks,
      onError: (err) => {
        errorNotified = true;
        args.callbacks?.onError?.(err);
      },
    };

    return await anthropicFetch(
      prepared.url,
      {
        headers: prepared.headers,
        body: JSON.stringify(prepared.body),
        signal: args.signal,
        timeoutMs,
        fetchImpl: args.fetchImpl,
      },
      async (response, requestSignal) => {
        if (!response.ok) {
          const errorBody = await readLimitedTextWithMaxBytes(
            response,
            anthropicMessagesLimits.maxErrorResponseBytes,
            'Anthropic 错误',
            requestSignal
          );
          const httpErr = buildHttpStatusError(
            response.status,
            errorBody,
            response.headers,
            args.provider.apiKey
          );
          notifyErrorOnce(httpErr);
          throw httpErr;
        }

        const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
        if (prepared.body.stream === false || contentType.includes('application/json')) {
          const jsonText = await readLimitedTextWithMaxBytes(
            response,
            anthropicMessagesLimits.maxJsonResponseBytes,
            'Anthropic 对话',
            requestSignal
          );
          if (looksLikeHtmlResponse(jsonText, contentType)) {
            protocolError(`Anthropic 接口返回了 HTML 页面而非 JSON，请检查 Base URL（${prepared.url}）。`);
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(jsonText);
          } catch (error) {
            protocolError(
              `Anthropic 响应 JSON 解析失败：${sanitizeErrorMessage(error instanceof Error ? error.message : String(error), args.provider.apiKey)}`
            );
          }
          return parseAnthropicMessagesResponse(parsed, {
            callbacks: wrappedCallbacks,
            onStreamUpdate: args.onStreamUpdate,
            apiKey: args.provider.apiKey,
          });
        }

        const processor = createAnthropicSseProcessor(
          wrappedCallbacks,
          args.onStreamUpdate,
          { apiKey: args.provider.apiKey }
        );
        if (requestSignal.aborted) {
          void response.body?.cancel().catch(() => undefined);
          throw resolveAnthropicAbortError(requestSignal);
        }
        const reader = response.body?.getReader();
        let onAbort: (() => void) | undefined;
        const abortPromise = new Promise<never>((_, reject) => {
          onAbort = () => {
            reject(resolveAnthropicAbortError(requestSignal));
            if (reader) {
              void reader.cancel().catch(() => undefined);
            } else {
              void response.body?.cancel().catch(() => undefined);
            }
          };
          if (requestSignal.aborted) {
            onAbort();
          } else {
            requestSignal.addEventListener('abort', onAbort, { once: true });
          }
        });
        abortPromise.catch(() => undefined);

        if (!reader) {
          try {
            const rawText = await Promise.race([response.text(), abortPromise]);
            if (requestSignal.aborted) {
              throw resolveAnthropicAbortError(requestSignal);
            }
            processor.consumeText(rawText);
            return processor.finish();
          } finally {
            if (onAbort) {
              requestSignal.removeEventListener('abort', onAbort);
            }
          }
        }

        const decoder = new TextDecoder();
        try {
          while (!processor.isStopped()) {
            if (requestSignal.aborted) {
              await reader.cancel().catch(() => undefined);
              throw resolveAnthropicAbortError(requestSignal);
            }
            const { value, done } = await Promise.race([reader.read(), abortPromise]);
            if (requestSignal.aborted) {
              await reader.cancel().catch(() => undefined);
              throw resolveAnthropicAbortError(requestSignal);
            }
            if (done) {
              break;
            }
            processor.consumeText(decoder.decode(value, { stream: true }));
          }
          if (requestSignal.aborted) {
            throw resolveAnthropicAbortError(requestSignal);
          }
          if (processor.isStopped()) {
            await reader.cancel().catch(() => undefined);
          }
          processor.consumeText(decoder.decode());
        } finally {
          if (onAbort) {
            requestSignal.removeEventListener('abort', onAbort);
          }
          try {
            reader.releaseLock();
          } catch {
            // 流已释放或取消时忽略
          }
        }

        return processor.finish();
      },
      args.provider.apiKey
    );
  } catch (error) {
    notifyErrorOnce(error);
    throw error;
  }
}

/**
 * 面向 `ProviderAdapterRegistry` 的 Anthropic Messages 原生适配器实现。
 */
export class AnthropicMessagesProviderAdapter implements ProviderAdapter {
  run(request: ChatProviderRequest): Promise<ChatCompletionResult> {
    return sendAnthropicMessagesChat(request);
  }

  async queryTask(_request: GenerationTaskProviderRequest): Promise<ChatCompletionResult> {
    throw new AnthropicProtocolError('Anthropic 原生协议不支持异步视频生成轮询任务。');
  }
}

/** 创建 Anthropic Messages 原生 `ProviderAdapter` 实例。 */
export function createAnthropicProviderAdapter(): ProviderAdapter {
  return new AnthropicMessagesProviderAdapter();
}
