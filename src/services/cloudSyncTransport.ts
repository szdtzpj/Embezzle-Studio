import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';

import type { CloudSyncProviderKind } from '../domain/types';

export const MAX_SYNC_OBJECT_BYTES = 10 * 1024 * 1024;
export const MAX_SYNC_MANIFEST_BYTES = 64 * 1024;
export const DEFAULT_SYNC_TIMEOUT_MS = 30_000;

export type CloudSyncErrorCode =
  | 'invalid-config'
  | 'credentials'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'rate-limited'
  | 'http'
  | 'precondition-failed'
  | 'too-large'
  | 'invalid-remote'
  | 'integrity-mismatch'
  | 'decrypt-failed'
  | 'unsupported';

export class CloudSyncError extends Error {
  readonly code: CloudSyncErrorCode;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    code: CloudSyncErrorCode,
    message: string,
    options: { status?: number; retryAfterMs?: number } = {}
  ) {
    super(message);
    this.name = 'CloudSyncError';
    this.code = code;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export interface CloudSyncObjectMetadata {
  key: string;
  etag?: string;
  size?: number;
  updatedAt?: number;
}

export interface CloudSyncObject extends CloudSyncObjectMetadata {
  body: Uint8Array;
}

export interface CloudSyncPutConditions {
  ifMatch?: string;
  ifNoneMatch?: '*';
}

export interface CloudSyncTransport {
  readonly kind: CloudSyncProviderKind;
  head(key: string, options?: { signal?: AbortSignal }): Promise<CloudSyncObjectMetadata | null>;
  get(key: string, options?: { limit?: number; signal?: AbortSignal }): Promise<CloudSyncObject>;
  put(
    key: string,
    body: Uint8Array | string,
    options?: {
      contentType?: string;
      conditions?: CloudSyncPutConditions;
      signal?: AbortSignal;
    }
  ): Promise<CloudSyncObjectMetadata>;
}

export interface CloudSyncTransportOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function digestBytes(value: Uint8Array): string {
  return bytesToHex(sha256(value));
}

export function digestText(value: string): string {
  return digestBytes(utf8ToBytes(value));
}

export function assertDigest(value: string, label = '摘要'): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new CloudSyncError('invalid-remote', `${label} 格式无效。`);
  }
  return normalized;
}

export function assertBoundedSize(size: number, limit: number, label: string): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > limit) {
    throw new CloudSyncError('too-large', `${label} 超过安全上限。`);
  }
}

export function normalizeEtag(value: string | null | undefined): string | undefined {
  const etag = value?.trim();
  if (!etag || etag.startsWith('W/')) return undefined;
  return etag;
}

export function responseUpdatedAt(response: Response): number | undefined {
  const value = response.headers.get('last-modified');
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function retryAfterMilliseconds(response: Response): number | undefined {
  const value = response.headers.get('retry-after')?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(300_000, Math.trunc(seconds * 1_000));
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(300_000, Math.max(0, date - Date.now()));
}

function responseErrorCode(status: number): CloudSyncErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 412 || status === 409) return 'precondition-failed';
  if (status === 429) return 'rate-limited';
  return 'http';
}

export function redactSensitiveText(value: string, maximum = 4_096): string {
  const sensitiveField = '(?:x-amz-[a-z-]+|authorization|password|secret|access[_-]?key|session[_-]?token|security[_-]?token|api[_-]?key|token|signature|credential)';
  return value
    .replace(
      new RegExp(`(${sensitiveField})\\s*(?:["']?\\s*[:=]\\s*["']?)([^"'\\r\\n,;&}]+)["']?`, 'giu'),
      '$1=[redacted]'
    )
    .replace(/([?&](?:token|key|password|secret|signature|credential)=)[^&\s]*/giu, '$1[redacted]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maximum);
}

function compactErrorBody(body: string): string {
  return redactSensitiveText(body, 240);
}

export async function readBoundedBytes(
  response: Response,
  limit: number,
  label: string,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared)) assertBoundedSize(declared, limit, label);
  if (signal?.aborted) throw new CloudSyncError('cancelled', '同步请求已取消。');

  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (signal?.aborted) throw new CloudSyncError('cancelled', '同步请求已取消。');
    assertBoundedSize(bytes.byteLength, limit, label);
    return bytes;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel();
        throw new CloudSyncError('cancelled', '同步请求已取消。');
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      assertBoundedSize(total, limit, label);
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Best effort cancellation after a bounded-read failure.
    }
    if (error instanceof CloudSyncError) throw error;
    throw abortAwareError(error, signal);
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

export async function readBoundedText(
  response: Response,
  limit: number,
  label: string,
  signal?: AbortSignal
): Promise<string> {
  const bytes = await readBoundedBytes(response, limit, label, signal);
  return new TextDecoder().decode(bytes);
}

export async function throwForResponse(
  response: Response,
  label: string,
  signal?: AbortSignal
): Promise<never> {
  let body = '';
  try {
    body = await readBoundedText(response, 4 * 1024, `${label}错误`, signal);
  } catch {
    // The status code is still useful when a proxy closes the body early.
  }
  const suffix = compactErrorBody(body);
  const code = responseErrorCode(response.status);
  const safeSuffix = code === 'unauthorized' || code === 'forbidden' ? '' : suffix;
  throw new CloudSyncError(
    code,
    `${label}失败（HTTP ${response.status}）${safeSuffix ? `：${safeSuffix}` : ''}`,
    { status: response.status, retryAfterMs: retryAfterMilliseconds(response) }
  );
}

export function abortAwareError(error: unknown, signal?: AbortSignal): CloudSyncError {
  if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
    return new CloudSyncError('cancelled', '同步请求已取消。');
  }
  if (error instanceof CloudSyncError) return error;
  return new CloudSyncError('network', '同步网络请求失败。');
}

export async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_SYNC_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<Response> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5 * 60_000) {
    throw new CloudSyncError('invalid-config', '同步请求超时时间无效。');
  }
  if (signal?.aborted) throw new CloudSyncError('cancelled', '同步请求已取消。');
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => controller.abort();
  signal?.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetchImpl(url, { ...init, redirect: 'error', signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new CloudSyncError('timeout', '同步请求超时。');
    throw abortAwareError(error, signal);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}
