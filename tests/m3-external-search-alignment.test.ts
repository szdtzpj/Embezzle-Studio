import { createRequire } from 'node:module';
import {
  act,
  createElement,
  forwardRef,
  useRef,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryWorkspacePersistenceAdapter } from '../src/app/workspace/adapters/memoryWorkspacePersistenceAdapter';
import { WorkspaceSession } from '../src/app/workspace/WorkspaceSession';
import { WorkspaceSessionProvider } from '../src/app/workspace/WorkspaceSessionProvider';
import { createDefaultWorkspace } from '../src/data/providerCatalog';
import type { ExternalSearchService } from '../src/domain/types';
import {
  allExternalSearchProviderHints,
  allExternalSearchProviderKinds,
  allExternalSearchProviderLabels,
  externalSearchProviderHints,
  externalSearchProviderKinds,
  externalSearchProviderLabels,
  externalSearchProviderRequiresEndpoint,
  validateExternalSearchEndpoint,
} from '../src/services/externalSearch';
import {
  createWorkspaceBackupEnvelope,
  exportEncryptedWorkspaceBackup,
  importEncryptedWorkspaceBackup,
  mergeValidatedWorkspaceBackupEnvelope,
  sanitizeWorkspaceForBackup,
  validateWorkspaceBackupEnvelope,
} from '../src/services/workspaceBackup';
import { reduceSettingsWorkspaceCommand } from '../src/features/settings/internal/SettingsWorkspaceRuntime';
import { SettingsToolsSectionView } from '../src/features/settings/internal/SettingsToolsSectionView';
import { SettingsProductivityProvider } from '../src/features/settings/SettingsProductivityProvider';
import { ProjectsConversationsProvider } from '../src/features/projects/ProjectsConversationsProvider';
import { ChatProvider } from '../src/features/chat/ChatProvider';
import { createProductionChatAudioAdapter } from '../src/features/chat/orchestration/ChatAudioAdapter';
import type { ProviderAdapterRegistry } from '../src/features/chat/orchestration/ProviderAdapterRegistry';
import { AppDialogHost } from '../src/ui/components/AppDialogHost';
import {
  ComposerSearchSheet,
  SearchServiceIcon,
  SearchServicesPanel,
  formatSanitizedConnectionError,
  type SearchServicesPanelHandle,
} from '../src/ui/components/SearchServicesPanel';
import {
  BochaMark,
  ExaMark,
  SearxngMark,
} from '../src/ui/components/SearchBrandMarks';
import { KelivoThemeProvider } from '../src/ui/theme';

const loadCjs = createRequire(import.meta.url);
const { createRoot } = loadCjs('react-dom/client') as {
  createRoot: (container: unknown) => {
    render: (element: ReactElement) => void;
    unmount: () => void;
  };
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
    longPressByTestId: new Map<string, () => void>(),
    changeTextByTestId: new Map<string, (text: string) => void>(),
    disabledByTestId: new Map<string, boolean>(),
    runExternalSearchSpy: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    resolveBrandOverride: null as ((name: 'DeepSeek' | 'Exa') => unknown) | null,
  };
});

vi.mock('react-native', () => {
  const makeHost = (tag: string, kind: string) =>
    forwardRef<unknown, Record<string, unknown>>(function MockRnHost(props, ref) {
      const {
        children,
        testID,
        accessibilityLabel,
        accessibilityRole,
        accessibilityLiveRegion,
        disabled,
        onPress,
        onLongPress,
        onChangeText,
        value,
        placeholder,
      } = props;
      if (typeof testID === 'string') {
        uiHooks.disabledByTestId.set(testID, Boolean(disabled));
        if (typeof onPress === 'function') {
          uiHooks.pressByTestId.set(testID, () => {
            if (!disabled) (onPress as () => void)();
          });
        }
        if (typeof onLongPress === 'function') {
          uiHooks.longPressByTestId.set(testID, () => {
            if (!disabled) (onLongPress as () => void)();
          });
        }
        if (typeof onChangeText === 'function') {
          uiHooks.changeTextByTestId.set(testID, onChangeText as (text: string) => void);
        }
      }
      return createElement(
        tag,
        {
          ref,
          'data-rn-kind': kind,
          ...(testID ? { 'data-testid': testID } : {}),
          ...(accessibilityLabel ? { 'aria-label': accessibilityLabel } : {}),
          ...(accessibilityRole ? { role: accessibilityRole } : {}),
          ...(accessibilityLiveRegion
            ? { 'aria-live': String(accessibilityLiveRegion) }
            : {}),
          ...(disabled ? { 'aria-disabled': 'true' } : {}),
          ...(placeholder ? { 'data-placeholder': String(placeholder) } : {}),
          ...(value !== undefined ? { 'data-value': String(value) } : {}),
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
      dismiss: () => undefined,
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

vi.mock('lucide-react-native', () => {
  const Icon = () => createElement('span');
  const names = [
    'Activity',
    'AlertTriangle',
    'BookOpen',
    'Check',
    'ChevronRight',
    'Download',
    'FileText',
    'Globe2',
    'HardDrive',
    'KeyRound',
    'MessageSquare',
    'Minus',
    'Pin',
    'Plus',
    'RefreshCw',
    'Settings',
    'ShieldAlert',
    'ShieldCheck',
    'Stethoscope',
    'Trash2',
    'Wrench',
    'X',
  ];
  const mod: Record<string, unknown> = { __esModule: true };
  for (const name of names) mod[name] = Icon;
  return mod;
});

// 刻意省略 Exa 以验证精简 mock 下 ExaMark 兜底兼容性，同时支持切换异常 Mock/Proxy 探针
vi.mock('@lobehub/icons-rn', () => {
  const makeBrand = (tag: string) => {
    const Icon = () => createElement('span', { 'data-brand-icon': tag });
    return Object.assign(Icon, { Color: Icon });
  };
  const defaultDeepSeek = makeBrand('DeepSeek');
  return {
    __esModule: true,
    Bing: makeBrand('Bing'),
    get DeepSeek() {
      return uiHooks.resolveBrandOverride
        ? uiHooks.resolveBrandOverride('DeepSeek')
        : defaultDeepSeek;
    },
    get Exa() {
      return uiHooks.resolveBrandOverride ? uiHooks.resolveBrandOverride('Exa') : undefined;
    },
    Grok: makeBrand('Grok'),
    Tavily: makeBrand('Tavily'),
  };
});

vi.mock('../src/services/externalSearch', async () => {
  const actual = (await vi.importActual('../src/services/externalSearch')) as Record<
    string,
    unknown
  >;
  return {
    ...actual,
    runExternalSearch: (...args: unknown[]) => uiHooks.runExternalSearchSpy(...args),
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

function createTenServices(): ExternalSearchService[] {
  return allExternalSearchProviderKinds.map((kind, idx) => ({
    id: `svc-${kind}-${idx}`,
    kind,
    name: allExternalSearchProviderLabels[kind],
    ...(kind === 'bing' || kind === 'duckduckgo' || kind === 'firecrawl' || kind === 'searxng'
      ? {}
      : { apiKey: `secret-key-${kind}` }),
    ...(kind === 'searxng' ? { endpoint: 'https://searx.example.com' } : {}),
    ...(kind === 'grok' ? { model: 'grok-4.5' } : {}),
  }));
}

describe('M3.2b1 10-provider external search full-stack alignment', () => {
  const activeRoots: Array<{ unmount: () => void }> = [];
  const activeSessions: WorkspaceSession[] = [];

  beforeEach(() => {
    uiHooks.pressByTestId.clear();
    uiHooks.longPressByTestId.clear();
    uiHooks.changeTextByTestId.clear();
    uiHooks.disabledByTestId.clear();
    uiHooks.runExternalSearchSpy.mockReset();
    uiHooks.resolveBrandOverride = null;
  });

  afterAll(() => {
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
      uiHooks.resolveBrandOverride = null;
      uiHooks.pressByTestId.clear();
      uiHooks.longPressByTestId.clear();
      uiHooks.changeTextByTestId.clear();
      uiHooks.disabledByTestId.clear();
      uiHooks.runExternalSearchSpy.mockReset();
      vi.useRealTimers();
      restoreGlobals();
      vi.restoreAllMocks();
    }
  });

  it('keeps legacy 6-item list intact while aligning labels, hints, and endpoint validation across all 10 providers', () => {
    expect(externalSearchProviderKinds).toHaveLength(6);
    expect(allExternalSearchProviderKinds).toHaveLength(10);
    expect(Object.keys(externalSearchProviderLabels)).toHaveLength(10);
    expect(Object.keys(externalSearchProviderHints)).toHaveLength(10);
    expect(allExternalSearchProviderLabels).toEqual(externalSearchProviderLabels);
    expect(allExternalSearchProviderHints).toEqual(externalSearchProviderHints);

    for (const kind of allExternalSearchProviderKinds) {
      expect(externalSearchProviderRequiresEndpoint(kind)).toBe(kind === 'searxng');
    }

    // SearXNG 空地址拦截；其他引擎空地址放行
    expect(validateExternalSearchEndpoint('searxng', '')).toEqual({
      ok: false,
      error: 'SearXNG 需要填写自托管 HTTPS 实例地址。',
    });
    expect(validateExternalSearchEndpoint('searxng', '   ').ok).toBe(false);
    expect(validateExternalSearchEndpoint('deepseek', '')).toEqual({
      ok: true,
      endpoint: undefined,
    });

    // 非 HTTPS、凭据、查询参数与私网/本机 SSRF 拦截
    const invalidUrls = [
      'http://searx.example.com',
      'ftp://searx.example.com',
      'not-a-url',
      'https://user:pass@searx.example.com',
      'https://searx.example.com/?q=1',
      'https://searx.example.com/#frag',
      'https://localhost:8080',
      'https://127.0.0.1',
      'https://10.0.0.8',
      'https://172.16.5.4',
      'https://192.168.1.10',
      'https://169.254.169.254',
      'https://[::1]',
      'https://searx.local',
    ];
    for (const bad of invalidUrls) {
      const result = validateExternalSearchEndpoint('searxng', bad);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.length).toBeGreaterThan(0);
      }
    }

    // 合法公网 HTTPS 地址规范化去尾部斜杠
    expect(validateExternalSearchEndpoint('searxng', ' https://searx.example.com/ ')).toEqual({
      ok: true,
      endpoint: 'https://searx.example.com',
    });
    expect(validateExternalSearchEndpoint('bocha', 'https://proxy.example.com/bocha/')).toEqual({
      ok: true,
      endpoint: 'https://proxy.example.com/bocha',
    });
  });

  it('supports exporting and importing all 10 external search kinds in workspaceBackup without leaking secrets or SSRF URLs', async () => {
    const workspace = createDefaultWorkspace();
    workspace.externalSearch = {
      enabled: true,
      selectedServiceId: 'svc-searxng-9',
      maxResults: 6,
      maxToolRounds: 2,
      services: createTenServices(),
    };

    const sanitized = sanitizeWorkspaceForBackup(workspace);
    expect(sanitized.externalSearch?.enabled).toBe(false);
    expect(sanitized.externalSearch?.services).toHaveLength(10);
    for (const svc of sanitized.externalSearch?.services ?? []) {
      expect('apiKey' in svc && svc.apiKey !== undefined).toBe(false);
    }

    const encrypted = await exportEncryptedWorkspaceBackup(
      workspace,
      'StrongPass123!',
      { now: 1_700_000_000_000 }
    );
    const merged = await importEncryptedWorkspaceBackup(
      encrypted,
      'StrongPass123!',
      createDefaultWorkspace()
    );

    expect(merged.externalSearch.enabled).toBe(false);
    expect(merged.externalSearch.services).toHaveLength(10);
    expect(merged.externalSearch.services.map((s) => s.kind)).toEqual(
      expect.arrayContaining(['deepseek', 'bocha', 'exa', 'searxng'])
    );
    const restoredSearxng = merged.externalSearch.services.find((s) => s.kind === 'searxng');
    expect(restoredSearxng?.endpoint).toBe('https://searx.example.com');
    expect(restoredSearxng?.apiKey).toBeUndefined();

    // 含 apiKey 或 SSRF endpoint 的外部搜索备份必须被拒绝
    const envelopeWithSecret = createWorkspaceBackupEnvelope(workspace, 1_700_000_000_000);
    const leaked = structuredClone(envelopeWithSecret);
    if (!leaked.workspace.externalSearch) {
      throw new Error('expected externalSearch in sanitized backup');
    }
    leaked.workspace.externalSearch.services[0].apiKey = 'leaked-secret';
    expect(() => validateWorkspaceBackupEnvelope(leaked)).toThrow(/API Key/);

    const ssrfEnvelope = structuredClone(envelopeWithSecret);
    const searxEntry = ssrfEnvelope.workspace.externalSearch?.services.find(
      (s) => s.kind === 'searxng'
    );
    if (searxEntry) searxEntry.endpoint = 'http://127.0.0.1:8080';
    expect(() => validateWorkspaceBackupEnvelope(ssrfEnvelope)).toThrow(/endpoint 无效/);

    // 兼容缺省 externalSearch 的旧版备份
    const legacyEnvelope = structuredClone(envelopeWithSecret) as unknown as {
      workspace: Record<string, unknown>;
    };
    delete legacyEnvelope.workspace.externalSearch;
    expect(() => validateWorkspaceBackupEnvelope(legacyEnvelope)).not.toThrow();
    const legacyMerged = mergeValidatedWorkspaceBackupEnvelope(
      legacyEnvelope as unknown as ReturnType<typeof createWorkspaceBackupEnvelope>,
      createDefaultWorkspace()
    );
    expect(legacyMerged.externalSearch).toEqual({
      enabled: false,
      maxResults: 5,
      maxToolRounds: 3,
      selectedServiceId: undefined,
      services: [],
    });
  });

  it('renders 10-provider picker, updated built-in subtitle, SearXNG validation & SSRF inline errors, and sanitized connection error', async () => {
    const { doc, container } = createStubDom();
    const onAddExternalService = vi.fn();
    const panelRef = { current: null as SearchServicesPanelHandle | null };

    function Harness({ services }: { services: ExternalSearchService[] }) {
      const innerRef = useRef<SearchServicesPanelHandle>(null);
      panelRef.current = innerRef.current;
      return elWithChildren(
        KelivoThemeProvider,
        { scheme: 'light' },
        createElement(SearchServicesPanel, {
          ref: (instance: SearchServicesPanelHandle | null) => {
            innerRef.current = instance;
            panelRef.current = instance;
          },
          readOnly: false,
          webSearch: { enabled: true, searchContextSize: 'medium' },
          externalSearch: {
            enabled: false,
            maxResults: 5,
            maxToolRounds: 3,
            services,
          },
          webSearchReady: true,
          webSearchContextSizeApplies: true,
          onSetSearchContextSize: vi.fn(),
          onRemoveExternalService: vi.fn(),
          onAddExternalService,
          onSetMaxResults: vi.fn(),
          onSetMaxToolRounds: vi.fn(),
        }),
        createElement(AppDialogHost)
      );
    }

    const root = createRoot(container);
    activeRoots.push(root);
    const initialServices: ExternalSearchService[] = [
      {
        id: 'svc-searx-1',
        kind: 'searxng',
        name: 'SearXNG',
        endpoint: 'https://searx.example.com',
        apiKey: 'top-secret-token',
      },
      {
        id: 'svc-exa-1',
        kind: 'exa',
        name: 'Exa AI',
        apiKey: 'exa-key',
      },
    ];

    act(() => {
      root.render(createElement(Harness, { services: initialServices }));
    });

    // 1. 验证内置搜索副标题覆盖 7 大官方协议，且 Exa 在缺省 mock 下降级渲染 ExaMark
    const builtinRow = doc.body.findByTestId('search-service-row-builtin');
    expect(builtinRow?.textContent).toContain(
      'OpenAI / Claude / Gemini / Grok / DeepSeek / 方舟 / 百炼'
    );
    expect(doc.body.findByTestId('search-service-row-exa')).not.toBeNull();

    // 2. 打开添加选择器，验证全部 10 家均渲染
    act(() => {
      panelRef.current?.openAdd();
    });
    for (const kind of allExternalSearchProviderKinds) {
      expect(doc.body.findByTestId(`search-add-kind-${kind}`)).not.toBeNull();
    }

    // 3. 选择 DeepSeek，验证显示自定义 URL 输入框（打破 6 家限制）
    act(() => {
      uiHooks.pressByTestId.get('search-add-kind-deepseek')?.();
    });
    expect(doc.body.findByTestId('search-service-form-endpoint')).not.toBeNull();

    // 重新打开并选择 SearXNG，验证无 Key + 必填 HTTPS + 实时 SSRF 拦截
    act(() => {
      panelRef.current?.openAdd();
    });
    act(() => {
      uiHooks.pressByTestId.get('search-add-kind-searxng')?.();
    });

    const formContent = doc.body.textContent;
    expect(formContent).toContain('API Key（可选）');
    expect(formContent).toContain('实例 URL（必填，HTTPS）');
    expect(formContent).toContain('format=json');

    // 空 URL 阻断提交并展示明确原因
    expect(uiHooks.disabledByTestId.get('search-service-form-submit')).toBe(true);
    expect(doc.body.findByTestId('search-service-form-error')?.textContent).toContain(
      'SearXNG 需要填写自托管 HTTPS 实例地址'
    );

    // 非法 http:// 地址实时报错并阻断
    act(() => {
      uiHooks.changeTextByTestId.get('search-service-form-endpoint')?.('http://searx.example.com');
    });
    expect(uiHooks.disabledByTestId.get('search-service-form-submit')).toBe(true);
    expect(doc.body.findByTestId('search-service-form-error')?.textContent).toContain('HTTPS');

    // 内网 SSRF 地址实时报错并阻断
    act(() => {
      uiHooks.changeTextByTestId.get('search-service-form-endpoint')?.('https://127.0.0.1:8080');
    });
    expect(uiHooks.disabledByTestId.get('search-service-form-submit')).toBe(true);
    expect(doc.body.findByTestId('search-service-form-error')?.textContent).toContain(
      '本机或私网主机名'
    );

    // 合法公网 HTTPS 地址消除错误并允许无 Key 保存
    act(() => {
      uiHooks.changeTextByTestId.get('search-service-form-endpoint')?.('https://searx.example.com/');
    });
    expect(doc.body.findByTestId('search-service-form-error')).toBeNull();
    expect(uiHooks.disabledByTestId.get('search-service-form-submit')).toBe(false);

    act(() => {
      uiHooks.pressByTestId.get('search-service-form-submit')?.();
    });
    expect(onAddExternalService).toHaveBeenCalledWith({
      kind: 'searxng',
      apiKey: undefined,
      endpoint: 'https://searx.example.com',
    });

    // 4. 长按测试连接失败时展示脱敏错误原因
    uiHooks.runExternalSearchSpy.mockRejectedValueOnce(
      new Error('SearXNG 返回 HTML，未启用 format=json (token: top-secret-token)')
    );
    act(() => {
      uiHooks.longPressByTestId.get('search-service-row-searxng')?.();
    });
    await act(async () => {
      uiHooks.pressByTestId.get('search-service-action-test')?.();
    });

    const connError = doc.body.findByTestId('search-service-connection-error');
    expect(connError).not.toBeNull();
    expect(connError?.textContent).toContain('format=json');
    expect(connError?.textContent).not.toContain('top-secret-token');

    // 5. 验证 BochaMark / SearxngMark / ExaMark 独立 SVG 渲染，及 ComposerSearchSheet 兼容 10 家与 R3 紧凑结构
    act(() => {
      root.render(
        elWithChildren(
          KelivoThemeProvider,
          { scheme: 'light' },
          createElement(
            'div',
            { 'data-testid': 'brand-marks-box' },
            createElement(BochaMark, { size: 18 }),
            createElement(SearxngMark, { size: 18 }),
            createElement(ExaMark, { size: 18 })
          ),
          createElement(ComposerSearchSheet, {
            visible: true,
            webSearchEnabled: false,
            webSearchReady: true,
            externalSearch: {
              enabled: true,
              selectedServiceId: 'svc-searxng-9',
              maxResults: 5,
              maxToolRounds: 3,
              services: createTenServices(),
            },
            modelSupportsTools: true,
            maxHeight: 160,
            onClose: vi.fn(),
            onSelectOff: vi.fn(),
            onSelectProvider: vi.fn(),
            onSelectExternal: vi.fn(),
            onManage: vi.fn(),
          })
        )
      );
    });

    const marksBox = doc.body.findByTestId('brand-marks-box');
    expect(marksBox?.findAll((el) => el.tagName === 'SVG')).toHaveLength(3);

    const compactTags = doc.body.findByTestId('composer-search-tags');
    expect(compactTags?.childNodes).toHaveLength(3);
    for (const kind of allExternalSearchProviderKinds) {
      expect(doc.body.findByTestId(`composer-search-option-${kind}`)).not.toBeNull();
    }
  });

  it('enforces endpoint validation & renders notice in SettingsToolsSectionView and commits all 10 kinds in SettingsWorkspaceRuntime', async () => {
    // 1. 验证 SettingsWorkspaceRuntime 对新增引擎名称与 endpoint 处理
    const ws = createDefaultWorkspace();
    const afterUpsert = reduceSettingsWorkspaceCommand(ws, {
      type: 'external-search.upsert',
      input: {
        kind: 'bocha',
        apiKey: 'bocha-key',
        newId: 'ext-bocha-1',
      },
    });
    expect(
      afterUpsert.workspace.externalSearch.services.find((s) => s.id === 'ext-bocha-1')
    ).toMatchObject({
      id: 'ext-bocha-1',
      kind: 'bocha',
      name: 'Bocha 博查',
      apiKey: 'bocha-key',
    });

    // 2. 挂载 SettingsToolsSectionView('webSearch')，验证 upsertExternalSearchService 与 WorkspaceSession 衔接
    const { doc, container } = createStubDom();
    const initial = createDefaultWorkspace();
    const persistence = new MemoryWorkspacePersistenceAdapter({ initial });
    const session = new WorkspaceSession({ persistence, autoBoot: false });
    activeSessions.push(session);
    await session.boot();
    const initialRevision = session.getRevision();

    const root = createRoot(container);
    activeRoots.push(root);

    const toolsPanelRef = { current: null as SearchServicesPanelHandle | null };

    function ToolsHarness() {
      const dummyAdapterRegistry = {
        resolve: () => ({ streamChat: async () => undefined }),
      } as unknown as ProviderAdapterRegistry;
      const dummyAudioAdapter = createProductionChatAudioAdapter();
      return elWithChildren(
        KelivoThemeProvider,
        { scheme: 'light' },
        elWithChildren(
          WorkspaceSessionProvider,
          { adapters: { persistence }, session },
          elWithChildren(
            ProjectsConversationsProvider,
            {},
            elWithChildren(
              SettingsProductivityProvider,
              {},
              elWithChildren(
                ChatProvider,
                {
                  adapters: {
                    lifecycle: {
                      getState: () => 'foreground' as const,
                      subscribe: () => () => undefined,
                    },
                    providers: dummyAdapterRegistry,
                    audio: dummyAudioAdapter,
                  },
                },
                createElement(SettingsToolsSectionView, {
                  section: 'webSearch',
                  searchServicesPanelRef: toolsPanelRef,
                })
              )
            )
          )
        ),
        createElement(AppDialogHost)
      );
    }

    await act(async () => {
      root.render(createElement(ToolsHarness));
    });

    // 确认 SettingsToolsSectionView 未出现禁用 testID
    expect(doc.body.findByTestId('search-service-add')).toBeNull();
    expect(doc.body.findByTestId('web-search-settings-card')).not.toBeNull();

    // 通过 SettingsToolsSectionView 挂载的真实 SearchServicesPanel 添加 SearXNG，验证端到端写入会话
    act(() => {
      toolsPanelRef.current?.openAdd();
    });
    act(() => {
      uiHooks.pressByTestId.get('search-add-kind-searxng')?.();
    });
    act(() => {
      uiHooks.changeTextByTestId.get('search-service-form-endpoint')?.('https://searx.example.com/');
    });
    await act(async () => {
      uiHooks.pressByTestId.get('search-service-form-submit')?.();
    });
    await session.settle();

    expect(session.getRevision()).toBeGreaterThan(initialRevision);
    expect(session.getSnapshot().externalSearch.services).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'searxng',
          name: 'SearXNG',
          endpoint: 'https://searx.example.com',
        }),
      ])
    );

    // 通过命令直接校验 Exa 与其余新引擎也可在 SettingsWorkspaceRuntime 中正确提交
    const searxRes = reduceSettingsWorkspaceCommand(session.getSnapshot(), {
      type: 'external-search.upsert',
      input: {
        kind: 'exa',
        apiKey: 'exa-key',
        endpoint: 'https://api.exa.ai/search',
        newId: 'ext-exa-1',
      },
    });
    expect(searxRes.workspace.externalSearch.services).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'ext-exa-1',
          kind: 'exa',
          name: 'Exa AI',
          endpoint: 'https://api.exa.ai/search',
        }),
      ])
    );
  });

  it('redacts URL query credentials, Basic/x-api-key headers, and guards short keys in SearchServicesPanel', async () => {
    const { doc, container } = createStubDom();
    const root = createRoot(container);
    activeRoots.push(root);

    const services: ExternalSearchService[] = [
      {
        id: 'svc-short-key',
        kind: 'tavily',
        name: 'Short Key Service',
        apiKey: 'a',
      },
      {
        id: 'svc-query-leak',
        kind: 'bocha',
        name: 'Bocha Proxy',
        apiKey: 'bocha-long-secret',
      },
    ];

    act(() => {
      root.render(
        elWithChildren(
          KelivoThemeProvider,
          { scheme: 'light' },
          createElement(SearchServicesPanel, {
            readOnly: false,
            webSearch: { enabled: true, searchContextSize: 'medium' },
            externalSearch: {
              enabled: false,
              maxResults: 5,
              maxToolRounds: 3,
              services,
            },
            webSearchReady: true,
            webSearchContextSizeApplies: true,
            onSetSearchContextSize: vi.fn(),
            onRemoveExternalService: vi.fn(),
            onAddExternalService: vi.fn(),
            onSetMaxResults: vi.fn(),
            onSetMaxToolRounds: vi.fn(),
          }),
          createElement(AppDialogHost)
        )
      );
    });

    // 1. URL 查询参数密钥 + Basic + x-api-key 脱敏，且不超过 160 字符
    uiHooks.runExternalSearchSpy.mockRejectedValueOnce(
      new Error(
        'GET https://proxy.example.com/s?q=hi&api_key=url_secret_999&token=tok_abc_888&key=k_xyz_777 Basic dXNlcjpwYXNz x-api-key: hdr_secret_123'
      )
    );
    act(() => {
      uiHooks.longPressByTestId.get('search-service-row-bocha')?.();
    });
    await act(async () => {
      uiHooks.pressByTestId.get('search-service-action-test')?.();
    });

    const bochaErr = doc.body.findByTestId('search-service-connection-error')?.textContent ?? '';
    expect(bochaErr).toContain('q=hi');
    expect(bochaErr).toContain('api_key=***');
    expect(bochaErr).toContain('token=***');
    expect(bochaErr).toContain('key=***');
    expect(bochaErr).toContain('Basic ***');
    expect(bochaErr).toContain('x-api-key: ***');
    expect(bochaErr).not.toContain('url_secret_999');
    expect(bochaErr).not.toContain('tok_abc_888');
    expect(bochaErr).not.toContain('k_xyz_777');
    expect(bochaErr).not.toContain('dXNlcjpwYXNz');
    expect(bochaErr).not.toContain('hdr_secret_123');

    // 2. 极短测试密钥（如 "a"）不会把常规错误文案中的字母 "a" 误替换为 ***
    uiHooks.runExternalSearchSpy.mockRejectedValueOnce(
      new Error('Search failed at upstream gateway')
    );
    act(() => {
      uiHooks.longPressByTestId.get('search-service-row-tavily')?.();
    });
    await act(async () => {
      uiHooks.pressByTestId.get('search-service-action-test')?.();
    });
    const tavilyErr = doc.body.findByTestId('search-service-connection-error')?.textContent ?? '';
    expect(tavilyErr).toBe('Search failed at upstream gateway');
  });

  it('enforces externalSearch allowlists, searxng endpoint presence, unique service ids, and normalizes endpoint in workspaceBackup', () => {
    const workspace = createDefaultWorkspace();
    workspace.externalSearch = {
      enabled: false,
      selectedServiceId: 'svc-searx-trailing',
      maxResults: 5,
      maxToolRounds: 3,
      services: [
        {
          id: 'svc-searx-trailing',
          kind: 'searxng',
          name: 'SearXNG',
          endpoint: 'https://searx.example.com/',
        },
      ],
    };

    const baseEnvelope = createWorkspaceBackupEnvelope(workspace, 1_700_000_000_000);

    // 1. 拒绝省略 endpoint 的 searxng 服务
    const missingEndpoint = structuredClone(baseEnvelope);
    delete missingEndpoint.workspace.externalSearch!.services[0].endpoint;
    expect(() => validateWorkspaceBackupEnvelope(missingEndpoint)).toThrow(/endpoint/);

    // 2. 拒绝 externalSearch 顶层未知注入键
    const extraTopKey = structuredClone(baseEnvelope) as unknown as {
      workspace: { externalSearch: Record<string, unknown> };
    };
    extraTopKey.workspace.externalSearch.evilKey = 'injected';
    expect(() => validateWorkspaceBackupEnvelope(extraTopKey)).toThrow(/未允许的字段 evilKey/);

    // 3. 拒绝 services[i] 未知注入键（如 apikey、token）
    const extraSvcLowerKey = structuredClone(baseEnvelope) as unknown as {
      workspace: { externalSearch: { services: Array<Record<string, unknown>> } };
    };
    extraSvcLowerKey.workspace.externalSearch.services[0].apikey = 'leaked-lowercase';
    expect(() => validateWorkspaceBackupEnvelope(extraSvcLowerKey)).toThrow(/未允许的字段 apikey/);

    const extraSvcTokenKey = structuredClone(baseEnvelope) as unknown as {
      workspace: { externalSearch: { services: Array<Record<string, unknown>> } };
    };
    extraSvcTokenKey.workspace.externalSearch.services[0].token = 'leaked-token';
    expect(() => validateWorkspaceBackupEnvelope(extraSvcTokenKey)).toThrow(/未允许的字段 token/);

    // 4. 拒绝重复 service id
    const dupIdEnvelope = structuredClone(baseEnvelope);
    dupIdEnvelope.workspace.externalSearch!.services.push({
      id: 'svc-searx-trailing',
      kind: 'bing',
      name: 'Bing Dup',
    });
    expect(() => validateWorkspaceBackupEnvelope(dupIdEnvelope)).toThrow(/重复/);

    // 5. mergeImportedWorkspace 规范化去除 endpoint 尾部斜杠与空格
    const trailingSlashEnvelope = structuredClone(baseEnvelope);
    trailingSlashEnvelope.workspace.externalSearch!.services[0].endpoint =
      '  https://searx.example.com///  ';
    expect(() => validateWorkspaceBackupEnvelope(trailingSlashEnvelope)).not.toThrow();
    const merged = mergeValidatedWorkspaceBackupEnvelope(
      trailingSlashEnvelope,
      createDefaultWorkspace()
    );
    expect(merged.externalSearch.services[0]?.endpoint).toBe('https://searx.example.com');
  });

  it('prevents dangling selectedServiceId at 16-service cap and preserves custom name on edit in SettingsWorkspaceRuntime', () => {
    const base = createDefaultWorkspace();
    const fullServices: ExternalSearchService[] = Array.from({ length: 16 }, (_, index) => ({
      id: `svc-${index + 1}`,
      kind: 'searxng',
      name: index === 0 ? 'Company Private SearXNG' : `SearXNG ${index + 1}`,
      endpoint: `https://searx-${index + 1}.example.com`,
    }));
    const fullWorkspace = {
      ...base,
      externalSearch: {
        ...base.externalSearch,
        selectedServiceId: 'svc-2',
        services: fullServices,
      },
    };

    // 1. 满 16 个服务时新增第 17 个，不产生悬空 selectedServiceId
    const afterAdd17 = reduceSettingsWorkspaceCommand(fullWorkspace, {
      type: 'external-search.upsert',
      input: {
        kind: 'tavily',
        apiKey: 'tvly-17',
        newId: 'svc-17',
      },
    });
    expect(afterAdd17.workspace.externalSearch.services).toHaveLength(16);
    expect(
      afterAdd17.workspace.externalSearch.services.some(
        (item) => item.id === afterAdd17.workspace.externalSearch.selectedServiceId
      )
    ).toBe(true);
    expect(afterAdd17.workspace.externalSearch.selectedServiceId).toBe('svc-2');

    // 2. 编辑既有自定义名称服务时（未传 name），保留原自定义名称不被覆盖
    const afterEdit = reduceSettingsWorkspaceCommand(fullWorkspace, {
      type: 'external-search.upsert',
      input: {
        serviceId: 'svc-1',
        kind: 'searxng',
        endpoint: 'https://updated-private.example.com',
        newId: 'unused-new-id',
      },
    });
    const edited = afterEdit.workspace.externalSearch.services.find((s) => s.id === 'svc-1');
    expect(edited?.name).toBe('Company Private SearXNG');
    expect(edited?.endpoint).toBe('https://updated-private.example.com');
    expect(afterEdit.workspace.externalSearch.selectedServiceId).toBe('svc-1');
  });

  it('rejects empty ?/# suffixes in validateExternalSearchEndpoint and guards renderBrandMark against plain objects and throwing Proxies', () => {
    // 1. 空 ? / # 尾符拦截
    const emptyQueryOrHash = [
      'https://search.example.com/?',
      'https://search.example.com/#',
      'https://search.example.com?',
      'https://search.example.com#',
    ];
    for (const url of emptyQueryOrHash) {
      const check = validateExternalSearchEndpoint('searxng', url);
      expect(check.ok).toBe(false);
    }

    // 2. renderBrandMark 对普通对象 {} 与属性访问抛错 Proxy 的安全降级
    const { container } = createStubDom();
    const root = createRoot(container);
    activeRoots.push(root);

    // 场景 A：导出普通对象 {}（无 .Color 且非函数）
    uiHooks.resolveBrandOverride = () => ({});
    expect(() => {
      act(() => {
        root.render(
          elWithChildren(
            KelivoThemeProvider,
            { scheme: 'light' },
            createElement(SearchServiceIcon, { kind: 'deepseek', color: '#000' }),
            createElement(SearchServiceIcon, { kind: 'exa', color: '#000' })
          )
        );
      });
    }).not.toThrow();

    // 场景 B：模块属性 getter 直接抛错
    uiHooks.resolveBrandOverride = (name) => {
      throw new Error(`[strict mock] Missing ${name}`);
    };
    expect(() => {
      act(() => {
        root.render(
          elWithChildren(
            KelivoThemeProvider,
            { scheme: 'light' },
            createElement(SearchServiceIcon, { kind: 'deepseek', color: '#000' }),
            createElement(SearchServiceIcon, { kind: 'exa', color: '#000' })
          )
        );
      });
    }).not.toThrow();

    // 场景 C：导出对象上的 .Color getter 抛错的 Proxy
    const throwingProxy = new Proxy(
      {},
      {
        get(_target, prop) {
          throw new Error(`[strict proxy] Forbidden access to ${String(prop)}`);
        },
      }
    );
    uiHooks.resolveBrandOverride = () => throwingProxy;
    expect(() => {
      act(() => {
        root.render(
          elWithChildren(
            KelivoThemeProvider,
            { scheme: 'light' },
            createElement(SearchServiceIcon, { kind: 'deepseek', color: '#000' }),
            createElement(SearchServiceIcon, { kind: 'exa', color: '#000' })
          )
        );
      });
    }).not.toThrow();
  });

  it('redacts hash fragments, URL userinfo, URL-safe Basic, multi-auth headers, quoted/truncated JSON, and avoids false positives or ReDoS', () => {
    // 1. URL Hash Fragment 首参数与 #? 路由参数脱敏
    const hashFrag = formatSanitizedConnectionError(
      new Error('Redirect https://proxy.example.com/cb#access_token=frag_tok_secret&api_key=frag_ak')
    );
    expect(hashFrag).toContain('#access_token=***&api_key=***');
    expect(hashFrag).not.toContain('frag_tok_secret');
    expect(hashFrag).not.toContain('frag_ak');

    const hashQuery = formatSanitizedConnectionError(
      new Error('https://proxy.example.com/cb#?token=frag_q_secret&state=ok')
    );
    expect(hashQuery).toContain('#?token=***&state=ok');
    expect(hashQuery).not.toContain('frag_q_secret');

    // 2. URL userinfo 凭据（user:pass@、单用户名 user@、多 @ 及 :@）且不误伤路径 @
    const userPass = formatSanitizedConnectionError(
      new Error('GET https://admin:super_secret_pw@proxy.example.com/search failed')
    );
    expect(userPass).toContain('https://***@proxy.example.com/search');
    expect(userPass).not.toContain('admin');
    expect(userPass).not.toContain('super_secret_pw');

    const singleUser = formatSanitizedConnectionError(
      new Error('https://gh_user_tok@proxy.example.com/s')
    );
    expect(singleUser).toBe('https://***@proxy.example.com/s');

    const multiAt = formatSanitizedConnectionError(
      new Error('https://u:p@ss@proxy.example.com/s')
    );
    expect(multiAt).toBe('https://***@proxy.example.com/s');

    const pathAt = formatSanitizedConnectionError(
      new Error('GET https://unpkg.com/@scope/pkg@1.0.0 failed')
    );
    expect(pathAt).toBe('GET https://unpkg.com/@scope/pkg@1.0.0 failed');

    // 3. URL-safe Base64 Basic 与 Proxy-Authorization / 非 Bearer 方案
    const urlSafeBasic = formatSanitizedConnectionError(
      new Error('Authorization: Basic YWJj-ZGVm_123==')
    );
    expect(urlSafeBasic).toBe('Authorization: Basic ***');
    expect(urlSafeBasic).not.toContain('-ZGVm_123==');

    const proxyAndToken = formatSanitizedConnectionError(
      new Error('Proxy-Authorization: Basic YWJj-ZGVm_123== Authorization: Token tok_secret_9')
    );
    expect(proxyAndToken).not.toContain('YWJj-ZGVm_123==');
    expect(proxyAndToken).not.toContain('tok_secret_9');

    // 4. 多鉴权头（含 x-goog-api-key、x-auth-token、x-api-token、x-subscription-token、api-key）
    const multiHeaders = formatSanitizedConnectionError(
      new Error(
        'x-goog-api-key: goog_sec_999 x-auth-token: auth_sec_888 x-api-token: atok_777 x-subscription-token: sub_666 api-key: ak_sec_555'
      )
    );
    expect(multiHeaders).not.toContain('goog_sec_999');
    expect(multiHeaders).not.toContain('auth_sec_888');
    expect(multiHeaders).not.toContain('atok_777');
    expect(multiHeaders).not.toContain('sub_666');
    expect(multiHeaders).not.toContain('ak_sec_555');

    // 5. JSON 双/单引号（含转义引号与截断未闭合引号）
    const jsonPairs = formatSanitizedConnectionError(
      new Error(
        '{"x-api-key":"json_sec_111","api_key":"json_ak_222","token":"tok_333","access_token":"acc_444","secret":"sec_555","password":"pwd_666"}'
      )
    );
    for (const leaked of ['json_sec_111', 'json_ak_222', 'tok_333', 'acc_444', 'sec_555', 'pwd_666']) {
      expect(jsonPairs).not.toContain(leaked);
    }

    const singleQuoted = formatSanitizedConnectionError(
      new Error("{'x-api-key':'single_sec_111','api_key':'single_ak_222'}")
    );
    expect(singleQuoted).not.toContain('single_sec_111');
    expect(singleQuoted).not.toContain('single_ak_222');

    const truncatedJson = formatSanitizedConnectionError(
      new Error('{"api_key":"cut\\"sec_999')
    );
    expect(truncatedJson).not.toContain('cut');
    expect(truncatedJson).not.toContain('sec_999');

    // 6. HTTP 状态与非敏感参数防误伤，及空参数边界保留
    const nonSensitive = formatSanitizedConnectionError(
      new Error('HTTP 401 Unauthorized https://api.tavily.com/search?format=json&q=hi&api_key=&token=real_tok_333')
    );
    expect(nonSensitive).toContain('401 Unauthorized');
    expect(nonSensitive).toContain('format=json');
    expect(nonSensitive).toContain('q=hi');
    expect(nonSensitive).toContain('api_key=&token=***');
    expect(nonSensitive).not.toContain('real_tok_333');

    // 7. 短 Key 守卫与 URL 编码 Key 脱敏
    expect(formatSanitizedConnectionError(new Error('HTTP 401 failed at 1234'), '1')).toBe(
      'HTTP 401 failed at 1234'
    );
    const percentEncoded = formatSanitizedConnectionError(
      new Error('upstream rejected token my%2Fsec%2Bkey%3D1'),
      'my/sec+key=1'
    );
    expect(percentEncoded).not.toContain('my%2Fsec%2Bkey%3D1');
    expect(percentEncoded).toContain('***');

    // 8. <= 160 截断前先脱敏尾部密钥
    const prefix = 'a'.repeat(150);
    const longErr = formatSanitizedConnectionError(
      new Error(`${prefix} api_key=very_long_secret_tail_999`)
    );
    expect(longErr.length).toBeLessThanOrEqual(160);
    expect(longErr.endsWith('...')).toBe(true);
    expect(longErr).not.toContain('very_long_secret');

    // 9. 零 ReDoS 线性复杂度验证
    const start = performance.now();
    const longUrlOut = formatSanitizedConnectionError(new Error(`https://${'a'.repeat(50_000)}`));
    const longJsonOut = formatSanitizedConnectionError(
      new Error(`{"api_key":"${'a\\\\'.repeat(25_000)}`)
    );
    const elapsedMs = performance.now() - start;
    expect(longUrlOut.length).toBeLessThanOrEqual(160);
    expect(longJsonOut.length).toBeLessThanOrEqual(160);
    expect(elapsedMs).toBeLessThan(50);
  });

  it('redacts unquoted-key quoted Authorization/Proxy-Authorization, extended auth schemes, AWS4 Signature, colon/tilde Bearer, and Ocp-Apim-Subscription-Key under 50ms', () => {
    // 1. 无引号键名 + 单/双引号值（含截断未闭合引号）
    const doubleQuotedAuth = formatSanitizedConnectionError(
      new Error('Authorization: "raw_secret_tok_111"')
    );
    expect(doubleQuotedAuth).toBe('Authorization: "***"');
    expect(doubleQuotedAuth).not.toContain('raw_secret_tok_111');

    const singleQuotedObjAuth = formatSanitizedConnectionError(
      new Error("headers: { Authorization: 'raw_secret_tok_222' }")
    );
    expect(singleQuotedObjAuth).toBe("headers: { Authorization: '***' }");
    expect(singleQuotedObjAuth).not.toContain('raw_secret_tok_222');

    const proxyQuotedAuth = formatSanitizedConnectionError(
      new Error('Proxy-Authorization: "proxy_raw_tok_333"')
    );
    expect(proxyQuotedAuth).toBe('Proxy-Authorization: "***"');
    expect(proxyQuotedAuth).not.toContain('proxy_raw_tok_333');

    const quotedSchemeAuth = formatSanitizedConnectionError(
      new Error('Authorization: "Token tok_in_quotes_555"')
    );
    expect(quotedSchemeAuth).toBe('Authorization: "***"');
    expect(quotedSchemeAuth).not.toContain('tok_in_quotes_555');

    const schemeThenQuoted = formatSanitizedConnectionError(
      new Error('Authorization: OAuth "oauth_quoted_556"')
    );
    expect(schemeThenQuoted).not.toContain('oauth_quoted_556');

    const truncatedQuotedAuth = formatSanitizedConnectionError(
      new Error('Authorization: "cut_auth_tok_777')
    );
    expect(truncatedQuotedAuth).not.toContain('cut_auth_tok_777');

    const truncatedSingleProxy = formatSanitizedConnectionError(
      new Error("headers: { Proxy-Authorization: 'cut_proxy_tok_888")
    );
    expect(truncatedSingleProxy).not.toContain('cut_proxy_tok_888');

    // 2. 扩展认证方案（OAuth / Key / Secret / Negotiate / NTLM / AWS4-HMAC-SHA256）与 Signature=
    const oauthErr = formatSanitizedConnectionError(new Error('Authorization: OAuth oauth_tok_666'));
    expect(oauthErr).toBe('Authorization: OAuth ***');
    expect(oauthErr).not.toContain('oauth_tok_666');

    const keySchemeErr = formatSanitizedConnectionError(new Error('Authorization: Key key_tok_777'));
    expect(keySchemeErr).toBe('Authorization: Key ***');
    expect(keySchemeErr).not.toContain('key_tok_777');

    const negotiateErr = formatSanitizedConnectionError(
      new Error('Proxy-Authorization: Negotiate nego_tok_888')
    );
    expect(negotiateErr).toBe('Proxy-Authorization: Negotiate ***');
    expect(negotiateErr).not.toContain('nego_tok_888');

    const ntlmSecretErr = formatSanitizedConnectionError(
      new Error('Authorization: NTLM ntlm_tok_889 Proxy-Authorization: Secret sec_tok_890')
    );
    expect(ntlmSecretErr).not.toContain('ntlm_tok_889');
    expect(ntlmSecretErr).not.toContain('sec_tok_890');

    const aws4Err = formatSanitizedConnectionError(
      new Error(
        'Authorization: AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7/2026, Signature=sig_sec_123'
      )
    );
    expect(aws4Err).not.toContain('AKIAIOSFODNN7');
    expect(aws4Err).not.toContain('sig_sec_123');
    expect(aws4Err).toContain('Signature=***');

    // 3. 孤立 Bearer 含 : / ~ 字符集扩展
    const bearerColon = formatSanitizedConnectionError(new Error('Bearer v1:secret_tail_999'));
    expect(bearerColon).toBe('Bearer ***');
    expect(bearerColon).not.toContain('secret_tail_999');

    const bearerTilde = formatSanitizedConnectionError(new Error('Bearer tok~secret_tilde_000'));
    expect(bearerTilde).toBe('Bearer ***');
    expect(bearerTilde).not.toContain('secret_tilde_000');

    // 4. Azure Ocp-Apim-Subscription-Key 与 subscription_key
    const azureSubErr = formatSanitizedConnectionError(
      new Error('Ocp-Apim-Subscription-Key: az_sub_secret_123 subscription_key=sub_sec_456')
    );
    expect(azureSubErr).not.toContain('az_sub_secret_123');
    expect(azureSubErr).not.toContain('sub_sec_456');

    // 5. 防误伤回归：401 Unauthorized / format=json / q=hi / 路径 @ / 短 Key（< 4）
    const safeText = formatSanitizedConnectionError(
      new Error(
        'HTTP 401 Unauthorized https://unpkg.com/@scope/pkg@1.0.0?format=json&q=hi'
      ),
      'abc'
    );
    expect(safeText).toBe(
      'HTTP 401 Unauthorized https://unpkg.com/@scope/pkg@1.0.0?format=json&q=hi'
    );

    // 6. 50,000 字符恶意 ReDoS 负载耗时 < 50ms
    const redosPayloads = [
      `Authorization: "${'a\\\\'.repeat(25_000)}`,
      `Authorization: OAuth ${'x'.repeat(50_000)}`,
      `${'Proxy-Authorization: '.repeat(2_381)}`,
      `https://${'a'.repeat(50_000)}`,
      `{"Authorization":"${'a\\\\'.repeat(25_000)}`,
    ];
    for (const payload of redosPayloads) {
      const t0 = performance.now();
      const out = formatSanitizedConnectionError(new Error(payload));
      const dt = performance.now() - t0;
      expect(out.length).toBeLessThanOrEqual(160);
      expect(dt).toBeLessThan(50);
    }
  });

  it('enforces backup referential integrity, required service name, id trimming, authority @ rejection, and runtime trailing-slash normalization', () => {
    const workspace = createDefaultWorkspace();
    workspace.externalSearch = {
      enabled: false,
      selectedServiceId: 'svc-1',
      maxResults: 5,
      maxToolRounds: 3,
      services: [
        {
          id: 'svc-1',
          kind: 'searxng',
          name: 'Private SearXNG',
          endpoint: 'https://searx.example.com',
        },
      ],
    };
    const baseEnvelope = createWorkspaceBackupEnvelope(workspace, 1_700_000_000_000);

    // 1. 拒绝悬空 selectedServiceId
    const danglingSelected = structuredClone(baseEnvelope);
    danglingSelected.workspace.externalSearch!.selectedServiceId = 'non-existent-id';
    expect(() => validateWorkspaceBackupEnvelope(danglingSelected)).toThrow(/不存在/);

    // 2. 拒绝缺失 name 或空白 name
    const omittedName = structuredClone(baseEnvelope) as unknown as {
      workspace: { externalSearch: { services: Array<Record<string, unknown>> } };
    };
    delete omittedName.workspace.externalSearch.services[0].name;
    expect(() => validateWorkspaceBackupEnvelope(omittedName)).toThrow(/name/);

    const blankName = structuredClone(baseEnvelope);
    blankName.workspace.externalSearch!.services[0].name = '   ';
    expect(() => validateWorkspaceBackupEnvelope(blankName)).toThrow(/name/);

    // 3. 拒绝首尾空白 id 与 selectedServiceId
    const paddedId = structuredClone(baseEnvelope);
    paddedId.workspace.externalSearch!.services[0].id = ' svc-1 ';
    expect(() => validateWorkspaceBackupEnvelope(paddedId)).toThrow(/首尾空白/);

    const paddedSelected = structuredClone(baseEnvelope);
    paddedSelected.workspace.externalSearch!.selectedServiceId = ' svc-1 ';
    expect(() => validateWorkspaceBackupEnvelope(paddedSelected)).toThrow(/首尾空白/);

    // 4. mergeValidatedWorkspaceBackupEnvelope 同样严格拦截畸形外部搜索配置，并在省略 selectedServiceId 时安全回退至首项
    expect(() =>
      mergeValidatedWorkspaceBackupEnvelope(
        danglingSelected,
        createDefaultWorkspace()
      )
    ).toThrow(/不存在/);

    const omittedSelectedEnvelope = structuredClone(baseEnvelope);
    delete omittedSelectedEnvelope.workspace.externalSearch!.selectedServiceId;
    omittedSelectedEnvelope.workspace.externalSearch!.services[0].endpoint =
      '  https://searx.example.com///  ';
    const mergedOmittedSelected = mergeValidatedWorkspaceBackupEnvelope(
      omittedSelectedEnvelope,
      createDefaultWorkspace()
    );
    expect(mergedOmittedSelected.externalSearch.services[0]).toMatchObject({
      id: 'svc-1',
      kind: 'searxng',
      name: 'Private SearXNG',
      endpoint: 'https://searx.example.com',
    });
    expect(mergedOmittedSelected.externalSearch.selectedServiceId).toBe('svc-1');

    // 5. externalSearch 拦截空凭据占位符 https://:@... 与 https://@...，且放行路径中含 @ 的公网 URL
    expect(validateExternalSearchEndpoint('searxng', 'https://:@search.example.com/').ok).toBe(false);
    expect(validateExternalSearchEndpoint('searxng', 'https://@search.example.com/').ok).toBe(false);
    expect(validateExternalSearchEndpoint('searxng', 'https://search.example.com/@org/searx/')).toEqual({
      ok: true,
      endpoint: 'https://search.example.com/@org/searx',
    });

    // 6. SettingsWorkspaceRuntime 直接命令提交规范化去除 endpoint 尾部斜杠与首尾空白
    const runtimeRes = reduceSettingsWorkspaceCommand(createDefaultWorkspace(), {
      type: 'external-search.upsert',
      input: {
        kind: 'searxng',
        endpoint: '  https://searx-slash.example.com///  ',
        newId: 'ext-searx-slash',
      },
    });
    expect(
      runtimeRes.workspace.externalSearch.services.find((s) => s.id === 'ext-searx-slash')?.endpoint
    ).toBe('https://searx-slash.example.com');
  });
});
