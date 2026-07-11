import type { AppWorkspace } from '../domain/types';
import { isWorkspaceSaveError, type WorkspaceSaveError } from './workspaceSaveError';

export type WorkspaceReplacementFailureStage =
  | 'flush-current'
  | 'build-imported'
  | 'persist-imported';

export class WorkspaceReplacementError extends Error {
  readonly stage: WorkspaceReplacementFailureStage;
  readonly originalError: unknown;

  constructor(stage: WorkspaceReplacementFailureStage, originalError: unknown) {
    const message = originalError instanceof Error ? originalError.message : String(originalError);
    super(message);
    this.name = 'WorkspaceReplacementError';
    this.stage = stage;
    this.originalError = originalError;
  }
}

export function isWorkspaceReplacementError(value: unknown): value is WorkspaceReplacementError {
  return value instanceof WorkspaceReplacementError;
}

export type WorkspaceReplacementPersistenceResult =
  | {
      status: 'committed';
      workspace: AppWorkspace;
    }
  | {
      status: 'committed-with-postcommit-error';
      workspace: AppWorkspace;
      error: WorkspaceSaveError;
    };

export interface PersistWorkspaceReplacementOptions {
  /** Must reject when the current in-memory workspace cannot be durably flushed. */
  flushCurrentWorkspace: () => Promise<void>;
  /** Decrypts and validates the candidate only after the strict flush succeeds. */
  buildImportedWorkspace: () => Promise<AppWorkspace>;
  persistImportedWorkspace: (workspace: AppWorkspace) => Promise<void>;
}

/**
 * Runs the durability-critical part of a complete workspace replacement.
 * A post-commit failure is returned with the imported snapshot so the caller
 * can reconcile its UI with the public snapshot that is already on disk.
 */
export async function persistWorkspaceReplacement({
  flushCurrentWorkspace,
  buildImportedWorkspace,
  persistImportedWorkspace,
}: PersistWorkspaceReplacementOptions): Promise<WorkspaceReplacementPersistenceResult> {
  try {
    await flushCurrentWorkspace();
  } catch (error) {
    throw new WorkspaceReplacementError('flush-current', error);
  }

  let imported: AppWorkspace;
  try {
    imported = await buildImportedWorkspace();
  } catch (error) {
    throw new WorkspaceReplacementError('build-imported', error);
  }

  try {
    await persistImportedWorkspace(imported);
    return { status: 'committed', workspace: imported };
  } catch (error) {
    if (isWorkspaceSaveError(error) && error.publicWorkspaceCommitted) {
      return {
        status: 'committed-with-postcommit-error',
        workspace: imported,
        error,
      };
    }
    throw new WorkspaceReplacementError('persist-imported', error);
  }
}
