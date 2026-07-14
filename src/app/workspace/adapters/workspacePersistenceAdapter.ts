import type { AppWorkspace } from '../../../domain/types';

/**
 * Persistence seam for Workspace Session.
 * Production wraps storage.ts; tests use the in-memory adapter.
 */
export interface WorkspacePersistenceAdapter {
  load(): Promise<AppWorkspace | null>;
  save(workspace: AppWorkspace): Promise<void>;
  consumeRecoveryNotice(): string | null;
}
