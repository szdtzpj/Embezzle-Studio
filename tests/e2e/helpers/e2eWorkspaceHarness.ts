import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MemoryApplicationLifecycleAdapter } from '../../../src/app/lifecycle/memoryApplicationLifecycleAdapter';
import { FakeClock } from '../../../src/app/testing/fakeClock';
import { FakeIdGenerator } from '../../../src/app/testing/fakeIdGenerator';
import { TraceRecorder } from '../../../src/app/testing/traceRecorder';
import {
  MemoryWorkspacePersistenceAdapter,
  type MemoryWorkspacePersistenceOptions,
} from '../../../src/app/workspace/adapters/memoryWorkspacePersistenceAdapter';
import { WorkspaceSession } from '../../../src/app/workspace/WorkspaceSession';
import { createDefaultWorkspace } from '../../../src/data/providerCatalog';
import type {
  AppWorkspace,
  ChatMessage,
  ExternalSearchProviderKind,
  ExternalSearchSettings,
  ImageGenerationOptions,
  MediaAttachment,
  ModelInfo,
  ProviderContinuationBlock,
  ProviderKind,
  ProviderProfile,
} from '../../../src/domain/types';
import { ChatWorkspaceRuntime } from '../../../src/features/chat/internal/ChatWorkspaceRuntime';
import { ChatRequestDecisionQueue } from '../../../src/features/chat/internal/decisions/useChatRequestDecisions';
import { ChatOrchestrator } from '../../../src/features/chat/orchestration/ChatOrchestrator';
import {
  createProductionProviderAdapterRegistry,
  type ProviderAdapterRegistry,
} from '../../../src/features/chat/orchestration/ProviderAdapterRegistry';
import {
  ScriptedProviderAdapter,
  ScriptedProviderAdapterRegistry,
  type ScriptedProviderStep,
} from '../../../src/features/chat/orchestration/scriptedProviderAdapter';
import { SettingsWorkspaceRuntime } from '../../../src/features/settings/internal/SettingsWorkspaceRuntime';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..', '..', '..');

/**
 * 兼容 M1-M3 契约的 E2E 超集类型定义（确保基线编译通过且 M1-M3 落地后无缝校验）。
 */
export type E2EProviderKind =
  | ProviderKind
  | 'anthropic'
  | 'gemini'
  | 'xai-grok'
  | 'deepseek';

export type E2EExternalSearchProviderKind =
  | ExternalSearchProviderKind
  | 'deepseek'
  | 'bocha'
  | 'exa'
  | 'searxng';

export interface E2ECustomHeaderEntry {
  key: string;
  value: string;
  enabled?: boolean;
}

export type E2EAuthHeaderMode =
  | 'auto'
  | 'bearer'
  | 'x-api-key'
  | 'x-goog-api-key'
  | 'custom';

export type E2EImageApiMode =
  | 'auto'
  | 'openai-images'
  | 'openai-responses'
  | 'gemini-generate-content'
  | 'xai-json'
  | 'unsupported';

export interface E2EProviderProfile extends Omit<ProviderProfile, 'kind'> {
  kind: E2EProviderKind;
  customHeaders?: E2ECustomHeaderEntry[];
  authHeaderMode?: E2EAuthHeaderMode;
  imageApiMode?: E2EImageApiMode;
}

export type E2EProviderContinuationBlock = ProviderContinuationBlock;

export interface E2EChatMessage extends ChatMessage {
  thinkingDurationMs?: number;
  providerContinuations?: ProviderContinuationBlock[];
}

export type E2EImageGenerationOptions = ImageGenerationOptions & {
  aspectRatio?: '1:1' | '3:2' | '2:3' | '4:3' | '3:4' | '16:9' | '9:16' | '21:9';
  quality?: 'low' | 'medium' | 'high' | 'auto';
  resolution?: '1k' | '2k' | '4k';
  count?: number;
  referenceImages?: MediaAttachment[];
};

export interface E2EWorkspaceHarnessOptions {
  initialWorkspace?: AppWorkspace | null;
  persistenceOptions?: Omit<MemoryWorkspacePersistenceOptions, 'initial' | 'trace'>;
  initialTimeMs?: number;
  scriptedSteps?: ScriptedProviderStep[];
}

export interface E2EWorkspaceHarness {
  clock: FakeClock;
  ids: FakeIdGenerator;
  trace: TraceRecorder;
  lifecycle: MemoryApplicationLifecycleAdapter;
  persistence: MemoryWorkspacePersistenceAdapter;
  session: WorkspaceSession;
  chatRuntime: ChatWorkspaceRuntime;
  settingsRuntime: SettingsWorkspaceRuntime;
  orchestrator: ChatOrchestrator;
  decisionQueue: ChatRequestDecisionQueue;
  productionAdapterRegistry: ProviderAdapterRegistry;
  createScriptedRegistry: (steps?: ScriptedProviderStep[]) => {
    adapter: ScriptedProviderAdapter;
    registry: ScriptedProviderAdapterRegistry;
  };
  addAndSelectProvider: (provider: E2EProviderProfile, model?: ModelInfo) => Promise<void>;
  setExternalSearch: (settings: Partial<ExternalSearchSettings>) => Promise<void>;
  setProviderWebSearch: (
    enabled: boolean,
    searchContextSize?: 'low' | 'medium' | 'high'
  ) => Promise<void>;
  flush: () => Promise<void>;
  dispose: () => void;
}

/**
 * 基于公开工作区与编排接缝装配零磁盘、零外网的 E2E 测试环境。
 */
export async function createE2EWorkspaceHarness(
  options: E2EWorkspaceHarnessOptions = {}
): Promise<E2EWorkspaceHarness> {
  const clock = new FakeClock();
  clock.setTime(options.initialTimeMs ?? 1764000000000);
  const ids = new FakeIdGenerator('e2e');
  const trace = new TraceRecorder(clock);
  const lifecycle = new MemoryApplicationLifecycleAdapter();

  const initialWorkspace =
    options.initialWorkspace === undefined ? createDefaultWorkspace() : options.initialWorkspace;

  const persistence = new MemoryWorkspacePersistenceAdapter({
    ...options.persistenceOptions,
    initial: initialWorkspace,
    trace,
  });

  const session = new WorkspaceSession({
    persistence,
    clock,
    lifecycle,
    trace,
    autoBoot: false,
  });
  await session.boot();

  const chatRuntime = new ChatWorkspaceRuntime(session);
  const settingsRuntime = new SettingsWorkspaceRuntime(session);
  const orchestrator = new ChatOrchestrator(trace);
  const decisionQueue = new ChatRequestDecisionQueue();
  decisionQueue.activate();
  const productionAdapterRegistry = createProductionProviderAdapterRegistry();

  const addAndSelectProvider = async (
    provider: E2EProviderProfile,
    model?: ModelInfo
  ): Promise<void> => {
    const normalizedProvider = provider as unknown as ProviderProfile;
    const exists = session
      .getSnapshot()
      .providers.some((item) => item.id === provider.id);

    if (exists) {
      await settingsRuntime.execute({
        type: 'provider.save',
        providerId: provider.id,
        provider: normalizedProvider,
        binding: { changed: true, mustClearModelCandidates: false },
        apiKeyChanged: true,
        now: clock.now(),
      });
      await settingsRuntime.execute({
        type: 'provider.select',
        providerId: provider.id,
      });
    } else {
      await settingsRuntime.execute({
        type: 'provider.add',
        provider: normalizedProvider,
      });
    }

    const targetModel = model ?? provider.models[0];
    if (targetModel) {
      await settingsRuntime.execute({
        type: 'model.add',
        providerId: provider.id,
        model: targetModel,
      });
      await settingsRuntime.execute({
        type: 'model.select',
        providerId: provider.id,
        modelId: targetModel.id,
        activateProvider: true,
      });
    }
  };

  const setExternalSearch = async (
    settings: Partial<ExternalSearchSettings>
  ): Promise<void> => {
    await settingsRuntime.execute({
      type: 'search.update-external',
      patch: settings,
    });
  };

  const setProviderWebSearch = async (
    enabled: boolean,
    searchContextSize: 'low' | 'medium' | 'high' = 'medium'
  ): Promise<void> => {
    await settingsRuntime.execute({
      type: 'search.update-provider',
      patch: { enabled, searchContextSize },
    });
  };

  const flush = async (): Promise<void> => {
    await session.flush({ reason: 'e2e-harness', propagateFailure: true });
  };

  const dispose = (): void => {
    decisionQueue.dispose();
    session.dispose();
  };

  return {
    clock,
    ids,
    trace,
    lifecycle,
    persistence,
    session,
    chatRuntime,
    settingsRuntime,
    orchestrator,
    decisionQueue,
    productionAdapterRegistry,
    createScriptedRegistry: (steps = options.scriptedSteps) => {
      const adapter = new ScriptedProviderAdapter(steps);
      const registry = new ScriptedProviderAdapterRegistry(adapter);
      return { adapter, registry };
    },
    addAndSelectProvider,
    setExternalSearch,
    setProviderWebSearch,
    flush,
    dispose,
  };
}

function resolveExistingModuleFile(relativePathFromRepoRoot: string): string | null {
  const cleanRel = relativePathFromRepoRoot.replace(/^[\\/]+/, '');
  const baseAbs = path.resolve(REPO_ROOT, cleanRel);
  const candidates = [
    baseAbs,
    `${baseAbs}.ts`,
    `${baseAbs}.tsx`,
    `${baseAbs}.mts`,
    `${baseAbs}.mjs`,
    `${baseAbs}.js`,
    path.join(baseAbs, 'index.ts'),
    path.join(baseAbs, 'index.tsx'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

/**
 * 动态加载按契约约定的项目模块（适配尚未合入的 M1-M3 契约模块，编译期零 TS2307 报错）。
 * 严格 fail-loud：若模块文件不存在或缺少任一 requiredExports 导出符号，立即抛错，绝不返回假对象或跳过测试。
 */
export async function safeImportModule<TContract = Record<string, unknown>>(
  relativePathFromRepoRoot: string,
  requiredExports: readonly string[] = []
): Promise<TContract> {
  const resolvedFile = resolveExistingModuleFile(relativePathFromRepoRoot);
  if (!resolvedFile) {
    throw new Error(
      `[E2E Contract Missing] 未找到契约模块 "${relativePathFromRepoRoot}"（预期导出: ${
        requiredExports.length ? requiredExports.join(', ') : '任意'
      }）。`
    );
  }

  // 计算相对于当前 helper 文件的 POSIX 导入路径，使 Vitest 模块转换器正确编译 .ts/.tsx
  const relativeFromHelper = path.relative(THIS_DIR, resolvedFile).replace(/\\/g, '/');
  const importSpec = relativeFromHelper.startsWith('.')
    ? relativeFromHelper
    : `./${relativeFromHelper}`;

  const loaded = (await import(/* @vite-ignore */ importSpec)) as Record<string, unknown>;

  const missingExports = requiredExports.filter(
    (exportName) => !(exportName in loaded) || loaded[exportName] === undefined
  );

  if (missingExports.length > 0) {
    throw new Error(
      `[E2E Contract Missing] 模块 "${relativePathFromRepoRoot}" 缺少约定导出符号: ${missingExports.join(
        ', '
      )}。`
    );
  }

  return loaded as TContract;
}

export interface MockFetchRouterRule {
  /** 匹配的源主机名或自定义匹配函数，例如 'api.openai.com' */
  match: string | RegExp | ((url: URL) => boolean);
  /** 重写目标基准 URL（默认使用 mockServerBaseUrl） */
  targetBaseUrl?: string;
}

export interface MockFetchRouterOptions {
  /** 允许透明转发至 mockServerBaseUrl 的官方主机名列表（默认已涵盖主流模型与搜索服务） */
  targetHosts?: string[];
  /** 额外自定义重写规则 */
  rewriteRules?: MockFetchRouterRule[];
  /** 是否拦截未匹配的外部非回环 URL，默认 true（防止测试意外发起真实公网请求） */
  blockUnmatchedExternalRequests?: boolean;
  /** 是否启用受控 Web Dev Proxy 上下文注入与 `/proxy` 信封解包路由，默认 false */
  enableWebDevProxy?: boolean;
}

export interface InstalledMockFetchRouter {
  restore: () => void;
  getRoutedCount: () => number;
}

const BLOCKED_PROXY_UPSTREAM_HEADERS = new Set([
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'cf-connecting-ip',
  'client-ip',
  'connection',
  'constructor',
  'content-length',
  'cookie',
  'cookie2',
  'expect',
  'forwarded',
  'host',
  'keep-alive',
  'origin',
  'proxy-authenticate',
  'proxy-authorization',
  'prototype',
  'referer',
  'te',
  'trailer',
  'transfer-encoding',
  'true-client-ip',
  'upgrade',
  'via',
  'x-http-method',
  'x-http-method-override',
  'x-method-override',
  'x-original-url',
  'x-real-ip',
  'x-rewrite-url',
  '__proto__',
]);

/**
 * 与 `scripts/dev-proxy.mjs` 对齐的上游请求头清洗逻辑，防止危险头透传至上游。
 */
function cleanProxyUpstreamHeaders(rawHeaders: unknown): Record<string, string> {
  if (rawHeaders == null) {
    return {};
  }
  if (typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) {
    throw new Error('Proxy headers must be an object of string values.');
  }
  const entries = Object.entries(rawHeaders as Record<string, unknown>);
  const connectionTokens = new Set<string>();
  for (const [key, value] of entries) {
    if (key.toLowerCase() === 'connection' && typeof value === 'string') {
      for (const token of value.split(',')) {
        if (token.trim()) {
          connectionTokens.add(token.trim().toLowerCase());
        }
      }
    }
  }
  const cleaned: Record<string, string> = {};
  for (const [key, value] of entries) {
    const lowerKey = key.toLowerCase();
    if (
      BLOCKED_PROXY_UPSTREAM_HEADERS.has(lowerKey) ||
      connectionTokens.has(lowerKey) ||
      lowerKey.startsWith('access-control-') ||
      lowerKey.startsWith('proxy-') ||
      lowerKey.startsWith('sec-') ||
      lowerKey.startsWith('x-forwarded-')
    ) {
      continue;
    }
    if (typeof value !== 'string') {
      throw new Error(`Proxy header ${key} must be a string.`);
    }
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(key) || /[\r\n]/.test(value)) {
      throw new Error(`Invalid proxy header: ${key}`);
    }
    cleaned[lowerKey] = value;
  }
  return cleaned;
}

/**
 * 临时注入受控本机 Web Dev Proxy 运行时上下文，并返回幂等的还原函数。
 */
function installWebDevProxyContext(): () => void {
  const hadOwnDev = Object.prototype.hasOwnProperty.call(globalThis, '__DEV__');
  const originalDevDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__DEV__');
  const hadProxyEnv = Object.prototype.hasOwnProperty.call(
    process.env,
    'EXPO_PUBLIC_ENABLE_WEB_DEV_PROXY'
  );
  const originalProxyEnv = process.env.EXPO_PUBLIC_ENABLE_WEB_DEV_PROXY;

  const hadOwnWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const existingWindow =
    typeof globalThis.window === 'object' && globalThis.window !== null
      ? globalThis.window
      : undefined;
  const hadOwnLocation = existingWindow
    ? Object.prototype.hasOwnProperty.call(existingWindow, 'location')
    : false;
  const originalLocationDescriptor = existingWindow
    ? Object.getOwnPropertyDescriptor(existingWindow, 'location')
    : undefined;

  Object.defineProperty(globalThis, '__DEV__', {
    value: true,
    configurable: true,
    writable: true,
    enumerable: true,
  });
  process.env.EXPO_PUBLIC_ENABLE_WEB_DEV_PROXY = '1';

  const loopbackLocation = { protocol: 'http:', hostname: '127.0.0.1' };
  if (existingWindow) {
    Object.defineProperty(existingWindow, 'location', {
      value: loopbackLocation,
      configurable: true,
      writable: true,
      enumerable: true,
    });
  } else {
    Object.defineProperty(globalThis, 'window', {
      value: { location: loopbackLocation },
      configurable: true,
      writable: true,
      enumerable: true,
    });
  }

  let restored = false;
  return () => {
    if (restored) {
      return;
    }
    restored = true;

    if (existingWindow) {
      if (hadOwnLocation && originalLocationDescriptor) {
        Object.defineProperty(existingWindow, 'location', originalLocationDescriptor);
      } else {
        Reflect.deleteProperty(existingWindow, 'location');
      }
    } else if (hadOwnWindow && originalWindowDescriptor) {
      Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }

    if (hadProxyEnv) {
      process.env.EXPO_PUBLIC_ENABLE_WEB_DEV_PROXY = originalProxyEnv;
    } else {
      delete process.env.EXPO_PUBLIC_ENABLE_WEB_DEV_PROXY;
    }

    if (hadOwnDev && originalDevDescriptor) {
      Object.defineProperty(globalThis, '__DEV__', originalDevDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, '__DEV__');
    }
  };
}

const DEFAULT_OFFICIAL_HOSTS = [
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'api.x.ai',
  'api.deepseek.com',
  'ark.cn-beijing.volces.com',
  'dashscope.aliyuncs.com',
  'api.bochaai.com',
  'api.exa.ai',
  'api.tavily.com',
  'api.search.brave.com',
  'api.firecrawl.dev',
  'searx.example.com',
  'your-relay.example.com',
];

function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === '127.0.0.1' || lower === 'localhost' || lower === '::1' || lower === '[::1]';
}

function matchesRule(rule: MockFetchRouterRule, parsedUrl: URL): boolean {
  if (typeof rule.match === 'string') {
    return parsedUrl.hostname.toLowerCase() === rule.match.toLowerCase();
  }
  if (rule.match instanceof RegExp) {
    return rule.match.test(parsedUrl.href);
  }
  return rule.match(parsedUrl);
}

/**
 * 安装受控 fetch 路由器：将合法官方 HTTPS URL 透明转发到本地 MockUpstreamServer，
 * 完整保留 method、headers、body、query 与 AbortSignal，既满足生产代码 HTTPS/公网域名校验，又完全隔离真网。
 */
export function installMockFetchRouter(
  mockServerBaseUrl: string,
  options: MockFetchRouterOptions = {}
): InstalledMockFetchRouter {
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== 'function') {
    throw new Error('当前运行时不存在全局 fetch，无法安装 MockFetchRouter。');
  }

  const normalizedMockBase = mockServerBaseUrl.replace(/\/+$/, '');
  const allowedHosts = new Set(
    (options.targetHosts ?? DEFAULT_OFFICIAL_HOSTS).map((host) => host.toLowerCase())
  );
  const rules = options.rewriteRules ?? [];
  const blockExternal = options.blockUnmatchedExternalRequests ?? true;
  const enableWebDevProxy = options.enableWebDevProxy === true;
  const restoreWebDevProxyContext = enableWebDevProxy ? installWebDevProxyContext() : undefined;
  let routedCount = 0;

  const resolveTargetBase = (parsedUrl: URL): string | null => {
    for (const rule of rules) {
      if (matchesRule(rule, parsedUrl)) {
        return (rule.targetBaseUrl ?? normalizedMockBase).replace(/\/+$/, '');
      }
    }
    if (allowedHosts.has(parsedUrl.hostname.toLowerCase())) {
      return normalizedMockBase;
    }
    return null;
  };

  const routedFetch: typeof fetch = async (input, init) => {
    const rawUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    const parsed = new URL(rawUrl);

    // 放行内联 data:/blob: URI（用于本地附件解码与对象 URL 读取，不产生外部网络请求）
    if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') {
      return originalFetch(input, init);
    }

    // 在回环直通之前拦截受控 Web Dev Proxy 信封请求，解包后按同套规则转发至 MockUpstreamServer
    if (
      enableWebDevProxy &&
      parsed.origin === 'http://127.0.0.1:8787' &&
      parsed.pathname === '/proxy'
    ) {
      const proxyMethod = (
        init?.method ??
        (typeof input !== 'string' && !(input instanceof URL) ? input.method : 'GET')
      ).toUpperCase();
      if (proxyMethod !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
          status: 405,
          headers: { 'content-type': 'application/json' },
        });
      }

      let rawEnvelopeText = '';
      if (typeof init?.body === 'string') {
        rawEnvelopeText = init.body;
      } else if (init?.body != null) {
        rawEnvelopeText = await new Response(init.body).text();
      } else if (typeof input !== 'string' && !(input instanceof URL)) {
        rawEnvelopeText = await input.clone().text();
      }

      let envelope: Record<string, unknown>;
      try {
        const parsedEnvelope = JSON.parse(rawEnvelopeText) as unknown;
        if (!parsedEnvelope || typeof parsedEnvelope !== 'object' || Array.isArray(parsedEnvelope)) {
          throw new Error('Proxy body must be a JSON object.');
        }
        envelope = parsedEnvelope as Record<string, unknown>;
      } catch {
        return new Response(JSON.stringify({ error: 'Invalid proxy JSON payload.' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }

      const targetRawUrl = typeof envelope.url === 'string' ? envelope.url : '';
      let targetParsed: URL;
      try {
        targetParsed = new URL(targetRawUrl);
      } catch {
        return new Response(JSON.stringify({ error: 'Invalid target URL.' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (targetParsed.protocol !== 'http:' && targetParsed.protocol !== 'https:') {
        return new Response(JSON.stringify({ error: 'Only http and https targets are allowed.' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }

      const upstreamMethod =
        typeof envelope.method === 'string' ? envelope.method.trim().toUpperCase() : 'GET';
      if (upstreamMethod !== 'GET' && upstreamMethod !== 'POST') {
        return new Response(JSON.stringify({ error: 'Upstream method must be GET or POST.' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }

      let cleanedHeaders: Record<string, string>;
      try {
        cleanedHeaders = cleanProxyUpstreamHeaders(envelope.headers);
      } catch (err) {
        return new Response(
          JSON.stringify({ error: err instanceof Error ? err.message : 'Invalid proxy headers.' }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        );
      }

      let upstreamBody: BodyInit | undefined;
      if (envelope.body != null) {
        if (typeof envelope.body !== 'string' || upstreamMethod === 'GET') {
          return new Response(JSON.stringify({ error: 'Invalid proxy upstream body.' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (envelope.bodyEncoding === 'base64') {
          const compact = envelope.body.replace(/\s+/g, '');
          if (
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)
          ) {
            return new Response(JSON.stringify({ error: 'Invalid base64 upstream body.' }), {
              status: 400,
              headers: { 'content-type': 'application/json' },
            });
          }
          const decoded = Buffer.from(compact, 'base64');
          upstreamBody = new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
        } else if (envelope.bodyEncoding == null || envelope.bodyEncoding === 'utf8') {
          upstreamBody = envelope.body;
        } else {
          return new Response(JSON.stringify({ error: 'Unsupported bodyEncoding.' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          });
        }
      }

      const signal =
        init?.signal ??
        (typeof input !== 'string' && !(input instanceof URL) ? input.signal : undefined);

      if (isLoopbackHost(targetParsed.hostname)) {
        return originalFetch(targetParsed.href, {
          method: upstreamMethod,
          headers: cleanedHeaders,
          body: upstreamBody,
          signal,
        });
      }

      const proxyTargetBase = resolveTargetBase(targetParsed);
      if (!proxyTargetBase) {
        if (blockExternal) {
          throw new Error(
            `[E2E Network Guard] 拦截到未授权的外部请求: ${targetParsed.href}。` +
              '请将其主机名加入 installMockFetchRouter targetHosts 或使用本地 MockUpstreamServer。'
          );
        }
        return originalFetch(targetParsed.href, {
          method: upstreamMethod,
          headers: cleanedHeaders,
          body: upstreamBody,
          signal,
        });
      }

      routedCount += 1;
      const forwardUrl = `${proxyTargetBase}${targetParsed.pathname}${targetParsed.search}`;
      return originalFetch(forwardUrl, {
        method: upstreamMethod,
        headers: cleanedHeaders,
        body: upstreamBody,
        signal,
      });
    }

    // 已经是本地回环地址时，直接放行给底层 fetch
    if (isLoopbackHost(parsed.hostname)) {
      return originalFetch(input, init);
    }

    const targetBase = resolveTargetBase(parsed);

    if (!targetBase) {
      if (blockExternal) {
        throw new Error(
          `[E2E Network Guard] 拦截到未授权的外部请求: ${parsed.href}。` +
            '请将其主机名加入 installMockFetchRouter targetHosts 或使用本地 MockUpstreamServer。'
        );
      }
      return originalFetch(input, init);
    }

    routedCount += 1;
    const targetUrl = `${targetBase}${parsed.pathname}${parsed.search}`;

    if (typeof input !== 'string' && !(input instanceof URL)) {
      // 当入参为 Request 实例时，完整提取 method / headers / body / signal 再重建转发
      const mergedHeaders = new Headers(input.headers);
      if (init?.headers) {
        const override = new Headers(init.headers);
        override.forEach((val, key) => {
          mergedHeaders.set(key, val);
        });
      }
      let bodyToSend = init?.body;
      if (bodyToSend === undefined && input.method !== 'GET' && input.method !== 'HEAD') {
        const buf = await input.clone().arrayBuffer();
        if (buf.byteLength > 0) {
          bodyToSend = buf;
        }
      }
      return originalFetch(targetUrl, {
        ...init,
        method: init?.method ?? input.method,
        headers: mergedHeaders,
        body: bodyToSend,
        signal: init?.signal ?? input.signal,
      });
    }

    return originalFetch(targetUrl, init);
  };

  globalThis.fetch = routedFetch;

  let routerRestored = false;
  return {
    restore: () => {
      if (routerRestored) {
        return;
      }
      routerRestored = true;
      try {
        if (globalThis.fetch === routedFetch) {
          globalThis.fetch = originalFetch;
        }
      } finally {
        restoreWebDevProxyContext?.();
      }
    },
    getRoutedCount: () => routedCount,
  };
}
