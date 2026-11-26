import { useMemo, useSyncExternalStore } from 'react';

import type {
  ActivityTimelineStep,
  AppWorkspace,
  ChatMessage,
  ChatTokenUsage,
  MediaAttachment,
  ModelParameterSettings,
  ProviderUsageEvent,
  ReasoningEffort,
  ToolActivityItem,
  WebCitation,
} from '../../../domain/types';
import {
  isWorkspaceCommitRejectedError,
  type WorkspaceCommitPort,
  type WorkspaceCommitOptions,
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
import { upsertConversationDraft } from '../../../services/workspaceProductState';
import {
  cleanupIntentsForMessages,
  recordGenerationTaskCleanupIntents,
} from '../../../services/generationTaskCleanupJournal';

/** 流式期间隔离的草稿增量切片（不落盘、不广播 WorkspaceSession）。 */
export interface StreamingMessageDraft {
  conversationId: string;
  messageId: string;
  content: string;
  reasoningContent?: string;
  thinkingDurationMs?: number;
  usage?: ChatTokenUsage;
  citations?: WebCitation[];
  webSearchTriggered?: boolean;
  toolActivity?: ToolActivityItem[];
  activityTimeline?: ActivityTimelineStep[];
  status: 'pending';
  updatedAt: number;
}

/** 兼容 Partial<ChatMessage> 与极简流式补丁；存储层统一归一为 pending 状态。 */
export type StreamingDraftPatch = Partial<
  Pick<
    ChatMessage,
    | 'content'
    | 'reasoningContent'
    | 'thinkingDurationMs'
    | 'usage'
    | 'citations'
    | 'webSearchTriggered'
    | 'toolActivity'
    | 'activityTimeline'
    | 'status'
  >
>;

export interface StreamingDraftStore {
  publish(conversationId: string, messageId: string, patch: StreamingDraftPatch): void;
  get(conversationId: string, messageId: string): StreamingMessageDraft | null;
  clear(conversationId: string, messageId?: string): void;
  clearAll(): void;
  subscribe(conversationId: string, messageId: string, listener: () => void): () => void;
}

/**
 * 创建独立的流式草稿外部存储，按 (conversationId, messageId) 精确通知订阅者，
 * 避免流式增量写入污染 WorkspaceSession 或触发整树重渲染。
 */
export function createStreamingDraftStore(): StreamingDraftStore {
  const draftsByConversation = new Map<string, Map<string, StreamingMessageDraft>>();
  const listenersByConversation = new Map<string, Map<string, Set<() => void>>>();

  const getDraft = (conversationId: string, messageId: string): StreamingMessageDraft | null => {
    if (!conversationId || !messageId) return null;
    return draftsByConversation.get(conversationId)?.get(messageId) ?? null;
  };

  const notifyMessageListeners = (conversationId: string, messageId: string): void => {
    const listeners = listenersByConversation.get(conversationId)?.get(messageId);
    if (!listeners || listeners.size === 0) return;
    // 复制监听者快照再通知，避免回调内部取消订阅影响迭代
    for (const listener of [...listeners]) {
      listener();
    }
  };

  return {
    publish(conversationId: string, messageId: string, patch: StreamingDraftPatch): void {
      if (!conversationId || !messageId) return;
      const prev = getDraft(conversationId, messageId);
      const next: StreamingMessageDraft = {
        ...(prev ?? {}),
        ...patch,
        conversationId,
        messageId,
        content: patch.content ?? prev?.content ?? '',
        status: 'pending',
        updatedAt: Date.now(),
      };
      let convDrafts = draftsByConversation.get(conversationId);
      if (!convDrafts) {
        convDrafts = new Map<string, StreamingMessageDraft>();
        draftsByConversation.set(conversationId, convDrafts);
      }
      convDrafts.set(messageId, next);
      notifyMessageListeners(conversationId, messageId);
    },

    get: getDraft,

    clear(conversationId: string, messageId?: string): void {
      if (!conversationId) return;
      const convDrafts = draftsByConversation.get(conversationId);
      if (!convDrafts || convDrafts.size === 0) return;

      if (messageId !== undefined) {
        if (!convDrafts.delete(messageId)) return;
        if (convDrafts.size === 0) {
          draftsByConversation.delete(conversationId);
        }
        notifyMessageListeners(conversationId, messageId);
        return;
      }

      const clearedIds = [...convDrafts.keys()];
      draftsByConversation.delete(conversationId);
      for (const id of clearedIds) {
        notifyMessageListeners(conversationId, id);
      }
    },

    clearAll(): void {
      if (draftsByConversation.size === 0) return;
      const targets: Array<[string, string]> = [];
      for (const [conversationId, convDrafts] of draftsByConversation) {
        for (const messageId of convDrafts.keys()) {
          targets.push([conversationId, messageId]);
        }
      }
      draftsByConversation.clear();
      for (const [conversationId, messageId] of targets) {
        notifyMessageListeners(conversationId, messageId);
      }
    },

    subscribe(conversationId: string, messageId: string, listener: () => void): () => void {
      if (!conversationId || !messageId) {
        return () => undefined;
      }
      let convListeners = listenersByConversation.get(conversationId);
      if (!convListeners) {
        convListeners = new Map<string, Set<() => void>>();
        listenersByConversation.set(conversationId, convListeners);
      }
      let msgListeners = convListeners.get(messageId);
      if (!msgListeners) {
        msgListeners = new Set<() => void>();
        convListeners.set(messageId, msgListeners);
      }
      msgListeners.add(listener);

      return () => {
        const currentConvListeners = listenersByConversation.get(conversationId);
        const currentMsgListeners = currentConvListeners?.get(messageId);
        if (!currentMsgListeners) return;
        currentMsgListeners.delete(listener);
        if (currentMsgListeners.size === 0) {
          currentConvListeners?.delete(messageId);
        }
        if (currentConvListeners && currentConvListeners.size === 0) {
          listenersByConversation.delete(conversationId);
        }
      };
    },
  };
}

/** 全局流式草稿单例存储。 */
export const streamingDraftStore = createStreamingDraftStore();

/** 向指定会话与消息发布流式增量草稿。 */
export function publishStreamingDraft(
  conversationId: string,
  messageId: string,
  patch: StreamingDraftPatch
): void {
  streamingDraftStore.publish(conversationId, messageId, patch);
}

/** 清理指定会话或单条消息的流式草稿。 */
export function clearStreamingDraft(conversationId: string, messageId?: string): void {
  streamingDraftStore.clear(conversationId, messageId);
}

/**
 * 订阅单条消息的流式草稿切片；仅当该 (conversationId, messageId) 草稿变化时触发组件更新。
 * 注意：仅使用 useMemo 与 useSyncExternalStore，保持快照订阅引用稳定且兼容精简测试桩。
 */
export function useStreamingDraftSelector(
  conversationId: string | undefined,
  messageId: string | undefined
): StreamingMessageDraft | null {
  const subscribe = useMemo(
    () => (listener: () => void) =>
      conversationId && messageId
        ? streamingDraftStore.subscribe(conversationId, messageId, listener)
        : () => undefined,
    [conversationId, messageId]
  );
  const getSnapshot = useMemo(
    () => () =>
      conversationId && messageId
        ? streamingDraftStore.get(conversationId, messageId)
        : null,
    [conversationId, messageId]
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

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
  | { type: 'message.remove-through'; messageId: string; now: number }
  | {
      type: 'draft.set';
      conversationId: string;
      text: string;
      now: number;
      attachments?: MediaAttachment[];
    };

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
    case 'draft.set':
      return {
        result: undefined,
        workspace: {
          ...workspace,
          composerDrafts: upsertConversationDraft(
            workspace.composerDrafts,
            command.conversationId,
            command.text,
            command.now,
            command.attachments
          ),
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
          // The composer payload is now represented by the committed user
          // message; clear its durable draft in this same snapshot so a crash
          // after send cannot restore already-sent attachments.
          composerDrafts: workspace.composerDrafts.filter(
            (draft) => draft.conversationId !== command.conversationId
          ),
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

  async execute(command: ChatWorkspaceCommand, options?: WorkspaceCommitOptions): Promise<boolean> {
    try {
      const before = this.session.getSnapshot();
      const intents = cleanupIntentsForChatCommand(before, command);
      if (intents.length) await recordGenerationTaskCleanupIntents(intents);
      await this.commit.execute(command, options);
      clearStreamingDraftsForCommittedCommand(before, command);
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

/** 终态或覆盖/删除指令提交成功后，联动清理对应流式草稿防止残影复用。 */
function clearStreamingDraftsForCommittedCommand(
  before: AppWorkspace,
  command: ChatWorkspaceCommand
): void {
  const activeConversationId = before.activeConversationId || 'conversation-default';
  switch (command.type) {
    case 'message.update': {
      if (command.patch.status && command.patch.status !== 'pending') {
        streamingDraftStore.clear(
          command.conversationId ?? activeConversationId,
          command.messageId
        );
      }
      return;
    }
    case 'conversation.set-messages': {
      streamingDraftStore.clear(command.conversationId);
      return;
    }
    case 'message.remove-through':
    case 'message.edit-through': {
      const index = before.messages.findIndex((message) => message.id === command.messageId);
      if (index >= 0) {
        for (const message of before.messages.slice(index)) {
          streamingDraftStore.clear(activeConversationId, message.id);
        }
      }
      return;
    }
    case 'message.remove-everywhere': {
      streamingDraftStore.clear(activeConversationId, command.messageId);
      for (const conversation of before.conversations) {
        if (conversation.messages.some((message) => message.id === command.messageId)) {
          streamingDraftStore.clear(conversation.id, command.messageId);
        }
      }
      return;
    }
    default:
      return;
  }
}

function cleanupIntentsForChatCommand(
  workspace: AppWorkspace,
  command: ChatWorkspaceCommand
) {
  const conversationId = workspace.activeConversationId || 'conversation-default';
  const byId = (messageId: string) => workspace.messages.find((message) => message.id === messageId);
  switch (command.type) {
    case 'message.remove-everywhere': {
      const messages = [
        ...workspace.messages.filter((message) => message.id === command.messageId),
        ...workspace.conversations.flatMap((conversation) =>
          conversation.messages.filter((message) => message.id === command.messageId)
        ),
      ];
      return cleanupIntentsForMessages(messages, conversationId);
    }
    case 'message.remove-through':
    case 'message.edit-through': {
      const index = workspace.messages.findIndex((message) => message.id === command.messageId);
      return index < 0 ? [] : cleanupIntentsForMessages(workspace.messages.slice(index), conversationId);
    }
    case 'message.update': {
      const message = byId(command.messageId);
      return message && Object.prototype.hasOwnProperty.call(command.patch, 'generationTask') &&
        command.patch.generationTask === undefined
        ? cleanupIntentsForMessages([message], command.conversationId ?? conversationId)
        : [];
    }
    case 'message.update-generation-copies':
      return Object.prototype.hasOwnProperty.call(command.patch, 'generationTask') &&
        command.patch.generationTask === undefined
        ? cleanupIntentsForMessages([command.source], conversationId)
        : [];
    case 'conversation.set-messages': {
      const existing = workspace.conversations.find((conversation) => conversation.id === command.conversationId);
      if (!existing) return [];
      const nextIds = new Set(command.messages.map((message) => message.id));
      return cleanupIntentsForMessages(
        existing.messages.filter((message) => !nextIds.has(message.id)),
        command.conversationId
      );
    }
    default:
      return [];
  }
}
