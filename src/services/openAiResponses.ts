import type {
  ChatCompletionResult,
  ChatMessage,
  ChatTokenUsage,
  MediaAttachment,
  ProviderProfile,
  ReasoningEffort,
} from '../domain/types';

export type OpenAiResponsesWireEffort = 'low' | 'medium' | 'high' | 'xhigh';

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

export interface OpenAiResponsesRequestBody {
  model: string;
  input: OpenAiResponsesInputMessage[];
  store: false;
  reasoning?: {
    effort: OpenAiResponsesWireEffort;
  };
}

export interface OpenAiResponsesRequest {
  url: string;
  body: OpenAiResponsesRequestBody;
}

export interface BuildOpenAiResponsesRequestArgs {
  provider: Pick<ProviderProfile, 'baseUrl'>;
  modelId: string;
  messages: ChatMessage[];
  reasoningEffort?: ReasoningEffort;
}

export const openAiResponsesLimits = Object.freeze({
  maxMessages: 1_000,
  maxInputTextCharacters: 2_000_000,
  maxInlineImageBytes: 20 * 1024 * 1024,
  maxInlineFileBytes: 20 * 1024 * 1024,
  maxResponseJsonBytes: 16 * 1024 * 1024,
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
      url.hostname.toLowerCase() !== 'api.openai.com' ||
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

function privateIpv4(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return false;
  }
  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) {
    return true;
  }
  return (
    octets[0] === 0 ||
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function localHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal') ||
    normalized.endsWith('.lan') ||
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized)
  ) {
    return true;
  }
  if (normalized.startsWith('::ffff:')) {
    return privateIpv4(normalized.slice('::ffff:'.length));
  }
  if (privateIpv4(normalized)) {
    return true;
  }
  return !normalized.includes('.') && !normalized.includes(':');
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

export function toOpenAiResponsesInput(messages: ChatMessage[]): OpenAiResponsesInputMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    return protocolError('Responses API 至少需要一条输入消息。');
  }
  if (messages.length > openAiResponsesLimits.maxMessages) {
    return protocolError(`输入消息过多，上限为 ${openAiResponsesLimits.maxMessages} 条。`);
  }

  let totalTextCharacters = 0;
  return messages.map((message, messageIndex) => {
    if (!message || typeof message.content !== 'string') {
      return protocolError(`第 ${messageIndex + 1} 条消息的文本无效。`);
    }
    if (!['system', 'user', 'assistant'].includes(message.role)) {
      return protocolError(`第 ${messageIndex + 1} 条消息的角色无效。`);
    }
    if (message.status !== 'ready') {
      return protocolError(`第 ${messageIndex + 1} 条消息尚未完成，不能发送给 Responses API。`);
    }

    totalTextCharacters += message.content.length;
    if (totalTextCharacters > openAiResponsesLimits.maxInputTextCharacters) {
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
  });
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

export function buildOpenAiResponsesRequest({
  provider,
  modelId,
  messages,
  reasoningEffort = 'default',
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

  return {
    url: getOpenAiResponsesEndpoint(provider),
    body,
  };
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

function reasoningSummary(payload: Record<string, unknown>): string | undefined {
  if (!Array.isArray(payload.output)) {
    return undefined;
  }
  const summaries: string[] = [];
  for (const item of payload.output) {
    if (!isRecord(item) || item.type !== 'reasoning' || !Array.isArray(item.summary)) {
      continue;
    }
    for (const summary of item.summary) {
      if (
        isRecord(summary) &&
        summary.type === 'summary_text' &&
        typeof summary.text === 'string' &&
        summary.text.trim()
      ) {
        summaries.push(summary.text.trim());
      }
    }
  }
  if (!summaries.length) {
    return undefined;
  }
  return boundedOutput(summaries.join('\n\n'), 'Responses 推理摘要');
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

export function parseOpenAiResponsesResponse(payload: unknown): ChatCompletionResult {
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
  if (!content.trim() && !reasoningContent) {
    return protocolError('Responses API 没有返回输出文本或推理摘要。');
  }

  return {
    content,
    reasoningContent,
    usage: tokenUsage(parsed),
    raw: parsed,
  };
}
