/**
 * F3 E2E 端到端测试：官方托管网络搜索（OpenAI / Claude / Gemini Grounding / xAI / DeepSeek / Ark / Bailian）。
 * 覆盖需求：ORIGINAL_REQUEST §R1 & PROJECT.md Features #3–#7。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { defaultParameterSettings } from '../../../src/data/providerCatalog';
import type {
  AppWorkspace,
  ChatMessage,
  ModelInfo,
  ProviderContinuationBlock,
  ProviderProfile,
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
  isExactOfficialAnthropicProvider,
  isExactOfficialOpenAiProvider,
  isExactOfficialXaiProvider,
  isRelayOrCustomProvider,
} from '../../../src/services/providerSetup';
import {
  buildProviderWebSearchRequest,
  parseProviderWebSearchResponse,
  ProviderWebSearchProtocolError,
  resolveProviderWebSearchProtocol,
} from '../../../src/services/providerWebSearch';
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
  buildDeepSeekChatSseChunks,
  buildGeminiStreamSseChunks,
  buildOpenAiChatSseChunks,
  buildOpenAiResponsesJson,
  buildOpenAiResponsesSseChunks,
  buildXaiDeprecatedSearchParameters410Response,
  buildXaiResponsesSseChunks,
} from '../helpers/sseFixtures';

function createTestExecutionRig(workspaceReader: () => AppWorkspace) {
  let currentLease: ChatLease | null = null;
  const messagePatches: Array<{ messageId: string; patch: Partial<ChatMessage> }> = [];
  const usageFinishes: Array<{ id: string; status: 'succeeded' | 'failed' | 'cancelled' }> = [];

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
      messagePatches.push({ messageId, patch });
    },
    notify: () => undefined,
  };

  return { orchestration, host, messagePatches, usageFinishes };
}

function getProviderFromHarness(harness: E2EWorkspaceHarness, providerId: string): ProviderProfile {
  const found = harness.session.getSnapshot().providers.find((p) => p.id === providerId);
  if (!found) {
    throw new Error(`未找到服务商 ${providerId}`);
  }
  return found;
}

describe('F3 — 官方托管网络搜索多协议适配与安全边界 E2E', () => {
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
  // Tier 1：Happy Path（7 个端到端官方搜索用例）
  // =========================================================================

  it('T1-1: OpenAI Responses 官方 web_search（search_context_size: high）与 url_citation 偏移解析', async () => {
    router = installMockFetchRouter(serverBaseUrl);
    harness = await createE2EWorkspaceHarness();

    const model: ModelInfo = {
      id: 'gpt-5',
      name: 'GPT-5',
      capabilities: ['text', 'reasoning', 'web-search', 'streaming'],
      source: 'preset',
    };
    await harness.addAndSelectProvider(
      {
        id: 'openai',
        name: 'OpenAI',
        kind: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-openai-websearch-t1',
        capabilities: ['text', 'reasoning', 'web-search', 'streaming'],
        models: [model],
      },
      model
    );
    await harness.setProviderWebSearch(true, 'high');

    const answerPart1 = '据官方发布，';
    const citedSegment = 'Embezzle Studio 2026 已支持全协议搜索';
    const startIdx = answerPart1.length;
    const endIdx = startIdx + citedSegment.length;

    const fixtureOptions = {
      model: 'gpt-5',
      webSearchQuery: 'Embezzle Studio 2026',
      textDeltas: [answerPart1, citedSegment, '。'],
      citations: [
        {
          url: 'https://docs.example.com/release-2026',
          title: '2026 Release Notes',
          start_index: startIdx,
          end_index: endIdx,
        },
      ],
    };

    server.enqueue({ method: 'POST', pathname: '/v1/responses' }, (req) => {
      const body = req.jsonBody as Record<string, unknown> | undefined;
      if (body?.stream === true) {
        return { kind: 'sse', chunks: buildOpenAiResponsesSseChunks(fixtureOptions) };
      }
      return { kind: 'json', body: buildOpenAiResponsesJson(fixtureOptions) };
    });

    const provider = getProviderFromHarness(harness, 'openai');
    const adapter = harness.productionAdapterRegistry.resolve({ provider, modelId: model.id, model }, 'chat');
    const result = await adapter.run({
      provider,
      modelId: model.id,
      model,
      messages: [{ id: 'u1', role: 'user', content: '查一下 Embezzle 2026 更新', createdAt: harness.clock.now(), status: 'ready' }],
      reasoningEffort: 'medium',
      parameterSettings: defaultParameterSettings,
      webSearch: harness.session.getSnapshot().webSearch,
    });

    const req = server.getLastRequest({ method: 'POST', pathname: '/v1/responses' });
    expect(req).toBeDefined();
    expect(req?.headers.authorization).toBe('Bearer sk-openai-websearch-t1');
    const jsonBody = req?.jsonBody as {
      store?: unknown;
      tools?: Array<Record<string, unknown>>;
    };
    expect(jsonBody.store).toBe(false);
    expect(jsonBody.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'web_search', search_context_size: 'high' }),
      ])
    );

    expect(result.webSearchTriggered).toBe(true);
    expect(result.citations?.length).toBeGreaterThanOrEqual(1);
    const citation = result.citations![0];
    expect(citation.url).toBe('https://docs.example.com/release-2026');
    expect(citation.title).toBe('2026 Release Notes');
    expect(citation.startIndex).toBeDefined();
    expect(citation.endIndex).toBeDefined();
    expect(citation.startIndex).toBe(startIdx);
    expect(citation.endIndex).toBe(endIdx);
    expect(result.content.slice(citation.startIndex!, citation.endIndex!)).toBe(citedSegment);
  });

  it('T1-2: OpenAI 非 Pro 模型 gpt-5.4 启用 webSearch 流式输出与 ChatRequestExecution 落盘闭环', async () => {
    router = installMockFetchRouter(serverBaseUrl);
    harness = await createE2EWorkspaceHarness();

    const model: ModelInfo = {
      id: 'gpt-5.4',
      name: 'GPT-5.4',
      capabilities: ['text', 'streaming', 'web-search'],
      source: 'preset',
    };
    await harness.addAndSelectProvider(
      {
        id: 'openai',
        name: 'OpenAI',
        kind: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-openai-ws-stream-t2',
        capabilities: ['text', 'streaming', 'web-search'],
        models: [model],
      },
      model
    );
    await harness.setProviderWebSearch(true, 'medium');

    server.enqueue(
      { method: 'POST', pathname: '/v1/responses' },
      {
        kind: 'sse',
        chunkDelayMs: 10,
        chunks: buildOpenAiResponsesSseChunks({
          model: 'gpt-5.4',
          reasoningSummaryDeltas: ['检索实时信息中...'],
          webSearchQuery: 'latest benchmark 2026',
          textDeltas: ['第一段搜索结论，', '第二段补充说明。'],
          citations: [
            {
              url: 'https://bench.example.org/2026',
              title: 'Benchmark Report',
              start_index: 0,
              end_index: 7,
            },
          ],
        }),
      }
    );

    const provider = getProviderFromHarness(harness, 'openai');
    const rig = createTestExecutionRig(() => harness!.session.getSnapshot());
    const lease = rig.orchestration.begin({ phase: 'provider-request', label: 'f3-t2' })!;
    const execution = new ChatRequestExecution(
      harness.productionAdapterRegistry,
      rig.orchestration,
      rig.host
    );

    const assistantMessage: ChatMessage = {
      id: 'msg-a-f3-t2',
      role: 'assistant',
      content: '',
      createdAt: harness.clock.now(),
      status: 'pending',
      providerId: provider.id,
      modelId: model.id,
    };
    const usageEvent = createStartedProviderUsageEvent({
      id: 'usage-f3-t2',
      kind: 'web-search',
      providerId: provider.id,
      modelId: model.id,
      createdAt: harness.clock.now(),
      messageId: assistantMessage.id,
    });

    const outcome = await execution.execute({
      assistantMessage,
      conversationId: harness.session.getSnapshot().activeConversationId,
      transcript: [
        { id: 'u1', role: 'user', content: '搜索最新基准', createdAt: harness.clock.now(), status: 'ready' },
      ],
      runtime: { provider, model, modelId: model.id, reasoningEffort: 'medium' },
      controller: lease.controller,
      usageEvent,
      parameterSettings: defaultParameterSettings,
    });

    expect(outcome.status).toBe('success');
    const readyPatch = rig.messagePatches.find((p) => p.patch.status === 'ready');
    expect(readyPatch?.patch.webSearchTriggered).toBe(true);
    expect(readyPatch?.patch.citations?.length).toBeGreaterThan(0);
    expect(rig.messagePatches.some((p) => p.patch.status === 'pending')).toBe(true);
    expect(rig.usageFinishes.at(-1)?.status).toBe('succeeded');
  });

  it('T1-3: Anthropic Claude 原生 /v1/messages web_search_20250305 与多轮 server_tool_use/web_search_tool_result 无损回传', async () => {
    await safeImportModule('src/services/anthropicMessages.ts');
    router = installMockFetchRouter(serverBaseUrl);
    harness = await createE2EWorkspaceHarness();

    const model: ModelInfo = {
      id: 'claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      capabilities: ['text', 'reasoning', 'web-search', 'streaming'],
      source: 'preset',
    };
    await harness.addAndSelectProvider(
      {
        id: 'anthropic',
        name: 'Anthropic Claude',
        kind: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        apiKey: 'sk-ant-ws-t3',
        authHeaderMode: 'x-api-key',
        capabilities: ['text', 'reasoning', 'web-search', 'streaming'],
        models: [model],
      },
      model
    );
    await harness.setProviderWebSearch(true, 'medium');

    server.enqueue(
      { method: 'POST', pathname: '/v1/messages' },
      {
        kind: 'sse',
        chunks: buildAnthropicMessagesSseChunks({
          model: 'claude-sonnet-4-6',
          thinkingBlocks: [{ thinking: '需要联网查证 Claude 文档。', signature: 'sig_ant_ws_1' }],
          serverWebSearch: {
            toolUseId: 'srvtoolu_ant_01',
            query: 'Anthropic web search 20250305',
            results: [
              {
                url: 'https://docs.anthropic.com/web-search',
                title: 'Anthropic Web Search Docs',
                encrypted_content: 'enc_search_payload_1',
              },
            ],
          },
          textDeltas: ['根据 Anthropic 官方文档，已支持 web_search_20250305。'],
          citations: [
            {
              type: 'web_search_result_location',
              url: 'https://docs.anthropic.com/web-search',
              title: 'Anthropic Web Search Docs',
              cited_text: '支持 web_search_20250305',
              encrypted_index: 'enc_idx_1',
            },
          ],
        }),
      }
    );
    server.enqueue(
      { method: 'POST', pathname: '/v1/messages' },
      {
        kind: 'sse',
        chunks: buildAnthropicMessagesSseChunks({
          model: 'claude-sonnet-4-6',
          textDeltas: ['第二轮基于已检索结果继续回答。'],
        }),
      }
    );

    const provider = getProviderFromHarness(harness, 'anthropic');
    const adapter = harness.productionAdapterRegistry.resolve({ provider, modelId: model.id, model }, 'chat');

    const u1: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: '查询 Anthropic web_search_20250305',
      createdAt: harness.clock.now(),
      status: 'ready',
    };
    const r1 = await adapter.run({
      provider,
      modelId: model.id,
      model,
      messages: [u1],
      reasoningEffort: 'medium',
      parameterSettings: defaultParameterSettings,
      webSearch: harness.session.getSnapshot().webSearch,
    });

    const req1 = server.getRequests({ pathname: '/v1/messages' })[0];
    expect(req1.headers['x-api-key']).toBe('sk-ant-ws-t3');
    expect(req1.headers['anthropic-version']).toBeDefined();
    expect(req1.headers.authorization).toBeUndefined();
    const body1 = req1.jsonBody as { tools?: Array<Record<string, unknown>> };
    expect(body1.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'web_search_20250305' })])
    );

    expect(r1.webSearchTriggered).toBe(true);
    expect(r1.citations?.some((c) => c.url === 'https://docs.anthropic.com/web-search')).toBe(true);
    expect(r1.providerContinuations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'anthropic', type: 'server_tool_use', id: 'srvtoolu_ant_01' }),
        expect.objectContaining({ provider: 'anthropic', type: 'web_search_tool_result', toolUseId: 'srvtoolu_ant_01' }),
      ])
    );

    // 第 2 轮无损回传 server_tool_use & web_search_tool_result
    const a1: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      content: r1.content,
      providerContinuations: r1.providerContinuations,
      createdAt: harness.clock.now() + 50,
      status: 'ready',
    };
    await adapter.run({
      provider,
      modelId: model.id,
      model,
      messages: [
        u1,
        a1,
        { id: 'u2', role: 'user', content: '再总结一次', createdAt: harness.clock.now() + 100, status: 'ready' },
      ],
      reasoningEffort: 'medium',
      parameterSettings: defaultParameterSettings,
      webSearch: harness.session.getSnapshot().webSearch,
    });

    const req2 = server.getLastRequest({ pathname: '/v1/messages' });
    const req2Messages = (req2?.jsonBody as { messages: Array<{ role: string; content: unknown }> }).messages;
    const assistantMsg = req2Messages.find((m) => m.role === 'assistant');
    expect(Array.isArray(assistantMsg?.content)).toBe(true);
    const contentBlocks = assistantMsg?.content as Array<Record<string, unknown>>;
    expect(contentBlocks.some((b) => b.type === 'server_tool_use' && b.id === 'srvtoolu_ant_01')).toBe(true);
    expect(contentBlocks.some((b) => b.type === 'web_search_tool_result' && b.tool_use_id === 'srvtoolu_ant_01')).toBe(true);
  });

  it('T1-4: Google Gemini 原生 google_search Grounding 标题与链接映射应精确一致', async () => {
    await safeImportModule('src/services/geminiNative.ts');
    router = installMockFetchRouter(serverBaseUrl);
    harness = await createE2EWorkspaceHarness();

    const model: ModelInfo = {
      id: 'gemini-2.5-pro',
      name: 'Gemini 2.5 Pro',
      capabilities: ['text', 'reasoning', 'web-search', 'streaming'],
      source: 'preset',
    };
    await harness.addAndSelectProvider(
      {
        id: 'gemini',
        name: 'Google Gemini',
        kind: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'AIzaSy-gemini-grounding-t4',
        authHeaderMode: 'x-goog-api-key',
        capabilities: ['text', 'reasoning', 'web-search', 'streaming'],
        models: [model],
      },
      model
    );
    await harness.setProviderWebSearch(true, 'medium');

    server.enqueue(
      { method: 'POST', pathname: /^\/v1beta\/models\/gemini-2\.5-pro:(streamGenerateContent|generateContent)$/ },
      {
        kind: 'sse',
        chunks: buildGeminiStreamSseChunks({
          modelVersion: 'gemini-2.5-pro',
          webSearchQueries: ['Gemini Grounding 2026'],
          groundingChunks: [
            { uri: 'https://ai.google.dev/gemini-api/docs/grounding', title: 'Gemini Grounding Docs' },
            { uri: 'https://blog.google/technology/ai', title: 'Google AI Blog' },
          ],
          textDeltas: ['Gemini Grounding 已返回检索来源。'],
        }),
      }
    );

    const provider = getProviderFromHarness(harness, 'gemini');
    const adapter = harness.productionAdapterRegistry.resolve({ provider, modelId: model.id, model }, 'chat');
    const result = await adapter.run({
      provider,
      modelId: model.id,
      model,
      messages: [{ id: 'u1', role: 'user', content: '使用 google_search 查询', createdAt: harness.clock.now(), status: 'ready' }],
      reasoningEffort: 'low',
      parameterSettings: defaultParameterSettings,
      webSearch: harness.session.getSnapshot().webSearch,
    });

    const req = server.getLastRequest({ method: 'POST' });
    expect(req?.pathname).toMatch(/^\/v1beta\/models\/gemini-2\.5-pro:/);
    expect(req?.headers['x-goog-api-key']).toBe('AIzaSy-gemini-grounding-t4');
    expect(req?.url).not.toContain('AIzaSy-gemini-grounding-t4');
    const reqBody = req?.jsonBody as { tools?: Array<Record<string, unknown>> };
    expect(reqBody.tools).toEqual(expect.arrayContaining([expect.objectContaining({ google_search: {} })]));

    expect(result.webSearchTriggered).toBe(true);
    expect(result.citations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: 'https://ai.google.dev/gemini-api/docs/grounding',
          title: 'Gemini Grounding Docs',
        }),
        expect.objectContaining({
          url: 'https://blog.google/technology/ai',
          title: 'Google AI Blog',
        }),
      ])
    );
  });

  it('T1-5: xAI Grok web_search + x_search 搜索应命中 /v1/responses 且绝不发送已废弃 search_parameters', async () => {
    await safeImportModule('src/services/xaiGrok.ts');
    router = installMockFetchRouter(serverBaseUrl);
    harness = await createE2EWorkspaceHarness();

    const model: ModelInfo = {
      id: 'grok-4.3',
      name: 'Grok 4.3',
      capabilities: ['text', 'reasoning', 'web-search', 'streaming'],
      source: 'preset',
    };
    await harness.addAndSelectProvider(
      {
        id: 'xai-grok',
        name: 'xAI Grok',
        kind: 'xai-grok',
        baseUrl: 'https://api.x.ai/v1',
        apiKey: 'xai-ws-t5',
        capabilities: ['text', 'reasoning', 'web-search', 'streaming'],
        models: [model],
      },
      model
    );
    await harness.setProviderWebSearch(true, 'medium');

    server.enqueue(
      { method: 'POST', pathname: '/v1/responses' },
      {
        kind: 'sse',
        chunks: buildXaiResponsesSseChunks({
          model: 'grok-4.3',
          webSearchQuery: 'xAI Grok 4.3 release',
          webSearchActionType: 'x_search_call',
          textDeltas: ['Grok X Search 结果显示已发布。'],
          citations: [
            {
              url: 'https://x.ai/news/grok-4-3',
              title: 'xAI Grok 4.3',
              start_index: 0,
              end_index: 12,
            },
          ],
        }),
      }
    );

    const provider = getProviderFromHarness(harness, 'xai-grok');
    const adapter = harness.productionAdapterRegistry.resolve({ provider, modelId: model.id, model }, 'chat');
    const result = await adapter.run({
      provider,
      modelId: model.id,
      model,
      messages: [{ id: 'u1', role: 'user', content: '查 xAI 最新动态', createdAt: harness.clock.now(), status: 'ready' }],
      reasoningEffort: 'medium',
      parameterSettings: defaultParameterSettings,
      webSearch: harness.session.getSnapshot().webSearch,
    });

    const req = server.getLastRequest({ method: 'POST', pathname: '/v1/responses' });
    expect(req).toBeDefined();
    expect(req?.headers.authorization).toBe('Bearer xai-ws-t5');
    // 硬性契约：绝不发送已废弃并返回 410 的 search_parameters
    expect(JSON.stringify(req?.jsonBody ?? {})).not.toContain('search_parameters');
    const tools = (req?.jsonBody as { tools?: Array<{ type?: string }> })?.tools ?? [];
    const toolTypes = tools.map((t) => t.type);
    expect(toolTypes).toContain('web_search');
    expect(toolTypes).toContain('x_search');

    expect(result.webSearchTriggered).toBe(true);
    expect(result.citations?.some((c) => c.url === 'https://x.ai/news/grok-4-3')).toBe(true);
  });

  it('T1-6: DeepSeek 官方直连 deepseek_web_search + deepseek_read_url 与 server_tool_calls 多轮回传', async () => {
    router = installMockFetchRouter(serverBaseUrl);
    harness = await createE2EWorkspaceHarness();

    const model: ModelInfo = {
      id: 'deepseek-v4-pro',
      name: 'DeepSeek V4 Pro',
      capabilities: ['text', 'reasoning', 'web-search', 'streaming'],
      source: 'preset',
    };
    await harness.addAndSelectProvider(
      {
        id: 'deepseek',
        name: 'DeepSeek',
        kind: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-ds-official-ws-t6',
        capabilities: ['text', 'reasoning', 'web-search', 'streaming'],
        models: [model],
      },
      model
    );
    await harness.setProviderWebSearch(true, 'medium');

    const dsServerTools = [
      {
        id: 'ds_ws_1',
        type: 'deepseek_web_search' as const,
        input: { query: 'DeepSeek V4 Pro' },
        output: { results: [{ url: 'https://www.deepseek.com/v4', title: 'DeepSeek V4' }] },
      },
      {
        id: 'ds_read_1',
        type: 'deepseek_read_url' as const,
        input: { url: 'https://www.deepseek.com/v4' },
        output: { title: 'DeepSeek V4', content: 'Official V4 release' },
      },
    ];

    server.enqueue(
      { method: 'POST', pathname: /\/v1\/(chat\/completions|responses)/ },
      {
        kind: 'sse',
        chunks: buildDeepSeekChatSseChunks({
          model: 'deepseek-v4-pro',
          reasoningDeltas: ['正在调用 DeepSeek 官方搜索与网页读取...'],
          serverToolCalls: dsServerTools,
          textDeltas: ['DeepSeek V4 Pro 已完成官方检索回答。'],
        }),
      }
    );
    server.enqueue(
      { method: 'POST', pathname: /\/v1\/(chat\/completions|responses)/ },
      {
        kind: 'sse',
        chunks: buildDeepSeekChatSseChunks({
          model: 'deepseek-v4-pro',
          textDeltas: ['第二轮 DeepSeek 续接回答。'],
        }),
      }
    );

    const provider = getProviderFromHarness(harness, 'deepseek');
    const adapter = harness.productionAdapterRegistry.resolve({ provider, modelId: model.id, model }, 'chat');

    const u1: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: '搜索 DeepSeek V4 Pro 并读取网页',
      createdAt: harness.clock.now(),
      status: 'ready',
    };
    const r1 = await adapter.run({
      provider,
      modelId: model.id,
      model,
      messages: [u1],
      reasoningEffort: 'medium',
      parameterSettings: defaultParameterSettings,
      webSearch: harness.session.getSnapshot().webSearch,
    });

    const req1 = server.getRequests()[0];
    expect(req1).toBeDefined();
    expect(req1.bodyText).toMatch(/deepseek_web_search|web_search/);
    expect(r1.webSearchTriggered).toBe(true);
    const dsBlock = r1.providerContinuations?.find(
      (b): b is Extract<ProviderContinuationBlock, { provider: 'deepseek'; type: 'server_tool_calls' }> =>
        b.provider === 'deepseek' && b.type === 'server_tool_calls'
    );
    expect(dsBlock).toBeDefined();
    expect(dsBlock?.serverToolCalls.length).toBe(2);

    // 第 2 轮把 server_tool_calls 回传
    const a1: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      content: r1.content,
      providerContinuations: r1.providerContinuations,
      createdAt: harness.clock.now() + 50,
      status: 'ready',
    };
    await adapter.run({
      provider,
      modelId: model.id,
      model,
      messages: [
        u1,
        a1,
        { id: 'u2', role: 'user', content: '补充细节', createdAt: harness.clock.now() + 100, status: 'ready' },
      ],
      reasoningEffort: 'medium',
      parameterSettings: defaultParameterSettings,
      webSearch: harness.session.getSnapshot().webSearch,
    });

    const req2 = server.getLastRequest();
    expect(req2?.bodyText).toContain('server_tool_calls');
    expect(req2?.bodyText).toContain('deepseek_web_search');
  });

  it('T1-7: 火山方舟（max_keyword/limit）与阿里百炼（usage.x_tools.web_search.count）官方搜索兼容', async () => {
    router = installMockFetchRouter(serverBaseUrl, {
      rewriteRules: [{ match: 'ws1.cn-beijing.maas.aliyuncs.com' }],
    });

    const arkProvider: ProviderProfile = {
      id: 'volcengine-ark',
      name: 'Volcengine Ark',
      kind: 'volcengine-ark',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: 'sk-ark-ws-t7',
      capabilities: ['text', 'web-search', 'streaming'],
      models: [{ id: 'doubao-seed-1-6', name: 'Doubao Seed', capabilities: ['text', 'web-search'], source: 'manual' }],
    };
    const arkReq = buildProviderWebSearchRequest({
      provider: arkProvider,
      modelId: 'doubao-seed-1-6',
      messages: [{ id: 'u1', role: 'user', content: '方舟搜索', createdAt: 1, status: 'ready' }],
    });
    expect(arkReq.url).toBe('https://ark.cn-beijing.volces.com/api/v3/responses');
    expect(arkReq.body.tools).toEqual([{ type: 'web_search', max_keyword: 3, limit: 10 }]);

    const bailianProvider: ProviderProfile = {
      id: 'bailian-compatible',
      name: 'Bailian',
      kind: 'bailian-compatible',
      baseUrl: 'https://ws1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      apiKey: 'sk-bailian-ws-t7',
      capabilities: ['text', 'web-search', 'streaming'],
      models: [{ id: 'qwen-plus', name: 'Qwen Plus', capabilities: ['text', 'web-search'], source: 'manual' }],
    };
    const bailianReq = buildProviderWebSearchRequest({
      provider: bailianProvider,
      modelId: 'qwen-plus',
      messages: [{ id: 'u1', role: 'user', content: '百炼搜索', createdAt: 1, status: 'ready' }],
    });
    expect(bailianReq.url).toBe('https://ws1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/responses');

    // 百炼即使没有 url_citation，只要 usage.x_tools.web_search.count > 0 也应判定 webSearchTriggered === true
    const bailianPayload = {
      ...buildOpenAiResponsesJson({
        model: 'qwen-plus',
        textDeltas: ['百炼检索后给出的答案。'],
      }),
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        total_tokens: 30,
        x_tools: {
          web_search: { count: 2 },
        },
      },
    };
    const parsedBailian = parseProviderWebSearchResponse({
      provider: bailianProvider,
      payload: bailianPayload,
    });
    expect(parsedBailian.webSearchTriggered).toBe(true);
    expect(parsedBailian.citations).toEqual([]);
  });

  // =========================================================================
  // Tier 2：Boundary / Corner / Error Handling（7 个降级、异常与安全边界用例）
  // =========================================================================

  it('T2-1: 中转站点与仿冒域名绝不走官方托管搜索，普通中转对话绝不误发官方专有搜索字段', async () => {
    router = installMockFetchRouter(serverBaseUrl);
    harness = await createE2EWorkspaceHarness();

    const relayProvider: ProviderProfile = {
      id: 'new-api-relay',
      name: 'Relay',
      kind: 'new-api-relay',
      baseUrl: 'https://your-relay.example.com/v1',
      apiKey: 'sk-relay-no-official-ws',
      capabilities: ['text', 'streaming', 'web-search'],
      models: [{ id: 'claude-sonnet-4-6', name: 'Claude via Relay', capabilities: ['text', 'streaming'], source: 'manual' }],
    };

    expect(isRelayOrCustomProvider(relayProvider)).toBe(true);
    expect(() => resolveProviderWebSearchProtocol(relayProvider)).toThrow(ProviderWebSearchProtocolError);

    // 仿冒域名必须全部被官方判定函数拒绝且不发出网络请求
    const lookalikes: ProviderProfile[] = [
      { ...relayProvider, kind: 'openai-compatible', baseUrl: 'https://evil-api.openai.com.proxy.test/v1' },
      { ...relayProvider, kind: 'anthropic', baseUrl: 'https://api.anthropic.com.evil.example/v1' },
      { ...relayProvider, kind: 'xai-grok', baseUrl: 'https://api.x.ai.evil.example/v1' },
    ];
    expect(isExactOfficialOpenAiProvider(lookalikes[0])).toBe(false);
    expect(isExactOfficialAnthropicProvider(lookalikes[1])).toBe(false);
    expect(isExactOfficialXaiProvider(lookalikes[2])).toBe(false);
    for (const fake of lookalikes) {
      expect(() => resolveProviderWebSearchProtocol(fake)).toThrow(ProviderWebSearchProtocolError);
    }

    // 中转站点走普通对话（未开 webSearch），必须走 /v1/chat/completions 且绝不带官方搜索字段
    server.enqueue(
      { method: 'POST', pathname: '/v1/chat/completions' },
      {
        kind: 'sse',
        chunks: buildOpenAiChatSseChunks({
          model: 'claude-sonnet-4-6',
          textDeltas: ['中转普通回复'],
        }),
      }
    );

    await harness.addAndSelectProvider(relayProvider, relayProvider.models[0]);
    const savedRelay = getProviderFromHarness(harness, 'new-api-relay');
    const adapter = harness.productionAdapterRegistry.resolve(
      { provider: savedRelay, modelId: 'claude-sonnet-4-6', model: relayProvider.models[0] },
      'chat'
    );
    const res = await adapter.run({
      provider: savedRelay,
      modelId: 'claude-sonnet-4-6',
      model: relayProvider.models[0],
      messages: [{ id: 'u1', role: 'user', content: '中转测试', createdAt: harness.clock.now(), status: 'ready' }],
      reasoningEffort: 'off',
      parameterSettings: defaultParameterSettings,
    });
    expect(res.content).toBe('中转普通回复');
    const req = server.getLastRequest({ pathname: '/v1/chat/completions' });
    expect(req?.bodyText).not.toContain('web_search_20250305');
    expect(req?.bodyText).not.toContain('google_search');
    expect(req?.bodyText).not.toContain('search_parameters');
    expect(req?.bodyText).not.toContain('deepseek_web_search');
  });

  it('T2-2: xAI 410 GONE 与 400 Bad Request 上游错误应经 ChatRequestExecution 安全透传且不泄露 Key', async () => {
    await safeImportModule('src/services/xaiGrok.ts');
    router = installMockFetchRouter(serverBaseUrl);
    harness = await createE2EWorkspaceHarness();

    const secretKey = 'xai-secret-must-not-leak-410';
    const model: ModelInfo = {
      id: 'grok-4.3',
      name: 'Grok 4.3',
      capabilities: ['text', 'web-search', 'streaming'],
      source: 'preset',
    };
    await harness.addAndSelectProvider(
      {
        id: 'xai-grok',
        name: 'xAI Grok',
        kind: 'xai-grok',
        baseUrl: 'https://api.x.ai/v1',
        apiKey: secretKey,
        capabilities: ['text', 'web-search', 'streaming'],
        models: [model],
      },
      model
    );
    await harness.setProviderWebSearch(true, 'medium');

    const provider = getProviderFromHarness(harness, 'xai-grok');
    const rig = createTestExecutionRig(() => harness!.session.getSnapshot());
    const execution = new ChatRequestExecution(
      harness.productionAdapterRegistry,
      rig.orchestration,
      rig.host
    );

    // 1) 上游返回 410 GONE
    server.enqueue(
      { method: 'POST', pathname: '/v1/responses' },
      { kind: 'error', status: 410, body: buildXaiDeprecatedSearchParameters410Response() }
    );
    const lease1 = rig.orchestration.begin({ phase: 'provider-request', label: 'xai-410' })!;
    const outcome410 = await execution.execute({
      assistantMessage: {
        id: 'a-410',
        role: 'assistant',
        content: '',
        createdAt: harness.clock.now(),
        status: 'pending',
        providerId: provider.id,
        modelId: model.id,
      },
      conversationId: harness.session.getSnapshot().activeConversationId,
      transcript: [{ id: 'u1', role: 'user', content: 'test 410', createdAt: harness.clock.now(), status: 'ready' }],
      runtime: { provider, model, modelId: model.id, reasoningEffort: 'off' },
      controller: lease1.controller,
      usageEvent: createStartedProviderUsageEvent({
        id: 'usage-410',
        kind: 'web-search',
        providerId: provider.id,
        modelId: model.id,
        createdAt: harness.clock.now(),
      }),
      parameterSettings: defaultParameterSettings,
    });

    expect(outcome410.status).toBe('error');
    if (outcome410.status === 'error') {
      expect(outcome410.error).toContain('410');
      expect(outcome410.error).not.toContain(secretKey);
    }
    expect(rig.usageFinishes.at(-1)?.status).toBe('failed');
    expect(rig.orchestration.current()).toBeNull();

    // 2) 上游返回 400 Bad Request
    server.enqueue(
      { method: 'POST', pathname: '/v1/responses' },
      { kind: 'error', status: 400, body: { error: { message: 'invalid tool schema' } } }
    );
    const lease2 = rig.orchestration.begin({ phase: 'provider-request', label: 'xai-400' })!;
    const outcome400 = await execution.execute({
      assistantMessage: {
        id: 'a-400',
        role: 'assistant',
        content: '',
        createdAt: harness.clock.now(),
        status: 'pending',
        providerId: provider.id,
        modelId: model.id,
      },
      conversationId: harness.session.getSnapshot().activeConversationId,
      transcript: [{ id: 'u2', role: 'user', content: 'test 400', createdAt: harness.clock.now(), status: 'ready' }],
      runtime: { provider, model, modelId: model.id, reasoningEffort: 'off' },
      controller: lease2.controller,
      usageEvent: createStartedProviderUsageEvent({
        id: 'usage-400',
        kind: 'web-search',
        providerId: provider.id,
        modelId: model.id,
        createdAt: harness.clock.now(),
      }),
      parameterSettings: defaultParameterSettings,
    });

    expect(outcome400.status).toBe('error');
    if (outcome400.status === 'error') {
      expect(outcome400.error).toMatch(/400|invalid tool schema/);
      expect(outcome400.error).not.toContain(secretKey);
    }
  });

  it('T2-3: 模型决定不触发搜索或返回空引用时应保留正文且 webSearchTriggered === false', async () => {
    router = installMockFetchRouter(serverBaseUrl);
    harness = await createE2EWorkspaceHarness();

    const openAiModel: ModelInfo = {
      id: 'gpt-5',
      name: 'GPT-5',
      capabilities: ['text', 'web-search', 'streaming'],
      source: 'preset',
    };
    await harness.addAndSelectProvider(
      {
        id: 'openai',
        name: 'OpenAI',
        kind: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-no-search-trigger',
        capabilities: ['text', 'web-search', 'streaming'],
        models: [openAiModel],
      },
      openAiModel
    );
    await harness.setProviderWebSearch(true, 'low');

    const noSearchOptions = {
      model: 'gpt-5',
      textDeltas: ['这是一个常识问题，无需联网检索。'],
      citations: [],
    };
    server.enqueue({ method: 'POST', pathname: '/v1/responses' }, (req) => {
      const body = req.jsonBody as Record<string, unknown> | undefined;
      return body?.stream === true
        ? { kind: 'sse', chunks: buildOpenAiResponsesSseChunks(noSearchOptions) }
        : { kind: 'json', body: buildOpenAiResponsesJson(noSearchOptions) };
    });

    const openai = getProviderFromHarness(harness, 'openai');
    const res = await harness.productionAdapterRegistry
      .resolve({ provider: openai, modelId: openAiModel.id, model: openAiModel }, 'chat')
      .run({
        provider: openai,
        modelId: openAiModel.id,
        model: openAiModel,
        messages: [{ id: 'u1', role: 'user', content: '1+1等于几？', createdAt: harness.clock.now(), status: 'ready' }],
        reasoningEffort: 'off',
        parameterSettings: defaultParameterSettings,
        webSearch: harness.session.getSnapshot().webSearch,
      });

    expect(res.content).toBe('这是一个常识问题，无需联网检索。');
    expect(res.citations ?? []).toEqual([]);
    expect(res.webSearchTriggered).toBe(false);
  });

  it('T2-4: 引用 URL 安全过滤、合法 fdic.gov 前缀放行与重复 URL 去重校验', () => {
    const provider: ProviderProfile = {
      id: 'openai',
      name: 'OpenAI',
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-url-filter',
      capabilities: ['text', 'web-search'],
      models: [],
    };

    const text = '合法内容与多种边界引用链接验证文本。';
    const payload = {
      id: 'resp_filter_1',
      object: 'response',
      status: 'completed',
      output: [
        { id: 'ws_1', type: 'web_search_call', status: 'completed' },
        {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text,
              annotations: [
                { type: 'url_citation', url: 'http://insecure.example.com/a', title: 'HTTP', start_index: 0, end_index: 2 },
                { type: 'url_citation', url: 'https://user:pass@example.com/b', title: 'Creds', start_index: 0, end_index: 2 },
                { type: 'url_citation', url: 'https://127.0.0.1/local', title: 'Loopback', start_index: 0, end_index: 2 },
                { type: 'url_citation', url: 'https://svc.internal/secret', title: 'Internal', start_index: 0, end_index: 2 },
                { type: 'url_citation', url: 'https://100.64.0.1/cgnat', title: 'CGNAT', start_index: 0, end_index: 2 },
                { type: 'url_citation', url: 'https://valid.example.com/out', title: 'OutOfBounds', start_index: 0, end_index: 999 },
                { type: 'url_citation', url: 'https://example.com/doc', title: 'Doc 1', start_index: 0, end_index: 4 },
                { type: 'url_citation', url: 'https://example.com/doc', title: 'Doc Duplicate', start_index: 4, end_index: 8 },
                { type: 'url_citation', url: 'https://fdic.gov/news/', title: 'FDIC Official', start_index: 8, end_index: 12 },
              ],
            },
          ],
        },
      ],
    };

    const parsed = parseProviderWebSearchResponse({ provider, payload });
    expect(parsed.content).toBe(text);
    const urls = parsed.citations.map((c) => c.url);
    expect(urls).toEqual(['https://example.com/doc', 'https://fdic.gov/news/']);
    for (const url of urls) {
      expect(new URL(url).protocol).toBe('https:');
    }
  });

  it('T2-5: 前置安全门禁拦截（无 Key / 无能力 / 搜索冲突 / MCP 冲突 / 非文本任务 / 方舟带图片）均不发请求', async () => {
    router = installMockFetchRouter(serverBaseUrl);
    harness = await createE2EWorkspaceHarness();

    const baseModel: ModelInfo = {
      id: 'gpt-5',
      name: 'GPT-5',
      capabilities: ['text', 'web-search', 'mcp', 'streaming'],
      source: 'preset',
    };
    const baseProvider: ProviderProfile = {
      id: 'openai',
      name: 'OpenAI',
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-valid-key',
      capabilities: ['text', 'web-search', 'mcp', 'streaming'],
      models: [baseModel],
    };
    const adapter = harness.productionAdapterRegistry.resolve(
      { provider: baseProvider, modelId: baseModel.id, model: baseModel },
      'chat'
    );
    const userMsg: ChatMessage = { id: 'u1', role: 'user', content: 'hi', createdAt: 1, status: 'ready' };

    // 1) 无 API Key
    await expect(
      adapter.run({
        provider: { ...baseProvider, apiKey: '' },
        modelId: baseModel.id,
        model: baseModel,
        messages: [userMsg],
        reasoningEffort: 'off',
        webSearch: { enabled: true, searchContextSize: 'medium' },
      })
    ).rejects.toThrow(/API Key/i);

    // 2) 模型无 web-search 能力
    const noWsModel: ModelInfo = { id: 'gpt-no-ws', name: 'No WS', capabilities: ['text', 'streaming'], source: 'manual' };
    await expect(
      adapter.run({
        provider: baseProvider,
        modelId: noWsModel.id,
        model: noWsModel,
        messages: [userMsg],
        reasoningEffort: 'off',
        webSearch: { enabled: true, searchContextSize: 'medium' },
      })
    ).rejects.toThrow(/支持联网搜索|web-search/);

    // 3) 官方搜索与外部搜索同时开启
    await expect(
      adapter.run({
        provider: baseProvider,
        modelId: baseModel.id,
        model: baseModel,
        messages: [userMsg],
        reasoningEffort: 'off',
        webSearch: { enabled: true, searchContextSize: 'medium' },
        externalSearch: {
          enabled: true,
          maxResults: 5,
          maxToolRounds: 2,
          selectedServiceId: 'bing',
          services: [{ id: 'bing', kind: 'bing', name: 'Bing' }],
        },
      })
    ).rejects.toThrow(/不能同时启用/);

    // 4) 官方搜索与 MCP 冲突
    await expect(
      adapter.run({
        provider: baseProvider,
        modelId: baseModel.id,
        model: baseModel,
        messages: [userMsg],
        reasoningEffort: 'off',
        webSearch: { enabled: true, searchContextSize: 'medium' },
        mcp: {
          plugin: {
            id: 'mcp1',
            name: 'MCP',
            version: '1.0.0',
            type: 'remote-mcp',
            permissions: ['network', 'tools'],
            allowedTools: ['search'],
            endpoint: 'https://mcp.example.com/sse',
            enabled: true,
            serverLabel: 'docs',
            providerId: 'openai',
            approvalPolicy: 'always',
          },
          requestApproval: async () => 'deny' as const,
        },
      })
    ).rejects.toThrow(/MCP/);

    // 5) 非文本任务（生图模型启用搜索）
    const imgModel: ModelInfo = {
      id: 'gpt-image-2.5-sunburst',
      name: 'Image',
      task: 'image-generation',
      capabilities: ['text', 'image-generation'],
      source: 'preset',
    };
    await expect(
      adapter.run({
        provider: baseProvider,
        modelId: imgModel.id,
        model: imgModel,
        messages: [userMsg],
        reasoningEffort: 'off',
        webSearch: { enabled: true, searchContextSize: 'medium' },
      })
    ).rejects.toThrow(/聊天模型/);

    // 6) 火山方舟带图片附件开启搜索
    const arkProvider: ProviderProfile = {
      id: 'volcengine-ark',
      name: 'Ark',
      kind: 'volcengine-ark',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: 'sk-ark',
      capabilities: ['text', 'image-input', 'web-search'],
      models: [{ id: 'doubao-seed', name: 'Doubao', capabilities: ['text', 'image-input', 'web-search'], source: 'manual' }],
    };
    await expect(
      adapter.run({
        provider: arkProvider,
        modelId: 'doubao-seed',
        model: arkProvider.models[0],
        messages: [
          {
            ...userMsg,
            attachments: [{ id: 'att1', kind: 'image', name: 'sample.png', uri: 'data:image/png;base64,AAA', mimeType: 'image/png' }],
          },
        ],
        reasoningEffort: 'off',
        webSearch: { enabled: true, searchContextSize: 'medium' },
      })
    ).rejects.toThrow(/纯文本/);

    expect(server.getRequests()).toHaveLength(0);
  });

  it('T2-6: 官方搜索遇到 HTML 错误页、incomplete 状态或 SSE 断流时应严格报错', async () => {
    router = installMockFetchRouter(serverBaseUrl);
    harness = await createE2EWorkspaceHarness();

    const model: ModelInfo = {
      id: 'gpt-5',
      name: 'GPT-5',
      capabilities: ['text', 'web-search', 'streaming'],
      source: 'preset',
    };
    await harness.addAndSelectProvider(
      {
        id: 'openai',
        name: 'OpenAI',
        kind: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-ws-err-t6',
        capabilities: ['text', 'web-search', 'streaming'],
        models: [model],
      },
      model
    );
    const provider = getProviderFromHarness(harness, 'openai');
    const adapter = harness.productionAdapterRegistry.resolve({ provider, modelId: model.id, model }, 'chat');
    const userMsg: ChatMessage = { id: 'u1', role: 'user', content: 'search fail', createdAt: 1, status: 'ready' };

    // 1) HTML 登录页
    server.enqueue(
      { method: 'POST', pathname: '/v1/responses' },
      { kind: 'text', status: 200, headers: { 'Content-Type': 'text/html' }, body: '<html>Bad Gateway</html>' }
    );
    await expect(
      adapter.run({
        provider,
        modelId: model.id,
        model,
        messages: [userMsg],
        reasoningEffort: 'off',
        webSearch: { enabled: true, searchContextSize: 'medium' },
      })
    ).rejects.toThrow(/HTML|JSON|解析|格式|Bad Gateway/i);

    // 2) incomplete 状态响应
    server.enqueue(
      { method: 'POST', pathname: '/v1/responses' },
      {
        kind: 'json',
        body: {
          id: 'resp_incomplete',
          object: 'response',
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          output: [],
        },
      }
    );
    await expect(
      adapter.run({
        provider,
        modelId: model.id,
        model,
        messages: [userMsg],
        reasoningEffort: 'off',
        webSearch: { enabled: true, searchContextSize: 'medium' },
      })
    ).rejects.toThrow(/incomplete|未完成|max_output_tokens/i);

    // 3) Socket 断流（对于流式路径）
    server.enqueue(
      { method: 'POST', pathname: '/v1/responses' },
      {
        kind: 'sse',
        chunks: buildOpenAiResponsesSseChunks({
          model: 'gpt-5',
          webSearchQuery: 'breaking',
          textDeltas: ['截断正文'],
        }),
        abortAfterChunkIndex: 1,
        abortMode: 'destroy-socket',
      }
    );
    await expect(
      adapter.run({
        provider,
        modelId: model.id,
        model,
        messages: [userMsg],
        reasoningEffort: 'off',
        webSearch: { enabled: true, searchContextSize: 'medium' },
      })
    ).rejects.toThrow(/terminated|aborted|closed|socket|premature|中断|未完成|completed|结束/i);
  });

  it('T2-7: providerWebSearch 参数与端点校验边界应 fail-closed 抛出 ProviderWebSearchProtocolError', () => {
    const arkProvider: ProviderProfile = {
      id: 'volcengine-ark',
      name: 'Ark',
      kind: 'volcengine-ark',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: 'sk-ark',
      capabilities: ['text', 'web-search'],
      models: [],
    };
    const msg: ChatMessage = { id: 'u1', role: 'user', content: 'test', createdAt: 1, status: 'ready' };

    // 非 OpenAI 传入 searchContextSize
    expect(() =>
      buildProviderWebSearchRequest({
        provider: arkProvider,
        modelId: 'doubao-seed',
        messages: [msg],
        searchContextSize: 'high',
      })
    ).toThrow(ProviderWebSearchProtocolError);

    // maxOutputTokens 低于下限 64
    const openAiProvider: ProviderProfile = {
      id: 'openai',
      name: 'OpenAI',
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-oa',
      capabilities: ['text', 'web-search'],
      models: [],
    };
    expect(() =>
      buildProviderWebSearchRequest({
        provider: openAiProvider,
        modelId: 'gpt-5',
        messages: [msg],
        maxOutputTokens: 10,
      })
    ).toThrow(ProviderWebSearchProtocolError);

    // URL 含 query / fragment / http
    expect(() =>
      resolveProviderWebSearchProtocol({ ...openAiProvider, baseUrl: 'https://api.openai.com/v1?token=leak' })
    ).toThrow(ProviderWebSearchProtocolError);
    expect(() =>
      resolveProviderWebSearchProtocol({ ...openAiProvider, baseUrl: 'https://api.openai.com/v1#frag' })
    ).toThrow(ProviderWebSearchProtocolError);
    expect(() =>
      resolveProviderWebSearchProtocol({ ...openAiProvider, baseUrl: 'http://api.openai.com/v1' })
    ).toThrow(ProviderWebSearchProtocolError);

    expect(server.getRequests()).toHaveLength(0);
  });
});
