import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage, PluginManifest, ProviderProfile } from '../src/domain/types';
import { createModelInfoFromId } from '../src/services/modelCapabilities';
import {
  isWebDevelopmentProxyAllowed,
  sendOpenAiCompatibleChat,
} from '../src/services/openAiCompatible';

const platform = vi.hoisted(() => ({ OS: 'android' }));

vi.mock('react-native', () => ({ Platform: platform }));

const provider: ProviderProfile = {
  id: 'openai',
  name: 'OpenAI',
  kind: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  capabilities: ['text', 'image-input', 'reasoning'],
  models: [],
};

const message: ChatMessage = {
  id: 'u1',
  role: 'user',
  content: 'Solve this.',
  createdAt: 1,
  status: 'ready',
};

const mcpAuthorization = 'Bearer mcp-secret-value';
const mcpAllowedTools = ['weather.lookup', 'calendar.read'];

function enabledMcpPlugin(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'mcp-trusted',
    name: 'Trusted MCP',
    version: '1.0.0',
    type: 'remote-mcp',
    permissions: ['network', 'tools'],
    allowedTools: [...mcpAllowedTools],
    transport: 'streamable-http',
    endpoint: 'https://mcp.example.com/rpc',
    enabled: true,
    serverLabel: 'trusted_mcp',
    providerId: provider.id,
    authorization: mcpAuthorization,
    approvalPolicy: 'always',
    ...overrides,
  };
}

function modelWithMcp(targetProvider: ProviderProfile = provider) {
  const model = createModelInfoFromId(targetProvider, 'gpt-5.2-pro', 'manual');
  model.capabilities = Array.from(new Set([...model.capabilities, 'mcp']));
  return model;
}

afterEach(() => {
  platform.OS = 'android';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Web development proxy boundary', () => {
  it('requires development mode, an explicit launcher flag, and a loopback page', () => {
    expect(isWebDevelopmentProxyAllowed({
      platform: 'web',
      development: true,
      explicitlyEnabled: true,
      location: { protocol: 'http:', hostname: '127.0.0.1' },
    })).toBe(true);
    expect(isWebDevelopmentProxyAllowed({
      platform: 'web',
      development: false,
      explicitlyEnabled: true,
      location: { protocol: 'http:', hostname: '127.0.0.1' },
    })).toBe(false);
    expect(isWebDevelopmentProxyAllowed({
      platform: 'web',
      development: true,
      explicitlyEnabled: false,
      location: { protocol: 'http:', hostname: '127.0.0.1' },
    })).toBe(false);
    expect(isWebDevelopmentProxyAllowed({
      platform: 'web',
      development: true,
      explicitlyEnabled: true,
      location: { protocol: 'https:', hostname: 'szdtzpj.github.io' },
    })).toBe(false);
  });

  it('fails closed before contacting a proxy from a production-style Web runtime', async () => {
    platform.OS = 'web';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendOpenAiCompatibleChat({
      provider,
      modelId: 'gpt-4.1',
      model: createModelInfoFromId(provider, 'gpt-4.1', 'manual'),
      messages: [message],
      reasoningEffort: 'default',
    })).rejects.toThrow(/正式 Web 构建不会发送 API Key/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('official OpenAI endpoint routing', () => {
  it('sends Responses-only Pro models to /responses without streaming or sampling fields', async () => {
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'resp_1',
      status: 'completed',
      output: [{
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Done.' }],
      }],
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendOpenAiCompatibleChat({
      provider,
      modelId: 'gpt-5.2-pro',
      model: createModelInfoFromId(provider, 'gpt-5.2-pro', 'manual'),
      messages: [message],
      reasoningEffort: 'max',
      maxOutputTokens: 4096,
      parameterSettings: {
        enabled: true,
        temperature: 0.2,
        topP: 0.8,
        presencePenalty: 1,
        frequencyPenalty: 1,
      },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(body).toMatchObject({
      model: 'gpt-5.2-pro',
      store: false,
      reasoning: { effort: 'xhigh' },
      max_output_tokens: 4096,
    });
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('stream');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 10 * 60_000);
    expect(result.content).toBe('Done.');
  });

  it('keeps ordinary OpenAI chat models on /chat/completions', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'Chat.' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await sendOpenAiCompatibleChat({
      provider,
      modelId: 'gpt-4.1',
      model: createModelInfoFromId(provider, 'gpt-4.1', 'manual'),
      messages: [message],
      reasoningEffort: 'default',
      maxOutputTokens: 4096,
    });

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.max_completion_tokens).toBe(4096);
    expect(body).not.toHaveProperty('max_output_tokens');
    expect(body).not.toHaveProperty('max_tokens');
  });

  it.each([
    {
      label: 'Volcengine Ark',
      provider: {
        ...provider,
        id: 'ark-chat-limit',
        name: 'Volcengine Ark',
        kind: 'volcengine-ark' as const,
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      },
      modelId: 'doubao-seed-2-0-pro-260215',
      expectedUrl: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    },
    {
      label: 'Alibaba Bailian',
      provider: {
        ...provider,
        id: 'bailian-chat-limit',
        name: 'Alibaba Bailian',
        kind: 'bailian-compatible' as const,
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      },
      modelId: 'qwen-plus',
      expectedUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    },
    {
      label: 'custom OpenAI-compatible relay',
      provider: {
        ...provider,
        id: 'custom-chat-limit',
        name: 'Custom relay',
        kind: 'custom' as const,
        baseUrl: 'https://relay.example.com/v1',
      },
      modelId: 'relay-chat-model',
      expectedUrl: 'https://relay.example.com/v1/chat/completions',
    },
  ])('serializes the output limit only as max_tokens for $label Chat', async ({
    provider: chatProvider,
    modelId,
    expectedUrl,
  }) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'Bounded.' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await sendOpenAiCompatibleChat({
      provider: chatProvider,
      modelId,
      model: createModelInfoFromId(chatProvider, modelId, 'manual'),
      messages: [message],
      reasoningEffort: 'default',
      maxOutputTokens: 4096,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(url).toBe(expectedUrl);
    expect(body.max_tokens).toBe(4096);
    expect(body).not.toHaveProperty('max_output_tokens');
    expect(body).not.toHaveProperty('max_completion_tokens');
  });

  it('sends an inline file only to the official OpenAI host when the model explicitly supports it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'Read.' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const model = createModelInfoFromId(provider, 'gpt-4.1', 'manual');
    model.capabilities = [...model.capabilities, 'file-input'];
    const fileMessage: ChatMessage = {
      ...message,
      attachments: [{
        id: 'file-1',
        kind: 'file',
        uri: 'file:///notes.pdf',
        name: 'notes.pdf',
        mimeType: 'application/pdf',
        base64: 'YWJjZA==',
      }],
    };

    await sendOpenAiCompatibleChat({
      provider,
      modelId: model.id,
      model,
      messages: [fileMessage],
      reasoningEffort: 'default',
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.messages[0].content).toContainEqual({
      type: 'file',
      file: {
        filename: 'notes.pdf',
        file_data: 'data:application/pdf;base64,YWJjZA==',
      },
    });

    const relay = { ...provider, id: 'relay', baseUrl: 'https://relay.example.com/v1' };
    await expect(sendOpenAiCompatibleChat({
      provider: relay,
      modelId: model.id,
      model,
      messages: [fileMessage],
      reasoningEffort: 'default',
    })).rejects.toThrow(/只在 OpenAI 官方 API/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('official OpenAI MCP routing integration', () => {
  it('sends a no-approval MCP turn through Responses with exact safety fields and reasoning effort', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'resp_mcp_direct',
      status: 'completed',
      output: [{
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'No tool needed.' }],
      }],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const requestApproval = vi.fn(async () => 'approve' as const);

    const result = await sendOpenAiCompatibleChat({
      provider,
      modelId: 'gpt-5.2-pro',
      model: modelWithMcp(),
      messages: [message],
      reasoningEffort: 'max',
      maxOutputTokens: 4096,
      mcp: {
        plugin: enabledMcpPlugin(),
        requestApproval,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init.redirect).toBe('error');
    expect(body).toMatchObject({
      model: 'gpt-5.2-pro',
      store: false,
      parallel_tool_calls: false,
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'xhigh' },
      max_output_tokens: 4096,
      tools: [{
        type: 'mcp',
        server_label: 'trusted_mcp',
        server_url: 'https://mcp.example.com/rpc',
        authorization: mcpAuthorization,
        require_approval: 'always',
        allowed_tools: mcpAllowedTools,
      }],
    });
    expect(body.tools[0].allowed_tools).toEqual(mcpAllowedTools);
    expect(requestApproval).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      content: 'No tool needed.',
      mcpActivity: {
        serverLabel: 'trusted_mcp',
        providerRequestCount: 1,
        approvals: [],
        calls: [],
      },
      raw: {
        protocol: 'openai-official',
        responseIds: ['resp_mcp_direct'],
        requestCount: 1,
      },
    });
  });

  it('calls the approval callback and continues with the complete manual context', async () => {
    const rawArguments = '{"city":"Shanghai"}';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'resp_mcp_approval',
        status: 'completed',
        output: [
          {
            type: 'mcp_list_tools',
            id: 'list_1',
            server_label: 'trusted_mcp',
            tools: [{ name: 'weather.lookup' }, { name: 'calendar.read' }],
          },
          {
            type: 'mcp_approval_request',
            id: 'approval_1',
            server_label: 'trusted_mcp',
            name: 'weather.lookup',
            arguments: rawArguments,
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'resp_mcp_final',
        status: 'completed',
        output: [
          {
            type: 'mcp_call',
            id: 'call_1',
            server_label: 'trusted_mcp',
            name: 'weather.lookup',
            arguments: rawArguments,
            approval_request_id: 'approval_1',
          },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Shanghai is clear.' }],
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const requestApproval = vi.fn(async () => 'approve' as const);
    const beforeContinuation = vi.fn(async () => undefined);
    const beforeProviderRequest = vi.fn((_context: { requestNumber: number }) => undefined);
    const onProviderRequestStarted = vi.fn((_context: { requestNumber: number }) => undefined);

    const result = await sendOpenAiCompatibleChat({
      provider,
      modelId: 'gpt-5.2-pro',
      model: modelWithMcp(),
      messages: [message],
      reasoningEffort: 'high',
      mcp: {
        plugin: enabledMcpPlugin(),
        requestApproval,
        beforeContinuation,
        beforeProviderRequest,
        onProviderRequestStarted,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(beforeProviderRequest.mock.calls.map(([context]) => context.requestNumber)).toEqual([1, 2]);
    expect(onProviderRequestStarted.mock.calls.map(([context]) => context.requestNumber)).toEqual([1, 2]);
    expect(fetchMock.mock.calls.map(([, init]) => (init as RequestInit).redirect)).toEqual([
      'error',
      'error',
    ]);
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'approval_1',
        serverLabel: 'trusted_mcp',
        toolName: 'weather.lookup',
        rawArguments,
        arguments: { city: 'Shanghai' },
      }),
      expect.objectContaining({ approvalNumber: 1, requestNumber: 1 })
    );
    expect(beforeContinuation).toHaveBeenCalledWith(expect.objectContaining({
      nextRequestNumber: 2,
      approvals: [{
        approvalRequestId: 'approval_1',
        serverLabel: 'trusted_mcp',
        toolName: 'weather.lookup',
        decision: 'approve',
        argumentBytes: rawArguments.length,
      }],
    }));
    const firstBody = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    const continuationBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(firstBody.reasoning).toEqual({ effort: 'high' });
    expect(continuationBody).toMatchObject({
      store: false,
      parallel_tool_calls: false,
      reasoning: { effort: 'high' },
      tools: [{
        require_approval: 'always',
        allowed_tools: mcpAllowedTools,
      }],
    });
    expect(continuationBody.input).toContainEqual(expect.objectContaining({
      type: 'mcp_approval_request',
      id: 'approval_1',
    }));
    expect(continuationBody.input).toContainEqual({
      type: 'mcp_approval_response',
      approval_request_id: 'approval_1',
      approve: true,
    });
    expect(result.content).toBe('Shanghai is clear.');
    expect(result.mcpActivity).toEqual({
      serverLabel: 'trusted_mcp',
      providerRequestCount: 2,
      approvals: [{ toolName: 'weather.lookup', decision: 'approve' }],
      calls: [{ toolName: 'weather.lookup', outcome: 'completed' }],
    });
  });

  it('rejects Web Search and MCP together before issuing a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const model = modelWithMcp();
    model.capabilities = Array.from(new Set([...model.capabilities, 'web-search']));

    await expect(sendOpenAiCompatibleChat({
      provider,
      modelId: model.id,
      model,
      messages: [message],
      reasoningEffort: 'default',
      webSearch: { enabled: true, searchContextSize: 'medium' },
      mcp: {
        plugin: enabledMcpPlugin(),
        requestApproval: vi.fn(async () => 'approve' as const),
      },
    })).rejects.toThrow(/MCP 与联网搜索不能在同一轮启用/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed for relays, undeclared models, invalid plugins, and disabled plugins', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const requestApproval = vi.fn(async () => 'approve' as const);
    const relay = {
      ...provider,
      id: 'openai-relay',
      kind: 'openai-compatible' as const,
      baseUrl: 'https://relay.example.com/v1',
    };

    await expect(sendOpenAiCompatibleChat({
      provider: relay,
      modelId: 'gpt-5.2-pro',
      model: modelWithMcp(relay),
      messages: [message],
      reasoningEffort: 'default',
      mcp: {
        plugin: enabledMcpPlugin({ providerId: relay.id }),
        requestApproval,
      },
    })).rejects.toThrow(/精确的 OpenAI 官方 api\.openai\.com Responses 路由/);

    const undeclaredModel = createModelInfoFromId(provider, 'gpt-5.2-pro', 'manual');
    undeclaredModel.capabilities = undeclaredModel.capabilities.filter((item) => item !== 'mcp');
    await expect(sendOpenAiCompatibleChat({
      provider,
      modelId: undeclaredModel.id,
      model: undeclaredModel,
      messages: [message],
      reasoningEffort: 'default',
      mcp: { plugin: enabledMcpPlugin(), requestApproval },
    })).rejects.toThrow(/模型未明确标记 MCP 能力/);

    for (const plugin of [
      enabledMcpPlugin({ allowedTools: [] }),
      enabledMcpPlugin({ enabled: false }),
    ]) {
      await expect(sendOpenAiCompatibleChat({
        provider,
        modelId: 'gpt-5.2-pro',
        model: modelWithMcp(),
        messages: [message],
        reasoningEffort: 'default',
        mcp: { plugin, requestApproval },
      })).rejects.toThrow(/MCP 配置未通过.*白名单与逐次审批安全检查/);
    }

    expect(fetchMock).not.toHaveBeenCalled();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a custom port',
      { kind: 'openai-compatible' as const, baseUrl: 'https://api.openai.com:8443/v1' },
    ],
    [
      'a mismatched provider kind',
      { kind: 'custom' as const, baseUrl: 'https://api.openai.com/v1' },
    ],
    [
      'an unexpected path',
      { kind: 'openai-compatible' as const, baseUrl: 'https://api.openai.com/admin' },
    ],
  ])('rejects MCP before fetch for %s', async (_label, overrides) => {
    const unsafeProvider: ProviderProfile = {
      ...provider,
      ...overrides,
      id: `unsafe-${_label}`,
    };
    const fetchMock = vi.fn();
    const requestApproval = vi.fn(async () => 'approve' as const);
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendOpenAiCompatibleChat({
      provider: unsafeProvider,
      modelId: 'gpt-5.2-pro',
      model: modelWithMcp(unsafeProvider),
      messages: [message],
      reasoningEffort: 'default',
      mcp: {
        plugin: enabledMcpPlugin({ providerId: unsafeProvider.id }),
        requestApproval,
      },
    })).rejects.toThrow(/OpenAI.*api\.openai\.com Responses/);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('does not expose MCP authorization when an HTTP error body reflects it', async () => {
    const reflectedBody = `upstream echoed ${mcpAuthorization}`;
    const fetchMock = vi.fn().mockResolvedValue(new Response(reflectedBody, {
      status: 502,
      headers: { 'content-type': 'text/plain' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const error = await sendOpenAiCompatibleChat({
      provider,
      modelId: 'gpt-5.2-pro',
      model: modelWithMcp(),
      messages: [message],
      reasoningEffort: 'default',
      mcp: {
        plugin: enabledMcpPlugin(),
        requestApproval: vi.fn(async () => 'approve' as const),
      },
    }).then(() => undefined, (reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('MCP Responses request failed.');
    expect((error as Error).message).not.toContain(mcpAuthorization);
    expect((error as Error).message).not.toContain(reflectedBody);
    const sentBody = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(sentBody.tools[0].authorization).toBe(mcpAuthorization);
  });
});

describe('provider Responses Web Search integration', () => {
  it.each([
    {
      label: 'Volcengine Ark',
      provider: {
        ...provider,
        id: 'ark',
        name: 'Volcengine Ark',
        kind: 'volcengine-ark' as const,
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        capabilities: ['text', 'web-search'] as ProviderProfile['capabilities'],
      },
      modelId: 'doubao-seed-2-0-pro-260215',
      expectedTool: { type: 'web_search', max_keyword: 3, limit: 10 },
    },
    {
      label: 'Alibaba Bailian',
      provider: {
        ...provider,
        id: 'bailian',
        name: 'Alibaba Bailian',
        kind: 'bailian-compatible' as const,
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        capabilities: ['text', 'web-search'] as ProviderProfile['capabilities'],
      },
      modelId: 'qwen-plus',
      expectedTool: { type: 'web_search' },
    },
  ])('does not send OpenAI-only search_context_size to $label', async ({
    provider: searchProvider,
    modelId,
    expectedTool,
  }) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'resp_search',
      status: 'completed',
      output: [{
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Search result.' }],
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const searchModel = createModelInfoFromId(searchProvider, modelId, 'manual');
    searchModel.capabilities = Array.from(new Set([...searchModel.capabilities, 'web-search']));

    const result = await sendOpenAiCompatibleChat({
      provider: searchProvider,
      modelId,
      model: searchModel,
      messages: [message],
      reasoningEffort: 'default',
      maxOutputTokens: 2048,
      webSearch: { enabled: true, searchContextSize: 'high' },
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.tools).toEqual([expectedTool]);
    expect(body.max_output_tokens).toBe(2048);
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body).not.toHaveProperty('max_tokens');
    expect(JSON.stringify(body)).not.toContain('search_context_size');
    expect(result.content).toBe('Search result.');
  });
});
