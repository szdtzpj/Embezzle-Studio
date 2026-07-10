import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage, MediaAttachment, ProviderProfile, ReasoningEffort } from '../src/domain/types';
import {
  createModelInfoFromId,
  getBailianThinkingProfile,
  isReasoningModel,
  isVideoInputModel,
  isVisionModel,
} from '../src/services/modelCapabilities';
import {
  fetchOpenAiCompatibleModels,
  sendOpenAiCompatibleChat,
} from '../src/services/openAiCompatible';
import { getSupportedReasoningEfforts } from '../src/services/reasoningEfforts';

const platform = vi.hoisted(() => ({ OS: 'android' }));
const fileSystemState = vi.hoisted(() => ({
  size: 8 * 1024 * 1024,
  base64Calls: 0,
}));

vi.mock('react-native', () => ({
  Platform: platform,
}));

vi.mock('expo-file-system', () => ({
  File: class {
    exists = true;
    size = fileSystemState.size;

    async base64() {
      fileSystemState.base64Calls += 1;
      return 'AAAA';
    }
  },
}));

const provider: ProviderProfile = {
  id: 'bailian-test',
  name: 'Bailian Test',
  kind: 'bailian-compatible',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: 'sk-test',
  capabilities: ['text', 'image-input', 'video-input', 'streaming'],
  models: [],
};

function model(modelId: string) {
  return createModelInfoFromId(provider, modelId, 'remote');
}

function userMessage(attachments?: MediaAttachment[]): ChatMessage {
  return {
    id: 'user-1',
    role: 'user',
    content: '请分析附件',
    createdAt: 1,
    status: 'ready',
    attachments,
  };
}

function jsonCompletion(content = 'ok') {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

async function sendAndReadBody(
  modelId: string,
  reasoningEffort: ReasoningEffort,
  attachments?: MediaAttachment[],
  parameterSettings?: Parameters<typeof sendOpenAiCompatibleChat>[0]['parameterSettings']
) {
  const fetchMock = vi.fn(async () => jsonCompletion());
  vi.stubGlobal('fetch', fetchMock);

  await sendOpenAiCompatibleChat({
    provider,
    modelId,
    model: model(modelId),
    messages: [userMessage(attachments)],
    reasoningEffort,
    parameterSettings,
  });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return {
    requestUrl,
    body: JSON.parse(String(init.body)) as Record<string, any>,
  };
}

beforeEach(() => {
  platform.OS = 'android';
  fileSystemState.base64Calls = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Bailian official thinking capability matrix', () => {
  it.each(['qwq-plus', 'qvq-max', 'qvq-plus', 'deepseek-r1', 'deepseek-r1-0528'])(
    'treats %s as thinking-only without an off or invented budget option',
    (modelId) => {
      const requestModel = model(modelId);

      expect(getBailianThinkingProfile(modelId)).toMatchObject({
        mode: 'thinking-only',
        supportsThinkingBudget: false,
      });
      expect(getSupportedReasoningEfforts(provider, requestModel)).toEqual(['default']);
      expect(isReasoningModel(requestModel)).toBe(true);
    }
  );

  it('keeps Qwen thinking-only models budget-capable but never offers off', () => {
    const requestModel = model('qwen3.7-max-preview');

    expect(getBailianThinkingProfile(requestModel.id)).toMatchObject({
      mode: 'thinking-only',
      supportsThinkingBudget: true,
    });
    expect(getSupportedReasoningEfforts(provider, requestModel)).toEqual([
      'default',
      'low',
      'medium',
      'high',
      'max',
    ]);
  });

  it.each(['deepseek-v3.1', 'deepseek-v3.2', 'deepseek-v3.2-exp', 'glm-4.5', 'glm-4.5-air'])(
    'recognizes %s as a mixed-thinking model',
    (modelId) => {
      const requestModel = model(modelId);

      expect(getBailianThinkingProfile(modelId).mode).toBe('mixed');
      expect(isReasoningModel(requestModel)).toBe(true);
      expect(getSupportedReasoningEfforts(provider, requestModel)).toContain('off');
    }
  );

  it.each([
    ['glm-5', ['default', 'off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh']],
    ['glm-5.1', ['default', 'off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh']],
    ['glm-5.2', ['default', 'off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']],
  ] as const)(
    'exposes the documented native GLM effort levels for %s',
    (modelId, expected) => {
      expect(getSupportedReasoningEfforts(provider, model(modelId))).toEqual(expected);
    }
  );
});

describe('Bailian request parameter mapping', () => {
  it('normalizes the two unsupported inclusive sampling endpoints', async () => {
    const temperature = await sendAndReadBody('qwen-max', 'default', undefined, {
      enabled: true,
      temperature: 2,
      topP: 1,
      presencePenalty: 0,
      frequencyPenalty: 0,
    });
    expect(temperature.body.temperature).toBe(1.99);

    const topP = await sendAndReadBody('qwen-max', 'default', undefined, {
      enabled: true,
      temperature: 1,
      topP: 0,
      presencePenalty: 0,
      frequencyPenalty: 0,
    });
    expect(topP.body.top_p).toBe(0.01);
  });

  it.each(['qwq-plus', 'qvq-max', 'deepseek-r1'])(
    'does not send unsupported thinking controls to %s',
    async (modelId) => {
      const { body } = await sendAndReadBody(modelId, 'max');

      expect(body).not.toHaveProperty('enable_thinking');
      expect(body).not.toHaveProperty('thinking_budget');
      expect(body).not.toHaveProperty('reasoning_effort');
    }
  );

  it('does not send enable_thinking=false to a Qwen thinking-only model', async () => {
    const disabled = await sendAndReadBody('qwen3.7-max-preview', 'off');
    expect(disabled.body).not.toHaveProperty('enable_thinking');

    const budgeted = await sendAndReadBody('qwen3.7-max-preview', 'max');
    expect(budgeted.body).not.toHaveProperty('enable_thinking');
    expect(budgeted.body.thinking_budget).toBe(16_384);
  });

  it('enables DeepSeek V3 mixed thinking with a bounded numeric budget preset', async () => {
    const { body } = await sendAndReadBody('deepseek-v3.2', 'high');

    expect(body.enable_thinking).toBe(true);
    expect(body.thinking_budget).toBe(8192);
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it.each([
    ['glm-5', 'xhigh'],
    ['glm-5.1', 'xhigh'],
    ['glm-5.2', 'max'],
  ] as const)('maps the UI max level for %s to %s', async (modelId, nativeEffort) => {
    const { body } = await sendAndReadBody(modelId, 'max');

    expect(body.enable_thinking).toBe(true);
    expect(body.reasoning_effort).toBe(nativeEffort);
  });

  it.each(['low', 'medium', 'high'] as const)(
    'preserves the native GLM %s reasoning effort',
    async (effort) => {
      const { body } = await sendAndReadBody('glm-5.1', effort);
      expect(body.reasoning_effort).toBe(effort);
    }
  );
});

describe('Bailian official visual model rules', () => {
  it.each([
    'qwen3.7-plus',
    'qwen3.7-plus-2026-05-26',
    'qwen3.7-max-2026-06-08',
    'qwen3.6-plus',
    'qwen3.6-flash',
    'qwen3.6-35b-a3b',
    'qwen3.5-plus',
    'qwen3.5-flash',
    'qwen3.5-omni-plus',
    'qwen3.5-27b',
  ])('marks %s for image and video input', (modelId) => {
    const requestModel = model(modelId);
    expect(isVisionModel(requestModel)).toBe(true);
    expect(isVideoInputModel(requestModel)).toBe(true);
  });

  it.each(['qwen3.6-max-preview', 'qwen3.7-max', 'qwen3.7-max-2026-05-20'])(
    'does not infer visual input for text-only %s',
    (modelId) => {
      const requestModel = model(modelId);
      expect(isVisionModel(requestModel)).toBe(false);
      expect(isVideoInputModel(requestModel)).toBe(false);
    }
  );
});

describe('Bailian OpenAI-compatible video and streaming payloads', () => {
  it('serializes a public video attachment as video_url', async () => {
    const attachment: MediaAttachment = {
      id: 'video-url',
      kind: 'video',
      uri: 'https://media.example.test/demo.mp4',
      name: 'demo.mp4',
      mimeType: 'video/mp4',
    };

    const { requestUrl, body } = await sendAndReadBody('qwen3.7-plus', 'default', [attachment]);

    expect(requestUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
    expect(body.messages[0].content[1]).toEqual({
      type: 'video_url',
      video_url: { url: attachment.uri },
    });
  });

  it('serializes a local video payload as a Base64 Data URL', async () => {
    const attachment: MediaAttachment = {
      id: 'video-base64',
      kind: 'video',
      uri: 'file:///local/demo.mp4',
      name: 'demo.mp4',
      mimeType: 'video/mp4',
      base64: 'AAAA',
    };

    const { body } = await sendAndReadBody('qwen3.5-plus', 'default', [attachment]);

    expect(body.messages[0].content[1]).toEqual({
      type: 'video_url',
      video_url: { url: 'data:video/mp4;base64,AAAA' },
    });
  });

  it('rejects a video Data URL over 10 MB before issuing a request', async () => {
    const attachment: MediaAttachment = {
      id: 'video-oversized-base64',
      kind: 'video',
      uri: 'file:///local/oversized.mp4',
      name: 'oversized.mp4',
      mimeType: 'video/mp4',
      base64: 'A'.repeat(10 * 1024 * 1024),
    };
    const fetchMock = vi.fn(async () => jsonCompletion());
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      sendOpenAiCompatibleChat({
        provider,
        modelId: 'qwen3.5-plus',
        model: model('qwen3.5-plus'),
        messages: [userMessage([attachment])],
        reasoningEffort: 'default',
      })
    ).rejects.toThrow(/Base64 Data URL.*10 MB/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an oversized local video before reading it into Base64 memory', async () => {
    const attachment: MediaAttachment = {
      id: 'video-oversized-local',
      kind: 'video',
      uri: 'file:///local/oversized.mp4',
      name: 'oversized.mp4',
      mimeType: 'video/mp4',
    };
    const fetchMock = vi.fn(async () => jsonCompletion());
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      sendOpenAiCompatibleChat({
        provider,
        modelId: 'qwen3.5-plus',
        model: model('qwen3.5-plus'),
        messages: [userMessage([attachment])],
        reasoningEffort: 'default',
      })
    ).rejects.toThrow(/Base64 Data URL/);
    expect(fileSystemState.base64Calls).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps large public video URLs eligible for provider-side download', async () => {
    const attachment: MediaAttachment = {
      id: 'video-large-url',
      kind: 'video',
      uri: 'https://media.example.test/large.mp4',
      name: 'large.mp4',
      mimeType: 'video/mp4',
      size: 100 * 1024 * 1024,
    };

    const { body } = await sendAndReadBody('qwen3.7-plus', 'default', [attachment]);
    expect(body.messages[0].content[1]).toEqual({
      type: 'video_url',
      video_url: { url: attachment.uri },
    });
  });

  it('parses reasoning chunks and the final usage-only chunk', async () => {
    const stream = [
      'data: {"choices":[{"delta":{"reasoning_content":"先思考"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"答案"}}]}',
      '',
      'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":6,"total_tokens":10}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      )
    );

    const result = await sendOpenAiCompatibleChat({
      provider,
      modelId: 'qwen3.7-plus',
      model: model('qwen3.7-plus'),
      messages: [userMessage()],
      reasoningEffort: 'default',
    });

    expect(result.content).toBe('答案');
    expect(result.reasoningContent).toBe('先思考');
    expect(result.usage).toEqual({
      inputTokens: 4,
      outputTokens: 6,
      reasoningTokens: undefined,
      cachedInputTokens: undefined,
      totalTokens: 10,
    });
  });
});

describe('Bailian model discovery fallback', () => {
  it.each([
    new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } }),
    new Response('<html>not an API</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
  ])('directs users to manual model entry when /models is unavailable', async (response) => {
    vi.stubGlobal('fetch', vi.fn(async () => response.clone()));

    await expect(fetchOpenAiCompatibleModels(provider)).rejects.toThrow(/手动添加模型/);
  });
});
