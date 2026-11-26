import type {
  ChatMessage,
  ChatTokenUsage,
  ProviderContinuationBlock,
  ProviderProfile,
  ToolActivityItem,
} from '../domain/types';
import { isWeakSearchTitle, titleFromSearchUrl } from './externalSearch';
import type { OpenAiResponsesInputMessage } from './openAiResponses';
import {
  parseOpenAiResponsesResponse,
  toOpenAiResponsesInput,
} from './openAiResponses';
import {
  isExactOfficialAnthropicProvider,
  isExactOfficialDeepSeekProvider,
  isExactOfficialGeminiProvider,
  isExactOfficialXaiProvider,
  isRelayOrCustomProvider,
} from './providerSetup';
import { isBlockedPublicHost } from './ssrfGuard';

export type ProviderWebSearchProtocol =
  | 'openai-official'
  | 'anthropic-official'
  | 'gemini-official'
  | 'xai-official'
  | 'deepseek-official'
  | 'volcengine-ark'
  | 'bailian-compatible';

export type OpenAiWebSearchContextSize = 'low' | 'medium' | 'high';
export type AnthropicWebSearchToolType = 'web_search_20250305' | 'web_search_20260209';

export interface ProviderWebSearchCitation {
  url: string;
  title?: string;
  startIndex: number;
  endIndex: number;
}

export interface ProviderWebSearchResult {
  content: string;
  reasoningContent?: string;
  usage?: ChatTokenUsage;
  citations: ProviderWebSearchCitation[];
  webSearchTriggered: boolean;
  toolActivity?: ToolActivityItem[];
  providerContinuations?: ProviderContinuationBlock[];
}

export interface BuildProviderWebSearchRequestArgs {
  provider: ProviderProfile;
  modelId: string;
  messages: ChatMessage[];
  searchContextSize?: OpenAiWebSearchContextSize;
  anthropicToolType?: AnthropicWebSearchToolType;
  maxOutputTokens?: number;
}

export interface ProviderWebSearchRequestBody {
  model?: string;
  input?: OpenAiResponsesInputMessage[];
  messages?: Array<Record<string, unknown>>;
  contents?: Array<Record<string, unknown>>;
  system?: string;
  systemInstruction?: { parts: Array<{ text: string }> };
  generationConfig?: { maxOutputTokens?: number };
  tools: Array<Record<string, unknown>>;
  store?: false;
  max_output_tokens?: number;
  max_tokens?: number;
}

export interface ProviderWebSearchRequest {
  protocol: ProviderWebSearchProtocol;
  url: string;
  body: ProviderWebSearchRequestBody;
}

export interface ParseProviderWebSearchResponseArgs {
  provider: ProviderProfile;
  payload: unknown;
}

export type ProviderWebSearchCapability =
  | {
      supported: true;
      mode: 'official-hosted';
      protocol: ProviderWebSearchProtocol;
    }
  | {
      supported: false;
      mode: 'client-external-fallback';
      isRelay: boolean;
      reason: string;
    };

export class ProviderWebSearchProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderWebSearchProtocolError';
  }
}

const openAiContextSizes = new Set<OpenAiWebSearchContextSize>(['low', 'medium', 'high']);
const arkHosts = new Set([
  'ark.cn-beijing.volces.com',
  'ark.cn-beijing.volcengineapi.com',
]);
const bailianLegacyHosts = new Set([
  'dashscope.aliyuncs.com',
  'dashscope-intl.aliyuncs.com',
  'dashscope-us.aliyuncs.com',
]);
const bailianWorkspaceHost = /^[a-z0-9][a-z0-9-]*\.(?:cn-beijing|ap-southeast-1|ap-northeast-1|eu-central-1|us-east-1)\.maas\.aliyuncs\.com$/;

function protocolError(message: string): never {
  throw new ProviderWebSearchProtocolError(message);
}

function parsedProviderUrl(provider: ProviderProfile): URL {
  let url: URL;
  try {
    url = new URL(provider.baseUrl.trim());
  } catch {
    return protocolError('供应商 Base URL 不是有效网址。');
  }

  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    return protocolError('联网搜索 Base URL 必须是无凭据、端口、查询参数和片段的 HTTPS 官方地址。');
  }
  return url;
}

function normalizedPath(url: URL): string {
  return url.pathname.replace(/\/+$/, '').toLowerCase();
}

function assertSupportedPath(url: URL, paths: ReadonlySet<string>, label: string): void {
  if (!paths.has(normalizedPath(url))) {
    protocolError(`${label} Base URL 路径不受支持。`);
  }
}

/**
 * 严格判定当前服务商是否允许启用官方托管联网搜索并返回协议标识。
 * 中转站（`new-api-relay`）、仿冒域名或非 HTTPS 地址一律 fail-closed 抛出 `ProviderWebSearchProtocolError`。
 */
export function resolveProviderWebSearchProtocol(
  provider: ProviderProfile
): ProviderWebSearchProtocol {
  const url = parsedProviderUrl(provider);
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');

  if (provider.kind === 'volcengine-ark') {
    if (!arkHosts.has(host)) {
      return protocolError('火山方舟联网搜索只允许官方 Ark 数据面域名。');
    }
    assertSupportedPath(
      url,
      new Set(['', '/api/v3', '/api/v3/responses', '/api/v3/chat/completions', '/api/v3/models']),
      '火山方舟'
    );
    return 'volcengine-ark';
  }

  if (provider.kind === 'bailian-compatible') {
    if (!bailianLegacyHosts.has(host) && !bailianWorkspaceHost.test(host)) {
      return protocolError('阿里百炼联网搜索只允许官方 DashScope 或百炼业务空间域名。');
    }
    assertSupportedPath(
      url,
      new Set([
        '/compatible-mode/v1',
        '/compatible-mode/v1/responses',
        '/compatible-mode/v1/chat/completions',
        '/compatible-mode/v1/models',
      ]),
      '阿里百炼'
    );
    return 'bailian-compatible';
  }

  if (provider.kind === 'anthropic') {
    if (!isExactOfficialAnthropicProvider(provider)) {
      return protocolError('Anthropic 联网搜索只允许 api.anthropic.com 官方域名。');
    }
    return 'anthropic-official';
  }

  if (provider.kind === 'gemini') {
    if (!isExactOfficialGeminiProvider(provider)) {
      return protocolError('Gemini 联网搜索只允许 generativelanguage.googleapis.com 官方域名。');
    }
    return 'gemini-official';
  }

  if (provider.kind === 'xai-grok') {
    if (!isExactOfficialXaiProvider(provider)) {
      return protocolError('xAI Grok 联网搜索只允许 api.x.ai 官方域名。');
    }
    return 'xai-official';
  }

  if (provider.kind === 'deepseek') {
    if (!isExactOfficialDeepSeekProvider(provider)) {
      return protocolError('DeepSeek 联网搜索只允许 api.deepseek.com 官方域名。');
    }
    return 'deepseek-official';
  }

  if (provider.kind === 'custom' || provider.kind === 'openai-compatible') {
    if (provider.kind === 'custom' && host === 'api.deepseek.com') {
      if (!isExactOfficialDeepSeekProvider(provider)) {
        return protocolError('DeepSeek 联网搜索只允许 api.deepseek.com 官方域名。');
      }
      return 'deepseek-official';
    }
    if (host !== 'api.openai.com') {
      return protocolError('OpenAI 联网搜索只允许 api.openai.com 官方域名。');
    }
    assertSupportedPath(
      url,
      new Set(['', '/v1', '/v1/responses', '/v1/chat/completions', '/v1/models']),
      'OpenAI'
    );
    return 'openai-official';
  }

  return protocolError(`供应商类型 ${provider.kind} 未启用可信联网搜索协议。`);
}

/**
 * 无异常地检测服务商官方托管搜索能力；对于中转站或自定义端点，引导降级使用客户端 `externalSearch`。
 */
export function resolveProviderWebSearchCapability(
  provider: ProviderProfile
): ProviderWebSearchCapability {
  try {
    const protocol = resolveProviderWebSearchProtocol(provider);
    return {
      supported: true,
      mode: 'official-hosted',
      protocol,
    };
  } catch (error) {
    return {
      supported: false,
      mode: 'client-external-fallback',
      isRelay: isRelayOrCustomProvider(provider),
      reason:
        error instanceof Error
          ? `${error.message} 建议启用客户端外部搜索（DeepSeek Tools / Bocha / Exa / SearXNG / Tavily）通过 search_web 闭环联网。`
          : '当前服务商不支持原生托管联网搜索，建议改用客户端外部搜索。',
    };
  }
}

/**
 * 获取服务商官方托管搜索接口的规范化请求 URL。
 */
export function getProviderWebSearchEndpoint(
  provider: ProviderProfile,
  modelId?: string
): string {
  const protocol = resolveProviderWebSearchProtocol(provider);
  const url = parsedProviderUrl(provider);

  if (protocol === 'openai-official' || protocol === 'xai-official') {
    return `${url.origin}/v1/responses`;
  }
  if (protocol === 'anthropic-official') {
    return `${url.origin}/v1/messages`;
  }
  if (protocol === 'gemini-official') {
    const cleanModel = modelId?.trim();
    return cleanModel
      ? `${url.origin}/v1beta/models/${encodeURIComponent(cleanModel)}:generateContent`
      : `${url.origin}/v1beta/models`;
  }
  if (protocol === 'deepseek-official') {
    return `${url.origin}/v1/chat/completions`;
  }
  if (protocol === 'volcengine-ark') {
    return `${url.origin}/api/v3/responses`;
  }
  return `${url.origin}/compatible-mode/v1/responses`;
}

function assertTextOnlyMessages(messages: ChatMessage[], protocol: ProviderWebSearchProtocol): void {
  const allowsMultimodal =
    protocol === 'openai-official' ||
    protocol === 'xai-official' ||
    protocol === 'anthropic-official' ||
    protocol === 'gemini-official';
  if (!allowsMultimodal && messages.some((message) => (message.attachments?.length ?? 0) > 0)) {
    if (protocol === 'deepseek-official') {
      protocolError('DeepSeek 官方联网搜索仅支持纯文本对话输入。');
    }
    protocolError('火山方舟和阿里百炼联网搜索首版只允许纯文本 Responses 输入。');
  }
}

export function assertProviderWebSearchMessagesSupported(
  provider: ProviderProfile,
  messages: ChatMessage[]
): void {
  assertTextOnlyMessages(messages, resolveProviderWebSearchProtocol(provider));
}

function buildAnthropicWebSearchBody(
  modelId: string,
  messages: ChatMessage[],
  anthropicToolType: AnthropicWebSearchToolType,
  maxOutputTokens?: number
): ProviderWebSearchRequestBody {
  const systemParts: string[] = [];
  const wireMessages: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    if (message.status !== 'ready') {
      protocolError('存在未完成的消息，不能发送联网搜索请求。');
    }
    if (message.role === 'system') {
      if (message.content.trim()) {
        systemParts.push(message.content.trim());
      }
      continue;
    }
    wireMessages.push({
      role: message.role,
      content: message.content,
    });
  }

  return {
    model: modelId,
    max_tokens: maxOutputTokens ?? 4096,
    ...(systemParts.length ? { system: systemParts.join('\n\n') } : {}),
    messages: wireMessages,
    tools: [
      {
        type: anthropicToolType,
        name: 'web_search',
        max_uses: 5,
      },
    ],
  };
}

function buildGeminiWebSearchBody(
  messages: ChatMessage[],
  maxOutputTokens?: number
): ProviderWebSearchRequestBody {
  const systemParts: string[] = [];
  const contents: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    if (message.status !== 'ready') {
      protocolError('存在未完成的消息，不能发送联网搜索请求。');
    }
    if (message.role === 'system') {
      if (message.content.trim()) {
        systemParts.push(message.content.trim());
      }
      continue;
    }
    contents.push({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    });
  }

  return {
    ...(systemParts.length
      ? { systemInstruction: { parts: [{ text: systemParts.join('\n\n') }] } }
      : {}),
    contents,
    tools: [{ google_search: {} }],
    ...(maxOutputTokens !== undefined
      ? { generationConfig: { maxOutputTokens } }
      : {}),
  };
}

function buildDeepSeekWebSearchBody(
  modelId: string,
  messages: ChatMessage[],
  maxOutputTokens?: number
): ProviderWebSearchRequestBody {
  const wireMessages: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    if (message.status !== 'ready') {
      protocolError('存在未完成的消息，不能发送联网搜索请求。');
    }
    const patch =
      message.role === 'assistant'
        ? buildDeepSeekContinuationMessagePatch(message.providerContinuations)
        : undefined;
    wireMessages.push({
      role: message.role,
      content: message.content,
      ...(patch ?? {}),
    });
  }

  return {
    model: modelId,
    messages: wireMessages,
    tools: [
      { type: 'deepseek_web_search', name: 'deepseek_web_search' },
      { type: 'deepseek_read_url', name: 'deepseek_read_url' },
    ],
    ...(maxOutputTokens !== undefined ? { max_tokens: maxOutputTokens } : {}),
  };
}

/**
 * 为各官方服务商构造标准化托管联网搜索请求。
 * 注意：xAI 使用 `web_search` + `x_search`，严禁发送会返回 410 Gone 的 `search_parameters`。
 */
export function buildProviderWebSearchRequest({
  provider,
  modelId,
  messages,
  searchContextSize,
  anthropicToolType = 'web_search_20250305',
  maxOutputTokens,
}: BuildProviderWebSearchRequestArgs): ProviderWebSearchRequest {
  const protocol = resolveProviderWebSearchProtocol(provider);
  const normalizedModelId = modelId.trim();
  if (!normalizedModelId) {
    return protocolError('联网搜索请求必须指定模型 ID。');
  }

  if (searchContextSize != null && !openAiContextSizes.has(searchContextSize)) {
    return protocolError('OpenAI search_context_size 只能是 low、medium 或 high。');
  }
  if (protocol !== 'openai-official' && searchContextSize != null) {
    return protocolError('search_context_size 只适用于 OpenAI 官方 Web Search 协议。');
  }
  if (
    maxOutputTokens !== undefined &&
    (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 64 || maxOutputTokens > 131_072)
  ) {
    return protocolError('联网搜索最大输出 Token 必须是 64–131072 的整数。');
  }

  assertTextOnlyMessages(messages, protocol);

  if (protocol === 'anthropic-official') {
    return {
      protocol,
      url: getProviderWebSearchEndpoint(provider, normalizedModelId),
      body: buildAnthropicWebSearchBody(
        normalizedModelId,
        messages,
        anthropicToolType,
        maxOutputTokens
      ),
    };
  }

  if (protocol === 'gemini-official') {
    return {
      protocol,
      url: getProviderWebSearchEndpoint(provider, normalizedModelId),
      body: buildGeminiWebSearchBody(messages, maxOutputTokens),
    };
  }

  if (protocol === 'deepseek-official') {
    return {
      protocol,
      url: getProviderWebSearchEndpoint(provider, normalizedModelId),
      body: buildDeepSeekWebSearchBody(normalizedModelId, messages, maxOutputTokens),
    };
  }

  const input = toOpenAiResponsesInput(messages);

  if (protocol === 'openai-official') {
    const tool: Record<string, unknown> = { type: 'web_search' };
    if (searchContextSize) {
      tool.search_context_size = searchContextSize;
    }
    return {
      protocol,
      url: getProviderWebSearchEndpoint(provider),
      body: {
        model: normalizedModelId,
        input,
        tools: [tool],
        store: false,
        ...(maxOutputTokens !== undefined ? { max_output_tokens: maxOutputTokens } : {}),
      },
    };
  }

  if (protocol === 'xai-official') {
    return {
      protocol,
      url: getProviderWebSearchEndpoint(provider),
      body: {
        model: normalizedModelId,
        input,
        tools: [{ type: 'web_search' }, { type: 'x_search' }],
        store: false,
        ...(maxOutputTokens !== undefined ? { max_output_tokens: maxOutputTokens } : {}),
      },
    };
  }

  if (protocol === 'volcengine-ark') {
    return {
      protocol,
      url: getProviderWebSearchEndpoint(provider),
      body: {
        model: normalizedModelId,
        input,
        tools: [{ type: 'web_search', max_keyword: 3, limit: 10 }],
        ...(maxOutputTokens !== undefined ? { max_output_tokens: maxOutputTokens } : {}),
      },
    };
  }

  return {
    protocol,
    url: getProviderWebSearchEndpoint(provider),
    body: {
      model: normalizedModelId,
      input,
      tools: [{ type: 'web_search' }],
      ...(maxOutputTokens !== undefined ? { max_output_tokens: maxOutputTokens } : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unsafeCitationHostname(hostname: string): boolean {
  return isBlockedPublicHost(hostname);
}

function validatedCitationUrl(value: unknown): string | undefined {
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
    unsafeCitationHostname(url.hostname)
  ) {
    return undefined;
  }
  return url.href;
}

interface PendingCitation extends ProviderWebSearchCitation {
  partOffset: number;
}

function citationsAndEvidence(
  payload: Record<string, unknown>,
  protocol: ProviderWebSearchProtocol
): {
  citations: ProviderWebSearchCitation[];
  annotationEvidence: boolean;
  callEvidence: boolean;
} {
  const citations: ProviderWebSearchCitation[] = [];
  const seenUrls = new Set<string>();
  let annotationEvidence = false;
  let callEvidence = false;
  let joinedTextLength = 0;
  let includedMessageCount = 0;

  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (!isRecord(item)) {
      continue;
    }
    if (item.type === 'web_search_call' || item.type === 'x_search_call') {
      callEvidence = true;
    }
    if (item.type !== 'message' || !Array.isArray(item.content)) {
      continue;
    }

    let messageText = '';
    let hasIncludedPart = false;
    const pending: PendingCitation[] = [];

    for (const part of item.content) {
      if (!isRecord(part)) {
        continue;
      }
      const partText =
        part.type === 'output_text' && typeof part.text === 'string'
          ? part.text
          : part.type === 'refusal' && typeof part.refusal === 'string'
            ? part.refusal
            : undefined;
      if (partText == null) {
        continue;
      }

      const partOffset = messageText.length;
      messageText += partText;
      hasIncludedPart = true;
      if (part.annotations == null) {
        continue;
      }
      if (!Array.isArray(part.annotations)) {
        continue;
      }

      for (const annotation of part.annotations) {
        if (!isRecord(annotation)) {
          continue;
        }
        if (annotation.type !== 'url_citation') {
          continue;
        }
        if (part.type !== 'output_text') {
          continue;
        }

        const start = annotation.start_index;
        const end = annotation.end_index;
        if (
          !Number.isInteger(start) ||
          !Number.isInteger(end) ||
          (start as number) < 0 ||
          (end as number) <= (start as number) ||
          (end as number) > partText.length
        ) {
          continue;
        }

        const url = validatedCitationUrl(annotation.url);
        if (!url) {
          continue;
        }
        annotationEvidence = true;
        const rawTitle =
          typeof annotation.title === 'string' && annotation.title.trim()
            ? annotation.title.trim()
            : undefined;
        const normalizedTitle =
          protocol === 'xai-official' && rawTitle && isWeakSearchTitle(rawTitle, url)
            ? titleFromSearchUrl(url)
            : rawTitle;
        pending.push({
          url,
          ...(normalizedTitle ? { title: normalizedTitle } : {}),
          startIndex: start as number,
          endIndex: end as number,
          partOffset,
        });
      }
    }

    if (!hasIncludedPart) {
      continue;
    }
    const messageOffset = joinedTextLength + (includedMessageCount > 0 ? 2 : 0);
    for (const citation of pending) {
      if (seenUrls.has(citation.url)) {
        continue;
      }
      seenUrls.add(citation.url);
      citations.push({
        url: citation.url,
        ...(citation.title ? { title: citation.title } : {}),
        startIndex: messageOffset + citation.partOffset + citation.startIndex,
        endIndex: messageOffset + citation.partOffset + citation.endIndex,
      });
    }
    joinedTextLength = messageOffset + messageText.length;
    includedMessageCount += 1;
  }

  // xAI Responses 额外补充顶层 payload.citations
  if (protocol === 'xai-official' && Array.isArray(payload.citations)) {
    for (const entry of payload.citations) {
      const rawUrl = typeof entry === 'string' ? entry : isRecord(entry) ? entry.url : undefined;
      const url = validatedCitationUrl(rawUrl);
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);
      annotationEvidence = true;
      const rawTitle =
        isRecord(entry) && typeof entry.title === 'string' ? entry.title.trim() : '';
      const title =
        !rawTitle || isWeakSearchTitle(rawTitle, url) ? titleFromSearchUrl(url) : rawTitle;
      citations.push({
        url,
        ...(title ? { title } : {}),
        startIndex: 0,
        endIndex: 0,
      });
    }
  }

  return { citations, annotationEvidence, callEvidence };
}

function bailianWebSearchCount(payload: Record<string, unknown>): number {
  if (!isRecord(payload.usage) || payload.usage.x_tools == null) {
    return 0;
  }
  if (!isRecord(payload.usage.x_tools)) {
    return protocolError('百炼 usage.x_tools 必须是 JSON 对象。');
  }
  const webSearch = payload.usage.x_tools.web_search;
  if (webSearch == null) {
    return 0;
  }
  if (!isRecord(webSearch)) {
    return protocolError('百炼 usage.x_tools.web_search 必须是 JSON 对象。');
  }
  const count = webSearch.count;
  if (!Number.isInteger(count) || (count as number) < 0) {
    return protocolError('百炼 usage.x_tools.web_search.count 必须是非负整数。');
  }
  return count as number;
}

const DANGEROUS_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * 递归剥离 `__proto__`、`constructor`、`prototype` 等原型污染危险自有属性，返回安全的纯对象或数组。
 */
function sanitizePlainValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return undefined;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePlainValue(item, seen));
  }
  const clean: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (DANGEROUS_OBJECT_KEYS.has(key)) {
      continue;
    }
    const sanitizedChild = sanitizePlainValue((value as Record<string, unknown>)[key], seen);
    if (sanitizedChild !== undefined) {
      clean[key] = sanitizedChild;
    }
  }
  return clean;
}

function sanitizePlainRecord(value: Record<string, unknown>): Record<string, unknown> {
  return sanitizePlainValue(value) as Record<string, unknown>;
}

/**
 * 从 DeepSeek 响应对象、message 或流式 delta 中提取服务端工具调用记录 `server_tool_calls`（已清洗危险键）。
 */
export function extractDeepSeekServerToolCalls(payloadOrMessageOrDelta: unknown): unknown[] {
  if (!isRecord(payloadOrMessageOrDelta)) {
    return [];
  }
  let rawList: unknown[] = [];
  if (Array.isArray(payloadOrMessageOrDelta.server_tool_calls)) {
    rawList = payloadOrMessageOrDelta.server_tool_calls;
  } else if (
    Array.isArray(payloadOrMessageOrDelta.choices) &&
    isRecord(payloadOrMessageOrDelta.choices[0])
  ) {
    const choice = payloadOrMessageOrDelta.choices[0];
    if (isRecord(choice.message) && Array.isArray(choice.message.server_tool_calls)) {
      rawList = choice.message.server_tool_calls;
    } else if (isRecord(choice.delta) && Array.isArray(choice.delta.server_tool_calls)) {
      rawList = choice.delta.server_tool_calls;
    }
  }
  return rawList.map((entry) => sanitizePlainValue(entry));
}

/**
 * 将提取的 DeepSeek `server_tool_calls` 封装为可持久化的 `ProviderContinuationBlock`。
 */
export function toDeepSeekServerToolCallsBlock(
  serverToolCalls: unknown[]
): ProviderContinuationBlock | undefined {
  if (!Array.isArray(serverToolCalls) || !serverToolCalls.length) {
    return undefined;
  }
  return {
    provider: 'deepseek',
    type: 'server_tool_calls',
    serverToolCalls: serverToolCalls.map((entry) => sanitizePlainValue(entry)),
  };
}

/**
 * 在多轮对话序列化 DeepSeek assistant 历史消息时，提取其中的 `server_tool_calls` 续接块并生成补丁字段。
 */
export function buildDeepSeekContinuationMessagePatch(
  continuations?: ProviderContinuationBlock[]
): { server_tool_calls: unknown[] } | undefined {
  if (!Array.isArray(continuations) || !continuations.length) {
    return undefined;
  }
  const merged: unknown[] = [];
  for (const block of continuations) {
    if (
      block &&
      block.provider === 'deepseek' &&
      block.type === 'server_tool_calls' &&
      Array.isArray(block.serverToolCalls)
    ) {
      merged.push(...block.serverToolCalls.map((entry) => sanitizePlainValue(entry)));
    }
  }
  return merged.length ? { server_tool_calls: merged } : undefined;
}

/**
 * 解析 DeepSeek Chat Completions `annotations` 中的 `url_citation`（自动过滤私网与非 HTTPS URL 并按 URL 去重）。
 */
export function parseDeepSeekUrlCitations(
  annotations: unknown,
  text?: string
): ProviderWebSearchCitation[] {
  if (!Array.isArray(annotations)) {
    return [];
  }
  const citations: ProviderWebSearchCitation[] = [];
  const seenUrls = new Set<string>();
  const maxTextLen = typeof text === 'string' ? text.length : Number.MAX_SAFE_INTEGER;

  for (const rawAnnotation of annotations) {
    if (!isRecord(rawAnnotation)) continue;
    const nestedCitation = isRecord(rawAnnotation.url_citation)
      ? rawAnnotation.url_citation
      : rawAnnotation;
    if (
      rawAnnotation.type !== 'url_citation' &&
      typeof nestedCitation.url !== 'string'
    ) {
      continue;
    }
    const url = validatedCitationUrl(nestedCitation.url);
    if (!url || seenUrls.has(url)) continue;

    const rawStart = nestedCitation.start_index;
    const rawEnd = nestedCitation.end_index;
    const validRange =
      Number.isInteger(rawStart) &&
      Number.isInteger(rawEnd) &&
      (rawStart as number) >= 0 &&
      (rawEnd as number) > (rawStart as number) &&
      (rawEnd as number) <= maxTextLen;

    seenUrls.add(url);
    const title =
      typeof nestedCitation.title === 'string' && nestedCitation.title.trim()
        ? nestedCitation.title.trim()
        : undefined;
    citations.push({
      url,
      ...(title ? { title } : {}),
      startIndex: validRange ? (rawStart as number) : 0,
      endIndex: validRange ? (rawEnd as number) : 0,
    });
  }

  return citations;
}

/**
 * 将 DeepSeek `server_tool_calls`（`deepseek_web_search` / `deepseek_read_url`）映射为统一的 `ToolActivityItem[]`。
 */
export function buildDeepSeekServerToolActivity(serverToolCalls: unknown[]): ToolActivityItem[] {
  if (!Array.isArray(serverToolCalls) || !serverToolCalls.length) {
    return [];
  }
  const items: ToolActivityItem[] = [];

  serverToolCalls.forEach((rawCall, idx) => {
    if (!isRecord(rawCall)) return;
    const callType = typeof rawCall.type === 'string' ? rawCall.type.trim() : 'deepseek_web_search';
    const id = typeof rawCall.id === 'string' && rawCall.id.trim() ? rawCall.id.trim() : `ds_tool_${idx}`;
    const rawInput = isRecord(rawCall.input)
      ? rawCall.input
      : isRecord(rawCall.action)
        ? rawCall.action
        : undefined;
    const input = rawInput ? sanitizePlainRecord(rawInput) : undefined;
    const output = isRecord(rawCall.output) ? rawCall.output : undefined;
    const query =
      typeof input?.query === 'string' && input.query.trim() ? input.query.trim() : undefined;
    const targetUrl =
      typeof input?.url === 'string' && input.url.trim() ? input.url.trim() : undefined;

    const rawResults = Array.isArray(output?.results)
      ? output.results
      : Array.isArray(output?.sources)
        ? output.sources
        : [];
    const mappedItems: Array<{ title: string; url: string; text?: string }> = [];
    for (const row of rawResults) {
      if (!isRecord(row)) continue;
      const url = validatedCitationUrl(row.url);
      if (!url) continue;
      const title =
        typeof row.title === 'string' && row.title.trim() ? row.title.trim() : titleFromSearchUrl(url);
      const snippet =
        typeof row.snippet === 'string'
          ? row.snippet.trim()
          : typeof row.content === 'string'
            ? row.content.trim()
            : undefined;
      mappedItems.push({ title, url, ...(snippet ? { text: snippet } : {}) });
    }

    const isReadUrl = callType === 'deepseek_read_url';
    const title = isReadUrl
      ? targetUrl
        ? `读取网页「${targetUrl}」`
        : '读取网页'
      : query
        ? `搜索「${query}」`
        : 'DeepSeek 联网检索';
    const summary = isReadUrl
      ? typeof output?.title === 'string' && output.title.trim()
        ? `已读取：${output.title.trim()}`
        : '网页读取完成'
      : mappedItems.length
        ? `返回 ${mappedItems.length} 条结果`
        : '检索完成';

    items.push({
      id,
      toolName: isReadUrl ? 'deepseek_read_url' : 'web_search',
      title,
      ...(input ? { arguments: input } : {}),
      status: 'completed',
      summary,
      ...(mappedItems.length || query
        ? {
            content: JSON.stringify({
              ...(query ? { query } : {}),
              items: mappedItems,
            }),
          }
        : {}),
      sequence: idx,
    });
  });

  return items;
}

function parseJsonPayload(payload: unknown): Record<string, unknown> {
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (!trimmed) {
      return protocolError('联网搜索响应内容为空。');
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!isRecord(parsed)) {
        return protocolError('联网搜索响应必须是 JSON 对象。');
      }
      return parsed;
    } catch (error) {
      return protocolError(
        `联网搜索响应 JSON 无法解析：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (!isRecord(payload)) {
    return protocolError('联网搜索响应必须是 JSON 对象。');
  }
  return payload;
}

function extractChatTokenUsage(rawUsage: unknown): ChatTokenUsage | undefined {
  if (!isRecord(rawUsage)) return undefined;
  const promptTokens =
    typeof rawUsage.prompt_tokens === 'number'
      ? rawUsage.prompt_tokens
      : typeof rawUsage.input_tokens === 'number'
        ? rawUsage.input_tokens
        : undefined;
  const completionTokens =
    typeof rawUsage.completion_tokens === 'number'
      ? rawUsage.completion_tokens
      : typeof rawUsage.output_tokens === 'number'
        ? rawUsage.output_tokens
        : undefined;
  const totalTokens =
    typeof rawUsage.total_tokens === 'number' ? rawUsage.total_tokens : undefined;
  const usage: ChatTokenUsage = {
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    totalTokens,
  };
  return Object.values(usage).some((v) => typeof v === 'number') ? usage : undefined;
}

function parseDeepSeekWebSearchPayload(parsed: Record<string, unknown>): ProviderWebSearchResult {
  if (isRecord(parsed.error)) {
    const msg =
      typeof parsed.error.message === 'string' && parsed.error.message.trim()
        ? parsed.error.message.trim()
        : 'DeepSeek 返回错误';
    protocolError(`DeepSeek 联网搜索失败：${msg}`);
  }
  if (!Array.isArray(parsed.choices) || !isRecord(parsed.choices[0])) {
    return protocolError('DeepSeek 联网搜索响应缺少 choices 数组。');
  }
  const message = isRecord(parsed.choices[0].message) ? parsed.choices[0].message : {};
  const content = typeof message.content === 'string' ? message.content : '';
  const reasoningContent =
    typeof message.reasoning_content === 'string' && message.reasoning_content.trim()
      ? message.reasoning_content
      : undefined;
  const serverToolCalls = extractDeepSeekServerToolCalls(parsed);
  const continuationBlock = toDeepSeekServerToolCallsBlock(serverToolCalls);
  const toolActivity = buildDeepSeekServerToolActivity(serverToolCalls);

  const citations = parseDeepSeekUrlCitations(message.annotations, content);
  const seenUrls = new Set(citations.map((c) => c.url));

  // 同步提取 server_tool_calls 内部返回的合法公开 HTTPS URL
  for (const call of serverToolCalls) {
    if (!isRecord(call)) continue;
    const output = isRecord(call.output) ? call.output : undefined;
    const results = Array.isArray(output?.results) ? output.results : [];
    for (const row of results) {
      if (!isRecord(row)) continue;
      const url = validatedCitationUrl(row.url);
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);
      const title =
        typeof row.title === 'string' && row.title.trim() ? row.title.trim() : undefined;
      citations.push({
        url,
        ...(title ? { title } : {}),
        startIndex: 0,
        endIndex: 0,
      });
    }
  }

  if (!content.trim() && !reasoningContent && !serverToolCalls.length) {
    return protocolError('DeepSeek 联网搜索未返回文本或工具调用结果。');
  }

  return {
    content,
    ...(reasoningContent ? { reasoningContent } : {}),
    usage: extractChatTokenUsage(parsed.usage),
    citations,
    webSearchTriggered: citations.length > 0 || serverToolCalls.length > 0,
    ...(toolActivity.length ? { toolActivity } : {}),
    ...(continuationBlock ? { providerContinuations: [continuationBlock] } : {}),
  };
}

function parseAnthropicWebSearchPayload(parsed: Record<string, unknown>): ProviderWebSearchResult {
  if (parsed.type === 'error' || isRecord(parsed.error)) {
    const errObj = isRecord(parsed.error) ? parsed.error : parsed;
    const msg =
      typeof errObj.message === 'string' && errObj.message.trim()
        ? errObj.message.trim()
        : 'Anthropic 返回错误';
    protocolError(`Anthropic 联网搜索失败：${msg}`);
  }
  if (!Array.isArray(parsed.content)) {
    return protocolError('Anthropic 联网搜索响应缺少 content 数组。');
  }

  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const citations: ProviderWebSearchCitation[] = [];
  const seenUrls = new Set<string>();
  let toolEvidence = false;

  for (const block of parsed.content) {
    if (!isRecord(block)) continue;
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      thinkingParts.push(block.thinking);
    } else if (block.type === 'server_tool_use' || block.type === 'web_search_tool_result') {
      toolEvidence = true;
      if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        for (const item of block.content) {
          if (!isRecord(item)) continue;
          const url = validatedCitationUrl(item.url);
          if (!url || seenUrls.has(url)) continue;
          seenUrls.add(url);
          const title = typeof item.title === 'string' && item.title.trim() ? item.title.trim() : undefined;
          citations.push({ url, ...(title ? { title } : {}), startIndex: 0, endIndex: 0 });
        }
      }
    } else if (block.type === 'text' && typeof block.text === 'string') {
      const startOffset = textParts.join('').length;
      textParts.push(block.text);
      if (Array.isArray(block.citations)) {
        for (const c of block.citations) {
          if (!isRecord(c)) continue;
          const url = validatedCitationUrl(c.url);
          if (!url || seenUrls.has(url)) continue;
          seenUrls.add(url);
          const title = typeof c.title === 'string' && c.title.trim() ? c.title.trim() : undefined;
          citations.push({
            url,
            ...(title ? { title } : {}),
            startIndex: startOffset,
            endIndex: startOffset + block.text.length,
          });
        }
      }
    }
  }

  const content = textParts.join('');
  const reasoningContent = thinkingParts.length ? thinkingParts.join('\n\n') : undefined;
  if (!content.trim() && !reasoningContent) {
    return protocolError('Anthropic 联网搜索未返回文本或推理内容。');
  }

  return {
    content,
    ...(reasoningContent ? { reasoningContent } : {}),
    usage: extractChatTokenUsage(parsed.usage),
    citations,
    webSearchTriggered: toolEvidence || citations.length > 0,
  };
}

function parseGeminiWebSearchPayload(parsed: Record<string, unknown>): ProviderWebSearchResult {
  if (isRecord(parsed.error)) {
    const msg =
      typeof parsed.error.message === 'string' && parsed.error.message.trim()
        ? parsed.error.message.trim()
        : 'Gemini 返回错误';
    protocolError(`Gemini 联网搜索失败：${msg}`);
  }
  const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
  const firstCandidate = isRecord(candidates[0]) ? candidates[0] : undefined;
  if (!firstCandidate) {
    return protocolError('Gemini 联网搜索响应缺少 candidates 数组。');
  }

  const contentObj = isRecord(firstCandidate.content) ? firstCandidate.content : {};
  const parts = Array.isArray(contentObj.parts) ? contentObj.parts : [];
  const textParts: string[] = [];
  const thoughtParts: string[] = [];

  for (const part of parts) {
    if (!isRecord(part) || typeof part.text !== 'string') continue;
    if (part.thought === true) {
      thoughtParts.push(part.text);
    } else {
      textParts.push(part.text);
    }
  }

  const grounding = isRecord(firstCandidate.groundingMetadata)
    ? firstCandidate.groundingMetadata
    : undefined;
  const webSearchQueries = Array.isArray(grounding?.webSearchQueries)
    ? grounding.webSearchQueries
    : [];
  const groundingChunks = Array.isArray(grounding?.groundingChunks)
    ? grounding.groundingChunks
    : [];
  const citations: ProviderWebSearchCitation[] = [];
  const seenUrls = new Set<string>();

  for (const chunk of groundingChunks) {
    if (!isRecord(chunk) || !isRecord(chunk.web)) continue;
    const url = validatedCitationUrl(chunk.web.uri ?? chunk.web.url);
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    const title =
      typeof chunk.web.title === 'string' && chunk.web.title.trim()
        ? chunk.web.title.trim()
        : undefined;
    citations.push({ url, ...(title ? { title } : {}), startIndex: 0, endIndex: 0 });
  }

  const content = textParts.join('');
  const reasoningContent = thoughtParts.length ? thoughtParts.join('\n\n') : undefined;
  if (!content.trim() && !reasoningContent) {
    return protocolError('Gemini 联网搜索未返回文本或推理内容。');
  }

  const usageMeta = isRecord(parsed.usageMetadata) ? parsed.usageMetadata : undefined;
  const usage: ChatTokenUsage | undefined = usageMeta
    ? {
        inputTokens:
          typeof usageMeta.promptTokenCount === 'number' ? usageMeta.promptTokenCount : undefined,
        outputTokens:
          typeof usageMeta.candidatesTokenCount === 'number'
            ? usageMeta.candidatesTokenCount
            : undefined,
        reasoningTokens:
          typeof usageMeta.thoughtsTokenCount === 'number'
            ? usageMeta.thoughtsTokenCount
            : undefined,
        totalTokens:
          typeof usageMeta.totalTokenCount === 'number' ? usageMeta.totalTokenCount : undefined,
      }
    : undefined;

  return {
    content,
    ...(reasoningContent ? { reasoningContent } : {}),
    ...(usage && Object.values(usage).some((v) => typeof v === 'number') ? { usage } : {}),
    citations,
    webSearchTriggered:
      webSearchQueries.length > 0 || groundingChunks.length > 0 || citations.length > 0,
  };
}

/**
 * 解析各官方服务商联网搜索响应载荷，输出统一的正文、推理、引用列表与联网触发证据标识。
 */
export function parseProviderWebSearchResponse({
  provider,
  payload,
}: ParseProviderWebSearchResponseArgs): ProviderWebSearchResult {
  const protocol = resolveProviderWebSearchProtocol(provider);
  const parsedJson = parseJsonPayload(payload);

  if (protocol === 'deepseek-official') {
    return parseDeepSeekWebSearchPayload(parsedJson);
  }
  if (protocol === 'anthropic-official') {
    return parseAnthropicWebSearchPayload(parsedJson);
  }
  if (protocol === 'gemini-official') {
    return parseGeminiWebSearchPayload(parsedJson);
  }

  let parsedResult: ReturnType<typeof parseOpenAiResponsesResponse>;
  try {
    parsedResult = parseOpenAiResponsesResponse(parsedJson, {
      continuationProvider: protocol === 'xai-official' ? 'xai' : 'openai',
    });
  } catch (error) {
    return protocolError(error instanceof Error ? error.message : String(error));
  }
  if (!isRecord(parsedResult.raw)) {
    return protocolError('联网搜索响应必须是 JSON 对象。');
  }

  const { citations, annotationEvidence, callEvidence } = citationsAndEvidence(
    parsedResult.raw,
    protocol
  );
  const bailianEvidence =
    protocol === 'bailian-compatible' && bailianWebSearchCount(parsedResult.raw) > 0;

  return {
    content: parsedResult.content,
    reasoningContent: parsedResult.reasoningContent,
    usage: parsedResult.usage,
    citations,
    webSearchTriggered: callEvidence || annotationEvidence || bailianEvidence,
  };
}
