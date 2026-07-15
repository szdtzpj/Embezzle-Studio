import { describe, expect, it, vi } from 'vitest';

import {
  classifyGenerationTaskQueryError,
  orderGenerationTaskCandidates,
  retryPendingGenerationTaskNotifications,
} from '../src/services/generationTaskBackground';
import type { GenerationTaskListItem } from '../src/services/generationTasks';
import type { GenerationTaskOutboxEntry } from '../src/services/generationTaskOutbox';
import type { GenerationTaskInfo } from '../src/domain/types';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-background-task', () => ({
  BackgroundTaskResult: { Success: 1, Failed: 2 },
  registerTaskAsync: vi.fn(async () => undefined),
  unregisterTaskAsync: vi.fn(async () => undefined),
}));
vi.mock('expo-task-manager', () => ({
  isTaskDefined: vi.fn(() => false),
  defineTask: vi.fn(),
  isTaskRegisteredAsync: vi.fn(async () => false),
}));
vi.mock('../src/services/storage', () => ({ loadWorkspace: vi.fn(async () => null) }));
vi.mock('../src/services/openAiCompatible', () => ({
  isAbortError: vi.fn(() => false),
  queryGenerationTask: vi.fn(),
}));
vi.mock('../src/services/generationTaskNotifications', () => ({
  notifyGenerationTaskCompletedOrFailed: vi.fn(async () => 'skipped'),
}));

function taskForTest(taskId = 'task-a'): GenerationTaskInfo {
  return {
    providerId: 'provider',
    modelId: 'model',
    taskId,
    kind: 'video',
  };
}

describe('generation task background classification', () => {
  it('retries unsent terminal notifications without selecting provider work', async () => {
    const entries = [
      {
        id: 'completed:message-a',
        conversationId: 'conversation-a',
        messageId: 'message-a',
        taskId: 'task-a',
        providerId: 'provider',
        modelId: 'model',
        state: 'completed' as const,
        generationTask: { ...taskForTest(), status: 'succeeded' },
        attemptCount: 1,
        createdAt: 1,
        updatedAt: 1,
        notificationState: 'failed' as const,
      },
      {
        id: 'failed:message-b',
        conversationId: 'conversation-b',
        messageId: 'message-b',
        taskId: 'task-b',
        providerId: 'provider',
        modelId: 'model',
        state: 'failed' as const,
        generationTask: { ...taskForTest('task-b'), status: 'failed' },
        attemptCount: 1,
        createdAt: 1,
        updatedAt: 1,
        notificationState: 'sent' as const,
      },
      {
        id: 'pending:message-c',
        conversationId: 'conversation-c',
        messageId: 'message-c',
        taskId: 'task-c',
        providerId: 'provider',
        modelId: 'model',
        state: 'pending' as const,
        generationTask: { ...taskForTest('task-c'), status: 'running' },
        attemptCount: 1,
        createdAt: 1,
        updatedAt: 1,
        notificationState: 'failed' as const,
      },
    ] satisfies GenerationTaskOutboxEntry[];
    const retried: string[] = [];
    await expect(
      retryPendingGenerationTaskNotifications(entries, async (entry) => {
        retried.push(entry.id);
      })
    ).resolves.toBe(1);
    expect(retried).toEqual(['completed:message-a']);
  });

  it('blocks credential/permission failures until the user fixes settings', () => {
    expect(classifyGenerationTaskQueryError(new Error('HTTP 401 unauthorized'))).toMatchObject({
      state: 'blocked',
    });
    expect(classifyGenerationTaskQueryError(new Error('provider is disabled'))).toMatchObject({
      state: 'blocked',
    });
  });

  it('treats provider terminal task states as failed and networks as retryable', () => {
    expect(classifyGenerationTaskQueryError(new Error('任务已过期'))).toMatchObject({
      state: 'failed',
    });
    expect(classifyGenerationTaskQueryError(new Error('HTTP 404 task not found'))).toMatchObject({
      state: 'failed',
    });
    expect(classifyGenerationTaskQueryError(new Error('network timeout'))).toMatchObject({
      state: 'pending',
    });
  });

  it('rotates past scheduled retries so later active tasks are not starved', () => {
    const items = Array.from({ length: 10 }, (_, index) => ({
      key: `conversation-${index}:message-${index}`,
      conversationId: `conversation-${index}`,
      messageId: `message-${index}`,
      title: 'test',
      createdAt: 1_000 - index,
      state: 'active',
      task: {
        providerId: 'provider',
        modelId: 'model',
        taskId: `task-${index}`,
        kind: 'video',
      },
    })) as GenerationTaskListItem[];
    const existing = new Map<string, GenerationTaskOutboxEntry>();
    for (const item of items.slice(0, 8)) {
      existing.set(`${item.task.taskId}:${item.messageId}`, {
        id: `${item.task.taskId}:${item.messageId}`,
        conversationId: item.conversationId,
        messageId: item.messageId,
        taskId: item.task.taskId,
        providerId: item.task.providerId,
        modelId: item.task.modelId,
        state: 'pending',
        generationTask: { ...item.task, nextCheckAt: 9_999, lastCheckedAt: 900 },
        attemptCount: 1,
        createdAt: 900,
        updatedAt: 900,
      });
    }

    const ordered = orderGenerationTaskCandidates(items, existing, 1_000).slice(0, 8);
    expect(ordered.some((item) => item.task.taskId === 'task-8')).toBe(true);
    expect(ordered.some((item) => item.task.taskId === 'task-9')).toBe(true);
  });
});
