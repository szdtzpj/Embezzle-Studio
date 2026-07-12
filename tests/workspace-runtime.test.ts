import { describe, expect, it } from 'vitest';

import type { ProviderProfile } from '../src/domain/types';
import {
  isProviderEnabled,
  isWorkspaceReadOnly,
  resolveEnabledProvider,
  resolveMessageProvider,
} from '../src/services/workspaceRuntime';

function provider(id: string, enabled?: boolean): ProviderProfile {
  return {
    id,
    name: id,
    kind: 'openai-compatible',
    baseUrl: `https://${id}.example.com/v1`,
    capabilities: ['text'],
    models: [],
    ...(enabled === undefined ? {} : { enabled }),
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

  it('treats legacy providers as enabled but rejects an explicit disabled state', () => {
    expect(isProviderEnabled(provider('legacy'))).toBe(true);
    expect(isProviderEnabled(provider('enabled', true))).toBe(true);
    expect(isProviderEnabled(provider('disabled', false))).toBe(false);
    expect(isProviderEnabled(null)).toBe(false);
  });

  it('falls back from a disabled requested provider to the first enabled provider', () => {
    const disabled = provider('disabled', false);
    const fallback = provider('fallback', true);
    const later = provider('later');

    expect(resolveEnabledProvider([disabled, fallback, later], disabled.id)).toBe(fallback);
    expect(resolveEnabledProvider([disabled, fallback, later], later.id)).toBe(later);
  });

  it('returns null instead of routing when every provider is disabled', () => {
    const first = provider('first', false);
    const second = provider('second', false);

    expect(resolveEnabledProvider([first, second], first.id)).toBeNull();
    expect(resolveEnabledProvider([], undefined)).toBeNull();
  });

  it('does not fall back when an explicitly recorded provider was deleted', () => {
    const activeProvider = provider('active');

    expect(resolveMessageProvider('deleted', [activeProvider], activeProvider)).toBeNull();
  });

  it('does not fall back when an explicitly recorded provider is disabled', () => {
    const recordedProvider = provider('recorded', false);
    const activeProvider = provider('active');

    expect(
      resolveMessageProvider(recordedProvider.id, [recordedProvider, activeProvider], activeProvider)
    ).toBeNull();
  });

  it('keeps the active-provider fallback for legacy messages without providerId', () => {
    const activeProvider = provider('active');

    expect(resolveMessageProvider(undefined, [activeProvider], activeProvider)).toBe(activeProvider);
  });

  it('rejects the active-provider fallback for legacy messages when it is disabled', () => {
    const activeProvider = provider('active', false);
    const enabledProvider = provider('other', true);

    expect(
      resolveMessageProvider(undefined, [activeProvider, enabledProvider], activeProvider)
    ).toBeNull();
  });
});
