import type { AppWorkspace } from '../../../domain/types';

export type WorkspaceCommitDurability = 'deferred' | 'required';

export interface WorkspaceCommitOptions {
  expectedRevision?: number;
  durability?: WorkspaceCommitDurability;
}

/**
 * Feature-private write capability. Bound to one feature's command type and reducer.
 * Visual code must not construct arbitrary AppWorkspace values through this port.
 */
export interface WorkspaceCommitPort<C, R> {
  execute(command: C, options?: WorkspaceCommitOptions): Promise<R>;
}

export type WorkspaceCommitReducer<C, R> = (
  workspace: AppWorkspace,
  command: C
) => { workspace: AppWorkspace; result: R };

export class WorkspaceCommitRejectedError extends Error {
  readonly code:
    | 'read-only'
    | 'replacing'
    | 'revision-mismatch'
    | 'not-ready';

  constructor(code: WorkspaceCommitRejectedError['code'], message: string) {
    super(message);
    this.name = 'WorkspaceCommitRejectedError';
    this.code = code;
  }
}

export function isWorkspaceCommitRejectedError(
  value: unknown
): value is WorkspaceCommitRejectedError {
  return value instanceof WorkspaceCommitRejectedError;
}
