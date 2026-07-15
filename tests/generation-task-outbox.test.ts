import { describe, expect, it } from 'vitest';

import { createDefaultWorkspace } from '../src/data/providerCatalog';
import type { ChatMessage, GenerationTaskInfo } from '../src/domain/types';
import {
  GENERATION_TASK_OUTBOX_ENTRY_KEY_PREFIX,
  GENERATION_TASK_OUTBOX_KEY,
  GENERATION_TASK_OUTBOX_LEGACY_MIGRATION_KEY,
  MAX_GENERATION_TASK_OUTBOX_WRITE_ATTEMPTS,
  GenerationTaskOutboxConflictError,
  applyGenerationTaskOutboxEntries,
  createGenerationTaskOutboxEntry,
  mergeGenerationTaskOutboxEntry,
  generationTaskOutboxEntryStorageKey,
  readGenerationTaskOutbox,
  readGenerationTaskOutboxConversationTombstone,
  tombstoneAndRemoveGenerationTaskOutboxForConversation,
  removeGenerationTaskOutbox,
  updateGenerationTaskOutboxNotificationState,
  upsertGenerationTaskOutbox,
  type GenerationTaskOutboxStorage,
} from '../src/services/generationTaskOutbox';

function memoryStorage(): GenerationTaskOutboxStorage & { values: Map<string, string> } {
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

function perEntryMemoryStorage(): GenerationTaskOutboxStorage & { values: Map<string, string> } {
  const base = memoryStorage();
  return {
    ...base,
    async getAllKeys() {
      return [...base.values.keys()];
    },
    async multiGet(keys) {
      return keys.map((key) => [key, base.values.get(key) ?? null] as const);
    },
    async multiRemove(keys) {
      for (const key of keys) base.values.delete(key);
    },
  };
}

function legacyMemoryStorage(): GenerationTaskOutboxStorage & { values: Map<string, string> } {
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
  };
}

const task: GenerationTaskInfo = {
  providerId: 'provider-ark',
  modelId: 'seedance-model',
  taskId: 'task-123',
  kind: 'video',
  status: 'running',
};

function taskMessage(id: string, originMessageId?: string): ChatMessage {
  return {
    id,
    ...(originMessageId ? { originMessageId } : {}),
    role: 'assistant',
    content: '生成中',
    createdAt: 10,
    status: 'pending',
    generationTask: { ...task },
  };
}

describe('generation task outbox', () => {
  it('round-trips a bounded result without duplicating base64 media bytes', async () => {
    const storage = memoryStorage();
    const entry = createGenerationTaskOutboxEntry({
      task: { ...task, status: 'succeeded', lastCheckedAt: 100, attemptCount: 2 },
      conversationId: 'conversation-a',
      messageId: 'message-a',
      state: 'completed',
      now: 100,
      attemptCount: 2,
      content: '视频生成完成',
      attachments: [
        {
          id: 'video-a',
          kind: 'video',
          uri: 'file:///video-a.mp4',
          name: 'video-a.mp4',
          mimeType: 'video/mp4',
          base64: 'SHOULD-NOT-BE-PERSISTED',
        },
      ],
    });
    await upsertGenerationTaskOutbox(entry, storage);

    const saved = storage.values.get(generationTaskOutboxEntryStorageKey(entry.id)) ?? '';
    expect(saved).not.toContain('SHOULD-NOT-BE-PERSISTED');
    expect([...storage.values.keys()]).toContain(generationTaskOutboxEntryStorageKey(entry.id));
    const loaded = await readGenerationTaskOutbox(storage);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ state: 'completed', attemptCount: 2 });
    expect(loaded[0].attachments?.[0]).not.toHaveProperty('base64');
  });

  it('marks a sent terminal notification in the durable task metadata', async () => {
    const storage = memoryStorage();
    const entry = createGenerationTaskOutboxEntry({
      task: { ...task, status: 'failed' },
      conversationId: 'conversation-a',
      messageId: 'message-a',
      state: 'failed',
      now: 100,
      attemptCount: 1,
      error: 'provider failed',
    });
    await upsertGenerationTaskOutbox(entry, storage);
    await updateGenerationTaskOutboxNotificationState(entry.id, 'sent', storage);

    const [loaded] = await readGenerationTaskOutbox(storage);
    expect(loaded.notificationState).toBe('sent');
    expect(loaded.generationTask.notifiedStatus).toBe('failed');
  });

  it('keeps different entries when another runtime writes between this runtime start and set', async () => {
    const storage = memoryStorage();
    const localEntry = createGenerationTaskOutboxEntry({
      task,
      conversationId: 'conversation-local',
      messageId: 'message-local',
      state: 'pending',
      now: 100,
      attemptCount: 1,
    });
    const externalEntry = createGenerationTaskOutboxEntry({
      task: { ...task, taskId: 'task-external' },
      conversationId: 'conversation-external',
      messageId: 'message-external',
      state: 'pending',
      now: 101,
      attemptCount: 1,
    });
    const originalSetItem = storage.setItem.bind(storage);
    let injected = false;
    storage.setItem = async (key, value) => {
      if (key === generationTaskOutboxEntryStorageKey(localEntry.id) && !injected) {
        injected = true;
        await originalSetItem(
          generationTaskOutboxEntryStorageKey(externalEntry.id),
          JSON.stringify({ schemaVersion: 1, entry: externalEntry })
        );
      }
      await originalSetItem(key, value);
    };

    await upsertGenerationTaskOutbox(localEntry, storage);

    const loaded = await readGenerationTaskOutbox(storage);
    expect(loaded.map((entry) => entry.id).sort()).toEqual(
      [externalEntry.id, localEntry.id].sort()
    );
    expect(
      [...storage.values.keys()].filter((key) =>
        key.startsWith(GENERATION_TASK_OUTBOX_ENTRY_KEY_PREFIX)
      )
    ).toHaveLength(2);
  });

  it('migrates a legacy envelope additively and does not re-expose removed entries', async () => {
    const storage = memoryStorage();
    const entry = createGenerationTaskOutboxEntry({
      task,
      conversationId: 'conversation-a',
      messageId: 'message-a',
      state: 'pending',
      now: 100,
      attemptCount: 1,
    });
    storage.values.set(
      GENERATION_TASK_OUTBOX_KEY,
      JSON.stringify({ schemaVersion: 1, entries: [entry] })
    );

    await expect(readGenerationTaskOutbox(storage)).resolves.toMatchObject([{ id: entry.id }]);
    expect(storage.values.has(generationTaskOutboxEntryStorageKey(entry.id))).toBe(true);
    expect(storage.values.has(GENERATION_TASK_OUTBOX_LEGACY_MIGRATION_KEY)).toBe(true);

    await removeGenerationTaskOutbox(entry.id, storage);
    await expect(readGenerationTaskOutbox(storage)).resolves.toEqual([]);
    expect(storage.values.has(GENERATION_TASK_OUTBOX_KEY)).toBe(true);
  });

  it('removes and later recreates one independent entry without touching another', async () => {
    const storage = memoryStorage();
    const first = createGenerationTaskOutboxEntry({
      task,
      conversationId: 'conversation-a',
      messageId: 'message-a',
      state: 'pending',
      now: 100,
      attemptCount: 1,
    });
    const second = createGenerationTaskOutboxEntry({
      task: { ...task, taskId: 'task-b' },
      conversationId: 'conversation-b',
      messageId: 'message-b',
      state: 'pending',
      now: 101,
      attemptCount: 1,
    });
    await upsertGenerationTaskOutbox(first, storage);
    await upsertGenerationTaskOutbox(second, storage);
    await removeGenerationTaskOutbox(first.id, storage);
    await expect(readGenerationTaskOutbox(storage)).resolves.toMatchObject([{ id: second.id }]);

    await upsertGenerationTaskOutbox({ ...first, updatedAt: 102 }, storage);
    expect((await readGenerationTaskOutbox(storage)).map((entry) => entry.id).sort()).toEqual(
      [first.id, second.id].sort()
    );
  });

  it('replays the legacy fallback mutation when a writer changes the envelope before set', async () => {
    const storage = legacyMemoryStorage();
    const localEntry = createGenerationTaskOutboxEntry({
      task,
      conversationId: 'conversation-local',
      messageId: 'message-local',
      state: 'pending',
      now: 100,
      attemptCount: 1,
    });
    const externalEntry = createGenerationTaskOutboxEntry({
      task: { ...task, taskId: 'task-external' },
      conversationId: 'conversation-external',
      messageId: 'message-external',
      state: 'pending',
      now: 101,
      attemptCount: 1,
    });
    const originalGetItem = storage.getItem.bind(storage);
    let envelopeReadCount = 0;
    storage.getItem = async (key) => {
      if (key === GENERATION_TASK_OUTBOX_KEY) {
        envelopeReadCount += 1;
        if (envelopeReadCount === 2) {
          storage.values.set(
            key,
            JSON.stringify({
              schemaVersion: 1,
              revision: 1,
              writeId: 'external-before-set',
              entries: [externalEntry],
            })
          );
        }
      }
      return originalGetItem(key);
    };

    await upsertGenerationTaskOutbox(localEntry, storage);

    expect((await readGenerationTaskOutbox(storage)).map((entry) => entry.id).sort()).toEqual(
      [externalEntry.id, localEntry.id].sort()
    );
  });

  it('fails closed after repeated cross-runtime overwrites instead of silently succeeding', async () => {
    const storage = legacyMemoryStorage();
    const entry = createGenerationTaskOutboxEntry({
      task,
      conversationId: 'conversation-a',
      messageId: 'message-a',
      state: 'pending',
      now: 100,
      attemptCount: 1,
    });
    const originalSetItem = storage.setItem.bind(storage);
    let overwriteCount = 0;
    storage.setItem = async (key, value) => {
      await originalSetItem(key, value);
      if (key !== GENERATION_TASK_OUTBOX_KEY) return;
      overwriteCount += 1;
      const written = JSON.parse(value) as {
        schemaVersion: number;
        revision: number;
        entries: unknown[];
      };
      storage.values.set(
        key,
        JSON.stringify({
          ...written,
          revision: written.revision + 1,
          writeId: `external-runtime-write-${overwriteCount}`,
        })
      );
    };

    await expect(upsertGenerationTaskOutbox(entry, storage)).rejects.toBeInstanceOf(
      GenerationTaskOutboxConflictError
    );
    expect(overwriteCount).toBe(MAX_GENERATION_TASK_OUTBOX_WRITE_ATTEMPTS);
  });

  it('applies one terminal result to source and inherited copies through the workspace owner', () => {
    const workspace = createDefaultWorkspace();
    const source = taskMessage('message-a');
    const branchCopy = taskMessage('message-branch', 'message-a');
    workspace.activeConversationId = 'conversation-a';
    workspace.messages = [source];
    workspace.conversations = [
      {
        id: 'conversation-a',
        title: '原始对话',
        createdAt: 1,
        updatedAt: 10,
        messages: [source],
      },
      {
        id: 'conversation-b',
        title: '分支',
        parentConversationId: 'conversation-a',
        branchPointMessageId: 'message-a',
        createdAt: 2,
        updatedAt: 10,
        messages: [branchCopy],
      },
    ];
    const entry = createGenerationTaskOutboxEntry({
      task: { ...task, status: 'succeeded', lastCheckedAt: 500, attemptCount: 3 },
      conversationId: 'conversation-a',
      messageId: 'message-a',
      state: 'completed',
      now: 500,
      attemptCount: 3,
      content: '已完成',
      attachments: [
        {
          id: 'video-a',
          kind: 'video',
          uri: 'file:///video-a.mp4',
          name: 'video-a.mp4',
          mimeType: 'video/mp4',
        },
      ],
    });

    const applied = applyGenerationTaskOutboxEntries(workspace, [entry], 600);
    expect(applied.appliedIds).toEqual([entry.id]);
    expect(applied.workspace.messages[0]).toMatchObject({ status: 'ready', content: '已完成' });
    expect(applied.workspace.conversations[0].messages[0].attachments?.[0].uri).toBe(
      'file:///video-a.mp4'
    );
    expect(applied.workspace.conversations[1].messages[0]).toMatchObject({
      status: 'ready',
      content: '已完成',
    });
  });

  it('fails closed to an empty queue for malformed persisted data', async () => {
    const storage = memoryStorage();
    storage.values.set(GENERATION_TASK_OUTBOX_KEY, '{broken');
    await expect(readGenerationTaskOutbox(storage)).resolves.toEqual([]);
  });

  it('tombstones deleted conversation tasks while retaining branch-shared task IDs', async () => {
    const storage = memoryStorage();
    const removable = createGenerationTaskOutboxEntry({
      task: { ...task, taskId: 'task-delete' },
      conversationId: 'conversation-delete',
      messageId: 'message-delete',
      state: 'completed',
      now: 10,
      attemptCount: 1,
      attachments: [{
        id: 'video-delete',
        kind: 'video',
        uri: 'file:///documents/video-delete.mp4',
        name: 'video-delete.mp4',
      }],
    });
    const retained = createGenerationTaskOutboxEntry({
      task: { ...task, taskId: 'task-branch' },
      conversationId: 'conversation-delete',
      messageId: 'message-branch',
      state: 'pending',
      now: 11,
      attemptCount: 1,
    });
    await upsertGenerationTaskOutbox(removable, storage);
    await upsertGenerationTaskOutbox(retained, storage);

    const removed = await tombstoneAndRemoveGenerationTaskOutboxForConversation(
      'conversation-delete',
      new Set(['task-branch']),
      20,
      storage
    );

    expect(removed.map((entry) => entry.id)).toEqual([removable.id]);
    expect(await readGenerationTaskOutbox(storage)).toEqual([retained]);
    await expect(readGenerationTaskOutboxConversationTombstone('conversation-delete', storage))
      .resolves.toMatchObject({ taskIds: ['task-delete'] });
    expect(await upsertGenerationTaskOutbox(removable, storage)).toBe(false);
    expect(await readGenerationTaskOutbox(storage)).toEqual([retained]);
  });

  it('blocks a stale headless per-entry upsert after delete tombstoning', async () => {
    const storage = perEntryMemoryStorage();
    const entry = createGenerationTaskOutboxEntry({
      task: { ...task, taskId: 'task-race' },
      conversationId: 'conversation-race',
      messageId: 'message-race',
      state: 'pending',
      now: 10,
      attemptCount: 1,
    });
    await upsertGenerationTaskOutbox(entry, storage);
    await tombstoneAndRemoveGenerationTaskOutboxForConversation(
      'conversation-race',
      new Set(),
      20,
      storage
    );

    const staleWrite = await upsertGenerationTaskOutbox({ ...entry, updatedAt: 30 }, storage);
    expect(staleWrite).toBe(false);
    expect(await readGenerationTaskOutbox(storage)).toEqual([]);
  });

  it('blocks a stale first headless upsert even when delete found no persisted entry', async () => {
    const storage = perEntryMemoryStorage();
    const entry = createGenerationTaskOutboxEntry({
      task: { ...task, taskId: 'task-not-yet-persisted' },
      conversationId: 'conversation-deleted-first',
      messageId: 'message-deleted-first',
      state: 'pending',
      now: 30,
      attemptCount: 1,
    });

    await tombstoneAndRemoveGenerationTaskOutboxForConversation(
      entry.conversationId,
      new Set(),
      20,
      storage
    );

    expect(await upsertGenerationTaskOutbox(entry, storage)).toBe(false);
    await expect(
      readGenerationTaskOutboxConversationTombstone(entry.conversationId, storage)
    ).resolves.toMatchObject({ blockAll: true, taskIds: [] });
    expect(await readGenerationTaskOutbox(storage)).toEqual([]);
  });

  it('never regresses a terminal result when a late pending write arrives', async () => {
    const completed = createGenerationTaskOutboxEntry({
      task: { ...task, status: 'succeeded', lastCheckedAt: 100 },
      conversationId: 'conversation-monotonic',
      messageId: 'message-monotonic',
      state: 'completed',
      now: 100,
      attemptCount: 2,
      content: 'done',
    });
    const pending = createGenerationTaskOutboxEntry({
      task: { ...task, status: 'running', lastCheckedAt: 200 },
      conversationId: completed.conversationId,
      messageId: completed.messageId,
      state: 'pending',
      now: 200,
      attemptCount: 3,
    });

    expect(mergeGenerationTaskOutboxEntry(completed, pending)).toMatchObject({
      state: 'completed',
      content: 'done',
    });
    expect(mergeGenerationTaskOutboxEntry(pending, completed)).toMatchObject({
      state: 'completed',
    });
  });

  it('keeps concurrent per-entry writes monotonic after out-of-order completion', async () => {
    const storage = perEntryMemoryStorage();
    const completed = createGenerationTaskOutboxEntry({
      task: { ...task, status: 'succeeded', lastCheckedAt: 100 },
      conversationId: 'conversation-race-monotonic',
      messageId: 'message-race-monotonic',
      state: 'completed',
      now: 100,
      attemptCount: 2,
      content: 'done',
    });
    const pending = createGenerationTaskOutboxEntry({
      task: { ...task, status: 'running', lastCheckedAt: 200 },
      conversationId: completed.conversationId,
      messageId: completed.messageId,
      state: 'pending',
      now: 200,
      attemptCount: 3,
    });
    await Promise.all([upsertGenerationTaskOutbox(pending, storage), upsertGenerationTaskOutbox(completed, storage)]);
    const entries = await readGenerationTaskOutbox(storage);
    expect(entries).toHaveLength(1);
    expect(entries[0].state).toBe('completed');
  });
});
