import type { Capability, ModelInfo, ModelTask, ProviderProfile, ReasoningEffort } from '../domain/types';

export type ModelCapabilityFilter =
  | 'all'
  | 'reasoning'
  | 'vision'
  | 'web'
  | 'free'
  | 'embedding'
  | 'rerank'
  | 'tool';

export interface RemoteModelMetadata {
  id?: string;
  name?: string;
  capabilities?: unknown;
  modalities?: {
    input?: unknown;
    output?: unknown;
  };
  architecture?: {
    input_modalities?: unknown;
    output_modalities?: unknown;
  };
  supported_parameters?: unknown;
  attachment?: unknown;
  reasoning?: unknown;
  reasoning_effort?: unknown;
  reasoning_efforts?: unknown;
  supported_reasoning_efforts?: unknown;
  thinking?: unknown;
  thinking_budget?: unknown;
  tool_call?: unknown;
  structured_output?: unknown;
  owned_by?: unknown;
  [key: string]: unknown;
}

export type BailianThinkingMode = 'none' | 'mixed' | 'thinking-only';

export type BailianReasoningEffortFamily = 'deepseek-v4' | 'glm-5.2' | 'glm-5.1-or-5';

export interface BailianThinkingProfile {
  mode: BailianThinkingMode;
  defaultEnabled?: boolean;
  supportsThinkingBudget: boolean;
  reasoningEffortFamily?: BailianReasoningEffortFamily;
}

type CapabilitySource = ModelInfo['source'];

const capabilityOrder: Capability[] = [
  'text',
  'image-input',
  'video-input',
  'file-input',
  'tool-calling',
  'reasoning',
  'web-search',
  'image-generation',
  'video-generation',
  'embedding',
  'rerank',
  'streaming',
  'mcp',
];

const visionKeywords = [
  'vision',
  'visual',
  'vl',
  'image-input',
  'image-recognition',
  'multimodal',
  'multi-modal',
  'omni',
  '4v',
  'qwen-vl',
  'qwen2-vl',
  'qwen2.5-vl',
  'qwen3-vl',
  'qvq',
  'glm-4v',
  'glm-v',
  'internvl',
  'minicpm-v',
  'pixtral',
  'llama-3.2-vision',
  'phi-3.5-vision',
  'gpt-4o',
  'gpt-4.1',
  'gpt-5',
  'o3',
  'o4',
  'claude-3',
  'claude-sonnet-4',
  'claude-opus-4',
  'claude-haiku-4',
  'gemini',
  'grok-4',
  'grok-vision',
  'doubao-seed',
  'doubao-1-5-vision',
  'doubao-1.5-vision',
];

const visionExclusions = [
  'gpt-image',
  'gpt-4o-image',
  'qwen-max',
  'qwen3-max',
  'qwen3-6-max-preview',
  'embedding',
  'rerank',
  'tts',
  'whisper',
];

const videoInputKeywords = [
  'video-input',
  'video-recognition',
  'video-understanding',
  'doubao-seed',
  'gemini',
  'qwen-vl',
  'qwen2-5-vl',
  'qwen3-vl',
  'qvq',
];
const videoGenerationKeywords = ['video-generation', 'text-to-video', 'seedance', 'sora', 'veo', 'kling', 'wan-video', 'wanx2.1-t2v'];
const imageGenerationKeywords = [
  'image-generation',
  'text-to-image',
  'seedream',
  'dall-e',
  'gpt-image',
  'imagen',
  'qwen-image',
  'wanx',
  'cogview',
  'flux',
  'stable-diffusion',
  'sdxl',
  'midjourney',
];
const embeddingKeywords = ['embedding', 'embeddings', 'text-embedding', 'embed', 'bge-m3', 'm3e', 'jina-embeddings'];
const rerankKeywords = ['rerank', 'reranker', 're-rank', 'bge-reranker'];
const reasoningKeywords = [
  'reasoning',
  'reasoner',
  'thinking',
  'think',
  'deepseek-r1',
  'deepseek-v4',
  'deepseek-v3-2',
  'deepseek-v3-1',
  '-r1',
  'r1-',
  'qwq',
  'qvq',
  'qwen3',
  'o1',
  'o3',
  'o4',
  'glm-z1',
  'glm-5',
  'glm-4-5',
  'hunyuan-t1',
  'grok-4',
  'gpt-5',
  'doubao-seed',
  'doubao-1-5-thinking',
];
const toolKeywords = [
  'function-call',
  'functioncall',
  'tool-calling',
  'tool-use',
  'tools',
  'gpt',
  'o1',
  'o3',
  'o4',
  'claude',
  'gemini',
  'qwen',
  'deepseek',
  'doubao',
  'glm',
  'grok',
  'kimi',
  'hunyuan',
  'mistral',
  'llama',
];
const webSearchKeywords = ['web-search', 'web_search', 'search-preview', 'sonar', 'online', 'browsing'];
const freeKeywords = ['free', 'gratis', 'trial'];
const arkThinkingKeywords = ['doubao-seed', 'deepseek-v4', 'deepseek-v3-2', 'glm-4-7'];

const exactCapabilities: Record<string, Capability[]> = {
  'gpt-4o-search-preview': ['text', 'image-input', 'tool-calling', 'web-search'],
  'gpt-4o-mini-search-preview': ['text', 'image-input', 'tool-calling', 'web-search'],
  sonar: ['text', 'web-search'],
  'sonar-pro': ['text', 'web-search'],
  'sonar-reasoning': ['text', 'reasoning', 'web-search'],
  'sonar-reasoning-pro': ['text', 'reasoning', 'web-search'],
  'sonar-deep-research': ['text', 'reasoning', 'web-search'],
};

export function modelSearchText(model: Pick<ModelInfo, 'id' | 'name'>): string {
  return `${model.name ?? ''} ${model.id}`.toLowerCase();
}

function normalizedModelId(modelId: string): string {
  return modelId
    .trim()
    .toLowerCase()
    .replace(/[:/_.]+/g, '-')
    .replace(/\(free\)$/i, '')
    .replace(/:-?free$/i, '')
    .replace(/-free$/i, '');
}

function containsModelFamily(modelId: string, family: string): boolean {
  return (
    modelId === family ||
    modelId.startsWith(`${family}-`) ||
    modelId.includes(`-${family}-`) ||
    modelId.endsWith(`-${family}`)
  );
}

function qwenSnapshotAtOrAfter(modelId: string, family: string, minimumDate: string): boolean {
  if (modelId === family || modelId === `${family}-latest`) {
    return true;
  }

  const match = modelId.match(new RegExp(`(?:^|-)${family}-(\\d{4})-(\\d{2})-(\\d{2})(?:$|-)`));
  if (!match) {
    return false;
  }

  return `${match[1]}-${match[2]}-${match[3]}` >= minimumDate;
}

export function getBailianThinkingProfile(modelId: string): BailianThinkingProfile {
  const id = normalizedModelId(modelId);
  const none: BailianThinkingProfile = { mode: 'none', supportsThinkingBudget: false };

  if (containsModelFamily(id, 'qwq') || containsModelFamily(id, 'qvq')) {
    return { mode: 'thinking-only', defaultEnabled: true, supportsThinkingBudget: false };
  }

  if (containsModelFamily(id, 'deepseek-r1')) {
    return { mode: 'thinking-only', defaultEnabled: true, supportsThinkingBudget: false };
  }

  if (containsModelFamily(id, 'deepseek-v4')) {
    return {
      mode: 'mixed',
      defaultEnabled: true,
      supportsThinkingBudget: false,
      reasoningEffortFamily: 'deepseek-v4',
    };
  }

  if (containsModelFamily(id, 'deepseek-v3-2') || containsModelFamily(id, 'deepseek-v3-1')) {
    return { mode: 'mixed', defaultEnabled: false, supportsThinkingBudget: true };
  }

  if (containsModelFamily(id, 'glm-5-2')) {
    return {
      mode: 'mixed',
      defaultEnabled: true,
      supportsThinkingBudget: false,
      reasoningEffortFamily: 'glm-5.2',
    };
  }

  if (
    containsModelFamily(id, 'glm-5-1') ||
    id === 'glm-5' ||
    id.endsWith('-glm-5')
  ) {
    return {
      mode: 'mixed',
      defaultEnabled: true,
      supportsThinkingBudget: false,
      reasoningEffortFamily: 'glm-5.1-or-5',
    };
  }

  if (
    containsModelFamily(id, 'glm-4-5') ||
    containsModelFamily(id, 'glm-4-6') ||
    containsModelFamily(id, 'glm-4-7')
  ) {
    return { mode: 'mixed', defaultEnabled: true, supportsThinkingBudget: false };
  }

  const qwenThinkingOnly =
    containsModelFamily(id, 'qwen3-7-max-preview') ||
    containsModelFamily(id, 'qwen3-7-max-2026-05-17') ||
    (containsModelFamily(id, 'qwen3-vl') && id.includes('-thinking')) ||
    (containsModelFamily(id, 'qwen3') && id.includes('-thinking'));
  if (qwenThinkingOnly) {
    return { mode: 'thinking-only', defaultEnabled: true, supportsThinkingBudget: true };
  }

  if (
    containsModelFamily(id, 'qwen3-7') ||
    containsModelFamily(id, 'qwen3-6') ||
    containsModelFamily(id, 'qwen3-5') ||
    containsModelFamily(id, 'qwen3-vl')
  ) {
    return { mode: 'mixed', defaultEnabled: true, supportsThinkingBudget: true };
  }

  if (containsModelFamily(id, 'qwen3-omni-flash')) {
    return { mode: 'mixed', supportsThinkingBudget: false };
  }

  if (
    containsModelFamily(id, 'qwen3-max') ||
    /(?:^|-)qwen3-(?:235b-a22b|32b|30b-a3b|14b|8b)(?:$|-)/.test(id)
  ) {
    return {
      mode: 'mixed',
      defaultEnabled: !containsModelFamily(id, 'qwen3-max'),
      supportsThinkingBudget: true,
    };
  }

  if (
    qwenSnapshotAtOrAfter(id, 'qwen-plus', '2025-04-28') ||
    qwenSnapshotAtOrAfter(id, 'qwen-flash', '2025-07-28') ||
    containsModelFamily(id, 'qwen-turbo')
  ) {
    if (id.includes('character')) {
      return none;
    }
    return { mode: 'mixed', defaultEnabled: false, supportsThinkingBudget: true };
  }

  return none;
}

function qwenVisionInputProfile(modelId: string): { image: boolean; video: boolean } {
  const id = normalizedModelId(modelId);
  const qwen37Visual =
    containsModelFamily(id, 'qwen3-7-plus') ||
    containsModelFamily(id, 'qwen3-7-max-2026-06-08');
  const qwen36Visual =
    containsModelFamily(id, 'qwen3-6-plus') ||
    containsModelFamily(id, 'qwen3-6-flash') ||
    containsModelFamily(id, 'qwen3-6-35b-a3b');
  const qwen35Visual =
    containsModelFamily(id, 'qwen3-5-plus') ||
    containsModelFamily(id, 'qwen3-5-flash') ||
    containsModelFamily(id, 'qwen3-5-omni-plus') ||
    containsModelFamily(id, 'qwen3-5-omni-flash') ||
    /(?:^|-)qwen3-5-(?:397b-a17b|122b-a10b|27b|35b-a3b)(?:$|-)/.test(id);

  const supported = qwen37Visual || qwen36Visual || qwen35Visual;
  return { image: supported, video: supported };
}

function includesAny(value: string, keywords: string[]): boolean {
  return keywords.some((keyword) => value.includes(keyword));
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string').map((item) => item.toLowerCase());
}

function add(caps: Set<Capability>, capability: Capability): void {
  caps.add(capability);
}

function addAll(caps: Set<Capability>, capabilities: Capability[]): void {
  capabilities.forEach((capability) => add(caps, capability));
}

function sortedCapabilities(caps: Set<Capability>): Capability[] {
  return capabilityOrder.filter((capability) => caps.has(capability));
}

const reasoningEffortOrder: ReasoningEffort[] = [
  'default',
  'off',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];
const reasoningEffortAliases: Record<string, ReasoningEffort> = {
  auto: 'default',
  default: 'default',
  none: 'none',
  minimal: 'minimal',
  off: 'off',
  disabled: 'off',
  disable: 'off',
  false: 'off',
  low: 'low',
  medium: 'medium',
  mid: 'medium',
  high: 'high',
  max: 'max',
  maximum: 'max',
  xhigh: 'xhigh',
  'x-high': 'xhigh',
  ultra: 'xhigh',
};

function normalizeReasoningEffortToken(value: string): ReasoningEffort | undefined {
  const token = value.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return reasoningEffortAliases[token];
}

function addReasoningEffort(efforts: Set<ReasoningEffort>, value: unknown): void {
  if (typeof value !== 'string') {
    return;
  }

  const effort = normalizeReasoningEffortToken(value);
  if (effort) {
    efforts.add(effort);
  }
}

function collectReasoningEffortValues(efforts: Set<ReasoningEffort>, value: unknown, depth = 0): void {
  if (depth > 3 || value == null) {
    return;
  }

  if (typeof value === 'string') {
    addReasoningEffort(efforts, value);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectReasoningEffortValues(efforts, item, depth + 1));
    return;
  }

  if (typeof value !== 'object') {
    return;
  }

  Object.entries(value as Record<string, unknown>).forEach(([key, entry]) => {
    const normalizedKey = key.toLowerCase().replace(/[\s_]+/g, '-');
    if (entry === true) {
      addReasoningEffort(efforts, normalizedKey);
    }

    if (
      normalizedKey.includes('effort') ||
      normalizedKey.includes('level') ||
      normalizedKey.includes('budget') ||
      ['enum', 'values', 'options', 'type', 'types', 'mode', 'modes', 'allowed-values', 'supported-values'].includes(normalizedKey)
    ) {
      collectReasoningEffortValues(efforts, entry, depth + 1);
    }
  });
}

function sortedReasoningEfforts(efforts: Set<ReasoningEffort>): ReasoningEffort[] {
  return reasoningEffortOrder.filter((effort) => efforts.has(effort));
}

function supportedReasoningEffortsFromMetadata(metadata?: RemoteModelMetadata): ReasoningEffort[] | undefined {
  if (!metadata) {
    return undefined;
  }

  const efforts = new Set<ReasoningEffort>();
  collectReasoningEffortValues(efforts, metadata.reasoning);
  collectReasoningEffortValues(efforts, metadata.reasoning_effort);
  collectReasoningEffortValues(efforts, metadata.reasoning_efforts);
  collectReasoningEffortValues(efforts, metadata.supported_reasoning_efforts);
  collectReasoningEffortValues(efforts, metadata.thinking);

  const sorted = sortedReasoningEfforts(efforts);
  return sorted.length ? sorted : undefined;
}

function addExternalCapability(caps: Set<Capability>, raw: string): void {
  const value = raw.toLowerCase();

  if (value.includes('image-recognition') || value.includes('vision') || value.includes('image-input')) {
    add(caps, 'image-input');
  }
  if (value.includes('video-recognition') || value.includes('video-input')) {
    add(caps, 'video-input');
  }
  if (value.includes('file-input') || value.includes('attachment')) {
    add(caps, 'file-input');
  }
  if (value.includes('function') || value.includes('tool')) {
    add(caps, 'tool-calling');
  }
  if (value.includes('reasoning') || value.includes('thinking')) {
    add(caps, 'reasoning');
  }
  if (value.includes('web-search') || value.includes('web_search') || value.includes('grounding')) {
    add(caps, 'web-search');
  }
  if (value.includes('image-generation')) {
    add(caps, 'image-generation');
  }
  if (value.includes('video-generation')) {
    add(caps, 'video-generation');
  }
  if (value.includes('embedding')) {
    add(caps, 'embedding');
  }
  if (value.includes('rerank')) {
    add(caps, 'rerank');
  }
}

function addCapabilitiesFromMetadata(caps: Set<Capability>, metadata?: RemoteModelMetadata): void {
  if (!metadata) {
    return;
  }

  const inputModalities = [
    ...stringArray(metadata.modalities?.input),
    ...stringArray(metadata.architecture?.input_modalities),
  ];
  const outputModalities = [
    ...stringArray(metadata.modalities?.output),
    ...stringArray(metadata.architecture?.output_modalities),
  ];
  const supportedParameters = stringArray(metadata.supported_parameters);

  if (inputModalities.includes('image')) add(caps, 'image-input');
  if (inputModalities.includes('video')) add(caps, 'video-input');
  if (inputModalities.includes('file')) add(caps, 'file-input');
  if (outputModalities.includes('image')) add(caps, 'image-generation');
  if (outputModalities.includes('video')) add(caps, 'video-generation');
  if (outputModalities.includes('vector')) add(caps, 'embedding');
  if (supportedParameters.some((item) => item.includes('tool') || item.includes('function'))) add(caps, 'tool-calling');
  if (supportedParameters.some((item) => item.includes('reasoning') || item.includes('thinking'))) add(caps, 'reasoning');
  if (metadata.attachment === true) add(caps, 'file-input');
  if (metadata.tool_call === true) add(caps, 'tool-calling');
  if (metadata.reasoning === true || supportedReasoningEffortsFromMetadata(metadata)?.length) add(caps, 'reasoning');

  if (Array.isArray(metadata.capabilities)) {
    metadata.capabilities.forEach((capability) => {
      if (typeof capability === 'string') {
        addExternalCapability(caps, capability);
      }
    });
  } else if (metadata.capabilities && typeof metadata.capabilities === 'object') {
    Object.entries(metadata.capabilities).forEach(([key, value]) => {
      if (value) {
        addExternalCapability(caps, key);
      }
    });
  }
}

function addCapabilitiesFromModelId(caps: Set<Capability>, provider: ProviderProfile, modelId: string, name?: string): void {
  const id = normalizedModelId(modelId);
  const text = `${id} ${name ? normalizedModelId(name) : ''}`;
  const exact = exactCapabilities[id];

  if (exact) {
    addAll(caps, exact);
  }

  if (includesAny(text, embeddingKeywords)) add(caps, 'embedding');
  if (includesAny(text, rerankKeywords)) add(caps, 'rerank');
  if (includesAny(text, imageGenerationKeywords)) add(caps, 'image-generation');
  if (includesAny(text, videoGenerationKeywords)) add(caps, 'video-generation');

  const isGenerationOrVector = caps.has('image-generation') || caps.has('video-generation') || caps.has('embedding') || caps.has('rerank');

  if (!isGenerationOrVector && includesAny(text, reasoningKeywords)) add(caps, 'reasoning');
  if (
    !isGenerationOrVector &&
    provider.kind === 'bailian-compatible' &&
    getBailianThinkingProfile(modelId).mode !== 'none'
  ) {
    add(caps, 'reasoning');
  }

  const qwenVision = qwenVisionInputProfile(modelId);
  if (qwenVision.image) add(caps, 'image-input');
  if (qwenVision.video) add(caps, 'video-input');

  const excludedFromVision = includesAny(text, visionExclusions);
  if (!excludedFromVision && !caps.has('embedding') && !caps.has('rerank') && includesAny(text, visionKeywords)) {
    add(caps, 'image-input');
  }

  if (!caps.has('embedding') && !caps.has('rerank') && includesAny(text, videoInputKeywords)) {
    add(caps, 'video-input');
  }

  if (!isGenerationOrVector && includesAny(text, toolKeywords)) {
    add(caps, 'tool-calling');
  }

  if (includesAny(text, webSearchKeywords)) {
    add(caps, 'web-search');
  }

  if (/^hunyuan(?!-lite\b)/.test(id)) add(caps, 'web-search');
  if (/^gemini-(?:2|3)\b/.test(id) || id === 'gemini-flash-latest' || id === 'gemini-pro-latest') add(caps, 'web-search');
  if (/^grok-(?:3|4)\b/.test(id)) add(caps, 'web-search');
  if (/^(?:gpt-4o|gpt-5|o3|o4)(?:\b|-)/.test(id)) add(caps, 'web-search');
  if (/^claude-(?:opus-4|sonnet-4|haiku-4|3-5-haiku|3-5-sonnet|3-7-sonnet)\b/.test(id)) add(caps, 'web-search');

  if (provider.kind === 'volcengine-ark' && includesAny(text, arkThinkingKeywords)) {
    add(caps, 'reasoning');
  }

  if (provider.kind === 'volcengine-ark' && id.startsWith('doubao-seed') && !id.includes('code')) {
    add(caps, 'image-input');
    add(caps, 'video-input');
    add(caps, 'tool-calling');
  }
}

export function inferModelCapabilities(
  provider: ProviderProfile,
  modelId: string,
  metadata?: RemoteModelMetadata,
  _source: CapabilitySource = 'remote'
): Capability[] {
  const caps = new Set<Capability>();

  add(caps, 'text');
  if (provider.capabilities.includes('streaming')) add(caps, 'streaming');

  addCapabilitiesFromMetadata(caps, metadata);
  addCapabilitiesFromModelId(caps, provider, modelId, metadata?.name);

  if (caps.has('embedding') || caps.has('rerank')) {
    caps.delete('tool-calling');
    caps.delete('web-search');
    caps.delete('image-input');
    caps.delete('video-input');
    caps.delete('image-generation');
    caps.delete('video-generation');
  }

  return sortedCapabilities(caps);
}

export function inferModelTask(model: Pick<ModelInfo, 'id' | 'name' | 'task' | 'capabilities'> | string): ModelTask {
  if (typeof model !== 'string' && model.task) {
    return model.task;
  }

  const text = typeof model === 'string' ? normalizedModelId(model) : modelSearchText(model);
  const capabilities = typeof model === 'string' ? [] : model.capabilities;

  if (capabilities.includes('image-generation') || includesAny(text, imageGenerationKeywords)) return 'image-generation';
  if (capabilities.includes('video-generation') || includesAny(text, videoGenerationKeywords)) return 'video-generation';
  if (capabilities.includes('embedding') || includesAny(text, embeddingKeywords)) return 'embedding';
  if (capabilities.includes('rerank') || includesAny(text, rerankKeywords)) return 'rerank';

  return 'chat';
}

export function createModelInfoFromId(
  provider: ProviderProfile,
  modelId: string,
  source: CapabilitySource = 'manual',
  metadata?: RemoteModelMetadata
): ModelInfo {
  const capabilities = inferModelCapabilities(provider, modelId, metadata, source);
  const supportedReasoningEfforts = supportedReasoningEffortsFromMetadata(metadata);
  const model: ModelInfo = {
    id: modelId,
    name: metadata?.name ?? modelId,
    capabilities,
    ...(supportedReasoningEfforts ? { supportedReasoningEfforts } : {}),
    task: inferModelTask({ id: modelId, name: metadata?.name ?? modelId, capabilities }),
    source,
  };

  return model;
}

export function enrichDiscoveredModel(provider: ProviderProfile, metadata: RemoteModelMetadata): ModelInfo | null {
  if (typeof metadata.id !== 'string' || metadata.id.length === 0) {
    return null;
  }

  return createModelInfoFromId(provider, metadata.id, 'remote', metadata);
}

export function isVisionModel(model?: Pick<ModelInfo, 'capabilities'> | null): boolean {
  return Boolean(model?.capabilities.includes('image-input'));
}

export function isVideoInputModel(model?: Pick<ModelInfo, 'capabilities'> | null): boolean {
  return Boolean(model?.capabilities.includes('video-input'));
}

export function isWebSearchModel(model?: Pick<ModelInfo, 'capabilities'> | null): boolean {
  return Boolean(model?.capabilities.includes('web-search'));
}

export function isToolCallingModel(model?: Pick<ModelInfo, 'capabilities'> | null): boolean {
  return Boolean(model?.capabilities.includes('tool-calling'));
}

export function isReasoningModel(model?: Pick<ModelInfo, 'capabilities'> | null): boolean {
  return Boolean(model?.capabilities.includes('reasoning'));
}

export function isEmbeddingModel(model?: Pick<ModelInfo, 'capabilities'> | null): boolean {
  return Boolean(model?.capabilities.includes('embedding'));
}

export function isRerankModel(model?: Pick<ModelInfo, 'capabilities'> | null): boolean {
  return Boolean(model?.capabilities.includes('rerank'));
}

export function isChatModel(model: ModelInfo): boolean {
  return inferModelTask(model) === 'chat';
}

export function canUseExternalWebSearch(model?: ModelInfo | null): boolean {
  return Boolean(model && isChatModel(model) && (isWebSearchModel(model) || isToolCallingModel(model)));
}

export function modelMatchesCapabilityFilter(model: ModelInfo, filter: ModelCapabilityFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'reasoning') return isReasoningModel(model);
  if (filter === 'vision') return isVisionModel(model);
  if (filter === 'web') return isWebSearchModel(model);
  if (filter === 'free') return includesAny(modelSearchText(model), freeKeywords);
  if (filter === 'embedding') return isEmbeddingModel(model);
  if (filter === 'rerank') return isRerankModel(model);
  return isToolCallingModel(model);
}
