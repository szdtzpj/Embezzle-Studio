import AsyncStorage from '@react-native-async-storage/async-storage';

import type { AppWorkspace, ChatMessage, MediaAttachment } from '../domain/types';
import {
  readGenerationTaskOutbox,
  removeGenerationTaskOutbox,
  tombstoneAndRemoveGenerationTaskOutboxForConversation,
  type GenerationTaskOutboxEntry,
  type GenerationTaskOutboxStorage,
} from './generationTaskOutbox';

/**
 * Destructive message/conversation edits are recorded outside AppWorkspace so
 * a failed/deferred workspace save cannot strand a headless outbox result or
 * its durable media. This key is device-local AsyncStorage state and is never
 * included in workspace backup/cloud-sync payloads.
 */
export const GENERATION_TASK_CLEANUP_JOURNAL_KEY =
  'embezzle-studio.generation-task-cleanup-journal.v1';
export const MAX_GENERATION_TASK_CLEANUP_JOURNAL_ENTRIES = 64;

export type GenerationTaskCleanupIntent =
  | {
      kind: 'conversation';
      conversationId: string;
      createdAt: number;
    }
  | {
      kind: 'task';
      conversationId: string;
      taskId: string;
      messageId?: string;
      createdAt: number;
    };

export interface GenerationTaskCleanupJournalStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem?(key: string): Promise<void>;
}

const fallbackValues = new Map<string, string>();
/** Vitest/SSR has no AsyncStorage window; production errors still propagate. */
const defaultStorage: GenerationTaskCleanupJournalStorage & GenerationTaskOutboxStorage = {
  async getItem(key) {
    try {
      return await AsyncStorage.getItem(key);
    } catch (error) {
      if (error instanceof ReferenceError && /window is not defined/u.test(error.message)) {
        return fallbackValues.get(key) ?? null;
      }
      throw error;
    }
  },
  async setItem(key, value) {
    try {
      await AsyncStorage.setItem(key, value);
    } catch (error) {
      if (error instanceof ReferenceError && /window is not defined/u.test(error.message)) {
        fallbackValues.set(key, value);
        return;
      }
      throw error;
    }
  },
  async removeItem(key) {
    try {
      await AsyncStorage.removeItem(key);
    } catch (error) {
      if (error instanceof ReferenceError && /window is not defined/u.test(error.message)) {
        fallbackValues.delete(key);
        return;
      }
      throw error;
    }
  },
  async getAllKeys() {
    try {
      return await AsyncStorage.getAllKeys();
    } catch (error) {
      if (error instanceof ReferenceError && /window is not defined/u.test(error.message)) {
        return [...fallbackValues.keys()];
      }
      throw error;
    }
  },
  async multiGet(keys) {
    try {
      return await AsyncStorage.multiGet([...keys]);
    } catch (error) {
      if (error instanceof ReferenceError && /window is not defined/u.test(error.message)) {
        return keys.map((key) => [key, fallbackValues.get(key) ?? null] as const);
      }
      throw error;
    }
  },
  async multiRemove(keys) {
    try {
      await AsyncStorage.multiRemove([...keys]);
    } catch (error) {
      if (error instanceof ReferenceError && /window is not defined/u.test(error.message)) {
        for (const key of keys) fallbackValues.delete(key);
        return;
      }
      throw error;
    }
  },
};

function boundedId(value: unknown, max = 512): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.normalize('NFKC').trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function normalizeIntent(value: unknown): GenerationTaskCleanupIntent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const conversationId = boundedId(candidate.conversationId, 256);
  const createdAt = typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt)
    ? Math.max(0, Math.trunc(candidate.createdAt))
    : undefined;
  if (!conversationId || createdAt === undefined) return undefined;
  if (candidate.kind === 'conversation') {
    return { kind: 'conversation', conversationId, createdAt };
  }
  if (candidate.kind !== 'task') return undefined;
  const taskId = boundedId(candidate.taskId, 512);
  if (!taskId) return undefined;
  const messageId = boundedId(candidate.messageId, 256);
  return {
    kind: 'task',
    conversationId,
    taskId,
    ...(messageId ? { messageId } : {}),
    createdAt,
  };
}

function intentKey(intent: GenerationTaskCleanupIntent): string {
  return intent.kind === 'conversation'
    ? `conversation:${intent.conversationId}`
    : `task:${intent.conversationId}:${intent.taskId}:${intent.messageId ?? ''}`;
}

export async function readGenerationTaskCleanupJournal(
  storage: GenerationTaskCleanupJournalStorage = defaultStorage
): Promise<GenerationTaskCleanupIntent[]> {
  const raw = await storage.getItem(GENERATION_TASK_CLEANUP_JOURNAL_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed
      .map(normalizeIntent)
      .filter((intent): intent is GenerationTaskCleanupIntent => Boolean(intent))
      .filter((intent) => {
        const key = intentKey(intent);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, MAX_GENERATION_TASK_CLEANUP_JOURNAL_ENTRIES);
  } catch {
    // A corrupt journal must not block workspace recovery. The next write
    // replaces it with a bounded, valid envelope.
    return [];
  }
}

async function writeJournal(
  intents: readonly GenerationTaskCleanupIntent[],
  storage: GenerationTaskCleanupJournalStorage
): Promise<void> {
  const bounded = intents.slice(0, MAX_GENERATION_TASK_CLEANUP_JOURNAL_ENTRIES);
  if (!bounded.length) {
    if (storage.removeItem) await storage.removeItem(GENERATION_TASK_CLEANUP_JOURNAL_KEY);
    else await storage.setItem(GENERATION_TASK_CLEANUP_JOURNAL_KEY, '[]');
    return;
  }
  await storage.setItem(GENERATION_TASK_CLEANUP_JOURNAL_KEY, JSON.stringify(bounded));
}

export async function recordGenerationTaskCleanupIntents(
  intents: readonly GenerationTaskCleanupIntent[],
  storage: GenerationTaskCleanupJournalStorage = defaultStorage
): Promise<void> {
  const existing = await readGenerationTaskCleanupJournal(storage);
  const merged = [...existing];
  const keys = new Set(existing.map(intentKey));
  for (const intent of intents) {
    const normalized = normalizeIntent(intent);
    if (!normalized) continue;
    const key = intentKey(normalized);
    if (keys.has(key)) continue;
    keys.add(key);
    merged.push(normalized);
  }
  await writeJournal(merged, storage);
}

function allMessages(workspace: AppWorkspace): Array<{ conversationId: string; message: ChatMessage }> {
  return [
    ...workspace.messages.map((message) => ({
      conversationId: workspace.activeConversationId,
      message,
    })),
    ...workspace.conversations.flatMap((conversation) =>
      conversation.messages.map((message) => ({ conversationId: conversation.id, message }))
    ),
  ];
}

function workspaceAttachments(workspace: AppWorkspace): MediaAttachment[] {
  return [
    ...allMessages(workspace).flatMap(({ message }) => message.attachments ?? []),
    ...workspace.composerDrafts.flatMap((draft) => draft.attachments ?? []),
  ];
}

function taskStillSurvives(
  workspace: AppWorkspace,
  intent: Extract<GenerationTaskCleanupIntent, { kind: 'task' }>
): boolean {
  // A generation task can be copied into a surviving branch. The task ID is
  // the durable identity, so any surviving occurrence keeps its outbox result.
  return allMessages(workspace).some(({ message }) => message.generationTask?.taskId === intent.taskId);
}

function conversationStillSurvives(workspace: AppWorkspace, conversationId: string): boolean {
  return workspace.conversations.some((conversation) => conversation.id === conversationId);
}

function outboxEntryStillReferenced(
  workspace: AppWorkspace,
  entry: GenerationTaskOutboxEntry
): boolean {
  return allMessages(workspace).some(({ message }) => message.generationTask?.taskId === entry.taskId);
}

function survivingTaskIds(workspace: AppWorkspace): Set<string> {
  return new Set(
    allMessages(workspace)
      .map(({ message }) => message.generationTask?.taskId)
      .filter((taskId): taskId is string => Boolean(taskId))
  );
}

function uniqueAttachments(attachments: readonly MediaAttachment[]): MediaAttachment[] {
  const seen = new Set<string>();
  return attachments.filter((attachment) => {
    if (seen.has(attachment.uri)) return false;
    seen.add(attachment.uri);
    return true;
  });
}

export interface GenerationTaskCleanupReconciliationResult {
  journalRemoved: number;
  outboxRemoved: number;
  orphanedMediaCleaned: number;
}

/**
 * Drain cleanup intents only after the canonical workspace is known to be
 * clean. If an edit did not commit, the target still exists and its intent is
 * discarded; if it did commit, stale outbox entries and media are reclaimed.
 */
export async function reconcileGenerationTaskCleanupJournal(
  workspace: AppWorkspace,
  options: {
    dirty?: boolean;
    storage?: GenerationTaskCleanupJournalStorage & GenerationTaskOutboxStorage;
  } = {}
): Promise<GenerationTaskCleanupReconciliationResult> {
  if (options.dirty === true) {
    return { journalRemoved: 0, outboxRemoved: 0, orphanedMediaCleaned: 0 };
  }
  const storage = options.storage ?? defaultStorage;
  const intents = await readGenerationTaskCleanupJournal(storage);
  const outbox = await readGenerationTaskOutbox(storage);
  const removeIds = new Set<string>();
  const retainedIntents: GenerationTaskCleanupIntent[] = [];
  let journalRemoved = 0;

  for (const intent of intents) {
    if (intent.kind === 'conversation') {
      if (conversationStillSurvives(workspace, intent.conversationId)) {
        journalRemoved += 1;
      } else {
        await tombstoneAndRemoveGenerationTaskOutboxForConversation(
          intent.conversationId,
          survivingTaskIds(workspace),
          Date.now(),
          storage
        );
        for (const entry of outbox) {
          if (entry.conversationId === intent.conversationId && !outboxEntryStillReferenced(workspace, entry)) {
            removeIds.add(entry.id);
          }
        }
        journalRemoved += 1;
      }
      continue;
    }
    if (taskStillSurvives(workspace, intent)) {
      journalRemoved += 1;
    } else {
      await tombstoneAndRemoveGenerationTaskOutboxForConversation(
        intent.conversationId,
        survivingTaskIds(workspace),
        Date.now(),
        storage
      );
      for (const entry of outbox) {
        if (
          entry.conversationId === intent.conversationId &&
          entry.taskId === intent.taskId &&
          (!intent.messageId || entry.messageId === intent.messageId)
        ) {
          removeIds.add(entry.id);
        }
      }
      journalRemoved += 1;
    }
  }

  // Even without a journal record, a stale worker may have written an entry
  // for a message that no longer exists. Reconcile those bounded records too.
  for (const entry of outbox) {
    if (!outboxEntryStillReferenced(workspace, entry)) removeIds.add(entry.id);
  }
  for (const id of removeIds) await removeGenerationTaskOutbox(id, storage);

  const remainingOutbox = await readGenerationTaskOutbox(storage);
  const referenced = uniqueAttachments([
    ...workspaceAttachments(workspace),
    ...remainingOutbox.flatMap((entry) => entry.attachments ?? []),
  ]);
  // Keep React Native/media-storage code out of the pure workspace command
  // graph. It is loaded only during an actual foreground reconciliation.
  const { cleanupOrphanedMediaStorage } = await import('./mediaStorage');
  const cleanup = await cleanupOrphanedMediaStorage(referenced);

  await writeJournal(retainedIntents, storage);
  return {
    journalRemoved,
    outboxRemoved: removeIds.size,
    orphanedMediaCleaned: cleanup.deletedCount,
  };
}

/** Returns task intents that may be removed by a destructive edit. */
export function cleanupIntentsForMessages(
  messages: readonly ChatMessage[],
  conversationId: string,
  now = Date.now()
): GenerationTaskCleanupIntent[] {
  return messages.flatMap((message) =>
    message.generationTask?.taskId
      ? [{
          kind: 'task' as const,
          conversationId,
          taskId: message.generationTask.taskId,
          messageId: message.id,
          createdAt: now,
        }]
      : []
  );
}
