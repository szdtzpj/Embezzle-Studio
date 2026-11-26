import { describe, expect, it } from 'vitest';

import {
  createDefaultWorkspace,
  defaultProviders,
  isUserCreatedProvider,
} from '../src/data/providerCatalog';
import type { ProviderKind } from '../src/domain/types';

describe('provider catalog ownership', () => {
  it('keeps volcengine-ark first and protects all 9 built-in providers by stable ID', () => {
    expect(defaultProviders[0]?.id).toBe('volcengine-ark');
    expect(defaultProviders.map((provider) => provider.id)).toEqual([
      'volcengine-ark',
      'bailian-compatible',
      'openai',
      'anthropic',
      'gemini',
      'xai-grok',
      'deepseek',
      'new-api-relay',
      'custom-openai',
    ]);
    for (const provider of defaultProviders) {
      expect(isUserCreatedProvider(provider)).toBe(false);
    }
  });

  it('includes ready-to-configure 2026 official provider presets with curated preset models', () => {
    expect(defaultProviders).toContainEqual(
      expect.objectContaining({
        id: 'openai',
        name: 'OpenAI',
        kind: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        models: expect.arrayContaining([
          expect.objectContaining({ id: 'gpt-6.2-astra', source: 'preset' }),
          expect.objectContaining({ id: 'gpt-image-2.5-sunburst', task: 'image-generation', source: 'preset' }),
        ]),
      })
    );
    expect(defaultProviders).toContainEqual(
      expect.objectContaining({
        id: 'anthropic',
        name: 'Anthropic Claude',
        kind: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        authHeaderMode: 'x-api-key',
        imageApiMode: 'unsupported',
        models: expect.arrayContaining([
          expect.objectContaining({ id: 'claude-sonnet-5-5', source: 'preset' }),
          expect.objectContaining({ id: 'claude-fable-5-2', source: 'preset' }),
        ]),
      })
    );
    expect(defaultProviders).toContainEqual(
      expect.objectContaining({
        id: 'gemini',
        name: 'Google Gemini',
        kind: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        authHeaderMode: 'x-goog-api-key',
        imageApiMode: 'gemini-generate-content',
        models: expect.arrayContaining([
          expect.objectContaining({ id: 'gemini-3.8-flash', source: 'preset' }),
          expect.objectContaining({ id: 'gemini-3.1-flash-image', task: 'image-generation', source: 'preset' }),
        ]),
      })
    );
    expect(defaultProviders).toContainEqual(
      expect.objectContaining({
        id: 'xai-grok',
        name: 'xAI Grok',
        kind: 'xai-grok',
        baseUrl: 'https://api.x.ai/v1',
        imageApiMode: 'xai-json',
        models: expect.arrayContaining([
          expect.objectContaining({ id: 'grok-4.7', source: 'preset' }),
          expect.objectContaining({ id: 'grok-imagine-image-2.0', task: 'image-generation', source: 'preset' }),
        ]),
      })
    );
    expect(defaultProviders).toContainEqual(
      expect.objectContaining({
        id: 'deepseek',
        name: 'DeepSeek',
        kind: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        capabilities: expect.arrayContaining(['text', 'tool-calling', 'reasoning', 'web-search', 'streaming']),
        models: expect.arrayContaining([
          expect.objectContaining({ id: 'deepseek-flash', source: 'preset' }),
          expect.objectContaining({ id: 'deepseek-v4-pro', source: 'preset' }),
        ]),
      })
    );
    expect(isUserCreatedProvider({ id: 'deepseek' })).toBe(false);
    expect(isUserCreatedProvider({ id: 'anthropic' })).toBe(false);
    expect(isUserCreatedProvider({ id: 'gemini' })).toBe(false);
    expect(isUserCreatedProvider({ id: 'xai-grok' })).toBe(false);
    expect(isUserCreatedProvider({ id: 'openai' })).toBe(false);
  });

  it('deep-copies provider arrays and preset models in createDefaultWorkspace', () => {
    const workspaceA = createDefaultWorkspace();
    const workspaceB = createDefaultWorkspace();
    const openAiA = workspaceA.providers.find((provider) => provider.id === 'openai');
    const openAiB = workspaceB.providers.find((provider) => provider.id === 'openai');
    expect(openAiA).toBeDefined();
    expect(openAiB).toBeDefined();
    openAiA!.models[0].capabilities.push('mcp');
    expect(openAiB!.models[0].capabilities).toEqual(
      defaultProviders.find((provider) => provider.id === 'openai')!.models[0].capabilities
    );
  });

  it.each<ProviderKind>([
    'custom',
    'openai-compatible',
    'anthropic',
    'gemini',
    'xai-grok',
    'deepseek',
    'volcengine-ark',
    'bailian-compatible',
    'new-api-relay',
  ])('keeps a user-created provider deletable after its kind changes to %s', (kind) => {
    const userCreatedProvider = { id: 'provider-user-created', kind };
    expect(isUserCreatedProvider(userCreatedProvider)).toBe(true);
  });

  it('does not let a mutable kind turn a built-in ID into a user-created provider', () => {
    const builtInProviderWithChangedKind = {
      id: defaultProviders[0].id,
      kind: 'custom' as const,
    };
    expect(isUserCreatedProvider(builtInProviderWithChangedKind)).toBe(false);
  });
});
