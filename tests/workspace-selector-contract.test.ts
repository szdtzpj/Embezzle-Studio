import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkspaceSession } from '../src/app/workspace/WorkspaceSession';
import { useWorkspaceSelector } from '../src/app/workspace/WorkspaceSessionProvider';
import { createDefaultWorkspace } from '../src/data/providerCatalog';

const reactHarness = vi.hoisted(() => ({
  contextValue: null as unknown,
  snapshotReads: [] as unknown[],
}));

vi.mock('react', () => ({
  default: {},
  createContext: (defaultValue: unknown) => ({ defaultValue }),
  useContext: () => reactHarness.contextValue,
  useEffect: () => undefined,
  useMemo: (factory: () => unknown) => factory(),
  useRef: (initialValue: unknown) => ({ current: initialValue }),
  useSyncExternalStore: (
    _subscribe: (listener: () => void) => () => void,
    getSnapshot: () => unknown
  ) => {
    const first = getSnapshot();
    const second = getSnapshot();
    reactHarness.snapshotReads = [first, second];
    if (first !== second) {
      throw new Error('External-store snapshots must be referentially stable.');
    }
    return first;
  },
}));

describe('Workspace selector external-store contract', () => {
  beforeEach(() => {
    reactHarness.contextValue = null;
    reactHarness.snapshotReads = [];
  });

  it('subscribes with the stable full snapshot before creating array or object selections', () => {
    const snapshot = createDefaultWorkspace();
    const session = {
      getSnapshot: () => snapshot,
      subscribe: () => () => undefined,
    } as unknown as WorkspaceSession;
    reactHarness.contextValue = { session };

    const projectIds = useWorkspaceSelector((workspace) =>
      workspace.projects.map((project) => project.id)
    );
    expect(projectIds).toEqual(snapshot.projects.map((project) => project.id));
    expect(reactHarness.snapshotReads).toEqual([snapshot, snapshot]);

    const summary = useWorkspaceSelector((workspace) => ({
      projectCount: workspace.projects.length,
      activeProjectId: workspace.activeProjectId,
    }));
    expect(summary).toEqual({
      projectCount: snapshot.projects.length,
      activeProjectId: snapshot.activeProjectId,
    });
    expect(reactHarness.snapshotReads).toEqual([snapshot, snapshot]);
  });
});
