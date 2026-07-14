import type { ChatLease, ChatOrchestrationController } from '../internal/ChatContext';

/** Link task-query cancellation to the shared Chat activity lease. */
export function bindTaskLeaseAbort(
  signal: AbortSignal,
  onAbort: () => void
): () => void {
  if (signal.aborted) {
    onAbort();
    return () => undefined;
  }
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

export type ChatTaskLeaseStartResult =
  | { ok: true; controller: AbortController }
  | { ok: false; busyLabel: string };

/**
 * Owns the shared task-query lease and every child request controller.
 * Callers only start/finish a keyed query or cancel the whole task group;
 * replacement identity, last-query release and global abort ordering stay here.
 */
export class ChatTaskLeaseCoordinator {
  private readonly controllers = new Map<string, AbortController>();
  private activityLease: ChatLease | null = null;
  private leaseAbortCleanup: (() => void) | null = null;
  private disposed = false;

  constructor(
    private readonly orchestration: ChatOrchestrationController,
    private readonly publishQuerying: (queryingByKey: Readonly<Record<string, boolean>>) => void
  ) {}

  start(key: string): ChatTaskLeaseStartResult {
    if (this.disposed) {
      return { ok: false, busyLabel: '媒体任务中心' };
    }

    let lease = this.activityLease;
    if (!lease) {
      lease = this.orchestration.begin({ phase: 'task-query', label: '媒体任务查询' });
      if (!lease) {
        return {
          ok: false,
          busyLabel: this.orchestration.current()?.label ?? '其他操作',
        };
      }
      this.activityLease = lease;
      this.registerLeaseAbort(lease);
    }

    this.controllers.get(key)?.abort();
    const controller = new AbortController();
    this.controllers.set(key, controller);
    this.publishSnapshot();
    return { ok: true, controller };
  }

  finish(key: string, controller: AbortController): void {
    if (this.controllers.get(key) === controller) {
      this.controllers.delete(key);
      this.publishSnapshot();
    }
    if (this.controllers.size === 0) {
      const lease = this.activityLease;
      if (lease) this.finishLease(lease);
    }
  }

  cancelAll(): void {
    const lease = this.activityLease;
    if (lease && !lease.controller.signal.aborted) {
      lease.controller.abort();
    }
    // AbortSignal dispatch is synchronous, but keep this fallback so cleanup
    // remains correct for an already-aborted or externally supplied signal.
    if (this.activityLease === lease) {
      this.abortTaskControllers();
      if (lease) this.finishLease(lease);
    } else if (!lease) {
      this.abortTaskControllers();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAll();
  }

  private registerLeaseAbort(lease: ChatLease): void {
    const onAbort = () => {
      this.abortTaskControllers();
      this.finishLease(lease);
    };
    this.leaseAbortCleanup = bindTaskLeaseAbort(lease.controller.signal, onAbort);
  }

  private abortTaskControllers(): void {
    for (const controller of this.controllers.values()) controller.abort();
    if (this.controllers.size === 0) return;
    this.controllers.clear();
    this.publishSnapshot();
  }

  private finishLease(lease: ChatLease): void {
    if (this.activityLease !== lease) return;
    this.leaseAbortCleanup?.();
    this.leaseAbortCleanup = null;
    this.activityLease = null;
    this.orchestration.finish(lease);
  }

  private publishSnapshot(): void {
    if (this.disposed) return;
    this.publishQuerying(
      Object.fromEntries([...this.controllers.keys()].map((key) => [key, true]))
    );
  }
}
