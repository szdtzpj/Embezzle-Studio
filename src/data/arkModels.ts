import type { Capability, ModelInfo, ModelTask, ProviderProfile } from '../domain/types';

const arkMultimodalReasoning: Capability[] = [
  'text',
  'image-input',
  'video-input',
  'tool-calling',
  'reasoning',
  'streaming',
];

const arkTextReasoning: Capability[] = ['text', 'tool-calling', 'reasoning', 'streaming'];
const arkVideoGeneration: Capability[] = ['text', 'image-input', 'video-input', 'video-generation'];
const arkImageGeneration: Capability[] = ['text', 'image-input', 'image-generation'];
const arkMultimodalEmbedding: Capability[] = ['text', 'image-input', 'video-input', 'embedding'];

interface ArkPresetOptions {
  contextWindow?: number;
  task?: ModelTask;
}

function arkPreset(
  id: string,
  name: string,
  capabilities: Capability[],
  options: ArkPresetOptions = {}
): ModelInfo {
  return {
    id,
    name,
    capabilities: [...capabilities],
    ...(options.contextWindow ? { contextWindow: options.contextWindow } : {}),
    ...(options.task ? { task: options.task } : {}),
    source: 'preset',
  };
}

/**
 * Curated from the public Volcano Ark model catalog.
 *
 * These are catalog candidates, not an account-entitlement response. Keep the
 * invocation Model ID (including its version suffix) separate from the shorter
 * product-family ID used in some console URLs.
 */
export const arkPresetModels: ModelInfo[] = [
  arkPreset('doubao-seed-evolving', 'Doubao Seed Evolving', arkMultimodalReasoning, {
    contextWindow: 262144,
    task: 'chat',
  }),
  arkPreset('doubao-seed-2-1-pro-260628', 'Doubao Seed 2.1 Pro', arkMultimodalReasoning, {
    contextWindow: 262144,
    task: 'chat',
  }),
  arkPreset('doubao-seed-2-1-turbo-260628', 'Doubao Seed 2.1 Turbo', arkMultimodalReasoning, {
    contextWindow: 262144,
    task: 'chat',
  }),
  arkPreset('doubao-seed-2-0-lite-260428', 'Doubao Seed 2.0 Lite', arkMultimodalReasoning, {
    contextWindow: 262144,
    task: 'chat',
  }),
  arkPreset('doubao-seed-2-0-mini-260428', 'Doubao Seed 2.0 Mini', arkMultimodalReasoning, {
    contextWindow: 262144,
    task: 'chat',
  }),
  arkPreset('doubao-seed-2-0-pro-260215', 'Doubao Seed 2.0 Pro', arkMultimodalReasoning, {
    contextWindow: 262144,
    task: 'chat',
  }),
  arkPreset('doubao-seed-2-0-lite-260215', 'Doubao Seed 2.0 Lite 260215', arkMultimodalReasoning, {
    contextWindow: 262144,
    task: 'chat',
  }),
  arkPreset('doubao-seed-2-0-mini-260215', 'Doubao Seed 2.0 Mini 260215', arkMultimodalReasoning, {
    contextWindow: 262144,
    task: 'chat',
  }),
  arkPreset('doubao-seed-2-0-code-preview-260215', 'Doubao Seed 2.0 Code Preview', arkMultimodalReasoning, {
    contextWindow: 262144,
    task: 'chat',
  }),
  arkPreset('doubao-seed-character-260628', 'Doubao Seed Character', arkMultimodalReasoning, {
    contextWindow: 131072,
    task: 'chat',
  }),
  arkPreset('glm-5-2-260617', 'GLM 5.2', arkTextReasoning, {
    contextWindow: 1048576,
    task: 'chat',
  }),
  arkPreset('glm-4-7-251222', 'GLM 4.7（即将下线）', arkTextReasoning, {
    contextWindow: 204800,
    task: 'chat',
  }),
  arkPreset('deepseek-v4-pro-260425', 'DeepSeek V4 Pro', arkTextReasoning, {
    contextWindow: 1048576,
    task: 'chat',
  }),
  arkPreset('deepseek-v4-flash-260425', 'DeepSeek V4 Flash', arkTextReasoning, {
    contextWindow: 1048576,
    task: 'chat',
  }),
  arkPreset('deepseek-v3-2-251201', 'DeepSeek V3.2（即将下线）', arkTextReasoning, {
    contextWindow: 131072,
    task: 'chat',
  }),

  arkPreset('doubao-seedance-2-0-260128', 'Doubao Seedance 2.0', arkVideoGeneration, {
    task: 'video-generation',
  }),
  arkPreset('doubao-seedance-2-0-fast-260128', 'Doubao Seedance 2.0 Fast', arkVideoGeneration, {
    task: 'video-generation',
  }),
  arkPreset('doubao-seedance-2-0-mini-260615', 'Doubao Seedance 2.0 Mini', arkVideoGeneration, {
    task: 'video-generation',
  }),
  arkPreset('doubao-seedance-1-0-pro-250528', 'Doubao Seedance 1.0 Pro', arkVideoGeneration, {
    task: 'video-generation',
  }),
  arkPreset('doubao-seedance-1-0-pro-fast-251015', 'Doubao Seedance 1.0 Pro Fast', arkVideoGeneration, {
    task: 'video-generation',
  }),

  arkPreset('doubao-seedream-5-0-pro-260628', 'Doubao Seedream 5.0 Pro', arkImageGeneration, {
    task: 'image-generation',
  }),
  arkPreset('doubao-seedream-5-0-260128', 'Doubao Seedream 5.0', arkImageGeneration, {
    task: 'image-generation',
  }),
  arkPreset('doubao-seedream-5-0-lite-260128', 'Doubao Seedream 5.0 Lite', arkImageGeneration, {
    task: 'image-generation',
  }),
  arkPreset('doubao-seedream-4-5-251128', 'Doubao Seedream 4.5', arkImageGeneration, {
    task: 'image-generation',
  }),
  arkPreset('doubao-seedream-4-0-250828', 'Doubao Seedream 4.0', arkImageGeneration, {
    task: 'image-generation',
  }),

  arkPreset('doubao-embedding-vision-251215', 'Doubao Embedding Vision', arkMultimodalEmbedding, {
    contextWindow: 131072,
    task: 'embedding',
  }),
];

const arkPresetModelIds = new Set(arkPresetModels.map((model) => model.id));

/** Short or stale IDs previously bundled by the app, retained only for migration cleanup. */
const arkLegacyStaticAliasIds = new Set([
  'doubao-seed-2-1-pro',
  'doubao-seed-2-1-turbo',
  'doubao-seed-1-8-251215',
  'doubao-1-5-thinking-pro',
  'doubao-1-5-thinking-vision-pro',
  'doubao-1-5-vision-pro',
]);

export function isArkPresetModelId(modelId: string): boolean {
  return arkPresetModelIds.has(modelId.trim().toLowerCase());
}

/**
 * Kept under its historical export name because storage and UI call it.
 * It now identifies only obsolete bundled aliases; complete manual Model IDs
 * such as doubao-seed-*-YYMMDD and doubao-seedance-*-YYMMDD must remain usable.
 */
export function isArkStaticDoubaoModelId(modelId: string): boolean {
  return arkLegacyStaticAliasIds.has(modelId.trim().toLowerCase());
}

export function isVolcengineArkProvider(provider: ProviderProfile): boolean {
  if (provider.kind === 'volcengine-ark') {
    return true;
  }

  try {
    const host = new URL(provider.baseUrl).hostname.toLowerCase();
    return host === 'ark.cn-beijing.volces.com' || host === 'ark.cn-beijing.volcengineapi.com';
  } catch {
    return false;
  }
}
