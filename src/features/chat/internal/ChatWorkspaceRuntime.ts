import type {
  AppWorkspace,
  ChatMessage,
  ModelParameterSettings,
  ProviderUsageEvent,
  ReasoningEffort,
} from '../../../domain/types';
import {
  isWorkspaceCommitRejectedError,
  type WorkspaceCommitPort,
} from '../../../app/workspace/internal/WorkspaceCommitPort';
import type { WorkspaceSession } from '../../../app/workspace/WorkspaceSession';
import { defaultParameterSettings } from '../../../data/providerCatalog';
import {
  clearWorkspaceSourceLineage,
  conversationTitleFromMessages,
  orderConversationSystemMessages,
  upsertConversation,
} from '../../projects/projectConversationHelpers';
import { canonicalMessageId } from '../../../services/conversationBranches';

export type ChatWorkspaceCommand =
  | { type: 'model.select'; providerId: string; modelId: string; activateProvider?: boolean }
  | { type: 'comparison.set-enabled'; enabled: boolean }
  | { type: 'comparison.select-answer'; groupId: string; messageId: string }
  | {
      type: 'search.set-mode';
      mode: 'off' | 'provider' | 'external';
      serviceId?: string;
    }
  | {
      type: 'prompt.apply';
      templateId: string;
      conversationId: string;
      systemMessage: ChatMessage;
      now: number;
    }
  | { type: 'usage.replace'; events: ProviderUsageEvent[] }
  | {
      type: 'reasoning.set';
      modelKey: string;
      effort: ReasoningEffort;
    }
  | { type: 'parameters.update'; patch: Partial<ModelParameterSettings> }
  | { type: 'parameters.reset' }
  | {
      type: 'conversation.set-messages';
      conversationId: string;
      messages: ChatMessage[];
      now: number;
      projectId?: string;
      activate?: boolean;
    }
  | {
      type: 'chat.append-messages';
      conversationId: string;
      messages: ChatMessage[];
      now: number;
      projectId?: string;
      removeWelcome?: boolean;
    }
  | { type: 'lineage.clear-message-ids'; messageIds: string[] }
  | {
      type: 'message.update';
      messageId: string;
      patch: Partial<ChatMessage>;
      conversationId?: string;
      now: number;
    }
  | {
      type: 'message.update-generation-copies';
      source: ChatMessage;
      patch: Partial<ChatMessage>;
      now: number;
    }
  | { type: 'message.toggle-context'; messageId: string; mode: 'excluded' | 'pinned'; now: number }
  | { type: 'message.edit-through'; messageId: string; content: string; now: number }
  | { type: 'message.remove-everywhere'; messageId: string; now: number }
  | { type: 'message.remove-through'; messageId: string; now: number };

function updateMessageCopies(
  workspace: AppWorkspace,
  messageId: string,
  update: (message: ChatMessage) => ChatMessage,
  now: number,
  conversationId?: string
): AppWorkspace {
  const messages = workspace.messages.map((message) =>
    message.id === messageId ? update(message) : message
  );
  return {
    ...workspace,
    messages,
    conversations: workspace.conversations.map((conversation) => {
      if (conversationId && conversation.id !== conversationId) {
        return conversation;
      }
      if (!conversation.messages.some((message) => message.id === messageId)) {
        return conversation;
      }
      const conversationMessages = conversation.messages.map((message) =>
        message.id === messageId ? update(message) : message
      );
      return {
        ...conversation,
        title: conversation.customTitle
          ? conversation.title
          : conversationTitleFromMessages(conversationMessages),
        messages: conversationMessages,
        updatedAt: now,
      };
    }),
  };
}


export function reduceChatWorkspaceCommand(
  workspace: AppWorkspace,
  command: ChatWorkspaceCommand
): { workspace: AppWorkspace; result: void } {
  switch (command.type) {
    case 'model.select':
      return {
        result: undefined,
        workspace: {
          ...workspace,
          ...(command.activateProvider ? { activeProviderId: command.providerId } : {}),
          activeModelIdByProvider: {
            ...workspace.activeModelIdByProvider,
            [command.providerId]: command.modelId,
          },
        },
      };
    case 'comparison.set-enabled':
      return { result: undefined, workspace: { ...workspace, comparisonEnabled: command.enabled } };
    case 'comparison.select-answer': {
      const select = (messages: ChatMessage[]) =>
        messages.map((message) =>
          message.role === 'assistant' && message.comparisonGroupId === command.groupId
            ? { ...message, selectedForContext: message.id === command.messageId }
            : message
        );
      return {
        result: undefined,
        workspace: {
          ...workspace,
          messages: select(workspace.messages),
          conversations: workspace.conversations.map((conversation) => ({
            ...conversation,
            messages: select(conversation.messages),
          })),
        },
      };
    }
    case 'search.set-mode':
      return {
        result: undefined,
        workspace: {
          ...workspace,
          webSearch: { ...workspace.webSearch, enabled: command.mode === 'provider' },
          externalSearch: {
            ...workspace.externalSearch,
            enabled: command.mode === 'external',
            ...(command.serviceId ? { selectedServiceId: command.serviceId } : {}),
          },
        },
      };
    case 'prompt.apply': {
      const messages = orderConversationSystemMessages([
        ...workspace.messages.filter((message) => message.promptTemplateId !== command.templateId),
        command.systemMessage,
      ]);
      return {
        result: undefined,
        workspace: {
          ...workspace,
          activeConversationId: command.conversationId,
          messages,
          conversations: upsertConversation(
            workspace.conversations,
            command.conversationId,
            messages,
            command.now
          ),
        },
      };
    }
    case 'usage.replace':
      return { result: undefined, workspace: { ...workspace, providerUsageEvents: command.events } };
    case 'reasoning.set': {
      const reasoningEffortByModel = { ...workspace.reasoningEffortByModel };
      if (command.effort === 'default') delete reasoningEffortByModel[command.modelKey];
      else reasoningEffortByModel[command.modelKey] = command.effort;
      return { result: undefined, workspace: { ...workspace, reasoningEffortByModel } };
    }
    case 'parameters.update':
      return {
        result: undefined,
        workspace: {
          ...workspace,
          parameterSettings: {
            ...defaultParameterSettings,
            ...(workspace.parameterSettings ?? {}),
            ...command.patch,
          },
        },
      };
    case 'parameters.reset':
      return {
        result: undefined,
        workspace: {
          ...workspace,
          parameterSettings: { ...defaultParameterSettings, enabled: true },
        },
      };
    case 'conversation.set-messages': {
      const conversations = upsertConversation(
        workspace.conversations,
        command.conversationId,
        command.messages,
        command.now,
        command.projectId
      );
      return {
        result: undefined,
        workspace: command.activate === false
          ? { ...workspace, conversations }
          : {
              ...workspace,
              activeConversationId: command.conversationId,
              messages: command.messages,
              conversations,
            },
      };
    }
    case 'chat.append-messages': {
      const base = command.removeWelcome
        ? workspace.messages.filter((message) => message.id !== 'welcome')
        : workspace.messages;
      const messages = [...base, ...command.messages];
      return {
        result: undefined,
        workspace: {
          ...workspace,
          activeConversationId: command.conversationId,
          messages,
          conversations: upsertConversation(
            workspace.conversations,
            command.conversationId,
            messages,
            command.now,
            command.projectId ?? workspace.activeProjectId
          ),
        },
      };
    }
    case 'lineage.clear-message-ids':
      return {
        result: undefined,
        workspace: {
          ...workspace,
          ...clearWorkspaceSourceLineage(
            workspace.artifacts,
            workspace.knowledgeSources,
            new Set<string>(),
            new Set(command.messageIds)
          ),
        },
      };
    case 'message.update':
      return {
        result: undefined,
        workspace: updateMessageCopies(
          workspace,
          command.messageId,
          (message) => ({ ...message, ...command.patch }),
          command.now,
          command.conversationId
        ),
      };
    case 'message.update-generation-copies': {
      const canonicalId = canonicalMessageId(command.source);
      const taskId = command.source.generationTask?.taskId;
      const update = (messages: ChatMessage[]) =>
        messages.map((message) =>
          message.role === 'assistant' &&
          canonicalMessageId(message) === canonicalId &&
          (!taskId || message.generationTask?.taskId === taskId)
            ? { ...message, ...command.patch }
            : message
        );
      return {
        result: undefined,
        workspace: {
          ...workspace,
          messages: update(workspace.messages),
          conversations: workspace.conversations.map((conversation) => {
            const messages = update(conversation.messages);
            return messages.some((message, index) => message !== conversation.messages[index])
              ? { ...conversation, messages, updatedAt: command.now }
              : conversation;
          }),
        },
      };
    }
    case 'message.toggle-context': {
      const target = workspace.messages.find((message) => message.id === command.messageId);
      if (!target) return { workspace, result: undefined };
      const enabling =
        command.mode === 'excluded'
          ? target.excludedFromContext !== true
          : target.pinnedForContext !== true;
      const update = (message: ChatMessage): ChatMessage => {
        const next = { ...message };
        if (command.mode === 'excluded') {
          if (enabling) {
            next.excludedFromContext = true;
            delete next.pinnedForContext;
          } else delete next.excludedFromContext;
        } else if (enabling) {
          next.pinnedForContext = true;
          delete next.excludedFromContext;
        } else delete next.pinnedForContext;
        return next;
      };
      const messages = workspace.messages.map((message) =>
        message.id === command.messageId ? update(message) : message
      );
      const conversationId = workspace.activeConversationId || 'conversation-default';
      return {
        result: undefined,
        workspace: {
          ...workspace,
          messages,
          conversations: upsertConversation(
            workspace.conversations,
            conversationId,
            messages,
            command.now,
            workspace.activeProjectId
          ),
        },
      };
    }
    case 'message.edit-through': {
      const index = workspace.messages.findIndex((message) => message.id === command.messageId);
      if (index < 0) return { workspace, result: undefined };
      const messages = workspace.messages.slice(0, index + 1).map((message) =>
        message.id === command.messageId
          ? { ...message, content: command.content, status: 'ready' as const, error: undefined }
          : message
      );
      const conversationId = workspace.activeConversationId || 'conversation-default';
      return {
        result: undefined,
        workspace: {
          ...workspace,
          messages,
          conversations: upsertConversation(
            workspace.conversations,
            conversationId,
            messages,
            command.now
          ),
        },
      };
    }
    case 'message.remove-everywhere': {
      const remove = (messages: ChatMessage[]) =>
        messages.filter((message) => message.id !== command.messageId);
      return {
        result: undefined,
        workspace: {
          ...workspace,
          messages: remove(workspace.messages),
          conversations: workspace.conversations.map((conversation) =>
            conversation.messages.some((message) => message.id === command.messageId)
              ? { ...conversation, messages: remove(conversation.messages), updatedAt: command.now }
              : conversation
          ),
        },
      };
    }
    case 'message.remove-through': {
      const index = workspace.messages.findIndex((message) => message.id === command.messageId);
      if (index < 0) return { workspace, result: undefined };
      const removed = workspace.messages.slice(index);
      const messages = workspace.messages.slice(0, index);
      const conversationId = workspace.activeConversationId || 'conversation-default';
      return {
        result: undefined,
        workspace: {
          ...workspace,
          ...clearWorkspaceSourceLineage(
            workspace.artifacts,
            workspace.knowledgeSources,
            new Set<string>(),
            new Set(removed.map((message) => message.id))
          ),
          messages,
          conversations: upsertConversation(
            workspace.conversations,
            conversationId,
            messages,
            command.now
          ),
        },
      };
    }
    default: {
      const exhaustive: never = command;
      throw new Error(`Unknown Chat workspace command: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Feature-private closed command runtime. Visual code can submit semantic
 * commands, but cannot submit reducers, callbacks, or arbitrary workspaces.
 */
export class ChatWorkspaceRuntime {
  private readonly commit: WorkspaceCommitPort<ChatWorkspaceCommand, void>;

  constructor(private readonly session: WorkspaceSession) {
    this.commit = session.bindCommitPort(reduceChatWorkspaceCommand);
  }

  async execute(command: ChatWorkspaceCommand): Promise<boolean> {
    try {
      await this.commit.execute(command);
      return true;
    } catch (error) {
      if (isWorkspaceCommitRejectedError(error)) return false;
      throw error;
    }
  }

  flush(options: { propagateFailure?: boolean } = {}): Promise<void> {
    return this.session.flush({
      reason: 'chat',
      propagateFailure: options.propagateFailure,
    });
  }
}
