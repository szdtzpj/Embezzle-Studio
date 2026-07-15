import React, {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import type { AppWorkspace } from '../../domain/types';
import type { ApplicationLifecyclePort } from '../lifecycle/applicationLifecyclePort';
import type { WorkspacePersistenceAdapter } from './adapters/workspacePersistenceAdapter';
import { WorkspaceSession, type WorkspaceSessionClock } from './WorkspaceSession';
import {
  WorkspaceSessionContext,
  type WorkspaceSessionContextValue,
} from './internal/WorkspaceSessionContext';
import type { WorkspaceStatus } from './workspaceStatus';

export interface WorkspaceSessionProviderAdapters {
  persistence: WorkspacePersistenceAdapter;
  lifecycle?: ApplicationLifecyclePort;
  clock?: WorkspaceSessionClock;
}

export function WorkspaceSessionProvider(props: {
  adapters: WorkspaceSessionProviderAdapters;
  children: ReactNode;
  /** Optional pre-built session for tests. */
  session?: WorkspaceSession;
}): React.ReactElement {
  const { adapters, children, session: injected } = props;
  const sessionRef = useRef<WorkspaceSession | null>(injected ?? null);
  const ownsSessionRef = useRef(injected === undefined);

  if (!sessionRef.current) {
    // Construction must stay side-effect free. Boot and lifecycle subscription
    // begin from the committed effect below, never during render.
    sessionRef.current = new WorkspaceSession({
      persistence: adapters.persistence,
      lifecycle: adapters.lifecycle,
      clock: adapters.clock,
      autoBoot: false,
    });
  }

  const session = sessionRef.current;
  const strictModeGuardRef = useRef({ disposeEpoch: 0 });
  useEffect(() => {
    const guard = strictModeGuardRef.current;
    const epoch = ++guard.disposeEpoch;
    const ownsSession = ownsSessionRef.current;
    void session.boot();
    return () => {
      if (!ownsSession) {
        return;
      }
      // React StrictMode replays effects synchronously. Deferring disposal by
      // one microtask avoids tearing down the same render-owned session during
      // that replay while still disposing it on a real unmount.
      void Promise.resolve().then(() => {
        if (guard.disposeEpoch === epoch) {
          session.dispose();
        }
      });
    };
  }, [session]);

  const value = useMemo<WorkspaceSessionContextValue>(() => ({ session }), [session]);

  return (
    <WorkspaceSessionContext.Provider value={value}>
      {children}
    </WorkspaceSessionContext.Provider>
  );
}

export function useWorkspaceSelector<T>(selector: (workspace: AppWorkspace) => T): T {
  const session = useContext(WorkspaceSessionContext)?.session;
  if (!session) {
    throw new Error('useWorkspaceSelector requires WorkspaceSessionProvider.');
  }

  const subscribe = useMemo(() => session.subscribe.bind(session), [session]);
  const getSnapshot = useMemo(() => () => session.getSnapshot(), [session]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // Subscribe to the complete stable workspace snapshot first. Running a
  // selector inside getSnapshot would make React compare arbitrary selector
  // results and violates useSyncExternalStore's snapshot contract.
  return selector(snapshot);
}

export function useWorkspaceStatus(): WorkspaceStatus {
  const session = useContext(WorkspaceSessionContext)?.session;
  if (!session) {
    throw new Error('useWorkspaceStatus requires WorkspaceSessionProvider.');
  }
  const subscribe = useMemo(() => session.subscribe.bind(session), [session]);
  const getSnapshot = useMemo(() => () => session.getStatus(), [session]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
