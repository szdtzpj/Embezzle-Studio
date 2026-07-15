import { describe, expect, it } from 'vitest';
import { mutateSessionForTest } from './helpers/workspaceSessionTestHarness';

import type { ApplicationLifecycleListener } from '../src/app/lifecycle/applicationLifecyclePort';
import { MemoryApplicationLifecycleAdapter } from '../src/app/lifecycle/memoryApplicationLifecycleAdapter';
import { FakeClock } from '../src/app/testing/fakeClock';
import { TraceRecorder } from '../src/app/testing/traceRecorder';
import { MemoryWorkspacePersistenceAdapter } from '../src/app/workspace/adapters/memoryWorkspacePersistenceAdapter';
import {
  isWorkspaceCommitRejectedError,
  WorkspaceSession,
  WORKSPACE_SAVE_DEBOUNCE_MS,
} from '../src/app/workspace/WorkspaceSession';
import { createDefaultWorkspace } from '../src/data/providerCatalog';
import { WorkspaceSaveError } from '../src/services/workspaceSaveError';

class CountingApplicationLifecycleAdapter extends MemoryApplicationLifecycleAdapter {
  subscribeCount = 0;
  unsubscribeCount = 0;

  override subscribe(listener: ApplicationLifecycleListener): () => void {
    this.subscribeCount += 1;
    const unsubscribe = super.subscribe(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.unsubscribeCount += 1;
      unsubscribe();
    };
  }
}

function createSession(options: {
  persistence?: MemoryWorkspacePersistenceAdapter;
  clock?: FakeClock;
  lifecycle?: MemoryApplicationLifecycleAdapter;
  trace?: TraceRecorder;
  autoBoot?: boolean;
} = {}) {
  const clock = options.clock ?? new FakeClock();
  const trace = options.trace ?? new TraceRecorder(clock);
  const persistence =
    options.persistence ??
    new MemoryWorkspacePersistenceAdapter({
      initial: createDefaultWorkspace(),
      trace,
    });
  const lifecycle = options.lifecycle ?? new MemoryApplicationLifecycleAdapter();
  const session = new WorkspaceSession({
    persistence,
    clock,
    lifecycle,
    trace,
    autoBoot: options.autoBoot ?? false,
  });
  return { session, persistence, clock, lifecycle, trace };
}

describe('Workspace Session interface', () => {
  it('enters read-only on load failure and never exposes a writable empty workspace', async () => {
    const persistence = new MemoryWorkspacePersistenceAdapter({
      loadError: 'disk unreadable',
    });
    const { session, trace } = createSession({ persistence });

    await session.boot();

    expect(session.getStatus().phase).toBe('read-only');
    expect(session.isWritable()).toBe(false);
    expect(session.getStatus().issue).toContain('disk unreadable');
    expect(session.getSnapshot().projects[0]?.name).toBe('默认项目');

    const port = session.bindCommitPort((workspace, command: { name: string }) => ({
      workspace: {
        ...workspace,
        projects: workspace.projects.map((project, index) =>
          index === 0 ? { ...project, name: command.name } : project
        ),
      },
      result: undefined,
    }));

    await expect(port.execute({ name: 'blocked' })).rejects.toSatisfy(
      (error: unknown) =>
        isWorkspaceCommitRejectedError(error) && error.code === 'read-only'
    );
    expect(persistence.savedSnapshots).toHaveLength(0);
    trace.assertOrder(['workspace.boot.start', 'workspace.boot.read-only']);
  });

  it('boots a loaded snapshot, surfaces recovery notice, and defers save', async () => {
    const stored = createDefaultWorkspace();
    stored.projects[0] = { ...stored.projects[0], name: 'Loaded project' };
    const clock = new FakeClock();
    const trace = new TraceRecorder(clock);
    const persistence = new MemoryWorkspacePersistenceAdapter({
      initial: stored,
      recoveryNotice: '主工作区快照损坏，已自动从最近备份恢复',
      trace,
    });
    const { session } = createSession({ persistence, clock, trace });

    await session.boot();
    expect(session.getStatus().phase).toBe('ready');
    expect(session.getSnapshot().projects[0]?.name).toBe('Loaded project');
    expect(session.getStatus().recoveryNotice).toContain('备份恢复');

    await mutateSessionForTest(session, (current) => ({
      ...current,
      projects: current.projects.map((project, index) =>
        index === 0 ? { ...project, name: 'Dirty' } : project
      ),
    }));
    expect(session.getStatus().dirty).toBe(true);
    expect(persistence.savedSnapshots).toHaveLength(0);

    clock.advance(WORKSPACE_SAVE_DEBOUNCE_MS - 1);
    expect(persistence.savedSnapshots).toHaveLength(0);
    clock.advance(1);
    await session.settle();

    expect(persistence.savedSnapshots).toHaveLength(1);
    expect(persistence.savedSnapshots[0]?.projects[0]?.name).toBe('Dirty');
    expect(session.getStatus().dirty).toBe(false);
    trace.assertOrder([
      'workspace.boot.ready',
      'workspace.commit',
      'workspace.flush.start',
      'persistence.save.success',
      'workspace.flush.success',
    ]);
  });

  it('notifies subscribers when a successful flush clears dirty state', async () => {
    const clock = new FakeClock();
    const { session } = createSession({ clock });
    await session.boot();

    const observedDirtyStates: boolean[] = [];
    const unsubscribe = session.subscribe(() => {
      observedDirtyStates.push(session.getStatus().dirty);
    });

    await mutateSessionForTest(session, (current) => ({
      ...current,
      projects: current.projects.map((project, index) =>
        index === 0 ? { ...project, name: 'Notify after flush' } : project
      ),
    }));
    clock.advance(WORKSPACE_SAVE_DEBOUNCE_MS);
    await session.settle();

    expect(observedDirtyStates).toEqual([true, false]);
    unsubscribe();
  });

  it('keeps concurrent commits dirty when notifying after an earlier flush succeeds', async () => {
    const clock = new FakeClock();
    const persistence = new MemoryWorkspacePersistenceAdapter({
      initial: createDefaultWorkspace(),
    });
    const originalSave = persistence.save.bind(persistence);
    let releaseFirstSave!: () => void;
    const firstSaveGate = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    let markFirstSaveStarted!: () => void;
    const firstSaveStarted = new Promise<void>((resolve) => {
      markFirstSaveStarted = resolve;
    });
    let saveCount = 0;
    persistence.save = async (workspace) => {
      saveCount += 1;
      if (saveCount === 1) {
        markFirstSaveStarted();
        await firstSaveGate;
      }
      await originalSave(workspace);
    };

    const { session } = createSession({ clock, persistence });
    await session.boot();

    const observedDirtyStates: boolean[] = [];
    session.subscribe(() => {
      observedDirtyStates.push(session.getStatus().dirty);
    });

    await mutateSessionForTest(session, (current) => ({
      ...current,
      projects: current.projects.map((project, index) =>
        index === 0 ? { ...project, name: 'First change' } : project
      ),
    }));
    clock.advance(WORKSPACE_SAVE_DEBOUNCE_MS);
    await firstSaveStarted;

    await mutateSessionForTest(session, (current) => ({
      ...current,
      projects: current.projects.map((project, index) =>
        index === 0 ? { ...project, name: 'Concurrent change' } : project
      ),
    }));
    releaseFirstSave();
    await session.settle();

    expect(session.getStatus().dirty).toBe(true);
    expect(observedDirtyStates).toEqual([true, true, true]);
    expect(persistence.savedSnapshots[0]?.projects[0]?.name).toBe('First change');

    clock.advance(WORKSPACE_SAVE_DEBOUNCE_MS);
    await session.settle();
    expect(session.getStatus().dirty).toBe(false);
    expect(observedDirtyStates).toEqual([true, true, true, false]);
    expect(persistence.savedSnapshots.at(-1)?.projects[0]?.name).toBe('Concurrent change');
  });

  it('restores dirty state after a failed deferred save', async () => {
    const clock = new FakeClock();
    const persistence = new MemoryWorkspacePersistenceAdapter({
      initial: createDefaultWorkspace(),
      saveError: 'save failed',
    });
    const { session } = createSession({ persistence, clock });
    await session.boot();

    await mutateSessionForTest(session, (current) => ({
      ...current,
      projects: current.projects.map((project, index) =>
        index === 0 ? { ...project, name: 'Unsaved' } : project
      ),
    }));
    clock.advance(WORKSPACE_SAVE_DEBOUNCE_MS);
    await session.settle();

    expect(session.getStatus().dirty).toBe(true);
    expect(session.getStatus().issue).toContain('save failed');
  });

  it('subscribes to lifecycle events only when boot starts, and only once', async () => {
    const clock = new FakeClock();
    const lifecycle = new CountingApplicationLifecycleAdapter();
    const persistence = new MemoryWorkspacePersistenceAdapter({
      initial: createDefaultWorkspace(),
    });
    const { session } = createSession({ persistence, clock, lifecycle, autoBoot: false });

    expect(lifecycle.subscribeCount).toBe(0);
    lifecycle.emit('background');
    await session.settle();
    expect(persistence.savedSnapshots).toHaveLength(0);

    await session.boot();
    await session.boot();
    expect(lifecycle.subscribeCount).toBe(1);
    await mutateSessionForTest(session, (current) => ({
      ...current,
      projects: current.projects.map((project, index) =>
        index === 0 ? { ...project, name: 'Boot lifecycle' } : project
      ),
    }));
    lifecycle.emit('background');
    await session.settle();

    expect(persistence.savedSnapshots).toHaveLength(1);
    expect(persistence.savedSnapshots[0]?.projects[0]?.name).toBe('Boot lifecycle');

    session.dispose();
    expect(lifecycle.unsubscribeCount).toBe(1);
  });

  it('flushes on background lifecycle events', async () => {
    const clock = new FakeClock();
    const lifecycle = new MemoryApplicationLifecycleAdapter();
    const persistence = new MemoryWorkspacePersistenceAdapter({
      initial: createDefaultWorkspace(),
    });
    const { session, trace } = createSession({ persistence, clock, lifecycle });
    await session.boot();

    await mutateSessionForTest(session, (current) => ({
      ...current,
      projects: current.projects.map((project, index) =>
        index === 0 ? { ...project, name: 'Background' } : project
      ),
    }));
    expect(persistence.savedSnapshots).toHaveLength(0);

    lifecycle.emit('background');
    await session.settle();

    expect(persistence.savedSnapshots).toHaveLength(1);
    expect(persistence.savedSnapshots[0]?.projects[0]?.name).toBe('Background');
    trace.assertOrder(['workspace.flush.start', 'workspace.flush.success']);
  });

  it('keeps deferred background save failures visible through status.issue', async () => {
    const clock = new FakeClock();
    const lifecycle = new MemoryApplicationLifecycleAdapter();
    const persistence = new MemoryWorkspacePersistenceAdapter({
      initial: createDefaultWorkspace(),
      saveError: 'background save failed',
    });
    const { session } = createSession({ persistence, clock, lifecycle });
    await session.boot();

    await mutateSessionForTest(session, (current) => ({
      ...current,
      projects: current.projects.map((project, index) =>
        index === 0 ? { ...project, name: 'Background failure' } : project
      ),
    }));
    lifecycle.emit('background');
    await session.settle();

    expect(session.getStatus()).toMatchObject({
      dirty: true,
      issue: 'background save failed',
    });
  });

  it('required durability finishes before the caller continues', async () => {
    const order: string[] = [];
    const persistence = new MemoryWorkspacePersistenceAdapter({
      initial: createDefaultWorkspace(),
    });
    const originalSave = persistence.save.bind(persistence);
    persistence.save = async (workspace) => {
      order.push('save-start');
      await originalSave(workspace);
      order.push('save-done');
    };
    const { session } = createSession({ persistence });
    await session.boot();

    const port = session.bindCommitPort((workspace, command: { title: string }) => ({
      workspace: {
        ...workspace,
        conversations: workspace.conversations.map((conversation, index) =>
          index === 0 ? { ...conversation, title: command.title } : conversation
        ),
      },
      result: 'ok' as const,
    }));

    order.push('before-execute');
    await port.execute({ title: 'Ledger' }, { durability: 'required' });
    order.push('after-execute');

    expect(order).toEqual(['before-execute', 'save-start', 'save-done', 'after-execute']);
    expect(persistence.savedSnapshots.at(-1)?.conversations[0]?.title).toBe('Ledger');
  });

  it('strict flush runs before import replacement and rejects concurrent commits', async () => {
    const clock = new FakeClock();
    const trace = new TraceRecorder(clock);
    const stored = createDefaultWorkspace();
    stored.projects[0] = { ...stored.projects[0], name: 'Current' };
    const persistence = new MemoryWorkspacePersistenceAdapter({ initial: stored, trace });
    const { session } = createSession({ persistence, clock, trace });
    await session.boot();

    await mutateSessionForTest(session, (current) => ({
      ...current,
      projects: current.projects.map((project, index) =>
        index === 0 ? { ...project, name: 'Dirty-current' } : project
      ),
    }));

    let buildStarted = false;
    const replacePromise = session.replace(async () => {
      buildStarted = true;
      const imported = createDefaultWorkspace();
      imported.projects[0] = { ...imported.projects[0], name: 'Imported' };
      return imported;
    });

    // While replacing, feature commits must reject.
    await expect(
      session
        .bindCommitPort((workspace) => ({ workspace, result: null }))
        .execute(null)
    ).rejects.toSatisfy(
      (error: unknown) =>
        isWorkspaceCommitRejectedError(error) && error.code === 'replacing'
    );

    const result = await replacePromise;
    expect(buildStarted).toBe(true);
    expect(result.status).toBe('committed');
    expect(session.getSnapshot().projects[0]?.name).toBe('Imported');
    expect(session.getStatus().phase).toBe('ready');
    expect(session.isReplacing()).toBe(false);

    // Strict flush of dirty current must precede build/persist of imported.
    const names = trace.names();
    const flushIndex = names.indexOf('workspace.flush.start');
    const buildIndex = names.indexOf('workspace.replace.build-imported');
    const persistIndex = names.indexOf('workspace.replace.persist-imported');
    expect(flushIndex).toBeGreaterThanOrEqual(0);
    expect(flushIndex).toBeLessThan(buildIndex);
    expect(buildIndex).toBeLessThan(persistIndex);

    const savedNames = persistence.savedSnapshots.map((snapshot) => snapshot.projects[0]?.name);
    expect(savedNames[0]).toBe('Dirty-current');
    expect(savedNames.at(-1)).toBe('Imported');
  });

  it('aborts replacement before decrypt when strict flush fails', async () => {
    const persistence = new MemoryWorkspacePersistenceAdapter({
      initial: createDefaultWorkspace(),
      saveError: 'flush blocked',
    });
    const { session } = createSession({ persistence });
    await session.boot();
    await mutateSessionForTest(session, (current) => ({
      ...current,
      projects: current.projects.map((project, index) =>
        index === 0 ? { ...project, name: 'Dirty' } : project
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
    expect(session.getSnapshot().projects[0]?.name).toBe('Dirty');
    expect(session.getStatus().phase).toBe('ready');
  });

  it('reconciles the public snapshot after post-commit replacement errors', async () => {
    const persistence = new MemoryWorkspacePersistenceAdapter({
      initial: createDefaultWorkspace(),
    });
    let saveCount = 0;
    const originalSave = persistence.save.bind(persistence);
    persistence.save = async (workspace) => {
      saveCount += 1;
      // First save is the strict flush of the current workspace; second is import.
      if (saveCount === 2) {
        await originalSave(workspace);
        throw new WorkspaceSaveError('SecureStore write failed', 'after-public-commit');
      }
      return originalSave(workspace);
    };

    const { session } = createSession({ persistence });
    await session.boot();

    const imported = createDefaultWorkspace();
    imported.projects[0] = { ...imported.projects[0], name: 'Postcommit import' };

    const result = await session.replace(async () => imported);
    expect(result.status).toBe('committed-with-postcommit-error');
    expect(session.getSnapshot().projects[0]?.name).toBe('Postcommit import');
    expect(session.getStatus().phase).toBe('ready');
    expect(session.getStatus().issue).toContain('SecureStore write failed');
  });

  it('rejects revision-mismatched commits', async () => {
    const { session } = createSession();
    await session.boot();
    const expected = session.getRevision();

    await mutateSessionForTest(session, (current) => ({
      ...current,
      projects: current.projects.map((project, index) =>
        index === 0 ? { ...project, name: 'Changed' } : project
      ),
    }));

    const port = session.bindCommitPort((workspace, command: { name: string }) => ({
      workspace: {
        ...workspace,
        projects: workspace.projects.map((project, index) =>
          index === 0 ? { ...project, name: command.name } : project
        ),
      },
      result: undefined,
    }));

    await expect(port.execute({ name: 'stale' }, { expectedRevision: expected })).rejects.toSatisfy(
      (error: unknown) =>
        isWorkspaceCommitRejectedError(error) && error.code === 'revision-mismatch'
    );
  });

  it('disposes with a final dirty flush', async () => {
    const persistence = new MemoryWorkspacePersistenceAdapter({
      initial: createDefaultWorkspace(),
    });
    const { session } = createSession({ persistence });
    await session.boot();
    await mutateSessionForTest(session, (current) => ({
      ...current,
      projects: current.projects.map((project, index) =>
        index === 0 ? { ...project, name: 'Unmount' } : project
      ),
    }));
    session.dispose();
    await session.settle();
    expect(persistence.savedSnapshots.some((snapshot) => snapshot.projects[0]?.name === 'Unmount')).toBe(
      true
    );
  });
});
