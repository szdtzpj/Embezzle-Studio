import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatConversation, ChatMessage, ProviderContinuationBlock } from '../src/domain/types';
import {
  exportConversation,
  exportConversationToJson,
  exportConversationToMarkdown,
  sanitizeExportFilename,
} from '../src/services/conversationExport';

const mocks = vi.hoisted(() => ({
  platform: { OS: 'web' as 'web' | 'android' | 'ios' },
  sharingAvailable: vi.fn(),
  shareAsync: vi.fn(),
  createdFiles: [] as Array<{ uri: string; content: string; deleted: boolean }>,
  shouldShareFail: false,
}));

vi.mock('react-native', () => ({ Platform: mocks.platform }));
vi.mock('expo-sharing', () => ({
  isAvailableAsync: mocks.sharingAvailable,
  shareAsync: mocks.shareAsync,
}));
vi.mock('expo-file-system', () => {
  class MockFile {
    readonly uri: string;
    exists = false;
    private content = '';
    private record: { uri: string; content: string; deleted: boolean };

    constructor(dir: { uri?: string } | string, name: string) {
      const base = typeof dir === 'string' ? dir : dir.uri ?? 'file:///mock-cache';
      this.uri = `${base}/${name}`;
      this.record = { uri: this.uri, content: '', deleted: false };
      mocks.createdFiles.push(this.record);
    }

    create(): void {
      this.exists = true;
    }

    write(value: string): void {
      this.content = value;
      this.record.content = value;
    }

    delete(): void {
      this.exists = false;
      this.record.deleted = true;
    }
  }

  return {
    File: MockFile,
    Paths: { cache: { uri: 'file:///mock-cache' } },
  };
});

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2S8AAAAASUVORK5CYII=';

function makeSampleConversation(overrides: Partial<ChatConversation> = {}): ChatConversation {
  const encryptedContinuation: ProviderContinuationBlock = {
    provider: 'xai',
    type: 'reasoning_encrypted',
    encryptedContent: 'xai_encrypted_blob_secret_unit_test',
  };

  const assistantWithSecret = {
    id: 'm-3',
    role: 'assistant',
    content: 'TypeScript 适合全栈快速迭代。\n\n```typescript\nconst ok = true;\n```',
    createdAt: 1700000003000,
    status: 'ready',
    modelId: 'gpt-5.4',
    providerName: 'OpenAI',
    reasoningContent: '先比对类型系统静态保障，再评估运行期开销。',
    thinkingDurationMs: 2400,
    providerContinuations: [encryptedContinuation],
    citations: [
      {
        index: 1,
        title: 'TypeScript Docs',
        url: 'https://www.typescriptlang.org/docs/',
      },
      {
        index: 2,
        title: 'Rust Book',
        url: 'https://doc.rust-lang.org/book/',
      },
    ],
    attachments: [
      {
        id: 'att-1',
        kind: 'image',
        uri: `data:image/png;base64,${TINY_PNG_BASE64}`,
        name: 'arch-diagram.png',
        mimeType: 'image/png',
        base64: TINY_PNG_BASE64,
        size: 68,
      },
    ],
    apiKey: 'sk-secret-must-be-redacted-12345',
    authorization: 'Bearer should-never-leak',
    raw: { secretRawField: 'should-never-leak' },
  } as unknown as ChatMessage;

  return {
    id: 'conv-export-1',
    title: 'TypeScript 与 Rust 架构对比',
    createdAt: 1700000000000,
    updatedAt: 1700000005000,
    messages: [
      {
        id: 'm-1',
        role: 'system',
        content: '你是一个严谨的技术架构助手',
        createdAt: 1700000001000,
        status: 'ready',
      },
      {
        id: 'm-2',
        role: 'user',
        content: '对比这两种语言',
        createdAt: 1700000002000,
        status: 'ready',
      },
      assistantWithSecret,
    ],
    ...overrides,
  };
}

beforeEach(() => {
  mocks.platform.OS = 'web';
  mocks.sharingAvailable.mockReset();
  mocks.sharingAvailable.mockResolvedValue(true);
  mocks.shareAsync.mockReset();
  mocks.shareAsync.mockImplementation(async () => {
    if (mocks.shouldShareFail) {
      throw new Error('share canceled');
    }
  });
  mocks.createdFiles.length = 0;
  mocks.shouldShareFail = false;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('sanitizeExportFilename', () => {
  it('sanitizes path traversal, control/bidi chars, duplicate extensions, Windows reserved names, and long Unicode stems', () => {
    expect(sanitizeExportFilename('', 'md')).toBe('conversation.md');
    expect(sanitizeExportFilename('   ', 'json')).toBe('conversation.json');

    const traversal = sanitizeExportFilename('../../CON:*?"<>|\x00\u202E\n', 'md');
    expect(traversal).toMatch(/\.md$/);
    expect(traversal).not.toMatch(/[/\\:*?"<>|\x00\r\n\u202E]/);
    expect(traversal.toUpperCase()).not.toBe('CON.MD');
    expect(traversal).toBe('_CON.md');

    const reservedNul = sanitizeExportFilename('NUL', 'json');
    expect(reservedNul).toBe('_NUL.json');

    const dupExt = sanitizeExportFilename('xAI:/\\CON*?.md', 'md');
    expect(dupExt).not.toMatch(/[/\\:*?]/);
    expect(dupExt.endsWith('.md.md')).toBe(false);
    expect(dupExt).toBe('xAI-CON.md');

    const longTitle = '图'.repeat(150);
    const truncated = sanitizeExportFilename(longTitle, 'json');
    expect(Array.from(truncated).length).toBeLessThanOrEqual(120);
    expect(truncated.endsWith('.json')).toBe(true);
  });
});

describe('exportConversationToMarkdown', () => {
  it('exports title, role labels, thinking collapsible block, citations, and attachment placeholders without base64', () => {
    const md = exportConversationToMarkdown(makeSampleConversation());

    expect(md).toContain('# TypeScript 与 Rust 架构对比');
    expect(md).toContain('## 系统');
    expect(md).toContain('## 用户');
    expect(md).toContain('## 助手 (OpenAI / gpt-5.4)');
    expect(md).toContain('<details>');
    expect(md).toContain('深度思考 (2.4s)');
    expect(md).toContain('先比对类型系统静态保障');
    expect(md).toContain('https://www.typescriptlang.org/docs/');
    expect(md).toContain('https://doc.rust-lang.org/book/');
    expect(md).toContain('arch-diagram.png');
    expect(md).not.toContain(TINY_PNG_BASE64);
    expect(md).not.toContain('sk-secret-must-be-redacted-12345');
    expect(md).not.toContain('xai_encrypted_blob_secret_unit_test');

    const withoutExtras = exportConversationToMarkdown(makeSampleConversation(), {
      includeThinking: false,
      includeCitations: false,
    });
    expect(withoutExtras).not.toContain('<details>');
    expect(withoutExtras).not.toContain('https://www.typescriptlang.org/docs/');
  });

  it('handles empty conversations, pending/error status, error secret redaction, XSS escaping, and 5+ backtick escalation', () => {
    const emptyMd = exportConversationToMarkdown(makeSampleConversation({ title: '', messages: [] }));
    expect(emptyMd.length).toBeGreaterThan(0);
    expect(emptyMd).toContain('# 未命名对话');

    const xssAndErrorsConv = makeSampleConversation({
      title: '# <script>alert("xss")</script> 注入测试',
      messages: [
        {
          id: 'm-err',
          role: 'assistant',
          content: '',
          createdAt: 1,
          status: 'error',
          error: '上游 502 Bad Gateway apiKey=sk-leak-99999',
        },
        {
          id: 'm-pending',
          role: 'assistant',
          content: '生成了一半…',
          createdAt: 2,
          status: 'pending',
        },
        {
          id: 'm-xss',
          role: 'assistant',
          content:
            '公式 $E=mc^2$。\n\n```typescript\nconst a = 1;\n```\n\n````markdown\n# nested\n<script>evil()</script>\n````',
          reasoningContent: '</details><script>alert(2)</script>',
          createdAt: 3,
          status: 'ready',
        },
      ],
    });

    const safeMd = exportConversationToMarkdown(xssAndErrorsConv);
    expect(safeMd).toContain('上游 502 Bad Gateway');
    expect(safeMd).not.toContain('sk-leak-99999');
    expect(safeMd).toContain('生成了一半…');
    expect(safeMd).toContain('$E=mc^2$');
    expect(safeMd).toContain('```typescript');
    expect(safeMd).not.toMatch(/<script[\s>]/i);
    expect(safeMd).not.toContain('</details><script>');
    expect(safeMd).toMatch(/`{5,}/);
  });

  it('escapes extended dangerous HTML tags, inline event attributes, angle-bracketed pseudo-protocols, and SVG data URIs while preserving safe links', () => {
    const conv = makeSampleConversation({
      title: 'Attack <SCRIPT SRC="https://evil.test/x.js"></SCRIPT> & <img onerror=alert(1)>',
      messages: [
        {
          id: 'm-xss-extended',
          role: 'assistant',
          content: [
            '安全比较 1 < 2 与数学 $x<a$。',
            '<img src=x onerror=alert(1)> <IMG/ONERROR=alert(2)>',
            '<video onloadstart=alert(3)><source onerror=alert(4)></video>',
            '<audio src=x onerror=alert(5)></audio>',
            '<input onfocus=alert(6)> <button onclick=alert(7)>btn</button>',
            '<marquee onstart=alert(8)>hi</marquee> <math><mi>x</mi></math>',
            '<div title=">" onclick=alert(9)>div</div> <a href="javascript:alert(10)">a</a>',
            '[click](<javascript:alert(1)>) and [obf](  <  JaVaScRiPt:alert(1) > )',
            '[ent](&#106;avascript:alert(1)) and [ctrl](java\tscript:alert(1))',
            '[vb](vbscript:msgbox(1)) and [html](data:text/html,<script>alert(1)</script>)',
            '[svg](data:image/svg+xml,<svg onload=alert(1)>) and ![svg2](data:image/svg+xml;base64,PHN2Zz4=)',
            '[safe-docs](https://www.typescriptlang.org/docs/) and [wiki](https://en.wikipedia.org/wiki/Foo_(bar))',
            '',
            '[ref-evil]: <javascript:alert(1)>',
          ].join('\n'),
          reasoningContent: '</DETAILS><script>alert(1)</script>\n<img onerror=alert(99)>',
          attachments: [
            {
              id: 'att-xss',
              kind: 'image',
              uri: `data:image/png;base64,${TINY_PNG_BASE64}`,
              name: 'secret<img onerror=alert(5)>.png',
              mimeType: 'image/png',
            },
          ],
          createdAt: 10,
          status: 'ready',
        },
      ],
    });

    const md = exportConversationToMarkdown(conv);
    expect(md).not.toMatch(/<(?:img|video|audio|source|input|button|marquee|math|div|a|script)(?=[\s/>])/i);
    expect(md).not.toMatch(/<\/details>\s*<script/i);
    expect(md).not.toMatch(/<javascript:/i);
    expect(md).not.toMatch(/\]\([^)]*(?:javascript|vbscript):/i);
    expect(md).not.toMatch(/\[ref-evil\]:\s*<?javascript:/i);
    expect(md).not.toMatch(/data:text\/html/i);
    expect(md).not.toMatch(/data:image\/svg\+xml/i);
    expect(md).toContain('1 < 2');
    expect(md).toContain('$x<a$');
    expect(md).toContain('[safe-docs](https://www.typescriptlang.org/docs/)');
    expect(md).toContain('[wiki](https://en.wikipedia.org/wiki/Foo_(bar))');
    expect(md).toContain('secret&lt;img onerror=alert(5)>.png');
  });

  it('blocks named HTML entity pseudo-protocols, CommonMark autolinks, and >2048-char padded / >64KB fail-closed HTML tags', () => {
    const pad2100 = 'a'.repeat(2100);
    const pad70k = 'b'.repeat(70_000);
    const conv = makeSampleConversation({
      messages: [
        {
          id: 'm-xss-depth',
          role: 'assistant',
          content: [
            '[named](javascript&colon;alert(1)) [tab](java&Tab;script:alert(1)) [nl](java&NewLine;script:alert(1))',
            '[mixed](&#106;avascript&COLON;alert(1)) [data](data&colon;text&sol;html&comma;&lt;script&gt;alert(1)&lt;/script&gt;)',
            '[safe-query](https://example.com/?a=1&copy=2)',
            '<javascript:alert(1)> and <vbscript:msgbox(1)>',
            '<data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==> and <data:image/svg+xml;base64,PHN2Zz4=>',
            '<javascript&colon;alert(1)>',
            '<https://example.com/docs?q=1&p=2> and <user@example.com>',
            `<div data-pad="${pad2100}" onclick=alert(1)>hi</div>`,
            `<span data-pad="${pad70k}" title="safe">over-64kb</span>`,
            '<div title="unclosed > onclick=alert(1)>quote-bypass</div>',
            `<div class="safe-box" data-pad="${pad2100}">safe-long</div>`,
            "数学表达 $x < a$ 与 1 < 2，以及 We know x<n because it's true。",
          ].join('\n'),
          createdAt: 11,
          status: 'ready',
        },
      ],
    });

    const md = exportConversationToMarkdown(conv);

    // 1. 命名实体伪协议全部拦截
    expect(md).not.toMatch(/javascript&colon;/i);
    expect(md).not.toMatch(/java&Tab;script/i);
    expect(md).not.toMatch(/java&NewLine;script/i);
    expect(md).not.toMatch(/&#106;avascript/i);
    expect(md).not.toMatch(/data&colon;text/i);
    expect(md).toContain('[safe-query](https://example.com/?a=1&copy=2)');

    // 2. CommonMark Autolink 危险协议全部中性化，正常 Autolink 保留
    expect(md).not.toMatch(/<(?:javascript|vbscript):/i);
    expect(md).not.toMatch(/<data:(?:text\/html|image\/svg\+xml)/i);
    expect(md).toContain('<https://example.com/docs?q=1&p=2>');
    expect(md).toContain('<user@example.com>');

    // 3. >2048 字符属性填充、>64KB fail-closed 与未闭合引号吞掉 '>' 均保守转义
    expect(md).toContain(`&lt;div data-pad="${pad2100}" onclick=alert(1)>hi</div>`);
    expect(md).toContain(`&lt;span data-pad="${pad70k}" title="safe">over-64kb</span>`);
    expect(md).toContain('&lt;div title="unclosed > onclick=alert(1)>quote-bypass</div>');

    // 4. 安全长属性标签与数学/撇号文本不被误伤
    expect(md).toContain(`<div class="safe-box" data-pad="${pad2100}">safe-long</div>`);
    expect(md).toContain('$x < a$');
    expect(md).toContain('1 < 2');
    expect(md).toContain("We know x<n because it's true");
  });

  it('preserves inline 4+ backticks, 3-backtick blocks containing 4 backticks, and LaTeX formulas without corrupting structure', () => {
    const inlineFourWithFormula =
      '示例行内反引号 ````code```` 与公式 $E=mc^2$\n\n```ts\nconst a = 1;\n```';
    const threeFenceContainingFour = '```md\n````\n```\n\n正常正文 $E=mc^2$';
    const unclosedFourFence = '````ts\nconst x = 42;';
    const nestedFiveFence = '`````md\n````ts\nconst y = 1;\n````\n`````';

    const conv = makeSampleConversation({
      messages: [
        {
          id: 'm-inline-4',
          role: 'assistant',
          content: inlineFourWithFormula,
          createdAt: 1,
          status: 'ready',
        },
        {
          id: 'm-three-with-four',
          role: 'assistant',
          content: threeFenceContainingFour,
          createdAt: 2,
          status: 'ready',
        },
        {
          id: 'm-unclosed-4',
          role: 'assistant',
          content: unclosedFourFence,
          createdAt: 3,
          status: 'ready',
        },
        {
          id: 'm-nested-5',
          role: 'assistant',
          content: nestedFiveFence,
          createdAt: 4,
          status: 'ready',
        },
      ],
    });

    const md = exportConversationToMarkdown(conv);
    // 场景 A & B 原样保留，绝不被包进 `````markdown 或在末尾追加孤立 `````
    expect(md).toContain(inlineFourWithFormula);
    expect(md).toContain(threeFenceContainingFour);
    expect(md).not.toContain('`````markdown\n示例行内反引号');
    expect(md).not.toContain('正常正文 $E=mc^2$\n\n`````');
    // 场景 C 顶层未闭合 4 反引号安全升阶并闭合
    expect(md).toContain('`````ts\nconst x = 42;\n`````');
    // 场景 D 外层 5 反引号升阶为 6 反引号，内层 4 反引号保持原样
    expect(md).toContain('``````md\n````ts\nconst y = 1;\n````\n`````');
  });

  it('rejects non-public HTTP/loopback citation URLs while preserving and escaping parentheses in valid HTTPS citation URLs', () => {
    const conv = makeSampleConversation({
      messages: [
        {
          id: 'm-cite-security',
          role: 'assistant',
          content: '参考资料如下。',
          createdAt: 5,
          status: 'ready',
          citations: [
            { index: 1, title: 'Local', url: 'http://127.0.0.1/internal' },
            { index: 2, title: 'PlainHttp', url: 'http://example.com/page' },
            { index: 3, title: 'Creds', url: 'https://user:pass@example.com/secret' },
            { index: 4, title: 'Parens', url: 'https://example.com/path(1)' },
          ],
        },
      ],
    });

    const md = exportConversationToMarkdown(conv);
    expect(md).toContain('- [1] [Local](#)');
    expect(md).toContain('- [2] [PlainHttp](#)');
    expect(md).toContain('- [3] [Creds](#)');
    expect(md).not.toContain('http://127.0.0.1/internal');
    expect(md).not.toContain('http://example.com/page');
    expect(md).not.toContain('user:pass@example.com');
    expect(md).toContain('- [4] [Parens](https://example.com/path%281%29)');
    expect(md).not.toContain('https://example.com/path1');
  });
});

describe('exportConversationToJson', () => {
  it('whitelists public fields, strips secrets/continuations/base64, and supports compact output', () => {
    const conv = makeSampleConversation({
      messages: [
        ...makeSampleConversation().messages,
        {
          id: 'm-err',
          role: 'assistant',
          content: '',
          createdAt: 4,
          status: 'error',
          error: 'request failed apiKey=sk-another-leak',
        },
      ],
    });

    const prettyJson = exportConversationToJson(conv, { pretty: true });
    expect(prettyJson).not.toContain('sk-secret-must-be-redacted-12345');
    expect(prettyJson).not.toContain('should-never-leak');
    expect(prettyJson).not.toContain('xai_encrypted_blob_secret_unit_test');
    expect(prettyJson).not.toContain(TINY_PNG_BASE64);
    expect(prettyJson).not.toContain('sk-another-leak');

    const parsed = JSON.parse(prettyJson) as {
      id: string;
      title: string;
      messages: Array<Record<string, unknown>>;
    };
    expect(parsed.id).toBe('conv-export-1');
    expect(parsed.title).toBe('TypeScript 与 Rust 架构对比');
    expect(parsed.messages).toHaveLength(4);
    expect(parsed.messages[2]?.providerContinuations).toBeUndefined();
    expect(parsed.messages[2]?.apiKey).toBeUndefined();

    const compactJson = exportConversationToJson(conv, { pretty: false });
    expect(compactJson).not.toContain('\n  ');
  });

  it('sanitizes unsafe citation URLs in JSON export and redacts secrets when error messages are mirrored into content', () => {
    const conv = makeSampleConversation({
      messages: [
        {
          id: 'm-err-mirror',
          role: 'assistant',
          content: '上游失败 apiKey=sk-content-leak-777&token=tok-leak-888',
          error: '上游失败 apiKey=sk-content-leak-777&token=tok-leak-888',
          createdAt: 10,
          status: 'error',
        },
        {
          id: 'm-ready-code',
          role: 'assistant',
          content: '正常代码说明：\n```ts\nconst apiKey = "example-placeholder";\n```',
          citations: [
            { index: 1, title: 'Unsafe JS', url: 'javascript:alert(1)' },
            { index: 2, title: 'Loopback', url: 'http://127.0.0.1/internal' },
            { index: 3, title: 'Safe HTTPS', url: 'https://example.com/docs' },
          ],
          createdAt: 11,
          status: 'ready',
        },
      ],
    });

    const md = exportConversationToMarkdown(conv);
    expect(md).not.toContain('sk-content-leak-777');
    expect(md).not.toContain('tok-leak-888');
    // 正常 ready 消息中的多行代码块与教学示例保持原样
    expect(md).toContain('```ts\nconst apiKey = "example-placeholder";\n```');

    const jsonStr = exportConversationToJson(conv);
    expect(jsonStr).not.toContain('sk-content-leak-777');
    expect(jsonStr).not.toContain('tok-leak-888');
    expect(jsonStr).not.toContain('javascript:alert(1)');
    expect(jsonStr).not.toContain('http://127.0.0.1/internal');

    const parsed = JSON.parse(jsonStr) as {
      messages: Array<{
        content: string;
        citations?: Array<{ url: string }>;
      }>;
    };
    expect(parsed.messages[1]?.content).toContain('```ts\nconst apiKey = "example-placeholder";\n```');
    expect(parsed.messages[1]?.citations?.map((c) => c.url)).toEqual([
      '#',
      '#',
      'https://example.com/docs',
    ]);
  });

  it('redacts bare Bearer tokens, Authorization headers, and query credentials in error content without swallowing trailing text', () => {
    const conv = makeSampleConversation({
      messages: [
        {
          id: 'm-err-bare-bearer',
          role: 'assistant',
          content: '请求上游失败：Bearer sk-ant-api03-SECRET_KEY_999',
          error: 'HTTP 401',
          createdAt: 20,
          status: 'error',
        },
        {
          id: 'm-err-auth-trailing',
          role: 'assistant',
          content:
            'Header Authorization: Bearer sk-live-secret-token-777 失败，请检查。\ntoken="tok-quoted-999" 且 api_key=sk-inline-111 请排查配置。',
          error: 'HTTP 403',
          createdAt: 21,
          status: 'error',
        },
        {
          id: 'm-err-query-keys',
          role: 'assistant',
          content:
            '请求地址失败 https://api.example.com/v1/search?api_key=sk-q1&x-api-key=xk-q2&access_token=at-q3&client_secret=cs-q4 请重试。',
          error: 'HTTP 502',
          createdAt: 22,
          status: 'error',
        },
        {
          id: 'm-ready-preserved',
          role: 'assistant',
          content: '正常响应保持不变：\n```http\nAuthorization: Bearer example-doc-token\n```',
          createdAt: 23,
          status: 'ready',
        },
      ],
    });

    const md = exportConversationToMarkdown(conv);
    expect(md).not.toContain('sk-ant-api03-SECRET_KEY_999');
    expect(md).toContain('请求上游失败：Bearer [redacted]');
    expect(md).not.toContain('sk-live-secret-token-777');
    expect(md).toContain('失败，请检查。');
    expect(md).not.toContain('tok-quoted-999');
    expect(md).not.toContain('sk-inline-111');
    expect(md).toContain('请排查配置。');
    expect(md).not.toContain('sk-q1');
    expect(md).not.toContain('xk-q2');
    expect(md).not.toContain('at-q3');
    expect(md).not.toContain('cs-q4');
    expect(md).toContain('请重试。');
    expect(md).toContain('Authorization: Bearer example-doc-token');

    const jsonStr = exportConversationToJson(conv);
    expect(jsonStr).not.toContain('sk-ant-api03-SECRET_KEY_999');
    expect(jsonStr).not.toContain('sk-live-secret-token-777');
    expect(jsonStr).not.toContain('tok-quoted-999');
    expect(jsonStr).not.toContain('sk-inline-111');
    expect(jsonStr).not.toContain('sk-q1');
    expect(jsonStr).not.toContain('xk-q2');
    expect(jsonStr).not.toContain('at-q3');
    expect(jsonStr).not.toContain('cs-q4');

    const parsed = JSON.parse(jsonStr) as {
      messages: Array<{ id: string; content: string }>;
    };
    expect(parsed.messages[0]?.content).toBe('请求上游失败：Bearer [redacted]');
    expect(parsed.messages[1]?.content).toContain('失败，请检查。');
    expect(parsed.messages[1]?.content).toContain('请排查配置。');
    expect(parsed.messages[2]?.content).toContain('请重试。');
    expect(parsed.messages[3]?.content).toContain('Authorization: Bearer example-doc-token');
  });

  it('redacts single-escaped and double-escaped nested JSON credentials without swallowing trailing diagnostics', () => {
    const singleEscaped = JSON.stringify({
      error: 'Upstream failed',
      headers: { 'x-api-key': 'sk-single-escaped-secret-123456', trace: 'trace-ok' },
    });
    const doubleEscaped = JSON.stringify(singleEscaped).replace(
      'sk-single-escaped-secret-123456',
      'sk-double-escaped-secret-987654'
    );
    const conv = makeSampleConversation({
      messages: [
        {
          id: 'm-err-escaped',
          role: 'assistant',
          content: `错误详情：\n${singleEscaped}\n${doubleEscaped}\n请检查授权后重试。`,
          error: 'HTTP 401',
          createdAt: 30,
          status: 'error',
        },
      ],
    });

    const md = exportConversationToMarkdown(conv);
    expect(md).not.toContain('sk-single-escaped-secret-123456');
    expect(md).not.toContain('sk-double-escaped-secret-987654');
    expect(md).toContain('trace-ok');
    expect(md).toContain('请检查授权后重试。');

    const jsonStr = exportConversationToJson(conv);
    expect(jsonStr).not.toContain('sk-single-escaped-secret-123456');
    expect(jsonStr).not.toContain('sk-double-escaped-secret-987654');
    expect(jsonStr).toContain('trace-ok');
    expect(jsonStr).toContain('请检查授权后重试。');
  });
});

describe('exportConversation cross-platform delivery', () => {
  it('downloads via Blob and revokes ObjectURL after 1000ms on Web', async () => {
    vi.useFakeTimers();
    mocks.platform.OS = 'web';

    const appended: Array<Record<string, unknown>> = [];
    const revoked: string[] = [];
    const createdLinks: Array<{
      href: string;
      download: string;
      rel: string;
      style: { display: string };
      click: ReturnType<typeof vi.fn>;
      remove: ReturnType<typeof vi.fn>;
    }> = [];

    vi.stubGlobal('document', {
      body: {
        appendChild: vi.fn((node: Record<string, unknown>) => {
          appended.push(node);
        }),
      },
      createElement: vi.fn(() => {
        const link = {
          href: '',
          download: '',
          rel: '',
          style: { display: '' },
          click: vi.fn(),
          remove: vi.fn(),
        };
        createdLinks.push(link);
        return link;
      }),
    });
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn((blob: Blob) => {
        expect(blob).toBeInstanceOf(Blob);
        return 'blob:export-1';
      }),
      revokeObjectURL: vi.fn((url: string) => {
        revoked.push(url);
      }),
    });

    const outcome = await exportConversation({
      conversation: makeSampleConversation(),
      format: 'markdown',
    });

    expect(outcome.method).toBe('web-download');
    expect(outcome.filename).toBe('TypeScript 与 Rust 架构对比.md');
    expect(appended).toHaveLength(1);
    expect(createdLinks[0]?.click).toHaveBeenCalledTimes(1);
    expect(createdLinks[0]?.remove).toHaveBeenCalledTimes(1);
    expect(revoked).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(revoked).toEqual(['blob:export-1']);
  });

  it('throws cleanly when document.body is missing on Web without leaving timers', async () => {
    mocks.platform.OS = 'web';
    vi.stubGlobal('document', {});
    await expect(
      exportConversation({
        conversation: makeSampleConversation(),
        format: 'json',
      })
    ).rejects.toThrow(/无法创建会话导出下载/);
  });

  it('shares via expo-sharing on Native and always deletes temporary cache file even on error', async () => {
    mocks.platform.OS = 'android';
    const outcome = await exportConversation({
      conversation: makeSampleConversation(),
      format: 'json',
    });
    expect(outcome.method).toBe('native-share');
    expect(outcome.filename).toBe('TypeScript 与 Rust 架构对比.json');
    expect(mocks.shareAsync).toHaveBeenCalledTimes(1);
    expect(mocks.createdFiles[0]?.deleted).toBe(true);

    mocks.shouldShareFail = true;
    await expect(
      exportConversation({
        conversation: makeSampleConversation(),
        format: 'markdown',
      })
    ).rejects.toThrow(/share canceled/);
    expect(mocks.createdFiles[1]?.deleted).toBe(true);

    mocks.sharingAvailable.mockResolvedValue(false);
    await expect(
      exportConversation({
        conversation: makeSampleConversation(),
        format: 'markdown',
      })
    ).rejects.toThrow(/没有可用的保存或分享应用/);
  });
});
