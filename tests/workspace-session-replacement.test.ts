import { describe, expect, it } from 'vitest';
import { mutateSessionForTest } from './helpers/workspaceSessionTestHarness';

import { FakeClock } from '../src/app/testing/fakeClock';
import { TraceRecorder } from '../src/app/testing/traceRecorder';
import { MemoryWorkspacePersistenceAdapter } from '../src/app/workspace/adapters/memoryWorkspacePersistenceAdapter';
import {
  isWorkspaceCommitRejectedError,
  WorkspaceSession,
} from '../src/app/workspace/WorkspaceSession';
import { createDefaultWorkspace } from '../src/data/providerCatalog';

/**
 * Replaces App.tsx source-slicing coverage for import replacement wiring.
 */
describe('Workspace Session replacement transaction', () => {
  it('uses a strict pre-import flush and reconciles UI after postcommit failure', async () => {
    const clock = new FakeClock();
    const trace = new TraceRecorder(clock);
    const persistence = new MemoryWorkspacePersistenceAdapter({
      initial: createDefaultWorkspace(),
      trace,
    });
    let saves = 0;
    const originalSave = persistence.save.bind(persistence);
    persistence.save = async (workspace) => {
      saves += 1;
      await originalSave(workspace);
      if (saves >= 2) {
        const { WorkspaceSaveError } = await import('../src/services/workspaceSaveError');
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
        index === 0 ? { ...project, name: 'Before import' } : project
      ),
    }));

    const imported = createDefaultWorkspace();
    imported.projects[0] = { ...imported.projects[0], name: 'Imported workspace' };

    const replacement = await session.replace(async () => imported);

    expect(replacement.status).toBe('committed-with-postcommit-error');
    expect(session.getSnapshot().projects[0]?.name).toBe('Imported workspace');
    expect(session.isWritable()).toBe(true);

    const names = trace.names();
    expect(names.indexOf('workspace.flush.start')).toBeLessThan(
      names.indexOf('workspace.replace.build-imported')
    );
    expect(names.indexOf('workspace.replace.build-imported')).toBeLessThan(
      names.indexOf('workspace.replace.persist-imported')
    );
    expect(names.indexOf('workspace.replace.persist-imported')).toBeLessThan(
      names.indexOf('workspace.replace.committed')
    );
  });

  it('fails closed while replacement is active for commits', async () => {
    const persistence = new MemoryWorkspacePersistenceAdapter({
      initial: createDefaultWorkspace(),
    });
    let releaseBuild!: () => void;
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });

    const session = new WorkspaceSession({
      persistence,
      autoBoot: false,
    });
    await session.boot();

    const replacePromise = session.replace(async () => {
      await buildGate;
      const imported = createDefaultWorkspace();
      imported.projects[0] = { ...imported.projects[0], name: 'Later' };
      return imported;
    });

    expect(session.isReplacing()).toBe(true);
    expect(session.isWritable()).toBe(false);

    await expect(
      mutateSessionForTest(session, (current) => ({
        ...current,
        projects: current.projects.map((project, index) =>
          index === 0 ? { ...project, name: 'blocked' } : project
        ),
      }))
    ).rejects.toSatisfy(
      (error: unknown) =>
        isWorkspaceCommitRejectedError(error) && error.code === 'replacing'
    );
    expect(session.getSnapshot().projects[0]?.name).not.toBe('blocked');

    releaseBuild();
    await replacePromise;
    expect(session.getSnapshot().projects[0]?.name).toBe('Later');
  });
});
