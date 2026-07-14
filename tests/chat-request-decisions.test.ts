import { describe, expect, it } from 'vitest';

import { ChatRequestDecisionQueue } from '../src/features/chat/internal/decisions/useChatRequestDecisions';

const request = {
  id: 'approval-1',
  serverLabel: 'local-tools',
  toolName: 'read_file',
  arguments: { path: 'notes.md' },
  rawArguments: '{"path":"notes.md"}',
  argumentBytes: 19,
};

const presentation = {
  providerName: 'OpenAI',
  modelId: 'gpt-test',
  serverName: 'Local tools',
  endpoint: 'https://example.test/mcp',
};

describe('ChatRequestDecisionQueue', () => {
  it('allows only one pending cost decision and settles it exactly once', async () => {
    const queue = new ChatRequestDecisionQueue();
    const first = queue.requestCostConfirmation('可能产生额外费用');
    const second = queue.requestCostConfirmation('不能覆盖首个决策');

    expect(queue.getSnapshot().costConfirmationReason).toBe('可能产生额外费用');
    await expect(second).resolves.toBe(false);

    queue.resolveCostConfirmation(true);
    queue.resolveCostConfirmation(false);
    await expect(first).resolves.toBe(true);
    expect(queue.getSnapshot().costConfirmationReason).toBeNull();
  });

  it('rejects stale MCP nonces and accepts only the current token', async () => {
    const queue = new ChatRequestDecisionQueue();
    const decision = queue.requestMcpApproval(request, presentation);
    const view = queue.getSnapshot().mcpApprovalView;
    expect(view).not.toBeNull();

    queue.resolveMcpApproval(
      { approvalRequestId: request.id, nonce: (view?.approvalNonce ?? 0) + 1 },
      'approve'
    );
    expect(queue.getSnapshot().mcpApprovalView).not.toBeNull();

    queue.resolveMcpApproval(
      { approvalRequestId: request.id, nonce: view?.approvalNonce ?? 0 },
      'approve'
    );
    await expect(decision).resolves.toBe('approve');
    expect(queue.getSnapshot().mcpApprovalView).toBeNull();
  });

  it('cancels MCP decisions on abort and all decisions on disposal', async () => {
    const queue = new ChatRequestDecisionQueue();
    const controller = new AbortController();
    const mcp = queue.requestMcpApproval(request, presentation, controller.signal);
    controller.abort();
    await expect(mcp).resolves.toBe('cancel');

    const cost = queue.requestCostConfirmation('confirm');
    const nextMcp = queue.requestMcpApproval({ ...request, id: 'approval-2' }, presentation);
    queue.dispose();

    await expect(cost).resolves.toBe(false);
    await expect(nextMcp).resolves.toBe('cancel');
    await expect(queue.requestCostConfirmation('after dispose')).resolves.toBe(false);
    await expect(
      queue.requestMcpApproval({ ...request, id: 'approval-3' }, presentation)
    ).resolves.toBe('cancel');
  });

  it('can reactivate after the Strict Mode effect cleanup probe', async () => {
    const queue = new ChatRequestDecisionQueue();
    queue.dispose();
    queue.activate();

    const decision = queue.requestCostConfirmation('strict-mode probe');
    queue.resolveCostConfirmation(true);
    await expect(decision).resolves.toBe(true);
  });
});
