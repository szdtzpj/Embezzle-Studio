import { describe, expect, it } from 'vitest';

import { defaultProviders, isUserCreatedProvider } from '../src/data/providerCatalog';
import type { ProviderKind } from '../src/domain/types';

describe('provider catalog ownership', () => {
  it('keeps every built-in provider protected by stable ID', () => {
    for (const provider of defaultProviders) {
      expect(isUserCreatedProvider(provider)).toBe(false);
    }
  });

  it('includes a ready-to-configure DeepSeek compatible provider', () => {
    expect(defaultProviders).toContainEqual(
      expect.objectContaining({
        id: 'deepseek',
        name: 'DeepSeek',
        kind: 'custom',
        baseUrl: 'https://api.deepseek.com/v1',
        capabilities: expect.arrayContaining(['text', 'tool-calling', 'reasoning', 'streaming']),
      })
    );
    expect(isUserCreatedProvider({ id: 'deepseek' })).toBe(false);
  });

  it.each<ProviderKind>([
    'custom',
    'openai-compatible',
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
