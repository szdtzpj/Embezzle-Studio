import React, {
  createContext,
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
import type { WorkspaceStatus } from './workspaceStatus';

export interface WorkspaceSessionProviderAdapters {
  persistence: WorkspacePersistenceAdapter;
  lifecycle?: ApplicationLifecyclePort;
  clock?: WorkspaceSessionClock;
}

interface WorkspaceSessionContextValue {
  session: WorkspaceSession;
}

const WorkspaceSessionContext = createContext<WorkspaceSessionContextValue | null>(null);

export function WorkspaceSessionProvider(props: {
  adapters: WorkspaceSessionProviderAdapters;
  children: ReactNode;
  /** Optional pre-built session for tests. */
  session?: WorkspaceSession;
}): React.ReactElement {
  const { adapters, children, session: injected } = props;
  const sessionRef = useRef<WorkspaceSession | null>(injected ?? null);

  if (!sessionRef.current) {
    sessionRef.current = new WorkspaceSession({
      persistence: adapters.persistence,
      lifecycle: adapters.lifecycle,
      clock: adapters.clock,
      autoBoot: true,
    });
  }

  const session = sessionRef.current;
  useEffect(() => {
    if (injected) {
      return undefined;
    }
    return () => {
      session.dispose();
    };
  }, [injected, session]);

  const value = useMemo(() => ({ session }), [session]);

  return (
    <WorkspaceSessionContext.Provider value={value}>
      {children}
    </WorkspaceSessionContext.Provider>
  );
}

function useWorkspaceSessionContext(): WorkspaceSessionContextValue {
  const value = useContext(WorkspaceSessionContext);
  if (!value) {
    throw new Error('WorkspaceSession hooks require WorkspaceSessionProvider.');
  }
  return value;
}

export function useWorkspaceSession(): WorkspaceSession {
  return useWorkspaceSessionContext().session;
}

export function useWorkspaceSelector<T>(selector: (workspace: AppWorkspace) => T): T {
  const session = useWorkspaceSession();
  const selectorRef = useRef(selector);
  selectorRef.current = selector;

  const subscribe = useMemo(() => session.subscribe.bind(session), [session]);
  const getSnapshot = useMemo(
    () => () => selectorRef.current(session.getSnapshot()),
    [session]
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useWorkspaceStatus(): WorkspaceStatus {
  const session = useWorkspaceSession();
  const subscribe = useMemo(() => session.subscribe.bind(session), [session]);
  const getSnapshot = useMemo(() => () => session.getStatus(), [session]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
