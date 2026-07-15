import { createContext, useContext } from 'react';

import type { WorkspaceSession } from '../WorkspaceSession';

export interface WorkspaceSessionContextValue {
  readonly session: WorkspaceSession;
}

export const WorkspaceSessionContext = createContext<WorkspaceSessionContextValue | null>(
  null
);

/**
 * Feature-internal escape hatch for command runtimes that need the complete
 * WorkspaceSession. Visual/public code should consume selectors and status
 * from WorkspaceSessionProvider instead.
 */
export function useWorkspaceSession(): WorkspaceSession {
  const value = useContext(WorkspaceSessionContext);
  if (!value) {
    throw new Error('useWorkspaceSession requires WorkspaceSessionProvider.');
  }
  return value.session;
}
