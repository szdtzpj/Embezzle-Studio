/**
 * F4 E2E 端到端测试：外部独立搜索（DeepSeek Tools / Bocha / Exa / SearXNG / Tavily / Brave）、
 * search_web Tool Calling 闭环、多轮重排与内联引用解析。
 * 覆盖需求：ORIGINAL_REQUEST §R1, §R2 & PROJECT.md Features #7, #17。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { defaultParameterSettings } from '../../../src/data/providerCatalog';
import type {
  AppWorkspace,
  ChatMessage,
  ExternalSearchService,
  ExternalSearchSettings,
  ModelInfo,
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
  citationsFromExternalSearchResults,
  isExternalSearchServiceConfigured,
  normalizeExternalSearchSettings,
  parseSearchWebToolArguments,
  reindexExternalSearchResult,
  resolveMessageMarkdownLink,
  runExternalSearch,
  stripExternalSearchSecrets,
} from '../../../src/services/externalSearch';
import {
  createE2EWorkspaceHarness,
  installMockFetchRouter,
  type E2EExternalSearchProviderKind,
  type E2EWorkspaceHarness,
  type InstalledMockFetchRouter,
} from '../helpers/e2eWorkspaceHarness';
import { createMockUpstreamServer, type MockUpstreamServer } from '../helpers/mockUpstreamServer';
import {
  buildBochaSearchJson,
  buildDeepSeekToolsSearchJson,
  buildExaSearchJson,
  buildOpenAiChatSseChunks,
  buildSearxngSearchJson,
} from '../helpers/sseFixtures';

type E2EExternalSearchService = Omit<ExternalSearchService, 'kind'> & {
  kind: E2EExternalSearchProviderKind;
};

function toRuntimeExternalSearchService(service: E2EExternalSearchService): ExternalSearchService {
  return service as unknown as ExternalSearchService;
}

function toRuntimeExternalSearchSettings(
  settings: Omit<ExternalSearchSettings, 'services'> & { services: E2EExternalSearchService[] }
): ExternalSearchSettings {
  return settings as unknown as ExternalSearchSettings;
}

function createTestExecutionRig(workspaceReader: () => AppWorkspace) {
  let currentLease: ChatLease | null = null;
  const messagePatches: Array<{ messageId: string; patch: Partial<ChatMessage> }> = [];
  const persistedUsageEvents: ProviderUsageEvent[] = [];
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
    persistUsageEvents: async (events) => {
      persistedUsageEvents.push(...events);
    },
    finishUsageEvent: async (event, status) => {
      usageFinishes.push({ id: event.id, status });
    },
    requestMcpApproval: async () => 'deny',
    updateAssistantMessage: (messageId, patch) => {
      messagePatches.push({ messageId, patch });
    },
    notify: () => undefined,
  };

  return { orchestration, host, messagePatches, persistedUsageEvents, usageFinishes };
}

function getProviderFromHarness(harness: E2EWorkspaceHarness, providerId: string): ProviderProfile {
  const found = harness.session.getSnapshot().providers.find((p) => p.id === providerId);
  if (!found) {
    throw new Error(`未找到服务商 ${providerId}`);
  }
  return found;
}

describe('F4 — 外部独立搜索、Tool Calling 闭环与内联引用 E2E', () => {
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
  // Tier 1：Happy Path（7 个端到端外部搜索与引用闭环用例）
  // =========================================================================

  it('T1-1: DeepSeek /v1/tools/search 外部搜索请求构造与响应解析', async () => {
    router = installMockFetchRouter(serverBaseUrl);
    server.enqueue(
      { method: 'POST', pathname: '/v1/tools/search' },
      {
        kind: 'json',
        body: buildDeepSeekToolsSearchJson([
          { title: 'DeepSeek Search API', url: 'https://platform.deepseek.com/docs/search', snippet: '官方搜索工具接口说明' },
          { title: 'Rerank Overview', url: 'https://platform.deepseek.com/docs/rerank', snippet: '重排分数说明' },
          { title: 'Release 2026', url: 'https://platform.deepseek.com/news/2026', snippet: '2026 发布说明' },
        ]),
      }
    );

    const result = await runExternalSearch({
      query: 'DeepSeek tools search 2026',
      service: toRuntimeExternalSearchService({
        id: 'ds-search-1',
        kind: 'deepseek',
        name: 'DeepSeek Search',
        apiKey: 'sk-ds-tools-key',
      }),
      maxResults: 5,
    });

    const req = server.getLastRequest({ method: 'POST', pathname: '/v1/tools/search' });
    expect(req).toBeDefined();
    expect(req?.headers.authorization).toBe('Bearer sk-ds-tools-key');
    expect(JSON.stringify(req?.jsonBody ?? {})).toContain('DeepSeek tools search 2026');

    expect(result.items).toHaveLength(3);
    expect(result.items.map((i) => ({ index: i.index, id: i.id }))).toEqual([
      { index: 1, id: 's1' },
      { index: 2, id: 's2' },
      { index: 3, id: 's3' },
    ]);
    expect(result.items[0].title).toBe('DeepSeek Search API');
    expect(result.items[0].url).toBe('https://platform.deepseek.com/docs/search');
  });

  it('T1-2: Bocha (bocha) 外部搜索协议构造与 webPages.value 解析', async () => {
    router = installMockFetchRouter(serverBaseUrl);
    server.enqueue(
      { method: 'POST', pathname: /\/v1\/web-search|\/search/ },
      {
        kind: 'json',
        body: buildBochaSearchJson([
          { title: '博查 AI 搜索', url: 'https://bochaai.com/docs/api', snippet: '博查摘要', content: '博查详细正文摘要' },
          { title: '中文网页检索', url: 'https://bochaai.com/docs/zh', snippet: '中文优化' },
        ]),
      }
    );

    const result = await runExternalSearch({
      query: '博查 搜索 API',
      service: toRuntimeExternalSearchService({
        id: 'bocha-1',
        kind: 'bocha',
        name: 'Bocha',
        apiKey: 'sk-bocha-e2e-key',
      }),
      maxResults: 5,
    });

    const req = server.getLastRequest({ method: 'POST' });
    expect(req).toBeDefined();
    expect(req?.headers.authorization).toBe('Bearer sk-bocha-e2e-key');
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      index: 1,
      id: 's1',
      title: '博查 AI 搜索',
      url: 'https://bochaai.com/docs/api',
    });
    expect(result.items[0].text.length).toBeGreaterThan(0);
  });

  it('T1-3: Exa (exa) 外部搜索协议构造与 highlights/text 解析', async () => {
    router = installMockFetchRouter(serverBaseUrl);
    server.enqueue(
      { method: 'POST', pathname: '/search' },
      {
        kind: 'json',
        body: buildExaSearchJson([
          { title: 'Exa Neural Search', url: 'https://docs.exa.ai/reference/search', snippet: 'High-precision neural highlight', content: 'Full Exa doc content' },
        ]),
      }
    );

    const result = await runExternalSearch({
      query: 'Exa neural search highlights',
      service: toRuntimeExternalSearchService({
        id: 'exa-1',
        kind: 'exa',
        name: 'Exa',
        apiKey: 'exa-api-key-123',
      }),
      maxResults: 5,
    });

    const req = server.getLastRequest({ method: 'POST', pathname: '/search' });
    expect(req).toBeDefined();
    expect(req?.headers['x-api-key'] ?? req?.headers.authorization).toContain('exa-api-key-123');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      index: 1,
      id: 's1',
      title: 'Exa Neural Search',
      url: 'https://docs.exa.ai/reference/search',
    });
    expect(result.items[0].text).toContain('highlight');
  });

  it('T1-4: SearXNG (searxng) 匿名自托管外部搜索支持（无需 API Key）与 format=json 解析', async () => {
    router = installMockFetchRouter(serverBaseUrl);
    const searxService = toRuntimeExternalSearchService({
      id: 'searx-1',
      kind: 'searxng',
      name: 'SearXNG',
      endpoint: 'https://searx.example.com/search',
    });

    expect(isExternalSearchServiceConfigured(searxService)).toBe(true);

    server.enqueue(
      { method: 'GET', pathname: '/search' },
      {
        kind: 'json',
        body: buildSearxngSearchJson('self-hosted searxng', [
          { title: 'SearXNG Docs', url: 'https://docs.searxng.org/', snippet: 'Privacy-respecting metasearch' },
          { title: 'Search API', url: 'https://docs.searxng.org/dev/search_api.html', snippet: 'JSON format support' },
        ]),
      }
    );

    const result = await runExternalSearch({
      query: 'self-hosted searxng',
      service: searxService,
      maxResults: 5,
    });

    const req = server.getLastRequest({ method: 'GET', pathname: '/search' });
    expect(req).toBeDefined();
    expect(req?.query.q).toBe('self-hosted searxng');
    expect(req?.query.format).toBe('json');
    expect(result.items).toHaveLength(2);
    expect(result.items[0].url).toBe('https://docs.searxng.org/');
  });

  it('T1-5: Tavily & Brave 外部搜索协议回归（answer 清洗与 HTML extra_snippets 剥离去重）', async () => {
    router = installMockFetchRouter(serverBaseUrl);

    // 1) Tavily
    server.enqueue(
      { method: 'POST', pathname: '/search' },
      {
        kind: 'json',
        body: {
          answer: '**总结**[[1]](https://example.com/a) 核心结论已确认。',
          results: [
            { title: 'Tavily Result', url: 'https://example.com/a', content: 'Tavily detailed snippet' },
          ],
        },
      }
    );
    const tavilyRes = await runExternalSearch({
      query: 'Tavily answer test',
      service: { id: 'tav-1', kind: 'tavily', name: 'Tavily', apiKey: 'tvly-e2e-key' },
    });
    const tavReq = server.getLastRequest({ method: 'POST', pathname: '/search' });
    expect(tavReq?.headers.authorization).toBe('Bearer tvly-e2e-key');
    expect((tavReq?.jsonBody as Record<string, unknown>).include_answer).toBe(true);
    expect(tavilyRes.answer).not.toContain('[[1]](');
    expect(tavilyRes.answer).toContain('核心结论已确认');
    expect(tavilyRes.items).toHaveLength(1);

    // 2) Brave
    server.enqueue(
      { method: 'GET', pathname: '/res/v1/web/search' },
      {
        kind: 'json',
        body: {
          web: {
            results: [
              {
                title: 'Brave Web Hit',
                url: 'https://brave.example.com/page',
                description: '<b>Highlighted</b> summary',
                extra_snippets: ['<strong>Extra</strong> detail'],
              },
            ],
          },
          news: {
            results: [
              {
                title: 'Brave News Hit',
                url: 'https://news.example.com/item',
                description: '<i>Breaking</i> news item',
              },
              {
                title: 'Duplicate Web Hit',
                url: 'https://brave.example.com/page',
                description: 'dup',
              },
            ],
          },
        },
      }
    );
    const braveRes = await runExternalSearch({
      query: 'Brave HTML strip',
      service: { id: 'brave-1', kind: 'brave', name: 'Brave', apiKey: 'BSA-e2e-key' },
    });
    const braveReq = server.getLastRequest({ method: 'GET', pathname: '/res/v1/web/search' });
    expect(braveReq?.headers['x-subscription-token']).toBe('BSA-e2e-key');
    expect(braveReq?.query.extra_snippets).toBe('true');
    expect(braveRes.items).toHaveLength(2);
    expect(braveRes.items[0].text).not.toContain('<b>');
    expect(braveRes.items[0].text).not.toContain('<strong>');
    expect(braveRes.items[1].text).not.toContain('<i>');
  });

  it('T1-6: search_web Tool Calling 端到端闭环（经 ProductionProviderAdapterRegistry + ChatRequestExecution）', async () => {
    router = installMockFetchRouter(serverBaseUrl, {
      rewriteRules: [{ match: 'relay.example.com' }],
    });
    harness = await createE2EWorkspaceHarness();

    const model: ModelInfo = {
      id: 'gpt-4.1',
      name: 'GPT-4.1',
      capabilities: ['text', 'tool-calling', 'streaming'],
      source: 'manual',
    };
    await harness.addAndSelectProvider(
      {
        id: 'new-api-relay',
        name: 'Relay',
        kind: 'new-api-relay',
        baseUrl: 'https://relay.example.com/v1',
        apiKey: 'sk-relay-tool-loop',
        capabilities: ['text', 'tool-calling', 'streaming'],
        models: [model],
      },
      model
    );
    await harness.setExternalSearch({
      enabled: true,
      maxResults: 5,
      maxToolRounds: 3,
      selectedServiceId: 'ext-tavily',
      services: [{ id: 'ext-tavily', kind: 'tavily', name: 'Tavily', apiKey: 'tvly-loop-key' }],
    });

    // 1) 第 1 轮模型响应请求 search_web
    server.enqueue(
      { method: 'POST', pathname: '/v1/chat/completions' },
      {
        kind: 'sse',
        chunks: buildOpenAiChatSseChunks({
          model: 'gpt-4.1',
          textDeltas: [],
          toolCalls: [
            {
              index: 0,
              id: 'call_search_1',
              name: 'search_web',
              argumentsJson: '{"query":"Embezzle 2026"}',
            },
          ],
        }),
      }
    );
    // 2) Tavily 返回 2 条结果
    server.enqueue(
      { method: 'POST', pathname: '/search' },
      {
        kind: 'json',
        body: {
          results: [
            { title: 'Embezzle Overview', url: 'https://embezzle.example.com/overview', content: 'Overview 2026' },
            { title: 'Embezzle Changelog', url: 'https://embezzle.example.com/changelog', content: 'Changelog 2026' },
          ],
        },
      }
    );
    // 3) 第 2 轮模型响应给出带引用的最终答案
    server.enqueue(
      { method: 'POST', pathname: '/v1/chat/completions' },
      {
        kind: 'sse',
        chunks: buildOpenAiChatSseChunks({
          model: 'gpt-4.1',
          textDeltas: ['Embezzle Studio 2026 已完成升级 [citation](1:s1)。'],
        }),
      }
    );

    const provider = getProviderFromHarness(harness, 'new-api-relay');
    const rig = createTestExecutionRig(() => harness!.session.getSnapshot());
    const lease = rig.orchestration.begin({ phase: 'provider-request', label: 'f4-t6' })!;
    const execution = new ChatRequestExecution(
      harness.productionAdapterRegistry,
      rig.orchestration,
      rig.host
    );

    const assistantMessage: ChatMessage = {
      id: 'msg-a-f4-t6',
      role: 'assistant',
      content: '',
      createdAt: harness.clock.now(),
      status: 'pending',
      providerId: provider.id,
      modelId: model.id,
    };
    const usageEvent = createStartedProviderUsageEvent({
      id: 'usage-f4-t6',
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
        { id: 'u1', role: 'user', content: '帮我查 Embezzle 2026 情况', createdAt: harness.clock.now(), status: 'ready' },
      ],
      runtime: { provider, model, modelId: model.id, reasoningEffort: 'off' },
      controller: lease.controller,
      usageEvent,
      parameterSettings: defaultParameterSettings,
    });

    expect(outcome.status).toBe('success');

    const chatReqs = server.getRequests({ method: 'POST', pathname: '/v1/chat/completions' });
    expect(chatReqs).toHaveLength(2);
    const req1Body = chatReqs[0].jsonBody as {
      messages: Array<{ role: string; content: string }>;
      tools: Array<{ function: { name: string } }>;
    };
    expect(req1Body.messages[0].role).toBe('system');
    expect(req1Body.messages[0].content).toContain('search_web');
    expect(req1Body.tools.map((t) => t.function.name)).toContain('search_web');

    const req2Body = chatReqs[1].jsonBody as {
      messages: Array<{ role: string; tool_call_id?: string; content?: string; tool_calls?: unknown[] }>;
    };
    expect(req2Body.messages.some((m) => m.role === 'assistant' && Array.isArray(m.tool_calls))).toBe(true);
    const toolMsg = req2Body.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'call_search_1');
    expect(toolMsg?.content).toContain('s1');
    expect(toolMsg?.content).toContain('s2');

    // 验证 ChatRequestExecution 正确更新第 2 次 providerRequestCount
    expect(rig.persistedUsageEvents.at(-1)?.providerRequestCount).toBe(2);

    const readyPatch = rig.messagePatches.find((p) => p.patch.status === 'ready');
    expect(readyPatch?.patch.webSearchTriggered).toBe(true);
    expect(readyPatch?.patch.citations).toHaveLength(2);
    expect(readyPatch?.patch.toolActivity?.[0]).toMatchObject({
      toolName: 'search_web',
      status: 'completed',
      summary: '返回 2 条结果',
    });
    expect(readyPatch?.patch.activityTimeline?.length).toBeGreaterThanOrEqual(1);
    expect(rig.usageFinishes.at(-1)?.status).toBe('succeeded');
  });

  it('T1-7: 多轮 search_web 结果重排 reindexExternalSearchResult、maxToolRounds 收尾与内联引用一致性', async () => {
    router = installMockFetchRouter(serverBaseUrl, {
      rewriteRules: [{ match: 'relay.example.com' }],
    });
    harness = await createE2EWorkspaceHarness();

    // 验证纯函数重排偏移
    const firstBatch = reindexExternalSearchResult(
      {
        items: [
          { index: 1, id: 's1', title: 'A', url: 'https://a.example.com', text: 'ta' },
          { index: 2, id: 's2', title: 'B', url: 'https://b.example.com', text: 'tb' },
        ],
      },
      0
    );
    const secondBatch = reindexExternalSearchResult(
      {
        items: [
          { index: 1, id: 's1', title: 'C', url: 'https://c.example.com', text: 'tc' },
          { index: 2, id: 's2', title: 'D', url: 'https://d.example.com', text: 'td' },
        ],
      },
      2
    );
    expect(secondBatch.items.map((i) => ({ index: i.index, id: i.id }))).toEqual([
      { index: 3, id: 's3' },
      { index: 4, id: 's4' },
    ]);
    const mergedCitations = citationsFromExternalSearchResults([firstBatch, secondBatch]);
    expect(resolveMessageMarkdownLink('1:s1', mergedCitations)).toBe('https://a.example.com/');
    expect(resolveMessageMarkdownLink('3:s3', mergedCitations)).toBe('https://c.example.com/');

    // 端到端 maxToolRounds: 2 触发第 3 次无 tools 强制收尾
    const model: ModelInfo = {
      id: 'gpt-4.1',
      name: 'GPT-4.1',
      capabilities: ['text', 'tool-calling', 'streaming'],
      source: 'manual',
    };
    await harness.addAndSelectProvider(
      {
        id: 'new-api-relay',
        name: 'Relay',
        kind: 'new-api-relay',
        baseUrl: 'https://relay.example.com/v1',
        apiKey: 'sk-relay-multi-round',
        capabilities: ['text', 'tool-calling', 'streaming'],
        models: [model],
      },
      model
    );
    const provider = getProviderFromHarness(harness, 'new-api-relay');
    const adapter = harness.productionAdapterRegistry.resolve({ provider, modelId: model.id, model }, 'chat');

    server.enqueue(
      { method: 'POST', pathname: '/v1/chat/completions' },
      {
        kind: 'sse',
        chunks: buildOpenAiChatSseChunks({
          textDeltas: [],
          toolCalls: [{ index: 0, id: 'c1', name: 'search_web', argumentsJson: '{"query":"query 1"}' }],
        }),
      }
    );
    server.enqueue(
      { method: 'POST', pathname: '/search' },
      {
        kind: 'json',
        body: {
          results: [
            { title: 'R1-A', url: 'https://r1.example.com/a', content: 'A' },
            { title: 'R1-B', url: 'https://r1.example.com/b', content: 'B' },
          ],
        },
      }
    );
    server.enqueue(
      { method: 'POST', pathname: '/v1/chat/completions' },
      {
        kind: 'sse',
        chunks: buildOpenAiChatSseChunks({
          textDeltas: [],
          toolCalls: [{ index: 0, id: 'c2', name: 'search_web', argumentsJson: '{"query":"query 2"}' }],
        }),
      }
    );
    server.enqueue(
      { method: 'POST', pathname: '/search' },
      {
        kind: 'json',
        body: {
          results: [
            { title: 'R2-C', url: 'https://r2.example.com/c', content: 'C' },
            { title: 'R2-D', url: 'https://r2.example.com/d', content: 'D' },
          ],
        },
      }
    );
    // 第 3 笔模型强制收尾响应（不再带 tools）
    server.enqueue(
      { method: 'POST', pathname: '/v1/chat/completions' },
      {
        kind: 'sse',
        chunks: buildOpenAiChatSseChunks({
          textDeltas: ['综合结论 [1](1:s1) 与 [3](3:s3)。'],
        }),
      }
    );

    const res = await adapter.run({
      provider,
      modelId: model.id,
      model,
      messages: [{ id: 'u1', role: 'user', content: '多轮检索测试', createdAt: harness.clock.now(), status: 'ready' }],
      reasoningEffort: 'off',
      parameterSettings: defaultParameterSettings,
      externalSearch: {
        enabled: true,
        maxResults: 5,
        maxToolRounds: 2,
        selectedServiceId: 'tav1',
        services: [{ id: 'tav1', kind: 'tavily', name: 'Tavily', apiKey: 'tvly-round' }],
      },
    });

    const chatReqs = server.getRequests({ method: 'POST', pathname: '/v1/chat/completions' });
    expect(chatReqs).toHaveLength(3);
    const finalReqBody = chatReqs[2].jsonBody as { tools?: unknown };
    expect(finalReqBody.tools).toBeUndefined();

    expect(res.citations?.map((c) => `${c.index}:${c.id}`)).toEqual(['1:s1', '2:s2', '3:s3', '4:s4']);
    expect(resolveMessageMarkdownLink('1:s1', res.citations)).toBe('https://r1.example.com/a');
    expect(resolveMessageMarkdownLink('3:s3', res.citations)).toBe('https://r2.example.com/c');
    expect(res.toolActivity).toHaveLength(2);
  });

  // =========================================================================
  // Tier 2：Boundary / Corner / Error Handling（7 个错误隔离与安全边界用例）
  // =========================================================================

  it('T2-1: 外部搜索 Key 缺失、禁用门禁及密钥脱敏剥离校验', async () => {
    router = installMockFetchRouter(serverBaseUrl);
    harness = await createE2EWorkspaceHarness();

    const needsKeyKinds: E2EExternalSearchProviderKind[] = ['tavily', 'brave', 'bocha', 'exa', 'deepseek'];
    for (const kind of needsKeyKinds) {
      await expect(
        runExternalSearch({
          query: 'no key test',
          service: toRuntimeExternalSearchService({ id: `id-${kind}`, kind, name: kind }),
        })
      ).rejects.toThrow(/API Key|密钥|apiKey/i);
    }
    expect(server.getRequests()).toHaveLength(0);

    // enabled: false 时走普通对话，不注入 tools 也不触发搜索
    const model: ModelInfo = {
      id: 'gpt-4.1',
      name: 'GPT-4.1',
      capabilities: ['text', 'tool-calling', 'streaming'],
      source: 'manual',
    };
    await harness.addAndSelectProvider(
      {
        id: 'openai',
        name: 'OpenAI',
        kind: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-disabled-ext',
        capabilities: ['text', 'tool-calling', 'streaming'],
        models: [model],
      },
      model
    );
    server.enqueue(
      { method: 'POST', pathname: '/v1/chat/completions' },
      { kind: 'sse', chunks: buildOpenAiChatSseChunks({ textDeltas: ['普通对话回复'] }) }
    );
    const openai = getProviderFromHarness(harness, 'openai');
    await harness.productionAdapterRegistry
      .resolve({ provider: openai, modelId: model.id, model }, 'chat')
      .run({
        provider: openai,
        modelId: model.id,
        model,
        messages: [{ id: 'u1', role: 'user', content: 'hi', createdAt: 1, status: 'ready' }],
        reasoningEffort: 'off',
        externalSearch: {
          enabled: false,
          maxResults: 5,
          maxToolRounds: 2,
          selectedServiceId: 'tav',
          services: [{ id: 'tav', kind: 'tavily', name: 'Tavily', apiKey: 'tvly-secret-key' }],
        },
      });
    const chatReq = server.getLastRequest({ pathname: '/v1/chat/completions' });
    expect((chatReq?.jsonBody as { tools?: unknown }).tools).toBeUndefined();
    expect(server.getRequests({ pathname: '/search' })).toHaveLength(0);

    // stripExternalSearchSecrets 脱敏
    const stripped = stripExternalSearchSecrets(
      toRuntimeExternalSearchSettings({
        enabled: true,
        maxResults: 5,
        maxToolRounds: 2,
        selectedServiceId: 'tav',
        services: [{ id: 'tav', kind: 'tavily', name: 'Tavily', apiKey: 'tvly-super-secret' }],
      })
    );
    expect(JSON.stringify(stripped)).not.toContain('tvly-super-secret');
    expect(stripped.services[0].apiKey).toBeUndefined();
  });

  it('T2-2: 搜索服务 502、HTML 错误页与网络超时在 Tool Calling 闭环中应容错隔离并降级完成', async () => {
    router = installMockFetchRouter(serverBaseUrl);
    harness = await createE2EWorkspaceHarness();

    const model: ModelInfo = {
      id: 'gpt-4.1',
      name: 'GPT-4.1',
      capabilities: ['text', 'tool-calling', 'streaming'],
      source: 'manual',
    };
    await harness.addAndSelectProvider(
      {
        id: 'openai',
        name: 'OpenAI',
        kind: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-ext-fault-t2',
        capabilities: ['text', 'tool-calling', 'streaming'],
        models: [model],
      },
      model
    );
    const provider = getProviderFromHarness(harness, 'openai');
    const adapter = harness.productionAdapterRegistry.resolve({ provider, modelId: model.id, model }, 'chat');

    // 1) Tool loop 内搜索返回 502，主模型第 2 轮顺利降级回复
    server.enqueue(
      { method: 'POST', pathname: '/v1/chat/completions' },
      {
        kind: 'sse',
        chunks: buildOpenAiChatSseChunks({
          textDeltas: [],
          toolCalls: [{ index: 0, id: 'c_502', name: 'search_web', argumentsJson: '{"query":"status 502"}' }],
        }),
      }
    );
    server.enqueue(
      { method: 'POST', pathname: '/search' },
      { kind: 'error', status: 502, body: 'Bad Gateway' }
    );
    server.enqueue(
      { method: 'POST', pathname: '/v1/chat/completions' },
      {
        kind: 'sse',
        chunks: buildOpenAiChatSseChunks({ textDeltas: ['搜索服务暂时不可用，以下为离线解答。'] }),
      }
    );

    const res502 = await adapter.run({
      provider,
      modelId: model.id,
      model,
      messages: [{ id: 'u1', role: 'user', content: '查最新情况', createdAt: 1, status: 'ready' }],
      reasoningEffort: 'off',
      externalSearch: {
        enabled: true,
        maxResults: 5,
        maxToolRounds: 2,
        selectedServiceId: 'tav',
        services: [{ id: 'tav', kind: 'tavily', name: 'Tavily', apiKey: 'tvly-502' }],
      },
    });
    expect(res502.content).toContain('离线解答');
    expect(res502.webSearchTriggered).toBe(false);
    expect(res502.citations).toEqual([]);
    expect(res502.toolActivity?.[0]?.status).toBe('failed');
    const secondModelReq = server.getRequests({ pathname: '/v1/chat/completions' })[1];
    const toolMsg = (secondModelReq.jsonBody as { messages: Array<{ role: string; content: string }> }).messages.find(
      (m) => m.role === 'tool'
    );
    expect(toolMsg?.content).toContain('"error"');

    // 2) 搜索直接返回 HTML 登录页
    server.enqueue(
      { method: 'POST', pathname: '/search' },
      { kind: 'text', status: 200, headers: { 'Content-Type': 'text/html' }, body: '<html>WAF Block</html>' }
    );
    await expect(
      runExternalSearch({
        query: 'html error',
        service: { id: 'tav', kind: 'tavily', name: 'Tavily', apiKey: 'tvly-html' },
      })
    ).rejects.toThrow(/JSON|HTML|502|格式|解析/i);

    // 3) 真实网络超时（runExternalSearch 将 timeoutMs 钳位下限为 3000ms，Mock 延迟 3800ms 预留 800ms 裕度触发内置超时）
    server.enqueue(
      { method: 'POST', pathname: '/search' },
      { kind: 'json', delayMs: 3800, body: { results: [] } }
    );
    await expect(
      runExternalSearch({
        query: 'timeout query',
        service: { id: 'tav', kind: 'tavily', name: 'Tavily', apiKey: 'tvly-timeout' },
        timeoutMs: 3000,
      })
    ).rejects.toThrow(/超时|timeout|abort/i);
  });

  it('T2-3: 空查询、超长查询、特殊字符 URL 编码及未知/畸形工具调用拦截', async () => {
    router = installMockFetchRouter(serverBaseUrl);
    harness = await createE2EWorkspaceHarness();

    await expect(
      runExternalSearch({
        query: '   ',
        service: { id: 'tav', kind: 'tavily', name: 'Tavily', apiKey: 'tvly-empty' },
      })
    ).rejects.toThrow(/不能为空/);

    await expect(
      runExternalSearch({
        query: 'a'.repeat(501),
        service: { id: 'tav', kind: 'tavily', name: 'Tavily', apiKey: 'tvly-long' },
      })
    ).rejects.toThrow(/过长/);

    // 特殊字符 GET 请求编码验证（Brave / SearXNG）
    const specialQuery = 'C++ & Rust? #2026 中文';
    server.enqueue(
      { method: 'GET', pathname: '/res/v1/web/search' },
      { kind: 'json', body: { web: { results: [] } } }
    );
    await runExternalSearch({
      query: specialQuery,
      service: { id: 'brave', kind: 'brave', name: 'Brave', apiKey: 'BSA-encode' },
    });
    const braveReq = server.getLastRequest({ pathname: '/res/v1/web/search' });
    expect(braveReq?.query.q).toBe(specialQuery);
    expect(braveReq?.url).toContain('%2B');
    expect(braveReq?.url).toContain('%26');

    // parseSearchWebToolArguments 边界
    expect(() => parseSearchWebToolArguments('')).toThrow(/缺少 query|query/i);
    expect(() => parseSearchWebToolArguments({})).toThrow(/参数无效|query/i);
    expect(parseSearchWebToolArguments('plain text query')).toBe('plain text query');
    expect(parseSearchWebToolArguments('{"query": "valid"}')).toBe('valid');

    // Tool Loop 中模型请求未知工具 delete_file，绝不执行且回传 error
    const model: ModelInfo = {
      id: 'gpt-4.1',
      name: 'GPT-4.1',
      capabilities: ['text', 'tool-calling', 'streaming'],
      source: 'manual',
    };
    await harness.addAndSelectProvider(
      {
        id: 'openai',
        name: 'OpenAI',
        kind: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-unknown-tool',
        capabilities: ['text', 'tool-calling', 'streaming'],
        models: [model],
      },
      model
    );
    server.enqueue(
      { method: 'POST', pathname: '/v1/chat/completions' },
      {
        kind: 'sse',
        chunks: buildOpenAiChatSseChunks({
          textDeltas: [],
          toolCalls: [{ index: 0, id: 'bad_call_1', name: 'delete_file', argumentsJson: '{"path":"/"}' }],
        }),
      }
    );
    server.enqueue(
      { method: 'POST', pathname: '/v1/chat/completions' },
      { kind: 'sse', chunks: buildOpenAiChatSseChunks({ textDeltas: ['已忽略不支持的工具。'] }) }
    );
    const openai = getProviderFromHarness(harness, 'openai');
    const res = await harness.productionAdapterRegistry
      .resolve({ provider: openai, modelId: model.id, model }, 'chat')
      .run({
        provider: openai,
        modelId: model.id,
        model,
        messages: [{ id: 'u1', role: 'user', content: 'bad tool', createdAt: 1, status: 'ready' }],
        reasoningEffort: 'off',
        externalSearch: {
          enabled: true,
          maxResults: 5,
          maxToolRounds: 2,
          selectedServiceId: 'tav',
          services: [{ id: 'tav', kind: 'tavily', name: 'Tavily', apiKey: 'tvly-tool' }],
        },
      });
    expect(res.toolActivity?.[0]?.status).toBe('failed');
    expect(server.getRequests({ pathname: '/search' })).toHaveLength(0);
  });

  it('T2-4: maxResults 边界裁剪、重复 URL 合并与弱标题/不安全 URL 净化', async () => {
    router = installMockFetchRouter(serverBaseUrl);
    const normalized = normalizeExternalSearchSettings({
      enabled: true,
      maxResults: 99,
      maxToolRounds: 0,
      services: [{ id: 'tav', kind: 'tavily', name: 'Tavily', apiKey: 'tvly-1' }],
    });
    expect(normalized.maxResults).toBe(10);
    expect(normalized.maxToolRounds).toBe(1);

    server.enqueue(
      { method: 'POST', pathname: '/search' },
      {
        kind: 'json',
        body: {
          results: [
            { title: 'Insecure HTTP', url: 'http://insecure.example.com/a', content: 'drop' },
            { title: 'Local IP', url: 'https://127.0.0.1/internal', content: 'drop' },
            { title: '1', url: 'https://docs.example.com/getting-started', content: 'weak numeric title' },
            { title: '[2]', url: 'https://api.example.org/release-notes', content: 'weak bracket title' },
            { title: 'Duplicate 1', url: 'https://api.example.org/release-notes', content: 'dup' },
            { title: 'Valid Three', url: 'https://third.example.net/guide', content: 'ok 3' },
            { title: 'Valid Four', url: 'https://fourth.example.net/guide', content: 'ok 4' },
          ],
        },
      }
    );

    const res = await runExternalSearch({
      query: 'sanitize and slice',
      service: { id: 'tav', kind: 'tavily', name: 'Tavily', apiKey: 'tvly-slice' },
      maxResults: 3,
    });

    expect(res.items).toHaveLength(3);
    expect(res.items.map((i) => i.index)).toEqual([1, 2, 3]);
    expect(res.items[0].title).not.toBe('1');
    expect(res.items[0].title.toLowerCase()).toContain('getting started');
    expect(res.items[1].title).not.toBe('[2]');
    expect(res.items.every((i) => i.url.startsWith('https://'))).toBe(true);
  });

  it('T2-5: 私网 / 本地 / 非 HTTPS 自定义 endpoint 防 SSRF 边界应 0 请求拦截', async () => {
    router = installMockFetchRouter(serverBaseUrl);
    const badEndpoints = [
      'https://10.0.0.1/search',
      'https://127.0.0.1/search',
      'https://localhost/search',
      'http://api.tavily.com/search',
      'https://user:pass@api.tavily.com/search',
      'https://api.tavily.com/search?k=1',
    ];

    for (const endpoint of badEndpoints) {
      await expect(
        runExternalSearch({
          query: 'ssrf probe',
          service: { id: 'tav', kind: 'tavily', name: 'Tavily', apiKey: 'tvly-ssrf', endpoint },
        })
      ).rejects.toThrow(/Endpoint|HTTPS|私网|本机/i);
    }

    expect(server.getRequests()).toHaveLength(0);
  });

  it('T2-6: 响应体积超限 (>5MiB)、缺 tool-calling / API Key、Responses-only 互斥与 AbortSignal 中止', async () => {
    router = installMockFetchRouter(serverBaseUrl);
    harness = await createE2EWorkspaceHarness();

    // 1) Content-Length > 5 MiB 被立即拒绝
    server.enqueue(
      { method: 'POST', pathname: '/search' },
      {
        kind: 'json',
        headers: { 'Content-Length': String(6 * 1024 * 1024) },
        body: { results: [] },
      }
    );
    await expect(
      runExternalSearch({
        query: 'huge payload',
        service: { id: 'tav', kind: 'tavily', name: 'Tavily', apiKey: 'tvly-huge' },
      })
    ).rejects.toThrow(/过大/);

    const validExt: ExternalSearchSettings = {
      enabled: true,
      maxResults: 5,
      maxToolRounds: 2,
      selectedServiceId: 'tav',
      services: [{ id: 'tav', kind: 'tavily', name: 'Tavily', apiKey: 'tvly-guard' }],
    };

    // 2) 主模型无 tool-calling 能力
    const noToolModel: ModelInfo = { id: 'gpt-no-tool', name: 'No Tool', capabilities: ['text', 'streaming'], source: 'manual' };
    const openai: ProviderProfile = {
      id: 'openai',
      name: 'OpenAI',
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-ok',
      capabilities: ['text', 'streaming'],
      models: [noToolModel],
    };
    const adapter = harness.productionAdapterRegistry.resolve({ provider: openai, modelId: noToolModel.id, model: noToolModel }, 'chat');
    await expect(
      adapter.run({
        provider: openai,
        modelId: noToolModel.id,
        model: noToolModel,
        messages: [{ id: 'u1', role: 'user', content: 'hi', createdAt: 1, status: 'ready' }],
        reasoningEffort: 'off',
        externalSearch: validExt,
      })
    ).rejects.toThrow(/tool-calling/);

    // 3) 主服务商无 API Key
    const toolModel: ModelInfo = { id: 'gpt-4.1', name: 'GPT-4.1', capabilities: ['text', 'tool-calling', 'streaming'], source: 'manual' };
    await expect(
      adapter.run({
        provider: { ...openai, apiKey: '' },
        modelId: toolModel.id,
        model: toolModel,
        messages: [{ id: 'u1', role: 'user', content: 'hi', createdAt: 1, status: 'ready' }],
        reasoningEffort: 'off',
        externalSearch: validExt,
      })
    ).rejects.toThrow(/API Key/);

    // 4) Responses-only 模型 (gpt-5-pro) 开启外部搜索拦截
    const proModel: ModelInfo = { id: 'gpt-5-pro', name: 'GPT-5 Pro', capabilities: ['text', 'tool-calling', 'streaming'], source: 'preset' };
    await expect(
      adapter.run({
        provider: openai,
        modelId: proModel.id,
        model: proModel,
        messages: [{ id: 'u1', role: 'user', content: 'hi', createdAt: 1, status: 'ready' }],
        reasoningEffort: 'off',
        externalSearch: validExt,
      })
    ).rejects.toThrow(/Responses-only|暂不支持外部/);

    expect(server.getRequests({ pathname: '/v1/chat/completions' })).toHaveLength(0);

    // 5) 工具等待期触发 AbortSignal
    server.enqueue(
      { method: 'POST', pathname: '/search' },
      { kind: 'json', delayMs: 500, body: { results: [] } }
    );
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 30);
    try {
      await expect(
        runExternalSearch({
          query: 'abort during wait',
          service: { id: 'tav', kind: 'tavily', name: 'Tavily', apiKey: 'tvly-abort' },
          signal: controller.signal,
        })
      ).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      clearTimeout(abortTimer);
    }
  });

  it('T2-7: 内联引用解析器 resolveMessageMarkdownLink 安全与边界矩阵校验', () => {
    const citations = [
      { id: 's1', index: 1, url: 'https://example.com/one', title: 'One' },
      { id: 's2', index: 2, url: 'https://example.com/two', title: 'Two' },
    ];

    expect(resolveMessageMarkdownLink('1:s1', citations)).toBe('https://example.com/one');
    expect(resolveMessageMarkdownLink('2:wrong_id', citations)).toBeNull();
    expect(resolveMessageMarkdownLink('0:s1', citations)).toBeNull();
    expect(resolveMessageMarkdownLink('-1:s1', citations)).toBeNull();
    expect(resolveMessageMarkdownLink('https://example.com/ok', citations)).toBe('https://example.com/ok');
    expect(resolveMessageMarkdownLink('http://example.com/bad', citations)).toBeNull();
    expect(resolveMessageMarkdownLink('intent://open', citations)).toBeNull();
    expect(resolveMessageMarkdownLink('javascript:alert(1)', citations)).toBeNull();
    expect(resolveMessageMarkdownLink('https://127.0.0.1/x', citations)).toBeNull();
  });
});
