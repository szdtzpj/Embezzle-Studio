import { inferModelTask } from '../../services/modelCapabilities';
import type { Capability, ModelInfo, ModelTask } from '../../domain/types';

export type ModelIconKey =
  | 'claude'
  | 'gemini'
  | 'qwen'
  | 'deepseek'
  | 'grok'
  | 'doubao'
  | 'chatglm'
  | 'zhipu'
  | 'kimi'
  | 'minimax'
  | 'bailian'
  | 'volcengine'
  | 'newapi'
  | 'openai'
  | 'unknown';

export const modelTaskLabel: Record<ModelTask, string> = {
  chat: '对话',
  'image-generation': '图片生成',
  'video-generation': '视频生成',
  'audio-transcription': '语音转写',
  'speech-generation': '语音合成',
  embedding: '嵌入',
  rerank: '重排',
};

/** Tasks that users can explicitly assign when provider metadata is incomplete. */
export const configurableModelTasks: readonly ModelTask[] = Object.freeze([
  'chat',
  'image-generation',
  'video-generation',
  'audio-transcription',
  'speech-generation',
  'embedding',
  'rerank',
]);

/** Capabilities that affect visible client features and can be safely overridden. */
export const configurableModelCapabilities: ReadonlyArray<{
  key: Capability;
  label: string;
}> = Object.freeze([
  { key: 'image-input', label: '图片输入' },
  { key: 'video-input', label: '视频输入' },
  { key: 'file-input', label: '文件输入' },
  { key: 'reasoning', label: '深度思考' },
  { key: 'tool-calling', label: '工具调用' },
  { key: 'web-search', label: '联网搜索' },
  { key: 'speech-to-text', label: '语音转写' },
  { key: 'text-to-speech', label: '语音合成' },
  { key: 'mcp', label: 'MCP' },
]);

/** Short capability tags used on model rows (settings / pickers). */
export const modelCapabilityTagLabel: Partial<Record<Capability, string>> = {
  'image-input': '视觉',
  'video-input': '视频理解',
  'file-input': '文件',
  reasoning: '推理',
  'tool-calling': '工具',
  'web-search': '联网',
  'image-generation': '生图',
  'video-generation': '视频生成',
  'speech-to-text': '转写',
  'text-to-speech': '朗读',
  mcp: 'MCP',
  embedding: '嵌入',
  rerank: '重排',
};

const capabilityTagOrder: Capability[] = [
  'image-input',
  'video-input',
  'file-input',
  'reasoning',
  'tool-calling',
  'web-search',
  'image-generation',
  'video-generation',
  'speech-to-text',
  'text-to-speech',
  'mcp',
  'embedding',
  'rerank',
];

/**
 * Compact tags for a model: primary task + capability chips.
 * Replaces the old capability-matrix table for day-to-day scanning.
 */
export function modelCapabilityTags(model: ModelInfo, options?: { max?: number }): string[] {
  const max = options?.max ?? 8;
  const tags: string[] = [];
  const seen = new Set<string>();

  const push = (label: string) => {
    if (!label || seen.has(label) || tags.length >= max) {
      return;
    }
    seen.add(label);
    tags.push(label);
  };

  const task = inferModelTask(model);
  push(modelTaskLabel[task]);

  const caps = new Set(model.capabilities ?? []);
  for (const capability of capabilityTagOrder) {
    if (!caps.has(capability)) {
      continue;
    }
    // Task already conveys the primary generation mode — skip duplicate.
    if (capability === 'image-generation' && task === 'image-generation') {
      continue;
    }
    if (capability === 'video-generation' && task === 'video-generation') {
      continue;
    }
    if (capability === 'speech-to-text' && task === 'audio-transcription') {
      continue;
    }
    if (capability === 'text-to-speech' && task === 'speech-generation') {
      continue;
    }
    if (capability === 'embedding' && task === 'embedding') {
      continue;
    }
    if (capability === 'rerank' && task === 'rerank') {
      continue;
    }
    const label = modelCapabilityTagLabel[capability];
    if (label) {
      push(label);
    }
  }

  return tags;
}

export function capitalizeFirstSegment(value: string) {
  return value.replace(/^[a-z]/, (char) => char.toUpperCase());
}

export function truncateModelLabel(value: string, maxLength = 18) {
  return value.length > maxLength ? `${value.slice(0, Math.max(1, maxLength - 3))}...` : value;
}

/** 词边界匹配 Grok 模型、xAI 品牌及 OpenAI 推理系列（o1/o3/o4），避免误匹配词根。 */
const grokModelBoundaryPattern = /(?:^|[^a-z0-9])grok(?:[^a-z]|$)/i;
const xaiBrandBoundaryPattern = /(?:^|[^a-z0-9])xai(?:[^a-z0-9]|$)/;
const xaiSlugBoundaryPattern = /(?:^|[^a-z0-9])x-ai\//;
const xaiDomainBoundaryPattern = /(?:^|[^a-z0-9])x\.ai(?:[^a-z0-9]|$)/;
const openAiReasoningBoundaryPattern = /(?:^|[^a-z0-9])o[134](?:$|[-_.])/;

export function formatCompactModelName(modelId?: string, _providerName?: string, maxLength = 18) {
  const raw = (modelId ?? '').trim();
  const lower = raw.toLowerCase();
  let compact = raw;

  if (lower.includes('claude')) compact = raw.replace(/.*claude[- ]?/i, 'Claude ');
  else if (lower.includes('gemini')) compact = raw.replace(/.*gemini[- ]?/i, 'Gemini ');
  else if (lower.includes('gpt')) compact = raw.replace(/.*gpt[- ]?/i, 'GPT-');
  else if (lower.includes('qwen')) compact = raw.replace(/.*qwen[- ]?/i, 'Qwen ');
  else if (lower.includes('deepseek')) compact = raw.replace(/.*deepseek[- ]?/i, 'DeepSeek ');
  else if (grokModelBoundaryPattern.test(lower)) {
    compact = raw.replace(/.*?grok[- ]?/i, 'Grok ').trim();
  }
  else if (lower.includes('doubao')) compact = raw.replace(/.*doubao[- ]?/i, 'Doubao ');
  else if (lower.includes('kimi')) compact = raw.replace(/.*kimi[- ]?/i, 'Kimi ');

  return truncateModelLabel(capitalizeFirstSegment(compact), maxLength);
}

/** 第一层：优先根据模型 ID 显式识别品牌，避免被中转或 Custom OpenAI-Compatible 服务商名称抢先命中。 */
function matchModelIconKeyByModelId(modelText: string): ModelIconKey | null {
  if (!modelText) return null;
  if (
    grokModelBoundaryPattern.test(modelText) ||
    xaiBrandBoundaryPattern.test(modelText) ||
    xaiSlugBoundaryPattern.test(modelText) ||
    xaiDomainBoundaryPattern.test(modelText)
  ) {
    return 'grok';
  }
  if (modelText.includes('claude') || modelText.includes('anthropic')) return 'claude';
  if (modelText.includes('gemini') || modelText.includes('google')) return 'gemini';
  if (
    modelText.includes('qwen') ||
    modelText.includes('qwq') ||
    modelText.includes('qvq') ||
    modelText.includes('tongyi')
  ) {
    return 'qwen';
  }
  if (modelText.includes('deepseek')) return 'deepseek';
  if (
    modelText.includes('gpt') ||
    modelText.includes('openai') ||
    modelText.includes('codex') ||
    openAiReasoningBoundaryPattern.test(modelText)
  ) {
    return 'openai';
  }
  if (modelText.includes('doubao') || modelText.includes('seed')) return 'doubao';
  if (modelText.includes('chatglm')) return 'chatglm';
  if (
    /(?:^|[^a-z0-9])glm(?:[-_.]|$)/.test(modelText) ||
    modelText.includes('zhipu') ||
    modelText.includes('bigmodel') ||
    modelText.includes('智谱')
  ) {
    return 'zhipu';
  }
  if (modelText.includes('kimi') || modelText.includes('moonshot')) return 'kimi';
  if (modelText.includes('minimax')) return 'minimax';
  return null;
}

/** 第二层：仅在模型 ID 未识别出明确品牌时，回退依据服务商名称匹配图标。 */
function matchModelIconKeyByProvider(providerText: string): ModelIconKey | null {
  if (!providerText) return null;
  // 置于 newapi / bailian / volcengine / openai 之前，确保 xAI / Grok 服务商优先识别
  if (
    grokModelBoundaryPattern.test(providerText) ||
    xaiBrandBoundaryPattern.test(providerText) ||
    xaiSlugBoundaryPattern.test(providerText) ||
    xaiDomainBoundaryPattern.test(providerText)
  ) {
    return 'grok';
  }
  if (providerText.includes('claude') || providerText.includes('anthropic')) return 'claude';
  if (providerText.includes('gemini') || providerText.includes('google')) return 'gemini';
  if (providerText.includes('deepseek')) return 'deepseek';
  if (providerText.includes('qwen') || providerText.includes('tongyi')) return 'qwen';
  if (
    providerText.includes('bailian') ||
    providerText.includes('dashscope') ||
    providerText.includes('aliyun')
  ) {
    return 'bailian';
  }
  if (
    providerText.includes('volc') ||
    providerText.includes('ark') ||
    providerText.includes('huoshan')
  ) {
    return 'volcengine';
  }
  if (
    providerText.includes('new api') ||
    providerText.includes('new-api') ||
    providerText.includes('newapi')
  ) {
    return 'newapi';
  }
  if (
    providerText.includes('zhipu') ||
    providerText.includes('bigmodel') ||
    providerText.includes('智谱')
  ) {
    return 'zhipu';
  }
  if (providerText.includes('kimi') || providerText.includes('moonshot')) return 'kimi';
  if (providerText.includes('minimax')) return 'minimax';
  if (
    providerText.includes('gpt') ||
    providerText.includes('openai') ||
    providerText.includes('codex')
  ) {
    return 'openai';
  }
  return null;
}

export function modelIconKey(modelId?: string, providerName?: string): ModelIconKey {
  const modelText = (modelId ?? '').trim().toLowerCase();
  const providerText = (providerName ?? '').trim().toLowerCase();

  if (
    modelText.includes('模型未记录') ||
    modelText.includes('未知服务商') ||
    providerText.includes('模型未记录') ||
    providerText.includes('未知服务商')
  ) {
    return 'unknown';
  }

  return (
    matchModelIconKeyByModelId(modelText) ??
    matchModelIconKeyByProvider(providerText) ??
    'unknown'
  );
}
