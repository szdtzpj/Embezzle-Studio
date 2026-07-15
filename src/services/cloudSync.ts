import { utf8ToBytes } from '@noble/ciphers/utils.js';

import type {
  AppWorkspace,
  CloudSyncConflict,
  CloudSyncSettings,
} from '../domain/types';
import type { CloudSyncCredentialRecord } from './cloudSyncCredentials';
import {
  exportEncryptedWorkspaceBackup,
  mergeValidatedWorkspaceBackupEnvelope,
  sanitizeWorkspaceForBackup,
  verifyEncryptedWorkspaceBackup,
  WorkspaceBackupError,
  type WorkspaceBackupRandomSource,
  type WorkspaceBackupEnvelope,
} from './workspaceBackup';
import {
  CloudSyncError,
  MAX_SYNC_MANIFEST_BYTES,
  MAX_SYNC_OBJECT_BYTES,
  assertDigest,
  digestBytes,
  digestText,
  redactSensitiveText,
  type CloudSyncObject,
  type CloudSyncTransport,
  type CloudSyncTransportOptions,
} from './cloudSyncTransport';
import { createS3Transport } from './s3SigV4';
import { createWebDavTransport } from './webDavTransport';

export const CLOUD_SYNC_MANIFEST_KEY = 'Embezzle-Studio-sync-manifest.json';
export const CLOUD_SYNC_PROBE_KEY = 'Embezzle-Studio-sync-cas-probe.json';
export const MAX_SYNC_HISTORY = 20;

const syncManifestMagic = 'embezzle-studio-sync-manifest';
const conditionalReady = new WeakSet<object>();

export interface CloudSyncSnapshotRef {
  objectKey: string;
  objectDigest: string;
  contentDigest: string;
  size: number;
  createdAt: number;
  deviceId: string;
}

export interface CloudSyncManifest {
  magic: typeof syncManifestMagic;
  version: 1;
  updatedAt: number;
  current: CloudSyncSnapshotRef;
  history: CloudSyncSnapshotRef[];
}

export interface CloudSyncRemoteState {
  manifest: CloudSyncManifest;
  etag?: string;
}

export type CloudSyncDecision =
  | 'initialize'
  | 'unchanged'
  | 'push'
  | 'pull'
  | 'conflict'
  | 'remote-missing';

export type CloudSyncOutcome = 'initialized' | 'unchanged' | 'pushed' | 'pulled' | 'conflict';

export interface CloudSyncResult {
  outcome: CloudSyncOutcome;
  workspace: AppWorkspace;
  localDigest: string;
  remoteDigest: string;
  conflict?: CloudSyncConflict;
}

export interface SynchronizeWorkspaceOptions extends CloudSyncTransportOptions {
  workspace: AppWorkspace;
  credentials: CloudSyncCredentialRecord;
  transport?: CloudSyncTransport;
  now?: number;
  randomBytes?: WorkspaceBackupRandomSource;
  signal?: AbortSignal;
  /** Enabled by default. The probe writes only a small dedicated object. */
  verifyConditionalWrites?: boolean;
}

export interface ResolveCloudSyncConflictOptions extends SynchronizeWorkspaceOptions {
  conflictId: string;
  strategy: 'keep-local' | 'keep-remote';
}

export type CloudSyncTransportCredentials = Omit<CloudSyncCredentialRecord, 'encryptionPassword'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const expectedSet = new Set(expected);
  if (Object.keys(value).some((key) => !expectedSet.has(key)) || expected.some((key) => !(key in value))) {
    throw new CloudSyncError('invalid-remote', `${label} 字段不完整或包含未知字段。`);
  }
}

function finiteTimestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new CloudSyncError('invalid-remote', `${label} 时间无效。`);
  }
  return Math.trunc(value);
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new CloudSyncError('invalid-remote', `${label} 无效。`);
  }
  return value;
}

export function snapshotObjectKey(objectDigest: string): string {
  return `Embezzle-Studio-snapshot-${assertDigest(objectDigest, '快照摘要')}.enc.json`;
}

function validateSnapshotRef(value: unknown, label: string): CloudSyncSnapshotRef {
  if (!isRecord(value)) throw new CloudSyncError('invalid-remote', `${label} 必须是对象。`);
  exactKeys(value, ['objectKey', 'objectDigest', 'contentDigest', 'size', 'createdAt', 'deviceId'], label);
  const objectDigest = assertDigest(boundedString(value.objectDigest, `${label}.objectDigest`, 64));
  const contentDigest = assertDigest(boundedString(value.contentDigest, `${label}.contentDigest`, 64));
  const objectKey = boundedString(value.objectKey, `${label}.objectKey`, 256);
  if (objectKey !== snapshotObjectKey(objectDigest)) {
    throw new CloudSyncError('invalid-remote', `${label}.objectKey 与摘要不匹配。`);
  }
  const size = value.size;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > MAX_SYNC_OBJECT_BYTES) {
    throw new CloudSyncError('invalid-remote', `${label}.size 无效。`);
  }
  return {
    objectKey,
    objectDigest,
    contentDigest,
    size,
    createdAt: finiteTimestamp(value.createdAt, `${label}.createdAt`),
    deviceId: boundedString(value.deviceId, `${label}.deviceId`, 256),
  };
}

export function parseCloudSyncManifest(value: Uint8Array | string): CloudSyncManifest {
  const serialized = typeof value === 'string' ? value : new TextDecoder().decode(value);
  if (new TextEncoder().encode(serialized).byteLength > MAX_SYNC_MANIFEST_BYTES) {
    throw new CloudSyncError('too-large', '同步 manifest 超过 64 KiB 安全上限。');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new CloudSyncError('invalid-remote', '同步 manifest 不是有效 JSON。');
  }
  if (!isRecord(parsed)) throw new CloudSyncError('invalid-remote', '同步 manifest 必须是对象。');
  exactKeys(parsed, ['magic', 'version', 'updatedAt', 'current', 'history'], '同步 manifest');
  if (parsed.magic !== syncManifestMagic || parsed.version !== 1) {
    throw new CloudSyncError('invalid-remote', '同步 manifest 版本不受支持。');
  }
  const current = validateSnapshotRef(parsed.current, '同步 manifest.current');
  if (!Array.isArray(parsed.history) || parsed.history.length > MAX_SYNC_HISTORY) {
    throw new CloudSyncError('invalid-remote', '同步 manifest.history 无效。');
  }
  const history = parsed.history.map((entry, index) =>
    validateSnapshotRef(entry, `同步 manifest.history[${index}]`)
  );
  const seen = new Set([current.objectDigest]);
  for (const entry of history) {
    if (seen.has(entry.objectDigest)) {
      throw new CloudSyncError('invalid-remote', '同步 manifest 含有重复快照。');
    }
    seen.add(entry.objectDigest);
  }
  return {
    magic: syncManifestMagic,
    version: 1,
    updatedAt: finiteTimestamp(parsed.updatedAt, '同步 manifest.updatedAt'),
    current,
    history,
  };
}

export function serializeCloudSyncManifest(manifest: CloudSyncManifest): string {
  const validated = parseCloudSyncManifest(JSON.stringify(manifest));
  return JSON.stringify(validated);
}

export function workspaceSyncContentDigest(workspace: AppWorkspace): string {
  return digestText(JSON.stringify(sanitizeWorkspaceForBackup(workspace)));
}

export function decideCloudSync(input: {
  localDigest: string;
  remoteDigest?: string;
  lastLocalDigest?: string;
  lastRemoteDigest?: string;
}): CloudSyncDecision {
  const localDigest = assertDigest(input.localDigest, '本地工作区摘要');
  const remoteDigest = input.remoteDigest ? assertDigest(input.remoteDigest, '远端工作区摘要') : undefined;
  const lastLocalDigest = input.lastLocalDigest
    ? assertDigest(input.lastLocalDigest, '上次本地摘要')
    : undefined;
  const lastRemoteDigest = input.lastRemoteDigest
    ? assertDigest(input.lastRemoteDigest, '上次远端摘要')
    : undefined;

  if (!remoteDigest) {
    return lastRemoteDigest ? 'remote-missing' : 'initialize';
  }
  if (remoteDigest === localDigest) return 'unchanged';
  if (!lastLocalDigest && !lastRemoteDigest) return 'conflict';

  const localChanged = !lastLocalDigest || localDigest !== lastLocalDigest;
  const remoteChanged = !lastRemoteDigest || remoteDigest !== lastRemoteDigest;
  if (!localChanged && !remoteChanged) return 'unchanged';
  if (localChanged && !remoteChanged) return 'push';
  if (!localChanged && remoteChanged) return 'pull';
  return 'conflict';
}

export function createCloudSyncTransport(
  settings: CloudSyncSettings,
  credentials: CloudSyncTransportCredentials,
  options: CloudSyncTransportOptions = {}
): CloudSyncTransport {
  if (settings.provider === 'webdav') {
    return createWebDavTransport({
      endpoint: settings.endpoint,
      remotePath: settings.remotePath,
      credentials,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    });
  }
  return createS3Transport({
    endpoint: settings.endpoint,
    remotePath: settings.remotePath,
    bucket: settings.bucket ?? '',
    region: settings.region ?? '',
    credentials,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
}

function createTransport(options: SynchronizeWorkspaceOptions): CloudSyncTransport {
  if (options.transport) return options.transport;
  return createCloudSyncTransport(options.workspace.cloudSync, options.credentials, options);
}

async function readRemoteState(
  transport: CloudSyncTransport,
  signal?: AbortSignal
): Promise<CloudSyncRemoteState | null> {
  let object: CloudSyncObject;
  try {
    object = await transport.get(CLOUD_SYNC_MANIFEST_KEY, {
      limit: MAX_SYNC_MANIFEST_BYTES,
      signal,
    });
  } catch (error) {
    if (error instanceof CloudSyncError && error.code === 'not-found') return null;
    throw error;
  }
  return {
    manifest: parseCloudSyncManifest(object.body),
    etag: object.etag,
  };
}

async function expectPreconditionFailure(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof CloudSyncError && error.code === 'precondition-failed') return;
    throw error;
  }
  throw new CloudSyncError(
    'unsupported',
    '远端存储未执行 If-Match/If-None-Match 条件写入；为避免静默覆盖，已拒绝同步。'
  );
}

/**
 * Probes conditional writes on a dedicated tiny object before the real
 * manifest is ever mutated. The object is intentionally retained; deleting it
 * would add another protocol surface and is unnecessary for safety.
 */
export async function ensureConditionalWriteSupport(
  transport: CloudSyncTransport,
  deviceId: string,
  now = Date.now(),
  signal?: AbortSignal
): Promise<void> {
  if (conditionalReady.has(transport as object)) return;
  const safeDeviceId = boundedString(deviceId, '设备 ID', 256);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let current: CloudSyncObject | null = null;
    try {
      current = await transport.get(CLOUD_SYNC_PROBE_KEY, { limit: 4 * 1024, signal });
    } catch (error) {
      if (!(error instanceof CloudSyncError) || error.code !== 'not-found') throw error;
    }

    if (!current) {
      const initial = JSON.stringify({ version: 1, phase: 'initial', deviceId: safeDeviceId, now, attempt });
      try {
        await transport.put(CLOUD_SYNC_PROBE_KEY, initial, {
          contentType: 'application/json',
          conditions: { ifNoneMatch: '*' },
          signal,
        });
      } catch (error) {
        if (error instanceof CloudSyncError && error.code === 'precondition-failed') continue;
        throw error;
      }
      current = await transport.get(CLOUD_SYNC_PROBE_KEY, { limit: 4 * 1024, signal });
    }

    if (!current.etag) {
      throw new CloudSyncError(
        'unsupported',
        '远端存储未提供强 ETag；无法安全执行并发同步。'
      );
    }

    await expectPreconditionFailure(
      transport.put(CLOUD_SYNC_PROBE_KEY, current.body, {
        contentType: 'application/json',
        conditions: { ifNoneMatch: '*' },
        signal,
      })
    );

    const staleEtag = current.etag;
    const next = JSON.stringify({ version: 1, phase: 'updated', deviceId: safeDeviceId, now, attempt });
    try {
      await transport.put(CLOUD_SYNC_PROBE_KEY, next, {
        contentType: 'application/json',
        conditions: { ifMatch: staleEtag },
        signal,
      });
    } catch (error) {
      if (error instanceof CloudSyncError && error.code === 'precondition-failed') continue;
      throw error;
    }
    await expectPreconditionFailure(
      transport.put(CLOUD_SYNC_PROBE_KEY, next, {
        contentType: 'application/json',
        conditions: { ifMatch: staleEtag },
        signal,
      })
    );
    conditionalReady.add(transport as object);
    return;
  }
  throw new CloudSyncError('precondition-failed', '同步条件写入探测期间远端状态持续变化，请稍后重试。');
}

interface LocalSnapshot {
  serialized: string;
  bytes: Uint8Array;
  ref: CloudSyncSnapshotRef;
}

async function createLocalSnapshot(
  workspace: AppWorkspace,
  password: string,
  now: number,
  randomBytes?: WorkspaceBackupRandomSource
): Promise<LocalSnapshot> {
  let serialized: string;
  try {
    serialized = await exportEncryptedWorkspaceBackup(workspace, password, { now, randomBytes });
  } catch (error) {
    throw mapBackupError(error);
  }
  const bytes = utf8ToBytes(serialized);
  const objectDigest = digestBytes(bytes);
  return {
    serialized,
    bytes,
    ref: {
      objectKey: snapshotObjectKey(objectDigest),
      objectDigest,
      contentDigest: workspaceSyncContentDigest(workspace),
      size: bytes.byteLength,
      createdAt: now,
      deviceId: workspace.cloudSync.deviceId,
    },
  };
}

async function uploadImmutableSnapshot(
  transport: CloudSyncTransport,
  snapshot: LocalSnapshot,
  signal?: AbortSignal
): Promise<void> {
  try {
    await transport.put(snapshot.ref.objectKey, snapshot.bytes, {
      contentType: 'application/json',
      conditions: { ifNoneMatch: '*' },
      signal,
    });
    return;
  } catch (error) {
    if (!(error instanceof CloudSyncError) || error.code !== 'precondition-failed') throw error;
  }
  const existing = await transport.get(snapshot.ref.objectKey, {
    limit: MAX_SYNC_OBJECT_BYTES,
    signal,
  });
  if (existing.body.byteLength !== snapshot.ref.size || digestBytes(existing.body) !== snapshot.ref.objectDigest) {
    throw new CloudSyncError('integrity-mismatch', '同名远端不可变快照与本地摘要不一致。');
  }
}

function manifestForSnapshot(
  snapshot: CloudSyncSnapshotRef,
  now: number,
  previous?: CloudSyncManifest
): CloudSyncManifest {
  const historyCandidates = previous ? [previous.current, ...previous.history] : [];
  const history: CloudSyncSnapshotRef[] = [];
  const seen = new Set([snapshot.objectDigest]);
  for (const entry of historyCandidates) {
    if (seen.has(entry.objectDigest)) continue;
    seen.add(entry.objectDigest);
    history.push(entry);
    if (history.length >= MAX_SYNC_HISTORY) break;
  }
  return {
    magic: syncManifestMagic,
    version: 1,
    updatedAt: now,
    current: snapshot,
    history,
  };
}

async function writeManifest(
  transport: CloudSyncTransport,
  manifest: CloudSyncManifest,
  previousEtag: string | undefined,
  signal?: AbortSignal
): Promise<void> {
  if (previousEtag === undefined && manifest.history.length) {
    throw new CloudSyncError('unsupported', '已有远端 manifest 缺少强 ETag，已拒绝覆盖。');
  }
  const serialized = serializeCloudSyncManifest(manifest);
  await transport.put(CLOUD_SYNC_MANIFEST_KEY, serialized, {
    contentType: 'application/json',
    conditions: previousEtag ? { ifMatch: previousEtag } : { ifNoneMatch: '*' },
    signal,
  });
  const readBack = await readRemoteState(transport, signal);
  if (!readBack || readBack.manifest.current.objectDigest !== manifest.current.objectDigest) {
    throw new CloudSyncError('precondition-failed', '远端 manifest 在写入后发生并发变化。');
  }
}

async function importSnapshot(
  transport: CloudSyncTransport,
  ref: CloudSyncSnapshotRef,
  password: string,
  currentWorkspace: AppWorkspace,
  signal?: AbortSignal,
  expectedContentDigest?: string
): Promise<AppWorkspace> {
  const object = await readAndVerifySnapshot(transport, ref, signal);
  const serialized = new TextDecoder().decode(object.body);
  try {
    const envelope = await verifyEncryptedSnapshotWorkspace(serialized, password, expectedContentDigest);
    return mergeValidatedWorkspaceBackupEnvelope(envelope, currentWorkspace);
  } catch (error) {
    throw mapBackupError(error);
  }
}

async function readAndVerifySnapshot(
  transport: CloudSyncTransport,
  ref: CloudSyncSnapshotRef,
  signal?: AbortSignal
): Promise<CloudSyncObject> {
  const object = await transport.get(ref.objectKey, { limit: MAX_SYNC_OBJECT_BYTES, signal });
  if (object.body.byteLength !== ref.size || digestBytes(object.body) !== ref.objectDigest) {
    throw new CloudSyncError('integrity-mismatch', '远端同步快照大小或 SHA-256 不匹配。');
  }
  return object;
}

function mapBackupError(error: unknown): CloudSyncError {
  if (error instanceof CloudSyncError) return error;
  if (error instanceof WorkspaceBackupError) {
    if (error.code === 'decrypt-failed') {
      return new CloudSyncError('decrypt-failed', '无法解密远端同步快照：同步密码错误或文件已损坏。');
    }
    if (error.code === 'too-large') return new CloudSyncError('too-large', error.message);
    if (error.code === 'password-policy') return new CloudSyncError('credentials', error.message);
    return new CloudSyncError('invalid-remote', error.message);
  }
  return new CloudSyncError('invalid-remote', '远端同步快照无法通过认证与结构验证。');
}

/**
 * Checks the logical digest against the authenticated portable payload before
 * device-local import rules intentionally normalize executable state. Those
 * rules can disable unsafe targets or recover one provider from an all-disabled
 * backup, so the post-merge AppWorkspace is not a byte-for-byte digest source.
 */
async function verifyEncryptedSnapshotWorkspace(
  serialized: string,
  password: string,
  expectedContentDigest?: string
): Promise<WorkspaceBackupEnvelope> {
  const envelope = await verifyEncryptedWorkspaceBackup(serialized, password);
  if (expectedContentDigest !== undefined) {
    const expected = assertDigest(expectedContentDigest, '远端内容摘要');
    const actual = digestText(JSON.stringify(envelope.workspace));
    if (actual !== expected) {
      throw new CloudSyncError('integrity-mismatch', '远端同步快照内容摘要不匹配。');
    }
  }
  return envelope;
}

function cleanSettings(settings: CloudSyncSettings): CloudSyncSettings {
  const cleaned: CloudSyncSettings = {
    ...settings,
    conflicts: settings.conflicts.map((conflict) => ({ ...conflict })),
  };
  delete cleaned.lastError;
  return cleaned;
}

function withSuccessfulSettings(
  workspace: AppWorkspace,
  localDigest: string,
  remoteDigest: string,
  now: number
): AppWorkspace {
  return {
    ...workspace,
    cloudSync: {
      ...cleanSettings(workspace.cloudSync),
      lastStatus: 'synced',
      lastSyncAt: now,
      lastSyncedDigest: localDigest,
      lastRemoteDigest: remoteDigest,
    },
  };
}

function withoutConflict(workspace: AppWorkspace, conflictId: string): AppWorkspace {
  return {
    ...workspace,
    cloudSync: {
      ...workspace.cloudSync,
      lastStatus: 'idle',
      conflicts: workspace.cloudSync.conflicts.filter((conflict) => conflict.id !== conflictId),
    },
  };
}

function conflictId(now: number, localDigest: string, remoteDigest: string): string {
  return `sync-conflict-${now.toString(36)}-${localDigest.slice(0, 10)}-${remoteDigest.slice(0, 10)}`;
}

function withConflict(
  workspace: AppWorkspace,
  localSnapshot: CloudSyncSnapshotRef,
  remoteSnapshot: CloudSyncSnapshotRef,
  now: number
): { workspace: AppWorkspace; conflict: CloudSyncConflict } {
  const conflict: CloudSyncConflict = {
    id: conflictId(now, localSnapshot.contentDigest, remoteSnapshot.contentDigest),
    detectedAt: now,
    localDigest: localSnapshot.contentDigest,
    remoteDigest: remoteSnapshot.contentDigest,
    ...(workspace.cloudSync.lastRemoteDigest
      ? { baseDigest: workspace.cloudSync.lastRemoteDigest }
      : {}),
    localObjectKey: localSnapshot.objectKey,
    remoteObjectKey: remoteSnapshot.objectKey,
    remoteUpdatedAt: remoteSnapshot.createdAt,
  };
  const conflicts = [
    conflict,
    ...workspace.cloudSync.conflicts.filter((candidate) =>
      candidate.localDigest !== conflict.localDigest || candidate.remoteDigest !== conflict.remoteDigest
    ),
  ].slice(0, MAX_SYNC_HISTORY);
  return {
    conflict,
    workspace: {
      ...workspace,
      cloudSync: {
        ...cleanSettings(workspace.cloudSync),
        lastStatus: 'conflict',
        lastRemoteDigest: remoteSnapshot.contentDigest,
        conflicts,
      },
    },
  };
}

export function cloudSyncSettingsAfterError(
  settings: CloudSyncSettings,
  error: unknown
): CloudSyncSettings {
  const message = error instanceof Error ? error.message : '同步失败。';
  const safeMessage = redactSensitiveText(message, 1_000);
  return {
    ...settings,
    lastStatus: 'error',
    lastError: safeMessage,
    conflicts: settings.conflicts.map((conflict) => ({ ...conflict })),
  };
}

/** Verifies an encrypted sync snapshot without changing the current workspace. */
export async function verifyCloudSyncSnapshot(
  serialized: string,
  password: string,
  expectedObjectDigest?: string,
  expectedContentDigest?: string
): Promise<void> {
  const bytes = utf8ToBytes(serialized);
  if (bytes.byteLength > MAX_SYNC_OBJECT_BYTES) {
    throw new CloudSyncError('too-large', '同步快照超过 10 MiB 安全上限。');
  }
  if (expectedObjectDigest && digestBytes(bytes) !== assertDigest(expectedObjectDigest)) {
    throw new CloudSyncError('integrity-mismatch', '同步快照 SHA-256 不匹配。');
  }
  try {
    await verifyEncryptedSnapshotWorkspace(serialized, password, expectedContentDigest);
  } catch (error) {
    throw mapBackupError(error);
  }
}

/**
 * Executes one client-only sync. It never writes the local workspace itself;
 * callers persist `result.workspace` through the existing WorkspaceSession.
 */
export async function synchronizeWorkspace(
  options: SynchronizeWorkspaceOptions
): Promise<CloudSyncResult> {
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now) || now < 0) throw new CloudSyncError('invalid-config', '同步时间无效。');
  if (!options.workspace.cloudSync.enabled) {
    throw new CloudSyncError('invalid-config', '用户自有存储同步尚未启用。');
  }
  if (options.workspace.cloudSync.conflicts.length) {
    throw new CloudSyncError(
      'precondition-failed',
      '存在尚未处理的同步冲突；请先明确保留本地或远端版本，再继续同步。'
    );
  }
  if (options.signal?.aborted) throw new CloudSyncError('cancelled', '同步请求已取消。');
  const transport = createTransport(options);
  const localDigest = workspaceSyncContentDigest(options.workspace);
  const remote = await readRemoteState(transport, options.signal);
  const decision = decideCloudSync({
    localDigest,
    remoteDigest: remote?.manifest.current.contentDigest,
    lastLocalDigest: options.workspace.cloudSync.lastSyncedDigest,
    lastRemoteDigest: options.workspace.cloudSync.lastRemoteDigest,
  });

  if (decision === 'remote-missing') {
    throw new CloudSyncError(
      'invalid-remote',
      '此前已同步的远端 manifest 现已缺失；为避免静默重建或覆盖，已停止同步。'
    );
  }
  if (decision === 'unchanged' && remote) {
    await importSnapshot(
      transport,
      remote.manifest.current,
      options.credentials.encryptionPassword,
      options.workspace,
      options.signal,
      remote.manifest.current.contentDigest
    );
    const workspace = withSuccessfulSettings(
      options.workspace,
      localDigest,
      remote.manifest.current.contentDigest,
      now
    );
    return {
      outcome: 'unchanged',
      workspace,
      localDigest,
      remoteDigest: remote.manifest.current.contentDigest,
    };
  }
  if (decision === 'pull' && remote) {
    const imported = await importSnapshot(
      transport,
      remote.manifest.current,
      options.credentials.encryptionPassword,
      options.workspace,
      options.signal,
      remote.manifest.current.contentDigest
    );
    const importedDigest = workspaceSyncContentDigest(imported);
    const workspace = withSuccessfulSettings(
      imported,
      importedDigest,
      remote.manifest.current.contentDigest,
      now
    );
    return {
      outcome: 'pulled',
      workspace,
      localDigest: importedDigest,
      remoteDigest: remote.manifest.current.contentDigest,
    };
  }

  const localSnapshot = await createLocalSnapshot(
    options.workspace,
    options.credentials.encryptionPassword,
    Math.trunc(now),
    options.randomBytes
  );
  if (options.verifyConditionalWrites !== false) {
    await ensureConditionalWriteSupport(
      transport,
      options.workspace.cloudSync.deviceId,
      Math.trunc(now),
      options.signal
    );
  }
  await uploadImmutableSnapshot(transport, localSnapshot, options.signal);

  if (decision === 'conflict' && remote) {
    await importSnapshot(
      transport,
      remote.manifest.current,
      options.credentials.encryptionPassword,
      options.workspace,
      options.signal,
      remote.manifest.current.contentDigest
    );
    const result = withConflict(options.workspace, localSnapshot.ref, remote.manifest.current, Math.trunc(now));
    return {
      outcome: 'conflict',
      workspace: result.workspace,
      localDigest,
      remoteDigest: remote.manifest.current.contentDigest,
      conflict: result.conflict,
    };
  }

  const nextManifest = manifestForSnapshot(localSnapshot.ref, Math.trunc(now), remote?.manifest);
  try {
    await writeManifest(transport, nextManifest, remote?.etag, options.signal);
  } catch (error) {
    if (!(error instanceof CloudSyncError) || error.code !== 'precondition-failed') throw error;
    const latest = await readRemoteState(transport, options.signal);
    if (!latest) throw error;
    if (latest.manifest.current.contentDigest === localDigest) {
      await importSnapshot(
        transport,
        latest.manifest.current,
        options.credentials.encryptionPassword,
        options.workspace,
        options.signal,
        latest.manifest.current.contentDigest
      );
      const workspace = withSuccessfulSettings(options.workspace, localDigest, localDigest, Math.trunc(now));
      return {
        outcome: decision === 'initialize' ? 'initialized' : 'pushed',
        workspace,
        localDigest,
        remoteDigest: localDigest,
      };
    }
    await importSnapshot(
      transport,
      latest.manifest.current,
      options.credentials.encryptionPassword,
      options.workspace,
      options.signal,
      latest.manifest.current.contentDigest
    );
    const result = withConflict(options.workspace, localSnapshot.ref, latest.manifest.current, Math.trunc(now));
    return {
      outcome: 'conflict',
      workspace: result.workspace,
      localDigest,
      remoteDigest: latest.manifest.current.contentDigest,
      conflict: result.conflict,
    };
  }

  const workspace = withSuccessfulSettings(options.workspace, localDigest, localDigest, Math.trunc(now));
  return {
    outcome: decision === 'initialize' ? 'initialized' : 'pushed',
    workspace,
    localDigest,
    remoteDigest: localDigest,
  };
}

/**
 * Resolves one recorded conflict only after an explicit user choice. Keeping
 * local still performs a fresh ETag CAS against the exact remote version that
 * was shown to the user; keeping remote authenticates the encrypted snapshot
 * before replacement.
 */
export async function resolveCloudSyncConflict(
  options: ResolveCloudSyncConflictOptions
): Promise<CloudSyncResult> {
  const now = Math.trunc(options.now ?? Date.now());
  const conflict = options.workspace.cloudSync.conflicts.find(
    (candidate) => candidate.id === options.conflictId
  );
  if (!conflict) throw new CloudSyncError('invalid-config', '找不到待处理的同步冲突。');
  const transport = createTransport(options);
  const remote = await readRemoteState(transport, options.signal);
  if (
    !remote ||
    remote.manifest.current.objectKey !== conflict.remoteObjectKey ||
    remote.manifest.current.contentDigest !== conflict.remoteDigest
  ) {
    throw new CloudSyncError(
      'precondition-failed',
      '远端版本已再次变化；未执行冲突覆盖，请刷新后重新选择。'
    );
  }

  if (options.strategy === 'keep-remote') {
    const imported = await importSnapshot(
      transport,
      remote.manifest.current,
      options.credentials.encryptionPassword,
      options.workspace,
      options.signal,
      remote.manifest.current.contentDigest
    );
    const clean = withoutConflict(imported, conflict.id);
    const localDigest = workspaceSyncContentDigest(clean);
    const workspace = withSuccessfulSettings(
      clean,
      localDigest,
      remote.manifest.current.contentDigest,
      now
    );
    return {
      outcome: 'pulled',
      workspace,
      localDigest,
      remoteDigest: remote.manifest.current.contentDigest,
    };
  }

  const localDigest = workspaceSyncContentDigest(options.workspace);
  if (localDigest !== conflict.localDigest || !conflict.localObjectKey) {
    throw new CloudSyncError(
      'precondition-failed',
      '本地版本在冲突后已变化，或缺少不可变本地快照；未覆盖远端。'
    );
  }
  const objectDigestMatch = conflict.localObjectKey.match(
    /^Embezzle-Studio-snapshot-([a-f0-9]{64})\.enc\.json$/u
  );
  if (!objectDigestMatch) {
    throw new CloudSyncError('invalid-remote', '冲突中的本地快照键无效。');
  }
  const objectDigest = objectDigestMatch[1];
  const object = await transport.get(conflict.localObjectKey, {
    limit: MAX_SYNC_OBJECT_BYTES,
    signal: options.signal,
  });
  if (digestBytes(object.body) !== objectDigest) {
    throw new CloudSyncError('integrity-mismatch', '冲突中的本地快照 SHA-256 不匹配。');
  }
  const serialized = new TextDecoder().decode(object.body);
  await verifyCloudSyncSnapshot(
    serialized,
    options.credentials.encryptionPassword,
    objectDigest,
    conflict.localDigest
  );
  const localRef: CloudSyncSnapshotRef = {
    objectKey: conflict.localObjectKey,
    objectDigest,
    contentDigest: conflict.localDigest,
    size: object.body.byteLength,
    createdAt: conflict.detectedAt,
    deviceId: options.workspace.cloudSync.deviceId,
  };
  if (options.verifyConditionalWrites !== false) {
    await ensureConditionalWriteSupport(
      transport,
      options.workspace.cloudSync.deviceId,
      now,
      options.signal
    );
  }
  await writeManifest(
    transport,
    manifestForSnapshot(localRef, now, remote.manifest),
    remote.etag,
    options.signal
  );
  const clean = withoutConflict(options.workspace, conflict.id);
  const workspace = withSuccessfulSettings(clean, localDigest, localDigest, now);
  return {
    outcome: 'pushed',
    workspace,
    localDigest,
    remoteDigest: localDigest,
  };
}
