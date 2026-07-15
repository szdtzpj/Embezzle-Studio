import type { WorkspaceCommitPort } from '../../app/workspace/internal/WorkspaceCommitPort';
import type { AppWorkspace } from '../../domain/types';
import {
  changesProjectConversationRequestContext,
  PROJECT_CONVERSATION_HISTORY_LOCK_NOTICE,
  type ProjectConversationCommand,
} from './projectConversationCommands';
import type { ProjectConversationResult } from './projectConversationResults';
import {
  reduceProjectConversationCommand,
  type ProjectConversationReduceContext,
} from './internal/projectConversationReducer';
import { recordGenerationTaskCleanupIntents } from '../../services/generationTaskCleanupJournal';

export interface ProjectsConversationsRuntimeDeps {
  commit: WorkspaceCommitPort<
    { command: ProjectConversationCommand; context: ProjectConversationReduceContext },
    ProjectConversationResult
  >;
  now: () => number;
  createId: (prefix: string) => string;
  isHistoryLocked: () => boolean;
  /** Runs after a durable conversation-delete commit. */
  onConversationDeleted?: (conversationId: string) => Promise<void>;
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

    // A provider request owns the active request context until it settles. Keep
    // the drawer usable for read-only browsing, but reject commands that would
    // switch, rewrite, or fork that context before the request commits.
    if (context.historyLocked && changesProjectConversationRequestContext(command)) {
      return {
        ok: false,
        notice: PROJECT_CONVERSATION_HISTORY_LOCK_NOTICE,
      };
    }

    // Record the destructive intent before the required workspace flush. If
    // that flush fails after mutating the in-memory snapshot, foreground
    // recovery can still tombstone the headless task and reclaim its media.
    if (command.type === 'conversation.delete') {
      await recordGenerationTaskCleanupIntents([
        {
          kind: 'conversation',
          conversationId: command.conversationId,
          createdAt: Date.now(),
        },
      ]);
    }

    const result = await this.deps.commit.execute(
      { command, context },
      command.type === 'conversation.delete' ? { durability: 'required' } : undefined
    );
    if (command.type === 'conversation.delete' && result.ok && this.deps.onConversationDeleted) {
      try {
        await this.deps.onConversationDeleted(command.conversationId);
      } catch {
        // The workspace delete is already durable. Cleanup is retried by the
        // next foreground recovery rather than turning a successful delete
        // into a misleading UI failure.
      }
    }
    return result;
  }
}

export function createProjectsCommitReducer(): (
  workspace: AppWorkspace,
  payload: { command: ProjectConversationCommand; context: ProjectConversationReduceContext }
) => { workspace: AppWorkspace; result: ProjectConversationResult } {
  return (workspace, payload) =>
    reduceProjectConversationCommand(workspace, payload.command, payload.context);
}
