import { describe, expect, it } from 'vitest';

import type { ProviderProfile } from '../src/domain/types';
import {
  isWorkspaceReadOnly,
  resolveMessageProvider,
} from '../src/services/workspaceRuntime';

function provider(id: string): ProviderProfile {
  return {
    id,
    name: id,
    kind: 'openai-compatible',
    baseUrl: `https://${id}.example.com/v1`,
    capabilities: ['text'],
    models: [],
  };
}

describe('workspace runtime safety', () => {
  it('enters read-only mode only after persistence failed to become ready', () => {
    expect(isWorkspaceReadOnly(true, false)).toBe(false);
    expect(isWorkspaceReadOnly(false, true)).toBe(false);
    expect(isWorkspaceReadOnly(false, false)).toBe(true);
  });

  it('resolves an explicitly recorded provider from the workspace', () => {
    const recordedProvider = provider('recorded');
    const activeProvider = provider('active');

    expect(
      resolveMessageProvider(recordedProvider.id, [recordedProvider, activeProvider], activeProvider)
    ).toBe(recordedProvider);
  });

  it('does not fall back when an explicitly recorded provider was deleted', () => {
    const activeProvider = provider('active');

    expect(resolveMessageProvider('deleted', [activeProvider], activeProvider)).toBeNull();
  });

  it('keeps the active-provider fallback for legacy messages without providerId', () => {
    const activeProvider = provider('active');

    expect(resolveMessageProvider(undefined, [activeProvider], activeProvider)).toBe(activeProvider);
  });
});
