import { describe, expect, it } from 'vitest';

import type { ProviderProfile } from '../src/domain/types';
import {
  createModelInfoFromId,
  enrichDiscoveredModel,
  inferModelTask,
  normalizeRemoteModelEntry,
} from '../src/services/modelCapabilities';

function provider(
  kind: ProviderProfile['kind'],
  baseUrl: string
): ProviderProfile {
  return {
    id: `provider-${kind}`,
    name: kind,
    kind,
    baseUrl,
    capabilities: ['text', 'streaming'],
    models: [],
  };
}

const openAi = provider('openai-compatible', 'https://api.openai.com/v1');
const anthropic = provider('anthropic', 'https://api.anthropic.com/v1');
const gemini = provider('gemini', 'https://generativelanguage.googleapis.com/v1beta');
const xai = provider('xai-grok', 'https://api.x.ai/v1');
const deepseek = provider('deepseek', 'https://api.deepseek.com/v1');
const relay = provider('new-api-relay', 'https://relay.example.com/v1');

describe('2026 model capabilities matrix', () => {
  it('recognizes OpenAI 2026 chat, reasoning, and image generation models without misclassifying gpt-4.1', () => {
    const gpt6 = createModelInfoFromId(openAi, 'gpt-6.2-astra', 'preset');
    expect(gpt6.task).toBe('chat');
    expect(gpt6.capabilities).toEqual(
      expect.arrayContaining(['text', 'image-input', 'reasoning', 'web-search', 'tool-calling'])
    );

    const gpt41 = createModelInfoFromId(openAi, 'gpt-4.1', 'remote');
    expect(gpt41.capabilities).toContain('image-input');
    expect(gpt41.capabilities).not.toContain('reasoning');
    expect(gpt41.capabilities).toContain('web-search');

    const qwen25Vl = createModelInfoFromId(relay, 'qwen2.5-vl-72b-instruct', 'remote');
    expect(qwen25Vl.capabilities).toContain('image-input');

    const gptImage = createModelInfoFromId(openAi, 'gpt-image-2.5-sunburst', 'preset');
    expect(gptImage.task).toBe('image-generation');
    expect(gptImage.capabilities).toContain('image-generation');
    expect(gptImage.capabilities).not.toContain('reasoning');
    expect(gptImage.capabilities).not.toContain('web-search');
  });

  it('recognizes Anthropic Claude 5.x and 4.x models', () => {
    const sonnet55 = createModelInfoFromId(anthropic, 'claude-sonnet-5-5', 'preset');
    expect(sonnet55.task).toBe('chat');
    expect(sonnet55.capabilities).toEqual(
      expect.arrayContaining(['text', 'image-input', 'reasoning', 'web-search', 'tool-calling'])
    );

    const fable52 = createModelInfoFromId(anthropic, 'claude-fable-5-2', 'preset');
    expect(fable52.capabilities).toEqual(
      expect.arrayContaining(['reasoning', 'web-search', 'image-input'])
    );
  });

  it('recognizes Gemini 2.5/3.x/4 chat models and keeps Gemini image models out of reasoning/video-input/web-search', () => {
    const gemini38 = createModelInfoFromId(gemini, 'gemini-3.8-flash', 'preset');
    expect(gemini38.task).toBe('chat');
    expect(gemini38.capabilities).toEqual(
      expect.arrayContaining(['text', 'image-input', 'video-input', 'reasoning', 'web-search'])
    );

    const geminiImage = createModelInfoFromId(gemini, 'gemini-3.1-flash-image', 'preset');
    expect(geminiImage.task).toBe('image-generation');
    expect(geminiImage.capabilities).toContain('image-generation');
    expect(geminiImage.capabilities).not.toContain('reasoning');
    expect(geminiImage.capabilities).not.toContain('video-input');
    expect(geminiImage.capabilities).not.toContain('web-search');

    const nanoBanana = createModelInfoFromId(gemini, 'nano-banana-pro', 'remote');
    expect(inferModelTask(nanoBanana)).toBe('image-generation');
    expect(nanoBanana.capabilities).not.toContain('reasoning');

    expect(inferModelTask('gemini-3.1-flash-lite-image')).toBe('image-generation');
    expect(inferModelTask({ id: 'gemini-3.1-flash-lite-image', capabilities: [] })).toBe(
      'image-generation'
    );
    expect(inferModelTask('gemini-3.0-image')).toBe('image-generation');
    expect(inferModelTask({ id: 'gemini-3.0-image', capabilities: [] })).toBe('image-generation');
    expect(inferModelTask({ id: 'gemini-3.0-flash', name: 'My Image', capabilities: [] })).toBe(
      'chat'
    );
  });

  it('recognizes xAI Grok 4.7/3-mini chat models and Grok Imagine image/video models', () => {
    const grok47 = createModelInfoFromId(xai, 'grok-4.7', 'preset');
    expect(grok47.task).toBe('chat');
    expect(grok47.capabilities).toEqual(
      expect.arrayContaining(['text', 'image-input', 'reasoning', 'web-search'])
    );

    const grok3Mini = createModelInfoFromId(xai, 'grok-3-mini', 'preset');
    expect(grok3Mini.capabilities).toContain('reasoning');

    const grokImage = createModelInfoFromId(xai, 'grok-imagine-image-2.0', 'preset');
    expect(grokImage.task).toBe('image-generation');
    expect(grokImage.capabilities).toContain('image-generation');
    expect(grokImage.capabilities).not.toContain('reasoning');
    expect(grokImage.capabilities).not.toContain('web-search');

    const grokVideo = createModelInfoFromId(xai, 'grok-imagine-video', 'remote');
    expect(grokVideo.task).toBe('video-generation');
    expect(grokVideo.capabilities).toContain('video-generation');
    expect(grokVideo.capabilities).not.toContain('reasoning');
  });

  it('recognizes DeepSeek Flash and V4 Pro and restricts official web-search annotation away from relays', () => {
    const flash = createModelInfoFromId(deepseek, 'deepseek-flash', 'preset');
    expect(flash.capabilities).toEqual(
      expect.arrayContaining(['text', 'image-input', 'reasoning', 'web-search', 'tool-calling'])
    );

    const v4Pro = createModelInfoFromId(deepseek, 'deepseek-v4-pro', 'preset');
    expect(v4Pro.capabilities).toEqual(
      expect.arrayContaining(['text', 'reasoning', 'web-search', 'tool-calling'])
    );

    const relayDeepSeek = createModelInfoFromId(relay, 'deepseek-v4-pro', 'remote');
    expect(relayDeepSeek.capabilities).toContain('reasoning');
    expect(relayDeepSeek.capabilities).not.toContain('web-search');

    const spoofedRelayDeepSeek = createModelInfoFromId(
      provider('new-api-relay', 'https://api.deepseek.com/v1'),
      'deepseek-flash',
      'remote'
    );
    expect(spoofedRelayDeepSeek.capabilities).not.toContain('web-search');

    const mismatchedOpenAiKindDeepSeek = createModelInfoFromId(
      provider('openai-compatible', 'https://api.deepseek.com/v1'),
      'deepseek-flash',
      'remote'
    );
    expect(mismatchedOpenAiKindDeepSeek.capabilities).not.toContain('web-search');

    const legacyCustomOfficialDeepSeek = createModelInfoFromId(
      provider('custom', 'https://api.deepseek.com/v1'),
      'deepseek-flash',
      'remote'
    );
    expect(legacyCustomOfficialDeepSeek.capabilities).toContain('web-search');

    const relayWithDeepSeekKind = createModelInfoFromId(
      provider('deepseek', 'https://relay.example.com/v1'),
      'deepseek-v4-pro',
      'remote'
    );
    expect(relayWithDeepSeekKind.capabilities).toContain('reasoning');
    expect(relayWithDeepSeekKind.capabilities).not.toContain('web-search');

    const geminiImageInput = createModelInfoFromId(
      gemini,
      'gemini-2.5-pro-image-input',
      'remote'
    );
    expect(geminiImageInput.task).toBe('chat');
    expect(geminiImageInput.capabilities).toContain('image-input');
    expect(geminiImageInput.capabilities).not.toContain('image-generation');
    expect(inferModelTask('gemini-2.5-pro-image-input')).toBe('chat');
  });
});

describe('multi-vendor remote model metadata normalization', () => {
  it('parses xAI/OpenAI context_length and capabilities.reasoning_effort', () => {
    const discovered = enrichDiscoveredModel(xai, {
      id: 'grok-4.7',
      context_length: 256000,
      capabilities: {
        reasoning_effort: ['low', 'medium', 'high', 'xhigh'],
        web_search: true,
      },
    });

    expect(discovered).toMatchObject({
      id: 'grok-4.7',
      contextWindow: 256000,
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    });
    expect(discovered?.capabilities).toEqual(expect.arrayContaining(['reasoning', 'web-search']));

    const nonReasoningWithEmptyEffort = enrichDiscoveredModel(xai, {
      id: 'custom-non-reasoning-model',
      capabilities: {
        reasoning_effort: [],
      },
    });
    expect(nonReasoningWithEmptyEffort?.capabilities).not.toContain('reasoning');

    const neutralModelWithEmptyEffort = enrichDiscoveredModel(xai, {
      id: 'grok-beta-chat',
      capabilities: {
        reasoning_effort: [],
      },
    });
    expect(neutralModelWithEmptyEffort?.capabilities).not.toContain('reasoning');
  });

  it('parses Anthropic display_name and context_length', () => {
    const entry = normalizeRemoteModelEntry({
      id: 'claude-opus-5-5',
      display_name: 'Claude Opus 5.5',
      type: 'model',
      max_context_length: 200000,
    });
    expect(entry).toMatchObject({
      id: 'claude-opus-5-5',
      name: 'Claude Opus 5.5',
      token_limits: { context_window: 200000 },
    });

    const model = enrichDiscoveredModel(anthropic, entry!);
    expect(model).toMatchObject({
      id: 'claude-opus-5-5',
      name: 'Claude Opus 5.5',
      contextWindow: 200000,
    });
  });

  it('strips models/ prefix and extracts inputTokenLimit and supportedGenerationMethods for Gemini', () => {
    const discovered = enrichDiscoveredModel(gemini, {
      name: 'models/gemini-3.1-pro',
      displayName: 'Gemini 3.1 Pro',
      inputTokenLimit: 2097152,
      supportedGenerationMethods: ['generateContent', 'countTokens'],
    } as never);

    expect(discovered).toMatchObject({
      id: 'gemini-3.1-pro',
      name: 'Gemini 3.1 Pro',
      contextWindow: 2097152,
      task: 'chat',
    });
    expect(discovered?.capabilities).toEqual(
      expect.arrayContaining(['text', 'streaming', 'reasoning', 'web-search'])
    );
  });
});
