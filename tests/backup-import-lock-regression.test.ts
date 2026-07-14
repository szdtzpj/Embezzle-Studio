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
 * Replaces App.tsx source slicing: replacement lock spans strict flush →
 * build → persist → snapshot apply, and rejects concurrent mutations.
 */
describe('encrypted backup import replacement lock', () => {
  it('holds the replacement lock from the final in-flight check through persistence and state replacement', async () => {
    const clock = new FakeClock();
    const trace = new TraceRecorder(clock);
    const persistence = new MemoryWorkspacePersistenceAdapter({
      initial: createDefaultWorkspace(),
      trace,
    });
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
        index === 0 ? { ...project, name: 'Dirty-before-import' } : project
      ),
    }));

    let releaseBuild!: () => void;
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });

    const replacePromise = session.replace(async () => {
      await buildGate;
      const imported = createDefaultWorkspace();
      imported.projects[0] = { ...imported.projects[0], name: 'Imported-locked' };
      return imported;
    });

    expect(session.isReplacing()).toBe(true);
    expect(session.isWritable()).toBe(false);

    releaseBuild();
    const result = await replacePromise;

    expect(result.status).toBe('committed');
    expect(session.getSnapshot().projects[0]?.name).toBe('Imported-locked');
    expect(session.isReplacing()).toBe(false);
    expect(session.isWritable()).toBe(true);

    const names = trace.names();
    const replaceStart = names.indexOf('workspace.replace.start');
    const flushStart = names.indexOf('workspace.flush.start');
    const buildImported = names.indexOf('workspace.replace.build-imported');
    const persistImported = names.indexOf('workspace.replace.persist-imported');
    const committed = names.indexOf('workspace.replace.committed');

    expect(replaceStart).toBeGreaterThanOrEqual(0);
    expect(replaceStart).toBeLessThan(flushStart);
    expect(flushStart).toBeLessThan(buildImported);
    expect(buildImported).toBeLessThan(persistImported);
    expect(persistImported).toBeLessThan(committed);
  });

  it('fails closed at every request and mutation entry point while replacement is active', async () => {
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
      return createDefaultWorkspace();
    });

    expect(session.isReplacing()).toBe(true);

    // Feature commits reject while replacing.
    await expect(
      session
        .bindCommitPort((workspace, command: { name: string }) => ({
          workspace: {
            ...workspace,
            projects: workspace.projects.map((project, index) =>
              index === 0 ? { ...project, name: command.name } : project
            ),
          },
          result: undefined,
        }))
        .execute({ name: 'blocked' })
    ).rejects.toSatisfy(
      (error: unknown) =>
        isWorkspaceCommitRejectedError(error) && error.code === 'replacing'
    );

    // Every feature-private commit capability rejects while replacing.
    const before = session.getSnapshot().projects[0]?.name;
    await expect(
      mutateSessionForTest(session, (current) => ({
        ...current,
        projects: current.projects.map((project, index) =>
          index === 0 ? { ...project, name: 'should-not-apply' } : project
        ),
      }))
    ).rejects.toSatisfy(
      (error: unknown) =>
        isWorkspaceCommitRejectedError(error) && error.code === 'replacing'
    );
    expect(session.getSnapshot().projects[0]?.name).toBe(before);

    releaseBuild();
    await replacePromise;
    expect(session.isReplacing()).toBe(false);
  });
});
