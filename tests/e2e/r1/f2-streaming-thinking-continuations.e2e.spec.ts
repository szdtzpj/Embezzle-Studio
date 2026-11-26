/**
 * F2 E2E 端到端测试：多协议流式对话、Reasoning/Thinking 计时与多轮加密续接态无损回传。
 * 覆盖需求：ORIGINAL_REQUEST §R1, §R2 & PROJECT.md Features #3–#6, #17。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { defaultParameterSettings } from '../../../src/data/providerCatalog';
import type {
  AppWorkspace,
  ChatCompletionResult,
  ChatMessage,
  ModelInfo,
  ProviderContinuationBlock,
  ProviderProfile,
  ProviderUsageEvent,
} from '../../../src/domain/types';
import type {
  ChatLease,
  ChatOrchestrationController,
} from '../../../src/features/chat/internal/ChatContext';
import {
  ChatRequestExecution,
  type ChatRequestExecutionHost,
} from '../../../src/features/chat/internal/requests/ChatRequestExecution';
import type { ChatActivityPhase } from '../../../src/features/chat/useChatActivity';
import { createStartedProviderUsageEvent } from '../../../src/services/costGuard';
import {
  createE2EWorkspaceHarness,
  installMockFetchRouter,
  safeImportModule,
  type E2EWorkspaceHarness,
  type InstalledMockFetchRouter,
} from '../helpers/e2eWorkspaceHarness';
import { createMockUpstreamServer, type MockUpstreamServer } from '../helpers/mockUpstreamServer';
import {
  buildAnthropicMessagesSseChunks,
  buildGeminiStreamSseChunks,
  buildOpenAiChatSseChunks,
  buildOpenAiResponsesSseChunks,
  buildXaiResponsesSseChunks,
  formatSseEvent,
} from '../helpers/sseFixtures';

function createTestExecutionRig(workspaceReader: () => AppWorkspace) {
  let currentLease: ChatLease | null = null;
  let seq = 0;
  const messagePatches: Array<{ messageId: string; patch: Partial<ChatMessage> }> = [];
  const usageFinishes: Array<{ id: string; status: 'succeeded' | 'failed' | 'cancelled' }> = [];
  const notifications: string[] = [];

  const orchestration: ChatOrchestrationController = {
    current: () => currentLease,
    begin: (options: {
      phase: Exclude<ChatActivityPhase, 'idle'>;
      label: string;
      mcpActive?: boolean;
    }) => {
      if (currentLease) return null;
      currentLease = {
        controller: new AbortController(),
        label: options.label,
        phase: options.phase,
        mcpActive: options.mcpActive === true,
      };
      return currentLease;
    },
    transition: (lease, phase) => {
      if (currentLease !== lease) return false;
      currentLease = { ...lease, phase };
      return true;
    },
    finish: (lease) => {
      if (currentLease === lease) {
        currentLease = null;
      }
    },
    stop: () => {
      currentLease?.controller.abort();
      currentLease = null;
    },
  };

  const host: ChatRequestExecutionHost = {
    readWorkspace: workspaceReader,
    appState: () => 'active',
    streamUpdateDelayMs: () => 5,
    discardAttachments: async () => undefined,
    authorize: async () => true,
    persistUsageEvents: async () => undefined,
    finishUsageEvent: async (event, status) => {
      usageFinishes.push({ id: event.id, status });
    },
    requestMcpApproval: async () => 'deny',
    updateAssistantMessage: (messageId, patch) => {
      seq += 1;
      void seq;
      messagePatches.push({ messageId, patch });
    },
    notify: (msg) => {
      notifications.push(msg);
    },
  };

  return { orchestration, host, messagePatches, usageFinishes, notifications };
}

function getProviderFromHarness(harness: E2EWorkspaceHarness, providerId: string): ProviderProfile {
  const provider = harness.session.getSnapshot().providers.find((p) => p.id === providerId);
  if (!provider) {
    throw new Error(`工作区中未找到服务商 ${providerId}`);
  }
  return provider;
}

function getModelFromProvider(provider: ProviderProfile, modelId: string): ModelInfo {
  const found = provider.models.find((m) => m.id === modelId);
  if (found) return found;
  return {
    id: modelId,
    name: modelId,
    capabilities: ['text', 'reasoning', 'streaming', 'web-search'],
    source: 'manual',
  };
}

describe('F2 — 多协议流式对话、Thinking 计时与加密态无损回传 E2E', () => {
  let server: MockUpstreamServer;
  let serverBaseUrl = '';
  let router: InstalledMockFetchRouter | null = null;
  let harness: E2EWorkspaceHarness | null = null;

  beforeAll(async () => {
    server = createMockUpstreamServer();
    const started = await server.start();
    serverBaseUrl = started.baseUrl;
  });

  afterEach(async () => {
    router?.restore();
    router = null;
    harness?.dispose();
    harness = null;
    server.reset();
  });

  afterAll(async () => {
    await server.close();
  });

  // =========================================================================
  // Tier 1：Happy Path（6 个端到端流式与多轮续接用例）
  // =========================================================================

  it('T1-1: OpenAI Responses 流式增量（reasoning.summary + encrypted_content）应准确聚合与保留续接块', async () => {
    router = installMockFetchRouter(serverBaseUrl);
    harness = await createE2EWorkspaceHarness();

    await harness.addAndSelectProvider({
      id: 'openai',
      name: 'OpenAI',
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-openai-f2-t1',
      capabilities: ['text', 'reasoning', 'streaming'],
      models: [
        {
          id: 'gpt-5.4-pro',
          name: 'GPT-5.4 Pro',
          capabilities: ['text', 'reasoning', 'streaming'],
          source: 'preset',
        },
      ],
    });

    const provider = getProviderFromHarness(harness, 'openai');
    const model = getModelFromProvider(provider, 'gpt-5.4-pro');

    server.enqueue(
      { method: 'POST', pathname: '/v1/responses' },
      {
        kind: 'sse',
        chunkDelayMs: 10,
        chunks: buildOpenAiResponsesSseChunks({
          model: 'gpt-5.4-pro',
          reasoningSummaryDeltas: ['先拆解问题，', '再验证结论。'],
          encryptedReasoningContent: 'enc_openai_rs_blob_abc123',
          textDeltas: ['最终答案：', '一切就绪。'],
          usage: { input_tokens: 30, output_tokens: 20, reasoning_tokens: 12, total_tokens: 50 },
        }),
      }
    );

    const streamUpdates: Array<{ content: string; reasoningContent?: string }> = [];
    const adapter = harness.productionAdapterRegistry.resolve(
      { provider, modelId: model.id, model },
      'chat'
    );

    const result = await adapter.run({
      provider,
      modelId: model.id,
      model,
      messages: [
        {
          id: 'u1',
          role: 'user',
          content: '请分析并回答',
          createdAt: harness.clock.now(),
          status: 'ready',
        },
      ],
      reasoningEffort: 'high',
      parameterSettings: defaultParameterSettings,
      onStreamUpdate: (update) => {
        streamUpdates.push({
          content: update.content,
          reasoningContent: update.reasoningContent,
        });
      },
    });

    const req = server.getLastRequest({ method: 'POST', pathname: '/v1/responses' });
    expect(req).toBeDefined();
    const jsonBody = req?.jsonBody as Record<string, unknown>;
    expect(jsonBody.stream).toBe(true);
    expect(jsonBody.store).toBe(false);

    expect(streamUpdates.length).toBeGreaterThanOrEqual(2);
    expect(result.content).toBe('最终答案：一切就绪。');
    expect(result.reasoningContent).toContain('先拆解问题，再验证结论。');
    expect(typeof result.thinkingDurationMs).toBe('number');
    expect(result.thinkingDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.usage?.totalTokens).toBe(50);

    const encBlock = result.providerContinuations?.find(
      (b) => b.provider === 'openai' && b.type === 'reasoning_encrypted'
    );
    expect(encBlock).toMatchObject({
      provider: 'openai',
      type: 'reasoning_encrypted',
      encryptedContent: 'enc_openai_rs_blob_abc123',
    });
  });

  it('T1-2: Anthropic Claude /v1/messages 原生流式（adaptive/budget_tokens Thinking、无 [DONE] 仅 message_stop）应正常完成', async () => {
    await safeImportModule('src/services/anthropicMessages.ts');
    router = installMockFetchRouter(serverBaseUrl);
    harness = await createE2EWorkspaceHarness();

    await harness.addAndSelectProvider({
      id: 'anthropic',
      name: 'Anthropic Claude',
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-f2-t2',
      authHeaderMode: 'x-api-key',
      capabilities: ['text', 'reasoning', 'streaming'],
      models: [
        {
          id: 'claude-sonnet-5-5',
          name: 'Claude Sonnet 5.5',
          capabilities: ['text', 'reasoning', 'streaming'],
          source: 'preset',
        },
      ],
    });

    const provider = getProviderFromHarness(harness, 'anthropic');
    const model = getModelFromProvider(provider, 'claude-sonnet-5-5');

    server.enqueue(
      { method: 'POST', pathname: '/v1/messages' },
      {
        kind: 'sse',
        chunkDelayMs: 8,
        chunks: buildAnthropicMessagesSseChunks({
          model: 'claude-sonnet-5-5',
          thinkingBlocks: [{ thinking: '深度分析 Claude 原生思维链...', signature: 'sig_claude_1' }],
          textDeltas: ['你好，', '这是 Claude 原生流式回复。'],
          usage: { input_tokens: 40, output_tokens: 22 },
        }),
      }
    );

    const adapter = harness.productionAdapterRegistry.resolve(
      { provider, modelId: model.id, model },
      'chat'
    );
    const result = await adapter.run({
      provider,
      modelId: model.id,
      model,
      messages: [
        {
          id: 'u1',
          role: 'user',
          content: '测试 Anthropic 流式',
          createdAt: harness.clock.now(),
          status: 'ready',
        },
      ],
      reasoningEffort: 'high',
      parameterSettings: defaultParameterSettings,
    });

    const req = server.getLastRequest({ method: 'POST', pathname: '/v1/messages' });
    expect(req).toBeDefined();
    expect(req?.headers['x-api-key']).toBe('sk-ant-f2-t2');
    expect(req?.headers['anthropic-version']).toBe('2023-06-01');
    const body = req?.jsonBody as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.thinking).toBeDefined();
    const thinkingCfg = body.thinking as Record<string, unknown>;
    expect(['adaptive', 'enabled']).toContain(thinkingCfg.type);
    if (thinkingCfg.type === 'enabled') {
      expect(typeof thinkingCfg.budget_tokens).toBe('number');
    }

    expect(result.content).toBe('你好，这是 Claude 原生流式回复。');
    expect(result.reasoningContent).toContain('深度分析 Claude 原生思维链');
    expect(typeof result.thinkingDurationMs).toBe('number');
    expect(result.usage?.inputTokens).toBe(40);
    expect(result.usage?.outputTokens).toBe(22);
  });

  it('T1-3: Anthropic 多轮 thinking.signature 与 redacted_thinking 应无损提取并在下轮原样回传', async () => {
    await safeImportModule('src/services/anthropicMessages.ts');
    router = installMockFetchRouter(serverBaseUrl);
    harness = await createE2EWorkspaceHarness();

    await harness.addAndSelectProvider({
      id: 'anthropic',
      name: 'Anthropic Claude',
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-f2-t3',
      authHeaderMode: 'x-api-key',
      capabilities: ['text', 'reasoning', 'streaming'],
      models: [
        {
          id: 'claude-opus-5-5',
          name: 'Claude Opus 5.5',
          capabilities: ['text', 'reasoning', 'streaming'],
          source: 'preset',
        },
      ],
    });

    const provider = getProviderFromHarness(harness, 'anthropic');
    const model = getModelFromProvider(provider, 'claude-opus-5-5');

    // 第 1 轮：同时返回 thinking+signature 与 redacted_thinking
    server.enqueue(
      { method: 'POST', pathname: '/v1/messages' },
      {
        kind: 'sse',
        chunks: buildAnthropicMessagesSseChunks({
          model: 'claude-opus-5-5',
          thinkingBlocks: [{ thinking: 'Round 1 thought', signature: 'EqQBCgIYAhIMsignatureRound1==' }],
          redactedThinkingData: 'REDACTED_OPAQUE_BLOB_V1',
          textDeltas: ['第一轮回答。'],
        }),
      }
    );
    // 第 2 轮：追问响应
    server.enqueue(
      { method: 'POST', pathname: '/v1/messages' },
      {
        kind: 'sse',
        chunks: buildAnthropicMessagesSseChunks({
          model: 'claude-opus-5-5',
          textDeltas: ['第二轮追问回答。'],
        }),
      }
    );

    const adapter = harness.productionAdapterRegistry.resolve(
      { provider, modelId: model.id, model },
      'chat'
    );

    const turn1User: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: '第一轮问题',
      createdAt: harness.clock.now(),
      status: 'ready',
    };
    const turn1Result = await adapter.run({
      provider,
      modelId: model.id,
      model,
      messages: [turn1User],
      reasoningEffort: 'medium',
      parameterSettings: defaultParameterSettings,
    });

    expect(turn1Result.content).toBe('第一轮回答。');
    expect(turn1Result.content).not.toContain('REDACTED_OPAQUE_BLOB_V1');
    expect(turn1Result.content).not.toContain('EqQBCgIYAhIMsignatureRound1==');

    const thinkingBlock = turn1Result.providerContinuations?.find(
      (b): b is Extract<ProviderContinuationBlock, { provider: 'anthropic'; type: 'thinking' }> =>
        b.provider === 'anthropic' && b.type === 'thinking'
    );
    const redactedBlock = turn1Result.providerContinuations?.find(
      (b): b is Extract<ProviderContinuationBlock, { provider: 'anthropic'; type: 'redacted_thinking' }> =>
        b.provider === 'anthropic' && b.type === 'redacted_thinking'
    );
    expect(thinkingBlock?.signature).toBe('EqQBCgIYAhIMsignatureRound1==');
    expect(redactedBlock?.data).toBe('REDACTED_OPAQUE_BLOB_V1');

    // 第 2 轮把第 1 轮 assistant 消息（带 providerContinuations）传入
    const turn1Assistant: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      content: turn1Result.content,
      reasoningContent: turn1Result.reasoningContent,
      providerContinuations: turn1Result.providerContinuations,
      createdAt: harness.clock.now() + 100,
      status: 'ready',
    };
    const turn2User: ChatMessage = {
      id: 'u2',
      role: 'user',
      content: '请继续展开',
      createdAt: harness.clock.now() + 200,
      status: 'ready',
    };

    const turn2Result = await adapter.run({
      provider,
      modelId: model.id,
      model,
      messages: [turn1User, turn1Assistant, turn2User],
      reasoningEffort: 'medium',
      parameterSettings: defaultParameterSettings,
    });
    expect(turn2Result.content).toBe('第二轮追问回答。');

    const round2Req = server.getLastRequest({ method: 'POST', pathname: '/v1/messages' });
    const reqMessages = (round2Req?.jsonBody as { messages: Array<{ role: string; content: unknown }> }).messages;
    const assistantMsg = reqMessages.find((m) => m.role === 'assistant');
    expect(Array.isArray(assistantMsg?.content)).toBe(true);
    const blocks = assistantMsg?.content as Array<Record<string, unknown>>;
    const thinkingBlocks = blocks.filter((b) => b.type === 'thinking');
    const redactedBlocks = blocks.filter((b) => b.type === 'redacted_thinking');
    const firstTextIndex = blocks.findIndex((b) => b.type === 'text');

    expect(thinkingBlocks.length).toBeGreaterThanOrEqual(1);
    expect(redactedBlocks.length).toBeGreaterThanOrEqual(1);
    expect(firstTextIndex).toBeGreaterThanOrEqual(0);
    for (const [idx, block] of blocks.entries()) {
      if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        expect(idx).toBeLessThan(firstTextIndex);
      }
    }

    expect(thinkingBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'thinking',
          thinking: 'Round 1 thought',
          signature: 'EqQBCgIYAhIMsignatureRound1==',
        }),
      ])
    );
    expect(redactedBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'redacted_thinking',
          data: 'REDACTED_OPAQUE_BLOB_V1',
        }),
      ])
    );
    expect(blocks[firstTextIndex]).toMatchObject({
      type: 'text',
      text: '第一轮回答。',
    });
  });

  it('T1-4: Google Gemini streamGenerateContent?alt=sse 应解析 thought 分片与多轮回传 thoughtSignature', async () => {
    await safeImportModule('src/services/geminiNative.ts');
    router = installMockFetchRouter(serverBaseUrl);
    harness = await createE2EWorkspaceHarness();

    await harness.addAndSelectProvider({
      id: 'gemini',
      name: 'Google Gemini',
      kind: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'AIzaSy-gemini-f2-t4',
      authHeaderMode: 'x-goog-api-key',
      capabilities: ['text', 'reasoning', 'streaming'],
      models: [
        {
          id: 'gemini-3.8-flash',
          name: 'Gemini 3.8 Flash',
          capabilities: ['text', 'reasoning', 'streaming'],
          source: 'preset',
        },
      ],
    });

    const provider = getProviderFromHarness(harness, 'gemini');
    const model = getModelFromProvider(provider, 'gemini-3.8-flash');

    server.enqueue(
      { method: 'POST', pathname: '/v1beta/models/gemini-3.8-flash:streamGenerateContent' },
      {
        kind: 'sse',
        chunks: buildGeminiStreamSseChunks({
          modelVersion: 'gemini-3.8-flash',
          thoughtParts: [{ text: 'Gemini 内部思考步骤...', thoughtSignature: 'gem_thought_sig_01' }],
          textDeltas: ['Gemini ', '流式回答。'],
          finalThoughtSignature: 'gem_final_sig_02',
          usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 12, thoughtsTokenCount: 8, totalTokenCount: 35 },
        }),
      }
    );
    server.enqueue(
      { method: 'POST', pathname: '/v1beta/models/gemini-3.8-flash:streamGenerateContent' },
      {
        kind: 'sse',
        chunks: buildGeminiStreamSseChunks({
          modelVersion: 'gemini-3.8-flash',
          textDeltas: ['第二轮 Gemini 回答。'],
        }),
      }
    );

    const adapter = harness.productionAdapterRegistry.resolve(
      { provider, modelId: model.id, model },
      'chat'
    );

    const u1: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: '计算推理题',
      createdAt: harness.clock.now(),
      status: 'ready',
    };
    const r1 = await adapter.run({
      provider,
      modelId: model.id,
      model,
      messages: [u1],
      reasoningEffort: 'high',
      parameterSettings: defaultParameterSettings,
    });

    const req1 = server.getRequests({ pathname: '/v1beta/models/gemini-3.8-flash:streamGenerateContent' })[0];
    expect(req1).toBeDefined();
    expect(req1.query.alt).toBe('sse');
    expect(req1.headers['x-goog-api-key']).toBe('AIzaSy-gemini-f2-t4');
    expect(req1.url).not.toContain('AIzaSy-gemini-f2-t4');

    expect(r1.content).toBe('Gemini 流式回答。');
    expect(r1.reasoningContent).toContain('Gemini 内部思考步骤...');
    const sigBlocks = (r1.providerContinuations ?? []).filter(
      (b): b is Extract<ProviderContinuationBlock, { provider: 'gemini'; type: 'thought_signature' }> =>
        b.provider === 'gemini' && b.type === 'thought_signature'
    );
    expect(sigBlocks.map((b) => b.thoughtSignature)).toEqual(
      expect.arrayContaining(['gem_final_sig_02'])
    );

    const a1: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      content: r1.content,
      reasoningContent: r1.reasoningContent,
      providerContinuations: r1.providerContinuations,
      createdAt: harness.clock.now() + 100,
      status: 'ready',
    };
    const u2: ChatMessage = {
      id: 'u2',
      role: 'user',
      content: '继续下一步',
      createdAt: harness.clock.now() + 200,
      status: 'ready',
    };

    await adapter.run({
      provider,
      modelId: model.id,
      model,
      messages: [u1, a1, u2],
      reasoningEffort: 'high',
      parameterSettings: defaultParameterSettings,
    });

    const req2 = server.getLastRequest({ pathname: '/v1beta/models/gemini-3.8-flash:streamGenerateContent' });
    const contents = (req2?.jsonBody as { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> }).contents;
    const modelTurn = contents.find((c) => c.role === 'model');
    expect(modelTurn).toBeDefined();
    const hasThoughtSignature = modelTurn?.parts.some((p) => p.thoughtSignature === 'gem_final_sig_02');
    expect(hasThoughtSignature).toBe(true);
  });

  it('T1-5: xAI Grok Responses 流式增量应正确提取与回传 reasoning.encrypted_content 且禁用 search_parameters', async () => {
    await safeImportModule('src/services/xaiGrok.ts');
    router = installMockFetchRouter(serverBaseUrl);
    harness = await createE2EWorkspaceHarness();

    await harness.addAndSelectProvider({
      id: 'xai-grok',
      name: 'xAI Grok',
      kind: 'xai-grok',
      baseUrl: 'https://api.x.ai/v1',
      apiKey: 'xai-e2e-key-t5',
      capabilities: ['text', 'reasoning', 'streaming'],
      models: [
        {
          id: 'grok-4.7',
          name: 'Grok 4.7',
          capabilities: ['text', 'reasoning', 'streaming'],
          source: 'preset',
        },
      ],
    });

    const provider = getProviderFromHarness(harness, 'xai-grok');
    const model = getModelFromProvider(provider, 'grok-4.7');

    server.enqueue(
      { method: 'POST', pathname: '/v1/responses' },
      {
        kind: 'sse',
        chunks: buildXaiResponsesSseChunks({
          model: 'grok-4.7',
          reasoningSummaryDeltas: ['Grok 推理摘要'],
          encryptedReasoningContent: 'xai_enc_reasoning_token_xyz',
          textDeltas: ['Grok 第一轮输出。'],
        }),
      }
    );
    server.enqueue(
      { method: 'POST', pathname: '/v1/responses' },
      {
        kind: 'sse',
        chunks: buildXaiResponsesSseChunks({
          model: 'grok-4.7',
          textDeltas: ['Grok 第二轮输出。'],
        }),
      }
    );

    const adapter = harness.productionAdapterRegistry.resolve(
      { provider, modelId: model.id, model },
      'chat'
    );
    const u1: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: 'Grok 测试问题',
      createdAt: harness.clock.now(),
      status: 'ready',
    };
    const r1 = await adapter.run({
      provider,
      modelId: model.id,
      model,
      messages: [u1],
      reasoningEffort: 'high',
      parameterSettings: defaultParameterSettings,
    });

    const req1 = server.getRequests({ pathname: '/v1/responses' })[0];
    expect(req1.bodyText).not.toContain('search_parameters');
    const xaiBlock = r1.providerContinuations?.find(
      (b) => b.provider === 'xai' && b.type === 'reasoning_encrypted'
    );
    expect(xaiBlock).toMatchObject({
      provider: 'xai',
      type: 'reasoning_encrypted',
      encryptedContent: 'xai_enc_reasoning_token_xyz',
    });

    const a1: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      content: r1.content,
      providerContinuations: r1.providerContinuations,
      createdAt: harness.clock.now() + 100,
      status: 'ready',
    };
    await adapter.run({
      provider,
      modelId: model.id,
      model,
      messages: [
        u1,
        a1,
        { id: 'u2', role: 'user', content: '继续', createdAt: harness.clock.now() + 200, status: 'ready' },
      ],
      reasoningEffort: 'high',
      parameterSettings: defaultParameterSettings,
    });

    const req2 = server.getLastRequest({ pathname: '/v1/responses' });
    expect(req2?.bodyText).not.toContain('search_parameters');
    expect(req2?.bodyText).toContain('xai_enc_reasoning_token_xyz');
  });

  it('T1-6: Thinking 实时计时 thinkingDurationMs 与 providerContinuations 应经 ChatRequestExecution 完整落盘', async () => {
    router = installMockFetchRouter(serverBaseUrl);
    harness = await createE2EWorkspaceHarness();

    await harness.addAndSelectProvider({
      id: 'openai',
      name: 'OpenAI',
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-openai-exec-t6',
      capabilities: ['text', 'reasoning', 'streaming'],
      models: [
        {
          id: 'gpt-5.4-pro',
          name: 'GPT-5.4 Pro',
          capabilities: ['text', 'reasoning', 'streaming'],
          source: 'preset',
        },
      ],
    });

    const provider = getProviderFromHarness(harness, 'openai');
    const model = getModelFromProvider(provider, 'gpt-5.4-pro');

    server.enqueue(
      { method: 'POST', pathname: '/v1/responses' },
      {
        kind: 'sse',
        chunkDelayMs: 25,
        chunks: buildOpenAiResponsesSseChunks({
          model: 'gpt-5.4-pro',
          reasoningSummaryDeltas: ['Step 1 thinking', 'Step 2 thinking'],
          encryptedReasoningContent: 'enc_exec_persisted_99',
          textDeltas: ['最终落盘结果'],
        }),
      }
    );

    const rig = createTestExecutionRig(() => harness!.session.getSnapshot());
    const lease = rig.orchestration.begin({ phase: 'provider-request', label: 'f2-t6' })!;
    const execution = new ChatRequestExecution(
      harness.productionAdapterRegistry,
      rig.orchestration,
      rig.host
    );

    const assistantMessage: ChatMessage = {
      id: 'msg-a-t6',
      role: 'assistant',
      content: '',
      createdAt: harness.clock.now(),
      status: 'pending',
      providerId: provider.id,
      modelId: model.id,
    };
    const usageEvent: ProviderUsageEvent = createStartedProviderUsageEvent({
      id: 'usage-t6',
      kind: 'chat',
      providerId: provider.id,
      modelId: model.id,
      createdAt: harness.clock.now(),
      messageId: assistantMessage.id,
    });

    const outcome = await execution.execute({
      assistantMessage,
      conversationId: harness.session.getSnapshot().activeConversationId,
      transcript: [
        { id: 'msg-u-t6', role: 'user', content: '计时落盘测试', createdAt: harness.clock.now(), status: 'ready' },
      ],
      runtime: { provider, model, modelId: model.id, reasoningEffort: 'high' },
      controller: lease.controller,
      usageEvent,
      parameterSettings: defaultParameterSettings,
    });

    expect(outcome.status).toBe('success');
    const readyPatch = rig.messagePatches.find((p) => p.patch.status === 'ready');
    expect(readyPatch).toBeDefined();
    expect(readyPatch?.patch.content).toBe('最终落盘结果');
    expect(typeof readyPatch?.patch.thinkingDurationMs).toBe('number');
    expect(readyPatch?.patch.thinkingDurationMs).toBeGreaterThanOrEqual(15);
    expect(readyPatch?.patch.providerContinuations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'openai',
          type: 'reasoning_encrypted',
          encryptedContent: 'enc_exec_persisted_99',
        }),
      ])
    );
    expect(rig.usageFinishes.at(-1)?.status).toBe('succeeded');
    expect(rig.orchestration.current()).toBeNull();
  });

  // =========================================================================
  // Tier 2：Boundary / Corner / Error Handling（7 个异常、断流与隔离用例）
  // =========================================================================

  it('T2-1: SSE 半包与跨 chunk 任意位置拆行（含 UTF-8 中文与 JSON/分隔符拆断）应完整重组无乱码', async () => {
    router = installMockFetchRouter(serverBaseUrl);
    harness = await createE2EWorkspaceHarness();

    await harness.addAndSelectProvider({
      id: 'openai',
      name: 'OpenAI',
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-openai-half-chunk',
      capabilities: ['text', 'streaming'],
      models: [
        { id: 'gpt-4.1', name: 'GPT-4.1', capabilities: ['text', 'streaming'], source: 'preset' },
      ],
    });
    const provider = getProviderFromHarness(harness, 'openai');
    const model = getModelFromProvider(provider, 'gpt-4.1');

    const fullFrame = formatSseEvent(undefined, {
      id: 'chatcmpl-half',
      object: 'chat.completion.chunk',
      model: 'gpt-4.1',
      choices: [{ index: 0, delta: { content: '中文半包重组✅完整测试' }, finish_reason: null }],
    });
    const split1 = Math.floor(fullFrame.length * 0.25);
    const split2 = Math.floor(fullFrame.length * 0.65);
    const split3 = fullFrame.length - 1; // 把末尾 \n\n 拆成两半

    server.enqueue(
      { method: 'POST', pathname: '/v1/chat/completions' },
      {
        kind: 'sse',
        chunkDelayMs: 5,
        chunks: [
          { raw: fullFrame.slice(0, split1) },
          { raw: fullFrame.slice(split1, split2) },
          { raw: fullFrame.slice(split2, split3) },
          { raw: fullFrame.slice(split3) },
          ...buildOpenAiChatSseChunks({ model: 'gpt-4.1', textDeltas: ['！'] }),
        ],
      }
    );

    const adapter = harness.productionAdapterRegistry.resolve({ provider, modelId: model.id, model }, 'chat');
    const result = await adapter.run({
      provider,
      modelId: model.id,
      model,
      messages: [{ id: 'u1', role: 'user', content: '半包测试', createdAt: harness.clock.now(), status: 'ready' }],
      reasoningEffort: 'off',
      parameterSettings: defaultParameterSettings,
    });

    expect(result.content).toBe('中文半包重组✅完整测试！');
  });

  it('T2-2: SSE 中途 premature-end 断流（缺失 response.completed / message_stop）不得伪装成功', async () => {
    router = installMockFetchRouter(serverBaseUrl);
    harness = await createE2EWorkspaceHarness();

    // 1) OpenAI Responses 缺失 response.completed
    await harness.addAndSelectProvider({
      id: 'openai',
      name: 'OpenAI',
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-premature-1',
      capabilities: ['text', 'streaming'],
      models: [{ id: 'gpt-5.4-pro', name: 'GPT-5.4 Pro', capabilities: ['text', 'streaming'], source: 'preset' }],
    });
    const openai = getProviderFromHarness(harness, 'openai');
    const gpt54 = getModelFromProvider(openai, 'gpt-5.4-pro');

    server.enqueue(
      { method: 'POST', pathname: '/v1/responses' },
      {
        kind: 'sse',
        chunks: buildOpenAiResponsesSseChunks({
          model: 'gpt-5.4-pro',
          textDeltas: ['前半段输出'],
          omitCompleted: true,
        }),
        abortAfterChunkIndex: 2,
        abortMode: 'premature-end',
      }
    );

    const openaiAdapter = harness.productionAdapterRegistry.resolve(
      { provider: openai, modelId: gpt54.id, model: gpt54 },
      'chat'
    );
    await expect(
      openaiAdapter.run({
        provider: openai,
        modelId: gpt54.id,
        model: gpt54,
        messages: [{ id: 'u1', role: 'user', content: '断流 test', createdAt: harness.clock.now(), status: 'ready' }],
        reasoningEffort: 'off',
        parameterSettings: defaultParameterSettings,
      })
    ).rejects.toThrow(/未完成|中断|completed|结束/i);

    // 2) Anthropic 缺失 message_stop
    await safeImportModule('src/services/anthropicMessages.ts');
    await harness.addAndSelectProvider({
      id: 'anthropic',
      name: 'Anthropic',
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-premature',
      capabilities: ['text', 'streaming'],
      models: [{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', capabilities: ['text', 'streaming'], source: 'preset' }],
    });
    const ant = getProviderFromHarness(harness, 'anthropic');
    const claude = getModelFromProvider(ant, 'claude-sonnet-5-5');

    server.enqueue(
      { method: 'POST', pathname: '/v1/messages' },
      {
        kind: 'sse',
        chunks: buildAnthropicMessagesSseChunks({
          model: 'claude-sonnet-5-5',
          textDeltas: ['半截内容'],
          omitMessageStop: true,
        }),
        abortAfterChunkIndex: 2,
        abortMode: 'premature-end',
      }
    );

    const antAdapter = harness.productionAdapterRegistry.resolve(
      { provider: ant, modelId: claude.id, model: claude },
      'chat'
    );
    await expect(
      antAdapter.run({
        provider: ant,
        modelId: claude.id,
        model: claude,
        messages: [{ id: 'u2', role: 'user', content: 'Anthropic 断流', createdAt: harness.clock.now(), status: 'ready' }],
        reasoningEffort: 'off',
        parameterSettings: defaultParameterSettings,
      })
    ).rejects.toThrow(/message_stop|未完成|中断|结束/i);
  });

  it('T2-3: SSE destroy-socket 断流经 ChatRequestExecution 应落盘 error、保留已达内容并释放租约', async () => {
    router = installMockFetchRouter(serverBaseUrl);
    harness = await createE2EWorkspaceHarness();

    await harness.addAndSelectProvider({
      id: 'openai',
      name: 'OpenAI',
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-socket-destroy',
      capabilities: ['text', 'streaming'],
      models: [{ id: 'gpt-4.1', name: 'GPT-4.1', capabilities: ['text', 'streaming'], source: 'preset' }],
    });
    const provider = getProviderFromHarness(harness, 'openai');
    const model = getModelFromProvider(provider, 'gpt-4.1');

    server.enqueue(
      { method: 'POST', pathname: '/v1/chat/completions' },
      {
        kind: 'sse',
        chunkDelayMs: 15,
        chunks: buildOpenAiChatSseChunks({
          model: 'gpt-4.1',
          textDeltas: ['已经收到的第一段，', '第二段将被切掉', '第三段不会到达'],
        }),
        abortAfterChunkIndex: 0,
        abortMode: 'destroy-socket',
      }
    );

    const rig = createTestExecutionRig(() => harness!.session.getSnapshot());
    const lease = rig.orchestration.begin({ phase: 'provider-request', label: 'destroy-socket-test' })!;
    const execution = new ChatRequestExecution(
      harness.productionAdapterRegistry,
      rig.orchestration,
      rig.host
    );

    const assistantMessage: ChatMessage = {
      id: 'msg-a-sock',
      role: 'assistant',
      content: '',
      createdAt: harness.clock.now(),
      status: 'pending',
      providerId: provider.id,
      modelId: model.id,
    };
    const usageEvent = createStartedProviderUsageEvent({
      id: 'usage-sock',
      kind: 'chat',
      providerId: provider.id,
      modelId: model.id,
      createdAt: harness.clock.now(),
      messageId: assistantMessage.id,
    });

    const outcome = await execution.execute({
      assistantMessage,
      conversationId: harness.session.getSnapshot().activeConversationId,
      transcript: [{ id: 'u1', role: 'user', content: '断网测试', createdAt: harness.clock.now(), status: 'ready' }],
      runtime: { provider, model, modelId: model.id, reasoningEffort: 'off' },
      controller: lease.controller,
      usageEvent,
      parameterSettings: defaultParameterSettings,
    });

    expect(outcome.status).toBe('error');
    const terminalPatch = rig.messagePatches.at(-1);
    expect(terminalPatch?.patch.status).toBe('error');
    expect(terminalPatch?.patch.content).toContain('已经收到的第一段，');
    expect(rig.usageFinishes.at(-1)?.status).toBe('failed');
    expect(rig.orchestration.current()).toBeNull();
  });

  it('T2-4: HTTP 200 SSE 仅包含心跳注释或空流时应拒绝伪装为成功回复', async () => {
    router = installMockFetchRouter(serverBaseUrl);
    harness = await createE2EWorkspaceHarness();

    await harness.addAndSelectProvider({
      id: 'openai',
      name: 'OpenAI',
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-empty-sse',
      capabilities: ['text', 'streaming'],
      models: [{ id: 'gpt-4.1', name: 'GPT-4.1', capabilities: ['text', 'streaming'], source: 'preset' }],
    });
    const provider = getProviderFromHarness(harness, 'openai');
    const model = getModelFromProvider(provider, 'gpt-4.1');

    server.enqueue(
      { method: 'POST', pathname: '/v1/chat/completions' },
      {
        kind: 'sse',
        chunks: [{ raw: ': keep-alive\n\n' }, { raw: ': ping\n\n' }],
      }
    );

    const adapter = harness.productionAdapterRegistry.resolve({ provider, modelId: model.id, model }, 'chat');
    await expect(
      adapter.run({
        provider,
        modelId: model.id,
        model,
        messages: [{ id: 'u1', role: 'user', content: '空流测试', createdAt: harness.clock.now(), status: 'ready' }],
        reasoningEffort: 'off',
        parameterSettings: defaultParameterSettings,
      })
    ).rejects.toThrow(/未返回|流|事件|空/);
  });

  it('T2-5: 上游 HTTP 429 限流与 HTTP 500 服务端错误在多协议下均应返回含状态码的可读 Error 且不泄露 Key', async () => {
    router = installMockFetchRouter(serverBaseUrl);
    harness = await createE2EWorkspaceHarness();

    const secretKey = 'sk-secret-do-not-expose-in-error-msg';
    await harness.addAndSelectProvider({
      id: 'openai',
      name: 'OpenAI',
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: secretKey,
      capabilities: ['text', 'streaming'],
      models: [{ id: 'gpt-5.4', name: 'GPT-5.4', capabilities: ['text', 'streaming'], source: 'preset' }],
    });
    const provider = getProviderFromHarness(harness, 'openai');
    const model = getModelFromProvider(provider, 'gpt-5.4');
    const adapter = harness.productionAdapterRegistry.resolve({ provider, modelId: model.id, model }, 'chat');

    server.enqueue(
      { method: 'POST', pathname: /\/v1\/(responses|chat\/completions)/ },
      {
        kind: 'error',
        status: 429,
        headers: { 'Retry-After': '5' },
        body: { error: { message: 'Too many requests, rate limit reached' } },
      }
    );

    let captured429: unknown;
    try {
      await adapter.run({
        provider,
        modelId: model.id,
        model,
        messages: [{ id: 'u1', role: 'user', content: '429', createdAt: harness.clock.now(), status: 'ready' }],
        reasoningEffort: 'off',
        parameterSettings: defaultParameterSettings,
      });
    } catch (err) {
      captured429 = err;
    }
    expect(captured429).toBeInstanceOf(Error);
    expect((captured429 as Error).message).toContain('429');
    expect((captured429 as Error).message).not.toContain(secretKey);

    server.enqueue(
      { method: 'POST', pathname: /\/v1\/(responses|chat\/completions)/ },
      {
        kind: 'error',
        status: 500,
        body: 'Internal Upstream Gateway Failure',
      }
    );

    let captured500: unknown;
    try {
      await adapter.run({
        provider,
        modelId: model.id,
        model,
        messages: [{ id: 'u2', role: 'user', content: '500', createdAt: harness.clock.now(), status: 'ready' }],
        reasoningEffort: 'off',
        parameterSettings: defaultParameterSettings,
      });
    } catch (err) {
      captured500 = err;
    }
    expect(captured500).toBeInstanceOf(Error);
    expect((captured500 as Error).message).toContain('500');
    expect((captured500 as Error).message).not.toContain(secretKey);
  });

  it('T2-6: 流式传输期间触发 AbortSignal 应快速中止、保留部分内容且正确结算 cancelled', async () => {
    router = installMockFetchRouter(serverBaseUrl);
    harness = await createE2EWorkspaceHarness();

    await harness.addAndSelectProvider({
      id: 'openai',
      name: 'OpenAI',
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-abort-test',
      capabilities: ['text', 'streaming'],
      models: [{ id: 'gpt-4.1', name: 'GPT-4.1', capabilities: ['text', 'streaming'], source: 'preset' }],
    });
    const provider = getProviderFromHarness(harness, 'openai');
    const model = getModelFromProvider(provider, 'gpt-4.1');

    const longDeltas = Array.from({ length: 8 }, (_, idx) => `块${idx + 1} `);
    server.enqueue(
      { method: 'POST', pathname: '/v1/chat/completions' },
      {
        kind: 'sse',
        chunkDelayMs: 60,
        chunks: buildOpenAiChatSseChunks({ model: 'gpt-4.1', textDeltas: longDeltas }),
      }
    );

    const rig = createTestExecutionRig(() => harness!.session.getSnapshot());
    const lease = rig.orchestration.begin({ phase: 'provider-request', label: 'abort-test' })!;
    const execution = new ChatRequestExecution(
      harness.productionAdapterRegistry,
      rig.orchestration,
      rig.host
    );

    const assistantMessage: ChatMessage = {
      id: 'msg-a-abort',
      role: 'assistant',
      content: '',
      createdAt: harness.clock.now(),
      status: 'pending',
      providerId: provider.id,
      modelId: model.id,
    };
    const usageEvent = createStartedProviderUsageEvent({
      id: 'usage-abort',
      kind: 'chat',
      providerId: provider.id,
      modelId: model.id,
      createdAt: harness.clock.now(),
      messageId: assistantMessage.id,
    });

    const startTime = Date.now();
    // 约 95ms 后主动触发中止，应远快于 10 chunks * 60ms = 600ms 完成
    const abortTimer = setTimeout(() => lease.controller.abort(), 95);
    let outcome: Awaited<ReturnType<typeof execution.execute>>;
    try {
      outcome = await execution.execute({
        assistantMessage,
        conversationId: harness.session.getSnapshot().activeConversationId,
        transcript: [{ id: 'u1', role: 'user', content: '中止测试', createdAt: harness.clock.now(), status: 'ready' }],
        runtime: { provider, model, modelId: model.id, reasoningEffort: 'off' },
        controller: lease.controller,
        usageEvent,
        parameterSettings: defaultParameterSettings,
      });
    } finally {
      clearTimeout(abortTimer);
    }
    const elapsed = Date.now() - startTime;

    expect(outcome.status).toBe('cancelled');
    expect(elapsed).toBeLessThan(450);
    const cancelPatch = rig.messagePatches.at(-1);
    expect(cancelPatch?.patch.status).toBe('cancelled');
    expect(rig.usageFinishes.at(-1)?.status).toBe('cancelled');
    expect(rig.orchestration.current()).toBeNull();
  });

  it('T2-7: 中转端点降级隔离 — new-api-relay 不得注入 Anthropic/Gemini 私有续接块至通用 OpenAI 报文', async () => {
    router = installMockFetchRouter(serverBaseUrl, {
      rewriteRules: [{ match: 'relay.example.com' }],
    });
    harness = await createE2EWorkspaceHarness();

    await harness.addAndSelectProvider({
      id: 'new-api-relay',
      name: 'Relay Station',
      kind: 'new-api-relay',
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'sk-relay-t7',
      capabilities: ['text', 'streaming'],
      models: [
        { id: 'claude-sonnet-5-5', name: 'Claude via Relay', capabilities: ['text', 'streaming'], source: 'manual' },
      ],
    });
    const provider = getProviderFromHarness(harness, 'new-api-relay');
    const model = getModelFromProvider(provider, 'claude-sonnet-5-5');

    server.enqueue(
      { method: 'POST', pathname: '/v1/chat/completions' },
      {
        kind: 'sse',
        chunks: buildOpenAiChatSseChunks({
          model: 'claude-sonnet-5-5',
          textDeltas: ['中转安全回复。'],
        }),
      }
    );

    const adapter = harness.productionAdapterRegistry.resolve(
      { provider, modelId: model.id, model },
      'chat'
    );

    const priorResult: ChatCompletionResult = await adapter.run({
      provider,
      modelId: model.id,
      model,
      messages: [
        { id: 'u1', role: 'user', content: '历史问题', createdAt: harness.clock.now(), status: 'ready' },
        {
          id: 'a1',
          role: 'assistant',
          content: '历史回答',
          providerContinuations: [
            { provider: 'anthropic', type: 'thinking', thinking: 'secret', signature: 'sig_private' },
            { provider: 'anthropic', type: 'redacted_thinking', data: 'REDACTED_PRIVATE_DATA' },
            { provider: 'gemini', type: 'thought_signature', thoughtSignature: 'gem_private_sig' },
          ],
          createdAt: harness.clock.now() + 50,
          status: 'ready',
        },
        { id: 'u2', role: 'user', content: '中转续问', createdAt: harness.clock.now() + 100, status: 'ready' },
      ],
      reasoningEffort: 'off',
      parameterSettings: defaultParameterSettings,
    });

    expect(priorResult.content).toBe('中转安全回复。');
    const req = server.getLastRequest({ method: 'POST', pathname: '/v1/chat/completions' });
    expect(req).toBeDefined();
    expect(req?.bodyText).not.toContain('redacted_thinking');
    expect(req?.bodyText).not.toContain('REDACTED_PRIVATE_DATA');
    expect(req?.bodyText).not.toContain('thoughtSignature');
    expect(req?.bodyText).not.toContain('sig_private');
  });
});
