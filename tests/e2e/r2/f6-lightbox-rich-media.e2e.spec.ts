import 'fake-indexeddb/auto';

import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createE2EWorkspaceHarness,
  safeImportModule,
  type E2EChatMessage,
} from '../helpers/e2eWorkspaceHarness';
import { TINY_PNG_BASE64 } from '../helpers/sseFixtures';
import { setE2EPlatformOs } from '../helpers/vitestE2eSetup';
import type {
  ChatMessage,
  MediaAttachment,
  ModelInfo,
  WebCitation,
} from '../../../src/domain/types';
import { resolveMessageMarkdownLink } from '../../../src/services/externalSearch';
import { saveAttachmentToDevice } from '../../../src/services/mediaExport';
import {
  cleanupOrphanedMediaStorage,
  discardUncommittedAttachments,
  materializeAttachment,
  persistAttachment,
  resolveAttachmentDisplayUri,
} from '../../../src/services/mediaStorage';
import {
  buildMessageActivityModules,
  finalizeActivityTimelineForTerminalMessage,
} from '../../../src/services/messageActivity';

/**
 * Node 环境最小原生模块与 RN UI 原语桩：
 * 确保 `safeImportModule` 动态导入含 JSX / 原生图标 / 分享依赖的 `.tsx` 组件文件时，
 * 不会因 Node 缺少 React Native 视图原语而顶层崩溃，同时联动 `setE2EPlatformOs` 并采集渲染节点树用于深度行为断言。
 */
interface CapturedRenderedNode {
  type: string;
  props: Record<string, unknown>;
  textContent: string;
}

const {
  f6PlatformState,
  capturedNodes,
  StubComponent,
  createStubComponent,
  createGestureChain,
  createLayoutTransitionStub,
} = vi.hoisted(() => {
  const platformState: {
    OS: 'android' | 'ios' | 'web';
    select: <T>(
      specifics: Partial<Record<'android' | 'ios' | 'web' | 'default', T>>
    ) => T | undefined;
  } = {
    OS: 'android',
    select(specifics) {
      return specifics[platformState.OS] ?? specifics.default;
    },
  };

  const nodes: CapturedRenderedNode[] = [];

  function extractText(node: unknown): string {
    if (typeof node === 'string' || typeof node === 'number') {
      return String(node);
    }
    if (Array.isArray(node)) {
      return node.map(extractText).join(' ').trim();
    }
    if (node && typeof node === 'object' && 'props' in node) {
      const props = (node as { props?: Record<string, unknown> }).props;
      if (props) {
        const label = typeof props.accessibilityLabel === 'string' ? props.accessibilityLabel : '';
        const childText = extractText(props.children);
        return [label, childText].filter(Boolean).join(' ').trim();
      }
    }
    return '';
  }

  function makeStub(name: string) {
    return (props: Record<string, unknown> = {}) => {
      const resolvedChildren =
        typeof props.children === 'function'
          ? (props.children as (state: { pressed: boolean }) => unknown)({ pressed: false })
          : props.children;
      nodes.push({
        type: name,
        props,
        textContent: extractText(resolvedChildren),
      });
      if (name === 'Modal' && props.visible === false) {
        return null;
      }
      return (resolvedChildren as ReactNode | undefined) ?? null;
    };
  }

  function makeGestureChain() {
    const chain: Record<string, unknown> = {};
    const methods = [
      'onStart',
      'onBegin',
      'onUpdate',
      'onChange',
      'onEnd',
      'onFinalize',
      'onTouchesDown',
      'onTouchesUp',
      'numberOfTaps',
      'minDistance',
      'maxPointers',
      'minPointers',
      'activeOffsetX',
      'activeOffsetY',
      'failOffsetX',
      'failOffsetY',
      'enabled',
      'hitSlop',
      'runOnJS',
    ];
    for (const method of methods) {
      chain[method] = () => chain;
    }
    return chain;
  }

  function makeLayoutTransitionStub() {
    const transition: Record<string, unknown> = {};
    const methods = ['duration', 'delay', 'springify', 'damping', 'stiffness', 'easing'];
    for (const method of methods) {
      transition[method] = () => transition;
    }
    return transition;
  }

  return {
    f6PlatformState: platformState,
    capturedNodes: nodes,
    StubComponent: makeStub('StubComponent'),
    createStubComponent: makeStub,
    createGestureChain: makeGestureChain,
    createLayoutTransitionStub: makeLayoutTransitionStub,
  };
});

// 与 tests/e2e/helpers/vitestE2eSetup.ts 的 setE2EPlatformOs 保持联动，消除双套状态割裂
vi.mock('../helpers/vitestE2eSetup', async (importOriginal) => {
  const original = await importOriginal<typeof import('../helpers/vitestE2eSetup')>();
  return {
    ...original,
    setE2EPlatformOs: (os: 'android' | 'ios' | 'web') => {
      original.setE2EPlatformOs(os);
      f6PlatformState.OS = os;
    },
  };
});

vi.mock('react-native', () => {
  const AnimatedView = createStubComponent('Animated.View');
  const AnimatedText = createStubComponent('Animated.Text');
  const AnimatedImage = createStubComponent('Animated.Image');
  const AnimatedScrollView = createStubComponent('Animated.ScrollView');

  class AnimatedValueStub {
    private currentValue: number;
    constructor(value = 0) {
      this.currentValue = value;
    }
    setValue(value: number) {
      this.currentValue = value;
    }
    interpolate() {
      return this.currentValue;
    }
  }

  const absoluteFillObject = {
    position: 'absolute' as const,
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  };

  return {
    Platform: f6PlatformState,
    StyleSheet: {
      create: <T extends Record<string, unknown>>(styles: T): T => styles,
      flatten: <T>(style: T): T => style,
      hairlineWidth: 1,
      absoluteFill: absoluteFillObject,
      absoluteFillObject,
    },
    Dimensions: {
      get: () => ({ width: 390, height: 844, scale: 2, fontScale: 1 }),
      addEventListener: () => ({ remove: () => undefined }),
    },
    useWindowDimensions: () => ({ width: 390, height: 844, scale: 2, fontScale: 1 }),
    useColorScheme: () => 'light',
    AppState: {
      currentState: 'active',
      addEventListener: () => ({ remove: () => undefined }),
    },
    Keyboard: {
      addListener: () => ({ remove: () => undefined }),
      dismiss: () => undefined,
    },
    BackHandler: {
      addEventListener: () => ({ remove: () => undefined }),
      exitApp: () => undefined,
    },
    Linking: {
      openURL: async () => undefined,
      canOpenURL: async () => true,
    },
    Share: {
      share: async () => ({ action: 'sharedAction' }),
      sharedAction: 'sharedAction',
      dismissedAction: 'dismissedAction',
    },
    Alert: {
      alert: () => undefined,
    },
    PanResponder: {
      create: () => ({ panHandlers: {} }),
    },
    InteractionManager: {
      runAfterInteractions: (task?: () => unknown) => {
        task?.();
        return { cancel: () => undefined };
      },
    },
    Animated: {
      View: AnimatedView,
      Text: AnimatedText,
      Image: AnimatedImage,
      ScrollView: AnimatedScrollView,
      Value: AnimatedValueStub,
      timing: () => ({ start: (cb?: () => void) => cb?.() }),
      spring: () => ({ start: (cb?: () => void) => cb?.() }),
      parallel: () => ({ start: (cb?: () => void) => cb?.() }),
      createAnimatedComponent: (component: unknown) => component,
    },
    View: createStubComponent('View'),
    Text: createStubComponent('Text'),
    TextInput: createStubComponent('TextInput'),
    ScrollView: createStubComponent('ScrollView'),
    Modal: createStubComponent('Modal'),
    Pressable: createStubComponent('Pressable'),
    TouchableOpacity: createStubComponent('TouchableOpacity'),
    Image: createStubComponent('Image'),
    ActivityIndicator: createStubComponent('ActivityIndicator'),
    FlatList: createStubComponent('FlatList'),
    KeyboardAvoidingView: createStubComponent('KeyboardAvoidingView'),
    Switch: createStubComponent('Switch'),
    SafeAreaView: createStubComponent('SafeAreaView'),
  };
});

vi.mock('expo-sharing', () => ({
  isAvailableAsync: async () => true,
  shareAsync: async () => undefined,
}));

vi.mock('expo-clipboard', () => ({
  setStringAsync: async () => true,
  getStringAsync: async () => '',
}));

vi.mock('expo-blur', () => ({
  BlurView: createStubComponent('BlurView'),
}));

vi.mock('expo-status-bar', () => ({
  StatusBar: createStubComponent('StatusBar'),
}));

vi.mock('lucide-react-native', () =>
  new Proxy(
    { __esModule: true },
    {
      get(target, prop) {
        if (prop in target) {
          return target[prop as keyof typeof target];
        }
        if (prop === 'then' || typeof prop === 'symbol') {
          return undefined;
        }
        if (prop === 'default') {
          return StubComponent;
        }
        return StubComponent;
      },
      has(target, prop) {
        if (prop === 'then' || typeof prop === 'symbol') {
          return prop in target;
        }
        return true;
      },
      getOwnPropertyDescriptor(target, prop) {
        if (prop in target) {
          return Object.getOwnPropertyDescriptor(target, prop);
        }
        if (prop === 'then' || typeof prop === 'symbol' || typeof prop !== 'string') {
          return undefined;
        }
        return {
          configurable: true,
          enumerable: true,
          value: StubComponent,
        };
      },
    }
  )
);

vi.mock('expo-haptics', () => ({
  selectionAsync: async () => undefined,
  notificationAsync: async () => undefined,
  impactAsync: async () => undefined,
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
}));

vi.mock('react-native-gesture-handler', () => ({
  GestureDetector: createStubComponent('GestureDetector'),
  GestureHandlerRootView: createStubComponent('GestureHandlerRootView'),
  Gesture: {
    Pinch: () => createGestureChain(),
    Pan: () => createGestureChain(),
    Tap: () => createGestureChain(),
    LongPress: () => createGestureChain(),
    Fling: () => createGestureChain(),
    Simultaneous: () => createGestureChain(),
    Race: () => createGestureChain(),
    Exclusive: () => createGestureChain(),
  },
}));

vi.mock('react-native-reanimated', () => ({
  default: {
    View: createStubComponent('Animated.View'),
    Text: createStubComponent('Animated.Text'),
    Image: createStubComponent('Animated.Image'),
    createAnimatedComponent: (component: unknown) => component,
  },
  Easing: {
    linear: () => 0,
    quad: () => 0,
    cubic: () => 0,
    ease: () => 0,
    out: (fn: unknown) => fn,
    inOut: (fn: unknown) => fn,
  },
  Extrapolation: { CLAMP: 'clamp', EXTEND: 'extend', IDENTITY: 'identity' },
  LinearTransition: createLayoutTransitionStub(),
  FadeIn: createLayoutTransitionStub(),
  FadeOut: createLayoutTransitionStub(),
  Layout: createLayoutTransitionStub(),
  interpolate: () => 0,
  useReducedMotion: () => false,
  useSharedValue: (v: unknown) => ({ value: v }),
  useAnimatedStyle: () => ({}),
  withTiming: (v: unknown) => v,
  withSpring: (v: unknown) => v,
  runOnJS: (fn: unknown) => fn,
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: createStubComponent('SafeAreaProvider'),
  SafeAreaView: createStubComponent('SafeAreaView'),
}));

/**
 * F6：图片灯箱、以此图继续编辑、富媒体渲染（代码高亮/LaTeX）与 Thinking/引用契约 E2E（Tiers 1–2）
 *
 * 约定 M3 公开契约：
 * 1. `src/features/chat/imageEditDraft.ts`
 *    - `buildEditWithImageDraft(args: { attachment, existingText?, prompt?, currentModelId?, availableModels? })`:
 *      校验图片附件并将其注入下一轮 `attachments`（`referenceImages`），当当前模型不支持生图时推荐切换至支持 `image-generation` 的模型。
 * 2. `src/ui/components/ImageLightboxModal.tsx`
 *    - 导出 `ImageLightboxModal`（接收 `visible`, `attachment`, `onClose`, `onSave?`, `onEditWithImage?`），
 *      `visible: false` 时不渲染可见内容，`visible: true` 时渲染图片与保存/关闭/以此图继续编辑真实交互控件并绑定回调。
 * 3. `src/ui/components/MessageMarkdown.tsx`
 *    - 保留 `MessageMarkdown` 组件导出，同时导出纯解析契约以支持跨端单测与无 DOM 校验：
 *      - `parseMarkdownBlocks(content)`：支持 `{ kind: 'code', language?, text }` 与 `{ kind: 'latex', text, display: true }`，并对超长输入做 300,000 字符级有界截断
 *      - `parseInlineRichSegments(text, citations?)`：统一使用 `text: string` 承载片段文本，支持行内 `latex` (`$...$`)、内联引用角标 `citation` (`[1]`)、普通 `text` 与 `link`
 *      - `highlightCodeTokens(code, language?)`：返回 `Array<{ text: string; tokenType: string }>`
 * 4. `src/ui/components/MessageActivityModules.tsx`
 *    - 保留 `MessageActivityModules`，并导出折叠状态机辅助 `resolveThinkingExpandedState`
 */
interface ImageEditDraftContract {
  buildEditWithImageDraft: (args: {
    attachment: MediaAttachment;
    existingText?: string;
    prompt?: string;
    currentModelId?: string;
    availableModels?: readonly ModelInfo[];
  }) => {
    attachments: MediaAttachment[];
    text: string;
    suggestedModelId?: string;
  };
}

interface ImageLightboxProps {
  visible: boolean;
  attachment: MediaAttachment | null;
  onClose: () => void;
  onSave?: (attachment: MediaAttachment) => void | Promise<void>;
  onEditWithImage?: (attachment: MediaAttachment) => void | Promise<void>;
}

interface ImageLightboxContract {
  ImageLightboxModal: (props: ImageLightboxProps) => ReactNode;
}

interface ParsedMarkdownBlock {
  kind: string;
  language?: string;
  text?: string;
  display?: boolean;
}

interface ParsedInlineSegment {
  kind: string;
  text: string;
  index?: number;
  citation?: WebCitation;
  url?: string;
}

interface CodeHighlightToken {
  text: string;
  tokenType: string;
}

interface MessageMarkdownRichContract {
  MessageMarkdown: unknown;
  parseMarkdownBlocks: (content: string) => ParsedMarkdownBlock[];
  parseInlineRichSegments: (
    text: string,
    citations?: readonly WebCitation[]
  ) => ParsedInlineSegment[];
  highlightCodeTokens: (code: string, language?: string) => CodeHighlightToken[];
}

interface MessageActivityContract {
  MessageActivityModules: unknown;
  resolveThinkingExpandedState: (args: {
    status: 'running' | 'completed';
    userOverride?: boolean;
    expandAll?: boolean;
  }) => boolean;
}

async function renderCapturedLightbox(
  Component: (props: ImageLightboxProps) => ReactNode,
  props: ImageLightboxProps
): Promise<{ markup: string; nodes: CapturedRenderedNode[] }> {
  capturedNodes.length = 0;
  const serverModuleName = 'react-dom/server';
  const { renderToStaticMarkup } = (await import(
    /* @vite-ignore */ serverModuleName
  )) as {
    renderToStaticMarkup: (element: ReactNode) => string;
  };
  const markup = renderToStaticMarkup(createElement(Component, props));
  return {
    markup,
    nodes: capturedNodes.slice(),
  };
}

function getInteractiveLabel(node: CapturedRenderedNode): string {
  const a11y = typeof node.props.accessibilityLabel === 'string' ? node.props.accessibilityLabel : '';
  const testId = typeof node.props.testID === 'string' ? node.props.testID : '';
  return `${a11y} ${testId} ${node.textContent}`.trim();
}

function installMinimalWebDocumentStub(): {
  downloads: Array<{ download: string; href: string }>;
  restore: () => void;
} {
  const downloads: Array<{ download: string; href: string }> = [];
  const globalRecord = globalThis as Record<string, unknown>;
  const hadDocument = 'document' in globalRecord;
  const previousDocument = globalRecord.document;
  const previousCreateObjectUrl = URL.createObjectURL;
  const previousRevokeObjectUrl = URL.revokeObjectURL;

  const fakeBody = {
    appendChild: () => undefined,
  };

  globalRecord.document = {
    body: fakeBody,
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
          downloads.push({ download: anchor.download, href: anchor.href });
        },
        remove: () => undefined,
      };
      return anchor;
    },
  };

  URL.createObjectURL = () => 'blob:https://embezzle.local/e2e-image-1';
  URL.revokeObjectURL = () => undefined;

  return {
    downloads,
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

describe('F6 图片灯箱、以此图继续编辑、富媒体与 Thinking/内联引用 E2E', () => {
  const restoreCallbacks: Array<() => void> = [];

  afterEach(async () => {
    while (restoreCallbacks.length > 0) {
      const restore = restoreCallbacks.pop();
      restore?.();
    }
    capturedNodes.length = 0;
    // 确保每次用例后彻底清理 fake-indexeddb，防止孤儿附件跨用例残留
    setE2EPlatformOs('web');
    try {
      await cleanupOrphanedMediaStorage([]);
    } finally {
      setE2EPlatformOs('android');
    }
  });

  describe('Tier 1：灯箱、续改联动、代码高亮、公式与 Thinking/引用正向链路', () => {
    it('[F6-T1-01] 生成图片持久化与“以此图继续编辑”状态转换注入 Composer 草稿一致', async () => {
      setE2EPlatformOs('web');
      const harness = await createE2EWorkspaceHarness();
      restoreCallbacks.push(() => harness.dispose());

      const editDraftService = await safeImportModule<ImageEditDraftContract>(
        'src/features/chat/imageEditDraft.ts',
        ['buildEditWithImageDraft']
      );

      const rawAttachment: MediaAttachment = {
        id: 'gen-img-edit-1',
        kind: 'image',
        uri: `data:image/png;base64,${TINY_PNG_BASE64}`,
        name: 'cyber-cat.png',
        mimeType: 'image/png',
        base64: TINY_PNG_BASE64,
        width: 1024,
        height: 1024,
      };

      const persisted = await persistAttachment(rawAttachment);
      expect(persisted.uri).toMatch(/^embezzle-web-attachment:\/\//);

      const convId = harness.session.getSnapshot().activeConversationId;
      const assistantMessage: ChatMessage = {
        id: harness.ids.createId('msg'),
        role: 'assistant',
        content: '图片生成完成。',
        createdAt: harness.clock.now(),
        status: 'ready',
        attachments: [persisted],
      };

      await harness.chatRuntime.execute({
        type: 'chat.append-messages',
        conversationId: convId,
        messages: [assistantMessage],
        now: harness.clock.now(),
      });

      const availableModels: ModelInfo[] = [
        { id: 'gpt-5.4', name: 'GPT-5.4', capabilities: ['text'], source: 'preset' },
        {
          id: 'gpt-image-2.5-sunburst',
          name: 'GPT Image 2.5',
          capabilities: ['image-generation'],
          task: 'image-generation',
          source: 'preset',
        },
      ];

      // 校验非图片附件不得被“以此图继续编辑”误注入
      expect(() =>
        editDraftService.buildEditWithImageDraft({
          attachment: {
            id: 'not-an-image',
            kind: 'file',
            uri: 'data:application/pdf;base64,JVBERi0xLjQK',
            name: 'spec.pdf',
            mimeType: 'application/pdf',
          },
          availableModels,
        })
      ).toThrow(/图片|image/i);

      // 调用 M3 “以此图继续编辑” 状态转换契约生成草稿补丁
      const draftPatch = editDraftService.buildEditWithImageDraft({
        attachment: persisted,
        prompt: '为这只猫加上霓虹眼镜',
        currentModelId: 'gpt-5.4',
        availableModels,
      });

      expect(draftPatch.attachments.length).toBe(1);
      expect(draftPatch.attachments[0]?.uri).toBe(persisted.uri);
      expect(draftPatch.attachments[0]?.kind).toBe('image');
      expect(draftPatch.text).toBe('为这只猫加上霓虹眼镜');
      expect(draftPatch.suggestedModelId).toBe('gpt-image-2.5-sunburst');

      // 将状态转换结果注入工作区草稿并切换至推荐生图模型
      if (draftPatch.suggestedModelId) {
        await harness.chatRuntime.execute({
          type: 'model.select',
          providerId: harness.session.getSnapshot().activeProviderId,
          modelId: draftPatch.suggestedModelId,
        });
      }

      await harness.chatRuntime.execute({
        type: 'draft.set',
        conversationId: convId,
        text: draftPatch.text,
        attachments: draftPatch.attachments,
        now: harness.clock.now() + 10,
      });

      await harness.flush();

      const stored = harness.persistence.getStoredSnapshot();
      const savedDraft = stored?.composerDrafts.find((draft) => draft.conversationId === convId);
      expect(savedDraft).toBeDefined();
      expect(savedDraft?.text).toBe('为这只猫加上霓虹眼镜');
      expect(savedDraft?.attachments?.length).toBe(1);
      expect(savedDraft?.attachments?.[0]?.uri).toBe(persisted.uri);
      expect(stored?.activeModelIdByProvider[stored.activeProviderId]).toBe(
        'gpt-image-2.5-sunburst'
      );

      const resolvedUri = await resolveAttachmentDisplayUri(persisted);
      expect(resolvedUri.startsWith('blob:') || resolvedUri.startsWith('data:image/png')).toBe(
        true
      );
    });

    it('[F6-T1-02] ImageLightboxModal 渲染保存/继续编辑/关闭真实控件并触发回调与下载流', async () => {
      setE2EPlatformOs('web');
      const lightboxModule = await safeImportModule<ImageLightboxContract>(
        'src/ui/components/ImageLightboxModal.tsx',
        ['ImageLightboxModal']
      );
      expect(typeof lightboxModule.ImageLightboxModal).toBe('function');

      const previewAttachment: MediaAttachment = {
        id: 'lightbox-preview-1',
        kind: 'image',
        uri: `data:image/png;base64,${TINY_PNG_BASE64}`,
        name: 'sunset:2026*preview.png',
        mimeType: 'image/png',
        base64: TINY_PNG_BASE64,
        width: 1024,
        height: 1024,
      };

      const onSave = vi.fn();
      const onEditWithImage = vi.fn();
      const onClose = vi.fn();

      // 1. visible: false 时不得渲染可见交互控件或图片
      const hiddenRender = await renderCapturedLightbox(lightboxModule.ImageLightboxModal, {
        visible: false,
        attachment: previewAttachment,
        onSave,
        onEditWithImage,
        onClose,
      });
      expect(hiddenRender.markup).toBe('');
      expect(
        hiddenRender.nodes.some(
          (node) =>
            (node.type === 'Pressable' || node.type === 'TouchableOpacity') &&
            typeof node.props.onPress === 'function'
        )
      ).toBe(false);

      // 2. visible: true 时必须真实渲染图片以及 保存 / 以此图继续编辑 / 关闭 交互节点
      const visibleRender = await renderCapturedLightbox(lightboxModule.ImageLightboxModal, {
        visible: true,
        attachment: previewAttachment,
        onSave,
        onEditWithImage,
        onClose,
      });

      const imageNodes = visibleRender.nodes.filter(
        (node) => (node.type === 'Image' || node.type === 'Animated.Image') && Boolean(node.props.source)
      );
      expect(imageNodes.length).toBeGreaterThanOrEqual(1);

      const pressableNodes = visibleRender.nodes.filter(
        (node) =>
          (node.type === 'Pressable' || node.type === 'TouchableOpacity') &&
          typeof node.props.onPress === 'function' &&
          node.props.disabled !== true
      );
      expect(pressableNodes.length).toBeGreaterThanOrEqual(3);

      const saveBtn = pressableNodes.find((node) =>
        /保存|下载|save|download/i.test(getInteractiveLabel(node))
      );
      const editBtn = pressableNodes.find((node) =>
        /继续编辑|编辑|edit/i.test(getInteractiveLabel(node))
      );
      const closeBtn = pressableNodes.find((node) =>
        /关闭|close|返回/i.test(getInteractiveLabel(node))
      );

      expect(saveBtn).toBeDefined();
      expect(editBtn).toBeDefined();
      expect(closeBtn).toBeDefined();

      // 3. 真实点击触发对应回调，防止 return null 或空壳绑定假阳性
      await (saveBtn?.props.onPress as () => unknown)();
      await (editBtn?.props.onPress as () => unknown)();
      await (closeBtn?.props.onPress as () => unknown)();
      await Promise.resolve();

      expect(onSave).toHaveBeenCalledTimes(1);
      expect(onSave).toHaveBeenCalledWith(previewAttachment);
      expect(onEditWithImage).toHaveBeenCalledTimes(1);
      expect(onEditWithImage).toHaveBeenCalledWith(previewAttachment);
      expect(onClose).toHaveBeenCalledTimes(1);

      // 4. 校验底层附件导出清洗与 Web 下载流
      const docStub = installMinimalWebDocumentStub();
      restoreCallbacks.push(() => docStub.restore());

      const persisted = await persistAttachment({
        id: 'lightbox-save-1',
        kind: 'image',
        uri: `data:image/png;base64,${TINY_PNG_BASE64}`,
        name: 'sunset:2026*preview.png',
        mimeType: 'image/png',
      });

      const saveResult = await saveAttachmentToDevice(persisted);
      expect(saveResult.status).toBe('saved');
      expect(saveResult.method).toBe('web-download');
      expect(saveResult.name).not.toMatch(/[:*?]/);
      expect(docStub.downloads.length).toBe(1);
      expect(docStub.downloads[0]?.download).toBe(saveResult.name);
    });

    it('[F6-T1-03] 代码块语言识别、语法高亮 Token 拆分与复制文本 100% 保真', async () => {
      const markdownModule = await safeImportModule<MessageMarkdownRichContract>(
        'src/ui/components/MessageMarkdown.tsx',
        ['MessageMarkdown', 'parseMarkdownBlocks', 'highlightCodeTokens']
      );

      const sourceTs = [
        '// 计算斐波那契',
        'export function fib(n: number): number {',
        '  const label = "result";',
        '  return n <= 1 ? n : fib(n - 1) + fib(n - 2);',
        '}',
      ].join('\n');

      const md = `示例实现：\n\n\`\`\`typescript\n${sourceTs}\n\`\`\`\n`;
      const blocks = markdownModule.parseMarkdownBlocks(md);
      const codeBlock = blocks.find((block) => block.kind === 'code');

      expect(codeBlock).toBeDefined();
      expect(codeBlock?.language).toBe('typescript');
      expect(codeBlock?.text).toBe(sourceTs);

      const tokens = markdownModule.highlightCodeTokens(sourceTs, 'typescript');
      expect(tokens.length).toBeGreaterThan(3);
      // 差异化高亮 Token：必须包含多种语义分类（关键字/字符串/注释等），不能全是同一普通文本
      const distinctTypes = new Set(tokens.map((token) => token.tokenType));
      expect(distinctTypes.size).toBeGreaterThanOrEqual(3);
      // 一键复制文本保真：所有高亮片段拼接后必须严格等于原始代码
      expect(tokens.map((token) => token.text).join('')).toBe(sourceTs);
    });

    it('[F6-T1-04] LaTeX 块级公式 $$...$$ 与行内公式 $...$ 解析识别且不破坏周边 Markdown', async () => {
      const markdownModule = await safeImportModule<MessageMarkdownRichContract>(
        'src/ui/components/MessageMarkdown.tsx',
        ['parseMarkdownBlocks', 'parseInlineRichSegments']
      );

      const blockFormulaMd = [
        '高斯积分如下：',
        '',
        '$$',
        '\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}',
        '$$',
        '',
        '结论正确。',
      ].join('\n');

      const blocks = markdownModule.parseMarkdownBlocks(blockFormulaMd);
      const latexBlock = blocks.find((block) => block.kind === 'latex');
      expect(latexBlock).toBeDefined();
      expect(latexBlock?.text).toContain('\\sqrt{\\pi}');

      const inlineSegments = markdownModule.parseInlineRichSegments(
        '爱因斯坦质能方程为 $E = mc^2$，广泛用于物理计算。'
      );
      const inlineMath = inlineSegments.find((seg) => seg.kind === 'latex');
      expect(inlineMath).toBeDefined();
      expect(inlineMath?.text).toContain('E = mc^2');
    });

    it('[F6-T1-05] Thinking 消费 thinkingDurationMs（优于总请求耗时）且完成后自动折叠并支持全展全收', async () => {
      const activityUi = await safeImportModule<MessageActivityContract>(
        'src/ui/components/MessageActivityModules.tsx',
        ['MessageActivityModules', 'resolveThinkingExpandedState']
      );

      const messageWithThinkingDuration: E2EChatMessage = {
        id: 'msg-thinking-dur-1',
        role: 'assistant',
        content: '最终回答内容。',
        reasoningContent: '第一步：分析问题边界。\n第二步：校验输入契约。',
        thinkingDurationMs: 2340,
        requestMetrics: {
          durationMs: 8500,
          timeToFirstTokenMs: 420,
        },
        createdAt: 1764000000000,
        status: 'ready',
      };

      const modules = buildMessageActivityModules(messageWithThinkingDuration);
      const thinkingModule = modules.find((item) => item.kind === 'thinking');
      expect(thinkingModule).toBeDefined();
      expect(thinkingModule?.status).toBe('completed');
      // 思考标题必须优先采用 thinkingDurationMs (2.3s)，而不是请求总耗时 (8.5s)
      expect(thinkingModule?.title).toContain('2.3s');
      expect(thinkingModule?.title).not.toContain('8.5s');

      // 折叠状态机契约：流式期默认展开，完成后自动折叠，支持全局展开/收起覆盖
      expect(activityUi.resolveThinkingExpandedState({ status: 'running' })).toBe(true);
      expect(activityUi.resolveThinkingExpandedState({ status: 'completed' })).toBe(false);
      expect(
        activityUi.resolveThinkingExpandedState({ status: 'completed', expandAll: true })
      ).toBe(true);
      expect(
        activityUi.resolveThinkingExpandedState({
          status: 'running',
          userOverride: false,
        })
      ).toBe(false);
    });

    it('[F6-T1-06] 正文内联引用角标 [1] / [2] 解析精准关联 citations 来源卡片', async () => {
      const markdownModule = await safeImportModule<MessageMarkdownRichContract>(
        'src/ui/components/MessageMarkdown.tsx',
        ['parseInlineRichSegments']
      );

      const citations: WebCitation[] = [
        {
          index: 1,
          id: 's1',
          title: 'OpenAI 官方文档',
          url: 'https://platform.openai.com/docs',
        },
        {
          index: 2,
          id: 's2',
          title: 'Anthropic 发布说明',
          url: 'https://docs.anthropic.com/en/docs',
        },
      ];

      const segments = markdownModule.parseInlineRichSegments(
        '多模态接口参见官方指南 [1]，安全思考回传参考 [2]。',
        citations
      );

      const citationSegments = segments.filter((seg) => seg.kind === 'citation');
      expect(citationSegments.length).toBe(2);
      expect(citationSegments[0]?.index).toBe(1);
      expect(citationSegments[0]?.citation?.url).toBe('https://platform.openai.com/docs');
      expect(citationSegments[1]?.index).toBe(2);
      expect(citationSegments[1]?.citation?.title).toBe('Anthropic 发布说明');
    });
  });

  describe('Tier 2：边界条件、畸形格式、安全性与异常态保护', () => {
    it('[F6-T2-01] 空/损坏图片附件在灯箱渲染与导出/显示解析时 fail-loud 且安全防护', async () => {
      setE2EPlatformOs('web');
      const docStub = installMinimalWebDocumentStub();
      restoreCallbacks.push(() => docStub.restore());

      const lightboxModule = await safeImportModule<ImageLightboxContract>(
        'src/ui/components/ImageLightboxModal.tsx',
        ['ImageLightboxModal']
      );
      expect(typeof lightboxModule.ImageLightboxModal).toBe('function');

      const onSaveSpy = vi.fn();
      const onCloseSpy = vi.fn();

      // 传入 attachment: null 时灯箱须安全渲染且关闭按钮仍可响应，同时不得允许保存空附件
      const nullRender = await renderCapturedLightbox(lightboxModule.ImageLightboxModal, {
        visible: true,
        attachment: null,
        onSave: onSaveSpy,
        onClose: onCloseSpy,
      });
      const enabledSaveOnNull = nullRender.nodes.find(
        (node) =>
          (node.type === 'Pressable' || node.type === 'TouchableOpacity') &&
          typeof node.props.onPress === 'function' &&
          node.props.disabled !== true &&
          /保存|下载|save|download/i.test(getInteractiveLabel(node))
      );
      if (enabledSaveOnNull) {
        (enabledSaveOnNull.props.onPress as () => void)();
      }
      expect(onSaveSpy).not.toHaveBeenCalled();

      const closeOnNull = nullRender.nodes.find(
        (node) =>
          (node.type === 'Pressable' || node.type === 'TouchableOpacity') &&
          typeof node.props.onPress === 'function' &&
          /关闭|close|返回/i.test(getInteractiveLabel(node))
      );
      expect(closeOnNull).toBeDefined();
      (closeOnNull?.props.onPress as () => void)();
      expect(onCloseSpy).toHaveBeenCalledTimes(1);

      const emptyAttachment: MediaAttachment = {
        id: 'empty-img-1',
        kind: 'image',
        uri: '',
        name: 'empty.png',
        mimeType: 'image/png',
      };
      await expect(materializeAttachment(emptyAttachment)).rejects.toThrow(/缺少|数据/);

      const brokenStoredAttachment: MediaAttachment = {
        id: 'broken-img-1',
        kind: 'image',
        uri: 'embezzle-web-attachment://missing-blob-id',
        name: 'missing.png',
        mimeType: 'image/png',
      };

      await expect(resolveAttachmentDisplayUri(brokenStoredAttachment)).rejects.toThrow(/丢失/);
      await expect(saveAttachmentToDevice(brokenStoredAttachment)).rejects.toThrow(
        /无法|读取|附件/
      );
      expect(docStub.downloads.length).toBe(0);
    });

    it('[F6-T2-02] 空代码块、无语言标签与代码内 $...$/[1] 不受行内公式和引用污染', async () => {
      const markdownModule = await safeImportModule<MessageMarkdownRichContract>(
        'src/ui/components/MessageMarkdown.tsx',
        ['parseMarkdownBlocks', 'highlightCodeTokens']
      );

      const md = [
        '```',
        '```',
        '',
        '```',
        'const price = "$100";',
        'const note = "formula $x^2$ and ref [1]";',
        '```',
      ].join('\n');

      const blocks = markdownModule.parseMarkdownBlocks(md);
      const codeBlocks = blocks.filter((block) => block.kind === 'code');
      expect(codeBlocks.length).toBe(2);
      expect(codeBlocks[0]?.text).toBe('');
      expect(codeBlocks[1]?.text).toContain('$x^2$');
      expect(codeBlocks[1]?.text).toContain('[1]');
      // 代码块内部不应分裂出 latex 或 citation 块
      expect(blocks.some((block) => block.kind === 'latex')).toBe(false);

      const emptyTokens = markdownModule.highlightCodeTokens('', undefined);
      expect(emptyTokens.map((t) => t.text).join('')).toBe('');
    });

    it('[F6-T2-03] 货币金额 $100 / $19.99 防误伤、未闭合 $$ 退化与 350,000 字符有界截断', async () => {
      const markdownModule = await safeImportModule<MessageMarkdownRichContract>(
        'src/ui/components/MessageMarkdown.tsx',
        ['parseMarkdownBlocks', 'parseInlineRichSegments']
      );

      // 货币金额绝不能误识别为行内公式
      const currencySegments = markdownModule.parseInlineRichSegments(
        '商品价格从 $100 涨到 $199.99，优惠券 \\$15 不构成公式。'
      );
      expect(currencySegments.some((seg) => seg.kind === 'latex')).toBe(false);

      // 混排场景：货币不误判，真实公式正常识别
      const mixedSegments = markdownModule.parseInlineRichSegments(
        '预算 $100 内求解 $a + b = c$ 即可。'
      );
      const mathSegs = mixedSegments.filter((seg) => seg.kind === 'latex');
      expect(mathSegs.length).toBe(1);
      expect(mathSegs[0]?.text).toContain('a + b = c');

      // 未闭合 $$ 必须退化为普通文本，不得产出 latex 块且完整保留原始表达式与后续文本
      const unclosedBlocks = markdownModule.parseMarkdownBlocks('$$\n\\alpha + \\beta\n普通续写');
      expect(unclosedBlocks.length).toBeGreaterThanOrEqual(1);
      expect(unclosedBlocks.some((block) => block.kind === 'latex')).toBe(false);
      const unclosedMergedText = unclosedBlocks.map((block) => block.text ?? '').join('\n');
      expect(unclosedMergedText).toContain('\\alpha + \\beta');
      expect(unclosedMergedText).toContain('普通续写');

      // 多段落超长 Markdown：渲染块数有界截断（<= 1500）
      const hugeMarkdown = '普通段落文本内容测试。\n\n'.repeat(30_000);
      expect(hugeMarkdown.length).toBeGreaterThan(350_000);
      const startMs = Date.now();
      const boundedBlocks = markdownModule.parseMarkdownBlocks(hugeMarkdown);
      const elapsedMs = Date.now() - startMs;
      expect(boundedBlocks.length).toBeGreaterThan(0);
      expect(boundedBlocks.length).toBeLessThanOrEqual(1500);
      expect(elapsedMs).toBeLessThan(2000);

      // 单段 360,000+ 字符（不拆 \n\n 段落）：输出渲染块总字符数必须有界截断（<= 305_000）
      const singleHugeParagraph = 'A'.repeat(360_000);
      const singleStartMs = Date.now();
      const boundedSingleBlocks = markdownModule.parseMarkdownBlocks(singleHugeParagraph);
      const singleElapsedMs = Date.now() - singleStartMs;
      expect(boundedSingleBlocks.length).toBeGreaterThan(0);
      const totalRenderedChars = boundedSingleBlocks.reduce(
        (sum, block) => sum + (block.text?.length ?? 0),
        0
      );
      expect(totalRenderedChars).toBeGreaterThan(0);
      expect(totalRenderedChars).toBeLessThanOrEqual(305_000);
      expect(singleElapsedMs).toBeLessThan(2000);
    });

    it('[F6-T2-04] 越界角标 [99] 退化与危险协议链接（javascript:/127.0.0.1/file:）防御', async () => {
      const markdownModule = await safeImportModule<MessageMarkdownRichContract>(
        'src/ui/components/MessageMarkdown.tsx',
        ['parseInlineRichSegments']
      );

      const citations: WebCitation[] = [
        { index: 1, id: 'c1', title: 'Legit', url: 'https://example.com/guide' },
      ];

      const segments = markdownModule.parseInlineRichSegments(
        '有效引用 [1] 与不存在引用 [99]。',
        citations
      );
      const validCitations = segments.filter((seg) => seg.kind === 'citation');
      expect(validCitations.length).toBe(1);
      expect(validCitations[0]?.index).toBe(1);
      // 越界 [99] 必须退化为普通文本，保留可见字符且不指向空对象
      expect(segments.some((seg) => seg.kind !== 'citation' && seg.text.includes('[99]'))).toBe(
        true
      );

      // 危险协议与内网地址防御
      expect(resolveMessageMarkdownLink('javascript:alert(1)', citations)).toBeNull();
      expect(resolveMessageMarkdownLink('data:text/html,<script>alert(1)</script>', citations)).toBeNull();
      expect(resolveMessageMarkdownLink('file:///etc/passwd', citations)).toBeNull();
      expect(resolveMessageMarkdownLink('http://127.0.0.1:8080/internal', citations)).toBeNull();
      expect(resolveMessageMarkdownLink('https://example.com/guide', citations)).toBe(
        'https://example.com/guide'
      );
    });

    it('[F6-T2-05] 异常终止消息（cancelled / error）Thinking 计时立即冻结停止跳秒', () => {
      const startedAt = 1764000000000;
      const finishedAt = 1764000003200;

      for (const terminalStatus of ['cancelled', 'error'] as const) {
        const frozenTimeline = finalizeActivityTimelineForTerminalMessage(
          [
            {
              id: 'step-think-1',
              kind: 'thinking',
              status: 'running',
              title: '深度思考',
              content: '正在推理…',
              startedAt,
              sequence: 0,
            },
            {
              id: 'step-tool-1',
              kind: 'tool',
              status: 'running',
              title: '正在搜索',
              toolName: 'search_web',
              startedAt: startedAt + 500,
              sequence: 1,
            },
          ],
          { messageStatus: terminalStatus, finishedAt }
        );

        expect(frozenTimeline?.[0]?.status).toBe('completed');
        expect(frozenTimeline?.[0]?.finishedAt).toBe(finishedAt);
        expect(frozenTimeline?.[0]?.title).toContain('3.2s');
        expect(frozenTimeline?.[1]?.status).toBe('failed');
        expect(frozenTimeline?.[1]?.finishedAt).toBe(finishedAt);
      }
    });

    it('[F6-T2-06] 非法 Base64 图片拒绝落盘与未提交临时附件及时清理', async () => {
      setE2EPlatformOs('web');

      const invalidBase64Attachment: MediaAttachment = {
        id: 'corrupt-b64-1',
        kind: 'image',
        uri: 'data:image/png;base64,!!!NOT_VALID_BASE64!!!',
        name: 'corrupt.png',
        mimeType: 'image/png',
        base64: '!!!NOT_VALID_BASE64!!!',
      };

      await expect(persistAttachment(invalidBase64Attachment)).rejects.toThrow(
        /fetch failed|failed to fetch|读取失败|data URL|base64/i
      );

      // 验证合法但未提交工作区的临时附件可被安全回收
      const tempAttachment = await persistAttachment({
        id: 'temp-orphan-1',
        kind: 'image',
        uri: `data:image/png;base64,${TINY_PNG_BASE64}`,
        name: 'orphan.png',
        mimeType: 'image/png',
      });
      await discardUncommittedAttachments([tempAttachment]);
      await expect(resolveAttachmentDisplayUri(tempAttachment)).rejects.toThrow(
        /浏览器存储已丢失/
      );
    });
  });
});
