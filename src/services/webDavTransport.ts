import { utf8ToBytes } from '@noble/ciphers/utils.js';

import type { CloudSyncCredentialRecord } from './cloudSyncCredentials';
import {
  CloudSyncCredentialError,
  canonicalCloudSyncEndpoint,
  canonicalCloudSyncRemotePath,
} from './cloudSyncCredentials';
import {
  CloudSyncError,
  MAX_SYNC_OBJECT_BYTES,
  abortAwareError,
  fetchWithTimeout,
  normalizeEtag,
  readBoundedBytes,
  responseUpdatedAt,
  throwForResponse,
  type CloudSyncObject,
  type CloudSyncObjectMetadata,
  type CloudSyncPutConditions,
  type CloudSyncTransport,
  type CloudSyncTransportOptions,
} from './cloudSyncTransport';

export interface WebDavTransportConfig extends CloudSyncTransportOptions {
  endpoint: string;
  remotePath: string;
  credentials: Pick<CloudSyncCredentialRecord, 'username' | 'password'>;
}

function transportConfig<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof CloudSyncCredentialError) {
      throw new CloudSyncError(
        error.code === 'invalid-config' ? 'invalid-config' : 'credentials',
        error.message
      );
    }
    throw error;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
    output += alphabet[first >> 2];
    output += alphabet[((first & 3) << 4) | (second >> 4)];
    output += index + 1 < bytes.length ? alphabet[((second & 15) << 2) | (third >> 6)] : '=';
    output += index + 2 < bytes.length ? alphabet[third & 63] : '=';
  }
  return output;
}

function encodeBasic(username: string, password: string): string {
  return `Basic ${bytesToBase64(utf8ToBytes(`${username}:${password}`))}`;
}

function decodedPathSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        throw new CloudSyncError('invalid-config', 'WebDAV Endpoint 路径编码无效。');
      }
    });
}

function objectUrl(endpoint: string, remotePath: string, key: string): string {
  const url = new URL(transportConfig(() => canonicalCloudSyncEndpoint(endpoint)));
  const endpointSegments = decodedPathSegments(url.pathname);
  const remoteSegments = transportConfig(() => canonicalCloudSyncRemotePath(remotePath)).split('/');
  const keySegments = key.split('/').filter(Boolean);
  if (!keySegments.length || keySegments.some((segment) => segment === '.' || segment === '..')) {
    throw new CloudSyncError('invalid-config', 'WebDAV 对象键包含非法路径段。');
  }
  url.pathname = `/${[...endpointSegments, ...remoteSegments, ...keySegments]
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function contentLength(response: Response): number | undefined {
  const raw = response.headers.get('content-length');
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function validateCredentials(credentials: WebDavTransportConfig['credentials']): { username: string; password: string } {
  const username = credentials.username?.trim();
  const password = credentials.password;
  if (!username || !password) {
    throw new CloudSyncError('credentials', 'WebDAV 用户名或密码缺失。');
  }
  return { username, password };
}

function conditionsHeaders(conditions?: CloudSyncPutConditions): Record<string, string> {
  if (!conditions) return {};
  if (conditions.ifMatch && conditions.ifNoneMatch) {
    throw new CloudSyncError('invalid-config', '同步写入条件不能同时使用 If-Match 和 If-None-Match。');
  }
  return {
    ...(conditions.ifMatch ? { 'If-Match': conditions.ifMatch } : {}),
    ...(conditions.ifNoneMatch ? { 'If-None-Match': conditions.ifNoneMatch } : {}),
  };
}

export function createWebDavTransport(config: WebDavTransportConfig): CloudSyncTransport {
  const endpoint = transportConfig(() => canonicalCloudSyncEndpoint(config.endpoint));
  const remotePath = transportConfig(() => canonicalCloudSyncRemotePath(config.remotePath));
  const credentials = validateCredentials(config.credentials);
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs;
  const auth = encodeBasic(credentials.username, credentials.password);

  async function request(
    method: 'HEAD' | 'GET' | 'PUT',
    key: string,
    options: {
      body?: Uint8Array;
      contentType?: string;
      conditions?: CloudSyncPutConditions;
      signal?: AbortSignal;
    } = {}
  ): Promise<Response> {
    const url = objectUrl(endpoint, remotePath, key);
    const headers: Record<string, string> = {
      Accept: 'application/octet-stream, application/json;q=0.9, */*;q=0.1',
      Authorization: auth,
      ...conditionsHeaders(options.conditions),
    };
    if (options.body) {
      headers['Content-Type'] = options.contentType ?? 'application/octet-stream';
    }
    try {
      return await fetchWithTimeout(
        fetchImpl,
        url,
        {
          method,
          headers,
          ...(options.body ? { body: options.body as unknown as BodyInit } : {}),
        },
        timeoutMs,
        options.signal
      );
    } catch (error) {
      throw abortAwareError(error, options.signal);
    }
  }

  async function head(key: string, options: { signal?: AbortSignal } = {}): Promise<CloudSyncObjectMetadata | null> {
    const response = await request('HEAD', key, options);
    if (response.status === 404) return null;
    if (!response.ok) await throwForResponse(response, 'WebDAV HEAD', options.signal);
    const size = contentLength(response);
    if (size !== undefined) {
      if (size > MAX_SYNC_OBJECT_BYTES) {
        throw new CloudSyncError('too-large', 'WebDAV 对象超过 10 MiB 安全上限。');
      }
    }
    return {
      key,
      etag: normalizeEtag(response.headers.get('etag')),
      ...(size !== undefined ? { size } : {}),
      ...(responseUpdatedAt(response) !== undefined ? { updatedAt: responseUpdatedAt(response) } : {}),
    };
  }

  async function get(
    key: string,
    options: { limit?: number; signal?: AbortSignal } = {}
  ): Promise<CloudSyncObject> {
    const limit = options.limit ?? MAX_SYNC_OBJECT_BYTES;
    const response = await request('GET', key, options);
    if (!response.ok) await throwForResponse(response, 'WebDAV GET', options.signal);
    const body = await readBoundedBytes(response, limit, 'WebDAV 对象', options.signal);
    return {
      key,
      body,
      etag: normalizeEtag(response.headers.get('etag')),
      size: body.byteLength,
      ...(responseUpdatedAt(response) !== undefined ? { updatedAt: responseUpdatedAt(response) } : {}),
    };
  }

  async function put(
    key: string,
    body: Uint8Array | string,
    options: {
      contentType?: string;
      conditions?: CloudSyncPutConditions;
      signal?: AbortSignal;
    } = {}
  ): Promise<CloudSyncObjectMetadata> {
    const bytes = typeof body === 'string' ? utf8ToBytes(body) : Uint8Array.from(body);
    if (bytes.byteLength > MAX_SYNC_OBJECT_BYTES) {
      throw new CloudSyncError('too-large', 'WebDAV 上传对象超过 10 MiB 安全上限。');
    }
    const response = await request('PUT', key, { ...options, body: bytes });
    if (!response.ok) await throwForResponse(response, 'WebDAV PUT', options.signal);
    return {
      key,
      etag: normalizeEtag(response.headers.get('etag')),
      size: bytes.byteLength,
      ...(responseUpdatedAt(response) !== undefined ? { updatedAt: responseUpdatedAt(response) } : {}),
    };
  }

  return {
    kind: 'webdav',
    head,
    get,
    put,
  };
}
