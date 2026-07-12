import type { ChatConversation, ChatMessage } from '../domain/types';

export const MAX_BRANCH_TITLE_LENGTH = 60;

export interface ConversationBranchMetadata {
  conversationId: string;
  now: number;
  title?: string;
  createMessageId: (source: ChatMessage, index: number) => string;
  createComparisonGroupId: (sourceGroupId: string) => string;
}

export interface ConversationBranchNode {
  conversation: ChatConversation;
  children: ConversationBranchNode[];
}

function characterSlice(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join('');
}

function requiredGeneratedId(value: string, label: string): string {
  const id = value.trim();
  if (!id) {
    throw new Error(`${label}不能为空。`);
  }
  return id;
}

function cloneMessage(message: ChatMessage, id: string): ChatMessage {
  return {
    ...message,
    id,
    originMessageId: message.originMessageId ?? message.id,
    ...(message.attachments
      ? { attachments: message.attachments.map((attachment) => ({ ...attachment })) }
      : {}),
    ...(message.usage ? { usage: { ...message.usage } } : {}),
    ...(message.citations
      ? { citations: message.citations.map((citation) => ({ ...citation })) }
      : {}),
    ...(message.requestMetrics ? { requestMetrics: { ...message.requestMetrics } } : {}),
    ...(message.costEstimate ? { costEstimate: { ...message.costEstimate } } : {}),
    ...(message.generationTask ? { generationTask: { ...message.generationTask } } : {}),
  };
}

/** The stable identity used to deduplicate inherited usage and generation tasks. */
export function canonicalMessageId(message: ChatMessage): string {
  return message.originMessageId ?? message.id;
}

/**
 * Clones the selected prefix into an independent local conversation branch.
 * Message IDs and comparison-group IDs are always regenerated, while
 * originMessageId retains the canonical request identity for later deduplication.
 */
export function forkConversationAtMessage(
  conversations: readonly ChatConversation[],
  sourceConversationId: string,
  branchPointMessageId: string,
  metadata: ConversationBranchMetadata
): ChatConversation {
  const source = conversations.find((conversation) => conversation.id === sourceConversationId);
  if (!source) {
    throw new Error('找不到要创建分支的对话。');
  }
  const branchPointIndex = source.messages.findIndex(
    (message) => message.id === branchPointMessageId
  );
  if (branchPointIndex < 0 || source.messages[branchPointIndex].id === 'welcome') {
    throw new Error('找不到有效的分支消息。');
  }
  if (source.messages[branchPointIndex].status === 'pending') {
    throw new Error('消息仍在生成中，请从已完成的消息创建分支。');
  }

  const conversationId = requiredGeneratedId(metadata.conversationId, '分支对话 ID');
  if (conversations.some((conversation) => conversation.id === conversationId)) {
    throw new Error('分支对话 ID 已存在。');
  }
  if (!Number.isFinite(metadata.now) || metadata.now < 0) {
    throw new Error('分支时间戳必须是非负有限数字。');
  }

  const usedMessageIds = new Set(
    conversations.flatMap((conversation) => conversation.messages.map((message) => message.id))
  );
  const usedComparisonGroupIds = new Set(
    conversations.flatMap((conversation) =>
      conversation.messages.flatMap((message) =>
        message.comparisonGroupId ? [message.comparisonGroupId] : []
      )
    )
  );
  const comparisonGroupMap = new Map<string, string>();
  const sourcePrefix = source.messages
    .slice(0, branchPointIndex + 1)
    .filter((message) => message.id !== 'welcome');

  const messages = sourcePrefix.map((message, index) => {
    const id = requiredGeneratedId(
      metadata.createMessageId(message, index),
      '分支消息 ID'
    );
    if (usedMessageIds.has(id)) {
      throw new Error(`分支消息 ID 重复：${id}。`);
    }
    usedMessageIds.add(id);
    const clone = cloneMessage(message, id);
    if (message.comparisonGroupId) {
      let groupId = comparisonGroupMap.get(message.comparisonGroupId);
      if (!groupId) {
        groupId = requiredGeneratedId(
          metadata.createComparisonGroupId(message.comparisonGroupId),
          '分支对比组 ID'
        );
        if (usedComparisonGroupIds.has(groupId)) {
          throw new Error(`分支对比组 ID 重复：${groupId}。`);
        }
        usedComparisonGroupIds.add(groupId);
        comparisonGroupMap.set(message.comparisonGroupId, groupId);
      }
      clone.comparisonGroupId = groupId;
    }
    return clone;
  });

  const requestedTitle = metadata.title?.trim();
  const fallbackTitle = `${source.title} · 分支`;
  const title = characterSlice(requestedTitle || fallbackTitle, MAX_BRANCH_TITLE_LENGTH);
  return {
    id: conversationId,
    title,
    ...(source.projectId ? { projectId: source.projectId } : {}),
    parentConversationId: source.id,
    branchPointMessageId,
    createdAt: metadata.now,
    updatedAt: metadata.now,
    messages,
  };
}

function branchSort(
  left: ChatConversation,
  right: ChatConversation
): number {
  return right.updatedAt - left.updatedAt || left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
}

function hasParentCycle(
  conversation: ChatConversation,
  byId: ReadonlyMap<string, ChatConversation>
): boolean {
  const seen = new Set([conversation.id]);
  let parentId = conversation.parentConversationId;
  while (parentId) {
    if (seen.has(parentId)) return true;
    seen.add(parentId);
    parentId = byId.get(parentId)?.parentConversationId;
  }
  return false;
}

/** Builds a cycle-safe forest; orphaned or cyclic branches are promoted to roots. */
export function buildConversationBranchForest(
  conversations: readonly ChatConversation[]
): ConversationBranchNode[] {
  const byId = new Map(conversations.map((conversation) => [conversation.id, conversation] as const));
  const childrenByParent = new Map<string, ChatConversation[]>();
  const roots: ChatConversation[] = [];

  for (const conversation of conversations) {
    const parentId = conversation.parentConversationId;
    if (!parentId || !byId.has(parentId) || parentId === conversation.id || hasParentCycle(conversation, byId)) {
      roots.push(conversation);
      continue;
    }
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push(conversation);
    childrenByParent.set(parentId, siblings);
  }

  const buildNode = (conversation: ChatConversation): ConversationBranchNode => ({
    conversation,
    children: (childrenByParent.get(conversation.id) ?? [])
      .sort(branchSort)
      .map(buildNode),
  });
  return roots.sort(branchSort).map(buildNode);
}

/** Deletes one branch node and reparents its direct children without cascading data loss. */
export function removeConversationPreservingBranches(
  conversations: readonly ChatConversation[],
  conversationId: string
): ChatConversation[] {
  const removed = conversations.find((conversation) => conversation.id === conversationId);
  if (!removed) {
    throw new Error('找不到要删除的对话分支。');
  }
  const fallbackParent = removed.parentConversationId && removed.parentConversationId !== removed.id
    ? conversations.find(
        (conversation) =>
          conversation.id !== removed.id && conversation.id === removed.parentConversationId
      )
    : undefined;
  return conversations
    .filter((conversation) => conversation.id !== conversationId)
    .map((conversation) => {
      if (conversation.parentConversationId !== conversationId) {
        return conversation;
      }
      const next = { ...conversation };
      const removedBranchPoint = removed.messages.find(
        (message) => message.id === conversation.branchPointMessageId
      );
      const mappedBranchPoint = fallbackParent && removedBranchPoint
        ? fallbackParent.messages.find(
            (message) =>
              message.id !== 'welcome' &&
              canonicalMessageId(message) === canonicalMessageId(removedBranchPoint)
          )
        : undefined;
      if (fallbackParent && mappedBranchPoint) {
        next.parentConversationId = fallbackParent.id;
        next.branchPointMessageId = mappedBranchPoint.id;
      } else {
        delete next.parentConversationId;
        delete next.branchPointMessageId;
      }
      return next;
    });
}
