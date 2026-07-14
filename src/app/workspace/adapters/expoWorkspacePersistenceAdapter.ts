import {
  consumeStorageRecoveryNotice,
  loadWorkspace,
  saveWorkspace,
} from '../../../services/storage';
import type { WorkspacePersistenceAdapter } from './workspacePersistenceAdapter';

/**
 * Production persistence adapter. Wraps storage.ts without rewriting schema or secrets.
 */
export function createExpoWorkspacePersistenceAdapter(): WorkspacePersistenceAdapter {
  return {
    load: () => loadWorkspace(),
    save: (workspace) => saveWorkspace(workspace),
    consumeRecoveryNotice: () => consumeStorageRecoveryNotice(),
  };
}
