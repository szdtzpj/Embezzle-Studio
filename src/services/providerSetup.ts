import type {
  Capability,
  ModelInfo,
  ModelTask,
  ProviderKind,
  ProviderProfile,
} from '../domain/types';
import { inferModelTask } from './modelCapabilities';

export type ProviderEndpointFamily =
  | 'openai-official'
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
  suffixes: readonly string[]
): string | undefined {
  const path = normalizedPathname(url).toLowerCase();
  const accepted = new Set([
    '',
    basePath,
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
      ['models', 'chat/completions', 'responses', 'images/generations', 'audio/transcriptions', 'audio/speech']
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
    const supported = task === 'chat' || (task === 'video-generation' && family === 'volcengine-ark');
    return {
      supported,
      reason: supported ? '当前客户端已实现该任务的图片输入序列化。' : '当前任务没有已验证的图片输入适配器。',
    };
  }
  if (capability === 'video-input') {
    const supported =
      (task === 'chat' && family === 'bailian-payg') ||
      (task === 'video-generation' && family === 'volcengine-ark');
    return {
      supported,
      reason: supported ? '当前客户端已实现该服务商的视频输入协议。' : '当前客户端没有该组合的视频输入适配器。',
    };
  }
  if (capability === 'file-input') {
    const supported = task === 'chat' && family === 'openai-official';
    return {
      supported,
      reason: supported ? '文件输入仅在 OpenAI 官方协议中启用。' : '兼容中转或其他服务商的文件协议尚未适配。',
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
    return { supported: false, reason: 'MCP 当前仅保存配置，工具执行保持关闭。' };
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
