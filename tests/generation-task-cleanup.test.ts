import { indexedDB } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultWorkspace } from '../src/data/providerCatalog';
import type { GenerationTaskInfo } from '../src/domain/types';
import {
  GENERATION_TASK_CLEANUP_JOURNAL_KEY,
  cleanupIntentsForMessages,
  readGenerationTaskCleanupJournal,
  reconcileGenerationTaskCleanupJournal,
  recordGenerationTaskCleanupIntents,
} from '../src/services/generationTaskCleanupJournal';
import {
  createGenerationTaskOutboxEntry,
  readGenerationTaskOutbox,
  readGenerationTaskOutboxConversationTombstone,
  upsertGenerationTaskOutbox,
  type GenerationTaskOutboxStorage,
} from '../src/services/generationTaskOutbox';

const platform = vi.hoisted(() => ({ OS: 'web' }));
vi.mock('react-native', () => ({ Platform: platform }));
vi.stubGlobal('indexedDB', indexedDB);

function storage(): GenerationTaskOutboxStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    async getItem(key) {
      return values.get(key) ?? null;
    },
    async setItem(key, value) {
      values.set(key, value);
    },
    async removeItem(key) {
      values.delete(key);
    },
    async getAllKeys() {
      return [...values.keys()];
    },
    async multiGet(keys) {
      return keys.map((key) => [key, values.get(key) ?? null] as const);
    },
    async multiRemove(keys) {
      for (const key of keys) values.delete(key);
    },
  };
}

const task: GenerationTaskInfo = {
  providerId: 'provider',
  modelId: 'video-model',
  taskId: 'task-cleanup',
  kind: 'video',
  status: 'running',
};

describe('generation task cleanup journal', () => {
  beforeEach(async () => {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase('embezzle-studio-attachments');
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
  });

  it('deduplicates and bounds device-local cleanup intents', async () => {
    const target = storage();
    await recordGenerationTaskCleanupIntents([
      { kind: 'conversation', conversationId: 'conversation-a', createdAt: 1 },
      { kind: 'conversation', conversationId: 'conversation-a', createdAt: 2 },
    ], target);
    expect(await readGenerationTaskCleanupJournal(target)).toEqual([
      { kind: 'conversation', conversationId: 'conversation-a', createdAt: 1 },
    ]);
    expect(target.values.has(GENERATION_TASK_CLEANUP_JOURNAL_KEY)).toBe(true);
  });

  it('waits for a clean workspace, then tombstones and removes a deleted conversation task', async () => {
    const target = storage();
    const entry = createGenerationTaskOutboxEntry({
      task,
      conversationId: 'conversation-deleted',
      messageId: 'message-deleted',
      state: 'pending',
      now: 1,
      attemptCount: 1,
    });
    await upsertGenerationTaskOutbox(entry, target);
    await recordGenerationTaskCleanupIntents([
      { kind: 'conversation', conversationId: 'conversation-deleted', createdAt: 2 },
    ], target);

    const workspace = createDefaultWorkspace();
    expect(await reconcileGenerationTaskCleanupJournal(workspace, { dirty: true, storage: target })).toEqual({
      journalRemoved: 0,
      outboxRemoved: 0,
      orphanedMediaCleaned: 0,
    });
    expect(await readGenerationTaskOutbox(target)).toHaveLength(1);

    const result = await reconcileGenerationTaskCleanupJournal(workspace, { storage: target });
    expect(result.outboxRemoved).toBe(1);
    expect(await readGenerationTaskOutbox(target)).toEqual([]);
    await expect(readGenerationTaskOutboxConversationTombstone('conversation-deleted', target))
      .resolves.toMatchObject({ blockAll: true });
    expect(await readGenerationTaskCleanupJournal(target)).toEqual([]);
  });

  it('preserves a task that survives in another branch', async () => {
    const target = storage();
    const entry = createGenerationTaskOutboxEntry({
      task,
      conversationId: 'conversation-original',
      messageId: 'message-original',
      state: 'completed',
      now: 1,
      attemptCount: 1,
    });
    await upsertGenerationTaskOutbox(entry, target);
    await recordGenerationTaskCleanupIntents([
      {
        kind: 'task',
        conversationId: 'conversation-original',
        taskId: task.taskId,
        messageId: 'message-original',
        createdAt: 2,
      },
    ], target);
    const workspace = createDefaultWorkspace();
    workspace.conversations = [{
      id: 'conversation-branch',
      title: 'branch',
      createdAt: 1,
      updatedAt: 1,
      messages: [{
        id: 'message-branch',
        originMessageId: 'message-original',
        role: 'assistant',
        content: '',
        createdAt: 1,
        status: 'pending',
        generationTask: task,
      }],
    }];
    const result = await reconcileGenerationTaskCleanupJournal(workspace, { storage: target });
    expect(result.outboxRemoved).toBe(0);
    expect(await readGenerationTaskOutbox(target)).toHaveLength(1);
  });

  it('derives task intents from destructive message edits', () => {
    const message = {
      id: 'message',
      role: 'assistant' as const,
      content: '',
      createdAt: 1,
      status: 'pending' as const,
      generationTask: task,
    };
    expect(cleanupIntentsForMessages([message], 'conversation-a', 9)).toEqual([
      {
        kind: 'task',
        conversationId: 'conversation-a',
        taskId: task.taskId,
        messageId: 'message',
        createdAt: 9,
      },
    ]);
  });
});
