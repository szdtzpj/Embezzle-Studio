import { createRequire } from 'node:module';
import {
  act,
  createElement,
  forwardRef,
  useImperativeHandle,
  useRef,
  type ReactElement,
  type ReactNode,
} from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage, MediaAttachment, WebCitation } from '../src/domain/types';
import { buildMessageActivityModules } from '../src/services/messageActivity';
import {
  MessageMarkdown,
  highlightCodeTokens,
  parseInlineRichSegments,
  parseMarkdownBlocks,
} from '../src/ui/components/MessageMarkdown';
import {
  MessageActivityModules,
  resolveThinkingExpandedState,
} from '../src/ui/components/MessageActivityModules';
import { AppDialogHost } from '../src/ui/components/AppDialogHost';
import { ImageLightboxModal } from '../src/ui/components/ImageLightboxModal';
import { AttachmentPreview } from '../src/features/chat/internal/presentation/ChatAttachmentPresentation';
import { WebCitationList } from '../src/features/chat/internal/presentation/ChatMessagePresentation';
import { ChatMessageRow, type ChatMessageRowProps } from '../src/features/chat/internal/presentation/ChatMessageRow';

interface CapturedNode {
  type: string;
  props: Record<string, unknown>;
  text: string;
}

const {
  capturedNodes,
  mockClipboardSetStringAsync,
  mockSaveAttachmentToDevice,
  mockScrollTo,
  StubIcon,
  makeStub,
  makeChain,
} = vi.hoisted(() => {
  const nodes: CapturedNode[] = [];
  const clipboardSpy = vi.fn(async (_value: string) => true);
  const saveAttachmentSpy = vi.fn(async (att: MediaAttachment) => ({
    status: 'saved' as const,
    method: 'web-download' as const,
    name: att.name,
  }));
  const scrollToSpy = vi.fn();

  function extractText(node: unknown): string {
    if (typeof node === 'string' || typeof node === 'number') {
      return String(node);
    }
    if (Array.isArray(node)) {
      return node.map(extractText).join('');
    }
    if (node && typeof node === 'object' && 'props' in node) {
      const props = (node as { props?: Record<string, unknown> }).props;
      if (props) {
        return extractText(props.children);
      }
    }
    return '';
  }

  function createNodeStub(name: string) {
    function StubElement(props: Record<string, unknown> = {}) {
      const children =
        typeof props.children === 'function'
          ? (props.children as (state: { pressed: boolean }) => ReactNode)({ pressed: false })
          : props.children;
      nodes.push({
        type: name,
        props,
        text: extractText(children),
      });
      return createElement(
        'div',
        {
          'data-stub-type': name,
          'data-testid': typeof props.testID === 'string' ? props.testID : undefined,
          'aria-label':
            typeof props.accessibilityLabel === 'string' ? props.accessibilityLabel : undefined,
          role: typeof props.accessibilityRole === 'string' ? props.accessibilityRole : undefined,
          'aria-selected':
            typeof (props.accessibilityState as { selected?: boolean } | undefined)?.selected ===
            'boolean'
              ? String((props.accessibilityState as { selected?: boolean }).selected)
              : undefined,
          'aria-expanded':
            typeof (props.accessibilityState as { expanded?: boolean } | undefined)?.expanded ===
            'boolean'
              ? String((props.accessibilityState as { expanded?: boolean }).expanded)
              : undefined,
          'aria-disabled': props.disabled ? 'true' : undefined,
          onClick: () => {
            if (!props.disabled && typeof props.onPress === 'function') {
              (props.onPress as () => void)();
            }
          },
        },
        children as ReactNode
      );
    }
    StubElement.displayName = `Stub(${name})`;
    return StubElement;
  }

  function createChain() {
    const chain: Record<string, unknown> = {};
    const methods = [
      'onStart',
      'onBegin',
      'onUpdate',
      'onChange',
      'onEnd',
      'onFinalize',
      'numberOfTaps',
      'minPointers',
      'maxPointers',
      'minDistance',
      'activeOffsetX',
      'activeOffsetY',
      'enabled',
      'hitSlop',
      'runOnJS',
    ];
    for (const method of methods) {
      chain[method] = () => chain;
    }
    return chain;
  }

  return {
    capturedNodes: nodes,
    mockClipboardSetStringAsync: clipboardSpy,
    mockSaveAttachmentToDevice: saveAttachmentSpy,
    mockScrollTo: scrollToSpy,
    StubIcon: createNodeStub('Icon'),
    makeStub: createNodeStub,
    makeChain: createChain,
  };
});

vi.mock('react-native', () => {
  const ViewStub = forwardRef<unknown, Record<string, unknown>>(function ViewStubInner(
    props = {},
    ref
  ) {
    capturedNodes.push({
      type: 'View',
      props,
      text: '',
    });
    return createElement(
      'div',
      {
        ref,
        'data-stub-type': 'View',
        'data-testid': typeof props.testID === 'string' ? props.testID : undefined,
      },
      props.children as ReactNode
    );
  });

  const ScrollViewStub = forwardRef<
    { scrollTo: (opts: { x?: number; y?: number; animated?: boolean }) => void },
    Record<string, unknown>
  >(function ScrollViewStubInner(props, ref) {
    useImperativeHandle(ref, () => ({
      scrollTo: mockScrollTo,
    }));
    return makeStub('ScrollView')(props);
  });

  const TextStub = (props: Record<string, unknown> = {}) => {
    capturedNodes.push({
      type: 'Text',
      props,
      text:
        typeof props.children === 'string' || typeof props.children === 'number'
          ? String(props.children)
          : '',
    });
    return createElement(
      'span',
      {
        'data-stub-type': 'Text',
        'data-testid': typeof props.testID === 'string' ? props.testID : undefined,
        'aria-label':
          typeof props.accessibilityLabel === 'string' ? props.accessibilityLabel : undefined,
        role: typeof props.accessibilityRole === 'string' ? props.accessibilityRole : undefined,
        onClick: () => {
          if (typeof props.onPress === 'function') {
            (props.onPress as () => void)();
          }
        },
      },
      props.children as ReactNode
    );
  };

  const absoluteFillObj = {
    position: 'absolute' as const,
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  };

  return {
    Platform: {
      OS: 'android',
      select: <T,>(opts: Partial<Record<'android' | 'ios' | 'web' | 'default', T>>) =>
        opts.android ?? opts.default,
    },
    StyleSheet: {
      create: <T extends Record<string, unknown>>(s: T): T => s,
      flatten: <T,>(s: T): T => s,
      hairlineWidth: 1,
      absoluteFill: absoluteFillObj,
      absoluteFillObject: absoluteFillObj,
    },
    Dimensions: {
      get: () => ({ width: 390, height: 844, scale: 2, fontScale: 1 }),
      addEventListener: () => ({ remove: () => undefined }),
    },
    useWindowDimensions: () => ({ width: 390, height: 844, scale: 2, fontScale: 1 }),
    useColorScheme: () => 'light',
    Linking: {
      openURL: vi.fn(async () => undefined),
      canOpenURL: vi.fn(async () => true),
    },
    Share: { share: vi.fn(async () => ({ action: 'sharedAction' })) },
    BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
    Animated: {
      View: makeStub('Animated.View'),
      Text: makeStub('Animated.Text'),
      createAnimatedComponent: (c: unknown) => c,
    },
    View: ViewStub,
    Text: TextStub,
    TextInput: makeStub('TextInput'),
    ScrollView: ScrollViewStub,
    Pressable: makeStub('Pressable'),
    TouchableOpacity: makeStub('TouchableOpacity'),
    Image: makeStub('Image'),
    ActivityIndicator: makeStub('ActivityIndicator'),
  };
});

vi.mock('react-native-gesture-handler', () => ({
  GestureDetector: makeStub('GestureDetector'),
  GestureHandlerRootView: makeStub('GestureHandlerRootView'),
  Gesture: {
    Pinch: () => makeChain(),
    Pan: () => makeChain(),
    Tap: () => makeChain(),
    Simultaneous: () => makeChain(),
    Race: () => makeChain(),
    Exclusive: () => makeChain(),
  },
}));

vi.mock('react-native-reanimated', () => {
  const noopTransition = {
    duration: () => noopTransition,
    delay: () => noopTransition,
    springify: () => noopTransition,
  };
  return {
    default: {
      View: makeStub('Animated.View'),
      Text: makeStub('Animated.Text'),
      createAnimatedComponent: (c: unknown) => c,
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
    LinearTransition: noopTransition,
    FadeIn: noopTransition,
    FadeOut: noopTransition,
    interpolate: (_v: number, _i: number[], o: number[]) => o[0] ?? 0,
    cancelAnimation: () => undefined,
    useReducedMotion: () => false,
    useSharedValue: <T,>(value: T) => useRef({ value }).current,
    useAnimatedStyle: () => ({}),
    withTiming: <T,>(value: T) => value,
    withSpring: <T,>(value: T) => value,
    runOnJS: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  };
});

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 16, left: 0, right: 0 }),
  SafeAreaProvider: makeStub('SafeAreaProvider'),
}));

vi.mock('moti', () => ({
  AnimatePresence: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  MotiView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('expo', () => ({
  useEvent: () => ({ status: 'idle' }),
}));

vi.mock('expo-clipboard', () => ({
  setStringAsync: mockClipboardSetStringAsync,
  getStringAsync: async () => '',
}));

vi.mock('expo-sharing', () => ({
  isAvailableAsync: async () => true,
  shareAsync: async () => undefined,
}));

vi.mock('expo-haptics', () => ({
  selectionAsync: async () => undefined,
  notificationAsync: async () => undefined,
  impactAsync: async () => undefined,
  NotificationFeedbackType: { Success: 'success', Warning: 'warning' },
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
}));

vi.mock('expo-video', () => ({
  VideoView: makeStub('VideoView'),
  useVideoPlayer: () => ({ play: () => undefined, pause: () => undefined, status: 'idle' }),
}));

vi.mock('lucide-react-native', () =>
  new Proxy(
    { __esModule: true },
    {
      get(target, prop) {
        if (prop in target) return target[prop as keyof typeof target];
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        return StubIcon;
      },
      has: () => true,
    }
  )
);

vi.mock('@lobehub/icons-rn', () => {
  const makeBrand = () => Object.assign(() => createElement('span'), { Color: () => createElement('span') });
  return {
    __esModule: true,
    Bailian: makeBrand(),
    Bing: makeBrand(),
    ChatGLM: makeBrand(),
    Claude: makeBrand(),
    DeepSeek: makeBrand(),
    Doubao: makeBrand(),
    Gemini: makeBrand(),
    Grok: makeBrand(),
    Kimi: makeBrand(),
    Minimax: makeBrand(),
    NewAPI: makeBrand(),
    OpenAI: makeBrand(),
    Qwen: makeBrand(),
    Tavily: makeBrand(),
    Volcengine: makeBrand(),
    Zhipu: makeBrand(),
  };
});

vi.mock('../src/services/mediaExport', () => ({
  saveAttachmentToDevice: mockSaveAttachmentToDevice,
}));

vi.mock('../src/services/mediaStorage', () => ({
  resolveAttachmentDisplayUri: vi.fn(async (attachment: MediaAttachment) => attachment.uri),
}));

vi.mock('../src/features/chat/internal/ChatWorkspaceRuntime', () => ({
  useStreamingDraftSelector: () => null,
}));

// -------------------- 轻量真实 DOM 挂载桩（仅在单用例生命周期内启用并完整恢复） --------------------
class MiniNode {
  nodeType: number;
  parentNode: MiniNode | null = null;
  childNodes: MiniNode[] = [];
  ownerDocument: MiniDocument;

  constructor(nodeType: number, ownerDocument: MiniDocument) {
    this.nodeType = nodeType;
    this.ownerDocument = ownerDocument;
  }

  appendChild(child: MiniNode): MiniNode {
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

  insertBefore(newNode: MiniNode, refNode: MiniNode | null): MiniNode {
    if (!refNode) return this.appendChild(newNode);
    if (newNode.nodeType === 11) {
      for (const item of [...newNode.childNodes]) this.insertBefore(item, refNode);
      newNode.childNodes = [];
      return newNode;
    }
    if (newNode.parentNode) newNode.parentNode.removeChild(newNode);
    const idx = this.childNodes.indexOf(refNode);
    if (idx === -1) return this.appendChild(newNode);
    newNode.parentNode = this;
    this.childNodes.splice(idx, 0, newNode);
    return newNode;
  }

  removeChild(child: MiniNode): MiniNode {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  get firstChild(): MiniNode | null {
    return this.childNodes[0] ?? null;
  }

  get children(): MiniNode[] {
    return this.childNodes.filter((c) => c.nodeType === 1);
  }

  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }

  set textContent(val: string) {
    this.childNodes = [];
    if (val) this.appendChild(new MiniText(val, this.ownerDocument));
  }
}

class MiniText extends MiniNode {
  data: string;
  constructor(data: string, doc: MiniDocument) {
    super(3, doc);
    this.data = data;
  }
  get nodeValue(): string {
    return this.data;
  }
  set nodeValue(val: string) {
    this.data = val;
  }
  override get textContent(): string {
    return this.data;
  }
  override set textContent(val: string) {
    this.data = val;
  }
}

class MiniComment extends MiniNode {
  data: string;
  constructor(data: string, doc: MiniDocument) {
    super(8, doc);
    this.data = data;
  }
  override get textContent(): string {
    return '';
  }
  override set textContent(_val: string) {}
}

class MiniElement extends MiniNode {
  tagName: string;
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  attributes = new Map<string, string>();
  style: Record<string, string> = {};
  listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(tagName: string, doc: MiniDocument) {
    super(1, doc);
    this.tagName = tagName.toUpperCase();
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  getAttributeNames(): string[] {
    return Array.from(this.attributes.keys());
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
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
  click(): void {
    const set = this.listeners.get('click');
    if (set) {
      for (const listener of set) {
        listener({ type: 'click', target: this, preventDefault: () => undefined });
      }
    }
  }
}

class MiniDocument extends MiniNode {
  defaultView: unknown = null;
  documentElement: MiniElement;
  body: MiniElement;
  activeElement: MiniElement | null = null;
  constructor() {
    super(9, null as unknown as MiniDocument);
    this.ownerDocument = this;
    this.documentElement = new MiniElement('html', this);
    this.body = new MiniElement('body', this);
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
  }
  createElement(tagName: string): MiniElement {
    return new MiniElement(tagName, this);
  }
  createElementNS(_ns: string, tagName: string): MiniElement {
    return new MiniElement(tagName, this);
  }
  createTextNode(text: string): MiniText {
    return new MiniText(text, this);
  }
  createComment(text: string): MiniComment {
    return new MiniComment(text, this);
  }
  createDocumentFragment(): MiniNode {
    return new MiniNode(11, this);
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

function findElements(
  root: MiniNode,
  predicate: (el: MiniElement) => boolean
): MiniElement[] {
  const result: MiniElement[] = [];
  if (root instanceof MiniElement && predicate(root)) {
    result.push(root);
  }
  for (const child of root.childNodes) {
    result.push(...findElements(child, predicate));
  }
  return result;
}

function findLatestCapturedNode(
  predicate: (node: CapturedNode) => boolean
): CapturedNode | undefined {
  for (let i = capturedNodes.length - 1; i >= 0; i -= 1) {
    const node = capturedNodes[i];
    if (node && predicate(node)) {
      return node;
    }
  }
  return undefined;
}

const loadCjs = createRequire(import.meta.url);
const { createRoot } = loadCjs('react-dom/client') as {
  createRoot: (container: unknown) => {
    render: (element: ReactElement) => void;
    unmount: () => void;
  };
};
const { renderToStaticMarkup } = loadCjs('react-dom/server') as {
  renderToStaticMarkup: (element: ReactElement) => string;
};

async function mountInMiniDom(
  element: ReactElement,
  cleanupBucket: Array<() => void>
): Promise<{
  container: MiniElement;
  unmount: () => void;
}> {
  const globalRecord = globalThis as Record<string, unknown>;
  const keys = [
    'window',
    'document',
    'IS_REACT_ACT_ENVIRONMENT',
    'Node',
    'Element',
    'HTMLElement',
  ] as const;
  const backups = keys.map((key) => ({
    key,
    had: key in globalRecord,
    value: globalRecord[key],
  }));

  const doc = new MiniDocument();
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const win = {
    document: doc,
    Node: MiniNode,
    Element: MiniElement,
    HTMLElement: MiniElement,
    HTMLIFrameElement: class MiniHTMLIFrameElement {},
    ShadowRoot: class MiniShadowRoot {},
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    navigator: globalRecord.navigator,
  };
  doc.defaultView = win;

  globalRecord.document = doc;
  globalRecord.window = win;
  globalRecord.Node = MiniNode;
  globalRecord.Element = MiniElement;
  globalRecord.HTMLElement = MiniElement;
  globalRecord.IS_REACT_ACT_ENVIRONMENT = true;

  const root = createRoot(container);
  const unmount = () => {
    try {
      act(() => {
        root.unmount();
      });
    } finally {
      for (const item of backups) {
        if (item.had) {
          globalRecord[item.key] = item.value;
        } else {
          delete globalRecord[item.key];
        }
      }
    }
  };
  cleanupBucket.push(unmount);

  await act(async () => {
    root.render(element);
  });

  return {
    container,
    unmount,
  };
}

function createBaseRowProps(overrides: Partial<ChatMessageRowProps> = {}): ChatMessageRowProps {
  const baseMessage: ChatMessage = {
    id: 'msg-row-1',
    role: 'assistant',
    content: '正文回答',
    createdAt: 1_764_000_000_000,
    status: 'ready',
  };
  return {
    conversationId: 'conv-1',
    message: baseMessage,
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
    onCopy: vi.fn(),
    onRetry: vi.fn(),
    onBeginEdit: vi.fn(),
    onChangeEditDraft: vi.fn(),
    onCancelEdit: vi.fn(),
    onSaveEdit: vi.fn(),
    onShare: vi.fn(),
    onToggleActionMenu: vi.fn(),
    onSaveArtifact: vi.fn(),
    onSaveKnowledge: vi.fn(),
    onBranch: vi.fn(),
    onDelete: vi.fn(),
    onRemoveSystemInstruction: vi.fn(),
    onSelectComparisonAnswer: vi.fn(),
    onRefreshGenerationTask: vi.fn(),
    onToggleVideo: vi.fn(),
    onReadAloud: vi.fn(),
    ...overrides,
  };
}

describe('M3.2a 富媒体 Markdown、Thinking 状态机、全屏灯箱与引用联动单测', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
    vi.useRealTimers();
    capturedNodes.length = 0;
    vi.clearAllMocks();
  });

  describe('MessageMarkdown 解析与代码高亮', () => {
    it('支持块级 $$...$$ 与多反引号围栏保护，未闭合 $$ 安全退化为文本', () => {
      const md = [
        '单行公式：',
        '$$E = mc^2$$',
        '',
        '多行公式：',
        '$$',
        '\\sum_{i=1}^n i = \\frac{n(n+1)}{2}',
        '$$',
        '',
        '````markdown',
        '```ts',
        'const price = "$100";',
        '```',
        '````',
      ].join('\n');

      const blocks = parseMarkdownBlocks(md);
      const latexBlocks = blocks.filter((b) => b.kind === 'latex');
      expect(latexBlocks).toHaveLength(2);
      expect(latexBlocks[0]).toMatchObject({ kind: 'latex', text: 'E = mc^2', display: true });
      expect(latexBlocks[1]?.kind === 'latex' && latexBlocks[1].text).toContain('\\frac{n(n+1)}{2}');

      const codeBlocks = blocks.filter((b) => b.kind === 'code');
      expect(codeBlocks).toHaveLength(1);
      expect(codeBlocks[0]).toMatchObject({
        kind: 'code',
        language: 'markdown',
      });
      expect(codeBlocks[0]?.kind === 'code' && codeBlocks[0].text).toContain('$100');

      const unclosed = parseMarkdownBlocks('$$\n\\alpha + \\beta\n普通续写');
      expect(unclosed.some((b) => b.kind === 'latex')).toBe(false);
      const merged = unclosed.map((b) => ('text' in b ? b.text : '')).join('\n');
      expect(merged).toContain('\\alpha + \\beta');
      expect(merged).toContain('普通续写');
    });

    it('在入口执行 300k 字符截断并限制块数', () => {
      const singleHuge = 'X'.repeat(350_000);
      const singleBlocks = parseMarkdownBlocks(singleHuge);
      const totalChars = singleBlocks.reduce(
        (sum, b) => sum + ('text' in b ? b.text.length : 0),
        0
      );
      expect(totalChars).toBe(300_000);

      const multiHuge = '段落行\n\n'.repeat(3_000);
      const multiBlocks = parseMarkdownBlocks(multiHuge);
      expect(multiBlocks.length).toBeLessThanOrEqual(1_500);
    });

    it('正确区分货币金额、转义符、有效/越界引用角标与安全链接', () => {
      const citations: WebCitation[] = [
        { index: 1, id: 'c1', title: 'Doc 1', url: 'https://example.com/1' },
      ];
      const segments = parseInlineRichSegments(
        '价格 $100 与 $19.99 及 \\$15 不变，求解 $a^2 + b^2 = c^2$，引用 [1] 有效，[99] 越界，[xss](javascript:alert(1)) 过滤。',
        citations
      );

      const latexSegs = segments.filter((s) => s.kind === 'latex');
      expect(latexSegs).toHaveLength(1);
      expect(latexSegs[0]?.text).toBe('a^2 + b^2 = c^2');

      const citeSegs = segments.filter((s) => s.kind === 'citation');
      expect(citeSegs).toHaveLength(1);
      expect(citeSegs[0]?.index).toBe(1);
      expect(citeSegs[0]?.citation?.url).toBe('https://example.com/1');

      expect(segments.some((s) => s.kind === 'text' && s.text.includes('[99]'))).toBe(true);
      expect(segments.some((s) => s.kind === 'link')).toBe(false);
    });

    it('highlightCodeTokens 严格保真且避免 TS 自减被误识别为 SQL 注释', () => {
      const tsCode = 'let n = 10;\nn--; // 递减\nconst msg = "hi $x$ [1]";';
      const tsTokens = highlightCodeTokens(tsCode, 'typescript');
      expect(tsTokens.map((t) => t.text).join('')).toBe(tsCode);
      expect(
        tsTokens.some((t) => {
          const kind: string = t.tokenType;
          return kind === 'latex' || kind === 'citation';
        })
      ).toBe(false);
      expect(tsTokens.some((t) => t.tokenType === 'operator' && t.text.includes('--'))).toBe(true);

      const sqlCode = 'SELECT 1 -- sql comment\nFROM users;';
      const sqlTokens = highlightCodeTokens(sqlCode, 'sql');
      expect(sqlTokens.map((t) => t.text).join('')).toBe(sqlCode);
      expect(sqlTokens.some((t) => t.tokenType === 'comment' && t.text.includes('-- sql comment'))).toBe(
        true
      );
      expect(highlightCodeTokens('')).toEqual([]);
    });

    it('MessageMarkdown 代码块一键复制写入剪贴板并触发 onCitationPress 回调', async () => {
      vi.useFakeTimers();
      const onCitationPress = vi.fn();
      const citations: WebCitation[] = [
        { index: 1, id: 'c1', title: 'Ref 1', url: 'https://example.com/ref1' },
      ];

      await mountInMiniDom(
        createElement(MessageMarkdown, {
          content: '参考说明 [1]\n\n```ts\nconst answer = 42;\n```',
          citations,
          onCitationPress,
        }),
        cleanups
      );

      const copyNode = findLatestCapturedNode(
        (n) => n.type === 'Pressable' && n.props.accessibilityLabel === '复制代码'
      );
      expect(copyNode).toBeDefined();

      await act(async () => {
        (copyNode?.props.onPress as (() => void) | undefined)?.();
        await Promise.resolve();
      });
      expect(mockClipboardSetStringAsync).toHaveBeenCalledWith('const answer = 42;');

      const citeNode = findLatestCapturedNode(
        (n) => n.type === 'Text' && n.props.accessibilityLabel === '查看第 1 条引用来源'
      );
      expect(citeNode).toBeDefined();
      await act(async () => {
        (citeNode?.props.onPress as (() => void) | undefined)?.();
      });
      expect(onCitationPress).toHaveBeenCalledWith(1, citations[0]);
    });

    it('线性复杂度防护：25,000 行未闭合 $$ 与 300,000 字符重复 [ 均在毫秒级返回', () => {
      const unclosedInput = '$$unclosed\n'.repeat(25_000);
      const t0 = performance.now();
      const blocks = parseMarkdownBlocks(unclosedInput);
      const blockElapsedMs = performance.now() - t0;
      expect(blockElapsedMs).toBeLessThan(200);
      expect(blocks.some((b) => b.kind === 'latex')).toBe(false);
      expect(blocks.length).toBeGreaterThanOrEqual(1);

      // 确认围栏后方的合法多行公式仍可正常识别
      const afterFenceBlocks = parseMarkdownBlocks(
        '$$unclosed\n```ts\nconst a = 1;\n```\n$$\nE = mc^2\n$$'
      );
      expect(afterFenceBlocks.some((b) => b.kind === 'latex' && b.text === 'E = mc^2')).toBe(true);

      const bracketInput = '['.repeat(300_000);
      const t1 = performance.now();
      const bracketSegments = parseInlineRichSegments(bracketInput);
      const inlineElapsedMs = performance.now() - t1;
      expect(inlineElapsedMs).toBeLessThan(200);
      expect(bracketSegments).toEqual([{ kind: 'text', text: bracketInput }]);

      const starInput = '*a '.repeat(100_000);
      const t2 = performance.now();
      const starSegments = parseInlineRichSegments(starInput);
      expect(performance.now() - t2).toBeLessThan(200);
      expect(starSegments).toEqual([{ kind: 'text', text: starInput }]);
    });

    it('恶意重复 []( / [a](、深层嵌套及大量前序方括号均在 150ms 内线性完成', () => {
      const emptyLinkOpen = '[]('.repeat(100_000);
      const t0 = performance.now();
      const emptySegs = parseInlineRichSegments(emptyLinkOpen);
      expect(performance.now() - t0).toBeLessThan(150);
      expect(emptySegs).toEqual([{ kind: 'text', text: emptyLinkOpen }]);

      const namedLinkOpen = '[a]('.repeat(75_000);
      const t1 = performance.now();
      const namedSegs = parseInlineRichSegments(namedLinkOpen);
      expect(performance.now() - t1).toBeLessThan(150);
      expect(namedSegs).toEqual([{ kind: 'text', text: namedLinkOpen }]);

      // 末尾附带闭合 `)` 仍受窗口与括号深度限制保护，不触发 2048 字符高频重扫
      const trailingParenInput = '[a]('.repeat(75_000) + ')';
      const t2 = performance.now();
      parseInlineRichSegments(trailingParenInput);
      expect(performance.now() - t2).toBeLessThan(150);

      // 重复前序嵌套标签后接合法链接，保持线性时间且准确拆出末尾链接
      const repeatedClosedPrefix = '[a [b]] '.repeat(30_000) + '[c](https://example.com)';
      const t3 = performance.now();
      const prefixSegs = parseInlineRichSegments(repeatedClosedPrefix);
      expect(performance.now() - t3).toBeLessThan(150);
      expect(prefixSegs.filter((s) => s.kind === 'link')).toEqual([
        { kind: 'link', text: 'c', url: 'https://example.com/' },
      ]);

      // 连续未闭合 `[` 后接大量 `](` 保持线性时间
      const openFlood = '['.repeat(150_000) + ']('.repeat(50_000);
      const t4 = performance.now();
      const openFloodSegs = parseInlineRichSegments(openFlood);
      expect(performance.now() - t4).toBeLessThan(150);
      expect(openFloodSegs).toEqual([{ kind: 'text', text: openFlood }]);
    });

    it('同段前序 [1] 引用与 [tag]/[a [b]] 不被后续 [label](url) 吞并，且保留合法嵌套', () => {
      const citations: WebCitation[] = [
        { index: 1, id: 's1', title: 'S1', url: 'https://s1.example.com' },
      ];

      const citeBeforeLink = parseInlineRichSegments(
        '[1] and [Docs](https://example.com)',
        citations
      );
      expect(citeBeforeLink).toEqual([
        { kind: 'citation', text: '[1]', index: 1, citation: citations[0] },
        { kind: 'text', text: ' and ' },
        { kind: 'link', text: 'Docs', url: 'https://example.com/' },
      ]);

      const tagBeforeLink = parseInlineRichSegments('[Note] click [here](https://example.com)');
      expect(tagBeforeLink).toEqual([
        { kind: 'text', text: '[Note] click ' },
        { kind: 'link', text: 'here', url: 'https://example.com/' },
      ]);

      const nestedClosedBeforeLink = parseInlineRichSegments(
        '[a [b]] and [c](https://example.com)'
      );
      expect(nestedClosedBeforeLink).toEqual([
        { kind: 'text', text: '[a [b]] and ' },
        { kind: 'link', text: 'c', url: 'https://example.com/' },
      ]);

      const validNestedLabel = parseInlineRichSegments(
        '[outer [inner] text](https://example.com)'
      );
      expect(validNestedLabel).toEqual([
        { kind: 'link', text: 'outer [inner] text', url: 'https://example.com/' },
      ]);

      const escapedInnerClose = parseInlineRichSegments('[a \\]](https://example.com)');
      expect(escapedInnerClose).toEqual([
        { kind: 'link', text: 'a \\]', url: 'https://example.com/' },
      ]);
    });

    it('修复货币串位、紧邻公式、蛇形命名/算术乘号与含配对括号 URL 的行内边界误解析', () => {
      // 1. 货币公式串位：$100+tax=$x+1$ 不得把 $100+tax=$ 当成公式
      const mixedCurrencyFormula = parseInlineRichSegments('$100+tax=$x+1$');
      expect(mixedCurrencyFormula.filter((s) => s.kind === 'latex')).toEqual([
        { kind: 'latex', text: 'x+1' },
      ]);
      expect(
        mixedCurrencyFormula.some((s) => s.kind === 'text' && s.text.includes('$100+tax='))
      ).toBe(true);

      // 2. 紧邻公式 $a$$b$ 应拆出两个连续行内公式
      const adjacentLatex = parseInlineRichSegments('$a$$b$');
      expect(adjacentLatex).toEqual([
        { kind: 'latex', text: 'a' },
        { kind: 'latex', text: 'b' },
      ]);

      // 3. 蛇形命名与算术乘号不误判为斜体，同时保留合法斜体
      const snakeAndMath = parseInlineRichSegments(
        '变量 my_variable_name 与 2 * 3 * 4，以及 _斜体_ 和 *强调*。'
      );
      expect(snakeAndMath.filter((s) => s.kind === 'em').map((s) => s.text)).toEqual([
        '斜体',
        '强调',
      ]);
      expect(
        snakeAndMath.some(
          (s) => s.kind === 'text' && s.text.includes('my_variable_name 与 2 * 3 * 4')
        )
      ).toBe(true);

      // 4. 含配对括号的 URL 完整提取，不提前在第一个 ) 截断
      const wikiLinks = parseInlineRichSegments(
        '[Wiki](https://en.wikipedia.org/wiki/Function_(mathematics))'
      );
      expect(wikiLinks).toEqual([
        {
          kind: 'link',
          text: 'Wiki',
          url: 'https://en.wikipedia.org/wiki/Function_(mathematics)',
        },
      ]);
    });

    it('citations 混合显式与隐式 index 时按与 WebCitationList 一致的规则回退匹配', () => {
      const mixedCitations: WebCitation[] = [
        { index: 1, id: 'c1', title: 'Explicit 1', url: 'https://example.com/1' },
        { id: 'c2', title: 'Implicit 2', url: 'https://example.com/2' },
      ];
      const segments = parseInlineRichSegments('参考 [1] 与 [2] 以及 [3]。', mixedCitations);
      const citeSegs = segments.filter((s) => s.kind === 'citation');
      expect(citeSegs).toHaveLength(2);
      expect(citeSegs[0]?.index).toBe(1);
      expect(citeSegs[0]?.citation?.id).toBe('c1');
      expect(citeSegs[1]?.index).toBe(2);
      expect(citeSegs[1]?.citation?.id).toBe('c2');
      expect(segments.some((s) => s.kind === 'text' && s.text.includes('[3]'))).toBe(true);

      // 若全为显式且跳号，[2] 不应误匹配第 2 条 (index: 3)
      const sparseCitations: WebCitation[] = [
        { index: 1, id: 's1', title: 'S1', url: 'https://example.com/s1' },
        { index: 3, id: 's3', title: 'S3', url: 'https://example.com/s3' },
      ];
      const sparseSegs = parseInlineRichSegments('仅 [1] 和 [3]，无 [2]。', sparseCitations);
      expect(sparseSegs.filter((s) => s.kind === 'citation').map((s) => s.index)).toEqual([1, 3]);
    });

    it('MarkdownCodeBlock 在异步复制完成前卸载时不启动定时器也不报错', async () => {
      vi.useFakeTimers();
      let resolveCopy!: () => void;
      mockClipboardSetStringAsync.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveCopy = () => resolve(true);
          })
      );

      const mounted = await mountInMiniDom(
        createElement(MessageMarkdown, {
          content: '```ts\nconst x = 1;\n```',
        }),
        cleanups
      );

      const copyNode = findLatestCapturedNode(
        (n) => n.type === 'Pressable' && n.props.accessibilityLabel === '复制代码'
      );
      expect(copyNode).toBeDefined();

      await act(async () => {
        (copyNode?.props.onPress as (() => void) | undefined)?.();
      });

      mounted.unmount();

      await act(async () => {
        resolveCopy();
        await Promise.resolve();
      });

      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('Thinking 耗时归属与展开折叠状态机', () => {
    it('buildMessageActivityModules 优先消费 thinkingDurationMs 而不被 requestMetrics 覆盖', () => {
      const modules = buildMessageActivityModules({
        id: 'm-think-1',
        role: 'assistant',
        content: '完成',
        reasoningContent: '思考内容',
        thinkingDurationMs: 2340,
        requestMetrics: { durationMs: 8500 },
        createdAt: 1_764_000_000_000,
        status: 'ready',
      });

      const thinking = modules.find((item) => item.kind === 'thinking');
      expect(thinking?.title).toContain('2.3s');
      expect(thinking?.title).not.toContain('8.5s');

      const timelineModules = buildMessageActivityModules({
        id: 'm-think-2',
        role: 'assistant',
        content: '完成',
        thinkingDurationMs: 1200,
        requestMetrics: { durationMs: 9100 },
        createdAt: 1_764_000_000_000,
        status: 'ready',
        activityTimeline: [
          {
            id: 'step-1',
            kind: 'thinking',
            sequence: 0,
            status: 'running',
            title: '深度思考',
            content: '推理细节',
            startedAt: 1_764_000_000_000,
          },
        ],
      });
      expect(timelineModules[0]?.title).toContain('1.2s');
      expect(timelineModules[0]?.title).not.toContain('9.1s');
    });

    it('resolveThinkingExpandedState 覆盖流式展开、完成折叠、全部展开与用户接管', () => {
      expect(resolveThinkingExpandedState({ status: 'running' })).toBe(true);
      expect(resolveThinkingExpandedState({ status: 'completed' })).toBe(false);
      expect(resolveThinkingExpandedState({ status: 'completed', expandAll: true })).toBe(true);
      expect(resolveThinkingExpandedState({ status: 'running', userOverride: false })).toBe(false);
    });

    it('MessageActivityModules 支持流式自动展开、用户手动接管与顶部全部展开/收起', async () => {
      const runningMsg: ChatMessage = {
        id: 'm-live-1',
        role: 'assistant',
        content: '',
        reasoningContent: '正在推理第一步',
        createdAt: Date.now() - 1200,
        status: 'pending',
      };

      const mounted = await mountInMiniDom(
        createElement(MessageActivityModules, { message: runningMsg }),
        cleanups
      );

      // 流式 running 自动展开思考内容
      expect(mounted.container.textContent).toContain('正在推理第一步');
      expect(
        findElements(
          mounted.container,
          (el) => el.getAttribute('data-testid') === 'activity-elapsed-badge-m-live-1:thinking'
        )
      ).toHaveLength(1);

      // 用户手动点击收起思考行，立即折叠且保持用户接管状态
      const stepNode = findLatestCapturedNode(
        (n) =>
          (n.props.accessibilityState as { expanded?: boolean } | undefined)?.expanded === true &&
          typeof n.props.onPress === 'function'
      );
      expect(stepNode).toBeDefined();
      await act(async () => {
        (stepNode?.props.onPress as (() => void) | undefined)?.();
      });
      expect(mounted.container.textContent).not.toContain('正在推理第一步');

      // 点击顶部“全部展开”重新展开
      const expandAllBtn = findElements(
        mounted.container,
        (el) => el.getAttribute('data-testid') === 'activity-toggle-expand-all'
      )[0];
      expect(expandAllBtn?.textContent).toContain('全部展开');
      const expandAllNode = findLatestCapturedNode(
        (n) => n.props.testID === 'activity-toggle-expand-all'
      );
      await act(async () => {
        (expandAllNode?.props.onPress as (() => void) | undefined)?.();
      });
      expect(mounted.container.textContent).toContain('正在推理第一步');
      const expandAllBtnAfter = findElements(
        mounted.container,
        (el) => el.getAttribute('data-testid') === 'activity-toggle-expand-all'
      )[0];
      expect(expandAllBtnAfter?.textContent).toContain('全部收起');
    });
  });

  describe('ImageLightboxModal 全屏灯箱与防错保护', () => {
    const sampleImg: MediaAttachment = {
      id: 'img-1',
      kind: 'image',
      uri: 'data:image/png;base64,iVBORw0KGgo=',
      name: 'demo.png',
      mimeType: 'image/png',
    };

    it('visible=false 早退为空，visible=true 静态内联渲染图片及交互控件并响应回调', async () => {
      const onClose = vi.fn();
      const onSave = vi.fn();
      const onEditWithImage = vi.fn();

      const hiddenHtml = renderToStaticMarkup(
        createElement(ImageLightboxModal, {
          visible: false,
          attachment: sampleImg,
          onClose,
        })
      );
      expect(hiddenHtml).toBe('');

      capturedNodes.length = 0;
      const visibleHtml = renderToStaticMarkup(
        createElement(ImageLightboxModal, {
          visible: true,
          attachment: sampleImg,
          onClose,
          onSave,
          onEditWithImage,
        })
      );
      expect(visibleHtml).toContain('demo.png');

      // 确认使用标准 <Image> 而非 <Animated.Image>
      expect(capturedNodes.some((n) => n.type === 'Image' && Boolean(n.props.source))).toBe(true);
      expect(capturedNodes.some((n) => n.type === 'Animated.Image')).toBe(false);

      const saveBtn = capturedNodes.find(
        (n) => n.type === 'Pressable' && n.props.testID === 'image-lightbox-save'
      );
      const editBtn = capturedNodes.find(
        (n) => n.type === 'Pressable' && n.props.testID === 'image-lightbox-edit'
      );
      const closeBtn = capturedNodes.find(
        (n) => n.type === 'Pressable' && n.props.testID === 'image-lightbox-close'
      );

      expect(saveBtn?.props.disabled).toBeFalsy();
      expect(editBtn?.props.disabled).toBeFalsy();
      expect(closeBtn).toBeDefined();

      await (saveBtn?.props.onPress as () => Promise<void>)();
      (editBtn?.props.onPress as () => void)();
      (closeBtn?.props.onPress as () => void)();

      expect(onSave).toHaveBeenCalledWith(sampleImg);
      expect(onEditWithImage).toHaveBeenCalledWith(sampleImg);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('attachment=null 时禁用保存按钮并拦截触发，未传 onSave 时兜底调用 saveAttachmentToDevice', async () => {
      const onSave = vi.fn();
      const onClose = vi.fn();

      capturedNodes.length = 0;
      renderToStaticMarkup(
        createElement(ImageLightboxModal, {
          visible: true,
          attachment: null,
          onClose,
          onSave,
        })
      );
      const saveOnNull = capturedNodes.find(
        (n) => n.type === 'Pressable' && n.props.testID === 'image-lightbox-save'
      );
      expect(saveOnNull?.props.disabled).toBe(true);
      await (saveOnNull?.props.onPress as () => Promise<void>)();
      expect(onSave).not.toHaveBeenCalled();

      capturedNodes.length = 0;
      renderToStaticMarkup(
        createElement(ImageLightboxModal, {
          visible: true,
          attachment: sampleImg,
          onClose,
        })
      );
      const saveFallbackBtn = capturedNodes.find(
        (n) => n.type === 'Pressable' && n.props.testID === 'image-lightbox-save'
      );
      await (saveFallbackBtn?.props.onPress as () => Promise<void>)();
      expect(mockSaveAttachmentToDevice).toHaveBeenCalledWith(sampleImg);
    });

    it('Web 端空附件时 wheel 滚轮事件不触发缩放倍率更新', async () => {
      const rn = await import('react-native');
      const prevOs = rn.Platform.OS;
      (rn.Platform as { OS: string }).OS = 'web';
      try {
        const mounted = await mountInMiniDom(
          createElement(
            'div',
            null,
            createElement(AppDialogHost),
            createElement(ImageLightboxModal, {
              visible: true,
              attachment: null,
              onClose: vi.fn(),
            })
          ),
          cleanups
        );

        const zoomResetBefore = findElements(
          mounted.container,
          (el) => el.getAttribute('data-testid') === 'image-lightbox-zoom-reset'
        )[0];
        expect(zoomResetBefore?.textContent).toBe('1.0x');

        // 空附件下未在画布节点绑定 wheel 监听且倍率保持 1.0x
        const nullWheelTargets = findElements(
          mounted.container,
          (el) => el !== mounted.container && el.listeners.has('wheel')
        );
        expect(nullWheelTargets).toHaveLength(0);

        const zoomResetAfter = findElements(
          mounted.container,
          (el) => el.getAttribute('data-testid') === 'image-lightbox-zoom-reset'
        )[0];
        expect(zoomResetAfter?.textContent).toBe('1.0x');
        mounted.unmount();

        // 有效附件下挂载时在画布节点绑定 wheel 监听并响应滚轮缩放
        const mountedWithImg = await mountInMiniDom(
          createElement(
            'div',
            null,
            createElement(AppDialogHost),
            createElement(ImageLightboxModal, {
              visible: true,
              attachment: sampleImg,
              onClose: vi.fn(),
            })
          ),
          cleanups
        );
        const imgWheelTargets = findElements(
          mountedWithImg.container,
          (el) => el !== mountedWithImg.container && el.listeners.has('wheel')
        );
        expect(imgWheelTargets).toHaveLength(1);
        for (const listener of imgWheelTargets[0]!.listeners.get('wheel') ?? []) {
          await act(async () => {
            listener({ deltaY: -120, preventDefault: () => undefined });
          });
        }
        const zoomResetImgAfter = findElements(
          mountedWithImg.container,
          (el) => el.getAttribute('data-testid') === 'image-lightbox-zoom-reset'
        )[0];
        expect(zoomResetImgAfter?.textContent).toBe('1.3x');
      } finally {
        (rn.Platform as { OS: string }).OS = prevOs;
      }
    });

    it('存在轻量 window={location}（无 document.createElement）时正确内联渲染，存在完整 DOM 时走 OverlayPortal', async () => {
      const globalRecord = globalThis as Record<string, unknown>;
      const prevWindow = Object.getOwnPropertyDescriptor(globalRecord, 'window');
      try {
        // 1) 仅有 window.location 调试代理上下文、无 document.createElement：必须内联渲染，不返回 null
        Object.defineProperty(globalRecord, 'window', {
          value: { location: { protocol: 'http:', hostname: '127.0.0.1' } },
          configurable: true,
          writable: true,
          enumerable: true,
        });
        capturedNodes.length = 0;
        const inlineHtml = renderToStaticMarkup(
          createElement(ImageLightboxModal, {
            visible: true,
            attachment: sampleImg,
            onClose: vi.fn(),
          })
        );
        expect(inlineHtml).toContain('demo.png');
        expect(
          capturedNodes.find((n) => n.type === 'Pressable' && n.props.testID === 'image-lightbox-save')
        ).toBeDefined();
      } finally {
        if (prevWindow) {
          Object.defineProperty(globalRecord, 'window', prevWindow);
        } else {
          delete globalRecord.window;
        }
      }

      // 2) 存在完整浏览器 DOM（window.document.createElement 为函数）时走 OverlayPortal：
      // 未挂载 AppDialogHost 时本体不直接内联输出控件，挂载 AppDialogHost 后通过 Portal 呈现
      const portalOnlyMount = await mountInMiniDom(
        createElement(ImageLightboxModal, {
          visible: true,
          attachment: sampleImg,
          onClose: vi.fn(),
        }),
        cleanups
      );
      expect(
        findElements(
          portalOnlyMount.container,
          (el) => el.getAttribute('data-testid') === 'image-lightbox-save'
        )
      ).toHaveLength(0);
      portalOnlyMount.unmount();

      const withHostMount = await mountInMiniDom(
        createElement(
          'div',
          null,
          createElement(AppDialogHost),
          createElement(ImageLightboxModal, {
            visible: true,
            attachment: sampleImg,
            onClose: vi.fn(),
          })
        ),
        cleanups
      );
      expect(
        findElements(
          withHostMount.container,
          (el) => el.getAttribute('data-testid') === 'image-lightbox-save'
        )
      ).toHaveLength(1);
    });
  });

  describe('ChatMessageRow、AttachmentPreview 与 WebCitationList 联动', () => {
    it('AttachmentPreview 平级渲染缩略图与继续编辑按钮（无嵌套 Pressable）', async () => {
      const att: MediaAttachment = {
        id: 'att-img-1',
        kind: 'image',
        uri: 'https://example.com/a.png',
        name: 'a.png',
      };
      const onOpenLightbox = vi.fn();
      const onEditWithImage = vi.fn();

      const mounted = await mountInMiniDom(
        createElement(AttachmentPreview, {
          attachment: att,
          onOpenLightbox,
          onEditWithImage,
        }),
        cleanups
      );

      const previewEl = findElements(
        mounted.container,
        (el) => el.getAttribute('data-testid') === 'attachment-image-preview-att-img-1'
      )[0];
      const editEl = findElements(
        mounted.container,
        (el) => el.getAttribute('data-testid') === 'attachment-image-edit-att-img-1'
      )[0];

      expect(previewEl).toBeDefined();
      expect(editEl).toBeDefined();
      // 确认继续编辑按钮不是缩略图 Pressable 的后代节点
      expect(findElements(previewEl!, (el) => el === editEl)).toHaveLength(0);

      const previewNode = findLatestCapturedNode(
        (n) => n.type === 'Pressable' && n.props.testID === 'attachment-image-preview-att-img-1'
      );
      const editNode = findLatestCapturedNode(
        (n) => n.type === 'Pressable' && n.props.testID === 'attachment-image-edit-att-img-1'
      );
      await act(async () => {
        (previewNode?.props.onPress as (() => void) | undefined)?.();
        (editNode?.props.onPress as (() => void) | undefined)?.();
      });
      expect(onOpenLightbox).toHaveBeenCalledTimes(1);
      expect(onEditWithImage).toHaveBeenCalledTimes(1);
    });

    it('ChatMessageRow 透传灯箱与继续编辑回调并联动正文 [1] 角标与横向来源抽屉聚焦高亮', async () => {
      const userImg: MediaAttachment = {
        id: 'u-img-1',
        kind: 'image',
        uri: 'https://example.com/u.png',
        name: 'u.png',
      };
      const assistantImg: MediaAttachment = {
        id: 'a-img-1',
        kind: 'image',
        uri: 'https://example.com/a.png',
        name: 'a.png',
      };
      const citations: WebCitation[] = [
        { index: 1, id: 'c1', title: 'Alpha Source', url: 'https://alpha.example.com', text: '摘要一' },
        { index: 2, id: 'c2', title: 'Beta Source', url: 'https://beta.example.com', text: '摘要二' },
      ];

      const onOpenImageLightbox = vi.fn();
      const onEditImageAttachment = vi.fn();

      const userMessage: ChatMessage = {
        id: 'msg-u-1',
        role: 'user',
        content: '帮我改图',
        attachments: [userImg],
        createdAt: 1_764_000_000_000,
        status: 'ready',
      };
      const assistantMessage: ChatMessage = {
        id: 'msg-a-1',
        role: 'assistant',
        content: '根据资料 [2] 已生成新图片。',
        attachments: [assistantImg],
        citations,
        createdAt: 1_764_000_001_000,
        status: 'ready',
      };

      const mounted = await mountInMiniDom(
        createElement(
          'div',
          null,
          createElement(
            ChatMessageRow,
            createBaseRowProps({
              message: userMessage,
              onOpenImageLightbox,
              onEditImageAttachment,
            })
          ),
          createElement(
            ChatMessageRow,
            createBaseRowProps({
              message: assistantMessage,
              onOpenImageLightbox,
              onEditImageAttachment,
            })
          )
        ),
        cleanups
      );

      const userPreviewNode = findLatestCapturedNode(
        (n) => n.type === 'Pressable' && n.props.testID === 'attachment-image-preview-u-img-1'
      );
      const assistantEditNode = findLatestCapturedNode(
        (n) => n.type === 'Pressable' && n.props.testID === 'attachment-image-edit-a-img-1'
      );

      await act(async () => {
        (userPreviewNode?.props.onPress as (() => void) | undefined)?.();
        (assistantEditNode?.props.onPress as (() => void) | undefined)?.();
      });

      expect(onOpenImageLightbox).toHaveBeenCalledWith(userImg, userMessage);
      expect(onEditImageAttachment).toHaveBeenCalledWith(assistantImg, assistantMessage);

      // 验证横向来源卡片抽屉渲染与点击正文 [2] 联动高亮及 scrollTo
      expect(
        findElements(
          mounted.container,
          (el) => el.getAttribute('data-testid') === 'web-citation-carousel'
        )
      ).toHaveLength(1);

      const inlineCitation2Node = findLatestCapturedNode(
        (n) => n.type === 'Text' && n.props.accessibilityLabel === '查看第 2 条引用来源'
      );
      expect(inlineCitation2Node).toBeDefined();

      await act(async () => {
        (inlineCitation2Node?.props.onPress as (() => void) | undefined)?.();
      });

      const card2 = findElements(
        mounted.container,
        (el) => el.getAttribute('data-testid') === 'web-citation-card-2'
      )[0];
      expect(card2?.getAttribute('aria-selected')).toBe('true');
      expect(mockScrollTo).toHaveBeenCalled();
    });

    it('WebCitationList 保留芯片与 sheet 契约且对危险 URL 拒绝打开', async () => {
      const { Linking } = await import('react-native');
      const unsafeCitations: WebCitation[] = [
        { index: 1, id: 'bad', title: 'Bad Link', url: 'javascript:alert(1)' },
        { index: 2, id: 'good', title: 'Good Link', url: 'https://good.example.com/page' },
      ];
      const mounted = await mountInMiniDom(
        createElement(WebCitationList, {
          citations: unsafeCitations,
          focusedCitationIndex: 2,
        }),
        cleanups
      );

      const chip = findElements(
        mounted.container,
        (el) => el.getAttribute('data-testid') === 'web-citation-chip'
      )[0];
      expect(chip?.textContent).toContain('2个引用');
      expect(mockScrollTo).toHaveBeenCalled();

      const badCardNode = findLatestCapturedNode(
        (n) => n.props.testID === 'web-citation-card-1'
      );
      const goodCardNode = findLatestCapturedNode(
        (n) => n.props.testID === 'web-citation-card-2'
      );

      await act(async () => {
        (badCardNode?.props.onPress as (() => void) | undefined)?.();
      });
      expect(Linking.openURL).not.toHaveBeenCalled();

      await act(async () => {
        (goodCardNode?.props.onPress as (() => void) | undefined)?.();
      });
      expect(Linking.openURL).toHaveBeenCalledWith('https://good.example.com/page');
    });
  });
});
