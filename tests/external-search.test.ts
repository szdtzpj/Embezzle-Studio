import { describe, expect, it } from 'vitest';

import type { ExternalSearchService } from '../src/domain/types';
import {
  citationsFromExternalSearchResults,
  cleanSearchAnswerForDisplay,
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
  resolveActiveExternalSearchService,
  runExternalSearch,
  stripExternalSearchSecrets,
  titleFromSearchUrl,
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
    expect(externalSearchProviderRequiresApiKey('tavily')).toBe(true);
    expect(isExternalSearchServiceConfigured(service('bing', { apiKey: undefined }))).toBe(true);
    expect(isExternalSearchServiceConfigured(service('tavily', { apiKey: undefined }))).toBe(false);

    const settings = normalizeExternalSearchSettings({
      enabled: true,
      services: [{ id: 'b1', kind: 'bing', name: 'Bing' }],
    });
    expect(isExternalSearchReady(settings)).toBe(true);
    expect(resolveActiveExternalSearchService(settings)?.kind).toBe('bing');
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
      service: service('grok', { model: 'grok-4-1-fast-reasoning' }),
      fetchImpl,
    });

    expect(calls[0]?.url).toBe('https://api.x.ai/v1/responses');
    const body = JSON.parse(String(calls[0]?.init?.body));
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
      query: 'self host',
      service: service('firecrawl', {
        apiKey: undefined,
        endpoint: 'https://fc.example.com/v2/search',
      }),
      fetchImpl,
    });
    expect(calls[1]?.url).toBe('https://fc.example.com/v2/search');
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
});
