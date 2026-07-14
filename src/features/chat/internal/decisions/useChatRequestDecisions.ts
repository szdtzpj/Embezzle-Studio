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

interface PendingMcpDecision {
  token: McpApprovalToken;
  settle(decision: ProviderMcpApprovalDecision): void;
}

const emptySnapshot: ChatRequestDecisionSnapshot = {
  costConfirmationReason: null,
  mcpApprovalView: null,
};

/**
 * Owns the two user-decision slots used by Chat requests. The queue enforces
 * one pending decision of each kind, nonce-binds MCP decisions, and settles
 * every promise on abort or disposal so callers cannot hang or replay stale
 * approvals.
 */
export class ChatRequestDecisionQueue {
  private snapshot: ChatRequestDecisionSnapshot = emptySnapshot;
  private readonly listeners = new Set<() => void>();
  private costResolver: ((confirmed: boolean) => void) | null = null;
  private pendingMcp: PendingMcpDecision | null = null;
  private mcpNonce = 0;
  private disposed = false;

  getSnapshot = (): ChatRequestDecisionSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  requestCostConfirmation(reason: string): Promise<boolean> {
    if (this.disposed || this.costResolver) {
      return Promise.resolve(false);
    }
    this.publish({ ...this.snapshot, costConfirmationReason: reason });
    return new Promise((resolve) => {
      this.costResolver = resolve;
    });
  }

  resolveCostConfirmation(confirmed: boolean): void {
    const resolver = this.costResolver;
    this.costResolver = null;
    if (this.snapshot.costConfirmationReason !== null) {
      this.publish({ ...this.snapshot, costConfirmationReason: null });
    }
    resolver?.(confirmed);
  }

  requestMcpApproval(
    request: ProviderMcpApprovalRequest,
    presentation: McpApprovalPresentation,
    signal?: AbortSignal
  ): Promise<ProviderMcpApprovalDecision> {
    if (this.disposed || this.pendingMcp || signal?.aborted) {
      return Promise.resolve('cancel');
    }

    return new Promise((resolve) => {
      let settled = false;
      const token: McpApprovalToken = {
        approvalRequestId: request.id,
        nonce: ++this.mcpNonce,
      };
      const onAbort = () => settle('cancel');
      const settle = (decision: ProviderMcpApprovalDecision) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        if (this.pendingMcp?.settle === settle) {
          this.pendingMcp = null;
        }
        if (this.snapshot.mcpApprovalView !== null) {
          this.publish({ ...this.snapshot, mcpApprovalView: null });
        }
        resolve(decision);
      };

      this.pendingMcp = { token, settle };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.publish({
        ...this.snapshot,
        mcpApprovalView: {
          ...presentation,
          approvalRequestId: token.approvalRequestId,
          approvalNonce: token.nonce,
          serverLabel: request.serverLabel,
          toolName: request.toolName,
          argumentsText: request.rawArguments,
          argumentBytes: request.argumentBytes,
        },
      });
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
    this.resolveCostConfirmation(false);
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
  requestCostConfirmation(reason: string): Promise<boolean>;
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
    (reason: string) => queue.requestCostConfirmation(reason),
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
