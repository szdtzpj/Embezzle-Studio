import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  arkPresetModels,
  isArkPresetModelId,
  isArkStaticDoubaoModelId,
} from '../src/data/arkModels';
import type { ModelInfo, ProviderProfile } from '../src/domain/types';
import {
  createModelInfoFromId,
  enrichDiscoveredModel,
} from '../src/services/modelCapabilities';
import { refreshProviderModels } from '../src/services/modelDiscovery';

const mocks = vi.hoisted(() => ({
  fetchModels: vi.fn(),
}));

vi.mock('../src/services/openAiCompatible', () => ({
  fetchOpenAiCompatibleModels: mocks.fetchModels,
  isAbortError: (error: unknown) => error instanceof Error && error.name === 'AbortError',
}));

function provider(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'provider-test',
    name: 'Test provider',
    kind: 'openai-compatible',
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key',
    capabilities: ['streaming'],
    models: [],
    ...overrides,
  };
}

describe('Volcano Ark public model catalog', () => {
  it('uses unique, current invocation Model IDs instead of console-family aliases', () => {
    const ids = arkPresetModels.map((model) => model.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining([
        'doubao-seed-evolving',
        'doubao-seed-2-1-pro-260628',
        'doubao-seed-2-1-turbo-260628',
        'doubao-seed-2-0-lite-260428',
        'doubao-seed-character-260628',
        'glm-5-2-260617',
        'deepseek-v4-pro-260425',
        'doubao-seedance-2-0-260128',
        'doubao-seedance-2-0-mini-260615',
        'doubao-seedream-5-0-pro-260628',
      ])
    );
    expect(ids).not.toEqual(
      expect.arrayContaining([
        'doubao-seed-2-1-pro',
        'doubao-seed-2-1-turbo',
        'doubao-seed-1-8-251215',
        'doubao-1-5-thinking-pro',
      ])
    );
  });

  it.each<{
    id: string;
    task: ModelInfo['task'];
    includes: ModelInfo['capabilities'];
    excludes?: ModelInfo['capabilities'];
  }>([
    {
      id: 'doubao-seed-2-1-pro-260628',
      task: 'chat',
      includes: ['reasoning', 'image-input', 'tool-calling', 'streaming'],
      excludes: ['video-input'],
    },
    {
      id: 'doubao-seed-2-0-code-preview-260215',
      task: 'chat',
      includes: ['reasoning', 'image-input', 'tool-calling'],
      excludes: ['video-input'],
    },
    {
      id: 'glm-5-2-260617',
      task: 'chat',
      includes: ['reasoning', 'tool-calling', 'streaming'],
      excludes: ['image-input', 'video-input'],
    },
    {
      id: 'doubao-seedance-2-0-260128',
      task: 'video-generation',
      includes: ['image-input', 'video-input', 'video-generation'],
      excludes: ['reasoning', 'streaming'],
    },
    {
      id: 'doubao-seedream-5-0-pro-260628',
      task: 'image-generation',
      includes: ['image-generation'],
      excludes: ['image-input', 'video-generation', 'reasoning'],
    },
    {
      id: 'doubao-embedding-vision-251215',
      task: 'embedding',
      includes: ['text', 'image-input', 'video-input', 'embedding'],
      excludes: ['tool-calling', 'reasoning'],
    },
  ])('records the documented task and capability metadata for $id', ({ id, task, includes, excludes = [] }) => {
    const model = arkPresetModels.find((candidate) => candidate.id === id);

    expect(model).toBeDefined();
    expect(model?.task).toBe(task);
    expect(model?.capabilities).toEqual(expect.arrayContaining(includes));
    excludes.forEach((capability) => expect(model?.capabilities).not.toContain(capability));
  });

  it('separates current preset IDs from obsolete bundled aliases', () => {
    expect(isArkPresetModelId(' doubao-seed-2-1-pro-260628 ')).toBe(true);
    expect(isArkStaticDoubaoModelId('doubao-seed-2-1-pro')).toBe(true);
    expect(isArkStaticDoubaoModelId('doubao-seed-1-8-251215')).toBe(true);

    expect(isArkStaticDoubaoModelId('doubao-seed-2-1-pro-260628')).toBe(false);
    expect(isArkStaticDoubaoModelId('doubao-seed-character-251128')).toBe(false);
    expect(isArkStaticDoubaoModelId('doubao-seedance-2-0-260128')).toBe(false);
    expect(isArkStaticDoubaoModelId('doubao-seedream-5-0-pro-260628')).toBe(false);
    expect(isArkStaticDoubaoModelId('ep-20260710-example')).toBe(false);
  });

  it('parses the observed Ark model metadata without guessing unsupported tasks', () => {
    const ark = provider({
      kind: 'volcengine-ark',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      capabilities: ['streaming'],
    });
    const chat = enrichDiscoveredModel(ark, {
      id: 'future-multimodal-chat',
      name: 'Future multimodal chat',
      domain: 'VLM',
      features: { tools: { function_calling: true } },
      modalities: {
        input_modalities: ['text', 'image', 'video'],
        output_modalities: ['text'],
      },
      task_type: ['VisualQuestionAnswering', 'TextGeneration'],
      token_limits: { context_window: 262144 },
    });
    const embedding = enrichDiscoveredModel(ark, {
      id: 'future-multimodal-embedding',
      domain: 'Embedding',
      modalities: { input_modalities: ['text', 'image', 'video'] },
      task_type: ['ImageEmbedding'],
      token_limits: { context_window: 131072 },
    });
    const video = enrichDiscoveredModel(ark, {
      id: 'future-video-generator',
      domain: 'VideoGeneration',
      modalities: {
        input_modalities: ['text', 'image', 'video'],
        output_modalities: ['video'],
      },
      task_type: ['MultimodalToVideo', 'VideoEditing'],
    });

    expect(chat).toMatchObject({ task: 'chat', contextWindow: 262144 });
    expect(chat?.capabilities).toEqual(
      expect.arrayContaining(['text', 'image-input', 'tool-calling', 'streaming'])
    );
    expect(chat?.capabilities).not.toContain('video-input');
    expect(embedding).toMatchObject({ task: 'embedding', contextWindow: 131072 });
    expect(embedding?.capabilities).toEqual(
      expect.arrayContaining(['text', 'image-input', 'video-input', 'embedding'])
    );
    expect(video).toMatchObject({ task: 'video-generation' });
    expect(video?.capabilities).toEqual(
      expect.arrayContaining(['text', 'image-input', 'video-input', 'video-generation'])
    );
  });

  it('rejects unsupported or conflicting Ark metadata instead of routing it to chat', () => {
    const ark = provider({
      kind: 'volcengine-ark',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    });

    expect(enrichDiscoveredModel(ark, {
      id: 'future-3d',
      domain: '3DGeneration',
      task_type: ['ImageTo3D'],
      modalities: { output_modalities: ['three_d'] },
    })).toBeNull();
    expect(enrichDiscoveredModel(ark, {
      id: 'future-speech-only',
      task_type: ['SpeechToText'],
      modalities: { input_modalities: ['audio'], output_modalities: ['text'] },
    })).toBeNull();
    expect(enrichDiscoveredModel(ark, {
      id: 'conflicting-task',
      domain: 'LLM',
      task_type: ['TextGeneration', 'TextToVideo'],
      modalities: { output_modalities: ['text', 'video'] },
    })).toBeNull();
    expect(enrichDiscoveredModel(ark, {
      id: 'future-audio-generator',
      domain: 'AudioGeneration',
      task_type: ['TextToSpeech'],
      modalities: { input_modalities: ['text'], output_modalities: ['audio'] },
    })).toBeNull();
  });

  it('accepts only exact Ark task metadata and supported adapter shapes', () => {
    const ark = provider({ kind: 'volcengine-ark', capabilities: ['streaming'] });
    const router = enrichDiscoveredModel(ark, {
      id: 'future-router',
      domain: 'Router',
      task_type: ['TextGeneration'],
      modalities: { input_modalities: ['text'], output_modalities: ['text'] },
      features: { tools: { function_calling: false } },
      token_limits: { context_window: '262144' },
    });
    const frames = enrichDiscoveredModel(ark, {
      id: 'future-frame-video',
      domain: 'VideoGeneration',
      task_type: ['TextToVideo'],
      modalities: {
        input_modalities: ['text', 'first_frame', 'first_last_frame', 'reference'],
        output_modalities: ['video'],
      },
    });
    const fakeKeywords = enrichDiscoveredModel(ark, {
      id: 'plain-model',
      domain: 'LLM',
      task_type: ['NotEmbedding', 'VideoQuestionAnswering'],
      modalities: { output_modalities: ['text'] },
    });
    const imageToImageOnly = enrichDiscoveredModel(ark, {
      id: 'edit-only-image',
      domain: 'ImageGeneration',
      task_type: ['ImageToImage'],
      modalities: { input_modalities: ['image'], output_modalities: ['image'] },
    });

    expect(router).toMatchObject({ task: 'chat' });
    expect(router).not.toHaveProperty('contextWindow');
    expect(router?.capabilities).not.toContain('tool-calling');
    expect(frames).toMatchObject({ task: 'video-generation' });
    expect(frames?.capabilities).toContain('image-input');
    expect(frames?.capabilities).not.toContain('streaming');
    expect(fakeKeywords).toMatchObject({ task: 'chat' });
    expect(fakeKeywords?.capabilities).not.toEqual(expect.arrayContaining(['embedding', 'video-generation']));
    expect(imageToImageOnly).toBeNull();
  });

  it('hides shutdown Ark entries and labels retiring entries returned by the compatibility probe', () => {
    const ark = provider({ kind: 'volcengine-ark' });

    expect(enrichDiscoveredModel(ark, { id: 'old-model', status: 'Shutdown' })).toBeNull();
    expect(enrichDiscoveredModel(ark, { id: 'retiring-model', status: 'Retiring' })).toMatchObject({
      name: 'retiring-model（即将下线）',
    });
  });

  it('keeps manually added Ark generation models within implemented adapter capabilities', () => {
    const ark = provider({
      kind: 'volcengine-ark',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      capabilities: ['streaming'],
    });
    const seedance = createModelInfoFromId(ark, 'doubao-seedance-2-0-260128', 'manual');
    const seedream = createModelInfoFromId(ark, 'doubao-seedream-5-0-pro-260628', 'manual');

    expect(seedance.task).toBe('video-generation');
    expect(seedance.capabilities).toEqual(
      expect.arrayContaining(['text', 'image-input', 'video-input', 'video-generation'])
    );
    expect(seedance.capabilities).not.toEqual(
      expect.arrayContaining(['tool-calling', 'reasoning', 'streaming'])
    );
    expect(seedream).toMatchObject({
      task: 'image-generation',
      capabilities: ['text', 'image-generation'],
    });
  });
});

describe('model discovery', () => {
  beforeEach(() => {
    mocks.fetchModels.mockReset();
  });

  it('uses an available Ark-compatible /models response and enriches known IDs with curated capabilities', async () => {
    const ark = provider({
      name: '火山方舟',
      kind: 'volcengine-ark',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    });
    const remoteModels: ModelInfo[] = [
      {
        id: 'doubao-seedance-2-0-260128',
        name: 'doubao-seedance-2-0',
        capabilities: ['text', 'video-generation'],
        task: 'video-generation',
        source: 'remote',
      },
      {
        id: 'account-endpoint-id',
        name: 'Account endpoint',
        capabilities: ['text', 'streaming'],
        task: 'chat',
        source: 'remote',
      },
    ];
    mocks.fetchModels.mockResolvedValue(remoteModels);

    const result = await refreshProviderModels(ark);

    expect(mocks.fetchModels).toHaveBeenCalledOnce();
    expect(mocks.fetchModels).toHaveBeenCalledWith(ark, undefined);
    expect(result.models).toHaveLength(remoteModels.length);
    expect(result.models.every((model) => model.source === 'remote')).toBe(true);
    expect(result.models[0]).toMatchObject({
      id: 'doubao-seedance-2-0-260128',
      task: 'video-generation',
    });
    expect(result.models[0].capabilities).toEqual(
      expect.arrayContaining(['image-input', 'video-input', 'video-generation'])
    );
    expect(result.models[1]).toEqual(remoteModels[1]);
    expect(result.notice).toContain('未列入官方 API 参考的兼容 /models 响应');
    expect(result.notice).toContain('不保证当前账号均可调用');
    expect(result.notice).toContain('Endpoint ID 仍可手动添加');
  });

  it('also recognizes an Ark data-plane host when the provider kind is custom', async () => {
    const ark = provider({
      kind: 'custom',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    });
    const remoteModels: ModelInfo[] = [{
      id: 'doubao-seed-2-0-lite-260428',
      name: 'Doubao Seed 2.0 Lite',
      capabilities: ['text'],
      task: 'chat',
      source: 'remote',
    }];
    mocks.fetchModels.mockResolvedValue(remoteModels);

    const result = await refreshProviderModels(ark);

    expect(mocks.fetchModels).toHaveBeenCalledWith(ark, undefined);
    expect(result.models[0].capabilities).toEqual(
      expect.arrayContaining(['reasoning', 'image-input', 'tool-calling'])
    );
    expect(result.models[0].capabilities).not.toContain('video-input');
  });

  it('never sends an Ark API key to a non-official host during automatic discovery', async () => {
    const ark = provider({
      kind: 'volcengine-ark',
      baseUrl: 'https://untrusted.example/v1',
      apiKey: 'must-not-leave-device',
    });

    const result = await refreshProviderModels(ark);

    expect(mocks.fetchModels).not.toHaveBeenCalled();
    expect(result.models).toHaveLength(arkPresetModels.length);
    expect(result.notice).toContain('未发送 API Key');
  });

  it('drops a remote entry when its task conflicts with the curated preset', async () => {
    const ark = provider({
      kind: 'volcengine-ark',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    });
    mocks.fetchModels.mockResolvedValue([
      {
        id: 'doubao-seedance-2-0-260128',
        name: 'Conflicting Seedance',
        capabilities: ['text'],
        task: 'chat',
        source: 'remote',
      },
      {
        id: 'safe-remote-model',
        name: 'Safe remote model',
        capabilities: ['text'],
        task: 'chat',
        source: 'remote',
      },
    ] satisfies ModelInfo[]);

    const result = await refreshProviderModels(ark);

    expect(result.models.map((model) => model.id)).toEqual(['safe-remote-model']);
  });

  it('falls back to the curated catalog when Ark /models is unavailable', async () => {
    const ark = provider({
      kind: 'volcengine-ark',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    });
    mocks.fetchModels.mockRejectedValue(new Error('network unavailable'));

    const result = await refreshProviderModels(ark);

    expect(mocks.fetchModels).toHaveBeenCalledOnce();
    expect(result.models).toHaveLength(arkPresetModels.length);
    expect(result.models.map((model) => model.id)).toEqual(arkPresetModels.map((model) => model.id));
    expect(result.notice).toContain('/models 响应暂不可用');
    expect(result.notice).toContain('本地精选候选（可能滞后）');
  });

  it.each([
    ['lookalike hostname', { baseUrl: 'https://ark.cn-beijing.volces.com.evil.example/api/v3' }],
    ['provider display name', { name: '火山方舟兼容中转', baseUrl: 'https://relay.example.com/v1' }],
  ])('does not infer the Ark protocol from a %s', async (_label, overrides) => {
    const remoteModels: ModelInfo[] = [{
      id: 'relay-model',
      name: 'Relay model',
      capabilities: ['text'],
      task: 'chat',
      source: 'remote',
    }];
    mocks.fetchModels.mockResolvedValue(remoteModels);
    const relay = provider({ kind: 'custom', ...overrides });

    const result = await refreshProviderModels(relay);

    expect(mocks.fetchModels).toHaveBeenCalledOnce();
    expect(mocks.fetchModels).toHaveBeenCalledWith(relay, undefined);
    expect(result.models).toBe(remoteModels);
  });

  it('keeps OpenAI-compatible remote discovery unchanged for non-Ark providers', async () => {
    const signal = new AbortController().signal;
    const remoteModels: ModelInfo[] = [
      {
        id: 'remote-chat-model',
        name: 'Remote chat model',
        capabilities: ['text', 'streaming'],
        task: 'chat',
        source: 'remote',
      },
    ];
    mocks.fetchModels.mockResolvedValue(remoteModels);
    const other = provider();

    const result = await refreshProviderModels(other, signal);

    expect(mocks.fetchModels).toHaveBeenCalledOnce();
    expect(mocks.fetchModels).toHaveBeenCalledWith(other, signal);
    expect(result.models).toBe(remoteModels);
    expect(result.notice).toBe('已获取 1 个可添加模型。');
  });

  it('honors an already-aborted refresh without attempting network discovery', async () => {
    const controller = new AbortController();
    controller.abort();
    const ark = provider({
      kind: 'volcengine-ark',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    });

    await expect(refreshProviderModels(ark, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.fetchModels).not.toHaveBeenCalled();
  });

  it('does not turn an in-flight Ark cancellation into a catalog fallback', async () => {
    const abortError = new Error('cancelled');
    abortError.name = 'AbortError';
    mocks.fetchModels.mockRejectedValue(abortError);
    const ark = provider({
      kind: 'volcengine-ark',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    });

    await expect(refreshProviderModels(ark)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
