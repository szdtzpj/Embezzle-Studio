import type { ModelInfo, ProviderProfile, ReasoningEffort } from '../domain/types';
import { getBailianThinkingProfile, inferModelTask, isReasoningModel } from './modelCapabilities';

export interface ReasoningEffortOption {
  key: ReasoningEffort;
  label: string;
}

export const reasoningEffortLabels: Record<ReasoningEffort, string> = {
  default: '默认',
  off: '关闭思考',
  none: '无',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
};

const effortOrder: ReasoningEffort[] = [
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

function normalizedText(value?: string): string {
  return (value ?? '').trim().toLowerCase().replace(/[:/_.\s]+/g, '-');
}

function modelText(model: ModelInfo): string {
  const id = normalizedText(model.id);
  const name = normalizedText(model.name);
  return name && name !== id ? `${id}-${name}` : id;
}

function orderedEfforts(efforts: Iterable<ReasoningEffort>): ReasoningEffort[] {
  const set = new Set(efforts);
  return effortOrder.filter((effort) => set.has(effort));
}

function withDefault(efforts: ReasoningEffort[]): ReasoningEffort[] {
  return orderedEfforts(['default', ...efforts]);
}

function isOpenAiBaseUrl(provider: ProviderProfile): boolean {
  try {
    return new URL(provider.baseUrl).hostname.toLowerCase() === 'api.openai.com';
  } catch {
    return false;
  }
}

function isOpenAiReasoningModel(text: string): boolean {
  return /(?:^|-)(?:o1|o3|o4)(?:$|-)/.test(text) || /(?:^|-)gpt-?5(?:$|-)/.test(text);
}

function isGpt52OrLaterModel(text: string): boolean {
  const match = text.match(/(?:^|-)gpt-?5-(\d+)(?:\b|-)/);
  return match ? Number(match[1]) >= 2 : false;
}

function isGpt56OrLaterModel(text: string): boolean {
  const match = text.match(/(?:^|-)gpt-?5-(\d+)(?:\b|-)/);
  return match ? Number(match[1]) >= 6 : false;
}

function gpt5MinorVersion(text: string): number | undefined {
  const match = text.match(/(?:^|-)gpt-?5-(\d+)(?:\b|-)/);
  return match ? Number(match[1]) : undefined;
}

function isGpt51Model(text: string): boolean {
  return /(?:^|-)gpt-?5-1(?:\b|-)/.test(text);
}

function isGpt5ProModel(text: string): boolean {
  return /(?:^|-)(?:gpt-?5-pro|gpt-?5-(?:2|4|5)-pro)(?:\b|-)/.test(text);
}

function isBaseGpt5Model(text: string): boolean {
  return /(?:^|-)gpt-?5(?:-(?:mini|nano))?(?:$|-)/.test(text) && gpt5MinorVersion(text) === undefined;
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

function canDisableThinking(provider: ProviderProfile, model: ModelInfo, text: string): boolean {
  if (provider.kind === 'volcengine-ark' || isArkThinkingModel(text)) {
    return true;
  }

  return provider.kind === 'bailian-compatible' && getBailianThinkingProfile(model.id).mode === 'mixed';
}

export function getSupportedReasoningEfforts(
  provider?: ProviderProfile | null,
  model?: ModelInfo | null
): ReasoningEffort[] {
  if (!provider || !model || inferModelTask(model) !== 'chat') {
    return [];
  }

  const text = modelText(model);
  if (model.capabilityOverrides?.reasoning === false) {
    return [];
  }
  if (provider.kind === 'bailian-compatible') {
    const profile = getBailianThinkingProfile(model.id);
    if (profile.mode === 'thinking-only') {
      return profile.supportsThinkingBudget
        ? ['default', 'low', 'medium', 'high', 'max']
        : ['default'];
    }

    if (profile.mode === 'mixed') {
      if (profile.reasoningEffortFamily === 'deepseek-v4') {
        return ['default', 'off', 'high', 'max'];
      }

      if (
        profile.reasoningEffortFamily === 'glm-5.2'
      ) {
        return ['default', 'off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
      }

      if (profile.reasoningEffortFamily === 'glm-5.1-or-5') {
        return ['default', 'off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
      }

      if (profile.supportsThinkingBudget) {
        return ['default', 'off', 'low', 'medium', 'high', 'max'];
      }

      return profile.defaultEnabled === false
        ? ['default', 'off', 'high']
        : ['default', 'off'];
    }
  }

  if (provider.kind === 'volcengine-ark') {
    if (text.includes('glm-5-2')) {
      return ['default', 'off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    }
    if (isDeepSeekV4Model(text)) {
      return ['default', 'off', 'high', 'max'];
    }
    if (text.includes('deepseek-v3-2') || text.includes('glm-4-7')) {
      return ['default', 'off'];
    }
    if (
      text.includes('doubao-seed-2-') ||
      text.includes('doubao-seed-evolving') ||
      text.includes('doubao-seed-character-260628')
    ) {
      return ['default', 'off', 'low', 'medium', 'high'];
    }
    return isReasoningModel(model) ? ['default', 'off'] : [];
  }

  if (isOpenAiBaseUrl(provider) || isOpenAiReasoningModel(text)) {
    if (isGpt5ProModel(text)) {
      return (gpt5MinorVersion(text) ?? 0) >= 2
        ? ['default', 'medium', 'high', 'xhigh']
        : ['default', 'high'];
    }
    if (isGpt56OrLaterModel(text)) {
      return ['default', 'none', 'low', 'medium', 'high', 'xhigh', 'max'];
    }
    if (isGpt52OrLaterModel(text)) {
      return ['default', 'none', 'low', 'medium', 'high', 'xhigh'];
    }
    if (isGpt51Model(text)) {
      return ['default', 'none', 'low', 'medium', 'high'];
    }
    if (isBaseGpt5Model(text)) {
      return ['default', 'minimal', 'low', 'medium', 'high'];
    }
    return isReasoningModel(model) ? ['default', 'low', 'medium', 'high'] : [];
  }

  if (isDeepSeekV4Model(text)) {
    return ['default', 'off', 'high', 'max'];
  }

  const explicit = orderedEfforts(model.supportedReasoningEfforts ?? []);
  if (explicit.length) {
    return withDefault(canDisableThinking(provider, model, text) ? [...explicit, 'off'] : explicit);
  }

  if (isDoubaoSeedModel(text)) {
    return ['default', 'off', 'low', 'medium', 'high'];
  }

  if (!isReasoningModel(model)) {
    return isArkThinkingModel(text) ? ['default', 'off', 'low', 'medium', 'high'] : [];
  }

  if (provider.kind === 'bailian-compatible') {
    return ['default'];
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
  if (supported.includes(effort)) {
    return effort;
  }
  // Preserve the intent of values saved by versions that collapsed official
  // none/minimal into "off" and xhigh into "max".
  if (effort === 'off') {
    if (supported.includes('none')) return 'none';
    if (supported.includes('minimal')) return 'minimal';
  }
  if (effort === 'max' && supported.includes('xhigh')) {
    return 'xhigh';
  }
  return 'default';
}
