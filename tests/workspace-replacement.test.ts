import { describe, expect, it, vi } from 'vitest';

import { createDefaultWorkspace } from '../src/data/providerCatalog';
import { persistWorkspaceReplacement } from '../src/services/workspaceReplacement';
import { WorkspaceSaveError } from '../src/services/workspaceSaveError';

describe('workspace replacement persistence boundary', () => {
  it('aborts before decrypting or persisting when the strict current-workspace flush fails', async () => {
    const flushCurrentWorkspace = vi.fn(async () => {
      throw new Error('current workspace flush failed');
    });
    const buildImportedWorkspace = vi.fn(async () => createDefaultWorkspace());
    const persistImportedWorkspace = vi.fn(async () => undefined);

    const result = persistWorkspaceReplacement({
      flushCurrentWorkspace,
      buildImportedWorkspace,
      persistImportedWorkspace,
    });

    await expect(result).rejects.toMatchObject({
      name: 'WorkspaceReplacementError',
      stage: 'flush-current',
      message: 'current workspace flush failed',
    });
    expect(flushCurrentWorkspace).toHaveBeenCalledOnce();
    expect(buildImportedWorkspace).not.toHaveBeenCalled();
    expect(persistImportedWorkspace).not.toHaveBeenCalled();
  });

  it('returns the imported snapshot for UI reconciliation after a public commit with postcommit failure', async () => {
    const imported = createDefaultWorkspace();
    imported.projects[0] = { ...imported.projects[0], name: 'Committed import' };
    const postcommitError = new WorkspaceSaveError(
      'SecureStore write failed',
      'after-public-commit'
    );

    const result = await persistWorkspaceReplacement({
      flushCurrentWorkspace: vi.fn(async () => undefined),
      buildImportedWorkspace: vi.fn(async () => imported),
      persistImportedWorkspace: vi.fn(async () => {
        throw postcommitError;
      }),
    });

    expect(result).toEqual({
      status: 'committed-with-postcommit-error',
      workspace: imported,
      error: postcommitError,
    });
  });

  it('does not reconcile an imported snapshot when persistence fails before the public commit', async () => {
    const result = persistWorkspaceReplacement({
      flushCurrentWorkspace: vi.fn(async () => undefined),
      buildImportedWorkspace: vi.fn(async () => createDefaultWorkspace()),
      persistImportedWorkspace: vi.fn(async () => {
        throw new WorkspaceSaveError('primary write failed', 'before-public-commit');
      }),
    });

    await expect(result).rejects.toMatchObject({
      stage: 'persist-imported',
      message: 'primary write failed',
    });
  });
});
