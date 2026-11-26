import { createRequire } from 'node:module';
import {
  act,
  createElement,
  forwardRef,
  useImperativeHandle,
  useState,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryWorkspacePersistenceAdapter } from '../src/app/workspace/adapters/memoryWorkspacePersistenceAdapter';
import { WorkspaceSession } from '../src/app/workspace/WorkspaceSession';
import { WorkspaceSessionProvider } from '../src/app/workspace/WorkspaceSessionProvider';
import { createDefaultWorkspace } from '../src/data/providerCatalog';
import type { ChatMessage, WebCitation } from '../src/domain/types';
import { ChatProvider } from '../src/features/chat/ChatProvider';
import { createProductionChatAudioAdapter } from '../src/features/chat/orchestration/ChatAudioAdapter';
import {
  clearStreamingDraft,
  publishStreamingDraft,
  streamingDraftStore,
} from '../src/features/chat/internal/ChatWorkspaceRuntime';
import type { ProviderAdapterRegistry } from '../src/features/chat/orchestration/ProviderAdapterRegistry';
import { ProjectsConversationsProvider } from '../src/features/projects/ProjectsConversationsProvider';
import { ChatPane } from '../src/features/chat/ChatPane';
import { ChatMessageRow } from '../src/features/chat/internal/presentation/ChatMessageRow';
import { AppearanceProvider } from '../src/ui/appearance/AppearanceProvider';
import { KelivoThemeProvider } from '../src/ui/theme';
import { mutateSessionForTest } from './helpers/workspaceSessionTestHarness';

function elWithChildren<P extends { children?: ReactNode }>(
  component: ComponentType<P>,
  props: Omit<P, 'children'>,
  ...children: ReactNode[]
): ReactElement {
  return createElement(component as ComponentType<Omit<P, 'children'>>, props, ...children);
}

const loadCjs = createRequire(import.meta.url);
const { createRoot } = loadCjs('react-dom/client') as {
  createRoot: (container: unknown) => {
    render: (element: ReactElement) => void;
    unmount: () => void;
  };
};

// -------------------- 轻量真实 DOM 挂载桩 --------------------
interface DomEventTarget {
  listeners: Map<string, Set<(event: unknown) => void>>;
}

class StubNode implements DomEventTarget {
  nodeType: number;
  parentNode: StubNode | null = null;
  childNodes: StubNode[] = [];
  listeners = new Map<string, Set<(event: unknown) => void>>();
  ownerDocument: StubDocument;

  constructor(nodeType: number, ownerDocument: StubDocument) {
    this.nodeType = nodeType;
    this.ownerDocument = ownerDocument;
  }

  appendChild(child: StubNode): StubNode {
    if (child.nodeType === 11) {
      for (const item of [...child.childNodes]) {
        this.appendChild(item);
      }
      child.childNodes = [];
      return child;
    }
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore(newNode: StubNode, referenceNode: StubNode | null): StubNode {
    if (!referenceNode) {
      return this.appendChild(newNode);
    }
    if (newNode.nodeType === 11) {
      for (const item of [...newNode.childNodes]) {
        this.insertBefore(item, referenceNode);
      }
      newNode.childNodes = [];
      return newNode;
    }
    if (newNode.parentNode) {
      newNode.parentNode.removeChild(newNode);
    }
    const index = this.childNodes.indexOf(referenceNode);
    if (index === -1) {
      return this.appendChild(newNode);
    }
    newNode.parentNode = this;
    this.childNodes.splice(index, 0, newNode);
    return newNode;
  }

  removeChild(child: StubNode): StubNode {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) {
      this.childNodes.splice(index, 1);
      child.parentNode = null;
    }
    return child;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  get firstChild(): StubNode | null {
    return this.childNodes[0] ?? null;
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    this.childNodes = [];
    if (value) {
      this.appendChild(new StubText(value, this.ownerDocument));
    }
  }
}

class StubText extends StubNode {
  data: string;
  constructor(data: string, ownerDocument: StubDocument) {
    super(3, ownerDocument);
    this.data = data;
  }
  get nodeValue(): string {
    return this.data;
  }
  set nodeValue(value: string) {
    this.data = value;
  }
  get textContent(): string {
    return this.data;
  }
  set textContent(value: string) {
    this.data = value;
  }
}

class StubComment extends StubNode {
  data: string;
  constructor(data: string, ownerDocument: StubDocument) {
    super(8, ownerDocument);
    this.data = data;
  }
  get textContent(): string {
    return '';
  }
  set textContent(_value: string) {}
}

class StubElement extends StubNode {
  tagName: string;
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  attributes = new Map<string, string>();
  style: Record<string, string> = {};
  value = '';
  checked = false;
  disabled = false;

  constructor(tagName: string, ownerDocument: StubDocument) {
    super(1, ownerDocument);
    this.tagName = tagName.toUpperCase();
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  focus(): void {}
  blur(): void {}

  findAll(predicate: (el: StubElement) => boolean): StubElement[] {
    const out: StubElement[] = [];
    const visit = (node: StubNode) => {
      if (node instanceof StubElement) {
        if (predicate(node)) out.push(node);
      }
      for (const child of node.childNodes) {
        visit(child);
      }
    };
    visit(this);
    return out;
  }

  findByTestId(testId: string): StubElement | null {
    return this.findAll((el) => el.getAttribute('data-testid') === testId)[0] ?? null;
  }
}

class StubDocument extends StubNode {
  defaultView: unknown;
  documentElement: StubElement;
  body: StubElement;
  activeElement: StubElement | null = null;

  constructor() {
    super(9, null as unknown as StubDocument);
    this.ownerDocument = this;
    this.documentElement = new StubElement('html', this);
    this.body = new StubElement('body', this);
    this.documentElement.appendChild(this.body);
  }

  createElement(tagName: string): StubElement {
    return new StubElement(tagName, this);
  }

  createElementNS(_ns: string, tagName: string): StubElement {
    return new StubElement(tagName, this);
  }

  createTextNode(text: string): StubText {
    return new StubText(text, this);
  }

  createComment(text: string): StubComment {
    return new StubComment(text, this);
  }

  createDocumentFragment(): StubNode {
    return new StubNode(11, this);
  }
}

interface GlobalBackup {
  key: PropertyKey;
  descriptor: PropertyDescriptor | undefined;
}

const savedGlobals: GlobalBackup[] = [];

function setGlobalForTest(key: PropertyKey, value: unknown): void {
  savedGlobals.push({
    key,
    descriptor: Object.getOwnPropertyDescriptor(globalThis, key),
  });
  Object.defineProperty(globalThis, key, {
    value,
    configurable: true,
    writable: true,
    enumerable: true,
  });
}

function restoreGlobals(): void {
  while (savedGlobals.length > 0) {
    const entry = savedGlobals.pop();
    if (!entry) continue;
    if (entry.descriptor) {
      Object.defineProperty(globalThis, entry.key, entry.descriptor);
    } else {
      Reflect.deleteProperty(globalThis, entry.key);
    }
  }
}

// -------------------- Vi Hoisted 捕获探针 --------------------
interface ScrollEventPayload {
  nativeEvent: {
    contentOffset: { x: number; y: number };
    contentSize: { width: number; height: number };
    layoutMeasurement: { width: number; height: number };
  };
}

interface CapturedFlatListHandle {
  props: {
    data?: readonly ChatMessage[];
    onScrollBeginDrag?: () => void;
    onScrollEndDrag?: (event?: ScrollEventPayload) => void;
    onMomentumScrollEnd?: (event?: ScrollEventPayload) => void;
    onScroll?: (event: ScrollEventPayload) => void;
    onContentSizeChange?: (width: number, height: number) => void;
    onScrollToIndexFailed?: (info: { index: number; averageItemLength: number }) => void;
  } | null;
  scrollToEnd: ReturnType<typeof vi.fn>;
  scrollToOffset: ReturnType<typeof vi.fn>;
  scrollToIndex: ReturnType<typeof vi.fn>;
}

const testProbes = vi.hoisted(() => {
  const prevDevDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__DEV__');
  if (!prevDevDescriptor) {
    Object.defineProperty(globalThis, '__DEV__', {
      value: false,
      configurable: true,
      writable: true,
      enumerable: true,
    });
  }
  return {
    prevDevDescriptor,
    rowRenderCounts: new Map<string, number>(),
    pressableHandlers: new Map<string, () => void>(),
    flatList: {
      props: null as CapturedFlatListHandle['props'],
      scrollToEnd: vi.fn(),
      scrollToOffset: vi.fn(),
      scrollToIndex: vi.fn(),
    } satisfies CapturedFlatListHandle,
  };
});

function makeScrollEvent(
  offsetY: number,
  contentHeight: number,
  layoutHeight = 600
): ScrollEventPayload {
  return {
    nativeEvent: {
      contentOffset: { x: 0, y: offsetY },
      contentSize: { width: 390, height: contentHeight },
      layoutMeasurement: { width: 390, height: layoutHeight },
    },
  };
}

// -------------------- 模块 Mock（仅模拟原生/图标/重型无关系组件） --------------------
vi.mock('react-native', () => {
  const flattenStyle = (style: unknown): Record<string, unknown> => {
    if (!style) return {};
    if (Array.isArray(style)) {
      return Object.assign({}, ...style.map(flattenStyle));
    }
    if (typeof style === 'object') {
      return style as Record<string, unknown>;
    }
    return {};
  };

  const makeHost = (tag: string) =>
    forwardRef<unknown, Record<string, unknown>>(function MockRnHost(props, ref) {
      const {
        children,
        testID,
        accessibilityLabel,
        accessibilityRole,
        onPress,
      } = props;
      if (typeof testID === 'string' && typeof onPress === 'function') {
        testProbes.pressableHandlers.set(testID, onPress as () => void);
      }
      return createElement(
        tag,
        {
          ref,
          ...(testID ? { 'data-testid': testID } : {}),
          ...(accessibilityLabel ? { 'aria-label': accessibilityLabel } : {}),
          ...(accessibilityRole ? { role: accessibilityRole } : {}),
        },
        children as ReactNode
      );
    });

  const View = makeHost('div');
  const Text = makeHost('span');
  const TextInput = makeHost('textarea');
  const Pressable = makeHost('div');
  const ScrollView = makeHost('div');
  const KeyboardAvoidingView = makeHost('div');
  const ActivityIndicator = makeHost('div');
  const Image = makeHost('img');

  const FlatList = forwardRef<unknown, Record<string, unknown>>(function MockFlatList(props, ref) {
    testProbes.flatList.props = props as CapturedFlatListHandle['props'];
    useImperativeHandle(
      ref,
      () => ({
        scrollToEnd: testProbes.flatList.scrollToEnd,
        scrollToOffset: testProbes.flatList.scrollToOffset,
        scrollToIndex: testProbes.flatList.scrollToIndex,
      }),
      []
    );
    const data = (props.data as readonly ChatMessage[] | undefined) ?? [];
    const renderItem = props.renderItem as
      | ((info: { item: ChatMessage; index: number }) => ReactNode)
      | undefined;
    const keyExtractor = props.keyExtractor as
      | ((item: ChatMessage, index: number) => string)
      | undefined;
    return createElement(
      'div',
      { 'data-testid': 'mock-flatlist' },
      data.map((item, index) =>
        createElement(
          'div',
          { key: keyExtractor ? keyExtractor(item, index) : String(index) },
          renderItem ? renderItem({ item, index }) : null
        )
      )
    );
  });

  return {
    Platform: {
      OS: 'ios',
      select: (spec: Record<string, unknown>) => spec.ios ?? spec.default,
    },
    StyleSheet: {
      create: <T extends Record<string, unknown>>(styles: T): T => styles,
      flatten: flattenStyle,
      absoluteFill: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
      hairlineWidth: 0.5,
    },
    Dimensions: {
      get: () => ({ width: 390, height: 844 }),
    },
    Keyboard: {
      addListener: () => ({ remove: () => undefined }),
      dismiss: () => undefined,
    },
    AppState: {
      currentState: 'active',
      addEventListener: () => ({ remove: () => undefined }),
    },
    BackHandler: {
      addEventListener: () => ({ remove: () => undefined }),
    },
    Share: {
      share: async () => ({ action: 'sharedAction' }),
    },
    useColorScheme: () => 'light',
    useWindowDimensions: () => ({ width: 390, height: 844 }),
    Linking: {
      openURL: async () => undefined,
    },
    NativeModules: {},
    View,
    Text,
    TextInput,
    Pressable,
    ScrollView,
    KeyboardAvoidingView,
    ActivityIndicator,
    Image,
    FlatList,
  };
});

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));

vi.mock('react-native-reanimated', () => {
  const createAnimatedComponent = <P extends object>(comp: ComponentType<P>) => comp;
  const noopAnimation = { duration: () => noopAnimation };
  return {
    default: {
      View: ({ children }: { children?: ReactNode }) =>
        createElement('div', null, children),
      Text: ({ children }: { children?: ReactNode }) =>
        createElement('span', null, children),
      createAnimatedComponent,
    },
    Easing: {
      out: (fn: unknown) => fn,
      inOut: (fn: unknown) => fn,
      cubic: () => 0,
      quad: () => 0,
    },
    Extrapolation: { CLAMP: 'clamp' },
    LinearTransition: noopAnimation,
    interpolate: (_v: number, _i: number[], o: number[]) => o[0] ?? 0,
    runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
    useAnimatedStyle: (fn: () => Record<string, unknown>) => fn(),
    useReducedMotion: () => true,
    useSharedValue: <T,>(value: T) => ({ value }),
    withTiming: <T,>(value: T) => value,
    withSpring: <T,>(value: T) => value,
    cancelAnimation: () => undefined,
  };
});

vi.mock('moti', () => ({
  AnimatePresence: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  MotiView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('expo', () => ({
  useEvent: () => undefined,
}));
vi.mock('expo-modules-core', () => ({
  NativeModulesProxy: {},
  requireNativeModule: () => ({}),
  requireOptionalNativeModule: () => null,
}));
vi.mock('expo-constants', () => ({
  default: { expoConfig: {}, manifest: null },
}));
vi.mock('expo-asset', () => ({
  Asset: { fromModule: () => ({ downloadAsync: async () => undefined }) },
}));
vi.mock('expo-audio', () => ({
  RecordingPresets: { HIGH_QUALITY: {} },
  createAudioPlayer: () => ({
    play: () => undefined,
    pause: () => undefined,
    remove: () => undefined,
  }),
  requestRecordingPermissionsAsync: async () => ({ granted: true }),
  setAudioModeAsync: async () => undefined,
  useAudioRecorder: () => ({
    prepareToRecordAsync: async () => undefined,
    record: () => undefined,
    stop: async () => undefined,
    uri: null,
  }),
  useAudioRecorderState: () => ({ isRecording: false }),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  },
}));
vi.mock('expo-status-bar', () => ({
  StatusBar: () => null,
}));
vi.mock('expo-clipboard', () => ({
  setStringAsync: async () => undefined,
}));
vi.mock('expo-haptics', () => ({
  selectionAsync: async () => undefined,
  notificationAsync: async () => undefined,
  impactAsync: async () => undefined,
  NotificationFeedbackType: { Success: 'success', Warning: 'warning' },
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
}));
vi.mock('expo-file-system', () => ({
  documentDirectory: 'file:///mock-doc/',
  cacheDirectory: 'file:///mock-cache/',
  Paths: { document: 'file:///mock-doc/', cache: 'file:///mock-cache/' },
  File: class {},
  Directory: class {},
}));
vi.mock('expo-document-picker', () => ({
  getDocumentAsync: async () => ({ canceled: true, assets: [] }),
}));
vi.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: async () => ({ canceled: true, assets: [] }),
  requestMediaLibraryPermissionsAsync: async () => ({ granted: true }),
}));
vi.mock('expo-sharing', () => ({
  isAvailableAsync: async () => false,
  shareAsync: async () => undefined,
}));
vi.mock('expo-secure-store', () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => undefined,
  deleteItemAsync: async () => undefined,
}));
vi.mock('expo-video', () => ({
  VideoView: () => null,
  useVideoPlayer: () => ({ play: () => undefined, pause: () => undefined }),
}));
vi.mock('expo-crypto', () => ({
  randomUUID: () => '00000000-0000-4000-8000-000000000000',
}));
vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('react-native-svg', () => ({
  default: () => null,
  Svg: () => null,
  Path: () => null,
  Circle: () => null,
  Rect: () => null,
}));

vi.mock('lucide-react-native', () => {
  const Icon = () => createElement('span');
  const names = [
    'ArrowDown', 'BookOpen', 'Brain', 'Check', 'ChevronDown', 'Columns3', 'Copy',
    'Download', 'FileText', 'GitBranch', 'Image', 'Lightbulb', 'Menu', 'MessageSquare',
    'Mic', 'MoreHorizontal', 'Pencil', 'Play', 'Plus', 'RefreshCw', 'Settings',
    'Share2', 'ShieldCheck', 'SlidersHorizontal', 'Sparkles', 'Square', 'Trash2',
    'Video', 'Volume2', 'Wrench', 'X',
  ];
  const mod: Record<string, unknown> = { __esModule: true };
  for (const name of names) mod[name] = Icon;
  return mod;
});

vi.mock('@lobehub/icons-rn', () => {
  const makeBrand = () => {
    const Icon = () => createElement('span');
    return Object.assign(Icon, { Color: Icon });
  };
  const names = [
    'Bailian', 'Bing', 'ChatGLM', 'Claude', 'DeepSeek', 'Doubao', 'Gemini',
    'Grok', 'Kimi', 'Minimax', 'NewAPI', 'OpenAI', 'Qwen', 'Tavily', 'Volcengine', 'Zhipu',
  ];
  const mod: Record<string, unknown> = { __esModule: true };
  for (const name of names) mod[name] = makeBrand();
  return mod;
});

vi.mock('../src/ui/components/MessageActivityModules', () => ({
  MessageActivityModules: ({ message }: { message: ChatMessage }) => {
    testProbes.rowRenderCounts.set(
      message.id,
      (testProbes.rowRenderCounts.get(message.id) ?? 0) + 1
    );
    return createElement(
      'div',
      {
        'data-testid': `activity-${message.id}`,
        'data-thinking-ms':
          message.thinkingDurationMs !== undefined ? String(message.thinkingDurationMs) : '',
        'data-citation-titles': (message.citations ?? []).map((item) => item.title).join(','),
      },
      message.reasoningContent ?? ''
    );
  },
}));

vi.mock('../src/ui/components/MessageMarkdown', () => ({
  MessageMarkdown: ({
    content,
    citations,
  }: {
    content: string;
    citations?: readonly WebCitation[];
  }) =>
    createElement(
      'div',
      {
        'data-testid': 'markdown-body',
        'data-citation-count': String(citations?.length ?? 0),
      },
      content
    ),
}));

vi.mock('../src/features/chat/internal/presentation/ChatModelPicker', () => ({
  ModelPickerModal: () => null,
  ParameterControl: () => null,
}));

vi.mock('../src/components/WorkspaceWorkbench', () => ({
  WorkspaceWorkbench: () => null,
}));

vi.mock('../src/components/ContextInspectorModal', () => ({
  ContextInspectorModal: () => null,
}));

vi.mock('../src/components/KnowledgeImportPreview', () => ({
  KnowledgeImportPreview: () => null,
}));

vi.mock('../src/components/McpApprovalModal', () => ({
  McpApprovalModal: () => null,
}));

vi.mock('../src/ui/components/ConfirmDialog', () => ({
  ConfirmDialog: () => null,
}));

vi.mock('../src/ui/components/SearchServicesPanel', () => ({
  ComposerSearchSheet: () => null,
  resolveActiveSearchIconKind: () => 'off',
  SearchServiceIcon: () => null,
}));

vi.mock('../src/ui/mobile/WorkspaceHub', () => ({
  MainWorkspaceTabBar: () => null,
  WorkspaceHub: () => null,
}));

function buildAssistantMessage(
  id: string,
  content: string,
  status: ChatMessage['status']
): ChatMessage {
  return {
    id,
    role: 'assistant',
    content,
    createdAt: 1000,
    status,
    providerId: 'openai',
    providerName: 'OpenAI',
    modelId: 'gpt-4.1',
  };
}

function stableRowCallbacks() {
  return {
    onCopy: () => undefined,
    onRetry: () => undefined,
    onBeginEdit: () => undefined,
    onChangeEditDraft: () => undefined,
    onCancelEdit: () => undefined,
    onSaveEdit: () => undefined,
    onShare: () => undefined,
    onToggleActionMenu: () => undefined,
    onSaveArtifact: () => undefined,
    onSaveKnowledge: () => undefined,
    onBranch: () => undefined,
    onDelete: () => undefined,
    onRemoveSystemInstruction: () => undefined,
    onSelectComparisonAnswer: () => undefined,
    onRefreshGenerationTask: () => undefined,
    onToggleVideo: () => undefined,
    onReadAloud: () => undefined,
  };
}

describe('R3 ChatMessageRow 隔离渲染与 ChatPane 智能吸底状态机', () => {
  let doc: StubDocument;
  let container: StubElement;
  let activeRoot: ReturnType<typeof createRoot> | null = null;
  let activeSession: WorkspaceSession | null = null;

  beforeEach(() => {
    streamingDraftStore.clearAll();
    testProbes.rowRenderCounts.clear();
    testProbes.pressableHandlers.clear();
    testProbes.flatList.props = null;
    testProbes.flatList.scrollToEnd.mockClear();
    testProbes.flatList.scrollToOffset.mockClear();
    testProbes.flatList.scrollToIndex.mockClear();

    doc = new StubDocument();
    container = doc.createElement('div');
    doc.body.appendChild(container);
    const win = {
      document: doc,
      Node: StubNode,
      Element: StubElement,
      HTMLElement: StubElement,
      HTMLIFrameElement: class StubHTMLIFrameElement {},
      ShadowRoot: class StubShadowRoot {},
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    doc.defaultView = win;
    setGlobalForTest('IS_REACT_ACT_ENVIRONMENT', true);
    setGlobalForTest('document', doc);
    setGlobalForTest('window', win);
    setGlobalForTest('Node', StubNode);
    setGlobalForTest('Element', StubElement);
    setGlobalForTest('HTMLElement', StubElement);
  });

  afterAll(() => {
    if (testProbes.prevDevDescriptor) {
      Object.defineProperty(globalThis, '__DEV__', testProbes.prevDevDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, '__DEV__');
    }
  });

  afterEach(async () => {
    try {
      if (activeRoot) {
        await act(async () => {
          activeRoot?.unmount();
        });
        activeRoot = null;
      }
      if (activeSession) {
        activeSession.dispose();
        await activeSession.settle();
        activeSession = null;
      }
    } finally {
      streamingDraftStore.clearAll();
      vi.useRealTimers();
      restoreGlobals();
    }
  });

  it('mounts 200+ ChatMessageRow items, isolates 220 streaming draft chunks to the pending row with zero history rerenders, and blocks stale drafts on terminal rows', async () => {
    const conversationId = 'conv-stream-isolation';
    const historyMessages = Array.from({ length: 205 }, (_, index) =>
      buildAssistantMessage(`hist-${index}`, `历史回答 ${index}`, 'ready')
    );
    const pendingMessage = buildAssistantMessage('pending-1', '', 'pending');
    const allMessages = [...historyMessages, pendingMessage];
    const callbacks = stableRowCallbacks();

    let triggerParentRerender: (() => void) | undefined;
    function HostList() {
      const [unrelatedTick, setUnrelatedTick] = useState(0);
      triggerParentRerender = () => setUnrelatedTick((v) => v + 1);
      return createElement(
        'div',
        { 'data-tick': String(unrelatedTick) },
        createElement(
          'button',
          {
            'data-testid': 'trigger-parent-rerender',
            onClick: () => setUnrelatedTick((v) => v + 1),
          },
          null
        ),
        allMessages.map((msg) =>
          createElement(ChatMessageRow, {
            key: msg.id,
            conversationId,
            message: msg,
            isAnimated: false,
            isSearchHighlighted: false,
            isEditing: false,
            editingDraft: '',
            editDisabled: false,
            systemRemoveDisabled: false,
            isCopied: false,
            isActionMenuOpen: false,
            isTaskQuerying: false,
            activeVideoId: null,
            canSynthesizeSpeech: false,
            isSpeaking: false,
            speechDisabled: false,
            videoFallbackTarget: null,
            ...callbacks,
          })
        )
      );
    }

    activeRoot = createRoot(container);
    await act(async () => {
      activeRoot?.render(
        elWithChildren(KelivoThemeProvider, { scheme: 'light' }, createElement(HostList))
      );
    });

    // 初始挂载每条历史行各渲染 1 次
    for (const msg of historyMessages) {
      expect(testProbes.rowRenderCounts.get(msg.id)).toBe(1);
    }
    expect(testProbes.rowRenderCounts.get('pending-1')).toBe(1);

    const citations: WebCitation[] = [
      { title: '引用文档', url: 'https://example.test/citation' },
    ];

    // 连续向 streamingDraftStore 发布 220 次分片
    await act(async () => {
      for (let i = 1; i <= 220; i += 1) {
        publishStreamingDraft(conversationId, 'pending-1', {
          content: `流式输出片段-${i}`,
          thinkingDurationMs: 100 + i,
          citations,
        });
      }
    });

    // 历史行渲染计数增量必须严格为 0
    for (const msg of historyMessages) {
      expect(testProbes.rowRenderCounts.get(msg.id)).toBe(1);
    }
    expect(testProbes.rowRenderCounts.get('pending-1')).toBeGreaterThan(1);

    const renderedText = container.textContent;
    expect(renderedText).toContain('流式输出片段-220');
    expect(renderedText).toContain('1个引用');
    const activityEl = container.findByTestId('activity-pending-1');
    expect(activityEl?.getAttribute('data-thinking-ms')).toBe('320');
    expect(activityEl?.getAttribute('data-citation-titles')).toBe('引用文档');

    // 验证父组件因无关状态更新重渲染时，200+ 条历史行仍受 React.memo 保护增量为 0
    await act(async () => {
      triggerParentRerender?.();
    });
    for (const msg of historyMessages) {
      expect(testProbes.rowRenderCounts.get(msg.id)).toBe(1);
    }

    // 清除 pending-1 草稿（包在 act 内）并验证终态消息注入脏草稿绝不回显
    await act(async () => {
      clearStreamingDraft(conversationId, 'pending-1');
    });

    const terminalMessages = [
      buildAssistantMessage('term-ready', 'READY_PERSISTED', 'ready'),
      buildAssistantMessage('term-cancelled', 'CANCELLED_PERSISTED', 'cancelled'),
      buildAssistantMessage('term-error', 'ERROR_PERSISTED', 'error'),
    ];
    for (const msg of terminalMessages) {
      publishStreamingDraft(conversationId, msg.id, {
        content: `STALE_DRAFT_${msg.id}`,
        thinkingDurationMs: 9999,
        citations: [{ title: 'STALE_CITATION', url: 'https://stale.example.test' }],
      });
    }

    await act(async () => {
      activeRoot?.render(
        elWithChildren(
          KelivoThemeProvider,
          { scheme: 'light' },
          ...terminalMessages.map((msg) =>
            createElement(ChatMessageRow, {
              key: msg.id,
              conversationId,
              message: msg,
              isAnimated: false,
              isSearchHighlighted: false,
              isEditing: false,
              editingDraft: '',
              editDisabled: false,
              systemRemoveDisabled: false,
              isCopied: false,
              isActionMenuOpen: false,
              isTaskQuerying: false,
              activeVideoId: null,
              canSynthesizeSpeech: false,
              isSpeaking: false,
              speechDisabled: false,
              videoFallbackTarget: null,
              ...callbacks,
            })
          )
        )
      );
    });

    const terminalText = container.textContent;
    expect(terminalText).toContain('READY_PERSISTED');
    expect(terminalText).toContain('CANCELLED_PERSISTED');
    expect(terminalText).toContain('ERROR_PERSISTED');
    expect(terminalText).not.toContain('STALE_DRAFT_');
    expect(terminalText).not.toContain('STALE_CITATION');
    await act(async () => {
      clearStreamingDraft(conversationId);
    });
  });

  it('drives real ChatPane auto-scroll state machine: prevents gesture hijacking on <120px drag up, resumes on scroll-to-bottom or drag back, exempts contentShrunk, resets on conversation switch, and retries scrollToIndexFailed', async () => {
    const initial = createDefaultWorkspace();
    const conv1Id = initial.activeConversationId;
    const conv2Id = 'conv-second';
    initial.messages = [
      { id: 'm1', role: 'user', content: '问题1', createdAt: 1, status: 'ready' },
      buildAssistantMessage('m2', '回答1', 'ready'),
    ];
    initial.conversations = [
      {
        ...initial.conversations[0],
        id: conv1Id,
        messages: [...initial.messages],
      },
      {
        ...initial.conversations[0],
        id: conv2Id,
        title: '第二会话',
        messages: [
          { id: 'c2-m1', role: 'user', content: '问题2', createdAt: 2, status: 'ready' },
        ],
      },
    ];

    const persistence = new MemoryWorkspacePersistenceAdapter({ initial });
    const session = new WorkspaceSession({ persistence, autoBoot: false });
    activeSession = session;
    await session.boot();

    const registry: ProviderAdapterRegistry = {
      resolve: () => ({
        run: async () => ({ content: 'ok', raw: undefined }),
        queryTask: async () => ({ content: '', raw: undefined }),
      }),
    };

    const audioAdapter = createProductionChatAudioAdapter();

    const lifecycle = {
      getState: () => 'foreground' as const,
      subscribe: () => () => undefined,
    };

    activeRoot = createRoot(container);
    await act(async () => {
      activeRoot?.render(
        elWithChildren(
          WorkspaceSessionProvider,
          { adapters: { persistence, lifecycle }, session },
          elWithChildren(
            AppearanceProvider,
            {},
            elWithChildren(
              ChatProvider,
              {
                adapters: {
                  lifecycle,
                  providers: registry,
                  audio: audioAdapter,
                },
              },
              elWithChildren(
                ProjectsConversationsProvider,
                {},
                createElement(ChatPane, {
                  settings: {
                    isOpen: false,
                    open: () => undefined,
                    close: () => undefined,
                    back: () => false,
                  },
                  onOpenSetup: () => undefined,
                })
              )
            )
          )
        )
      );
    });

    expect(testProbes.flatList.props).not.toBeNull();
    expect(container.findByTestId('chat-scroll-to-bottom')).toBeNull();

    // 先建立基线偏移（在底部：contentHeight=2000, layoutHeight=600, offsetY=1400）
    await act(async () => {
      testProbes.flatList.props?.onScroll?.(makeScrollEvent(1400, 2000, 600));
    });
    testProbes.flatList.scrollToEnd.mockClear();

    // 0a) 零位移起手拖拽（不发 onScroll）：即刻收到流式 onContentSizeChange 绝不能调用 scrollToEnd
    await act(async () => {
      testProbes.flatList.props?.onScrollBeginDrag?.();
      testProbes.flatList.props?.onContentSizeChange?.(390, 2040);
    });
    expect(testProbes.flatList.scrollToEnd).not.toHaveBeenCalled();

    // 0b) 拖拽中发生仍在底部且无 scrolledUp 的微抖 onScroll，受 isUserDraggingRef 保护仍不得重新吸底
    await act(async () => {
      testProbes.flatList.props?.onScroll?.(makeScrollEvent(1400, 2040, 600));
      testProbes.flatList.props?.onContentSizeChange?.(390, 2060);
    });
    expect(testProbes.flatList.scrollToEnd).not.toHaveBeenCalled();

    // 1) 近底部 < 120px（distanceFromBottom = 120 -> 上滑至 1340/2060）拖拽上滑：不得抢手势，且显示回底按钮
    await act(async () => {
      testProbes.flatList.props?.onScroll?.(makeScrollEvent(1340, 2060, 600));
    });
    expect(container.findByTestId('chat-scroll-to-bottom')).not.toBeNull();

    await act(async () => {
      testProbes.flatList.props?.onContentSizeChange?.(390, 2080);
    });
    expect(testProbes.flatList.scrollToEnd).not.toHaveBeenCalled();

    // 松手停留在非底部位置后，内容继续增长仍不抢手势
    await act(async () => {
      testProbes.flatList.props?.onScrollEndDrag?.(makeScrollEvent(1340, 2080, 600));
      testProbes.flatList.props?.onContentSizeChange?.(390, 2140);
    });
    expect(testProbes.flatList.scrollToEnd).not.toHaveBeenCalled();
    expect(container.findByTestId('chat-scroll-to-bottom')).not.toBeNull();

    // 2) 点击 chat-scroll-to-bottom 按钮恢复吸底并隐藏按钮，后续内容增长恢复 scrollToEnd({ animated: false })
    const scrollToBottomHandler = testProbes.pressableHandlers.get('chat-scroll-to-bottom');
    expect(scrollToBottomHandler).toBeTypeOf('function');
    await act(async () => {
      scrollToBottomHandler?.();
    });
    expect(testProbes.flatList.scrollToEnd).toHaveBeenCalledWith({ animated: true });
    expect(container.findByTestId('chat-scroll-to-bottom')).toBeNull();

    testProbes.flatList.scrollToEnd.mockClear();
    await act(async () => {
      testProbes.flatList.props?.onContentSizeChange?.(390, 2220);
    });
    expect(testProbes.flatList.scrollToEnd).toHaveBeenCalledWith({ animated: false });

    // 3) 再次拖拽上滑后，通过主动下滑至底部（distanceFromBottom < 24）恢复吸底
    await act(async () => {
      testProbes.flatList.props?.onScroll?.(makeScrollEvent(1620, 2220, 600));
      testProbes.flatList.props?.onScrollBeginDrag?.();
      testProbes.flatList.props?.onScroll?.(makeScrollEvent(1400, 2220, 600));
      testProbes.flatList.props?.onScrollEndDrag?.(makeScrollEvent(1400, 2220, 600));
    });
    expect(container.findByTestId('chat-scroll-to-bottom')).not.toBeNull();

    await act(async () => {
      testProbes.flatList.props?.onScrollBeginDrag?.();
      testProbes.flatList.props?.onScroll?.(makeScrollEvent(1610, 2220, 600));
      testProbes.flatList.props?.onScrollEndDrag?.(makeScrollEvent(1610, 2220, 600));
    });
    expect(container.findByTestId('chat-scroll-to-bottom')).toBeNull();
    testProbes.flatList.scrollToEnd.mockClear();
    await act(async () => {
      testProbes.flatList.props?.onContentSizeChange?.(390, 2300);
    });
    expect(testProbes.flatList.scrollToEnd).toHaveBeenCalledWith({ animated: false });

    // 4) contentShrunk 内容缩减豁免：即使高度骤减使 distanceFromBottom >= 120 也不误关吸底或弹出按钮
    await act(async () => {
      testProbes.flatList.props?.onScroll?.(makeScrollEvent(1700, 2300, 600));
      // 模拟折叠长代码块导致 contentSize.height 缩减至 1900，同时 offsetY 稍微下降
      testProbes.flatList.props?.onScroll?.(makeScrollEvent(1150, 1900, 600));
    });
    expect(container.findByTestId('chat-scroll-to-bottom')).toBeNull();
    testProbes.flatList.scrollToEnd.mockClear();
    await act(async () => {
      testProbes.flatList.props?.onContentSizeChange?.(390, 1950);
    });
    expect(testProbes.flatList.scrollToEnd).toHaveBeenCalledWith({ animated: false });

    // 5) 切换 activeConversationId 后重置吸底与拖拽态并隐藏按钮
    await act(async () => {
      testProbes.flatList.props?.onScrollBeginDrag?.();
      testProbes.flatList.props?.onScroll?.(makeScrollEvent(900, 1950, 600));
    });
    expect(container.findByTestId('chat-scroll-to-bottom')).not.toBeNull();

    await act(async () => {
      await mutateSessionForTest(session, (ws) => ({
        ...ws,
        activeConversationId: conv2Id,
        messages: ws.conversations.find((c) => c.id === conv2Id)?.messages ?? [],
      }));
    });
    // 清除 WorkspaceSession.scheduleDeferredSave 创建的原生防抖定时器，避免进入 fake timers 后泄漏
    await session.flush();
    expect(container.findByTestId('chat-scroll-to-bottom')).toBeNull();
    testProbes.flatList.scrollToEnd.mockClear();
    await act(async () => {
      testProbes.flatList.props?.onContentSizeChange?.(390, 900);
    });
    expect(testProbes.flatList.scrollToEnd).toHaveBeenCalledWith({ animated: false });

    // 6) onScrollToIndexFailed 触发回退 scrollToOffset({ animated: false }) 与定时重试 scrollToIndex
    vi.useFakeTimers();
    await act(async () => {
      testProbes.flatList.props?.onScrollToIndexFailed?.({
        index: 0,
        averageItemLength: 120,
      });
    });
    expect(testProbes.flatList.scrollToOffset).toHaveBeenCalledWith({
      offset: 0,
      animated: false,
    });
    expect(testProbes.flatList.scrollToIndex).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(60);
    });
    expect(testProbes.flatList.scrollToIndex).toHaveBeenCalledWith({
      index: 0,
      animated: true,
      viewPosition: 0.2,
    });
    vi.useRealTimers();
    await session.flush();
  });
});
