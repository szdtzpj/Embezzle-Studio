import type { ModelInfo, ProviderProfile, ReasoningEffort } from '../domain/types';
import { inferModelTask, isReasoningModel } from './modelCapabilities';

export interface ReasoningEffortOption {
  key: ReasoningEffort;
  label: string;
}

export const reasoningEffortLabels: Record<ReasoningEffort, string> = {
  default: '默认',
  off: '关闭',
  low: '低',
  medium: '中',
  high: '高',
  max: '极高',
};

const effortOrder: ReasoningEffort[] = ['default', 'off', 'low', 'medium', 'high', 'max'];

function normalizedText(value?: string): string {
  return (value ?? '').trim().toLowerCase().replace(/[:/_.\s]+/g, '-');
}

function modelText(model: ModelInfo): string {
  return `${normalizedText(model.id)} ${normalizedText(model.name)}`.trim();
}

function orderedEfforts(efforts: Iterable<ReasoningEffort>): ReasoningEffort[] {
  const set = new Set(efforts);
  return effortOrder.filter((effort) => set.has(effort));
}

function withDefault(efforts: ReasoningEffort[]): ReasoningEffort[] {
  return orderedEfforts(['default', ...efforts]);
}

function isOpenAiBaseUrl(provider: ProviderProfile): boolean {
  return provider.baseUrl.toLowerCase().includes('api.openai.com');
}

function isQwenBudgetModel(text: string): boolean {
  return text.includes('qwen') || text.includes('qwq') || text.includes('qvq');
}

function isBailianEffortModel(text: string): boolean {
  return text.includes('deepseek-v4') || text.includes('glm-5');
}

function isOpenAiReasoningModel(text: string): boolean {
  return /(?:^|-)(?:o1|o3|o4)(?:$|-)/.test(text) || /(?:^|-)gpt-5(?:$|-)/.test(text);
}

function isGpt51Model(text: string): boolean {
  return /(?:^|-)gpt-5-1(?:\b|-)/.test(text);
}

function isGpt5ProModel(text: string): boolean {
  return /(?:^|-)gpt-5-pro(?:\b|-)/.test(text);
}

function isDoubaoSeedModel(text: string): boolean {
  return text.includes('doubao-seed');
}

function isDeepSeekV4Model(text: string): boolean {
  return text.includes('deepseek-v4');
}

function isArkThinkingModel(text: string): boolean {
  return (
    isDoubaoSeedModel(text) ||
    isDeepSeekV4Model(text) ||
    text.includes('deepseek-v3-2') ||
    text.includes('glm-4-7')
  );
}

function canDisableThinking(provider: ProviderProfile, text: string): boolean {
  if (provider.kind === 'volcengine-ark' || isArkThinkingModel(text)) {
    return true;
  }

  return provider.kind === 'bailian-compatible' && (isQwenBudgetModel(text) || isBailianEffortModel(text));
}

export function getSupportedReasoningEfforts(
  provider?: ProviderProfile | null,
  model?: ModelInfo | null
): ReasoningEffort[] {
  if (!provider || !model || inferModelTask(model) !== 'chat') {
    return [];
  }

  const text = modelText(model);
  if (isDeepSeekV4Model(text)) {
    return ['default', 'off', 'high', 'max'];
  }

  const explicit = orderedEfforts(model.supportedReasoningEfforts ?? []);
  if (explicit.length) {
    return withDefault(canDisableThinking(provider, text) ? [...explicit, 'off'] : explicit);
  }

  if (isDoubaoSeedModel(text)) {
    return ['default', 'off', 'low', 'medium', 'high'];
  }

  if (isGpt51Model(text)) {
    return ['default', 'off', 'low', 'medium', 'high'];
  }

  if (isGpt5ProModel(text)) {
    return ['default', 'high'];
  }

  if (provider.kind === 'bailian-compatible') {
    if (isQwenBudgetModel(text)) {
      return ['default', 'off', 'low', 'medium', 'high', 'max'];
    }

    if (isBailianEffortModel(text)) {
      return ['default', 'off', 'high', 'max'];
    }
  }

  if (!isReasoningModel(model)) {
    return isArkThinkingModel(text) ? ['default', 'off', 'low', 'medium', 'high'] : [];
  }

  if (provider.kind === 'volcengine-ark') {
    return ['default', 'off', 'low', 'medium', 'high'];
  }

  if (provider.kind === 'bailian-compatible') {
    return ['default', 'off'];
  }

  if (isOpenAiBaseUrl(provider) || isOpenAiReasoningModel(text)) {
    return ['default', 'low', 'medium', 'high'];
  }

  return ['default', 'off', 'low', 'medium', 'high', 'max'];
}

export function getReasoningEffortOptions(
  provider?: ProviderProfile | null,
  model?: ModelInfo | null
): ReasoningEffortOption[] {
  return getSupportedReasoningEfforts(provider, model).map((effort) => ({
    key: effort,
    label: reasoningEffortLabels[effort],
  }));
}

export function normalizeReasoningEffort(
  provider: ProviderProfile | null | undefined,
  model: ModelInfo | null | undefined,
  effort: ReasoningEffort
): ReasoningEffort {
  const supported = getSupportedReasoningEfforts(provider, model);
  return supported.includes(effort) ? effort : 'default';
}
