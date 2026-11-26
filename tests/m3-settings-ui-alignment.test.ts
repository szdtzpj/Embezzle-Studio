import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  act,
  createElement,
  forwardRef,
  useEffect,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryWorkspacePersistenceAdapter } from '../src/app/workspace/adapters/memoryWorkspacePersistenceAdapter';
import { WorkspaceSession } from '../src/app/workspace/WorkspaceSession';
import { WorkspaceSessionProvider } from '../src/app/workspace/WorkspaceSessionProvider';
import { createDefaultWorkspace } from '../src/data/providerCatalog';
import type {
  ProviderAuthHeaderMode,
  ProviderImageApiMode,
  ProviderKind,
  ProviderProfile,
} from '../src/domain/types';
import { ChatProvider } from '../src/features/chat/ChatProvider';
import { createProductionChatAudioAdapter } from '../src/features/chat/orchestration/ChatAudioAdapter';
import type { ProviderAdapterRegistry } from '../src/features/chat/orchestration/ProviderAdapterRegistry';
import { ProjectsConversationsProvider } from '../src/features/projects/ProjectsConversationsProvider';
import { FirstRunSetupWizard } from '../src/features/settings/FirstRunSetupWizard';
import { SettingsPane } from '../src/features/settings/SettingsPane';
import { SettingsProductivityProvider } from '../src/features/settings/SettingsProductivityProvider';
import { useSettingsLauncher } from '../src/features/settings/useSettingsLauncher';
import type { SettingsScreenModel } from '../src/features/settings/internal/SettingsScreen';
import { useSettingsScreenModel } from '../src/features/settings/internal/useSettingsScreenModel';
import { resolveImageApiMode } from '../src/services/imageGeneration';
import {
  PROVIDER_CUSTOM_HEADER_LIMITS,
  isSensitiveCustomHeaderName,
  resolveProviderAuthHeaders,
  validateProviderCustomHeaders,
} from '../src/services/providerSetup';
import { AppearanceProvider } from '../src/ui/appearance/AppearanceProvider';
import { AppDialogHost } from '../src/ui/components/AppDialogHost';
import { ModelAvatar } from '../src/ui/components/ModelAvatar';
import { ProviderDetailScreen } from '../src/ui/screens/settings/ProviderDetailScreen';
import { KelivoThemeProvider } from '../src/ui/theme';
import { formatCompactModelName, modelIconKey } from '../src/ui/utils/modelDisplay';

const loadCjs = createRequire(import.meta.url);
const { createRoot } = loadCjs('react-dom/client') as {
  createRoot: (container: unknown) => {
    render: (element: ReactElement) => void;
    unmount: () => void;
  };
};
const prevPngExtensionHandler = loadCjs.extensions['.png'];
loadCjs.extensions['.png'] = (mod: { exports: unknown }) => {
  mod.exports = 1;
};

function elWithChildren<P extends { children?: ReactNode }>(
  component: ComponentType<P>,
  props: Omit<P, 'children'>,
  ...children: ReactNode[]
): ReactElement {
  return createElement(component as ComponentType<Omit<P, 'children'>>, props, ...children);
}

// -------------------- 轻量真实 DOM 挂载桩 --------------------
class StubNode {
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
    if (!referenceNode) return this.appendChild(newNode);
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
    if (index === -1) return this.appendChild(newNode);
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

  contains(other: StubNode | null): boolean {
    let cur = other;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }

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

const uiHooks = vi.hoisted(() => {
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
    pressByTestId: new Map<string, () => void>(),
    pressByLabel: new Map<string, () => void>(),
    pressByText: new Map<string, () => void>(),
    changeTextByTestId: new Map<string, (text: string) => void>(),
    disabledByTestId: new Map<string, boolean>(),
    keyboardDismissSpy: vi.fn(),
  };
});

function extractTextFromChildren(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(extractTextFromChildren).join('');
  }
  if (node && typeof node === 'object' && 'props' in node) {
    const element = node as { props?: { children?: ReactNode } };
    return extractTextFromChildren(element.props?.children);
  }
  return '';
}

vi.mock('react-native', () => {
  const makeHost = (tag: string, kind: string) =>
    forwardRef<unknown, Record<string, unknown>>(function MockRnHost(props, ref) {
      const {
        children,
        testID,
        accessibilityLabel,
        accessibilityRole,
        accessibilityState,
        accessibilityLiveRegion,
        disabled,
        onPress,
        onChangeText,
        value,
        placeholder,
        secureTextEntry,
      } = props;
      const invokePress = () => {
        if (!disabled && typeof onPress === 'function') {
          (onPress as (event: { stopPropagation: () => void }) => void)({
            stopPropagation: () => undefined,
          });
        }
      };
      if (typeof testID === 'string') {
        uiHooks.disabledByTestId.set(testID, Boolean(disabled));
        if (typeof onPress === 'function') {
          uiHooks.pressByTestId.set(testID, invokePress);
        }
        if (typeof onChangeText === 'function') {
          uiHooks.changeTextByTestId.set(testID, onChangeText as (text: string) => void);
        }
      }
      if (typeof accessibilityLabel === 'string' && typeof onPress === 'function') {
        uiHooks.pressByLabel.set(accessibilityLabel, invokePress);
      }
      if (typeof onPress === 'function') {
        const text = extractTextFromChildren(children as ReactNode).trim();
        if (text) {
          uiHooks.pressByText.set(text, invokePress);
        }
      }
      return createElement(
        tag,
        {
          ref,
          'data-rn-kind': kind,
          ...(testID ? { 'data-testid': String(testID) } : {}),
          ...(accessibilityLabel ? { 'aria-label': String(accessibilityLabel) } : {}),
          ...(accessibilityRole ? { role: String(accessibilityRole) } : {}),
          ...(accessibilityState
            ? { 'data-a11y-state': JSON.stringify(accessibilityState) }
            : {}),
          ...(accessibilityLiveRegion
            ? { 'aria-live': String(accessibilityLiveRegion) }
            : {}),
          ...(disabled ? { 'aria-disabled': 'true' } : {}),
          ...(placeholder ? { 'data-placeholder': String(placeholder) } : {}),
          ...(value !== undefined ? { 'data-value': String(value) } : {}),
          ...(secureTextEntry !== undefined ? { 'data-secure': String(Boolean(secureTextEntry)) } : {}),
        },
        children as ReactNode
      );
    });

  return {
    Platform: {
      OS: 'ios',
      select: (spec: Record<string, unknown>) => spec.ios ?? spec.default,
    },
    StyleSheet: {
      create: <T extends Record<string, unknown>>(styles: T): T => styles,
      flatten: (s: unknown) => s ?? {},
      absoluteFill: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
      hairlineWidth: 0.5,
    },
    Dimensions: {
      get: () => ({ width: 390, height: 844 }),
    },
    useWindowDimensions: () => ({ width: 390, height: 844 }),
    useColorScheme: () => 'light',
    BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
    InteractionManager: {
      runAfterInteractions: (fn: () => void) => {
        fn();
        return { cancel: () => undefined };
      },
    },
    Share: { share: async () => ({ action: 'sharedAction' }) },
    Keyboard: {
      addListener: () => ({ remove: () => undefined }),
      dismiss: () => uiHooks.keyboardDismissSpy(),
    },
    AppState: {
      currentState: 'active',
      addEventListener: () => ({ remove: () => undefined }),
    },
    Linking: { openURL: async () => undefined },
    NativeModules: {},
    View: makeHost('div', 'View'),
    Text: makeHost('span', 'Text'),
    TextInput: makeHost('textarea', 'TextInput'),
    Pressable: makeHost('div', 'Pressable'),
    ScrollView: makeHost('div', 'ScrollView'),
    Switch: makeHost('input', 'Switch'),
    KeyboardAvoidingView: makeHost('div', 'KeyboardAvoidingView'),
    ActivityIndicator: makeHost('div', 'ActivityIndicator'),
    Image: makeHost('img', 'Image'),
    SafeAreaView: makeHost('div', 'SafeAreaView'),
    FlatList: makeHost('div', 'FlatList'),
    Modal: makeHost('div', 'Modal'),
  };
});

vi.mock('moti', () => ({
  AnimatePresence: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  MotiView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('react-native-gesture-handler', () => ({
  GestureDetector: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Gesture: {
    Pan: () => {
      const chain = {
        activeOffsetX: () => chain,
        onStart: () => chain,
        onUpdate: () => chain,
        onEnd: () => chain,
        onFinalize: () => chain,
      };
      return chain;
    },
  },
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('react-native-reanimated', () => ({
  default: {
    View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
    createAnimatedComponent: <P extends object>(comp: ComponentType<P>) => comp,
  },
  Easing: { out: (fn: unknown) => fn, inOut: (fn: unknown) => fn, cubic: () => 0, quad: () => 0 },
  Extrapolation: { CLAMP: 'clamp' },
  LinearTransition: { duration: () => ({}) },
  interpolate: () => 0,
  runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
  useAnimatedStyle: () => ({}),
  useReducedMotion: () => true,
  useSharedValue: <T,>(initial: T) => ({ value: initial }),
  withTiming: <T,>(toValue: T) => toValue,
  withSpring: <T,>(toValue: T) => toValue,
  cancelAnimation: () => undefined,
}));

vi.mock('react-native-svg', () => ({
  default: ({ children }: { children?: ReactNode }) =>
    createElement('svg', { 'data-svg': 'root' }, children),
  Svg: ({ children }: { children?: ReactNode }) =>
    createElement('svg', { 'data-svg': 'root' }, children),
  Circle: () => createElement('circle'),
  Path: () => createElement('path'),
  Rect: () => createElement('rect'),
}));

vi.mock('expo', () => ({ useEvent: () => undefined }));
vi.mock('expo-modules-core', () => ({
  Platform: { OS: 'ios' },
  NativeModulesProxy: {},
  requireNativeModule: () => ({}),
  requireOptionalNativeModule: () => null,
}));
vi.mock('expo-background-task', () => ({
  BackgroundTaskResult: { Success: 1, Failed: 2 },
  registerTaskAsync: async () => undefined,
  unregisterTaskAsync: async () => undefined,
}));
vi.mock('expo-task-manager', () => ({
  isTaskDefined: () => false,
  defineTask: () => undefined,
  isTaskRegisteredAsync: async () => false,
}));
vi.mock('expo-notifications', () => ({
  getPermissionsAsync: async () => ({ status: 'granted' }),
  requestPermissionsAsync: async () => ({ status: 'granted' }),
  scheduleNotificationAsync: async () => 'notif-id',
  setNotificationHandler: () => undefined,
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: {}, manifest: null } }));
vi.mock('expo-asset', () => ({
  Asset: { fromModule: () => ({ downloadAsync: async () => undefined }) },
}));
vi.mock('expo-blur', () => ({
  BlurView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
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
vi.mock('expo-secure-store', () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => undefined,
  deleteItemAsync: async () => undefined,
}));
vi.mock('expo-sharing', () => ({
  isAvailableAsync: async () => false,
  shareAsync: async () => undefined,
}));
vi.mock('expo-video', () => ({
  VideoView: () => null,
  useVideoPlayer: () => ({ play: () => undefined, pause: () => undefined }),
}));
vi.mock('expo-crypto', () => ({
  randomUUID: () => '00000000-0000-4000-8000-000000000000',
  getRandomBytesAsync: async (byteCount: number) => {
    const out = new Uint8Array(byteCount);
    for (let i = 0; i < byteCount; i += 1) {
      out[i] = (i * 31 + 17) & 0xff;
    }
    return out;
  },
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  },
}));
vi.mock('expo-document-picker', () => ({
  getDocumentAsync: async () => ({ canceled: true, assets: [] }),
}));
vi.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: async () => ({ canceled: true, assets: [] }),
  requestMediaLibraryPermissionsAsync: async () => ({ granted: true }),
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: async () => undefined }));
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

vi.mock('../assets/splash-icon.png', () => ({ default: 1 }));

vi.mock('lucide-react-native', () => {
  const Icon = () => createElement('span');
  return new Proxy(
    { __esModule: true },
    {
      get(target, prop) {
        if (prop in target) {
          return target[prop as keyof typeof target];
        }
        if (prop === 'then' || typeof prop === 'symbol') {
          return undefined;
        }
        return Icon;
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
          value: Icon,
        };
      },
    }
  );
});

// 严格对齐 R3 测试 mock 白名单：包含单色 Grok（无 .Color），绝不提供 XAI
vi.mock('@lobehub/icons-rn', () => {
  const makeColorBrand = (tag: string) => {
    const Icon = () => createElement('span', { 'data-brand-icon': tag });
    return Object.assign(Icon, { Color: Icon });
  };
  const makeMonoBrand = (tag: string) => {
    const Icon = ({ color }: { color?: string }) =>
      createElement('span', {
        'data-brand-icon': tag,
        ...(color ? { 'data-color': color } : {}),
      });
    return Icon;
  };
  return {
    __esModule: true,
    Bailian: makeColorBrand('Bailian'),
    Bing: makeColorBrand('Bing'),
    ChatGLM: makeColorBrand('ChatGLM'),
    Claude: makeColorBrand('Claude'),
    DeepSeek: makeColorBrand('DeepSeek'),
    Doubao: makeColorBrand('Doubao'),
    Gemini: makeColorBrand('Gemini'),
    Grok: makeMonoBrand('Grok'),
    Kimi: makeColorBrand('Kimi'),
    Minimax: makeColorBrand('Minimax'),
    NewAPI: makeColorBrand('NewAPI'),
    OpenAI: makeMonoBrand('OpenAI'),
    Qwen: makeColorBrand('Qwen'),
    Tavily: makeColorBrand('Tavily'),
    Volcengine: makeColorBrand('Volcengine'),
    Zhipu: makeColorBrand('Zhipu'),
  };
});

const savedGlobals: Array<{ key: PropertyKey; descriptor: PropertyDescriptor | undefined }> = [];

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

function createStubDom() {
  const doc = new StubDocument();
  class StubIFrame extends StubElement {}
  const win = {
    document: doc,
    Element: StubElement,
    HTMLElement: StubElement,
    HTMLIFrameElement: StubIFrame,
    Node: StubNode,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  doc.defaultView = win;
  setGlobalForTest('window', win);
  setGlobalForTest('document', doc);
  setGlobalForTest('Element', StubElement);
  setGlobalForTest('HTMLElement', StubElement);
  setGlobalForTest('HTMLIFrameElement', StubIFrame);
  setGlobalForTest('Node', StubNode);
  setGlobalForTest('IS_REACT_ACT_ENVIRONMENT', true);
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  return { doc, container };
}

function createProviderAdapterRegistryStub(): ProviderAdapterRegistry {
  return {
    resolve: () => ({
      sendChat: async () => undefined,
      generateVideo: async () => ({
        taskId: 'task-1',
        status: 'succeeded',
        outputs: [],
      }),
      queryVideo: async () => ({
        taskId: 'task-1',
        status: 'succeeded',
        outputs: [],
      }),
    }),
  } as unknown as ProviderAdapterRegistry;
}

describe('M3.2b2 Settings UI 对接、单源校验与 Grok 品牌展示', () => {
  const activeRoots: Array<{ unmount: () => void }> = [];
  const activeSessions: WorkspaceSession[] = [];

  beforeEach(() => {
    uiHooks.pressByTestId.clear();
    uiHooks.pressByLabel.clear();
    uiHooks.pressByText.clear();
    uiHooks.changeTextByTestId.clear();
    uiHooks.disabledByTestId.clear();
    uiHooks.keyboardDismissSpy.mockReset();
  });

  afterAll(() => {
    if (prevPngExtensionHandler) {
      loadCjs.extensions['.png'] = prevPngExtensionHandler;
    } else {
      delete loadCjs.extensions['.png'];
    }
    if (uiHooks.prevDevDescriptor) {
      Object.defineProperty(globalThis, '__DEV__', uiHooks.prevDevDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, '__DEV__');
    }
  });

  afterEach(async () => {
    try {
      while (activeRoots.length > 0) {
        const root = activeRoots.pop();
        if (root) {
          await act(async () => {
            root.unmount();
          });
        }
      }
      while (activeSessions.length > 0) {
        const session = activeSessions.pop();
        if (session) {
          session.dispose();
          await session.settle();
        }
      }
    } finally {
      uiHooks.pressByTestId.clear();
      uiHooks.pressByLabel.clear();
      uiHooks.pressByText.clear();
      uiHooks.changeTextByTestId.clear();
      uiHooks.disabledByTestId.clear();
      uiHooks.keyboardDismissSpy.mockReset();
      vi.useRealTimers();
      restoreGlobals();
      vi.restoreAllMocks();
    }
  });

  async function createReadySession(workspace = createDefaultWorkspace()) {
    const adapter = new MemoryWorkspacePersistenceAdapter({ initial: workspace });
    const session = new WorkspaceSession({ persistence: adapter, autoBoot: false });
    await session.boot();
    activeSessions.push(session);
    return { session, adapter };
  }

  async function renderWithProviders(
    session: WorkspaceSession,
    adapter: MemoryWorkspacePersistenceAdapter,
    children: ReactNode
  ): Promise<{ doc: StubDocument; container: StubElement }> {
    const { doc, container } = createStubDom();
    const root = createRoot(container);
    activeRoots.push(root);

    await act(async () => {
      root.render(
        elWithChildren(
          AppearanceProvider,
          {},
          elWithChildren(
            WorkspaceSessionProvider,
            { adapters: { persistence: adapter }, session },
            elWithChildren(
              ProjectsConversationsProvider,
              {},
              elWithChildren(
                ChatProvider,
                {
                  adapters: {
                    lifecycle: {
                      getState: () => 'foreground' as const,
                      subscribe: () => () => undefined,
                    },
                    providers: createProviderAdapterRegistryStub(),
                    audio: createProductionChatAudioAdapter(),
                  },
                },
                elWithChildren(SettingsProductivityProvider, {}, children)
              )
            )
          ),
          createElement(AppDialogHost)
        )
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    return { doc, container };
  }

  it('S1: 精确识别 Grok / xAI 模型与服务商名称并防止词根误判', () => {
    expect(modelIconKey('grok-4.7')).toBe('grok');
    expect(modelIconKey('grok-4.3')).toBe('grok');
    expect(modelIconKey('grok-4.5')).toBe('grok');
    expect(modelIconKey('grok-3-mini')).toBe('grok');
    expect(modelIconKey('grok-imagine-image-2.0')).toBe('grok');
    expect(modelIconKey('x-ai/grok-4')).toBe('grok');
    expect(modelIconKey('xai-grok')).toBe('grok');
    expect(modelIconKey(undefined, 'xAI Grok')).toBe('grok');
    expect(modelIconKey(undefined, 'https://api.x.ai/v1')).toBe('grok');
    expect(modelIconKey('x-ai/grok-4', 'New API Relay')).toBe('grok');
    expect(modelIconKey('grok-4.7', 'Custom OpenAI-Compatible')).toBe('grok');
    expect(modelIconKey('claude-sonnet-4', 'Custom OpenAI-Compatible')).toBe('claude');
    expect(modelIconKey(undefined, 'Custom OpenAI-Compatible')).toBe('openai');
    expect(modelIconKey('o3', 'Custom OpenAI-Compatible')).toBe('openai');
    expect(modelIconKey('o4-mini', 'New API Relay')).toBe('openai');

    // 防误判边界测试
    expect(modelIconKey('ngrok-tunnel')).not.toBe('grok');
    expect(modelIconKey('grokking-7b')).not.toBe('grok');
    expect(modelIconKey('pixai-v2')).not.toBe('grok');
    expect(modelIconKey('flex.ai')).not.toBe('grok');
    expect(modelIconKey('max-ai/foo')).not.toBe('grok');
    expect(modelIconKey('模型未记录', 'xAI Grok')).toBe('unknown');

    // 紧凑展示名称与 18 字符截断
    expect(formatCompactModelName('grok-4.7')).toBe('Grok 4.7');
    expect(formatCompactModelName('grok-4.3')).toBe('Grok 4.3');
    expect(formatCompactModelName('x-ai/grok-4')).toBe('Grok 4');
    expect(formatCompactModelName('xai-grok')).toBe('Grok');
    expect(formatCompactModelName('grok-imagine-image-2.0')).toBe('Grok imagine-im...');
    expect(formatCompactModelName('ngrok-tunnel')).toBe('Ngrok-tunnel');
    expect(formatCompactModelName('grokking-7b')).toBe('Grokking-7b');
  });

  it('S2: ModelAvatar 使用单色 Grok 图标且源码无 Grok.Color 与 XAI 导出依赖', async () => {
    const { container } = createStubDom();
    const root = createRoot(container);
    activeRoots.push(root);

    act(() => {
      root.render(
        elWithChildren(
          KelivoThemeProvider,
          { scheme: 'light' },
          createElement(ModelAvatar, { modelId: 'grok-4.7' }),
          createElement(ModelAvatar, { modelId: 'grok-imagine-image-2.0' }),
          createElement(ModelAvatar, { modelId: 'x-ai/grok-4' }),
          createElement(ModelAvatar, { modelId: undefined, providerName: 'xAI Grok' }),
          createElement(ModelAvatar, { modelId: 'unrecognized-model' })
        )
      );
    });

    const grokNodes = container.findAll((el) => el.getAttribute('data-brand-icon') === 'Grok');
    expect(grokNodes).toHaveLength(4);
    for (const node of grokNodes) {
      expect(node.getAttribute('data-color')).toBeTruthy();
    }

    const avatarSource = await readFile(path.resolve('src/ui/components/ModelAvatar.tsx'), 'utf8');
    expect(avatarSource).not.toContain('Grok.Color');
    expect(avatarSource).not.toContain('XAI');
  });

  it('S3: FirstRunSetupWizard 展示全部 9 大服务商预设且均有专属协议描述', async () => {
    const { session, adapter } = await createReadySession();
    const { doc } = await renderWithProviders(
      session,
      adapter,
      createElement(FirstRunSetupWizard, {
        visible: true,
        onUseSample: () => undefined,
        onOpenSettings: () => undefined,
        onClose: () => undefined,
      })
    );

    const text = doc.body.textContent;
    expect(text).toContain('Volcengine Ark');
    expect(text).toContain('Alibaba Bailian');
    expect(text).toContain('OpenAI');
    expect(text).toContain('Anthropic Claude');
    expect(text).toContain('Google Gemini');
    expect(text).toContain('xAI Grok');
    expect(text).toContain('DeepSeek');
    expect(text).toContain('New API Relay');
    expect(text).toContain('Custom OpenAI-Compatible');

    expect(text).toContain('Anthropic Claude · 原生 Messages 与思考');
    expect(text).toContain('Google Gemini · 原生多模态、搜索与生图');
    expect(text).toContain('xAI Grok · Responses 与 Web / X 搜索');
    expect(text).toContain('DeepSeek · 深度推理与官方联网');
    // 只有 1 个 custom 服务商允许出现“自定义 OpenAI 兼容接口”
    expect(text.match(/自定义 OpenAI 兼容接口/g)).toHaveLength(1);
  });

  it('S4: FirstRunSetupWizard 简单模式隐藏官方 Endpoint、展示鉴权提示，并支持跳过持久化', async () => {
    const { session, adapter } = await createReadySession();
    const onClose = vi.fn();
    const { doc } = await renderWithProviders(
      session,
      adapter,
      createElement(FirstRunSetupWizard, {
        visible: true,
        onUseSample: () => undefined,
        onOpenSettings: () => undefined,
        onClose,
      })
    );

    await act(async () => {
      uiHooks.pressByText.get('xAI GrokxAI Grok · Responses 与 Web / X 搜索')?.();
    });
    await act(async () => {
      uiHooks.pressByText.get('下一步：填写 API Key')?.();
    });

    expect(doc.body.textContent).toContain('官方 Endpoint');
    expect(doc.body.textContent).toContain('https://api.x.ai/v1');
    expect(doc.body.textContent).not.toContain('API Base URL');

    // 返回选择 New API Relay 后应暴露可编辑 Base URL 输入框
    await act(async () => {
      uiHooks.pressByText.get('返回选择服务商')?.();
    });
    await act(async () => {
      uiHooks.pressByText.get('New API RelayNew API / One API 中转')?.();
    });
    await act(async () => {
      uiHooks.pressByText.get('下一步：填写 API Key')?.();
    });
    expect(doc.body.textContent).toContain('API Base URL');

    // 关闭向导应落盘 onboarding.status = 'dismissed'
    await act(async () => {
      uiHooks.pressByLabel.get('暂时关闭配置向导')?.();
    });
    await session.flush();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(adapter.getStoredSnapshot()?.onboarding.status).toBe('dismissed');
  });

  it('S5: ProviderDetailScreen 补齐 9 大 ProviderKind 且 SettingsSelect 使用 ScrollView 防小屏裁切', async () => {
    const { container, doc } = createStubDom();
    const root = createRoot(container);
    activeRoots.push(root);

    const onChangeBindingDraft = vi.fn();
    const defaultOpenAi = createDefaultWorkspace().providers.find((p) => p.id === 'openai')!;
    const baseProps = {
      readOnly: false,
      provider: defaultOpenAi,
      experienceMode: 'simple' as const,
      addedModelCount: 1,
      candidateModelCount: 0,
      refreshingModels: false,
      notice: '',
      nameDraft: defaultOpenAi.name,
      kindDraft: 'anthropic' as ProviderKind,
      baseUrlDraft: 'https://api.anthropic.com/v1',
      apiKeyDraft: '',
      authHeaderModeDraft: 'x-api-key' as ProviderAuthHeaderMode,
      imageApiModeDraft: 'unsupported' as ProviderImageApiMode,
      customHeadersDraft: [],
      customHeadersValidation: validateProviderCustomHeaders([]),
      endpointInspection: {
        valid: true,
        family: 'anthropic-official' as const,
        policy: 'allowed' as const,
        official: true,
        normalizedBaseUrl: 'https://api.anthropic.com/v1',
        kindCompatible: true,
        modelDiscoveryMode: 'official-model-list' as const,
        errors: [],
        warnings: [],
      },
      onBack: () => undefined,
      onOpenModels: () => undefined,
      onSetNameDraft: () => undefined,
      onChangeBindingDraft,
      onSetApiKeyDraft: () => undefined,
      onSetAuthHeaderModeDraft: () => undefined,
      onSetImageApiModeDraft: () => undefined,
      onAddCustomHeaderDraft: () => undefined,
      onUpdateCustomHeaderDraft: () => undefined,
      onRemoveCustomHeaderDraft: () => undefined,
      onSaveProviderDraft: () => undefined,
      onRefreshModels: () => undefined,
    };

    await act(async () => {
      root.render(
        elWithChildren(
          KelivoThemeProvider,
          { scheme: 'light' },
          createElement(ProviderDetailScreen, baseProps),
          createElement(AppDialogHost)
        )
      );
    });

    // 确保内置协议类型正确回显，不回退到 '请选择'
    expect(doc.body.textContent).toContain('Anthropic Claude');
    expect(doc.body.textContent).not.toContain('请选择');

    // 打开协议选择器
    await act(async () => {
      uiHooks.pressByLabel.get('协议类型')?.();
    });
    expect(uiHooks.keyboardDismissSpy).toHaveBeenCalledTimes(1);

    const scrollViews = doc.body.findAll((el) => el.getAttribute('data-rn-kind') === 'ScrollView');
    expect(scrollViews.length).toBeGreaterThanOrEqual(2);
    const selectText = doc.body.textContent;
    for (const label of [
      'OpenAI',
      'Anthropic Claude',
      'Google Gemini',
      'xAI Grok',
      'DeepSeek',
      '火山方舟',
      '阿里百炼',
      'New API 中转',
      '兼容接口',
    ]) {
      expect(selectText).toContain(label);
    }

    await act(async () => {
      uiHooks.pressByText.get('xAI Grok')?.();
    });
    expect(onChangeBindingDraft).toHaveBeenCalledWith({ kind: 'xai-grok' });

    const selectSource = await readFile(
      path.resolve('src/ui/components/settings/SettingsSelect.tsx'),
      'utf8'
    );
    expect(selectSource).toContain('<ScrollView');
    expect(selectSource).toContain('Keyboard.dismiss()');
  });

  it('S6: customHeaders 编辑器支持增删改启停、敏感头掩码警告与 readOnly 禁用', async () => {
    const { container, doc } = createStubDom();
    const root = createRoot(container);
    activeRoots.push(root);

    const onAdd = vi.fn();
    const onUpdate = vi.fn();
    const onRemove = vi.fn();
    const provider = createDefaultWorkspace().providers.find((p) => p.id === 'new-api-relay')!;
    const drafts = [
      { id: 'h-1', key: 'X-Tenant-Id', value: 'tenant-a', enabled: true },
      { id: 'h-2', key: 'Authorization', value: 'Bearer secret-xyz', enabled: true },
    ];

    const renderScreen = async (readOnly: boolean) => {
      await act(async () => {
        root.render(
          elWithChildren(
            KelivoThemeProvider,
            { scheme: 'light' },
            createElement(ProviderDetailScreen, {
              readOnly,
              provider,
              experienceMode: 'advanced',
              addedModelCount: 0,
              candidateModelCount: 0,
              refreshingModels: false,
              notice: '',
              nameDraft: provider.name,
              kindDraft: 'new-api-relay',
              baseUrlDraft: 'https://relay.example.com/v1',
              apiKeyDraft: '',
              authHeaderModeDraft: 'custom',
              imageApiModeDraft: 'openai-images',
              customHeadersDraft: drafts,
              customHeadersValidation: validateProviderCustomHeaders(drafts),
              endpointInspection: {
                valid: true,
                family: 'openai-compatible-custom',
                policy: 'allowed',
                official: false,
                normalizedBaseUrl: 'https://relay.example.com/v1',
                kindCompatible: true,
                modelDiscoveryMode: 'optional-compatible-list',
                errors: [],
                warnings: [],
              },
              onBack: () => undefined,
              onOpenModels: () => undefined,
              onSetNameDraft: () => undefined,
              onChangeBindingDraft: () => undefined,
              onSetApiKeyDraft: () => undefined,
              onSetAuthHeaderModeDraft: () => undefined,
              onSetImageApiModeDraft: () => undefined,
              onAddCustomHeaderDraft: onAdd,
              onUpdateCustomHeaderDraft: onUpdate,
              onRemoveCustomHeaderDraft: onRemove,
              onSaveProviderDraft: () => undefined,
              onRefreshModels: () => undefined,
            }),
            createElement(AppDialogHost)
          )
        );
      });
    };

    await renderScreen(false);

    expect(doc.body.textContent).toContain('敏感鉴权头将覆盖默认 API Key 同名请求头；加密备份导出时会自动剥离。');
    // 第 2 条敏感头默认掩码
    expect(doc.body.findByTestId('provider-custom-header-value-1')?.getAttribute('data-secure')).toBe(
      'true'
    );
    await act(async () => {
      uiHooks.pressByTestId.get('provider-custom-header-secret-toggle-1')?.();
    });
    expect(doc.body.findByTestId('provider-custom-header-value-1')?.getAttribute('data-secure')).toBe(
      'false'
    );

    await act(async () => {
      uiHooks.pressByTestId.get('provider-custom-header-add')?.();
      uiHooks.changeTextByTestId.get('provider-custom-header-key-0')?.('X-Env');
      uiHooks.changeTextByTestId.get('provider-custom-header-value-0')?.('prod');
      uiHooks.pressByTestId.get('provider-custom-header-toggle-1')?.();
      uiHooks.pressByTestId.get('provider-custom-header-delete-0')?.();
    });

    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith('h-1', { key: 'X-Env' });
    expect(onUpdate).toHaveBeenCalledWith('h-1', { value: 'prod' });
    expect(onUpdate).toHaveBeenCalledWith('h-2', { enabled: false });
    expect(onRemove).toHaveBeenCalledWith('h-1');

    // 只读态禁用全部增删改启停控件
    await renderScreen(true);
    expect(uiHooks.disabledByTestId.get('provider-custom-header-add')).toBe(true);
    expect(uiHooks.disabledByTestId.get('provider-custom-header-toggle-1')).toBe(true);
    expect(uiHooks.disabledByTestId.get('provider-custom-header-delete-0')).toBe(true);
  });

  it('S7: 单源安全校验与 useSettingsScreenModel 阻断非法 customHeaders 且清空时不残留旧值', async () => {
    // 1. 直接验证单源 validateProviderCustomHeaders 对全量威胁向量的拦截
    expect(
      validateProviderCustomHeaders([{ key: 'Host', value: 'evil.example' }]).valid
    ).toBe(false);
    expect(
      validateProviderCustomHeaders([{ key: 'Cookie', value: 'a=1' }]).valid
    ).toBe(false);
    expect(
      validateProviderCustomHeaders([{ key: 'Content-Type', value: 'text/plain' }]).valid
    ).toBe(false);
    expect(
      validateProviderCustomHeaders([{ key: 'content-type', value: 'application/xml' }]).valid
    ).toBe(false);
    expect(
      validateProviderCustomHeaders([{ key: 'Proxy-Authorization', value: 'Basic abc' }]).valid
    ).toBe(false);
    expect(
      validateProviderCustomHeaders([{ key: 'X-Forwarded-For', value: '1.2.3.4' }]).valid
    ).toBe(false);
    expect(
      validateProviderCustomHeaders([{ key: 'Access-Control-Allow-Origin', value: '*' }]).valid
    ).toBe(false);
    expect(
      validateProviderCustomHeaders([{ key: 'Sec-Fetch-Site', value: 'same-origin' }]).valid
    ).toBe(false);
    expect(
      validateProviderCustomHeaders([{ key: '__proto__', value: 'pollute' }]).valid
    ).toBe(false);
    expect(
      validateProviderCustomHeaders([{ key: 'Invalid Header', value: 'v' }]).valid
    ).toBe(false);
    expect(
      validateProviderCustomHeaders([{ key: 'X-Test', value: 'abc\r\nX-Evil: 1' }]).valid
    ).toBe(false);
    expect(
      validateProviderCustomHeaders([{ key: 'X-Test', value: 'abc\0def' }]).valid
    ).toBe(false);
    expect(
      validateProviderCustomHeaders([{ key: '', value: 'non-empty' }]).valid
    ).toBe(false);
    expect(
      validateProviderCustomHeaders([
        { key: 'X-Trace', value: '1' },
        { key: 'x-trace', value: '2' },
      ]).valid
    ).toBe(false);
    expect(
      validateProviderCustomHeaders([{ key: 'x'.repeat(129), value: 'v' }]).valid
    ).toBe(false);
    expect(
      validateProviderCustomHeaders([{ key: 'X-Long', value: 'v'.repeat(4097) }]).valid
    ).toBe(false);
    const overLimitHeaders = Array.from(
      { length: PROVIDER_CUSTOM_HEADER_LIMITS.maxCount + 1 },
      (_, i) => ({ key: `X-Header-${i}`, value: '1' })
    );
    expect(validateProviderCustomHeaders(overLimitHeaders).valid).toBe(false);
    expect(isSensitiveCustomHeaderName('X-API-Key')).toBe(true);
    expect(isSensitiveCustomHeaderName('X-Tenant-Id')).toBe(false);

    // 2. 通过真实 useSettingsScreenModel 验证 Fail-Loud 阻断落盘与清空不残留
    const workspace = createDefaultWorkspace();
    const relay = workspace.providers.find((p) => p.id === 'new-api-relay')!;
    relay.baseUrl = 'https://relay.example.com/v1';
    relay.customHeaders = [{ key: 'X-Old-Tag', value: 'stale', enabled: true }];
    workspace.activeProviderId = 'new-api-relay';

    const { session, adapter } = await createReadySession(workspace);
    let latestModel: SettingsScreenModel | null = null;
    function ModelHarness() {
      const model = useSettingsScreenModel(() => undefined);
      useEffect(() => {
        latestModel = model;
      });
      return createElement('div');
    }

    await renderWithProviders(session, adapter, createElement(ModelHarness));

    // 提交非法禁用头 Host -> 阻断保存、提示错误、旧工作区不被污染
    await act(async () => {
      latestModel!.providers.updateCustomHeaderDraft(
        latestModel!.providers.customHeadersDraft[0].id,
        { key: 'Host', value: 'attacker.example' }
      );
    });
    await act(async () => {
      latestModel!.providers.saveDraft();
    });
    await session.flush();
    expect(latestModel!.status.notice).toContain('不允许配置系统或代理控制头');
    expect(
      adapter.getStoredSnapshot()?.providers.find((p) => p.id === 'new-api-relay')?.customHeaders
    ).toEqual([{ key: 'X-Old-Tag', value: 'stale', enabled: true }]);

    // 清空所有自定义头并保存 -> 必须从保存结果中移除旧 customHeaders，不能因 ...activeProvider 残留
    await act(async () => {
      latestModel!.providers.removeCustomHeaderDraft(
        latestModel!.providers.customHeadersDraft[0].id
      );
    });
    await act(async () => {
      latestModel!.providers.saveDraft();
    });
    await session.flush();
    const savedRelay = adapter.getStoredSnapshot()?.providers.find((p) => p.id === 'new-api-relay');
    expect(savedRelay?.customHeaders).toBeUndefined();
  });

  it('S8: 通过 SettingsPane 完整 UI 导航保存 authHeaderMode / imageApiMode / customHeaders 并回显', async () => {
    const workspace = createDefaultWorkspace();
    const relay = workspace.providers.find((p) => p.id === 'new-api-relay')!;
    relay.baseUrl = 'https://relay.example.com/v1';
    workspace.activeProviderId = 'new-api-relay';

    const { session, adapter } = await createReadySession(workspace);
    function OpenSettingsOnMount() {
      const { open } = useSettingsLauncher();
      useEffect(() => {
        open({ kind: 'providers' });
      }, [open]);
      return createElement(SettingsPane);
    }

    const { doc } = await renderWithProviders(session, adapter, createElement(OpenSettingsOnMount));

    // 验证 ProviderListScreen 中的 xAI Grok 行渲染出 Grok 图标
    expect(doc.body.findAll((el) => el.getAttribute('data-brand-icon') === 'Grok').length).toBeGreaterThanOrEqual(1);

    // 进入 New API Relay 详情页
    await act(async () => {
      uiHooks.pressByLabel.get('打开 New API Relay')?.();
    });
    expect(doc.body.textContent).toContain('高级协议与自定义请求头');

    // 选择 authHeaderMode = custom
    await act(async () => {
      uiHooks.pressByLabel.get('鉴权请求头模式')?.();
    });
    await act(async () => {
      uiHooks.pressByText.get('仅使用自定义请求头')?.();
    });

    // 选择 imageApiMode = unsupported
    await act(async () => {
      uiHooks.pressByLabel.get('生图接口协议')?.();
    });
    await act(async () => {
      uiHooks.pressByText.get('不支持原生生图')?.();
    });

    // 添加合法自定义头并保存
    await act(async () => {
      uiHooks.pressByTestId.get('provider-custom-header-add')?.();
    });
    await act(async () => {
      uiHooks.changeTextByTestId.get('provider-custom-header-key-0')?.('X-Relay-Token');
      uiHooks.changeTextByTestId.get('provider-custom-header-value-0')?.('tok-888');
    });
    await act(async () => {
      uiHooks.pressByTestId.get('provider-save-draft')?.();
    });
    await session.flush();

    const persistedRelay = adapter.getStoredSnapshot()?.providers.find((p) => p.id === 'new-api-relay');
    expect(persistedRelay?.authHeaderMode).toBe('custom');
    expect(persistedRelay?.imageApiMode).toBe('unsupported');
    expect(persistedRelay?.customHeaders).toEqual([
      { key: 'X-Relay-Token', value: 'tok-888', enabled: true },
    ]);

    // 重新通过新的 WorkspaceSession 挂载 SettingsPane 验证 3 个字段从持久化快照完整回显
    const { session: reloadedSession, adapter: reloadedAdapter } = await createReadySession(
      adapter.getStoredSnapshot()!
    );
    function ReopenRelayOnMount() {
      const { open } = useSettingsLauncher();
      useEffect(() => {
        open({ kind: 'providers' });
      }, [open]);
      return createElement(SettingsPane);
    }
    const { doc: reloadedDoc } = await renderWithProviders(
      reloadedSession,
      reloadedAdapter,
      createElement(ReopenRelayOnMount)
    );
    await act(async () => {
      uiHooks.pressByLabel.get('打开 New API Relay')?.();
    });
    expect(reloadedDoc.body.textContent).toContain('仅使用自定义请求头');
    expect(reloadedDoc.body.textContent).toContain('不支持原生生图');
    expect(
      reloadedDoc.body.findByTestId('provider-custom-header-key-0')?.getAttribute('data-value')
    ).toBe('X-Relay-Token');
    expect(
      reloadedDoc.body.findByTestId('provider-custom-header-value-0')?.getAttribute('data-value')
    ).toBe('tok-888');
  });

  it('S9: 非端点修改保活 apiKey 与模型缓存，切换 kind 安全联动默认端点与敏感头警告', async () => {
    const workspace = createDefaultWorkspace();
    const xai = workspace.providers.find((p) => p.id === 'xai-grok')!;
    xai.apiKey = 'xai-secret-key';
    workspace.activeProviderId = 'xai-grok';
    workspace.modelCandidatesByProvider['xai-grok'] = [
      { id: 'grok-4.7', name: 'Grok 4.7', capabilities: ['text', 'streaming'], source: 'remote' },
    ];

    const { session, adapter } = await createReadySession(workspace);
    let latestModel: SettingsScreenModel | null = null;
    function ModelHarness() {
      const model = useSettingsScreenModel(() => undefined);
      useEffect(() => {
        latestModel = model;
      });
      return createElement('div');
    }

    await renderWithProviders(session, adapter, createElement(ModelHarness));

    // (a) 仅修改 authHeaderMode / imageApiMode / customHeaders：不改端点指纹，保留 apiKey 与模型缓存
    await act(async () => {
      latestModel!.providers.setAuthHeaderModeDraft('bearer');
      latestModel!.providers.setImageApiModeDraft('xai-json');
      latestModel!.providers.addCustomHeaderDraft();
    });
    await act(async () => {
      latestModel!.providers.updateCustomHeaderDraft(
        latestModel!.providers.customHeadersDraft[0].id,
        { key: 'Authorization', value: 'Bearer override-xai' }
      );
    });
    await act(async () => {
      latestModel!.providers.saveDraft();
    });
    await session.flush();

    const savedXai = session.getSnapshot().providers.find((p) => p.id === 'xai-grok')!;
    expect(savedXai.apiKey).toBe('xai-secret-key');
    expect(savedXai.models.length).toBeGreaterThan(0);
    expect(adapter.getStoredSnapshot()?.modelCandidatesByProvider['xai-grok']).toHaveLength(1);

    // (b) 在简单模式下切换 kind 为 anthropic：联动官方默认 baseUrl、清空旧 apiKey 草稿并触发敏感头核对提醒
    await act(async () => {
      latestModel!.providers.changeBindingDraft({ kind: 'anthropic' });
    });
    expect(latestModel!.providers.kindDraft).toBe('anthropic');
    expect(latestModel!.providers.baseUrlDraft).toBe('https://api.anthropic.com/v1');
    expect(latestModel!.providers.apiKeyDraft).toBe('');
    expect(latestModel!.status.notice).toContain('请核对自定义请求头中的鉴权凭据');

    // (c) 切换到另一服务商（deepseek）：草稿深拷贝同步，不带入刚才未保存的 anthropic/customHeaders 草稿
    await act(async () => {
      await latestModel!.providers.select('deepseek');
    });
    expect(latestModel!.providers.kindDraft).toBe('deepseek');
    expect(latestModel!.providers.baseUrlDraft).toBe('https://api.deepseek.com/v1');
    expect(latestModel!.providers.customHeadersDraft).toEqual([]);
  });

  it('S10: authHeaderMode: custom 无 apiKey 允许 refreshModels() 并与运行时鉴权/生图解析联动', async () => {
    const workspace = createDefaultWorkspace();
    const relay = workspace.providers.find((p) => p.id === 'new-api-relay')!;
    relay.baseUrl = 'https://relay.example.com/v1';
    relay.authHeaderMode = 'custom';
    relay.imageApiMode = 'unsupported';
    relay.customHeaders = [];
    workspace.activeProviderId = 'new-api-relay';

    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'grok-4.7' }, { id: 'claude-sonnet-5-5' }] }),
    }));
    setGlobalForTest('fetch', fetchSpy);

    const { session, adapter } = await createReadySession(workspace);
    let latestModel: SettingsScreenModel | null = null;
    function ModelHarness() {
      const model = useSettingsScreenModel(() => undefined);
      useEffect(() => {
        latestModel = model;
      });
      return createElement('div');
    }

    await renderWithProviders(session, adapter, createElement(ModelHarness));

    // 当 authHeaderMode === 'custom' 但没有任何启用的非空自定义头时，应给出明确引导且不发请求
    await act(async () => {
      latestModel!.models.refresh();
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(latestModel!.status.notice).toContain('自定义鉴权模式');

    // 添加 1 条启用自定义鉴权头（全空白 value）与 1 条禁用头，仍应被拦截且 0 fetch 调用
    await act(async () => {
      latestModel!.providers.addCustomHeaderDraft();
      latestModel!.providers.addCustomHeaderDraft();
    });
    const [h1, h2] = latestModel!.providers.customHeadersDraft;
    await act(async () => {
      latestModel!.providers.updateCustomHeaderDraft(h1.id, {
        key: 'X-Custom-Auth',
        value: '   ',
        enabled: true,
      });
      latestModel!.providers.updateCustomHeaderDraft(h2.id, {
        key: 'X-Disabled-Tag',
        value: 'should-not-send',
        enabled: false,
      });
    });
    await act(async () => {
      latestModel!.models.refresh();
    });
    await session.flush();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(latestModel!.status.notice).toContain('自定义鉴权模式');

    // 当自定义请求头键名为空白但值非空时，保存与刷新也应拦截且不发请求
    const savedBlankValueHeaderId = latestModel!.providers.customHeadersDraft[0]!.id;
    await act(async () => {
      latestModel!.providers.updateCustomHeaderDraft(savedBlankValueHeaderId, {
        key: '   ',
        value: 'token-with-blank-key',
        enabled: true,
      });
    });
    await act(async () => {
      latestModel!.models.refresh();
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(latestModel!.status.notice).toContain('不能为空');

    // 恢复有效自定义头名称后再更新为有效非空白值（persistProviderDraft 后草稿已随 activeProvider 刷新 ID），再次 refreshModels() 应放行且仅注入启用头
    const latestHeaderId = latestModel!.providers.customHeadersDraft[0]!.id;
    await act(async () => {
      latestModel!.providers.updateCustomHeaderDraft(latestHeaderId, {
        key: 'X-Custom-Auth',
        value: 'token-99',
        enabled: true,
      });
    });
    await act(async () => {
      latestModel!.models.refresh();
    });
    await session.flush();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const requestInit = (fetchSpy.mock.calls[0] as unknown[] | undefined)?.[1] as
      | { headers?: Record<string, string> }
      | undefined;
    expect(requestInit?.headers?.Authorization).toBeUndefined();
    expect(requestInit?.headers?.['X-Custom-Auth']).toBe('token-99');
    expect(requestInit?.headers?.['X-Disabled-Tag']).toBeUndefined();

    // 验证落盘后的 ProviderProfile 与运行时 resolveProviderAuthHeaders / resolveImageApiMode 完全对齐
    const persistedRelay = adapter.getStoredSnapshot()?.providers.find((p) => p.id === 'new-api-relay') as ProviderProfile;
    expect(resolveProviderAuthHeaders(persistedRelay)).toEqual({
      'X-Custom-Auth': 'token-99',
    });
    expect(resolveImageApiMode(persistedRelay, 'grok-imagine-image-2.0')).toBe('unsupported');
  });

  it('S11: ProviderDetailScreen 保持挂载热切 activeProvider 时重置高级区折叠状态并保留手动切换能力', async () => {
    const workspace = createDefaultWorkspace();
    const relay = workspace.providers.find((p) => p.id === 'new-api-relay')!;
    relay.baseUrl = 'https://relay.example.com/v1';
    workspace.activeProviderId = 'new-api-relay';
    workspace.experienceMode = 'simple';

    const { session, adapter } = await createReadySession(workspace);
    let latestModel: SettingsScreenModel | null = null;
    function HotSwitchDetailHarness() {
      const model = useSettingsScreenModel(() => undefined);
      useEffect(() => {
        latestModel = model;
      });
      return createElement(ProviderDetailScreen, {
        readOnly: model.status.readOnly,
        provider: model.providers.activeProvider,
        experienceMode: model.appearance.experienceMode,
        addedModelCount: model.models.addedModels.length,
        candidateModelCount: model.models.candidates.length,
        refreshingModels: model.models.refreshing,
        notice: model.status.notice,
        nameDraft: model.providers.nameDraft,
        kindDraft: model.providers.kindDraft,
        baseUrlDraft: model.providers.baseUrlDraft,
        apiKeyDraft: model.providers.apiKeyDraft,
        authHeaderModeDraft: model.providers.authHeaderModeDraft,
        imageApiModeDraft: model.providers.imageApiModeDraft,
        customHeadersDraft: model.providers.customHeadersDraft,
        customHeadersValidation: model.providers.customHeadersValidation,
        endpointInspection: model.providers.endpointInspection,
        onBack: () => undefined,
        onOpenModels: () => undefined,
        onSetNameDraft: model.providers.setNameDraft,
        onChangeBindingDraft: model.providers.changeBindingDraft,
        onSetApiKeyDraft: model.providers.setApiKeyDraft,
        onSetAuthHeaderModeDraft: model.providers.setAuthHeaderModeDraft,
        onSetImageApiModeDraft: model.providers.setImageApiModeDraft,
        onAddCustomHeaderDraft: model.providers.addCustomHeaderDraft,
        onUpdateCustomHeaderDraft: model.providers.updateCustomHeaderDraft,
        onRemoveCustomHeaderDraft: model.providers.removeCustomHeaderDraft,
        onSaveProviderDraft: model.providers.saveDraft,
        onRefreshModels: model.models.refresh,
      });
    }

    const { doc } = await renderWithProviders(session, adapter, createElement(HotSwitchDetailHarness));

    expect(
      doc.body.findByTestId('provider-advanced-headers-toggle')?.getAttribute('data-a11y-state')
    ).toBe(JSON.stringify({ expanded: true }));

    // 在 ProviderDetailScreen 保持挂载的情况下热切到简单模式无高级配置的 volcengine-ark
    await act(async () => {
      await latestModel!.providers.select('volcengine-ark');
    });
    expect(latestModel!.providers.kindDraft).toBe('volcengine-ark');
    expect(
      doc.body.findByTestId('provider-advanced-headers-toggle')?.getAttribute('data-a11y-state')
    ).toBe(JSON.stringify({ expanded: false }));
    expect(doc.body.textContent).not.toContain('鉴权请求头模式');

    // 当前服务商内手动点击展开/收起依然完全受控有效
    await act(async () => {
      uiHooks.pressByTestId.get('provider-advanced-headers-toggle')?.();
    });
    expect(
      doc.body.findByTestId('provider-advanced-headers-toggle')?.getAttribute('data-a11y-state')
    ).toBe(JSON.stringify({ expanded: true }));
    expect(doc.body.textContent).toContain('鉴权请求头模式');

    await act(async () => {
      uiHooks.pressByTestId.get('provider-advanced-headers-toggle')?.();
    });
    expect(
      doc.body.findByTestId('provider-advanced-headers-toggle')?.getAttribute('data-a11y-state')
    ).toBe(JSON.stringify({ expanded: false }));

    // 切到 bailian-compatible（无非默认高级配置）保持收起，切回 new-api-relay 自动展开
    await act(async () => {
      await latestModel!.providers.select('bailian-compatible');
    });
    expect(
      doc.body.findByTestId('provider-advanced-headers-toggle')?.getAttribute('data-a11y-state')
    ).toBe(JSON.stringify({ expanded: false }));

    await act(async () => {
      await latestModel!.providers.select('new-api-relay');
    });
    expect(
      doc.body.findByTestId('provider-advanced-headers-toggle')?.getAttribute('data-a11y-state')
    ).toBe(JSON.stringify({ expanded: true }));
  });
});
