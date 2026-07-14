import type { WorkspaceCommitPort } from '../../app/workspace/internal/WorkspaceCommitPort';
import type { AppWorkspace } from '../../domain/types';
import type { ProjectConversationCommand } from './projectConversationCommands';
import type { ProjectConversationResult } from './projectConversationResults';
import {
  reduceProjectConversationCommand,
  type ProjectConversationReduceContext,
} from './internal/projectConversationReducer';

export interface ProjectsConversationsRuntimeDeps {
  commit: WorkspaceCommitPort<
    { command: ProjectConversationCommand; context: ProjectConversationReduceContext },
    ProjectConversationResult
  >;
  now: () => number;
  createId: (prefix: string) => string;
  isHistoryLocked: () => boolean;
}

/**
 * Deep module runtime for Local Projects + Conversation Branches.
 * Owns semantic validation and submits typed commits through Workspace Session.
 */
export class ProjectsConversationsRuntime {
  constructor(private readonly deps: ProjectsConversationsRuntimeDeps) {}

  async execute(command: ProjectConversationCommand): Promise<ProjectConversationResult> {
    const context: ProjectConversationReduceContext = {
      now: this.deps.now(),
      createId: this.deps.createId,
      historyLocked: this.deps.isHistoryLocked(),
    };

    if (
      (command.type === 'conversation.delete' || command.type === 'project.delete') &&
      context.historyLocked
    ) {
      return {
        ok: false,
        notice:
          command.type === 'conversation.delete'
            ? '当前仍有服务商请求进行中；本次删除未执行。'
            : '当前仍有服务商请求进行中；请先停止或等待完成，再删除项目。',
      };
    }

    return this.deps.commit.execute({ command, context });
  }
}

export function createProjectsCommitReducer(): (
  workspace: AppWorkspace,
  payload: { command: ProjectConversationCommand; context: ProjectConversationReduceContext }
) => { workspace: AppWorkspace; result: ProjectConversationResult } {
  return (workspace, payload) =>
    reduceProjectConversationCommand(workspace, payload.command, payload.context);
}
