/**
 * Tier 3 跨特性组合矩阵 E2E 测试（Pairwise & Three-Way Cross-Feature Matrix）。
 * 覆盖 [T3-01] 至 [T3-12] 共 12 个两两/三方交互组合场景，严格沿用公开导出契约与 safeImportModule fail-loud 策略。
 */
import 'fake-indexeddb/auto';

import fs from 'node:fs';
import path from 'node:path';
import { createElement, type ReactNode } from 'react';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
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
import {
  reindexExternalSearchResult,
  resolveMessageMarkdownLink,
} from '../../../src/services/externalSearch';
import { saveAttachmentToDevice } from '../../../src/services/mediaExport';
import {
  cleanupOrphanedMediaStorage,
  discardUncommittedAttachments,
  persistAttachment,
  resolveAttachmentDisplayUri,
} from '../../../src/services/mediaStorage';
import { finalizeActivityTimelineForTerminalMessage } from '../../../src/services/messageActivity';
import { createPromptTemplate } from '../../../src/services/promptTemplates';
import type { ProviderMcpApprovalRequest } from '../../../src/services/providerMcp';
import {
  isRelayOrCustomProvider,
  resolveProviderAuthHeaders,
} from '../../../src/services/providerSetup';
import {
  buildWorkspaceSearchIndex,
  searchWorkspace,
  searchWorkspaceIndex,
} from '../../../src/services/workspaceSearch';
import {
  bindAppDialogHost,
  requestConfirm,
  requestNotice,
  type DialogRequest,
} from '../../../src/ui/components/dialogService';
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
  buildGeminiGenerateContentJson,
  buildGeminiStreamSseChunks,
  buildOpenAiChatSseChunks,
  buildOpenAiImageGenerationJson,
  buildSearxngSearchJson,
  buildXaiResponsesSseChunks,
  generateHighFrequencyTextDeltas,
  TINY_PNG_BASE64,
} from '../helpers/sseFixtures';
import { setE2EPlatformOs } from '../helpers/vitestE2eSetup';
import {
  CORE_WEB_INTERACTIVE_TARGETS,
  probeElementGeometryAndOcclusion,
  probeOverlayResidual,
} from '../helpers/webGeometryProbes';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..', '..', '..');

interface CapturedRenderedNode {
  type: string;
  props: Record<string, unknown>;
  textContent: string;
}

const {
  tier3PlatformState,
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
    tier3PlatformState: platformState,
    capturedNodes: nodes,
    StubComponent: makeStub('StubComponent'),
    createStubComponent: makeStub,
    createGestureChain: makeGestureChain,
    createLayoutTransitionStub: makeLayoutTransitionStub,
  };
});

// 保持 vitestE2eSetup 的 setE2EPlatformOs 与本文件 react-native Platform 桩双向联动
vi.mock('../helpers/vitestE2eSetup', async (importOriginal) => {
  const original = await importOriginal<typeof import('../helpers/vitestE2eSetup')>();
  return {
    ...original,
    setE2EPlatformOs: (os: 'android' | 'ios' | 'web') => {
      original.setE2EPlatformOs(os);
      tier3PlatformState.OS = os;
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
    Platform: tier3PlatformState,
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

// 动态契约接口声明（严禁静态 import 未落地模块）
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
  parseMarkdownBlocks: (content: string) => Array<{
    kind: string;
    language?: string;
    text?: string;
    display?: boolean;
  }>;
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
  highlightCodeTokens: (code: string, language?: string) => Array<{ text: string; tokenType: string }>;
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
    apiKey: apiKeyOverride ?? `sk-t3-${id}`,
    models: found.models.map((m) => ({ ...m, capabilities: [...m.capabilities] })),
    capabilities: [...found.capabilities],
  } as E2EProviderProfile;
}

function createExecutionRig(
  workspaceReader: () => AppWorkspace,
  overrides: {
    streamUpdateDelayMs?: number;
    authorize?: (plan: unknown) => Promise<boolean>;
    requestMcpApproval?: (
      request: ProviderMcpApprovalRequest,
      presentation: {
        providerName: string;
        modelId: string;
        serverName: string;
        endpoint: string;
      },
      signal?: AbortSignal
    ) => Promise<'approve' | 'deny' | 'cancel'>;
  } = {}
) {
  let currentLease: ChatLease | null = null;
  const messagePatches: Array<{ messageId: string; patch: Partial<ChatMessage>; conversationId: string }> = [];
  const persistedUsageEvents: ProviderUsageEvent[] = [];
  const usageFinishes: Array<{ id: string; status: 'succeeded' | 'failed' | 'cancelled' }> = [];
  const notifications: string[] = [];

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
    authorize: overrides.authorize ?? (async () => true),
    persistUsageEvents: async (events: readonly ProviderUsageEvent[]) => {
      persistedUsageEvents.push(...events);
    },
    finishUsageEvent: async (
      event: ProviderUsageEvent,
      status: 'succeeded' | 'failed' | 'cancelled'
    ) => {
      usageFinishes.push({ id: event.id, status });
    },
    requestMcpApproval: overrides.requestMcpApproval ?? (async () => 'deny' as const),
    updateAssistantMessage: (messageId: string, patch: Partial<ChatMessage>, conversationId: string) => {
      messagePatches.push({ messageId, patch, conversationId });
    },
    notify: (message: string) => {
      notifications.push(message);
    },
  };

  return { orchestration, host, messagePatches, persistedUsageEvents, usageFinishes, notifications };
}

function installWebExportAndDownloadDomStub(): {
  downloads: Array<{ filename: string; href: string }>;
  createdBlobs: Blob[];
  revokedUrls: string[];
  restore: () => void;
} {
  const downloads: Array<{ filename: string; href: string }> = [];
  const createdBlobs: Blob[] = [];
  const revokedUrls: string[] = [];

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

  URL.createObjectURL = (blob: Blob | MediaSource) => {
    if (blob instanceof Blob) {
      createdBlobs.push(blob);
    }
    return `blob:https://embezzle.local/t3-export-${createdBlobs.length}`;
  };
  URL.revokeObjectURL = (url: string) => {
    revokedUrls.push(url);
  };

  return {
    downloads,
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

async function renderCapturedLightbox(
  Component: (props: ImageLightboxProps) => ReactNode,
  props: ImageLightboxProps
): Promise<{ markup: string; nodes: CapturedRenderedNode[] }> {
  capturedNodes.length = 0;
  const serverModuleName = 'react-dom/server';
  const { renderToStaticMarkup } = (await import(/* @vite-ignore */ serverModuleName)) as {
    renderToStaticMarkup: (element: ReactNode) => string;
  };
  const markup = renderToStaticMarkup(createElement(Component, props));
  return { markup, nodes: capturedNodes.slice() };
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
      (val) => {
        clearTimeout(timer);
        resolve(val);
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

describe('Tier 3 — 跨特性组合矩阵 E2E 测试（12 项核心两两/三方交互）', () => {
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
    bindAppDialogHost(null);
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

  it('[T3-01] F2×F3: Claude Thinking (signature/redacted_thinking) + 官方 web_search_20250305 多轮混合续接及 Gemini thoughtSignature + Grounding', async () => {
    const router = installMockFetchRouter(serverBaseUrl);
    restoreCallbacks.push(() => router.restore());
    const harness = await createE2EWorkspaceHarness();
    restoreCallbacks.push(() => harness.dispose());

    // 1) Anthropic Claude：Thinking + redacted_thinking + web_search_20250305 多轮回传
    const claudeModel: ModelInfo = {
      id: 'claude-sonnet-5-5',
      name: 'Claude Sonnet 5.5',
      capabilities: ['text', 'reasoning', 'web-search', 'streaming'],
      source: 'preset',
    };
    await harness.addAndSelectProvider(
      getDefaultProviderClone('anthropic', 'sk-ant-t3-01'),
      claudeModel
    );
    await harness.setProviderWebSearch(true, 'medium');

    server.enqueue(
      { method: 'POST', pathname: '/v1/messages' },
      {
        kind: 'sse',
        chunkDelayMs: 5,
        chunks: buildAnthropicMessagesSseChunks({
          model: 'claude-sonnet-5-5',
          thinkingBlocks: [{ thinking: '思考联网检索方向', signature: 'sig_claude_t3_01' }],
          redactedThinkingData: 'redacted_blob_t3_01',
          serverWebSearch: {
            toolUseId: 'srvtoolu_t3_01',
            query: 'Embezzle 2026 release',
            results: [
              {
                url: 'https://anthropic.com/news/2026',
                title: 'Anthropic News',
                encrypted_content: 'enc_ws_result_t3_01',
              },
            ],
          },
          textDeltas: ['Claude 首轮结论 [1]。'],
          citations: [
            {
              type: 'web_search_result_location',
              url: 'https://anthropic.com/news/2026',
              title: 'Anthropic News',
              cited_text: 'Claude 首轮结论',
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
          model: 'claude-sonnet-5-5',
          thinkingBlocks: [{ thinking: '延续前序上下文思考', signature: 'sig_claude_t3_02' }],
          textDeltas: ['Claude 第二轮追问解答。'],
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
      id: harness.ids.createId('msg'),
      role: 'user',
      content: '查询 Embezzle 2026 发布进展',
      createdAt: harness.clock.now(),
      status: 'ready',
    };
    const asstMsg1: ChatMessage = {
      id: harness.ids.createId('msg'),
      role: 'assistant',
      content: '',
      createdAt: harness.clock.now() + 1,
      status: 'pending',
      providerId: claudeProvider.id,
      modelId: claudeModel.id,
    };

    const lease1 = rig.orchestration.begin({ phase: 'provider-request', label: 't3-01-r1' })!;
    const out1 = await execution.execute({
      assistantMessage: asstMsg1,
      conversationId: convId,
      transcript: [userMsg1],
      runtime: { provider: claudeProvider, model: claudeModel, modelId: claudeModel.id, reasoningEffort: 'high' },
      controller: lease1.controller,
      usageEvent: createStartedProviderUsageEvent({
        id: 'usage-t3-01-r1',
        kind: 'web-search',
        providerId: claudeProvider.id,
        modelId: claudeModel.id,
        createdAt: harness.clock.now(),
        messageId: asstMsg1.id,
      }),
      parameterSettings: defaultParameterSettings,
    });

    expect(out1.status).toBe('success');
    const readyPatch1 = rig.messagePatches.find(
      (p) => p.messageId === asstMsg1.id && p.patch.status === 'ready'
    );
    expect(readyPatch1?.patch.thinkingDurationMs).toBeGreaterThanOrEqual(0);
    expect(readyPatch1?.patch.webSearchTriggered).toBe(true);
    expect(readyPatch1?.patch.citations?.length).toBeGreaterThanOrEqual(1);

    const persistedAsst1: E2EChatMessage = {
      ...asstMsg1,
      ...readyPatch1?.patch,
      status: 'ready',
    };
    await harness.chatRuntime.execute({
      type: 'chat.append-messages',
      conversationId: convId,
      messages: [userMsg1, persistedAsst1],
      now: harness.clock.now(),
    });

    // Round 2 追问，验证回传 thinking/redacted_thinking/server_tool_use/web_search_tool_result
    const userMsg2: ChatMessage = {
      id: harness.ids.createId('msg'),
      role: 'user',
      content: '继续展开上一轮细节',
      createdAt: harness.clock.now() + 20,
      status: 'ready',
    };
    const asstMsg2: ChatMessage = {
      id: harness.ids.createId('msg'),
      role: 'assistant',
      content: '',
      createdAt: harness.clock.now() + 21,
      status: 'pending',
      providerId: claudeProvider.id,
      modelId: claudeModel.id,
    };
    const lease2 = rig.orchestration.begin({ phase: 'provider-request', label: 't3-01-r2' })!;
    const out2 = await execution.execute({
      assistantMessage: asstMsg2,
      conversationId: convId,
      transcript: [userMsg1, persistedAsst1, userMsg2],
      runtime: { provider: claudeProvider, model: claudeModel, modelId: claudeModel.id, reasoningEffort: 'high' },
      controller: lease2.controller,
      usageEvent: createStartedProviderUsageEvent({
        id: 'usage-t3-01-r2',
        kind: 'web-search',
        providerId: claudeProvider.id,
        modelId: claudeModel.id,
        createdAt: harness.clock.now(),
        messageId: asstMsg2.id,
      }),
      parameterSettings: defaultParameterSettings,
    });
    expect(out2.status).toBe('success');

    const claudeReqs = server.getRequests({ method: 'POST', pathname: '/v1/messages' });
    expect(claudeReqs).toHaveLength(2);
    expect(claudeReqs[0]?.headers['x-api-key']).toBe('sk-ant-t3-01');
    expect(claudeReqs[0]?.headers['anthropic-version']).toBe('2023-06-01');
    const r1Tools = (claudeReqs[0]?.jsonBody as { tools?: Array<{ type?: string }> })?.tools ?? [];
    expect(r1Tools.some((t) => t.type === 'web_search_20250305')).toBe(true);

    const r2Messages = (
      claudeReqs[1]?.jsonBody as {
        messages?: Array<{ role: string; content: Array<Record<string, unknown>> }>;
      }
    )?.messages;
    const assistantHistory = r2Messages?.find((m) => m.role === 'assistant');
    expect(assistantHistory).toBeDefined();
    const typesOrder = (assistantHistory?.content ?? []).map((b) => String(b.type));
    const firstNonThinkingIdx = typesOrder.findIndex(
      (t) => t !== 'thinking' && t !== 'redacted_thinking'
    );
    const lastThinkingIdx = Math.max(
      typesOrder.lastIndexOf('thinking'),
      typesOrder.lastIndexOf('redacted_thinking')
    );
    if (firstNonThinkingIdx !== -1 && lastThinkingIdx !== -1) {
      expect(lastThinkingIdx).toBeLessThan(firstNonThinkingIdx);
    }
    const serializedR2 = JSON.stringify(assistantHistory);
    expect(serializedR2).toContain('sig_claude_t3_01');
    expect(serializedR2).toContain('redacted_blob_t3_01');
    expect(serializedR2).toContain('srvtoolu_t3_01');
    expect(serializedR2).toContain('enc_ws_result_t3_01');

    // 2) Gemini：thoughtSignature + Grounding 多轮覆盖
    const geminiModel: ModelInfo = {
      id: 'gemini-2.5-pro',
      name: 'Gemini 2.5 Pro',
      capabilities: ['text', 'reasoning', 'web-search', 'streaming'],
      source: 'preset',
    };
    await harness.addAndSelectProvider(
      getDefaultProviderClone('gemini', 'AIzaSy-t3-01'),
      geminiModel
    );
    const geminiProvider = harness.session
      .getSnapshot()
      .providers.find((p) => p.id === 'gemini') as ProviderProfile;

    server.enqueue(
      { method: 'POST', pathname: '/v1beta/models/gemini-2.5-pro:streamGenerateContent' },
      {
        kind: 'sse',
        chunks: buildGeminiStreamSseChunks({
          thoughtParts: [{ text: 'Gemini 搜索思考', thoughtSignature: 'gem_thought_t3_01' }],
          textDeltas: ['Gemini Grounding 回复。'],
          finalThoughtSignature: 'gem_final_t3_01',
          webSearchQueries: ['gemini grounding 2026'],
          groundingChunks: [{ uri: 'https://ai.google.dev/grounding', title: 'Google Grounding' }],
        }),
      }
    );
    server.enqueue(
      { method: 'POST', pathname: '/v1beta/models/gemini-2.5-pro:streamGenerateContent' },
      {
        kind: 'sse',
        chunks: buildGeminiStreamSseChunks({
          textDeltas: ['Gemini 第二轮续接。'],
        }),
      }
    );

    const gAdapter = harness.productionAdapterRegistry.resolve(
      { provider: geminiProvider, modelId: geminiModel.id, model: geminiModel },
      'chat'
    );
    const gUser1: ChatMessage = {
      id: 'g-u1',
      role: 'user',
      content: '搜索 Gemini Grounding',
      createdAt: harness.clock.now(),
      status: 'ready',
    };
    const gOut1 = await gAdapter.run({
      provider: geminiProvider,
      modelId: geminiModel.id,
      model: geminiModel,
      messages: [gUser1],
      reasoningEffort: 'medium',
      parameterSettings: defaultParameterSettings,
      webSearch: harness.session.getSnapshot().webSearch,
    });
    expect(gOut1.citations?.[0]?.url).toBe('https://ai.google.dev/grounding');
    expect(gOut1.providerContinuations?.length).toBeGreaterThanOrEqual(1);

    const gAsst1: E2EChatMessage = {
      id: 'g-a1',
      role: 'assistant',
      content: gOut1.content,
      createdAt: harness.clock.now() + 1,
      status: 'ready',
      providerContinuations: gOut1.providerContinuations,
    };
    await gAdapter.run({
      provider: geminiProvider,
      modelId: geminiModel.id,
      model: geminiModel,
      messages: [gUser1, gAsst1, { id: 'g-u2', role: 'user', content: '继续', createdAt: harness.clock.now() + 2, status: 'ready' }],
      reasoningEffort: 'medium',
      parameterSettings: defaultParameterSettings,
      webSearch: harness.session.getSnapshot().webSearch,
    });

    const gemReqs = server.getRequests({
      pathname: '/v1beta/models/gemini-2.5-pro:streamGenerateContent',
    });
    expect(gemReqs).toHaveLength(2);
    expect(JSON.stringify(gemReqs[1]?.jsonBody)).toContain('gem_final_t3_01');
  });

  it('[T3-02] F2×F4: OpenAI 非 Pro 推理流式 + 外部搜索 Tool Calling 多轮闭环与引用重排（及 gpt-5.4-pro 拒绝）', async () => {
    const router = installMockFetchRouter(serverBaseUrl);
    restoreCallbacks.push(() => router.restore());
    const harness = await createE2EWorkspaceHarness();
    restoreCallbacks.push(() => harness.dispose());

    const model54: ModelInfo = {
      id: 'gpt-5.4',
      name: 'GPT-5.4',
      capabilities: ['text', 'reasoning', 'tool-calling', 'streaming'],
      source: 'preset',
    };
    await harness.addAndSelectProvider(
      getDefaultProviderClone('openai', 'sk-openai-t3-02'),
      model54
    );
    await harness.setExternalSearch({
      enabled: true,
      maxResults: 5,
      maxToolRounds: 2,
      selectedServiceId: 'bocha-1',
      services: [
        {
          id: 'bocha-1',
          kind: 'bocha',
          name: 'Bocha',
          apiKey: 'sk-bocha-t3-02',
        } as unknown as ExternalSearchService,
      ],
    });

    // 验证 reindexExternalSearchResult 连续编号重排契约（第二个参数为已累计条数 offset）
    const r1 = reindexExternalSearchResult(
      {
        items: [
          { index: 1, id: 's1', title: 'B1', url: 'https://bocha.example.com/1', text: 'T1' },
          { index: 2, id: 's2', title: 'B2', url: 'https://bocha.example.com/2', text: 'T2' },
        ],
      },
      0
    );
    const r2 = reindexExternalSearchResult(
      {
        items: [
          { index: 1, id: 's1', title: 'D1', url: 'https://ds.example.com/3', text: 'T3' },
          { index: 2, id: 's2', title: 'D2', url: 'https://ds.example.com/4', text: 'T4' },
        ],
      },
      2
    );
    expect(r1.items.map((i) => `${i.index}:${i.id}`)).toEqual(['1:s1', '2:s2']);
    expect(r2.items.map((i) => `${i.index}:${i.id}`)).toEqual(['3:s3', '4:s4']);

    // 第 1 轮 /v1/chat/completions：reasoning + tool_calls search_web
    server.enqueue(
      { method: 'POST', pathname: '/v1/chat/completions' },
      {
        kind: 'sse',
        chunkDelayMs: 5,
        chunks: buildOpenAiChatSseChunks({
          model: 'gpt-5.4',
          reasoningDeltas: ['推理：先查第一次外部资料。'],
          textDeltas: [],
          toolCalls: [
            {
              index: 0,
              id: 'call_bocha_1',
              name: 'search_web',
              argumentsJson: '{"query":"Embezzle 2026 first"}',
            },
          ],
        }),
      }
    );
    // Bocha 第 1 次返回 2 条
    server.enqueue(
      { method: 'POST', pathname: /\/v1\/web-search|\/search/ },
      {
        kind: 'json',
        body: buildBochaSearchJson([
          { title: 'Bocha Hit 1', url: 'https://bocha.example.com/1', snippet: '摘要 1' },
          { title: 'Bocha Hit 2', url: 'https://bocha.example.com/2', snippet: '摘要 2' },
        ]),
      }
    );
    // 第 2 轮 /v1/chat/completions：再次请求 search_web
    server.enqueue(
      { method: 'POST', pathname: '/v1/chat/completions' },
      {
        kind: 'sse',
        chunks: buildOpenAiChatSseChunks({
          model: 'gpt-5.4',
          reasoningDeltas: ['继续补充第二轮检索。'],
          textDeltas: [],
          toolCalls: [
            {
              index: 0,
              id: 'call_bocha_2',
              name: 'search_web',
              argumentsJson: '{"query":"Embezzle 2026 second"}',
            },
          ],
        }),
      }
    );
    // Bocha 第 2 次返回 2 条
    server.enqueue(
      { method: 'POST', pathname: /\/v1\/web-search|\/search/ },
      {
        kind: 'json',
        body: buildBochaSearchJson([
          { title: 'Hit 3', url: 'https://bocha.example.com/3', snippet: '摘要 3' },
          { title: 'Hit 4', url: 'https://bocha.example.com/4', snippet: '摘要 4' },
        ]),
      }
    );
    // 第 3 轮无 tools 收尾输出
    server.enqueue(
      { method: 'POST', pathname: '/v1/chat/completions' },
      {
        kind: 'sse',
        chunks: buildOpenAiChatSseChunks({
          model: 'gpt-5.4',
          reasoningDeltas: ['综合 4 条结果得出答案。'],
          textDeltas: ['结论引用 [1](1:s1) 与 [3](3:s3)。'],
        }),
      }
    );

    const provider = harness.session
      .getSnapshot()
      .providers.find((p) => p.id === 'openai') as ProviderProfile;
    const convId = harness.session.getSnapshot().activeConversationId;
    const rig = createExecutionRig(() => harness.session.getSnapshot());
    const execution = new ChatRequestExecution(
      harness.productionAdapterRegistry,
      rig.orchestration,
      rig.host
    );

    const asstMsg: ChatMessage = {
      id: 'msg-t3-02',
      role: 'assistant',
      content: '',
      createdAt: harness.clock.now(),
      status: 'pending',
      providerId: provider.id,
      modelId: model54.id,
    };
    const lease = rig.orchestration.begin({ phase: 'provider-request', label: 't3-02' })!;
    const outcome = await execution.execute({
      assistantMessage: asstMsg,
      conversationId: convId,
      transcript: [
        { id: 'u-t3-02', role: 'user', content: '查最新双源资料', createdAt: harness.clock.now(), status: 'ready' },
      ],
      runtime: { provider, model: model54, modelId: model54.id, reasoningEffort: 'medium' },
      controller: lease.controller,
      usageEvent: createStartedProviderUsageEvent({
        id: 'usage-t3-02',
        kind: 'web-search',
        providerId: provider.id,
        modelId: model54.id,
        createdAt: harness.clock.now(),
        messageId: asstMsg.id,
      }),
      parameterSettings: defaultParameterSettings,
    });

    expect(outcome.status).toBe('success');
    // 严格走 /v1/chat/completions 共 3 次，不误锁 /v1/responses
    const chatReqs = server.getRequests({ method: 'POST', pathname: '/v1/chat/completions' });
    expect(chatReqs).toHaveLength(3);
    expect(server.getRequests({ pathname: '/v1/responses' })).toHaveLength(0);
    expect((chatReqs[2]?.jsonBody as { tools?: unknown }).tools).toBeUndefined();

    const readyPatch = rig.messagePatches.find((p) => p.patch.status === 'ready');
    expect(readyPatch?.patch.reasoningContent).toBeTruthy();
    expect(readyPatch?.patch.thinkingDurationMs).toBeGreaterThanOrEqual(0);
    expect(readyPatch?.patch.webSearchTriggered).toBe(true);
    expect(readyPatch?.patch.citations?.map((c) => `${c.index}:${c.id}`)).toEqual([
      '1:s1',
      '2:s2',
      '3:s3',
      '4:s4',
    ]);
    expect(rig.persistedUsageEvents.at(-1)?.providerRequestCount).toBeGreaterThanOrEqual(2);
    const completedTools = (readyPatch?.patch.toolActivity ?? []).filter((t) => t.status === 'completed');
    expect(completedTools.length).toBeGreaterThanOrEqual(2);

    // 负向边界：gpt-5.4-pro 在 externalSearch 模式下必须安全拒绝（不发 /v1/responses 错误工具请求）
    const proModel: ModelInfo = {
      id: 'gpt-5.4-pro',
      name: 'GPT-5.4 Pro',
      capabilities: ['text', 'reasoning'],
      source: 'preset',
    };
    const proAdapter = harness.productionAdapterRegistry.resolve(
      { provider, modelId: proModel.id, model: proModel },
      'chat'
    );
    await expect(
      proAdapter.run({
        provider,
        modelId: proModel.id,
        model: proModel,
        messages: [{ id: 'u-pro', role: 'user', content: 'test', createdAt: 1, status: 'ready' }],
        reasoningEffort: 'medium',
        parameterSettings: defaultParameterSettings,
        externalSearch: harness.session.getSnapshot().externalSearch,
      })
    ).rejects.toThrow(/Responses-only|search_web|暂不支持外部/);
  });

  it('[T3-03] F2×F5×F6: Gemini 文生图 thoughtSignature → 持久化 → 灯箱交互与保存 → 以此图继续编辑多轮改图', async () => {
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

    server.enqueue(
      { method: 'POST', pathname: '/v1beta/models/gemini-3.1-flash-image:generateContent' },
      {
        kind: 'json',
        body: buildGeminiGenerateContentJson({
          modelVersion: 'gemini-3.1-flash-image',
          textDeltas: ['初版构图已生成。'],
          inlineImages: [
            { mimeType: 'image/png', data: TINY_PNG_BASE64, thoughtSignature: 'gem_sig_1' },
          ],
        }),
      }
    );
    server.enqueue(
      { method: 'POST', pathname: '/v1beta/models/gemini-3.1-flash-image:generateContent' },
      {
        kind: 'json',
        body: buildGeminiGenerateContentJson({
          modelVersion: 'gemini-3.1-flash-image',
          textDeltas: ['改图完成。'],
          inlineImages: [
            { mimeType: 'image/png', data: TINY_PNG_BASE64, thoughtSignature: 'gem_sig_2' },
          ],
        }),
      }
    );

    const gemini = getDefaultProviderClone('gemini', 'AIzaSy-t3-03');
    const round1 = await imageGen.generateImages({
      provider: gemini,
      modelId: 'gemini-3.1-flash-image',
      prompt: '赛博朋克雪山日落',
      options: { aspectRatio: '16:9', resolution: '2k' },
    });

    expect(round1.attachments?.length).toBe(1);
    const firstAtt = round1.attachments![0];
    expect(firstAtt.uri).toMatch(/^embezzle-web-attachment:\/\//);

    const convId = harness.session.getSnapshot().activeConversationId;
    await harness.chatRuntime.execute({
      type: 'chat.append-messages',
      conversationId: convId,
      messages: [
        {
          id: 'msg-t3-03-img1',
          role: 'assistant',
          content: round1.content,
          createdAt: harness.clock.now(),
          status: 'ready',
          attachments: round1.attachments,
          providerContinuations: round1.providerContinuations,
        } as E2EChatMessage,
      ],
      now: harness.clock.now(),
    });
    await harness.flush();

    const stored = harness.persistence.getStoredSnapshot();
    const persistedMsg = stored?.conversations
      .find((c) => c.id === convId)
      ?.messages.find((m) => m.id === 'msg-t3-03-img1');
    expect(persistedMsg?.attachments?.[0]?.uri).toMatch(/^embezzle-web-attachment:\/\//);
    expect(persistedMsg?.attachments?.[0]?.base64 ?? null).toBeNull();

    // 渲染灯箱验证真实交互按钮与回调
    const onSave = vi.fn();
    const onEditWithImage = vi.fn();
    const onClose = vi.fn();
    const rendered = await renderCapturedLightbox(lightboxMod.ImageLightboxModal, {
      visible: true,
      attachment: firstAtt,
      onSave,
      onEditWithImage,
      onClose,
    });
    const pressables = rendered.nodes.filter(
      (n) =>
        (n.type === 'Pressable' || n.type === 'TouchableOpacity') &&
        typeof n.props.onPress === 'function' &&
        n.props.disabled !== true
    );
    const saveBtn = pressables.find((n) => /保存|下载|save|download/i.test(getInteractiveLabel(n)));
    const editBtn = pressables.find((n) => /继续编辑|编辑|edit/i.test(getInteractiveLabel(n)));
    const closeBtn = pressables.find((n) => /关闭|close|返回/i.test(getInteractiveLabel(n)));
    expect(saveBtn).toBeDefined();
    expect(editBtn).toBeDefined();
    expect(closeBtn).toBeDefined();

    await (saveBtn?.props.onPress as () => unknown)();
    await (editBtn?.props.onPress as () => unknown)();
    await (closeBtn?.props.onPress as () => unknown)();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onEditWithImage).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    const saveRes = await saveAttachmentToDevice(firstAtt);
    expect(saveRes.status).toBe('saved');
    expect(docStub.downloads.length).toBe(1);

    // 构造“以此图继续编辑”草稿（当前模型为纯文本 gemini-2.5-pro 时应推荐切至生图模型）
    const draftPatch = editDraft.buildEditWithImageDraft({
      attachment: firstAtt,
      prompt: '在天空增加极光',
      currentModelId: 'gemini-2.5-pro',
      availableModels: gemini.models,
    });
    expect(draftPatch.suggestedModelId).toBe('gemini-3.1-flash-image');
    await harness.chatRuntime.execute({
      type: 'draft.set',
      conversationId: convId,
      text: draftPatch.text,
      attachments: draftPatch.attachments,
      now: harness.clock.now() + 5,
    });

    // Round 2 多轮改图同时携带 thoughtSignature 与参考图 inlineData
    const round2 = await imageGen.generateImages({
      provider: gemini,
      modelId: draftPatch.suggestedModelId ?? 'gemini-3.1-flash-image',
      prompt: draftPatch.text,
      options: { aspectRatio: '16:9', referenceImages: draftPatch.attachments },
      continuationBlocks: round1.providerContinuations,
    });
    expect(round2.attachments?.length).toBe(1);

    const gemReqs = server.getRequests({
      pathname: '/v1beta/models/gemini-3.1-flash-image:generateContent',
    });
    expect(gemReqs).toHaveLength(2);
    const req2Str = JSON.stringify(gemReqs[1]?.jsonBody ?? {});
    expect(req2Str).toContain('gem_sig_1');
    expect(req2Str).toContain('inlineData');
  });

  it('[T3-04] F1×F4×F5: 中转站点 customHeaders/custom auth 过滤 + SearXNG 匿名搜索后切换 auto 降级生图', async () => {
    setE2EPlatformOs('web');
    const router = installMockFetchRouter(serverBaseUrl, { enableWebDevProxy: true });
    restoreCallbacks.push(() => router.restore());
    const harness = await createE2EWorkspaceHarness();
    restoreCallbacks.push(() => harness.dispose());

    const imageGen = await safeImportModule<ImageGenerationServiceContract>(
      'src/services/imageGeneration.ts',
      ['generateImages', 'resolveImageApiMode']
    );

    const relayProvider: E2EProviderProfile = {
      id: 'new-api-relay',
      name: 'New API 中转',
      kind: 'new-api-relay',
      baseUrl: 'https://your-relay.example.com/v1',
      apiKey: 'sk-relay-default-ignored',
      authHeaderMode: 'custom',
      imageApiMode: 'auto',
      customHeaders: [
        { key: 'X-Relay-Token', value: 'rel-abc', enabled: true },
        { key: 'X-Drop-Me', value: 'no', enabled: false },
        { key: 'Host', value: 'evil.test', enabled: true },
      ],
      capabilities: ['text', 'tool-calling', 'streaming', 'image-generation'],
      models: [
        { id: 'gpt-4.1', capabilities: ['text', 'tool-calling', 'streaming'], source: 'manual' },
        {
          id: 'gemini-3.1-flash-image',
          capabilities: ['image-generation'],
          task: 'image-generation',
          source: 'manual',
        },
      ],
    };

    expect(isRelayOrCustomProvider(relayProvider as unknown as ProviderProfile)).toBe(true);
    const resolvedHeaders = resolveProviderAuthHeaders(relayProvider as unknown as ProviderProfile);
    expect(resolvedHeaders['X-Relay-Token']).toBe('rel-abc');
    expect(resolvedHeaders['X-Drop-Me']).toBeUndefined();
    expect(resolvedHeaders.Host).toBeUndefined();
    expect(resolvedHeaders.Authorization).toBeUndefined();

    await harness.addAndSelectProvider(relayProvider, relayProvider.models[0]);
    await harness.setExternalSearch({
      enabled: true,
      maxResults: 3,
      maxToolRounds: 2,
      selectedServiceId: 'searx-t3-04',
      services: [
        {
          id: 'searx-t3-04',
          kind: 'searxng',
          name: 'SearXNG',
          endpoint: 'https://searx.example.com/search',
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
          toolCalls: [
            {
              index: 0,
              id: 'call_searx_1',
              name: 'search_web',
              argumentsJson: '{"query":"relay image prompt"}',
            },
          ],
        }),
      }
    );
    server.enqueue(
      { method: 'GET', pathname: '/search' },
      {
        kind: 'json',
        body: buildSearxngSearchJson('relay image prompt', [
          { title: 'Prompt Guide', url: 'https://searx.example.com/guide', snippet: 'Use warm tone' },
        ]),
      }
    );
    server.enqueue(
      { method: 'POST', pathname: '/v1/chat/completions' },
      {
        kind: 'sse',
        chunks: buildOpenAiChatSseChunks({
          model: 'gpt-4.1',
          textDeltas: ['参考 SearXNG 提示词 [1](1:s1)。'],
        }),
      }
    );
    server.enqueue(
      { method: 'POST', pathname: '/v1/images/generations' },
      {
        kind: 'json',
        body: buildOpenAiImageGenerationJson({ revisedPrompt: 'Warm tone artwork' }),
      }
    );

    const activeProvider = harness.session
      .getSnapshot()
      .providers.find((p) => p.id === 'new-api-relay') as ProviderProfile;
    const chatAdapter = harness.productionAdapterRegistry.resolve(
      { provider: activeProvider, modelId: 'gpt-4.1', model: relayProvider.models[0] },
      'chat'
    );
    const chatRes = await chatAdapter.run({
      provider: activeProvider,
      modelId: 'gpt-4.1',
      model: relayProvider.models[0],
      messages: [{ id: 'u1', role: 'user', content: '检索绘图建议', createdAt: 1, status: 'ready' }],
      reasoningEffort: 'medium',
      parameterSettings: defaultParameterSettings,
      externalSearch: harness.session.getSnapshot().externalSearch,
    });
    expect(chatRes.citations?.[0]?.url).toBe('https://searx.example.com/guide');

    const searxReq = server.getLastRequest({ method: 'GET', pathname: '/search' });
    expect(searxReq?.query.format).toBe('json');

    expect(imageGen.resolveImageApiMode(relayProvider, 'gemini-3.1-flash-image')).toBe('openai-images');
    const imgRes = await imageGen.generateImages({
      provider: relayProvider,
      modelId: 'gemini-3.1-flash-image',
      prompt: '根据检索结果绘制暖色调插画',
      options: { aspectRatio: '1:1' },
    });
    expect(imgRes.attachments?.length).toBe(1);
    expect(imgRes.attachments?.[0]?.uri).toMatch(/^embezzle-web-attachment:\/\//);

    const chatHttpReqs = server.getRequests({ method: 'POST', pathname: '/v1/chat/completions' });
    const imgHttpReq = server.getLastRequest({ method: 'POST', pathname: '/v1/images/generations' });
    for (const httpReq of [...chatHttpReqs, imgHttpReq]) {
      expect(httpReq).toBeDefined();
      expect(httpReq?.headers['x-relay-token']).toBe('rel-abc');
      expect(httpReq?.headers['x-drop-me']).toBeUndefined();
      expect(httpReq?.headers.authorization).toBeUndefined();
      expect(httpReq?.headers.host).not.toBe('evil.test');
    }
  });

  it('[T3-05] F1×F3×F7: xAI Grok web_search/x_search 对话 → /export 指令筛选与 Markdown/JSON 脱敏导出', async () => {
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

    const grokModel: ModelInfo = {
      id: 'grok-4.7',
      name: 'Grok 4.7',
      capabilities: ['text', 'reasoning', 'web-search', 'streaming'],
      source: 'preset',
    };
    const xaiKey = 'xai-secret-key-t3-05';
    await harness.addAndSelectProvider(getDefaultProviderClone('xai-grok', xaiKey), grokModel);
    await harness.setProviderWebSearch(true, 'medium');

    server.enqueue(
      { method: 'POST', pathname: '/v1/responses' },
      {
        kind: 'sse',
        chunks: buildXaiResponsesSseChunks({
          model: 'grok-4.7',
          webSearchQuery: 'xAI 2026',
          webSearchActionType: 'x_search_call',
          reasoningSummaryDeltas: ['检索 X 与网页实况'],
          encryptedReasoningContent: 'xai_encrypted_blob_secret_t3_05',
          textDeltas: ['Grok 综合回答。'],
          citations: [{ url: 'https://x.ai/blog/2026', title: 'xAI Blog' }],
        }),
      }
    );

    const xaiProvider = harness.session
      .getSnapshot()
      .providers.find((p) => p.id === 'xai-grok') as ProviderProfile;
    const adapter = harness.productionAdapterRegistry.resolve(
      { provider: xaiProvider, modelId: grokModel.id, model: grokModel },
      'chat'
    );
    const result = await adapter.run({
      provider: xaiProvider,
      modelId: grokModel.id,
      model: grokModel,
      messages: [{ id: 'u-xai', role: 'user', content: '查 xAI 最新动态', createdAt: 1, status: 'ready' }],
      reasoningEffort: 'medium',
      parameterSettings: defaultParameterSettings,
      webSearch: harness.session.getSnapshot().webSearch,
    });

    // 验证绝对不含废弃的 410 search_parameters，且含 web_search 与 x_search
    const grokReq = server.getLastRequest({ method: 'POST', pathname: '/v1/responses' });
    const grokBody = grokReq?.jsonBody as { search_parameters?: unknown; tools?: Array<{ type?: string }> };
    expect(grokBody.search_parameters).toBeUndefined();
    const toolTypes = (grokBody.tools ?? []).map((t) => t.type);
    expect(toolTypes).toContain('web_search');
    expect(toolTypes).toContain('x_search');

    const convId = harness.session.getSnapshot().activeConversationId;
    const taintedAssistant: E2EChatMessage & { apiKey?: string } = {
      id: 'asst-xai-t3-05',
      role: 'assistant',
      content: result.content,
      reasoningContent: result.reasoningContent,
      thinkingDurationMs: result.thinkingDurationMs,
      providerContinuations: result.providerContinuations,
      citations: result.citations,
      modelId: grokModel.id,
      providerId: xaiProvider.id,
      createdAt: 2,
      status: 'ready',
      apiKey: xaiKey,
    };
    await harness.chatRuntime.execute({
      type: 'chat.append-messages',
      conversationId: convId,
      messages: [
        { id: 'u-xai', role: 'user', content: '查 xAI 最新动态', createdAt: 1, status: 'ready' },
        taintedAssistant,
      ],
      now: 3,
    });

    // 校验 /exp 指令与导出脱敏
    expect(slash.shouldOpenSlashCommandMenu('/exp')).toBe(true);
    const matches = slash.filterSlashCommands('/exp');
    const exportCmd = matches.find((item) => item.command.includes('export'));
    expect(exportCmd).toBeDefined();
    const selection = slash.resolveSlashCommandSelection(exportCmd!, '/exp');
    expect(selection.kind).toBe('builtin');

    const conv = harness.session.getSnapshot().conversations.find((c) => c.id === convId)!;
    const md = exportService.exportConversationToMarkdown(conv);
    expect(md).toContain('grok-4.7');
    expect(md).toMatch(/<details>|深度思考|思考过程/);
    expect(md).toContain('https://x.ai/blog/2026');
    expect(md).not.toContain(xaiKey);
    expect(md).not.toContain('xai_encrypted_blob_secret_t3_05');

    const jsonStr = exportService.exportConversationToJson(conv);
    const parsedJson = JSON.parse(jsonStr) as { messages?: unknown[] };
    expect(parsedJson.messages?.length).toBeGreaterThanOrEqual(2);
    expect(jsonStr).not.toContain(xaiKey);
    expect(jsonStr).not.toContain('xai_encrypted_blob_secret_t3_05');

    expect(exportService.sanitizeExportFilename('xAI:/\\CON*?.md', 'md')).not.toMatch(/[/\\:*?]/);
    vi.useFakeTimers();
    const exported = await exportService.exportConversation({ conversation: conv, format: 'markdown' });
    expect(exported.filename).toMatch(/\.md$/);
    await vi.advanceTimersByTimeAsync(1500);
    expect(domStub.revokedUrls).toHaveLength(1);
  });

  it('[T3-06] F7×F10: Web 快捷键/IME/斜杠模板替换与流式草稿隔离（220 chunks 零全局广播与防误提交）', async () => {
    setE2EPlatformOs('web');
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
    expect(
      typeof draftHook,
      '缺少流式草稿隔离选择器（useStreamingDraftSelector / useStreamingMessageDraft）'
    ).toBe('function');

    type DraftPublishFn = (
      conversationId: string,
      messageId: string,
      patch: { content?: string; reasoningContent?: string; status?: string }
    ) => void;
    type DraftStoreLike = {
      set?: DraftPublishFn;
      update?: DraftPublishFn;
      publish?: DraftPublishFn;
      setDraft?: DraftPublishFn;
    };

    const resolveDraftChannel = (candidates: Array<Record<string, unknown>>): DraftPublishFn | null => {
      for (const obj of candidates) {
        for (const key of [
          'setStreamingDraft',
          'updateStreamingDraft',
          'publishStreamingDraft',
          'setStreamingMessageDraft',
        ]) {
          if (typeof obj[key] === 'function') {
            return obj[key] as DraftPublishFn;
          }
        }
        const store = obj.streamingDraftStore as DraftStoreLike | undefined;
        if (store && typeof store === 'object') {
          const fn = store.set ?? store.update ?? store.publish ?? store.setDraft;
          if (typeof fn === 'function') {
            return fn.bind(store);
          }
        }
      }
      return null;
    };

    const harness = await createE2EWorkspaceHarness();
    restoreCallbacks.push(() => harness.dispose());
    const publishDraft = resolveDraftChannel([
      runtimeMod,
      providerMod,
      harness.chatRuntime as unknown as Record<string, unknown>,
    ]);
    expect(publishDraft, '缺少流式草稿写入通道 API').not.toBeNull();

    // 1) IME 与 Shift+Enter 校验
    expect(
      shortcuts.resolveComposerKeyAction({
        platformOs: 'web',
        key: 'Enter',
        isComposing: true,
        text: 'daima',
      })
    ).toBe('ignore');
    expect(
      shortcuts.resolveComposerKeyAction({
        platformOs: 'web',
        key: 'Enter',
        keyCode: 229,
        text: '代码',
      })
    ).toBe('ignore');
    expect(
      shortcuts.resolveComposerKeyAction({
        platformOs: 'web',
        key: 'Enter',
        shiftKey: true,
        text: '第一行',
      })
    ).toBe('newline');

    // 2) 斜杠模板替换写入草稿
    const templates = createPromptTemplate(
      [],
      { name: '代码审查', content: '请审查以下模块：\n{{code}}', mode: 'composer' },
      { id: 'tpl-t3-06', now: harness.clock.now() }
    );
    const tplMatch = slash
      .filterSlashCommands('/代码', { promptTemplates: templates })
      .find((item) => item.kind === 'template');
    expect(tplMatch).toBeDefined();
    const tplSel = slash.resolveSlashCommandSelection(tplMatch!, '/代码');
    expect(tplSel.nextText).toContain('请审查以下模块');

    const convId = harness.session.getSnapshot().activeConversationId;
    await harness.chatRuntime.execute({
      type: 'draft.set',
      conversationId: convId,
      text: tplSel.nextText ?? '',
      now: harness.clock.now(),
    });

    // 3) 非组词 Enter 触发提交并自动清空 composerDrafts
    expect(
      shortcuts.resolveComposerKeyAction({
        platformOs: 'web',
        key: 'Enter',
        isComposing: false,
        text: tplSel.nextText ?? '',
      })
    ).toBe('submit');

    const asstMsgId = 'msg-t3-06-stream';
    await harness.chatRuntime.execute({
      type: 'chat.append-messages',
      conversationId: convId,
      messages: [
        { id: 'u-t3-06', role: 'user', content: tplSel.nextText ?? '', createdAt: 10, status: 'ready' },
        { id: asstMsgId, role: 'assistant', content: '', createdAt: 11, status: 'pending' },
      ],
      now: 12,
    });
    await harness.flush();

    // 4) 220 chunks 流式期间零全局广播、零持久化落盘、且按 Enter 被拦截
    let sessionEmitCount = 0;
    const unsub = harness.session.subscribe(() => {
      sessionEmitCount += 1;
    });
    restoreCallbacks.push(unsub);
    const saveSpy = vi.spyOn(harness.persistence, 'save');
    restoreCallbacks.push(() => saveSpy.mockRestore());

    let accumulated = '';
    for (const delta of generateHighFrequencyTextDeltas(220, '段')) {
      accumulated += delta;
      publishDraft!(convId, asstMsgId, { content: accumulated, status: 'pending' });
    }
    expect(sessionEmitCount).toBe(0);
    expect(saveSpy.mock.calls.length).toBe(0);

    expect(
      shortcuts.resolveComposerKeyAction({
        platformOs: 'web',
        key: 'Enter',
        text: '流式期间误按回车',
        isStreaming: true,
      })
    ).toBe('ignore');

    // 5) 终态落盘并验证草稿已清空
    await harness.chatRuntime.execute({
      type: 'message.update',
      conversationId: convId,
      messageId: asstMsgId,
      patch: { content: accumulated, status: 'ready' },
      now: 20,
    });
    await harness.flush();
    expect(saveSpy.mock.calls.length).toBe(1);
    const stored = harness.persistence.getStoredSnapshot();
    expect(stored?.composerDrafts.some((d) => d.conversationId === convId)).toBe(false);
  });

  it('[T3-07] F2×F8: 并发会话隔离（中止会话 A 冻结计时 vs 会话 B 完整落盘 Thinking 与加密续接态）', async () => {
    const harness = await createE2EWorkspaceHarness();
    restoreCallbacks.push(() => harness.dispose());

    const claude = getDefaultProviderClone('anthropic', 'sk-ant-t3-07');
    const openai = getDefaultProviderClone('openai', 'sk-openai-t3-07');
    await harness.addAndSelectProvider(claude, claude.models[0]);
    await harness.addAndSelectProvider(openai, openai.models[0]);

    const convA = 'conv-t3-07-a';
    const convB = 'conv-t3-07-b';
    const msgAId = 'asst-t3-07-a';
    const msgBId = 'asst-t3-07-b';

    await harness.chatRuntime.execute({
      type: 'conversation.set-messages',
      conversationId: convA,
      activate: false,
      now: 100,
      messages: [
        { id: 'u-a', role: 'user', content: 'A 请求', createdAt: 100, status: 'ready' },
        { id: msgAId, role: 'assistant', content: '', createdAt: 101, status: 'pending' },
      ],
    });
    await harness.chatRuntime.execute({
      type: 'conversation.set-messages',
      conversationId: convB,
      activate: false,
      now: 102,
      messages: [
        { id: 'u-b', role: 'user', content: 'B 请求', createdAt: 102, status: 'ready' },
        { id: msgBId, role: 'assistant', content: '', createdAt: 103, status: 'pending' },
      ],
    });

    const releaseGate: { fn: (() => void) | null } = { fn: null };
    const bGate = new Promise<void>((resolve) => {
      releaseGate.fn = resolve;
    });

    const adapterA: ProviderAdapter = {
      run: (req) =>
        new Promise((_resolve, reject) => {
          req.onStreamUpdate?.({
            content: '会话A半截回答',
            reasoningContent: '会话A运行中思考',
            activityTimeline: [
              {
                kind: 'thinking',
                id: 'think-a',
                status: 'running',
                title: '思考中',
                content: '会话A运行中思考',
                startedAt: 1000,
                sequence: 0,
              },
            ],
          });
          req.signal?.addEventListener(
            'abort',
            () => {
              const err = new Error('Aborted A');
              err.name = 'AbortError';
              reject(err);
            },
            { once: true }
          );
        }),
      queryTask: async () => ({ content: '', raw: undefined }),
    };

    const adapterB: ProviderAdapter = {
      run: async (req) => {
        req.onStreamUpdate?.({ content: '会话B流式前缀-', reasoningContent: '会话B深度思考' });
        await bGate;
        return {
          content: '会话B流式前缀-完整答案',
          reasoningContent: '会话B深度思考',
          thinkingDurationMs: 640,
          providerContinuations: [
            {
              provider: 'openai',
              type: 'reasoning_encrypted',
              itemId: 'rs_b_1',
              encryptedContent: 'enc_b_t3_07',
            },
          ],
          raw: undefined,
        };
      },
      queryTask: async () => ({ content: '', raw: undefined }),
    };

    const rigA = createExecutionRig(() => harness.session.getSnapshot(), { streamUpdateDelayMs: 0 });
    const rigB = createExecutionRig(() => harness.session.getSnapshot(), { streamUpdateDelayMs: 0 });
    const leaseA = rigA.orchestration.begin({ phase: 'provider-request', label: 'A' })!;
    const leaseB = rigB.orchestration.begin({ phase: 'provider-request', label: 'B' })!;

    const execA = new ChatRequestExecution(
      { resolve: () => adapterA } as ProviderAdapterRegistry,
      rigA.orchestration,
      rigA.host
    );
    const execB = new ChatRequestExecution(
      { resolve: () => adapterB } as ProviderAdapterRegistry,
      rigB.orchestration,
      rigB.host
    );

    const pA = execA.execute({
      assistantMessage: { id: msgAId, role: 'assistant', content: '', createdAt: 101, status: 'pending' },
      conversationId: convA,
      transcript: [{ id: 'u-a', role: 'user', content: 'A 请求', createdAt: 100, status: 'ready' }],
      runtime: { provider: claude as unknown as ProviderProfile, model: claude.models[0], modelId: claude.models[0].id, reasoningEffort: 'high' },
      controller: leaseA.controller,
      usageEvent: createStartedProviderUsageEvent({
        id: 'usage-a',
        kind: 'chat',
        providerId: claude.id,
        modelId: claude.models[0].id,
        createdAt: 100,
        messageId: msgAId,
      }),
      parameterSettings: defaultParameterSettings,
    });
    const pB = execB.execute({
      assistantMessage: { id: msgBId, role: 'assistant', content: '', createdAt: 103, status: 'pending' },
      conversationId: convB,
      transcript: [{ id: 'u-b', role: 'user', content: 'B 请求', createdAt: 102, status: 'ready' }],
      runtime: { provider: openai as unknown as ProviderProfile, model: openai.models[0], modelId: openai.models[0].id, reasoningEffort: 'high' },
      controller: leaseB.controller,
      usageEvent: createStartedProviderUsageEvent({
        id: 'usage-b',
        kind: 'chat',
        providerId: openai.id,
        modelId: openai.models[0].id,
        createdAt: 102,
        messageId: msgBId,
      }),
      parameterSettings: defaultParameterSettings,
    });

    await Promise.resolve();
    leaseA.controller.abort();
    const outA = await pA;
    expect(outA.status).toBe('cancelled');

    const cancelledPatchA = rigA.messagePatches.find((p) => p.patch.status === 'cancelled');
    expect(cancelledPatchA?.patch.content).toContain('会话A半截回答');
    expect(cancelledPatchA?.patch.activityTimeline?.[0]?.status).toBe('completed');
    const frozenTimeline = finalizeActivityTimelineForTerminalMessage(
      cancelledPatchA?.patch.activityTimeline ?? [
        { kind: 'thinking', id: 'think-a', status: 'running', title: '思考中', content: 'x', startedAt: 1000, sequence: 0 },
      ],
      { messageStatus: 'cancelled', finishedAt: 2500 }
    );
    expect(frozenTimeline).toBeDefined();
    expect(frozenTimeline?.[0]?.status).toBe('completed');
    expect(frozenTimeline?.[0]?.finishedAt).toBeGreaterThanOrEqual(1000);

    releaseGate.fn?.();
    const outB = await pB;
    expect(outB.status).toBe('success');

    const readyPatchB = rigB.messagePatches.find((p) => p.patch.status === 'ready');
    expect(readyPatchB?.patch.content).toBe('会话B流式前缀-完整答案');
    expect((readyPatchB?.patch as E2EChatMessage | undefined)?.thinkingDurationMs).toBe(640);
    expect((readyPatchB?.patch as E2EChatMessage | undefined)?.providerContinuations?.[0]).toMatchObject({
      provider: 'openai',
      encryptedContent: 'enc_b_t3_07',
    });

    await harness.chatRuntime.execute({
      type: 'message.update',
      conversationId: convA,
      messageId: msgAId,
      patch: { ...cancelledPatchA?.patch, activityTimeline: frozenTimeline },
      now: 2500,
    });
    await harness.chatRuntime.execute({
      type: 'message.update',
      conversationId: convB,
      messageId: msgBId,
      patch: readyPatchB?.patch ?? {},
      now: 2600,
    });
    await harness.flush();

    const stored = harness.persistence.getStoredSnapshot();
    const storedA = stored?.conversations.find((c) => c.id === convA)?.messages.find((m) => m.id === msgAId);
    const storedB = stored?.conversations.find((c) => c.id === convB)?.messages.find((m) => m.id === msgBId);
    expect(storedA?.status).toBe('cancelled');
    expect(storedB?.status).toBe('ready');
    expect((storedB as E2EChatMessage | undefined)?.providerContinuations?.length).toBe(1);
  });

  it('[T3-08] F6×F7: 代码高亮/LaTeX/内联引用 [1] 防污染与 Markdown/JSON 导出 XSS/四反引号升阶兼容', async () => {
    const markdownMod = await safeImportModule<MessageMarkdownRichContract>(
      'src/ui/components/MessageMarkdown.tsx',
      ['MessageMarkdown', 'parseMarkdownBlocks', 'parseInlineRichSegments', 'highlightCodeTokens']
    );
    const exportService = await safeImportModule<ConversationExportContract>(
      'src/services/conversationExport.ts',
      ['exportConversationToMarkdown', 'exportConversationToJson']
    );

    const codeSource = 'const price = "$100";\nconst arr = items[1];\nreturn price + arr;';
    const richBody = [
      '能量公式 $E=mc^2$ 与价格 $19.99，引用 [1] 有效，越界 [99] 退化文本。',
      '',
      '$$\\int e^{-x^2}dx$$',
      '',
      `\`\`\`typescript\n${codeSource}\n\`\`\``,
    ].join('\n');

    const citations = [
      { index: 1, id: 'c1', title: 'Physics Ref', url: 'https://physics.example.org/relativity' },
    ];

    const blocks = markdownMod.parseMarkdownBlocks(richBody);
    const codeBlock = blocks.find((b) => b.kind === 'code');
    expect(codeBlock?.language).toBe('typescript');
    expect(codeBlock?.text).toBe(codeSource);
    const latexBlock = blocks.find((b) => b.kind === 'latex' && b.display === true);
    expect(latexBlock?.text).toContain('\\int e^{-x^2}dx');

    const tokens = markdownMod.highlightCodeTokens(codeSource, 'typescript');
    expect(tokens.map((t) => t.text).join('')).toBe(codeSource);
    expect(new Set(tokens.map((t) => t.tokenType)).size).toBeGreaterThanOrEqual(3);
    // 代码块内部字符串 `$100` 与 `[1]` 保留在 code token 中，不分裂成 latex/citation
    expect(tokens.some((t) => t.tokenType === 'latex' || t.tokenType === 'citation')).toBe(false);

    const inlineSegments = markdownMod.parseInlineRichSegments(
      '能量公式 $E=mc^2$ 与价格 $19.99，引用 [1] 有效，越界 [99] 退化文本。',
      citations
    );
    expect(inlineSegments.some((s) => s.kind === 'latex' && s.text.includes('E=mc^2'))).toBe(true);
    expect(inlineSegments.some((s) => s.kind === 'latex' && s.text.includes('19.99'))).toBe(false);
    expect(inlineSegments.some((s) => s.kind === 'citation' && s.index === 1)).toBe(true);
    expect(inlineSegments.some((s) => s.kind === 'citation' && s.index === 99)).toBe(false);

    const conv: ChatConversation = {
      id: 'conv-t3-08',
      title: '富媒体与 <script>alert(1)</script> 导出',
      createdAt: 1000,
      updatedAt: 2000,
      messages: [
        {
          id: 'm-rich-1',
          role: 'assistant',
          content: `${richBody}\n\n\`\`\`\`markdown\n# nested\n<script>alert(1)</script>\n\`\`\`\``,
          reasoningContent: '</details><script>alert(2)</script>',
          citations,
          createdAt: 1500,
          status: 'ready',
        },
      ],
    };

    const md = exportService.exportConversationToMarkdown(conv);
    expect(md).not.toMatch(/<script[\s>]/i);
    expect(md).toMatch(/`{5,}/);
    expect(md).toContain('https://physics.example.org/relativity');
    expect(md).toContain('E=mc^2');
    const jsonParsed = JSON.parse(exportService.exportConversationToJson(conv)) as { messages: unknown[] };
    expect(jsonParsed.messages).toHaveLength(1);
  });

  it('[T3-09] F2×F8: Thinking 与加密续接态对话 Fork、跨项目移动、删除父分支存活及全局搜索（零凭据泄露）', async () => {
    const router = installMockFetchRouter(serverBaseUrl);
    restoreCallbacks.push(() => router.restore());
    const harness = await createE2EWorkspaceHarness();
    restoreCallbacks.push(() => harness.dispose());

    const claude = getDefaultProviderClone('anthropic', 'sk-ant-secret-t3-09');
    await harness.addAndSelectProvider(claude, claude.models[0]);

    const projectsRuntime = new ProjectsConversationsRuntime({
      commit: harness.session.bindCommitPort(createProjectsCommitReducer()),
      now: () => harness.clock.now(),
      createId: (prefix) => harness.ids.createId(prefix),
      isHistoryLocked: () => false,
    });

    await projectsRuntime.execute({ type: 'project.create', input: { name: '量子项目 A' } });
    const projA = harness.session.getSnapshot().activeProjectId;
    await projectsRuntime.execute({ type: 'project.create', input: { name: '归档项目 B' } });
    const projB = harness.session.getSnapshot().activeProjectId;

    await projectsRuntime.execute({ type: 'conversation.start', projectId: projA });
    const parentConvId = harness.session.getSnapshot().activeConversationId;
    const msgUser1: ChatMessage = {
      id: 'm-u-t3-09',
      role: 'user',
      content: '解释量子纠缠',
      createdAt: 100,
      status: 'ready',
    };
    const msgAsst1: E2EChatMessage = {
      id: 'm-a-t3-09',
      role: 'assistant',
      content: '量子纠缠是非定域关联。',
      reasoningContent: '全息隐态推演关键帧',
      thinkingDurationMs: 1400,
      providerContinuations: [
        {
          provider: 'anthropic',
          type: 'thinking',
          thinking: '全息隐态推演关键帧',
          signature: 'sig_fork_survive_t3_09',
        },
      ],
      createdAt: 110,
      status: 'ready',
    };
    const msgAsstTail: ChatMessage = {
      id: 'm-a-tail-t3-09',
      role: 'assistant',
      content: '分叉后的尾巴',
      createdAt: 120,
      status: 'ready',
    };

    await harness.chatRuntime.execute({
      type: 'conversation.set-messages',
      conversationId: parentConvId,
      projectId: projA,
      now: 130,
      messages: [msgUser1, msgAsst1, msgAsstTail],
    });

    // 在 msgAsstTail 处 fork（保留包含 msgAsst1 的前缀历史）
    const forkRes = await projectsRuntime.execute({
      type: 'conversation.fork',
      conversationId: parentConvId,
      messageId: msgAsstTail.id,
    });
    expect(forkRes.ok).toBe(true);
    const forkConvId = harness.session.getSnapshot().activeConversationId;

    // 移动父对话到项目 B 并删除父对话
    await projectsRuntime.execute({
      type: 'conversation.move',
      conversationId: parentConvId,
      projectId: projB,
    });
    const delRes = await projectsRuntime.execute({
      type: 'conversation.delete',
      conversationId: parentConvId,
    });
    expect(delRes.ok).toBe(true);
    await harness.flush();

    const forkConv = harness.session.getSnapshot().conversations.find((c) => c.id === forkConvId);
    expect(forkConv).toBeDefined();
    expect(forkConv?.parentConversationId).toBeUndefined();
    const forkedAsst = forkConv?.messages.find(
      (m) => m.originMessageId === msgAsst1.id || m.id === msgAsst1.id
    ) as E2EChatMessage | undefined;
    expect(forkedAsst?.thinkingDurationMs).toBe(1400);
    expect(forkedAsst?.providerContinuations?.[0]).toMatchObject({
      signature: 'sig_fork_survive_t3_09',
    });

    // 基于存活子分支发起下一轮请求，验证仍无损回传历史 signature
    server.enqueue(
      { method: 'POST', pathname: '/v1/messages' },
      {
        kind: 'sse',
        chunks: buildAnthropicMessagesSseChunks({ textDeltas: ['分支续接成功'] }),
      }
    );
    const antProvider = harness.session
      .getSnapshot()
      .providers.find((p) => p.id === 'anthropic') as ProviderProfile;
    const antAdapter = harness.productionAdapterRegistry.resolve(
      { provider: antProvider, modelId: claude.models[0].id, model: claude.models[0] },
      'chat'
    );
    await antAdapter.run({
      provider: antProvider,
      modelId: claude.models[0].id,
      model: claude.models[0],
      messages: [
        ...(forkConv?.messages.slice(0, 2) ?? []),
        { id: 'u-fork-next', role: 'user', content: '继续分支', createdAt: 200, status: 'ready' },
      ],
      reasoningEffort: 'high',
      parameterSettings: defaultParameterSettings,
    });
    const antReq = server.getLastRequest({ pathname: '/v1/messages' });
    expect(JSON.stringify(antReq?.jsonBody)).toContain('sig_fork_survive_t3_09');

    // 全局搜索命中子分支 reasoning，且绝不泄露 API Key
    const snapshot = harness.session.getSnapshot();
    const index = buildWorkspaceSearchIndex(snapshot);
    const hits = searchWorkspaceIndex(index, '全息隐态推演');
    expect(hits.some((h) => h.conversationId === forkConvId && h.matchedField === 'reasoning')).toBe(true);
    expect(searchWorkspace(snapshot, 'sk-ant-secret-t3-09')).toEqual([]);
    expect(JSON.stringify(index)).not.toContain('sk-ant-secret-t3-09');
  });

  it('[T3-10] F8×F10: 并发 FIFO 费用/MCP 审批 + SettingsPane 按需卸载与流式 Abort 清除 timer 防死锁', async () => {
    const harness = await createE2EWorkspaceHarness();
    restoreCallbacks.push(() => harness.dispose());

    // 1) 验证 SettingsPane 按需卸载与 ProjectDrawerShell 手势 .onFinalize（暴露 M2 未合入项，绝不跳过）
    const settingsSrc = fs.readFileSync(
      path.resolve(REPO_ROOT, 'src/features/settings/SettingsPane.tsx'),
      'utf8'
    );
    const settingsSf = ts.createSourceFile(
      'SettingsPane.tsx',
      settingsSrc,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const settingsHasLegacyHidden =
      /\bhasMounted\b/.test(settingsSf.getText()) ||
      /display\s*:\s*['"]none['"]/.test(settingsSf.getText());
    expect(
      settingsHasLegacyHidden,
      'SettingsPane.tsx 仍保留 display:none/hasMounted 常驻隐藏逻辑，关闭后须按需卸载'
    ).toBe(false);

    // 2) 并发 FIFO 费用与 MCP 审批（未改 FIFO 时 fail-loud 暴露）
    const pCost1 = harness.decisionQueue.requestCostConfirmation('超额确认 #1');
    const pCost2 = harness.decisionQueue.requestCostConfirmation('超额确认 #2');
    expect(harness.decisionQueue.getSnapshot().costConfirmationReason).toBe('超额确认 #1');

    harness.decisionQueue.resolveCostConfirmation(true);
    await expect(raceWithTimeout(pCost1, 'cost1')).resolves.toBe(true);
    // FIFO 下第 2 个请求应自动顶上
    expect(harness.decisionQueue.getSnapshot().costConfirmationReason).toBe('超额确认 #2');
    harness.decisionQueue.resolveCostConfirmation(false);
    await expect(raceWithTimeout(pCost2, 'cost2')).resolves.toBe(false);

    const req1 = makeMcpApprovalRequest('mcp-t3-10-1', 'read_file');
    const req2 = makeMcpApprovalRequest('mcp-t3-10-2', 'write_file');
    const pMcp1 = harness.decisionQueue.requestMcpApproval(req1, {
      providerName: 'OpenAI',
      modelId: 'gpt-5',
      serverName: 'Docs',
      endpoint: 'https://mcp.example.com/sse',
    });
    const pMcp2 = harness.decisionQueue.requestMcpApproval(req2, {
      providerName: 'OpenAI',
      modelId: 'gpt-5',
      serverName: 'Docs',
      endpoint: 'https://mcp.example.com/sse',
    });

    const snap1 = harness.decisionQueue.getSnapshot().mcpApprovalView;
    expect(snap1?.approvalRequestId).toBe('mcp-t3-10-1');
    // 错 nonce 不可结算
    harness.decisionQueue.resolveMcpApproval(
      { approvalRequestId: snap1!.approvalRequestId, nonce: snap1!.approvalNonce + 7 },
      'approve'
    );
    expect(harness.decisionQueue.getSnapshot().mcpApprovalView?.approvalRequestId).toBe('mcp-t3-10-1');
    harness.decisionQueue.resolveMcpApproval(
      { approvalRequestId: snap1!.approvalRequestId, nonce: snap1!.approvalNonce },
      'approve'
    );
    await expect(raceWithTimeout(pMcp1, 'mcp1')).resolves.toBe('approve');
    expect(harness.decisionQueue.getSnapshot().mcpApprovalView?.approvalRequestId).toBe('mcp-t3-10-2');

    // 3) 250 chunks 流式期间同时 Abort + cancelAll，验证无死锁且清除 streamTimer
    const openai = getDefaultProviderClone('openai', 'sk-openai-t3-10');
    await harness.addAndSelectProvider(openai, openai.models[0]);
    const rig = createExecutionRig(() => harness.session.getSnapshot(), { streamUpdateDelayMs: 60 });
    const lease = rig.orchestration.begin({ phase: 'provider-request', label: 't3-10-stream' })!;
    const msgId = 'msg-t3-10-abort';

    const slowAdapter: ProviderAdapter = {
      run: (req) =>
        new Promise((_resolve, reject) => {
          let acc = '';
          for (const d of generateHighFrequencyTextDeltas(250, 'w')) {
            acc += d;
          }
          req.onStreamUpdate?.({ content: acc });
          req.signal?.addEventListener(
            'abort',
            () => {
              const e = new Error('aborted');
              e.name = 'AbortError';
              reject(e);
            },
            { once: true }
          );
        }),
      queryTask: async () => ({ content: '', raw: undefined }),
    };

    const exec = new ChatRequestExecution(
      { resolve: () => slowAdapter } as ProviderAdapterRegistry,
      rig.orchestration,
      rig.host
    );
    const execPromise = exec.execute({
      assistantMessage: { id: msgId, role: 'assistant', content: '', createdAt: 1, status: 'pending' },
      conversationId: harness.session.getSnapshot().activeConversationId,
      transcript: [{ id: 'u-1', role: 'user', content: '高频流', createdAt: 0, status: 'ready' }],
      runtime: { provider: openai as unknown as ProviderProfile, model: openai.models[0], modelId: openai.models[0].id, reasoningEffort: 'low' },
      controller: lease.controller,
      usageEvent: createStartedProviderUsageEvent({
        id: 'usage-t3-10',
        kind: 'chat',
        providerId: openai.id,
        modelId: openai.models[0].id,
        createdAt: 1,
        messageId: msgId,
      }),
      parameterSettings: defaultParameterSettings,
    });

    await Promise.resolve();
    lease.controller.abort();
    harness.decisionQueue.cancelAll();

    await expect(raceWithTimeout(pMcp2, 'mcp2 cancelAll', 400)).resolves.toBe('cancel');
    const outcome = await raceWithTimeout(execPromise, 'exec abort', 400);
    expect(outcome.status).toBe('cancelled');

    const countAtCancel = rig.messagePatches.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(rig.messagePatches.length).toBe(countAtCancel);
    expect(rig.messagePatches.at(-1)?.patch.status).toBe('cancelled');
  });

  it('[T3-11] F4×F9: 外部搜索危险链接安全过滤 + dialogService 单队列调度 + 窄屏 elementFromPoint 透明遮罩检测', async () => {
    // 1) 外部搜索危险链接安全过滤
    expect(resolveMessageMarkdownLink('https://docs.example.com/guide')).toBe(
      'https://docs.example.com/guide'
    );
    expect(resolveMessageMarkdownLink('javascript:alert(1)')).toBeNull();
    expect(resolveMessageMarkdownLink('http://127.0.0.1:8080/admin')).toBeNull();
    expect(resolveMessageMarkdownLink('file:///etc/passwd')).toBeNull();

    // 2) dialogService 单队列调度与统一 Modal 队列契约校验
    const dialogSrc = fs.readFileSync(
      path.resolve(REPO_ROOT, 'src/ui/components/dialogService.ts'),
      'utf8'
    );
    expect(
      /\b(?:showModalSheet|requestModalSheet|showConfirmDialog|enqueueModalSheet|presentModalSheet)\b/.test(
        dialogSrc
      ),
      'dialogService.ts 须导出统一 Modal 队列入口（如 showModalSheet / showConfirmDialog）'
    ).toBe(true);

    let activeDialog: DialogRequest | null = null;
    bindAppDialogHost((req) => {
      activeDialog = req;
    });
    const confirmP = requestConfirm({ title: '确认 1', description: 'desc' });
    const noticeP = requestNotice({ title: '通知 2', description: 'desc' });
    expect(activeDialog).not.toBeNull();
    expect((activeDialog as DialogRequest | null)?.title).toBe('确认 1');

    // Host 中途卸载：未决 Promise 必须全部 fail-closed 结算
    bindAppDialogHost(null);
    await expect(confirmP).resolves.toBe(false);
    await expect(noticeP).resolves.toBeUndefined();

    // 3) 窄屏 390x844 DOM 透明全屏遮罩（opacity: 1, backgroundColor: rgba(...,0.35)）检测与穿透解除
    const vp = { width: 390, height: 844 };
    const makeEl = (
      tagName: string,
      attrs: Record<string, string>,
      rect: { left: number; top: number; width: number; height: number },
      style: Record<string, string>
    ) => {
      const domRect = {
        ...rect,
        x: rect.left,
        y: rect.top,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height,
        toJSON: () => rect,
      };
      const node = {
        tagName: tagName.toUpperCase(),
        attrs,
        style,
        rect: domRect,
        getAttribute: (name: string) => attrs[name] ?? null,
        getBoundingClientRect: () => domRect,
        contains: (other: unknown) => other === node,
      };
      return node;
    };

    const scrim = makeEl(
      'div',
      { 'aria-label': '关闭搜索菜单遮罩' },
      { left: 0, top: 0, width: vp.width, height: vp.height },
      {
        display: 'flex',
        visibility: 'visible',
        opacity: '1',
        pointerEvents: 'auto',
        position: 'fixed',
        zIndex: '40',
        backgroundColor: 'rgba(0, 0, 0, 0.35)',
      }
    );
    const elements = [
      makeEl('div', { 'data-testid': 'drawer-trigger' }, { left: 12, top: 8, width: 36, height: 36 }, { display: 'flex', visibility: 'visible', opacity: '1', pointerEvents: 'auto', position: 'relative', zIndex: '1' }),
      makeEl('div', { 'data-testid': 'model-picker-trigger' }, { left: 60, top: 8, width: 140, height: 36 }, { display: 'flex', visibility: 'visible', opacity: '1', pointerEvents: 'auto', position: 'relative', zIndex: '1' }),
      makeEl('div', { 'data-testid': 'settings-trigger' }, { left: 342, top: 8, width: 36, height: 36 }, { display: 'flex', visibility: 'visible', opacity: '1', pointerEvents: 'auto', position: 'relative', zIndex: '1' }),
      makeEl('textarea', { 'data-testid': 'composer-input' }, { left: 56, top: 724, width: 270, height: 48 }, { display: 'flex', visibility: 'visible', opacity: '1', pointerEvents: 'auto', position: 'relative', zIndex: '1' }),
      makeEl('div', { 'data-testid': 'composer-send-button' }, { left: 338, top: 728, width: 38, height: 38 }, { display: 'flex', visibility: 'visible', opacity: '1', pointerEvents: 'auto', position: 'relative', zIndex: '1' }),
      scrim,
    ];

    const matchSel = (el: (typeof elements)[number], sel: string): boolean => {
      const m = /\[([a-zA-Z0-9_-]+)="([^"]+)"\]/.exec(sel);
      return m ? el.getAttribute(m[1]) === m[2] : false;
    };

    const prevWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        innerWidth: vp.width,
        innerHeight: vp.height,
        getComputedStyle: (el: (typeof elements)[number]) => el.style,
      },
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      writable: true,
      value: {
        documentElement: {},
        body: {},
        querySelector: (sel: string) => elements.find((el) => matchSel(el, sel)) ?? null,
        querySelectorAll: (sel: string) => (sel === '*' ? elements : []),
        elementFromPoint: (x: number, y: number) => {
          const hits = elements
            .filter(
              (el) =>
                el.style.pointerEvents !== 'none' &&
                x >= el.rect.left &&
                x <= el.rect.right &&
                y >= el.rect.top &&
                y <= el.rect.bottom
            )
            .sort((a, b) => Number(b.style.zIndex) - Number(a.style.zIndex));
          return hits[0] ?? null;
        },
      },
    });
    restoreCallbacks.push(() => {
      if (prevWindow) Object.defineProperty(globalThis, 'window', prevWindow);
      else Reflect.deleteProperty(globalThis, 'window');
      if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
      else Reflect.deleteProperty(globalThis, 'document');
    });

    const blockedGeo = probeElementGeometryAndOcclusion(CORE_WEB_INTERACTIVE_TARGETS);
    expect(blockedGeo.items.find((i) => i.key === 'composerInput')?.occluded).toBe(true);
    expect(probeOverlayResidual().hasBlockingOverlay).toBe(true);

    scrim.style.pointerEvents = 'none';
    const clearGeo = probeElementGeometryAndOcclusion(CORE_WEB_INTERACTIVE_TARGETS);
    expect(clearGeo.failures).toEqual([]);
    expect(clearGeo.overlaps).toEqual([]);
    expect(probeOverlayResidual().hasBlockingOverlay).toBe(false);
  });

  it('[T3-12] F4×F5×F8: Claude 生图引导拦截 → 外部搜索检索 → OpenAI 生图草稿持久化冷重启恢复与孤儿附件清理', async () => {
    setE2EPlatformOs('web');
    const router = installMockFetchRouter(serverBaseUrl, { enableWebDevProxy: true });
    restoreCallbacks.push(() => router.restore());
    const harness = await createE2EWorkspaceHarness();
    restoreCallbacks.push(() => harness.dispose());

    const imageGen = await safeImportModule<ImageGenerationServiceContract>(
      'src/services/imageGeneration.ts',
      ['generateImages', 'resolveImageApiMode']
    );

    // 1) Claude 生图零网络请求拦截并给出切换引导
    const claude = getDefaultProviderClone('anthropic', 'sk-ant-t3-12');
    expect(imageGen.resolveImageApiMode(claude, 'claude-sonnet-5-5')).toBe('unsupported');
    await expect(
      imageGen.generateImages({
        provider: claude,
        modelId: 'claude-sonnet-5-5',
        prompt: '绘制系统架构图',
      })
    ).rejects.toThrow(/(?:不支持.*生图|切换|OpenAI|Gemini|xAI)/i);
    expect(server.getRequests()).toHaveLength(0);

    // 2) 切换至 OpenAI 跑一轮 Tavily 外部搜索检索参考，再调用 gpt-image-2.5-sunburst 生图
    const openai = getDefaultProviderClone('openai', 'sk-openai-t3-12');
    const chatModel: ModelInfo = {
      id: 'gpt-4.1',
      name: 'GPT-4.1',
      capabilities: ['text', 'tool-calling', 'streaming'],
      source: 'preset',
    };
    await harness.addAndSelectProvider(openai, chatModel);
    await harness.setExternalSearch({
      enabled: true,
      maxResults: 2,
      maxToolRounds: 2,
      selectedServiceId: 'tavily-t3-12',
      services: [
        { id: 'tavily-t3-12', kind: 'tavily', name: 'Tavily', apiKey: 'tvly-t3-12' },
      ],
    });

    server.enqueue(
      { method: 'POST', pathname: '/v1/chat/completions' },
      {
        kind: 'sse',
        chunks: buildOpenAiChatSseChunks({
          model: 'gpt-4.1',
          textDeltas: [],
          toolCalls: [
            {
              index: 0,
              id: 'call_tav_1',
              name: 'search_web',
              argumentsJson: '{"query":"design spec 2026"}',
            },
          ],
        }),
      }
    );
    server.enqueue(
      { method: 'POST', pathname: '/search' },
      {
        kind: 'json',
        body: {
          results: [{ title: 'Design Spec', url: 'https://design.example.com', content: 'Minimal clean UI' }],
        },
      }
    );
    server.enqueue(
      { method: 'POST', pathname: '/v1/chat/completions' },
      {
        kind: 'sse',
        chunks: buildOpenAiChatSseChunks({
          model: 'gpt-4.1',
          textDeltas: ['参考设计规范 [1](1:s1)。'],
        }),
      }
    );
    server.enqueue(
      { method: 'POST', pathname: '/v1/images/generations' },
      {
        kind: 'json',
        body: buildOpenAiImageGenerationJson({ revisedPrompt: 'Minimal clean UI diagram' }),
      }
    );

    const activeOpenAi = harness.session
      .getSnapshot()
      .providers.find((p) => p.id === 'openai') as ProviderProfile;
    const adapter = harness.productionAdapterRegistry.resolve(
      { provider: activeOpenAi, modelId: 'gpt-4.1', model: chatModel },
      'chat'
    );
    const searchChat = await adapter.run({
      provider: activeOpenAi,
      modelId: 'gpt-4.1',
      model: chatModel,
      messages: [{ id: 'u-1', role: 'user', content: '查设计规范', createdAt: 1, status: 'ready' }],
      reasoningEffort: 'medium',
      parameterSettings: defaultParameterSettings,
      externalSearch: harness.session.getSnapshot().externalSearch,
    });
    expect(searchChat.citations?.[0]?.url).toBe('https://design.example.com/');

    const genRes = await imageGen.generateImages({
      provider: openai,
      modelId: 'gpt-image-2.5-sunburst',
      prompt: '依据设计规范绘制首页草图',
      options: { aspectRatio: '16:9', quality: 'high' },
    });
    const draftAttachment = genRes.attachments![0];
    expect(draftAttachment.uri).toMatch(/^embezzle-web-attachment:\/\//);

    const convId = harness.session.getSnapshot().activeConversationId;
    await harness.chatRuntime.execute({
      type: 'draft.set',
      conversationId: convId,
      text: '带着生成图继续提问',
      attachments: [draftAttachment],
      now: harness.clock.now(),
    });

    // 另存一个未挂接到任何消息或草稿的孤儿附件
    const orphanAttachment = await persistAttachment({
      id: 'orphan-att-t3-12',
      kind: 'image',
      uri: `data:image/png;base64,${TINY_PNG_BASE64}`,
      name: 'orphan.png',
      mimeType: 'image/png',
      base64: TINY_PNG_BASE64,
    });

    await harness.flush();

    // 3) 冷重启 WorkspaceSession 验证草稿与附件引用恢复
    const rebooted = new WorkspaceSession({
      persistence: harness.persistence,
      clock: harness.clock,
      lifecycle: harness.lifecycle,
      trace: harness.trace,
      autoBoot: false,
    });
    restoreCallbacks.push(() => rebooted.dispose());
    await rebooted.boot();

    const restoredDraft = rebooted
      .getSnapshot()
      .composerDrafts.find((d) => d.conversationId === convId);
    expect(restoredDraft?.text).toBe('带着生成图继续提问');
    expect(restoredDraft?.attachments?.[0]?.uri).toBe(draftAttachment.uri);
    expect(restoredDraft?.attachments?.[0]?.base64 ?? null).toBeNull();

    // 4) 清理孤儿附件后，草稿附件仍可读，孤儿附件已被回收
    await discardUncommittedAttachments([orphanAttachment]);
    await cleanupOrphanedMediaStorage([draftAttachment]);
    const validUri = await resolveAttachmentDisplayUri(draftAttachment);
    expect(validUri.startsWith('blob:') || validUri.startsWith('data:')).toBe(true);
    await expect(resolveAttachmentDisplayUri(orphanAttachment)).rejects.toThrow(/浏览器存储已丢失/);
  });
});
