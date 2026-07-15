import { createDefaultWorkspace } from '../../data/providerCatalog';
import type { AppWorkspace } from '../../domain/types';
import {
  isWorkspaceReplacementError,
  persistWorkspaceReplacement,
  type WorkspaceReplacementPersistenceResult,
} from '../../services/workspaceReplacement';
import type { ApplicationLifecyclePort } from '../lifecycle/applicationLifecyclePort';
import type { TraceRecorder } from '../testing/traceRecorder';
import type { WorkspacePersistenceAdapter } from './adapters/workspacePersistenceAdapter';
import {
  isWorkspaceCommitRejectedError,
  WorkspaceCommitRejectedError,
  type WorkspaceCommitDurability,
  type WorkspaceCommitOptions,
  type WorkspaceCommitPort,
  type WorkspaceCommitReducer,
} from './internal/WorkspaceCommitPort';
import type { WorkspacePhase, WorkspaceStatus } from './workspaceStatus';

export const WORKSPACE_SAVE_DEBOUNCE_MS = 450;

export interface WorkspaceSessionClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): { clear(): void };
}

export interface WorkspaceSessionOptions {
  persistence: WorkspacePersistenceAdapter;
  clock?: WorkspaceSessionClock;
  lifecycle?: ApplicationLifecyclePort;
  /** Optional test trace. Production omits this. */
  trace?: TraceRecorder;
  /** When false, the caller must invoke boot() explicitly. Default true. */
  autoBoot?: boolean;
}

export type WorkspaceSessionListener = () => void;

const productionClock: WorkspaceSessionClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    return { clear: () => clearTimeout(handle) };
  },
};

/**
 * Sole writable owner of the in-memory AppWorkspace snapshot, revision,
 * persistence status, read-only/replacement phases, and durability semantics.
 */
export class WorkspaceSession {
  private snapshot: AppWorkspace;
  private revision = 0;
  private phase: WorkspacePhase = 'booting';
  private dirty = false;
  private issue: string | undefined;
  private recoveryNotice: string | undefined;
  private saveTimer: { clear(): void } | null = null;
  private disposed = false;
  private bootPromise: Promise<void> | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private cachedStatus: WorkspaceStatus;
  private readonly listeners = new Set<WorkspaceSessionListener>();
  private readonly persistence: WorkspacePersistenceAdapter;
  private readonly clock: WorkspaceSessionClock;
  private readonly trace?: TraceRecorder;
  private readonly lifecycle?: ApplicationLifecyclePort;
  private unsubscribeLifecycle: (() => void) | null = null;

  constructor(options: WorkspaceSessionOptions) {
    this.persistence = options.persistence;
    this.clock = options.clock ?? productionClock;
    this.trace = options.trace;
    this.lifecycle = options.lifecycle;
    this.snapshot = createDefaultWorkspace();
    this.cachedStatus = this.buildStatus();

    if (options.autoBoot !== false) {
      void this.boot();
    }
  }

  subscribe(listener: WorkspaceSessionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): AppWorkspace {
    return this.snapshot;
  }

  getRevision(): number {
    return this.revision;
  }

  getStatus(): WorkspaceStatus {
    return this.cachedStatus;
  }

  private buildStatus(): WorkspaceStatus {
    const status: WorkspaceStatus = {
      phase: this.phase,
      revision: this.revision,
      dirty: this.dirty,
    };
    if (this.issue) {
      status.issue = this.issue;
    }
    if (this.recoveryNotice) {
      status.recoveryNotice = this.recoveryNotice;
    }
    return status;
  }

  private refreshStatus(): void {
    this.cachedStatus = this.buildStatus();
  }

  isWritable(): boolean {
    return this.phase === 'ready';
  }

  isReplacing(): boolean {
    return this.phase === 'replacing';
  }

  isReadOnly(): boolean {
    return this.phase === 'read-only';
  }

  isBooting(): boolean {
    return this.phase === 'booting';
  }

  /**
   * Load the durable snapshot. Load failure transitions to read-only and never
   * falls back to an empty writable workspace.
   */
  async boot(): Promise<void> {
    if (this.bootPromise) {
      return this.bootPromise;
    }
    if (this.disposed) {
      this.bootPromise = Promise.resolve();
      return this.bootPromise;
    }
    this.ensureLifecycleSubscription();
    this.bootPromise = this.runBoot();
    return this.bootPromise;
  }

  private ensureLifecycleSubscription(): void {
    if (this.unsubscribeLifecycle || !this.lifecycle || this.disposed) {
      return;
    }
    this.unsubscribeLifecycle = this.lifecycle.subscribe((event) => {
      if (event === 'background') {
        void this.flush({ reason: 'background' });
      }
    });
  }

  private async runBoot(): Promise<void> {
    this.trace?.record('workspace.boot.start');
    try {
      const loaded = await this.persistence.load();
      if (this.disposed) {
        return;
      }
      if (loaded) {
        // Apply the durable snapshot without scheduling a rewrite.
        this.snapshot = loaded;
        this.revision += 1;
      }
      const recovery = this.persistence.consumeRecoveryNotice();
      this.recoveryNotice = recovery ?? undefined;
      this.issue = undefined;
      this.phase = 'ready';
      this.dirty = false;
      this.trace?.record('workspace.boot.ready', {
        recovered: Boolean(recovery),
        hadSnapshot: Boolean(loaded),
        revision: this.revision,
      });
      this.emit();
    } catch (error) {
      if (this.disposed) {
        return;
      }
      const message = error instanceof Error ? error.message : '工作区加载失败。';
      this.issue = message;
      this.recoveryNotice = undefined;
      this.phase = 'read-only';
      this.dirty = false;
      this.trace?.record('workspace.boot.read-only', { message });
      this.emit();
    }
  }

  /**
   * Bind a feature-private commit port to a closed command/reducer pair.
   */
  bindCommitPort<C, R>(reduce: WorkspaceCommitReducer<C, R>): WorkspaceCommitPort<C, R> {
    return {
      execute: async (command, options) => this.executeCommit(command, reduce, options),
    };
  }

  private async executeCommit<C, R>(
    command: C,
    reduce: WorkspaceCommitReducer<C, R>,
    options?: WorkspaceCommitOptions
  ): Promise<R> {
    this.assertAcceptsCommits(options?.expectedRevision);
    const { workspace: next, result } = reduce(this.snapshot, command);
    if (next !== this.snapshot) {
      await this.commitSnapshot(next, {
        durability: options?.durability ?? 'deferred',
        source: 'feature-commit',
        expectedRevision: options?.expectedRevision,
      });
    }
    return result;
  }

  private assertAcceptsCommits(expectedRevision?: number): void {
    if (this.phase === 'booting') {
      throw new WorkspaceCommitRejectedError('not-ready', '工作区仍在加载中。');
    }
    if (this.phase === 'read-only') {
      throw new WorkspaceCommitRejectedError(
        'read-only',
        '工作区加载失败，当前为只读模式，无法保存更改。'
      );
    }
    if (this.phase === 'replacing') {
      throw new WorkspaceCommitRejectedError(
        'replacing',
        '正在验证并导入备份，暂时不能修改工作区。'
      );
    }
    if (expectedRevision !== undefined && expectedRevision !== this.revision) {
      throw new WorkspaceCommitRejectedError(
        'revision-mismatch',
        '工作区在提交前已变更，请重试。'
      );
    }
  }

  private async commitSnapshot(
    next: AppWorkspace,
    options: {
      durability: WorkspaceCommitDurability;
      source: string;
      expectedRevision?: number;
    }
  ): Promise<void> {
    if (options.expectedRevision !== undefined && options.expectedRevision !== this.revision) {
      throw new WorkspaceCommitRejectedError(
        'revision-mismatch',
        '工作区在提交前已变更，请重试。'
      );
    }

    this.snapshot = next;
    this.revision += 1;
    this.trace?.record('workspace.commit', {
      source: options.source,
      revision: this.revision,
      durability: options.durability,
    });

    if (options.durability === 'required') {
      this.clearSaveTimer();
      this.dirty = true;
      this.emit();
      await this.flush({ reason: 'required', propagateFailure: true });
      return;
    }

    this.scheduleDeferredSave();
    this.emit();
  }

  private scheduleDeferredSave(): void {
    this.dirty = true;
    this.clearSaveTimer();
    this.saveTimer = this.clock.setTimeout(() => {
      this.saveTimer = null;
      void this.flush({ reason: 'debounce' });
    }, WORKSPACE_SAVE_DEBOUNCE_MS);
  }

  private clearSaveTimer(): void {
    if (this.saveTimer) {
      this.saveTimer.clear();
      this.saveTimer = null;
    }
  }

  /**
   * Durably persist the current snapshot when dirty (or always when propagateFailure).
   * Matches App.tsx flushWorkspace semantics. Saves are serialized on one chain.
   */
  flush(options: {
    reason?: string;
    propagateFailure?: boolean;
  } = {}): Promise<void> {
    const run = this.flushChain
      .catch(() => undefined)
      .then(() => this.runFlush(options));
    this.flushChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** Wait for in-flight flush work (tests and unmount paths). */
  async settle(): Promise<void> {
    await this.flushChain;
  }

  private async runFlush(options: {
    reason?: string;
    propagateFailure?: boolean;
  }): Promise<void> {
    if (this.phase !== 'ready' && this.phase !== 'replacing') {
      if (options.propagateFailure) {
        throw new Error('工作区持久化尚未就绪。');
      }
      return;
    }

    // Strict replacement flush always queues one complete snapshot even when
    // the dirty flag is already false, so it waits behind any save in flight.
    if (!this.dirty && !options.propagateFailure) {
      this.trace?.record('workspace.flush.skipped', {
        reason: options.reason ?? 'unspecified',
      });
      return;
    }

    this.clearSaveTimer();
    this.dirty = false;
    this.trace?.record('workspace.flush.start', {
      reason: options.reason ?? 'unspecified',
      revision: this.revision,
    });

    try {
      await this.persistence.save(this.snapshot);
    } catch (error) {
      this.dirty = true;
      const failure = error instanceof Error ? error : new Error('工作区保存失败。');
      this.issue = failure.message;
      this.trace?.record('workspace.flush.error', {
        reason: options.reason ?? 'unspecified',
        message: failure.message,
      });
      this.emit();
      if (options.propagateFailure) {
        throw failure;
      }
      return;
    }

    this.issue = undefined;
    this.trace?.record('workspace.flush.success', {
      reason: options.reason ?? 'unspecified',
      revision: this.revision,
    });
    // A successful save changes observable durability state even when a newer
    // commit arrived while the save was in flight. emit() refreshes status
    // without overwriting that newer commit's dirty flag.
    this.emit();
  }

  /**
   * Complete workspace replacement with strict pre-import flush and replacement lease.
   */
  async replace(
    buildImportedWorkspace: () => Promise<AppWorkspace>
  ): Promise<WorkspaceReplacementPersistenceResult> {
    if (this.phase === 'read-only' || this.phase === 'booting') {
      throw new Error('工作区持久化尚未就绪。');
    }
    if (this.phase === 'replacing') {
      throw new Error('另一个备份导入正在进行中，本次导入未执行。');
    }

    this.phase = 'replacing';
    this.trace?.record('workspace.replace.start', { revision: this.revision });
    this.emit();

    try {
      const replacement = await persistWorkspaceReplacement({
        flushCurrentWorkspace: () => this.flush({ reason: 'replace-strict', propagateFailure: true }),
        buildImportedWorkspace: async () => {
          this.trace?.record('workspace.replace.build-imported');
          return buildImportedWorkspace();
        },
        persistImportedWorkspace: async (workspace) => {
          this.trace?.record('workspace.replace.persist-imported');
          await this.persistence.save(workspace);
        },
      });

      // Imported snapshot is already on disk; do not schedule a rewrite.
      this.snapshot = replacement.workspace;
      this.revision += 1;
      this.clearSaveTimer();
      this.dirty = false;
      this.issue =
        replacement.status === 'committed-with-postcommit-error'
          ? replacement.error.message
          : undefined;
      this.phase = 'ready';
      this.trace?.record('workspace.replace.committed', {
        status: replacement.status,
        revision: this.revision,
      });
      this.emit();
      return replacement;
    } catch (error) {
      // replace() is only entered from ready; restore ready after a failed lease.
      this.phase = 'ready';
      this.trace?.record('workspace.replace.error', {
        stage: isWorkspaceReplacementError(error) ? error.stage : 'unknown',
        message: error instanceof Error ? error.message : String(error),
      });
      this.emit();
      throw error;
    }
  }

  /**
   * Flush on dispose when dirty. Mirrors App unmount flush.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearSaveTimer();
    this.unsubscribeLifecycle?.();
    this.unsubscribeLifecycle = null;
    if (this.phase === 'ready' && this.dirty) {
      this.trace?.record('workspace.dispose.flush');
      void this.flush({ reason: 'dispose' });
    }
    this.listeners.clear();
  }

  /** Test helper: consume one-shot recovery notice from status after read. */
  consumeRecoveryNoticeFromStatus(): string | undefined {
    const notice = this.recoveryNotice;
    this.recoveryNotice = undefined;
    if (notice !== undefined) {
      this.emit();
    }
    return notice;
  }

  private emit(): void {
    this.refreshStatus();
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export { WorkspaceCommitRejectedError, isWorkspaceCommitRejectedError };
export type { WorkspaceCommitPort, WorkspaceCommitOptions, WorkspaceCommitReducer };
