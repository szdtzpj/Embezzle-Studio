import { defaultExternalSearchSettings as catalogDefaultExternalSearch } from '../data/providerCatalog';
import type {
  ExternalSearchProviderKind,
  ExternalSearchService,
  ExternalSearchSettings,
  WebCitation,
} from '../domain/types';

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

export const externalSearchProviderKinds = [
  'bing',
  'duckduckgo',
  'tavily',
  'brave',
  'firecrawl',
  'grok',
] as const satisfies readonly ExternalSearchProviderKind[];

export const externalSearchProviderLabels: Record<ExternalSearchProviderKind, string> = {
  bing: 'Bing（免费）',
  duckduckgo: 'DuckDuckGo',
  tavily: 'Tavily',
  brave: 'Brave Search',
  firecrawl: 'Firecrawl',
  grok: 'Grok Search (xAI)',
};

export const externalSearchProviderHints: Record<ExternalSearchProviderKind, string> = {
  bing: '本地匿名抓取 bing.com，无需 API Key',
  duckduckgo: '本地匿名搜索，无需 API Key',
  tavily: '需 API Key · 面向 AI 的搜索 API',
  brave: '需 API Key · Brave Search API',
  firecrawl: '可选 API Key',
  grok: '需 API Key · xAI web_search / x_search',
};

/** Kinds that can run without a user API key (anonymous scrape or provider quota). */
export function externalSearchProviderAllowsAnonymous(
  kind: ExternalSearchProviderKind,
  _endpoint?: string
): boolean {
  return kind === 'bing' || kind === 'duckduckgo' || kind === 'firecrawl';
}

/** Kinds that refuse to start without an API key. */
export function externalSearchProviderRequiresApiKey(
  kind: ExternalSearchProviderKind,
  _endpoint?: string
): boolean {
  return kind === 'tavily' || kind === 'brave' || kind === 'grok';
}

export function isExternalSearchServiceConfigured(service: ExternalSearchService): boolean {
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
  service: ExternalSearchService;
  maxResults?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
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
    if (!id || seen.has(id) || !externalSearchProviderKinds.includes(kind as ExternalSearchProviderKind)) {
      continue;
    }
    seen.add(id);
    const name =
      (typeof record.name === 'string' && record.name.trim()) ||
      externalSearchProviderLabels[kind as ExternalSearchProviderKind];
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
  settings: ExternalSearchSettings
): ExternalSearchService | null {
  const selectedId = settings.selectedServiceId;
  const service =
    settings.services.find((item) => item.id === selectedId) ??
    settings.services[0];
  if (!service || !isExternalSearchServiceConfigured(service)) return null;
  return service;
}

/** Selected service is ready (has key, or free/anonymous kind). */
export function isExternalSearchReady(settings: ExternalSearchSettings): boolean {
  return resolveSelectedExternalSearchService(settings) != null;
}

/** Runtime path: user enabled external search and a configured service is selected. */
export function resolveActiveExternalSearchService(
  settings: ExternalSearchSettings
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
    const url = new URL(trimmed.startsWith('//') ? `https:${trimmed}` : trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host.endsWith('.local')
    ) {
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
  if (t === url) return true;
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

function withItemIds(items: Array<{ title: string; url: string; text: string }>): ExternalSearchResultItem[] {
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
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === '::' ||
    host === '::1'
  ) {
    return true;
  }
  if (
    host.includes(':') &&
    (host.startsWith('fc') ||
      host.startsWith('fd') ||
      /^fe[89ab]/.test(host) ||
      host.startsWith('ff'))
  ) {
    return true;
  }

  const ipv4Candidate = host.startsWith('::ffff:') ? host.slice('::ffff:'.length) : host;
  const parts = ipv4Candidate.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const bytes = parts.map(Number);
  if (bytes.some((byte) => byte < 0 || byte > 255)) return true;
  const [a, b] = bytes;
  return Boolean(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function assertSafePublicHttpsEndpoint(raw: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return searchError(`${label} Endpoint 不是有效网址。`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    return searchError(`${label} Endpoint 必须是无凭据、无查询参数的 HTTPS 地址。`);
  }
  if (isBlockedEndpointHostname(url.hostname)) {
    return searchError(`${label} Endpoint 不能指向本机或私网主机名。`);
  }
  return url;
}

function defaultEndpoint(kind: ExternalSearchProviderKind, override?: string): string {
  if (override?.trim()) {
    return assertSafePublicHttpsEndpoint(override, externalSearchProviderLabels[kind]).toString().replace(/\/+$/, '');
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
  fetchImpl: typeof fetch,
  signal?: AbortSignal
): Promise<string> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) throw signal.reason ?? new Error('搜索已取消。');
  signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('搜索超时。')), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const text = await readLimitedSearchResponseText(
      response,
      response.ok ? MAX_EXTERNAL_SEARCH_HTML_BYTES : MAX_EXTERNAL_SEARCH_ERROR_BYTES,
      label
    );
    if (!response.ok) {
      return searchError(`${label} 失败：HTTP ${response.status} ${text.slice(0, 240)}`);
    }
    return text;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function readLimitedSearchResponseText(
  response: Response,
  maxBytes: number,
  label: string
): Promise<string> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return searchError(`${label} 响应过大（上限 ${Math.round(maxBytes / 1024)} KiB）。`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      return searchError(`${label} 响应过大（上限 ${Math.round(maxBytes / 1024)} KiB）。`);
    }
    return text;
  }

  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      totalBytes += value?.byteLength ?? 0;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return searchError(`${label} 响应过大（上限 ${Math.round(maxBytes / 1024)} KiB）。`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

async function searchBing(
  query: string,
  service: ExternalSearchService,
  maxResults: number,
  timeoutMs: number,
  fetchImpl: typeof fetch,
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
    signal
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
  return { items: withItemIds(items) };
}

async function searchDuckDuckGo(
  query: string,
  service: ExternalSearchService,
  maxResults: number,
  timeoutMs: number,
  fetchImpl: typeof fetch,
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
      signal
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
    signal
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
    const snippetMatch = after.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div|span)>/i);
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
  service: ExternalSearchService,
  maxResults: number,
  timeoutMs: number,
  fetchImpl: typeof fetch,
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
  if (signal?.aborted) throw signal.reason ?? new Error('搜索已取消。');
  signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('搜索超时。')), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query,
        limit: maxResults,
      }),
      signal: controller.signal,
    });
    const data = await readJson(response, 'Firecrawl');
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
    const items = withItemIds(mapped);
    return { items };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function readJson(
  response: Response,
  label: string
): Promise<Record<string, unknown>> {
  const text = await readLimitedSearchResponseText(
    response,
    response.ok ? MAX_EXTERNAL_SEARCH_JSON_BYTES : MAX_EXTERNAL_SEARCH_ERROR_BYTES,
    label
  );
  if (!response.ok) {
    return searchError(`${label} 失败：HTTP ${response.status} ${text.slice(0, 240)}`);
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
  service: ExternalSearchService,
  maxResults: number,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  signal?: AbortSignal
): Promise<ExternalSearchResult> {
  const endpoint = defaultEndpoint('tavily', service.endpoint);
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) throw signal.reason ?? new Error('搜索已取消。');
  signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('搜索超时。')), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
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
    });
    const data = await readJson(response, 'Tavily');
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
    const items = withItemIds(mapped);
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
  service: ExternalSearchService,
  maxResults: number,
  timeoutMs: number,
  fetchImpl: typeof fetch,
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
  if (signal?.aborted) throw signal.reason ?? new Error('搜索已取消。');
  signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('搜索超时。')), timeoutMs);
  try {
    const response = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': service.apiKey!.trim(),
      },
      signal: controller.signal,
    });
    const data = await readJson(response, 'Brave Search');
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

function citationItemsFromUnknown(value: unknown, maxItems: number): Array<{ title: string; url: string; text: string }> {
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
 * Titles are frequently just indexes; enrich from URL and markdown links in the answer.
 */
async function searchGrok(
  query: string,
  service: ExternalSearchService,
  maxResults: number,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  signal?: AbortSignal
): Promise<ExternalSearchResult> {
  const endpoint = defaultEndpoint('grok', service.endpoint);
  const model = (service.model?.trim() || DEFAULT_GROK_SEARCH_MODEL).slice(0, 120);
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) throw signal.reason ?? new Error('搜索已取消。');
  signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('搜索超时。')), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
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
    });
    const data = await readJson(response, 'Grok Search');
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

export async function runExternalSearch(args: ExternalSearchRunArgs): Promise<ExternalSearchResult> {
  const query = args.query.trim();
  if (!query) return searchError('搜索 query 不能为空。');
  if (query.length > 500) return searchError('搜索 query 过长（最多 500 字符）。');
  if (
    externalSearchProviderRequiresApiKey(args.service.kind, args.service.endpoint) &&
    !args.service.apiKey?.trim()
  ) {
    return searchError(`${externalSearchProviderLabels[args.service.kind]} 需要配置 API Key。`);
  }

  const maxResults = clampInt(
    args.maxResults ?? DEFAULT_EXTERNAL_SEARCH_MAX_RESULTS,
    1,
    MAX_EXTERNAL_SEARCH_RESULTS,
    DEFAULT_EXTERNAL_SEARCH_MAX_RESULTS
  );
  const timeoutMs = clampInt(args.timeoutMs ?? 20_000, 3_000, 60_000, 20_000);
  const fetchImpl = args.fetchImpl ?? fetch;

  switch (args.service.kind) {
    case 'tavily':
      return searchTavily(query, args.service, maxResults, timeoutMs, fetchImpl, args.signal);
    case 'brave':
      return searchBrave(query, args.service, maxResults, timeoutMs, fetchImpl, args.signal);
    case 'grok':
      return searchGrok(query, args.service, maxResults, timeoutMs, fetchImpl, args.signal);
    case 'bing':
      return searchBing(query, args.service, maxResults, timeoutMs, fetchImpl, args.signal);
    case 'duckduckgo':
      return searchDuckDuckGo(query, args.service, maxResults, timeoutMs, fetchImpl, args.signal);
    case 'firecrawl':
      return searchFirecrawl(query, args.service, maxResults, timeoutMs, fetchImpl, args.signal);
    default:
      return searchError(`不支持的外部搜索类型：${String((args.service as ExternalSearchService).kind)}`);
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
