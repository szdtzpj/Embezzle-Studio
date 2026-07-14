import { describe, expect, it } from 'vitest';

import { createDefaultWorkspace, defaultParameterSettings } from '../src/data/providerCatalog';
import { createStartedProviderUsageEvent } from '../src/services/costGuard';
import type { ChatMessage, ModelInfo } from '../src/domain/types';
import type { ChatOrchestrationController, ChatLease } from '../src/features/chat/internal/ChatContext';
import {
  ChatRequestExecution,
  type ChatRequestExecutionHost,
} from '../src/features/chat/internal/requests/ChatRequestExecution';
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
});
