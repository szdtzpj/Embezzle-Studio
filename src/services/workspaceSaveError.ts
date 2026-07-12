export type WorkspaceSaveCommitStage = 'before-public-commit' | 'after-public-commit';

/**
 * Distinguishes a rejected save that left the public workspace untouched from
 * one whose AsyncStorage primary snapshot was already committed. Callers that
 * replace the complete workspace must reconcile their in-memory state after
 * an `after-public-commit` failure instead of claiming that nothing changed.
 */
export class WorkspaceSaveError extends Error {
  readonly commitStage: WorkspaceSaveCommitStage;
  readonly originalError: unknown;

  constructor(
    message: string,
    commitStage: WorkspaceSaveCommitStage,
    originalError?: unknown
  ) {
    super(message);
    this.name = 'WorkspaceSaveError';
    this.commitStage = commitStage;
    this.originalError = originalError;
  }

  get publicWorkspaceCommitted(): boolean {
    return this.commitStage === 'after-public-commit';
  }
}

export function isWorkspaceSaveError(value: unknown): value is WorkspaceSaveError {
  return value instanceof WorkspaceSaveError;
}

export function toWorkspaceSaveError(
  value: unknown,
  commitStage: WorkspaceSaveCommitStage
): WorkspaceSaveError {
  if (isWorkspaceSaveError(value)) {
    if (value.publicWorkspaceCommitted || commitStage === 'before-public-commit') {
      return value;
    }
  }
  const message = value instanceof Error ? value.message : String(value);
  return new WorkspaceSaveError(message, commitStage, value);
}
