import { createRequire } from 'node:module';
import {
  act,
  createElement,
  forwardRef,
  useImperativeHandle,
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
import type { ExternalSearchSettings } from '../src/domain/types';
import { ProjectDrawer } from '../src/features/projects/ProjectDrawer';
import { ProjectDrawerShell } from '../src/features/projects/ProjectDrawerShell';
import { ProjectsConversationsProvider, useProjectConversationNavigation } from '../src/features/projects/ProjectsConversationsProvider';
import { SettingsPane } from '../src/features/settings/SettingsPane';
import { SettingsProductivityProvider } from '../src/features/settings/SettingsProductivityProvider';
import { useSettingsLauncher } from '../src/features/settings/useSettingsLauncher';
import { AppDialogHost, OverlayPortal } from '../src/ui/components/AppDialogHost';
import { ConfirmDialog } from '../src/ui/components/ConfirmDialog';
import { NoticeDialog } from '../src/ui/components/NoticeDialog';
import { ComposerSearchSheet } from '../src/ui/components/SearchServicesPanel';
import { getOverlayHostSnapshot, requestConfirm } from '../src/ui/components/dialogService';
import { KelivoThemeProvider } from '../src/ui/theme';

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

// -------------------- Hoisted 可控动画/手势/UI探针 --------------------
interface TimingRecord {
  toValue: number;
  callback?: (finished: boolean) => void;
}

interface CapturedPanGesture {
  onStartCb?: () => void;
  onUpdateCb?: (event: { translationX: number }) => void;
  onEndCb?: (event: { translationX: number; velocityX: number }) => void;
  onFinalizeCb?: () => void;
}

const uiProbes = vi.hoisted(() => {
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
    pressablesByTestId: new Map<string, () => void>(),
    pressablesByAriaLabel: new Map<string, () => void>(),
    switchHandlersByTestId: new Map<string, (next: boolean) => void>(),
    timings: [] as TimingRecord[],
    springCalls: [] as number[],
    sharedValues: [] as Array<{ value: unknown }>,
    cancelAnimationSpy: vi.fn((_sharedValue: unknown) => undefined),
    panGesture: {
      onStartCb: undefined,
      onUpdateCb: undefined,
      onEndCb: undefined,
      onFinalizeCb: undefined,
    } as CapturedPanGesture,
    settingsModelCalls: 0,
    settingsNavEvents: [] as string[],
  };
});

function flattenRnStyle(style: unknown): Record<string, unknown> {
  if (!style) return {};
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.map(flattenRnStyle));
  }
  if (typeof style === 'object') {
    return style as Record<string, unknown>;
  }
  return {};
}

vi.mock('react-native', () => {
  const makeHost = (tag: string, kind: string) =>
    forwardRef<unknown, Record<string, unknown>>(function MockRnHost(props, ref) {
      const {
        children,
        testID,
        accessibilityLabel,
        accessibilityRole,
        pointerEvents,
        style,
        onPress,
        onValueChange,
        value,
      } = props;
      if (typeof testID === 'string' && typeof onPress === 'function') {
        uiProbes.pressablesByTestId.set(testID, onPress as () => void);
      }
      if (typeof accessibilityLabel === 'string' && typeof onPress === 'function') {
        uiProbes.pressablesByAriaLabel.set(accessibilityLabel, onPress as () => void);
      }
      if (typeof testID === 'string' && typeof onValueChange === 'function') {
        uiProbes.switchHandlersByTestId.set(testID, onValueChange as (next: boolean) => void);
      }
      const flatStyle = flattenRnStyle(style);
      return createElement(
        tag,
        {
          ref,
          'data-rn-kind': kind,
          ...(testID ? { 'data-testid': testID } : {}),
          ...(accessibilityLabel ? { 'aria-label': accessibilityLabel } : {}),
          ...(accessibilityRole ? { role: accessibilityRole } : {}),
          ...(pointerEvents ? { 'data-pointer-events': String(pointerEvents) } : {}),
          ...(value !== undefined ? { 'data-switch-value': String(value) } : {}),
          'data-style-json': JSON.stringify(flatStyle),
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
      flatten: flattenRnStyle,
      absoluteFill: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
      hairlineWidth: 0.5,
    },
    Dimensions: {
      get: () => ({ width: 390, height: 844 }),
    },
    useWindowDimensions: () => ({ width: 390, height: 844 }),
    useColorScheme: () => 'light',
    BackHandler: {
      addEventListener: () => ({ remove: () => undefined }),
    },
    InteractionManager: {
      runAfterInteractions: (fn: () => void) => {
        fn();
        return { cancel: () => undefined };
      },
    },
    Share: {
      share: async () => ({ action: 'sharedAction' }),
    },
    Keyboard: {
      addListener: () => ({ remove: () => undefined }),
      dismiss: () => undefined,
    },
    AppState: {
      currentState: 'active',
      addEventListener: () => ({ remove: () => undefined }),
    },
    Linking: {
      openURL: async () => undefined,
    },
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
  };
});

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('react-native-reanimated', () => {
  const createAnimatedComponent = <P extends object>(comp: ComponentType<P>) => comp;
  return {
    default: {
      View: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
        createElement(
          'div',
          {
            'data-rn-kind': 'Reanimated.View',
            'data-style-json': JSON.stringify(flattenRnStyle(style)),
          },
          children
        ),
      Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
      createAnimatedComponent,
    },
    Easing: {
      out: (fn: unknown) => fn,
      inOut: (fn: unknown) => fn,
      cubic: () => 0,
      quad: () => 0,
    },
    Extrapolation: { CLAMP: 'clamp' },
    LinearTransition: { duration: () => ({}) },
    interpolate: (value: number, input: number[], output: number[]) => {
      const i0 = input[0] ?? 0;
      const i1 = input[1] ?? 1;
      const o0 = output[0] ?? 0;
      const o1 = output[1] ?? 0;
      if (i1 === i0) return o0;
      const t = Math.min(1, Math.max(0, (value - i0) / (i1 - i0)));
      return o0 + (o1 - o0) * t;
    },
    runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
    useAnimatedStyle: (fn: () => Record<string, unknown>) => fn(),
    useReducedMotion: () => true,
    useSharedValue: <T,>(initial: T) => {
      const boxRef = useRef<{ value: T } | null>(null);
      if (!boxRef.current) {
        boxRef.current = { value: initial };
        uiProbes.sharedValues.push(boxRef.current);
      }
      return boxRef.current;
    },
    withTiming: (toValue: number, _config?: unknown, callback?: (finished: boolean) => void) => {
      uiProbes.timings.push({ toValue, callback });
      return toValue;
    },
    withSpring: (toValue: number) => {
      uiProbes.springCalls.push(toValue);
      return toValue;
    },
    cancelAnimation: (sharedValue: unknown) => {
      uiProbes.cancelAnimationSpy(sharedValue);
    },
  };
});

vi.mock('react-native-gesture-handler', () => ({
  GestureDetector: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Gesture: {
    Pan: () => {
      const chain = {
        activeOffsetX: () => chain,
        onStart: (cb: () => void) => {
          uiProbes.panGesture.onStartCb = cb;
          return chain;
        },
        onUpdate: (cb: (event: { translationX: number }) => void) => {
          uiProbes.panGesture.onUpdateCb = cb;
          return chain;
        },
        onEnd: (cb: (event: { translationX: number; velocityX: number }) => void) => {
          uiProbes.panGesture.onEndCb = cb;
          return chain;
        },
        onFinalize: (cb: () => void) => {
          uiProbes.panGesture.onFinalizeCb = cb;
          return chain;
        },
      };
      return chain;
    },
  },
}));

vi.mock('moti', () => ({
  AnimatePresence: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  MotiView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('expo', () => ({ useEvent: () => undefined }));
vi.mock('expo-modules-core', () => ({
  NativeModulesProxy: {},
  requireNativeModule: () => ({}),
  requireOptionalNativeModule: () => null,
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: {}, manifest: null } }));
vi.mock('expo-asset', () => ({ Asset: { fromModule: () => ({ downloadAsync: async () => undefined }) } }));
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
}));
vi.mock('react-native-svg', () => ({
  default: () => null,
  Svg: () => null,
  Path: () => null,
  Circle: () => null,
  Rect: () => null,
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  },
}));

vi.mock('lucide-react-native', () => {
  const Icon = () => createElement('span');
  const names = [
    'Activity', 'AlertTriangle', 'Check', 'CheckCircle2', 'ChevronRight', 'Folder',
    'Globe2', 'Info', 'Minus', 'MoreHorizontal', 'PenSquare', 'Pencil', 'Pin',
    'Plus', 'Search', 'Settings', 'Share2', 'ShieldAlert', 'Trash2', 'X',
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

vi.mock('../src/features/settings/internal/useSettingsScreenModel', () => ({
  useSettingsScreenModel: () => {
    uiProbes.settingsModelCalls += 1;
    return { onClose: () => undefined };
  },
}));

vi.mock('../src/features/settings/internal/SettingsScreen', () => ({
  SettingsScreen: forwardRef(function MockSettingsScreen(_props: unknown, ref) {
    useImperativeHandle(ref, () => ({
      resetNavigation: () => uiProbes.settingsNavEvents.push('resetNavigation'),
      handleBack: () => {
        uiProbes.settingsNavEvents.push('handleBack');
        return false;
      },
      openProviders: () => uiProbes.settingsNavEvents.push('openProviders'),
      openProviderModels: (id: string) => uiProbes.settingsNavEvents.push(`openProviderModels:${id}`),
      openActiveProviderModels: () => uiProbes.settingsNavEvents.push('openActiveProviderModels'),
      openToolsSection: (tool: string) => uiProbes.settingsNavEvents.push(`openToolsSection:${tool}`),
    }));
    return createElement('div', { 'data-testid': 'mock-settings-screen' }, 'SettingsScreen');
  }),
}));

function parseStyle(el: StubElement): Record<string, unknown> {
  const raw = el.getAttribute('data-style-json');
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

describe('R3 Overlay、ComposerSearchSheet、ProjectDrawerShell 与 SettingsPane 契约测试', () => {
  let doc: StubDocument;
  let container: StubElement;
  let activeRoot: ReturnType<typeof createRoot> | null = null;
  let activeSession: WorkspaceSession | null = null;

  beforeEach(() => {
    uiProbes.pressablesByTestId.clear();
    uiProbes.pressablesByAriaLabel.clear();
    uiProbes.switchHandlersByTestId.clear();
    uiProbes.timings = [];
    uiProbes.springCalls = [];
    uiProbes.sharedValues = [];
    uiProbes.cancelAnimationSpy.mockClear();
    uiProbes.panGesture = {};
    uiProbes.settingsModelCalls = 0;
    uiProbes.settingsNavEvents = [];

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
    if (uiProbes.prevDevDescriptor) {
      Object.defineProperty(globalThis, '__DEV__', uiProbes.prevDevDescriptor);
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
      vi.useRealTimers();
      restoreGlobals();
    }
  });

  it('ComposerSearchSheet renders empty when hidden, switches compact vs regular modes cleanly around 180px, avoids full-screen scrim, and fires toggle/manage/select callbacks', async () => {
    const externalSearch: ExternalSearchSettings = {
      enabled: false,
      selectedServiceId: 'svc-tavily',
      maxResults: 5,
      maxToolRounds: 2,
      services: [
        {
          id: 'svc-tavily',
          kind: 'tavily',
          name: 'Tavily Search',
          apiKey: 'tavily-key',
          endpoint: '',
        },
      ],
    };

    const onClose = vi.fn();
    const onSelectOff = vi.fn();
    const onSelectProvider = vi.fn();
    const onSelectExternal = vi.fn();
    const onManage = vi.fn();

    const baseProps = {
      webSearchEnabled: true,
      webSearchReady: true,
      externalSearch,
      modelSupportsTools: true,
      onClose,
      onSelectOff,
      onSelectProvider,
      onSelectExternal,
      onManage,
    };

    activeRoot = createRoot(container);

    // 1) visible={false} 必须返回 null
    await act(async () => {
      activeRoot?.render(
        elWithChildren(
          KelivoThemeProvider,
          { scheme: 'light' },
          createElement(ComposerSearchSheet, { ...baseProps, visible: false, maxHeight: 120 })
        )
      );
    });
    expect(container.findByTestId('composer-search-menu')).toBeNull();
    expect(container.childNodes.length).toBe(0);

    // 2) maxHeight={120} 与 {180} 启用紧凑模式并校验头高 <= 70px、列表区 >= 48px、无全屏遮罩
    for (const compactHeight of [120, 180]) {
      await act(async () => {
        activeRoot?.render(
          elWithChildren(
            KelivoThemeProvider,
            { scheme: 'light' },
            createElement(ComposerSearchSheet, {
              ...baseProps,
              visible: true,
              maxHeight: compactHeight,
            })
          )
        );
      });

      const menu = container.findByTestId('composer-search-menu');
      const tags = container.findByTestId('composer-search-tags');
      expect(menu).not.toBeNull();
      expect(tags).not.toBeNull();
      if (!menu || !tags) throw new Error('missing composer-search-menu/tags');

      const popoverStyle = parseStyle(menu);
      expect(popoverStyle).toMatchObject({
        position: 'absolute',
        bottom: '100%',
        zIndex: 30,
      });
      // 无全屏遮罩层（不会出现 position: 'fixed'）
      expect(
        container.findAll((el) => parseStyle(el).position === 'fixed')
      ).toHaveLength(0);

      // 紧凑模式下 sheetHandle 不渲染（tags 子元素：title + masterCard + ScrollView = 3）
      expect(tags.childNodes.length).toBe(3);

      const sheetStyle = parseStyle(tags);
      expect(sheetStyle.paddingTop).toBe(4);
      expect(sheetStyle.paddingBottom).toBe(4);

      const titleEl = tags.childNodes[0] as StubElement;
      const masterCardEl = tags.childNodes[1] as StubElement;
      const scrollEl = tags.childNodes[2] as StubElement;
      const titleStyle = parseStyle(titleEl);
      const masterCardStyle = parseStyle(masterCardEl);
      const scrollStyle = parseStyle(scrollEl);

      // 头部总高：sheet paddingTop(4)+paddingBottom(4) + title(lineHeight 16 + marginBottom 2) + masterCard(height 34 + marginBottom 4) = 68 <= 70
      const headerHeight =
        Number(sheetStyle.paddingTop ?? 0) +
        Number(sheetStyle.paddingBottom ?? 0) +
        Number(titleStyle.lineHeight ?? 0) +
        Number(titleStyle.marginBottom ?? 0) +
        Number(masterCardStyle.height ?? 0) +
        Number(masterCardStyle.marginBottom ?? 0);
      expect(headerHeight).toBeLessThanOrEqual(70);

      const expectedListMaxH = Math.max(48, compactHeight - 66);
      expect(scrollStyle.maxHeight).toBe(expectedListMaxH);
      expect(Number(scrollStyle.maxHeight)).toBeGreaterThanOrEqual(48);

      // 紧凑选项卡片高度 = 42
      const builtinOption = container.findByTestId('composer-search-option-builtin');
      expect(builtinOption).not.toBeNull();
      expect(parseStyle(builtinOption!).height).toBe(42);
    }

    // 3) maxHeight={181} 与 {420} 切回常规模式（渲染 sheetHandle，常规卡片 height=48）
    for (const regularHeight of [181, 420]) {
      await act(async () => {
        activeRoot?.render(
          elWithChildren(
            KelivoThemeProvider,
            { scheme: 'light' },
            createElement(ComposerSearchSheet, {
              ...baseProps,
              visible: true,
              maxHeight: regularHeight,
            })
          )
        );
      });
      const tags = container.findByTestId('composer-search-tags');
      expect(tags).not.toBeNull();
      expect(tags?.childNodes.length).toBe(4);
      const tagsStyle = parseStyle(tags!);
      expect(tagsStyle.maxHeight).toBe(regularHeight);
      expect(tagsStyle.overflow).toBe('hidden');
      const scrollEl = tags!.childNodes[3] as StubElement;
      const scrollStyle = parseStyle(scrollEl);
      expect(scrollStyle.flexGrow).toBe(0);
      expect(scrollStyle.flexShrink).toBe(1);
      expect(scrollStyle.minHeight).toBe(0);
      if (regularHeight === 420) {
        expect(132 + Number(scrollStyle.maxHeight)).toBeLessThanOrEqual(regularHeight + 2);
      } else {
        // 边界 181px 下常规固定头部约 132px，依靠 flexShrink: 1 + overflow: hidden 弹性收缩至约 49px (>= 48px)
        expect(regularHeight - 132).toBeGreaterThanOrEqual(48);
      }
      const builtinOption = container.findByTestId('composer-search-option-builtin');
      expect(parseStyle(builtinOption!).height).toBe(48);
    }

    // 4) 开关、管理齿轮与选项回调真实可触发
    uiProbes.pressablesByTestId.get('composer-search-manage')?.();
    expect(onManage).toHaveBeenCalledTimes(1);

    uiProbes.pressablesByTestId.get('composer-search-option-builtin')?.();
    expect(onSelectProvider).toHaveBeenCalledTimes(1);

    uiProbes.pressablesByTestId.get('composer-search-option-tavily')?.();
    expect(onSelectExternal).toHaveBeenCalledWith('svc-tavily');

    uiProbes.switchHandlersByTestId.get('composer-search-toggle')?.(false);
    expect(onSelectOff).toHaveBeenCalledTimes(1);
  });

  it('AppDialogHost and OverlayPortal enforce sheet->fullscreen->dialog stacking with single top pointerEvents="box-none", clean up portals on hide/unmount, and avoid recursive loops with ConfirmDialog/NoticeDialog', async () => {
    activeRoot = createRoot(container);

    // 1) 空闲返回 null
    await act(async () => {
      activeRoot?.render(
        elWithChildren(KelivoThemeProvider, { scheme: 'light' }, createElement(AppDialogHost))
      );
    });
    expect(container.findByTestId('app-dialog-host')).toBeNull();
    expect(getOverlayHostSnapshot().portals).toEqual([]);

    // 2) 同时挂载 sheet Portal + fullscreen Portal + requestConfirm(...)
    let confirmPromise!: Promise<boolean>;
    await act(async () => {
      activeRoot?.render(
        elWithChildren(
          KelivoThemeProvider,
          { scheme: 'light' },
          createElement(
            'div',
            null,
            elWithChildren(
              OverlayPortal,
              { visible: true, layer: 'sheet' },
              createElement('div', { 'data-testid': 'portal-sheet-body' }, 'SHEET')
            ),
            elWithChildren(
              OverlayPortal,
              { visible: true, layer: 'fullscreen' },
              createElement('div', { 'data-testid': 'portal-fullscreen-body' }, 'FULLSCREEN')
            ),
            createElement(AppDialogHost)
          )
        )
      );
    });

    await act(async () => {
      confirmPromise = requestConfirm({
        title: '确认操作',
        description: '验证叠压层级',
        confirmLabel: '确认',
        cancelLabel: '取消',
      });
    });

    const hostRoot = container.findByTestId('app-dialog-host');
    expect(hostRoot).not.toBeNull();
    const layers = hostRoot!.childNodes.filter(
      (node): node is StubElement => node instanceof StubElement
    );
    expect(layers).toHaveLength(3);
    // 渲染顺序：sheet -> fullscreen -> dialog
    expect(layers[0].findByTestId('portal-sheet-body')).not.toBeNull();
    expect(layers[1].findByTestId('portal-fullscreen-body')).not.toBeNull();
    expect(layers[2].textContent).toContain('确认操作');

    // 仅最顶层容器为 box-none，所有下层严格为 none
    expect(layers[0].getAttribute('data-pointer-events')).toBe('none');
    expect(layers[1].getAttribute('data-pointer-events')).toBe('none');
    expect(layers[2].getAttribute('data-pointer-events')).toBe('box-none');

    // 结算 dialog 后，仅剩 sheet -> fullscreen，此时顶层转移至 fullscreen
    await act(async () => {
      uiProbes.pressablesByAriaLabel.get('取消')?.();
    });
    await expect(confirmPromise).resolves.toBe(false);

    const layersAfterConfirm = container.findByTestId('app-dialog-host')!.childNodes.filter(
      (node): node is StubElement => node instanceof StubElement
    );
    expect(layersAfterConfirm).toHaveLength(2);
    expect(layersAfterConfirm[0].getAttribute('data-pointer-events')).toBe('none');
    expect(layersAfterConfirm[1].getAttribute('data-pointer-events')).toBe('box-none');

    // 3) 切换 visible={false} 与卸载组件后自动清理 portals 并恢复返回 null
    await act(async () => {
      activeRoot?.render(
        elWithChildren(
          KelivoThemeProvider,
          { scheme: 'light' },
          createElement(
            'div',
            null,
            elWithChildren(
              OverlayPortal,
              { visible: false, layer: 'sheet' },
              createElement('div', { 'data-testid': 'portal-sheet-body' }, 'SHEET')
            ),
            createElement(AppDialogHost)
          )
        )
      );
    });
    expect(getOverlayHostSnapshot().portals).toEqual([]);
    expect(container.findByTestId('app-dialog-host')).toBeNull();

    // 4) 同时挂载 AppDialogHost + ConfirmDialog visible + NoticeDialog visible 验证无递归死循环
    await act(async () => {
      activeRoot?.render(
        elWithChildren(
          KelivoThemeProvider,
          { scheme: 'light' },
          createElement(
            'div',
            null,
            createElement(ConfirmDialog, {
              visible: true,
              title: '声明式确认',
              description: '无自注册环路',
              onConfirm: () => undefined,
              onCancel: () => undefined,
            }),
            createElement(NoticeDialog, {
              visible: true,
              title: '声明式通知',
              description: '正常共存',
              onClose: () => undefined,
            }),
            createElement(AppDialogHost)
          )
        )
      );
    });
    const bothHost = container.findByTestId('app-dialog-host');
    expect(bothHost).not.toBeNull();
    expect(bothHost!.textContent).toContain('声明式确认');
    expect(bothHost!.textContent).toContain('声明式通知');
    expect(getOverlayHostSnapshot().portals).toHaveLength(2);

    // 彻底卸载，确认全局快照清空
    await act(async () => {
      activeRoot?.render(createElement('div'));
    });
    expect(getOverlayHostSnapshot().portals).toEqual([]);
  });

  it('ProjectDrawerShell handles unmount/pointerEvents/a11y disambiguation with ProjectDrawer, protects rapid open->close->open epoch from stale withTiming callbacks, and handles Gesture.Pan onFinalize safely', async () => {
    activeRoot = createRoot(container);
    const onClose = vi.fn();

    // 1) open={false} 初始返回 null
    await act(async () => {
      activeRoot?.render(
        elWithChildren(
          KelivoThemeProvider,
          { scheme: 'light' },
          elWithChildren(
            ProjectDrawerShell,
            { open: false, onClose },
            createElement('div', { 'data-testid': 'drawer-inner' }, 'DRAWER')
          )
        )
      );
    });
    expect(container.findByTestId('project-drawer-shell')).toBeNull();
    expect(uiProbes.cancelAnimationSpy).toHaveBeenCalledTimes(1);

    // 2) 快速开关 open: true -> false -> true，验证旧 withTiming(0) 回调受 epochRef/openRef 保护不误卸载
    await act(async () => {
      activeRoot?.render(
        elWithChildren(
          KelivoThemeProvider,
          { scheme: 'light' },
          elWithChildren(
            ProjectDrawerShell,
            { open: true, onClose },
            createElement('div', { 'data-testid': 'drawer-inner' }, 'DRAWER')
          )
        )
      );
    });
    expect(container.findByTestId('project-drawer-shell')).not.toBeNull();
    expect(
      container.findByTestId('project-drawer-shell')?.getAttribute('data-pointer-events')
    ).toBe('auto');
    uiProbes.cancelAnimationSpy.mockClear();

    await act(async () => {
      activeRoot?.render(
        elWithChildren(
          KelivoThemeProvider,
          { scheme: 'light' },
          elWithChildren(
            ProjectDrawerShell,
            { open: false, onClose },
            createElement('div', { 'data-testid': 'drawer-inner' }, 'DRAWER')
          )
        )
      );
    });
    const staleTiming = uiProbes.timings.find((item) => item.toValue === 0);
    expect(staleTiming).toBeDefined();
    // 关闭动画期间容器 pointerEvents 立即变为 none
    expect(
      container.findByTestId('project-drawer-shell')?.getAttribute('data-pointer-events')
    ).toBe('none');

    await act(async () => {
      activeRoot?.render(
        elWithChildren(
          KelivoThemeProvider,
          { scheme: 'light' },
          elWithChildren(
            ProjectDrawerShell,
            { open: true, onClose },
            createElement('div', { 'data-testid': 'drawer-inner' }, 'DRAWER')
          )
        )
      );
    });
    expect(uiProbes.cancelAnimationSpy).toHaveBeenCalledTimes(2);
    expect(uiProbes.cancelAnimationSpy.mock.calls[0]?.[0]).toBe(uiProbes.sharedValues[0]);
    expect(uiProbes.cancelAnimationSpy.mock.calls[1]?.[0]).toBe(uiProbes.sharedValues[0]);

    // 触发旧 withTiming(0) 的完成回调：绝不能误卸载已重新打开的抽屉
    await act(async () => {
      staleTiming?.callback?.(true);
    });
    expect(container.findByTestId('project-drawer-shell')).not.toBeNull();
    expect(container.findByTestId('drawer-inner')).not.toBeNull();

    // 3) Gesture.Pan() 未达阈值中断 -> onFinalize 回弹至 1
    uiProbes.springCalls = [];
    uiProbes.panGesture.onStartCb?.();
    uiProbes.panGesture.onUpdateCb?.({ translationX: -30 });
    uiProbes.panGesture.onEndCb?.({ translationX: -30, velocityX: -100 });
    const springsAfterSmallDrag = uiProbes.springCalls.length;
    uiProbes.panGesture.onFinalizeCb?.();
    expect(uiProbes.springCalls.length).toBeGreaterThan(springsAfterSmallDrag);
    expect(uiProbes.springCalls.at(-1)).toBe(1);
    expect(onClose).not.toHaveBeenCalled();

    // 4) Gesture.Pan() 达阈值触发 closingByGesture 后 -> onFinalize 不再回弹
    uiProbes.springCalls = [];
    uiProbes.panGesture.onStartCb?.();
    uiProbes.panGesture.onUpdateCb?.({ translationX: -200 });
    uiProbes.panGesture.onEndCb?.({ translationX: -200, velocityX: -900 });
    expect(onClose).toHaveBeenCalledTimes(1);
    uiProbes.panGesture.onFinalizeCb?.();
    expect(uiProbes.springCalls).toEqual([]);

    // 5) 联合真实 ProjectDrawer 验证遮罩 "关闭聊天记录遮罩" 与抽屉关闭按钮 "关闭聊天记录" 互不重名
    const initial = createDefaultWorkspace();
    const persistence = new MemoryWorkspacePersistenceAdapter({ initial });
    const session = new WorkspaceSession({ persistence, autoBoot: false });
    activeSession = session;
    await session.boot();

    let openDrawerFn: (() => void) | null = null;
    function DrawerHarness() {
      const nav = useProjectConversationNavigation();
      openDrawerFn = nav.openDrawer;
      return createElement(ProjectDrawer, {
        chat: {
          resetComposer: () => undefined,
          clearTaskQueries: () => undefined,
          revealMessage: () => undefined,
          applyPromptTemplate: () => undefined,
          showNotice: () => undefined,
        },
      });
    }

    await act(async () => {
      activeRoot?.render(
        elWithChildren(
          WorkspaceSessionProvider,
          { adapters: { persistence }, session },
          elWithChildren(
            KelivoThemeProvider,
            { scheme: 'light' },
            createElement(
              ProjectsConversationsProvider,
              null,
              createElement(DrawerHarness)
            )
          )
        )
      );
    });

    await act(async () => {
      openDrawerFn?.();
    });

    const scrimButtons = container.findAll(
      (el) => el.getAttribute('aria-label') === '关闭聊天记录遮罩'
    );
    const closeButtons = container.findAll(
      (el) => el.getAttribute('aria-label') === '关闭聊天记录'
    );
    expect(scrimButtons).toHaveLength(1);
    expect(closeButtons).toHaveLength(1);
    expect(scrimButtons[0]).not.toBe(closeButtons[0]);
  });

  it('SettingsPane unmounts completely when closed (zero useSettingsScreenModel calls), mounts and navigates on open({ kind: "providers" }), and unmounts again on close()', async () => {
    const initial = createDefaultWorkspace();
    const persistence = new MemoryWorkspacePersistenceAdapter({ initial });
    const session = new WorkspaceSession({ persistence, autoBoot: false });
    activeSession = session;
    await session.boot();

    let launcherHandle: ReturnType<typeof useSettingsLauncher> | null = null;
    function Harness() {
      launcherHandle = useSettingsLauncher();
      return createElement(SettingsPane);
    }

    activeRoot = createRoot(container);
    await act(async () => {
      activeRoot?.render(
        elWithChildren(
          WorkspaceSessionProvider,
          { adapters: { persistence }, session },
          createElement(
            SettingsProductivityProvider,
            null,
            createElement(Harness)
          )
        )
      );
    });

    // 关闭态：输出为空且 useSettingsScreenModel 零调用
    expect(container.findByTestId('mock-settings-screen')).toBeNull();
    expect(uiProbes.settingsModelCalls).toBe(0);

    // 打开到 providers：真实挂载并导航
    await act(async () => {
      launcherHandle?.open({ kind: 'providers' });
    });
    expect(container.findByTestId('mock-settings-screen')).not.toBeNull();
    expect(uiProbes.settingsModelCalls).toBeGreaterThanOrEqual(1);
    expect(uiProbes.settingsNavEvents).toContain('openProviders');

    // close() 后彻底卸载
    const callsBeforeClose = uiProbes.settingsModelCalls;
    await act(async () => {
      launcherHandle?.close();
    });
    expect(container.findByTestId('mock-settings-screen')).toBeNull();
    expect(uiProbes.settingsModelCalls).toBe(callsBeforeClose);
  });
});
