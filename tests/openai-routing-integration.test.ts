import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage, ProviderProfile } from '../src/domain/types';
import { createModelInfoFromId } from '../src/services/modelCapabilities';
import {
  isWebDevelopmentProxyAllowed,
  sendOpenAiCompatibleChat,
} from '../src/services/openAiCompatible';

const platform = vi.hoisted(() => ({ OS: 'android' }));

vi.mock('react-native', () => ({ Platform: platform }));

const provider: ProviderProfile = {
  id: 'openai',
  name: 'OpenAI',
  kind: 'custom',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  capabilities: ['text', 'image-input', 'reasoning'],
  models: [],
};

const message: ChatMessage = {
  id: 'u1',
  role: 'user',
  content: 'Solve this.',
  createdAt: 1,
  status: 'ready',
};

afterEach(() => {
  platform.OS = 'android';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Web development proxy boundary', () => {
  it('requires development mode, an explicit launcher flag, and a loopback page', () => {
    expect(isWebDevelopmentProxyAllowed({
      platform: 'web',
      development: true,
      explicitlyEnabled: true,
      location: { protocol: 'http:', hostname: '127.0.0.1' },
    })).toBe(true);
    expect(isWebDevelopmentProxyAllowed({
      platform: 'web',
      development: false,
      explicitlyEnabled: true,
      location: { protocol: 'http:', hostname: '127.0.0.1' },
    })).toBe(false);
    expect(isWebDevelopmentProxyAllowed({
      platform: 'web',
      development: true,
      explicitlyEnabled: false,
      location: { protocol: 'http:', hostname: '127.0.0.1' },
    })).toBe(false);
    expect(isWebDevelopmentProxyAllowed({
      platform: 'web',
      development: true,
      explicitlyEnabled: true,
      location: { protocol: 'https:', hostname: 'szdtzpj.github.io' },
    })).toBe(false);
  });

  it('fails closed before contacting a proxy from a production-style Web runtime', async () => {
    platform.OS = 'web';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendOpenAiCompatibleChat({
      provider,
      modelId: 'gpt-4.1',
      model: createModelInfoFromId(provider, 'gpt-4.1', 'manual'),
      messages: [message],
      reasoningEffort: 'default',
    })).rejects.toThrow(/正式 Web 构建不会发送 API Key/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('official OpenAI endpoint routing', () => {
  it('sends Responses-only Pro models to /responses without streaming or sampling fields', async () => {
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'resp_1',
      status: 'completed',
      output: [{
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Done.' }],
      }],
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendOpenAiCompatibleChat({
      provider,
      modelId: 'gpt-5.2-pro',
      model: createModelInfoFromId(provider, 'gpt-5.2-pro', 'manual'),
      messages: [message],
      reasoningEffort: 'max',
      maxOutputTokens: 4096,
      parameterSettings: {
        enabled: true,
        temperature: 0.2,
        topP: 0.8,
        presencePenalty: 1,
        frequencyPenalty: 1,
      },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(body).toMatchObject({
      model: 'gpt-5.2-pro',
      store: false,
      reasoning: { effort: 'xhigh' },
      max_output_tokens: 4096,
    });
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('stream');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 10 * 60_000);
    expect(result.content).toBe('Done.');
  });

  it('keeps ordinary OpenAI chat models on /chat/completions', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'Chat.' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await sendOpenAiCompatibleChat({
      provider,
      modelId: 'gpt-4.1',
      model: createModelInfoFromId(provider, 'gpt-4.1', 'manual'),
      messages: [message],
      reasoningEffort: 'default',
      maxOutputTokens: 4096,
    });

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.max_completion_tokens).toBe(4096);
    expect(body).not.toHaveProperty('max_output_tokens');
    expect(body).not.toHaveProperty('max_tokens');
  });

  it.each([
    {
      label: 'Volcengine Ark',
      provider: {
        ...provider,
        id: 'ark-chat-limit',
        name: 'Volcengine Ark',
        kind: 'volcengine-ark' as const,
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      },
      modelId: 'doubao-seed-2-0-pro-260215',
      expectedUrl: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    },
    {
      label: 'Alibaba Bailian',
      provider: {
        ...provider,
        id: 'bailian-chat-limit',
        name: 'Alibaba Bailian',
        kind: 'bailian-compatible' as const,
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      },
      modelId: 'qwen-plus',
      expectedUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    },
    {
      label: 'custom OpenAI-compatible relay',
      provider: {
        ...provider,
        id: 'custom-chat-limit',
        name: 'Custom relay',
        kind: 'custom' as const,
        baseUrl: 'https://relay.example.com/v1',
      },
      modelId: 'relay-chat-model',
      expectedUrl: 'https://relay.example.com/v1/chat/completions',
    },
  ])('serializes the output limit only as max_tokens for $label Chat', async ({
    provider: chatProvider,
    modelId,
    expectedUrl,
  }) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'Bounded.' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await sendOpenAiCompatibleChat({
      provider: chatProvider,
      modelId,
      model: createModelInfoFromId(chatProvider, modelId, 'manual'),
      messages: [message],
      reasoningEffort: 'default',
      maxOutputTokens: 4096,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(url).toBe(expectedUrl);
    expect(body.max_tokens).toBe(4096);
    expect(body).not.toHaveProperty('max_output_tokens');
    expect(body).not.toHaveProperty('max_completion_tokens');
  });

  it('sends an inline file only to the official OpenAI host when the model explicitly supports it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'Read.' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const model = createModelInfoFromId(provider, 'gpt-4.1', 'manual');
    model.capabilities = [...model.capabilities, 'file-input'];
    const fileMessage: ChatMessage = {
      ...message,
      attachments: [{
        id: 'file-1',
        kind: 'file',
        uri: 'file:///notes.pdf',
        name: 'notes.pdf',
        mimeType: 'application/pdf',
        base64: 'YWJjZA==',
      }],
    };

    await sendOpenAiCompatibleChat({
      provider,
      modelId: model.id,
      model,
      messages: [fileMessage],
      reasoningEffort: 'default',
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.messages[0].content).toContainEqual({
      type: 'file',
      file: {
        filename: 'notes.pdf',
        file_data: 'data:application/pdf;base64,YWJjZA==',
      },
    });

    const relay = { ...provider, id: 'relay', baseUrl: 'https://relay.example.com/v1' };
    await expect(sendOpenAiCompatibleChat({
      provider: relay,
      modelId: model.id,
      model,
      messages: [fileMessage],
      reasoningEffort: 'default',
    })).rejects.toThrow(/只在 OpenAI 官方 API/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('provider Responses Web Search integration', () => {
  it.each([
    {
      label: 'Volcengine Ark',
      provider: {
        ...provider,
        id: 'ark',
        name: 'Volcengine Ark',
        kind: 'volcengine-ark' as const,
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        capabilities: ['text', 'web-search'] as ProviderProfile['capabilities'],
      },
      modelId: 'doubao-seed-2-0-pro-260215',
      expectedTool: { type: 'web_search', max_keyword: 3, limit: 10 },
    },
    {
      label: 'Alibaba Bailian',
      provider: {
        ...provider,
        id: 'bailian',
        name: 'Alibaba Bailian',
        kind: 'bailian-compatible' as const,
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        capabilities: ['text', 'web-search'] as ProviderProfile['capabilities'],
      },
      modelId: 'qwen-plus',
      expectedTool: { type: 'web_search' },
    },
  ])('does not send OpenAI-only search_context_size to $label', async ({
    provider: searchProvider,
    modelId,
    expectedTool,
  }) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'resp_search',
      status: 'completed',
      output: [{
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Search result.' }],
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const searchModel = createModelInfoFromId(searchProvider, modelId, 'manual');
    searchModel.capabilities = Array.from(new Set([...searchModel.capabilities, 'web-search']));

    const result = await sendOpenAiCompatibleChat({
      provider: searchProvider,
      modelId,
      model: searchModel,
      messages: [message],
      reasoningEffort: 'default',
      maxOutputTokens: 2048,
      webSearch: { enabled: true, searchContextSize: 'high' },
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.tools).toEqual([expectedTool]);
    expect(body.max_output_tokens).toBe(2048);
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body).not.toHaveProperty('max_tokens');
    expect(JSON.stringify(body)).not.toContain('search_context_size');
    expect(result.content).toBe('Search result.');
  });
});
