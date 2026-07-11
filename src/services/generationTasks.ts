import type {
  ChatConversation,
  GenerationTaskInfo,
  MediaAttachment,
} from '../domain/types';

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
const failedStatuses = new Set(['cancelled', 'canceled', 'error', 'expired', 'failed']);

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

/** Derives the task-center view from persisted conversations without duplicating task state. */
export function deriveGenerationTasks(
  conversations: readonly ChatConversation[]
): GenerationTaskListItem[] {
  const tasks: GenerationTaskListItem[] = [];

  for (const conversation of conversations) {
    for (const message of conversation.messages) {
      if (!message.generationTask) {
        continue;
      }
      const attachment = message.attachments?.find((item) => item.kind === 'video');
      tasks.push({
        key: `${conversation.id}:${message.id}`,
        conversationId: conversation.id,
        messageId: message.id,
        title: conversation.title,
        createdAt: message.createdAt,
        task: message.generationTask,
        state: generationTaskState(message.generationTask, attachment),
        ...(attachment ? { attachment } : {}),
        ...(message.error ? { error: message.error } : {}),
      });
    }
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
