import type {
  Capability,
  ModelInfo,
  ModelTask,
  ProviderCustomHeader,
  ProviderKind,
  ProviderProfile,
} from '../domain/types';
import {
  inferModelTask,
  normalizeRemoteModelEntry,
  type RemoteModelMetadata,
} from './modelCapabilities';

export type ProviderEndpointFamily =
  | 'openai-official'
  | 'anthropic-official'
  | 'gemini-official'
  | 'xai-official'
  | 'deepseek-official'
  | 'volcengine-ark'
  | 'bailian-payg'
  | 'bailian-coding-plan'
  | 'bailian-token-plan'
  | 'openai-compatible-custom'
  | 'invalid';

export type BailianRegion =
  | 'cn-beijing'
  | 'ap-southeast-1'
  | 'us-east-1'
  | 'eu-central-1'
  | 'ap-northeast-1';

export type ProviderSetupPolicy = 'allowed' | 'warning' | 'blocked';

export type ModelDiscoveryMode =
  | 'official-model-list'
  | 'best-effort-compatible-list'
  | 'optional-compatible-list'
  | 'blocked';

export interface ProviderEndpointInspection {
  valid: boolean;
  family: ProviderEndpointFamily;
  policy: ProviderSetupPolicy;
  official: boolean;
  normalizedBaseUrl?: string;
  hostname?: string;
  recommendedKind?: ProviderKind;
  kindCompatible: boolean;
  region?: BailianRegion;
  workspaceId?: string;
  legacyEndpoint?: boolean;
  modelDiscoveryMode: ModelDiscoveryMode;
  errors: string[];
  warnings: string[];
}

export interface ProviderEndpointInspectionOptions {
  kind?: ProviderKind;
  /**
   * The value is inspected in memory only. It is never returned, logged, or
   * included in an endpoint fingerprint.
   */
  apiKey?: string;
}

export interface ProviderEndpointBindingChange {
  changed: boolean;
  previousFingerprint?: string;
  nextFingerprint?: string;
  mustClearApiKey: boolean;
  mustClearModels: boolean;
  mustClearModelCandidates: boolean;
  reason?: string;
}

export type CapabilityMatrixStatus =
  | 'available'
  | 'provider-only'
  | 'unknown'
  | 'disabled'
  | 'blocked';

export type CapabilityEvidence =
  | 'user-override'
  | 'curated-catalog'
  | 'provider-list-or-inference'
  | 'name-inference'
  | 'none';

export interface CapabilityMatrixCell {
  capability: Capability;
  label: string;
  declared: boolean;
  status: CapabilityMatrixStatus;
  evidence: CapabilityEvidence;
  reason: string;
}

export interface ModelCapabilityMatrixRow {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  task: ModelTask;
  source: ModelInfo['source'];
  contextWindow?: number;
  cells: Record<Capability, CapabilityMatrixCell>;
}

export interface CapabilityMatrixOptions {
  platform?: 'android' | 'ios' | 'web' | string;
}

const openAiHost = 'api.openai.com';
const anthropicHost = 'api.anthropic.com';
const geminiHost = 'generativelanguage.googleapis.com';
const xaiHost = 'api.x.ai';
const deepSeekHost = 'api.deepseek.com';
const defaultAnthropicVersion = '2023-06-01';
const arkHosts = new Set([
  'ark.cn-beijing.volces.com',
  'ark.cn-beijing.volcengineapi.com',
]);
const bailianLegacyRegions = new Map<string, BailianRegion>([
  ['dashscope.aliyuncs.com', 'cn-beijing'],
  ['dashscope-intl.aliyuncs.com', 'ap-southeast-1'],
  ['dashscope-us.aliyuncs.com', 'us-east-1'],
]);
const bailianWorkspaceHost = new RegExp(
  '^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\\.' +
    '(cn-beijing|ap-southeast-1|us-east-1|eu-central-1|ap-northeast-1)\\.' +
    'maas\\.aliyuncs\\.com$'
);
const bailianCodingPlanHost = 'coding.dashscope.aliyuncs.com';
const bailianTokenPlanHost = 'token-plan.cn-beijing.maas.aliyuncs.com';

const capabilityOrder: Capability[] = [
  'text',
  'image-input',
  'video-input',
  'file-input',
  'reasoning',
  'web-search',
  'image-generation',
  'video-generation',
  'speech-to-text',
  'text-to-speech',
  'tool-calling',
  'embedding',
  'rerank',
  'streaming',
  'mcp',
];

export const capabilityMatrixLabels: Record<Capability, string> = {
  text: '文本',
  'image-input': '图片输入',
  'video-input': '视频输入',
  'file-input': '文件输入',
  'tool-calling': '工具调用',
  reasoning: '深度思考',
  'web-search': '联网搜索',
  'image-generation': '图片生成',
  'video-generation': '视频生成',
  'speech-to-text': '语音转写',
  'text-to-speech': '语音合成',
  embedding: '嵌入',
  rerank: '重排',
  streaming: '流式输出',
  mcp: 'MCP',
};

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.+$/, '');
  return normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]';
}

function normalizedPathname(url: URL): string {
  const path = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return path === '/' ? '' : path;
}

function normalizedUrl(url: URL, pathname: string): string {
  const normalized = new URL(url.toString());
  normalized.pathname = pathname || '/';
  normalized.search = '';
  normalized.hash = '';
  return normalized.toString().replace(/\/+$/, '');
}

function normalizeKnownEndpointPath(
  url: URL,
  basePath: string,
  suffixes: readonly string[],
  extraExactPaths: readonly string[] = []
): string | undefined {
  const path = normalizedPathname(url).toLowerCase();
  const accepted = new Set([
    '',
    basePath,
    ...extraExactPaths,
    ...suffixes.map((suffix) => `${basePath}/${suffix}`),
  ]);
  return accepted.has(path) ? normalizedUrl(url, basePath) : undefined;
}

function normalizeCustomEndpoint(url: URL): string {
  let path = normalizedPathname(url);
  path = path.replace(/\/(?:chat\/completions|models|responses)$/i, '');
  if (!path) {
    path = '/v1';
  }
  return normalizedUrl(url, path);
}

function recommendedKindForFamily(family: ProviderEndpointFamily): ProviderKind | undefined {
  if (family === 'openai-official') return 'openai-compatible';
  if (family === 'anthropic-official') return 'anthropic';
  if (family === 'gemini-official') return 'gemini';
  if (family === 'xai-official') return 'xai-grok';
  if (family === 'deepseek-official') return 'deepseek';
  if (family === 'volcengine-ark') return 'volcengine-ark';
  if (
    family === 'bailian-payg' ||
    family === 'bailian-coding-plan' ||
    family === 'bailian-token-plan'
  ) {
    return 'bailian-compatible';
  }
  if (family === 'openai-compatible-custom') return 'custom';
  return undefined;
}

function kindMatchesFamily(kind: ProviderKind | undefined, family: ProviderEndpointFamily): boolean {
  if (!kind) return true;
  if (family === 'openai-official') return kind === 'custom' || kind === 'openai-compatible';
  if (family === 'anthropic-official') return kind === 'anthropic';
  if (family === 'gemini-official') return kind === 'gemini';
  if (family === 'xai-official') return kind === 'xai-grok';
  if (family === 'deepseek-official') return kind === 'deepseek' || kind === 'custom';
  if (family === 'volcengine-ark') return kind === 'volcengine-ark';
  if (
    family === 'bailian-payg' ||
    family === 'bailian-coding-plan' ||
    family === 'bailian-token-plan'
  ) {
    return kind === 'bailian-compatible';
  }
  if (family === 'openai-compatible-custom') {
    return kind === 'custom' || kind === 'openai-compatible' || kind === 'new-api-relay';
  }
  return false;
}

function planKeyDetected(apiKey?: string): boolean {
  return apiKey?.trim().toLowerCase().startsWith('sk-sp-') === true;
}

/**
 * Inspects and canonicalizes a provider endpoint without performing DNS,
 * network, authentication, or inference calls.
 */
export function inspectProviderEndpoint(
  rawBaseUrl: string,
  options: ProviderEndpointInspectionOptions = {}
): ProviderEndpointInspection {
  const errors: string[] = [];
  const warnings: string[] = [];
  const value = rawBaseUrl.trim();

  if (!value) {
    return {
      valid: false,
      family: 'invalid',
      policy: 'blocked',
      official: false,
      kindCompatible: false,
      modelDiscoveryMode: 'blocked',
      errors: ['请填写 Base URL。'],
      warnings,
    };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return {
      valid: false,
      family: 'invalid',
      policy: 'blocked',
      official: false,
      kindCompatible: false,
      modelDiscoveryMode: 'blocked',
      errors: ['Base URL 不是有效网址，请填写完整地址。'],
      warnings,
    };
  }

  if (url.username || url.password) {
    errors.push('Base URL 不能包含用户名或密码。');
  }
  if (url.search || url.hash) {
    errors.push('Base URL 不能包含查询参数或片段。');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) {
    errors.push('Base URL 必须使用 HTTPS；只有本机回环调试地址可以使用 HTTP。');
  }

  const hostname = url.hostname.toLowerCase().replace(/\.+$/, '');
  if (url.hostname !== hostname) url.hostname = hostname;
  const hasOfficialPort = url.port.length > 0;
  let family: ProviderEndpointFamily = 'openai-compatible-custom';
  let official = false;
  let normalizedBaseUrl: string | undefined;
  let region: BailianRegion | undefined;
  let workspaceId: string | undefined;
  let legacyEndpoint = false;
  let modelDiscoveryMode: ModelDiscoveryMode = 'optional-compatible-list';
  let policy: ProviderSetupPolicy = 'warning';

  if (hostname === bailianCodingPlanHost) {
    family = 'bailian-coding-plan';
    official = true;
    region = 'cn-beijing';
    normalizedBaseUrl = normalizeKnownEndpointPath(url, '/v1', ['models', 'chat/completions', 'responses']);
    policy = 'blocked';
    modelDiscoveryMode = 'blocked';
    errors.push('百炼 Coding Plan 仅允许受支持的编程工具使用，不能接入 Embezzle Studio 这类自定义应用。');
  } else if (hostname === bailianTokenPlanHost) {
    family = 'bailian-token-plan';
    official = true;
    region = 'cn-beijing';
    normalizedBaseUrl = normalizeKnownEndpointPath(
      url,
      '/compatible-mode/v1',
      ['models', 'chat/completions', 'responses']
    );
    policy = 'blocked';
    modelDiscoveryMode = 'blocked';
    errors.push('百炼 Token Plan 团队版仅允许受支持的编程工具或 OpenClaw 使用，不能接入自定义应用。');
  } else if (hostname === openAiHost) {
    family = 'openai-official';
    official = true;
    normalizedBaseUrl = normalizeKnownEndpointPath(
      url,
      '/v1',
      [
        'models',
        'chat/completions',
        'responses',
        'images/generations',
        'images/edits',
        'audio/transcriptions',
        'audio/speech',
      ]
    );
    policy = 'allowed';
    modelDiscoveryMode = 'official-model-list';
  } else if (hostname === anthropicHost) {
    family = 'anthropic-official';
    official = true;
    normalizedBaseUrl = normalizeKnownEndpointPath(url, '/v1', ['messages', 'models']);
    policy = 'allowed';
    modelDiscoveryMode = 'official-model-list';
  } else if (hostname === geminiHost) {
    family = 'gemini-official';
    official = true;
    const rawPath = normalizedPathname(url).toLowerCase();
    normalizedBaseUrl = normalizeKnownEndpointPath(
      url,
      '/v1beta',
      ['models', 'openai', 'openai/models', 'openai/chat/completions'],
      ['/v1', '/v1/models']
    );
    policy = 'allowed';
    modelDiscoveryMode = 'official-model-list';
    if (rawPath.startsWith('/v1beta/openai')) {
      warnings.push('已将 Gemini OpenAI 兼容路径规范化为官方原生 /v1beta 端点基础路径。');
    }
  } else if (hostname === xaiHost) {
    family = 'xai-official';
    official = true;
    normalizedBaseUrl = normalizeKnownEndpointPath(
      url,
      '/v1',
      ['models', 'chat/completions', 'responses', 'images/generations', 'images/edits']
    );
    policy = 'allowed';
    modelDiscoveryMode = 'official-model-list';
  } else if (hostname === deepSeekHost) {
    family = 'deepseek-official';
    official = true;
    normalizedBaseUrl = normalizeKnownEndpointPath(
      url,
      '/v1',
      ['models', 'chat/completions', 'responses'],
      ['/anthropic', '/anthropic/v1/messages']
    );
    policy = 'allowed';
    modelDiscoveryMode = 'official-model-list';
  } else if (arkHosts.has(hostname)) {
    family = 'volcengine-ark';
    official = true;
    normalizedBaseUrl = normalizeKnownEndpointPath(
      url,
      '/api/v3',
      ['models', 'chat/completions', 'responses', 'contents/generations/tasks']
    );
    policy = 'allowed';
    modelDiscoveryMode = 'best-effort-compatible-list';
    warnings.push('火山方舟数据面的 /models 不是稳定公开契约；列表只能作为候选，不能证明账号有调用权限。');
  } else {
    const legacyRegion = bailianLegacyRegions.get(hostname);
    const workspaceMatch = hostname.match(bailianWorkspaceHost);
    if (legacyRegion || workspaceMatch) {
      family = 'bailian-payg';
      official = true;
      region = legacyRegion ?? (workspaceMatch?.[2] as BailianRegion);
      workspaceId = workspaceMatch?.[1];
      legacyEndpoint = Boolean(legacyRegion && hostname !== 'dashscope-us.aliyuncs.com');
      normalizedBaseUrl = normalizeKnownEndpointPath(
        url,
        '/compatible-mode/v1',
        ['models', 'chat/completions', 'responses']
      );
      policy = 'allowed';
      modelDiscoveryMode = 'optional-compatible-list';
      if (legacyEndpoint) {
        warnings.push('该百炼旧域名仍可使用；北京和新加坡建议改用业务空间专属域名。');
      }
      warnings.push('百炼兼容 /models 可能不可用；模型目录或列表也不能证明当前 API Key 有实际调用权限。');
    } else {
      normalizedBaseUrl = normalizeCustomEndpoint(url);
      warnings.push('这是用户指定的兼容端点；地址本身不能证明模型能力、账号权限或计费规则。');
    }
  }

  if (official && hasOfficialPort) {
    errors.push('官方服务商地址不能使用自定义端口。');
  }
  if (official && !normalizedBaseUrl) {
    errors.push('Base URL 路径不是该官方服务商支持的基础路径或已知接口路径。');
  }
  if (planKeyDetected(options.apiKey)) {
    policy = 'blocked';
    modelDiscoveryMode = 'blocked';
    errors.push('检测到百炼套餐专属 API Key；自定义应用不得使用 Coding Plan 或 Token Plan 密钥。');
  }

  const recommendedKind = recommendedKindForFamily(family);
  const kindCompatible = kindMatchesFamily(options.kind, family);
  if (!kindCompatible) {
    errors.push(`当前服务商类型与端点协议不一致；应选择 ${recommendedKind ?? '兼容服务商'} 类型。`);
  }

  if (errors.length > 0) {
    policy = 'blocked';
  }

  return {
    valid: errors.length === 0 && Boolean(normalizedBaseUrl),
    family,
    policy,
    official,
    normalizedBaseUrl,
    hostname,
    recommendedKind,
    kindCompatible,
    ...(region ? { region } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(legacyEndpoint ? { legacyEndpoint: true } : {}),
    modelDiscoveryMode,
    errors,
    warnings,
  };
}

export function providerEndpointFingerprint(
  provider: Pick<ProviderProfile, 'kind' | 'baseUrl'>
): string | undefined {
  const inspection = inspectProviderEndpoint(provider.baseUrl, { kind: provider.kind });
  if (!inspection.valid || !inspection.normalizedBaseUrl) {
    return undefined;
  }
  return `${provider.kind}::${inspection.normalizedBaseUrl}`;
}

/**
 * Returns true only for the exact official OpenAI Responses base route that
 * has been reviewed for provider-hosted MCP execution. Hostname lookalikes,
 * custom ports, compatible relays, and a mismatched provider kind all fail
 * closed even when their URL would otherwise normalize.
 */
export function isExactOfficialOpenAiProvider(
  provider: Pick<ProviderProfile, 'kind' | 'baseUrl'>
): boolean {
  // ProviderKind currently names the dedicated OpenAI protocol choice
  // `openai-compatible`; `custom` is intentionally not accepted here even
  // when it points at api.openai.com.
  if (provider.kind !== 'openai-compatible') {
    return false;
  }
  const inspection = inspectProviderEndpoint(provider.baseUrl, { kind: provider.kind });
  return Boolean(
    inspection.valid &&
    inspection.official &&
    inspection.kindCompatible &&
    inspection.family === 'openai-official' &&
    inspection.hostname === openAiHost &&
    inspection.normalizedBaseUrl === 'https://api.openai.com/v1'
  );
}

/**
 * Returns true only for the exact official Anthropic API base route.
 */
export function isExactOfficialAnthropicProvider(
  provider: Pick<ProviderProfile, 'kind' | 'baseUrl'>
): boolean {
  if (provider.kind !== 'anthropic') {
    return false;
  }
  const inspection = inspectProviderEndpoint(provider.baseUrl, { kind: provider.kind });
  return Boolean(
    inspection.valid &&
    inspection.official &&
    inspection.kindCompatible &&
    inspection.family === 'anthropic-official' &&
    inspection.hostname === anthropicHost &&
    inspection.normalizedBaseUrl === 'https://api.anthropic.com/v1'
  );
}

/**
 * Returns true only for the exact official Google Gemini API base route.
 */
export function isExactOfficialGeminiProvider(
  provider: Pick<ProviderProfile, 'kind' | 'baseUrl'>
): boolean {
  if (provider.kind !== 'gemini') {
    return false;
  }
  const inspection = inspectProviderEndpoint(provider.baseUrl, { kind: provider.kind });
  return Boolean(
    inspection.valid &&
    inspection.official &&
    inspection.kindCompatible &&
    inspection.family === 'gemini-official' &&
    inspection.hostname === geminiHost &&
    inspection.normalizedBaseUrl === 'https://generativelanguage.googleapis.com/v1beta'
  );
}

/**
 * Returns true only for the exact official xAI Grok API base route.
 */
export function isExactOfficialXaiProvider(
  provider: Pick<ProviderProfile, 'kind' | 'baseUrl'>
): boolean {
  if (provider.kind !== 'xai-grok') {
    return false;
  }
  const inspection = inspectProviderEndpoint(provider.baseUrl, { kind: provider.kind });
  return Boolean(
    inspection.valid &&
    inspection.official &&
    inspection.kindCompatible &&
    inspection.family === 'xai-official' &&
    inspection.hostname === xaiHost &&
    inspection.normalizedBaseUrl === 'https://api.x.ai/v1'
  );
}

/**
 * Returns true only for the official DeepSeek API host. Accepts both the dedicated
 * `deepseek` kind and historical `custom` DeepSeek profiles (or URL-only checks),
 * while rejecting relays, mismatched kinds, and lookalike hosts.
 */
export function isExactOfficialDeepSeekProvider(
  provider: Pick<ProviderProfile, 'baseUrl'> & { kind?: ProviderKind }
): boolean {
  if (provider.kind !== undefined && provider.kind !== 'deepseek' && provider.kind !== 'custom') {
    return false;
  }
  const inspection = inspectProviderEndpoint(
    provider.baseUrl,
    provider.kind ? { kind: provider.kind } : {}
  );
  return Boolean(
    inspection.valid &&
    inspection.official &&
    inspection.kindCompatible &&
    inspection.family === 'deepseek-official' &&
    inspection.hostname === deepSeekHost &&
    inspection.normalizedBaseUrl === 'https://api.deepseek.com/v1'
  );
}

/**
 * 判断服务商是否为中转站或自定义兼容端点（需要降级走通用 OpenAI 兼容协议）。
 */
export function isRelayOrCustomProvider(
  provider: Pick<ProviderProfile, 'kind' | 'baseUrl'>
): boolean {
  if (provider.kind === 'new-api-relay') {
    return true;
  }
  if (
    isExactOfficialOpenAiProvider(provider) ||
    isExactOfficialAnthropicProvider(provider) ||
    isExactOfficialGeminiProvider(provider) ||
    isExactOfficialXaiProvider(provider) ||
    isExactOfficialDeepSeekProvider(provider)
  ) {
    return false;
  }
  const kindInspection = inspectProviderEndpoint(provider.baseUrl, { kind: provider.kind });
  if (
    (provider.kind === 'volcengine-ark' &&
      kindInspection.valid &&
      kindInspection.family === 'volcengine-ark') ||
    (provider.kind === 'bailian-compatible' &&
      kindInspection.valid &&
      kindInspection.family === 'bailian-payg')
  ) {
    return false;
  }
  if (provider.kind === 'custom') {
    return true;
  }
  // 脱离 kind 约束检验 URL 基础安全与官方归属：
  // 凡是合法 HTTPS/本机回环且非任何官方主机的端点（包含仿冒官方域名与各类第三方中转），
  // 均判定为中转或自定义兼容端点；错配的其他官方主机或非法/不安全 URL 返回 false。
  const urlInspection = inspectProviderEndpoint(provider.baseUrl);
  return urlInspection.valid && !urlInspection.official;
}

/** 服务商自定义请求头数量与长度限制（与持久化/备份层保持单源一致）。 */
export const PROVIDER_CUSTOM_HEADER_LIMITS = Object.freeze({
  maxCount: 32,
  maxKeyLength: 128,
  maxValueLength: 4096,
});

/** 敏感鉴权请求头集合（不区分大小写），导出备份时剥离，界面层提示风险并掩码展示。 */
export const SENSITIVE_CUSTOM_HEADER_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'api-key',
  'x-api-key',
  'x-api-token',
  'x-auth-token',
  'x-goog-api-key',
]);

export interface CustomHeaderValidationIssue {
  index: number;
  key: string;
  message: string;
}

export interface CustomHeadersValidationResult {
  valid: boolean;
  normalized: ProviderCustomHeader[];
  issues: CustomHeaderValidationIssue[];
  hasSensitiveHeaders: boolean;
}

const blockedCustomHeaderNames = new Set([
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'cf-connecting-ip',
  'client-ip',
  'connection',
  'constructor',
  'content-length',
  'content-type',
  'cookie',
  'cookie2',
  'expect',
  'forwarded',
  'host',
  'keep-alive',
  'origin',
  'proxy-authenticate',
  'proxy-authorization',
  'prototype',
  'referer',
  'te',
  'trailer',
  'transfer-encoding',
  'true-client-ip',
  'upgrade',
  'via',
  'x-http-method',
  'x-http-method-override',
  'x-method-override',
  'x-original-url',
  'x-real-ip',
  'x-rewrite-url',
  '__proto__',
]);

const validHeaderNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function isBlockedCustomHeaderName(lowerKey: string): boolean {
  return (
    blockedCustomHeaderNames.has(lowerKey) ||
    lowerKey.startsWith('access-control-') ||
    lowerKey.startsWith('proxy-') ||
    lowerKey.startsWith('sec-') ||
    lowerKey.startsWith('x-forwarded-')
  );
}

/** 判断自定义请求头名称是否属于敏感鉴权凭据头。 */
export function isSensitiveCustomHeaderName(key: string): boolean {
  return SENSITIVE_CUSTOM_HEADER_NAMES.has(key.trim().toLowerCase());
}

function isSafeCustomHeaderEntry(key: string, value: string): boolean {
  const trimmedKey = key.trim();
  const lowerKey = trimmedKey.toLowerCase();
  if (
    !trimmedKey ||
    trimmedKey.length > PROVIDER_CUSTOM_HEADER_LIMITS.maxKeyLength ||
    !validHeaderNamePattern.test(trimmedKey)
  ) {
    return false;
  }
  if (/[\r\n\0]/.test(value) || value.length > PROVIDER_CUSTOM_HEADER_LIMITS.maxValueLength) {
    return false;
  }
  if (isBlockedCustomHeaderName(lowerKey)) {
    return false;
  }
  return true;
}

/**
 * 校验并规范化服务商自定义请求头草稿列表（单源对齐运行时注入、本地持久化与备份校验规则）。
 */
export function validateProviderCustomHeaders(
  headers: ReadonlyArray<ProviderCustomHeader>
): CustomHeadersValidationResult {
  const normalized: ProviderCustomHeader[] = [];
  const issues: CustomHeaderValidationIssue[] = [];
  const seenKeys = new Set<string>();
  let hasSensitiveHeaders = false;

  headers.forEach((header, index) => {
    const rawKey = typeof header?.key === 'string' ? header.key : '';
    const cleanKey = rawKey.trim();
    const value = typeof header?.value === 'string' ? header.value : '';
    const enabled = header?.enabled !== false;

    // 表单中添加空行但尚未填写时，允许跳过而不阻塞保存
    if (!cleanKey && value === '') {
      return;
    }

    if (!cleanKey) {
      issues.push({
        index,
        key: cleanKey,
        message: `第 ${index + 1} 条自定义请求头名称不能为空。`,
      });
      return;
    }

    if (cleanKey.length > PROVIDER_CUSTOM_HEADER_LIMITS.maxKeyLength) {
      issues.push({
        index,
        key: cleanKey,
        message: `请求头名称不能超过 ${PROVIDER_CUSTOM_HEADER_LIMITS.maxKeyLength} 个字符。`,
      });
      return;
    }

    if (value.length > PROVIDER_CUSTOM_HEADER_LIMITS.maxValueLength) {
      issues.push({
        index,
        key: cleanKey,
        message: `请求头内容不能超过 ${PROVIDER_CUSTOM_HEADER_LIMITS.maxValueLength} 个字符。`,
      });
      return;
    }

    if (!validHeaderNamePattern.test(cleanKey)) {
      issues.push({
        index,
        key: cleanKey,
        message: `请求头名称格式无效（仅支持标准 HTTP Token 字符，不能含空格或中文）：${cleanKey}。`,
      });
      return;
    }

    if (/[\r\n\0]/.test(value)) {
      issues.push({
        index,
        key: cleanKey,
        message: `请求头「${cleanKey}」的值不能包含换行符或控制字符。`,
      });
      return;
    }

    const lowerKey = cleanKey.toLowerCase();
    if (isBlockedCustomHeaderName(lowerKey)) {
      issues.push({
        index,
        key: cleanKey,
        message: `出于安全限制，不允许配置系统或代理控制头：${cleanKey}。`,
      });
      return;
    }

    if (seenKeys.has(lowerKey)) {
      issues.push({
        index,
        key: cleanKey,
        message: `存在重复的自定义请求头名称（不区分大小写）：${cleanKey}。`,
      });
      return;
    }

    if (normalized.length >= PROVIDER_CUSTOM_HEADER_LIMITS.maxCount) {
      issues.push({
        index,
        key: cleanKey,
        message: `自定义请求头最多支持 ${PROVIDER_CUSTOM_HEADER_LIMITS.maxCount} 条。`,
      });
      return;
    }

    seenKeys.add(lowerKey);
    normalized.push({
      key: cleanKey,
      value,
      enabled,
    });
    if (enabled && isSensitiveCustomHeaderName(cleanKey)) {
      hasSensitiveHeaders = true;
    }
  });

  return {
    valid: issues.length === 0,
    normalized,
    issues,
    hasSensitiveHeaders,
  };
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

function hasHeaderCaseInsensitive(headers: Record<string, string>, key: string): boolean {
  const lowerTarget = key.toLowerCase();
  return Object.keys(headers).some((existingKey) => existingKey.toLowerCase() === lowerTarget);
}

/**
 * 依据服务商协议、`authHeaderMode` 与 `customHeaders` 构造安全的鉴权及自定义请求头。
 */
export function resolveProviderAuthHeaders(
  provider: Pick<ProviderProfile, 'kind' | 'baseUrl' | 'apiKey' | 'authHeaderMode' | 'customHeaders'>
): Record<string, string> {
  const headers: Record<string, string> = {};
  const mode = provider.authHeaderMode ?? 'auto';
  const apiKey = provider.apiKey?.trim() ?? '';
  const inspection = inspectProviderEndpoint(provider.baseUrl, { kind: provider.kind });
  const isRelay = provider.kind === 'new-api-relay';
  const isAnthropicTarget =
    provider.kind === 'anthropic' ||
    (!isRelay && inspection.family === 'anthropic-official');
  const isGeminiTarget =
    provider.kind === 'gemini' ||
    (!isRelay && inspection.family === 'gemini-official');

  if (mode === 'auto') {
    if (isAnthropicTarget) {
      if (apiKey) {
        headers['x-api-key'] = apiKey;
      }
      headers['anthropic-version'] = defaultAnthropicVersion;
    } else if (isGeminiTarget) {
      if (apiKey) {
        headers['x-goog-api-key'] = apiKey;
      }
    } else if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
  } else if (mode === 'bearer') {
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
  } else if (mode === 'x-api-key') {
    if (apiKey) {
      headers['x-api-key'] = apiKey;
    }
    if (isAnthropicTarget) {
      headers['anthropic-version'] = defaultAnthropicVersion;
    }
  } else if (mode === 'x-goog-api-key') {
    if (apiKey) {
      headers['x-goog-api-key'] = apiKey;
    }
  }

  for (const header of provider.customHeaders ?? []) {
    if (!header || header.enabled === false) {
      continue;
    }
    if (typeof header.key !== 'string' || typeof header.value !== 'string') {
      continue;
    }
    const cleanKey = header.key.trim();
    if (!isSafeCustomHeaderEntry(cleanKey, header.value)) {
      continue;
    }
    setHeaderCaseInsensitive(headers, cleanKey, header.value);
  }

  return headers;
}

export interface ModelDiscoveryRequest {
  url: string;
  headers: Record<string, string>;
  protocol: 'openai' | 'anthropic' | 'gemini';
}

/**
 * 为 OpenAI / xAI / DeepSeek / Anthropic / Gemini / 中转站构造统一的模型列表探测请求。
 */
export function buildModelDiscoveryRequest(
  provider: Pick<ProviderProfile, 'kind' | 'baseUrl' | 'apiKey' | 'authHeaderMode' | 'customHeaders'>
): ModelDiscoveryRequest {
  const inspection = inspectProviderEndpoint(provider.baseUrl, { kind: provider.kind });
  if (!inspection.valid || !inspection.normalizedBaseUrl) {
    throw new Error(inspection.errors[0] ?? '服务商 Base URL 无效，无法探测模型列表。');
  }

  const headers = resolveProviderAuthHeaders(provider);
  if (isExactOfficialAnthropicProvider(provider)) {
    if (!hasHeaderCaseInsensitive(headers, 'anthropic-version')) {
      headers['anthropic-version'] = defaultAnthropicVersion;
    }
    return {
      url: `${inspection.normalizedBaseUrl}/models`,
      headers,
      protocol: 'anthropic',
    };
  }

  if (isExactOfficialGeminiProvider(provider)) {
    return {
      url: `${inspection.normalizedBaseUrl}/models`,
      headers,
      protocol: 'gemini',
    };
  }

  return {
    url: `${inspection.normalizedBaseUrl}/models`,
    headers,
    protocol: 'openai',
  };
}

/**
 * 统一解析各厂商 `/models` 接口返回值（支持 `{ data }`, Gemini `{ models }`, 以及数组响应）。
 */
export function parseDiscoveredModelsPayload(
  provider: Pick<ProviderProfile, 'kind' | 'baseUrl'>,
  payload: unknown
): RemoteModelMetadata[] {
  let rawItems: unknown[] = [];
  if (Array.isArray(payload)) {
    rawItems = payload;
  } else if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (isExactOfficialGeminiProvider(provider) && Array.isArray(record.models)) {
      rawItems = record.models;
    } else if (Array.isArray(record.data)) {
      rawItems = record.data;
    } else if (Array.isArray(record.models)) {
      rawItems = record.models;
    }
  }

  return rawItems
    .map((item) => normalizeRemoteModelEntry(item))
    .filter((item): item is RemoteModelMetadata => item !== null);
}

/**
 * Compares the exact protocol/endpoint binding used for secrets and cached
 * models. Display-name-only edits intentionally do not participate.
 */
export function compareProviderEndpointBinding(
  previous: Pick<ProviderProfile, 'kind' | 'baseUrl'>,
  next: Pick<ProviderProfile, 'kind' | 'baseUrl'>
): ProviderEndpointBindingChange {
  const previousFingerprint = providerEndpointFingerprint(previous);
  const nextFingerprint = providerEndpointFingerprint(next);
  const changed = !previousFingerprint || !nextFingerprint || previousFingerprint !== nextFingerprint;

  return {
    changed,
    ...(previousFingerprint ? { previousFingerprint } : {}),
    ...(nextFingerprint ? { nextFingerprint } : {}),
    mustClearApiKey: changed,
    mustClearModels: changed,
    mustClearModelCandidates: changed,
    ...(changed
      ? {
          reason: !nextFingerprint
            ? '新端点尚未通过本地协议校验；必须停用旧凭据和模型缓存。'
            : '服务商协议或规范化 Base URL 已变化；旧凭据和模型不能自动复用。',
        }
      : {}),
  };
}

function capabilityEvidence(model: ModelInfo, capability: Capability): CapabilityEvidence {
  if (Object.prototype.hasOwnProperty.call(model.capabilityOverrides ?? {}, capability)) {
    return 'user-override';
  }
  if (!model.capabilities.includes(capability)) {
    return 'none';
  }
  if (model.source === 'preset') return 'curated-catalog';
  if (model.source === 'remote') return 'provider-list-or-inference';
  return 'name-inference';
}

function hasHostedProviderAdapter(inspection: ProviderEndpointInspection): boolean {
  return inspection.valid && (
    inspection.family === 'openai-official' ||
    inspection.family === 'anthropic-official' ||
    inspection.family === 'gemini-official' ||
    inspection.family === 'xai-official' ||
    inspection.family === 'deepseek-official' ||
    inspection.family === 'volcengine-ark' ||
    inspection.family === 'bailian-payg'
  );
}

function clientAdapterSupport(
  capability: Capability,
  task: ModelTask,
  inspection: ProviderEndpointInspection,
  platform: string
): { supported: boolean; reason: string } {
  if (!inspection.valid || inspection.policy === 'blocked') {
    return { supported: false, reason: '服务商端点尚未通过本地协议与使用政策校验。' };
  }

  const family = inspection.family;
  if (capability === 'text') {
    return {
      supported: ['chat', 'image-generation', 'video-generation'].includes(task),
      reason: '当前客户端可为该任务发送文本输入。',
    };
  }
  if (capability === 'image-input') {
    const supported =
      task === 'chat' ||
      (task === 'image-generation' &&
        (family === 'openai-official' || family === 'gemini-official' || family === 'xai-official')) ||
      (task === 'video-generation' && family === 'volcengine-ark');
    return {
      supported,
      reason: supported ? '当前客户端已实现该任务的图片输入序列化。' : '当前任务没有已验证的图片输入适配器。',
    };
  }
  if (capability === 'video-input') {
    const supported =
      (task === 'chat' && (family === 'bailian-payg' || family === 'gemini-official')) ||
      (task === 'video-generation' && family === 'volcengine-ark');
    return {
      supported,
      reason: supported ? '当前客户端已实现该服务商的视频输入协议。' : '当前客户端没有该组合的视频输入适配器。',
    };
  }
  if (capability === 'file-input') {
    const supported =
      task === 'chat' &&
      (family === 'openai-official' || family === 'anthropic-official' || family === 'gemini-official');
    return {
      supported,
      reason: supported
        ? '当前服务商官方协议支持文件输入。'
        : '兼容中转或其他服务商的文件协议尚未适配。',
    };
  }
  if (capability === 'reasoning') {
    return {
      supported: task === 'chat',
      reason: task === 'chat' ? '客户端会按服务商和模型约束序列化思考参数。' : '思考强度仅用于聊天任务。',
    };
  }
  if (capability === 'web-search') {
    const supported = task === 'chat' && hasHostedProviderAdapter(inspection);
    return {
      supported,
      reason: supported ? '已匹配精确官方端点的服务商托管搜索适配器。' : '联网搜索只对精确官方端点启用。',
    };
  }
  if (capability === 'image-generation') {
    if (task === 'image-generation' && family === 'anthropic-official') {
      return {
        supported: false,
        reason: 'Anthropic 官方接口不提供原生光栅生图服务，请改用 OpenAI、Gemini 或 xAI 生图模型。',
      };
    }
    return {
      supported: task === 'image-generation',
      reason: task === 'image-generation' ? '客户端已实现兼容图片生成请求。' : '当前模型用途不是图片生成。',
    };
  }
  if (capability === 'video-generation') {
    const supported = task === 'video-generation' && family === 'volcengine-ark';
    return {
      supported,
      reason: supported ? '当前客户端已实现火山方舟视频任务协议。' : '当前仅适配火山方舟视频生成任务。',
    };
  }
  if (capability === 'speech-to-text' || capability === 'text-to-speech') {
    const taskMatches = capability === 'speech-to-text'
      ? task === 'audio-transcription'
      : task === 'speech-generation';
    const supported =
      taskMatches &&
      platform === 'android' &&
      (family === 'openai-official' || family === 'bailian-payg');
    return {
      supported,
      reason: supported
        ? 'Android 已实现用户服务商的请求式语音协议。'
        : !taskMatches
          ? '当前模型用途与该语音能力不一致。'
          : platform !== 'android'
          ? '当前语音功能仅在 Android 启用。'
          : '当前服务商没有已验证的语音适配器。',
    };
  }
  if (capability === 'streaming') {
    return {
      supported: task === 'chat',
      reason: task === 'chat' ? '聊天客户端已实现流式响应。' : '该专用任务不使用聊天流式协议。',
    };
  }
  if (capability === 'tool-calling') {
    return { supported: false, reason: '模型可能支持工具调用，但当前客户端未开放通用工具执行循环。' };
  }
  if (capability === 'mcp') {
    const isOfficialOpenAi =
      inspection.official &&
      inspection.family === 'openai-official' &&
      inspection.hostname === openAiHost &&
      inspection.normalizedBaseUrl === 'https://api.openai.com/v1';
    if (isOfficialOpenAi) {
      return {
        supported: true,
        reason: '仅 api.openai.com 官方 Responses 具备逐次审批、store:false 手动上下文续接适配。',
      };
    }
    if (family === 'volcengine-ark') {
      return {
        supported: false,
        reason: '火山方舟官方虽有工具审批协议，但在真实账号验证 store:false 手动续接前，MCP 执行保持关闭。',
      };
    }
    if (family === 'bailian-payg') {
      return {
        supported: false,
        reason: '阿里百炼 Responses 缺少执行前审批协议，MCP 执行保持关闭。',
      };
    }
    return {
      supported: false,
      reason: 'MCP 仅对精确的 api.openai.com 官方端点开放；兼容端点、中转和其他服务商保持关闭。',
    };
  }
  if (capability === 'embedding' || capability === 'rerank') {
    return { supported: false, reason: '模型能力可记录，但当前聊天界面没有对应的专用调用入口。' };
  }

  return { supported: false, reason: '当前客户端没有该能力的适配器。' };
}

function capabilityCell(
  model: ModelInfo,
  task: ModelTask,
  capability: Capability,
  inspection: ProviderEndpointInspection,
  platform: string
): CapabilityMatrixCell {
  const declared = model.capabilities.includes(capability);
  const explicitOverride = model.capabilityOverrides?.[capability];
  const evidence = capabilityEvidence(model, capability);

  if (explicitOverride === false) {
    return {
      capability,
      label: capabilityMatrixLabels[capability],
      declared: false,
      status: 'disabled',
      evidence,
      reason: '用户已为此模型明确关闭该能力。',
    };
  }
  if (!declared) {
    return {
      capability,
      label: capabilityMatrixLabels[capability],
      declared: false,
      status: 'unknown',
      evidence,
      reason: '现有目录、接口元数据或用户设置未提供可靠支持证据。',
    };
  }

  const adapter = clientAdapterSupport(capability, task, inspection, platform);
  if (!inspection.valid || inspection.policy === 'blocked') {
    return {
      capability,
      label: capabilityMatrixLabels[capability],
      declared: true,
      status: 'blocked',
      evidence,
      reason: adapter.reason,
    };
  }
  if (!adapter.supported) {
    return {
      capability,
      label: capabilityMatrixLabels[capability],
      declared: true,
      status: 'provider-only',
      evidence,
      reason: adapter.reason,
    };
  }
  return {
    capability,
    label: capabilityMatrixLabels[capability],
    declared: true,
    status: 'available',
    evidence,
    reason: adapter.reason,
  };
}

/**
 * Builds a display-ready row while keeping provider/model claims separate from
 * adapters that are actually implemented by this client.
 */
export function buildModelCapabilityMatrixRow(
  provider: ProviderProfile,
  model: ModelInfo,
  { platform = 'android' }: CapabilityMatrixOptions = {}
): ModelCapabilityMatrixRow {
  const inspection = inspectProviderEndpoint(provider.baseUrl, { kind: provider.kind });
  const task = inferModelTask(model);
  const cells = Object.fromEntries(
    capabilityOrder.map((capability) => [
      capability,
      capabilityCell(model, task, capability, inspection, platform),
    ])
  ) as Record<Capability, CapabilityMatrixCell>;

  return {
    providerId: provider.id,
    providerName: provider.name,
    modelId: model.id,
    modelName: model.name ?? model.id,
    task,
    source: model.source,
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    cells,
  };
}

export function buildModelCapabilityMatrixRows(
  provider: ProviderProfile,
  models: readonly ModelInfo[],
  options: CapabilityMatrixOptions = {}
): ModelCapabilityMatrixRow[] {
  return models.map((model) => buildModelCapabilityMatrixRow(provider, model, options));
}
