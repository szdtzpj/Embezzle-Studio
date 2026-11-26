import { afterEach, describe, expect, it, vi } from 'vitest';

import { safeImportModule, type E2EChatMessage } from '../helpers/e2eWorkspaceHarness';
import { TINY_PNG_BASE64 } from '../helpers/sseFixtures';
import { setE2EPlatformOs } from '../helpers/vitestE2eSetup';
import type { ChatConversation, PromptTemplate } from '../../../src/domain/types';
import { createPromptTemplate, renderPromptTemplate } from '../../../src/services/promptTemplates';

/**
 * F7：会话导出（Markdown/JSON）、Web 键盘快捷键（Enter/Shift+Enter/IME）与 `/` 快捷指令 E2E（Tiers 1–2）
 *
 * 约定 M3 公开契约：
 * 1. `src/services/conversationExport.ts`
 *    - `exportConversationToMarkdown(conversation, options?): string`
 *    - `exportConversationToJson(conversation, options?): string`
 *    - `sanitizeExportFilename(title, extension): string`
 *    - `exportConversation(args: { conversation, format: 'markdown' | 'json', ... }): Promise<{ filename: string; content: string; method: string }>`
 * 2. `src/features/chat/composerShortcuts.ts`
 *    - `resolveComposerKeyAction(input: ComposerKeyActionInput): 'submit' | 'newline' | 'select-slash-command' | 'ignore'`
 * 3. `src/features/chat/slashCommands.ts`
 *    - `shouldOpenSlashCommandMenu(text: string, cursorOffset?: number): boolean`
 *    - `filterSlashCommands(inputText: string, options?: { promptTemplates?: readonly PromptTemplate[] }): SlashCommandItem[]`
 *    - `resolveSlashCommandSelection(command: SlashCommandItem, currentText: string): SlashCommandSelectionResult`
 */
interface ConversationExportContract {
  exportConversationToMarkdown: (
    conversation: ChatConversation,
    options?: { includeThinking?: boolean; includeCitations?: boolean }
  ) => string;
  exportConversationToJson: (
    conversation: ChatConversation,
    options?: { pretty?: boolean }
  ) => string;
  sanitizeExportFilename: (title: string, extension: 'md' | 'json') => string;
  exportConversation: (args: {
    conversation: ChatConversation;
    format: 'markdown' | 'json';
  }) => Promise<{ filename: string; content: string; method: string }>;
}

interface ComposerShortcutsContract {
  resolveComposerKeyAction: (input: {
    platformOs: 'android' | 'ios' | 'web';
    key: string;
    shiftKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    isComposing?: boolean;
    keyCode?: number;
    text: string;
    isStreaming?: boolean;
    disabled?: boolean;
    slashMenuOpen?: boolean;
  }) => 'submit' | 'newline' | 'select-slash-command' | 'ignore';
}

interface SlashCommandItemContract {
  id: string;
  command: string;
  title: string;
  kind: 'builtin' | 'template';
  action?: string;
  template?: PromptTemplate;
}

interface SlashCommandSelectionResultContract {
  kind: 'builtin' | 'template';
  action?: string;
  nextText?: string;
}

interface SlashCommandsContract {
  shouldOpenSlashCommandMenu: (text: string, cursorOffset?: number) => boolean;
  filterSlashCommands: (
    inputText: string,
    options?: { promptTemplates?: readonly PromptTemplate[] }
  ) => SlashCommandItemContract[];
  resolveSlashCommandSelection: (
    item: SlashCommandItemContract,
    currentText: string
  ) => SlashCommandSelectionResultContract;
}

function createRichSampleConversation(): ChatConversation {
  const messages: E2EChatMessage[] = [
    {
      id: 'msg-sys-1',
      role: 'system',
      content: '你是一个严谨的技术架构助手。',
      createdAt: 1764000000000,
      status: 'ready',
    },
    {
      id: 'msg-user-1',
      role: 'user',
      content: '请结合最新文档对比 TypeScript 与 Rust，并参考我上传的架构图。',
      createdAt: 1764000001000,
      status: 'ready',
      attachments: [
        {
          id: 'att-user-img-1',
          kind: 'image',
          uri: `data:image/png;base64,${TINY_PNG_BASE64}`,
          name: 'arch-diagram.png',
          mimeType: 'image/png',
          base64: TINY_PNG_BASE64,
        },
      ],
    },
    {
      id: 'msg-asst-1',
      role: 'assistant',
      content:
        'TypeScript 适合全栈快速迭代 [1]，Rust 擅长零开销系统编程 [2]。\n\n```ts\nconst mode = "strict";\n```',
      reasoningContent: '先比对类型系统静态保障，再对照生态运行环境。',
      thinkingDurationMs: 1850,
      modelId: 'gpt-5.4',
      providerId: 'openai',
      providerName: 'OpenAI',
      citations: [
        {
          index: 1,
          id: 'cite-1',
          title: 'TypeScript 5.x 文档',
          url: 'https://www.typescriptlang.org/docs/',
        },
        {
          index: 2,
          id: 'cite-2',
          title: 'The Rust Programming Language',
          url: 'https://doc.rust-lang.org/book/',
        },
      ],
      createdAt: 1764000005000,
      status: 'ready',
    },
  ];

  return {
    id: 'conv-export-e2e-1',
    title: 'TypeScript 与 Rust 架构对比',
    createdAt: 1764000000000,
    updatedAt: 1764000005000,
    messages,
  };
}

function installWebExportDomStub(): {
  downloadedFiles: Array<{ filename: string; href: string }>;
  createdBlobs: Blob[];
  revokedUrls: string[];
  restore: () => void;
} {
  const downloadedFiles: Array<{ filename: string; href: string }> = [];
  const createdBlobs: Blob[] = [];
  const revokedUrls: string[] = [];

  const globalRecord = globalThis as Record<string, unknown>;
  const hadDocument = 'document' in globalRecord;
  const previousDocument = globalRecord.document;
  const previousCreateObjectUrl = URL.createObjectURL;
  const previousRevokeObjectUrl = URL.revokeObjectURL;

  globalRecord.document = {
    body: {
      appendChild: () => undefined,
    },
    createElement: (tag: string) => {
      if (tag !== 'a') {
        return {};
      }
      const anchor = {
        href: '',
        download: '',
        rel: '',
        style: { display: '' },
        click: () => {
          downloadedFiles.push({ filename: anchor.download, href: anchor.href });
        },
        remove: () => undefined,
      };
      return anchor;
    },
  };

  URL.createObjectURL = (blob: Blob | MediaSource) => {
    if (blob instanceof Blob) {
      createdBlobs.push(blob);
    }
    return `blob:https://embezzle.local/export-${createdBlobs.length}`;
  };
  URL.revokeObjectURL = (url: string) => {
    revokedUrls.push(url);
  };

  return {
    downloadedFiles,
    createdBlobs,
    revokedUrls,
    restore: () => {
      if (hadDocument) {
        globalRecord.document = previousDocument;
      } else {
        delete globalRecord.document;
      }
      URL.createObjectURL = previousCreateObjectUrl;
      URL.revokeObjectURL = previousRevokeObjectUrl;
    },
  };
}

describe('F7 会话导出 Markdown/JSON、Web 快捷键与 / 快捷指令 E2E', () => {
  const restoreCallbacks: Array<() => void> = [];

  afterEach(() => {
    vi.useRealTimers();
    while (restoreCallbacks.length > 0) {
      const restore = restoreCallbacks.pop();
      restore?.();
    }
  });

  describe('Tier 1：会话导出、Web 发送/换行快捷键与斜杠指令主流程', () => {
    it('[F7-T1-01] 会话导出标准 Markdown 包含标题、角色模型、Thinking 折叠区、引用列表与附件占位', async () => {
      const exportService = await safeImportModule<ConversationExportContract>(
        'src/services/conversationExport.ts',
        ['exportConversationToMarkdown']
      );

      const conversation = createRichSampleConversation();
      const markdown = exportService.exportConversationToMarkdown(conversation);

      expect(markdown).toContain('TypeScript 与 Rust 架构对比');
      expect(markdown).toContain('用户');
      expect(markdown).toContain('gpt-5.4');
      expect(markdown).toContain('你是一个严谨的技术架构助手');
      // Thinking 折叠区与思考内容
      expect(markdown).toMatch(/<details>|深度思考|思考过程/);
      expect(markdown).toContain('先比对类型系统静态保障');
      // 引用来源列表
      expect(markdown).toContain('https://www.typescriptlang.org/docs/');
      expect(markdown).toContain('https://doc.rust-lang.org/book/');
      // 附件名称占位且不内联原始 Base64 图像数据
      expect(markdown).toContain('arch-diagram.png');
      expect(markdown).not.toContain(TINY_PNG_BASE64);
    });

    it('[F7-T1-02] 会话导出结构化 JSON 可往返解析且剥离任何 API Key 敏感字段', async () => {
      const exportService = await safeImportModule<ConversationExportContract>(
        'src/services/conversationExport.ts',
        ['exportConversationToJson']
      );

      const conversation = createRichSampleConversation();
      // 注入可能误混入消息 raw 或扩展字段的敏感键，检验序列化脱敏
      const conversationWithSensitiveMeta: ChatConversation = {
        ...conversation,
        messages: conversation.messages.map((msg) => ({
          ...msg,
          error: undefined,
        })),
      };
      const taintedMessage = conversationWithSensitiveMeta.messages[2] as E2EChatMessage & {
        apiKey?: string;
      };
      taintedMessage.apiKey = 'sk-secret-must-be-redacted-12345';

      const jsonText = exportService.exportConversationToJson(conversationWithSensitiveMeta);
      expect(jsonText).not.toContain('sk-secret-must-be-redacted-12345');

      const parsed = JSON.parse(jsonText) as {
        conversationId?: string;
        id?: string;
        title?: string;
        messages?: Array<{ role: string; content: string }>;
      };
      expect(parsed.id ?? parsed.conversationId).toBe('conv-export-e2e-1');
      expect(parsed.title).toBe('TypeScript 与 Rust 架构对比');
      expect(parsed.messages?.length).toBe(3);
      expect(parsed.messages?.[2]?.content).toContain('TypeScript 适合全栈快速迭代');
    });

    it('[F7-T1-03] Web 端会话导出自动清洗文件名并通过 Blob 下载与释放 ObjectURL', async () => {
      vi.useFakeTimers();
      setE2EPlatformOs('web');
      const domStub = installWebExportDomStub();
      restoreCallbacks.push(() => domStub.restore());

      const exportService = await safeImportModule<ConversationExportContract>(
        'src/services/conversationExport.ts',
        ['exportConversation', 'sanitizeExportFilename']
      );

      const conversation = createRichSampleConversation();
      const mdOutcome = await exportService.exportConversation({
        conversation,
        format: 'markdown',
      });
      const jsonOutcome = await exportService.exportConversation({
        conversation,
        format: 'json',
      });

      expect(mdOutcome.filename).toMatch(/\.md$/);
      expect(jsonOutcome.filename).toMatch(/\.json$/);
      expect(mdOutcome.method).toMatch(/download|web/i);
      expect(jsonOutcome.method).toMatch(/download|web/i);
      expect(domStub.downloadedFiles.length).toBe(2);
      expect(domStub.createdBlobs.length).toBe(2);
      expect(domStub.downloadedFiles[0]?.filename).toBe(mdOutcome.filename);
      expect(domStub.downloadedFiles[1]?.filename).toBe(jsonOutcome.filename);

      // 无论是同步释放还是延迟释放（如 artifactExport 约定 1000ms），1500ms 内必须释放全部 ObjectURL
      await vi.advanceTimersByTimeAsync(1500);
      expect(domStub.revokedUrls.length).toBe(2);
    });

    it('[F7-T1-04] Web 快捷键决策：非组词非空按 Enter 发送，Shift+Enter 换行不发送', async () => {
      setE2EPlatformOs('web');
      const shortcuts = await safeImportModule<ComposerShortcutsContract>(
        'src/features/chat/composerShortcuts.ts',
        ['resolveComposerKeyAction']
      );

      expect(
        shortcuts.resolveComposerKeyAction({
          platformOs: 'web',
          key: 'Enter',
          shiftKey: false,
          isComposing: false,
          keyCode: 13,
          text: '请帮我总结本段内容',
        })
      ).toBe('submit');

      expect(
        shortcuts.resolveComposerKeyAction({
          platformOs: 'web',
          key: 'Enter',
          shiftKey: true,
          isComposing: false,
          keyCode: 13,
          text: '第一行文本',
        })
      ).toBe('newline');
    });

    it('[F7-T1-05] / 快捷指令触发与前缀筛选同时覆盖内置动作和工作区 PromptTemplate', async () => {
      const slash = await safeImportModule<SlashCommandsContract>(
        'src/features/chat/slashCommands.ts',
        ['shouldOpenSlashCommandMenu', 'filterSlashCommands']
      );

      const templates = createPromptTemplate(
        [],
        {
          name: '代码审查',
          content: '请从安全性、边界条件与性能角度审查以下代码：\n{{code}}',
          mode: 'composer',
        },
        { id: 'tpl-review-1', now: 1764000000000 }
      );

      expect(slash.shouldOpenSlashCommandMenu('/')).toBe(true);
      expect(slash.shouldOpenSlashCommandMenu('/exp')).toBe(true);

      const allCommands = slash.filterSlashCommands('/', { promptTemplates: templates });
      expect(allCommands.some((item) => item.kind === 'builtin')).toBe(true);
      expect(allCommands.some((item) => item.kind === 'template' && item.title === '代码审查')).toBe(
        true
      );

      const filteredExport = slash.filterSlashCommands('/exp', { promptTemplates: templates });
      expect(filteredExport.some((item) => item.command.includes('export'))).toBe(true);

      const filteredTemplate = slash.filterSlashCommands('/代码', { promptTemplates: templates });
      expect(filteredTemplate.some((item) => item.title === '代码审查')).toBe(true);
    });

    it('[F7-T1-06] 选中 / 快捷指令正确区分执行内置动作与替换模板（保留变量占位符）', async () => {
      const slash = await safeImportModule<SlashCommandsContract>(
        'src/features/chat/slashCommands.ts',
        ['filterSlashCommands', 'resolveSlashCommandSelection']
      );

      const templates = createPromptTemplate(
        [],
        {
          name: '英文润色',
          content: '请以学术风格润色以下英文段落：\n{{paragraph}}',
          mode: 'composer',
        },
        { id: 'tpl-polish-1', now: 1764000000000 }
      );

      const matchedTemplate = slash
        .filterSlashCommands('/英文', { promptTemplates: templates })
        .find((item) => item.kind === 'template');
      expect(matchedTemplate).toBeDefined();

      const templateOutcome = slash.resolveSlashCommandSelection(
        matchedTemplate as SlashCommandItemContract,
        '/英文'
      );
      expect(templateOutcome.kind).toBe('template');
      expect(templateOutcome.nextText).not.toContain('/英文');
      expect(templateOutcome.nextText).toContain('请以学术风格润色以下英文段落');
      expect(templateOutcome.nextText).toContain('{{paragraph}}');
      expect(
        renderPromptTemplate(templateOutcome.nextText ?? '', { paragraph: 'Hello world.' })
      ).toContain('Hello world.');

      const matchedBuiltin = slash
        .filterSlashCommands('/export', { promptTemplates: templates })
        .find((item) => item.kind === 'builtin');
      expect(matchedBuiltin).toBeDefined();

      const builtinOutcome = slash.resolveSlashCommandSelection(
        matchedBuiltin as SlashCommandItemContract,
        '/export'
      );
      expect(builtinOutcome.kind).toBe('builtin');
      expect(builtinOutcome.action).toBeTruthy();
    });
  });

  describe('Tier 2：IME 防误发、特殊转义、空/异常会话与斜杠防误触', () => {
    it('[F7-T2-01] 中文 IME 组词期（isComposing: true 或 keyCode === 229）按 Enter 绝不误发送', async () => {
      setE2EPlatformOs('web');
      const shortcuts = await safeImportModule<ComposerShortcutsContract>(
        'src/features/chat/composerShortcuts.ts',
        ['resolveComposerKeyAction']
      );

      expect(
        shortcuts.resolveComposerKeyAction({
          platformOs: 'web',
          key: 'Enter',
          isComposing: true,
          keyCode: 13,
          text: 'wo xiang wen',
        })
      ).toBe('ignore');

      expect(
        shortcuts.resolveComposerKeyAction({
          platformOs: 'web',
          key: 'Enter',
          isComposing: false,
          keyCode: 229,
          text: '中文候选词',
        })
      ).toBe('ignore');

      expect(
        shortcuts.resolveComposerKeyAction({
          platformOs: 'web',
          key: 'Process',
          keyCode: 229,
          text: '输入中',
        })
      ).toBe('ignore');
    });

    it('[F7-T2-02] 非 Web 平台、空白输入、流式生成中或只读态下按 Enter 安全拦截不提交', async () => {
      const shortcuts = await safeImportModule<ComposerShortcutsContract>(
        'src/features/chat/composerShortcuts.ts',
        ['resolveComposerKeyAction']
      );

      expect(
        shortcuts.resolveComposerKeyAction({
          platformOs: 'android',
          key: 'Enter',
          text: '移动端文本',
        })
      ).toBe('ignore');

      expect(
        shortcuts.resolveComposerKeyAction({
          platformOs: 'web',
          key: 'Enter',
          text: '   \n\t  ',
        })
      ).toBe('ignore');

      expect(
        shortcuts.resolveComposerKeyAction({
          platformOs: 'web',
          key: 'Enter',
          text: '有效内容',
          isStreaming: true,
        })
      ).toBe('ignore');

      expect(
        shortcuts.resolveComposerKeyAction({
          platformOs: 'web',
          key: 'Enter',
          text: '有效内容',
          disabled: true,
        })
      ).toBe('ignore');

      // 组合键 Alt+Enter 不应意外直接提交
      expect(
        shortcuts.resolveComposerKeyAction({
          platformOs: 'web',
          key: 'Enter',
          altKey: true,
          text: '有效内容',
        })
      ).not.toBe('submit');
    });

    it('[F7-T2-03] 空会话、仅 welcome 或含 error/pending 状态消息导出不崩溃且正确标记状态', async () => {
      const exportService = await safeImportModule<ConversationExportContract>(
        'src/services/conversationExport.ts',
        ['exportConversationToMarkdown', 'exportConversationToJson']
      );

      const emptyConv: ChatConversation = {
        id: 'conv-empty-1',
        title: '',
        createdAt: 1764000000000,
        updatedAt: 1764000000000,
        messages: [],
      };

      const emptyMd = exportService.exportConversationToMarkdown(emptyConv);
      expect(emptyMd.length).toBeGreaterThan(0);
      const emptyJson = JSON.parse(exportService.exportConversationToJson(emptyConv)) as {
        messages: unknown[];
      };
      expect(emptyJson.messages).toEqual([]);

      const abnormalConv: ChatConversation = {
        id: 'conv-err-1',
        title: '异常中断记录',
        createdAt: 1764000000000,
        updatedAt: 1764000002000,
        messages: [
          {
            id: 'm-err',
            role: 'assistant',
            content: '',
            status: 'error',
            error: '上游 502 Bad Gateway',
            createdAt: 1764000001000,
          },
          {
            id: 'm-pending',
            role: 'assistant',
            content: '生成了一半…',
            status: 'pending',
            createdAt: 1764000002000,
          },
        ],
      };

      const abnormalMd = exportService.exportConversationToMarkdown(abnormalConv);
      expect(abnormalMd).toContain('上游 502 Bad Gateway');
      expect(abnormalMd).toContain('生成了一半…');
    });

    it('[F7-T2-04] 恶意文件名（路径符/控制符/Windows 保留名）清洗与 Markdown XSS/嵌套围栏隔离', async () => {
      const exportService = await safeImportModule<ConversationExportContract>(
        'src/services/conversationExport.ts',
        ['sanitizeExportFilename', 'exportConversationToMarkdown']
      );

      const dangerousName = exportService.sanitizeExportFilename('../../CON:*?"<>|\x00\n', 'md');
      expect(dangerousName).toMatch(/\.md$/);
      expect(dangerousName).not.toMatch(/[/\\:*?"<>|\x00\r\n]/);
      expect(dangerousName.toUpperCase()).not.toBe('CON.MD');

      const reservedName = exportService.sanitizeExportFilename('NUL', 'json');
      expect(reservedName).toMatch(/\.json$/);
      expect(reservedName.toUpperCase()).not.toBe('NUL.JSON');

      const xssConv: ChatConversation = {
        id: 'conv-xss-1',
        title: '# <script>alert("xss")</script> 注入测试',
        createdAt: 1764000000000,
        updatedAt: 1764000001000,
        messages: [
          {
            id: 'm-xss-1',
            role: 'assistant',
            content: '````markdown\n# nested\n<script>evil()</script>\n````',
            reasoningContent: '</details><script>alert(2)</script>',
            status: 'ready',
            createdAt: 1764000001000,
          },
        ],
      };

      const safeMd = exportService.exportConversationToMarkdown(xssConv);
      // 标题与思考区块内部的原始 HTML 脚本标签必须安全转义或剥离，不得残留未转义 <script> 或破坏外层 <details>
      expect(safeMd).not.toMatch(/<script[\s>]/i);
      expect(safeMd).not.toContain('</details><script>');
      // 正文含嵌套四反引号 ````markdown 时，外层导出代码块围栏必须自动升阶为至少 5 个反引号
      expect(safeMd).toMatch(/`{5,}/);
    });

    it('[F7-T2-05] URL、路径与行内常规斜杠（https://.../a/b）绝不误触发 / 快捷指令菜单', async () => {
      const slash = await safeImportModule<SlashCommandsContract>(
        'src/features/chat/slashCommands.ts',
        ['shouldOpenSlashCommandMenu']
      );

      expect(slash.shouldOpenSlashCommandMenu('https://api.openai.com/v1/images')).toBe(false);
      expect(slash.shouldOpenSlashCommandMenu('src/services/conversationExport.ts')).toBe(false);
      expect(slash.shouldOpenSlashCommandMenu('今天吃什么 / 面条还是米饭')).toBe(false);
      expect(slash.shouldOpenSlashCommandMenu('a/b/c')).toBe(false);
      expect(slash.shouldOpenSlashCommandMenu('')).toBe(false);
      expect(slash.shouldOpenSlashCommandMenu('   ')).toBe(false);
    });

    it('[F7-T2-06] 未知 /unknown-command 与超长斜杠输入返回空匹配且不误执行', async () => {
      const slash = await safeImportModule<SlashCommandsContract>(
        'src/features/chat/slashCommands.ts',
        ['shouldOpenSlashCommandMenu', 'filterSlashCommands']
      );

      const unknownMatches = slash.filterSlashCommands('/not-a-real-command-xyz');
      expect(unknownMatches).toEqual([]);

      const longInput = `/${'x'.repeat(500)}`;
      expect(() => slash.shouldOpenSlashCommandMenu(longInput)).not.toThrow();
      const longMatches = slash.filterSlashCommands(longInput);
      expect(longMatches).toEqual([]);
    });
  });
});
