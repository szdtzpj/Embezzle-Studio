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
  it('queues concurrent cost decisions in FIFO order and promotes synchronously', async () => {
    const queue = new ChatRequestDecisionQueue();
    const first = queue.requestCostConfirmation('第一次确认');
    const second = queue.requestCostConfirmation('第二次确认');

    expect(queue.getSnapshot().costConfirmationReason).toBe('第一次确认');

    let secondResolvedEarly = false;
    void second.then(() => {
      secondResolvedEarly = true;
    });
    await Promise.resolve();
    expect(secondResolvedEarly).toBe(false);

    queue.resolveCostConfirmation(true);
    await expect(first).resolves.toBe(true);
    // 结算第 1 项后，第 2 项须同步推进为当前可见决策
    expect(queue.getSnapshot().costConfirmationReason).toBe('第二次确认');

    queue.resolveCostConfirmation(false);
    await expect(second).resolves.toBe(false);
    expect(queue.getSnapshot().costConfirmationReason).toBeNull();

    // 队列为空时再次结算应为安全 no-op
    queue.resolveCostConfirmation(true);
    expect(queue.getSnapshot().costConfirmationReason).toBeNull();
  });

  it('supports AbortSignal for both active and queued cost decisions', async () => {
    const queue = new ChatRequestDecisionQueue();

    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      queue.requestCostConfirmation('已取消的请求', preAborted.signal)
    ).resolves.toBe(false);
    expect(queue.getSnapshot().costConfirmationReason).toBeNull();

    const firstController = new AbortController();
    const secondController = new AbortController();
    const thirdController = new AbortController();

    const first = queue.requestCostConfirmation('队首费用确认', firstController.signal);
    const second = queue.requestCostConfirmation('队中将被取消', secondController.signal);
    const third = queue.requestCostConfirmation('队尾费用确认', thirdController.signal);

    // 取消队中项不得打断当前队首展示
    secondController.abort();
    await expect(second).resolves.toBe(false);
    expect(queue.getSnapshot().costConfirmationReason).toBe('队首费用确认');

    // 取消队首项须结算为 false 并同步推进下一个有效排队项（队尾）
    firstController.abort();
    await expect(first).resolves.toBe(false);
    expect(queue.getSnapshot().costConfirmationReason).toBe('队尾费用确认');

    queue.resolveCostConfirmation(true);
    await expect(third).resolves.toBe(true);
    expect(queue.getSnapshot().costConfirmationReason).toBeNull();
  });

  it('queues concurrent MCP approvals in FIFO order and rejects stale tokens', async () => {
    const queue = new ChatRequestDecisionQueue();
    const first = queue.requestMcpApproval(request, presentation);
    const second = queue.requestMcpApproval({ ...request, id: 'approval-2' }, presentation);

    const firstView = queue.getSnapshot().mcpApprovalView;
    expect(firstView?.approvalRequestId).toBe('approval-1');

    // 结算第 1 项后自动弹出第 2 项并生成新 nonce
    queue.resolveMcpApproval(
      { approvalRequestId: 'approval-1', nonce: firstView?.approvalNonce ?? 0 },
      'approve'
    );
    await expect(first).resolves.toBe('approve');

    const secondView = queue.getSnapshot().mcpApprovalView;
    expect(secondView?.approvalRequestId).toBe('approval-2');
    expect(secondView?.approvalNonce).not.toBe(firstView?.approvalNonce);

    // 重放第 1 项旧 token 不得影响第 2 项
    queue.resolveMcpApproval(
      { approvalRequestId: 'approval-1', nonce: firstView?.approvalNonce ?? 0 },
      'deny'
    );
    expect(queue.getSnapshot().mcpApprovalView?.approvalRequestId).toBe('approval-2');

    queue.resolveMcpApproval(
      { approvalRequestId: 'approval-2', nonce: secondView?.approvalNonce ?? 0 },
      'deny'
    );
    await expect(second).resolves.toBe('deny');
    expect(queue.getSnapshot().mcpApprovalView).toBeNull();
  });

  it('cancels queued MCP decision without disturbing active one and settles all on cancelAll', async () => {
    const queue = new ChatRequestDecisionQueue();
    const secondController = new AbortController();

    const mcp1 = queue.requestMcpApproval(request, presentation);
    const mcp2 = queue.requestMcpApproval(
      { ...request, id: 'approval-2' },
      presentation,
      secondController.signal
    );
    const mcp3 = queue.requestMcpApproval({ ...request, id: 'approval-3' }, presentation);
    const cost1 = queue.requestCostConfirmation('费用 1');
    const cost2 = queue.requestCostConfirmation('费用 2');

    secondController.abort();
    await expect(mcp2).resolves.toBe('cancel');
    expect(queue.getSnapshot().mcpApprovalView?.approvalRequestId).toBe('approval-1');

    queue.cancelAll();
    await expect(mcp1).resolves.toBe('cancel');
    await expect(mcp3).resolves.toBe('cancel');
    await expect(cost1).resolves.toBe(false);
    await expect(cost2).resolves.toBe(false);
    expect(queue.getSnapshot()).toEqual({
      costConfirmationReason: null,
      mcpApprovalView: null,
    });
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
