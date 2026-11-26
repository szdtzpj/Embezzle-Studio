import { createRequire } from 'node:module';
import {
  act,
  createElement,
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
import { ChatPane } from '../src/features/chat/ChatPane';
import { ChatProvider } from '../src/features/chat/ChatProvider';
import { createProductionChatAudioAdapter } from '../src/features/chat/orchestration/ChatAudioAdapter';
import type { ProviderAdapterRegistry } from '../src/features/chat/orchestration/ProviderAdapterRegistry';
import { ProjectDrawer } from '../src/features/projects/ProjectDrawer';
import {
  ProjectsConversationsProvider,
  useProjectConversationNavigation,
} from '../src/features/projects/ProjectsConversationsProvider';
import { AppearanceProvider } from '../src/ui/appearance/AppearanceProvider';
import { AppDialogHost } from '../src/ui/components/AppDialogHost';
import { ComposerSearchSheet } from '../src/ui/components/SearchServicesPanel';
import {
  getOverlayHostSnapshot,
  removeOverlayPortal,
  upsertOverlayPortal,
} from '../src/ui/components/dialogService';
import { KelivoThemeProvider } from '../src/ui/theme';

function elWithChildren<P extends { children?: ReactNode }>(
  component: ComponentType<P>,
  props: Omit<P, 'children'>,
  ...children: ReactNode[]
): ReactElement {
  return createElement(component as ComponentType<Omit<P, 'children'>>, props, ...children);
}

interface RnWebSheetApi {
  create: <T extends Record<string, unknown>>(styles: T) => T;
  flatten: (style: unknown) => Record<string, unknown>;
  getSheet?: () => { id: string; textContent: string };
}

interface RnWebModule {
  Platform: { OS: string; select: <T>(spec: Record<string, T>) => T };
  StyleSheet: RnWebSheetApi;
  View: ComponentType<Record<string, unknown>>;
  [key: string]: unknown;
}

const loadCjs = createRequire(import.meta.url);
const { renderToStaticMarkup } = loadCjs('react-dom/server') as {
  renderToStaticMarkup: (element: ReactElement) => string;
};
const { createRoot } = loadCjs('react-dom/client') as {
  createRoot: (container: unknown) => {
    render: (element: ReactElement) => void;
    unmount: () => void;
  };
};
const rnw = loadCjs('react-native-web') as RnWebModule;

const { prevDevDescriptor } = vi.hoisted(() => {
  const prevDesc = Object.getOwnPropertyDescriptor(globalThis, '__DEV__');
  if (!prevDesc) {
    Object.defineProperty(globalThis, '__DEV__', {
      value: false,
      configurable: true,
      writable: true,
      enumerable: true,
    });
  }
  return { prevDevDescriptor: prevDesc };
});

vi.mock('react-native', async () => {
  const actualRnw = (await vi.importActual('react-native-web')) as Record<string, unknown>;
  const actualDimensions = (actualRnw.Dimensions ?? {}) as Record<string, unknown>;
  return {
    ...actualRnw,
    Dimensions: {
      ...actualDimensions,
      get: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
    },
    useWindowDimensions: () => ({ width: 390, height: 844 }),
    InteractionManager: {
      runAfterInteractions: (fn: () => void) => {
        fn();
        return { cancel: () => undefined };
      },
    },
  };
});

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('react-native-reanimated', async () => {
  const actualRnw = (await vi.importActual('react-native-web')) as RnWebModule;
  return {
    default: {
      View: actualRnw.View,
      Text: actualRnw.Text,
      createAnimatedComponent: <P extends object>(comp: ComponentType<P>) => comp,
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
    useSharedValue: <T,>(initial: T) => ({ value: initial }),
    withTiming: <T,>(toValue: T) => toValue,
    withSpring: <T,>(toValue: T) => toValue,
    cancelAnimation: () => undefined,
  };
});

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
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
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
vi.mock('expo-sharing', () => ({
  isAvailableAsync: async () => false,
  shareAsync: async () => undefined,
}));
vi.mock('expo-video', () => ({
  VideoView: () => null,
  useVideoPlayer: () => ({ play: () => undefined, pause: () => undefined }),
}));
vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('expo-haptics', () => ({
  selectionAsync: async () => undefined,
  notificationAsync: async () => undefined,
  impactAsync: async () => undefined,
  NotificationFeedbackType: { Success: 'success', Warning: 'warning' },
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
}));
vi.mock('react-native-svg', () => ({
  default: () => null,
  Svg: () => null,
  Path: () => null,
  Circle: () => null,
  Rect: () => null,
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
vi.mock('expo-crypto', () => ({
  randomUUID: () => '00000000-0000-4000-8000-000000000000',
}));
vi.mock('lucide-react-native', () => {
  const Icon = () => createElement('span');
  const names = [
    'Activity', 'AlertTriangle', 'ArrowDown', 'BookOpen', 'Brain', 'Check',
    'CheckCircle2', 'ChevronDown', 'ChevronRight', 'Columns3', 'Copy', 'Download',
    'FileText', 'Folder', 'GitBranch', 'Globe2', 'Image', 'Info', 'Lightbulb',
    'Menu', 'MessageSquare', 'Mic', 'Minus', 'MoreHorizontal', 'PenSquare',
    'Pencil', 'Pin', 'Play', 'Plus', 'RefreshCw', 'Search', 'Settings', 'Share2',
    'ShieldAlert', 'ShieldCheck', 'SlidersHorizontal', 'Sparkles', 'Square',
    'Trash2', 'Video', 'Volume2', 'Wrench', 'X',
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
vi.mock('../src/features/chat/internal/presentation/ChatMessageRow', () => ({
  ChatMessageRow: () => null,
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
vi.mock('../src/ui/mobile/WorkspaceHub', () => ({
  WorkspaceHub: () => null,
  MainWorkspaceTabBar: () => null,
}));

// -------------------- 最小真实 DOM 桩（供 ProjectDrawerShell open->close 状态切换） --------------------
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
      for (const item of [...child.childNodes]) this.appendChild(item);
      child.childNodes = [];
      return child;
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore(newNode: StubNode, referenceNode: StubNode | null): StubNode {
    if (!referenceNode) return this.appendChild(newNode);
    if (newNode.nodeType === 11) {
      for (const item of [...newNode.childNodes]) this.insertBefore(item, referenceNode);
      newNode.childNodes = [];
      return newNode;
    }
    if (newNode.parentNode) newNode.parentNode.removeChild(newNode);
    const idx = this.childNodes.indexOf(referenceNode);
    if (idx === -1) return this.appendChild(newNode);
    newNode.parentNode = this;
    this.childNodes.splice(idx, 0, newNode);
    return newNode;
  }
  removeChild(child: StubNode): StubNode {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }
  addEventListener(type: string, fn: (event: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }
  removeEventListener(type: string, fn: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  get firstChild(): StubNode | null {
    return this.childNodes[0] ?? null;
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
  set nodeValue(v: string) {
    this.data = v;
  }
}

class StubComment extends StubNode {
  data: string;
  constructor(data: string, ownerDocument: StubDocument) {
    super(8, ownerDocument);
    this.data = data;
  }
}

function createStubStyle(): Record<string, unknown> & {
  setProperty: (name: string, value: string) => void;
  removeProperty: (name: string) => string;
  getPropertyValue: (name: string) => string;
} {
  const props = new Map<string, string>();
  const styleObj: Record<string, unknown> & {
    setProperty: (name: string, value: string) => void;
    removeProperty: (name: string) => string;
    getPropertyValue: (name: string) => string;
  } = {
    setProperty(name: string, value: string) {
      props.set(name, String(value));
      styleObj[name] = String(value);
    },
    removeProperty(name: string) {
      const prev = props.get(name) ?? '';
      props.delete(name);
      delete styleObj[name];
      return prev;
    },
    getPropertyValue(name: string) {
      return props.get(name) ?? '';
    },
  };
  return styleObj;
}

class StubElement extends StubNode {
  tagName: string;
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  attributes = new Map<string, string>();
  className = '';
  style = createStubStyle();
  value = '';
  checked = false;
  disabled = false;
  selectionStart: number | null = 0;
  selectionEnd: number | null = 0;

  constructor(tagName: string, ownerDocument: StubDocument) {
    super(1, ownerDocument);
    this.tagName = tagName.toUpperCase();
  }
  setAttribute(name: string, value: string): void {
    if (name === 'class') this.className = String(value);
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    if (name === 'class') this.className = '';
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
      if (node instanceof StubElement && predicate(node)) out.push(node);
      for (const child of node.childNodes) visit(child);
    };
    visit(this);
    return out;
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
  createElement(tag: string): StubElement {
    return new StubElement(tag, this);
  }
  createElementNS(_ns: string, tag: string): StubElement {
    return new StubElement(tag, this);
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

function extractCssRulesByClass(sheetText: string, classAttr: string | null): string {
  if (!classAttr) return '';
  const classNames = classAttr.split(/\s+/).filter(Boolean);
  const rules: string[] = [];
  for (const name of classNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\.${escaped}\\b[^{]*\\{[^}]+\\}`, 'g');
    const matches = sheetText.match(regex);
    if (matches) rules.push(...matches);
  }
  return rules.join('\n');
}

function getElementStyleTextByTestId(
  html: string,
  sheetText: string,
  testId: string
): string {
  const tagRegex = new RegExp(`<[^>]*\\bdata-testid="${testId}"[^>]*>`, 'i');
  const tagMatch = html.match(tagRegex);
  if (!tagMatch) return '';
  const tag = tagMatch[0];
  const classMatch = tag.match(/\bclass="([^"]*)"/i);
  const styleMatch = tag.match(/\bstyle="([^"]*)"/i);
  const classCss = extractCssRulesByClass(sheetText, classMatch?.[1] ?? null);
  return `${classCss}\n${styleMatch?.[1] ?? ''}`;
}

describe('Web react-native-web 几何样式编译契约', () => {
  const registeredPortalIds: string[] = [];
  let activeRoot: ReturnType<typeof createRoot> | null = null;
  let activeSession: WorkspaceSession | null = null;

  beforeEach(() => {
    expect(rnw.Platform.OS).toBe('web');
  });

  afterAll(() => {
    if (prevDevDescriptor) {
      Object.defineProperty(globalThis, '__DEV__', prevDevDescriptor);
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
      for (const id of registeredPortalIds.splice(0)) {
        removeOverlayPortal(id);
      }
      vi.useRealTimers();
      restoreGlobals();
    }
  });

  it('mounts real ChatPane and compiles its root shell container into react-native-web 100dvh, maxHeight: 100dvh, overflow: hidden, and minHeight: 0 CSS', async () => {
    const initial = createDefaultWorkspace();
    initial.messages = [];
    initial.conversations = [
      {
        ...initial.conversations[0],
        messages: [],
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

    const html = renderToStaticMarkup(
      createElement(
        'div',
        { 'data-testid': 'chatpane-render-root' },
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
      )
    );

    expect(html).toContain('data-testid="model-picker-trigger"');

    const rootMarker = 'data-testid="chatpane-render-root"';
    const rootStart = html.indexOf(rootMarker);
    expect(rootStart).toBeGreaterThan(-1);
    const rootCloseIdx = html.indexOf('>', rootStart);
    const firstChildDivMatch = html.slice(rootCloseIdx + 1).match(/<div\b[^>]*>/i);
    expect(firstChildDivMatch?.[0]).toBeTruthy();

    const shellTag = firstChildDivMatch![0];
    const classMatch = shellTag.match(/\bclass="([^"]*)"/i);
    const styleMatch = shellTag.match(/\bstyle="([^"]*)"/i);
    const sheetCss = rnw.StyleSheet.getSheet?.().textContent ?? '';
    const shellCss = `${extractCssRulesByClass(sheetCss, classMatch?.[1] ?? null)}\n${styleMatch?.[1] ?? ''}`;

    expect(shellCss).toContain('height:100dvh');
    expect(shellCss).toContain('max-height:100dvh');
    expect(shellCss).toMatch(/overflow(?:-x)?:hidden/);
    expect(shellCss).toContain('overflow-y:hidden');
    expect(shellCss).toContain('min-height:0');
  });

  it('compiles active AppDialogHost into real Web position: fixed, z-index: 9999, and strict single top-layer pointer-events isolation', () => {
    registeredPortalIds.push('web-contract-sheet', 'web-contract-dialog');
    upsertOverlayPortal({
      id: 'web-contract-sheet',
      layer: 'sheet',
      render: () => createElement(rnw.View, { testID: 'web-sheet-content' }),
    });
    upsertOverlayPortal({
      id: 'web-contract-dialog',
      layer: 'dialog',
      render: () => createElement(rnw.View, { testID: 'web-dialog-content' }),
    });
    expect(getOverlayHostSnapshot().portals).toHaveLength(2);

    const html = renderToStaticMarkup(
      elWithChildren(KelivoThemeProvider, { scheme: 'light' }, createElement(AppDialogHost))
    );
    expect(html).toContain('data-testid="app-dialog-host"');

    const sheetCss = rnw.StyleSheet.getSheet?.().textContent ?? '';
    const hostCss = getElementStyleTextByTestId(html, sheetCss, 'app-dialog-host');
    expect(hostCss).toContain('position:fixed');
    expect(hostCss).toContain('z-index:9999');

    // 验证两层子容器 pointer-events 隔离：底层 sheet 容器为 pointer-events: none，顶层 dialog 容器为 box-none（非 none）
    const sheetIdx = html.indexOf('data-testid="web-sheet-content"');
    const dialogIdx = html.indexOf('data-testid="web-dialog-content"');
    expect(sheetIdx).toBeGreaterThan(-1);
    expect(dialogIdx).toBeGreaterThan(sheetIdx);

    const beforeSheetTags = [...html.slice(0, sheetIdx).matchAll(/<div\b[^>]*>/g)];
    const sheetWrapperTag = beforeSheetTags.at(-1)?.[0] ?? '';
    const sheetWrapperClass = sheetWrapperTag.match(/\bclass="([^"]*)"/i)?.[1] ?? null;
    const sheetContainerCss = extractCssRulesByClass(sheetCss, sheetWrapperClass);
    // pointerEvents="none"：仅 pointer-events:none!important，不向子元素放行 pointer-events:auto
    expect(sheetContainerCss).toContain('pointer-events:none');
    expect(sheetContainerCss).not.toContain('pointer-events:auto');

    const betweenTags = [...html.slice(sheetIdx, dialogIdx).matchAll(/<div\b[^>]*>/g)];
    const dialogWrapperTag = betweenTags.at(-1)?.[0] ?? '';
    const dialogWrapperClass = dialogWrapperTag.match(/\bclass="([^"]*)"/i)?.[1] ?? null;
    const dialogContainerCss = extractCssRulesByClass(sheetCss, dialogWrapperClass);
    // pointerEvents="box-none"：自身穿透 + 直接子元素 `>* {pointer-events:auto;}` 允许交互
    expect(dialogContainerCss).toContain('pointer-events:auto');
  });

  it('compiles ComposerSearchSheet at maxHeight=120 with compact header <= 70px, scroll list maxHeight >= 48px, and zero full-screen scrim', () => {
    const externalSearch: ExternalSearchSettings = {
      enabled: false,
      selectedServiceId: 'svc-1',
      maxResults: 5,
      maxToolRounds: 2,
      services: [
        {
          id: 'svc-1',
          kind: 'tavily',
          name: 'Tavily',
          apiKey: 'k',
          endpoint: '',
        },
      ],
    };

    const html = renderToStaticMarkup(
      elWithChildren(
        KelivoThemeProvider,
        { scheme: 'light' },
        createElement(ComposerSearchSheet, {
          visible: true,
          webSearchEnabled: true,
          webSearchReady: true,
          externalSearch,
          modelSupportsTools: true,
          maxHeight: 120,
          onClose: () => undefined,
          onSelectOff: () => undefined,
          onSelectProvider: () => undefined,
          onSelectExternal: () => undefined,
          onManage: () => undefined,
        })
      )
    );

    expect(html).toContain('data-testid="composer-search-menu"');
    expect(html).toContain('data-testid="composer-search-tags"');
    expect(html).toContain('data-testid="composer-search-option-builtin"');

    const sheetCss = rnw.StyleSheet.getSheet?.().textContent ?? '';
    const menuCss = getElementStyleTextByTestId(html, sheetCss, 'composer-search-menu');
    const tagsCss = getElementStyleTextByTestId(html, sheetCss, 'composer-search-tags');

    expect(menuCss).toContain('position:absolute');
    expect(menuCss).toContain('bottom:100%');
    expect(menuCss).toContain('z-index:30');
    expect(menuCss).not.toContain('position:fixed');

    // 验证紧凑面板 max-height:120px 与内部列表 max-height:54px（120 - 66 = 54 >= 48）且无 position:fixed 遮罩
    expect(tagsCss).toContain('max-height:120px');
    expect(tagsCss).toContain('padding-top:4px');
    expect(tagsCss).toContain('padding-bottom:4px');

    const allTags = [...html.matchAll(/<[^>]+>/g)].map((m) => m[0]);
    const allElementCss = allTags.map((tag) => {
      const cls = tag.match(/\bclass="([^"]*)"/i)?.[1] ?? null;
      const inline = tag.match(/\bstyle="([^"]*)"/i)?.[1] ?? '';
      return `${extractCssRulesByClass(sheetCss, cls)}\n${inline}`;
    });

    expect(allElementCss.some((css) => css.includes('max-height:54px'))).toBe(true);
    expect(allElementCss.some((css) => css.includes('position:fixed'))).toBe(false);

    // 校验紧凑头部实算高（paddingTop 4 + paddingBottom 4 + title lineHeight 16 + mb 2 + masterCard 34 + mb 4 = 68 <= 70）
    expect(
      allElementCss.some((css) => css.includes('line-height:16px') && css.includes('margin-bottom:2px'))
    ).toBe(true);
    expect(
      allElementCss.some((css) => css.includes('height:34px') && css.includes('margin-bottom:4px'))
    ).toBe(true);

    // 验证常规模式边界 maxHeight=181 下外层 overflow:hidden 与列表 flex-shrink:1 / min-height:0px 编译
    const regularHtml181 = renderToStaticMarkup(
      elWithChildren(
        KelivoThemeProvider,
        { scheme: 'light' },
        createElement(ComposerSearchSheet, {
          visible: true,
          webSearchEnabled: true,
          webSearchReady: true,
          externalSearch,
          modelSupportsTools: true,
          maxHeight: 181,
          onClose: () => undefined,
          onSelectOff: () => undefined,
          onSelectProvider: () => undefined,
          onSelectExternal: () => undefined,
          onManage: () => undefined,
        })
      )
    );
    const sheetCssAfter181 = rnw.StyleSheet.getSheet?.().textContent ?? '';
    const tagsCss181 = getElementStyleTextByTestId(regularHtml181, sheetCssAfter181, 'composer-search-tags');
    expect(tagsCss181).toContain('max-height:181px');
    expect(tagsCss181).toContain('overflow-y:hidden');

    const regular181Css = [...regularHtml181.matchAll(/<[^>]+>/g)].map((m) => {
      const tag = m[0];
      const cls = tag.match(/\bclass="([^"]*)"/i)?.[1] ?? null;
      const inline = tag.match(/\bstyle="([^"]*)"/i)?.[1] ?? '';
      return `${extractCssRulesByClass(sheetCssAfter181, cls)}\n${inline}`;
    });
    expect(
      regular181Css.some((css) => css.includes('flex-shrink:1') && css.includes('min-height:0px'))
    ).toBe(true);
  });

  it('mounts real ProjectDrawer + ProjectDrawerShell and compiles open vs closing states with distinct aria-labels and pointer-events: none when closing', async () => {
    const doc = new StubDocument();
    const container = doc.createElement('div');
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

    const initial = createDefaultWorkspace();
    const persistence = new MemoryWorkspacePersistenceAdapter({ initial });
    const session = new WorkspaceSession({ persistence, autoBoot: false });
    activeSession = session;
    await session.boot();

    let openDrawerFn: (() => void) | null = null;
    let closeDrawerFn: (() => void) | null = null;
    function DrawerHarness() {
      const nav = useProjectConversationNavigation();
      openDrawerFn = nav.openDrawer;
      closeDrawerFn = nav.closeDrawer;
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

    activeRoot = createRoot(container);
    await act(async () => {
      activeRoot?.render(
        elWithChildren(
          WorkspaceSessionProvider,
          { adapters: { persistence }, session },
          elWithChildren(
            KelivoThemeProvider,
            { scheme: 'light' },
            elWithChildren(
              ProjectsConversationsProvider,
              {},
              createElement(DrawerHarness)
            )
          )
        )
      );
    });

    // 初始关闭态不渲染 project-drawer-shell
    expect(container.findAll((el) => el.getAttribute('data-testid') === 'project-drawer-shell')).toHaveLength(0);

    // 打开真实 ProjectDrawer
    await act(async () => {
      openDrawerFn?.();
    });

    const sheetCss = rnw.StyleSheet.getSheet?.().textContent ?? '';
    const shellOpen = container.findAll((el) => el.getAttribute('data-testid') === 'project-drawer-shell')[0];
    const scrimOpen = container.findAll((el) => el.getAttribute('aria-label') === '关闭聊天记录遮罩')[0];
    const closeBtn = container.findAll((el) => el.getAttribute('aria-label') === '关闭聊天记录')[0];

    expect(shellOpen).toBeDefined();
    expect(scrimOpen).toBeDefined();
    expect(closeBtn).toBeDefined();
    expect(scrimOpen).not.toBe(closeBtn);
    expect(extractCssRulesByClass(sheetCss, shellOpen.getAttribute('class'))).not.toContain('pointer-events:none');

    // 调用 closeDrawer 进入关闭态，shell 与 scrim 必须立刻编译为 pointer-events: none
    await act(async () => {
      closeDrawerFn?.();
    });

    const shellClosing = container.findAll((el) => el.getAttribute('data-testid') === 'project-drawer-shell')[0];
    const scrimClosing = container.findAll((el) => el.getAttribute('aria-label') === '关闭聊天记录遮罩')[0];
    expect(extractCssRulesByClass(sheetCss, shellClosing.getAttribute('class'))).toContain('pointer-events:none');
    expect(extractCssRulesByClass(sheetCss, scrimClosing.getAttribute('class'))).toContain('pointer-events:none');
  });
});
