import AsyncStorage from '@react-native-async-storage/async-storage';

import type {
  AppWorkspace,
  ChatMessage,
  GenerationTaskInfo,
  MediaAttachment,
} from '../domain/types';
import { canonicalMessageId } from './conversationBranches';

/**
 * Results produced by a background/headless task are kept outside the
 * workspace until the foreground WorkspaceSession can apply them. This keeps
 * a headless JS runtime from racing a foreground session that may have a dirty
 * in-memory snapshot.
 */
export const GENERATION_TASK_OUTBOX_KEY = 'embezzle-studio.generation-task-outbox.v1';
export const GENERATION_TASK_OUTBOX_ENTRY_KEY_PREFIX = `${GENERATION_TASK_OUTBOX_KEY}.entry.`;
export const GENERATION_TASK_OUTBOX_LEGACY_MIGRATION_KEY = `${GENERATION_TASK_OUTBOX_KEY}.legacy-migrated`;
export const GENERATION_TASK_OUTBOX_CONVERSATION_TOMBSTONE_KEY_PREFIX =
  `${GENERATION_TASK_OUTBOX_KEY}.conversation-tombstone.`;
export const GENERATION_TASK_OUTBOX_SCHEMA_VERSION = 1;
export const MAX_GENERATION_TASK_OUTBOX_ENTRIES = 128;
export const MAX_GENERATION_TASK_OUTBOX_CONTENT = 200_000;
export const MAX_GENERATION_TASK_OUTBOX_WRITE_ATTEMPTS = 5;

export type GenerationTaskOutboxState = 'pending' | 'completed' | 'failed' | 'blocked';
export type GenerationTaskOutboxNotificationState = 'pending' | 'sent' | 'skipped' | 'failed';

export interface GenerationTaskOutboxEntry {
  id: string;
  conversationId: string;
  messageId: string;
  taskId: string;
  providerId: string;
  modelId: string;
  state: GenerationTaskOutboxState;
  content?: string;
  error?: string;
  attachments?: MediaAttachment[];
  generationTask: GenerationTaskInfo;
  attemptCount: number;
  createdAt: number;
  updatedAt: number;
  notificationState?: GenerationTaskOutboxNotificationState;
}

export interface GenerationTaskOutboxEnvelope {
  schemaVersion: typeof GENERATION_TASK_OUTBOX_SCHEMA_VERSION;
  revision: number;
  writeId?: string;
  entries: GenerationTaskOutboxEntry[];
}

export interface GenerationTaskOutboxConversationTombstone {
  schemaVersion: typeof GENERATION_TASK_OUTBOX_SCHEMA_VERSION;
  conversationId: string;
  taskIds: string[];
  /** New tombstones block every stale task except explicit branch-shared IDs. */
  blockAll?: boolean;
  retainedTaskIds?: string[];
  deletedAt: number;
}

export interface GenerationTaskOutboxStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem?(key: string): Promise<void>;
  getAllKeys?(): Promise<readonly string[]>;
  multiGet?(keys: readonly string[]): Promise<readonly (readonly [string, string | null])[]>;
  multiRemove?(keys: readonly string[]): Promise<void>;
}

interface EnumerableGenerationTaskOutboxStorage extends GenerationTaskOutboxStorage {
  getAllKeys(): Promise<readonly string[]>;
}

interface GenerationTaskOutboxEntryRecord {
  schemaVersion: typeof GENERATION_TASK_OUTBOX_SCHEMA_VERSION;
  entry: GenerationTaskOutboxEntry;
}

const defaultStorage: GenerationTaskOutboxStorage = AsyncStorage;
let operationChain: Promise<void> = Promise.resolve();
let writeSequence = 0;

export class GenerationTaskOutboxConflictError extends Error {
  constructor(message = '生成任务队列在多运行时间持续变化，未安全写入；请稍后重试。') {
    super(message);
    this.name = 'GenerationTaskOutboxConflictError';
  }
}

export function generationTaskOutboxEntryStorageKey(entryId: string): string {
  return `${GENERATION_TASK_OUTBOX_ENTRY_KEY_PREFIX}${encodeURIComponent(entryId)}`;
}

export function generationTaskOutboxConversationTombstoneStorageKey(
  conversationId: string
): string {
  return `${GENERATION_TASK_OUTBOX_CONVERSATION_TOMBSTONE_KEY_PREFIX}${encodeURIComponent(
    conversationId
  )}`;
}

function emptyEnvelope(): GenerationTaskOutboxEnvelope {
  return {
    schemaVersion: GENERATION_TASK_OUTBOX_SCHEMA_VERSION,
    revision: 0,
    entries: [],
  };
}

function createWriteId(): string {
  writeSequence = (writeSequence + 1) % Number.MAX_SAFE_INTEGER;
  return [
    Date.now().toString(36),
    writeSequence.toString(36),
    Math.random().toString(36).slice(2, 12),
  ].join('-');
}

function finiteNonNegative(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : fallback;
}

function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.normalize('NFKC');
  return Array.from(normalized).slice(0, maximum).join('');
}

function cloneAttachment(attachment: MediaAttachment): MediaAttachment {
  const clone = { ...attachment };
  // Base64 payloads must never be duplicated into a background result queue.
  // Generated video attachments are durable file/remote URIs by this stage.
  delete clone.base64;
  return clone;
}

function normalizeGenerationTask(value: unknown): GenerationTaskInfo | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const providerId = boundedText(candidate.providerId, 256);
  const modelId = boundedText(candidate.modelId, 512);
  const taskId = boundedText(candidate.taskId, 512);
  if (!providerId || !modelId || !taskId || candidate.kind !== 'video') return undefined;
  const task: GenerationTaskInfo = { providerId, modelId, taskId, kind: 'video' };
  const status = boundedText(candidate.status, 128);
  const lastCheckedAt = finiteNonNegative(candidate.lastCheckedAt, -1);
  const nextCheckAt = finiteNonNegative(candidate.nextCheckAt, -1);
  const attemptCount = finiteNonNegative(candidate.attemptCount, -1);
  if (status) task.status = status;
  if (lastCheckedAt >= 0) task.lastCheckedAt = lastCheckedAt;
  if (nextCheckAt >= 0) task.nextCheckAt = nextCheckAt;
  if (attemptCount >= 0) task.attemptCount = attemptCount;
  if (candidate.notifiedStatus === 'completed' || candidate.notifiedStatus === 'failed') {
    task.notifiedStatus = candidate.notifiedStatus;
  }
  return task;
}

function normalizeAttachment(value: unknown): MediaAttachment | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const id = boundedText(candidate.id, 256);
  const uri = boundedText(candidate.uri, 16_384);
  const name = boundedText(candidate.name, 512);
  const kind = candidate.kind;
  if (!id || !uri || !name || (kind !== 'image' && kind !== 'video' && kind !== 'file')) {
    return undefined;
  }
  const attachment: MediaAttachment = { id, uri, name, kind };
  const mimeType = boundedText(candidate.mimeType, 256);
  const size = finiteNonNegative(candidate.size, -1);
  const width = finiteNonNegative(candidate.width, -1);
  const height = finiteNonNegative(candidate.height, -1);
  const durationMs = finiteNonNegative(candidate.durationMs, -1);
  if (mimeType) attachment.mimeType = mimeType;
  if (size >= 0) attachment.size = size;
  if (width >= 0) attachment.width = width;
  if (height >= 0) attachment.height = height;
  if (durationMs >= 0) attachment.durationMs = durationMs;
  return attachment;
}

function normalizeEntry(value: unknown): GenerationTaskOutboxEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const id = boundedText(candidate.id, 1_024);
  const conversationId = boundedText(candidate.conversationId, 256);
  const messageId = boundedText(candidate.messageId, 256);
  const taskId = boundedText(candidate.taskId, 512);
  const providerId = boundedText(candidate.providerId, 256);
  const modelId = boundedText(candidate.modelId, 512);
  const generationTask = normalizeGenerationTask(candidate.generationTask);
  const state = candidate.state;
  if (
    !id ||
    !conversationId ||
    !messageId ||
    !taskId ||
    !providerId ||
    !modelId ||
    !generationTask ||
    generationTask.taskId !== taskId ||
    generationTask.providerId !== providerId ||
    generationTask.modelId !== modelId ||
    (state !== 'pending' && state !== 'completed' && state !== 'failed' && state !== 'blocked')
  ) {
    return undefined;
  }
  const attachments = Array.isArray(candidate.attachments)
    ? candidate.attachments.map(normalizeAttachment).filter((item): item is MediaAttachment => Boolean(item))
    : undefined;
  const notificationState =
    candidate.notificationState === 'pending' ||
    candidate.notificationState === 'sent' ||
    candidate.notificationState === 'skipped' ||
    candidate.notificationState === 'failed'
      ? candidate.notificationState
      : undefined;
  return {
    id,
    conversationId,
    messageId,
    taskId,
    providerId,
    modelId,
    state,
    ...(boundedText(candidate.content, MAX_GENERATION_TASK_OUTBOX_CONTENT)
      ? { content: boundedText(candidate.content, MAX_GENERATION_TASK_OUTBOX_CONTENT) }
      : {}),
    ...(boundedText(candidate.error, 4_000)
      ? { error: boundedText(candidate.error, 4_000) }
      : {}),
    ...(attachments?.length ? { attachments } : {}),
    generationTask,
    attemptCount: finiteNonNegative(candidate.attemptCount),
    createdAt: finiteNonNegative(candidate.createdAt),
    updatedAt: finiteNonNegative(candidate.updatedAt),
    ...(notificationState ? { notificationState } : {}),
  };
}

function normalizeEnvelope(value: unknown): GenerationTaskOutboxEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return emptyEnvelope();
  }
  const candidate = value as Record<string, unknown>;
  const entries = Array.isArray(candidate.entries)
    ? candidate.entries
        .map(normalizeEntry)
        .filter((entry): entry is GenerationTaskOutboxEntry => Boolean(entry))
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
        .slice(0, MAX_GENERATION_TASK_OUTBOX_ENTRIES)
    : [];
  const revision = finiteNonNegative(candidate.revision);
  const writeId = boundedText(candidate.writeId, 256);
  return {
    schemaVersion: GENERATION_TASK_OUTBOX_SCHEMA_VERSION,
    revision,
    ...(writeId ? { writeId } : {}),
    entries,
  };
}

function normalizeEntryRecord(value: unknown): GenerationTaskOutboxEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== undefined &&
    candidate.schemaVersion !== GENERATION_TASK_OUTBOX_SCHEMA_VERSION
  ) {
    return undefined;
  }
  return normalizeEntry(candidate.entry ?? candidate);
}

function serializeEntryRecord(entry: GenerationTaskOutboxEntry): string {
  const record: GenerationTaskOutboxEntryRecord = {
    schemaVersion: GENERATION_TASK_OUTBOX_SCHEMA_VERSION,
    entry,
  };
  return JSON.stringify(record);
}

function isTerminalState(state: GenerationTaskOutboxState): boolean {
  return state === 'completed' || state === 'failed' || state === 'blocked';
}

function stateRank(state: GenerationTaskOutboxState): number {
  if (state === 'completed') return 3;
  if (state === 'failed' || state === 'blocked') return 2;
  return 1;
}

function entryFreshness(entry: GenerationTaskOutboxEntry): [number, number, number] {
  return [
    finiteNonNegative(entry.generationTask.lastCheckedAt),
    finiteNonNegative(entry.attemptCount),
    finiteNonNegative(entry.updatedAt),
  ];
}

function compareFreshness(
  left: GenerationTaskOutboxEntry,
  right: GenerationTaskOutboxEntry
): number {
  const a = entryFreshness(left);
  const b = entryFreshness(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return left.id.localeCompare(right.id);
}

/**
 * Merge two writes for one task entry without allowing a terminal result to
 * regress to a late pending/error snapshot. Fresh task metadata wins within
 * the same lifecycle state; a sent notification is never downgraded.
 */
export function mergeGenerationTaskOutboxEntry(
  existing: GenerationTaskOutboxEntry | undefined,
  incoming: GenerationTaskOutboxEntry
): GenerationTaskOutboxEntry {
  if (!existing) return incoming;
  const existingTerminal = isTerminalState(existing.state);
  const incomingTerminal = isTerminalState(incoming.state);
  let winner = incoming;
  if (existingTerminal && !incomingTerminal) winner = existing;
  else if (!existingTerminal && incomingTerminal) winner = incoming;
  else if (stateRank(existing.state) !== stateRank(incoming.state)) {
    winner = stateRank(existing.state) > stateRank(incoming.state) ? existing : incoming;
  } else if (compareFreshness(existing, incoming) > 0) winner = existing;
  const notificationState =
    existing.notificationState === 'sent' || winner.notificationState === 'sent'
      ? 'sent'
      : winner.notificationState ?? existing.notificationState;
  return notificationState ? { ...winner, notificationState } : winner;
}

function normalizeConversationTombstone(
  value: unknown,
  conversationId: string
): GenerationTaskOutboxConversationTombstone | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const taskIds = Array.isArray(candidate.taskIds)
    ? candidate.taskIds
        .filter((taskId): taskId is string => typeof taskId === 'string' && taskId.trim().length > 0)
        .map((taskId) => taskId.trim().slice(0, 512))
        .filter((taskId, index, all) => all.indexOf(taskId) === index)
        .slice(0, MAX_GENERATION_TASK_OUTBOX_ENTRIES)
    : [];
  const retainedTaskIds = Array.isArray(candidate.retainedTaskIds)
    ? candidate.retainedTaskIds
        .filter((taskId): taskId is string => typeof taskId === 'string' && taskId.trim().length > 0)
        .map((taskId) => taskId.trim().slice(0, 512))
        .filter((taskId, index, all) => all.indexOf(taskId) === index)
        .slice(0, MAX_GENERATION_TASK_OUTBOX_ENTRIES)
    : [];
  const deletedAt = finiteNonNegative(candidate.deletedAt, -1);
  if (candidate.schemaVersion !== GENERATION_TASK_OUTBOX_SCHEMA_VERSION || deletedAt < 0) {
    return undefined;
  }
  return {
    schemaVersion: GENERATION_TASK_OUTBOX_SCHEMA_VERSION,
    conversationId,
    taskIds,
    ...(candidate.blockAll === true ? { blockAll: true } : {}),
    ...(retainedTaskIds.length ? { retainedTaskIds } : {}),
    deletedAt,
  };
}

async function readConversationTombstone(
  conversationId: string,
  storage: GenerationTaskOutboxStorage
): Promise<GenerationTaskOutboxConversationTombstone | undefined> {
  const raw = await storage.getItem(generationTaskOutboxConversationTombstoneStorageKey(conversationId));
  if (!raw) return undefined;
  try {
    return normalizeConversationTombstone(JSON.parse(raw), conversationId);
  } catch {
    return undefined;
  }
}

async function writeConversationTombstone(
  conversationId: string,
  taskIds: readonly string[],
  retainedTaskIds: readonly string[],
  blockAll: boolean,
  deletedAt: number,
  storage: GenerationTaskOutboxStorage
): Promise<void> {
  const normalizedTaskIds = [...new Set(taskIds.map((taskId) => taskId.trim()).filter(Boolean))]
    .slice(0, MAX_GENERATION_TASK_OUTBOX_ENTRIES);
  const normalizedRetainedTaskIds = [
    ...new Set(retainedTaskIds.map((taskId) => taskId.trim()).filter(Boolean)),
  ].slice(0, MAX_GENERATION_TASK_OUTBOX_ENTRIES);
  const tombstone: GenerationTaskOutboxConversationTombstone = {
    schemaVersion: GENERATION_TASK_OUTBOX_SCHEMA_VERSION,
    conversationId,
    taskIds: normalizedTaskIds,
    ...(blockAll ? { blockAll: true } : {}),
    ...(normalizedRetainedTaskIds.length
      ? { retainedTaskIds: normalizedRetainedTaskIds }
      : {}),
    deletedAt: Math.max(0, Math.trunc(deletedAt)),
  };
  await storage.setItem(
    generationTaskOutboxConversationTombstoneStorageKey(conversationId),
    JSON.stringify(tombstone)
  );
}

function tombstoneBlocksTask(
  tombstone: GenerationTaskOutboxConversationTombstone | undefined,
  taskId: string
): boolean {
  if (!tombstone) return false;
  if (tombstone.blockAll) {
    return !(tombstone.retainedTaskIds ?? []).includes(taskId);
  }
  return tombstone.taskIds.includes(taskId);
}

async function entryIsTombstoned(
  entry: Pick<GenerationTaskOutboxEntry, 'conversationId' | 'taskId'>,
  storage: GenerationTaskOutboxStorage
): Promise<boolean> {
  const tombstone = await readConversationTombstone(entry.conversationId, storage);
  return tombstoneBlocksTask(tombstone, entry.taskId);
}

async function withoutTombstonedEntries(
  entries: readonly GenerationTaskOutboxEntry[],
  storage: GenerationTaskOutboxStorage
): Promise<GenerationTaskOutboxEntry[]> {
  const tombstones = new Map<string, GenerationTaskOutboxConversationTombstone | undefined>();
  const visible: GenerationTaskOutboxEntry[] = [];
  for (const entry of entries) {
    if (!tombstones.has(entry.conversationId)) {
      tombstones.set(
        entry.conversationId,
        await readConversationTombstone(entry.conversationId, storage)
      );
    }
    if (!tombstoneBlocksTask(tombstones.get(entry.conversationId), entry.taskId)) {
      visible.push(entry);
    }
  }
  return visible;
}

function supportsPerEntryStorage(
  storage: GenerationTaskOutboxStorage
): storage is EnumerableGenerationTaskOutboxStorage {
  return (
    typeof storage.getAllKeys === 'function' &&
    (typeof storage.removeItem === 'function' || typeof storage.multiRemove === 'function')
  );
}

async function readEnvelope(storage: GenerationTaskOutboxStorage): Promise<GenerationTaskOutboxEnvelope> {
  const raw = await storage.getItem(GENERATION_TASK_OUTBOX_KEY);
  if (!raw) return emptyEnvelope();
  try {
    return normalizeEnvelope(JSON.parse(raw));
  } catch {
    return emptyEnvelope();
  }
}

async function persistEnvelope(
  envelope: GenerationTaskOutboxEnvelope,
  storage: GenerationTaskOutboxStorage
): Promise<void> {
  await storage.setItem(GENERATION_TASK_OUTBOX_KEY, JSON.stringify(envelope));
}

function sameWrite(
  observed: GenerationTaskOutboxEnvelope,
  expected: GenerationTaskOutboxEnvelope
): boolean {
  return observed.revision === expected.revision && observed.writeId === expected.writeId;
}

function sameEnvelopeSnapshot(
  observed: GenerationTaskOutboxEnvelope,
  expected: GenerationTaskOutboxEnvelope
): boolean {
  return sameWrite(observed, expected) && JSON.stringify(observed.entries) === JSON.stringify(expected.entries);
}

async function yieldForConcurrentRuntime(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function mutateLegacyEnvelope(
  storage: GenerationTaskOutboxStorage,
  mutate: (current: GenerationTaskOutboxEnvelope) => GenerationTaskOutboxEnvelope
): Promise<void> {
  const run = operationChain.catch(() => undefined).then(async () => {
    for (let attempt = 0; attempt < MAX_GENERATION_TASK_OUTBOX_WRITE_ATTEMPTS; attempt += 1) {
      const current = await readEnvelope(storage);
      if (current.revision >= Number.MAX_SAFE_INTEGER) {
        throw new GenerationTaskOutboxConflictError('生成任务队列版本已达安全上限，未继续写入。');
      }
      const mutated = normalizeEnvelope(mutate(current));
      const next: GenerationTaskOutboxEnvelope = {
        ...mutated,
        revision: current.revision + 1,
        writeId: createWriteId(),
      };
      const beforeWrite = await readEnvelope(storage);
      if (!sameEnvelopeSnapshot(beforeWrite, current)) continue;
      await persistEnvelope(next, storage);

      // AsyncStorage does not expose compare-and-set. Verify the exact writer
      // token twice across an event-loop turn so an overlapping headless or
      // foreground write is detected, then re-read and reapply the mutation.
      const firstReadBack = await readEnvelope(storage);
      if (!sameWrite(firstReadBack, next)) continue;
      await yieldForConcurrentRuntime();
      const settledReadBack = await readEnvelope(storage);
      if (sameWrite(settledReadBack, next)) return;
    }
    throw new GenerationTaskOutboxConflictError();
  });
  operationChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function readKeyValues(
  storage: EnumerableGenerationTaskOutboxStorage,
  keys: readonly string[]
): Promise<readonly (readonly [string, string | null])[]> {
  if (keys.length === 0) return [];
  if (storage.multiGet) return storage.multiGet(keys);
  return Promise.all(
    keys.map(async (key) => [key, await storage.getItem(key)] as const)
  );
}

async function removeKeys(
  storage: EnumerableGenerationTaskOutboxStorage,
  keys: readonly string[]
): Promise<void> {
  if (keys.length === 0) return;
  if (storage.multiRemove) {
    await storage.multiRemove(keys);
    return;
  }
  if (!storage.removeItem) {
    throw new Error('Generation task outbox storage cannot remove per-entry records.');
  }
  for (const key of keys) await storage.removeItem(key);
}

async function readPerEntryRecords(
  storage: EnumerableGenerationTaskOutboxStorage
): Promise<Array<{ key: string; entry: GenerationTaskOutboxEntry }>> {
  const keys = (await storage.getAllKeys()).filter((key) =>
    key.startsWith(GENERATION_TASK_OUTBOX_ENTRY_KEY_PREFIX)
  );
  const values = await readKeyValues(storage, keys);
  const records: Array<{ key: string; entry: GenerationTaskOutboxEntry }> = [];
  for (const [key, raw] of values) {
    if (!raw) continue;
    try {
      const entry = normalizeEntryRecord(JSON.parse(raw));
      if (!entry || generationTaskOutboxEntryStorageKey(entry.id) !== key) continue;
      records.push({ key, entry });
    } catch {
      // Ignore an isolated corrupt entry without discarding unrelated tasks.
    }
  }
  return records.sort(
    (a, b) => b.entry.updatedAt - a.entry.updatedAt || a.entry.id.localeCompare(b.entry.id)
  );
}

async function readPerEntryRecord(
  storage: EnumerableGenerationTaskOutboxStorage,
  key: string
): Promise<GenerationTaskOutboxEntry | undefined> {
  const raw = await storage.getItem(key);
  if (!raw) return undefined;
  try {
    const entry = normalizeEntryRecord(JSON.parse(raw));
    return entry && generationTaskOutboxEntryStorageKey(entry.id) === key ? entry : undefined;
  } catch {
    return undefined;
  }
}

async function writeMonotonicPerEntryRecord(
  storage: EnumerableGenerationTaskOutboxStorage,
  key: string,
  incoming: GenerationTaskOutboxEntry
): Promise<void> {
  let desired = incoming;
  for (let attempt = 0; attempt < MAX_GENERATION_TASK_OUTBOX_WRITE_ATTEMPTS; attempt += 1) {
    desired = mergeGenerationTaskOutboxEntry(await readPerEntryRecord(storage, key), desired);
    await storage.setItem(key, serializeEntryRecord(desired));
    await yieldForConcurrentRuntime();
    const observed = await readPerEntryRecord(storage, key);
    if (observed) {
      const merged = mergeGenerationTaskOutboxEntry(observed, desired);
      if (JSON.stringify(merged) === JSON.stringify(observed)) return;
      desired = merged;
    }
  }
  throw new GenerationTaskOutboxConflictError(
    'Generation task outbox entry kept changing across runtimes; the update was not persisted safely.'
  );
}

async function ensureLegacyEnvelopeMigrated(
  storage: EnumerableGenerationTaskOutboxStorage
): Promise<void> {
  if (await storage.getItem(GENERATION_TASK_OUTBOX_LEGACY_MIGRATION_KEY)) return;

  for (let attempt = 0; attempt < MAX_GENERATION_TASK_OUTBOX_WRITE_ATTEMPTS; attempt += 1) {
    const raw = await storage.getItem(GENERATION_TASK_OUTBOX_KEY);
    if (!raw) return;
    let envelope: GenerationTaskOutboxEnvelope;
    try {
      envelope = normalizeEnvelope(JSON.parse(raw));
    } catch {
      return;
    }

    for (const entry of envelope.entries) {
      if (await entryIsTombstoned(entry, storage)) continue;
      const key = generationTaskOutboxEntryStorageKey(entry.id);
      // Never overwrite a per-entry record that may already contain a newer
      // foreground or headless update. Migration is intentionally additive.
      if ((await storage.getItem(key)) === null) {
        if (await storage.getItem(GENERATION_TASK_OUTBOX_LEGACY_MIGRATION_KEY)) return;
        await storage.setItem(key, serializeEntryRecord(entry));
      }
    }

    if ((await storage.getItem(GENERATION_TASK_OUTBOX_KEY)) !== raw) continue;
    await storage.setItem(
      GENERATION_TASK_OUTBOX_LEGACY_MIGRATION_KEY,
      JSON.stringify({
        schemaVersion: GENERATION_TASK_OUTBOX_SCHEMA_VERSION,
        migratedAt: Date.now(),
        revision: envelope.revision,
        ...(envelope.writeId ? { writeId: envelope.writeId } : {}),
      })
    );
    return;
  }

  throw new GenerationTaskOutboxConflictError(
    '旧版生成任务队列在迁移期间持续变化，未安全切换到独立记录。'
  );
}

async function prunePerEntryRecords(
  storage: EnumerableGenerationTaskOutboxStorage
): Promise<void> {
  const records = await readPerEntryRecords(storage);
  if (records.length <= MAX_GENERATION_TASK_OUTBOX_ENTRIES) return;
  await removeKeys(
    storage,
    records.slice(MAX_GENERATION_TASK_OUTBOX_ENTRIES).map((record) => record.key)
  );
}

function withNotificationState(
  entry: GenerationTaskOutboxEntry,
  notificationState: GenerationTaskOutboxNotificationState
): GenerationTaskOutboxEntry {
  const notifiedStatus: GenerationTaskInfo['notifiedStatus'] =
    entry.state === 'completed' ? 'completed' : 'failed';
  return {
    ...entry,
    notificationState,
    generationTask:
      notificationState === 'sent' &&
      (entry.state === 'completed' || entry.state === 'failed' || entry.state === 'blocked')
        ? { ...entry.generationTask, notifiedStatus }
        : entry.generationTask,
  };
}

export async function readGenerationTaskOutbox(
  storage: GenerationTaskOutboxStorage = defaultStorage
): Promise<GenerationTaskOutboxEntry[]> {
  if (supportsPerEntryStorage(storage)) {
    await ensureLegacyEnvelopeMigrated(storage);
    const entries = (await readPerEntryRecords(storage))
      .slice(0, MAX_GENERATION_TASK_OUTBOX_ENTRIES)
      .map((record) => record.entry);
    return withoutTombstonedEntries(entries, storage);
  }
  await operationChain.catch(() => undefined);
  return withoutTombstonedEntries((await readEnvelope(storage)).entries, storage);
}

export async function upsertGenerationTaskOutbox(
  entry: GenerationTaskOutboxEntry,
  storage: GenerationTaskOutboxStorage = defaultStorage
): Promise<boolean> {
  const normalized = normalizeEntry(entry);
  if (!normalized) throw new Error('Invalid generation task outbox entry.');
  if (await entryIsTombstoned(normalized, storage)) return false;
  if (supportsPerEntryStorage(storage)) {
    await ensureLegacyEnvelopeMigrated(storage);
    const key = generationTaskOutboxEntryStorageKey(normalized.id);
    if (await entryIsTombstoned(normalized, storage)) return false;
    await writeMonotonicPerEntryRecord(storage, key, normalized);
    if (await entryIsTombstoned(normalized, storage)) {
      await removeKeys(storage, [key]);
      return false;
    }
    await prunePerEntryRecords(storage);
    return true;
  }
  await mutateLegacyEnvelope(storage, (current) => {
    const existingIndex = current.entries.findIndex((item) => item.id === normalized.id);
    const entries = [...current.entries];
    if (existingIndex >= 0) {
      entries.splice(existingIndex, 1, mergeGenerationTaskOutboxEntry(entries[existingIndex], normalized));
    }
    else entries.push(normalized);
    entries.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    return {
      schemaVersion: GENERATION_TASK_OUTBOX_SCHEMA_VERSION,
      revision: current.revision,
      entries: entries.slice(0, MAX_GENERATION_TASK_OUTBOX_ENTRIES),
    };
  });
  if (await entryIsTombstoned(normalized, storage)) {
    await removeGenerationTaskOutbox(normalized.id, storage);
    return false;
  }
  return true;
}

export async function updateGenerationTaskOutboxNotificationState(
  entryId: string,
  notificationState: GenerationTaskOutboxNotificationState,
  storage: GenerationTaskOutboxStorage = defaultStorage
): Promise<void> {
  if (supportsPerEntryStorage(storage)) {
    await ensureLegacyEnvelopeMigrated(storage);
    const key = generationTaskOutboxEntryStorageKey(entryId);
    const raw = await storage.getItem(key);
    if (!raw) return;
    let entry: GenerationTaskOutboxEntry | undefined;
    try {
      entry = normalizeEntryRecord(JSON.parse(raw));
    } catch {
      return;
    }
    if (!entry || entry.id !== entryId) return;
    if (await entryIsTombstoned(entry, storage)) {
      await removeKeys(storage, [key]);
      return;
    }
    await writeMonotonicPerEntryRecord(
      storage,
      key,
      withNotificationState(entry, notificationState)
    );
    if (await entryIsTombstoned(entry, storage)) await removeKeys(storage, [key]);
    return;
  }
  const existing = (await readEnvelope(storage)).entries.find((entry) => entry.id === entryId);
  if (existing && await entryIsTombstoned(existing, storage)) {
    await removeGenerationTaskOutbox(entryId, storage);
    return;
  }
  await mutateLegacyEnvelope(storage, (current) => {
    const entries = current.entries.map((entry): GenerationTaskOutboxEntry =>
      entry.id === entryId ? withNotificationState(entry, notificationState) : entry
    );
    return { ...current, entries };
  });
}

export async function removeGenerationTaskOutbox(
  entryId: string,
  storage: GenerationTaskOutboxStorage = defaultStorage
): Promise<void> {
  if (supportsPerEntryStorage(storage)) {
    await ensureLegacyEnvelopeMigrated(storage);
    await removeKeys(storage, [generationTaskOutboxEntryStorageKey(entryId)]);
    return;
  }
  await mutateLegacyEnvelope(storage, (current) => ({
    ...current,
    entries: current.entries.filter((entry) => entry.id !== entryId),
  }));
}

/**
 * Atomically marks deleted-conversation task IDs before removing their
 * records. Headless writers check the tombstone in upsert, so a stale worker
 * that was already querying cannot recreate a task after the delete commit.
 * Task IDs still referenced by a surviving branch are explicitly retained.
 */
export async function tombstoneAndRemoveGenerationTaskOutboxForConversation(
  conversationId: string,
  retainedTaskIds: ReadonlySet<string> = new Set(),
  deletedAt = Date.now(),
  storage: GenerationTaskOutboxStorage = defaultStorage
): Promise<GenerationTaskOutboxEntry[]> {
  if (supportsPerEntryStorage(storage)) await ensureLegacyEnvelopeMigrated(storage);
  else await operationChain.catch(() => undefined);
  const entries = supportsPerEntryStorage(storage)
    ? (await readPerEntryRecords(storage)).map((record) => record.entry)
    : (await readEnvelope(storage)).entries;
  const removable = entries.filter(
    (entry) => entry.conversationId === conversationId && !retainedTaskIds.has(entry.taskId)
  );
  const previous = await readConversationTombstone(conversationId, storage);
  const retainedTombstoneTaskIds = (previous?.taskIds ?? []).filter(
    (taskId) => !retainedTaskIds.has(taskId)
  );
  const taskIds = [
    ...retainedTombstoneTaskIds,
    ...removable.map((entry) => entry.taskId),
  ];
  await writeConversationTombstone(
    conversationId,
    taskIds,
    [...retainedTaskIds],
    true,
    deletedAt,
    storage
  );
  for (const entry of removable) await removeGenerationTaskOutbox(entry.id, storage);
  return removable;
}

export async function readGenerationTaskOutboxConversationTombstone(
  conversationId: string,
  storage: GenerationTaskOutboxStorage = defaultStorage
): Promise<GenerationTaskOutboxConversationTombstone | undefined> {
  return readConversationTombstone(conversationId, storage);
}

export function createGenerationTaskOutboxEntry(input: {
  task: GenerationTaskInfo;
  conversationId: string;
  messageId: string;
  state: GenerationTaskOutboxState;
  now: number;
  attemptCount: number;
  content?: string;
  error?: string;
  attachments?: readonly MediaAttachment[];
}): GenerationTaskOutboxEntry {
  const generationTask: GenerationTaskInfo = {
    ...input.task,
    ...(input.task.lastCheckedAt !== undefined
      ? { lastCheckedAt: input.task.lastCheckedAt }
      : {}),
    ...(input.task.nextCheckAt !== undefined ? { nextCheckAt: input.task.nextCheckAt } : {}),
    attemptCount: Math.max(0, Math.trunc(input.attemptCount)),
  };
  return {
    id: `${input.task.taskId}:${input.messageId}`,
    conversationId: input.conversationId,
    messageId: input.messageId,
    taskId: input.task.taskId,
    providerId: input.task.providerId,
    modelId: input.task.modelId,
    state: input.state,
    ...(input.content ? { content: input.content.slice(0, MAX_GENERATION_TASK_OUTBOX_CONTENT) } : {}),
    ...(input.error ? { error: input.error.slice(0, 4_000) } : {}),
    ...(input.attachments?.length
      ? { attachments: input.attachments.map(cloneAttachment) }
      : {}),
    generationTask,
    attemptCount: generationTask.attemptCount ?? 0,
    createdAt: input.now,
    updatedAt: input.now,
    notificationState: 'pending',
  };
}

function patchMessageFromOutbox(
  message: ChatMessage,
  entry: GenerationTaskOutboxEntry
): ChatMessage {
  if (message.role !== 'assistant' || message.generationTask?.taskId !== entry.taskId) {
    return message;
  }
  const next: ChatMessage = {
    ...message,
    ...(entry.content !== undefined ? { content: entry.content } : {}),
    ...(entry.attachments?.length ? { attachments: entry.attachments.map(cloneAttachment) } : {}),
    generationTask: { ...entry.generationTask },
  };
  if (entry.state === 'completed') {
    next.status = 'ready';
    delete next.error;
  } else if (entry.state === 'failed' || entry.state === 'blocked') {
    next.status = 'error';
    next.error = entry.error ?? '生成任务失败。';
  } else {
    // Keep the assistant pending while a provider task is still running.
    next.status = message.status === 'error' ? 'pending' : message.status;
    delete next.error;
  }
  return next;
}

/** Pure reducer used by the foreground WorkspaceSession to apply one result. */
export function applyGenerationTaskOutboxEntry(
  workspace: AppWorkspace,
  entry: GenerationTaskOutboxEntry,
  now = Date.now()
): AppWorkspace {
  let changed = false;
  const updateMessages = (messages: ChatMessage[]): ChatMessage[] => {
    const updated = messages.map((message) => {
      const next = patchMessageFromOutbox(message, entry);
      if (next !== message) changed = true;
      return next;
    });
    return updated;
  };

  const topLevelMessages = updateMessages(workspace.messages);
  const conversations = workspace.conversations.map((conversation) => {
    const messages = updateMessages(conversation.messages);
    if (messages === conversation.messages || !messages.some((message, i) => message !== conversation.messages[i])) {
      return conversation;
    }
    return { ...conversation, messages, updatedAt: now };
  });

  // A task can be represented in a branch copy. If an older persisted snapshot
  // lacks the task ID but has the same canonical message, avoid silently
  // dropping the result when the source occurrence is still present.
  if (!changed) {
    const canonical = workspace.conversations
      .find((conversation) => conversation.id === entry.conversationId)
      ?.messages.find((message) => message.id === entry.messageId);
    if (canonical) {
      const canonicalId = canonicalMessageId(canonical);
      const fallbackUpdate = (message: ChatMessage) =>
        message.role === 'assistant' && canonicalMessageId(message) === canonicalId
          ? patchMessageFromOutbox({ ...message, generationTask: entry.generationTask }, entry)
          : message;
      const fallbackMessages = workspace.messages.map(fallbackUpdate);
      const fallbackConversations = workspace.conversations.map((conversation) => ({
        ...conversation,
        messages: conversation.messages.map(fallbackUpdate),
        updatedAt: now,
      }));
      if (
        fallbackMessages.some((message, i) => message !== workspace.messages[i]) ||
        fallbackConversations.some((conversation, i) => conversation !== workspace.conversations[i])
      ) {
        return { ...workspace, messages: fallbackMessages, conversations: fallbackConversations };
      }
    }
    return workspace;
  }
  return { ...workspace, messages: topLevelMessages, conversations };
}

export function applyGenerationTaskOutboxEntries(
  workspace: AppWorkspace,
  entries: readonly GenerationTaskOutboxEntry[],
  now = Date.now()
): { workspace: AppWorkspace; appliedIds: string[] } {
  let current = workspace;
  const appliedIds: string[] = [];
  for (const entry of entries) {
    const next = applyGenerationTaskOutboxEntry(current, entry, now);
    if (next !== current) {
      current = next;
      appliedIds.push(entry.id);
    }
  }
  return { workspace: current, appliedIds };
}
