import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createElement, type ReactNode } from 'react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ImageGenerationOptions,
  MediaAttachment,
  ModelInfo,
  PromptTemplate,
  ProviderProfile,
} from '../src/domain/types';
import { defaultProviders } from '../src/data/providerCatalog';
import { createPromptTemplate, renderPromptTemplate } from '../src/services/promptTemplates';
import { buildEditWithImageDraft } from '../src/features/chat/imageEditDraft';
import { resolveComposerKeyAction } from '../src/features/chat/composerShortcuts';
import {
  filterSlashCommands,
  resolveSlashCommandSelection,
  shouldOpenSlashCommandMenu,
} from '../src/features/chat/slashCommands';

const nodeRequire = createRequire(import.meta.url);
const { renderToStaticMarkup } = nodeRequire('react-dom/server') as {
  renderToStaticMarkup: (element: ReactNode) => string;
};

interface CapturedUiNode {
  type: string;
  props: Record<string, unknown>;
  text: string;
}

const capturedUiNodes: CapturedUiNode[] = [];

function extractChildrenText(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(extractChildrenText).join('');
  }
  if (node && typeof node === 'object' && 'props' in node) {
    const props = (node as { props?: Record<string, unknown> }).props;
    if (props) {
      return extractChildrenText(props.children);
    }
  }
  return '';
}

function makeUiStub(name: string) {
  return function UiStub(props: Record<string, unknown> = {}) {
    const children =
      typeof props.children === 'function'
        ? (props.children as (state: { pressed: boolean }) => ReactNode)({ pressed: false })
        : props.children;
    capturedUiNodes.push({
      type: name,
      props,
      text: extractChildrenText(children),
    });
    return createElement(
      'div',
      {
        'data-stub': name,
        'data-testid': typeof props.testID === 'string' ? props.testID : undefined,
      },
      children as ReactNode
    );
  };
}

async function loadIsolatedImageGenParamsBar() {
  vi.resetModules();
  vi.doMock('react-native', () => ({
    Platform: {
      OS: 'web',
      select: (map: Record<string, unknown>) => map.web ?? map.default,
    },
    StyleSheet: {
      create: <T extends Record<string, unknown>>(styles: T) => styles,
      hairlineWidth: 1,
    },
    View: makeUiStub('View'),
    Text: makeUiStub('Text'),
    ScrollView: makeUiStub('ScrollView'),
    Pressable: makeUiStub('Pressable'),
  }));
  vi.doMock('../src/ui/theme', () => ({
    useKelivoTheme: () => ({
      dark: false,
      colors: {
        text: '#111827',
        textSecondary: '#6B7280',
        textOnAccent: '#FFFFFF',
        accent: '#2563EB',
        accentText: '#1D4ED8',
        accentSoft: '#EFF6FF',
        accentBorder: '#93C5FD',
        outline: '#E5E7EB',
        card: '#FFFFFF',
      },
      radius: {
        sm: 8,
        md: 12,
        lg: 16,
        pill: 999,
      },
    }),
  }));
  vi.doMock('../src/ui/components/AnimatedPressable', () => ({
    AnimatedPressable: makeUiStub('AnimatedPressable'),
  }));

  const mod = await import('../src/ui/components/ImageGenParamsBar');
  return mod.ImageGenParamsBar;
}

function cloneProvider(id: string): ProviderProfile {
  const found = defaultProviders.find((item) => item.id === id);
  if (!found) {
    throw new Error(`未找到预设服务商：${id}`);
  }
  return {
    ...found,
    apiKey: `sk-test-${id}`,
    capabilities: [...found.capabilities],
    models: found.models.map((model) => ({ ...model, capabilities: [...model.capabilities] })),
  };
}

describe('M3.3 Chat 集成与交互扩展单元测试', () => {
  afterEach(() => {
    capturedUiNodes.length = 0;
  });

  describe('imageEditDraft (以此图继续编辑草稿构建)', () => {
    const sampleImage: MediaAttachment = {
      id: 'att-img-1',
      kind: 'image',
      uri: 'embezzle-web-attachment://img-1',
      name: 'cat.png',
      mimeType: 'image/png',
      base64: 'iVBORw0KGgo=',
    };

    it('拒绝非图片附件、非 image/* MIME 或空数据附件并抛出包含图片提示的错误', () => {
      expect(() =>
        buildEditWithImageDraft({
          attachment: {
            id: 'att-file-1',
            kind: 'file',
            uri: 'file:///doc.pdf',
            name: 'doc.pdf',
            mimeType: 'application/pdf',
          },
        })
      ).toThrow(/图片|image/i);

      expect(() =>
        buildEditWithImageDraft({
          attachment: {
            id: 'att-bad-mime',
            kind: 'image',
            uri: 'file:///a.txt',
            name: 'a.txt',
            mimeType: 'text/plain',
          },
        })
      ).toThrow(/图片|image/i);

      expect(() =>
        buildEditWithImageDraft({
          attachment: {
            id: 'att-empty',
            kind: 'image',
            uri: '   ',
            name: 'empty.png',
            mimeType: 'image/png',
          },
        })
      ).toThrow(/图片|image/i);
    });

    it('当前模型非生图模型时优先推荐非 gpt-image-1 生图模型，已是生图模型时不建议切换', () => {
      const models: ModelInfo[] = [
        { id: 'gpt-5.4', name: 'GPT-5.4', capabilities: ['text'], source: 'preset' },
        {
          id: 'gpt-image-1',
          name: 'Legacy GPT Image 1',
          capabilities: ['image-generation'],
          task: 'image-generation',
          source: 'manual',
        },
        {
          id: 'gpt-image-2.5-sunburst',
          name: 'GPT Image 2.5',
          capabilities: ['image-generation'],
          task: 'image-generation',
          source: 'preset',
        },
      ];

      const switchDraft = buildEditWithImageDraft({
        attachment: sampleImage,
        existingText: '保留草稿',
        prompt: '把背景改成霓虹城市',
        currentModelId: 'gpt-5.4',
        availableModels: models,
      });

      expect(switchDraft.suggestedModelId).toBe('gpt-image-2.5-sunburst');
      expect(switchDraft.text).toBe('把背景改成霓虹城市');
      expect(switchDraft.attachments).toHaveLength(1);
      expect(switchDraft.attachments[0]?.uri).toBe(sampleImage.uri);
      expect(switchDraft.attachments[0]).not.toBe(sampleImage);

      const keepDraft = buildEditWithImageDraft({
        attachment: sampleImage,
        existingText: '调整曝光',
        currentModelId: 'gpt-image-2.5-sunburst',
        availableModels: models,
      });

      expect(keepDraft.suggestedModelId).toBeUndefined();
      expect(keepDraft.text).toBe('调整曝光');
    });

    it('Gemini 文本模型下推荐切换至 gemini-3.1-flash-image', () => {
      const gemini = cloneProvider('gemini');
      const result = buildEditWithImageDraft({
        attachment: sampleImage,
        currentModelId: 'gemini-2.5-pro',
        availableModels: gemini.models,
      });
      expect(result.suggestedModelId).toBe('gemini-3.1-flash-image');
    });
  });

  describe('composerShortcuts (Web 快捷键与中文 IME 防误触发)', () => {
    it('移动端始终忽略；中文 IME 组词状态一律忽略', () => {
      expect(
        resolveComposerKeyAction({
          platformOs: 'android',
          key: 'Enter',
          text: '你好',
        })
      ).toBe('ignore');
      expect(
        resolveComposerKeyAction({
          platformOs: 'ios',
          key: 'Enter',
          text: '你好',
        })
      ).toBe('ignore');
      expect(
        resolveComposerKeyAction({
          platformOs: 'web',
          key: 'Enter',
          isComposing: true,
          text: 'nihao',
        })
      ).toBe('ignore');
      expect(
        resolveComposerKeyAction({
          platformOs: 'web',
          key: 'Enter',
          keyCode: 229,
          text: '你好',
        })
      ).toBe('ignore');
      expect(
        resolveComposerKeyAction({
          platformOs: 'web',
          key: 'Process',
          text: '你好',
        })
      ).toBe('ignore');
    });

    it('正确处理 Shift+Enter 换行、纯 Enter 发送、有附件发送、修饰键与斜杠选中', () => {
      expect(
        resolveComposerKeyAction({
          platformOs: 'web',
          key: 'Enter',
          shiftKey: true,
          text: '第一行',
        })
      ).toBe('newline');

      expect(
        resolveComposerKeyAction({
          platformOs: 'web',
          key: 'Enter',
          altKey: true,
          text: '内容',
        })
      ).toBe('ignore');
      expect(
        resolveComposerKeyAction({
          platformOs: 'web',
          key: 'Enter',
          ctrlKey: true,
          text: '内容',
        })
      ).toBe('ignore');
      expect(
        resolveComposerKeyAction({
          platformOs: 'web',
          key: 'Enter',
          metaKey: true,
          text: '内容',
        })
      ).toBe('ignore');

      expect(
        resolveComposerKeyAction({
          platformOs: 'web',
          key: 'Enter',
          text: '   ',
        })
      ).toBe('ignore');

      expect(
        resolveComposerKeyAction({
          platformOs: 'web',
          key: 'Enter',
          text: '',
          hasAttachments: true,
        })
      ).toBe('submit');

      expect(
        resolveComposerKeyAction({
          platformOs: 'web',
          key: 'Enter',
          text: '/exp',
          slashMenuOpen: true,
        })
      ).toBe('select-slash-command');

      expect(
        resolveComposerKeyAction({
          platformOs: 'web',
          key: 'Enter',
          text: '正文中',
          isStreaming: true,
        })
      ).toBe('ignore');

      expect(
        resolveComposerKeyAction({
          platformOs: 'web',
          key: 'Enter',
          text: '正文中',
          disabled: true,
        })
      ).toBe('ignore');
    });
  });

  describe('slashCommands (/ 快捷指令识别、过滤与模板替换)', () => {
    it('仅在行首单段 /query 触发，严防 URL、路径、行内斜杠与超长输入误触', () => {
      expect(shouldOpenSlashCommandMenu('/')).toBe(true);
      expect(shouldOpenSlashCommandMenu('  /exp')).toBe(true);
      expect(shouldOpenSlashCommandMenu('/代码')).toBe(true);
      expect(shouldOpenSlashCommandMenu('/export extra', 7)).toBe(true);

      expect(shouldOpenSlashCommandMenu('')).toBe(false);
      expect(shouldOpenSlashCommandMenu('   ')).toBe(false);
      expect(shouldOpenSlashCommandMenu('https://api.openai.com/v1/images')).toBe(false);
      expect(shouldOpenSlashCommandMenu('src/features/chat/ChatPane.tsx')).toBe(false);
      expect(shouldOpenSlashCommandMenu('方案 A / 方案 B')).toBe(false);
      expect(shouldOpenSlashCommandMenu('/export extra')).toBe(false);

      const overlong = `/${'a'.repeat(500)}`;
      expect(shouldOpenSlashCommandMenu(overlong)).toBe(false);
      expect(filterSlashCommands(overlong)).toEqual([]);
    });

    it('同时过滤内置动作与 PromptTemplate，并正确保留 {{var}} 占位符', () => {
      let templates: PromptTemplate[] = [];
      templates = createPromptTemplate(
        templates,
        {
          name: '代码审查',
          content: '请审查这段代码：\n{{snippet}}',
          mode: 'composer',
        },
        { id: 'tpl-1', now: 1000 }
      );
      templates = createPromptTemplate(
        templates,
        {
          name: '架构师角色',
          content: '你是一位资深移动架构师。',
          mode: 'system',
        },
        { id: 'tpl-2', now: 2000 }
      );

      const all = filterSlashCommands('/', { promptTemplates: templates });
      expect(all.some((item) => item.command === '/export' && item.kind === 'builtin')).toBe(true);
      expect(all.some((item) => item.command === '/export-json' && item.kind === 'builtin')).toBe(true);
      expect(all.some((item) => item.command === '/new' && item.kind === 'builtin')).toBe(true);
      expect(all.some((item) => item.command === '/context' && item.kind === 'builtin')).toBe(true);
      expect(all.some((item) => item.command === '/clear' && item.kind === 'builtin')).toBe(true);
      expect(all.some((item) => item.title === '代码审查' && item.kind === 'template')).toBe(true);

      const tplMatch = filterSlashCommands('/代码', { promptTemplates: templates })[0];
      expect(tplMatch).toBeDefined();
      const tplSelected = resolveSlashCommandSelection(tplMatch!, '/代码');
      expect(tplSelected.kind).toBe('template');
      expect(tplSelected.nextText).toContain('{{snippet}}');
      expect(tplSelected.nextText).not.toContain('/代码');
      expect(
        renderPromptTemplate(tplSelected.nextText ?? '', { snippet: 'const x = 1;' })
      ).toContain('const x = 1;');

      const exportMatch = filterSlashCommands('/export-j', { promptTemplates: templates })[0];
      expect(exportMatch?.action).toBe('export-json');
      const builtinSelected = resolveSlashCommandSelection(exportMatch!, '/export-j');
      expect(builtinSelected).toEqual({
        kind: 'builtin',
        action: 'export-json',
        nextText: '',
      });
    });

    it('resolveSlashCommandSelection 原样保留 $$E = mc^2$$、$1 与 $& 等特殊替换序列不被篡改', () => {
      const content = '推导公式：\n$$E = mc^2$$\n变量：{{var1}}，Shell：$1 与 $& 与 $\' 与 $`';
      const templates = createPromptTemplate(
        [],
        {
          name: 'latex',
          content,
          mode: 'composer',
        },
        { id: 'tpl-latex', now: 3000 }
      );
      const matched = filterSlashCommands('/latex', { promptTemplates: templates }).find(
        (item) => item.kind === 'template'
      );
      expect(matched).toBeDefined();

      const selectedFromRoot = resolveSlashCommandSelection(matched!, '/latex');
      expect(selectedFromRoot.kind).toBe('template');
      expect(selectedFromRoot.nextText).toBe(content);

      const selectedWithLeadingSpaces = resolveSlashCommandSelection(matched!, '  /latex');
      expect(selectedWithLeadingSpaces.nextText).toBe(content);
    });
  });

  describe('ImageGenParamsBar 组件协议自适应与操作回调', () => {
    afterAll(() => {
      vi.doUnmock('react-native');
      vi.doUnmock('../src/ui/theme');
      vi.doUnmock('../src/ui/components/AnimatedPressable');
      vi.resetModules();
    });

    it('OpenAI 生图模式渲染比例、画质与张数，且支持切换参数回调', async () => {
      const ImageGenParamsBar = await loadIsolatedImageGenParamsBar();
      const openai = cloneProvider('openai');
      const onChange = vi.fn<(next: ImageGenerationOptions) => void>();

      const markup = renderToStaticMarkup(
        createElement(ImageGenParamsBar, {
          provider: openai,
          modelId: 'gpt-image-2.5-sunburst',
          value: { aspectRatio: '1:1', count: 1 },
          onChange,
        })
      );

      expect(markup).toContain('16:9');
      expect(markup).toContain('高清');
      expect(markup).toContain('4张');
      expect(markup).not.toContain('2K');

      const ratio16x9 = capturedUiNodes.find(
        (node) => node.type === 'AnimatedPressable' && node.text === '16:9'
      );
      const qualityHigh = capturedUiNodes.find(
        (node) => node.type === 'AnimatedPressable' && node.text === '高清'
      );
      const count4 = capturedUiNodes.find(
        (node) => node.type === 'AnimatedPressable' && node.text === '4张'
      );
      const res2k = capturedUiNodes.find(
        (node) => node.type === 'AnimatedPressable' && node.text === '2K'
      );

      expect(ratio16x9).toBeDefined();
      expect(qualityHigh).toBeDefined();
      expect(count4).toBeDefined();
      expect(res2k).toBeUndefined();

      (ratio16x9?.props.onPress as () => void)();
      expect(onChange).toHaveBeenCalledWith({ aspectRatio: '16:9', count: 1 });

      (qualityHigh?.props.onPress as () => void)();
      expect(onChange).toHaveBeenCalledWith({ aspectRatio: '1:1', count: 1, quality: 'high' });

      (count4?.props.onPress as () => void)();
      expect(onChange).toHaveBeenCalledWith({ aspectRatio: '1:1', count: 4 });
    });

    it('Gemini 生图模式渲染分辨率 1K/2K/4K 且隐藏张数，Anthropic 显示不支持引导并触发切模型回调', async () => {
      const ImageGenParamsBar = await loadIsolatedImageGenParamsBar();
      const gemini = cloneProvider('gemini');
      const onChange = vi.fn();

      const geminiMarkup = renderToStaticMarkup(
        createElement(ImageGenParamsBar, {
          provider: gemini,
          modelId: 'gemini-3.1-flash-image',
          value: { aspectRatio: '1:1' },
          onChange,
        })
      );

      expect(geminiMarkup).toContain('2K');
      expect(geminiMarkup).not.toContain('2张');
      expect(
        capturedUiNodes.some((node) => node.type === 'AnimatedPressable' && node.text === '2K')
      ).toBe(true);
      expect(
        capturedUiNodes.some((node) => node.type === 'AnimatedPressable' && node.text === '2张')
      ).toBe(false);

      capturedUiNodes.length = 0;

      const anthropic = cloneProvider('anthropic');
      const onSwitch = vi.fn();
      const markup = renderToStaticMarkup(
        createElement(ImageGenParamsBar, {
          provider: anthropic,
          modelId: 'claude-sonnet-5-5',
          value: { aspectRatio: '1:1' },
          onChange,
          onSwitchModelPress: onSwitch,
        })
      );
      expect(markup).toContain('不支持原生生图');
      expect(markup).toContain('data-testid="image-params-switch-model"');
      const switchBtn = capturedUiNodes.find(
        (node) => node.props.testID === 'image-params-switch-model'
      );
      expect(switchBtn).toBeDefined();
      (switchBtn?.props.onPress as () => void)();
      expect(onSwitch).toHaveBeenCalledTimes(1);
    });
  });

  describe('ChatPane 与 ProjectDrawer 集成防回归契约', () => {
    it('ChatPane 与 ProjectDrawer 接入全部 M3.3 能力并严守 M2/R3 红线', async () => {
      const [chatPaneSrc, stylesSrc, drawerSrc, paramsBarSrc] = await Promise.all([
        readFile(path.resolve('src/features/chat/ChatPane.tsx'), 'utf8'),
        readFile(path.resolve('src/features/chat/chatPaneStyles.ts'), 'utf8'),
        readFile(path.resolve('src/features/projects/ProjectDrawer.tsx'), 'utf8'),
        readFile(path.resolve('src/ui/components/ImageGenParamsBar.tsx'), 'utf8'),
      ]);

      // 解除生图参考图旧拦截，扩展 canAttachImage 与透传 imageOptions
      expect(chatPaneSrc).not.toContain('当前图片生成适配器只支持文本生图');
      expect(chatPaneSrc).toContain("activeModelTask === 'image-generation'");
      expect(chatPaneSrc).toContain('assertImageGenerationReferenceAttachments');
      expect(chatPaneSrc).toContain('<ImageGenParamsBar');
      expect(chatPaneSrc).toContain('<ImageLightboxModal');
      expect(chatPaneSrc).toContain('onOpenImageLightbox={handleRowOpenImageLightbox}');
      expect(chatPaneSrc).toContain('onEditImageAttachment={handleRowEditImageAttachment}');
      expect(chatPaneSrc).toContain('resolveComposerKeyAction(');
      expect(chatPaneSrc).toContain('shouldOpenSlashCommandMenu(');
      expect(chatPaneSrc).toContain('testID="slash-command-menu"');
      expect(chatPaneSrc).toContain('testID="chat-export-button"');
      expect(chatPaneSrc).toContain('exportConversation({ conversation, format })');

      // sendComparisonMessage、sendMessage 与保护 useEffect 对 'slash' 遮罩复位防回归
      const sendComparisonStart = chatPaneSrc.indexOf('async function sendComparisonMessage(');
      const sendMessageStart = chatPaneSrc.indexOf('async function sendMessage(');
      const toggleSettingsStart = chatPaneSrc.indexOf('function toggleSettingsScreen(');
      expect(sendComparisonStart).toBeGreaterThan(-1);
      expect(sendMessageStart).toBeGreaterThan(sendComparisonStart);
      expect(toggleSettingsStart).toBeGreaterThan(sendMessageStart);

      const sendComparisonSlice = chatPaneSrc.slice(sendComparisonStart, sendMessageStart);
      const sendMessageSlice = chatPaneSrc.slice(sendMessageStart, toggleSettingsStart);
      expect(sendComparisonSlice).toContain("setActiveComposerMenu('none')");
      expect(sendComparisonSlice).toContain('setSlashHighlightIndex(0)');
      expect(sendMessageSlice).toContain("setActiveComposerMenu('none')");
      expect(sendMessageSlice).toContain('setSlashHighlightIndex(0)');

      const composerMenuGuardMatch = chatPaneSrc.match(
        /useEffect\(\(\) => \{[\s\S]*?current === 'slash'[\s\S]*?\}, \[[^\]]+\]\);/
      );
      expect(composerMenuGuardMatch?.[0]).toBeDefined();
      expect(composerMenuGuardMatch?.[0]).toContain('workspaceReadOnly');
      expect(composerMenuGuardMatch?.[0]).toContain('!composerSupportsMessages');
      expect(composerMenuGuardMatch?.[0]).toContain('slashCommands.length === 0');

      // 保持 10 家搜索提示对齐
      expect(chatPaneSrc).toContain('SearXNG');
      expect(chatPaneSrc).toContain('博查');
      expect(chatPaneSrc).toContain('Exa');

      // ProjectDrawer 导出入口、高度常量与 Android elevation: 31 修复
      expect(drawerSrc).toContain('const conversationActionMenuHeight = 276;');
      expect(drawerSrc).toContain('elevation: 31');
      expect(drawerSrc).toContain('导出 Markdown');
      expect(drawerSrc).toContain('导出 JSON');
      expect(drawerSrc).toContain('exportConversation({ conversation, format })');

      // slashMenu 样式与窄屏 topHeaderRow 呼吸间距
      expect(stylesSrc).toContain('slashMenu:');
      const topHeaderRowMatch = stylesSrc.match(/topHeaderRow:\s*\{[\s\S]*?\}/);
      expect(topHeaderRowMatch?.[0]).toContain('gap: 8');

      // 零原生 Modal / SafeAreaView 与依赖方向隔离
      for (const src of [chatPaneSrc, drawerSrc, paramsBarSrc]) {
        expect(src).not.toContain('<Modal');
        expect(src).not.toContain('<SafeAreaView');
      }
      expect(paramsBarSrc).not.toContain('features/');
    });
  });
});
