import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage, ExternalSearchService, ProviderProfile } from '../src/domain/types';
import { runDeepSeekFetch, runExternalSearch } from '../src/services/externalSearch';
import {
  guardedApiFetch,
  queryGenerationTask,
  sendOpenAiCompatibleChat,
} from '../src/services/openAiCompatible';
import { validatedPublicHttpsUrl } from '../src/services/openAiResponses';
import { resolveProviderAuthHeaders } from '../src/services/providerSetup';
import { isBlockedPublicHost } from '../src/services/ssrfGuard';

const platform = vi.hoisted(() => ({ OS: 'android' }));

vi.mock('react-native', () => ({ Platform: platform }));

function relayProvider(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'relay-1',
    name: 'Relay Provider',
    kind: 'new-api-relay',
    baseUrl: 'https://relay.example.com/v1',
    apiKey: 'sk-relay-secret-1234',
    capabilities: ['text', 'tool-calling', 'streaming'],
    models: [
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        capabilities: ['text', 'tool-calling', 'streaming'],
        source: 'manual',
      },
    ],
    ...overrides,
  };
}

function searchService(
  kind: ExternalSearchService['kind'],
  overrides: Partial<ExternalSearchService> = {}
): ExternalSearchService {
  return {
    id: `${kind}-test`,
    kind,
    name: kind,
    apiKey: 'sk-search-secret-5678',
    ...overrides,
  };
}

function userMessage(content: string): ChatMessage {
  return {
    id: 'msg-u1',
    role: 'user',
    content,
    createdAt: 1,
    status: 'ready',
  };
}

afterEach(() => {
  platform.OS = 'android';
  delete process.env.EXPO_PUBLIC_ENABLE_WEB_DEV_PROXY;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Tier 5 security and protocol regressions', () => {
  it('enforces Web fail-closed boundary on runExternalSearch and runDeepSeekFetch while allowing controlled dev proxy', async () => {
    platform.OS = 'web';
    const globalFetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', globalFetchSpy);

    // 1) 未启用受控 Web 调试代理时：无论是否传 fetchImpl，runExternalSearch 与 runDeepSeekFetch 均 fail-closed 拦截
    await expect(
      runExternalSearch({
        query: 'web prod block',
        service: searchService('tavily'),
      })
    ).rejects.toThrow(/正式 Web 构建不会发送/);
    await expect(
      runExternalSearch({
        query: 'web prod custom fetch block',
        service: searchService('tavily'),
        fetchImpl: globalFetchSpy,
      })
    ).rejects.toThrow(/正式 Web 构建不会发送/);
    await expect(
      runDeepSeekFetch({
        url: 'https://example.com/doc',
        apiKey: 'ds-key-1234',
      })
    ).rejects.toThrow(/正式 Web 构建不会发送/);
    expect(globalFetchSpy).not.toHaveBeenCalled();

    // 2) 显式开启受控本机调试代理时：单层转发至 127.0.0.1:8787/proxy
    process.env.EXPO_PUBLIC_ENABLE_WEB_DEV_PROXY = '1';
    vi.stubGlobal('__DEV__', true);
    vi.stubGlobal('window', { location: { protocol: 'http:', hostname: '127.0.0.1' } });
    const proxyFetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('http://127.0.0.1:8787/proxy');
      const envelope = JSON.parse(String(init?.body)) as { url: string; method: string };
      expect(envelope.url).toBe('https://api.tavily.com/search');
      expect(envelope.method).toBe('POST');
      return new Response(
        JSON.stringify({
          results: [{ title: 'Proxied Hit', url: 'https://example.com/hit', content: 'ok' }],
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal('fetch', proxyFetchSpy);

    const searchRes = await runExternalSearch({
      query: 'web dev proxy ok',
      service: searchService('tavily'),
    });
    expect(proxyFetchSpy).toHaveBeenCalledTimes(1);
    expect(searchRes.items[0]?.title).toBe('Proxied Hit');
  });

  it('prevents customHeaders from overriding Content-Type on authHeaders and protocol requests', async () => {
    const provider = relayProvider({
      customHeaders: [
        { key: 'Content-Type', value: 'text/plain', enabled: true },
        { key: 'content-type', value: 'application/xml', enabled: true },
        { key: 'X-Trace', value: 'trace-ok', enabled: true },
      ],
    });

    const resolved = resolveProviderAuthHeaders(provider);
    expect(resolved['Content-Type']).toBeUndefined();
    expect(resolved['content-type']).toBeUndefined();
    expect(resolved['X-Trace']).toBe('trace-ok');

    const sentHeaders: Array<Record<string, string>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        sentHeaders.push((init?.headers ?? {}) as Record<string, string>);
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'Content-Type protected' } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );

    const res = await sendOpenAiCompatibleChat({
      provider,
      modelId: 'gpt-4o',
      messages: [userMessage('hi')],
      reasoningEffort: 'off',
    });
    expect(res.content).toBe('Content-Type protected');
    expect(sentHeaders[0]?.['Content-Type']).toBe('application/json');
    expect(sentHeaders[0]?.['X-Trace']).toBe('trace-ok');
  });

  it('serializes binary/URLSearchParams bodies in Web proxy mode and rejects unsupported body types explicitly', async () => {
    platform.OS = 'web';
    process.env.EXPO_PUBLIC_ENABLE_WEB_DEV_PROXY = '1';
    vi.stubGlobal('__DEV__', true);
    vi.stubGlobal('window', { location: { protocol: 'http:', hostname: '127.0.0.1' } });

    const envelopes: Array<{ body?: string; bodyEncoding?: string; headers: Record<string, string> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        envelopes.push(JSON.parse(String(init?.body)));
        return new Response('ok', { status: 200 });
      })
    );

    await guardedApiFetch('https://relay.example.com/v1/upload', {
      method: 'POST',
      body: new Uint8Array([1, 2, 3]),
    });
    expect(envelopes[0]).toMatchObject({
      bodyEncoding: 'base64',
      body: 'AQID',
    });

    await guardedApiFetch('https://relay.example.com/v1/form', {
      method: 'POST',
      body: new URLSearchParams({ q: 'hello' }),
    });
    expect(envelopes[1]?.body).toBe('q=hello');
    expect(envelopes[1]?.bodyEncoding).toBeUndefined();

    await expect(
      guardedApiFetch('https://relay.example.com/v1/bad', {
        method: 'POST',
        body: { unsupported: true } as unknown as BodyInit,
      })
    ).rejects.toThrow(/不支持该请求体类型/);
  });

  it('does not emit toolStatus=failed when sendExternalSearchToolChat is aborted during single-round search_web execution', async () => {
    const controller = new AbortController();
    let callCount = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        callCount += 1;
        if (url.includes('/chat/completions')) {
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: '',
                    tool_calls: [
                      {
                        id: 'call_abort_1',
                        type: 'function',
                        function: {
                          name: 'search_web',
                          arguments: JSON.stringify({ query: 'abort during search' }),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        // 外部搜索请求到达时触发中止并挂起响应流
        controller.abort();
        const abortErr = new Error('搜索已取消。');
        abortErr.name = 'AbortError';
        throw abortErr;
      })
    );

    const updates: Array<{ toolActivity?: Array<{ status?: string }> }> = [];
    await expect(
      sendOpenAiCompatibleChat({
        provider: relayProvider(),
        modelId: 'gpt-4o',
        messages: [userMessage('Search and abort')],
        reasoningEffort: 'off',
        signal: controller.signal,
        externalSearch: {
          enabled: true,
          selectedServiceId: 'tavily-test',
          maxResults: 3,
          maxToolRounds: 1,
          services: [searchService('tavily')],
        },
        onStreamUpdate: (update) => {
          updates.push({ toolActivity: update.toolActivity });
        },
      })
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(callCount).toBe(2);
    const hasFailedToolStatus = updates.some((u) =>
      u.toolActivity?.some((item) => item.status === 'failed')
    );
    expect(hasFailedToolStatus).toBe(false);
  });

  it('maintains ChatPane timer cleanup and draftSaveOperationRef race-condition guards', async () => {
    const chatPaneSource = await readFile(path.resolve('src/features/chat/ChatPane.tsx'), 'utf8');

    expect(chatPaneSource).toContain('clearScrollToBottomTimers();');
    expect(chatPaneSource).toContain('clearAttachments: false');
    expect(chatPaneSource).toContain('if (draftSaveOperationRef.current !== operation)');
    expect(chatPaneSource).toContain("setNotice('当前没有可导出的对话。')");
  });

  it('blocks unnormalized hex/octal IPv4 obfuscations and non-compressed IPv6 loopback/mapped forms in ssrfGuard and adapters', () => {
    const blockedHosts = [
      '0x7f.0.0.1',
      '0xa9.0xfe.0xa9.0xfe',
      '0177.0.0.1',
      '012.0.0.1',
      '0x7f000001',
      '2130706433',
      '0000::1',
      '0:0:0:0:0:ffff:a9fe:a9fe',
    ];
    for (const host of blockedHosts) {
      expect(isBlockedPublicHost(host)).toBe(true);
    }
    expect(isBlockedPublicHost('api.example.cab')).toBe(false);
    expect(isBlockedPublicHost('8.8.8.8')).toBe(false);

    expect(validatedPublicHttpsUrl('https://[0000::1]/secret')).toBeUndefined();
    expect(validatedPublicHttpsUrl('https://[0:0:0:0:0:ffff:a9fe:a9fe]/latest')).toBeUndefined();
    expect(validatedPublicHttpsUrl('https://docs.example.com/guide')).toBe(
      'https://docs.example.com/guide'
    );
  });

  it('rejects unsafe Ark video URLs in queryGenerationTask before any mediaStorage download', async () => {
    const arkProvider: ProviderProfile = {
      id: 'ark-test',
      name: 'Volcengine Ark',
      kind: 'volcengine-ark',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: 'ark-secret-1234',
      capabilities: ['video-generation'],
      models: [],
    };
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: 'task-ssrf-video',
          status: 'succeeded',
          content: { video_url: 'https://169.254.169.254/latest/meta-data/video.mp4' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      queryGenerationTask(arkProvider, {
        providerId: arkProvider.id,
        modelId: 'doubao-seedance-2-0',
        taskId: 'task-ssrf-video',
        kind: 'video',
        status: 'submitted',
      })
    ).rejects.toThrow(/不安全的媒体链接/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
