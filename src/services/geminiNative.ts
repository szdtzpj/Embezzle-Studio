import { Platform } from 'react-native';

import type {
  ActivityTimelineStep,
  ChatCompletionResult,
  ChatTokenUsage,
  ImageGenerationOptions,
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
import { materializeAttachment, persistAttachment } from './mediaStorage';
import {
  completeOpenThinkingSteps,
  formatSearchActivityTitle,
  formatThinkingRowTitle,
  nextTimelineSequence,
  upsertTimelineStep,
  upsertToolActivity,
} from './messageActivity';
import { createModelInfoFromId, inferModelTask } from './modelCapabilities';
import {
  inspectProviderEndpoint,
  isExactOfficialGeminiProvider,
  resolveProviderAuthHeaders,
} from './providerSetup';
import { isBlockedPublicHost } from './ssrfGuard';

const webDevProxyUrl = 'http://127.0.0.1:8787/proxy';
const emptyContentPlaceholder = '模型返回了空内容。';
const supportedImageMimeTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);
const blockedSafetyFinishReasons = new Set([
  'SAFETY',
  'RECITATION',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'IMAGE_SAFETY',
]);

/** Gemini 原生协议资源与边界限制常量。 */
export const geminiNativeLimits = Object.freeze({
  maxMessages: 1_000,
  maxInputTextCharacters: 2_000_000,
  maxInlineMediaBytes: 20 * 1024 * 1024,
  maxJsonResponseBytes: 30 * 1024 * 1024,
  maxErrorResponseBytes: 64 * 1024,
  maxStreamEventBytes: 2 * 1024 * 1024,
  maxStreamOutputCharacters: 2_000_000,
  maxAllowedOutputTokens: 131_072,
  defaultTimeoutMs: 600_000,
});

/** Gemini 原生协议专属异常。 */
export class GeminiNativeProtocolError extends Error {
  status?: number;
  errorStatus?: string;
  finishReason?: string;

  constructor(
    message: string,
    options: { status?: number; errorStatus?: string; finishReason?: string } = {}
  ) {
    super(message);
    this.name = 'GeminiNativeProtocolError';
    this.status = options.status;
    this.errorStatus = options.errorStatus;
    this.finishReason = options.finishReason;
  }
}

/** 与现有 ChatRequestExecution 对齐的流式增量快照结构。 */
export interface GeminiStreamUpdate {
  content: string;
  reasoningContent?: string;
  usage?: ChatTokenUsage;
  toolActivity?: ToolActivityItem[];
  activityTimeline?: ActivityTimelineStep[];
  raw?: unknown;
}

/** Gemini 原生请求体数据结构。 */
export interface GeminiNativeRequestBody {
  contents: Array<{
    role: 'user' | 'model';
    parts: Array<Record<string, unknown>>;
  }>;
  systemInstruction?: {
    parts: Array<{ text: string }>;
  };
  generationConfig?: Record<string, unknown>;
  tools?: Array<Record<string, unknown>>;
}

/** 调用 Gemini 原生接口的完整参数（兼容 ChatProviderRequest）。 */
export interface GeminiNativeRequestOptions
  extends Omit<ChatProviderRequest, 'reasoningEffort'> {
  reasoningEffort?: ReasoningEffort;
  attachments?: MediaAttachment[];
  imageOptions?: ImageGenerationOptions;
  stream?: boolean;
  callbacks?: StreamChatCallbacks;
  onStreamUpdate?: (update: GeminiStreamUpdate) => void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface GeminiStreamState {
  modelId: string;
  content: string;
  reasoningContent: string;
  thinkingStartedAt?: number;
  thinkingClosed: boolean;
  thinkingDurationMs: number;
  thinkingStepId: string;
  usage?: ChatTokenUsage;
  continuationBlocks: ProviderContinuationBlock[];
  citations: WebCitation[];
  citationIndexByUrl: Map<string, number>;
  searchQueries: string[];
  toolActivity: ToolActivityItem[];
  activityTimeline: ActivityTimelineStep[];
  attachments: MediaAttachment[];
  webSearchTriggered: boolean;
  finishReason?: string;
  blockReason?: string;
  sawValidChunk: boolean;
  rawChunks: unknown[];
  lastPayload: unknown;
}

function createAbortError(message = '请求已取消。'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

/**
 * 判断当前 Web 运行时是否显式开启了受控的本机开发调试代理（生产 Web 构建 fail-closed）。
 */
function isWebDevelopmentProxyAllowed(): boolean {
  const development = typeof __DEV__ !== 'undefined' && __DEV__ === true;
  const explicitlyEnabled = process.env.EXPO_PUBLIC_ENABLE_WEB_DEV_PROXY === '1';
  const location =
    typeof window !== 'undefined'
      ? { protocol: window.location.protocol, hostname: window.location.hostname }
      : undefined;
  return Boolean(
    Platform.OS === 'web' &&
    development &&
    explicitlyEnabled &&
    location &&
    (location.protocol === 'http:' || location.protocol === 'https:') &&
    isLoopbackHostname(location.hostname)
  );
}

function protocolError(
  message: string,
  options: { status?: number; errorStatus?: string; finishReason?: string } = {}
): never {
  throw new GeminiNativeProtocolError(message, options);
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
  if (!trimmedKey) {
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

function setHeaderCaseInsensitive(headers: Record<string, string>, key: string, value: string): void {
  const lowerTarget = key.toLowerCase();
  for (const existingKey of Object.keys(headers)) {
    if (existingKey.toLowerCase() === lowerTarget && existingKey !== key) {
      delete headers[existingKey];
    }
  }
  headers[key] = value;
}

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
 * 清洗 Gemini 模型 ID（移除 `models/` 前缀及空白），拦截非法路径字符。
 */
export function cleanGeminiModelId(modelId: string): string {
  const cleaned = modelId.trim().replace(/^models\//i, '').trim();
  if (!cleaned) {
    return protocolError('Gemini 模型 ID 不能为空。');
  }
  if (/[?#\\]/.test(cleaned) || cleaned.includes('..') || cleaned.includes('/')) {
    return protocolError(`Gemini 模型 ID「${cleaned}」包含非法路径字符。`);
  }
  return cleaned;
}

/**
 * 构造 Gemini 原生端点 URL（`.../v1beta/models/{model}:generateContent` 或 `:streamGenerateContent?alt=sse`）。
 * 严禁在 URL 中拼接 `?key=` 查询参数，鉴权统一通过请求头传递。
 */
export function getGeminiNativeEndpoint(
  provider: Pick<ProviderProfile, 'kind' | 'baseUrl'>,
  modelId: string,
  stream = true
): string {
  const rawBaseUrl = provider.baseUrl.trim();
  if (!rawBaseUrl) {
    return protocolError('请先填写 Gemini 服务商的 Base URL。');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    return protocolError('Gemini Base URL 不是有效网址，请填写完整的 https:// 地址。');
  }

  if (parsed.username || parsed.password) {
    return protocolError('Gemini Base URL 不能包含用户名或密码。');
  }
  if (parsed.search || parsed.hash) {
    return protocolError('Gemini Base URL 不能包含查询参数或片段。');
  }
  if (
    parsed.protocol !== 'https:' &&
    !(parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname))
  ) {
    return protocolError('Gemini Base URL 必须使用 HTTPS；只有本机回环调试地址可以使用 HTTP。');
  }

  const inspection = inspectProviderEndpoint(rawBaseUrl, { kind: provider.kind });
  let base: string;

  if (inspection.family === 'gemini-official') {
    if (parsed.port) {
      return protocolError('官方服务商地址不能使用自定义端口。');
    }
    if (!inspection.normalizedBaseUrl) {
      return protocolError('Gemini 官方 Base URL 路径不受支持。');
    }
    base = inspection.normalizedBaseUrl;
  } else {
    // 自定义反代或中转路径规范化：保留反代前缀与显式版本段，缺省补全 /v1beta
    let path = parsed.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
    path = path
      .replace(/:(?:streamGenerateContent|generateContent)$/i, '')
      .replace(/\/openai(?:\/(?:chat\/completions|models))?$/i, '')
      .replace(/\/models(?:\/[^/]+)?$/i, '')
      .replace(/\/+$/, '');
    if (!path || path === '/') {
      path = '/v1beta';
    }
    base = `${parsed.origin}${path}`;
  }

  const cleanModel = cleanGeminiModelId(modelId);
  const encodedModel = encodeURIComponent(cleanModel);
  return stream
    ? `${base}/models/${encodedModel}:streamGenerateContent?alt=sse`
    : `${base}/models/${encodedModel}:generateContent`;
}

/**
 * 构造 Gemini 原生请求头：走 `resolveProviderAuthHeaders`（默认 `x-goog-api-key` + `customHeaders`）
 * 并附加 `Content-Type` / `Accept`。
 */
export function buildGeminiNativeHeaders(
  provider: Pick<ProviderProfile, 'kind' | 'baseUrl' | 'apiKey' | 'authHeaderMode' | 'customHeaders'>,
  options: { stream?: boolean } = {}
): Record<string, string> {
  const headers = resolveProviderAuthHeaders(provider);
  setHeaderCaseInsensitive(headers, 'Content-Type', 'application/json');
  setHeaderCaseInsensitive(
    headers,
    'Accept',
    options.stream === false ? 'application/json' : 'text/event-stream, application/json'
  );
  return headers;
}

function assertGeminiAuthReady(
  provider: Pick<ProviderProfile, 'kind' | 'baseUrl' | 'apiKey' | 'authHeaderMode'>,
  headers: Record<string, string>
): void {
  if (provider.authHeaderMode === 'custom') {
    return;
  }
  const hasAuth =
    hasHeaderCaseInsensitive(headers, 'x-goog-api-key') ||
    hasHeaderCaseInsensitive(headers, 'authorization') ||
    hasHeaderCaseInsensitive(headers, 'x-api-key');

  if (!hasAuth && isExactOfficialGeminiProvider(provider)) {
    protocolError('请先配置 Gemini API Key。');
  }
}

function normalizeMimeType(mimeType: string | undefined): string {
  const raw = (mimeType || 'application/octet-stream').split(';', 1)[0].trim().toLowerCase();
  return raw === 'image/jpg' ? 'image/jpeg' : raw;
}

function normalizeImageOutputMimeType(mimeType: string | undefined): string {
  const normalized = normalizeMimeType(mimeType);
  if (supportedImageMimeTypes.has(normalized)) {
    return normalized;
  }
  return 'image/png';
}

function imageExtensionForMime(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/gif') return 'gif';
  return 'png';
}

function stripAndValidateBase64(
  rawData: string,
  attachmentName: string,
  maxBytes = geminiNativeLimits.maxInlineMediaBytes
): { mimeTypeFromUri?: string; data: string } {
  const trimmed = rawData.trim();
  const dataUrlMatch = trimmed.match(/^data:([^;,]+);base64,([\s\S]*)$/i);
  const mimeTypeFromUri = dataUrlMatch?.[1]?.trim().toLowerCase();
  const payload = (dataUrlMatch?.[2] ?? trimmed).replace(/\s+/g, '');

  if (!payload || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || payload.length % 4 === 1) {
    return protocolError(`附件「${attachmentName}」的 Base64 数据无效。`);
  }
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  const bytes = Math.floor((payload.length * 3) / 4) - padding;
  if (bytes > maxBytes) {
    return protocolError(
      `附件「${attachmentName}」超过 Gemini 内联媒体大小限制（上限 ${Math.round(maxBytes / 1024 / 1024)} MB）。`
    );
  }
  return {
    ...(mimeTypeFromUri ? { mimeTypeFromUri } : {}),
    data: payload,
  };
}

async function attachmentToGeminiUserPart(
  attachment: MediaAttachment
): Promise<Record<string, unknown>> {
  const name = attachment.name || attachment.id || '未命名附件';
  const materialized = await materializeAttachment(attachment, {
    maxSourceBytes: geminiNativeLimits.maxInlineMediaBytes,
  });

  const inline = materialized.base64?.trim();
  if (inline) {
    const parsed = stripAndValidateBase64(inline, name);
    const mimeType = normalizeMimeType(
      parsed.mimeTypeFromUri ??
        materialized.mimeType ??
        (materialized.kind === 'image' ? 'image/jpeg' : 'application/octet-stream')
    );
    return {
      inlineData: {
        mimeType,
        data: parsed.data,
      },
    };
  }

  const uri = materialized.uri?.trim();
  if (!uri) {
    return protocolError(`附件「${name}」缺少可用的 Base64 数据或文件地址。`);
  }
  if (uri.toLowerCase().startsWith('data:')) {
    const parsed = stripAndValidateBase64(uri, name);
    const mimeType = normalizeMimeType(
      parsed.mimeTypeFromUri ??
        materialized.mimeType ??
        (materialized.kind === 'image' ? 'image/jpeg' : 'application/octet-stream')
    );
    return {
      inlineData: {
        mimeType,
        data: parsed.data,
      },
    };
  }

  const safeUrl = validatedHttpsPublicUrl(uri);
  if (!safeUrl) {
    return protocolError(`附件「${name}」无法读取本地数据或使用了非公网 HTTPS 地址。`);
  }

  return {
    fileData: {
      mimeType: normalizeMimeType(
        materialized.mimeType ??
          (materialized.kind === 'image' ? 'image/jpeg' : 'application/octet-stream')
      ),
      fileUri: safeUrl,
    },
  };
}

async function attachmentToGeminiModelInlinePart(
  attachment: MediaAttachment
): Promise<Record<string, unknown> | undefined> {
  try {
    const materialized = await materializeAttachment(attachment, {
      maxSourceBytes: geminiNativeLimits.maxInlineMediaBytes,
    });
    const inline = materialized.base64?.trim();
    if (inline) {
      const parsed = stripAndValidateBase64(inline, attachment.name || attachment.id);
      const mimeType = normalizeMimeType(
        parsed.mimeTypeFromUri ?? materialized.mimeType ?? 'image/png'
      );
      return {
        inlineData: {
          mimeType,
          data: parsed.data,
        },
      };
    }
    const uri = materialized.uri?.trim();
    if (uri && uri.toLowerCase().startsWith('data:')) {
      const parsed = stripAndValidateBase64(uri, attachment.name || attachment.id);
      const mimeType = normalizeMimeType(
        parsed.mimeTypeFromUri ?? materialized.mimeType ?? 'image/png'
      );
      return {
        inlineData: {
          mimeType,
          data: parsed.data,
        },
      };
    }
    const safeUrl = uri ? validatedHttpsPublicUrl(uri) : undefined;
    if (safeUrl) {
      return {
        fileData: {
          mimeType: normalizeMimeType(materialized.mimeType ?? 'image/png'),
          fileUri: safeUrl,
        },
      };
    }
  } catch {
    // 历史模型生成的图片若本地缓存已被清理，优雅跳过而不阻断多轮文本对话
    return undefined;
  }
  return undefined;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function buildGeminiThinkingConfig(args: {
  cleanModelId: string;
  model: ModelInfo;
  reasoningEffort: ReasoningEffort;
}): Record<string, unknown> | undefined {
  const { cleanModelId, model, reasoningEffort } = args;
  if (model.capabilityOverrides?.reasoning === false) {
    return undefined;
  }

  const lower = cleanModelId.toLowerCase();
  const isGemini3Or4 = /(?:^|-)gemini-(?:3|4)(?:[.\-_]|$)/.test(lower);
  const isGemini25 = /(?:^|-)gemini-2[.-]5(?:[.\-_]|$)/.test(lower);
  const isGemini25Pro = /(?:^|-)gemini-2[.-]5-pro(?:[.\-_]|$)/.test(lower);
  const isGemini31Pro = /(?:^|-)gemini-3(?:\.1|-1)?-pro(?:[.\-_]|$)/.test(lower);
  const hasReasoningCap = model.capabilities.includes('reasoning');

  if (isGemini3Or4) {
    // Gemini 3.x / 4.x 严格仅使用 thinkingLevel（禁止混传 thinkingBudget）
    if (reasoningEffort === 'off' || reasoningEffort === 'none') {
      return {
        thinkingLevel: isGemini31Pro ? 'LOW' : 'MINIMAL',
      };
    }
    if (reasoningEffort === 'minimal') {
      return { thinkingLevel: 'MINIMAL', includeThoughts: true };
    }
    if (reasoningEffort === 'low') {
      return { thinkingLevel: 'LOW', includeThoughts: true };
    }
    if (reasoningEffort === 'medium') {
      return { thinkingLevel: 'MEDIUM', includeThoughts: true };
    }
    if (
      reasoningEffort === 'high' ||
      reasoningEffort === 'xhigh' ||
      reasoningEffort === 'max'
    ) {
      return { thinkingLevel: 'HIGH', includeThoughts: true };
    }
    return hasReasoningCap ? { includeThoughts: true } : undefined;
  }

  if (isGemini25) {
    // Gemini 2.5 严格仅使用 thinkingBudget（禁止混传 thinkingLevel；2.5-pro 最低 128 不得传 0）
    if (reasoningEffort === 'off' || reasoningEffort === 'none') {
      return {
        thinkingBudget: isGemini25Pro ? 128 : 0,
      };
    }
    if (reasoningEffort === 'minimal') {
      return { thinkingBudget: 512, includeThoughts: true };
    }
    if (reasoningEffort === 'low') {
      return { thinkingBudget: 1_024, includeThoughts: true };
    }
    if (reasoningEffort === 'medium') {
      return { thinkingBudget: 8_192, includeThoughts: true };
    }
    if (reasoningEffort === 'high') {
      return { thinkingBudget: 16_384, includeThoughts: true };
    }
    if (reasoningEffort === 'xhigh' || reasoningEffort === 'max') {
      return { thinkingBudget: 24_576, includeThoughts: true };
    }
    return hasReasoningCap ? { includeThoughts: true } : undefined;
  }

  if (hasReasoningCap && reasoningEffort !== 'off' && reasoningEffort !== 'none') {
    return { includeThoughts: true };
  }

  return undefined;
}

/**
 * 构造 Gemini `generationConfig`（含代际隔离的 `thinkingConfig`、采样参数、输出上限及生图配置）。
 */
export function buildGeminiGenerationConfig(args: {
  modelId: string;
  model?: ModelInfo;
  reasoningEffort?: ReasoningEffort;
  parameterSettings?: ModelParameterSettings;
  maxOutputTokens?: number;
  imageOptions?: ImageGenerationOptions;
}): Record<string, unknown> {
  const cleanModel = cleanGeminiModelId(args.modelId);
  const resolvedModel =
    args.model ??
    ({
      id: cleanModel,
      capabilities: ['text', 'reasoning'],
      source: 'manual',
    } as ModelInfo);
  const task = inferModelTask(resolvedModel);
  const config: Record<string, unknown> = {};

  if (args.parameterSettings?.enabled) {
    const temp = Math.round(clampNumber(args.parameterSettings.temperature, 0, 2) * 100) / 100;
    const topP = Math.round(clampNumber(args.parameterSettings.topP, 0, 1) * 100) / 100;
    if (temp !== 1) {
      config.temperature = temp;
    }
    if (topP !== 1) {
      config.topP = topP;
    }
  }

  if (args.maxOutputTokens !== undefined) {
    if (
      !Number.isInteger(args.maxOutputTokens) ||
      args.maxOutputTokens < 64 ||
      args.maxOutputTokens > geminiNativeLimits.maxAllowedOutputTokens
    ) {
      protocolError(`最大输出 Token 必须是 64–${geminiNativeLimits.maxAllowedOutputTokens} 的整数。`);
    }
    config.maxOutputTokens = args.maxOutputTokens;
  }

  if (task !== 'image-generation' || (args.reasoningEffort && args.reasoningEffort !== 'default')) {
    const thinkingConfig = buildGeminiThinkingConfig({
      cleanModelId: cleanModel,
      model: resolvedModel,
      reasoningEffort: args.reasoningEffort ?? 'default',
    });
    if (thinkingConfig) {
      config.thinkingConfig = thinkingConfig;
    }
  }

  if (args.imageOptions || task === 'image-generation') {
    config.responseModalities = ['TEXT', 'IMAGE'];
    const imageConfig: Record<string, unknown> = {};
    if (args.imageOptions?.aspectRatio) {
      imageConfig.aspectRatio = args.imageOptions.aspectRatio;
    }
    if (args.imageOptions?.resolution) {
      imageConfig.imageSize = args.imageOptions.resolution.toUpperCase();
    }
    if (Object.keys(imageConfig).length > 0) {
      config.imageConfig = imageConfig;
    }
  }

  return config;
}

/**
 * 构造 Gemini 原生 `:generateContent` / `:streamGenerateContent?alt=sse` 完整请求。
 */
export async function buildGeminiNativeRequest(
  options: GeminiNativeRequestOptions
): Promise<{
  url: string;
  headers: Record<string, string>;
  body: GeminiNativeRequestBody;
}> {
  const cleanModel = cleanGeminiModelId(options.modelId);
  if (!Array.isArray(options.messages) || options.messages.length === 0) {
    return protocolError('Gemini 请求至少需要一条输入消息。');
  }
  if (options.messages.length > geminiNativeLimits.maxMessages) {
    return protocolError(`输入消息过多，上限为 ${geminiNativeLimits.maxMessages} 条。`);
  }

  if (options.mcp) {
    return protocolError('Gemini 原生协议暂不支持 OpenAI Remote MCP。');
  }
  if (options.webSearch?.enabled && options.externalSearch?.enabled) {
    return protocolError('服务商原生联网搜索与外部搜索不能同时启用。');
  }
  if (options.externalSearch?.enabled && !options.webSearch?.enabled) {
    return protocolError('Gemini 原生适配器暂不支持外部搜索工具循环，请开启服务商联网搜索或使用兼容适配器。');
  }

  const requestModel =
    options.model ?? createModelInfoFromId(options.provider, cleanModel, 'manual');
  const task = inferModelTask(requestModel);
  if (task !== 'chat' && task !== 'image-generation') {
    return protocolError(`当前模型任务类型为 ${task}，Gemini 原生对话接口不支持此任务。`);
  }

  if (options.webSearch?.enabled) {
    if (task !== 'chat') {
      return protocolError('联网搜索仅适用于对话模型，已拒绝发起请求。');
    }
    if (!requestModel.capabilities.includes('web-search')) {
      return protocolError('当前模型未标记支持联网搜索能力，已拒绝发起可能计费的搜索请求。');
    }
  }

  const stream = options.stream !== false;
  const url = getGeminiNativeEndpoint(options.provider, cleanModel, stream);
  const headers = buildGeminiNativeHeaders(options.provider, { stream });
  assertGeminiAuthReady(options.provider, headers);

  // 将外层传入的 attachments 合并到最后一条有效 user 消息（按 id 去重）
  const workingMessages = options.messages.map((msg) => ({
    ...msg,
    attachments: msg.attachments ? [...msg.attachments] : undefined,
  }));
  if (options.attachments?.length) {
    for (let i = workingMessages.length - 1; i >= 0; i -= 1) {
      if (workingMessages[i].role === 'user' && workingMessages[i].status === 'ready') {
        const existing = workingMessages[i].attachments ?? [];
        const seenIds = new Set(existing.map((item) => item.id));
        const merged = [...existing];
        for (const extra of options.attachments) {
          if (!seenIds.has(extra.id)) {
            seenIds.add(extra.id);
            merged.push(extra);
          }
        }
        workingMessages[i].attachments = merged;
        break;
      }
    }
  }

  const systemParts: Array<{ text: string }> = [];
  const contents: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> = [];
  let totalInputChars = 0;

  for (const msg of workingMessages) {
    if (msg.status !== 'ready') {
      continue;
    }

    if (msg.role === 'system') {
      const trimmed = msg.content.trim();
      if (trimmed) {
        totalInputChars += trimmed.length;
        systemParts.push({ text: trimmed });
      }
      continue;
    }

    if (msg.role === 'user') {
      const parts: Array<Record<string, unknown>> = [];
      if (msg.content) {
        totalInputChars += msg.content.length;
        parts.push({ text: msg.content });
      }
      for (const att of msg.attachments ?? []) {
        parts.push(await attachmentToGeminiUserPart(att));
      }
      if (parts.length > 0) {
        contents.push({ role: 'user', parts });
      }
      continue;
    }

    // assistant -> Gemini role: 'model'，按原结构无损还原 thoughtSignature 与内联图像
    const geminiSignatures = (msg.providerContinuations ?? []).filter(
      (
        block
      ): block is Extract<
        ProviderContinuationBlock,
        { provider: 'gemini'; type: 'thought_signature' }
      > => block.provider === 'gemini' && block.type === 'thought_signature'
    );

    const usedSigIndexes = new Set<number>();
    const takeSignature = (
      predicate: (
        block: Extract<ProviderContinuationBlock, { provider: 'gemini'; type: 'thought_signature' }>
      ) => boolean
    ): string | undefined => {
      for (let idx = 0; idx < geminiSignatures.length; idx += 1) {
        if (usedSigIndexes.has(idx)) continue;
        const candidate = geminiSignatures[idx];
        if (predicate(candidate)) {
          usedSigIndexes.add(idx);
          return candidate.thoughtSignature;
        }
      }
      return undefined;
    };

    const parts: Array<Record<string, unknown>> = [];
    const usableText =
      msg.content && msg.content !== emptyContentPlaceholder ? msg.content : '';
    const imageAttachments = (msg.attachments ?? []).filter((att) => att.kind === 'image');

    if (usableText) {
      totalInputChars += usableText.length;
      const textSig =
        takeSignature((b) => b.partRole === 'text') ??
        (imageAttachments.length === 0 ? takeSignature((b) => !b.partRole) : undefined);
      parts.push({
        text: usableText,
        ...(textSig ? { thoughtSignature: textSig } : {}),
      });
    }

    for (const att of imageAttachments) {
      const mediaPart = await attachmentToGeminiModelInlinePart(att);
      if (!mediaPart) {
        continue;
      }
      const imageSig =
        takeSignature((b) => b.attachmentId === att.id) ??
        takeSignature((b) => b.partRole === 'image') ??
        takeSignature((b) => !b.partRole);
      if (imageSig) {
        mediaPart.thoughtSignature = imageSig;
      }
      parts.push(mediaPart);
    }

    // 处理剩余未消耗的签名块（例如 function_call 或仅返回了 thoughtSignature 的轮次）
    for (let idx = 0; idx < geminiSignatures.length; idx += 1) {
      if (usedSigIndexes.has(idx)) continue;
      const leftover = geminiSignatures[idx];
      const lastPart = parts[parts.length - 1];
      if (lastPart && typeof lastPart.thoughtSignature !== 'string') {
        lastPart.thoughtSignature = leftover.thoughtSignature;
      } else {
        parts.push({
          text: '',
          thoughtSignature: leftover.thoughtSignature,
        });
      }
    }

    if (parts.length > 0) {
      contents.push({ role: 'model', parts });
    }
  }

  if (totalInputChars > geminiNativeLimits.maxInputTextCharacters) {
    return protocolError(
      `输入文本总长度超过上限（${geminiNativeLimits.maxInputTextCharacters} 字符）。`
    );
  }
  if (!contents.some((item) => item.role === 'user')) {
    return protocolError('Gemini 请求必须至少包含一条有效的用户消息。');
  }

  const generationConfig = buildGeminiGenerationConfig({
    modelId: cleanModel,
    model: requestModel,
    reasoningEffort: options.reasoningEffort ?? 'default',
    parameterSettings: options.parameterSettings,
    maxOutputTokens: options.maxOutputTokens,
    imageOptions: options.imageOptions,
  });

  const body: GeminiNativeRequestBody = {
    contents,
    ...(systemParts.length > 0
      ? {
          systemInstruction: {
            parts:
              systemParts.length === 1
                ? systemParts
                : [{ text: systemParts.map((item) => item.text).join('\n\n') }],
          },
        }
      : {}),
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
    ...(options.webSearch?.enabled ? { tools: [{ google_search: {} }] } : {}),
  };

  return { url, headers, body };
}

function closeOpenThinking(
  state: GeminiStreamState,
  callbacks?: StreamChatCallbacks,
  now = Date.now()
): void {
  if (state.thinkingStartedAt !== undefined && !state.thinkingClosed) {
    state.thinkingClosed = true;
    const elapsed = Math.max(0, now - state.thinkingStartedAt);
    state.thinkingDurationMs = elapsed;
    state.activityTimeline = upsertTimelineStep(state.activityTimeline, {
      id: state.thinkingStepId,
      kind: 'thinking',
      sequence: nextTimelineSequence(state.activityTimeline),
      status: 'completed',
      title: formatThinkingRowTitle('completed', state.thinkingStartedAt, now),
      content: state.reasoningContent,
      startedAt: state.thinkingStartedAt,
      finishedAt: now,
    });
    state.activityTimeline = completeOpenThinkingSteps(state.activityTimeline, now);
    callbacks?.onThinkingComplete?.(elapsed);
  }
}

function emitGeminiStreamUpdate(
  state: GeminiStreamState,
  onStreamUpdate?: (update: GeminiStreamUpdate) => void
): void {
  if (!onStreamUpdate) return;
  onStreamUpdate({
    content: state.content,
    ...(state.reasoningContent ? { reasoningContent: state.reasoningContent } : {}),
    ...(state.usage ? { usage: { ...state.usage } } : {}),
    ...(state.toolActivity.length ? { toolActivity: [...state.toolActivity] } : {}),
    ...(state.activityTimeline.length ? { activityTimeline: [...state.activityTimeline] } : {}),
    raw: state.lastPayload,
  });
}

function extractUsageMetadata(rawUsage: unknown): ChatTokenUsage | undefined {
  if (!isRecord(rawUsage)) {
    return undefined;
  }
  const usage: ChatTokenUsage = {};
  let hasField = false;

  if (typeof rawUsage.promptTokenCount === 'number' && Number.isFinite(rawUsage.promptTokenCount)) {
    usage.inputTokens = rawUsage.promptTokenCount;
    hasField = true;
  }
  if (
    typeof rawUsage.candidatesTokenCount === 'number' &&
    Number.isFinite(rawUsage.candidatesTokenCount)
  ) {
    usage.outputTokens = rawUsage.candidatesTokenCount;
    hasField = true;
  }
  const thoughtTokens =
    typeof rawUsage.thoughtsTokenCount === 'number' && Number.isFinite(rawUsage.thoughtsTokenCount)
      ? rawUsage.thoughtsTokenCount
      : typeof rawUsage.totalThoughtTokens === 'number' && Number.isFinite(rawUsage.totalThoughtTokens)
        ? rawUsage.totalThoughtTokens
        : undefined;
  if (thoughtTokens !== undefined) {
    usage.reasoningTokens = thoughtTokens;
    hasField = true;
  }
  if (
    typeof rawUsage.cachedContentTokenCount === 'number' &&
    Number.isFinite(rawUsage.cachedContentTokenCount)
  ) {
    usage.cachedInputTokens = rawUsage.cachedContentTokenCount;
    hasField = true;
  }
  if (typeof rawUsage.totalTokenCount === 'number' && Number.isFinite(rawUsage.totalTokenCount)) {
    usage.totalTokens = rawUsage.totalTokenCount;
    hasField = true;
  } else if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
    usage.totalTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.reasoningTokens ?? 0);
  }

  return hasField ? usage : undefined;
}

function mergeGroundingMetadata(
  state: GeminiStreamState,
  grounding: unknown,
  callbacks?: StreamChatCallbacks
): void {
  if (!isRecord(grounding)) {
    return;
  }

  let citationsChanged = false;
  let queriesChanged = false;
  const chunkIndexToCitationIdx = new Map<number, number>();

  if (Array.isArray(grounding.webSearchQueries)) {
    for (const q of grounding.webSearchQueries) {
      if (typeof q === 'string' && q.trim() && !state.searchQueries.includes(q.trim())) {
        state.searchQueries.push(q.trim());
        queriesChanged = true;
      }
    }
  }

  if (Array.isArray(grounding.groundingChunks)) {
    for (let chunkIdx = 0; chunkIdx < grounding.groundingChunks.length; chunkIdx += 1) {
      const chunk = grounding.groundingChunks[chunkIdx];
      if (!isRecord(chunk) || !isRecord(chunk.web)) continue;
      const safeUrl = validatedHttpsPublicUrl(chunk.web.uri);
      if (!safeUrl) continue;

      const existingIdx = state.citationIndexByUrl.get(safeUrl);
      if (existingIdx !== undefined) {
        chunkIndexToCitationIdx.set(chunkIdx, existingIdx);
        continue;
      }

      const title =
        typeof chunk.web.title === 'string' && chunk.web.title.trim()
          ? chunk.web.title.trim()
          : undefined;
      const citationIdx = state.citations.length;
      state.citationIndexByUrl.set(safeUrl, citationIdx);
      chunkIndexToCitationIdx.set(chunkIdx, citationIdx);
      state.citations.push({
        url: safeUrl,
        ...(title ? { title } : {}),
        index: citationIdx + 1,
      });
      citationsChanged = true;
    }
  }

  if (Array.isArray(grounding.groundingSupports)) {
    for (const support of grounding.groundingSupports) {
      if (!isRecord(support) || !isRecord(support.segment)) continue;
      const seg = support.segment;
      const startIndex =
        typeof seg.startIndex === 'number' && Number.isInteger(seg.startIndex) && seg.startIndex >= 0
          ? seg.startIndex
          : undefined;
      const endIndex =
        typeof seg.endIndex === 'number' && Number.isInteger(seg.endIndex) && seg.endIndex >= 0
          ? seg.endIndex
          : undefined;
      const text = typeof seg.text === 'string' && seg.text.trim() ? seg.text.trim() : undefined;

      const indices = Array.isArray(support.groundingChunkIndices)
        ? support.groundingChunkIndices
        : [];
      for (const rawChunkIdx of indices) {
        if (typeof rawChunkIdx !== 'number' || !Number.isInteger(rawChunkIdx)) continue;
        const citationIdx = chunkIndexToCitationIdx.get(rawChunkIdx);
        if (citationIdx === undefined) continue;
        const target = state.citations[citationIdx];
        if (!target) continue;
        if (target.startIndex === undefined && startIndex !== undefined && endIndex !== undefined) {
          target.startIndex = startIndex;
          target.endIndex = endIndex;
          citationsChanged = true;
        }
        if (!target.text && text) {
          target.text = text;
          citationsChanged = true;
        }
      }
    }
  }

  if (queriesChanged || citationsChanged || state.searchQueries.length > 0 || state.citations.length > 0) {
    state.webSearchTriggered = true;
    const queryLabel = state.searchQueries.join(' / ');
    const count = state.citations.length;
    const title = formatSearchActivityTitle({
      status: 'completed',
      query: queryLabel || undefined,
      resultCount: count,
    });
    const detail = JSON.stringify({
      ...(queryLabel ? { query: queryLabel } : {}),
      items: state.citations.map((item) => ({
        title: item.title || item.url,
        url: item.url,
        ...(item.text ? { text: item.text } : {}),
      })),
    });

    const now = Date.now();
    state.toolActivity = upsertToolActivity(state.toolActivity, {
      id: 'gemini-google-search',
      toolName: 'web_search',
      title,
      ...(queryLabel ? { arguments: { query: queryLabel } } : {}),
      status: 'completed',
      summary: count > 0 ? `返回 ${count} 条结果` : '已完成 Google Search 检索',
      content: detail,
      finishedAt: now,
    });
    state.activityTimeline = upsertTimelineStep(state.activityTimeline, {
      id: 'tool:gemini-google-search',
      kind: 'tool',
      sequence: nextTimelineSequence(state.activityTimeline),
      status: 'completed',
      toolName: 'web_search',
      title,
      ...(queryLabel ? { arguments: { query: queryLabel } } : {}),
      summary: count > 0 ? `返回 ${count} 条结果` : '已完成 Google Search 检索',
      content: detail,
      finishedAt: now,
    });

    callbacks?.onToolActivity?.([...state.toolActivity], [...state.activityTimeline]);
    if (citationsChanged || state.citations.length > 0) {
      callbacks?.onCitations?.([...state.citations], true);
    }
  }
}

function processGeminiChunkPayload(
  state: GeminiStreamState,
  payload: unknown,
  callbacks?: StreamChatCallbacks,
  onStreamUpdate?: (update: GeminiStreamUpdate) => void,
  apiKey?: string
): void {
  if (!isRecord(payload)) {
    return;
  }

  if (isRecord(payload.error)) {
    const code = typeof payload.error.code === 'number' ? payload.error.code : undefined;
    const errStatus = typeof payload.error.status === 'string' ? payload.error.status : undefined;
    const rawErrMsg =
      typeof payload.error.message === 'string'
        ? payload.error.message
        : 'Gemini 返回了错误事件。';
    const errMsg = sanitizeErrorMessage(rawErrMsg, apiKey);
    const err = new GeminiNativeProtocolError(
      `Gemini 接口错误${errStatus ? `（${errStatus}）` : ''}：${errMsg}`,
      { status: code, errorStatus: errStatus }
    );
    callbacks?.onError?.(err);
    throw err;
  }

  state.sawValidChunk = true;
  state.lastPayload = payload;
  state.rawChunks.push(payload);

  if (isRecord(payload.promptFeedback) && typeof payload.promptFeedback.blockReason === 'string') {
    state.blockReason = payload.promptFeedback.blockReason;
  }

  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const candidate = isRecord(candidates[0]) ? candidates[0] : undefined;

  if (candidate) {
    if (typeof candidate.finishReason === 'string' && candidate.finishReason) {
      state.finishReason = candidate.finishReason;
    }

    const contentRecord = isRecord(candidate.content) ? candidate.content : undefined;
    const parts = contentRecord && Array.isArray(contentRecord.parts) ? contentRecord.parts : [];
    const now = Date.now();

    for (const part of parts) {
      if (!isRecord(part)) continue;

      const isThought = part.thought === true;
      const thoughtSignature =
        typeof part.thoughtSignature === 'string' && part.thoughtSignature.length > 0
          ? part.thoughtSignature
          : undefined;

      if (isThought) {
        const thoughtText = typeof part.text === 'string' ? part.text : '';
        if (thoughtText) {
          if (state.content.length + state.reasoningContent.length + thoughtText.length > geminiNativeLimits.maxStreamOutputCharacters) {
            protocolError('Gemini 流式输出总字符数超过安全上限。');
          }
          if (state.thinkingStartedAt === undefined) {
            state.thinkingStartedAt = now;
          }
          state.reasoningContent += thoughtText;
          state.activityTimeline = upsertTimelineStep(state.activityTimeline, {
            id: state.thinkingStepId,
            kind: 'thinking',
            sequence: nextTimelineSequence(state.activityTimeline),
            status: 'running',
            title: formatThinkingRowTitle('running', state.thinkingStartedAt),
            content: state.reasoningContent,
            startedAt: state.thinkingStartedAt,
          });
          callbacks?.onThinkingDelta?.(thoughtText, state.reasoningContent);
        }
        if (thoughtSignature) {
          state.continuationBlocks.push({
            provider: 'gemini',
            type: 'thought_signature',
            thoughtSignature,
            partRole: 'text',
          });
          callbacks?.onContinuationBlocks?.([...state.continuationBlocks]);
        }
        continue;
      }

      if (typeof part.text === 'string') {
        closeOpenThinking(state, callbacks, now);
        if (part.text) {
          if (state.content.length + state.reasoningContent.length + part.text.length > geminiNativeLimits.maxStreamOutputCharacters) {
            protocolError('Gemini 流式输出总字符数超过安全上限。');
          }
          state.content += part.text;
          callbacks?.onTextDelta?.(part.text, state.content);
        }
        if (thoughtSignature) {
          state.continuationBlocks.push({
            provider: 'gemini',
            type: 'thought_signature',
            thoughtSignature,
            partRole: 'text',
          });
          callbacks?.onContinuationBlocks?.([...state.continuationBlocks]);
        }
      } else if (
        isRecord(part.inlineData) &&
        typeof part.inlineData.data === 'string' &&
        part.inlineData.data.length > 0 &&
        typeof part.inlineData.mimeType === 'string' &&
        part.inlineData.mimeType.toLowerCase().startsWith('image/')
      ) {
        closeOpenThinking(state, callbacks, now);
        const mimeType = normalizeImageOutputMimeType(part.inlineData.mimeType);
        const cleanData = part.inlineData.data.replace(/\s+/g, '');
        if (/^[A-Za-z0-9+/]*={0,2}$/.test(cleanData) && cleanData.length % 4 !== 1) {
          const imageIndex = state.attachments.length;
          const attachmentId = `gemini-img-${now}-${imageIndex}`;
          const ext = imageExtensionForMime(mimeType);
          const attachment: MediaAttachment = {
            id: attachmentId,
            kind: 'image',
            mimeType,
            uri: `data:${mimeType};base64,${cleanData}`,
            name: `${state.modelId}-${imageIndex + 1}.${ext}`,
            base64: cleanData,
          };
          state.attachments.push(attachment);
          callbacks?.onImageGenerated?.([attachment]);

          if (thoughtSignature) {
            state.continuationBlocks.push({
              provider: 'gemini',
              type: 'thought_signature',
              thoughtSignature,
              partRole: 'image',
              attachmentId,
            });
            callbacks?.onContinuationBlocks?.([...state.continuationBlocks]);
          }
        }
      } else if (isRecord(part.functionCall) && thoughtSignature) {
        state.continuationBlocks.push({
          provider: 'gemini',
          type: 'thought_signature',
          thoughtSignature,
          partRole: 'function_call',
        });
        callbacks?.onContinuationBlocks?.([...state.continuationBlocks]);
      } else if (thoughtSignature) {
        state.continuationBlocks.push({
          provider: 'gemini',
          type: 'thought_signature',
          thoughtSignature,
          partRole: 'text',
        });
        callbacks?.onContinuationBlocks?.([...state.continuationBlocks]);
      }
    }

    if (candidate.groundingMetadata) {
      mergeGroundingMetadata(state, candidate.groundingMetadata, callbacks);
    }
  }

  const parsedUsage = extractUsageMetadata(payload.usageMetadata);
  if (parsedUsage) {
    state.usage = parsedUsage;
    callbacks?.onUsage?.({ ...parsedUsage });
  }

  emitGeminiStreamUpdate(state, onStreamUpdate);
}

function finalizeGeminiStreamState(
  state: GeminiStreamState,
  callbacks?: StreamChatCallbacks,
  apiKey?: string
): ChatCompletionResult {
  closeOpenThinking(state, callbacks);

  const hasContent =
    Boolean(state.content) ||
    Boolean(state.reasoningContent) ||
    state.attachments.length > 0 ||
    state.continuationBlocks.length > 0;

  if (state.blockReason && !hasContent) {
    const safeBlockReason = sanitizeErrorMessage(state.blockReason, apiKey);
    const err = new GeminiNativeProtocolError(
      `Gemini 拒绝了输入请求（blockReason: ${safeBlockReason}）。`,
      { finishReason: safeBlockReason }
    );
    callbacks?.onError?.(err);
    throw err;
  }

  if (
    state.finishReason &&
    blockedSafetyFinishReasons.has(state.finishReason) &&
    !state.content &&
    state.attachments.length === 0
  ) {
    const safeFinishReason = sanitizeErrorMessage(state.finishReason, apiKey);
    const err = new GeminiNativeProtocolError(
      `Gemini 因安全或内容策略拦截了本次输出（finishReason: ${safeFinishReason}）。`,
      { finishReason: safeFinishReason }
    );
    callbacks?.onError?.(err);
    throw err;
  }

  const result: ChatCompletionResult = {
    content: state.content || (hasContent ? '' : emptyContentPlaceholder),
    ...(state.reasoningContent ? { reasoningContent: state.reasoningContent } : {}),
    ...(state.thinkingStartedAt !== undefined ? { thinkingDurationMs: state.thinkingDurationMs } : {}),
    ...(state.continuationBlocks.length
      ? { providerContinuations: [...state.continuationBlocks] }
      : {}),
    ...(state.usage ? { usage: { ...state.usage } } : {}),
    ...(state.citations.length ? { citations: [...state.citations] } : {}),
    ...(state.webSearchTriggered ? { webSearchTriggered: true } : {}),
    ...(state.toolActivity.length ? { toolActivity: [...state.toolActivity] } : {}),
    ...(state.activityTimeline.length ? { activityTimeline: [...state.activityTimeline] } : {}),
    ...(state.attachments.length ? { attachments: [...state.attachments] } : {}),
    raw: state.rawChunks.length === 1 ? state.rawChunks[0] : state.rawChunks,
  };

  callbacks?.onDone?.(result);
  return result;
}

function createInitialGeminiState(modelId: string): GeminiStreamState {
  return {
    modelId: modelId.trim() || 'gemini',
    content: '',
    reasoningContent: '',
    thinkingClosed: false,
    thinkingDurationMs: 0,
    thinkingStepId: 'gemini-thinking',
    continuationBlocks: [],
    citations: [],
    citationIndexByUrl: new Map<string, number>(),
    searchQueries: [],
    toolActivity: [],
    activityTimeline: [],
    attachments: [],
    webSearchTriggered: false,
    sawValidChunk: false,
    rawChunks: [],
    lastPayload: undefined,
  };
}

/**
 * 解析 Gemini 非流式 `:generateContent` JSON 响应。
 */
export function parseGeminiGenerateContentResponse(
  payload: unknown,
  options: {
    modelId?: string;
    callbacks?: StreamChatCallbacks;
    onStreamUpdate?: (update: GeminiStreamUpdate) => void;
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
      const err = new GeminiNativeProtocolError(`Gemini 响应 JSON 解析失败：${safeDetail}`);
      options.callbacks?.onError?.(err);
      throw err;
    }
  }
  if (!isRecord(parsed)) {
    return protocolError('Gemini 响应内容必须是 JSON 对象。');
  }
  const state = createInitialGeminiState(options.modelId ?? 'gemini');
  processGeminiChunkPayload(
    state,
    parsed,
    options.callbacks,
    options.onStreamUpdate,
    options.apiKey
  );
  return finalizeGeminiStreamState(state, options.callbacks, options.apiKey);
}

function buildGeminiHttpStatusError(
  status: number,
  rawBody: string,
  cleanModelId: string,
  apiKey?: string
): GeminiNativeProtocolError {
  let errorStatus: string | undefined;
  let detail = '';

  try {
    const parsed = JSON.parse(rawBody) as unknown;
    const errRecord =
      isRecord(parsed) && isRecord(parsed.error)
        ? parsed.error
        : Array.isArray(parsed) && isRecord(parsed[0]) && isRecord(parsed[0].error)
          ? parsed[0].error
          : undefined;
    if (errRecord) {
      errorStatus = typeof errRecord.status === 'string' ? errRecord.status : undefined;
      detail = typeof errRecord.message === 'string' ? errRecord.message.trim() : '';
    }
  } catch {
    detail = compactResponseText(rawBody);
  }
  if (!detail) {
    detail = compactResponseText(rawBody);
  }
  const safeDetail = sanitizeErrorMessage(detail, apiKey);

  if (status === 400) {
    return new GeminiNativeProtocolError(
      `Gemini 请求参数无效（400）：${safeDetail || '请检查模型参数或历史 thoughtSignature。'}`,
      { status, errorStatus }
    );
  }
  if (status === 401 || status === 403) {
    return new GeminiNativeProtocolError(
      `Gemini API Key 无效、未授权或当前地区受限（${status}）：${safeDetail || '请核对密钥权限。'}`,
      { status, errorStatus }
    );
  }
  if (status === 404) {
    return new GeminiNativeProtocolError(
      `Gemini 模型或接口不存在（404）：请检查模型 ID「${cleanModelId}」及 Base URL。${safeDetail ? ` 详情：${safeDetail}` : ''}`,
      { status, errorStatus }
    );
  }
  if (status === 429) {
    return new GeminiNativeProtocolError(
      `Gemini 请求频率或配额超限（429），请稍后重试。${safeDetail ? ` 详情：${safeDetail}` : ''}`,
      { status, errorStatus }
    );
  }
  if (status >= 500) {
    return new GeminiNativeProtocolError(
      `Gemini 服务端暂时不可用（${status}）：${safeDetail || '请稍后重试。'}`,
      { status, errorStatus }
    );
  }
  return new GeminiNativeProtocolError(
    `Gemini 请求失败（${status}）：${safeDetail || '未知错误'}`,
    { status, errorStatus }
  );
}

function resolveGeminiSignalError(signal?: AbortSignal): Error {
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
    throw resolveGeminiSignalError(signal);
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    protocolError(`${label}响应体过大（上限 ${Math.round(maxBytes / 1024 / 1024)} MB）。`);
  }
  const reader = response.body?.getReader();
  let onAbort: (() => void) | undefined;
  const abortPromise = signal
    ? new Promise<never>((_, reject) => {
        onAbort = () => {
          reject(resolveGeminiSignalError(signal));
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
      const body = abortPromise
        ? await Promise.race([response.text(), abortPromise])
        : await response.text();
      if (signal?.aborted) {
        throw resolveGeminiSignalError(signal);
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
        throw resolveGeminiSignalError(signal);
      }
      const { value, done } = abortPromise
        ? await Promise.race([reader.read(), abortPromise])
        : await reader.read();
      if (signal?.aborted) {
        await reader.cancel().catch(() => undefined);
        throw resolveGeminiSignalError(signal);
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
 * Gemini 专用安全传输函数：
 * 复用 `isWebDevelopmentProxyAllowed` 做 Web 生产态 fail-closed 拦截，
 * 支持长程推理可配置 `timeoutMs`（默认 600_000 ms）并在结束后彻底清理定时器与 Abort 监听。
 */
async function geminiFetch(
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
    controller.abort(createAbortError('Gemini 请求超时。'));
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
        throw new GeminiNativeProtocolError(
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
        throw new GeminiNativeProtocolError(
          'Web 调试代理未启动或不可访问。请用 npm run web 启动应用，或确认 127.0.0.1:8787 可访问。'
        );
      }
    }

    return await consumeResponse(response, controller.signal);
  } catch (error) {
    if (timedOut) {
      const timeoutError = new GeminiNativeProtocolError(
        `Gemini 请求超过 ${Math.round(init.timeoutMs / 1000)} 秒，已自动停止。`
      );
      timeoutError.name = 'TimeoutError';
      throw timeoutError;
    }
    if (init.signal?.aborted || isAbortError(error)) {
      throw createAbortError();
    }
    if (error instanceof GeminiNativeProtocolError) {
      throw error;
    }
    const rawMsg = error instanceof Error ? error.message : String(error);
    throw new GeminiNativeProtocolError(sanitizeErrorMessage(rawMsg, apiKey));
  } finally {
    clearTimeout(timeoutHandle);
    init.signal?.removeEventListener('abort', onCallerAbort);
  }
}

async function readGeminiSseResponse(
  response: Response,
  modelId: string,
  callbacks?: StreamChatCallbacks,
  onStreamUpdate?: (update: GeminiStreamUpdate) => void,
  apiKey?: string,
  signal?: AbortSignal
): Promise<ChatCompletionResult> {
  const state = createInitialGeminiState(modelId);
  let buffer = '';
  let pendingTrailingCr = false;

  const processSseBlock = (rawBlock: string) => {
    if (!rawBlock.trim()) return;
    const dataLines: string[] = [];
    for (const rawLine of rawBlock.split('\n')) {
      const line = rawLine.trimEnd();
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trimStart());
      }
    }
    if (dataLines.length === 0) return;
    const payloadText = dataLines.join('\n').trim();
    if (!payloadText || payloadText === '[DONE]') {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(payloadText);
    } catch (error) {
      const err = new GeminiNativeProtocolError(
        `Gemini 流式 JSON 解析失败：${sanitizeErrorMessage(error instanceof Error ? error.message : String(error), apiKey)}`
      );
      callbacks?.onError?.(err);
      throw err;
    }
    processGeminiChunkPayload(state, parsed, callbacks, onStreamUpdate, apiKey);
  };

  const drainCompleteBlocks = () => {
    let separatorIndex = buffer.indexOf('\n\n');
    while (separatorIndex >= 0) {
      const block = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      processSseBlock(block);
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

  const consumeText = (text: string) => {
    if (!text) return;

    // 保留跨 chunk 边界的末尾 \r，防止将 \r + \n 误拼接为 \n\n 破坏 SSE 事件边界
    let chunk = text;
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

    if (new TextEncoder().encode(buffer).byteLength > geminiNativeLimits.maxStreamEventBytes) {
      const err = new GeminiNativeProtocolError('Gemini 流式事件缓冲区超过安全上限，已停止接收。');
      callbacks?.onError?.(err);
      throw err;
    }

    drainCompleteBlocks();
  };

  if (signal?.aborted) {
    void response.body?.cancel().catch(() => undefined);
    throw resolveGeminiSignalError(signal);
  }

  const reader = response.body?.getReader();
  let onAbort: (() => void) | undefined;
  const abortPromise = signal
    ? new Promise<never>((_, reject) => {
        onAbort = () => {
          reject(resolveGeminiSignalError(signal));
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
      const rawText = abortPromise
        ? await Promise.race([response.text(), abortPromise])
        : await response.text();
      if (signal?.aborted) {
        throw resolveGeminiSignalError(signal);
      }
      consumeText(rawText);
    } finally {
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
    }
  } else {
    const decoder = new TextDecoder();
    try {
      while (true) {
        if (signal?.aborted) {
          await reader.cancel().catch(() => undefined);
          throw resolveGeminiSignalError(signal);
        }
        const { value, done } = abortPromise
          ? await Promise.race([reader.read(), abortPromise])
          : await reader.read();
        if (signal?.aborted) {
          await reader.cancel().catch(() => undefined);
          throw resolveGeminiSignalError(signal);
        }
        if (done) break;
        consumeText(decoder.decode(value, { stream: true }));
      }
      consumeText(decoder.decode());
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

  flushPendingCr();
  drainCompleteBlocks();

  if (buffer.trim()) {
    processSseBlock(buffer);
  }

  if (!state.sawValidChunk) {
    const emptyErr = new GeminiNativeProtocolError('Gemini 未返回有效的流式响应事件。');
    callbacks?.onError?.(emptyErr);
    throw emptyErr;
  }

  return finalizeGeminiStreamState(state, callbacks, apiKey);
}

/**
 * 发送 Google Gemini 原生 `:generateContent` / `:streamGenerateContent?alt=sse` 请求，
 * 支持思考计时、`thoughtSignature` 多轮透传、Google Search Grounding 与内联图像输出。
 */
export async function sendGeminiNativeChat(
  options: GeminiNativeRequestOptions
): Promise<ChatCompletionResult> {
  let errorNotified = false;
  const notifyErrorOnce = (error: unknown) => {
    if (errorNotified || isAbortError(error)) {
      return;
    }
    errorNotified = true;
    const errObj = error instanceof Error ? error : new Error(String(error));
    options.callbacks?.onError?.(errObj);
  };

  try {
    const prepared = await buildGeminiNativeRequest(options);
    const cleanModel = cleanGeminiModelId(options.modelId);
    const timeoutMs =
      typeof options.timeoutMs === 'number' &&
      Number.isFinite(options.timeoutMs) &&
      options.timeoutMs > 0
        ? options.timeoutMs
        : geminiNativeLimits.defaultTimeoutMs;

    const wrappedCallbacks: StreamChatCallbacks = {
      ...options.callbacks,
      onError: (err) => {
        errorNotified = true;
        options.callbacks?.onError?.(err);
      },
    };

    return await geminiFetch(
      prepared.url,
      {
        headers: prepared.headers,
        body: JSON.stringify(prepared.body),
        signal: options.signal,
        timeoutMs,
        fetchImpl: options.fetchImpl,
      },
      async (response, requestSignal) => {
        if (!response.ok) {
          const errorBody = await readLimitedTextWithMaxBytes(
            response,
            geminiNativeLimits.maxErrorResponseBytes,
            'Gemini 错误',
            requestSignal
          );
          const httpErr = buildGeminiHttpStatusError(
            response.status,
            errorBody,
            cleanModel,
            options.provider.apiKey
          );
          notifyErrorOnce(httpErr);
          throw httpErr;
        }

        const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
        const isJsonResponse =
          options.stream === false ||
          (contentType.includes('application/json') && !contentType.includes('text/event-stream'));

        if (isJsonResponse) {
          const jsonText = await readLimitedTextWithMaxBytes(
            response,
            geminiNativeLimits.maxJsonResponseBytes,
            'Gemini 对话',
            requestSignal
          );
          if (looksLikeHtmlResponse(jsonText, contentType)) {
            protocolError(`Gemini 接口返回了 HTML 页面而非 JSON，请检查 Base URL（${prepared.url}）。`);
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(jsonText);
          } catch (error) {
            protocolError(
              `Gemini 响应 JSON 解析失败：${sanitizeErrorMessage(error instanceof Error ? error.message : String(error), options.provider.apiKey)}`
            );
          }
          return parseGeminiGenerateContentResponse(parsed, {
            modelId: cleanModel,
            callbacks: wrappedCallbacks,
            onStreamUpdate: options.onStreamUpdate,
            apiKey: options.provider.apiKey,
          });
        }

        return readGeminiSseResponse(
          response,
          cleanModel,
          wrappedCallbacks,
          options.onStreamUpdate,
          options.provider.apiKey,
          requestSignal
        );
      },
      options.provider.apiKey
    );
  } catch (error) {
    notifyErrorOnce(error);
    throw error;
  }
}

/**
 * 面向 `ProviderAdapterRegistry` 的 Google Gemini 原生适配器实现。
 */
export class GeminiNativeProviderAdapter implements ProviderAdapter {
  async run(request: ChatProviderRequest): Promise<ChatCompletionResult> {
    const result = await sendGeminiNativeChat(request);
    if (!result.attachments?.length) {
      return result;
    }
    const persistedAttachments = await Promise.all(
      result.attachments.map(async (attachment) => {
        try {
          return await persistAttachment(attachment, { downloadRemote: true });
        } catch {
          return attachment;
        }
      })
    );
    return {
      ...result,
      attachments: persistedAttachments,
    };
  }

  async queryTask(_request: GenerationTaskProviderRequest): Promise<ChatCompletionResult> {
    throw new GeminiNativeProtocolError('Gemini 原生适配器不支持异步视频生成轮询任务。');
  }
}

/** 创建 Google Gemini 原生 `ProviderAdapter` 实例。 */
export function createGeminiNativeProviderAdapter(): ProviderAdapter {
  return new GeminiNativeProviderAdapter();
}
