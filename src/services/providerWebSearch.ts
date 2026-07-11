import type { ChatMessage, ChatTokenUsage, ProviderProfile } from '../domain/types';
import type { OpenAiResponsesInputMessage } from './openAiResponses';
import {
  parseOpenAiResponsesResponse,
  toOpenAiResponsesInput,
} from './openAiResponses';

export type ProviderWebSearchProtocol =
  | 'openai-official'
  | 'volcengine-ark'
  | 'bailian-compatible';

export type OpenAiWebSearchContextSize = 'low' | 'medium' | 'high';

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
}

export interface BuildProviderWebSearchRequestArgs {
  provider: ProviderProfile;
  modelId: string;
  messages: ChatMessage[];
  searchContextSize?: OpenAiWebSearchContextSize;
  maxOutputTokens?: number;
}

export interface ProviderWebSearchRequest {
  protocol: ProviderWebSearchProtocol;
  url: string;
  body: {
    model: string;
    input: OpenAiResponsesInputMessage[];
    tools: Array<Record<string, unknown>>;
    store?: false;
    max_output_tokens?: number;
  };
}

export interface ParseProviderWebSearchResponseArgs {
  provider: ProviderProfile;
  payload: unknown;
}

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

  if (provider.kind === 'custom' || provider.kind === 'openai-compatible') {
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

export function getProviderWebSearchEndpoint(provider: ProviderProfile): string {
  const protocol = resolveProviderWebSearchProtocol(provider);
  const url = parsedProviderUrl(provider);

  if (protocol === 'openai-official') {
    return `${url.origin}/v1/responses`;
  }
  if (protocol === 'volcengine-ark') {
    return `${url.origin}/api/v3/responses`;
  }
  return `${url.origin}/compatible-mode/v1/responses`;
}

function assertTextOnlyMessages(messages: ChatMessage[], protocol: ProviderWebSearchProtocol): void {
  if (
    protocol !== 'openai-official' &&
    messages.some((message) => (message.attachments?.length ?? 0) > 0)
  ) {
    protocolError('火山方舟和阿里百炼联网搜索首版只允许纯文本 Responses 输入。');
  }
}

export function assertProviderWebSearchMessagesSupported(
  provider: ProviderProfile,
  messages: ChatMessage[]
): void {
  assertTextOnlyMessages(messages, resolveProviderWebSearchProtocol(provider));
}

export function buildProviderWebSearchRequest({
  provider,
  modelId,
  messages,
  searchContextSize,
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
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (
    !host ||
    (!host.includes('.') && !host.includes(':')) ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    host.endsWith('.home.arpa')
  ) {
    return true;
  }

  if (host.includes(':')) {
    const segments = host.split(':');
    const first = Number.parseInt(segments[0] || '0', 16);
    const second = Number.parseInt(segments[1] || '0', 16);
    const third = Number.parseInt(segments[2] || '0', 16);
    return (
      host.startsWith('::') ||
      host.startsWith('64:ff9b:') ||
      host.startsWith('100::') ||
      host.startsWith('2002:') ||
      first === 0x5f00 ||
      (first >= 0xfc00 && first <= 0xfdff) ||
      (first >= 0xfe80 && first <= 0xfeff) ||
      (first >= 0xff00 && first <= 0xffff) ||
      (first === 0x3fff && second <= 0x0fff) ||
      (first === 0x2001 &&
        (second === 0 ||
          (second === 2 && third === 0) ||
          second === 0x0db8 ||
          (second >= 0x10 && second <= 0x2f)))
    );
  }

  const octets = host.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  ) {
    return /^[0-9.]+$/.test(host);
  }
  const [a, b, c] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
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

function citationsAndEvidence(payload: Record<string, unknown>): {
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
    if (item.type === 'web_search_call') {
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
        pending.push({
          url,
          ...(typeof annotation.title === 'string' && annotation.title.trim()
            ? { title: annotation.title.trim() }
            : {}),
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

export function parseProviderWebSearchResponse({
  provider,
  payload,
}: ParseProviderWebSearchResponseArgs): ProviderWebSearchResult {
  const protocol = resolveProviderWebSearchProtocol(provider);
  const parsedResult = parseOpenAiResponsesResponse(payload);
  if (!isRecord(parsedResult.raw)) {
    return protocolError('联网搜索响应必须是 JSON 对象。');
  }

  const { citations, annotationEvidence, callEvidence } = citationsAndEvidence(parsedResult.raw);
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
