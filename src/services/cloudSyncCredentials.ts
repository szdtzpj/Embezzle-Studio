import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import type { CloudSyncProviderKind } from '../domain/types';

/**
 * Cloud-sync credentials are deliberately separate from AppWorkspace.  The
 * workspace can be exported, compared, and persisted without ever carrying
 * these values.  The encryption password is included here because an
 * unattended sync needs to be able to authenticate the encrypted snapshot;
 * callers should still make the user aware that this is a sensitive secret.
 */
export interface CloudSyncCredentialRecord {
  username?: string;
  password?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  encryptionPassword: string;
}

export interface CloudSyncCredentialBinding {
  provider: CloudSyncProviderKind;
  endpoint: string;
  remotePath: string;
  bucket?: string;
  region?: string;
}

export interface CloudSyncCredentialStoreAdapter {
  platform?: 'web' | 'native';
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

export const CLOUD_SYNC_CREDENTIAL_KEY = 'embezzle-studio.cloud-sync-credentials.v1';
export const MIN_SYNC_PASSWORD_LENGTH = 8;
export const MAX_SYNC_PASSWORD_LENGTH = 1024;
const MAX_CREDENTIAL_FIELD_LENGTH = 4096;
const MAX_SERIALIZED_CREDENTIAL_BYTES = 8 * 1024;

const memoryValues = new Map<string, string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.+$/u, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized === '[::1]';
}

function boundedString(value: unknown, label: string, maximum = MAX_CREDENTIAL_FIELD_LENGTH): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new CloudSyncCredentialError('invalid-credentials', `${label} 必须是文本。`);
  const normalized = value.normalize('NFKC');
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new CloudSyncCredentialError('invalid-credentials', `${label} 无效。`);
  }
  return normalized;
}

function boundedCredential(
  value: unknown,
  label: string,
  maximum = MAX_CREDENTIAL_FIELD_LENGTH,
  trim = false
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new CloudSyncCredentialError('invalid-credentials', `${label} 必须是文本。`);
  const candidate = trim ? value.trim() : value;
  if (!candidate || candidate.length > maximum || /[\u0000-\u001f\u007f]/u.test(candidate)) {
    throw new CloudSyncCredentialError('invalid-credentials', `${label} 无效。`);
  }
  return candidate;
}

function decodePathPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new CloudSyncCredentialError('invalid-config', '同步地址包含无效的 URL 编码。');
  }
}

function normalizePathSegments(value: string, label: string): string[] {
  const raw = value.trim().replace(/\\/gu, '/');
  if (!raw || raw.includes('\0')) {
    throw new CloudSyncCredentialError('invalid-config', `${label} 不能为空。`);
  }
  const segments = raw.split('/').filter(Boolean).map((segment) => decodePathPart(segment));
  if (!segments.length || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new CloudSyncCredentialError('invalid-config', `${label} 包含非法路径段。`);
  }
  if (segments.some((segment) => /[\u0000-\u001f\u007f]/u.test(segment))) {
    throw new CloudSyncCredentialError('invalid-config', `${label} 包含控制字符。`);
  }
  const normalized = segments.join('/');
  if (normalized.length > 2048) {
    throw new CloudSyncCredentialError('invalid-config', `${label} 过长。`);
  }
  return segments;
}

/** Normalizes and validates an endpoint without retaining credentials in it. */
export function canonicalCloudSyncEndpoint(value: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CloudSyncCredentialError('invalid-config', '同步 Endpoint 不能为空。');
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new CloudSyncCredentialError('invalid-config', '同步 Endpoint 不是有效 URL。');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) {
    throw new CloudSyncCredentialError('invalid-config', '同步 Endpoint 必须使用 HTTPS（本机回环地址可使用 HTTP）。');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new CloudSyncCredentialError('invalid-config', '同步 Endpoint 不得包含账号、密码、查询参数或片段。');
  }
  const pathSegments = url.pathname.split('/').filter(Boolean).map((segment) => decodePathPart(segment));
  if (pathSegments.some((segment) => segment === '.' || segment === '..' || segment.includes('\\'))) {
    throw new CloudSyncCredentialError('invalid-config', '同步 Endpoint 路径包含非法路径段。');
  }
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
    url.port = '';
  }
  url.pathname = pathSegments.length ? `/${pathSegments.map(encodeURIComponent).join('/')}` : '/';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/u, '');
}

export function canonicalCloudSyncRemotePath(value: string): string {
  return normalizePathSegments(value, '同步远端路径').join('/');
}

export function canonicalCloudSyncBinding(binding: CloudSyncCredentialBinding): string {
  const endpoint = canonicalCloudSyncEndpoint(binding.endpoint);
  const remotePath = canonicalCloudSyncRemotePath(binding.remotePath);
  const bucket = binding.bucket ? boundedString(binding.bucket, 'S3 Bucket', 256) ?? '' : '';
  const region = binding.region ? boundedString(binding.region, 'S3 Region', 128) ?? '' : '';
  if (binding.provider === 's3' && (!bucket || !region)) {
    throw new CloudSyncCredentialError('invalid-config', 'S3 同步必须提供 Bucket 和 Region。');
  }
  if (binding.provider === 'webdav' && (binding.bucket || binding.region)) {
    throw new CloudSyncCredentialError('invalid-config', 'WebDAV 不接受 Bucket 或 Region。');
  }
  return JSON.stringify({ provider: binding.provider, endpoint, remotePath, bucket, region });
}

export function cloudSyncBindingFingerprint(binding: CloudSyncCredentialBinding): string {
  return `cloud-sync-v1:${canonicalCloudSyncBinding(binding)}`;
}

export type CloudSyncCredentialErrorCode = 'invalid-config' | 'invalid-credentials' | 'secure-store-unavailable';

export class CloudSyncCredentialError extends Error {
  readonly code: CloudSyncCredentialErrorCode;

  constructor(code: CloudSyncCredentialErrorCode, message: string) {
    super(message);
    this.name = 'CloudSyncCredentialError';
    this.code = code;
  }
}

function normalizeCredentials(
  binding: CloudSyncCredentialBinding,
  value: unknown
): CloudSyncCredentialRecord {
  if (!isRecord(value)) throw new CloudSyncCredentialError('invalid-credentials', '同步凭据格式无效。');
  const encryptionPassword = boundedCredential(
    value.encryptionPassword,
    '同步加密密码',
    MAX_SYNC_PASSWORD_LENGTH
  );
  if (!encryptionPassword || Array.from(encryptionPassword).length < MIN_SYNC_PASSWORD_LENGTH) {
    throw new CloudSyncCredentialError('invalid-credentials', `同步加密密码至少需要 ${MIN_SYNC_PASSWORD_LENGTH} 个字符。`);
  }
  const record: CloudSyncCredentialRecord = { encryptionPassword };
  if (binding.provider === 'webdav') {
    const username = boundedCredential(value.username, 'WebDAV 用户名', MAX_CREDENTIAL_FIELD_LENGTH, true);
    const password = boundedCredential(value.password, 'WebDAV 密码');
    if (!username || !password) {
      throw new CloudSyncCredentialError('invalid-credentials', 'WebDAV 需要用户名和密码或应用密码。');
    }
    record.username = username;
    record.password = password;
  } else {
    const accessKeyId = boundedCredential(value.accessKeyId, 'S3 Access Key ID', 512, true);
    const secretAccessKey = boundedCredential(value.secretAccessKey, 'S3 Secret Access Key', 1024);
    const sessionToken = boundedCredential(value.sessionToken, 'S3 Session Token', 4096);
    if (!accessKeyId || !secretAccessKey) {
      throw new CloudSyncCredentialError('invalid-credentials', 'S3 需要 Access Key ID 和 Secret Access Key。');
    }
    record.accessKeyId = accessKeyId;
    record.secretAccessKey = secretAccessKey;
    if (sessionToken) record.sessionToken = sessionToken;
  }
  return record;
}

function serializedBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function webSessionStorage(): Storage | undefined {
  if (typeof globalThis.sessionStorage === 'undefined') return undefined;
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

function defaultAdapter(): CloudSyncCredentialStoreAdapter {
  if (Platform.OS === 'web') {
    return {
      platform: 'web',
      async getItem(key) {
        return webSessionStorage()?.getItem(key) ?? memoryValues.get(key) ?? null;
      },
      async setItem(key, value) {
        try {
          webSessionStorage()?.setItem(key, value);
        } catch {
          // Keep a current-tab in-memory fallback when sessionStorage is blocked.
        }
        memoryValues.set(key, value);
      },
      async deleteItem(key) {
        try {
          webSessionStorage()?.removeItem(key);
        } catch {
          // Best effort; the in-memory value is still removed below.
        }
        memoryValues.delete(key);
      },
    };
  }
  return {
    platform: 'native',
    async getItem(key) {
      try {
        if (!(await SecureStore.isAvailableAsync())) {
          throw new CloudSyncCredentialError('secure-store-unavailable', '当前设备无法使用安全存储，已拒绝读取同步凭据。');
        }
        return await SecureStore.getItemAsync(key);
      } catch (error) {
        if (error instanceof CloudSyncCredentialError) throw error;
        throw new CloudSyncCredentialError('secure-store-unavailable', '读取同步凭据失败，未使用明文回退。');
      }
    },
    async setItem(key, value) {
      try {
        if (!(await SecureStore.isAvailableAsync())) {
          throw new CloudSyncCredentialError('secure-store-unavailable', '当前设备无法使用安全存储，已拒绝保存同步凭据。');
        }
        await SecureStore.setItemAsync(key, value);
      } catch (error) {
        if (error instanceof CloudSyncCredentialError) throw error;
        throw new CloudSyncCredentialError('secure-store-unavailable', '保存同步凭据失败，未写入明文存储。');
      }
    },
    async deleteItem(key) {
      try {
        if (!(await SecureStore.isAvailableAsync())) {
          throw new CloudSyncCredentialError(
            'secure-store-unavailable',
            '同步已停用，但当前设备无法确认本机安全存储中的同步凭据已删除；请稍后重试清除。'
          );
        }
        await SecureStore.deleteItemAsync(key);
      } catch (error) {
        if (error instanceof CloudSyncCredentialError) throw error;
        throw new CloudSyncCredentialError(
          'secure-store-unavailable',
          '同步已停用，但清除本机安全存储中的同步凭据失败；请重试清除。'
        );
      }
    },
  };
}

function serializedCredentialEnvelope(
  binding: CloudSyncCredentialBinding,
  credentials: CloudSyncCredentialRecord
): string {
  const normalized = normalizeCredentials(binding, credentials);
  const serialized = JSON.stringify({
    version: 1,
    binding: cloudSyncBindingFingerprint(binding),
    credentials: normalized,
  });
  if (serializedBytes(serialized) > MAX_SERIALIZED_CREDENTIAL_BYTES) {
    throw new CloudSyncCredentialError('invalid-credentials', '同步凭据过大，已拒绝保存。');
  }
  return serialized;
}

export async function readCloudSyncCredentials(
  binding: CloudSyncCredentialBinding,
  adapter: CloudSyncCredentialStoreAdapter = defaultAdapter()
): Promise<CloudSyncCredentialRecord | undefined> {
  const expectedBinding = cloudSyncBindingFingerprint(binding);
  const raw = await adapter.getItem(CLOUD_SYNC_CREDENTIAL_KEY);
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1 || parsed.binding !== expectedBinding) {
      // There is only one configured sync target. A binding change must not
      // leave an old target's credentials resident for a future accidental
      // reuse, even though the binding check would prevent hydration today.
      await adapter.deleteItem(CLOUD_SYNC_CREDENTIAL_KEY);
      return undefined;
    }
    return normalizeCredentials(binding, parsed.credentials);
  } catch (error) {
    await adapter.deleteItem(CLOUD_SYNC_CREDENTIAL_KEY);
    if (error instanceof CloudSyncCredentialError) throw error;
    return undefined;
  }
}

export async function writeCloudSyncCredentials(
  binding: CloudSyncCredentialBinding,
  credentials: CloudSyncCredentialRecord,
  adapter: CloudSyncCredentialStoreAdapter = defaultAdapter()
): Promise<void> {
  canonicalCloudSyncBinding(binding);
  await adapter.setItem(CLOUD_SYNC_CREDENTIAL_KEY, serializedCredentialEnvelope(binding, credentials));
}

export async function clearCloudSyncCredentials(
  adapter: CloudSyncCredentialStoreAdapter = defaultAdapter()
): Promise<void> {
  await adapter.deleteItem(CLOUD_SYNC_CREDENTIAL_KEY);
}
