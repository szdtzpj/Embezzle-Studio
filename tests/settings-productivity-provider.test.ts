import { describe, expect, it, vi } from 'vitest';

import { MemoryWorkspacePersistenceAdapter } from '../src/app/workspace/adapters/memoryWorkspacePersistenceAdapter';
import { WorkspaceSession } from '../src/app/workspace/WorkspaceSession';
import { createDefaultWorkspace } from '../src/data/providerCatalog';
import { attemptSettingsCloseCommit } from '../src/features/settings/SettingsProductivityProvider';
import { SettingsWorkspaceRuntime } from '../src/features/settings/internal/SettingsWorkspaceRuntime';
import { mutateSessionForTest } from './helpers/workspaceSessionTestHarness';

function bindLifecycleCommit(session: WorkspaceSession) {
  return session.bindCommitPort<{ type: 'provider.ensure-active-enabled' }, void>(
    (workspace) => ({ workspace, result: undefined })
  );
}

describe('Settings productivity lifecycle', () => {
  it('reuses the Settings runtime to reconcile a disabled active provider', async () => {
    const session = new WorkspaceSession({
      persistence: new MemoryWorkspacePersistenceAdapter({ initial: createDefaultWorkspace() }),
      autoBoot: false,
    });
    await session.boot();
    await mutateSessionForTest(session, (workspace) => ({
      ...workspace,
      activeProviderId: workspace.providers[0].id,
      providers: workspace.providers.map((provider, index) => ({
        ...provider,
        enabled: index !== 0,
      })),
    }));
    const runtime = new SettingsWorkspaceRuntime(session);

    await attemptSettingsCloseCommit(runtime);

    expect(session.getSnapshot().activeProviderId).toBe(session.getSnapshot().providers[1].id);
  });

  it('still executes the active-provider reconciliation when close is writable', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);

    await attemptSettingsCloseCommit({ execute });

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith({ type: 'provider.ensure-active-enabled' });
  });

  it('settles close commits rejected while booting, read-only, or replacing', async () => {
    const reportUnexpectedError = vi.fn();

    const bootingSession = new WorkspaceSession({
      persistence: new MemoryWorkspacePersistenceAdapter(),
      autoBoot: false,
    });
    await expect(
      attemptSettingsCloseCommit(bindLifecycleCommit(bootingSession), reportUnexpectedError)
    ).resolves.toBeUndefined();

    const readOnlySession = new WorkspaceSession({
      persistence: new MemoryWorkspacePersistenceAdapter({ loadError: 'unreadable' }),
      autoBoot: false,
    });
    await readOnlySession.boot();
    await expect(
      attemptSettingsCloseCommit(bindLifecycleCommit(readOnlySession), reportUnexpectedError)
    ).resolves.toBeUndefined();

    let releaseReplacement!: () => void;
    const replacementGate = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    const replacingSession = new WorkspaceSession({
      persistence: new MemoryWorkspacePersistenceAdapter({
        initial: createDefaultWorkspace(),
      }),
      autoBoot: false,
    });
    await replacingSession.boot();
    const replacement = replacingSession.replace(async () => {
      await replacementGate;
      return createDefaultWorkspace();
    });
    await expect(
      attemptSettingsCloseCommit(bindLifecycleCommit(replacingSession), reportUnexpectedError)
    ).resolves.toBeUndefined();
    releaseReplacement();
    await replacement;

    expect(reportUnexpectedError).not.toHaveBeenCalled();
  });

  it('reports unexpected close-commit failures without leaking a rejected promise', async () => {
    const failure = new Error('unexpected reducer failure');
    const reportUnexpectedError = vi.fn();

    await expect(
      attemptSettingsCloseCommit(
        { execute: () => Promise.reject(failure) },
        reportUnexpectedError
      )
    ).resolves.toBeUndefined();

    expect(reportUnexpectedError).toHaveBeenCalledOnce();
    expect(reportUnexpectedError).toHaveBeenCalledWith(failure);
  });
});
