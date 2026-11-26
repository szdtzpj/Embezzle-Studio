import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryApplicationLifecycleAdapter } from '../../../src/app/lifecycle/memoryApplicationLifecycleAdapter';
import { FakeClock } from '../../../src/app/testing/fakeClock';
import { MemoryWorkspacePersistenceAdapter } from '../../../src/app/workspace/adapters/memoryWorkspacePersistenceAdapter';
import {
  WORKSPACE_SAVE_DEBOUNCE_MS,
  WorkspaceSession,
} from '../../../src/app/workspace/WorkspaceSession';
import { useWorkspaceSelector } from '../../../src/app/workspace/WorkspaceSessionProvider';
import { createDefaultWorkspace } from '../../../src/data/providerCatalog';
import { ChatWorkspaceRuntime } from '../../../src/features/chat/internal/ChatWorkspaceRuntime';
import type {
  ChatLease,
  ChatOrchestrationController,
} from '../../../src/features/chat/internal/ChatContext';
import { ChatRequestExecution } from '../../../src/features/chat/internal/requests/ChatRequestExecution';
import type { ProviderAdapter } from '../../../src/features/chat/orchestration/ProviderAdapterRegistry';
import {
  createE2EWorkspaceHarness,
  safeImportModule,
} from '../helpers/e2eWorkspaceHarness';
import { generateHighFrequencyTextDeltas } from '../helpers/sseFixtures';
import {
  installLongTaskCollector,
  probeOverlayResidual,
  readLongTaskStats,
} from '../helpers/webGeometryProbes';

const reactHarness = vi.hoisted(() => ({
  contextValue: null as unknown,
  snapshotReads: [] as unknown[],
}));

vi.mock('react', () => ({
  default: {},
  createContext: (defaultValue: unknown) => ({ defaultValue }),
  useContext: () => reactHarness.contextValue,
  useEffect: () => undefined,
  useMemo: (factory: () => unknown) => factory(),
  useRef: (initialValue: unknown) => ({ current: initialValue }),
  useSyncExternalStore: (
    _subscribe: (listener: () => void) => () => void,
    getSnapshot: () => unknown
  ) => {
    const first = getSnapshot();
    const second = getSnapshot();
    reactHarness.snapshotReads = [first, second];
    if (first !== second) {
      throw new Error('External-store snapshots must be referentially stable.');
    }
    return first;
  },
}));

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..', '..', '..');

function parseSourceFile(relPath: string): ts.SourceFile {
  const absPath = path.resolve(REPO_ROOT, relPath);
  const content = fs.readFileSync(absPath, 'utf8');
  const kind = absPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(absPath, content, ts.ScriptTarget.Latest, true, kind);
}

interface JsxElementSummary {
  tagName: string;
  attributes: Map<string, string>;
  attributeNodes: Map<string, ts.JsxAttribute>;
  node: ts.JsxOpeningElement | ts.JsxSelfClosingElement;
}

function collectJsxElements(sourceFile: ts.SourceFile, targetTag?: string): JsxElementSummary[] {
  const results: JsxElementSummary[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tagName = node.tagName.getText(sourceFile);
      if (!targetTag || tagName === targetTag) {
        const attributes = new Map<string, string>();
        const attributeNodes = new Map<string, ts.JsxAttribute>();
        for (const prop of node.attributes.properties) {
          if (ts.isJsxAttribute(prop)) {
            const name = prop.name.getText(sourceFile);
            const initText = prop.initializer ? prop.initializer.getText(sourceFile) : 'true';
            attributes.set(name, initText);
            attributeNodes.set(name, prop);
          }
        }
        results.push({ tagName, attributes, attributeNodes, node });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return results;
}

function collectImportAliases(sourceFile: ts.SourceFile, targetNames: readonly string[]): Set<string> {
  const targetSet = new Set(targetNames);
  const aliases = new Set<string>();
  const namespaces = new Set<string>();

  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
    const { importClause } = stmt;
    if (importClause.name && targetSet.has(importClause.name.text)) {
      aliases.add(importClause.name.text);
    }
    const bindings = importClause.namedBindings;
    if (!bindings) continue;
    if (ts.isNamedImports(bindings)) {
      for (const spec of bindings.elements) {
        const originalName = spec.propertyName ? spec.propertyName.text : spec.name.text;
        if (targetSet.has(originalName)) {
          aliases.add(spec.name.text);
        }
      }
    } else if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
    }
  }

  for (const ns of namespaces) {
    for (const name of targetNames) {
      aliases.add(`${ns}.${name}`);
    }
  }
  return aliases;
}

function collectCallExpressions(
  sourceFile: ts.SourceFile,
  calleeNames: string | readonly string[]
): ts.CallExpression[] {
  const allowed = new Set(Array.isArray(calleeNames) ? calleeNames : [calleeNames]);
  const results: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && allowed.has(node.expression.getText(sourceFile))) {
      results.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return results;
}

function unwrapExpression(expr: ts.Expression): ts.Expression {
  let curr = expr;
  while (
    ts.isParenthesizedExpression(curr) ||
    ts.isAsExpression(curr) ||
    ts.isSatisfiesExpression(curr) ||
    ts.isNonNullExpression(curr)
  ) {
    curr = curr.expression;
  }
  return curr;
}

type FunctionLikeNode = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

function extractFunctionFromInitializer(
  init: ts.Expression,
  sf: ts.SourceFile
): FunctionLikeNode | null {
  const expr = unwrapExpression(exprOrInit(init));
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
    return expr;
  }
  if (ts.isCallExpression(expr)) {
    const callee = expr.expression.getText(sf);
    if ((callee === 'useCallback' || callee === 'React.useCallback') && expr.arguments[0]) {
      return extractFunctionFromInitializer(expr.arguments[0], sf);
    }
  }
  return null;
}

function exprOrInit(expr: ts.Expression): ts.Expression {
  return expr;
}

function findFunctionLikeByName(sourceFile: ts.SourceFile, targetName: string): FunctionLikeNode | null {
  let found: FunctionLikeNode | null = null;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === targetName) {
      found = node;
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === targetName &&
      node.initializer
    ) {
      const fn = extractFunctionFromInitializer(node.initializer, sourceFile);
      if (fn) {
        found = fn;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function resolveSelectorFunction(
  sourceFile: ts.SourceFile,
  arg: ts.Expression | undefined,
  visited = new Set<string>()
): FunctionLikeNode | null {
  if (!arg) return null;
  const expr = unwrapExpression(arg);
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
    return expr;
  }
  if (ts.isIdentifier(expr) && !visited.has(expr.text)) {
    visited.add(expr.text);
    const fn = findFunctionLikeByName(sourceFile, expr.text);
    if (fn) return fn;
  }
  return null;
}

function isFullSnapshotSelector(fn: FunctionLikeNode, sf: ts.SourceFile): boolean {
  const firstParam = fn.parameters[0]?.name;
  if (!firstParam || !ts.isIdentifier(firstParam)) return false;
  const paramName = firstParam.text;

  const isReturnedExprFullSnapshot = (rawExpr: ts.Expression): boolean => {
    const expr = unwrapExpression(rawExpr);
    if (ts.isIdentifier(expr) && expr.text === paramName) {
      return true;
    }
    if (ts.isObjectLiteralExpression(expr)) {
      return expr.properties.some(
        (prop) =>
          ts.isSpreadAssignment(prop) &&
          ts.isIdentifier(unwrapExpression(prop.expression)) &&
          unwrapExpression(prop.expression).getText(sf) === paramName
      );
    }
    if (ts.isCallExpression(expr) && expr.expression.getText(sf) === 'Object.assign') {
      return expr.arguments.some(
        (a) => ts.isIdentifier(unwrapExpression(a)) && unwrapExpression(a).getText(sf) === paramName
      );
    }
    return false;
  };

  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) {
    return isReturnedExprFullSnapshot(fn.body);
  }
  if (fn.body && ts.isBlock(fn.body)) {
    let matched = false;
    const visit = (node: ts.Node) => {
      if (matched) return;
      if (ts.isReturnStatement(node) && node.expression && isReturnedExprFullSnapshot(node.expression)) {
        matched = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(fn.body);
    return matched;
  }
  return false;
}

function doesSelectorSubscribeFullConversations(fn: FunctionLikeNode, sf: ts.SourceFile): boolean {
  const text = fn.getText(sf);
  return /\.\s*conversations\b/.test(text) && !/generationTask|activeTask/i.test(text);
}

function isNullLiteral(node: ts.Node): boolean {
  const target = ts.isExpression(node) ? unwrapExpression(node) : node;
  return target.kind === ts.SyntaxKind.NullKeyword;
}

function isReturnNullStatement(stmt: ts.Statement): boolean {
  if (ts.isReturnStatement(stmt)) {
    return Boolean(stmt.expression && isNullLiteral(stmt.expression));
  }
  if (ts.isBlock(stmt)) {
    return stmt.statements.some((s) => isReturnNullStatement(s));
  }
  return false;
}

function isClosedConditionText(condText: string): boolean {
  return (
    /!\s*(?:props\.|settings\.)?isOpen\b/.test(condText) ||
    /(?:props\.|settings\.)?isOpen\s*===?\s*false\b/.test(condText)
  );
}

function isOpenConditionText(condText: string): boolean {
  return (
    /\b(?:props\.|settings\.)?isOpen\b/.test(condText) &&
    !/!\s*(?:props\.|settings\.)?isOpen\b/.test(condText) &&
    !/===?\s*false\b/.test(condText)
  );
}

function doesSettingsPaneUnmountOnClose(sf: ts.SourceFile): {
  foundComponent: boolean;
  hasLegacyKeepAlive: boolean;
  returnsNullWhenClosed: boolean;
} {
  const fn = findFunctionLikeByName(sf, 'SettingsPane');
  if (!fn || !fn.body) {
    return { foundComponent: false, hasLegacyKeepAlive: false, returnsNullWhenClosed: false };
  }

  const fullText = sf.getFullText();
  const bodyText = fn.body.getText(sf);
  const hasLegacyKeepAlive =
    /\bhasMounted\b/.test(bodyText) ||
    /display\s*:\s*['"]none['"]/.test(fullText) ||
    /nativeHidden\s*:\s*\{\s*opacity\s*:\s*0\s*\}/.test(fullText);

  let returnsNullWhenClosed = false;
  const visit = (node: ts.Node) => {
    if (returnsNullWhenClosed) return;
    if (ts.isIfStatement(node)) {
      const condText = node.expression.getText(sf);
      if (isClosedConditionText(condText) && isReturnNullStatement(node.thenStatement)) {
        returnsNullWhenClosed = true;
        return;
      }
    } else if (ts.isReturnStatement(node) && node.expression) {
      const expr = unwrapExpression(node.expression);
      if (ts.isConditionalExpression(expr)) {
        const condText = expr.condition.getText(sf);
        if (
          (isOpenConditionText(condText) && isNullLiteral(expr.whenFalse)) ||
          (isClosedConditionText(condText) && isNullLiteral(expr.whenTrue))
        ) {
          returnsNullWhenClosed = true;
          return;
        }
      } else if (
        ts.isBinaryExpression(expr) &&
        expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        isOpenConditionText(expr.left.getText(sf))
      ) {
        returnsNullWhenClosed = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);

  return { foundComponent: true, hasLegacyKeepAlive, returnsNullWhenClosed };
}

function isSubstantiveOnFinalizeCallback(arg: ts.Expression | undefined, sf: ts.SourceFile): boolean {
  const fn = resolveSelectorFunction(sf, arg);
  if (!fn || !fn.body) return false;

  if (ts.isBlock(fn.body)) {
    if (fn.body.statements.length === 0) return false;
  }

  const bodyText = fn.body.getText(sf);
  const hasStateOrAnimationReset =
    /\bwithTiming\b|\bwithSpring\b|\brunOnJS\b/.test(bodyText) ||
    /\.value\s*=/.test(bodyText) ||
    /\bset[A-Z][A-Za-z0-9_]*\s*\(/.test(bodyText);
  return hasStateOrAnimationReset;
}

function hasSubstantiveCloseRaceGuard(sf: ts.SourceFile): boolean {
  const cancelCalls = collectCallExpressions(sf, 'cancelAnimation');
  if (cancelCalls.length > 0) return true;

  const guardNamePattern = /epoch|token|generation|openRef|isOpen|cancelled|canceled|active|closing/i;
  const checkNodeHasConditionalGuard = (node: ts.Node, visited = new Set<string>()): boolean => {
    let guarded = false;
    const visit = (curr: ts.Node) => {
      if (guarded) return;
      if (ts.isIfStatement(curr)) {
        const condText = curr.expression.getText(sf);
        const thenText = curr.thenStatement.getText(sf);
        if (
          guardNamePattern.test(condText) &&
          (/\bsetMounted\b/.test(thenText) || /\bclose\b|\bmounted\b/i.test(thenText))
        ) {
          guarded = true;
          return;
        }
      } else if (ts.isConditionalExpression(curr)) {
        const condText = curr.condition.getText(sf);
        const fullText = curr.getText(sf);
        if (guardNamePattern.test(condText) && /\bsetMounted\b/.test(fullText)) {
          guarded = true;
          return;
        }
      } else if (ts.isCallExpression(curr)) {
        const callee = curr.expression.getText(sf);
        if (callee === 'runOnJS' && curr.arguments[0] && ts.isIdentifier(curr.arguments[0])) {
          const fnName = curr.arguments[0].text;
          if (!visited.has(fnName)) {
            visited.add(fnName);
            const resolved = findFunctionLikeByName(sf, fnName);
            if (resolved && checkNodeHasConditionalGuard(resolved, visited)) {
              guarded = true;
              return;
            }
          }
        } else if (ts.isIdentifier(curr.expression) && !visited.has(curr.expression.text)) {
          const fnName = curr.expression.text;
          visited.add(fnName);
          const resolved = findFunctionLikeByName(sf, fnName);
          if (resolved && checkNodeHasConditionalGuard(resolved, visited)) {
            guarded = true;
            return;
          }
        }
      }
      ts.forEachChild(curr, visit);
    };
    visit(node);
    return guarded;
  };

  const withTimingCalls = collectCallExpressions(sf, 'withTiming');
  return withTimingCalls.some((call) => {
    const cb = call.arguments[2];
    if (!cb) return false;
    return checkNodeHasConditionalGuard(cb);
  });
}

function inspectChatPaneStreamingDraftRouting(sf: ts.SourceFile): {
  foundHandler: boolean;
  isolatesPendingUpdates: boolean;
} {
  const fn = findFunctionLikeByName(sf, 'updateAssistantMessage');
  if (!fn || !fn.body) {
    return { foundHandler: false, isolatesPendingUpdates: false };
  }

  const bodyText = fn.body.getText(sf);
  const callsMessageUpdateDirectly = /['"]message\.update['"]/.test(bodyText);
  if (!callsMessageUpdateDirectly) {
    // 不直接发送 message.update（例如完全交由草稿通道或外层路由）
    return {
      foundHandler: true,
      isolatesPendingUpdates: /draft|stream/i.test(bodyText),
    };
  }

  // 若仍保留 message.update（例如仅终态落盘），必须存在对 pending / streaming 的条件隔离分流
  let hasPendingBranch = false;
  const visit = (node: ts.Node) => {
    if (hasPendingBranch) return;
    if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) {
      const condText = ts.isIfStatement(node)
        ? node.expression.getText(sf)
        : node.condition.getText(sf);
      if (/pending|streaming|draft/i.test(condText)) {
        hasPendingBranch = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);

  return {
    foundHandler: true,
    isolatesPendingUpdates: hasPendingBranch && /draft|streaming/i.test(bodyText),
  };
}

function createSingleLeaseController(): {
  controller: AbortController;
  orchestration: ChatOrchestrationController;
} {
  const controller = new AbortController();
  let activeLease: ChatLease | null = null;
  const orchestration: ChatOrchestrationController = {
    current: () => activeLease,
    begin: ({ phase, label, mcpActive = false }) => {
      if (activeLease) return null;
      activeLease = { controller, label, phase, mcpActive };
      return activeLease;
    },
    transition: (lease, phase) => {
      if (!activeLease || activeLease !== lease) return false;
      activeLease.phase = phase;
      return true;
    },
    finish: (lease) => {
      if (activeLease === lease) activeLease = null;
    },
    stop: () => {
      controller.abort();
    },
  };
  return { controller, orchestration };
}

interface MockPerformanceObserverHooks {
  install: () => () => void;
  emitLongTask: (durationMs: number, startTime?: number) => void;
  triggerRaf: (timestampMs: number) => void;
  getDisconnectCalls: () => number;
  getCancelRafCalls: () => number;
  getObserverCreatedCount: () => number;
}

function createPerfAndRafHarness(options: {
  supportedEntryTypes: string[];
}): MockPerformanceObserverHooks {
  let disconnectCalls = 0;
  let cancelRafCalls = 0;
  let observerCreatedCount = 0;
  let nextRafId = 1;
  const rafCallbacks = new Map<number, (ts: number) => void>();
  const observerListeners = new Set<(list: { getEntries: () => Array<{ startTime: number; duration: number; name: string }> }) => void>();

  class MockPerformanceObserver {
    static readonly supportedEntryTypes = options.supportedEntryTypes;
    private readonly callback: (list: {
      getEntries: () => Array<{ startTime: number; duration: number; name: string }>;
    }) => void;

    constructor(
      callback: (list: {
        getEntries: () => Array<{ startTime: number; duration: number; name: string }>;
      }) => void
    ) {
      observerCreatedCount += 1;
      this.callback = callback;
    }

    observe(): void {
      observerListeners.add(this.callback);
    }

    disconnect(): void {
      disconnectCalls += 1;
      observerListeners.delete(this.callback);
    }
  }

  const fakeWindow: Record<string, unknown> = {};
  const mockRaf = (cb: (ts: number) => void): number => {
    const id = nextRafId++;
    rafCallbacks.set(id, cb);
    return id;
  };
  const mockCancelRaf = (id: number): void => {
    cancelRafCalls += 1;
    rafCallbacks.delete(id);
  };

  const install = (): (() => void) => {
    const prevWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const prevPerfObserver = Object.getOwnPropertyDescriptor(globalThis, 'PerformanceObserver');
    const prevRaf = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
    const prevCancelRaf = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame');

    Object.defineProperty(globalThis, 'window', {
      value: fakeWindow,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'PerformanceObserver', {
      value: MockPerformanceObserver,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      value: mockRaf,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'cancelAnimationFrame', {
      value: mockCancelRaf,
      configurable: true,
      writable: true,
    });

    return () => {
      const restoreDescriptor = (key: string, prev: PropertyDescriptor | undefined) => {
        if (prev) {
          Object.defineProperty(globalThis, key, prev);
        } else {
          Reflect.deleteProperty(globalThis, key);
        }
      };
      restoreDescriptor('window', prevWindow);
      restoreDescriptor('PerformanceObserver', prevPerfObserver);
      restoreDescriptor('requestAnimationFrame', prevRaf);
      restoreDescriptor('cancelAnimationFrame', prevCancelRaf);
    };
  };

  return {
    install,
    emitLongTask: (durationMs: number, startTime = 100) => {
      for (const listener of observerListeners) {
        listener({
          getEntries: () => [{ startTime, duration: durationMs, name: 'self' }],
        });
      }
    },
    triggerRaf: (timestampMs: number) => {
      const pending = Array.from(rafCallbacks.entries());
      rafCallbacks.clear();
      for (const [, cb] of pending) {
        cb(timestampMs);
      }
    },
    getDisconnectCalls: () => disconnectCalls,
    getCancelRafCalls: () => cancelRafCalls,
    getObserverCreatedCount: () => observerCreatedCount,
  };
}

describe('F10: Drawer 手势安全、长对话虚拟化吸底与高频流式性能 E2E', () => {
  const restoreCallbacks: Array<() => void> = [];

  beforeEach(() => {
    reactHarness.contextValue = null;
    reactHarness.snapshotReads = [];
  });

  afterEach(() => {
    while (restoreCallbacks.length > 0) {
      const restore = restoreCallbacks.pop();
      restore?.();
    }
  });

  describe('Tier 1 — 流式切片隔离、按需卸载、Drawer 手势与虚拟化列表正常契约', () => {
    it('F10-T1-1: 流式草稿态隔离（useStreamingDraftSelector 存在、草稿通道 220 chunks 零全局广播且 ChatPane 分流 pending 更新）', async () => {
      // (a) 从 ChatWorkspaceRuntime.ts 与 WorkspaceSessionProvider.tsx 探测草稿隔离选择器与草稿通道接口
      const runtimeMod = await safeImportModule<Record<string, unknown>>(
        'src/features/chat/internal/ChatWorkspaceRuntime.ts',
        []
      );
      const providerMod = await safeImportModule<Record<string, unknown>>(
        'src/app/workspace/WorkspaceSessionProvider.tsx',
        ['useWorkspaceSelector']
      );

      const draftHook =
        (typeof runtimeMod.useStreamingDraftSelector === 'function'
          ? runtimeMod.useStreamingDraftSelector
          : undefined) ??
        (typeof runtimeMod.useStreamingMessageDraft === 'function'
          ? runtimeMod.useStreamingMessageDraft
          : undefined) ??
        (typeof providerMod.useStreamingDraftSelector === 'function'
          ? providerMod.useStreamingDraftSelector
          : undefined) ??
        (typeof providerMod.useStreamingMessageDraft === 'function'
          ? providerMod.useStreamingMessageDraft
          : undefined);

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
        clear?: (conversationId: string, messageId?: string) => void;
      };

      const resolveDraftChannel = (
        candidates: Array<Record<string, unknown>>
      ): { kind: 'fn'; fn: DraftPublishFn } | { kind: 'store'; store: DraftStoreLike } | undefined => {
        for (const obj of candidates) {
          for (const fnKey of [
            'setStreamingDraft',
            'updateStreamingDraft',
            'publishStreamingDraft',
            'setStreamingMessageDraft',
          ]) {
            if (typeof obj[fnKey] === 'function') {
              return { kind: 'fn', fn: obj[fnKey] as DraftPublishFn };
            }
          }
          const storeCandidate = obj.streamingDraftStore;
          if (storeCandidate && typeof storeCandidate === 'object') {
            return { kind: 'store', store: storeCandidate as DraftStoreLike };
          }
        }
        return undefined;
      };

      const moduleDraftChannel = resolveDraftChannel([runtimeMod, providerMod]);

      // (b) 同时通过 TS AST 检查 ChatPane.tsx 中 updateAssistantMessage 对 status === 'pending' 流式增量走草稿隔离层
      const chatPaneSf = parseSourceFile('src/features/chat/ChatPane.tsx');
      const chatPaneRouting = inspectChatPaneStreamingDraftRouting(chatPaneSf);
      expect(chatPaneRouting.foundHandler, 'ChatPane.tsx 缺少 updateAssistantMessage 处理函数').toBe(true);
      expect(
        chatPaneRouting.isolatesPendingUpdates,
        'ChatPane.tsx updateAssistantMessage 在 status === "pending" 流式更新时仍直接提交 message.update，须路由至流式草稿隔离层'
      ).toBe(true);

      // 校验草稿隔离 Hook 或草稿通道契约已定义（未落地时在此真实暴露失败）
      expect(
        draftHook ?? moduleDraftChannel,
        '缺少流式草稿隔离选择器（useStreamingDraftSelector / useStreamingMessageDraft）或草稿通道 API'
      ).toBeDefined();
      expect(
        draftHook,
        '缺少流式草稿隔离选择器（useStreamingDraftSelector / useStreamingMessageDraft）'
      ).toBeDefined();

      // 若导出或实例上存在草稿通道接口，真实驱动 220 个高频 chunks 验证中间态零 WorkspaceSession 广播与零持久化落盘
      const harness = await createE2EWorkspaceHarness();
      restoreCallbacks.push(() => harness.dispose());

      const runtimeInstanceObj = harness.chatRuntime as unknown as Record<string, unknown>;
      const draftChannel =
        moduleDraftChannel ?? resolveDraftChannel([runtimeInstanceObj]);

      if (draftChannel) {
        await harness.addAndSelectProvider({
          id: 'f10-t1-provider',
          name: 'F10 T1 OpenAI',
          kind: 'openai-compatible',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-f10-t1',
          capabilities: ['text', 'streaming'],
          models: [{ id: 'gpt-5', capabilities: ['text', 'streaming'], source: 'manual' }],
        });
        const convId = harness.session.getSnapshot().activeConversationId;
        const assistantMsgId = 'stream-isolated-msg';
        await harness.chatRuntime.execute({
          type: 'conversation.set-messages',
          conversationId: convId,
          now: harness.clock.now(),
          messages: [
            { id: 'u-stream', role: 'user', content: '高频流式测试', createdAt: 1, status: 'ready' },
            { id: assistantMsgId, role: 'assistant', content: '', createdAt: 2, status: 'pending' },
          ],
        });
        await harness.flush();

        let sessionEmitDuringStream = 0;
        const unsubscribe = harness.session.subscribe(() => {
          sessionEmitDuringStream += 1;
        });
        restoreCallbacks.push(unsubscribe);

        const saveSpy = vi.spyOn(harness.persistence, 'save');
        restoreCallbacks.push(() => saveSpy.mockRestore());

        const publishDraft: DraftPublishFn =
          draftChannel.kind === 'fn'
            ? draftChannel.fn
            : (cId, mId, patch) => {
                const s = draftChannel.store;
                const fn = s.set ?? s.update ?? s.publish ?? s.setDraft;
                fn?.(cId, mId, patch);
              };

        const deltas = generateHighFrequencyTextDeltas(220, '块');
        let accumulated = '';
        for (const delta of deltas) {
          accumulated += delta;
          publishDraft(convId, assistantMsgId, { content: accumulated, status: 'pending' });
        }

        expect(
          sessionEmitDuringStream,
          `流式草稿通道写入 220 chunks 期间不应触发 WorkspaceSession 广播，实际触发 ${sessionEmitDuringStream} 次`
        ).toBe(0);
        expect(
          saveSpy.mock.calls.length,
          `流式草稿通道写入 220 chunks 期间不应触发持久化落盘，实际落盘 ${saveSpy.mock.calls.length} 次`
        ).toBe(0);

        // 完成提交终态时，仅执行 1 次终态提交与落盘
        await harness.chatRuntime.execute({
          type: 'message.update',
          messageId: assistantMsgId,
          conversationId: convId,
          patch: { content: accumulated, status: 'ready' },
          now: harness.clock.now(),
        });
        await harness.flush();
        expect(saveSpy.mock.calls.length).toBe(1);
        const persistedMsg = harness.persistence
          .getStoredSnapshot()
          ?.conversations.find((c) => c.id === convId)
          ?.messages.find((m) => m.id === assistantMsgId);
        expect(persistedMsg?.content).toBe(accumulated);
        expect(persistedMsg?.status).toBe('ready');
      }
    });

    it('F10-T1-2: GenerationTaskBackgroundProvider 精确订阅（不直接订阅全量 conversations 数组）', () => {
      const sf = parseSourceFile('src/features/background/GenerationTaskBackgroundProvider.tsx');
      const selectorCalls = collectCallExpressions(sf, 'useWorkspaceSelector');
      expect(selectorCalls.length).toBeGreaterThanOrEqual(1);

      const subscribesFullConversations = selectorCalls.some((call) => {
        const selectorFn = resolveSelectorFunction(sf, call.arguments[0]);
        if (selectorFn) {
          return doesSelectorSubscribeFullConversations(selectorFn, sf);
        }
        const argText = call.arguments[0]?.getText(sf) ?? '';
        return /\.\s*conversations\b/.test(argText) && !/generationTask|activeTask/i.test(argText);
      });
      expect(
        subscribesFullConversations,
        'GenerationTaskBackgroundProvider 不得直接订阅全量 workspace.conversations 导致每条文本 chunk 都触发后台任务重注册'
      ).toBe(false);

      const useEffectCalls = collectCallExpressions(sf, ['useEffect', 'React.useEffect']);
      const effectDependsOnFullConversations = useEffectCalls.some((call) => {
        const depsArg = call.arguments[1];
        if (!depsArg || !ts.isArrayLiteralExpression(depsArg)) return false;
        return depsArg.elements.some((el) => el.getText(sf).trim() === 'conversations');
      });
      expect(
        effectDependsOnFullConversations,
        'GenerationTaskBackgroundProvider 的 useEffect 依赖数组不得直接依赖全量 conversations 数组'
      ).toBe(false);
    });

    it('F10-T1-3: SettingsPane 关闭后按需卸载（!isOpen 时返回 null，不常驻渲染挂载）', () => {
      const sf = parseSourceFile('src/features/settings/SettingsPane.tsx');
      const status = doesSettingsPaneUnmountOnClose(sf);
      expect(status.foundComponent, 'SettingsPane.tsx 须定义 SettingsPane 组件').toBe(true);
      expect(
        status.hasLegacyKeepAlive,
        'SettingsPane 不得保留 hasMounted 常驻隐藏或 display:none / opacity:0 保活逻辑'
      ).toBe(false);
      expect(
        status.returnsNullWhenClosed,
        'SettingsPane 关闭 (!isOpen) 时须立即卸载返回 null，不得常驻挂载'
      ).toBe(true);
    });

    it('F10-T1-4: ProjectDrawerShell 无嵌套 GestureHandlerRootView 且 Pan 手势完备 .onFinalize', () => {
      const sf = parseSourceFile('src/features/projects/ProjectDrawerShell.tsx');

      // 1) 不得在 Modal 内部重复嵌套 GestureHandlerRootView（支持导入别名解析）
      const rootViewTags = collectImportAliases(sf, ['GestureHandlerRootView']);
      rootViewTags.add('GestureHandlerRootView');
      const nestedRootViews = collectJsxElements(sf).filter((el) => rootViewTags.has(el.tagName));
      expect(
        nestedRootViews.length,
        `ProjectDrawerShell 存在 ${nestedRootViews.length} 处嵌套 <GestureHandlerRootView>`
      ).toBe(0);

      // 2) Gesture.Pan() 链必须注册非空且具备实质性复位逻辑的 .onFinalize(...) 以清理手势中断残影
      const onFinalizeCalls: ts.CallExpression[] = [];
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'onFinalize'
        ) {
          onFinalizeCalls.push(node);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
      expect(
        onFinalizeCalls.length,
        'ProjectDrawerShell 的 Gesture.Pan() 手势链缺少 .onFinalize(...) 复位保护'
      ).toBeGreaterThanOrEqual(1);
      const hasSubstantiveFinalize = onFinalizeCalls.some((call) =>
        isSubstantiveOnFinalizeCallback(call.arguments[0], sf)
      );
      expect(
        hasSubstantiveFinalize,
        'ProjectDrawerShell .onFinalize(...) 回调不得为空，须对动画进度或状态执行实质复位'
      ).toBe(true);
    });

    it('F10-T1-5: 长对话虚拟化列表（FlatList/FlashList 迁移）与不抢手势智能吸底及“回到底部”按钮', () => {
      const sf = parseSourceFile('src/features/chat/ChatPane.tsx');
      const scrollViewTags = collectImportAliases(sf, ['ScrollView']);
      scrollViewTags.add('ScrollView');
      const scrollViews = collectJsxElements(sf).filter((el) => scrollViewTags.has(el.tagName));
      const chatMessageScrollView = scrollViews.find(
        (sv) => sv.attributes.get('ref') === '{chatScrollRef}'
      );
      expect(
        chatMessageScrollView?.tagName,
        'ChatPane 主消息列表仍使用 <ScrollView ref={chatScrollRef}>，须迁移至虚拟化列表 (FlatList/FlashList)'
      ).toBeUndefined();

      const virtualListTags = new Set([
        ...collectImportAliases(sf, ['FlatList', 'FlashList']),
        'FlatList',
        'FlashList',
      ]);
      const virtualLists = collectJsxElements(sf).filter((el) => virtualListTags.has(el.tagName));
      expect(
        virtualLists.length,
        'ChatPane 须渲染 <FlatList> 或 <FlashList> 承载长对话消息列表'
      ).toBeGreaterThanOrEqual(1);

      const hasScrollBeginDrag = virtualLists.some((el) =>
        el.attributes.has('onScrollBeginDrag')
      );
      expect(
        hasScrollBeginDrag,
        '虚拟化消息列表须绑定 onScrollBeginDrag 在用户触屏拖拽时立即解除吸底保护'
      ).toBe(true);

      const allJsx = collectJsxElements(sf);
      const hasScrollToBottomButton = allJsx.some((el) => {
        const label = el.attributes.get('accessibilityLabel') ?? '';
        const testId = el.attributes.get('testID') ?? '';
        return label.includes('回到底部') || /scroll-to-bottom/i.test(testId);
      });
      expect(
        hasScrollToBottomButton,
        'ChatPane 须提供“回到底部”悬浮按钮以便用户离开底部后一键回滚'
      ).toBe(true);
    });

    it('F10-T1-6: webGeometryProbes Long Task 探针基线窗口采样与重置隔离', () => {
      const perfHarness = createPerfAndRafHarness({
        supportedEntryTypes: ['longtask', 'measure'],
      });
      const restore = perfHarness.install();
      restoreCallbacks.push(restore);

      const installed = installLongTaskCollector(true);
      expect(installed).toEqual({ supported: true, installed: true });

      // 模拟 2 次正常短帧 (18ms) 与 1 次 65ms 长阻塞帧 + Long Task
      perfHarness.triggerRaf(100);
      perfHarness.triggerRaf(118);
      perfHarness.triggerRaf(136);
      perfHarness.emitLongTask(65, 136);
      perfHarness.triggerRaf(201);

      const stats = readLongTaskStats(true);
      expect(stats.supported).toBe(true);
      expect(stats.installed).toBe(true);
      expect(stats.count).toBe(1);
      expect(stats.totalDurationMs).toBe(65);
      expect(stats.maxDurationMs).toBe(65);
      expect(stats.maxRafGapMs).toBeGreaterThanOrEqual(65);

      // resetAfterRead = true 后二次读取应被重置清零
      const afterReset = readLongTaskStats();
      expect(afterReset.count).toBe(0);
      expect(afterReset.totalDurationMs).toBe(0);
      expect(afterReset.maxDurationMs).toBe(0);
      expect(afterReset.maxRafGapMs).toBe(0);
    });
  });

  describe('Tier 2 — 高频流式取消、防抖竞争、Drawer 时序与探针降级边界', () => {
    it('F10-T2-1: 250 chunks 高频流式节流聚合 + Abort/断流清除残余 timer 防覆写终态', async () => {
      const harness = await createE2EWorkspaceHarness();
      restoreCallbacks.push(() => harness.dispose());
      await harness.addAndSelectProvider({
        id: 'f10-stream-provider',
        name: 'F10 Stream OpenAI',
        kind: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-f10-test',
        capabilities: ['text', 'streaming'],
        models: [{ id: 'gpt-5', capabilities: ['text', 'streaming'], source: 'manual' }],
      });
      const provider = harness.session
        .getSnapshot()
        .providers.find((p) => p.id === 'f10-stream-provider');
      const model = provider?.models[0];
      if (!provider || !model) throw new Error('Expected test provider/model.');

      const convId = harness.session.getSnapshot().activeConversationId;
      const runCase = async (mode: 'complete' | 'abort' | 'error', msgId: string) => {
        await harness.chatRuntime.execute({
          type: 'conversation.set-messages',
          conversationId: convId,
          now: harness.clock.now(),
          messages: [
            { id: `u-${msgId}`, role: 'user', content: '高频测试', createdAt: 1, status: 'ready' },
            { id: msgId, role: 'assistant', content: '', createdAt: 2, status: 'pending' },
          ],
        });
        const { controller, orchestration } = createSingleLeaseController();
        orchestration.begin({ phase: 'provider-request', label: msgId });

        const deltas = generateHighFrequencyTextDeltas(250, '段');
        const adapter: ProviderAdapter = {
          run: async (request) => {
            if (mode === 'complete') {
              let full = '';
              for (const d of deltas) {
                full += d;
                request.onStreamUpdate?.({ content: full });
              }
              return { content: full, raw: undefined };
            }
            if (mode === 'abort') {
              request.onStreamUpdate?.({ content: '已输出半截-不可被覆写' });
              controller.abort();
              const err = new Error('User cancelled');
              err.name = 'AbortError';
              throw err;
            }
            request.onStreamUpdate?.({ content: '断流前内容' });
            throw new Error('SSE_SOCKET_RESET');
          },
          queryTask: async () => ({ content: '', raw: undefined }),
        };

        const exec = new ChatRequestExecution(
          { resolve: () => adapter },
          orchestration,
          {
            readWorkspace: () => harness.session.getSnapshot(),
            appState: () => 'active',
            // 故意设置较大 streamUpdateDelayMs，检验 abort/error 时是否立刻 clearTimeout
            streamUpdateDelayMs: () => 50,
            discardAttachments: async () => undefined,
            authorize: async () => true,
            persistUsageEvents: async () => undefined,
            finishUsageEvent: async () => undefined,
            requestMcpApproval: async () => 'cancel',
            updateAssistantMessage: (messageId, patch, targetConvId) => {
              void harness.chatRuntime.execute({
                type: 'message.update',
                messageId,
                patch,
                conversationId: targetConvId,
                now: harness.clock.now(),
              });
            },
            notify: () => undefined,
          }
        );

        return exec.execute({
          assistantMessage: { id: msgId, role: 'assistant', content: '', createdAt: 2, status: 'pending' },
          conversationId: convId,
          transcript: [{ id: `u-${msgId}`, role: 'user', content: '高频测试', createdAt: 1, status: 'ready' }],
          runtime: { provider, model, modelId: model.id, reasoningEffort: 'default' },
          controller,
          usageEvent: {
            id: `usage-${msgId}`,
            providerId: provider.id,
            modelId: model.id,
            kind: 'chat',
            status: 'started',
            createdAt: 1,
            localDateKey: '2026-11-25',
            unknownCostComponents: [],
            providerRequestCount: 1,
          },
          parameterSettings: harness.session.getSnapshot().parameterSettings,
        });
      };

      const resComplete = await runCase('complete', 'msg-250-ok');
      expect(resComplete.status).toBe('success');
      const okMsg = harness.session
        .getSnapshot()
        .messages.find((m) => m.id === 'msg-250-ok');
      expect(okMsg?.status).toBe('ready');
      expect(okMsg?.content).toBe(generateHighFrequencyTextDeltas(250, '段').join(''));

      const resAbort = await runCase('abort', 'msg-250-abort');
      expect(resAbort.status).toBe('cancelled');
      // 等待原 50ms 节流计时器窗口过去，验证不会回滚成 pending
      await new Promise((r) => setTimeout(r, 80));
      const abortedMsg = harness.session
        .getSnapshot()
        .messages.find((m) => m.id === 'msg-250-abort');
      expect(abortedMsg?.status).toBe('cancelled');
      expect(abortedMsg?.content).toBe('已输出半截-不可被覆写');

      const resError = await runCase('error', 'msg-250-err');
      expect(resError.status).toBe('error');
      await new Promise((r) => setTimeout(r, 80));
      const errMsg = harness.session
        .getSnapshot()
        .messages.find((m) => m.id === 'msg-250-err');
      expect(errMsg?.status).toBe('error');
      expect(errMsg?.error).toBe('SSE_SOCKET_RESET');
    });

    it('F10-T2-2: WorkspaceSession 450ms 防抖合并 200 次高频更新与 required/deferred 交错提交不倒挂', async () => {
      const clock = new FakeClock();
      clock.setTime(1764000000000);
      const lifecycle = new MemoryApplicationLifecycleAdapter();
      const persistence = new MemoryWorkspacePersistenceAdapter({
        initial: createDefaultWorkspace(),
      });
      const session = new WorkspaceSession({
        persistence,
        clock,
        lifecycle,
        autoBoot: false,
      });
      restoreCallbacks.push(() => session.dispose());
      await session.boot();

      const runtime = new ChatWorkspaceRuntime(session);
      const convId = session.getSnapshot().activeConversationId;

      // 连续 200 次更新，每次仅推进 10ms（低于 450ms 防抖阈值）
      for (let i = 1; i <= 200; i += 1) {
        await runtime.execute({
          type: 'draft.set',
          conversationId: convId,
          text: `高频草稿-${i}`,
          now: clock.now(),
        });
        clock.advance(10);
      }
      await session.settle();
      expect(persistence.savedSnapshots.length).toBe(0);

      // 推进完整 450ms 防抖窗口，应仅执行 1 次落盘且内容为最新第 200 次
      clock.advance(WORKSPACE_SAVE_DEBOUNCE_MS);
      await session.settle();
      expect(persistence.savedSnapshots.length).toBe(1);
      expect(
        persistence.getStoredSnapshot()?.composerDrafts.find((d) => d.conversationId === convId)?.text
      ).toBe('高频草稿-200');

      // deferred 之后立刻触发 required 提交：required 必须清除旧 timer 并立即单次落盘，后续推进 450ms 不再重复写
      await runtime.execute({
        type: 'draft.set',
        conversationId: convId,
        text: '延迟草稿-将被required覆盖',
        now: clock.now(),
      });
      await runtime.execute(
        {
          type: 'draft.set',
          conversationId: convId,
          text: '最终权威-required提交',
          now: clock.now(),
        },
        { durability: 'required' }
      );
      expect(persistence.savedSnapshots.length).toBe(2);

      clock.advance(WORKSPACE_SAVE_DEBOUNCE_MS);
      await session.settle();
      expect(persistence.savedSnapshots.length).toBe(2);
      expect(
        persistence.getStoredSnapshot()?.composerDrafts.find((d) => d.conversationId === convId)?.text
      ).toBe('最终权威-required提交');
    });

    it('F10-T2-3: useWorkspaceSelector 引用稳定性契约与外围宿主精确切片订阅（禁止全量 snapshot => snapshot）', () => {
      // 1) useSyncExternalStore 快照引用稳定性验证
      const snapshot = createDefaultWorkspace();
      const fakeSession = {
        getSnapshot: () => snapshot,
        subscribe: () => () => undefined,
      } as unknown as WorkspaceSession;
      reactHarness.contextValue = { session: fakeSession };

      const activeId = useWorkspaceSelector((ws) => ws.activeConversationId);
      expect(activeId).toBe(snapshot.activeConversationId);
      expect(reactHarness.snapshotReads).toEqual([snapshot, snapshot]);

      // 2) 检查 MobileApplication.tsx 与 ProjectDrawer.tsx 不得再订阅完整 snapshot 对象（含具名 selector 变量与对象展开绕过）
      const fullSnapshotConsumers: string[] = [];
      for (const relPath of [
        'src/ui/mobile/MobileApplication.tsx',
        'src/features/projects/ProjectDrawer.tsx',
      ]) {
        const sf = parseSourceFile(relPath);
        const calls = collectCallExpressions(sf, 'useWorkspaceSelector');
        for (const call of calls) {
          const selectorFn = resolveSelectorFunction(sf, call.arguments[0]);
          if (selectorFn && isFullSnapshotSelector(selectorFn, sf)) {
            fullSnapshotConsumers.push(`${relPath}: ${call.getText(sf)}`);
          }
        }
      }
      expect(
        fullSnapshotConsumers,
        `以下组件仍全量订阅整个 workspace 快照导致高频重渲染: ${fullSnapshotConsumers.join('; ')}`
      ).toEqual([]);
    });

    it('F10-T2-4: Drawer 连续开合竞争取消保护与 probeOverlayResidual 透明遮罩残留检出', () => {
      // 1) 源码检查 ProjectDrawerShell 关闭动画回调或取消链具备实质条件/取消保护（防止快速关->开误卸载或死变量绕过）
      const drawerShellSf = parseSourceFile('src/features/projects/ProjectDrawerShell.tsx');
      const withTimingCalls = collectCallExpressions(drawerShellSf, 'withTiming');
      expect(withTimingCalls.length).toBeGreaterThanOrEqual(1);
      const hasEpochOrCancelGuard = hasSubstantiveCloseRaceGuard(drawerShellSf);
      expect(
        hasEpochOrCancelGuard,
        'ProjectDrawerShell 关闭动画缺少实质性代际/取消保护（如 cancelAnimation 或 if 条件判断），连续开合竞争时可导致 setMounted(false) 误卸载'
      ).toBe(true);

      // 2) probeOverlayResidual 检出 0.01 透明阻挡 scrim
      const scrimRect: DOMRect = {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        width: 390,
        height: 844,
        right: 390,
        bottom: 844,
        toJSON: () => ({}),
      };
      const scrimEl = {
        tagName: 'DIV',
        style: {
          display: 'flex',
          visibility: 'visible',
          pointerEvents: 'auto',
          position: 'fixed',
          zIndex: '30',
          opacity: '0.01',
        },
        getAttribute: (name: string) => (name === 'data-testid' ? 'project-drawer-scrim' : null),
        getBoundingClientRect: () => scrimRect,
      };
      const docEl = { tagName: 'HTML' };
      const bodyEl = { tagName: 'BODY' };

      const prevWin = Object.getOwnPropertyDescriptor(globalThis, 'window');
      const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
      Object.defineProperty(globalThis, 'window', {
        value: {
          innerWidth: 390,
          innerHeight: 844,
          getComputedStyle: (el: typeof scrimEl) => el.style,
        },
        configurable: true,
        writable: true,
      });
      Object.defineProperty(globalThis, 'document', {
        value: {
          documentElement: docEl,
          body: bodyEl,
          querySelectorAll: () => [docEl, bodyEl, scrimEl],
        },
        configurable: true,
        writable: true,
      });

      try {
        const residual = probeOverlayResidual();
        expect(residual.hasBlockingOverlay).toBe(true);
        expect(residual.residuals[0]?.testId).toBe('project-drawer-scrim');

        scrimEl.style.pointerEvents = 'none';
        expect(probeOverlayResidual().hasBlockingOverlay).toBe(false);
      } finally {
        if (prevWin) Object.defineProperty(globalThis, 'window', prevWin);
        else Reflect.deleteProperty(globalThis, 'window');
        if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
        else Reflect.deleteProperty(globalThis, 'document');
      }
    });

    it('F10-T2-5: 长对话（240 条消息）渲染窗/搜索定位契约、distanceFromBottom 吸底阈值与 onScrollBeginDrag 锁定保护', () => {
      const sf = parseSourceFile('src/features/chat/ChatPane.tsx');
      // 1) 验证 handleChatScroll 的距底阈值（< 120）与自动吸底判断（兼容 FunctionDeclaration 与箭头函数/useCallback）
      const scrollFnNode = findFunctionLikeByName(sf, 'handleChatScroll');
      expect(scrollFnNode).not.toBeNull();
      if (scrollFnNode && scrollFnNode.body) {
        const bodyText = scrollFnNode.body.getText(sf);
        expect(bodyText).toContain('distanceFromBottom');
        expect(bodyText).toContain('120');
      }

      // 2) 基于 AST 核查 ChatPane.tsx 中搜索高亮定位 forcedChatMessageId 与渲染窗/虚拟化列表窗口配置
      const fullText = sf.getFullText();
      expect(fullText).toContain('forcedChatMessageId');

      const virtualListTags = new Set([
        ...collectImportAliases(sf, ['FlatList', 'FlashList', 'ScrollView']),
        'FlatList',
        'FlashList',
        'ScrollView',
      ]);
      const msgListContainers = collectJsxElements(sf).filter(
        (el) => virtualListTags.has(el.tagName) && el.attributes.get('onScroll') === '{handleChatScroll}'
      );
      expect(msgListContainers.length).toBe(1);

      const hasWindowOrRenderLimit =
        /\brenderedChatMessages\b/.test(fullText) ||
        msgListContainers.some(
          (el) =>
            el.attributes.has('initialNumToRender') ||
            el.attributes.has('windowSize') ||
            el.attributes.has('maxToRenderPerBatch')
        );
      expect(hasWindowOrRenderLimit).toBe(true);

      // 3) 消息滚动容器必须绑定 onScrollBeginDrag 防止吸底抢手势
      expect(
        msgListContainers[0]?.attributes.has('onScrollBeginDrag'),
        '主消息列表缺少 onScrollBeginDrag 手势保护以解除自动吸底'
      ).toBe(true);
    });

    it('F10-T2-6: installLongTaskCollector 降级边界（无 longtask 时降级 rAF 采样 + 重复安装清理旧监听器）', () => {
      // 1) 无 longtask 支持的浏览器环境降级至 rAF 采样
      const fallbackHarness = createPerfAndRafHarness({
        supportedEntryTypes: ['mark', 'measure'],
      });
      const restoreFallback = fallbackHarness.install();
      try {
        const res = installLongTaskCollector(true);
        expect(res).toEqual({ supported: false, installed: true });
        expect(fallbackHarness.getObserverCreatedCount()).toBe(0);

        fallbackHarness.triggerRaf(10);
        fallbackHarness.triggerRaf(95);
        const stats = readLongTaskStats(true);
        expect(stats.supported).toBe(false);
        expect(stats.count).toBe(0);
        expect(stats.maxRafGapMs).toBe(85);
      } finally {
        restoreFallback();
      }

      // 2) 重复安装必须断开旧 PerformanceObserver 并 cancel 旧 rAF
      const fullHarness = createPerfAndRafHarness({
        supportedEntryTypes: ['longtask'],
      });
      const restoreFull = fullHarness.install();
      try {
        const first = installLongTaskCollector(true);
        expect(first).toEqual({ supported: true, installed: true });
        expect(fullHarness.getDisconnectCalls()).toBe(0);
        expect(fullHarness.getCancelRafCalls()).toBe(0);

        const second = installLongTaskCollector(true);
        expect(second).toEqual({ supported: true, installed: true });
        expect(fullHarness.getDisconnectCalls()).toBe(1);
        expect(fullHarness.getCancelRafCalls()).toBe(1);
      } finally {
        restoreFull();
      }
    });
  });
});
