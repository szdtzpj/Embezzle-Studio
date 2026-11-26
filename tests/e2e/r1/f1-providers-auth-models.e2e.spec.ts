/**
 * F1 E2E 端到端测试：主流模型接入、协议路由、Auth 策略、自定义 Headers 与模型能力发现。
 * 覆盖需求：ORIGINAL_REQUEST §R1 & PROJECT.md Features #2–#8。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createDefaultWorkspace, defaultProviders } from '../../../src/data/providerCatalog';
import type { ProviderProfile } from '../../../src/domain/types';
import { inferModelTask } from '../../../src/services/modelCapabilities';
import { refreshProviderModels } from '../../../src/services/modelDiscovery';
import { fetchOpenAiCompatibleModels } from '../../../src/services/openAiCompatible';
import { classifyProviderConnectionError } from '../../../src/services/providerDiagnostics';
import {
  buildModelCapabilityMatrixRow,
  buildModelDiscoveryRequest,
  compareProviderEndpointBinding,
  inspectProviderEndpoint,
  isExactOfficialAnthropicProvider,
  isExactOfficialDeepSeekProvider,
  isExactOfficialGeminiProvider,
  isExactOfficialOpenAiProvider,
  isExactOfficialXaiProvider,
  isRelayOrCustomProvider,
  parseDiscoveredModelsPayload,
  resolveProviderAuthHeaders,
} from '../../../src/services/providerSetup';
import {
  createE2EWorkspaceHarness,
  installMockFetchRouter,
  type E2EWorkspaceHarness,
  type InstalledMockFetchRouter,
} from '../helpers/e2eWorkspaceHarness';
import { createMockUpstreamServer, type MockUpstreamServer } from '../helpers/mockUpstreamServer';

function createProviderFixture(overrides: Partial<ProviderProfile>): ProviderProfile {
  return {
    id: 'test-provider',
    name: 'Test Provider',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-e2e-secret-token-1234',
    capabilities: ['text', 'image-input', 'tool-calling', 'reasoning', 'web-search', 'streaming'],
    models: [],
    ...overrides,
  };
}

describe('F1 — 主流模型接入、协议路由、Auth/Headers 与模型发现 E2E', () => {
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
  // Tier 1：Happy Path（7 个端到端隔离用例）
  // =========================================================================

  it('T1-1: 预置 9 大官方与中转服务商目录及 2026 模型家族应完整加载入工作区', async () => {
    harness = await createE2EWorkspaceHarness();
    const workspace = createDefaultWorkspace();
    const snapshot = harness.session.getSnapshot();

    expect(defaultProviders).toHaveLength(9);
    expect(snapshot.providers.map((p) => p.id)).toEqual(
      expect.arrayContaining([
        'volcengine-ark',
        'bailian-compatible',
        'openai',
        'anthropic',
        'gemini',
        'xai-grok',
        'deepseek',
        'new-api-relay',
        'custom-openai',
      ])
    );

    const byId = new Map(workspace.providers.map((p) => [p.id, p]));

    // 验证官方服务商默认鉴权与生图模式契约
    const openai = byId.get('openai');
    expect(openai?.kind).toBe('openai-compatible');
    expect(openai?.authHeaderMode).toBe('bearer');
    expect(openai?.models.map((m) => m.id)).toEqual(
      expect.arrayContaining(['gpt-6.2-astra', 'gpt-5.5', 'gpt-5.4', 'gpt-4.1', 'o3', 'o4-mini', 'gpt-image-2.5-sunburst'])
    );
    const gptImage = openai?.models.find((m) => m.id === 'gpt-image-2.5-sunburst');
    expect(gptImage ? inferModelTask(gptImage) : undefined).toBe('image-generation');

    const anthropic = byId.get('anthropic');
    expect(anthropic?.kind).toBe('anthropic');
    expect(anthropic?.authHeaderMode).toBe('x-api-key');
    expect(anthropic?.imageApiMode).toBe('unsupported');
    expect(anthropic?.models.map((m) => m.id)).toEqual(
      expect.arrayContaining(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-2', 'claude-sonnet-4-6'])
    );

    const gemini = byId.get('gemini');
    expect(gemini?.kind).toBe('gemini');
    expect(gemini?.authHeaderMode).toBe('x-goog-api-key');
    expect(gemini?.imageApiMode).toBe('gemini-generate-content');
    expect(gemini?.models.map((m) => m.id)).toEqual(
      expect.arrayContaining(['gemini-3.8-flash', 'gemini-3.1-pro', 'gemini-2.5-pro', 'gemini-3.1-flash-image'])
    );

    const grok = byId.get('xai-grok');
    expect(grok?.kind).toBe('xai-grok');
    expect(grok?.authHeaderMode).toBe('bearer');
    expect(grok?.imageApiMode).toBe('xai-json');
    expect(grok?.models.map((m) => m.id)).toEqual(
      expect.arrayContaining(['grok-4.7', 'grok-4.3', 'grok-4.5', 'grok-imagine-image-2.0'])
    );

    const deepseek = byId.get('deepseek');
    expect(deepseek?.kind).toBe('deepseek');
    expect(deepseek?.models.map((m) => m.id)).toEqual(
      expect.arrayContaining(['deepseek-flash', 'deepseek-v4-pro'])
    );
  });

  it('T1-2: 官方服务商端点规范化与精确主机判定应正确识别动作后缀与中转边界', () => {
    const openAiRes = inspectProviderEndpoint('https://api.openai.com/v1/responses/', { kind: 'openai-compatible' });
    expect(openAiRes.valid).toBe(true);
    expect(openAiRes.official).toBe(true);
    expect(openAiRes.normalizedBaseUrl).toBe('https://api.openai.com/v1');
    expect(isExactOfficialOpenAiProvider({ kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1/responses/' })).toBe(true);

    const anthropicRes = inspectProviderEndpoint('https://api.anthropic.com/v1/messages/', { kind: 'anthropic' });
    expect(anthropicRes.valid).toBe(true);
    expect(anthropicRes.normalizedBaseUrl).toBe('https://api.anthropic.com/v1');
    expect(isExactOfficialAnthropicProvider({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1/messages/' })).toBe(true);

    const geminiRes = inspectProviderEndpoint('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
      kind: 'gemini',
    });
    expect(geminiRes.valid).toBe(true);
    expect(geminiRes.normalizedBaseUrl).toBe('https://generativelanguage.googleapis.com/v1beta');
    expect(isExactOfficialGeminiProvider({ kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions' })).toBe(true);

    expect(isExactOfficialXaiProvider({ kind: 'xai-grok', baseUrl: 'https://api.x.ai/v1/responses' })).toBe(true);
    expect(isExactOfficialDeepSeekProvider({ kind: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic/v1/messages' })).toBe(true);

    // 火山方舟与阿里百炼业务空间均应识别为官方且非中转
    expect(isRelayOrCustomProvider({ kind: 'volcengine-ark', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' })).toBe(false);
    const bailianWs = inspectProviderEndpoint('https://ws1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', {
      kind: 'bailian-compatible',
    });
    expect(bailianWs.valid).toBe(true);
    expect(bailianWs.official).toBe(true);
    expect(bailianWs.workspaceId).toBe('ws1');
    expect(isRelayOrCustomProvider({ kind: 'bailian-compatible', baseUrl: 'https://ws1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' })).toBe(false);

    // 中转站点与 custom 均应视为 Relay/Custom
    expect(isRelayOrCustomProvider({ kind: 'new-api-relay', baseUrl: 'https://your-relay.example.com/v1' })).toBe(true);
    expect(isRelayOrCustomProvider({ kind: 'custom', baseUrl: 'https://api.openai.com/v1' })).toBe(true);
  });

  it('T1-3: authHeaderMode 与 customHeaders 应在本地计算及真实 /models HTTP 请求中准确发送', async () => {
    const anthropicProvider = createProviderFixture({
      id: 'anthropic',
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-e2e-key',
      authHeaderMode: 'auto',
      customHeaders: [
        { key: 'X-Tenant-Tag', value: 'studio-e2e', enabled: true },
        { key: 'X-Disabled-Tag', value: 'should-not-send', enabled: false },
      ],
    });

    // 先核对纯函数构造契约
    const resolvedAntHeaders = resolveProviderAuthHeaders(anthropicProvider);
    expect(resolvedAntHeaders['x-api-key']).toBe('sk-ant-e2e-key');
    expect(resolvedAntHeaders['anthropic-version']).toBe('2023-06-01');
    expect(resolvedAntHeaders.Authorization).toBeUndefined();
    expect(resolvedAntHeaders['X-Tenant-Tag']).toBe('studio-e2e');
    expect(resolvedAntHeaders['X-Disabled-Tag']).toBeUndefined();

    const geminiProvider = createProviderFixture({
      id: 'gemini',
      kind: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'AIzaSy-e2e-gemini-key',
      authHeaderMode: 'auto',
    });
    const geminiDiscReq = buildModelDiscoveryRequest(geminiProvider);
    expect(geminiDiscReq.headers['x-goog-api-key']).toBe('AIzaSy-e2e-gemini-key');
    expect(geminiDiscReq.url).not.toContain('AIzaSy-e2e-gemini-key');

    const customAuthProvider = createProviderFixture({
      id: 'custom-auth-relay',
      kind: 'new-api-relay',
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'sk-relay-unused-default',
      authHeaderMode: 'custom',
      customHeaders: [
        { key: 'X-Gateway-Auth', value: 'custom-token-999', enabled: true },
        { key: 'X-Skip-Me', value: 'disabled', enabled: false },
      ],
    });
    const customHeadersResolved = resolveProviderAuthHeaders(customAuthProvider);
    expect(customHeadersResolved.Authorization).toBeUndefined();
    expect(customHeadersResolved['X-Gateway-Auth']).toBe('custom-token-999');

    // 再通过公开入口 refreshProviderModels 发起真实 HTTP 请求，验证实际携带了正确鉴权头与 customHeaders
    router = installMockFetchRouter(serverBaseUrl, {
      rewriteRules: [{ match: 'relay.example.com' }],
    });

    server.on({ method: 'GET', pathname: '/v1/models' }, (req) => {
      if (req.headers['x-api-key'] === 'sk-ant-e2e-key') {
        return {
          kind: 'json',
          body: { data: [{ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' }] },
        };
      }
      if (req.headers['x-gateway-auth'] === 'custom-token-999') {
        return {
          kind: 'json',
          body: { data: [{ id: 'gpt-4.1' }] },
        };
      }
      return {
        kind: 'error',
        status: 401,
        body: { error: { message: 'missing expected auth headers' } },
      };
    });

    server.on({ method: 'GET', pathname: '/v1beta/models' }, (req) => {
      if (req.headers['x-goog-api-key'] === 'AIzaSy-e2e-gemini-key') {
        return {
          kind: 'json',
          body: {
            models: [
              {
                name: 'models/gemini-3.8-flash',
                displayName: 'Gemini 3.8 Flash',
                inputTokenLimit: 1048576,
              },
            ],
          },
        };
      }
      return {
        kind: 'error',
        status: 401,
        body: { error: { message: 'missing x-goog-api-key header' } },
      };
    });

    const antRes = await refreshProviderModels(anthropicProvider);
    expect(antRes.models.map((m) => m.id)).toContain('claude-sonnet-5-5');
    const antReq = server.getLastRequest({ pathname: '/v1/models' });
    expect(antReq?.headers['x-api-key']).toBe('sk-ant-e2e-key');
    expect(antReq?.headers['anthropic-version']).toBe('2023-06-01');
    expect(antReq?.headers.authorization).toBeUndefined();
    expect(antReq?.headers['x-tenant-tag']).toBe('studio-e2e');
    expect(antReq?.headers['x-disabled-tag']).toBeUndefined();

    const geminiRes = await refreshProviderModels(geminiProvider);
    expect(geminiRes.models.map((m) => m.id)).toContain('gemini-3.8-flash');
    const geminiReq = server.getLastRequest({ pathname: '/v1beta/models' });
    expect(geminiReq?.headers['x-goog-api-key']).toBe('AIzaSy-e2e-gemini-key');
    expect(geminiReq?.headers.authorization).toBeUndefined();
    expect(geminiReq?.query.key).toBeUndefined();

    const customRes = await refreshProviderModels(customAuthProvider);
    expect(customRes.models.map((m) => m.id)).toContain('gpt-4.1');
    const relayReq = server.getLastRequest({ pathname: '/v1/models' });
    expect(relayReq?.headers.authorization).toBeUndefined();
    expect(relayReq?.headers['x-gateway-auth']).toBe('custom-token-999');
    expect(relayReq?.headers['x-skip-me']).toBeUndefined();
  });

  it('T1-4: OpenAI / xAI / DeepSeek /v1/models 端到端探测应准确识别 2026 模型与旧别名', async () => {
    router = installMockFetchRouter(serverBaseUrl);

    server.enqueue(
      { method: 'GET', pathname: '/v1/models' },
      {
        kind: 'json',
        body: {
          data: [
            { id: 'gpt-6.2-astra' },
            { id: 'gpt-5.5' },
            { id: 'gpt-image-2.5-sunburst' },
            { id: 'o3' },
            { id: 'gpt-4.1' },
          ],
        },
      }
    );
    server.enqueue(
      { method: 'GET', pathname: '/v1/models' },
      {
        kind: 'json',
        body: {
          data: [
            { id: 'grok-4.7' },
            { id: 'grok-imagine-image-2.0' },
          ],
        },
      }
    );
    server.enqueue(
      { method: 'GET', pathname: '/v1/models' },
      {
        kind: 'json',
        body: {
          data: [
            { id: 'deepseek-v4-pro' },
            { id: 'deepseek-flash' },
            { id: 'deepseek-chat' },
            { id: 'deepseek-reasoner' },
          ],
        },
      }
    );

    const openAiResult = await refreshProviderModels(
      createProviderFixture({ id: 'openai', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' })
    );
    expect(openAiResult.source).toBe('remote');
    expect(openAiResult.tone).toBe('success');
    const astra = openAiResult.models.find((m) => m.id === 'gpt-6.2-astra');
    expect(astra?.source).toBe('remote');
    expect(astra?.capabilities).toEqual(expect.arrayContaining(['text', 'reasoning', 'web-search', 'streaming']));
    const imgModel = openAiResult.models.find((m) => m.id === 'gpt-image-2.5-sunburst');
    expect(imgModel?.task).toBe('image-generation');
    expect(imgModel?.capabilities).toContain('image-generation');

    const xaiResult = await refreshProviderModels(
      createProviderFixture({ id: 'xai-grok', kind: 'xai-grok', baseUrl: 'https://api.x.ai/v1' })
    );
    const grok47 = xaiResult.models.find((m) => m.id === 'grok-4.7');
    expect(grok47?.capabilities).toEqual(expect.arrayContaining(['reasoning', 'web-search']));
    expect(xaiResult.models.find((m) => m.id === 'grok-imagine-image-2.0')?.task).toBe('image-generation');

    const dsResult = await refreshProviderModels(
      createProviderFixture({ id: 'deepseek', kind: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' })
    );
    const dsChat = dsResult.models.find((m) => m.id === 'deepseek-chat');
    const dsReasoner = dsResult.models.find((m) => m.id === 'deepseek-reasoner');
    expect(dsChat?.capabilities).toContain('web-search');
    expect(dsReasoner?.capabilities).toEqual(expect.arrayContaining(['reasoning', 'web-search']));
    expect(dsResult.models.find((m) => m.id === 'deepseek-v4-pro')?.capabilities).toContain('reasoning');
  });

  it('T1-5: Anthropic /v1/models 与 Gemini /v1beta/models 端到端发现应兼容不同载荷格式与服务端元数据', async () => {
    router = installMockFetchRouter(serverBaseUrl, {
      rewriteRules: [{ match: 'relay.example.com' }],
    });

    server.on({ method: 'GET', pathname: '/v1/models' }, (req) => {
      if (req.headers['x-api-key']) {
        return {
          kind: 'json',
          body: {
            data: [{ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', type: 'model' }],
          },
        };
      }
      return {
        kind: 'json',
        body: {
          data: [
            {
              id: 'custom-reasoner',
              context_length: 131072,
              modalities: { input: ['text', 'image'] },
              supported_reasoning_efforts: ['low', 'high'],
              capabilities: { reasoning: true, web_search: true },
            },
          ],
        },
      };
    });

    server.on({ method: 'GET', pathname: '/v1beta/models' }, () => ({
      kind: 'json',
      body: {
        models: [
          {
            name: 'models/gemini-3.8-flash',
            displayName: 'Gemini 3.8 Flash',
            inputTokenLimit: 1048576,
            supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
          },
        ],
      },
    }));

    const antRes = await refreshProviderModels(
      createProviderFixture({
        id: 'anthropic',
        kind: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        apiKey: 'sk-ant-models',
      })
    );
    expect(antRes.models.map((m) => m.id)).toContain('claude-sonnet-5-5');

    // Gemini 端到端发现：必须命中 /v1beta/models 且解析 { models: [...] }
    const geminiProvider = createProviderFixture({
      id: 'gemini',
      kind: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'AIzaSy-models-test',
    });
    const geminiParsedDirect = parseDiscoveredModelsPayload(geminiProvider, {
      models: [{ name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', inputTokenLimit: 1048576 }],
    });
    expect(geminiParsedDirect[0]?.id).toBe('gemini-3.8-flash');

    const geminiRes = await refreshProviderModels(geminiProvider);
    const geminiFlash = geminiRes.models.find((m) => m.id === 'gemini-3.8-flash');
    expect(geminiFlash).toBeDefined();
    expect(geminiFlash?.contextWindow).toBe(1048576);
    expect(geminiFlash?.capabilities).toEqual(expect.arrayContaining(['text', 'reasoning', 'web-search']));

    const geminiReq = server.getLastRequest({ pathname: '/v1beta/models' });
    expect(geminiReq?.headers['x-goog-api-key']).toBe('AIzaSy-models-test');
    expect(geminiReq?.query.key).toBeUndefined();

    // 自定义中转服务端元数据解析
    const relayRes = await refreshProviderModels(
      createProviderFixture({
        id: 'relay-meta',
        kind: 'new-api-relay',
        baseUrl: 'https://relay.example.com/v1',
      })
    );
    const customModel = relayRes.models.find((m) => m.id === 'custom-reasoner');
    expect(customModel?.contextWindow).toBe(131072);
    expect(customModel?.supportedReasoningEfforts).toEqual(['low', 'high']);
    expect(customModel?.capabilities).toEqual(expect.arrayContaining(['image-input', 'reasoning', 'web-search']));
  });

  it('T1-6: Ark 500 降级精选目录、Bailian 业务空间探测及中转自定义头工作区持久化应正确完成', async () => {
    router = installMockFetchRouter(serverBaseUrl, {
      rewriteRules: [
        { match: 'ws1.cn-beijing.maas.aliyuncs.com' },
        { match: 'relay.example.com' },
      ],
    });

    server.on({ method: 'GET', pathname: '/api/v3/models' }, () => ({
      kind: 'error',
      status: 500,
      body: { error: 'ark models unavailable' },
    }));
    server.on({ method: 'GET', pathname: '/compatible-mode/v1/models' }, () => ({
      kind: 'json',
      body: { data: [{ id: 'qwen-max-latest' }] },
    }));

    const arkResult = await refreshProviderModels(
      createProviderFixture({
        id: 'volcengine-ark',
        kind: 'volcengine-ark',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      })
    );
    expect(arkResult.source).toBe('catalog');
    expect(arkResult.tone).toBe('warning');
    expect(arkResult.models.length).toBeGreaterThan(0);

    const bailianResult = await refreshProviderModels(
      createProviderFixture({
        id: 'bailian-compatible',
        kind: 'bailian-compatible',
        baseUrl: 'https://ws1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      })
    );
    expect(bailianResult.source).toBe('remote');
    expect(bailianResult.models.map((m) => m.id)).toContain('qwen-max-latest');

    // 工作区配置持久化 + 无损恢复
    harness = await createE2EWorkspaceHarness();
    await harness.addAndSelectProvider({
      id: 'new-api-relay',
      name: 'My Relay',
      kind: 'new-api-relay',
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'sk-relay-persist',
      authHeaderMode: 'custom',
      customHeaders: [{ key: 'X-Custom-Relay', value: 'v2026', enabled: true }],
      capabilities: ['text', 'streaming'],
      models: [
        {
          id: 'claude-sonnet-5-5',
          name: 'Claude Sonnet 5.5',
          capabilities: ['text', 'streaming'],
          source: 'manual',
        },
      ],
    });
    await harness.flush();

    const stored = harness.persistence.getStoredSnapshot();
    const persistedRelay = stored?.providers.find((p) => p.id === 'new-api-relay');
    expect(persistedRelay?.baseUrl).toBe('https://relay.example.com/v1');
    expect((persistedRelay as ProviderProfile & { authHeaderMode?: string })?.authHeaderMode).toBe('custom');
    expect((persistedRelay as ProviderProfile & { customHeaders?: Array<{ key: string; value: string }> })?.customHeaders).toEqual([
      { key: 'X-Custom-Relay', value: 'v2026', enabled: true },
    ]);
  });

  it('T1-7: 模型能力矩阵应准确区分官方可用能力、仅服务商宣称能力与 Anthropic 光栅生图拦截', () => {
    const workspace = createDefaultWorkspace();
    const openai = workspace.providers.find((p) => p.id === 'openai')!;
    const astra = openai.models.find((m) => m.id === 'gpt-6.2-astra')!;
    const openaiRow = buildModelCapabilityMatrixRow(openai, astra, { platform: 'android' });
    expect(openaiRow.cells.mcp.status).toBe('available');
    expect(openaiRow.cells['web-search'].status).toBe('available');

    // 中转站即使模型声明了 web-search 和 mcp，矩阵也应标注为 provider-only（非官方直连不开放托管适配）
    const relay = createProviderFixture({
      id: 'new-api-relay',
      kind: 'new-api-relay',
      baseUrl: 'https://your-relay.example.com/v1',
    });
    const relayRow = buildModelCapabilityMatrixRow(relay, astra, { platform: 'android' });
    expect(relayRow.cells['web-search'].status).toBe('provider-only');
    expect(relayRow.cells.mcp.status).toBe('provider-only');

    // Anthropic 不支持原生光栅生图
    const anthropic = workspace.providers.find((p) => p.id === 'anthropic')!;
    const fakeImgModel = {
      id: 'claude-image-fake',
      name: 'Claude Image',
      task: 'image-generation' as const,
      capabilities: ['text' as const, 'image-generation' as const],
      source: 'manual' as const,
    };
    const antImgRow = buildModelCapabilityMatrixRow(anthropic, fakeImgModel);
    expect(antImgRow.cells['image-generation'].status).toBe('provider-only');
    expect(antImgRow.cells['image-generation'].reason).toContain('Anthropic');
  });

  // =========================================================================
  // Tier 2：Boundary / Corner / Error Handling（7 个异常与安全边界用例）
  // =========================================================================

  it('T2-1: 主机名子串仿冒绕过防御（Lookalike Host Guard）与非安全 URL 应严格拦截', () => {
    const lookalikes: Array<{ kind: ProviderProfile['kind']; baseUrl: string }> = [
      { kind: 'openai-compatible', baseUrl: 'https://evil-api.openai.com.proxy.test/v1' },
      { kind: 'openai-compatible', baseUrl: 'https://api.openai.com.evil.example/v1' },
      { kind: 'anthropic', baseUrl: 'https://api.anthropic.com.evil.example/v1' },
      { kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com.relay.test/v1beta' },
      { kind: 'xai-grok', baseUrl: 'https://api.x.ai.proxy.test/v1' },
      { kind: 'deepseek', baseUrl: 'https://api.deepseek.com.relay.test/v1' },
      { kind: 'volcengine-ark', baseUrl: 'https://ark.cn-beijing.volces.com.evil.example/api/v3' },
    ];

    for (const target of lookalikes) {
      const inspection = inspectProviderEndpoint(target.baseUrl, { kind: target.kind });
      expect(inspection.official).toBe(false);
      expect(isExactOfficialOpenAiProvider(target)).toBe(false);
      expect(isExactOfficialAnthropicProvider(target)).toBe(false);
      expect(isExactOfficialGeminiProvider(target)).toBe(false);
      expect(isExactOfficialXaiProvider(target)).toBe(false);
      expect(isExactOfficialDeepSeekProvider(target)).toBe(false);
      expect(isRelayOrCustomProvider(target)).toBe(true);
    }

    // 非官方端口、凭据、query 与非回环 HTTP 必须阻断
    expect(inspectProviderEndpoint('https://api.openai.com:8443/v1', { kind: 'openai-compatible' }).valid).toBe(false);
    expect(inspectProviderEndpoint('https://user:pass@api.openai.com/v1', { kind: 'openai-compatible' }).valid).toBe(false);
    expect(inspectProviderEndpoint('https://api.openai.com/v1?leak=1', { kind: 'openai-compatible' }).valid).toBe(false);
    expect(inspectProviderEndpoint('http://api.openai.com/v1', { kind: 'openai-compatible' }).valid).toBe(false);
  });

  it('T2-2: customHeaders 安全消毒应剥离危险/跳点/原型污染/CRLF 注入头并保持大小写覆盖', () => {
    const provider = createProviderFixture({
      id: 'header-sanitize',
      kind: 'custom',
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'sk-safe',
      customHeaders: [
        { key: 'Host', value: 'evil.example', enabled: true },
        { key: 'Connection', value: 'keep-alive', enabled: true },
        { key: 'Cookie', value: 'session=steal', enabled: true },
        { key: 'Origin', value: 'https://attacker.test', enabled: true },
        { key: 'Referer', value: 'https://attacker.test', enabled: true },
        { key: 'Proxy-Authorization', value: 'Basic abc', enabled: true },
        { key: 'X-Forwarded-For', value: '127.0.0.1', enabled: true },
        { key: 'Access-Control-Allow-Origin', value: '*', enabled: true },
        { key: '__proto__', value: 'polluted', enabled: true },
        { key: 'constructor', value: 'polluted', enabled: true },
        { key: 'X-Crlf-Attack', value: 'ok\r\nX-Injected: true', enabled: true },
        { key: 'Invalid Header Name', value: 'bad', enabled: true },
        { key: 'authorization', value: 'Bearer override-token', enabled: true },
        { key: 'X-Safe-Trace', value: 'trace-42', enabled: true },
      ],
    });

    const headers = resolveProviderAuthHeaders(provider);
    const lowerKeys = Object.keys(headers).map((k) => k.toLowerCase());

    expect(lowerKeys).not.toContain('host');
    expect(lowerKeys).not.toContain('connection');
    expect(lowerKeys).not.toContain('cookie');
    expect(lowerKeys).not.toContain('origin');
    expect(lowerKeys).not.toContain('referer');
    expect(lowerKeys).not.toContain('proxy-authorization');
    expect(lowerKeys).not.toContain('x-forwarded-for');
    expect(lowerKeys).not.toContain('access-control-allow-origin');
    expect(lowerKeys).not.toContain('x-crlf-attack');
    expect(Object.prototype.hasOwnProperty.call(headers, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(headers, 'constructor')).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    // 合法自定义头生效且大小写去重覆盖默认 Authorization
    expect(headers['X-Safe-Trace']).toBe('trace-42');
    expect(headers.authorization).toBe('Bearer override-token');
    expect(headers.Authorization).toBeUndefined();
  });

  it('T2-3: /v1/models 返回 HTTP 401/403/429 分类准确、不泄露 API Key 原文，且百炼 sk-sp- Key 本地阻断', async () => {
    router = installMockFetchRouter(serverBaseUrl);
    const secretKey = 'sk-super-secret-do-not-leak-987654';
    const provider = createProviderFixture({
      id: 'openai',
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: secretKey,
    });

    server.enqueue(
      { method: 'GET', pathname: '/v1/models' },
      { kind: 'error', status: 401, body: { error: { message: 'Invalid API key provided' } } }
    );
    let err401: unknown;
    try {
      await fetchOpenAiCompatibleModels(provider);
    } catch (err) {
      err401 = err;
    }
    expect(err401).toBeInstanceOf(Error);
    expect(classifyProviderConnectionError(err401).kind).toBe('api-key');
    expect(String((err401 as Error).message)).not.toContain(secretKey);

    server.enqueue(
      { method: 'GET', pathname: '/v1/models' },
      { kind: 'error', status: 403, body: { error: { message: 'Forbidden model permission' } } }
    );
    let err403: unknown;
    try {
      await fetchOpenAiCompatibleModels(provider);
    } catch (err) {
      err403 = err;
    }
    expect(err403).toBeInstanceOf(Error);
    expect(classifyProviderConnectionError(err403).kind).toBe('permission');

    server.enqueue(
      { method: 'GET', pathname: '/v1/models' },
      { kind: 'error', status: 429, body: { error: { message: 'Rate limit exceeded' } } }
    );
    let err429: unknown;
    try {
      await fetchOpenAiCompatibleModels(provider);
    } catch (err) {
      err429 = err;
    }
    expect(err429).toBeInstanceOf(Error);
    expect(classifyProviderConnectionError(err429).kind).toBe('quota');

    // 百炼 sk-sp- 套餐专属 Key 本地阻断且错误文本不含密钥原文
    const planKey = 'sk-sp-bailian-coding-plan-secret';
    const planInspection = inspectProviderEndpoint('https://dashscope.aliyuncs.com/compatible-mode/v1', {
      kind: 'bailian-compatible',
      apiKey: planKey,
    });
    expect(planInspection.policy).toBe('blocked');
    expect(planInspection.valid).toBe(false);
    expect(JSON.stringify(planInspection)).not.toContain(planKey);
  });

  it('T2-4: /v1/models 返回 HTML 登录页、畸形 JSON 或 HTTP 200 { error } 时应明确拒绝并给出引导', async () => {
    router = installMockFetchRouter(serverBaseUrl);
    const openai = createProviderFixture({
      id: 'openai',
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
    });

    server.enqueue(
      { method: 'GET', pathname: '/v1/models' },
      { kind: 'text', status: 200, headers: { 'Content-Type': 'text/html' }, body: '<html><body>Login</body></html>' }
    );
    await expect(fetchOpenAiCompatibleModels(openai)).rejects.toThrow(/HTML|Base URL/i);

    server.enqueue(
      { method: 'GET', pathname: '/v1/models' },
      { kind: 'text', status: 200, headers: { 'Content-Type': 'application/json' }, body: '{broken json' }
    );
    await expect(fetchOpenAiCompatibleModels(openai)).rejects.toThrow(/JSON/i);

    server.enqueue(
      { method: 'GET', pathname: '/v1/models' },
      { kind: 'json', status: 200, body: { error: { message: 'invalid token payload' } } }
    );
    await expect(fetchOpenAiCompatibleModels(openai)).rejects.toThrow(/invalid token payload|错误/);

    // 百炼 /models 不可用时应给出“手动添加模型”引导
    const bailian = createProviderFixture({
      id: 'bailian-compatible',
      kind: 'bailian-compatible',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    });
    server.enqueue(
      { method: 'GET', pathname: '/compatible-mode/v1/models' },
      { kind: 'error', status: 404, body: { error: 'Not Found' } }
    );
    await expect(fetchOpenAiCompatibleModels(bailian)).rejects.toThrow(/手动添加模型/);
  });

  it('T2-5: /v1/models 返回空列表、重复 ID 与缺失 ID 脏条目应安全清洗去重', async () => {
    router = installMockFetchRouter(serverBaseUrl);
    const provider = createProviderFixture({
      id: 'openai',
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
    });

    server.enqueue(
      { method: 'GET', pathname: '/v1/models' },
      { kind: 'json', body: { data: [] } }
    );
    const emptyRes = await refreshProviderModels(provider);
    expect(emptyRes.models).toEqual([]);

    server.enqueue(
      { method: 'GET', pathname: '/v1/models' },
      {
        kind: 'json',
        body: {
          data: [
            { id: 'gpt-5' },
            { id: ' gpt-5 ' },
            { id: '' },
            { name: 'missing-id' },
            null,
          ],
        },
      }
    );
    const dirtyRes = await refreshProviderModels(provider);
    expect(dirtyRes.models.map((m) => m.id)).toEqual(['gpt-5']);
  });

  it('T2-6: Endpoint 绑定变更应触发旧模型候选、激活模型与关联 MCP 插件强制清理', async () => {
    const equivBinding = compareProviderEndpointBinding(
      { kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1/' },
      { kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1/models' }
    );
    expect(equivBinding.changed).toBe(false);
    expect(equivBinding.mustClearApiKey).toBe(false);

    const changedBinding = compareProviderEndpointBinding(
      { kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' },
      { kind: 'new-api-relay', baseUrl: 'https://relay.example.com/v1' }
    );
    expect(changedBinding.changed).toBe(true);
    expect(changedBinding.mustClearApiKey).toBe(true);
    expect(changedBinding.mustClearModels).toBe(true);
    expect(changedBinding.mustClearModelCandidates).toBe(true);

    harness = await createE2EWorkspaceHarness();
    await harness.settingsRuntime.execute({
      type: 'plugin.add',
      plugin: {
        id: 'mcp-openai-1',
        name: 'Official MCP',
        version: '1.0.0',
        type: 'remote-mcp',
        permissions: ['network', 'tools'],
        allowedTools: ['docs_search'],
        endpoint: 'https://mcp.example.com/sse',
        enabled: true,
        serverLabel: 'docs',
        providerId: 'openai',
        authorization: 'Bearer mcp-secret',
        approvalPolicy: 'always',
      },
    });
    await harness.settingsRuntime.execute({
      type: 'model.set-candidates',
      providerId: 'openai',
      models: [{ id: 'gpt-5.4', name: 'GPT-5.4', capabilities: ['text'], source: 'remote' }],
    });

    const currentOpenAi = harness.session.getSnapshot().providers.find((p) => p.id === 'openai')!;
    await harness.settingsRuntime.execute({
      type: 'provider.save',
      providerId: 'openai',
      provider: {
        ...currentOpenAi,
        kind: 'new-api-relay',
        baseUrl: 'https://relay.example.com/v1',
        apiKey: '',
      },
      binding: changedBinding,
      apiKeyChanged: true,
      now: harness.clock.now(),
    });

    const nextSnap = harness.session.getSnapshot();
    expect(nextSnap.modelCandidatesByProvider.openai).toEqual([]);
    expect(nextSnap.activeModelIdByProvider.openai).toBe('');
    const plugin = nextSnap.plugins.find((pl) => pl.id === 'mcp-openai-1');
    expect(plugin?.enabled).toBe(false);
    expect(plugin?.authorization).toBeUndefined();
  });

  it('T2-7: 模型探测中途触发 AbortSignal 应立即中止且不得吞掉 AbortError（含百炼）', async () => {
    router = installMockFetchRouter(serverBaseUrl);
    server.on({ method: 'GET', pathname: '/v1/models' }, () => ({
      kind: 'json',
      delayMs: 400,
      body: { data: [{ id: 'gpt-5.4' }] },
    }));
    server.on({ method: 'GET', pathname: '/compatible-mode/v1/models' }, () => ({
      kind: 'json',
      delayMs: 400,
      body: { data: [{ id: 'qwen-plus' }] },
    }));

    const controller1 = new AbortController();
    const timer1 = setTimeout(() => controller1.abort(), 25);
    try {
      await expect(
        refreshProviderModels(
          createProviderFixture({ id: 'openai', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' }),
          controller1.signal
        )
      ).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      clearTimeout(timer1);
    }

    const controller2 = new AbortController();
    const timer2 = setTimeout(() => controller2.abort(), 25);
    try {
      await expect(
        refreshProviderModels(
          createProviderFixture({
            id: 'bailian-compatible',
            kind: 'bailian-compatible',
            baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          }),
          controller2.signal
        )
      ).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      clearTimeout(timer2);
    }
  });
});
