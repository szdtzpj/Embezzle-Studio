import { describe, expect, it } from 'vitest';

import type {
  ChatConversation,
  ChatMessage,
  GenerationTaskInfo,
  MediaAttachment,
} from '../src/domain/types';
import {
  deriveGenerationTasks,
  filterGenerationTasks,
  generationTaskState,
  isGenerationTaskTerminal,
} from '../src/services/generationTasks';

function task(status?: string): GenerationTaskInfo {
  return {
    providerId: 'ark',
    modelId: 'seedance',
    taskId: `task-${status ?? 'none'}`,
    kind: 'video',
    status,
  };
}

function message(id: string, createdAt: number, generationTask?: GenerationTaskInfo): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    createdAt,
    status: 'ready',
    ...(generationTask ? { generationTask } : {}),
  };
}

function conversation(id: string, title: string, messages: ChatMessage[]): ChatConversation {
  return {
    id,
    title,
    createdAt: 1,
    updatedAt: messages.at(-1)?.createdAt ?? 1,
    messages,
  };
}

const video: MediaAttachment = {
  id: 'video-1',
  kind: 'video',
  uri: 'file:///video.mp4',
  name: 'video.mp4',
};

describe('generation task state', () => {
  it.each(['succeeded', 'SUCCESS', 'completed', 'done'])('recognizes completed status %s', (status) => {
    expect(generationTaskState(task(status))).toBe('completed');
  });

  it.each(['failed', 'ERROR', 'cancelled', 'canceled', 'expired'])('recognizes failed status %s', (status) => {
    expect(generationTaskState(task(status))).toBe('failed');
  });

  it('treats unknown and missing statuses as active', () => {
    expect(generationTaskState(task())).toBe('active');
    expect(generationTaskState(task('provider-specific-queued'))).toBe('active');
  });

  it('gives a returned video priority over a stale or failed provider status', () => {
    expect(generationTaskState(task('failed'), video)).toBe('completed');
    expect(isGenerationTaskTerminal(task('running'), video)).toBe(true);
  });
});

describe('generation task derivation and filtering', () => {
  it('derives tasks from every conversation with composite keys and newest-first ordering', () => {
    const older = message('same-message-id', 10, task('running'));
    older.error = '上次查询网络失败';
    const completed = message('same-message-id', 20, task('processing'));
    completed.attachments = [video];
    const conversations = [
      conversation('conversation-a', '任务 A', [message('plain', 30), older]),
      conversation('conversation-b', '任务 B', [completed]),
    ];

    const derived = deriveGenerationTasks(conversations);

    expect(derived).toHaveLength(2);
    expect(derived.map((item) => item.key)).toEqual([
      'conversation-b:same-message-id',
      'conversation-a:same-message-id',
    ]);
    expect(derived[0]).toMatchObject({
      conversationId: 'conversation-b',
      messageId: 'same-message-id',
      title: '任务 B',
      state: 'completed',
      attachment: video,
    });
    expect(derived[1]).toMatchObject({
      title: '任务 A',
      state: 'active',
      error: '上次查询网络失败',
    });
  });

  it('deduplicates inherited branch tasks while retaining an unrelated reused message ID', () => {
    const rootMessage = message('shared-task-message', 10, task('running'));
    const branchMessage = {
      ...message('branch-task-message', 10, task('running')),
      originMessageId: rootMessage.id,
    };
    const nestedMessage = {
      ...message('nested-task-message', 10, task('running')),
      originMessageId: rootMessage.id,
    };
    const root = conversation('root', 'Root', [rootMessage]);
    const branch = {
      ...conversation('branch', 'Branch', [branchMessage]),
      parentConversationId: root.id,
      branchPointMessageId: rootMessage.id,
    };
    const nested = {
      ...conversation('nested', 'Nested', [nestedMessage]),
      parentConversationId: branch.id,
      branchPointMessageId: branchMessage.id,
    };
    const unrelated = conversation('unrelated', 'Unrelated', [
      message('shared-task-message', 20, task('failed')),
    ]);

    const derived = deriveGenerationTasks([nested, branch, unrelated, root]);

    expect(derived).toHaveLength(2);
    expect(derived.map((item) => item.key)).toEqual([
      'unrelated:shared-task-message',
      'root:shared-task-message',
    ]);
  });

  it('deduplicates orphaned branch copies by their explicit canonical origin', () => {
    const first = message('copy-a', 10, task('running'));
    first.originMessageId = 'deleted-source';
    const second = message('copy-b', 10, task('running'));
    second.originMessageId = 'deleted-source';

    const derived = deriveGenerationTasks([
      conversation('orphan-a', 'Orphan A', [first]),
      conversation('orphan-b', 'Orphan B', [second]),
    ]);

    expect(derived).toHaveLength(1);
    expect(derived[0].task.taskId).toBe('task-running');
  });

  it('keeps the most complete known state for canonical task copies', () => {
    const rootMessage = message('video-task', 10, task('running'));
    const completedCopy = message('video-task-copy', 10, task('running'));
    completedCopy.originMessageId = rootMessage.id;
    completedCopy.attachments = [video];
    const root = conversation('root', 'Root', [rootMessage]);
    const branch = {
      ...conversation('branch', 'Branch', [completedCopy]),
      parentConversationId: root.id,
      branchPointMessageId: rootMessage.id,
    };

    const derived = deriveGenerationTasks([root, branch]);

    expect(derived).toHaveLength(1);
    expect(derived[0]).toMatchObject({
      key: 'branch:video-task-copy',
      state: 'completed',
      attachment: video,
    });
  });

  it('filters all, active, completed, and failed without mutating the source', () => {
    const conversations = [conversation('conversation', '任务', [
      message('active', 1, task('submitted')),
      message('complete', 2, task('succeeded')),
      message('failed', 3, task('expired')),
    ])];
    const tasks = deriveGenerationTasks(conversations);

    expect(filterGenerationTasks(tasks, 'all')).toEqual(tasks);
    expect(filterGenerationTasks(tasks, 'all')).not.toBe(tasks);
    expect(filterGenerationTasks(tasks, 'active').map((item) => item.messageId)).toEqual(['active']);
    expect(filterGenerationTasks(tasks, 'completed').map((item) => item.messageId)).toEqual(['complete']);
    expect(filterGenerationTasks(tasks, 'failed').map((item) => item.messageId)).toEqual(['failed']);
    expect(tasks).toHaveLength(3);
  });

  it('uses derived state for terminal detection and does not mistake a query error for provider failure', () => {
    const activeMessage = message('active', 1, task('running'));
    activeMessage.error = '查询超时';
    const [active] = deriveGenerationTasks([conversation('conversation', '任务', [activeMessage])]);
    expect(active.state).toBe('active');
    expect(isGenerationTaskTerminal(active)).toBe(false);

    const [failed] = deriveGenerationTasks([
      conversation('conversation', '任务', [message('failed', 2, task('failed'))]),
    ]);
    expect(isGenerationTaskTerminal(failed)).toBe(true);
  });
});
