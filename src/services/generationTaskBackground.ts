import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import type { WorkspaceSession } from '../app/workspace/WorkspaceSession';
import type { AppWorkspace, GenerationTaskInfo, ProviderProfile } from '../domain/types';
import {
  deriveGenerationTasks,
  generationTaskState,
  type GenerationTaskListItem,
} from './generationTasks';
import {
  applyGenerationTaskOutboxEntries,
  createGenerationTaskOutboxEntry,
  readGenerationTaskOutbox,
  removeGenerationTaskOutbox,
  updateGenerationTaskOutboxNotificationState,
  upsertGenerationTaskOutbox,
  type GenerationTaskOutboxEntry,
  type GenerationTaskOutboxState,
} from './generationTaskOutbox';
import { reconcileGenerationTaskCleanupJournal } from './generationTaskCleanupJournal';
import { notifyGenerationTaskCompletedOrFailed } from './generationTaskNotifications';
import { isAbortError, queryGenerationTask } from './openAiCompatible';
import { loadWorkspace } from './storage';

export const GENERATION_TASK_BACKGROUND_IDENTIFIER = 'embezzle-generation-task-recovery';
export const GENERATION_TASK_BACKGROUND_MINIMUM_INTERVAL_MINUTES = 15;
export const GENERATION_TASK_BACKGROUND_QUERY_TIMEOUT_MS = 30_000;
export const MAX_GENERATION_TASKS_PER_BACKGROUND_RUN = 8;

export interface GenerationTaskQueryFailure {
  state: Extract<GenerationTaskOutboxState, 'pending' | 'failed' | 'blocked'>;
  message: string;
}

let registrationChain: Promise<void> = Promise.resolve();
let foregroundApplyChain: Promise<string[]> = Promise.resolve([]);

function normalizedErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error ?? '生成任务查询失败。'))
    .normalize('NFKC')
    .replace(/(?:api[_-]?key|authorization|token|secret)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .slice(0, 4_000);
}

export function classifyGenerationTaskQueryError(error: unknown): GenerationTaskQueryFailure {
  const message = normalizedErrorMessage(error);
  const normalized = message.toLowerCase();
  if (
    /\b(?:401|403)\b|unauthori[sz]ed|forbidden|invalid[_ -]?(?:api[_ -]?)?key|authentication|missing.+(?:key|provider)|provider.+(?:disabled|missing)|api key|权限|鉴权|密钥|服务商.+(?:停用|不存在)/u.test(
      normalized
    )
  ) {
    return { state: 'blocked', message };
  }
  if (
    /\b404\b|\b(?:expired|cancelled|canceled)\b|任务.{0,8}(?:过期|已取消|失败)|video generation task.{0,24}failed/u.test(
      normalized
    )
  ) {
    return { state: 'failed', message };
  }
  return { state: 'pending', message };
}

function nextBackgroundCheckAt(now: number, attemptCount: number): number {
  const base = GENERATION_TASK_BACKGROUND_MINIMUM_INTERVAL_MINUTES * 60_000;
  const exponent = Math.max(0, Math.min(5, attemptCount - 1));
  return now + base * 2 ** exponent;
}

function providerForTask(
  workspace: AppWorkspace,
  task: GenerationTaskInfo
): ProviderProfile | undefined {
  return workspace.providers.find((provider) => provider.id === task.providerId);
}

async function queryTaskWithTimeout(
  provider: ProviderProfile,
  task: GenerationTaskInfo
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GENERATION_TASK_BACKGROUND_QUERY_TIMEOUT_MS);
  try {
    return await queryGenerationTask(provider, task, controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

async function persistEntryAndMaybeNotify(
  entry: GenerationTaskOutboxEntry,
  previous?: GenerationTaskOutboxEntry
): Promise<void> {
  const alreadyNotified =
    previous?.state === entry.state && previous.notificationState === 'sent';
  const nextEntry = alreadyNotified
    ? {
        ...entry,
        notificationState: 'sent' as const,
        generationTask: {
          ...entry.generationTask,
          notifiedStatus: entry.state === 'completed' ? ('completed' as const) : ('failed' as const),
        },
      }
    : entry;
  const persisted = await upsertGenerationTaskOutbox(nextEntry);
  if (!persisted) return;
  if (
    alreadyNotified ||
    (entry.state !== 'completed' && entry.state !== 'failed' && entry.state !== 'blocked')
  ) {
    return;
  }
  const notificationState = await notifyGenerationTaskCompletedOrFailed(nextEntry);
  await updateGenerationTaskOutboxNotificationState(nextEntry.id, notificationState);
}

export interface GenerationTaskRecoveryResult {
  attempted: number;
  completed: number;
  failed: number;
  blocked: number;
  pending: number;
  skipped: number;
}

function isTerminalGenerationTaskOutboxState(
  state: GenerationTaskOutboxState
): state is Extract<GenerationTaskOutboxState, 'completed' | 'failed' | 'blocked'> {
  return state === 'completed' || state === 'failed' || state === 'blocked';
}

/**
 * Retries terminal notifications without querying the provider again. A
 * denied permission or transient notification/channel failure is persisted as
 * a non-sent state, so a later foreground/background run can retry it.
 */
export async function retryPendingGenerationTaskNotifications(
  entries: readonly GenerationTaskOutboxEntry[],
  retry: (entry: GenerationTaskOutboxEntry) => Promise<void> = (entry) =>
    persistEntryAndMaybeNotify(entry, entry)
): Promise<number> {
  let retried = 0;
  for (const entry of entries) {
    if (!isTerminalGenerationTaskOutboxState(entry.state) || entry.notificationState === 'sent') {
      continue;
    }
    await retry(entry);
    retried += 1;
  }
  return retried;
}

/**
 * Orders active tasks so a permanently pending first page cannot starve later
 * tasks. Due/never-checked tasks win over scheduled retries; within a class,
 * the oldest check is preferred. The persisted outbox supplies the latest
 * nextCheckAt/lastCheckedAt values because a headless run cannot mutate the
 * foreground workspace directly.
 */
export function orderGenerationTaskCandidates(
  items: readonly GenerationTaskListItem[],
  existingById: ReadonlyMap<string, GenerationTaskOutboxEntry>,
  now: number
): GenerationTaskListItem[] {
  return [...items].sort((left, right) => {
    const leftPrevious = existingById.get(`${left.task.taskId}:${left.messageId}`);
    const rightPrevious = existingById.get(`${right.task.taskId}:${right.messageId}`);
    const leftTask = leftPrevious ? { ...left.task, ...leftPrevious.generationTask } : left.task;
    const rightTask = rightPrevious ? { ...right.task, ...rightPrevious.generationTask } : right.task;
    const leftDue = leftTask.nextCheckAt === undefined || leftTask.nextCheckAt <= now;
    const rightDue = rightTask.nextCheckAt === undefined || rightTask.nextCheckAt <= now;
    return (
      Number(rightDue) - Number(leftDue) ||
      (leftTask.nextCheckAt ?? 0) - (rightTask.nextCheckAt ?? 0) ||
      (leftTask.lastCheckedAt ?? 0) - (rightTask.lastCheckedAt ?? 0) ||
      right.createdAt - left.createdAt ||
      left.key.localeCompare(right.key)
    );
  });
}

/**
 * Queries due tasks exactly once each. This is suitable for a WorkManager wake;
 * it deliberately does not run a long polling loop in the background.
 */
export async function runDueGenerationTaskQueries(
  workspace: AppWorkspace,
  options: { now?: number; ignoreSchedule?: boolean } = {}
): Promise<GenerationTaskRecoveryResult> {
  const now = Math.max(0, Math.trunc(options.now ?? Date.now()));
  const existingOutbox = await readGenerationTaskOutbox();
  const existingById = new Map(existingOutbox.map((entry) => [entry.id, entry]));
  // Terminal entries are intentionally handled before selecting provider
  // queries. They must not consume the query cap, but their notification may
  // need another attempt after a denied permission/channel/network failure.
  const retriedNotifications = await retryPendingGenerationTaskNotifications(existingOutbox);
  const activeTasks = orderGenerationTaskCandidates(
    deriveGenerationTasks(workspace.conversations).filter((item) => item.state === 'active'),
    existingById,
    now
  )
    // Terminal outbox entries are waiting for foreground application/cleanup,
    // not another provider query; do not let them consume this run's query cap.
    .filter((item) => {
      const previous = existingById.get(`${item.task.taskId}:${item.messageId}`);
      return !previous || (
        previous.state !== 'completed' &&
        previous.state !== 'failed' &&
        previous.state !== 'blocked'
      );
    })
    .slice(0, MAX_GENERATION_TASKS_PER_BACKGROUND_RUN);
  const result: GenerationTaskRecoveryResult = {
    attempted: 0,
    completed: 0,
    failed: 0,
    blocked: 0,
    pending: 0,
    skipped: retriedNotifications,
  };

  for (const item of activeTasks) {
    const entryId = `${item.task.taskId}:${item.messageId}`;
    const previous = existingById.get(entryId);
    // Terminal entries were retried above and are excluded from activeTasks;
    // keep this guard for callers supplying a custom/legacy candidate list.
    if (previous && isTerminalGenerationTaskOutboxState(previous.state)) {
      result.skipped += 1;
      continue;
    }
    const effectiveTask: GenerationTaskInfo = previous
      ? { ...item.task, ...previous.generationTask }
      : item.task;
    const attemptCount = Math.max(0, previous?.attemptCount ?? effectiveTask.attemptCount ?? 0) + 1;
    if (
      !options.ignoreSchedule &&
      effectiveTask.nextCheckAt !== undefined &&
      effectiveTask.nextCheckAt > now
    ) {
      result.skipped += 1;
      continue;
    }
    result.attempted += 1;
    const provider = providerForTask(workspace, effectiveTask);
    if (!provider || provider.enabled === false || !provider.apiKey?.trim()) {
      const message = !provider
        ? '任务对应的服务商已不存在。'
        : provider.enabled === false
          ? '任务对应的服务商已停用。'
          : '任务对应的服务商缺少 API Key。';
      const task: GenerationTaskInfo = {
        ...effectiveTask,
        status: 'blocked',
        lastCheckedAt: now,
        attemptCount,
      };
      delete task.nextCheckAt;
      const entry = createGenerationTaskOutboxEntry({
        task,
        conversationId: item.conversationId,
        messageId: item.messageId,
        state: 'blocked',
        now,
        attemptCount,
        error: message,
      });
      await persistEntryAndMaybeNotify(entry, previous);
      result.blocked += 1;
      continue;
    }

    try {
      const response = await queryTaskWithTimeout(provider, effectiveTask);
      const responseTask: GenerationTaskInfo = {
        ...(response.generationTask ?? effectiveTask),
        lastCheckedAt: now,
        attemptCount,
      };
      const video = response.attachments?.find((attachment) => attachment.kind === 'video');
      const state = generationTaskState(responseTask, video);
      const outboxState: GenerationTaskOutboxState =
        state === 'completed' ? 'completed' : state === 'failed' ? 'failed' : 'pending';
      if (outboxState === 'pending') {
        responseTask.nextCheckAt = nextBackgroundCheckAt(now, attemptCount);
      } else {
        delete responseTask.nextCheckAt;
      }
      const entry = createGenerationTaskOutboxEntry({
        task: responseTask,
        conversationId: item.conversationId,
        messageId: item.messageId,
        state: outboxState,
        now,
        attemptCount,
        content: response.content,
        attachments: response.attachments,
        ...(outboxState === 'failed' ? { error: response.content } : {}),
      });
      await persistEntryAndMaybeNotify(entry, previous);
      result[outboxState] += 1;
    } catch (error) {
      const classified = classifyGenerationTaskQueryError(error);
      const task: GenerationTaskInfo = {
        ...effectiveTask,
        status:
          classified.state === 'blocked'
            ? 'blocked'
            : classified.state === 'failed'
              ? 'failed'
              : effectiveTask.status,
        lastCheckedAt: now,
        attemptCount,
      };
      if (classified.state === 'pending') {
        task.nextCheckAt = nextBackgroundCheckAt(now, attemptCount);
      } else {
        delete task.nextCheckAt;
      }
      const entry = createGenerationTaskOutboxEntry({
        task,
        conversationId: item.conversationId,
        messageId: item.messageId,
        state: classified.state,
        now,
        attemptCount,
        error:
          isAbortError(error) && classified.state === 'pending'
            ? '生成任务查询超时，将稍后重试。'
            : classified.message,
      });
      await persistEntryAndMaybeNotify(entry, previous);
      result[classified.state] += 1;
    }
  }
  return result;
}

export async function runGenerationTaskBackgroundWorker(): Promise<BackgroundTask.BackgroundTaskResult> {
  if (Platform.OS === 'web') return BackgroundTask.BackgroundTaskResult.Success;
  try {
    const workspace = await loadWorkspace();
    if (!workspace) return BackgroundTask.BackgroundTaskResult.Success;
    await runDueGenerationTaskQueries(workspace);
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
}

if (!TaskManager.isTaskDefined(GENERATION_TASK_BACKGROUND_IDENTIFIER)) {
  TaskManager.defineTask(GENERATION_TASK_BACKGROUND_IDENTIFIER, runGenerationTaskBackgroundWorker);
}

export function ensureGenerationTaskBackgroundRegistration(
  workspace: AppWorkspace
): Promise<void> {
  if (Platform.OS === 'web') return Promise.resolve();
  const hasActiveTasks = deriveGenerationTasks(workspace.conversations).some(
    (item) => item.state === 'active'
  );
  registrationChain = registrationChain.catch(() => undefined).then(async () => {
    const registered = await TaskManager.isTaskRegisteredAsync(
      GENERATION_TASK_BACKGROUND_IDENTIFIER
    );
    if (hasActiveTasks && !registered) {
      await BackgroundTask.registerTaskAsync(GENERATION_TASK_BACKGROUND_IDENTIFIER, {
        minimumInterval: GENERATION_TASK_BACKGROUND_MINIMUM_INTERVAL_MINUTES,
      });
    } else if (!hasActiveTasks && registered) {
      await BackgroundTask.unregisterTaskAsync(GENERATION_TASK_BACKGROUND_IDENTIFIER);
    }
  });
  return registrationChain;
}

/**
 * Applies headless results through the one writable WorkspaceSession, flushes
 * them durably, and only then removes the corresponding outbox records.
 */
export function applyGenerationTaskOutboxToSession(
  session: WorkspaceSession,
  now = Date.now()
): Promise<string[]> {
  foregroundApplyChain = foregroundApplyChain.catch(() => []).then(async () => {
    if (session.getStatus().phase !== 'ready') return [];
    const entries = await readGenerationTaskOutbox();
    let appliedIds: string[] = [];
    if (entries.length) {
      const commit = session.bindCommitPort((workspace: AppWorkspace, command: GenerationTaskOutboxEntry[]) => {
        const applied = applyGenerationTaskOutboxEntries(workspace, command, now);
        return { workspace: applied.workspace, result: applied.appliedIds };
      });
      appliedIds = await commit.execute(entries, { durability: 'required' });
      for (const entryId of appliedIds) await removeGenerationTaskOutbox(entryId);
    }
    const status = session.getStatus();
    await reconcileGenerationTaskCleanupJournal(session.getSnapshot(), {
      dirty: status.dirty,
    });
    return appliedIds;
  });
  return foregroundApplyChain;
}
