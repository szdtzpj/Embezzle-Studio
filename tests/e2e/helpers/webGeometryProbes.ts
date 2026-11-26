/**
 * Web 端（Chromium / Playwright）几何遮挡、残余遮罩与 Long Task 性能探针。
 * 所有探针函数均保持纯浏览器上下文自包含（无外部 Node/闭包变量依赖），可直接传入 `page.evaluate(...)`，
 * 同时导出独立可注入脚本字符串供 `page.addInitScript(...)` 或跨上下文执行。
 */

export interface InteractiveTargetDescriptor {
  key: string;
  description: string;
  /** 按优先级排列的 CSS 选择器列表（优先 data-testid，其次 aria-label / role / placeholder） */
  selectors: string[];
  required?: boolean;
}

export interface ElementRectSnapshot {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface ElementOcclusionDetail {
  hitTag: string;
  hitTestId: string | null;
  hitAriaLabel: string | null;
  hitRole: string | null;
  hitClass: string | null;
  hitPoint: { x: number; y: number };
}

export interface ElementGeometryProbeItem {
  key: string;
  matchedSelector: string | null;
  found: boolean;
  visible: boolean;
  outOfViewport: boolean;
  occluded: boolean;
  clickable: boolean;
  rect: ElementRectSnapshot | null;
  occlusionDetail?: ElementOcclusionDetail;
}

export interface ElementOverlapPair {
  firstKey: string;
  secondKey: string;
  intersectionWidth: number;
  intersectionHeight: number;
  intersectionArea: number;
}

export interface GeometryAndOcclusionReport {
  viewport: { width: number; height: number };
  items: ElementGeometryProbeItem[];
  overlaps: ElementOverlapPair[];
  failures: string[];
}

export interface LongTaskEntryRecord {
  startTime: number;
  duration: number;
  name: string;
}

export interface LongTaskStatsReport {
  supported: boolean;
  installed: boolean;
  count: number;
  totalDurationMs: number;
  maxDurationMs: number;
  entries: LongTaskEntryRecord[];
  maxRafGapMs?: number;
}

export interface OverlayResidualItem {
  tag: string;
  testId: string | null;
  ariaLabel: string | null;
  role: string | null;
  zIndex: number;
  pointerEvents: string;
  opacity: number;
  rect: ElementRectSnapshot;
}

export interface OverlayResidualReport {
  viewport: { width: number; height: number };
  residuals: OverlayResidualItem[];
  hasBlockingOverlay: boolean;
}

/**
 * 核心 Web 端可交互热区锚点目录（覆盖 data-testid、aria-label、role、placeholder）。
 */
export const CORE_WEB_INTERACTIVE_TARGETS: readonly InteractiveTargetDescriptor[] = [
  {
    key: 'modelPickerTrigger',
    description: '顶部模型选择胶囊按钮',
    selectors: ['[data-testid="model-picker-trigger"]'],
    required: true,
  },
  {
    key: 'composerInput',
    description: '消息输入框',
    selectors: [
      '[data-testid="composer-input"]',
      'textarea[aria-label="消息输入框"]',
      '[aria-label="消息输入框"]',
      'textarea[placeholder*="今天如何"]',
    ],
    required: true,
  },
  {
    key: 'sendOrStopButton',
    description: '发送或停止请求按钮',
    selectors: [
      '[data-testid="composer-send-button"]',
      '[role="button"][aria-label="发送消息"]',
      '[role="button"][aria-label="停止当前请求"]',
      '[aria-label="发送消息"]',
      '[aria-label="停止当前请求"]',
    ],
    required: true,
  },
  {
    key: 'drawerTrigger',
    description: '打开聊天记录侧边栏按钮',
    selectors: [
      '[data-testid="drawer-trigger"]',
      '[role="button"][aria-label="打开聊天记录"]',
      '[aria-label="打开聊天记录"]',
    ],
    required: true,
  },
  {
    key: 'settingsTrigger',
    description: '打开设置页面按钮',
    selectors: [
      '[data-testid="settings-trigger"]',
      '[role="button"][aria-label="打开设置"]',
      '[aria-label="打开设置"]',
    ],
    required: true,
  },
  {
    key: 'workbenchTrigger',
    description: '打开本地成果工作台按钮',
    selectors: [
      '[data-testid="workbench-trigger"]',
      '[role="button"][aria-label="打开本地成果工作台"]',
      '[aria-label="打开本地成果工作台"]',
    ],
    required: false,
  },
  {
    key: 'chatExportButton',
    description: '顶部导出当前对话按钮',
    selectors: [
      '[data-testid="chat-export-button"]',
      '[role="button"][aria-label="导出当前对话"]',
      '[aria-label="导出当前对话"]',
    ],
    required: false,
  },
  {
    key: 'searchGlobeButton',
    description: 'Composer 联网搜索切换按钮',
    selectors: ['[data-testid="composer-search-globe"]'],
    required: false,
  },
  {
    key: 'tabBar',
    description: '底部主工作区 TabBar',
    selectors: ['[data-testid="main-workspace-tab-bar"]', '[role="tablist"]'],
    required: false,
  },
];

/**
 * 浏览器端探针：检查一组目标元素的视口边界、elementFromPoint 可点击性以及两两矩形重叠情况。
 * 可直接作为 `page.evaluate(probeElementGeometryAndOcclusion, targets)` 传入 Playwright。
 */
export function probeElementGeometryAndOcclusion(
  targets: readonly InteractiveTargetDescriptor[]
): GeometryAndOcclusionReport {
  const viewport = {
    width: window.innerWidth,
    height: window.innerHeight,
  };

  const items: ElementGeometryProbeItem[] = [];
  const visibleBoxes: Array<{ key: string; rect: ElementRectSnapshot }> = [];
  const failures: string[] = [];

  for (const target of targets) {
    let matchedEl: Element | null = null;
    let matchedSelector: string | null = null;

    for (const selector of target.selectors) {
      const candidate = document.querySelector(selector);
      if (candidate) {
        matchedEl = candidate;
        matchedSelector = selector;
        break;
      }
    }

    if (!matchedEl) {
      items.push({
        key: target.key,
        matchedSelector: null,
        found: false,
        visible: false,
        outOfViewport: false,
        occluded: false,
        clickable: false,
        rect: null,
      });
      if (target.required) {
        failures.push(`未找到必需交互元素 "${target.key}" (${target.description})`);
      }
      continue;
    }

    const domRect = matchedEl.getBoundingClientRect();
    const style = window.getComputedStyle(matchedEl);
    const rect: ElementRectSnapshot = {
      left: domRect.left,
      top: domRect.top,
      right: domRect.right,
      bottom: domRect.bottom,
      width: domRect.width,
      height: domRect.height,
    };

    const visible =
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      parseFloat(style.opacity || '1') > 0;

    const outOfViewport =
      rect.left < -1 ||
      rect.top < -1 ||
      rect.right > viewport.width + 1 ||
      rect.bottom > viewport.height + 1;

    let occluded = false;
    let clickable = false;
    let occlusionDetail: ElementOcclusionDetail | undefined;

    if (visible && !outOfViewport) {
      const cx = Math.min(viewport.width - 1, Math.max(1, rect.left + rect.width / 2));
      const cy = Math.min(viewport.height - 1, Math.max(1, rect.top + rect.height / 2));
      const hit = document.elementFromPoint(cx, cy);

      if (hit && (hit === matchedEl || matchedEl.contains(hit))) {
        clickable = true;
      } else {
        occluded = true;
        occlusionDetail = {
          hitTag: hit ? hit.tagName.toLowerCase() : 'null',
          hitTestId: hit ? hit.getAttribute('data-testid') : null,
          hitAriaLabel: hit ? hit.getAttribute('aria-label') : null,
          hitRole: hit ? hit.getAttribute('role') : null,
          hitClass: hit ? hit.getAttribute('class') : null,
          hitPoint: { x: cx, y: cy },
        };
      }
      visibleBoxes.push({ key: target.key, rect });
    }

    if (visible && outOfViewport) {
      failures.push(`交互元素 "${target.key}" 超出视口边界`);
    }
    if (visible && occluded) {
      failures.push(
        `交互元素 "${target.key}" 中心点被遮挡（命中 ${occlusionDetail?.hitTag ?? 'unknown'}）`
      );
    }

    items.push({
      key: target.key,
      matchedSelector,
      found: true,
      visible,
      outOfViewport,
      occluded,
      clickable,
      rect,
      ...(occlusionDetail ? { occlusionDetail } : {}),
    });
  }

  const overlaps: ElementOverlapPair[] = [];
  for (let i = 0; i < visibleBoxes.length; i += 1) {
    for (let j = i + 1; j < visibleBoxes.length; j += 1) {
      const a = visibleBoxes[i];
      const b = visibleBoxes[j];
      const interLeft = Math.max(a.rect.left, b.rect.left);
      const interTop = Math.max(a.rect.top, b.rect.top);
      const interRight = Math.min(a.rect.right, b.rect.right);
      const interBottom = Math.min(a.rect.bottom, b.rect.bottom);
      const interW = interRight - interLeft;
      const interH = interBottom - interTop;
      if (interW > 1 && interH > 1) {
        const area = interW * interH;
        overlaps.push({
          firstKey: a.key,
          secondKey: b.key,
          intersectionWidth: interW,
          intersectionHeight: interH,
          intersectionArea: area,
        });
        failures.push(`交互元素 "${a.key}" 与 "${b.key}" 发生矩形重叠 (${Math.round(area)}px^2)`);
      }
    }
  }

  return {
    viewport,
    items,
    overlaps,
    failures,
  };
}

interface E2ELongTaskState {
  supported: boolean;
  entries: LongTaskEntryRecord[];
  observer: PerformanceObserver | null;
  rafActive: boolean;
  rafId: number | null;
  lastRafTime: number | null;
  maxRafGapMs: number;
}

type WindowWithLongTaskProbe = Window & {
  __e2eLongTaskState?: E2ELongTaskState;
};

/**
 * 浏览器端探针：在页面上安装 `PerformanceObserver('longtask')` 与可选 `requestAnimationFrame` 帧间隔监控。
 */
export function installLongTaskCollector(trackRaf = true): {
  supported: boolean;
  installed: boolean;
} {
  const win = window as WindowWithLongTaskProbe;
  if (win.__e2eLongTaskState?.observer) {
    win.__e2eLongTaskState.observer.disconnect();
  }
  if (win.__e2eLongTaskState?.rafId !== null && win.__e2eLongTaskState?.rafId !== undefined) {
    cancelAnimationFrame(win.__e2eLongTaskState.rafId);
  }

  const supported =
    typeof PerformanceObserver === 'function' &&
    Array.isArray(PerformanceObserver.supportedEntryTypes) &&
    PerformanceObserver.supportedEntryTypes.includes('longtask');

  const state: E2ELongTaskState = {
    supported,
    entries: [],
    observer: null,
    rafActive: trackRaf,
    rafId: null,
    lastRafTime: null,
    maxRafGapMs: 0,
  };

  if (supported) {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.entries.push({
          startTime: entry.startTime,
          duration: entry.duration,
          name: entry.name,
        });
      }
    });
    observer.observe({ entryTypes: ['longtask'] });
    state.observer = observer;
  }

  if (trackRaf && typeof requestAnimationFrame === 'function') {
    const sampleFrame = (ts: number) => {
      if (!state.rafActive) return;
      if (state.lastRafTime !== null) {
        const gap = ts - state.lastRafTime;
        if (gap > state.maxRafGapMs) {
          state.maxRafGapMs = gap;
        }
      }
      state.lastRafTime = ts;
      state.rafId = requestAnimationFrame(sampleFrame);
    };
    state.rafId = requestAnimationFrame(sampleFrame);
  }

  win.__e2eLongTaskState = state;
  return { supported, installed: true };
}

/**
 * 浏览器端探针：读取当前页面收集到的 Long Task 与最大帧间隔统计。
 */
export function readLongTaskStats(resetAfterRead = false): LongTaskStatsReport {
  const win = window as WindowWithLongTaskProbe;
  const state = win.__e2eLongTaskState;
  if (!state) {
    return {
      supported: false,
      installed: false,
      count: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
      entries: [],
    };
  }

  const entries = state.entries.slice();
  let totalDurationMs = 0;
  let maxDurationMs = 0;
  for (const item of entries) {
    totalDurationMs += item.duration;
    if (item.duration > maxDurationMs) {
      maxDurationMs = item.duration;
    }
  }
  const maxRafGapMs = state.rafActive ? state.maxRafGapMs : undefined;

  if (resetAfterRead) {
    state.entries.length = 0;
    state.maxRafGapMs = 0;
    state.lastRafTime = null;
  }

  return {
    supported: state.supported,
    installed: true,
    count: entries.length,
    totalDurationMs,
    maxDurationMs,
    entries,
    ...(maxRafGapMs !== undefined ? { maxRafGapMs } : {}),
  };
}

/**
 * 浏览器端探针：扫描全屏或高 z-index 残余 Scrim/遮罩元素（用于验证 Drawer/Modal 关闭后无拦截残留）。
 */
export function probeOverlayResidual(
  minViewportRatio = 0.85,
  minZIndex = 10
): OverlayResidualReport {
  const viewport = {
    width: window.innerWidth,
    height: window.innerHeight,
  };
  const residuals: OverlayResidualItem[] = [];
  const allElements = document.querySelectorAll('*');

  for (let i = 0; i < allElements.length; i += 1) {
    const el = allElements[i];
    if (el === document.documentElement || el === document.body) {
      continue;
    }
    const style = window.getComputedStyle(el);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.pointerEvents === 'none'
    ) {
      continue;
    }
    if (style.position !== 'fixed' && style.position !== 'absolute') {
      continue;
    }

    const rawZIndex = (style.zIndex || '').trim().toLowerCase();
    const parsedZIndex = Number.parseInt(rawZIndex, 10);
    // 支持检测 position: fixed 且 zIndex 为 auto 的全视口透明阻塞层，防止低层/未声明 zIndex 的固定蒙层逃逸
    const isAutoFixed = style.position === 'fixed' && (rawZIndex === '' || rawZIndex === 'auto');
    if (!isAutoFixed && (!Number.isFinite(parsedZIndex) || parsedZIndex < minZIndex)) {
      continue;
    }
    const zIndex = Number.isFinite(parsedZIndex) ? parsedZIndex : 0;

    const domRect = el.getBoundingClientRect();
    const coversViewport =
      domRect.width >= viewport.width * minViewportRatio &&
      domRect.height >= viewport.height * minViewportRatio;
    if (!coversViewport) {
      continue;
    }

    const opacity = Number.parseFloat(style.opacity || '1');
    // 仅报告非根容器的半透明/透明遮罩或显式 scrim/backdrop（保持 100% 自包含）
    const testId = el.getAttribute('data-testid');
    const ariaLabel = el.getAttribute('aria-label');
    const role = el.getAttribute('role');
    const bg = (style.backgroundColor || '').trim().toLowerCase();
    let isTransparentOrTranslucentBg = bg === 'transparent';
    if (!isTransparentOrTranslucentBg && bg) {
      const commaAlphaMatch =
        /^(?:rgba|hsla)\([^,]+,[^,]+,[^,]+,\s*([0-9.]+%?)\s*\)$/.exec(bg);
      const slashAlphaMatch =
        /^(?:rgba?|hsla?)\([^/]+\/\s*([0-9.]+%?)\s*\)$/.exec(bg);
      const alphaRaw = commaAlphaMatch?.[1] ?? slashAlphaMatch?.[1];
      if (alphaRaw !== undefined) {
        const alpha = alphaRaw.endsWith('%')
          ? Number.parseFloat(alphaRaw) / 100
          : Number.parseFloat(alphaRaw);
        if (Number.isFinite(alpha) && alpha < 1) {
          isTransparentOrTranslucentBg = true;
        }
      }
    }
    const matchesOverlayAria =
      ariaLabel !== null && /关闭|dismiss|close|backdrop|scrim|overlay|遮罩/i.test(ariaLabel);
    const looksLikeOverlay =
      opacity < 1 ||
      (testId !== null && /scrim|overlay|backdrop|modal/i.test(testId)) ||
      role === 'dialog' ||
      matchesOverlayAria ||
      isTransparentOrTranslucentBg;

    if (looksLikeOverlay) {
      residuals.push({
        tag: el.tagName.toLowerCase(),
        testId,
        ariaLabel,
        role,
        zIndex,
        pointerEvents: style.pointerEvents,
        opacity,
        rect: {
          left: domRect.left,
          top: domRect.top,
          right: domRect.right,
          bottom: domRect.bottom,
          width: domRect.width,
          height: domRect.height,
        },
      });
    }
  }

  return {
    viewport,
    residuals,
    hasBlockingOverlay: residuals.length > 0,
  };
}

/**
 * 构建可在 Playwright `page.addInitScript(...)` 或 `page.evaluate(...)` 直接求值的独立脚本字符串，
 * 将所有探针注册到 `window.__embezzleE2EProbes`。
 */
export function buildInjectedWebProbesScript(): string {
  return [
    '(function(){',
    '  const targets = ' + JSON.stringify(CORE_WEB_INTERACTIVE_TARGETS) + ';',
    '  const probeElementGeometryAndOcclusion = ' + probeElementGeometryAndOcclusion.toString() + ';',
    '  const installLongTaskCollector = ' + installLongTaskCollector.toString() + ';',
    '  const readLongTaskStats = ' + readLongTaskStats.toString() + ';',
    '  const probeOverlayResidual = ' + probeOverlayResidual.toString() + ';',
    '  window.__embezzleE2EProbes = {',
    '    CORE_WEB_INTERACTIVE_TARGETS: targets,',
    '    probeElementGeometryAndOcclusion,',
    '    installLongTaskCollector,',
    '    readLongTaskStats,',
    '    probeOverlayResidual',
    '  };',
    '})();',
  ].join('\n');
}
