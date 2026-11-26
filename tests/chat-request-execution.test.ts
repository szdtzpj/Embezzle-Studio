import { describe, expect, it, vi } from 'vitest';

import { createDefaultWorkspace, defaultParameterSettings } from '../src/data/providerCatalog';
import { createStartedProviderUsageEvent } from '../src/services/costGuard';
import type { ChatMessage, ModelInfo } from '../src/domain/types';
import type { ChatOrchestrationController, ChatLease } from '../src/features/chat/internal/ChatContext';
import { ChatRequestDecisionQueue } from '../src/features/chat/internal/decisions/useChatRequestDecisions';
import {
  ChatRequestExecution,
  type ChatRequestExecutionHost,
} from '../src/features/chat/internal/requests/ChatRequestExecution';
import { ChatUsageLedger } from '../src/features/chat/internal/requests/ChatUsageLedger';
import type {
  ProviderAdapter,
  ProviderAdapterRegistry,
} from '../src/features/chat/orchestration/ProviderAdapterRegistry';

function orchestrationFor(controller: AbortController, mcpActive = false) {
  let current: ChatLease | null = {
    controller,
    label: 'test request',
    phase: 'provider-request',
    mcpActive,
  };
  let finished = false;
  const orchestration: ChatOrchestrationController = {
    current: () => current,
    begin: () => null,
    transition: () => false,
    finish: (lease) => {
      if (current === lease) {
        current = null;
        finished = true;
      }
    },
    stop: () => current?.controller.abort(),
  };
  return { orchestration, finished: () => finished };
}

function createHost(trace: string[] = []) {
  const workspace = createDefaultWorkspace();
  const updates: Partial<ChatMessage>[] = [];
  const completed: string[] = [];
  const host: ChatRequestExecutionHost = {
    readWorkspace: () => workspace,
    appState: () => 'active',
    streamUpdateDelayMs: () => 0,
    discardAttachments: async () => undefined,
    authorize: async () => {
      trace.push('authorize');
      return true;
    },
    persistUsageEvents: async () => {
      trace.push('persist');
    },
    finishUsageEvent: async (_event, status) => {
      completed.push(status);
    },
    requestMcpApproval: async () => 'cancel',
    updateAssistantMessage: (_messageId, patch) => {
      updates.push(patch);
    },
    notify: (message) => trace.push(`notice:${message}`),
  };
  return { workspace, host, updates, completed };
}

function executionPlan(workspace: ReturnType<typeof createDefaultWorkspace>, controller: AbortController) {
  const model: ModelInfo = {
    id: 'gpt-test',
    capabilities: [],
    task: 'chat',
    source: 'manual',
  };
  const provider = { ...workspace.providers[0], models: [model] };
  workspace.providers = [provider, ...workspace.providers.slice(1)];
  const assistantMessage: ChatMessage = {
    id: 'assistant-1',
    role: 'assistant',
    content: '',
    createdAt: 2,
    status: 'pending',
    providerId: provider.id,
    providerName: provider.name,
    modelId: model.id,
  };
  return {
    assistantMessage,
    conversationId: workspace.activeConversationId,
    transcript: [
      {
        id: 'user-1',
        role: 'user' as const,
        content: 'hello',
        createdAt: 1,
        status: 'ready' as const,
      },
    ],
    runtime: {
      provider,
      model,
      modelId: model.id,
      reasoningEffort: 'default' as const,
    },
    controller,
    usageEvent: createStartedProviderUsageEvent({
      id: 'usage-1',
      kind: 'chat',
      providerId: provider.id,
      modelId: model.id,
      createdAt: 1,
      messageId: assistantMessage.id,
    }),
    parameterSettings: defaultParameterSettings,
  };
}

describe('ChatRequestExecution', () => {
  it('persists a continuation attempt before allowing the next provider send', async () => {
    const trace: string[] = [];
    const controller = new AbortController();
    const { orchestration } = orchestrationFor(controller);
    const { workspace, host } = createHost(trace);
    const adapter: ProviderAdapter = {
      run: async (request) => {
        trace.push('provider-start');
        await request.beforeExternalSearchProviderRequest?.({
          requestNumber: 2,
          signal: controller.signal,
        });
        trace.push('continuation-send');
        return { content: 'done', raw: undefined };
      },
      queryTask: async () => ({ content: '', raw: undefined }),
    };
    const registry: ProviderAdapterRegistry = { resolve: () => adapter };
    const execution = new ChatRequestExecution(registry, orchestration, host);

    await expect(execution.execute(executionPlan(workspace, controller))).resolves.toMatchObject({
      status: 'success',
    });
    expect(trace).toEqual(['provider-start', 'authorize', 'persist', 'continuation-send']);
  });

  it('terminalizes an aborted provider result and releases the active lease', async () => {
    const controller = new AbortController();
    const state = orchestrationFor(controller);
    const { workspace, host, updates, completed } = createHost();
    const adapter: ProviderAdapter = {
      run: async () => {
        controller.abort();
        return { content: 'late result', raw: undefined };
      },
      queryTask: async () => ({ content: '', raw: undefined }),
    };
    const registry: ProviderAdapterRegistry = { resolve: () => adapter };
    const execution = new ChatRequestExecution(registry, state.orchestration, host);

    await expect(execution.execute(executionPlan(workspace, controller))).resolves.toMatchObject({
      status: 'cancelled',
    });
    expect(updates.at(-1)).toMatchObject({ status: 'cancelled' });
    expect(completed).toEqual(['cancelled']);
    expect(state.finished()).toBe(true);
  });

  it('retains a bounded MCP audit after approval when the request is interrupted', async () => {
    const controller = new AbortController();
    const state = orchestrationFor(controller, true);
    const { workspace, host, updates, completed } = createHost();
    host.requestMcpApproval = async () => 'approve';
    const plan = executionPlan(workspace, controller);
    workspace.plugins = [
      {
        id: 'mcp-1',
        name: 'Local tools',
        version: '1.0.0',
        type: 'remote-mcp',
        permissions: ['network', 'tools'],
        allowedTools: ['read_file'],
        endpoint: 'https://example.test/mcp',
        enabled: true,
        serverLabel: 'local-tools',
        providerId: plan.runtime.provider.id,
        approvalPolicy: 'always',
      },
    ];
    const adapter: ProviderAdapter = {
      run: async (request) => {
        const mcp = request.mcp;
        expect(mcp).toBeDefined();
        if (!mcp) throw new Error('missing MCP runtime');
        mcp.onProviderRequestStarted?.({ requestNumber: 1, signal: controller.signal });
        await mcp.requestApproval(
          {
            id: 'approval-1',
            serverLabel: 'local-tools',
            toolName: 'read_file',
            rawArguments: '{"path":"notes.md"}',
            arguments: { path: 'notes.md' },
            argumentBytes: 19,
          },
          { approvalNumber: 1, requestNumber: 1, signal: controller.signal }
        );
        controller.abort();
        const error = new Error('interrupted');
        error.name = 'AbortError';
        throw error;
      },
      queryTask: async () => ({ content: '', raw: undefined }),
    };
    const registry: ProviderAdapterRegistry = { resolve: () => adapter };
    const execution = new ChatRequestExecution(registry, state.orchestration, host);

    const outcome = await execution.execute(plan);
    expect(outcome).toMatchObject({
      status: 'cancelled',
      mcpAudit: {
        status: 'cancelled',
        providerSendStarted: true,
        activity: {
          serverLabel: 'local-tools',
          approvals: [{ toolName: 'read_file', decision: 'approve' }],
        },
      },
    });
    expect(updates.at(-1)).toMatchObject({
      status: 'cancelled',
      mcpActivity: {
        approvals: [{ toolName: 'read_file', decision: 'approve' }],
      },
    });
    expect(completed).toEqual(['cancelled']);
  });

  it('persists thinkingDurationMs and providerContinuations onto the completed assistant message', async () => {
    const controller = new AbortController();
    const state = orchestrationFor(controller);
    const { workspace, host, updates, completed } = createHost();
    const continuations = [
      {
        provider: 'openai' as const,
        type: 'reasoning_encrypted' as const,
        id: 'rs_1',
        encryptedContent: 'enc_blob_123',
      },
    ];
    const adapter: ProviderAdapter = {
      run: async () => ({
        content: 'final text',
        reasoningContent: 'thinking summary',
        thinkingDurationMs: 420,
        providerContinuations: continuations,
        raw: undefined,
      }),
      queryTask: async () => ({ content: '', raw: undefined }),
    };
    const registry: ProviderAdapterRegistry = { resolve: () => adapter };
    const execution = new ChatRequestExecution(registry, state.orchestration, host);

    const outcome = await execution.execute(executionPlan(workspace, controller));
    expect(outcome.status).toBe('success');
    const readyPatch = updates.find((patch) => patch.status === 'ready');
    expect(readyPatch).toMatchObject({
      content: 'final text',
      thinkingDurationMs: 420,
      providerContinuations: continuations,
    });
    expect(completed).toEqual(['succeeded']);
  });

  it('preserves explicit thinkingDurationMs=0, sums substantive thinking steps, and avoids fabricating duration for blank placeholders', async () => {
    // 1) 显式返回 thinkingDurationMs: 0 时必须原样保留，不得因 falsy 丢失
    {
      const controller = new AbortController();
      const state = orchestrationFor(controller);
      const { workspace, host, updates } = createHost();
      const adapter: ProviderAdapter = {
        run: async () => ({
          content: 'instant answer',
          thinkingDurationMs: 0,
          raw: undefined,
        }),
        queryTask: async () => ({ content: '', raw: undefined }),
      };
      const execution = new ChatRequestExecution({ resolve: () => adapter }, state.orchestration, host);
      await execution.execute(executionPlan(workspace, controller));
      const readyPatch = updates.find((patch) => patch.status === 'ready');
      expect(readyPatch?.thinkingDurationMs).toBe(0);
    }

    // 2) 未显式返回 thinkingDurationMs 时，累加 activityTimeline 中实质推理 thinking 步的多段耗时
    {
      const controller = new AbortController();
      const state = orchestrationFor(controller);
      const { workspace, host, updates } = createHost();
      const adapter: ProviderAdapter = {
        run: async () => ({
          content: 'reasoned answer',
          activityTimeline: [
            {
              id: 'think-1',
              kind: 'thinking',
              sequence: 1,
              title: '第一段推理',
              content: '拆解条件 A',
              status: 'completed',
              startedAt: 1000,
              finishedAt: 1250,
            },
            {
              id: 'tool-1',
              kind: 'tool',
              sequence: 2,
              title: '检索',
              status: 'completed',
              startedAt: 1250,
              finishedAt: 1500,
            },
            {
              id: 'think-2',
              kind: 'thinking',
              sequence: 3,
              title: '第二段推理',
              content: '综合验证 B',
              status: 'completed',
              startedAt: 1500,
              finishedAt: 1920,
            },
          ],
          raw: undefined,
        }),
        queryTask: async () => ({ content: '', raw: undefined }),
      };
      const execution = new ChatRequestExecution({ resolve: () => adapter }, state.orchestration, host);
      await execution.execute(executionPlan(workspace, controller));
      const readyPatch = updates.find((patch) => patch.status === 'ready');
      expect(readyPatch?.thinkingDurationMs).toBe(670);
    }

    // 3) 仅有空占位 thinking 步且无 reasoningContent 时，不得伪造耗时（应为 undefined）
    {
      const controller = new AbortController();
      const state = orchestrationFor(controller);
      const { workspace, host, updates } = createHost();
      const adapter: ProviderAdapter = {
        run: async () => ({
          content: 'plain answer',
          reasoningContent: '   ',
          activityTimeline: [
            {
              id: 'think-empty',
              kind: 'thinking',
              sequence: 1,
              title: '思考占位',
              content: '   ',
              status: 'completed',
              startedAt: 1000,
              finishedAt: 1800,
            },
          ],
          raw: undefined,
        }),
        queryTask: async () => ({ content: '', raw: undefined }),
      };
      const execution = new ChatRequestExecution({ resolve: () => adapter }, state.orchestration, host);
      await execution.execute(executionPlan(workspace, controller));
      const readyPatch = updates.find((patch) => patch.status === 'ready');
      expect(readyPatch?.status).toBe('ready');
      expect(readyPatch?.thinkingDurationMs).toBeUndefined();
    }
  });

  it('retains streamed thinkingDurationMs, citations, and webSearchTriggered across subsequent text-only chunks', async () => {
    const controller = new AbortController();
    const state = orchestrationFor(controller);
    const { workspace, host, updates } = createHost();
    let resolveFirstPending: (() => void) | undefined;
    let resolveSecondPending: (() => void) | undefined;
    const firstPendingFlushed = new Promise<void>((resolve) => {
      resolveFirstPending = resolve;
    });
    const secondPendingFlushed = new Promise<void>((resolve) => {
      resolveSecondPending = resolve;
    });
    const origUpdate = host.updateAssistantMessage;
    let pendingFlushCount = 0;
    host.updateAssistantMessage = (messageId, patch, conversationId) => {
      origUpdate(messageId, patch, conversationId);
      if (patch.status === 'pending') {
        pendingFlushCount += 1;
        if (pendingFlushCount === 1) resolveFirstPending?.();
        if (pendingFlushCount === 2) resolveSecondPending?.();
      }
    };
    const citations = [{ title: 'Source A', url: 'https://example.test/a' }];
    const adapter: ProviderAdapter = {
      run: async (request) => {
        request.onStreamUpdate?.({
          content: '初步正文',
          thinkingDurationMs: 320,
          citations,
          webSearchTriggered: true,
        });
        await firstPendingFlushed;
        request.onStreamUpdate?.({
          content: '初步正文 + 后续纯文本分片',
        });
        await secondPendingFlushed;
        return {
          content: '初步正文 + 后续纯文本分片',
          citations,
          webSearchTriggered: true,
          raw: undefined,
        };
      },
      queryTask: async () => ({ content: '', raw: undefined }),
    };

    const execution = new ChatRequestExecution({ resolve: () => adapter }, state.orchestration, host);
    const outcome = await execution.execute(executionPlan(workspace, controller));
    expect(outcome.status).toBe('success');

    const pendingPatches = updates.filter((patch) => patch.status === 'pending');
    expect(pendingPatches.length).toBeGreaterThanOrEqual(2);
    const lastPending = pendingPatches[pendingPatches.length - 1];
    expect(lastPending).toMatchObject({
      content: '初步正文 + 后续纯文本分片',
      thinkingDurationMs: 320,
      citations,
      webSearchTriggered: true,
      status: 'pending',
    });

    const readyPatch = updates.find((patch) => patch.status === 'ready');
    expect(readyPatch).toMatchObject({
      thinkingDurationMs: 320,
      citations,
      webSearchTriggered: true,
      status: 'ready',
    });
  });

  it('clears pending streamTimer on abort with hanging discardAttachments and preserves streamed metadata on cancelled state', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const state = orchestrationFor(controller);
      const { workspace, host, updates } = createHost();
      let markDiscardStarted: (() => void) | undefined;
      let resolveDiscard: (() => void) | undefined;
      const discardStarted = new Promise<void>((resolve) => {
        markDiscardStarted = resolve;
      });
      host.streamUpdateDelayMs = () => 60;
      host.discardAttachments = async () => {
        markDiscardStarted?.();
        await new Promise<void>((resolve) => {
          resolveDiscard = resolve;
        });
      };
      const citations = [{ title: 'Streamed Ref', url: 'https://example.test/ref' }];

      const adapter: ProviderAdapter = {
        run: async (request) => {
          request.onStreamUpdate?.({
            content: '已流出部分内容',
            thinkingDurationMs: 280,
            citations,
            webSearchTriggered: true,
          });
          // 后续仅发纯文本 chunk，确保元数据不被覆盖
          request.onStreamUpdate?.({
            content: '已流出部分内容-补充',
          });
          controller.abort();
          return {
            content: 'late',
            attachments: [
              {
                id: 'att-1',
                kind: 'image',
                name: 'tmp.png',
                mimeType: 'image/png',
                uri: 'file:///tmp.png',
              },
            ],
            raw: undefined,
          };
        },
        queryTask: async () => ({ content: '', raw: undefined }),
      };

      const execution = new ChatRequestExecution({ resolve: () => adapter }, state.orchestration, host);
      const executePromise = execution.execute(executionPlan(workspace, controller));
      await discardStarted;
      await vi.advanceTimersByTimeAsync(100);
      expect(updates.some((patch) => patch.status === 'pending')).toBe(false);

      resolveDiscard?.();
      const outcome = await executePromise;
      expect(outcome.status).toBe('cancelled');

      const cancelledIndex = updates.findIndex((patch) => patch.status === 'cancelled');
      expect(cancelledIndex).toBeGreaterThanOrEqual(0);
      expect(updates[cancelledIndex]).toMatchObject({
        content: '已流出部分内容-补充',
        thinkingDurationMs: 280,
        citations,
        webSearchTriggered: true,
        status: 'cancelled',
      });

      // 推进超过 60ms 节流延迟，确认 streamTimer 已被提前清理、绝无 pending 覆写终态
      await vi.advanceTimersByTimeAsync(100);
      expect(updates.slice(cancelledIndex + 1).some((patch) => patch.status === 'pending')).toBe(false);
      expect(updates.at(-1)?.status).toBe('cancelled');
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears pending streamTimer on stream error and retains streamed thinkingDurationMs/citations on error state', async () => {
    const controller = new AbortController();
    const state = orchestrationFor(controller);
    const { workspace, host, updates, completed } = createHost();
    host.streamUpdateDelayMs = () => 60;
    const citations = [{ title: 'Error Ref', url: 'https://example.test/err' }];

    const adapter: ProviderAdapter = {
      run: async (request) => {
        request.onStreamUpdate?.({
          content: '断流前内容',
          thinkingDurationMs: 410,
          citations,
          webSearchTriggered: true,
        });
        throw new Error('SSE stream disconnected');
      },
      queryTask: async () => ({ content: '', raw: undefined }),
    };

    const execution = new ChatRequestExecution({ resolve: () => adapter }, state.orchestration, host);
    const outcome = await execution.execute(executionPlan(workspace, controller));
    expect(outcome).toMatchObject({
      status: 'error',
      error: 'SSE stream disconnected',
    });

    const errorIndex = updates.findIndex((patch) => patch.status === 'error');
    expect(errorIndex).toBeGreaterThanOrEqual(0);
    expect(updates[errorIndex]).toMatchObject({
      content: '断流前内容',
      thinkingDurationMs: 410,
      citations,
      webSearchTriggered: true,
      status: 'error',
      error: 'SSE stream disconnected',
    });
    expect(completed).toEqual(['failed']);

    // 等待超过 60ms 节流窗口，确认无延时 pending 覆写终态
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(updates.slice(errorIndex + 1)).toEqual([]);
  });

  it('aborts a pending continuation cost-confirmation dialog immediately when controller.abort() fires', async () => {
    const controller = new AbortController();
    const state = orchestrationFor(controller, true);
    const { workspace, host, completed } = createHost();
    workspace.costGuard = {
      ...workspace.costGuard,
      enabled: true,
      confirmPotentialMultipleCharges: false,
      dailyRequestLimit: 1,
      limitAction: 'warn',
    };
    workspace.providerUsageEvents = [
      createStartedProviderUsageEvent({
        id: 'prior-today',
        kind: 'chat',
        providerId: workspace.providers[0].id,
        modelId: 'gpt-test',
        createdAt: Date.now(),
      }),
    ];

    const decisions = new ChatRequestDecisionQueue();
    const ledger = new ChatUsageLedger({
      readWorkspace: () => workspace,
      isReplacing: () => false,
      replaceUsageEvents: async () => true,
      flushRequired: async () => undefined,
      confirmCost: (reason, signal) => decisions.requestCostConfirmation(reason, signal),
      notify: () => undefined,
      now: () => Date.now(),
    });
    host.authorize = (plan, signal) => ledger.authorize(plan, signal);
    host.requestMcpApproval = async () => 'approve';

    const plan = executionPlan(workspace, controller);
    workspace.plugins = [
      {
        id: 'mcp-cost-abort',
        name: 'Local tools',
        version: '1.0.0',
        type: 'remote-mcp',
        permissions: ['network', 'tools'],
        allowedTools: ['read_file'],
        endpoint: 'https://example.test/mcp',
        enabled: true,
        serverLabel: 'local-tools',
        providerId: plan.runtime.provider.id,
        approvalPolicy: 'always',
      },
    ];

    let waitingOnContinuation = false;
    const adapter: ProviderAdapter = {
      run: async (request) => {
        const mcp = request.mcp!;
        mcp.onProviderRequestStarted?.({ requestNumber: 1, signal: controller.signal });
        waitingOnContinuation = true;
        await mcp.beforeContinuation?.({
          nextRequestNumber: 2,
          approvals: [
            {
              approvalRequestId: 'approval-1',
              serverLabel: 'local-tools',
              toolName: 'read_file',
              argumentBytes: 19,
              decision: 'approve',
            },
          ],
          signal: controller.signal,
        });
        return { content: 'unreachable', raw: undefined };
      },
      queryTask: async () => ({ content: '', raw: undefined }),
    };

    const execution = new ChatRequestExecution({ resolve: () => adapter }, state.orchestration, host);
    const execPromise = execution.execute(plan);

    await Promise.resolve();
    expect(waitingOnContinuation).toBe(true);
    expect(decisions.getSnapshot().costConfirmationReason).not.toBeNull();

    // 仅触发 controller.abort()，不手动 resolveCostConfirmation，验证不会死锁
    controller.abort();
    const outcome = await execPromise;
    expect(outcome.status).toBe('cancelled');
    expect(decisions.getSnapshot().costConfirmationReason).toBeNull();
    expect(completed).toEqual(['cancelled']);
    expect(state.finished()).toBe(true);
    decisions.dispose();
  });
});
