import { defaultExternalSearchSettings as catalogDefaultExternalSearch } from '../data/providerCatalog';
import type {
  ExternalSearchProviderKind,
  ExternalSearchService,
  ExternalSearchSettings,
  WebCitation,
} from '../domain/types';
import {
  createAbortPromise,
  isBlockedPublicHost,
  resolveStreamAbortError,
} from './ssrfGuard';

export const EXTERNAL_SEARCH_TOOL_NAME = 'search_web';
export const MAX_EXTERNAL_SEARCH_SERVICES = 16;
export const MAX_EXTERNAL_SEARCH_RESULTS = 10;
export const MAX_EXTERNAL_SEARCH_TOOL_ROUNDS = 4;
export const DEFAULT_EXTERNAL_SEARCH_MAX_RESULTS = 5;
export const DEFAULT_EXTERNAL_SEARCH_MAX_TOOL_ROUNDS = 3;
export const DEFAULT_GROK_SEARCH_MODEL = 'grok-4.5';

const MAX_EXTERNAL_SEARCH_JSON_BYTES = 5 * 1024 * 1024;
const MAX_EXTERNAL_SEARCH_HTML_BYTES = 3 * 1024 * 1024;
const MAX_EXTERNAL_SEARCH_ERROR_BYTES = 64 * 1024;

/** 与 ExternalSearchProviderKind 等价的向后兼容类型别名（已统一包含全部 10 家引擎）。 */
export type ExtendedExternalSearchProviderKind = ExternalSearchProviderKind;

/** 与 ExternalSearchService 等价的向后兼容类型别名。 */
export type ExtendedExternalSearchService = ExternalSearchService;

/** 与 ExternalSearchSettings 等价的向后兼容类型别名。 */
export type ExtendedExternalSearchSettings = ExternalSearchSettings;

/** 保留历史 6 项列表导出，兼容既有单元测试断言；新增引擎请使用 allExternalSearchProviderKinds。 */
export const externalSearchProviderKinds = [
  'bing',
  'duckduckgo',
  'tavily',
  'brave',
  'firecrawl',
  'grok',
] as const satisfies readonly ExternalSearchProviderKind[];

/** 全量 10 家外部搜索服务标识列表（供 UI 与备份校验使用）。 */
export const allExternalSearchProviderKinds = [
  ...externalSearchProviderKinds,
  'deepseek',
  'bocha',
  'exa',
  'searxng',
] as const satisfies readonly ExternalSearchProviderKind[];

export const externalSearchProviderLabels: Record<ExternalSearchProviderKind, string> = {
  bing: 'Bing（免费）',
  duckduckgo: 'DuckDuckGo',
  tavily: 'Tavily',
  brave: 'Brave Search',
  firecrawl: 'Firecrawl',
  grok: 'Grok Search (xAI)',
  deepseek: 'DeepSeek Search',
  bocha: 'Bocha 博查',
  exa: 'Exa AI',
  searxng: 'SearXNG',
};

export const allExternalSearchProviderLabels: Record<ExternalSearchProviderKind, string> =
  externalSearchProviderLabels;

export const externalSearchProviderHints: Record<ExternalSearchProviderKind, string> = {
  bing: '本地匿名抓取 bing.com，无需 API Key',
  duckduckgo: '本地匿名搜索，无需 API Key',
  tavily: '需 API Key · 面向 AI 的搜索 API',
  brave: '需 API Key · Brave Search API',
  firecrawl: '可选 API Key',
  grok: '需 API Key · xAI web_search / x_search',
  deepseek: '需 API Key · DeepSeek 官方联网搜索与网页抓取',
  bocha: '需 API Key · Bocha 博查中文全网搜索',
  exa: '需 API Key · Exa 神经语义检索与高亮摘要',
  searxng: '自托管元搜索实例 · 无需 Key（需配置 HTTPS 地址并启用 format=json）',
};

export const allExternalSearchProviderHints: Record<ExternalSearchProviderKind, string> =
  externalSearchProviderHints;

/** 允许无 API Key 直接运行的外部搜索类型。 */
export function externalSearchProviderAllowsAnonymous(
  kind: ExtendedExternalSearchProviderKind,
  _endpoint?: string
): boolean {
  return (
    kind === 'bing' ||
    kind === 'duckduckgo' ||
    kind === 'firecrawl' ||
    kind === 'searxng'
  );
}

/** 必须提供 API Key 才能启动的外部搜索类型。 */
export function externalSearchProviderRequiresApiKey(
  kind: ExtendedExternalSearchProviderKind,
  _endpoint?: string
): boolean {
  return (
    kind === 'tavily' ||
    kind === 'brave' ||
    kind === 'grok' ||
    kind === 'deepseek' ||
    kind === 'bocha' ||
    kind === 'exa'
  );
}

/** 判断外部搜索服务是否强制要求填写自托管实例 Endpoint（当前仅 SearXNG）。 */
export function externalSearchProviderRequiresEndpoint(
  kind: ExternalSearchProviderKind
): boolean {
  return kind === 'searxng';
}

export type ExternalSearchEndpointValidation =
  | { ok: true; endpoint?: string }
  | { ok: false; error: string };

/**
 * 校验外部搜索服务的自定义 Endpoint：
 * - SearXNG 无默认公共实例，必须填写非空地址；
 * - 任意非空地址均须通过公网 HTTPS 校验（拦截 http://、凭据、query/hash 及本机/私网 SSRF）。
 */
export function validateExternalSearchEndpoint(
  kind: ExternalSearchProviderKind,
  rawEndpoint?: string
): ExternalSearchEndpointValidation {
  const trimmed = rawEndpoint?.trim() ?? '';
  if (!trimmed) {
    if (externalSearchProviderRequiresEndpoint(kind)) {
      return { ok: false, error: 'SearXNG 需要填写自托管 HTTPS 实例地址。' };
    }
    return { ok: true, endpoint: undefined };
  }
  try {
    const checked = assertSafePublicHttpsEndpoint(
      trimmed,
      externalSearchProviderLabels[kind]
    )
      .toString()
      .replace(/\/+$/, '');
    return { ok: true, endpoint: checked };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Endpoint 地址无效。',
    };
  }
}

/**
 * 判断外部搜索服务条目是否已完成必要配置（Key 或自托管 Endpoint）。
 */
export function isExternalSearchServiceConfigured(
  service: ExtendedExternalSearchService
): boolean {
  if (service.kind === 'searxng') {
    const endpoint = service.endpoint?.trim();
    if (!endpoint) return false;
    try {
      assertSafePublicHttpsEndpoint(endpoint, 'SearXNG');
      return true;
    } catch {
      return false;
    }
  }
  if (service.apiKey?.trim()) return true;
  return externalSearchProviderAllowsAnonymous(service.kind, service.endpoint);
}

export const defaultExternalSearchSettings: ExternalSearchSettings = {
  ...catalogDefaultExternalSearch,
};

export interface ExternalSearchResultItem {
  title: string;
  url: string;
  text: string;
  id: string;
  index: number;
}

export interface ExternalSearchResult {
  answer?: string;
  items: ExternalSearchResultItem[];
}

export interface ExternalSearchRunArgs {
  query: string;
  service: ExtendedExternalSearchService;
  maxResults?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface DeepSeekFetchArgs {
  url: string;
  apiKey: string;
  endpoint?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface DeepSeekFetchResult {
  title: string;
  url: string;
  content: string;
}

export class ExternalSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExternalSearchError';
  }
}

function searchError(message: string): never {
  throw new ExternalSearchError(message);
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

/** 对外部搜索错误信息中的 apiKey 原文及其大小写混合 URL 编码形式执行全量脱敏，防止凭据跨服务商或向界面泄露。 */
export function redactExternalSearchSecrets(text: string, apiKey?: string): string {
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

function sanitizeExternalSearchError(error: unknown, apiKey?: string): Error {
  if (error instanceof Error) {
    const cleanMessage = redactExternalSearchSecrets(error.message, apiKey);
    if (cleanMessage === error.message) {
      return error;
    }
    if (error instanceof ExternalSearchError) {
      return new ExternalSearchError(cleanMessage);
    }
    const cloned = new Error(cleanMessage);
    cloned.name = error.name;
    return cloned;
  }
  return new ExternalSearchError(redactExternalSearchSecrets(String(error), apiKey));
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function normalizeExternalSearchSettings(value: unknown): ExternalSearchSettings {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const maxResults = clampInt(
    typeof raw.maxResults === 'number' ? raw.maxResults : DEFAULT_EXTERNAL_SEARCH_MAX_RESULTS,
    1,
    MAX_EXTERNAL_SEARCH_RESULTS,
    DEFAULT_EXTERNAL_SEARCH_MAX_RESULTS
  );
  const maxToolRounds = clampInt(
    typeof raw.maxToolRounds === 'number' ? raw.maxToolRounds : DEFAULT_EXTERNAL_SEARCH_MAX_TOOL_ROUNDS,
    1,
    MAX_EXTERNAL_SEARCH_TOOL_ROUNDS,
    DEFAULT_EXTERNAL_SEARCH_MAX_TOOL_ROUNDS
  );
  const services = normalizeExternalSearchServices(
    Array.isArray(raw.services) ? raw.services : catalogDefaultExternalSearch.services
  );
  const selectedServiceId =
    typeof raw.selectedServiceId === 'string' &&
    services.some((service) => service.id === raw.selectedServiceId)
      ? raw.selectedServiceId
      : services.some((service) => service.id === catalogDefaultExternalSearch.selectedServiceId)
        ? catalogDefaultExternalSearch.selectedServiceId
        : services[0]?.id;

  return {
    // User intent flag; runtime still requires a selected service with a Key.
    enabled: raw.enabled === true,
    ...(selectedServiceId ? { selectedServiceId } : {}),
    maxResults,
    maxToolRounds,
    services,
  };
}

export function normalizeExternalSearchServices(value: unknown): ExternalSearchService[] {
  if (!Array.isArray(value)) return [];
  const out: ExternalSearchService[] = [];
  const seen = new Set<string>();
  for (const entry of value.slice(0, MAX_EXTERNAL_SEARCH_SERVICES)) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const kind = typeof record.kind === 'string' ? record.kind.trim() : '';
    if (
      !id ||
      seen.has(id) ||
      !allExternalSearchProviderKinds.includes(kind as ExtendedExternalSearchProviderKind)
    ) {
      continue;
    }
    seen.add(id);
    const name =
      (typeof record.name === 'string' && record.name.trim()) ||
      allExternalSearchProviderLabels[kind as ExtendedExternalSearchProviderKind];
    const apiKey = typeof record.apiKey === 'string' ? record.apiKey.trim() : undefined;
    const endpoint = typeof record.endpoint === 'string' ? record.endpoint.trim() : undefined;
    const model = typeof record.model === 'string' ? record.model.trim() : undefined;
    out.push({
      id,
      kind: kind as ExternalSearchProviderKind,
      name: name.slice(0, 80),
      ...(apiKey ? { apiKey } : {}),
      ...(endpoint ? { endpoint } : {}),
      ...(model ? { model } : {}),
    });
  }
  return out;
}

export function stripExternalSearchSecrets(
  settings: ExternalSearchSettings
): ExternalSearchSettings {
  return {
    ...settings,
    services: settings.services.map(({ apiKey: _apiKey, ...service }) => service),
  };
}

export function resolveSelectedExternalSearchService(
  settings: ExternalSearchSettings | ExtendedExternalSearchSettings
): ExternalSearchService | null {
  const selectedId = settings.selectedServiceId;
  const service =
    settings.services.find((item) => item.id === selectedId) ??
    settings.services[0];
  if (!service || !isExternalSearchServiceConfigured(service)) return null;
  return service as ExternalSearchService;
}

/** Selected service is ready (has key, or free/anonymous kind). */
export function isExternalSearchReady(
  settings: ExternalSearchSettings | ExtendedExternalSearchSettings
): boolean {
  return resolveSelectedExternalSearchService(settings) != null;
}

/** Runtime path: user enabled external search and a configured service is selected. */
export function resolveActiveExternalSearchService(
  settings: ExternalSearchSettings | ExtendedExternalSearchSettings
): ExternalSearchService | null {
  if (!settings.enabled) return null;
  return resolveSelectedExternalSearchService(settings);
}

export function getExternalSearchToolDefinition() {
  return {
    type: 'function',
    function: {
      name: EXTERNAL_SEARCH_TOOL_NAME,
      description:
        'Search the public web for current information. Use when the user needs live facts, news, docs, or verification.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query to look up online',
          },
        },
        required: ['query'],
      },
    },
  };
}

export function getExternalSearchSystemPrompt(): string {
  return [
    '## search_web tool',
    'When the user needs realtime or verifiable external information, call search_web with a focused query.',
    'Search results include index and id fields. Cite facts inline as [citation](index:id) immediately after the claim.',
    'Do not invent URLs. Prefer multiple short targeted searches over one vague query.',
  ].join('\n');
}

function shortId(index: number): string {
  return `s${(index + 1).toString(36)}`;
}

function normalizePublicHttpsUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(
      trimmed.startsWith('//')
        ? `https:${trimmed}`
        : trimmed.includes('://')
          ? trimmed
          : `https://${trimmed}`
    );
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    if (!url.hostname || isBlockedEndpointHostname(url.hostname)) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

/** True when a provider gave a useless title (empty, bare citation index, or raw URL). */
export function isWeakSearchTitle(title: string, url: string): boolean {
  const t = title.trim();
  if (!t) return true;
  // Grok annotations often use "1" / "2" / "[1]" as citation labels.
  if (/^\d{1,3}$/.test(t)) return true;
  if (/^\[\d{1,3}\]$/.test(t)) return true;
  const normalizeForCompare = (value: string) => value.trim().replace(/\/+$/, '').toLowerCase();
  if (normalizeForCompare(t) === normalizeForCompare(url)) return true;
  // Hostname-only is an acceptable fallback title, not weak.
  return false;
}

/** Prefer readable host / path segment over citation indexes like "1". */
export function titleFromSearchUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./i, '');
    const segments = url.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1] ?? '';
    const decoded = decodeURIComponent(last).replace(/\+/g, ' ').replace(/[-_]+/g, ' ').trim();
    // Skip opaque ids / file extensions-only junk.
    if (
      decoded &&
      decoded.length >= 4 &&
      decoded.length <= 80 &&
      !/^[a-f0-9]{8,}$/i.test(decoded) &&
      !/^\d+$/.test(decoded) &&
      !/\.(html?|php|aspx?)$/i.test(decoded)
    ) {
      return decoded.slice(0, 120);
    }
    return host || rawUrl;
  } catch {
    return rawUrl;
  }
}

/**
 * Pull markdown links from Grok-style answers:
 * `[title](url)`, `[[1]](url)`, `**text**[[1]](url)`.
 */
export function extractLinksFromAnswerText(
  answer: string
): Array<{ title: string; url: string }> {
  const out: Array<{ title: string; url: string }> = [];
  const seen = new Set<string>();
  const patterns = [
    /\[\[(\d+)\]\]\((https?:\/\/[^)\s]+)\)/gi,
    /\[([^\]]{1,200})\]\((https?:\/\/[^)\s]+)\)/gi,
  ];
  for (const re of patterns) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(answer)) !== null) {
      const label = (match[1] ?? '').trim();
      const url = normalizePublicHttpsUrl(match[2] ?? '');
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const title = isWeakSearchTitle(label, url) ? titleFromSearchUrl(url) : label;
      out.push({ title: title.slice(0, 300), url });
    }
  }
  return out;
}

/** Strip dense citation markdown so answer preview stays readable. */
export function cleanSearchAnswerForDisplay(answer: string): string {
  return answer
    .replace(/\[\[(\d+)\]\]\((https?:\/\/[^)\s]+)\)/gi, '')
    .replace(/\[(\d{1,3})\]\((https?:\/\/[^)\s]+)\)/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function withItemIds(
  items: Array<{ title: string; url: string; text: string }>
): ExternalSearchResultItem[] {
  const out: ExternalSearchResultItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const url = normalizePublicHttpsUrl(item.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const index = out.length + 1;
    const rawTitle = (item.title || '').trim();
    const title = (
      isWeakSearchTitle(rawTitle, url) ? titleFromSearchUrl(url) : rawTitle
    ).slice(0, 300);
    out.push({
      title: title || url,
      url,
      text: (item.text || '').slice(0, 4000),
      id: shortId(out.length),
      index,
    });
    if (out.length >= MAX_EXTERNAL_SEARCH_RESULTS) break;
  }
  return out;
}

/** Rebase one tool result so every search round uses globally unique citation ids/indexes. */
export function reindexExternalSearchResult(
  result: ExternalSearchResult,
  offset: number
): ExternalSearchResult {
  const safeOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  return {
    ...result,
    items: result.items.map((item, itemIndex) => ({
      ...item,
      index: safeOffset + itemIndex + 1,
      id: shortId(safeOffset + itemIndex),
    })),
  };
}

function mergeSearchItems(
  primary: Array<{ title: string; url: string; text: string }>,
  secondary: Array<{ title: string; url: string; text: string }>,
  maxItems: number
): Array<{ title: string; url: string; text: string }> {
  const byUrl = new Map<string, { title: string; url: string; text: string }>();
  for (const item of [...primary, ...secondary]) {
    const url = normalizePublicHttpsUrl(item.url);
    if (!url) continue;
    const existing = byUrl.get(url);
    if (!existing) {
      byUrl.set(url, {
        title: item.title,
        url,
        text: item.text,
      });
      continue;
    }
    // Prefer a stronger title / longer snippet when merging.
    const nextTitle =
      isWeakSearchTitle(existing.title, url) && !isWeakSearchTitle(item.title, url)
        ? item.title
        : existing.title;
    const nextText =
      (item.text?.length ?? 0) > (existing.text?.length ?? 0) ? item.text : existing.text;
    byUrl.set(url, { title: nextTitle, url, text: nextText });
  }
  return Array.from(byUrl.values()).slice(0, maxItems);
}

function isBlockedEndpointHostname(rawHost: string): boolean {
  return isBlockedPublicHost(rawHost);
}

function resolveSearchAbortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }
  return resolveStreamAbortError(signal);
}

function assertSafePublicHttpsEndpoint(raw: string, label: string): URL {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return searchError(`${label} Endpoint 不是有效网址。`);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    /^https:\/\/[^/?#\\]*@/i.test(trimmed) ||
    url.search ||
    url.hash ||
    trimmed.includes('?') ||
    trimmed.includes('#')
  ) {
    return searchError(`${label} Endpoint 必须是无凭据、无查询参数的 HTTPS 地址。`);
  }
  if (isBlockedEndpointHostname(url.hostname)) {
    return searchError(`${label} Endpoint 不能指向本机或私网主机名。`);
  }
  if (url.port && url.port !== '443') {
    return searchError(`${label} Endpoint 必须使用标准 443 端口的 HTTPS 地址。`);
  }
  return url;
}

function assertSafePublicHttpsTargetUrl(raw: string, label: string): URL {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return searchError(`${label} 目标 URL 不是有效网址。`);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    /^https:\/\/[^/?#\\]*@/i.test(trimmed)
  ) {
    return searchError(`${label} 目标 URL 必须是无凭据的 HTTPS 地址。`);
  }
  if (isBlockedEndpointHostname(url.hostname)) {
    return searchError(`${label} 目标 URL 不能指向本机或私网地址。`);
  }
  if (url.port && url.port !== '443') {
    return searchError(`${label} 目标 URL 必须使用标准 443 端口的 HTTPS 地址。`);
  }
  return url;
}

function assertSafeSearchRequestUrl(raw: string, label: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return searchError(`${label} 请求地址无效。`);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    return searchError(`${label} 请求地址必须是无凭据的 HTTPS 地址。`);
  }
  if (isBlockedEndpointHostname(url.hostname)) {
    return searchError(`${label} 请求地址不能指向本机或私网地址。`);
  }
  if (url.port && url.port !== '443') {
    return searchError(`${label} 请求地址必须使用标准 443 端口的 HTTPS 地址。`);
  }
}

function detectBrowserDomPlatformOs(): string | undefined {
  return typeof window !== 'undefined' && typeof document !== 'undefined'
    ? 'web'
    : undefined;
}

async function resolveRuntimePlatformOs(): Promise<string | undefined> {
  try {
    const rn = (await import('react-native')) as { Platform?: { OS?: string } };
    return rn?.Platform?.OS ?? detectBrowserDomPlatformOs();
  } catch {
    return detectBrowserDomPlatformOs();
  }
}

async function resolveNetworkTransport(): Promise<typeof import('./networkTransport') | null> {
  try {
    return await import('./networkTransport');
  } catch {
    return null;
  }
}

async function assertSearchWebAccessAllowed(): Promise<{
  platformOs: string | undefined;
  transport: typeof import('./networkTransport') | null;
}> {
  const [platformOs, transport] = await Promise.all([
    resolveRuntimePlatformOs(),
    resolveNetworkTransport(),
  ]);
  if (platformOs === 'web' && !transport?.isWebDevelopmentProxyAllowed()) {
    searchError(
      '正式 Web 构建不会发送 API Key 或外部搜索请求。仅可在本机通过 npm run web 显式启动受限调试代理。'
    );
  }
  return { platformOs, transport };
}

/**
 * 统一执行外部搜索与网页抓取 HTTP 请求：
 * - Web 非授权调试代理环境下强制 fail-closed 拦截；
 * - 默认接入 `guardedApiFetch`，显式传入自定义 `fetchImpl` 时在授权 Web 代理模式下走单层信封包装；
 * - 发起前强制校验证书协议、443 端口与主机 SSRF 规则，并锁定 `redirect: 'error'` 防止 302 跳转泄露凭据。
 */
async function executeSearchFetch(
  url: string,
  init: RequestInit,
  explicitFetchImpl: typeof fetch | undefined,
  label: string
): Promise<Response> {
  const { platformOs, transport } = await assertSearchWebAccessAllowed();
  if (init.signal?.aborted) {
    throw resolveSearchAbortError(init.signal);
  }
  assertSafeSearchRequestUrl(url, label);
  const safeInit: RequestInit = {
    ...init,
    redirect: 'error',
  };

  if (!explicitFetchImpl || explicitFetchImpl === transport?.guardedApiFetch) {
    const defaultTransport = transport?.guardedApiFetch ?? fetch;
    return defaultTransport(url, safeInit);
  }
  if (platformOs === 'web' && transport) {
    return transport.transportFetch(url, safeInit, explicitFetchImpl);
  }
  return explicitFetchImpl(url, safeInit);
}

function defaultEndpoint(kind: ExtendedExternalSearchProviderKind, override?: string): string {
  if (override?.trim()) {
    return assertSafePublicHttpsEndpoint(override, allExternalSearchProviderLabels[kind])
      .toString()
      .replace(/\/+$/, '');
  }
  switch (kind) {
    case 'tavily':
      return 'https://api.tavily.com/search';
    case 'brave':
      return 'https://api.search.brave.com/res/v1/web/search';
    case 'grok':
      return 'https://api.x.ai/v1/responses';
    case 'firecrawl':
      return 'https://api.firecrawl.dev/v2/search';
    case 'bing':
      return 'https://www.bing.com/search';
    case 'duckduckgo':
      return 'https://html.duckduckgo.com/html/';
    case 'deepseek':
      return 'https://api.deepseek.com/v1/tools/search';
    case 'bocha':
      return 'https://api.bochaai.com/v1/web-search';
    case 'exa':
      return 'https://api.exa.ai/search';
    case 'searxng':
      return searchError('SearXNG 需要先配置自托管实例 Endpoint。');
  }
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    });
}

function stripHtml(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function unwrapBingHref(href: string): string {
  const trimmed = href.trim();
  if (!trimmed) return trimmed;
  try {
    const absolute = new URL(trimmed, 'https://www.bing.com');
    if (
      absolute.hostname.toLowerCase().includes('bing.') &&
      absolute.pathname.includes('/ck/')
    ) {
      const encoded = absolute.searchParams.get('u');
      if (encoded && /^a1/i.test(encoded)) {
        const b64 = encoded
          .slice(2)
          .replace(/-/g, '+')
          .replace(/_/g, '/');
        const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
        // Prefer atob in RN/web; fall back to Buffer in Node tests.
        const decoded =
          typeof atob === 'function'
            ? atob(b64 + pad)
            : Buffer.from(b64 + pad, 'base64').toString('utf8');
        if (decoded.startsWith('http')) return decoded;
      }
    }
    return absolute.toString();
  } catch {
    return trimmed;
  }
}

async function fetchText(
  url: string,
  init: RequestInit,
  label: string,
  timeoutMs: number,
  fetchImpl: typeof fetch | undefined,
  signal?: AbortSignal,
  apiKey?: string
): Promise<string> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) throw resolveSearchAbortError(signal);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('搜索超时。')), timeoutMs);
  try {
    const response = await executeSearchFetch(
      url,
      { ...init, signal: controller.signal },
      fetchImpl,
      label
    );
    const text = await readLimitedSearchResponseText(
      response,
      response.ok ? MAX_EXTERNAL_SEARCH_HTML_BYTES : MAX_EXTERNAL_SEARCH_ERROR_BYTES,
      label,
      controller.signal
    );
    if (!response.ok) {
      const safeSnippet = redactExternalSearchSecrets(text, apiKey).slice(0, 240);
      return searchError(`${label} 失败：HTTP ${response.status} ${safeSnippet}`);
    }
    return text;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function awaitStreamCancelSettled(cancelPromise: Promise<unknown> | null): Promise<void> {
  if (!cancelPromise) {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cancelPromise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 50);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function readLimitedSearchResponseText(
  response: Response,
  maxBytes: number,
  label: string,
  signal?: AbortSignal
): Promise<string> {
  if (signal?.aborted) {
    await response.body?.cancel().catch(() => undefined);
    throw resolveSearchAbortError(signal);
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return searchError(`${label} 响应过大（上限 ${Math.round(maxBytes / 1024)} KiB）。`);
  }

  const reader = response.body?.getReader();
  let cancelPromise: Promise<unknown> | null = null;
  const { promise: abortPromise, cleanup: cleanupAbort } = createAbortPromise(
    signal,
    () => {
      if (reader) {
        cancelPromise = reader.cancel().catch(() => undefined);
      } else if (response.body) {
        cancelPromise = response.body.cancel().catch(() => undefined);
      }
    }
  );

  if (!reader) {
    try {
      const text = abortPromise
        ? await Promise.race([response.text(), abortPromise])
        : await response.text();
      if (signal?.aborted) {
        throw resolveSearchAbortError(signal);
      }
      if (new TextEncoder().encode(text).byteLength > maxBytes) {
        return searchError(`${label} 响应过大（上限 ${Math.round(maxBytes / 1024)} KiB）。`);
      }
      return text;
    } finally {
      cleanupAbort();
      await awaitStreamCancelSettled(cancelPromise);
    }
  }

  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';
  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => undefined);
        throw resolveSearchAbortError(signal);
      }
      const { value, done } = abortPromise
        ? await Promise.race([reader.read(), abortPromise])
        : await reader.read();
      if (signal?.aborted) {
        await reader.cancel().catch(() => undefined);
        throw resolveSearchAbortError(signal);
      }
      if (done) break;
      totalBytes += value?.byteLength ?? 0;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return searchError(`${label} 响应过大（上限 ${Math.round(maxBytes / 1024)} KiB）。`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    if (signal?.aborted) {
      throw resolveSearchAbortError(signal);
    }
    return text;
  } finally {
    cleanupAbort();
    await awaitStreamCancelSettled(cancelPromise);
    try {
      reader.releaseLock();
    } catch {
      // 流已释放或取消时忽略
    }
  }
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

async function searchBing(
  query: string,
  service: ExtendedExternalSearchService,
  maxResults: number,
  timeoutMs: number,
  fetchImpl: typeof fetch | undefined,
  signal?: AbortSignal
): Promise<ExternalSearchResult> {
  const base = defaultEndpoint('bing', service.endpoint);
  const url = new URL(base);
  url.searchParams.set('q', query);
  const html = await fetchText(
    url.toString(),
    {
      method: 'GET',
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    },
    'Bing',
    timeoutMs,
    fetchImpl,
    signal,
    service.apiKey
  );

  const items: Array<{ title: string; url: string; text: string }> = [];
  const blocks = html.match(/<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>[\s\S]*?<\/li>/gi) ?? [];
  for (const block of blocks) {
    const linkMatch =
      block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i) ??
      block.match(/<a[^>]*href="([^"]+)"[^>]*h="ID=SERP[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const href = unwrapBingHref(decodeHtmlEntities(linkMatch[1] ?? ''));
    const title = stripHtml(linkMatch[2] ?? '');
    const snippetMatch =
      block.match(/class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i) ??
      block.match(/class="b_algoSlug"[^>]*>([\s\S]*?)<\/(?:div|p|span)>/i);
    const text = snippetMatch ? stripHtml(snippetMatch[1] ?? '') : '';
    if (!href || !title) continue;
    items.push({ title, url: href, text });
    if (items.length >= maxResults) break;
  }
  if (!items.length) {
    return searchError('Bing 未解析到结果（页面结构可能变更，或网络被拦截）。');
  }
  return { items: withItemIds(items).slice(0, maxResults) };
}

async function searchDuckDuckGo(
  query: string,
  service: ExtendedExternalSearchService,
  maxResults: number,
  timeoutMs: number,
  fetchImpl: typeof fetch | undefined,
  signal?: AbortSignal
): Promise<ExternalSearchResult> {
  // 1) Instant Answer JSON (free, limited)
  const instantUrl = new URL('https://api.duckduckgo.com/');
  instantUrl.searchParams.set('q', query);
  instantUrl.searchParams.set('format', 'json');
  instantUrl.searchParams.set('no_html', '1');
  instantUrl.searchParams.set('skip_disambig', '1');
  instantUrl.searchParams.set('no_redirect', '1');

  const instantItems: Array<{ title: string; url: string; text: string }> = [];
  try {
    const text = await fetchText(
      instantUrl.toString(),
      {
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': BROWSER_UA },
      },
      'DuckDuckGo Instant',
      timeoutMs,
      fetchImpl,
      signal,
      service.apiKey
    );
    const data = JSON.parse(text) as Record<string, unknown>;
    const abstractUrl = typeof data.AbstractURL === 'string' ? data.AbstractURL : '';
    const abstractText = typeof data.AbstractText === 'string' ? data.AbstractText : '';
    const heading = typeof data.Heading === 'string' ? data.Heading : '';
    if (abstractUrl) {
      instantItems.push({
        title: heading || abstractUrl,
        url: abstractUrl,
        text: abstractText,
      });
    }
    const related = Array.isArray(data.RelatedTopics) ? data.RelatedTopics : [];
    const walk = (nodes: unknown[]) => {
      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        const row = node as Record<string, unknown>;
        if (Array.isArray(row.Topics)) {
          walk(row.Topics);
          continue;
        }
        const firstUrl = typeof row.FirstURL === 'string' ? row.FirstURL : '';
        const body = typeof row.Text === 'string' ? row.Text : '';
        if (firstUrl) {
          instantItems.push({
            title: body.split(' - ')[0] || firstUrl,
            url: firstUrl,
            text: body,
          });
        }
        if (instantItems.length >= maxResults) return;
      }
    };
    walk(related);
  } catch {
    // Fall through to HTML scrape.
  }

  if (instantItems.length >= Math.min(3, maxResults)) {
    return { items: withItemIds(instantItems).slice(0, maxResults) };
  }

  // 2) HTML scrape (anonymous)
  const base = defaultEndpoint('duckduckgo', service.endpoint);
  const form = new URLSearchParams({ q: query });
  const html = await fetchText(
    base,
    {
      method: 'POST',
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    },
    'DuckDuckGo',
    timeoutMs,
    fetchImpl,
    signal,
    service.apiKey
  );

  const htmlItems: Array<{ title: string; url: string; text: string }> = [...instantItems];
  const seen = new Set(htmlItems.map((item) => item.url));
  const linkRe =
    /class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(html)) && htmlItems.length < maxResults) {
    let href = decodeHtmlEntities(match[1] ?? '').trim();
    // DDG sometimes wraps uddg= query param
    try {
      const wrapped = new URL(href, 'https://duckduckgo.com');
      const uddg = wrapped.searchParams.get('uddg');
      if (uddg) href = decodeURIComponent(uddg);
    } catch {
      // keep href
    }
    const title = stripHtml(match[2] ?? '');
    if (!href || !title || seen.has(href)) continue;
    // Find nearby snippet after this match
    const after = html.slice(match.index, match.index + 800);
    const snippetMatch = after.match(
      /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div|span)>/i
    );
    const text = snippetMatch ? stripHtml(snippetMatch[1] ?? '') : '';
    seen.add(href);
    htmlItems.push({ title, url: href, text });
  }

  if (!htmlItems.length) {
    return searchError('DuckDuckGo 未解析到结果（可能被限流或页面结构变更）。');
  }
  return { items: withItemIds(htmlItems).slice(0, maxResults) };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function pickText(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate);
  }
  return '';
}

/** Brave descriptions often include <strong> query highlights. */
function stripLightHtml(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function joinSnippets(parts: unknown[], maxLen = 800): string {
  const texts: string[] = [];
  for (const part of parts) {
    if (typeof part === 'string' && part.trim()) texts.push(stripLightHtml(part));
    if (texts.join(' ').length >= maxLen) break;
  }
  return texts.join(' · ').slice(0, maxLen);
}

function mapProviderRows(
  rows: unknown[],
  mapRow: (row: Record<string, unknown>) => { title: string; url: string; text: string } | null
): Array<{ title: string; url: string; text: string }> {
  const out: Array<{ title: string; url: string; text: string }> = [];
  for (const entry of rows) {
    const row = asRecord(entry);
    if (!row) continue;
    const mapped = mapRow(row);
    if (!mapped?.url && !mapped?.title) continue;
    if (mapped) out.push(mapped);
  }
  return out;
}

async function searchFirecrawl(
  query: string,
  service: ExtendedExternalSearchService,
  maxResults: number,
  timeoutMs: number,
  fetchImpl: typeof fetch | undefined,
  signal?: AbortSignal
): Promise<ExternalSearchResult> {
  const endpoint = defaultEndpoint('firecrawl', service.endpoint);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const key = service.apiKey?.trim();
  if (key) {
    headers.Authorization = `Bearer ${key}`;
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) throw resolveSearchAbortError(signal);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('搜索超时。')), timeoutMs);
  try {
    const response = await executeSearchFetch(
      endpoint,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query,
          limit: maxResults,
        }),
        signal: controller.signal,
      },
      fetchImpl,
      'Firecrawl'
    );
    const data = await readJson(response, 'Firecrawl', key, controller.signal);
    // v2: { success, data: { web: [...] } }
    // legacy/self-host variants: { data: [...] }, { web: [...] }, { results: [...] }
    const payload = asRecord(data.data) ?? data;
    const web = Array.isArray(payload.web)
      ? payload.web
      : Array.isArray(data.web)
        ? data.web
        : Array.isArray(data.results)
          ? data.results
          : Array.isArray(data.data)
            ? data.data
            : [];
    const mapped = mapProviderRows(web, (row) => {
      const url = pickText(row.url, row.sourceURL, row.metadata && asRecord(row.metadata)?.sourceURL);
      const meta = asRecord(row.metadata);
      const title = pickText(row.title, meta?.title, url);
      // Prefer short description; fall back to trimmed markdown (not full page dump).
      const markdown = pickText(row.markdown, row.content);
      const description = pickText(row.description, row.snippet, meta?.description);
      const text =
        description ||
        (markdown ? markdown.replace(/\s+/g, ' ').trim().slice(0, 600) : '');
      if (!url && !title) return null;
      return { title, url, text };
    });
    const items = withItemIds(mapped).slice(0, maxResults);
    return { items };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function readJson(
  response: Response,
  label: string,
  apiKey?: string,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const text = await readLimitedSearchResponseText(
    response,
    response.ok ? MAX_EXTERNAL_SEARCH_JSON_BYTES : MAX_EXTERNAL_SEARCH_ERROR_BYTES,
    label,
    signal
  );
  if (!response.ok) {
    const safeSnippet = redactExternalSearchSecrets(text, apiKey).slice(0, 240);
    return searchError(`${label} 失败：HTTP ${response.status} ${safeSnippet}`);
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return searchError(`${label} 返回了非对象 JSON。`);
    }
    return parsed as Record<string, unknown>;
  } catch {
    return searchError(`${label} 返回了无效 JSON。`);
  }
}

async function searchTavily(
  query: string,
  service: ExtendedExternalSearchService,
  maxResults: number,
  timeoutMs: number,
  fetchImpl: typeof fetch | undefined,
  signal?: AbortSignal
): Promise<ExternalSearchResult> {
  const endpoint = defaultEndpoint('tavily', service.endpoint);
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) throw resolveSearchAbortError(signal);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('搜索超时。')), timeoutMs);
  try {
    const response = await executeSearchFetch(
      endpoint,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${service.apiKey!.trim()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          max_results: maxResults,
          // Short AI synopsis when available — useful in the activity panel.
          include_answer: true,
        }),
        signal: controller.signal,
      },
      fetchImpl,
      'Tavily'
    );
    const data = await readJson(response, 'Tavily', service.apiKey, controller.signal);
    // Official shape: { answer?, results: [{ title, url, content, raw_content, score, published_date }] }
    const results = Array.isArray(data.results)
      ? data.results
      : Array.isArray(data.data)
        ? data.data
        : [];
    const mapped = mapProviderRows(results, (row) => {
      const url = pickText(row.url, row.link);
      const title = pickText(row.title, row.name, url);
      const text = pickText(row.content, row.snippet, row.raw_content, row.description);
      if (!url && !title) return null;
      return {
        title,
        url,
        text: text.replace(/\s+/g, ' ').trim().slice(0, 1200),
      };
    });
    const items = withItemIds(mapped).slice(0, maxResults);
    const answer =
      typeof data.answer === 'string' && data.answer.trim()
        ? cleanSearchAnswerForDisplay(data.answer.trim()).slice(0, 2000)
        : undefined;
    return { ...(answer ? { answer } : {}), items };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function searchBrave(
  query: string,
  service: ExtendedExternalSearchService,
  maxResults: number,
  timeoutMs: number,
  fetchImpl: typeof fetch | undefined,
  signal?: AbortSignal
): Promise<ExternalSearchResult> {
  const base = defaultEndpoint('brave', service.endpoint);
  const url = new URL(base);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(maxResults));
  // Extra excerpts improve snippet quality for the activity UI.
  url.searchParams.set('extra_snippets', 'true');
  url.searchParams.set('text_decorations', 'false');
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) throw resolveSearchAbortError(signal);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('搜索超时。')), timeoutMs);
  try {
    const response = await executeSearchFetch(
      url.toString(),
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': service.apiKey!.trim(),
        },
        signal: controller.signal,
      },
      fetchImpl,
      'Brave Search'
    );
    const data = await readJson(response, 'Brave Search', service.apiKey, controller.signal);
    // Official: { web: { results: [{ title, url, description, extra_snippets[] }] }, news?: { results } }
    const web = asRecord(data.web) ?? {};
    const news = asRecord(data.news) ?? {};
    const webResults = Array.isArray(web.results) ? web.results : [];
    const newsResults = Array.isArray(news.results) ? news.results : [];
    const mappedWeb = mapProviderRows(webResults, (row) => {
      const itemUrl = pickText(row.url, row.link);
      const title = pickText(row.title, itemUrl);
      const description = stripLightHtml(pickText(row.description, row.snippet));
      const extras = Array.isArray(row.extra_snippets) ? row.extra_snippets : [];
      const text = joinSnippets([description, ...extras], 1000);
      if (!itemUrl && !title) return null;
      return { title, url: itemUrl, text };
    });
    const mappedNews = mapProviderRows(newsResults, (row) => {
      const itemUrl = pickText(row.url, row.link);
      const title = pickText(row.title, itemUrl);
      const text = stripLightHtml(pickText(row.description, row.snippet, row.age));
      if (!itemUrl && !title) return null;
      return { title, url: itemUrl, text };
    });
    // Prefer web results; fill remaining slots from news if needed.
    const merged = mergeSearchItems(mappedWeb, mappedNews, maxResults);
    return { items: withItemIds(merged).slice(0, maxResults) };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

function citationItemsFromUnknown(
  value: unknown,
  maxItems: number
): Array<{ title: string; url: string; text: string }> {
  const out: Array<{ title: string; url: string; text: string }> = [];
  const list = Array.isArray(value) ? value : [];
  for (const entry of list) {
    if (typeof entry === 'string') {
      const url = normalizePublicHttpsUrl(entry);
      if (url) out.push({ title: titleFromSearchUrl(url), url, text: '' });
    } else if (entry && typeof entry === 'object') {
      const row = entry as Record<string, unknown>;
      // xAI may use type url_citation, or omit type with only url/title.
      if (
        row.type === 'url_citation' ||
        row.type === 'citation' ||
        typeof row.url === 'string'
      ) {
        const url = normalizePublicHttpsUrl(String(row.url ?? row.uri ?? ''));
        if (url) {
          const rawTitle =
            typeof row.title === 'string'
              ? row.title.trim()
              : typeof row.name === 'string'
                ? row.name.trim()
                : '';
          // Grok often labels citations "1","2" — treat as weak.
          const title = isWeakSearchTitle(rawTitle, url) ? titleFromSearchUrl(url) : rawTitle;
          const snippet =
            typeof row.snippet === 'string'
              ? row.snippet
              : typeof row.text === 'string'
                ? row.text
                : typeof row.description === 'string'
                  ? row.description
                  : '';
          out.push({ title, url, text: snippet });
        }
      }
    }
    if (out.length >= maxItems) break;
  }
  return out;
}

/**
 * Grok/xAI Responses path: answer text + url_citation annotations.
 * 严格禁止发送已废弃的 `search_parameters`。
 */
async function searchGrok(
  query: string,
  service: ExtendedExternalSearchService,
  maxResults: number,
  timeoutMs: number,
  fetchImpl: typeof fetch | undefined,
  signal?: AbortSignal
): Promise<ExternalSearchResult> {
  const endpoint = defaultEndpoint('grok', service.endpoint);
  const model = (service.model?.trim() || DEFAULT_GROK_SEARCH_MODEL).slice(0, 120);
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) throw resolveSearchAbortError(signal);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('搜索超时。')), timeoutMs);
  try {
    const response = await executeSearchFetch(
      endpoint,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${service.apiKey!.trim()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          input: [
            {
              role: 'system',
              content:
                'You are a web research assistant. Prefer current public sources. Return a concise factual answer and rely on web/x search tools.',
            },
            { role: 'user', content: query },
          ],
          tools: [{ type: 'web_search' }, { type: 'x_search' }],
          store: false,
          stream: false,
        }),
        signal: controller.signal,
      },
      fetchImpl,
      'Grok Search'
    );
    const data = await readJson(response, 'Grok Search', service.apiKey, controller.signal);
    const output = Array.isArray(data.output) ? data.output : [];
    // Collect every assistant message block — Grok may stream multiple output items.
    const messageBlocks = output.filter(
      (item) =>
        item &&
        typeof item === 'object' &&
        (item as Record<string, unknown>).type === 'message' &&
        (item as Record<string, unknown>).role === 'assistant'
    );
    const message =
      messageBlocks[messageBlocks.length - 1] &&
      typeof messageBlocks[messageBlocks.length - 1] === 'object'
        ? (messageBlocks[messageBlocks.length - 1] as Record<string, unknown>)
        : {};
    const content = Array.isArray(message.content) ? (message.content as unknown[]) : [];
    const textParts = content.filter(
      (item) =>
        item &&
        typeof item === 'object' &&
        (item as Record<string, unknown>).type === 'output_text'
    );
    const textPart =
      (textParts[textParts.length - 1] as Record<string, unknown> | undefined) ?? {};
    const answer =
      typeof textPart.text === 'string' ? String(textPart.text).trim() : undefined;

    // Merge citations from top-level, all message annotations, and markdown links in answer.
    const annotationBags: unknown[] = [data.citations, textPart.annotations];
    for (const block of messageBlocks) {
      if (!block || typeof block !== 'object') continue;
      const blockContent = Array.isArray((block as Record<string, unknown>).content)
        ? ((block as Record<string, unknown>).content as unknown[])
        : [];
      for (const part of blockContent) {
        if (!part || typeof part !== 'object') continue;
        const row = part as Record<string, unknown>;
        if (row.type === 'output_text' && row.annotations != null) {
          annotationBags.push(row.annotations);
        }
      }
    }

    let rawItems: Array<{ title: string; url: string; text: string }> = [];
    for (const bag of annotationBags) {
      rawItems = mergeSearchItems(
        rawItems,
        citationItemsFromUnknown(bag, maxResults * 2),
        maxResults * 2
      );
    }
    if (answer) {
      const fromAnswer = extractLinksFromAnswerText(answer).map((item) => ({
        title: item.title,
        url: item.url,
        text: '',
      }));
      rawItems = mergeSearchItems(rawItems, fromAnswer, maxResults * 2);
    }

    const items = withItemIds(rawItems).slice(0, maxResults);
    // Keep a cleaned answer for tool/UI preview (drop dense [[n]](url) noise).
    const cleanedAnswer = answer ? cleanSearchAnswerForDisplay(answer) : undefined;
    return {
      ...(cleanedAnswer ? { answer: cleanedAnswer.slice(0, 2000) } : {}),
      items,
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * 调用 DeepSeek Search API（`POST /v1/tools/search`）。
 */
async function searchDeepSeek(
  query: string,
  service: ExtendedExternalSearchService,
  maxResults: number,
  timeoutMs: number,
  fetchImpl: typeof fetch | undefined,
  signal?: AbortSignal
): Promise<ExternalSearchResult> {
  const endpoint = defaultEndpoint('deepseek', service.endpoint);
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) throw resolveSearchAbortError(signal);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('搜索超时。')), timeoutMs);

  try {
    const response = await executeSearchFetch(
      endpoint,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${service.apiKey!.trim()}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          query,
          count: maxResults,
          ori_question: query,
          need_content: true,
        }),
        signal: controller.signal,
      },
      fetchImpl,
      'DeepSeek Search'
    );
    const data = await readJson(response, 'DeepSeek Search', service.apiKey, controller.signal);
    const results = Array.isArray(data.results)
      ? data.results
      : Array.isArray(data.data)
        ? data.data
        : [];
    const mapped = mapProviderRows(results, (row) => {
      const url = pickText(row.url, row.link);
      const title = pickText(row.title, row.name, url);
      const text = pickText(row.summary, row.snippet, row.content, row.description);
      if (!url && !title) return null;
      return {
        title,
        url,
        text: text.replace(/\s+/g, ' ').trim().slice(0, 1500),
      };
    });
    return { items: withItemIds(mapped).slice(0, maxResults) };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * 调用 DeepSeek Fetch API（`POST /v1/tools/fetch`）抓取指定公网 HTTPS 页面正文（含 SSRF 防护）。
 */
export async function runDeepSeekFetch(args: DeepSeekFetchArgs): Promise<DeepSeekFetchResult> {
  await assertSearchWebAccessAllowed();
  const apiKey = args.apiKey.trim();
  if (!apiKey) {
    return searchError('DeepSeek Fetch 需要配置 API Key。');
  }
  const targetUrl = assertSafePublicHttpsTargetUrl(args.url, 'DeepSeek Fetch').toString();

  let fetchEndpoint = 'https://api.deepseek.com/v1/tools/fetch';
  if (args.endpoint?.trim()) {
    const checked = assertSafePublicHttpsEndpoint(args.endpoint, 'DeepSeek Fetch')
      .toString()
      .replace(/\/+$/, '');
    fetchEndpoint = checked.endsWith('/tools/search')
      ? checked.replace(/\/tools\/search$/, '/tools/fetch')
      : checked;
  }

  const timeoutMs = clampInt(args.timeoutMs ?? 20_000, 3_000, 60_000, 20_000);
  const controller = new AbortController();
  const onAbort = () => controller.abort(args.signal?.reason);
  if (args.signal?.aborted) throw resolveSearchAbortError(args.signal);
  args.signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('网页抓取超时。')), timeoutMs);

  try {
    const response = await executeSearchFetch(
      fetchEndpoint,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ url: targetUrl }),
        signal: controller.signal,
      },
      args.fetchImpl,
      'DeepSeek Fetch'
    );
    const data = await readJson(response, 'DeepSeek Fetch', apiKey, controller.signal);
    const nested = asRecord(data.data) ?? data;
    const title = pickText(nested.title, titleFromSearchUrl(targetUrl));
    const content = pickText(nested.content, nested.text, nested.markdown);
    return {
      title,
      url: targetUrl,
      content,
    };
  } catch (error) {
    throw sanitizeExternalSearchError(error, apiKey);
  } finally {
    clearTimeout(timeout);
    args.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * 调用 Bocha 博查 Web Search API（`POST https://api.bochaai.com/v1/web-search`）。
 */
async function searchBocha(
  query: string,
  service: ExtendedExternalSearchService,
  maxResults: number,
  timeoutMs: number,
  fetchImpl: typeof fetch | undefined,
  signal?: AbortSignal
): Promise<ExternalSearchResult> {
  const endpoint = defaultEndpoint('bocha', service.endpoint);
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) throw resolveSearchAbortError(signal);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('搜索超时。')), timeoutMs);

  try {
    const response = await executeSearchFetch(
      endpoint,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${service.apiKey!.trim()}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          query,
          freshness: 'noLimit',
          summary: true,
          count: maxResults,
        }),
        signal: controller.signal,
      },
      fetchImpl,
      'Bocha 博查'
    );
    const data = await readJson(response, 'Bocha 博查', service.apiKey, controller.signal);
    const numericCode =
      typeof data.code === 'number'
        ? data.code
        : typeof data.code === 'string' && /^\d+$/.test(data.code.trim())
          ? Number(data.code.trim())
          : undefined;
    if (numericCode !== undefined && numericCode !== 200) {
      const msg = pickText(data.msg, data.message, `业务错误码 ${numericCode}`);
      return searchError(`Bocha 博查失败：${redactExternalSearchSecrets(msg, service.apiKey)}`);
    }

    const innerData = asRecord(data.data);
    const webPages = asRecord(innerData?.webPages) ?? asRecord(data.webPages);
    const rows = Array.isArray(webPages?.value)
      ? webPages.value
      : Array.isArray(data.results)
        ? data.results
        : [];
    const mapped = mapProviderRows(rows, (row) => {
      const url = pickText(row.url, row.link);
      const title = pickText(row.name, row.title, url);
      const text = pickText(row.summary, row.snippet, row.description);
      if (!url && !title) return null;
      return {
        title,
        url,
        text: text.replace(/\s+/g, ' ').trim().slice(0, 1500),
      };
    });
    return { items: withItemIds(mapped).slice(0, maxResults) };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * 调用 Exa AI Search API（`POST https://api.exa.ai/search`，`x-api-key` 鉴权）。
 */
async function searchExa(
  query: string,
  service: ExtendedExternalSearchService,
  maxResults: number,
  timeoutMs: number,
  fetchImpl: typeof fetch | undefined,
  signal?: AbortSignal
): Promise<ExternalSearchResult> {
  const endpoint = defaultEndpoint('exa', service.endpoint);
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) throw resolveSearchAbortError(signal);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('搜索超时。')), timeoutMs);

  try {
    const response = await executeSearchFetch(
      endpoint,
      {
        method: 'POST',
        headers: {
          'x-api-key': service.apiKey!.trim(),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          query,
          numResults: maxResults,
          contents: {
            highlights: { maxCharacters: 1200 },
            text: { maxCharacters: 1500 },
          },
        }),
        signal: controller.signal,
      },
      fetchImpl,
      'Exa AI'
    );
    const data = await readJson(response, 'Exa AI', service.apiKey, controller.signal);
    const rows = Array.isArray(data.results) ? data.results : [];
    const mapped = mapProviderRows(rows, (row) => {
      const url = pickText(row.url);
      const title = pickText(row.title, url);
      const highlights = Array.isArray(row.highlights) ? joinSnippets(row.highlights, 1200) : '';
      const text = highlights || pickText(row.text, row.summary, row.snippet);
      if (!url && !title) return null;
      return {
        title,
        url,
        text: text.replace(/\s+/g, ' ').trim().slice(0, 1500),
      };
    });
    return { items: withItemIds(mapped).slice(0, maxResults) };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * 调用用户自托管 SearXNG 实例（`GET {endpoint}/search?q=...&format=json`）。
 * 无内置默认公共实例；对返回 HTML 或未开启 JSON 输出的实例明确给出 `format=json` 配置指引。
 */
async function searchSearxng(
  query: string,
  service: ExtendedExternalSearchService,
  maxResults: number,
  timeoutMs: number,
  fetchImpl: typeof fetch | undefined,
  signal?: AbortSignal
): Promise<ExternalSearchResult> {
  const rawEndpoint = service.endpoint?.trim();
  if (!rawEndpoint) {
    return searchError('SearXNG 需要先配置自托管实例 Endpoint。');
  }
  const checkedUrl = assertSafePublicHttpsEndpoint(rawEndpoint, 'SearXNG');
  const cleanPath = checkedUrl.pathname.replace(/\/+$/, '');
  checkedUrl.pathname = cleanPath.toLowerCase().endsWith('/search')
    ? cleanPath
    : `${cleanPath}/search`;
  checkedUrl.searchParams.set('q', query);
  checkedUrl.searchParams.set('format', 'json');

  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  const optionalKey = service.apiKey?.trim();
  if (optionalKey) {
    headers.Authorization = `Bearer ${optionalKey}`;
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) throw resolveSearchAbortError(signal);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('搜索超时。')), timeoutMs);

  try {
    const response = await executeSearchFetch(
      checkedUrl.toString(),
      {
        method: 'GET',
        headers,
        signal: controller.signal,
      },
      fetchImpl,
      'SearXNG'
    );
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    const text = await readLimitedSearchResponseText(
      response,
      response.ok ? MAX_EXTERNAL_SEARCH_JSON_BYTES : MAX_EXTERNAL_SEARCH_ERROR_BYTES,
      'SearXNG',
      controller.signal
    );
    if (!response.ok) {
      const safeSnippet = redactExternalSearchSecrets(text, optionalKey).slice(0, 240);
      return searchError(`SearXNG 失败：HTTP ${response.status} ${safeSnippet}`);
    }
    const trimmed = text.trim();
    if (contentType.includes('text/html') || trimmed.startsWith('<')) {
      return searchError(
        'SearXNG 实例返回了 HTML 页面而非 JSON（可能未启用 format=json 输出）。请在 SearXNG settings.yml 的 search.formats 中启用 json。'
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return searchError(
        'SearXNG 实例未返回有效 JSON（请确认实例已启用 format=json 输出）。'
      );
    }
    const data = asRecord(parsed);
    if (!data) {
      return searchError('SearXNG 返回了非对象 JSON。');
    }

    const rows = Array.isArray(data.results) ? data.results : [];
    const mapped = mapProviderRows(rows, (row) => {
      const url = pickText(row.url);
      const title = pickText(row.title, url);
      const snippet = pickText(row.content, row.snippet);
      if (!url && !title) return null;
      return {
        title,
        url,
        text: snippet.replace(/\s+/g, ' ').trim().slice(0, 1500),
      };
    });
    return { items: withItemIds(mapped).slice(0, maxResults) };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function runExternalSearch(args: ExternalSearchRunArgs): Promise<ExternalSearchResult> {
  await assertSearchWebAccessAllowed();
  const query = args.query.trim();
  if (!query) return searchError('搜索 query 不能为空。');
  if (query.length > 500) return searchError('搜索 query 过长（最多 500 字符）。');
  if (
    externalSearchProviderRequiresApiKey(args.service.kind, args.service.endpoint) &&
    !args.service.apiKey?.trim()
  ) {
    return searchError(`${allExternalSearchProviderLabels[args.service.kind]} 需要配置 API Key。`);
  }

  const maxResults = clampInt(
    args.maxResults ?? DEFAULT_EXTERNAL_SEARCH_MAX_RESULTS,
    1,
    MAX_EXTERNAL_SEARCH_RESULTS,
    DEFAULT_EXTERNAL_SEARCH_MAX_RESULTS
  );
  const timeoutMs = clampInt(args.timeoutMs ?? 20_000, 3_000, 60_000, 20_000);
  const fetchImpl = args.fetchImpl;

  try {
    switch (args.service.kind) {
      case 'tavily':
        return await searchTavily(query, args.service, maxResults, timeoutMs, fetchImpl, args.signal);
      case 'brave':
        return await searchBrave(query, args.service, maxResults, timeoutMs, fetchImpl, args.signal);
      case 'grok':
        return await searchGrok(query, args.service, maxResults, timeoutMs, fetchImpl, args.signal);
      case 'bing':
        return await searchBing(query, args.service, maxResults, timeoutMs, fetchImpl, args.signal);
      case 'duckduckgo':
        return await searchDuckDuckGo(query, args.service, maxResults, timeoutMs, fetchImpl, args.signal);
      case 'firecrawl':
        return await searchFirecrawl(query, args.service, maxResults, timeoutMs, fetchImpl, args.signal);
      case 'deepseek':
        return await searchDeepSeek(query, args.service, maxResults, timeoutMs, fetchImpl, args.signal);
      case 'bocha':
        return await searchBocha(query, args.service, maxResults, timeoutMs, fetchImpl, args.signal);
      case 'exa':
        return await searchExa(query, args.service, maxResults, timeoutMs, fetchImpl, args.signal);
      case 'searxng':
        return await searchSearxng(query, args.service, maxResults, timeoutMs, fetchImpl, args.signal);
      default:
        return searchError(
          `不支持的外部搜索类型：${String((args.service as ExtendedExternalSearchService).kind)}`
        );
    }
  } catch (error) {
    throw sanitizeExternalSearchError(error, args.service.apiKey);
  }
}

export function formatExternalSearchToolResult(result: ExternalSearchResult): string {
  return JSON.stringify({
    ...(result.answer ? { answer: result.answer } : {}),
    items: result.items.map((item) => ({
      index: item.index,
      id: item.id,
      title: item.title,
      url: item.url,
      text: item.text,
    })),
  });
}

export function citationsFromExternalSearchResults(
  results: readonly ExternalSearchResult[]
): WebCitation[] {
  const out: WebCitation[] = [];
  for (const result of results) {
    for (const item of result.items) {
      out.push({
        url: item.url,
        title: item.title,
        id: item.id,
        index: item.index,
        ...(item.text?.trim() ? { text: item.text.trim().slice(0, 400) } : {}),
      });
    }
  }
  return out;
}

/** Resolve normal HTTPS links and the search prompt's one-based `index:id` links. */
export function resolveMessageMarkdownLink(
  raw: string,
  citations: readonly WebCitation[] = []
): string | null {
  const value = raw.trim();
  if (!value) return null;
  const direct = normalizePublicHttpsUrl(value);
  if (direct) return direct;

  const match = /^(\d+):([A-Za-z0-9_-]{1,120})$/.exec(value);
  if (!match) return null;
  const index = Number(match[1]);
  const id = match[2];
  if (!Number.isSafeInteger(index) || index <= 0) return null;
  const hasStableMetadata = citations.some((item) => item.id || item.index !== undefined);
  const citation =
    citations.find((item) => item.index === index && item.id === id) ??
    citations.find((item) => item.id === id) ??
    (!hasStableMetadata ? citations[index - 1] : undefined);
  return citation ? normalizePublicHttpsUrl(citation.url) : null;
}

export function parseSearchWebToolArguments(raw: unknown): string {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return searchError('search_web 缺少 query。');
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const query = (parsed as Record<string, unknown>).query;
        if (typeof query === 'string' && query.trim()) return query.trim();
      }
    } catch {
      // Treat plain string as the query itself.
      return trimmed.slice(0, 500);
    }
    return trimmed.slice(0, 500);
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const query = (raw as Record<string, unknown>).query;
    if (typeof query === 'string' && query.trim()) return query.trim().slice(0, 500);
  }
  return searchError('search_web 参数无效：需要 { "query": "..." }。');
}
