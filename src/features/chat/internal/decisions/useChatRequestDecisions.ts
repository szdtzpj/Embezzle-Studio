import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

import type { McpApprovalViewModel } from '../../../../components/McpApprovalModal';
import type {
  ProviderMcpApprovalDecision,
  ProviderMcpApprovalRequest,
} from '../../../../services/providerMcp';
import {
  isSameMcpApprovalToken,
  type McpApprovalToken,
} from '../../../../services/mcpLifecycle';

export interface ChatRequestDecisionSnapshot {
  costConfirmationReason: string | null;
  mcpApprovalView: McpApprovalViewModel | null;
}

type McpApprovalPresentation = Omit<
  McpApprovalViewModel,
  | 'approvalRequestId'
  | 'approvalNonce'
  | 'serverLabel'
  | 'toolName'
  | 'argumentsText'
  | 'argumentBytes'
>;

interface PendingCostDecision {
  reason: string;
  settle(confirmed: boolean): void;
}

interface PendingMcpDecision {
  token: McpApprovalToken;
  view: McpApprovalViewModel;
  settle(decision: ProviderMcpApprovalDecision): void;
}

const emptySnapshot: ChatRequestDecisionSnapshot = {
  costConfirmationReason: null,
  mcpApprovalView: null,
};

/**
 * 持有 Chat 请求的两类用户决策槽位，分别以独立 FIFO 队列管理并发费用确认与
 * MCP 工具审批；每类同一时间仅激活队首一项，并在取消或销毁时幂等结算全部排队项。
 */
export class ChatRequestDecisionQueue {
  private snapshot: ChatRequestDecisionSnapshot = emptySnapshot;
  private readonly listeners = new Set<() => void>();
  private pendingCost: PendingCostDecision | null = null;
  private readonly costQueue: PendingCostDecision[] = [];
  private pendingMcp: PendingMcpDecision | null = null;
  private readonly mcpQueue: PendingMcpDecision[] = [];
  private mcpNonce = 0;
  private disposed = false;

  getSnapshot = (): ChatRequestDecisionSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** 发起费用确认决策（支持队列 FIFO 排队与可选 AbortSignal 取消）。 */
  requestCostConfirmation(reason: string, signal?: AbortSignal): Promise<boolean> {
    if (this.disposed || signal?.aborted) {
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      let settled = false;
      const onAbort = () => entry.settle(false);
      const entry: PendingCostDecision = {
        reason,
        settle: (confirmed: boolean) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          if (this.pendingCost === entry) {
            this.pendingCost = null;
            // 队首结算后同步推进下一个排队决策，保证 UI 快照与测试立即可见
            const next = this.costQueue.shift() ?? null;
            if (next) {
              this.pendingCost = next;
              this.publish({ ...this.snapshot, costConfirmationReason: next.reason });
            } else if (this.snapshot.costConfirmationReason !== null) {
              this.publish({ ...this.snapshot, costConfirmationReason: null });
            }
          } else {
            const index = this.costQueue.indexOf(entry);
            if (index >= 0) {
              this.costQueue.splice(index, 1);
            }
          }
          resolve(confirmed);
        },
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      if (!this.pendingCost) {
        this.pendingCost = entry;
        this.publish({ ...this.snapshot, costConfirmationReason: reason });
      } else {
        this.costQueue.push(entry);
      }
    });
  }

  resolveCostConfirmation(confirmed: boolean): void {
    if (this.pendingCost) {
      this.pendingCost.settle(confirmed);
      return;
    }
    if (this.snapshot.costConfirmationReason !== null) {
      this.publish({ ...this.snapshot, costConfirmationReason: null });
    }
  }

  /** 发起 MCP 工具调用审批（支持队列 FIFO 排队、nonce 防重放与 AbortSignal 取消）。 */
  requestMcpApproval(
    request: ProviderMcpApprovalRequest,
    presentation: McpApprovalPresentation,
    signal?: AbortSignal
  ): Promise<ProviderMcpApprovalDecision> {
    if (this.disposed || signal?.aborted) {
      return Promise.resolve('cancel');
    }

    return new Promise((resolve) => {
      let settled = false;
      const token: McpApprovalToken = {
        approvalRequestId: request.id,
        nonce: ++this.mcpNonce,
      };
      const view: McpApprovalViewModel = {
        ...presentation,
        approvalRequestId: token.approvalRequestId,
        approvalNonce: token.nonce,
        serverLabel: request.serverLabel,
        toolName: request.toolName,
        argumentsText: request.rawArguments,
        argumentBytes: request.argumentBytes,
      };
      const onAbort = () => settle('cancel');
      const settle = (decision: ProviderMcpApprovalDecision) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        if (this.pendingMcp === entry) {
          this.pendingMcp = null;
          // 队首审批结算后同步推进下一项待审批请求并生成新快照
          const next = this.mcpQueue.shift() ?? null;
          if (next) {
            this.pendingMcp = next;
            this.publish({ ...this.snapshot, mcpApprovalView: next.view });
          } else if (this.snapshot.mcpApprovalView !== null) {
            this.publish({ ...this.snapshot, mcpApprovalView: null });
          }
        } else {
          const index = this.mcpQueue.indexOf(entry);
          if (index >= 0) {
            this.mcpQueue.splice(index, 1);
          }
        }
        resolve(decision);
      };
      const entry: PendingMcpDecision = { token, view, settle };

      signal?.addEventListener('abort', onAbort, { once: true });
      if (!this.pendingMcp) {
        this.pendingMcp = entry;
        this.publish({
          ...this.snapshot,
          mcpApprovalView: view,
        });
      } else {
        this.mcpQueue.push(entry);
      }
    });
  }

  resolveMcpApproval(
    token: McpApprovalToken,
    decision: ProviderMcpApprovalDecision
  ): void {
    const pending = this.pendingMcp;
    if (!pending || !isSameMcpApprovalToken(pending.token, token)) {
      return;
    }
    pending.settle(decision);
  }

  cancelAll(): void {
    // 先排空等待队列再结算当前激活槽位，避免连续触发中间态上屏闪烁
    const queuedCost = this.costQueue.splice(0, this.costQueue.length);
    for (const item of queuedCost) {
      item.settle(false);
    }
    this.pendingCost?.settle(false);

    const queuedMcp = this.mcpQueue.splice(0, this.mcpQueue.length);
    for (const item of queuedMcp) {
      item.settle('cancel');
    }
    this.pendingMcp?.settle('cancel');
  }

  activate(): void {
    this.disposed = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAll();
    this.listeners.clear();
  }

  private publish(snapshot: ChatRequestDecisionSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

export interface ChatRequestDecisions extends ChatRequestDecisionSnapshot {
  requestCostConfirmation(reason: string, signal?: AbortSignal): Promise<boolean>;
  resolveCostConfirmation(confirmed: boolean): void;
  requestMcpApproval(
    request: ProviderMcpApprovalRequest,
    presentation: McpApprovalPresentation,
    signal?: AbortSignal
  ): Promise<ProviderMcpApprovalDecision>;
  resolveMcpApproval(
    token: McpApprovalToken,
    decision: ProviderMcpApprovalDecision
  ): void;
  cancelAll(): void;
}

export function useChatRequestDecisions(): ChatRequestDecisions {
  const queue = useMemo(() => new ChatRequestDecisionQueue(), []);
  const snapshot = useSyncExternalStore(
    queue.subscribe,
    queue.getSnapshot,
    queue.getSnapshot
  );

  useEffect(() => {
    queue.activate();
    return () => queue.dispose();
  }, [queue]);

  const requestCostConfirmation = useCallback(
    (reason: string, signal?: AbortSignal) => queue.requestCostConfirmation(reason, signal),
    [queue]
  );
  const resolveCostConfirmation = useCallback(
    (confirmed: boolean) => queue.resolveCostConfirmation(confirmed),
    [queue]
  );
  const requestMcpApproval = useCallback(
    (
      request: ProviderMcpApprovalRequest,
      presentation: McpApprovalPresentation,
      signal?: AbortSignal
    ) => queue.requestMcpApproval(request, presentation, signal),
    [queue]
  );
  const resolveMcpApproval = useCallback(
    (token: McpApprovalToken, decision: ProviderMcpApprovalDecision) =>
      queue.resolveMcpApproval(token, decision),
    [queue]
  );
  const cancelAll = useCallback(() => queue.cancelAll(), [queue]);

  return {
    ...snapshot,
    requestCostConfirmation,
    resolveCostConfirmation,
    requestMcpApproval,
    resolveMcpApproval,
    cancelAll,
  };
}
