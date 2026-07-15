import type {
  ChatConversation,
  GenerationTaskInfo,
  MediaAttachment,
} from '../domain/types';
import { canonicalMessageId } from './conversationBranches';

export type GenerationTaskFilter = 'all' | 'active' | 'completed' | 'failed';
export type GenerationTaskState = Exclude<GenerationTaskFilter, 'all'>;

export interface GenerationTaskListItem {
  key: string;
  conversationId: string;
  messageId: string;
  title: string;
  createdAt: number;
  task: GenerationTaskInfo;
  state: GenerationTaskState;
  attachment?: MediaAttachment;
  error?: string;
}

const completedStatuses = new Set(['complete', 'completed', 'done', 'success', 'succeeded']);
const failedStatuses = new Set([
  'blocked',
  'cancelled',
  'canceled',
  'error',
  'expired',
  'failed',
]);

function normalizedProviderStatus(status: string | undefined): string {
  return status?.trim().toLowerCase().replace(/[\s-]+/g, '_') ?? '';
}

export function generationTaskState(
  task: GenerationTaskInfo,
  attachment?: MediaAttachment
): GenerationTaskState {
  if (attachment?.kind === 'video') {
    return 'completed';
  }

  const status = normalizedProviderStatus(task.status);
  if (completedStatuses.has(status)) {
    return 'completed';
  }
  if (failedStatuses.has(status)) {
    return 'failed';
  }
  return 'active';
}

export function isGenerationTaskTerminal(
  taskOrItem: GenerationTaskInfo | GenerationTaskListItem,
  attachment?: MediaAttachment
): boolean {
  if ('state' in taskOrItem) {
    return taskOrItem.state !== 'active';
  }
  return generationTaskState(taskOrItem, attachment) !== 'active';
}

function messageOccurrenceKey(conversationId: string, messageIndex: number): string {
  return JSON.stringify([conversationId, messageIndex]);
}

function findBranchSourceOccurrence(
  conversationsById: ReadonlyMap<string, ChatConversation>,
  conversation: ChatConversation,
  messageIndex: number
): string | undefined {
  const message = conversation.messages[messageIndex];
  const canonicalId = canonicalMessageId(message);
  const visited = new Set<string>([conversation.id]);
  let parentId = conversation.parentConversationId;

  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = conversationsById.get(parentId);
    if (!parent) {
      return undefined;
    }
    const sourceIndex = parent.messages.findIndex(
      (candidate) =>
        !candidate.originMessageId &&
        candidate.id === canonicalId &&
        candidate.role === message.role
    );
    if (sourceIndex >= 0) {
      return messageOccurrenceKey(parent.id, sourceIndex);
    }
    parentId = parent.parentConversationId;
  }
  return undefined;
}

function buildBranchDeduplicationKeys(
  conversations: readonly ChatConversation[]
): ReadonlyMap<string, string> {
  const conversationsById = new Map(
    conversations.map((conversation) => [conversation.id, conversation] as const)
  );
  const keys = new Map<string, string>();

  for (const conversation of conversations) {
    conversation.messages.forEach((message, messageIndex) => {
      if (!message.originMessageId) {
        return;
      }
      const occurrence = messageOccurrenceKey(conversation.id, messageIndex);
      const sourceOccurrence = findBranchSourceOccurrence(
        conversationsById,
        conversation,
        messageIndex
      );
      const groupKey = sourceOccurrence
        ? `source:${sourceOccurrence}`
        : `orphan:${message.role}:${canonicalMessageId(message)}`;
      keys.set(occurrence, groupKey);
      if (sourceOccurrence) {
        keys.set(sourceOccurrence, groupKey);
      }
    });
  }

  return keys;
}

/** Derives the task-center view from persisted conversations without duplicating task state. */
export function deriveGenerationTasks(
  conversations: readonly ChatConversation[]
): GenerationTaskListItem[] {
  const tasks: GenerationTaskListItem[] = [];
  const seenTaskKeys = new Set<string>();
  const branchDeduplicationKeys = buildBranchDeduplicationKeys(conversations);
  const taskOccurrences = conversations.flatMap((conversation) =>
    conversation.messages.flatMap((message, messageIndex) => {
      const generationTask = message.generationTask;
      return generationTask
        ? [{ conversation, message, messageIndex, generationTask }]
        : [];
    })
  );
  // Prefer an original source over an inherited copy when task state is equal.
  taskOccurrences.sort((left, right) => {
    const leftAttachment = left.message.attachments?.find((item) => item.kind === 'video');
    const rightAttachment = right.message.attachments?.find((item) => item.kind === 'video');
    const leftTerminal = generationTaskState(left.generationTask, leftAttachment) !== 'active';
    const rightTerminal = generationTaskState(right.generationTask, rightAttachment) !== 'active';
    return (
      Number(Boolean(rightAttachment)) - Number(Boolean(leftAttachment)) ||
      Number(rightTerminal) - Number(leftTerminal) ||
      Number(Boolean(left.message.originMessageId)) -
        Number(Boolean(right.message.originMessageId))
    );
  });

  for (const { conversation, message, messageIndex, generationTask } of taskOccurrences) {
    const occurrence = messageOccurrenceKey(conversation.id, messageIndex);
    const canonicalId = branchDeduplicationKeys.get(occurrence) ?? `message:${occurrence}`;
    if (seenTaskKeys.has(canonicalId)) {
      continue;
    }
    seenTaskKeys.add(canonicalId);
    const attachment = message.attachments?.find((item) => item.kind === 'video');
    tasks.push({
      key: `${conversation.id}:${message.id}`,
      conversationId: conversation.id,
      messageId: message.id,
      title: conversation.title,
      createdAt: message.createdAt,
      task: generationTask,
      state: generationTaskState(generationTask, attachment),
      ...(attachment ? { attachment } : {}),
      ...(message.error ? { error: message.error } : {}),
    });
  }

  return tasks.sort(
    (left, right) => right.createdAt - left.createdAt || left.key.localeCompare(right.key)
  );
}

export function filterGenerationTasks(
  tasks: readonly GenerationTaskListItem[],
  filter: GenerationTaskFilter
): GenerationTaskListItem[] {
  return filter === 'all' ? [...tasks] : tasks.filter((task) => task.state === filter);
}
