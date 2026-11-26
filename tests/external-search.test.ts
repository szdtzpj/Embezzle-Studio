import { describe, expect, it, vi } from 'vitest';

import type { ExternalSearchService } from '../src/domain/types';
import {
  allExternalSearchProviderKinds,
  allExternalSearchProviderLabels,
  DEFAULT_GROK_SEARCH_MODEL,
  citationsFromExternalSearchResults,
  cleanSearchAnswerForDisplay,
  externalSearchProviderKinds,
  extractLinksFromAnswerText,
  externalSearchProviderAllowsAnonymous,
  externalSearchProviderRequiresApiKey,
  formatExternalSearchToolResult,
  getExternalSearchToolDefinition,
  isExternalSearchReady,
  isExternalSearchServiceConfigured,
  isWeakSearchTitle,
  normalizeExternalSearchSettings,
  parseSearchWebToolArguments,
  reindexExternalSearchResult,
  resolveMessageMarkdownLink,
  resolveActiveExternalSearchService,
  runDeepSeekFetch,
  runExternalSearch,
  stripExternalSearchSecrets,
  titleFromSearchUrl,
  type ExtendedExternalSearchService,
} from '../src/services/externalSearch';

function service(
  kind: ExternalSearchService['kind'],
  overrides: Partial<ExternalSearchService> = {}
): ExternalSearchService {
  return {
    id: `${kind}-1`,
    kind,
    name: kind,
    apiKey: 'test-key',
    ...overrides,
  };
}

describe('external search settings', () => {
  it('normalizes services and readiness without requiring enabled=true', () => {
    const settings = normalizeExternalSearchSettings({
      enabled: false,
      maxResults: 99,
      maxToolRounds: 0,
      services: [
        { id: 't1', kind: 'tavily', name: 'Tavily', apiKey: 'sk-tavily' },
        { id: 'bad', kind: 'unknown', name: 'x' },
      ],
    });
    expect(settings.maxResults).toBe(10);
    expect(settings.maxToolRounds).toBe(1);
    expect(settings.services).toHaveLength(1);
    expect(settings.selectedServiceId).toBe('t1');
    expect(isExternalSearchReady(settings)).toBe(true);
    expect(resolveActiveExternalSearchService(settings)).toBeNull();
  });

  it('treats free anonymous providers as ready without API key', () => {
    expect(externalSearchProviderAllowsAnonymous('bing')).toBe(true);
    expect(externalSearchProviderAllowsAnonymous('duckduckgo')).toBe(true);
    expect(externalSearchProviderAllowsAnonymous('firecrawl')).toBe(true);
    expect(
      externalSearchProviderAllowsAnonymous('firecrawl', 'https://fc.example.com/v2/search')
    ).toBe(true);
    expect(externalSearchProviderRequiresApiKey('firecrawl')).toBe(false);
    expect(
      externalSearchProviderRequiresApiKey('firecrawl', 'https://fc.example.com/v2/search')
    ).toBe(false);
    expect(externalSearchProviderRequiresApiKey('tavily')).toBe(true);
    expect(isExternalSearchServiceConfigured(service('bing', { apiKey: undefined }))).toBe(true);
    expect(isExternalSearchServiceConfigured(service('firecrawl', { apiKey: undefined }))).toBe(true);
    expect(isExternalSearchServiceConfigured(service('tavily', { apiKey: undefined }))).toBe(false);

    const settings = normalizeExternalSearchSettings({
      enabled: true,
      services: [{ id: 'b1', kind: 'bing', name: 'Bing' }],
    });
    expect(isExternalSearchReady(settings)).toBe(true);
    expect(resolveActiveExternalSearchService(settings)?.kind).toBe('bing');
  });

  it('restores safe disabled defaults when migrating a workspace without external search', () => {
    const settings = normalizeExternalSearchSettings(undefined);
    expect(settings.enabled).toBe(false);
    expect(settings.selectedServiceId).toBe('ext-search-bing');
    expect(settings.services.map((item) => item.kind)).toEqual(['bing', 'duckduckgo']);
  });

  it('strips api keys for persistence/backup', () => {
    const stripped = stripExternalSearchSecrets({
      enabled: true,
      maxResults: 5,
      maxToolRounds: 3,
      services: [service('brave')],
    });
    expect(stripped.services[0]?.apiKey).toBeUndefined();
  });
});

describe('search_web tool contract', () => {
  it('exposes an OpenAI-compatible function tool', () => {
    const tool = getExternalSearchToolDefinition();
    expect(tool.type).toBe('function');
    expect(tool.function.name).toBe('search_web');
    expect(tool.function.parameters.required).toContain('query');
  });

  it('parses tool arguments from object or JSON string', () => {
    expect(parseSearchWebToolArguments({ query: ' latest ai news ' })).toBe('latest ai news');
    expect(parseSearchWebToolArguments(JSON.stringify({ query: 'foo' }))).toBe('foo');
  });

  it('keeps citation ids unique across rounds and resolves inline citation links', () => {
    const first = reindexExternalSearchResult({
      items: [
        { id: 's1', index: 1, title: 'A', url: 'https://example.com/a', text: 'a' },
        { id: 's2', index: 2, title: 'B', url: 'https://example.com/b', text: 'b' },
      ],
    }, 0);
    const second = reindexExternalSearchResult({
      items: [
        { id: 's1', index: 1, title: 'C', url: 'https://example.com/c', text: 'c' },
      ],
    }, first.items.length);
    const citations = citationsFromExternalSearchResults([first, second]);

    expect(second.items[0]).toMatchObject({ index: 3, id: 's3' });
    expect(citations.map((citation) => [citation.index, citation.id])).toEqual([
      [1, 's1'],
      [2, 's2'],
      [3, 's3'],
    ]);
    expect(resolveMessageMarkdownLink('3:s3', citations)).toBe('https://example.com/c');
    expect(resolveMessageMarkdownLink('https://example.com/direct', citations)).toBe(
      'https://example.com/direct'
    );
    expect(resolveMessageMarkdownLink('intent://unsafe', citations)).toBeNull();
    expect(resolveMessageMarkdownLink('3:wrong', citations)).toBeNull();
  });
});

describe('provider adapters', () => {
  it('runs Tavily search with bearer auth and maps results', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          answer: 'summary',
          results: [
            { title: 'A', url: 'https://example.com/a', content: 'body a', score: 0.9 },
            { title: 'B', url: 'http://insecure.example', content: 'drop' },
            {
              title: 'C',
              url: 'https://example.com/c',
              raw_content: 'long raw page text for fallback',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const result = await runExternalSearch({
      query: 'test query',
      service: service('tavily'),
      maxResults: 5,
      fetchImpl,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.tavily.com/search');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers).toMatchObject({
      Authorization: 'Bearer test-key',
    });
    const requestBody = JSON.parse(String(calls[0]?.init?.body));
    expect(requestBody.include_answer).toBe(true);
    expect(result.answer).toBe('summary');
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.url).toBe('https://example.com/a');
    expect(result.items[0]?.text).toContain('body a');
    expect(result.items[1]?.text).toContain('long raw page');
    expect(result.items[0]?.index).toBe(1);
    expect(result.items[0]?.id).toBeTruthy();

    const toolPayload = JSON.parse(formatExternalSearchToolResult(result));
    expect(toolPayload.items[0].url).toBe('https://example.com/a');
    expect(citationsFromExternalSearchResults([result])[0]?.url).toBe('https://example.com/a');
  });

  it('runs Brave search with extra snippets and strips highlight HTML', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      expect(String(input)).toContain('https://api.search.brave.com/res/v1/web/search?q=');
      expect(String(input)).toContain('extra_snippets=true');
      return new Response(
        JSON.stringify({
          web: {
            results: [
              {
                title: 'Brave Hit',
                url: 'https://brave.example/doc',
                description: 'Best <strong>Greek</strong> places',
                extra_snippets: ['Extra context one', 'Extra context two'],
              },
            ],
          },
          news: {
            results: [
              {
                title: 'News Hit',
                url: 'https://news.example/story',
                description: 'breaking',
              },
            ],
          },
        }),
        { status: 200 }
      );
    };

    const result = await runExternalSearch({
      query: 'hello world',
      service: service('brave'),
      fetchImpl,
    });

    expect((calls[0]?.init?.headers as Record<string, string>)['X-Subscription-Token']).toBe(
      'test-key'
    );
    expect(result.items[0]?.title).toBe('Brave Hit');
    expect(result.items[0]?.text).toContain('Best Greek places');
    expect(result.items[0]?.text).not.toContain('<strong>');
    expect(result.items[0]?.text).toContain('Extra context one');
    expect(result.items.some((item) => item.url.includes('news.example'))).toBe(true);
  });

  it('maps Firecrawl v2 web results and trims long markdown', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: {
            web: [
              {
                title: 'FC Doc',
                url: 'https://example.com/fc',
                description: 'short desc',
                markdown: '# Huge\n\n' + 'x'.repeat(2000),
              },
              {
                url: 'https://example.com/meta-only',
                metadata: { title: 'From Meta', description: 'meta desc' },
              },
            ],
          },
        }),
        { status: 200 }
      );

    const result = await runExternalSearch({
      query: 'firecrawl shape',
      service: service('firecrawl'),
      fetchImpl,
    });
    expect(result.items[0]?.title).toBe('FC Doc');
    expect(result.items[0]?.text).toBe('short desc');
    expect(result.items[1]?.title).toBe('From Meta');
    expect(result.items[1]?.text).toContain('meta desc');
  });

  it('runs Grok Responses search and normalizes weak citation titles', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text:
                    '**2026世界杯阿根廷 vs 瑞士**[[1]](https://finance.sina.com.cn/wm/2026-07-12/doc.html) 已结束。',
                  annotations: [
                    {
                      type: 'url_citation',
                      url: 'https://finance.sina.com.cn/wm/2026-07-12/doc.html',
                      title: '1',
                    },
                    { type: 'url_citation', url: 'https://www.fifa.com/tournament', title: '2' },
                  ],
                },
              ],
            },
          ],
          citations: ['https://example.com/cite'],
        }),
        { status: 200 }
      );
    };

    const result = await runExternalSearch({
      query: 'what is grok',
      service: service('grok', { apiKey: 'test-key', model: undefined }),
      fetchImpl,
    });

    expect(calls[0]?.url).toBe('https://api.x.ai/v1/responses');
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.model).toBe(DEFAULT_GROK_SEARCH_MODEL);
    expect(body.tools).toEqual([{ type: 'web_search' }, { type: 'x_search' }]);
    expect(result.answer).toContain('2026世界杯');
    expect(result.answer).not.toContain('[[1]]');
    expect(result.items.map((item) => item.url)).toEqual(
      expect.arrayContaining([
        'https://example.com/cite',
        'https://finance.sina.com.cn/wm/2026-07-12/doc.html',
        'https://www.fifa.com/tournament',
      ])
    );
    const sina = result.items.find((item) => item.url.includes('sina.com.cn'));
    expect(sina?.title).not.toBe('1');
    expect(isWeakSearchTitle(sina?.title ?? '', sina?.url ?? '')).toBe(false);
  });

  it('detects weak citation titles and cleans Grok-style answer markdown', () => {
    expect(isWeakSearchTitle('1', 'https://example.com/a')).toBe(true);
    expect(isWeakSearchTitle('Real Title', 'https://example.com/a')).toBe(false);
    expect(titleFromSearchUrl('https://www.fifa.com/tournaments/mens/worldcup')).toMatch(
      /fifa\.com|worldcup/i
    );
    expect(titleFromSearchUrl('https://finance.sina.com.cn/wm/2026-07-12/doc.html')).toContain(
      'sina.com.cn'
    );
    const links = extractLinksFromAnswerText(
      'see [[1]](https://example.com/a) and [Hello World](https://example.com/b)'
    );
    expect(links.map((item) => item.url)).toEqual(
      expect.arrayContaining(['https://example.com/a', 'https://example.com/b'])
    );
    expect(
      cleanSearchAnswerForDisplay('**score**[[1]](https://example.com/a) done')
    ).toBe('**score** done');
  });

  it('runs anonymous Bing HTML search without API key', async () => {
    const html = `
      <ol id="b_results">
        <li class="b_algo">
          <h2><a href="https://example.com/bing-hit">Bing Title</a></h2>
          <div class="b_caption"><p>Snippet text here</p></div>
        </li>
      </ol>
    `;
    const fetchImpl: typeof fetch = async (input) => {
      expect(String(input)).toContain('https://www.bing.com/search?q=');
      return new Response(html, { status: 200 });
    };

    const result = await runExternalSearch({
      query: 'bing free',
      service: service('bing', { apiKey: undefined }),
      fetchImpl,
    });

    expect(result.items[0]?.title).toBe('Bing Title');
    expect(result.items[0]?.url).toBe('https://example.com/bing-hit');
    expect(result.items[0]?.text).toContain('Snippet');
  });

  it('runs DuckDuckGo HTML scrape without API key when Instant Answer is thin', async () => {
    let call = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      call += 1;
      if (call === 1) {
        expect(String(input)).toContain('api.duckduckgo.com');
        return new Response(JSON.stringify({ AbstractURL: '', RelatedTopics: [] }), {
          status: 200,
        });
      }
      expect(String(input)).toContain('html.duckduckgo.com');
      expect(init?.method).toBe('POST');
      const html = `
        <div class="result">
          <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fddg">DDG Result</a>
          <a class="result__snippet">Privacy first snippet</a>
        </div>
      `;
      return new Response(html, { status: 200 });
    };

    const result = await runExternalSearch({
      query: 'privacy',
      service: service('duckduckgo', { apiKey: undefined }),
      fetchImpl,
    });

    expect(result.items[0]?.title).toBe('DDG Result');
    expect(result.items[0]?.url).toBe('https://example.com/ddg');
  });

  it('runs Firecrawl with optional bearer token', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            web: [
              {
                title: 'FC',
                url: 'https://example.com/fc',
                description: 'firecrawl hit',
              },
            ],
          },
        }),
        { status: 200 }
      );
    };

    const withKey = await runExternalSearch({
      query: 'crawl me',
      service: service('firecrawl'),
      fetchImpl,
    });
    expect(calls[0]?.url).toBe('https://api.firecrawl.dev/v2/search');
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer test-key'
    );
    expect(withKey.items[0]?.title).toBe('FC');

    const withoutKey = await runExternalSearch({
      query: 'anonymous quota',
      service: service('firecrawl', { apiKey: undefined }),
      fetchImpl,
    });
    expect(calls[1]?.url).toBe('https://api.firecrawl.dev/v2/search');
    expect(
      (calls[1]?.init?.headers as Record<string, string>).Authorization
    ).toBeUndefined();
    expect(withoutKey.items[0]?.url).toBe('https://example.com/fc');
  });

  it('rejects key-required providers without a key', async () => {
    await expect(
      runExternalSearch({
        query: 'x',
        service: service('tavily', { apiKey: undefined }),
        fetchImpl: async () => new Response('{}', { status: 200 }),
      })
    ).rejects.toThrow(/API Key/);
  });

  it('rejects private custom endpoints and oversized search responses', async () => {
    await expect(
      runExternalSearch({
        query: 'x',
        service: service('tavily', { endpoint: 'https://10.0.0.1/search' }),
        fetchImpl: async () => new Response('{}', { status: 200 }),
      })
    ).rejects.toThrow(/本机或私网/);

    await expect(
      runExternalSearch({
        query: 'x',
        service: service('tavily'),
        fetchImpl: async () =>
          new Response('{}', {
            status: 200,
            headers: { 'content-length': String(6 * 1024 * 1024) },
          }),
      })
    ).rejects.toThrow(/响应过大/);
  });
});

function extendedService(
  kind: ExtendedExternalSearchService['kind'],
  overrides: Partial<ExtendedExternalSearchService> = {}
): ExtendedExternalSearchService {
  return {
    id: `${kind}-1`,
    kind,
    name: allExternalSearchProviderLabels[kind],
    apiKey: 'test-ext-key',
    ...overrides,
  };
}

describe('extended external search engines (DeepSeek / Bocha / Exa / SearXNG)', () => {
  it('keeps legacy 6-item exports intact while exposing 10-item superset metadata and SearXNG endpoint requirement', () => {
    expect(externalSearchProviderKinds).toHaveLength(6);
    expect(allExternalSearchProviderKinds).toHaveLength(10);
    expect(allExternalSearchProviderKinds).toEqual(
      expect.arrayContaining(['deepseek', 'bocha', 'exa', 'searxng'])
    );

    expect(externalSearchProviderRequiresApiKey('deepseek')).toBe(true);
    expect(externalSearchProviderRequiresApiKey('bocha')).toBe(true);
    expect(externalSearchProviderRequiresApiKey('exa')).toBe(true);
    expect(externalSearchProviderAllowsAnonymous('searxng')).toBe(true);
    expect(externalSearchProviderRequiresApiKey('searxng')).toBe(false);

    // SearXNG 无默认公共实例，必须配置合法 HTTPS endpoint 才算 configured
    expect(
      isExternalSearchServiceConfigured(extendedService('searxng', { apiKey: undefined, endpoint: undefined }))
    ).toBe(false);
    expect(
      isExternalSearchServiceConfigured(extendedService('searxng', { apiKey: undefined, endpoint: 'http://searx.local' }))
    ).toBe(false);
    expect(
      isExternalSearchServiceConfigured(extendedService('searxng', { apiKey: undefined, endpoint: 'https://searx.example.com' }))
    ).toBe(true);
  });

  it('runs DeepSeek Search and runDeepSeekFetch with SSRF protection', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith('/tools/fetch')) {
        return new Response(
          JSON.stringify({ title: 'DeepSeek Doc', content: 'Fetched markdown content' }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          results: [
            { title: 'DS Hit', url: 'https://platform.deepseek.com/docs', summary: 'DS summary' },
            { title: 'LAN Hit', url: 'https://10.0.0.5/internal', summary: 'Should be dropped' },
          ],
        }),
        { status: 200 }
      );
    };

    const searchResult = await runExternalSearch({
      query: 'deepseek api',
      service: extendedService('deepseek'),
      maxResults: 3,
      fetchImpl,
    });
    expect(calls[0]?.url).toBe('https://api.deepseek.com/v1/tools/search');
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe('Bearer test-ext-key');
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      query: 'deepseek api',
      count: 3,
      need_content: true,
    });
    expect(searchResult.items).toHaveLength(1);
    expect(searchResult.items[0]?.url).toBe('https://platform.deepseek.com/docs');

    const fetched = await runDeepSeekFetch({
      url: 'https://platform.deepseek.com/docs?lang=zh',
      apiKey: 'test-ext-key',
      fetchImpl,
    });
    expect(calls[1]?.url).toBe('https://api.deepseek.com/v1/tools/fetch');
    expect(fetched.content).toBe('Fetched markdown content');

    await expect(
      runDeepSeekFetch({
        url: 'https://169.254.169.254/latest/meta-data',
        apiKey: 'test-ext-key',
        fetchImpl,
      })
    ).rejects.toThrow(/本机或私网/);
  });

  it('runs Bocha web search and rejects non-200 business codes', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          code: 200,
          data: {
            webPages: {
              value: [
                {
                  name: '博查测试',
                  url: 'https://bochaai.com/docs',
                  summary: '博查摘要内容',
                },
              ],
            },
          },
        }),
        { status: 200 }
      );
    };

    const result = await runExternalSearch({
      query: '博查 API',
      service: extendedService('bocha'),
      maxResults: 4,
      fetchImpl,
    });
    expect(calls[0]?.url).toBe('https://api.bochaai.com/v1/web-search');
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      query: '博查 API',
      freshness: 'noLimit',
      summary: true,
      count: 4,
    });
    expect(result.items[0]).toMatchObject({
      title: '博查测试',
      url: 'https://bochaai.com/docs',
      text: '博查摘要内容',
    });

    await expect(
      runExternalSearch({
        query: 'bad code',
        service: extendedService('bocha'),
        fetchImpl: async () => new Response(JSON.stringify({ code: 403, msg: 'quota exceeded' }), { status: 200 }),
      })
    ).rejects.toThrow(/quota exceeded/);
  });

  it('runs Exa AI search with x-api-key and highlights parsing', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          results: [
            {
              title: 'Exa Search',
              url: 'https://docs.exa.ai/reference/search',
              highlights: ['Neural highlight 1', 'Neural highlight 2'],
              text: 'Full fallback text',
            },
          ],
        }),
        { status: 200 }
      );
    };

    const result = await runExternalSearch({
      query: 'exa neural',
      service: extendedService('exa'),
      maxResults: 5,
      fetchImpl,
    });
    expect(calls[0]?.url).toBe('https://api.exa.ai/search');
    expect((calls[0]?.init?.headers as Record<string, string>)['x-api-key']).toBe('test-ext-key');
    expect(result.items[0]?.text).toContain('Neural highlight 1');
  });

  it('runs SearXNG with /search path completion, format=json, and clear HTML error hints', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          results: [
            {
              title: 'SearXNG Result',
              url: 'https://docs.searxng.org/',
              content: 'Metasearch snippet',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const result = await runExternalSearch({
      query: 'hello searxng',
      service: extendedService('searxng', {
        apiKey: undefined,
        endpoint: 'https://searx.example.com',
      }),
      fetchImpl,
    });
    expect(calls[0]?.url).toBe('https://searx.example.com/search?q=hello+searxng&format=json');
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(result.items[0]?.title).toBe('SearXNG Result');

    await expect(
      runExternalSearch({
        query: 'html err',
        service: extendedService('searxng', {
          apiKey: undefined,
          endpoint: 'https://searx.example.com/search',
        }),
        fetchImpl: async () =>
          new Response('<html><body>SearXNG HTML</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      })
    ).rejects.toThrow(/format=json/);
  });

  it('handles 400/404/410 HTTP errors, AbortSignal, and never sends Grok search_parameters', async () => {
    for (const status of [400, 404, 410]) {
      await expect(
        runExternalSearch({
          query: 'err',
          service: extendedService('grok'),
          fetchImpl: async (input, init) => {
            expect(String(input)).toBe('https://api.x.ai/v1/responses');
            expect(String(init?.body)).not.toContain('search_parameters');
            return new Response(JSON.stringify({ error: `HTTP ${status}` }), { status });
          },
        })
      ).rejects.toThrow(new RegExp(String(status)));
    }

    const abortController = new AbortController();
    abortController.abort(new Error('manual cancel'));
    await expect(
      runExternalSearch({
        query: 'cancelled',
        service: extendedService('exa'),
        signal: abortController.signal,
        fetchImpl: async () => new Response('{}', { status: 200 }),
      })
    ).rejects.toThrow(/manual cancel/);
  });

  it('blocks IPv6 transition, documentation, and site-local SSRF addresses with 0 fetch calls and handles Bocha string error codes', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    for (const blockedUrl of [
      'https://[64:ff9b::127.0.0.1]/x',
      'https://[2002:7f00:0001::]/x',
      'https://[fec0::1]/x',
      'https://[2001:db8::1]/x',
      'https://[100::1]/x',
    ]) {
      await expect(
        runDeepSeekFetch({
          url: blockedUrl,
          apiKey: 'test-ext-key',
          fetchImpl: fetchSpy,
        })
      ).rejects.toThrow(/本机或私网/);

      await expect(
        runExternalSearch({
          query: 'ssrf',
          service: extendedService('searxng', { apiKey: undefined, endpoint: blockedUrl }),
          fetchImpl: fetchSpy,
        })
      ).rejects.toThrow(/本机或私网/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();

    // Bocha 字符串错误码 "403"
    await expect(
      runExternalSearch({
        query: 'string code',
        service: extendedService('bocha'),
        fetchImpl: async () =>
          new Response(JSON.stringify({ code: '403', msg: 'Invalid API Key' }), { status: 200 }),
      })
    ).rejects.toThrow(/Invalid API Key/);

    // 弱标题忽略尾部斜杠与大小写
    expect(isWeakSearchTitle('https://example.com', 'https://example.com/')).toBe(true);
    expect(isWeakSearchTitle('HTTPS://EXAMPLE.COM', 'https://example.com/')).toBe(true);
    expect(titleFromSearchUrl('https://example.com/')).toBe('example.com');
  });

  it('strictly caps client results to maxResults when upstream providers return extra items', async () => {
    const fourUrls = [
      'https://example.com/1',
      'https://example.com/2',
      'https://example.com/3',
      'https://example.com/4',
    ];

    // Tavily
    const tavilyRes = await runExternalSearch({
      query: 'cap test',
      service: service('tavily'),
      maxResults: 3,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            results: fourUrls.map((url, idx) => ({ title: `T${idx + 1}`, url, content: 'body' })),
          }),
          { status: 200 }
        ),
    });
    expect(tavilyRes.items).toHaveLength(3);

    // Firecrawl
    const firecrawlRes = await runExternalSearch({
      query: 'cap test',
      service: service('firecrawl'),
      maxResults: 3,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            data: {
              web: fourUrls.map((url, idx) => ({ title: `F${idx + 1}`, url, description: 'body' })),
            },
          }),
          { status: 200 }
        ),
    });
    expect(firecrawlRes.items).toHaveLength(3);

    // DeepSeek
    const deepseekRes = await runExternalSearch({
      query: 'cap test',
      service: extendedService('deepseek'),
      maxResults: 3,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            results: fourUrls.map((url, idx) => ({ title: `D${idx + 1}`, url, summary: 'body' })),
          }),
          { status: 200 }
        ),
    });
    expect(deepseekRes.items).toHaveLength(3);

    // Bocha
    const bochaRes = await runExternalSearch({
      query: 'cap test',
      service: extendedService('bocha'),
      maxResults: 3,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            code: 200,
            data: {
              webPages: {
                value: fourUrls.map((url, idx) => ({ name: `B${idx + 1}`, url, summary: 'body' })),
              },
            },
          }),
          { status: 200 }
        ),
    });
    expect(bochaRes.items).toHaveLength(3);

    // Exa
    const exaRes = await runExternalSearch({
      query: 'cap test',
      service: extendedService('exa'),
      maxResults: 3,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            results: fourUrls.map((url, idx) => ({ title: `E${idx + 1}`, url, text: 'body' })),
          }),
          { status: 200 }
        ),
    });
    expect(exaRes.items).toHaveLength(3);

    // SearXNG
    const searxngRes = await runExternalSearch({
      query: 'cap test',
      service: extendedService('searxng', { apiKey: undefined, endpoint: 'https://searx.example.com' }),
      maxResults: 3,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            results: fourUrls.map((url, idx) => ({ title: `S${idx + 1}`, url, content: 'body' })),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        ),
    });
    expect(searxngRes.items).toHaveLength(3);
  });

  it('redacts raw and percent-encoded external search apiKey across HTTP errors, Bocha error codes, and DeepSeek Fetch', async () => {
    const rawKey = 'tvly-secret+key/val=9911';
    const mixedCaseEncoded = encodeURIComponent(rawKey)
      .replace(/%2B/gi, '%2b')
      .replace(/%2F/gi, '%2F')
      .replace(/%3D/gi, '%3d');

    // 1) Tavily HTTP 401 回显原文与混合大小写编码密钥
    await expect(
      runExternalSearch({
        query: 'redact tavily',
        service: service('tavily', { apiKey: rawKey }),
        fetchImpl: async () =>
          new Response(
            JSON.stringify({ detail: `Invalid key ${rawKey} / ${mixedCaseEncoded}` }),
            { status: 401 }
          ),
      })
    ).rejects.toSatisfy((err: Error) => {
      const msg = err.message;
      return (
        msg.includes('HTTP 401') &&
        msg.includes('[REDACTED]') &&
        !msg.includes(rawKey) &&
        !msg.includes(mixedCaseEncoded)
      );
    });

    // 2) SearXNG HTTP 403 回显可选 apiKey
    await expect(
      runExternalSearch({
        query: 'redact searxng',
        service: extendedService('searxng', {
          apiKey: rawKey,
          endpoint: 'https://searx.example.com',
        }),
        fetchImpl: async () =>
          new Response(`Forbidden token ${rawKey} (${mixedCaseEncoded})`, { status: 403 }),
      })
    ).rejects.toSatisfy((err: Error) => {
      const msg = err.message;
      return (
        msg.includes('HTTP 403') &&
        msg.includes('[REDACTED]') &&
        !msg.includes(rawKey) &&
        !msg.includes(mixedCaseEncoded)
      );
    });

    // 3) Bocha HTTP 200 业务错误码回显密钥
    await expect(
      runExternalSearch({
        query: 'redact bocha',
        service: extendedService('bocha', { apiKey: rawKey }),
        fetchImpl: async () =>
          new Response(
            JSON.stringify({ code: 401, msg: `Auth failed: ${rawKey} / ${mixedCaseEncoded}` }),
            { status: 200 }
          ),
      })
    ).rejects.toSatisfy((err: Error) => {
      const msg = err.message;
      return (
        msg.includes('[REDACTED]') &&
        !msg.includes(rawKey) &&
        !msg.includes(mixedCaseEncoded)
      );
    });

    // 4) Bing fetchText HTTP 500 回显可选 apiKey
    await expect(
      runExternalSearch({
        query: 'redact bing',
        service: service('bing', { apiKey: rawKey }),
        fetchImpl: async () => new Response(`Upstream error ${rawKey}`, { status: 500 }),
      })
    ).rejects.toSatisfy((err: Error) => {
      const msg = err.message;
      return msg.includes('HTTP 500') && msg.includes('[REDACTED]') && !msg.includes(rawKey);
    });

    // 5) runDeepSeekFetch HTTP 401 与网络异常脱敏
    await expect(
      runDeepSeekFetch({
        url: 'https://example.com/article',
        apiKey: rawKey,
        fetchImpl: async () =>
          new Response(`Unauthorized ${rawKey} / ${mixedCaseEncoded}`, { status: 401 }),
      })
    ).rejects.toSatisfy((err: Error) => {
      const msg = err.message;
      return (
        msg.includes('HTTP 401') &&
        msg.includes('[REDACTED]') &&
        !msg.includes(rawKey) &&
        !msg.includes(mixedCaseEncoded)
      );
    });

    await expect(
      runDeepSeekFetch({
        url: 'https://example.com/article',
        apiKey: rawKey,
        fetchImpl: async () => {
          throw new Error(`fetch failed with ${rawKey}`);
        },
      })
    ).rejects.toSatisfy((err: Error) => {
      const msg = err.message;
      return msg.includes('[REDACTED]') && !msg.includes(rawKey);
    });
  });

  it('enforces redirect: error, rejects non-443 ports, and aborts hanging streams immediately', async () => {
    const capturedInits: RequestInit[] = [];
    const okFetch: typeof fetch = async (_input, init) => {
      if (init) capturedInits.push(init);
      return new Response(
        JSON.stringify({
          results: [{ title: 'OK', url: 'https://example.com/ok', content: 'body' }],
        }),
        { status: 200 }
      );
    };

    await runExternalSearch({
      query: 'redirect check',
      service: service('tavily'),
      fetchImpl: okFetch,
    });
    expect(capturedInits[0]?.redirect).toBe('error');

    await runDeepSeekFetch({
      url: 'https://example.com/doc',
      apiKey: 'ds-key-1234',
      fetchImpl: async (_input, init) => {
        if (init) capturedInits.push(init);
        return new Response(JSON.stringify({ data: { title: 'Doc', content: 'Body' } }), {
          status: 200,
        });
      },
    });
    expect(capturedInits[1]?.redirect).toBe('error');

    // 非标准 443 端口防 SSRF 端口扫描
    await expect(
      runExternalSearch({
        query: 'port ssrf',
        service: extendedService('searxng', {
          apiKey: undefined,
          endpoint: 'https://searx.example.com:8443/search',
        }),
        fetchImpl: okFetch,
      })
    ).rejects.toThrow(/443/);

    await expect(
      runDeepSeekFetch({
        url: 'https://example.com:8080/internal',
        apiKey: 'ds-key-1234',
        fetchImpl: okFetch,
      })
    ).rejects.toThrow(/443/);

    // 流挂起时 AbortSignal 在 < 200ms 内快速退出并确定性取消 reader
    let streamCancelled = false;
    let markReadingStarted: (() => void) | undefined;
    let markStreamCancelled: (() => void) | undefined;
    const readingStarted = new Promise<void>((resolve) => {
      markReadingStarted = resolve;
    });
    const streamCancelledPromise = new Promise<void>((resolve) => {
      markStreamCancelled = resolve;
    });
    const hangingStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":'));
      },
      pull() {
        markReadingStarted?.();
      },
      cancel() {
        streamCancelled = true;
        markStreamCancelled?.();
      },
    });
    const abortCtrl = new AbortController();
    const pending = runExternalSearch({
      query: 'hang stream',
      service: service('tavily'),
      signal: abortCtrl.signal,
      fetchImpl: async () => new Response(hangingStream, { status: 200 }),
    });
    const expectAbort = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await readingStarted;
    const startedAt = Date.now();
    abortCtrl.abort();
    await expectAbort;
    expect(Date.now() - startedAt).toBeLessThan(200);
    await streamCancelledPromise;
    expect(streamCancelled).toBe(true);
  });

  it('falls back to DOM web detection and fails closed when react-native import fails or Platform.OS is missing', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('window', { location: { protocol: 'https:', hostname: 'app.example.com' } });
    vi.stubGlobal('document', {});
    vi.stubGlobal('fetch', fetchSpy);

    try {
      // 1) import('react-native') 抛出异常时兜底识别为 web 并 fail-closed
      vi.resetModules();
      vi.doMock('react-native', () => {
        throw new Error('react-native chunk unavailable');
      });
      const modWhenThrow = await import('../src/services/externalSearch');
      await expect(
        modWhenThrow.runExternalSearch({
          query: 'dom fallback throw',
          service: service('tavily'),
          fetchImpl: fetchSpy,
        })
      ).rejects.toThrow(/正式 Web 构建不会发送/);
      await expect(
        modWhenThrow.runDeepSeekFetch({
          url: 'https://example.com/article',
          apiKey: 'ds-key-1234',
          fetchImpl: fetchSpy,
        })
      ).rejects.toThrow(/正式 Web 构建不会发送/);

      // 2) Platform.OS 缺失时同样兜底识别为 web 并 fail-closed
      vi.resetModules();
      vi.doMock('react-native', () => ({ Platform: {} }));
      const modWhenMissingOs = await import('../src/services/externalSearch');
      await expect(
        modWhenMissingOs.runExternalSearch({
          query: 'dom fallback empty os',
          service: service('tavily'),
          fetchImpl: fetchSpy,
        })
      ).rejects.toThrow(/正式 Web 构建不会发送/);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('react-native');
      vi.resetModules();
      vi.unstubAllGlobals();
    }
  });
});
