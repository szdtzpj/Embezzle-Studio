import type { ReactNode } from 'react';

export type DialogTone = 'danger' | 'warning' | 'primary';

export interface ConfirmDialogOptions {
  title: string;
  description: string;
  subject?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: DialogTone;
  icon?: ReactNode;
  signal?: AbortSignal;
}

export interface NoticeDialogOptions {
  title: string;
  description: string;
  buttonLabel?: string;
  tone?: DialogTone;
  icon?: ReactNode;
  signal?: AbortSignal;
}

export interface ConfirmDialogRequest {
  kind: 'confirm';
  title: string;
  description: string;
  subject?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: DialogTone;
  icon?: ReactNode;
  resolve: (confirmed: boolean) => void;
}

export interface NoticeDialogRequest {
  kind: 'notice';
  title: string;
  description: string;
  buttonLabel?: string;
  tone?: DialogTone;
  icon?: ReactNode;
  resolve: () => void;
}

export type DialogRequest = ConfirmDialogRequest | NoticeDialogRequest;

export interface ModalSheetOptions<T = unknown> {
  title?: string;
  dismissible?: boolean;
  signal?: AbortSignal;
  onDismiss?: () => void;
  render: (close: (result?: T) => void) => ReactNode;
}

export interface ModalSheetRequest<T = unknown> {
  kind: 'sheet';
  id: number;
  order: number;
  title?: string;
  dismissible: boolean;
  render: (close: (result?: T) => void) => ReactNode;
  resolve: (result?: T) => void;
  dismiss: () => void;
}

export type OverlayLayer = 'sheet' | 'fullscreen' | 'dialog';

export interface OverlayPortalEntry {
  id: string;
  layer: OverlayLayer;
  priority: number;
  order: number;
  onRequestClose?: () => void;
  render: () => ReactNode;
}

export interface OverlayHostSnapshot {
  activeSheet: ModalSheetRequest<unknown> | null;
  portals: OverlayPortalEntry[];
  version: number;
}

type DialogListener = (request: DialogRequest | null) => void;
type OverlayListener = (snapshot: OverlayHostSnapshot) => void;

const defaultLayerPriority: Record<OverlayLayer, number> = {
  sheet: 50,
  fullscreen: 60,
  dialog: 80,
};

let listener: DialogListener | null = null;
let active: DialogRequest | null = null;
const queue: DialogRequest[] = [];

let overlayListener: OverlayListener | null = null;
let activeSheet: ModalSheetRequest<unknown> | null = null;
const sheetQueue: ModalSheetRequest<unknown>[] = [];

const portalEntries = new Map<string, OverlayPortalEntry>();
let nextOverlayOrder = 0;
let overlayVersion = 0;
let isClearingHost = false;

function hasMountedHost(): boolean {
  if (isClearingHost) {
    return false;
  }
  return Boolean(listener || overlayListener);
}

function settleWithoutHost(request: DialogRequest): void {
  if (request.kind === 'confirm') {
    request.resolve(false);
  } else {
    request.resolve();
  }
}

function presentNext(): void {
  if (!listener || active) {
    return;
  }
  active = queue.shift() ?? null;
  if (active) {
    listener(active);
  }
}

function finish(request: DialogRequest): void {
  if (active === request) {
    active = null;
    listener?.(null);
    presentNext();
    return;
  }

  const queuedIndex = queue.indexOf(request);
  if (queuedIndex >= 0) {
    queue.splice(queuedIndex, 1);
  }
}

export function getOverlayHostSnapshot(): OverlayHostSnapshot {
  const portals = [...portalEntries.values()].sort(
    (left, right) => left.priority - right.priority || left.order - right.order
  );
  return {
    activeSheet,
    portals,
    version: overlayVersion,
  };
}

function notifyOverlayHost(): void {
  overlayVersion += 1;
  overlayListener?.(getOverlayHostSnapshot());
}

function presentNextSheet(): void {
  if (!hasMountedHost() || activeSheet) {
    return;
  }
  activeSheet = sheetQueue.shift() ?? null;
  if (activeSheet) {
    notifyOverlayHost();
  }
}

function finishSheet(request: ModalSheetRequest<unknown>): void {
  if (activeSheet === request) {
    activeSheet = null;
    notifyOverlayHost();
    presentNextSheet();
    return;
  }

  const queuedIndex = sheetQueue.indexOf(request);
  if (queuedIndex >= 0) {
    sheetQueue.splice(queuedIndex, 1);
  }
}

/**
 * 绑定全局对话框宿主。传入 `null` 代表宿主卸载，
 * 必须立即对所有活跃与排队中的对话框及 Sheet 请求执行 fail-closed 结算。
 */
export function bindAppDialogHost(next: DialogListener | null): void {
  listener = next;
  if (listener) {
    if (active) {
      listener(active);
    } else {
      presentNext();
    }
    presentNextSheet();
    return;
  }

  // 宿主消失时不得遗留未结算的确认弹窗、通知或模态 Sheet Promise。
  const abandoned = [...(active ? [active] : []), ...queue];
  active = null;
  queue.length = 0;

  const abandonedSheets = [...(activeSheet ? [activeSheet] : []), ...sheetQueue];
  activeSheet = null;
  sheetQueue.length = 0;

  // 清算期间标记为无可用宿主，防止 onDismiss 同步重入调用把新请求重新滞留在队列中
  isClearingHost = true;
  try {
    abandoned.forEach(settleWithoutHost);
    if (abandonedSheets.length > 0) {
      abandonedSheets.forEach((sheet) => sheet.dismiss());
      notifyOverlayHost();
    }
  } finally {
    isClearingHost = false;
  }
}

/**
 * 订阅统一 Overlay 宿主状态（含命令式 Sheet 与声明式 OverlayPortal）。
 */
export function subscribeOverlayHost(next: OverlayListener): () => void {
  overlayListener = next;
  presentNextSheet();
  next(getOverlayHostSnapshot());

  return () => {
    if (overlayListener === next) {
      overlayListener = null;
    }
    if (!hasMountedHost()) {
      const abandonedSheets = [...(activeSheet ? [activeSheet] : []), ...sheetQueue];
      activeSheet = null;
      sheetQueue.length = 0;
      if (abandonedSheets.length > 0) {
        isClearingHost = true;
        try {
          abandonedSheets.forEach((sheet) => sheet.dismiss());
        } finally {
          isClearingHost = false;
        }
      }
    }
  };
}

export function getDefaultOverlayPriority(layer: OverlayLayer): number {
  return defaultLayerPriority[layer];
}

/**
 * 注册或更新声明式 Portal 条目；仅在可见状态注册，不影响外部阻塞队列。
 */
export function upsertOverlayPortal(
  entry: Omit<OverlayPortalEntry, 'order' | 'priority'> & { priority?: number }
): void {
  const existing = portalEntries.get(entry.id);
  const priority = entry.priority ?? getDefaultOverlayPriority(entry.layer);
  const order =
    existing && existing.layer === entry.layer && existing.priority === priority
      ? existing.order
      : ++nextOverlayOrder;
  portalEntries.set(entry.id, {
    ...entry,
    priority,
    order,
  });
  notifyOverlayHost();
}

/**
 * 注销声明式 Portal 条目；若条目不存在则静默跳过，避免多余渲染。
 */
export function removeOverlayPortal(id: string): void {
  if (!portalEntries.delete(id)) {
    return;
  }
  notifyOverlayHost();
}

function enqueue(request: DialogRequest): void {
  if (!listener || isClearingHost) {
    settleWithoutHost(request);
    return;
  }
  queue.push(request);
  presentNext();
}

/**
 * 发起串行确认弹窗；支持可选 `AbortSignal` 与自定义图标。
 */
export function requestConfirm(options: ConfirmDialogOptions): Promise<boolean> {
  if (options.signal?.aborted) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    let settled = false;
    let onAbort: (() => void) | null = null;
    const cleanupSignal = () => {
      if (onAbort && options.signal) {
        options.signal.removeEventListener('abort', onAbort);
        onAbort = null;
      }
    };

    const request: ConfirmDialogRequest = {
      kind: 'confirm',
      title: options.title,
      description: options.description,
      subject: options.subject,
      confirmLabel: options.confirmLabel,
      cancelLabel: options.cancelLabel,
      tone: options.tone ?? 'danger',
      icon: options.icon,
      resolve: (confirmed) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanupSignal();
        finish(request);
        resolve(confirmed);
      },
    };

    if (options.signal) {
      onAbort = () => request.resolve(false);
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    enqueue(request);
  });
}

/**
 * 统一确认弹窗命令式入口（与 `requestConfirm` 语义一致）。
 */
export function showConfirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return requestConfirm(options);
}

/**
 * 发起串行通知弹窗；支持可选 `AbortSignal` 与自定义图标。
 */
export function requestNotice(options: NoticeDialogOptions): Promise<void> {
  if (options.signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    let onAbort: (() => void) | null = null;
    const cleanupSignal = () => {
      if (onAbort && options.signal) {
        options.signal.removeEventListener('abort', onAbort);
        onAbort = null;
      }
    };

    const request: NoticeDialogRequest = {
      kind: 'notice',
      title: options.title,
      description: options.description,
      buttonLabel: options.buttonLabel,
      tone: options.tone ?? 'primary',
      icon: options.icon,
      resolve: () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanupSignal();
        finish(request);
        resolve();
      },
    };

    if (options.signal) {
      onAbort = () => request.resolve();
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    enqueue(request);
  });
}

/**
 * 发起独立于 Alert/Dialog 队列的模态 Sheet；
 * 同层按 FIFO 调度，且不会阻塞内部嵌套调用 `requestConfirm` / `showConfirmDialog`。
 */
export function showModalSheet<T = unknown>(
  options: ModalSheetOptions<T>
): Promise<T | undefined> {
  if (options.signal?.aborted || !hasMountedHost()) {
    options.onDismiss?.();
    return Promise.resolve(undefined);
  }

  return new Promise((resolve) => {
    let settled = false;
    let onAbort: (() => void) | null = null;
    const cleanupSignal = () => {
      if (onAbort && options.signal) {
        options.signal.removeEventListener('abort', onAbort);
        onAbort = null;
      }
    };

    const order = ++nextOverlayOrder;
    let requestRef: ModalSheetRequest<unknown>;

    const settle = (result: T | undefined, dismissed: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupSignal();
      finishSheet(requestRef);
      if (dismissed) {
        options.onDismiss?.();
      }
      resolve(result);
    };

    requestRef = {
      kind: 'sheet',
      id: order,
      order,
      title: options.title,
      dismissible: options.dismissible ?? true,
      render: (close) => options.render((result) => close(result)),
      resolve: (result) => settle(result as T | undefined, false),
      dismiss: () => settle(undefined, true),
    };

    if (options.signal) {
      onAbort = () => settle(undefined, true);
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    sheetQueue.push(requestRef);
    presentNextSheet();
  });
}
