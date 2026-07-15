import type {
  AppWorkspace,
  BackupPreferences,
  CloudSyncConflict,
  CloudSyncSettings,
  ConversationDraft,
  ExperienceMode,
  MediaAttachment,
  OnboardingState,
  OnboardingStep,
  ProviderProfile,
} from '../domain/types';
import { MAX_ATTACHMENT_COUNT, validateAttachments } from './attachmentLimits';
import { inferModelTask } from './modelCapabilities';
import { sliceUnicodeCharacters, unicodeCharacterLengthExceeds } from './textBounds';

export const MAX_CONVERSATION_DRAFTS = 100;
export const MAX_CONVERSATION_DRAFT_CHARACTERS = 50_000;
export const MAX_CONVERSATION_DRAFT_ATTACHMENTS = MAX_ATTACHMENT_COUNT;
export const MAX_ARTIFACT_TAGS = 12;
export const MAX_ARTIFACT_TAG_CHARACTERS = 32;
export const MAX_SYNC_CONFLICTS = 20;
export const MAX_SYNC_TEXT_FIELD_CHARACTERS = 512;

const onboardingSteps = new Set<OnboardingStep>([
  'provider',
  'credentials',
  'connection',
  'models',
  'sample',
]);
const syncStatuses = new Set<CloudSyncSettings['lastStatus']>([
  'idle',
  'syncing',
  'synced',
  'conflict',
  'error',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

function normalizeDraftAttachment(value: unknown): MediaAttachment | undefined {
  if (!isRecord(value)) return undefined;
  const id = boundedText(value.id, 256);
  const uri = boundedText(value.uri, 16_384);
  const name = boundedText(value.name, 512);
  const kind = value.kind;
  if (
    !id ||
    !uri ||
    uri.startsWith('data:') ||
    !name ||
    (kind !== 'image' && kind !== 'video' && kind !== 'file')
  ) {
    return undefined;
  }
  const mimeType = boundedText(value.mimeType, 256);
  const size = finiteNonNegativeNumber(value.size);
  const width = finiteNonNegativeNumber(value.width);
  const height = finiteNonNegativeNumber(value.height);
  const durationMs = finiteNonNegativeNumber(value.durationMs);
  return {
    id,
    uri,
    name,
    kind,
    ...(mimeType ? { mimeType } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    base64: null,
  };
}

function normalizeDraftAttachments(value: unknown): MediaAttachment[] {
  if (!Array.isArray(value)) return [];
  // Do not silently truncate an untrusted persisted set. A count over the
  // composer limit means the whole set is unsafe to restore; returning an
  // empty set also avoids mapping attacker-controlled oversized arrays.
  if (value.length > MAX_CONVERSATION_DRAFT_ATTACHMENTS) return [];
  const attachments = value
    .map(normalizeDraftAttachment)
    .filter((attachment): attachment is MediaAttachment => Boolean(attachment));
  try {
    validateAttachments(attachments);
    return attachments;
  } catch {
    return [];
  }
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

function boundedText(value: unknown, maximum = MAX_SYNC_TEXT_FIELD_CHARACTERS): string {
  if (typeof value !== 'string') return '';
  const normalized = value.normalize('NFKC').trim();
  return unicodeCharacterLengthExceeds(normalized, maximum)
    ? sliceUnicodeCharacters(normalized, maximum)
    : normalized;
}

function optionalBoundedText(
  value: unknown,
  maximum = MAX_SYNC_TEXT_FIELD_CHARACTERS
): string | undefined {
  const normalized = boundedText(value, maximum);
  return normalized || undefined;
}

function normalizedDigest(value: unknown): string | undefined {
  const digest = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[a-f0-9]{64}$/u.test(digest) ? digest : undefined;
}

export function createLocalDeviceId(
  now = Date.now(),
  random: () => number = Math.random
): string {
  return `device-${Math.max(0, Math.trunc(now)).toString(36)}-${random()
    .toString(36)
    .slice(2, 10)}`;
}

export function normalizeExperienceMode(value: unknown): ExperienceMode {
  return value === 'advanced' ? 'advanced' : 'simple';
}

export function hasUsableProviderConfiguration(
  providers: readonly ProviderProfile[],
  activeModelIdByProvider: Readonly<Record<string, string>>
): boolean {
  return providers.some((provider) => {
    if (provider.enabled === false || !provider.apiKey?.trim()) return false;
    const selectedId = activeModelIdByProvider[provider.id];
    const model = provider.models.find((candidate) => candidate.id === selectedId)
      ?? provider.models.find((candidate) => candidate.source !== 'remote');
    return Boolean(model && inferModelTask(model) === 'chat');
  });
}

export function normalizeOnboardingState(
  value: unknown,
  configured: boolean
): OnboardingState {
  if (!isRecord(value)) {
    return configured
      ? { status: 'completed', lastStep: 'sample' }
      : { status: 'pending', lastStep: 'provider' };
  }

  const lastStep = onboardingSteps.has(value.lastStep as OnboardingStep)
    ? value.lastStep as OnboardingStep
    : 'provider';
  const completedAt = finiteTimestamp(value.completedAt);
  const dismissedAt = finiteTimestamp(value.dismissedAt);
  if (value.status === 'completed') {
    return {
      status: 'completed',
      lastStep: 'sample',
      ...(completedAt !== undefined ? { completedAt } : {}),
    };
  }
  if (value.status === 'dismissed') {
    return {
      status: 'dismissed',
      lastStep,
      ...(dismissedAt !== undefined ? { dismissedAt } : {}),
    };
  }
  return { status: 'pending', lastStep };
}

export function normalizeConversationDrafts(
  value: unknown,
  conversationIds: ReadonlySet<string>
): ConversationDraft[] {
  if (!Array.isArray(value)) return [];
  const byConversation = new Map<string, ConversationDraft>();
  for (const candidate of value.slice(0, MAX_CONVERSATION_DRAFTS * 2)) {
    if (!isRecord(candidate)) continue;
    const conversationId = boundedText(candidate.conversationId, 256);
    if (!conversationId || !conversationIds.has(conversationId)) continue;
    const rawText = typeof candidate.text === 'string' ? candidate.text : '';
    const text = unicodeCharacterLengthExceeds(rawText, MAX_CONVERSATION_DRAFT_CHARACTERS)
      ? sliceUnicodeCharacters(rawText, MAX_CONVERSATION_DRAFT_CHARACTERS)
      : rawText;
    const attachments = normalizeDraftAttachments(candidate.attachments);
    if (!text && !attachments.length) continue;
    const updatedAt = finiteTimestamp(candidate.updatedAt) ?? 0;
    const current = byConversation.get(conversationId);
    if (!current || updatedAt >= current.updatedAt) {
      byConversation.set(conversationId, {
        conversationId,
        text,
        updatedAt,
        ...(attachments.length ? { attachments } : {}),
      });
    }
  }
  return [...byConversation.values()]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_CONVERSATION_DRAFTS);
}

export function upsertConversationDraft(
  drafts: readonly ConversationDraft[],
  conversationId: string,
  text: string,
  updatedAt: number,
  attachments: readonly MediaAttachment[] = []
): ConversationDraft[] {
  const normalizedId = boundedText(conversationId, 256);
  if (!normalizedId) return [...drafts];
  const bounded = unicodeCharacterLengthExceeds(text, MAX_CONVERSATION_DRAFT_CHARACTERS)
    ? sliceUnicodeCharacters(text, MAX_CONVERSATION_DRAFT_CHARACTERS)
    : text;
  const normalizedAttachments = normalizeDraftAttachments(attachments);
  const remaining = drafts.filter((draft) => draft.conversationId !== normalizedId);
  if (!bounded && !normalizedAttachments.length) return remaining;
  return [
    {
      conversationId: normalizedId,
      text: bounded,
      updatedAt: Math.max(0, Math.trunc(updatedAt)),
      ...(normalizedAttachments.length ? { attachments: normalizedAttachments } : {}),
    },
    ...remaining,
  ].slice(0, MAX_CONVERSATION_DRAFTS);
}

export function normalizeBackupPreferences(value: unknown): BackupPreferences {
  if (!isRecord(value)) return { reminderIntervalDays: 14 };
  const reminderIntervalDays = [0, 7, 14, 30].includes(value.reminderIntervalDays as number)
    ? value.reminderIntervalDays as BackupPreferences['reminderIntervalDays']
    : 14;
  const lastExportedAt = finiteTimestamp(value.lastExportedAt);
  const lastVerifiedAt = finiteTimestamp(value.lastVerifiedAt);
  const snoozedUntil = finiteTimestamp(value.snoozedUntil);
  return {
    reminderIntervalDays,
    ...(lastExportedAt !== undefined ? { lastExportedAt } : {}),
    ...(lastVerifiedAt !== undefined ? { lastVerifiedAt } : {}),
    ...(snoozedUntil !== undefined ? { snoozedUntil } : {}),
  };
}

export function isBackupReminderDue(
  preferences: BackupPreferences,
  now = Date.now()
): boolean {
  if (!preferences.reminderIntervalDays) return false;
  if (preferences.snoozedUntil && preferences.snoozedUntil > now) return false;
  const baseline = Math.max(preferences.lastExportedAt ?? 0, preferences.lastVerifiedAt ?? 0);
  return baseline === 0 || now - baseline >= preferences.reminderIntervalDays * 86_400_000;
}

export function normalizeArtifactTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tags = [...new Set(value.flatMap((candidate) => {
    const tag = boundedText(candidate, MAX_ARTIFACT_TAG_CHARACTERS);
    return tag ? [tag] : [];
  }))].slice(0, MAX_ARTIFACT_TAGS);
  return tags.length ? tags : undefined;
}

function normalizeSyncConflict(value: unknown): CloudSyncConflict | undefined {
  if (!isRecord(value)) return undefined;
  const id = boundedText(value.id, 256);
  const detectedAt = finiteTimestamp(value.detectedAt);
  const localDigest = normalizedDigest(value.localDigest);
  const remoteDigest = normalizedDigest(value.remoteDigest);
  const baseDigest = normalizedDigest(value.baseDigest);
  const localObjectKey = optionalBoundedText(value.localObjectKey, 1024);
  const remoteObjectKey = boundedText(value.remoteObjectKey, 1024);
  if (!id || detectedAt === undefined || !localDigest || !remoteDigest || !remoteObjectKey) {
    return undefined;
  }
  const remoteUpdatedAt = finiteTimestamp(value.remoteUpdatedAt);
  return {
    id,
    detectedAt,
    localDigest,
    remoteDigest,
    ...(baseDigest ? { baseDigest } : {}),
    ...(localObjectKey ? { localObjectKey } : {}),
    remoteObjectKey,
    ...(remoteUpdatedAt !== undefined ? { remoteUpdatedAt } : {}),
  };
}

export function normalizeCloudSyncSettings(
  value: unknown,
  fallbackDeviceId = createLocalDeviceId()
): CloudSyncSettings {
  const source = isRecord(value) ? value : {};
  const provider = source.provider === 's3' ? 's3' : 'webdav';
  const conflicts = Array.isArray(source.conflicts)
    ? source.conflicts
        .flatMap((candidate) => {
          const conflict = normalizeSyncConflict(candidate);
          return conflict ? [conflict] : [];
        })
        .sort((left, right) => right.detectedAt - left.detectedAt)
        .slice(0, MAX_SYNC_CONFLICTS)
    : [];
  const lastStatus = syncStatuses.has(source.lastStatus as CloudSyncSettings['lastStatus'])
    ? source.lastStatus as CloudSyncSettings['lastStatus']
    : 'idle';
  const endpoint = boundedText(source.endpoint, 1024);
  const remotePath = boundedText(source.remotePath, 1024) || 'Embezzle-Studio';
  const bucket = optionalBoundedText(source.bucket, 256);
  const region = optionalBoundedText(source.region, 128);
  const deviceId = boundedText(source.deviceId, 256) || fallbackDeviceId;
  const lastSyncAt = finiteTimestamp(source.lastSyncAt);
  const lastSyncedDigest = normalizedDigest(source.lastSyncedDigest);
  const lastRemoteDigest = normalizedDigest(source.lastRemoteDigest);
  const lastError = optionalBoundedText(source.lastError, 1000);
  return {
    enabled: source.enabled === true,
    provider,
    endpoint,
    remotePath,
    ...(bucket ? { bucket } : {}),
    ...(region ? { region } : {}),
    deviceId,
    lastStatus,
    ...(lastSyncAt !== undefined ? { lastSyncAt } : {}),
    ...(lastSyncedDigest ? { lastSyncedDigest } : {}),
    ...(lastRemoteDigest ? { lastRemoteDigest } : {}),
    ...(lastError ? { lastError } : {}),
    conflicts,
  };
}

export function workspaceNeedsOnboarding(workspace: AppWorkspace): boolean {
  return workspace.onboarding.status === 'pending' && !hasUsableProviderConfiguration(
    workspace.providers,
    workspace.activeModelIdByProvider
  );
}
