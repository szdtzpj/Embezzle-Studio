import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage, MediaAttachment, ProviderProfile, ReasoningEffort } from '../src/domain/types';
import { createModelInfoFromId } from '../src/services/modelCapabilities';
import {
  getModelParameterConstraint,
  queryGenerationTask,
  sendOpenAiCompatibleChat,
} from '../src/services/openAiCompatible';
import { getSupportedReasoningEfforts, normalizeReasoningEffort } from '../src/services/reasoningEfforts';

const platform = vi.hoisted(() => ({ OS: 'android' }));
vi.mock('react-native', () => ({ Platform: platform }));

// These protocol tests must not initialize the native file-system runtime just
// to persist a provider-returned video URL. The real persistence boundary is
// covered by media-storage/media-export tests; keeping it mocked here also
// prevents full-suite worker contention from turning the two Ark task tests
// into 5-second native-module import timeouts.
const mediaStorageMocks = vi.hoisted(() => ({
  materializeAttachment: vi.fn(async (attachment: MediaAttachment) => attachment),
  persistAttachment: vi.fn(async (attachment: MediaAttachment) => attachment),
}));
vi.mock('../src/services/mediaStorage', () => mediaStorageMocks);

const ark: ProviderProfile = {
  id: 'ark',
  name: 'Volcengine Ark',
  kind: 'volcengine-ark',
  baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  apiKey: 'test',
  capabilities: ['text', 'reasoning'],
  models: [],
};

const openai: ProviderProfile = {
  id: 'openai',
  name: 'OpenAI',
  kind: 'custom',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test',
  capabilities: ['text', 'reasoning'],
  models: [],
};

const customArk: ProviderProfile = {
  ...ark,
  id: 'custom-ark',
  name: 'Ark proxy',
  kind: 'custom',
};

const message: ChatMessage = {
  id: 'u1',
  role: 'user',
  content: 'Hello',
  createdAt: 1,
  status: 'ready',
};

afterEach(() => vi.unstubAllGlobals());

describe('documented reasoning effort matrices', () => {
  it.each([
    [ark, 'glm-5-2-260617', ['default', 'off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']],
    [ark, 'deepseek-v4-pro-260425', ['default', 'off', 'high', 'max']],
    [ark, 'deepseek-v3-2-251201', ['default', 'off']],
    [ark, 'glm-4-7-251222', ['default', 'off']],
    [ark, 'doubao-seed-2-1-pro-260628', ['default', 'off', 'minimal', 'low', 'medium', 'high']],
    [customArk, 'glm-5-2-260617', ['default', 'off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']],
    [openai, 'gpt-5', ['default', 'minimal', 'low', 'medium', 'high']],
    [openai, 'gpt-5.1', ['default', 'none', 'low', 'medium', 'high']],
    [openai, 'gpt-5.2', ['default', 'none', 'low', 'medium', 'high', 'xhigh']],
    [openai, 'gpt-5.6-sol', ['default', 'none', 'low', 'medium', 'high', 'xhigh', 'max']],
    [openai, 'gpt-5.6-pro', ['default', 'none', 'low', 'medium', 'high', 'xhigh', 'max']],
    [openai, 'gpt-5.4-pro', ['default', 'medium', 'high', 'xhigh']],
  ] as const)('%s / %s', (provider, modelId, expected) => {
    const model = createModelInfoFromId(provider, modelId, 'manual');
    expect(getSupportedReasoningEfforts(provider, model)).toEqual(expected);
  });

  it('migrates legacy collapsed effort values without changing valid provider off/max controls', () => {
    const gpt5 = createModelInfoFromId(openai, 'gpt-5', 'manual');
    const gpt52 = createModelInfoFromId(openai, 'gpt-5.2', 'manual');
    const arkGlm = createModelInfoFromId(ark, 'glm-5-2-260617', 'manual');
    expect(normalizeReasoningEffort(openai, gpt5, 'off')).toBe('minimal');
    expect(normalizeReasoningEffort(openai, gpt52, 'max')).toBe('xhigh');
    expect(normalizeReasoningEffort(ark, arkGlm, 'off')).toBe('off');
    expect(normalizeReasoningEffort(ark, arkGlm, 'max')).toBe('max');
  });
});

async function requestBody(
  provider: ProviderProfile,
  modelId: string,
  effort: ReasoningEffort,
  parameterSettings?: Parameters<typeof sendOpenAiCompatibleChat>[0]['parameterSettings']
) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: 'ok' } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  await sendOpenAiCompatibleChat({
    provider,
    modelId,
    model: createModelInfoFromId(provider, modelId, 'manual'),
    messages: [message],
    reasoningEffort: effort,
    parameterSettings,
  });
  return JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as Record<string, unknown>;
}

describe('reasoning and sampling wire parameters', () => {
  it('preserves Ark max/xhigh and never sends an invented effort to toggle-only models', async () => {
    expect(await requestBody(ark, 'deepseek-v4-pro-260425', 'max')).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    });
    expect(await requestBody(ark, 'glm-5-2-260617', 'xhigh')).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'xhigh',
    });
    const toggleOnly = await requestBody(ark, 'deepseek-v3-2-251201', 'high');
    expect(toggleOnly).not.toHaveProperty('reasoning_effort');
  });

  it('uses the same Ark wire protocol for a custom profile pointed at the official Ark host', async () => {
    expect(await requestBody(customArk, 'glm-5-2-260617', 'max')).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    });
  });

  it('omits sampling for active reasoning and sends at most one sampler when allowed', async () => {
    const settings = {
      enabled: true,
      temperature: 0.2,
      topP: 0.6,
      presencePenalty: 1,
      frequencyPenalty: 1,
    };
    const reasoning = await requestBody(openai, 'gpt-5', 'high', settings);
    expect(reasoning).not.toHaveProperty('temperature');
    expect(reasoning).not.toHaveProperty('top_p');
    expect(reasoning).not.toHaveProperty('presence_penalty');

    const noReasoning = await requestBody(openai, 'gpt-5.2', 'none', settings);
    expect(noReasoning.temperature).toBe(0.2);
    expect(noReasoning).not.toHaveProperty('top_p');
    expect(noReasoning).not.toHaveProperty('presence_penalty');

    const standard = await requestBody(openai, 'gpt-4.1', 'default', settings);
    expect(standard.temperature).toBe(0.2);
    expect(standard).not.toHaveProperty('top_p');
    expect(standard.presence_penalty).toBe(1);
  });

  it('does not expose undocumented penalty controls for official OpenAI reasoning models', () => {
    expect(getModelParameterConstraint(openai, 'gpt-5.1', 'temperature').supported).toBe(true);
    expect(getModelParameterConstraint(openai, 'gpt-5.1', 'topP').supported).toBe(true);
    expect(getModelParameterConstraint(openai, 'gpt-5.1', 'presencePenalty').supported).toBe(false);
    expect(getModelParameterConstraint(openai, 'gpt-5.1', 'frequencyPenalty').supported).toBe(false);
  });

  it('preserves GPT-5.6 max reasoning effort on the official OpenAI wire', async () => {
    expect(await requestBody(openai, 'gpt-5.6-sol', 'max')).toMatchObject({
      reasoning_effort: 'max',
    });
  });
});

describe('Ark video task protocol', () => {
  it('forwards a reference image and treats expired as a terminal error', async () => {
    const reference: MediaAttachment = {
      id: 'ref-1',
      kind: 'image',
      uri: 'https://images.example.com/first-frame.png',
      name: 'first-frame.png',
      mimeType: 'image/png',
    };
    const videoMessage: ChatMessage = { ...message, attachments: [reference] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'cgt-1',
        status: 'succeeded',
        content: { video_url: 'https://videos.example.com/result.mp4' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'cgt-expired',
        status: 'expired',
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendOpenAiCompatibleChat({
      provider: ark,
      modelId: 'doubao-seedance-2-0-260128',
      model: createModelInfoFromId(ark, 'doubao-seedance-2-0-260128', 'manual'),
      messages: [videoMessage],
      reasoningEffort: 'default',
    });

    const submitted = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(submitted.content).toContainEqual({
      type: 'image_url',
      image_url: { url: reference.uri },
    });
    expect(result.attachments?.[0].uri).toBe('https://videos.example.com/result.mp4');
    expect(result.attachments?.[0].mimeType).toBe('video/mp4');
    await expect(queryGenerationTask(ark, {
      providerId: ark.id,
      modelId: 'doubao-seedance-2-0-260128',
      taskId: 'cgt-expired',
      kind: 'video',
    })).rejects.toThrow(/已过期/);
  });

  it('allows video references for a custom profile on the exact official Ark host', async () => {
    const reference: MediaAttachment = {
      id: 'ref-video',
      kind: 'video',
      uri: 'https://videos.example.com/reference.mp4',
      name: 'reference.mp4',
      mimeType: 'video/mp4',
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'cgt-video-ref',
      status: 'succeeded',
      content: { video_url: 'https://videos.example.com/generated.mp4' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await sendOpenAiCompatibleChat({
      provider: customArk,
      modelId: 'doubao-seedance-2-0-260128',
      model: createModelInfoFromId(customArk, 'doubao-seedance-2-0-260128', 'manual'),
      messages: [{ ...message, attachments: [reference] }],
      reasoningEffort: 'default',
    });

    const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(requestUrl).toBe('https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks');
    expect(body.content).toContainEqual({
      type: 'video_url',
      video_url: { url: reference.uri },
    });
  });
});
