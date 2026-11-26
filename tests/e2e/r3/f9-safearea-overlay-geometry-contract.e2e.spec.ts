import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

import {
  bindAppDialogHost,
  requestConfirm,
  requestNotice,
  type DialogRequest,
} from '../../../src/ui/components/dialogService';
import {
  coordinateMobileBack,
  type MobileBackActions,
  type MobileBackState,
} from '../../../src/ui/mobile/MobileBackCoordinator';
import {
  buildInjectedWebProbesScript,
  CORE_WEB_INTERACTIVE_TARGETS,
  probeElementGeometryAndOcclusion,
  probeOverlayResidual,
  type GeometryAndOcclusionReport,
  type InteractiveTargetDescriptor,
  type OverlayResidualReport,
} from '../helpers/webGeometryProbes';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..', '..', '..');

function resolveRepoFile(relPath: string): string {
  return path.resolve(REPO_ROOT, relPath);
}

function parseSourceFile(relPath: string): ts.SourceFile {
  const absPath = resolveRepoFile(relPath);
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

function collectCallExpressions(sourceFile: ts.SourceFile, calleeNames: string | readonly string[]): ts.CallExpression[] {
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

function resolveIdentifierInitializer(
  sourceFile: ts.SourceFile,
  identName: string
): ts.Expression | ts.FunctionDeclaration | null {
  let found: ts.Expression | ts.FunctionDeclaration | null = null;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === identName && node.initializer) {
      found = node.initializer;
      return;
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === identName) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function doesKeyboardAvoidingBehaviorTargetAndroid(
  attr: ts.JsxAttribute | undefined,
  sf: ts.SourceFile
): boolean {
  if (!attr || !attr.initializer) return false;

  const isHeightOrPadding = (val: string): boolean => val === 'height' || val === 'padding';

  const checkExpr = (rawExpr: ts.Expression, canReachAndroid: boolean, visited = new Set<string>()): boolean => {
    if (!canReachAndroid) return false;
    const expr = unwrapExpression(rawExpr);

    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
      return isHeightOrPadding(expr.text);
    }

    if (ts.isIdentifier(expr)) {
      if (expr.text === 'undefined' || visited.has(expr.text)) return false;
      visited.add(expr.text);
      const resolved = resolveIdentifierInitializer(sf, expr.text);
      if (resolved && !ts.isFunctionDeclaration(resolved)) {
        return checkExpr(resolved, canReachAndroid, visited);
      }
      return false;
    }

    if (ts.isConditionalExpression(expr)) {
      const condText = expr.condition.getText(sf).replace(/\s+/g, '');
      const isOnlyIos = /Platform\.OS===?['"]ios['"]/.test(condText);
      const isNotIos = /Platform\.OS!==?['"]ios['"]/.test(condText);
      const isOnlyWeb = /Platform\.OS===?['"]web['"]/.test(condText);
      const isOnlyAndroid = /Platform\.OS===?['"]android['"]/.test(condText);
      const isNotAndroid = /Platform\.OS!==?['"]android['"]/.test(condText);

      let trueForAndroid: boolean = canReachAndroid;
      let falseForAndroid: boolean = canReachAndroid;
      if (isOnlyIos || isOnlyWeb) {
        trueForAndroid = false;
      } else if (isOnlyAndroid || isNotIos) {
        falseForAndroid = false;
      } else if (isNotAndroid) {
        trueForAndroid = false;
      }

      return (
        checkExpr(expr.whenTrue, trueForAndroid, visited) ||
        checkExpr(expr.whenFalse, falseForAndroid, visited)
      );
    }

    if (ts.isCallExpression(expr) && expr.expression.getText(sf) === 'Platform.select') {
      const firstArg = expr.arguments[0];
      if (firstArg && ts.isObjectLiteralExpression(firstArg)) {
        const findProp = (key: string): ts.Expression | undefined => {
          for (const prop of firstArg.properties) {
            if (ts.isPropertyAssignment(prop) && prop.name.getText(sf).replace(/['"]/g, '') === key) {
              return prop.initializer;
            }
          }
          return undefined;
        };
        const androidVal = findProp('android') ?? findProp('native') ?? findProp('default');
        if (androidVal) {
          return checkExpr(androidVal, true, visited);
        }
      }
      return false;
    }

    if (ts.isBinaryExpression(expr)) {
      return (
        checkExpr(expr.left, canReachAndroid, visited) ||
        checkExpr(expr.right, canReachAndroid, visited)
      );
    }

    return false;
  };

  if (ts.isStringLiteral(attr.initializer)) {
    return isHeightOrPadding(attr.initializer.text);
  }
  if (ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
    return checkExpr(attr.initializer.expression, true);
  }
  return false;
}

function collectScatteredComposerMenuBooleanStates(sf: ts.SourceFile): string[] {
  const menuStateNames: string[] = [];
  const menuBoolNamePattern =
    /^(?:attach|reasoning|parameter|search|composer)[A-Za-z0-9_]*(?:Menu|Sheet|Popover)?Open$|^(?:is|show)(?:Attach|Reasoning|Parameter|Search)[A-Za-z0-9_]*(?:Menu|Sheet|Open|Visible)?$/i;

  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isArrayBindingPattern(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      const callee = node.initializer.expression.getText(sf);
      if (callee === 'useState' || callee === 'React.useState') {
        const firstArg = node.initializer.arguments[0];
        const isFalseLiteral = firstArg?.kind === ts.SyntaxKind.FalseKeyword;
        const firstElem = node.name.elements[0]?.getText(sf) ?? '';
        if (isFalseLiteral && menuBoolNamePattern.test(firstElem)) {
          menuStateNames.push(firstElem);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return menuStateNames;
}

function evaluateStaticNumericLiteral(node: ts.Expression, sf: ts.SourceFile): number | null {
  const expr = unwrapExpression(node);
  if (ts.isNumericLiteral(expr)) {
    const val = Number(expr.text);
    return Number.isFinite(val) ? val : null;
  }
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.MinusToken) {
    const inner = evaluateStaticNumericLiteral(expr.operand, sf);
    return inner === null ? null : -inner;
  }
  if (ts.isIdentifier(expr)) {
    const resolved = resolveIdentifierInitializer(sf, expr.text);
    if (resolved && !ts.isFunctionDeclaration(resolved)) {
      return evaluateStaticNumericLiteral(resolved, sf);
    }
  }
  return null;
}

function inspectParameterMenuMaxHeightFloor(
  sf: ts.SourceFile
): { found: boolean; maxFloorFound: number; hasZeroMathMax: boolean } {
  let initExpr: ts.Expression | null = null;
  const visitDecl = (node: ts.Node) => {
    if (initExpr) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'parameterMenuMaxHeight' &&
      node.initializer
    ) {
      initExpr = node.initializer;
      return;
    }
    ts.forEachChild(node, visitDecl);
  };
  visitDecl(sf);
  if (!initExpr) {
    return { found: false, maxFloorFound: 0, hasZeroMathMax: false };
  }

  let maxFloorFound = 0;
  let hasZeroMathMax = false;
  const visitedFns = new Set<string>();

  const inspectSubtree = (root: ts.Node) => {
    const walk = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(sf);
        if (callee === 'useMemo') {
          const factory = node.arguments[0];
          if (factory) inspectSubtree(factory);
          return;
        }
        if (callee === 'Math.max') {
          let localMax = -Infinity;
          for (const arg of node.arguments) {
            const num = evaluateStaticNumericLiteral(arg, sf);
            if (num !== null && num > localMax) {
              localMax = num;
            }
          }
          if (localMax === 0) {
            hasZeroMathMax = true;
          }
          if (localMax > maxFloorFound && Number.isFinite(localMax)) {
            maxFloorFound = localMax;
          }
        } else if (/clamp/i.test(callee) && node.arguments.length >= 2) {
          const minNum = evaluateStaticNumericLiteral(node.arguments[1], sf);
          if (minNum !== null && minNum > maxFloorFound) {
            maxFloorFound = minNum;
          }
        } else if (ts.isIdentifier(node.expression) && !visitedFns.has(node.expression.text)) {
          visitedFns.add(node.expression.text);
          const resolved = resolveIdentifierInitializer(sf, node.expression.text);
          if (resolved) inspectSubtree(resolved);
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(root);
  };

  inspectSubtree(initExpr);
  return { found: true, maxFloorFound, hasZeroMathMax };
}

function getNumericStyleProperty(
  obj: ts.ObjectLiteralExpression,
  sf: ts.SourceFile,
  propName: string
): number | null {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && prop.name.getText(sf) === propName) {
      return evaluateStaticNumericLiteral(prop.initializer, sf);
    }
  }
  return null;
}

function findObjectPropertyAssignments(
  sourceFile: ts.SourceFile,
  keyName: string
): ts.ObjectLiteralExpression | null {
  let found: ts.ObjectLiteralExpression | null = null;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(sourceFile) === keyName &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function getStyleObjectPropertyNames(obj: ts.ObjectLiteralExpression, sf: ts.SourceFile): Set<string> {
  const keys = new Set<string>();
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop)) {
      keys.add(prop.name.getText(sf));
    }
  }
  return keys;
}

interface FakeDomRectInput {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface FakeElementConfig {
  tagName: string;
  attrs?: Record<string, string>;
  rect: FakeDomRectInput;
  style?: Partial<{
    display: string;
    visibility: string;
    opacity: string;
    pointerEvents: string;
    position: string;
    zIndex: string;
  }>;
  children?: FakeElementConfig[];
}

interface FakeDomElement {
  tagName: string;
  attributes: Record<string, string>;
  style: {
    display: string;
    visibility: string;
    opacity: string;
    pointerEvents: string;
    position: string;
    zIndex: string;
  };
  rect: DOMRect;
  children: FakeDomElement[];
  getAttribute: (name: string) => string | null;
  getBoundingClientRect: () => DOMRect;
  contains: (other: unknown) => boolean;
}

function createFakeDomElement(config: FakeElementConfig): FakeDomElement {
  const children = (config.children ?? []).map(createFakeDomElement);
  const { left, top, width, height } = config.rect;
  const domRect: DOMRect = {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({ left, top, width, height, right: left + width, bottom: top + height }),
  };

  const el: FakeDomElement = {
    tagName: config.tagName.toUpperCase(),
    attributes: config.attrs ?? {},
    style: {
      display: config.style?.display ?? 'flex',
      visibility: config.style?.visibility ?? 'visible',
      opacity: config.style?.opacity ?? '1',
      pointerEvents: config.style?.pointerEvents ?? 'auto',
      position: config.style?.position ?? 'relative',
      zIndex: config.style?.zIndex ?? 'auto',
    },
    rect: domRect,
    children,
    getAttribute: (name: string) =>
      Object.prototype.hasOwnProperty.call(el.attributes, name) ? el.attributes[name] : null,
    getBoundingClientRect: () => el.rect,
    contains: (other: unknown): boolean => {
      if (other === el) return true;
      return el.children.some((child) => child.contains(other));
    },
  };
  return el;
}

function matchesSimpleSelector(el: FakeDomElement, selector: string): boolean {
  if (selector === '*') return true;
  // 支持形如 `[data-testid="foo"]`、`textarea[aria-label="..."]`、`[aria-label="..."]`、`[placeholder*="..."]`
  const tagMatch = /^([a-zA-Z0-9_-]+)/.exec(selector);
  if (tagMatch && el.tagName.toLowerCase() !== tagMatch[1].toLowerCase()) {
    return false;
  }

  const attrPattern = /\[([a-zA-Z0-9_-]+)(\*)?="([^"]+)"\]/g;
  let match: RegExpExecArray | null = attrPattern.exec(selector);
  let hasAttrConstraint = false;
  while (match) {
    hasAttrConstraint = true;
    const [, attrName, wildcard, expectedVal] = match;
    const actualVal = el.getAttribute(attrName);
    if (actualVal === null) return false;
    if (wildcard === '*') {
      if (!actualVal.includes(expectedVal)) return false;
    } else if (actualVal !== expectedVal) {
      return false;
    }
    match = attrPattern.exec(selector);
  }
  return Boolean(tagMatch || hasAttrConstraint);
}

function flattenFakeDom(roots: FakeDomElement[]): FakeDomElement[] {
  const list: FakeDomElement[] = [];
  const walk = (node: FakeDomElement) => {
    list.push(node);
    for (const child of node.children) walk(child);
  };
  for (const root of roots) walk(root);
  return list;
}

function createFakeBrowserGlobals(
  viewport: { width: number; height: number },
  elements: FakeDomElement[]
): {
  fakeWindow: Record<string, unknown>;
  fakeDocument: Record<string, unknown>;
  installOnGlobal: () => () => void;
} {
  const allNodes = flattenFakeDom(elements);
  const documentElement = createFakeDomElement({
    tagName: 'html',
    rect: { left: 0, top: 0, width: viewport.width, height: viewport.height },
  });
  const body = createFakeDomElement({
    tagName: 'body',
    rect: { left: 0, top: 0, width: viewport.width, height: viewport.height },
  });

  const fakeDocument: Record<string, unknown> = {
    documentElement,
    body,
    querySelector: (selector: string) =>
      allNodes.find((el) => matchesSimpleSelector(el, selector)) ?? null,
    querySelectorAll: (selector: string) => {
      if (selector === '*') {
        return [documentElement, body, ...allNodes];
      }
      return allNodes.filter((el) => matchesSimpleSelector(el, selector));
    },
    elementFromPoint: (x: number, y: number) => {
      // 按最高 zIndex 与后序 DOM 顺序进行 hit-testing（跳过 pointerEvents: none 及不可见元素）
      const candidates = allNodes
        .map((el, domOrder) => ({ el, domOrder }))
        .filter(({ el }) => {
          if (
            el.style.display === 'none' ||
            el.style.visibility === 'hidden' ||
            el.style.pointerEvents === 'none'
          ) {
            return false;
          }
          const r = el.getBoundingClientRect();
          return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
        })
        .sort((a, b) => {
          const za = Number.parseInt(a.el.style.zIndex, 10);
          const zb = Number.parseInt(b.el.style.zIndex, 10);
          const zDiff = (Number.isFinite(zb) ? zb : 0) - (Number.isFinite(za) ? za : 0);
          return zDiff !== 0 ? zDiff : b.domOrder - a.domOrder;
        });
      return candidates[0]?.el ?? body;
    },
  };

  const fakeWindow: Record<string, unknown> = {
    innerWidth: viewport.width,
    innerHeight: viewport.height,
    getComputedStyle: (el: FakeDomElement) => el.style,
  };

  const installOnGlobal = (): (() => void) => {
    const prevWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const prevDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');

    Object.defineProperty(globalThis, 'window', {
      value: fakeWindow,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'document', {
      value: fakeDocument,
      configurable: true,
      writable: true,
    });

    return () => {
      if (prevWindow) {
        Object.defineProperty(globalThis, 'window', prevWindow);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
      if (prevDocument) {
        Object.defineProperty(globalThis, 'document', prevDocument);
      } else {
        Reflect.deleteProperty(globalThis, 'document');
      }
    };
  };

  return { fakeWindow, fakeDocument, installOnGlobal };
}

function createCoreInteractiveDomSet(viewport: { width: number; height: number }): FakeDomElement[] {
  const topY = 8;
  const composerTop = viewport.height - 120;
  const tabBarTop = viewport.height - 56;
  return [
    createFakeDomElement({
      tagName: 'div',
      attrs: { 'data-testid': 'drawer-trigger', role: 'button', 'aria-label': '打开聊天记录' },
      rect: { left: 12, top: topY, width: 36, height: 36 },
    }),
    createFakeDomElement({
      tagName: 'div',
      attrs: { 'data-testid': 'model-picker-trigger', role: 'button' },
      rect: { left: 60, top: topY, width: 140, height: 36 },
    }),
    createFakeDomElement({
      tagName: 'div',
      attrs: { 'data-testid': 'chat-export-button', role: 'button', 'aria-label': '导出当前对话' },
      rect: { left: viewport.width - 144, top: topY, width: 36, height: 36 },
    }),
    createFakeDomElement({
      tagName: 'div',
      attrs: { 'data-testid': 'workbench-trigger', role: 'button', 'aria-label': '打开本地成果工作台' },
      rect: { left: viewport.width - 96, top: topY, width: 36, height: 36 },
    }),
    createFakeDomElement({
      tagName: 'div',
      attrs: { 'data-testid': 'settings-trigger', role: 'button', 'aria-label': '打开设置' },
      rect: { left: viewport.width - 48, top: topY, width: 36, height: 36 },
    }),
    createFakeDomElement({
      tagName: 'div',
      attrs: { 'data-testid': 'composer-search-globe', role: 'button' },
      rect: { left: 16, top: composerTop + 6, width: 32, height: 32 },
    }),
    createFakeDomElement({
      tagName: 'textarea',
      attrs: { 'data-testid': 'composer-input', 'aria-label': '消息输入框' },
      rect: { left: 56, top: composerTop, width: Math.max(120, viewport.width - 120), height: 48 },
    }),
    createFakeDomElement({
      tagName: 'div',
      attrs: { 'data-testid': 'composer-send-button', role: 'button', 'aria-label': '发送消息' },
      rect: { left: viewport.width - 52, top: composerTop + 4, width: 38, height: 38 },
    }),
    createFakeDomElement({
      tagName: 'div',
      attrs: { 'data-testid': 'main-workspace-tab-bar', role: 'tablist' },
      rect: { left: 0, top: tabBarTop, width: viewport.width, height: 52 },
    }),
  ];
}

describe('F9: 全端安全区、键盘避让、单队列 Overlay 与几何无遮挡 E2E', () => {
  const restoreCallbacks: Array<() => void> = [];

  afterEach(() => {
    bindAppDialogHost(null);
    while (restoreCallbacks.length > 0) {
      const restore = restoreCallbacks.pop();
      restore?.();
    }
  });

  describe('Tier 1 — 核心布局、Overlay 队列与多视口几何正常路径', () => {
    it('F9-T1-1: Android 键盘避让单一化（app.json resize 且 ChatPane 不再叠加 height/padding）', () => {
      const appJson = JSON.parse(
        fs.readFileSync(resolveRepoFile('app.json'), 'utf8')
      ) as { expo?: { android?: { softwareKeyboardLayoutMode?: string } } };
      expect(appJson.expo?.android?.softwareKeyboardLayoutMode).toBe('resize');

      const chatPaneSf = parseSourceFile('src/features/chat/ChatPane.tsx');
      const kavTags = collectImportAliases(chatPaneSf, ['KeyboardAvoidingView']);
      kavTags.add('KeyboardAvoidingView');
      const kavElements = collectJsxElements(chatPaneSf).filter((el) => kavTags.has(el.tagName));
      expect(kavElements.length).toBeGreaterThanOrEqual(1);

      for (const kav of kavElements) {
        const behaviorAttr = kav.attributeNodes.get('behavior');
        const behaviorExpr = kav.attributes.get('behavior') ?? '';
        // 在 Android resize 模式下，behavior AST 不得在 Android 分支返回 'height' 或 'padding'，防止双重挤压
        const setsAndroidHeightOrPadding = doesKeyboardAvoidingBehaviorTargetAndroid(
          behaviorAttr,
          chatPaneSf
        );
        expect(
          setsAndroidHeightOrPadding,
          `ChatPane KeyboardAvoidingView 仍存在 Android 双重避让 behavior=${behaviorExpr}`
        ).toBe(false);
      }
    });

    it('F9-T1-2: Android 键盘弹出自动隐藏 MainWorkspaceTabBar 与 Web 100dvh 视口适配契约', () => {
      const chatPaneSf = parseSourceFile('src/features/chat/ChatPane.tsx');
      const keyboardListeners = collectCallExpressions(chatPaneSf, 'Keyboard.addListener');
      const listenedEvents = keyboardListeners.map(
        (call) => call.arguments[0]?.getText(chatPaneSf) ?? ''
      );
      expect(
        listenedEvents.some((arg) => arg.includes('keyboardDidShow') || arg.includes('keyboardWillShow')),
        'ChatPane.tsx 须监听 Keyboard.addListener 键盘弹出事件以隐藏底部 TabBar'
      ).toBe(true);
      expect(
        listenedEvents.some((arg) => arg.includes('keyboardDidHide') || arg.includes('keyboardWillHide')),
        'ChatPane.tsx 须监听 Keyboard.addListener 键盘收起事件以恢复底部 TabBar'
      ).toBe(true);

      // 验证 MainWorkspaceTabBar 的渲染祖先条件（三元 / && 短路）或 hidden/visible 属性包含键盘隐藏条件
      const tabBarTags = collectImportAliases(chatPaneSf, ['MainWorkspaceTabBar']);
      tabBarTags.add('MainWorkspaceTabBar');
      const tabBarElements = collectJsxElements(chatPaneSf).filter((el) =>
        tabBarTags.has(el.tagName)
      );
      expect(tabBarElements.length).toBe(1);

      const conditionCandidates: string[] = [];
      const collectExprIdentifiers = (expr: ts.Expression) => {
        const walk = (n: ts.Node) => {
          if (ts.isIdentifier(n)) {
            const init = resolveIdentifierInitializer(chatPaneSf, n.text);
            if (init && !ts.isFunctionDeclaration(init)) {
              conditionCandidates.push(init.getText(chatPaneSf));
            }
          }
          ts.forEachChild(n, walk);
        };
        walk(expr);
      };

      for (const propName of ['hidden', 'visible', 'keyboardVisible', 'isKeyboardVisible']) {
        const attrNode = tabBarElements[0].attributeNodes.get(propName);
        if (attrNode?.initializer && ts.isJsxExpression(attrNode.initializer) && attrNode.initializer.expression) {
          conditionCandidates.push(attrNode.initializer.expression.getText(chatPaneSf));
          collectExprIdentifiers(attrNode.initializer.expression);
        }
      }

      let curr: ts.Node | undefined = tabBarElements[0].node.parent;
      while (curr) {
        if (ts.isConditionalExpression(curr)) {
          conditionCandidates.push(curr.condition.getText(chatPaneSf));
          collectExprIdentifiers(curr.condition);
        } else if (
          ts.isBinaryExpression(curr) &&
          curr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        ) {
          conditionCandidates.push(curr.left.getText(chatPaneSf));
          collectExprIdentifiers(curr.left);
        }
        curr = curr.parent;
      }

      const hasKeyboardHideControl = conditionCandidates.some((text) => /keyboard/i.test(text));
      expect(
        hasKeyboardHideControl,
        `MainWorkspaceTabBar 渲染条件或隐藏属性 [${conditionCandidates.join(' | ')}] 须结合键盘状态在弹出时隐藏`
      ).toBe(true);

      // 验证 chatPaneStyles.ts 已适配 Web 100dvh 视口约束
      const stylesSf = parseSourceFile('src/features/chat/chatPaneStyles.ts');
      let has100Dvh = false;
      const visitStyle = (node: ts.Node) => {
        if (ts.isStringLiteral(node) && node.text.includes('100dvh')) {
          has100Dvh = true;
        }
        ts.forEachChild(node, visitStyle);
      };
      visitStyle(stylesSf);
      expect(
        has100Dvh,
        'chatPaneStyles.ts 须包含 100dvh 视口约束以防止 Web 移动端软键盘挤压裁切'
      ).toBe(true);
    });

    it('F9-T1-3: 单源 useSafeAreaInsets() 布局契约（根部 SafeAreaProvider，业务屏与弹窗不嵌套 SafeAreaView）', () => {
      const mobileShellSf = parseSourceFile('src/ui/mobile/MobileShell.tsx');
      const providerTags = collectImportAliases(mobileShellSf, ['SafeAreaProvider']);
      providerTags.add('SafeAreaProvider');
      const rootProviders = collectJsxElements(mobileShellSf).filter((el) =>
        providerTags.has(el.tagName)
      );
      expect(rootProviders.length).toBe(1);

      const nestedSafeAreaTargets = [
        'src/features/chat/ChatPane.tsx',
        'src/components/McpApprovalModal.tsx',
        'src/components/ContextInspectorModal.tsx',
        'src/components/WorkspaceWorkbench.tsx',
        'src/components/KnowledgeImportPreview.tsx',
        'src/features/settings/FirstRunSetupWizard.tsx',
      ];

      const violations: string[] = [];
      for (const relPath of nestedSafeAreaTargets) {
        const sf = parseSourceFile(relPath);
        const safeAreaTags = collectImportAliases(sf, ['SafeAreaView']);
        safeAreaTags.add('SafeAreaView');
        const safeViews = collectJsxElements(sf).filter((el) => safeAreaTags.has(el.tagName));
        if (safeViews.length > 0) {
          violations.push(`${relPath} (存在 ${safeViews.length} 处嵌套 <SafeAreaView>)`);
        }
      }
      expect(
        violations,
        `以下屏幕/弹窗仍嵌套 <SafeAreaView>（与根 SafeAreaProvider 或 insets.bottom 叠加）: ${violations.join(', ')}`
      ).toEqual([]);

      // 设置主屏、工具面板屏及 WorkspaceHub (MainWorkspaceTabBar) 须消费 useSafeAreaInsets() 而非硬编码边距
      for (const screenPath of [
        'src/ui/screens/settings/SettingsMainScreen.tsx',
        'src/ui/screens/settings/ToolsPanelScreen.tsx',
        'src/ui/mobile/WorkspaceHub.tsx',
      ]) {
        const sf = parseSourceFile(screenPath);
        const insetCalleeAliases = Array.from(collectImportAliases(sf, ['useSafeAreaInsets']));
        if (!insetCalleeAliases.includes('useSafeAreaInsets')) {
          insetCalleeAliases.push('useSafeAreaInsets');
        }
        const insetCalls = collectCallExpressions(sf, insetCalleeAliases);
        expect(
          insetCalls.length,
          `${screenPath} 须使用 useSafeAreaInsets() 替代硬编码安全区边距`
        ).toBeGreaterThanOrEqual(1);
      }
    });

    it('F9-T1-4: AppDialogHost / dialogService 单队列 FIFO 串行调度与 Promise 正常结算', async () => {
      const presentedHistory: string[] = [];
      let currentRequest: DialogRequest | null = null;
      bindAppDialogHost((req) => {
        currentRequest = req;
        if (req) presentedHistory.push(`${req.kind}:${req.title}`);
      });

      const p1 = requestConfirm({ title: '确认 1', description: '删除项目' });
      const p2 = requestNotice({ title: '通知 2', description: '操作完成' });
      const p3 = requestConfirm({ title: '确认 3', description: '清空缓存' });

      // 队列同一时刻仅激活第 1 个弹窗
      expect(presentedHistory).toEqual(['confirm:确认 1']);
      const firstReq = currentRequest as DialogRequest | null;
      if (!firstReq || firstReq.kind !== 'confirm') {
        throw new Error('Expected first active request to be confirm.');
      }
      firstReq.resolve(true);
      await expect(p1).resolves.toBe(true);

      // 第 1 个结算后自动弹出第 2 个
      expect(presentedHistory).toEqual(['confirm:确认 1', 'notice:通知 2']);
      const secondReq = currentRequest as DialogRequest | null;
      if (!secondReq || secondReq.kind !== 'notice') {
        throw new Error('Expected second active request to be notice.');
      }
      secondReq.resolve();
      await expect(p2).resolves.toBeUndefined();

      // 第 2 个结算后自动弹出第 3 个
      expect(presentedHistory).toEqual(['confirm:确认 1', 'notice:通知 2', 'confirm:确认 3']);
      const thirdReq = currentRequest as DialogRequest | null;
      if (!thirdReq || thirdReq.kind !== 'confirm') {
        throw new Error('Expected third active request to be confirm.');
      }
      thirdReq.resolve(false);
      await expect(p3).resolves.toBe(false);
      expect(currentRequest).toBeNull();
    });

    it('F9-T1-5: Composer 浮层互斥切换与 webGeometryProbes 多视口（360x640/390x844/844x390）无遮挡校验', () => {
      // 1) 验证 ChatPane 点击 composer-search-globe 具备互斥/统一菜单状态切换逻辑（兼容多 boolean 互关与单枚举收敛）
      const chatPaneSf = parseSourceFile('src/features/chat/ChatPane.tsx');
      const searchGlobeBtn = collectJsxElements(chatPaneSf).find(
        (el) => el.attributes.get('testID') === '"composer-search-globe"'
      );
      expect(searchGlobeBtn).toBeDefined();
      const onPressAttr = searchGlobeBtn?.attributeNodes.get('onPress');
      expect(onPressAttr, 'composer-search-globe 缺少 onPress 处理函数').toBeDefined();

      let onPressBodyText = onPressAttr?.initializer?.getText(chatPaneSf) ?? '';
      if (
        onPressAttr?.initializer &&
        ts.isJsxExpression(onPressAttr.initializer) &&
        onPressAttr.initializer.expression
      ) {
        const expr = unwrapExpression(onPressAttr.initializer.expression);
        if (ts.isIdentifier(expr)) {
          const resolved = resolveIdentifierInitializer(chatPaneSf, expr.text);
          if (resolved) {
            onPressBodyText = resolved.getText(chatPaneSf);
          }
        }
      }
      expect(onPressBodyText.trim().length).toBeGreaterThan(0);

      const scatteredBooleans = collectScatteredComposerMenuBooleanStates(chatPaneSf);
      if (scatteredBooleans.length >= 2) {
        // 尚存多个独立 boolean 状态时，点击搜索菜单须显式关闭其他菜单（false）
        expect(onPressBodyText).toContain('false');
      } else {
        // 已收敛为单一枚举状态时，须调用统一菜单状态切换/设置逻辑且不得同时开启多个菜单
        const hasUnifiedMenuToggle =
          /(?:set|toggle|open|select|switch)[A-Za-z0-9_]*\s*\(/.test(onPressBodyText);
        expect(
          hasUnifiedMenuToggle,
          `composer-search-globe onPress (${onPressBodyText}) 须调用统一枚举菜单切换逻辑`
        ).toBe(true);
        const trueCount = (onPressBodyText.match(/\(true\)/g) ?? []).length;
        expect(trueCount).toBeLessThanOrEqual(1);
      }

      // 2) 在 3 个标准端视口运行真实 probeElementGeometryAndOcclusion 与 probeOverlayResidual
      const viewports = [
        { width: 360, height: 640 },
        { width: 390, height: 844 },
        { width: 844, height: 390 },
      ];

      for (const vp of viewports) {
        const dom = createCoreInteractiveDomSet(vp);
        const browser = createFakeBrowserGlobals(vp, dom);
        const restore = browser.installOnGlobal();
        try {
          const geoReport = probeElementGeometryAndOcclusion(CORE_WEB_INTERACTIVE_TARGETS);
          expect(geoReport.viewport).toEqual(vp);
          expect(geoReport.failures).toEqual([]);
          expect(geoReport.overlaps).toEqual([]);
          expect(geoReport.items.every((item) => item.found && item.clickable)).toBe(true);

          const residualReport = probeOverlayResidual();
          expect(residualReport.hasBlockingOverlay).toBe(false);
          expect(residualReport.residuals).toEqual([]);
        } finally {
          restore();
        }
      }
    });

    it('F9-T1-6: MobileBackCoordinator 按严格优先级顺序逐级关闭 Overlay 并在空闲时返回 false', () => {
      const closedSequence: string[] = [];
      const state: MobileBackState = {
        contextInspectorOpen: true,
        workbenchOpen: true,
        costDecisionOpen: true,
        mcpDecisionOpen: true,
        moveDialogOpen: true,
        renameDialogOpen: true,
        deleteConversationDialogOpen: true,
        deleteProviderDialogOpen: true,
        modelPickerOpen: true,
        projectDrawerOpen: true,
        settingsOpen: true,
        chatTransientOpen: true,
      };

      const actions: MobileBackActions = {
        closeContextInspector: () => {
          state.contextInspectorOpen = false;
          closedSequence.push('contextInspector');
        },
        closeWorkbench: () => {
          state.workbenchOpen = false;
          closedSequence.push('workbench');
        },
        cancelCostDecision: () => {
          state.costDecisionOpen = false;
          closedSequence.push('costDecision');
        },
        cancelMcpDecision: () => {
          state.mcpDecisionOpen = false;
          closedSequence.push('mcpDecision');
        },
        closeMoveDialog: () => {
          state.moveDialogOpen = false;
          closedSequence.push('moveDialog');
        },
        closeRenameDialog: () => {
          state.renameDialogOpen = false;
          closedSequence.push('renameDialog');
        },
        closeDeleteConversationDialog: () => {
          state.deleteConversationDialogOpen = false;
          closedSequence.push('deleteConversationDialog');
        },
        closeDeleteProviderDialog: () => {
          state.deleteProviderDialogOpen = false;
          closedSequence.push('deleteProviderDialog');
        },
        closeModelPicker: () => {
          state.modelPickerOpen = false;
          closedSequence.push('modelPicker');
        },
        closeProjectDrawer: () => {
          state.projectDrawerOpen = false;
          closedSequence.push('projectDrawer');
        },
        settingsBack: () => {
          state.settingsOpen = false;
          closedSequence.push('settings');
          return true;
        },
        closeChatTransients: () => {
          state.chatTransientOpen = false;
          closedSequence.push('chatTransients');
        },
      };

      for (let step = 0; step < 12; step += 1) {
        expect(coordinateMobileBack(state, actions)).toBe(true);
      }
      expect(closedSequence).toEqual([
        'contextInspector',
        'workbench',
        'costDecision',
        'mcpDecision',
        'moveDialog',
        'renameDialog',
        'deleteConversationDialog',
        'deleteProviderDialog',
        'modelPicker',
        'projectDrawer',
        'settings',
        'chatTransients',
      ]);

      // 全部 Overlay 关闭后应透传给系统默认返回（false）
      expect(coordinateMobileBack(state, actions)).toBe(false);
    });
  });

  describe('Tier 2 — 遮挡边界、枚举塌缩与探针容错异常路径', () => {
    it('F9-T2-1: 业务组件禁止并发堆叠独立原生 <Modal>，统一经 AppDialogHost/dialogService 队列调度', () => {
      const dialogServiceSf = parseSourceFile('src/ui/components/dialogService.ts');
      const unifiedQueueNames = new Set([
        'showModalSheet',
        'requestModalSheet',
        'showConfirmDialog',
        'enqueueModalSheet',
        'presentModalSheet',
      ]);
      const exportedNames = new Set<string>();
      for (const stmt of dialogServiceSf.statements) {
        const hasExport = ts.canHaveModifiers(stmt)
          ? Boolean(ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
          : false;
        if (ts.isFunctionDeclaration(stmt) && hasExport && stmt.name) {
          exportedNames.add(stmt.name.text);
        } else if (ts.isVariableStatement(stmt) && hasExport) {
          for (const decl of stmt.declarationList.declarations) {
            if (ts.isIdentifier(decl.name)) {
              exportedNames.add(decl.name.text);
            }
          }
        } else if (
          ts.isExportDeclaration(stmt) &&
          stmt.exportClause &&
          ts.isNamedExports(stmt.exportClause)
        ) {
          for (const spec of stmt.exportClause.elements) {
            exportedNames.add(spec.name.text);
          }
        }
      }
      const hasUnifiedModalQueue = Array.from(unifiedQueueNames).some((name) =>
        exportedNames.has(name)
      );

      const modalFiles = [
        'src/features/chat/ChatPane.tsx',
        'src/features/projects/ProjectDrawerShell.tsx',
        'src/components/McpApprovalModal.tsx',
        'src/components/ContextInspectorModal.tsx',
        'src/components/KnowledgeImportPreview.tsx',
        'src/ui/components/SearchServicesPanel.tsx',
        'src/features/settings/FirstRunSetupWizard.tsx',
        'src/features/share/IncomingShareSheet.tsx',
      ];

      let rawModalCount = 0;
      const modalLocations: string[] = [];
      for (const relPath of modalFiles) {
        const sf = parseSourceFile(relPath);
        const modalTags = collectImportAliases(sf, ['Modal']);
        modalTags.add('Modal');
        const modals = collectJsxElements(sf).filter((el) => modalTags.has(el.tagName));
        if (modals.length > 0) {
          rawModalCount += modals.length;
          modalLocations.push(`${relPath}(${modals.length})`);
        }
      }

      expect(
        hasUnifiedModalQueue,
        'dialogService.ts 须提供统一 Modal/Sheet 队列入口（如 showModalSheet/showConfirmDialog）以防止并发 Modal 死锁'
      ).toBe(true);
      expect(
        rawModalCount,
        `业务组件仍存在 ${rawModalCount} 处分散独立原生 <Modal> [${modalLocations.join(', ')}]，应收敛至统一 Overlay 队列宿主`
      ).toBeLessThanOrEqual(1);
    });

    it('F9-T2-2: Composer 统一浮层枚举（含搜索）、小 composerLayoutY 高度不塌缩及 Android elevation 契约', () => {
      const chatPaneSf = parseSourceFile('src/features/chat/ChatPane.tsx');

      // 1) 不得保留 >= 2 个散落的独立菜单开关 boolean useState(false)（含改名绕过）
      const scatteredOpenStates = collectScatteredComposerMenuBooleanStates(chatPaneSf);
      expect(
        scatteredOpenStates.length,
        `Composer 浮层状态仍分散为 ${scatteredOpenStates.length} 个独立 boolean [${scatteredOpenStates.join(', ')}]，应统一为单一枚举状态`
      ).toBeLessThanOrEqual(1);

      // 2) parameterMenuMaxHeight 须基于 AST 校验正数下限夹紧（如 Math.max(120, ...) / clamp），拒绝 Math.max(0, ...) 无保底塌缩
      const floorInfo = inspectParameterMenuMaxHeightFloor(chatPaneSf);
      expect(floorInfo.found, 'ChatPane.tsx 须定义 parameterMenuMaxHeight').toBe(true);
      expect(
        floorInfo.maxFloorFound,
        `parameterMenuMaxHeight 缺少 >= 100 的正数最小可用高度下限保底（当前检测到最大静态下限为 ${floorInfo.maxFloorFound}，hasZeroMathMax=${String(floorInfo.hasZeroMathMax)}）`
      ).toBeGreaterThanOrEqual(100);

      // 3) 样式表中实际浮层菜单须同时具备正值 zIndex 与 elevation，且输入容器层级高于背景遮罩
      const stylesSf = parseSourceFile('src/features/chat/chatPaneStyles.ts');
      for (const styleKey of ['attachMenu', 'reasoningMenu', 'parameterMenu']) {
        const obj = findObjectPropertyAssignments(stylesSf, styleKey);
        expect(obj, `chatPaneStyles.ts 缺少样式块 ${styleKey}`).not.toBeNull();
        if (!obj) continue;
        const propNames = getStyleObjectPropertyNames(obj, stylesSf);
        const zIndexVal = getNumericStyleProperty(obj, stylesSf, 'zIndex');
        const elevationVal = getNumericStyleProperty(obj, stylesSf, 'elevation');
        expect(
          propNames.has('zIndex') &&
            propNames.has('elevation') &&
            (zIndexVal === null || zIndexVal > 0) &&
            (elevationVal === null || elevationVal > 0),
          `chatPaneStyles.${styleKey} 须同时配置正值 zIndex 与 elevation（当前 keys: ${Array.from(propNames).join(', ')}）`
        ).toBe(true);
      }

      const backdropObj = findObjectPropertyAssignments(stylesSf, 'attachMenuBackdrop');
      const wrapperObj = findObjectPropertyAssignments(stylesSf, 'composerWrapper');
      if (backdropObj && wrapperObj) {
        const backdropZ = getNumericStyleProperty(backdropObj, stylesSf, 'zIndex');
        const wrapperZ = getNumericStyleProperty(wrapperObj, stylesSf, 'zIndex');
        if (backdropZ !== null && wrapperZ !== null) {
          expect(
            wrapperZ,
            `composerWrapper.zIndex (${wrapperZ}) 须高于 attachMenuBackdrop.zIndex (${backdropZ})`
          ).toBeGreaterThan(backdropZ);
        }
      }
    });

    it('F9-T2-3: elementFromPoint 透明残余遮罩（opacity: 0, pointerEvents: auto）精准检出与穿透解除', () => {
      const vp = { width: 390, height: 844 };
      const scrim = createFakeDomElement({
        tagName: 'div',
        attrs: { 'data-testid': 'drawer-scrim', role: 'dialog' },
        rect: { left: 0, top: 0, width: vp.width, height: vp.height },
        style: {
          position: 'fixed',
          zIndex: '30',
          opacity: '0',
          pointerEvents: 'auto',
        },
      });
      const dom = [...createCoreInteractiveDomSet(vp), scrim];
      const browser = createFakeBrowserGlobals(vp, dom);
      const restore = browser.installOnGlobal();
      restoreCallbacks.push(restore);

      // 当透明 scrim 仍接收点击时，所有核心热区应被 elementFromPoint 捕获遮挡
      const blockedReport = probeElementGeometryAndOcclusion(CORE_WEB_INTERACTIVE_TARGETS);
      const inputItem = blockedReport.items.find((i) => i.key === 'composerInput');
      const sendItem = blockedReport.items.find((i) => i.key === 'sendOrStopButton');
      expect(inputItem?.occluded).toBe(true);
      expect(inputItem?.clickable).toBe(false);
      expect(inputItem?.occlusionDetail?.hitTestId).toBe('drawer-scrim');
      expect(sendItem?.occluded).toBe(true);

      const residualBlocked = probeOverlayResidual();
      expect(residualBlocked.hasBlockingOverlay).toBe(true);
      expect(residualBlocked.residuals[0]?.testId).toBe('drawer-scrim');

      // 切换为 pointerEvents: 'none' 后点击穿透且无阻挡遮罩残留
      scrim.style.pointerEvents = 'none';
      const unblockedReport = probeElementGeometryAndOcclusion(CORE_WEB_INTERACTIVE_TARGETS);
      expect(unblockedReport.failures).toEqual([]);
      expect(unblockedReport.items.every((i) => i.clickable)).toBe(true);
      expect(probeOverlayResidual().hasBlockingOverlay).toBe(false);

      // position: fixed + zIndex: 'auto' 的全视口透明阻塞层同样必须被检出
      scrim.style.zIndex = 'auto';
      scrim.style.pointerEvents = 'auto';
      scrim.style.opacity = '0';
      const autoZResidual = probeOverlayResidual();
      expect(autoZResidual.hasBlockingOverlay).toBe(true);
      expect(autoZResidual.residuals[0]?.testId).toBe('drawer-scrim');
    });

    it('F9-T2-4: 视口越界 ±1px 容差边界与 844x390 横屏 TabBar/Composer 矩形重叠精确计算', () => {
      // 1) ±1px 容差测试（360x640）
      const vpNarrow = { width: 360, height: 640 };
      const domNarrow = createCoreInteractiveDomSet(vpNarrow);
      const modelPicker = domNarrow.find((el) => el.getAttribute('data-testid') === 'model-picker-trigger');
      const settingsBtn = domNarrow.find((el) => el.getAttribute('data-testid') === 'settings-trigger');
      if (!modelPicker || !settingsBtn) throw new Error('Expected test elements.');

      // 恰好超出 +1px：容差放行
      settingsBtn.rect = {
        ...settingsBtn.rect,
        left: 325,
        right: 361,
        width: 36,
      };
      const browser1 = createFakeBrowserGlobals(vpNarrow, domNarrow);
      const restore1 = browser1.installOnGlobal();
      try {
        const reportPass = probeElementGeometryAndOcclusion(CORE_WEB_INTERACTIVE_TARGETS);
        const settingsItem = reportPass.items.find((i) => i.key === 'settingsTrigger');
        expect(settingsItem?.outOfViewport).toBe(false);
      } finally {
        restore1();
      }

      // 超出 +2px 与左边界 -2px：必须检出 outOfViewport
      settingsBtn.rect = { ...settingsBtn.rect, left: 326, right: 362, width: 36 };
      modelPicker.rect = { ...modelPicker.rect, left: -2, right: 138, width: 140 };
      const browser2 = createFakeBrowserGlobals(vpNarrow, domNarrow);
      const restore2 = browser2.installOnGlobal();
      try {
        const reportOut = probeElementGeometryAndOcclusion(CORE_WEB_INTERACTIVE_TARGETS);
        expect(reportOut.items.find((i) => i.key === 'settingsTrigger')?.outOfViewport).toBe(true);
        expect(reportOut.items.find((i) => i.key === 'modelPickerTrigger')?.outOfViewport).toBe(true);
        expect(reportOut.failures.length).toBeGreaterThanOrEqual(2);
      } finally {
        restore2();
      }

      // 2) 横屏 844x390 下 TabBar 与 Composer 重叠检出
      const vpLandscape = { width: 844, height: 390 };
      const domLandscape = createCoreInteractiveDomSet(vpLandscape);
      const composer = domLandscape.find((el) => el.getAttribute('data-testid') === 'composer-input');
      const tabBar = domLandscape.find((el) => el.getAttribute('data-testid') === 'main-workspace-tab-bar');
      if (!composer || !tabBar) throw new Error('Expected composer and tabBar.');

      // 令 composer 底部与 tabBar 顶部重叠 12px（宽 300px）
      composer.rect = {
        ...composer.rect,
        left: 100,
        right: 400,
        width: 300,
        top: vpLandscape.height - 96,
        bottom: vpLandscape.height - 44,
        height: 52,
      };
      tabBar.rect = {
        ...tabBar.rect,
        left: 0,
        right: 844,
        width: 844,
        top: vpLandscape.height - 56,
        bottom: vpLandscape.height - 4,
        height: 52,
      };

      const browser3 = createFakeBrowserGlobals(vpLandscape, domLandscape);
      const restore3 = browser3.installOnGlobal();
      try {
        const reportOverlap = probeElementGeometryAndOcclusion(CORE_WEB_INTERACTIVE_TARGETS);
        const overlap = reportOverlap.overlaps.find(
          (o) =>
            (o.firstKey === 'composerInput' && o.secondKey === 'tabBar') ||
            (o.firstKey === 'tabBar' && o.secondKey === 'composerInput')
        );
        expect(overlap).toBeDefined();
        expect(overlap?.intersectionHeight).toBe(12);
        expect(overlap?.intersectionArea).toBe(3600);
      } finally {
        restore3();
      }
    });

    it('F9-T2-5: dialogService 边界安全（无 Host fail-closed、中途卸载清空队列、重复 resolve 幂等）', async () => {
      // 1) 未挂载 Host 时 fail-closed 立即结算
      bindAppDialogHost(null);
      await expect(
        requestConfirm({ title: '无宿主确认', description: '不应挂起' })
      ).resolves.toBe(false);
      await expect(
        requestNotice({ title: '无宿主通知', description: '立即完成' })
      ).resolves.toBeUndefined();

      // 2) Host 挂载期间入队多个请求后突然卸载 Host，所有未决 Promise 必须全部安全结算
      let activeReq: DialogRequest | null = null;
      bindAppDialogHost((req) => {
        activeReq = req;
      });
      const pFirst = requestConfirm({ title: '中途卸载 1', description: 'desc' });
      const pSecond = requestConfirm({ title: '中途卸载 2', description: 'desc' });
      const pThird = requestNotice({ title: '中途卸载 3', description: 'desc' });
      expect(activeReq).not.toBeNull();

      bindAppDialogHost(null);
      await expect(pFirst).resolves.toBe(false);
      await expect(pSecond).resolves.toBe(false);
      await expect(pThird).resolves.toBeUndefined();

      // 3) 重复触发第 1 个弹窗 resolve 多次，不得误关排在后面的第 2 个弹窗
      let latestReq: DialogRequest | null = null;
      bindAppDialogHost((req) => {
        latestReq = req;
      });
      const q1 = requestConfirm({ title: '幂等 1', description: 'd1' });
      const q2 = requestConfirm({ title: '幂等 2', description: 'd2' });

      const firstHandle = latestReq as DialogRequest | null;
      if (!firstHandle || firstHandle.kind !== 'confirm') {
        throw new Error('Expected confirm dialog.');
      }
      firstHandle.resolve(true);
      firstHandle.resolve(false); // 重复结算必须幂等忽略
      await expect(q1).resolves.toBe(true);

      const secondHandle = latestReq as DialogRequest | null;
      expect(secondHandle?.title).toBe('幂等 2');
      if (!secondHandle || secondHandle.kind !== 'confirm') {
        throw new Error('Expected second dialog to stay open.');
      }
      secondHandle.resolve(false);
      await expect(q2).resolves.toBe(false);
    });

    it('F9-T2-6: buildInjectedWebProbesScript() 在隔离 vm 沙箱挂载探针并容错缺失可选热区与必需热区', () => {
      const vp = { width: 390, height: 844 };
      // 仅挂载 required: true 的 5 个元素，缺省 optional 元素（tabBar / searchGlobeButton / workbenchTrigger / chatExportButton）
      const minimalRequiredDom = createCoreInteractiveDomSet(vp).filter((el) => {
        const testId = el.getAttribute('data-testid');
        return (
          testId !== 'main-workspace-tab-bar' &&
          testId !== 'composer-search-globe' &&
          testId !== 'workbench-trigger' &&
          testId !== 'chat-export-button'
        );
      });

      const browser = createFakeBrowserGlobals(vp, minimalRequiredDom);
      const scriptText = buildInjectedWebProbesScript();
      const context: {
        window: Record<string, unknown>;
        document: Record<string, unknown>;
      } = {
        window: browser.fakeWindow,
        document: browser.fakeDocument,
      };
      vm.runInNewContext(scriptText, context);

      const probes = context.window.__embezzleE2EProbes as {
        CORE_WEB_INTERACTIVE_TARGETS: readonly InteractiveTargetDescriptor[];
        probeElementGeometryAndOcclusion: (
          targets: readonly InteractiveTargetDescriptor[]
        ) => GeometryAndOcclusionReport;
        probeOverlayResidual: () => OverlayResidualReport;
      };
      expect(probes).toBeDefined();

      // 可选元素缺失（例如键盘弹起隐藏了 tabBar）不应报错
      const reportWithMissingOptional = probes.probeElementGeometryAndOcclusion(
        probes.CORE_WEB_INTERACTIVE_TARGETS
      );
      expect(reportWithMissingOptional.failures).toEqual([]);
      expect(reportWithMissingOptional.items.find((i) => i.key === 'tabBar')?.found).toBe(false);

      // 缺少 required: true 元素（如 composerInput）必须显式记入 failures
      const onlyComposerInputTargets = probes.CORE_WEB_INTERACTIVE_TARGETS.filter(
        (t) => t.key === 'composerInput'
      );
      const domWithoutComposer = minimalRequiredDom.filter(
        (el) => el.getAttribute('data-testid') !== 'composer-input'
      );
      const browserMissingRequired = createFakeBrowserGlobals(vp, domWithoutComposer);
      const context2 = {
        window: browserMissingRequired.fakeWindow,
        document: browserMissingRequired.fakeDocument,
      };
      vm.runInNewContext(scriptText, context2);
      const probes2 = context2.window.__embezzleE2EProbes as typeof probes;
      const reportMissingRequired = probes2.probeElementGeometryAndOcclusion(onlyComposerInputTargets);
      expect(reportMissingRequired.failures.length).toBe(1);
      expect(reportMissingRequired.failures[0]).toContain('composerInput');
    });
  });
});
