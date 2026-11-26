/**
 * Tier 4 全链路真实工作流 E2E 测试（Node 全栈仿真）。
 * 覆盖场景 S1、S2、S3、S6（与 `tests/e2e/web/` 浏览器端的 S4、S5 共同构成完整 Tier 4 验收）。
 */
import 'fake-indexeddb/auto';

import { createElement, type ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { WorkspaceSession } from '../../../src/app/workspace/WorkspaceSession';
import { defaultParameterSettings, defaultProviders } from '../../../src/data/providerCatalog';
import type {
  AppWorkspace,
  ChatConversation,
  ChatMessage,
  ExternalSearchService,
  MediaAttachment,
  ModelInfo,
  PromptTemplate,
  ProviderContinuationBlock,
  ProviderProfile,
  ProviderUsageEvent,
} from '../../../src/domain/types';
import type {
  ChatLease,
  ChatOrchestrationController,
} from '../../../src/features/chat/internal/ChatContext';
import { ChatRequestExecution } from '../../../src/features/chat/internal/requests/ChatRequestExecution';
import type {
  ProviderAdapter,
  ProviderAdapterRegistry,
} from '../../../src/features/chat/orchestration/ProviderAdapterRegistry';
import type { ChatActivityPhase } from '../../../src/features/chat/useChatActivity';
import {
  createProjectsCommitReducer,
  ProjectsConversationsRuntime,
} from '../../../src/features/projects/ProjectsConversationsRuntime';
import { createStartedProviderUsageEvent } from '../../../src/services/costGuard';
import { stripExternalSearchSecrets } from '../../../src/services/externalSearch';
import { saveAttachmentToDevice } from '../../../src/services/mediaExport';
import {
  cleanupOrphanedMediaStorage,
  persistAttachment,
  resolveAttachmentDisplayUri,
} from '../../../src/services/mediaStorage';
import { finalizeActivityTimelineForTerminalMessage } from '../../../src/services/messageActivity';
import { createPromptTemplate } from '../../../src/services/promptTemplates';
import type { ProviderMcpApprovalRequest } from '../../../src/services/providerMcp';
import { compareProviderEndpointBinding } from '../../../src/services/providerSetup';
import {
  buildWorkspaceSearchIndex,
  searchWorkspace,
  searchWorkspaceIndex,
} from '../../../src/services/workspaceSearch';
import {
  createE2EWorkspaceHarness,
  installMockFetchRouter,
  safeImportModule,
  type E2EChatMessage,
  type E2EImageGenerationOptions,
  type E2EProviderProfile,
} from '../helpers/e2eWorkspaceHarness';
import { createMockUpstreamServer, type MockUpstreamServer } from '../helpers/mockUpstreamServer';
import {
  buildAnthropicMessagesSseChunks,
  buildBochaSearchJson,
  buildDeepSeekChatSseChunks,
  buildDeepSeekToolsSearchJson,
  buildExaSearchJson,
  buildGeminiGenerateContentJson,
  buildOpenAiChatSseChunks,
  buildOpenAiResponsesSseChunks,
  buildSearxngSearchJson,
  buildXaiDeprecatedSearchParameters410Response,
  buildXaiResponsesSseChunks,
  generateHighFrequencyTextDeltas,
  TINY_PNG_BASE64,
} from '../helpers/sseFixtures';
import { setE2EPlatformOs } from '../helpers/vitestE2eSetup';

interface CapturedRenderedNode {
  type: string;
  props: Record<string, unknown>;
  textContent: string;
}

const {
  tier4PlatformState,
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
    tier4PlatformState: platformState,
    capturedNodes: nodes,
    StubComponent: makeStub('StubComponent'),
    createStubComponent: makeStub,
    createGestureChain: makeGestureChain,
    createLayoutTransitionStub: makeLayoutTransitionStub,
  };
});

vi.mock('../helpers/vitestE2eSetup', async (importOriginal) => {
  const original = await importOriginal<typeof import('../helpers/vitestE2eSetup')>();
  return {
    ...original,
    setE2EPlatformOs: (os: 'android' | 'ios' | 'web') => {
      original.setE2EPlatformOs(os);
      tier4PlatformState.OS = os;
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
    Platform: tier4PlatformState,
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

// 动态契约接口声明（M2/M3 模块）
interface ImageGenerationServiceContract {
  resolveImageApiMode: (
    provider: E2EProviderProfile,
    modelId?: string
  ) =>
    | 'openai-images'
    | 'openai-responses'
    | 'gemini-generate-content'
    | 'xai-json'
    | 'unsupported';
  generateImages: (args: {
    provider: E2EProviderProfile;
    modelId: string;
    prompt: string;
    options?: E2EImageGenerationOptions;
    continuationBlocks?: ProviderContinuationBlock[];
    messages?: ChatMessage[];
    signal?: AbortSignal;
  }) => Promise<{
    content: string;
    attachments?: MediaAttachment[];
    providerContinuations?: ProviderContinuationBlock[];
    raw?: unknown;
  }>;
}

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

interface MessageMarkdownRichContract {
  MessageMarkdown: unknown;
  parseInlineRichSegments: (
    text: string,
    citations?: ReadonlyArray<NonNullable<ChatMessage['citations']>[number]>
  ) => Array<{
    kind: string;
    text: string;
    index?: number;
    citation?: NonNullable<ChatMessage['citations']>[number];
    url?: string;
  }>;
}

interface MessageActivityContract {
  MessageActivityModules: unknown;
  resolveThinkingExpandedState: (args: {
    status: 'running' | 'completed';
    userOverride?: boolean;
    expandAll?: boolean;
  }) => boolean;
}

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
    isComposing?: boolean;
    keyCode?: number;
    text: string;
    isStreaming?: boolean;
    disabled?: boolean;
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

interface SlashCommandsContract {
  shouldOpenSlashCommandMenu: (text: string, cursorOffset?: number) => boolean;
  filterSlashCommands: (
    inputText: string,
    options?: { promptTemplates?: readonly PromptTemplate[] }
  ) => SlashCommandItemContract[];
  resolveSlashCommandSelection: (
    item: SlashCommandItemContract,
    currentText: string
  ) => { kind: 'builtin' | 'template'; action?: string; nextText?: string };
}

function getDefaultProviderClone(id: string, apiKeyOverride?: string): E2EProviderProfile {
  const found = defaultProviders.find((item) => item.id === id);
  if (!found) {
    throw new Error(`未在 defaultProviders 中找到服务商预设：${id}`);
  }
  return {
    ...found,
    apiKey: apiKeyOverride ?? `sk-t4-${id}`,
    models: found.models.map((m) => ({ ...m, capabilities: [...m.capabilities] })),
    capabilities: [...found.capabilities],
  } as E2EProviderProfile;
}

function createExecutionRig(
  workspaceReader: () => AppWorkspace,
  overrides: { streamUpdateDelayMs?: number } = {}
) {
  let currentLease: ChatLease | null = null;
  const messagePatches: Array<{ messageId: string; patch: Partial<ChatMessage>; conversationId: string }> = [];
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

  const host = {
    readWorkspace: workspaceReader,
    appState: () => 'active' as const,
    streamUpdateDelayMs: () => overrides.streamUpdateDelayMs ?? 5,
    discardAttachments: async () => undefined,
    authorize: async () => true,
    persistUsageEvents: async (events: readonly ProviderUsageEvent[]) => {
      persistedUsageEvents.push(...events);
    },
    finishUsageEvent: async (
      event: ProviderUsageEvent,
      status: 'succeeded' | 'failed' | 'cancelled'
    ) => {
      usageFinishes.push({ id: event.id, status });
    },
    requestMcpApproval: async () => 'deny' as const,
    updateAssistantMessage: (messageId: string, patch: Partial<ChatMessage>, conversationId: string) => {
      messagePatches.push({ messageId, patch, conversationId });
    },
    notify: () => undefined,
  };

  return { orchestration, host, messagePatches, persistedUsageEvents, usageFinishes };
}

function installWebExportAndDownloadDomStub(): {
  downloads: Array<{ filename: string; href: string }>;
  revokedUrls: string[];
  restore: () => void;
} {
  const downloads: Array<{ filename: string; href: string }> = [];
  const revokedUrls: string[] = [];
  let blobSeq = 0;

  const globalRecord = globalThis as Record<string, unknown>;
  const hadDocument = 'document' in globalRecord;
  const previousDocument = globalRecord.document;
  const previousCreateObjectUrl = URL.createObjectURL;
  const previousRevokeObjectUrl = URL.revokeObjectURL;

  globalRecord.document = {
    body: { appendChild: () => undefined },
    createElement: (tag: string) => {
      if (tag !== 'a') return {};
      const anchor = {
        href: '',
        download: '',
        rel: '',
        style: { display: '' },
        click: () => {
          downloads.push({ filename: anchor.download, href: anchor.href });
        },
        remove: () => undefined,
      };
      return anchor;
    },
  };

  URL.createObjectURL = () => {
    blobSeq += 1;
    return `blob:https://embezzle.local/t4-export-${blobSeq}`;
  };
  URL.revokeObjectURL = (url: string) => {
    revokedUrls.push(url);
  };

  return {
    downloads,
    revokedUrls,
    restore: () => {
      if (hadDocument) globalRecord.document = previousDocument;
      else delete globalRecord.document;
      URL.createObjectURL = previousCreateObjectUrl;
      URL.revokeObjectURL = previousRevokeObjectUrl;
    },
  };
}

async function renderCapturedLightbox(
  Component: (props: ImageLightboxProps) => ReactNode,
  props: ImageLightboxProps
): Promise<{ nodes: CapturedRenderedNode[] }> {
  capturedNodes.length = 0;
  const serverModuleName = 'react-dom/server';
  const { renderToStaticMarkup } = (await import(/* @vite-ignore */ serverModuleName)) as {
    renderToStaticMarkup: (element: ReactNode) => string;
  };
  renderToStaticMarkup(createElement(Component, props));
  return { nodes: capturedNodes.slice() };
}

function getInteractiveLabel(node: CapturedRenderedNode): string {
  const a11y = typeof node.props.accessibilityLabel === 'string' ? node.props.accessibilityLabel : '';
  const testId = typeof node.props.testID === 'string' ? node.props.testID : '';
  return `${a11y} ${testId} ${node.textContent}`.trim();
}

async function raceWithTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 400): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[Deadlock] "${label}" 在 ${timeoutMs}ms 内未结算。`));
    }, timeoutMs);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function makeMcpApprovalRequest(id: string, toolName = 'search_docs'): ProviderMcpApprovalRequest {
  const args = { query: `mcp-${id}` };
  const rawArguments = JSON.stringify(args);
  return {
    id,
    serverLabel: 'docs-mcp',
    toolName,
    rawArguments,
    arguments: args,
    argumentBytes: Buffer.byteLength(rawArguments, 'utf8'),
  };
}

describe('Tier 4 — 全链路真实业务复合工作流 E2E 测试（S1, S2, S3, S6）', () => {
  let server: MockUpstreamServer;
  let serverBaseUrl = '';
  const restoreCallbacks: Array<() => void | Promise<void>> = [];

  beforeAll(async () => {
    server = createMockUpstreamServer();
    const started = await server.start();
    serverBaseUrl = started.baseUrl;
  });

  afterEach(async () => {
    vi.useRealTimers();
    while (restoreCallbacks.length > 0) {
      const restore = restoreCallbacks.pop();
      await restore?.();
    }
    capturedNodes.length = 0;
    server.reset();
    setE2EPlatformOs('web');
    try {
      await cleanupOrphanedMediaStorage([]);
    } finally {
      setE2EPlatformOs('android');
    }
  });

  afterAll(async () => {
    await server.close();
  });

  it('[S1] 空工作区初始化 → 官方 Claude 与自定义 Headers 中转配置 → 多轮 Thinking + 官方搜索 → 冷重启无损回传与内联引用折叠验收', async () => {
    const router = installMockFetchRouter(serverBaseUrl);
    restoreCallbacks.push(() => router.restore());

    // 从 null 持久化冷初始化，验证默认工作区冷创建
    const harness = await createE2EWorkspaceHarness({ initialWorkspace: null });
    restoreCallbacks.push(() => harness.dispose());

    const claudeModel: ModelInfo = {
      id: 'claude-opus-5-5',
      name: 'Claude Opus 5.5',
      capabilities: ['text', 'reasoning', 'web-search', 'streaming'],
      source: 'preset',
    };
    const antKey = 'sk-ant-s1-secret-key';
    await harness.addAndSelectProvider(getDefaultProviderClone('anthropic', antKey), claudeModel);

    // 新增并更新带自定义头的中转站，校验 Endpoint 变更触发候选模型清理契约
    const relayBefore: E2EProviderProfile = {
      id: 's1-relay',
      name: 'S1 中转',
      kind: 'new-api-relay',
      baseUrl: 'https://relay-old.example.com/v1',
      apiKey: 'sk-relay-old',
      authHeaderMode: 'custom',
      customHeaders: [
        { key: 'X-Studio-Env', value: 'prod', enabled: true },
        { key: 'X-Skip', value: '1', enabled: false },
        { key: 'Host', value: 'evil.test', enabled: true },
      ],
      capabilities: ['text', 'streaming'],
      models: [{ id: 'gpt-4.1', capabilities: ['text', 'streaming'], source: 'manual' }],
    };
    await harness.settingsRuntime.execute({
      type: 'provider.add',
      provider: relayBefore as unknown as ProviderProfile,
    });
    const relayAfter: E2EProviderProfile = {
      ...relayBefore,
      baseUrl: 'https://your-relay.example.com/v1',
    };
    const bindingChange = compareProviderEndpointBinding(
      relayBefore as unknown as ProviderProfile,
      relayAfter as unknown as ProviderProfile
    );
    expect(bindingChange.changed).toBe(true);
    expect(bindingChange.mustClearModelCandidates).toBe(true);
    await harness.settingsRuntime.execute({
      type: 'provider.save',
      providerId: 's1-relay',
      provider: relayAfter as unknown as ProviderProfile,
      binding: bindingChange,
      apiKeyChanged: false,
      now: harness.clock.now(),
    });

    // 切回官方 Claude 并开启官方搜索
    await harness.settingsRuntime.execute({
      type: 'model.select',
      providerId: 'anthropic',
      modelId: 'claude-opus-5-5',
      activateProvider: true,
    });
    await harness.setProviderWebSearch(true, 'high');

    server.enqueue(
      { method: 'POST', pathname: '/v1/messages' },
      {
        kind: 'sse',
        chunkDelayMs: 5,
        chunks: buildAnthropicMessagesSseChunks({
          model: 'claude-opus-5-5',
          thinkingBlocks: [{ thinking: '深度分析 S1 问题', signature: 'sig_s1_round1' }],
          redactedThinkingData: 'redacted_s1_round1',
          serverWebSearch: {
            toolUseId: 'srvtoolu_s1_1',
            query: 'Anthropic 2026 roadmap',
            results: [
              {
                url: 'https://anthropic.com/roadmap',
                title: 'Anthropic Roadmap',
                encrypted_content: 'enc_ws_s1_1',
              },
            ],
          },
          textDeltas: ['官方路线图结论如下 [1]。'],
          citations: [
            {
              type: 'web_search_result_location',
              url: 'https://anthropic.com/roadmap',
              title: 'Anthropic Roadmap',
              cited_text: '官方路线图结论如下',
            },
          ],
        }),
      }
    );
    server.enqueue(
      { method: 'POST', pathname: '/v1/messages' },
      {
        kind: 'sse',
        chunks: buildAnthropicMessagesSseChunks({
          model: 'claude-opus-5-5',
          thinkingBlocks: [{ thinking: '基于冷重启恢复历史继续思考', signature: 'sig_s1_round2' }],
          textDeltas: ['冷重启第二轮追问完成。'],
        }),
      }
    );

    const claudeProvider = harness.session
      .getSnapshot()
      .providers.find((p) => p.id === 'anthropic') as ProviderProfile;
    const convId = harness.session.getSnapshot().activeConversationId;
    const rig = createExecutionRig(() => harness.session.getSnapshot());
    const execution = new ChatRequestExecution(
      harness.productionAdapterRegistry,
      rig.orchestration,
      rig.host
    );

    const userMsg1: ChatMessage = {
      id: 's1-u1',
      role: 'user',
      content: '搜索 Anthropic 2026 路线图',
      createdAt: harness.clock.now(),
      status: 'ready',
    };
    const asstMsg1: ChatMessage = {
      id: 's1-a1',
      role: 'assistant',
      content: '',
      createdAt: harness.clock.now() + 1,
      status: 'pending',
      providerId: claudeProvider.id,
      modelId: claudeModel.id,
    };
    const lease1 = rig.orchestration.begin({ phase: 'provider-request', label: 's1-r1' })!;
    const out1 = await execution.execute({
      assistantMessage: asstMsg1,
      conversationId: convId,
      transcript: [userMsg1],
      runtime: { provider: claudeProvider, model: claudeModel, modelId: claudeModel.id, reasoningEffort: 'high' },
      controller: lease1.controller,
      usageEvent: createStartedProviderUsageEvent({
        id: 'usage-s1-r1',
        kind: 'web-search',
        providerId: claudeProvider.id,
        modelId: claudeModel.id,
        createdAt: harness.clock.now(),
        messageId: asstMsg1.id,
      }),
      parameterSettings: defaultParameterSettings,
    });
    expect(out1.status).toBe('success');

    const readyPatch1 = rig.messagePatches.find((p) => p.messageId === asstMsg1.id && p.patch.status === 'ready');
    const savedAsst1: E2EChatMessage = {
      ...asstMsg1,
      ...readyPatch1?.patch,
      status: 'ready',
    };
    await harness.chatRuntime.execute({
      type: 'chat.append-messages',
      conversationId: convId,
      messages: [userMsg1, savedAsst1],
      now: harness.clock.now() + 10,
    });
    await harness.flush();

    // 销毁 session 并基于同一 persistence 冷重启
    harness.dispose();
    const rebooted = new WorkspaceSession({
      persistence: harness.persistence,
      clock: harness.clock,
      lifecycle: harness.lifecycle,
      trace: harness.trace,
      autoBoot: false,
    });
    restoreCallbacks.push(() => rebooted.dispose());
    await rebooted.boot();

    const rebootedSnap = rebooted.getSnapshot();
    const rebootedConv = rebootedSnap.conversations.find((c) => c.id === convId);
    const rebootedClaude = rebootedSnap.providers.find((p) => p.id === 'anthropic')!;
    const rebootedAsst1 = rebootedConv?.messages.find((m) => m.id === asstMsg1.id) as E2EChatMessage;
    expect(rebootedAsst1?.providerContinuations?.length).toBeGreaterThanOrEqual(2);

    // Round 2 冷重启后追问，校验无损回传历史 signature / redacted_thinking / server_tool_use
    const rig2 = createExecutionRig(() => rebooted.getSnapshot());
    const exec2 = new ChatRequestExecution(
      harness.productionAdapterRegistry,
      rig2.orchestration,
      rig2.host
    );
    const lease2 = rig2.orchestration.begin({ phase: 'provider-request', label: 's1-r2' })!;
    const out2 = await exec2.execute({
      assistantMessage: {
        id: 's1-a2',
        role: 'assistant',
        content: '',
        createdAt: harness.clock.now() + 20,
        status: 'pending',
        providerId: rebootedClaude.id,
        modelId: claudeModel.id,
      },
      conversationId: convId,
      transcript: [
        userMsg1,
        rebootedAsst1,
        { id: 's1-u2', role: 'user', content: '补充说明一下', createdAt: harness.clock.now() + 19, status: 'ready' },
      ],
      runtime: { provider: rebootedClaude, model: claudeModel, modelId: claudeModel.id, reasoningEffort: 'high' },
      controller: lease2.controller,
      usageEvent: createStartedProviderUsageEvent({
        id: 'usage-s1-r2',
        kind: 'web-search',
        providerId: rebootedClaude.id,
        modelId: claudeModel.id,
        createdAt: harness.clock.now() + 20,
        messageId: 's1-a2',
      }),
      parameterSettings: defaultParameterSettings,
    });
    expect(out2.status).toBe('success');

    const msgReqs = server.getRequests({ method: 'POST', pathname: '/v1/messages' });
    expect(msgReqs).toHaveLength(2);
    expect(msgReqs[0]?.headers['x-api-key']).toBe(antKey);
    expect(msgReqs[0]?.headers['x-skip']).toBeUndefined();
    expect(msgReqs[0]?.headers.host).not.toBe('evil.test');
    const r2Serialized = JSON.stringify(msgReqs[1]?.jsonBody ?? {});
    expect(r2Serialized).toContain('sig_s1_round1');
    expect(r2Serialized).toContain('redacted_s1_round1');
    expect(r2Serialized).toContain('srvtoolu_s1_1');

    // UI 消费契约验收（M3 模块：内联引用解析 + Thinking 自动折叠）
    const mdMod = await safeImportModule<MessageMarkdownRichContract>(
      'src/ui/components/MessageMarkdown.tsx',
      ['MessageMarkdown', 'parseInlineRichSegments']
    );
    const activityMod = await safeImportModule<MessageActivityContract>(
      'src/ui/components/MessageActivityModules.tsx',
      ['MessageActivityModules', 'resolveThinkingExpandedState']
    );
    const segments = mdMod.parseInlineRichSegments(rebootedAsst1.content, rebootedAsst1.citations);
    const citeSeg = segments.find((s) => s.kind === 'citation');
    expect(citeSeg?.citation?.url).toBe('https://anthropic.com/roadmap');
    expect(activityMod.resolveThinkingExpandedState({ status: 'completed' })).toBe(false);
    expect(activityMod.resolveThinkingExpandedState({ status: 'running' })).toBe(true);
  });

  it('[S2] Gemini 原生文生图 → 持久化与全屏灯箱交互 → 以此图继续编辑多轮改图 → 429 限流恢复与取消孤儿清理', async () => {
    setE2EPlatformOs('web');
    const router = installMockFetchRouter(serverBaseUrl, { enableWebDevProxy: true });
    restoreCallbacks.push(() => router.restore());
    const harness = await createE2EWorkspaceHarness();
    restoreCallbacks.push(() => harness.dispose());
    const docStub = installWebExportAndDownloadDomStub();
    restoreCallbacks.push(() => docStub.restore());

    const imageGen = await safeImportModule<ImageGenerationServiceContract>(
      'src/services/imageGeneration.ts',
      ['generateImages', 'resolveImageApiMode']
    );
    const editDraft = await safeImportModule<ImageEditDraftContract>(
      'src/features/chat/imageEditDraft.ts',
      ['buildEditWithImageDraft']
    );
    const lightboxMod = await safeImportModule<ImageLightboxContract>(
      'src/ui/components/ImageLightboxModal.tsx',
      ['ImageLightboxModal']
    );

    const gemini = getDefaultProviderClone('gemini', 'AIzaSy-s2-secret');
    await harness.addAndSelectProvider(gemini, {
      id: 'gemini-2.5-pro',
      name: 'Gemini 2.5 Pro',
      capabilities: ['text', 'reasoning', 'streaming'],
      source: 'preset',
    });

    // Step 1: 文生图
    server.enqueue(
      { method: 'POST', pathname: '/v1beta/models/gemini-3.1-flash-image:generateContent' },
      {
        kind: 'json',
        body: buildGeminiGenerateContentJson({
          modelVersion: 'gemini-3.1-flash-image',
          textDeltas: ['初稿太空猫已生成。'],
          inlineImages: [
            { mimeType: 'image/png', data: TINY_PNG_BASE64, thoughtSignature: 'gem_s2_r1' },
          ],
        }),
      }
    );
    const round1 = await imageGen.generateImages({
      provider: gemini,
      modelId: 'gemini-3.1-flash-image',
      prompt: '宇航员橘猫漂浮在地球轨道',
      options: { aspectRatio: '16:9', resolution: '2k' },
    });
    const att1 = round1.attachments![0];
    expect(att1.uri).toMatch(/^embezzle-web-attachment:\/\//);

    const convId = harness.session.getSnapshot().activeConversationId;
    await harness.chatRuntime.execute({
      type: 'chat.append-messages',
      conversationId: convId,
      messages: [
        {
          id: 's2-msg-1',
          role: 'assistant',
          content: round1.content,
          attachments: [att1],
          providerContinuations: round1.providerContinuations,
          createdAt: harness.clock.now(),
          status: 'ready',
        } as E2EChatMessage,
      ],
      now: harness.clock.now(),
    });
    await harness.flush();

    const storedAfterR1 = harness.persistence.getStoredSnapshot();
    const persistedAtt1 = storedAfterR1?.conversations
      .find((c) => c.id === convId)
      ?.messages.find((m) => m.id === 's2-msg-1')?.attachments?.[0];
    expect(persistedAtt1?.base64 ?? null).toBeNull();

    // Step 2: 全屏灯箱渲染与本地下载
    const onSave = vi.fn();
    const onEditWithImage = vi.fn();
    const onClose = vi.fn();
    const rendered = await renderCapturedLightbox(lightboxMod.ImageLightboxModal, {
      visible: true,
      attachment: att1,
      onSave,
      onEditWithImage,
      onClose,
    });
    const pressables = rendered.nodes.filter(
      (n) =>
        (n.type === 'Pressable' || n.type === 'TouchableOpacity') &&
        typeof n.props.onPress === 'function'
    );
    const saveBtn = pressables.find((n) => /保存|下载|save|download/i.test(getInteractiveLabel(n)));
    const editBtn = pressables.find((n) => /继续编辑|编辑|edit/i.test(getInteractiveLabel(n)));
    expect(saveBtn).toBeDefined();
    expect(editBtn).toBeDefined();
    await (saveBtn?.props.onPress as () => unknown)();
    await (editBtn?.props.onPress as () => unknown)();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onEditWithImage).toHaveBeenCalledTimes(1);

    const saveRes = await saveAttachmentToDevice(att1);
    expect(saveRes.status).toBe('saved');
    expect(docStub.downloads.length).toBe(1);

    // Step 3: “以此图继续编辑”推荐模型切换与草稿注入
    const draftPatch = editDraft.buildEditWithImageDraft({
      attachment: att1,
      prompt: '增加流星雨背景',
      currentModelId: 'gemini-2.5-pro',
      availableModels: gemini.models,
    });
    expect(draftPatch.suggestedModelId).toBe('gemini-3.1-flash-image');
    await harness.chatRuntime.execute({
      type: 'draft.set',
      conversationId: convId,
      text: draftPatch.text,
      attachments: draftPatch.attachments,
      now: harness.clock.now() + 10,
    });

    // Step 4: 429 限流故障后重试成功回传 gem_s2_r1
    server.enqueue(
      { method: 'POST', pathname: '/v1beta/models/gemini-3.1-flash-image:generateContent' },
      {
        kind: 'error',
        status: 429,
        headers: { 'Retry-After': '5' },
        body: { error: { message: 'RESOURCE_EXHAUSTED: rate limit exceeded' } },
      }
    );
    server.enqueue(
      { method: 'POST', pathname: '/v1beta/models/gemini-3.1-flash-image:generateContent' },
      {
        kind: 'json',
        body: buildGeminiGenerateContentJson({
          modelVersion: 'gemini-3.1-flash-image',
          textDeltas: ['已叠加流星雨。'],
          inlineImages: [
            { mimeType: 'image/png', data: TINY_PNG_BASE64, thoughtSignature: 'gem_s2_r2' },
          ],
        }),
      }
    );

    await expect(
      imageGen.generateImages({
        provider: gemini,
        modelId: 'gemini-3.1-flash-image',
        prompt: draftPatch.text,
        options: { aspectRatio: '16:9', referenceImages: draftPatch.attachments },
        continuationBlocks: round1.providerContinuations,
      })
    ).rejects.toThrow(/429|rate|limit|限流/i);

    // 草稿与历史附件未损坏
    expect(
      harness.session.getSnapshot().composerDrafts.find((d) => d.conversationId === convId)?.text
    ).toBe('增加流星雨背景');

    const round2 = await imageGen.generateImages({
      provider: gemini,
      modelId: 'gemini-3.1-flash-image',
      prompt: draftPatch.text,
      options: { aspectRatio: '16:9', referenceImages: draftPatch.attachments },
      continuationBlocks: round1.providerContinuations,
    });
    expect(round2.attachments?.length).toBe(1);
    const reqs = server.getRequests({
      pathname: '/v1beta/models/gemini-3.1-flash-image:generateContent',
    });
    expect(reqs).toHaveLength(3);
    expect(JSON.stringify(reqs[2]?.jsonBody)).toContain('gem_s2_r1');
    expect(JSON.stringify(reqs[2]?.jsonBody)).toContain('inlineData');

    // Step 5: AbortSignal 预先取消与孤儿附件清理
    const abortCtrl = new AbortController();
    abortCtrl.abort();
    await expect(
      imageGen.generateImages({
        provider: gemini,
        modelId: 'gemini-3.1-flash-image',
        prompt: '取消测试',
        signal: abortCtrl.signal,
      })
    ).rejects.toThrow(/abort|取消/i);

    const orphan = await persistAttachment({
      id: 's2-orphan-att',
      kind: 'image',
      uri: `data:image/png;base64,${TINY_PNG_BASE64}`,
      name: 's2-orphan.png',
      mimeType: 'image/png',
      base64: TINY_PNG_BASE64,
    });
    await cleanupOrphanedMediaStorage([att1, round2.attachments![0]]);
    await expect(resolveAttachmentDisplayUri(orphan)).rejects.toThrow(/浏览器存储已丢失/);
  });

  it('[S3] xAI Grok（零 410）+ DeepSeek 官方/外部搜索 4 引擎切换与 502 故障降级 → /export Markdown/JSON 脱敏导出', async () => {
    setE2EPlatformOs('web');
    const router = installMockFetchRouter(serverBaseUrl, { enableWebDevProxy: true });
    restoreCallbacks.push(() => router.restore());
    const harness = await createE2EWorkspaceHarness();
    restoreCallbacks.push(() => harness.dispose());
    const domStub = installWebExportAndDownloadDomStub();
    restoreCallbacks.push(() => domStub.restore());

    const slash = await safeImportModule<SlashCommandsContract>(
      'src/features/chat/slashCommands.ts',
      ['shouldOpenSlashCommandMenu', 'filterSlashCommands', 'resolveSlashCommandSelection']
    );
    const exportService = await safeImportModule<ConversationExportContract>(
      'src/services/conversationExport.ts',
      [
        'exportConversationToMarkdown',
        'exportConversationToJson',
        'sanitizeExportFilename',
        'exportConversation',
      ]
    );

    const xaiKey = 'xai-s3-secret-token';
    const grokModel: ModelInfo = {
      id: 'grok-4.3',
      name: 'Grok 4.3',
      capabilities: ['text', 'reasoning', 'web-search', 'streaming'],
      source: 'preset',
    };
    await harness.addAndSelectProvider(getDefaultProviderClone('xai-grok', xaiKey), grokModel);
    await harness.setProviderWebSearch(true, 'medium');

    // 阶段 A：xAI Grok 官方搜索 + 410 故障安全透传
    server.enqueue(
      { method: 'POST', pathname: '/v1/responses' },
      {
        kind: 'sse',
        chunks: buildXaiResponsesSseChunks({
          model: 'grok-4.3',
          webSearchQuery: 'grok x search 2026',
          webSearchActionType: 'x_search_call',
          textDeltas: ['Grok 实时结果。'],
          citations: [{ url: 'https://x.ai/s3', title: 'xAI S3' }],
        }),
      }
    );
    server.enqueue(
      { method: 'POST', pathname: '/v1/responses' },
      { kind: 'error', status: 410, body: buildXaiDeprecatedSearchParameters410Response() }
    );

    const xaiProvider = harness.session
      .getSnapshot()
      .providers.find((p) => p.id === 'xai-grok') as ProviderProfile;
    const xaiAdapter = harness.productionAdapterRegistry.resolve(
      { provider: xaiProvider, modelId: grokModel.id, model: grokModel },
      'chat'
    );
    const grokRes = await xaiAdapter.run({
      provider: xaiProvider,
      modelId: grokModel.id,
      model: grokModel,
      messages: [{ id: 's3-u1', role: 'user', content: '查 Grok 搜索', createdAt: 1, status: 'ready' }],
      reasoningEffort: 'medium',
      parameterSettings: defaultParameterSettings,
      webSearch: harness.session.getSnapshot().webSearch,
    });
    expect(grokRes.citations?.[0]?.url).toBe('https://x.ai/s3');

    const grokReqBody = server.getLastRequest({ pathname: '/v1/responses' })?.jsonBody as {
      search_parameters?: unknown;
      tools?: Array<{ type?: string }>;
    };
    expect(grokReqBody.search_parameters).toBeUndefined();
    expect(grokReqBody.tools?.map((t) => t.type)).toEqual(
      expect.arrayContaining(['web_search', 'x_search'])
    );

    const rig410 = createExecutionRig(() => harness.session.getSnapshot());
    const exec410 = new ChatRequestExecution(
      harness.productionAdapterRegistry,
      rig410.orchestration,
      rig410.host
    );
    const lease410 = rig410.orchestration.begin({ phase: 'provider-request', label: 's3-410' })!;
    const out410 = await exec410.execute({
      assistantMessage: { id: 's3-410-msg', role: 'assistant', content: '', createdAt: 2, status: 'pending' },
      conversationId: harness.session.getSnapshot().activeConversationId,
      transcript: [{ id: 's3-u-410', role: 'user', content: '触发 410', createdAt: 1, status: 'ready' }],
      runtime: { provider: xaiProvider, model: grokModel, modelId: grokModel.id, reasoningEffort: 'medium' },
      controller: lease410.controller,
      usageEvent: createStartedProviderUsageEvent({
        id: 'usage-s3-410',
        kind: 'web-search',
        providerId: xaiProvider.id,
        modelId: grokModel.id,
        createdAt: 2,
        messageId: 's3-410-msg',
      }),
      parameterSettings: defaultParameterSettings,
    });
    expect(out410.status).toBe('error');
    if (out410.status === 'error') {
      expect(out410.error).not.toContain(xaiKey);
    }

    // 阶段 B：DeepSeek 官方直连双工具搜索 + 多轮 server_tool_calls 回传
    const dsModel: ModelInfo = {
      id: 'deepseek-v4-pro',
      name: 'DeepSeek V4 Pro',
      capabilities: ['text', 'reasoning', 'web-search', 'streaming'],
      source: 'preset',
    };
    await harness.addAndSelectProvider(getDefaultProviderClone('deepseek', 'sk-ds-s3-secret'), dsModel);
    const dsProvider = harness.session
      .getSnapshot()
      .providers.find((p) => p.id === 'deepseek') as ProviderProfile;
    server.enqueue(
      { method: 'POST', pathname: '/v1/chat/completions' },
      {
        kind: 'sse',
        chunks: buildDeepSeekChatSseChunks({
          model: 'deepseek-v4-pro',
          reasoningDeltas: ['DeepSeek 官方联网推理'],
          serverToolCalls: [
            { id: 'ds_c1', type: 'deepseek_web_search', input: { query: 'ds 2026' } },
            { id: 'ds_c2', type: 'deepseek_read_url', input: { url: 'https://deepseek.com/docs' } },
          ],
          textDeltas: ['DeepSeek 官方搜索完成。'],
        }),
      }
    );
    server.enqueue(
      { method: 'POST', pathname: '/v1/chat/completions' },
      {
        kind: 'sse',
        chunks: buildDeepSeekChatSseChunks({ model: 'deepseek-v4-pro', textDeltas: ['DeepSeek 第二轮。'] }),
      }
    );

    const dsAdapter = harness.productionAdapterRegistry.resolve(
      { provider: dsProvider, modelId: dsModel.id, model: dsModel },
      'chat'
    );
    const dsRes1 = await dsAdapter.run({
      provider: dsProvider,
      modelId: dsModel.id,
      model: dsModel,
      messages: [{ id: 'ds-u1', role: 'user', content: '查 DeepSeek 官方搜索', createdAt: 10, status: 'ready' }],
      reasoningEffort: 'high',
      parameterSettings: defaultParameterSettings,
      webSearch: harness.session.getSnapshot().webSearch,
    });
    expect(dsRes1.providerContinuations?.some((b) => b.provider === 'deepseek')).toBe(true);

    await dsAdapter.run({
      provider: dsProvider,
      modelId: dsModel.id,
      model: dsModel,
      messages: [
        { id: 'ds-u1', role: 'user', content: '查 DeepSeek 官方搜索', createdAt: 10, status: 'ready' },
        {
          id: 'ds-a1',
          role: 'assistant',
          content: dsRes1.content,
          providerContinuations: dsRes1.providerContinuations,
          createdAt: 11,
          status: 'ready',
        } as E2EChatMessage,
        { id: 'ds-u2', role: 'user', content: '继续追问', createdAt: 12, status: 'ready' },
      ],
      reasoningEffort: 'high',
      parameterSettings: defaultParameterSettings,
      webSearch: harness.session.getSnapshot().webSearch,
    });
    const dsReqs = server.getRequests({ pathname: '/v1/chat/completions' });
    expect(dsReqs).toHaveLength(2);
    expect(JSON.stringify(dsReqs[0]?.jsonBody)).toContain('deepseek_web_search');
    expect(JSON.stringify(dsReqs[0]?.jsonBody)).toContain('deepseek_read_url');
    expect(JSON.stringify(dsReqs[1]?.jsonBody)).toContain('server_tool_calls');

    // 阶段 C：中转 gpt-4.1 切换 4 个外部搜索引擎 + SearXNG 502 故障降级
    await harness.setProviderWebSearch(false);
    const relay = getDefaultProviderClone('new-api-relay', 'sk-relay-s3');
    const relayModel: ModelInfo = {
      id: 'gpt-4.1',
      name: 'GPT-4.1',
      capabilities: ['text', 'tool-calling', 'streaming'],
      source: 'manual',
    };
    await harness.addAndSelectProvider(relay, relayModel);
    const activeRelay = harness.session
      .getSnapshot()
      .providers.find((p) => p.id === 'new-api-relay') as ProviderProfile;
    const relayAdapter = harness.productionAdapterRegistry.resolve(
      { provider: activeRelay, modelId: 'gpt-4.1', model: relayModel },
      'chat'
    );

    const engineSpecs: Array<{
      id: string;
      kind: 'deepseek' | 'bocha' | 'exa' | 'searxng';
      apiKey?: string;
      endpoint?: string;
      routeMatcher: { method: 'GET' | 'POST'; pathname: string | RegExp };
      responseAction:
        | { kind: 'json'; body: unknown }
        | { kind: 'error'; status: number; body: string };
      finalText: string;
    }> = [
      {
        id: 'ext-ds',
        kind: 'deepseek',
        apiKey: 'sk-ext-ds-secret',
        routeMatcher: { method: 'POST', pathname: '/v1/tools/search' },
        responseAction: {
          kind: 'json',
          body: buildDeepSeekToolsSearchJson([{ title: 'DS Tool', url: 'https://ds.example.com/1', snippet: 's1' }]),
        },
        finalText: 'DeepSeek Tools 结果 [1](1:s1)。',
      },
      {
        id: 'ext-bocha',
        kind: 'bocha',
        apiKey: 'sk-ext-bocha-secret',
        routeMatcher: { method: 'POST', pathname: /\/v1\/web-search/ },
        responseAction: {
          kind: 'json',
          body: buildBochaSearchJson([{ title: 'Bocha Hit', url: 'https://bocha.example.com/2', snippet: 's2' }]),
        },
        finalText: 'Bocha 结果 [1](1:s1)。',
      },
      {
        id: 'ext-exa',
        kind: 'exa',
        apiKey: 'sk-ext-exa-secret',
        routeMatcher: { method: 'POST', pathname: '/search' },
        responseAction: {
          kind: 'json',
          body: buildExaSearchJson([{ title: 'Exa Hit', url: 'https://exa.example.com/3', snippet: 's3' }]),
        },
        finalText: 'Exa 结果 [1](1:s1)。',
      },
      {
        id: 'ext-searx-ok',
        kind: 'searxng',
        endpoint: 'https://searx.example.com/search',
        routeMatcher: { method: 'GET', pathname: '/search' },
        responseAction: {
          kind: 'json',
          body: buildSearxngSearchJson('searx s3', [
            { title: 'SearXNG Hit', url: 'https://searx.example.com/4', snippet: 's4' },
          ]),
        },
        finalText: 'SearXNG 正常结果 [1](1:s1)。',
      },
      {
        id: 'ext-searx',
        kind: 'searxng',
        endpoint: 'https://searx.example.com/search',
        routeMatcher: { method: 'GET', pathname: '/search' },
        responseAction: { kind: 'error', status: 502, body: 'Bad Gateway' },
        finalText: 'SearXNG 暂不可用，降级给出本地知识回答。',
      },
    ];

    const collectedCitations: NonNullable<ChatMessage['citations']> = [];
    for (const spec of engineSpecs) {
      await harness.setExternalSearch({
        enabled: true,
        maxResults: 3,
        maxToolRounds: 2,
        selectedServiceId: spec.id,
        services: [
          {
            id: spec.id,
            kind: spec.kind,
            name: spec.kind,
            ...(spec.apiKey ? { apiKey: spec.apiKey } : {}),
            ...(spec.endpoint ? { endpoint: spec.endpoint } : {}),
          } as unknown as ExternalSearchService,
        ],
      });

      server.enqueue(
        { method: 'POST', pathname: '/v1/chat/completions' },
        {
          kind: 'sse',
          chunks: buildOpenAiChatSseChunks({
            model: 'gpt-4.1',
            textDeltas: [],
            toolCalls: [{ index: 0, id: `call_${spec.id}`, name: 'search_web', argumentsJson: '{"query":"test"}' }],
          }),
        }
      );
      server.enqueue(spec.routeMatcher, spec.responseAction);
      server.enqueue(
        { method: 'POST', pathname: '/v1/chat/completions' },
        {
          kind: 'sse',
          chunks: buildOpenAiChatSseChunks({ model: 'gpt-4.1', textDeltas: [spec.finalText] }),
        }
      );

      const res = await relayAdapter.run({
        provider: activeRelay,
        modelId: 'gpt-4.1',
        model: relayModel,
        messages: [{ id: `u-${spec.id}`, role: 'user', content: `搜索 ${spec.kind}`, createdAt: 20, status: 'ready' }],
        reasoningEffort: 'medium',
        parameterSettings: defaultParameterSettings,
        externalSearch: harness.session.getSnapshot().externalSearch,
      });
      expect(res.content).toContain(spec.finalText);
      collectedCitations.push(...(res.citations ?? []));
    }

    // 验证 stripExternalSearchSecrets 剥离全部外部搜索 Key
    const strippedSettings = stripExternalSearchSecrets({
      enabled: true,
      selectedServiceId: 'ext-ds',
      maxResults: 5,
      maxToolRounds: 3,
      services: [
        { id: 'ext-ds', kind: 'deepseek' as ExternalSearchService['kind'], name: 'DS', apiKey: 'sk-ext-ds-secret' },
      ],
    });
    expect(JSON.stringify(strippedSettings)).not.toContain('sk-ext-ds-secret');

    // 阶段 D：/export 指令与安全脱敏导出
    expect(slash.shouldOpenSlashCommandMenu('/export')).toBe(true);
    const expCmd = slash.filterSlashCommands('/export').find((item) => item.kind === 'builtin');
    expect(expCmd).toBeDefined();
    expect(slash.resolveSlashCommandSelection(expCmd!, '/export').kind).toBe('builtin');

    const maliciousConv: ChatConversation = {
      id: 'conv-s3-export',
      title: '../../CON <script>alert(1)</script> 多引擎汇报',
      createdAt: 1000,
      updatedAt: 2000,
      messages: [
        {
          id: 'm-s3-1',
          role: 'assistant',
          content: '汇总各搜索引擎结论。',
          reasoningContent: '分析 Grok、DeepSeek、Bocha、Exa、SearXNG 降级结果',
          citations: collectedCitations,
          modelId: 'gpt-4.1',
          createdAt: 1500,
          status: 'ready',
        },
      ],
    };

    const md = exportService.exportConversationToMarkdown(maliciousConv);
    expect(md).not.toMatch(/<script[\s>]/i);
    expect(md).toMatch(/<details>|深度思考|思考过程/);
    expect(md).toContain('https://ds.example.com/1');
    expect(md).toContain('https://bocha.example.com/2');
    expect(md).toContain('https://exa.example.com/3');
    expect(md).not.toContain(xaiKey);

    const safeMdName = exportService.sanitizeExportFilename(maliciousConv.title, 'md');
    expect(safeMdName).toMatch(/\.md$/);
    expect(safeMdName).not.toMatch(/[/\\:*?"<>|]/);

    vi.useFakeTimers();
    const mdRes = await exportService.exportConversation({ conversation: maliciousConv, format: 'markdown' });
    const jsonRes = await exportService.exportConversation({ conversation: maliciousConv, format: 'json' });
    expect(mdRes.filename).toMatch(/\.md$/);
    expect(jsonRes.filename).toMatch(/\.json$/);
    await vi.advanceTimersByTimeAsync(1500);
    expect(domStub.revokedUrls).toHaveLength(2);
  });

  it('[S6] 并发压力与异常恢复：FIFO 费用/MCP 确认取消防死锁 + 断流切模型重连 + / 斜杠指令与草稿隔离 + 分支与全局搜索一致', async () => {
    setE2EPlatformOs('web');
    const router = installMockFetchRouter(serverBaseUrl, { enableWebDevProxy: true });
    restoreCallbacks.push(() => router.restore());
    const harness = await createE2EWorkspaceHarness();
    restoreCallbacks.push(() => harness.dispose());

    const shortcuts = await safeImportModule<ComposerShortcutsContract>(
      'src/features/chat/composerShortcuts.ts',
      ['resolveComposerKeyAction']
    );
    const slash = await safeImportModule<SlashCommandsContract>(
      'src/features/chat/slashCommands.ts',
      ['filterSlashCommands', 'resolveSlashCommandSelection']
    );
    const runtimeMod = await safeImportModule<Record<string, unknown>>(
      'src/features/chat/internal/ChatWorkspaceRuntime.ts',
      []
    );
    const providerMod = await safeImportModule<Record<string, unknown>>(
      'src/app/workspace/WorkspaceSessionProvider.tsx',
      ['useWorkspaceSelector']
    );

    const draftHook =
      runtimeMod.useStreamingDraftSelector ??
      runtimeMod.useStreamingMessageDraft ??
      providerMod.useStreamingDraftSelector ??
      providerMod.useStreamingMessageDraft;
    expect(typeof draftHook).toBe('function');

    const openaiSecret = 'sk-openai-s6-secret';
    const mcpSecret = 'Bearer mcp-s6-secret-token';
    const openai = getDefaultProviderClone('openai', openaiSecret);
    await harness.addAndSelectProvider(openai, openai.models[0]);
    await harness.settingsRuntime.execute({
      type: 'cost-guard.update',
      patch: { enabled: true, dailyUsdBudget: 0.01, limitAction: 'warn' },
    });

    // 1) FIFO 费用与 MCP 并发确认 + Abort/cancelAll 清除 streamTimer 防死锁
    const pCost1 = harness.decisionQueue.requestCostConfirmation('预算确认 A');
    const pCost2 = harness.decisionQueue.requestCostConfirmation('预算确认 B');
    harness.decisionQueue.resolveCostConfirmation(true);
    await expect(raceWithTimeout(pCost1, 'S6 cost1')).resolves.toBe(true);
    expect(harness.decisionQueue.getSnapshot().costConfirmationReason).toBe('预算确认 B');

    const mcp1 = makeMcpApprovalRequest('s6-mcp-1', 'inspect');
    const mcp2 = makeMcpApprovalRequest('s6-mcp-2', 'deploy');
    const pMcp1 = harness.decisionQueue.requestMcpApproval(mcp1, {
      providerName: 'OpenAI',
      modelId: 'gpt-5',
      serverName: 'Ops MCP',
      endpoint: 'https://mcp.example.com/sse',
    });
    const pMcp2 = harness.decisionQueue.requestMcpApproval(mcp2, {
      providerName: 'OpenAI',
      modelId: 'gpt-5',
      serverName: 'Ops MCP',
      endpoint: 'https://mcp.example.com/sse',
    });
    const snap1 = harness.decisionQueue.getSnapshot().mcpApprovalView;
    expect(snap1?.approvalRequestId).toBe('s6-mcp-1');
    // 错 nonce 拒绝
    harness.decisionQueue.resolveMcpApproval(
      { approvalRequestId: snap1!.approvalRequestId, nonce: snap1!.approvalNonce + 99 },
      'approve'
    );
    expect(harness.decisionQueue.getSnapshot().mcpApprovalView?.approvalRequestId).toBe('s6-mcp-1');
    harness.decisionQueue.resolveMcpApproval(
      { approvalRequestId: snap1!.approvalRequestId, nonce: snap1!.approvalNonce },
      'approve'
    );
    await expect(raceWithTimeout(pMcp1, 'S6 mcp1')).resolves.toBe('approve');
    expect(harness.decisionQueue.getSnapshot().mcpApprovalView?.approvalRequestId).toBe('s6-mcp-2');

    const rigAbort = createExecutionRig(() => harness.session.getSnapshot(), { streamUpdateDelayMs: 50 });
    const leaseAbort = rigAbort.orchestration.begin({ phase: 'provider-request', label: 's6-abort' })!;
    const abortAdapter: ProviderAdapter = {
      run: (req) =>
        new Promise((_resolve, reject) => {
          req.onStreamUpdate?.({
            content: '未完流式',
            activityTimeline: [
              { kind: 'thinking', id: 'th-s6', status: 'running', title: '思考中', content: 'x', startedAt: 100, sequence: 0 },
            ],
          });
          req.signal?.addEventListener(
            'abort',
            () => {
              const e = new Error('cancelled');
              e.name = 'AbortError';
              reject(e);
            },
            { once: true }
          );
        }),
      queryTask: async () => ({ content: '', raw: undefined }),
    };
    const execAbort = new ChatRequestExecution(
      { resolve: () => abortAdapter } as ProviderAdapterRegistry,
      rigAbort.orchestration,
      rigAbort.host
    );
    const convId = harness.session.getSnapshot().activeConversationId;
    const abortExecP = execAbort.execute({
      assistantMessage: { id: 's6-abort-msg', role: 'assistant', content: '', createdAt: 10, status: 'pending' },
      conversationId: convId,
      transcript: [{ id: 's6-u0', role: 'user', content: '取消测试', createdAt: 9, status: 'ready' }],
      runtime: { provider: openai as unknown as ProviderProfile, model: openai.models[0], modelId: openai.models[0].id, reasoningEffort: 'low' },
      controller: leaseAbort.controller,
      usageEvent: createStartedProviderUsageEvent({
        id: 'usage-s6-abort',
        kind: 'chat',
        providerId: openai.id,
        modelId: openai.models[0].id,
        createdAt: 10,
        messageId: 's6-abort-msg',
      }),
      parameterSettings: defaultParameterSettings,
    });

    await Promise.resolve();
    leaseAbort.controller.abort();
    harness.decisionQueue.cancelAll();
    await expect(raceWithTimeout(pCost2, 'S6 cost2 cancelAll', 400)).resolves.toBe(false);
    await expect(raceWithTimeout(pMcp2, 'S6 mcp2 cancelAll', 400)).resolves.toBe('cancel');
    const abortOutcome = await raceWithTimeout(abortExecP, 'S6 exec abort', 400);
    expect(abortOutcome.status).toBe('cancelled');

    const frozen = finalizeActivityTimelineForTerminalMessage(
      [{ kind: 'thinking', id: 'th-s6', status: 'running', title: '思考中', content: 'x', startedAt: 100, sequence: 0 }],
      { messageStatus: 'cancelled', finishedAt: 500 }
    );
    expect(frozen?.[0]?.status).toBe('completed');

    // 2) 中途断流 premature-end & destroy-socket → 切模型重连恢复 + 200+ chunks 草稿隔离
    const proModel: ModelInfo = {
      id: 'gpt-5.4-pro',
      name: 'GPT-5.4 Pro',
      capabilities: ['text', 'reasoning', 'streaming'],
      source: 'preset',
    };
    const activeOpenAi = harness.session
      .getSnapshot()
      .providers.find((p) => p.id === 'openai') as ProviderProfile;
    const proAdapter = harness.productionAdapterRegistry.resolve(
      { provider: activeOpenAi, modelId: proModel.id, model: proModel },
      'chat'
    );

    server.enqueue(
      { method: 'POST', pathname: '/v1/responses' },
      {
        kind: 'sse',
        abortAfterChunkIndex: 1,
        abortMode: 'premature-end',
        chunks: buildOpenAiResponsesSseChunks({
          model: 'gpt-5.4-pro',
          textDeltas: ['断流前半句'],
        }),
      }
    );
    await expect(
      proAdapter.run({
        provider: activeOpenAi,
        modelId: proModel.id,
        model: proModel,
        messages: [{ id: 'u-drop-1', role: 'user', content: '断流1', createdAt: 20, status: 'ready' }],
        reasoningEffort: 'medium',
        parameterSettings: defaultParameterSettings,
      })
    ).rejects.toThrow(/response\.completed|意外中断|未收到|中断/i);

    server.enqueue(
      { method: 'POST', pathname: '/v1/responses' },
      {
        kind: 'sse',
        abortAfterChunkIndex: 0,
        abortMode: 'destroy-socket',
        chunks: buildOpenAiResponsesSseChunks({
          model: 'gpt-5.4-pro',
          textDeltas: ['socket 断开'],
        }),
      }
    );
    await expect(
      proAdapter.run({
        provider: activeOpenAi,
        modelId: proModel.id,
        model: proModel,
        messages: [{ id: 'u-drop-2', role: 'user', content: '断流2', createdAt: 21, status: 'ready' }],
        reasoningEffort: 'medium',
        parameterSettings: defaultParameterSettings,
      })
    ).rejects.toThrow(/terminated|aborted|closed|socket|ECONNRESET|意外中断|未收到/i);

    // 切换模型 + /代码 斜杠指令模板 + Enter/IME 校验 + 重连 210 chunks 流式恢复
    const chatModel41: ModelInfo = {
      id: 'gpt-4.1',
      name: 'GPT-4.1',
      capabilities: ['text', 'streaming'],
      source: 'preset',
    };
    await harness.settingsRuntime.execute({
      type: 'model.select',
      providerId: 'openai',
      modelId: 'gpt-4.1',
      activateProvider: true,
    });
    const templates = createPromptTemplate(
      [],
      { name: '代码审查', content: '请审查 S6 高并发代码', mode: 'composer' },
      { id: 'tpl-s6', now: harness.clock.now() }
    );
    const tplItem = slash.filterSlashCommands('/代码', { promptTemplates: templates })[0];
    expect(tplItem).toBeDefined();
    const sel = slash.resolveSlashCommandSelection(tplItem!, '/代码');
    expect(
      shortcuts.resolveComposerKeyAction({
        platformOs: 'web',
        key: 'Enter',
        isComposing: true,
        text: sel.nextText ?? '',
      })
    ).toBe('ignore');
    expect(
      shortcuts.resolveComposerKeyAction({
        platformOs: 'web',
        key: 'Enter',
        isComposing: false,
        text: sel.nextText ?? '',
      })
    ).toBe('submit');

    const deltas210 = generateHighFrequencyTextDeltas(210, 's6-');
    server.enqueue(
      { method: 'POST', pathname: '/v1/chat/completions' },
      { kind: 'sse', chunks: buildOpenAiChatSseChunks({ model: 'gpt-4.1', textDeltas: deltas210 }) }
    );

    const chat41Adapter = harness.productionAdapterRegistry.resolve(
      { provider: activeOpenAi, modelId: 'gpt-4.1', model: chatModel41 },
      'chat'
    );
    const recovered = await chat41Adapter.run({
      provider: activeOpenAi,
      modelId: 'gpt-4.1',
      model: chatModel41,
      messages: [{ id: 's6-u-rec', role: 'user', content: sel.nextText ?? '重连', createdAt: 30, status: 'ready' }],
      reasoningEffort: 'low',
      parameterSettings: defaultParameterSettings,
    });
    expect(recovered.content).toContain('s6-209');

    // 3) 分支、落盘、冷重启与全局搜索零泄露验证
    const msgRecUser: ChatMessage = {
      id: 's6-rec-u',
      role: 'user',
      content: '高并发恢复关键记录',
      createdAt: 30,
      status: 'ready',
    };
    const msgRecAsst: ChatMessage = {
      id: 's6-rec-a',
      role: 'assistant',
      content: recovered.content,
      createdAt: 31,
      status: 'ready',
    };
    await harness.chatRuntime.execute({
      type: 'conversation.set-messages',
      conversationId: convId,
      now: 35,
      messages: [msgRecUser, msgRecAsst],
    });
    const projectsRuntime = new ProjectsConversationsRuntime({
      commit: harness.session.bindCommitPort(createProjectsCommitReducer()),
      now: () => harness.clock.now(),
      createId: (prefix) => harness.ids.createId(prefix),
      isHistoryLocked: () => false,
    });
    const forkRes = await projectsRuntime.execute({
      type: 'conversation.fork',
      conversationId: convId,
      messageId: msgRecAsst.id,
    });
    expect(forkRes.ok).toBe(true);
    await harness.flush();

    const rebooted = new WorkspaceSession({
      persistence: harness.persistence,
      clock: harness.clock,
      lifecycle: harness.lifecycle,
      trace: harness.trace,
      autoBoot: false,
    });
    restoreCallbacks.push(() => rebooted.dispose());
    await rebooted.boot();

    const searchTarget = {
      ...rebooted.getSnapshot(),
      plugins: [{ id: 'mcp-s6', authorization: mcpSecret }],
    };
    const index = buildWorkspaceSearchIndex(searchTarget);
    const hits = searchWorkspaceIndex(index, '高并发恢复关键记录');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(searchWorkspace(searchTarget, openaiSecret)).toEqual([]);
    expect(searchWorkspace(searchTarget, mcpSecret)).toEqual([]);
    expect(JSON.stringify(index)).not.toContain(openaiSecret);
    expect(JSON.stringify(index)).not.toContain(mcpSecret);
  });
});
