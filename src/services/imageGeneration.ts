import { Platform } from 'react-native';

import type {
  ChatCompletionResult,
  ChatMessage,
  ChatTokenUsage,
  ImageAspectRatio,
  ImageGenerationOptions,
  MediaAttachment,
  ProviderContinuationBlock,
  ProviderImageApiMode,
  ProviderProfile,
} from '../domain/types';
import { sendGeminiNativeChat } from './geminiNative';
import { materializeAttachment, persistAttachment } from './mediaStorage';
import { isOpenAiImageGenerationModel, sendOpenAiResponsesChat } from './openAiResponses';
import {
  inspectProviderEndpoint,
  isExactOfficialOpenAiProvider,
  isRelayOrCustomProvider,
  resolveProviderAuthHeaders,
} from './providerSetup';
import { safePublicHttpsUrl } from './ssrfGuard';

const webDevProxyUrl = 'http://127.0.0.1:8787/proxy';
const defaultRequestTimeoutMs = 120_000;
const maxErrorResponseBytes = 64 * 1024;
const maxGeneratedImageResponseBytes = 30 * 1024 * 1024;
const maxReferenceImages = 10;
const maxImageCount = 10;
const supportedReferenceMimeTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
]);

/** 统一生图服务请求参数。 */
export interface UnifiedImageGenerationRequest {
  provider: ProviderProfile;
  modelId: string;
  prompt: string;
  options?: ImageGenerationOptions;
  continuationBlocks?: ProviderContinuationBlock[];
  messages?: ChatMessage[];
  signal?: AbortSignal;
  /** 可选自定义 fetch 注入（仅用于测试或受控容器，Web 生产态仍强制执行 fail-closed 拦截）。 */
  fetchImpl?: typeof fetch;
}

function createAbortError(message = '图片生成请求已取消。'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

/**
 * 校验当前 Web 运行时是否显式开启了本机受控调试代理（正式 Web 构建 fail-closed）。
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
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

/**
 * 对错误文本中的 API Key 原文及其大小写混合 URL 编码形式（含 URLSearchParams 空格 `+` 变体）做全面脱敏。
 */
function redactSecrets(text: string, apiKey?: string): string {
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

function sanitizeErrorSnippet(text: string, apiKey?: string, maxLength = 320): string {
  return redactSecrets(text, apiKey).replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function sanitizeErrorMessage(error: unknown, apiKey?: string): Error {
  if (error instanceof Error) {
    const sanitized = redactSecrets(error.message, apiKey);
    if (sanitized !== error.message) {
      const cloned = new Error(sanitized);
      cloned.name = error.name;
      for (const [key, value] of Object.entries(error)) {
        if (key !== 'message' && key !== 'name' && key !== 'stack') {
          (cloned as unknown as Record<string, unknown>)[key] = value;
        }
      }
      return cloned;
    }
    return error;
  }
  return new Error(redactSecrets(String(error), apiKey));
}

function headersToObject(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }
  if (headers instanceof Headers) {
    const record: Record<string, string> = {};
    headers.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...headers };
}

/**
 * 将二进制 ArrayBuffer 分块编码为 Base64 字符串（避免大数组展开导致栈溢出，兼容 Web 与原生运行时）。
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/**
 * 生图服务受保护传输封装：
 * - Native 端直连请求（支持超时与取消）；
 * - Web 生产态严格 fail-closed 拦截任何外发请求；
 * - Web 本机开发态仅在显式开启受限调试代理时经 127.0.0.1:8787/proxy 转发（支持文本与 FormData Base64 转发）。
 */
async function imageTransportFetch(
  url: string,
  init: RequestInit,
  fetchImpl?: typeof fetch
): Promise<Response> {
  if (init.signal?.aborted) {
    throw createAbortError();
  }
  const performFetch = fetchImpl ?? fetch;

  if (Platform.OS !== 'web') {
    return performFetch(url, init);
  }

  if (!isWebDevelopmentProxyAllowed()) {
    throw new Error(
      '正式 Web 构建不会发送 API Key 或模型请求。仅可在本机通过 npm run web 显式启动受限调试代理。'
    );
  }

  const outboundHeaders = headersToObject(init.headers);
  let outboundBody: string | undefined;
  let bodyEncoding: 'base64' | undefined;

  if (typeof FormData !== 'undefined' && init.body instanceof FormData) {
    // 仅在受控 Web 本地调试代理已放行后，将 FormData 序列化为带 boundary 的 multipart 二进制信封
    const serialized = new Response(init.body);
    const serializedContentType = serialized.headers.get('content-type');
    for (const existingKey of Object.keys(outboundHeaders)) {
      if (existingKey.toLowerCase() === 'content-type') {
        delete outboundHeaders[existingKey];
      }
    }
    if (serializedContentType) {
      outboundHeaders['Content-Type'] = serializedContentType;
    }
    outboundBody = arrayBufferToBase64(await serialized.arrayBuffer());
    bodyEncoding = 'base64';
  } else if (typeof init.body === 'string' || init.body === undefined) {
    outboundBody = init.body;
  } else {
    throw new Error('当前 Web 本地调试代理暂不支持 multipart/form-data 二进制转发，请改用原生端或兼容模式。');
  }

  try {
    return await performFetch(webDevProxyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        method: init.method ?? 'POST',
        headers: outboundHeaders,
        body: outboundBody,
        ...(bodyEncoding ? { bodyEncoding } : {}),
      }),
      signal: init.signal,
    });
  } catch (error) {
    if (isAbortError(error) || init.signal?.aborted) {
      throw error;
    }
    throw new Error('Web 调试代理未启动或不可访问。请用 npm run web 启动应用，或确认 127.0.0.1:8787 可访问。');
  }
}

async function guardedImageFetch<T>(
  url: string,
  init: RequestInit,
  consumeResponse: (response: Response, signal: AbortSignal) => Promise<T>,
  fetchImpl?: typeof fetch,
  timeoutMs = defaultRequestTimeoutMs
): Promise<T> {
  if (init.signal?.aborted) {
    throw createAbortError();
  }

  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => controller.abort(init.signal?.reason ?? createAbortError());
  init.signal?.addEventListener('abort', onCallerAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(createAbortError('图片生成请求超时。'));
  }, timeoutMs);

  try {
    const response = await imageTransportFetch(
      url,
      { ...init, redirect: 'error', signal: controller.signal },
      fetchImpl
    );
    return await consumeResponse(response, controller.signal);
  } catch (error) {
    if (timedOut) {
      const timeoutErr = createAbortError(`图片生成请求超过 ${Math.round(timeoutMs / 1000)} 秒，已自动停止。`);
      timeoutErr.name = 'TimeoutError';
      throw timeoutErr;
    }
    if (init.signal?.aborted || isAbortError(error)) {
      throw createAbortError();
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener('abort', onCallerAbort);
  }
}

async function readLimitedResponseText(
  response: Response,
  maxBytes: number,
  label: string,
  signal?: AbortSignal
): Promise<string> {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : createAbortError();
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`${label}响应过大（上限 ${Math.round(maxBytes / 1024 / 1024)} MB）。`);
  }

  const reader = response.body?.getReader();
  let onAbort: (() => void) | undefined;
  const abortPromise = signal
    ? new Promise<never>((_, reject) => {
        onAbort = () => {
          reject(signal.reason instanceof Error ? signal.reason : createAbortError());
          void reader?.cancel().catch(() => undefined);
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
        throw signal.reason instanceof Error ? signal.reason : createAbortError();
      }
      if (new TextEncoder().encode(body).byteLength > maxBytes) {
        throw new Error(`${label}响应过大（上限 ${Math.round(maxBytes / 1024 / 1024)} MB）。`);
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
        throw signal.reason instanceof Error ? signal.reason : createAbortError();
      }
      const { value, done } = abortPromise
        ? await Promise.race([reader.read(), abortPromise])
        : await reader.read();
      if (signal?.aborted) {
        await reader.cancel().catch(() => undefined);
        throw signal.reason instanceof Error ? signal.reason : createAbortError();
      }
      if (done) {
        break;
      }
      totalBytes += value?.byteLength ?? 0;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${label}响应过大（上限 ${Math.round(maxBytes / 1024 / 1024)} MB）。`);
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } finally {
    if (signal && onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
    reader.releaseLock();
  }
}

function canonicalModelId(modelId: string): string {
  return modelId.trim().toLowerCase().replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

function isDallEModel(modelId: string): boolean {
  return /(?:^|[/_-])dall[·._-]?e[._-]?(?:2|3)(?:$|[/_.-])/i.test(modelId);
}

function isGptImageModel(modelId: string): boolean {
  return /gpt[._-]?image/i.test(modelId);
}

function isOpenAiResponsesChatHostModel(modelId: string): boolean {
  const canonical = canonicalModelId(modelId);
  if (!canonical || isGptImageModel(canonical) || isDallEModel(canonical)) {
    return false;
  }
  return /^(?:gpt-(?:4\.1|5|6)|o[34])/.test(canonical);
}

/**
 * 解析当前服务商与模型实际应采用的生图协议通道。
 *
 * 决策优先级：
 * 1. `imageApiMode === 'unsupported'` 或官方 Anthropic / DeepSeek → `'unsupported'`
 * 2. 显式指定的非 `'auto'` 模式 → 原样返回
 * 3. 中转站 / 自定义兼容端点 → 统一降级 `'openai-images'`
 * 4. 官方 Gemini → `'gemini-generate-content'`；官方 xAI → `'xai-json'`
 * 5. 官方 OpenAI 对话宿主模型 → `'openai-responses'`；其余（GPT-Image / DALL-E / Ark / Bailian） → `'openai-images'`
 */
export function resolveImageApiMode(
  provider: ProviderProfile,
  modelId?: string
): Exclude<ProviderImageApiMode, 'auto'> {
  if (provider.imageApiMode === 'unsupported') {
    return 'unsupported';
  }
  if (
    (provider.kind === 'anthropic' || provider.kind === 'deepseek') &&
    !isRelayOrCustomProvider(provider)
  ) {
    return 'unsupported';
  }
  if (provider.imageApiMode && provider.imageApiMode !== 'auto') {
    return provider.imageApiMode;
  }
  if (isRelayOrCustomProvider(provider)) {
    return 'openai-images';
  }
  if (provider.kind === 'gemini') {
    return 'gemini-generate-content';
  }
  if (provider.kind === 'xai-grok') {
    return 'xai-json';
  }
  if (
    provider.kind === 'openai-compatible' &&
    isExactOfficialOpenAiProvider(provider) &&
    modelId &&
    isOpenAiResponsesChatHostModel(modelId)
  ) {
    return 'openai-responses';
  }
  return 'openai-images';
}

function resolveImagesBaseUrl(provider: ProviderProfile): string {
  const inspection = inspectProviderEndpoint(provider.baseUrl, { kind: provider.kind });
  if (!inspection.valid || !inspection.normalizedBaseUrl) {
    throw new Error(inspection.errors[0] ?? '服务商 Base URL 无效，无法发起图片生成请求。');
  }
  return inspection.normalizedBaseUrl.replace(/\/(?:images\/generations|images\/edits)$/i, '');
}

function normalizedMimeType(mimeType?: string): string | undefined {
  if (!mimeType) {
    return undefined;
  }
  const normalized = mimeType.split(';', 1)[0]?.trim().toLowerCase();
  return normalized || undefined;
}

function validateImageGenerationRequest(args: UnifiedImageGenerationRequest): {
  mode: Exclude<ProviderImageApiMode, 'auto'>;
  modelId: string;
  prompt: string;
  referenceImages: MediaAttachment[];
} {
  if (args.signal?.aborted) {
    throw createAbortError();
  }

  const mode = resolveImageApiMode(args.provider, args.modelId);
  if (mode === 'unsupported') {
    throw new Error('当前服务商不支持原生图片生成，请切换至 OpenAI、Gemini 或 xAI 生图模型。');
  }

  const modelId = args.modelId?.trim() ?? '';
  if (!modelId) {
    throw new Error('请先选择图片生成模型。');
  }

  if (isExactOfficialOpenAiProvider(args.provider) && canonicalModelId(modelId) === 'gpt-image-1') {
    throw new Error(
      'OpenAI 官方 gpt-image-1 已下线，请切换至 gpt-image-2.5-sunburst、gpt-image-2.5-flare 或 gpt-image-1.5。'
    );
  }

  const prompt = args.prompt?.trim() ?? '';
  if (!prompt) {
    throw new Error('请先输入图片生成提示词（prompt）。');
  }

  const count = args.options?.count;
  if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > maxImageCount)) {
    throw new Error(`图片生成数量（count）必须在 1 到 ${maxImageCount} 之间（上限 ${maxImageCount} 张）。`);
  }

  const referenceImages = args.options?.referenceImages ?? [];
  if (referenceImages.length > maxReferenceImages) {
    throw new Error(`参考图片数量超过上限（最多支持 ${maxReferenceImages} 张）。`);
  }

  for (const attachment of referenceImages) {
    if (attachment.kind !== 'image') {
      throw new Error(
        `参考图「${attachment.name}」格式不受支持，仅支持 PNG、JPEG、WEBP、GIF 图片。`
      );
    }
    const mime = normalizedMimeType(attachment.mimeType);
    if (mime && !supportedReferenceMimeTypes.has(mime)) {
      throw new Error(
        `参考图「${attachment.name}」的 MIME 类型（${mime}）不受支持，仅支持 PNG、JPEG、WEBP、GIF 图片。`
      );
    }
  }

  return { mode, modelId, prompt, referenceImages };
}

function aspectRatioToOpenAiSize(aspectRatio: ImageAspectRatio | undefined, modelId: string): string {
  const dallE = isDallEModel(modelId);
  switch (aspectRatio) {
    case '16:9':
    case '3:2':
    case '21:9':
    case '4:3':
      return dallE ? '1792x1024' : '1536x1024';
    case '9:16':
    case '2:3':
    case '3:4':
      return dallE ? '1024x1792' : '1024x1536';
    case '1:1':
    default:
      return '1024x1024';
  }
}

function mapDallEQuality(quality: ImageGenerationOptions['quality']): string | undefined {
  if (!quality) {
    return undefined;
  }
  return quality === 'high' ? 'hd' : 'standard';
}

function parseDataUri(uri: string): { mimeType?: string; base64?: string } {
  const match = uri.match(/^data:([^;,]+)?(?:;[^,]*)?,(.*)$/i);
  if (!match) {
    return {};
  }
  return {
    mimeType: match[1]?.trim().toLowerCase(),
    base64: match[2]?.trim(),
  };
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const cleaned = base64.replace(/\s+/g, '');
  if (typeof atob === 'function') {
    const binary = atob(cleaned);
    const buffer = new ArrayBuffer(binary.length);
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  const nodeBuf = Buffer.from(cleaned, 'base64');
  const buffer = new ArrayBuffer(nodeBuf.byteLength);
  const bytes = new Uint8Array(buffer);
  bytes.set(nodeBuf);
  return bytes;
}

async function resolveReferenceBinary(
  attachment: MediaAttachment
): Promise<{ bytes: Uint8Array<ArrayBuffer>; mimeType: string; filename: string; dataUrl: string }> {
  const materialized = await materializeAttachment(attachment);
  const parsedUri = materialized.uri.startsWith('data:') ? parseDataUri(materialized.uri) : {};
  const rawBase64 = materialized.base64
    ? materialized.base64.startsWith('data:')
      ? parseDataUri(materialized.base64).base64
      : materialized.base64
    : parsedUri.base64;

  const mimeType =
    normalizedMimeType(materialized.mimeType) ??
    normalizedMimeType(parsedUri.mimeType) ??
    'image/png';
  const filename = materialized.name?.trim() || `${materialized.id || 'reference'}.png`;

  if (rawBase64) {
    const cleanB64 = rawBase64.replace(/\s+/g, '');
    return {
      bytes: base64ToBytes(cleanB64),
      mimeType,
      filename,
      dataUrl: `data:${mimeType};base64,${cleanB64}`,
    };
  }

  throw new Error(`参考图「${attachment.name}」缺少可用的本地图像数据，请重新选择后重试。`);
}

function readTokenUsage(payload: unknown): ChatTokenUsage | undefined {
  if (!isRecord(payload) || !isRecord(payload.usage)) {
    return undefined;
  }
  const usage = payload.usage;
  const inputTokens =
    typeof usage.input_tokens === 'number'
      ? usage.input_tokens
      : typeof usage.prompt_tokens === 'number'
        ? usage.prompt_tokens
        : undefined;
  const outputTokens =
    typeof usage.output_tokens === 'number'
      ? usage.output_tokens
      : typeof usage.completion_tokens === 'number'
        ? usage.completion_tokens
        : undefined;
  const totalTokens = typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined;

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

interface ParsedGeneratedImageItem {
  uri: string;
  mimeType: string;
  revisedPrompt?: string;
}

function isSafeInlineImageDataUrl(value: string): boolean {
  return /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=\s]+$/i.test(value.trim());
}

function extractOpenAiStyleImages(payload: unknown): ParsedGeneratedImageItem[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    return [];
  }

  const results: ParsedGeneratedImageItem[] = [];
  for (const item of payload.data) {
    if (!isRecord(item)) {
      continue;
    }
    const revisedPrompt = nonEmptyText(item.revised_prompt);
    const directUrl =
      nonEmptyText(item.url) ??
      (isRecord(item.image_url) ? nonEmptyText(item.image_url.url) : undefined);
    const b64 = nonEmptyText(item.b64_json) ?? nonEmptyText(item.base64);

    if (directUrl) {
      const safeUrl = isSafeInlineImageDataUrl(directUrl)
        ? directUrl
        : safePublicHttpsUrl(directUrl);
      if (safeUrl) {
        results.push({
          uri: safeUrl,
          mimeType: 'image/png',
          ...(revisedPrompt ? { revisedPrompt } : {}),
        });
      }
      continue;
    }
    if (b64) {
      const uri = b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`;
      results.push({
        uri,
        mimeType: 'image/png',
        ...(revisedPrompt ? { revisedPrompt } : {}),
      });
    }
  }
  return results;
}

async function persistGeneratedAttachmentsSafely(
  attachments: MediaAttachment[]
): Promise<{ attachments: MediaAttachment[]; hasFailedRemoteDownload: boolean }> {
  const persistedList = await Promise.all(
    attachments.map(async (attachment) => {
      const wasRemote = /^https?:\/\//i.test(attachment.uri);
      try {
        const persisted = await persistAttachment(attachment, { downloadRemote: true });
        return {
          attachment: persisted,
          failedRemote: wasRemote && /^https?:\/\//i.test(persisted.uri),
        };
      } catch {
        // 下载远程链接或本地持久化失败时保留原附件，避免整次生图结果丢失
        return {
          attachment,
          failedRemote: wasRemote,
        };
      }
    })
  );

  return {
    attachments: persistedList.map((entry) => entry.attachment),
    hasFailedRemoteDownload: persistedList.some((entry) => entry.failedRemote),
  };
}

function buildImageResultContent(options: {
  baseMessage: string;
  hasFailedRemoteDownload: boolean;
  revisedPrompts?: string[];
}): string {
  const parts = [options.baseMessage];
  if (options.revisedPrompts?.length) {
    parts.push(`提示词优化：${options.revisedPrompts.join('；')}`);
  }
  if (options.hasFailedRemoteDownload) {
    parts.push('部分远程图片未能复制到本地，链接可能随时失效，请尽快导出。');
  }
  return parts.join('\n');
}

async function executeOpenAiImagesGeneration(
  args: UnifiedImageGenerationRequest,
  modelId: string,
  prompt: string,
  referenceImages: MediaAttachment[]
): Promise<ChatCompletionResult> {
  const baseUrl = resolveImagesBaseUrl(args.provider);
  const size = aspectRatioToOpenAiSize(args.options?.aspectRatio, modelId);
  const count = args.options?.count;
  const authHeadersMap = resolveProviderAuthHeaders(args.provider);
  const dallE = isDallEModel(modelId);
  const gptImage = isGptImageModel(modelId);

  let endpoint: string;
  let headers: Record<string, string>;
  let body: BodyInit;

  if (referenceImages.length > 0) {
    endpoint = `${baseUrl}/images/edits`;
    const formData = new FormData();
    formData.append('model', modelId);
    formData.append('prompt', prompt);
    formData.append('size', size);
    if (count !== undefined) {
      formData.append('n', String(count));
    }
    const resolvedQuality = dallE
      ? mapDallEQuality(args.options?.quality)
      : args.options?.quality;
    if (resolvedQuality) {
      formData.append('quality', resolvedQuality);
    }

    const resolvedRefs = await Promise.all(referenceImages.map(resolveReferenceBinary));
    if (resolvedRefs.length === 1) {
      const ref = resolvedRefs[0];
      formData.append('image', new Blob([ref.bytes], { type: ref.mimeType }), ref.filename);
    } else {
      for (const ref of resolvedRefs) {
        formData.append('image[]', new Blob([ref.bytes], { type: ref.mimeType }), ref.filename);
      }
    }

    // FormData 必须由运行时自动生成带 boundary 的 Content-Type，大小写无关剔除自定义 Content-Type 防止覆写
    const sanitizedMultipartAuthHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(authHeadersMap)) {
      if (key.toLowerCase() !== 'content-type') {
        sanitizedMultipartAuthHeaders[key] = value;
      }
    }

    headers = {
      Accept: 'application/json',
      ...sanitizedMultipartAuthHeaders,
    };
    body = formData;
  } else {
    endpoint = `${baseUrl}/images/generations`;
    const payload: Record<string, unknown> = {
      model: modelId,
      prompt,
      size,
      ...(count !== undefined ? { n: count } : {}),
    };
    const resolvedQuality = dallE
      ? mapDallEQuality(args.options?.quality)
      : args.options?.quality;
    if (resolvedQuality) {
      payload.quality = resolvedQuality;
    }
    if (dallE) {
      payload.response_format = 'b64_json';
    } else if (gptImage) {
      // GPT Image 系列不支持 response_format 参数，使用 output_format 指定输出格式
      payload.output_format = 'png';
    } else {
      // 通用 OpenAI 兼容或未知生图模型优先尝试 b64_json，部分中转/兼容端点支持
      payload.response_format = 'b64_json';
    }

    headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...authHeadersMap,
    };
    body = JSON.stringify(payload);
  }

  const payload = await guardedImageFetch(
    endpoint,
    {
      method: 'POST',
      headers,
      body,
      signal: args.signal,
      redirect: 'error',
    },
    async (response, requestSignal) => {
      if (!response.ok) {
        const errText = await readLimitedResponseText(
          response,
          maxErrorResponseBytes,
          '图片生成',
          requestSignal
        );
        throw new Error(
          `图片生成请求失败：${response.status} ${sanitizeErrorSnippet(errText, args.provider.apiKey)}`
        );
      }

      const rawText = await readLimitedResponseText(
        response,
        maxGeneratedImageResponseBytes,
        '图片生成',
        requestSignal
      );
      return JSON.parse(rawText) as unknown;
    },
    args.fetchImpl
  ).catch((error) => {
    if (isAbortError(error)) {
      throw error;
    }
    throw sanitizeErrorMessage(error, args.provider.apiKey);
  });

  const parsedItems = extractOpenAiStyleImages(payload);
  if (parsedItems.length === 0) {
    throw new Error('图片生成未返回任何有效图片数据。');
  }

  const now = Date.now();
  const initialAttachments: MediaAttachment[] = parsedItems.map((item, index) => ({
    id: `generated-image-${now}-${index}`,
    kind: 'image',
    uri: item.uri,
    name: `${modelId}-${index + 1}.png`,
    mimeType: item.mimeType,
  }));

  const { attachments, hasFailedRemoteDownload } =
    await persistGeneratedAttachmentsSafely(initialAttachments);
  const revisedPrompts = parsedItems
    .map((item) => item.revisedPrompt)
    .filter((value): value is string => Boolean(value));

  return {
    content: buildImageResultContent({
      baseMessage: '图片生成完成。',
      hasFailedRemoteDownload,
      revisedPrompts,
    }),
    usage: readTokenUsage(payload),
    attachments,
    raw: payload,
  };
}

async function executeXaiJsonImageGeneration(
  args: UnifiedImageGenerationRequest,
  modelId: string,
  prompt: string,
  referenceImages: MediaAttachment[]
): Promise<ChatCompletionResult> {
  const baseUrl = resolveImagesBaseUrl(args.provider);
  const authHeadersMap = resolveProviderAuthHeaders(args.provider);
  const count = args.options?.count;
  const aspectRatio = args.options?.aspectRatio;

  let endpoint: string;
  let payload: Record<string, unknown>;

  if (referenceImages.length > 0) {
    endpoint = `${baseUrl}/images/edits`;
    const resolvedRefs = await Promise.all(referenceImages.map(resolveReferenceBinary));
    const dataUrls = resolvedRefs.map((ref) => ref.dataUrl);
    payload = {
      model: modelId,
      prompt,
      ...(dataUrls.length === 1
        ? { image: { url: dataUrls[0], type: 'image_url' } }
        : { images: dataUrls.map((url) => ({ url, type: 'image_url' })) }),
      ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
      ...(count !== undefined ? { n: count } : {}),
      response_format: 'b64_json',
    };
  } else {
    endpoint = `${baseUrl}/images/generations`;
    payload = {
      model: modelId,
      prompt,
      ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
      ...(count !== undefined ? { n: count } : {}),
      response_format: 'b64_json',
    };
  }

  const responsePayload = await guardedImageFetch(
    endpoint,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...authHeadersMap,
      },
      body: JSON.stringify(payload),
      signal: args.signal,
      redirect: 'error',
    },
    async (response, requestSignal) => {
      if (!response.ok) {
        const errText = await readLimitedResponseText(
          response,
          maxErrorResponseBytes,
          'xAI 图片生成',
          requestSignal
        );
        throw new Error(
          `图片生成请求失败：${response.status} ${sanitizeErrorSnippet(errText, args.provider.apiKey)}`
        );
      }

      const rawText = await readLimitedResponseText(
        response,
        maxGeneratedImageResponseBytes,
        'xAI 图片生成',
        requestSignal
      );
      return JSON.parse(rawText) as unknown;
    },
    args.fetchImpl
  ).catch((error) => {
    if (isAbortError(error)) {
      throw error;
    }
    throw sanitizeErrorMessage(error, args.provider.apiKey);
  });

  const parsedItems = extractOpenAiStyleImages(responsePayload);
  if (parsedItems.length === 0) {
    throw new Error('xAI 图片生成未返回任何有效图片数据。');
  }

  const now = Date.now();
  const initialAttachments: MediaAttachment[] = parsedItems.map((item, index) => ({
    id: `xai-generated-image-${now}-${index}`,
    kind: 'image',
    uri: item.uri,
    name: `${modelId}-${index + 1}.png`,
    mimeType: item.mimeType,
  }));

  const { attachments, hasFailedRemoteDownload } =
    await persistGeneratedAttachmentsSafely(initialAttachments);

  return {
    content: buildImageResultContent({
      baseMessage: '图片生成完成。',
      hasFailedRemoteDownload,
    }),
    usage: readTokenUsage(responsePayload),
    attachments,
    raw: responsePayload,
  };
}

function extractResponsesRevisedPrompts(raw: unknown): string[] {
  if (!isRecord(raw) || !Array.isArray(raw.output)) {
    return [];
  }
  const prompts: string[] = [];
  for (const item of raw.output) {
    if (isRecord(item) && item.type === 'image_generation_call') {
      const revised = nonEmptyText(item.revised_prompt);
      if (revised) {
        prompts.push(revised);
      }
    }
  }
  return prompts;
}

async function executeOpenAiResponsesImageGeneration(
  args: UnifiedImageGenerationRequest,
  modelId: string,
  prompt: string,
  referenceImages: MediaAttachment[]
): Promise<ChatCompletionResult> {
  const hostModelId = isOpenAiImageGenerationModel(modelId) ? 'gpt-5.4' : modelId;
  const size = aspectRatioToOpenAiSize(args.options?.aspectRatio, modelId);

  const imageTool: Record<string, unknown> = {
    type: 'image_generation',
    size,
    ...(args.options?.quality ? { quality: args.options.quality } : {}),
    ...(args.options?.count !== undefined ? { n: args.options.count } : {}),
  };

  let requestMessages: ChatMessage[];
  if (args.messages?.length) {
    requestMessages = args.messages.map((msg) => ({ ...msg }));
    if (referenceImages.length > 0) {
      for (let i = requestMessages.length - 1; i >= 0; i -= 1) {
        if (requestMessages[i].role === 'user' && requestMessages[i].status === 'ready') {
          const existing = requestMessages[i].attachments ?? [];
          const seen = new Set(existing.map((att) => att.id));
          requestMessages[i].attachments = [
            ...existing,
            ...referenceImages.filter((att) => !seen.has(att.id)),
          ];
          break;
        }
      }
    }
  } else {
    requestMessages = [
      {
        id: `responses-img-user-${Date.now()}`,
        role: 'user',
        content: prompt,
        createdAt: Date.now(),
        status: 'ready',
        ...(referenceImages.length > 0 ? { attachments: referenceImages } : {}),
      },
    ];
  }

  const result = await sendOpenAiResponsesChat({
    provider: args.provider,
    modelId: hostModelId,
    messages: requestMessages,
    stream: true,
    tools: [imageTool],
    allowCustomEndpoint: true,
    signal: args.signal,
    fetchImpl: args.fetchImpl,
  }).catch((error) => {
    if (isAbortError(error)) {
      throw error;
    }
    throw sanitizeErrorMessage(error, args.provider.apiKey);
  });

  if (!result.attachments?.length) {
    throw new Error('Responses 生图工具未返回任何有效图片数据。');
  }

  const { attachments, hasFailedRemoteDownload } = await persistGeneratedAttachmentsSafely(
    result.attachments
  );
  const revisedPrompts = extractResponsesRevisedPrompts(result.raw);
  const baseMessage = result.content.trim()
    ? `${result.content.trim()}\n已通过 Responses 工具完成绘图。`
    : '已通过 Responses 工具完成绘图。';

  return {
    ...result,
    content: buildImageResultContent({
      baseMessage,
      hasFailedRemoteDownload,
      revisedPrompts,
    }),
    attachments,
  };
}

async function executeGeminiImageGeneration(
  args: UnifiedImageGenerationRequest,
  modelId: string,
  prompt: string,
  referenceImages: MediaAttachment[]
): Promise<ChatCompletionResult> {
  const now = Date.now();
  let requestMessages: ChatMessage[];

  if (args.messages?.length) {
    requestMessages = args.messages;
  } else if (args.continuationBlocks?.length) {
    // 当调用方仅传续接块与参考图进行多轮改图时，合成包含 thoughtSignature 的历史 model 轮次
    requestMessages = [
      {
        id: `gemini-img-u0-${now}`,
        role: 'user',
        content: '(previous image generation request)',
        createdAt: now - 2,
        status: 'ready',
      },
      {
        id: `gemini-img-a1-${now}`,
        role: 'assistant',
        content: '',
        createdAt: now - 1,
        status: 'ready',
        ...(referenceImages.length > 0 ? { attachments: referenceImages } : {}),
        providerContinuations: args.continuationBlocks,
      },
      {
        id: `gemini-img-u1-${now}`,
        role: 'user',
        content: prompt,
        createdAt: now,
        status: 'ready',
        ...(referenceImages.length > 0 ? { attachments: referenceImages } : {}),
      },
    ];
  } else {
    requestMessages = [
      {
        id: `gemini-img-u1-${now}`,
        role: 'user',
        content: prompt,
        createdAt: now,
        status: 'ready',
        ...(referenceImages.length > 0 ? { attachments: referenceImages } : {}),
      },
    ];
  }

  const result = await sendGeminiNativeChat({
    provider: args.provider,
    modelId,
    messages: requestMessages,
    attachments: referenceImages.length > 0 ? referenceImages : undefined,
    imageOptions: args.options,
    reasoningEffort: 'default',
    stream: false,
    signal: args.signal,
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
  }).catch((error) => {
    if (isAbortError(error)) {
      throw error;
    }
    throw sanitizeErrorMessage(error, args.provider.apiKey);
  });

  if (!result.attachments?.length) {
    throw new Error('Gemini 生图未返回任何有效图片数据。');
  }

  const { attachments, hasFailedRemoteDownload } = await persistGeneratedAttachmentsSafely(
    result.attachments
  );
  const baseMessage = result.content.trim() || '图片生成完成。';

  return {
    ...result,
    content: buildImageResultContent({
      baseMessage,
      hasFailedRemoteDownload,
    }),
    attachments,
  };
}

/**
 * 统一跨协议图片生成与参考图编辑入口。
 *
 * 完整支持 OpenAI Images (`/v1/images/generations` & multipart `/v1/images/edits`)、
 * OpenAI Responses (`image_generation` 工具)、Google Gemini 原生生图与 `thoughtSignature` 多轮改图、
 * xAI Grok JSON 生图/改图，以及火山方舟 / 阿里百炼 / 中转兼容端点，并统一完成附件本地持久化。
 */
export async function generateImages(
  args: UnifiedImageGenerationRequest
): Promise<ChatCompletionResult> {
  try {
    const { mode, modelId, prompt, referenceImages } = validateImageGenerationRequest(args);

    switch (mode) {
      case 'openai-images':
        return await executeOpenAiImagesGeneration(args, modelId, prompt, referenceImages);
      case 'openai-responses':
        return await executeOpenAiResponsesImageGeneration(args, modelId, prompt, referenceImages);
      case 'gemini-generate-content':
        return await executeGeminiImageGeneration(args, modelId, prompt, referenceImages);
      case 'xai-json':
        return await executeXaiJsonImageGeneration(args, modelId, prompt, referenceImages);
      default:
        throw new Error('当前服务商不支持原生图片生成，请切换至 OpenAI、Gemini 或 xAI 生图模型。');
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw sanitizeErrorMessage(error, args.provider.apiKey);
  }
}
