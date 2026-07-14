import { describe, expect, it } from 'vitest';
import { mutateSessionForTest } from './helpers/workspaceSessionTestHarness';

import { FakeClock } from '../src/app/testing/fakeClock';
import { TraceRecorder } from '../src/app/testing/traceRecorder';
import { MemoryWorkspacePersistenceAdapter } from '../src/app/workspace/adapters/memoryWorkspacePersistenceAdapter';
import { WorkspaceSession } from '../src/app/workspace/WorkspaceSession';
import { createDefaultWorkspace } from '../src/data/providerCatalog';
import { WorkspaceSaveError } from '../src/services/workspaceSaveError';

/**
 * Replaces App.tsx source assertions for import transaction wiring.
 */
describe('App workspace import transaction wiring', () => {
  it('uses a strict pre-import flush and reconciles the UI after postcommit failure', async () => {
    const clock = new FakeClock();
    const trace = new TraceRecorder(clock);
    const persistence = new MemoryWorkspacePersistenceAdapter({
      initial: createDefaultWorkspace(),
      trace,
    });
    let saveCount = 0;
    const originalSave = persistence.save.bind(persistence);
    persistence.save = async (workspace) => {
      saveCount += 1;
      await originalSave(workspace);
      if (saveCount >= 2) {
        throw new WorkspaceSaveError('凭据收尾失败', 'after-public-commit');
      }
    };

    const session = new WorkspaceSession({
      persistence,
      clock,
      trace,
      autoBoot: false,
    });
    await session.boot();

    await mutateSessionForTest(session, (current) => ({
      ...current,
      projects: current.projects.map((project, index) =>
        index === 0 ? { ...project, name: 'Pre-import dirty' } : project
      ),
    }));

    const imported = createDefaultWorkspace();
    imported.projects[0] = { ...imported.projects[0], name: 'Imported snapshot' };

    const replacement = await session.replace(async () => imported);

    expect(replacement.status).toBe('committed-with-postcommit-error');
    expect(session.getSnapshot().projects[0]?.name).toBe('Imported snapshot');
    expect(session.isWritable()).toBe(true);
    expect(session.getStatus().issue).toContain('凭据收尾失败');

    // Strict flush of current must run before imported build/persist.
    const names = trace.names();
    expect(names.indexOf('workspace.flush.start')).toBeLessThan(
      names.indexOf('workspace.replace.build-imported')
    );
    expect(names.indexOf('workspace.replace.build-imported')).toBeLessThan(
      names.indexOf('workspace.replace.persist-imported')
    );

    // First durable snapshot is the dirty current workspace; last public commit is imported.
    expect(persistence.savedSnapshots[0]?.projects[0]?.name).toBe('Pre-import dirty');
    expect(persistence.getStoredSnapshot()?.projects[0]?.name).toBe('Imported snapshot');
  });

  it('aborts before decrypt when the current workspace cannot be flushed', async () => {
    const persistence = new MemoryWorkspacePersistenceAdapter({
      initial: createDefaultWorkspace(),
      saveError: 'current workspace flush failed',
    });
    const session = new WorkspaceSession({
      persistence,
      autoBoot: false,
    });
    await session.boot();
    await mutateSessionForTest(session, (current) => ({
      ...current,
      projects: current.projects.map((project, index) =>
        index === 0 ? { ...project, name: 'Unflushed' } : project
      ),
    }));

    let built = false;
    await expect(
      session.replace(async () => {
        built = true;
        return createDefaultWorkspace();
      })
    ).rejects.toMatchObject({
      name: 'WorkspaceReplacementError',
      stage: 'flush-current',
    });

    expect(built).toBe(false);
    expect(session.getSnapshot().projects[0]?.name).toBe('Unflushed');
    expect(session.getStatus().phase).toBe('ready');
  });
});
