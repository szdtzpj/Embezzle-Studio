import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import {
  isWorkspaceCommitRejectedError,
} from '../../app/workspace/internal/WorkspaceCommitPort';
import {
  useWorkspaceSession,
  useWorkspaceStatus,
} from '../../app/workspace/WorkspaceSessionProvider';
import { createId } from '../../services/id';
import type { ProjectConversationCommand } from './projectConversationCommands';
import type { ProjectConversationResult } from './projectConversationResults';
import {
  createProjectsCommitReducer,
  ProjectsConversationsRuntime,
} from './ProjectsConversationsRuntime';

export interface ProjectsConversationsPorts {
  /** True while a provider request holds history mutation lock. */
  isHistoryLocked: () => boolean;
}

const unlockedProjectsPorts: ProjectsConversationsPorts = {
  isHistoryLocked: () => false,
};

interface ProjectsConversationsContextValue {
  drawerOpen: boolean;
  openDrawer(): void;
  closeDrawer(): void;
  execute(command: ProjectConversationCommand): Promise<ProjectConversationResult>;
}

const ProjectsConversationsContext = createContext<ProjectsConversationsContextValue | null>(
  null
);

export function ProjectsConversationsProvider(props: {
  children: ReactNode;
  ports?: ProjectsConversationsPorts;
}): React.ReactElement {
  const { children, ports = unlockedProjectsPorts } = props;
  const session = useWorkspaceSession();
  const workspaceStatus = useWorkspaceStatus();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const runtime = useMemo(() => {
    const commit = session.bindCommitPort(createProjectsCommitReducer());
    return new ProjectsConversationsRuntime({
      commit,
      now: () => Date.now(),
      createId,
      isHistoryLocked: ports.isHistoryLocked,
    });
  }, [ports.isHistoryLocked, session]);

  const execute = useCallback(
    async (command: ProjectConversationCommand): Promise<ProjectConversationResult> => {
      if (workspaceStatus.phase === 'replacing') {
        return {
          ok: false,
          notice: '正在验证并导入备份，暂时不能修改工作区。',
        };
      }
      if (workspaceStatus.phase !== 'ready') {
        return {
          ok: false,
          notice: '工作区加载失败，当前为只读模式，无法保存更改。',
        };
      }
      try {
        return await runtime.execute(command);
      } catch (error) {
        if (isWorkspaceCommitRejectedError(error)) {
          return { ok: false, notice: error.message };
        }
        return {
          ok: false,
          notice: error instanceof Error ? error.message : '项目或对话操作失败。',
        };
      }
    },
    [runtime, workspaceStatus.phase]
  );

  const value = useMemo<ProjectsConversationsContextValue>(
    () => ({
      drawerOpen,
      openDrawer: () => setDrawerOpen(true),
      closeDrawer: () => setDrawerOpen(false),
      execute,
    }),
    [drawerOpen, execute]
  );

  return (
    <ProjectsConversationsContext.Provider value={value}>
      {children}
    </ProjectsConversationsContext.Provider>
  );
}

export function useProjectConversationNavigation(): ProjectsConversationsContextValue {
  const value = useContext(ProjectsConversationsContext);
  if (!value) {
    throw new Error(
      'useProjectConversationNavigation requires ProjectsConversationsProvider.'
    );
  }
  return value;
}
