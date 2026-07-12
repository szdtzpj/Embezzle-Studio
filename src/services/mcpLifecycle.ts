import type { ChatMessage, McpActivitySummary } from '../domain/types';

export interface McpApprovalToken {
  approvalRequestId: string;
  nonce: number;
}

export interface McpProviderSendState {
  requestIsCurrent: boolean;
  mcpActive: boolean;
  signalAborted: boolean;
  appState: string | null | undefined;
}

export interface McpAuditCandidate {
  status: 'cancelled' | 'error';
  activity: McpActivitySummary;
  providerSendStarted: boolean;
  error?: string;
}

export function isSameMcpApprovalToken(
  left: McpApprovalToken | null | undefined,
  right: McpApprovalToken | null | undefined
): boolean {
  return Boolean(
    left &&
    right &&
    left.approvalRequestId === right.approvalRequestId &&
    left.nonce === right.nonce
  );
}

export function assertMcpProviderSendAllowed(state: McpProviderSendState): void {
  if (
    !state.requestIsCurrent ||
    !state.mcpActive ||
    state.signalAborted ||
    state.appState !== 'active'
  ) {
    const error = new Error('MCP 请求已取消或应用不在前台；不会向服务商发送请求。');
    error.name = 'AbortError';
    throw error;
  }
}

export function hasMcpAuditEvidence(
  activity: McpActivitySummary | undefined,
  providerSendStarted: boolean
): boolean {
  return Boolean(
    activity &&
    (providerSendStarted || activity.approvals.length > 0 || activity.calls.length > 0)
  );
}

function cloneMcpActivity(activity: McpActivitySummary): McpActivitySummary {
  return {
    serverLabel: activity.serverLabel,
    providerRequestCount: activity.providerRequestCount,
    approvals: activity.approvals.map((approval) => ({ ...approval })),
    calls: activity.calls.map((call) => ({ ...call })),
  };
}

/**
 * Restores a pre-rerun branch without erasing evidence from the failed attempt.
 * The audit stub deliberately contains no tool arguments, outputs, credentials,
 * response IDs, or attachments.
 */
export function restoreMessagesWithMcpAuditStub({
  originalMessages,
  attemptedAssistant,
  audit,
  stubId,
  createdAt,
}: {
  originalMessages: readonly ChatMessage[];
  attemptedAssistant: ChatMessage;
  audit?: McpAuditCandidate;
  stubId: string;
  createdAt: number;
}): ChatMessage[] {
  if (!audit || !hasMcpAuditEvidence(audit.activity, audit.providerSendStarted)) {
    return [...originalMessages];
  }

  const hasUnknownOutcome = audit.activity.calls.some((call) => call.outcome === 'unknown');
  const statusText = audit.status === 'cancelled' ? '已取消' : '失败';
  const uncertaintyText = hasUnknownOutcome
    ? ' 外部工具结果不确定；副作用可能已经发生，本应用无法确认或撤销。'
    : '';
  const auditStub: ChatMessage = {
    id: stubId,
    role: 'assistant',
    content: `本次重新运行${statusText}；以下保留 MCP 工具审计。${uncertaintyText}`.trim(),
    createdAt,
    status: audit.status,
    modelId: attemptedAssistant.modelId,
    providerId: attemptedAssistant.providerId,
    providerName: attemptedAssistant.providerName,
    mcpActivity: cloneMcpActivity(audit.activity),
    excludedFromContext: true,
    ...(audit.status === 'error' && audit.error ? { error: audit.error } : {}),
  };

  return [...originalMessages, auditStub];
}
