import * as Notifications from 'expo-notifications';
import { Linking, Platform } from 'react-native';

import type { GenerationTaskOutboxEntry } from './generationTaskOutbox';

export const GENERATION_TASK_NOTIFICATION_CHANNEL_ID = 'generation-tasks';

export type GenerationTaskNotificationPermission =
  | 'granted'
  | 'denied'
  | 'undetermined'
  | 'unavailable';

export interface GenerationTaskNotificationRoute {
  taskId: string;
  conversationId?: string;
  messageId?: string;
  state: 'completed' | 'failed' | 'blocked';
}

let handlerInstalled = false;
let channelPromise: Promise<void> | null = null;

function safeNotificationText(value: string | undefined, fallback: string): string {
  const text = (value ?? fallback)
    .replace(/https?:\/\/\S+/gi, '[endpoint]')
    .replace(/(?:api[_-]?key|authorization|token|secret)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return (text || fallback).slice(0, 180);
}

/** Installs foreground presentation behavior once. Safe to call from app startup. */
export function installGenerationTaskNotificationHandler(): void {
  if (Platform.OS === 'web' || handlerInstalled) return;
  handlerInstalled = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

export async function ensureGenerationTaskNotificationChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  if (!channelPromise) {
    channelPromise = Notifications.setNotificationChannelAsync(
      GENERATION_TASK_NOTIFICATION_CHANNEL_ID,
      {
        name: '生成任务',
        description: '视频和其他长时间生成任务的完成或失败提醒。',
        importance: Notifications.AndroidImportance.DEFAULT,
        sound: null,
        vibrationPattern: [0, 120],
        enableVibrate: true,
      }
    )
      .then(() => undefined)
      .catch((error) => {
        channelPromise = null;
        throw error;
      });
  }
  await channelPromise;
}

export async function getGenerationTaskNotificationPermission(): Promise<GenerationTaskNotificationPermission> {
  if (Platform.OS === 'web') return 'unavailable';
  try {
    const response = await Notifications.getPermissionsAsync();
    if (response.granted || response.status === 'granted') return 'granted';
    if (response.status === 'undetermined') return 'undetermined';
    return 'denied';
  } catch {
    return 'unavailable';
  }
}

/** Call only from an explicit user action, never from a headless worker. */
export async function requestGenerationTaskNotificationPermission(): Promise<GenerationTaskNotificationPermission> {
  if (Platform.OS === 'web') return 'unavailable';
  try {
    await ensureGenerationTaskNotificationChannel();
    const response = await Notifications.requestPermissionsAsync();
    if (response.granted || response.status === 'granted') return 'granted';
    if (response.status === 'undetermined') return 'undetermined';
    return 'denied';
  } catch {
    return 'unavailable';
  }
}

/**
 * Opens the operating-system notification settings after the user has denied
 * the runtime prompt. This is deliberately explicit; background workers and
 * app startup must never navigate the user without an action.
 */
export async function openGenerationTaskNotificationSettings(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    await Linking.openSettings();
    return true;
  } catch {
    return false;
  }
}

/**
 * Schedules one immediate local notification. It never requests permission and
 * therefore remains safe in a headless/background execution context.
 */
export async function notifyGenerationTaskCompletedOrFailed(
  entry: GenerationTaskOutboxEntry
): Promise<'sent' | 'skipped' | 'failed'> {
  if (Platform.OS === 'web' || (entry.state !== 'completed' && entry.state !== 'failed' && entry.state !== 'blocked')) {
    return 'skipped';
  }
  try {
    const permission = await getGenerationTaskNotificationPermission();
    if (permission !== 'granted') return 'skipped';
    await ensureGenerationTaskNotificationChannel();
    const completed = entry.state === 'completed';
    await Notifications.scheduleNotificationAsync({
      identifier: `generation-task:${entry.taskId}:${completed ? 'completed' : 'failed'}`,
      content: {
        title: completed ? '生成任务已完成' : '生成任务未完成',
        body: completed
          ? '视频生成结果已回到对话中。'
          : safeNotificationText(entry.error, '视频生成任务失败，请打开任务中心查看详情。'),
        data: {
          type: 'generation-task',
          taskId: entry.taskId,
          conversationId: entry.conversationId,
          messageId: entry.messageId,
          state: entry.state,
        },
        sound: false,
        ...(Platform.OS === 'android'
          ? { channelId: GENERATION_TASK_NOTIFICATION_CHANNEL_ID }
          : {}),
      },
      trigger: null,
    });
    return 'sent';
  } catch {
    return 'failed';
  }
}

export async function getLastGenerationTaskNotificationResponse(): Promise<
  Notifications.NotificationResponse | null
> {
  if (Platform.OS === 'web') return null;
  try {
    const response = await Notifications.getLastNotificationResponseAsync();
    return response ?? null;
  } catch {
    return null;
  }
}

/** Clears the OS-held cold-start response after the app has consumed it. */
export async function clearLastGenerationTaskNotificationResponse(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    await Notifications.clearLastNotificationResponseAsync();
  } catch {
    // Some older native builds do not expose this optional emitter method.
  }
}

/**
 * Validates the small, local-only payload attached to a task notification.
 * Notification data is external input from the operating system and must not
 * be trusted as an arbitrary navigation object.
 */
export function parseGenerationTaskNotificationResponse(
  response: Notifications.NotificationResponse | null | undefined
): GenerationTaskNotificationRoute | null {
  return parseGenerationTaskNotificationData(response?.notification.request.content.data);
}

export function parseGenerationTaskNotificationData(data: unknown): GenerationTaskNotificationRoute | null {
  if (!data || typeof data !== 'object') return null;
  const candidate = data as Record<string, unknown>;
  if (candidate.type !== 'generation-task') return null;
  if (typeof candidate.taskId !== 'string' || !candidate.taskId.trim()) return null;
  if (candidate.state !== 'completed' && candidate.state !== 'failed' && candidate.state !== 'blocked') {
    return null;
  }
  const route: GenerationTaskNotificationRoute = {
    taskId: candidate.taskId.trim().slice(0, 256),
    state: candidate.state,
  };
  if (typeof candidate.conversationId === 'string' && candidate.conversationId.trim()) {
    route.conversationId = candidate.conversationId.trim().slice(0, 256);
  }
  if (typeof candidate.messageId === 'string' && candidate.messageId.trim()) {
    route.messageId = candidate.messageId.trim().slice(0, 256);
  }
  return route;
}

export function subscribeToGenerationTaskNotificationResponses(
  listener: (response: Notifications.NotificationResponse) => void
): { remove(): void } | null {
  if (Platform.OS === 'web') return null;
  return Notifications.addNotificationResponseReceivedListener(listener);
}
