import type {
  AppWorkspace,
  ChatConversation,
  ChatMessage,
  MediaAttachment,
  ProjectKnowledgeSource,
  WorkspaceArtifact,
  WorkspaceProject,
} from '../../domain/types';

export const MAX_SAVED_CONVERSATIONS = 100;

export function isConversationMessage(message: ChatMessage): boolean {
  return (
    message.id !== 'welcome' &&
    message.role !== 'system' &&
    (message.content.trim().length > 0 ||
      Boolean(message.attachments?.length) ||
      Boolean(message.reasoningContent?.trim()) ||
      Boolean(message.generationTask) ||
      Boolean(message.error))
  );
}

export function hasConversationHistory(conversation: ChatConversation): boolean {
  return conversation.messages.some(isConversationMessage);
}

export function messageAttachments(messages: ChatMessage[]): MediaAttachment[] {
  return messages.flatMap((message) => message.attachments ?? []);
}

export function sortConversations(conversations: ChatConversation[]): ChatConversation[] {
  return [...conversations].sort(
    (a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) || b.updatedAt - a.updatedAt
  );
}

export function conversationTitleFromMessages(messages: ChatMessage[]): string {
  const userMessage = messages.find(
    (message) => message.role === 'user' && (message.content.trim() || message.attachments?.length)
  );

  if (userMessage?.content.trim()) {
    const title = userMessage.content.trim().replace(/\s+/g, ' ');
    return title.length > 28 ? `${title.slice(0, 28)}...` : title;
  }

  if (userMessage?.attachments?.length) {
    return '附件对话';
  }

  return '新对话';
}

export function upsertConversation(
  conversations: ChatConversation[],
  conversationId: string,
  messages: ChatMessage[],
  updatedAt: number,
  projectId?: string
): ChatConversation[] {
  const existing = conversations.find((conversation) => conversation.id === conversationId);
  const firstTimestamp = messages[0]?.createdAt;
  const conversation: ChatConversation = {
    ...existing,
    id: conversationId,
    ...(existing?.projectId || projectId ? { projectId: existing?.projectId ?? projectId } : {}),
    title: existing?.customTitle ? existing.title : conversationTitleFromMessages(messages),
    createdAt: existing?.createdAt ?? firstTimestamp ?? updatedAt,
    updatedAt,
    messages,
  };

  return sortConversations([
    conversation,
    ...conversations.filter((item) => item.id !== conversationId),
  ]);
}

export function clearWorkspaceSourceLineage(
  artifacts: readonly WorkspaceArtifact[],
  knowledgeSources: readonly ProjectKnowledgeSource[],
  conversationIds: ReadonlySet<string>,
  messageIds: ReadonlySet<string>
): Pick<AppWorkspace, 'artifacts' | 'knowledgeSources'> {
  const artifactsNext = artifacts.map((artifact) => {
    const next = { ...artifact };
    if (next.sourceConversationId && conversationIds.has(next.sourceConversationId)) {
      delete next.sourceConversationId;
    }
    if (next.sourceMessageId && messageIds.has(next.sourceMessageId)) {
      delete next.sourceMessageId;
    }
    next.revisions = artifact.revisions.map((revision) => {
      if (!revision.sourceMessageId || !messageIds.has(revision.sourceMessageId)) {
        return { ...revision };
      }
      const revisionNext = { ...revision };
      delete revisionNext.sourceMessageId;
      return revisionNext;
    });
    return next;
  });
  const knowledgeNext = knowledgeSources.map((source) => {
    const next = { ...source };
    if (next.sourceConversationId && conversationIds.has(next.sourceConversationId)) {
      delete next.sourceConversationId;
    }
    if (next.sourceMessageId && messageIds.has(next.sourceMessageId)) {
      delete next.sourceMessageId;
    }
    return next;
  });
  return { artifacts: artifactsNext, knowledgeSources: knowledgeNext };
}

export function projectInstructionMessage(
  project: WorkspaceProject,
  now: number,
  createId: (prefix: string) => string
): ChatMessage | undefined {
  const content = project.systemPrompt?.trim();
  if (!content) {
    return undefined;
  }
  return {
    id: createId('project-system'),
    role: 'system',
    content,
    createdAt: now,
    status: 'ready',
    projectInstructionId: project.id,
  };
}

export function orderConversationSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  const welcome = messages.filter((message) => message.id === 'welcome');
  const projectInstructions = messages.filter(
    (message) => message.id !== 'welcome' && Boolean(message.projectInstructionId)
  );
  const otherSystemMessages = messages.filter(
    (message) =>
      message.id !== 'welcome' &&
      !message.projectInstructionId &&
      message.role === 'system'
  );
  const conversational = messages.filter(
    (message) => message.id !== 'welcome' && message.role !== 'system'
  );
  return [...welcome, ...projectInstructions, ...otherSystemMessages, ...conversational];
}

export function syncProjectInstructionSnapshot(
  messages: ChatMessage[],
  project: WorkspaceProject,
  now: number,
  createId: (prefix: string) => string
): ChatMessage[] {
  const retained = messages.filter((message) => !message.projectInstructionId);
  const instruction = projectInstructionMessage(project, now, createId);
  return orderConversationSystemMessages(instruction ? [instruction, ...retained] : retained);
}
