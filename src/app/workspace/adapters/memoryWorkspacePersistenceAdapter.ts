import type { AppWorkspace } from '../../../domain/types';
import type { TraceRecorder } from '../../testing/traceRecorder';
import type { WorkspacePersistenceAdapter } from './workspacePersistenceAdapter';

export interface MemoryWorkspacePersistenceOptions {
  initial?: AppWorkspace | null;
  loadError?: Error | string | null;
  saveError?: Error | string | null | ((workspace: AppWorkspace, saveCount: number) => Error | string | null);
  /** When true, save throws WorkspaceSaveError-style after "public commit". */
  postCommitSaveError?: Error | string | null;
  recoveryNotice?: string | null;
  trace?: TraceRecorder;
}

/**
 * In-memory Workspace persistence for characterization and session tests.
 * Does not touch AsyncStorage or SecureStore.
 */
export class MemoryWorkspacePersistenceAdapter implements WorkspacePersistenceAdapter {
  private snapshot: AppWorkspace | null;
  private recoveryNotice: string | null;
  private loadError: Error | string | null;
  private saveError: MemoryWorkspacePersistenceOptions['saveError'];
  private postCommitSaveError: Error | string | null;
  private readonly trace?: TraceRecorder;
  private saveCount = 0;
  private saveQueue: Promise<void> = Promise.resolve();

  readonly savedSnapshots: AppWorkspace[] = [];

  constructor(options: MemoryWorkspacePersistenceOptions = {}) {
    this.snapshot = options.initial ?? null;
    this.recoveryNotice = options.recoveryNotice ?? null;
    this.loadError = options.loadError ?? null;
    this.saveError = options.saveError ?? null;
    this.postCommitSaveError = options.postCommitSaveError ?? null;
    this.trace = options.trace;
  }

  getStoredSnapshot(): AppWorkspace | null {
    return this.snapshot;
  }

  setLoadError(error: Error | string | null): void {
    this.loadError = error;
  }

  setSaveError(
    error: MemoryWorkspacePersistenceOptions['saveError']
  ): void {
    this.saveError = error;
  }

  setPostCommitSaveError(error: Error | string | null): void {
    this.postCommitSaveError = error;
  }

  setStoredSnapshot(workspace: AppWorkspace | null): void {
    this.snapshot = workspace;
  }

  async load(): Promise<AppWorkspace | null> {
    this.trace?.record('persistence.load.start');
    if (this.loadError) {
      const error = toError(this.loadError);
      this.trace?.record('persistence.load.error', { message: error.message });
      throw error;
    }
    this.trace?.record('persistence.load.success', {
      hasSnapshot: this.snapshot !== null,
    });
    return this.snapshot ? cloneWorkspace(this.snapshot) : null;
  }

  consumeRecoveryNotice(): string | null {
    const notice = this.recoveryNotice;
    this.recoveryNotice = null;
    if (notice) {
      this.trace?.record('persistence.recovery-notice', { notice });
    }
    return notice;
  }

  save(workspace: AppWorkspace): Promise<void> {
    const queued = this.saveQueue
      .catch(() => undefined)
      .then(async () => {
        this.saveCount += 1;
        this.trace?.record('persistence.save.start', { saveCount: this.saveCount });

        const preError = resolveSaveError(this.saveError, workspace, this.saveCount);
        if (preError) {
          this.trace?.record('persistence.save.error', {
            stage: 'before-public-commit',
            message: preError.message,
          });
          throw preError;
        }

        this.snapshot = cloneWorkspace(workspace);
        this.savedSnapshots.push(cloneWorkspace(workspace));
        this.trace?.record('persistence.save.public-committed', { saveCount: this.saveCount });

        if (this.postCommitSaveError) {
          const error = toError(this.postCommitSaveError);
          this.trace?.record('persistence.save.error', {
            stage: 'after-public-commit',
            message: error.message,
          });
          const { WorkspaceSaveError } = await import('../../../services/workspaceSaveError');
          throw new WorkspaceSaveError(error.message, 'after-public-commit', error);
        }

        this.trace?.record('persistence.save.success', { saveCount: this.saveCount });
      });
    this.saveQueue = queued;
    return queued;
  }
}

function resolveSaveError(
  saveError: MemoryWorkspacePersistenceOptions['saveError'],
  workspace: AppWorkspace,
  saveCount: number
): Error | null {
  if (!saveError) {
    return null;
  }
  if (typeof saveError === 'function') {
    const result = saveError(workspace, saveCount);
    return result ? toError(result) : null;
  }
  return toError(saveError);
}

function toError(value: Error | string): Error {
  return value instanceof Error ? value : new Error(value);
}

function cloneWorkspace(workspace: AppWorkspace): AppWorkspace {
  return JSON.parse(JSON.stringify(workspace)) as AppWorkspace;
}
