import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage, ProviderProfile } from '../src/domain/types';
import { createModelInfoFromId } from '../src/services/modelCapabilities';
import { sendOpenAiCompatibleChat } from '../src/services/openAiCompatible';

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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
    });
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
    });

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions');
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
