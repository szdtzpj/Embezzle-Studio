import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  arkPresetModels,
  isArkPresetModelId,
  isArkStaticDoubaoModelId,
} from '../src/data/arkModels';
import type { ModelInfo, ProviderProfile } from '../src/domain/types';
import { refreshProviderModels } from '../src/services/modelDiscovery';

const mocks = vi.hoisted(() => ({
  fetchModels: vi.fn(),
}));

vi.mock('../src/services/openAiCompatible', () => ({
  fetchOpenAiCompatibleModels: mocks.fetchModels,
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
      includes: ['reasoning', 'image-input', 'video-input', 'tool-calling', 'streaming'],
    },
    {
      id: 'doubao-seed-2-0-code-preview-260215',
      task: 'chat',
      includes: ['reasoning', 'image-input', 'video-input', 'tool-calling'],
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
      includes: ['image-input', 'image-generation'],
      excludes: ['video-generation', 'reasoning'],
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
});

describe('model discovery', () => {
  beforeEach(() => {
    mocks.fetchModels.mockReset();
  });

  it('uses the local official catalog for Ark and never calls the undocumented Bearer /models path', async () => {
    const ark = provider({
      name: '火山方舟',
      kind: 'volcengine-ark',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    });

    const result = await refreshProviderModels(ark);

    expect(mocks.fetchModels).not.toHaveBeenCalled();
    expect(result.models).toHaveLength(arkPresetModels.length);
    expect(result.models.every((model) => model.source === 'remote')).toBe(true);
    expect(result.models.map((model) => model.id)).toEqual(arkPresetModels.map((model) => model.id));
    expect(result.notice).toContain('官方模型目录');
    expect(result.notice).toContain('不会校验当前账号权限');
    expect(result.notice).toContain('Endpoint ID 请手动添加');
  });

  it('also recognizes an Ark data-plane host when the provider kind is custom', async () => {
    const ark = provider({
      kind: 'custom',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    });

    const result = await refreshProviderModels(ark);

    expect(mocks.fetchModels).not.toHaveBeenCalled();
    expect(result.models.some((model) => model.id === 'doubao-seedance-2-0-260128')).toBe(true);
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
    const ark = provider({ kind: 'volcengine-ark' });

    await expect(refreshProviderModels(ark, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.fetchModels).not.toHaveBeenCalled();
  });
});
