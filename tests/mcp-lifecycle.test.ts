import { describe, expect, it } from 'vitest';

import { createDefaultWorkspace } from '../src/data/providerCatalog';
import type { ChatMessage, McpActivitySummary, PluginManifest } from '../src/domain/types';
import {
  assertMcpProviderSendAllowed,
  hasMcpAuditEvidence,
  isSameMcpApprovalToken,
  restoreMessagesWithMcpAuditStub,
} from '../src/services/mcpLifecycle';
import { removeProviderFromWorkspace } from '../src/services/providerLifecycle';

const attemptedAssistant: ChatMessage = {
  id: 'attempted-assistant',
  role: 'assistant',
  content: '',
  createdAt: 20,
  status: 'pending',
  providerId: 'provider-a',
  providerName: 'Provider A',
  modelId: 'model-a',
};

function activity(overrides: Partial<McpActivitySummary> = {}): McpActivitySummary {
  return {
    serverLabel: 'trusted_mcp',
    providerRequestCount: 1,
    approvals: [],
    calls: [],
    ...overrides,
  };
}

describe('MCP request lifecycle guards', () => {
  it('binds a settlement to both approval request ID and local nonce', () => {
    const current = { approvalRequestId: 'approval-1', nonce: 7 };
    expect(isSameMcpApprovalToken(current, { ...current })).toBe(true);
    expect(isSameMcpApprovalToken(current, { approvalRequestId: 'approval-1', nonce: 8 })).toBe(false);
    expect(isSameMcpApprovalToken(current, { approvalRequestId: 'approval-2', nonce: 7 })).toBe(false);
    expect(isSameMcpApprovalToken(current, null)).toBe(false);
  });

  it('allows a provider send only for the current foreground MCP scope', () => {
    expect(() => assertMcpProviderSendAllowed({
      requestIsCurrent: true,
      mcpActive: true,
      signalAborted: false,
      appState: 'active',
    })).not.toThrow();

    for (const blocked of [
      { requestIsCurrent: false, mcpActive: true, signalAborted: false, appState: 'active' },
      { requestIsCurrent: true, mcpActive: false, signalAborted: false, appState: 'active' },
      { requestIsCurrent: true, mcpActive: true, signalAborted: true, appState: 'active' },
      { requestIsCurrent: true, mcpActive: true, signalAborted: false, appState: 'background' },
    ]) {
      expect(() => assertMcpProviderSendAllowed(blocked)).toThrowError(
        expect.objectContaining({ name: 'AbortError' })
      );
    }
  });

  it('keeps an audit stub when the initial provider send started before any approval', () => {
    const emptyActivity = activity();
    expect(hasMcpAuditEvidence(emptyActivity, false)).toBe(false);
    expect(hasMcpAuditEvidence(emptyActivity, true)).toBe(true);

    const restored = restoreMessagesWithMcpAuditStub({
      originalMessages: [{
        id: 'original',
        role: 'user',
        content: 'hello',
        createdAt: 1,
        status: 'ready',
      }],
      attemptedAssistant,
      audit: {
        status: 'cancelled',
        activity: emptyActivity,
        providerSendStarted: true,
      },
      stubId: 'audit-stub',
      createdAt: 30,
    });

    expect(restored).toHaveLength(2);
    expect(restored[1]).toMatchObject({
      id: 'audit-stub',
      role: 'assistant',
      status: 'cancelled',
      providerId: 'provider-a',
      modelId: 'model-a',
      excludedFromContext: true,
      mcpActivity: emptyActivity,
    });
    expect(restored[1]).not.toHaveProperty('attachments');
  });

  it('does not create a misleading stub when cancellation happened before provider send', () => {
    const originals: ChatMessage[] = [{
      id: 'original',
      role: 'user',
      content: 'hello',
      createdAt: 1,
      status: 'ready',
    }];
    const restored = restoreMessagesWithMcpAuditStub({
      originalMessages: originals,
      attemptedAssistant,
      audit: {
        status: 'cancelled',
        activity: activity(),
        providerSendStarted: false,
      },
      stubId: 'unused',
      createdAt: 30,
    });
    expect(restored).toEqual(originals);
  });

  it('preserves an unknown post-approval outcome with an irreversible-side-effect warning', () => {
    const restored = restoreMessagesWithMcpAuditStub({
      originalMessages: [],
      attemptedAssistant,
      audit: {
        status: 'error',
        error: 'continuation failed',
        providerSendStarted: true,
        activity: activity({
          providerRequestCount: 2,
          approvals: [{ toolName: 'write_record', decision: 'approve' }],
          calls: [{ toolName: 'write_record', outcome: 'unknown' }],
        }),
      },
      stubId: 'unknown-audit',
      createdAt: 31,
    });
    expect(restored[0].content).toContain('副作用可能已经发生');
    expect(restored[0].mcpActivity?.calls).toEqual([
      { toolName: 'write_record', outcome: 'unknown' },
    ]);
  });
});

describe('provider removal lifecycle', () => {
  it('removes provider-bound MCP plugins in the same immutable transition', () => {
    const workspace = createDefaultWorkspace();
    const removedProviderId = workspace.providers[0].id;
    const keptProviderId = workspace.providers[1].id;
    const plugin = (id: string, providerId: string): PluginManifest => ({
      id,
      name: id,
      version: '1.0.0',
      type: 'remote-mcp',
      permissions: ['network', 'tools'],
      allowedTools: ['search'],
      transport: 'streamable-http',
      endpoint: `https://${id}.example.com/mcp`,
      serverLabel: id.replace(/-/g, '_'),
      providerId,
      approvalPolicy: 'always',
      authorization: `Bearer ${id}`,
      enabled: false,
    });
    workspace.plugins = [
      plugin('remove-me', removedProviderId),
      plugin('keep-me', keptProviderId),
    ];

    const result = removeProviderFromWorkspace(workspace, removedProviderId, 123);
    expect(result?.removedPluginIds).toEqual(['remove-me']);
    expect(result?.workspace.providers.some((provider) => provider.id === removedProviderId)).toBe(false);
    expect(result?.workspace.plugins.map((item) => item.id)).toEqual(['keep-me']);
    const providerIds = new Set(result?.workspace.providers.map((provider) => provider.id));
    expect(result?.workspace.plugins.every((item) => providerIds.has(item.providerId ?? ''))).toBe(true);
    expect(workspace.plugins).toHaveLength(2);
  });
});
