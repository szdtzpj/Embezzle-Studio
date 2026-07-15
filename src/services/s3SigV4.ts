import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

import {
  CloudSyncCredentialError,
  canonicalCloudSyncEndpoint,
  canonicalCloudSyncRemotePath,
} from './cloudSyncCredentials';
import {
  CloudSyncError,
  abortAwareError,
  fetchWithTimeout,
  normalizeEtag,
  readBoundedBytes,
  responseUpdatedAt,
  throwForResponse,
  MAX_SYNC_OBJECT_BYTES,
  type CloudSyncObject,
  type CloudSyncObjectMetadata,
  type CloudSyncPutConditions,
  type CloudSyncTransport,
  type CloudSyncTransportOptions,
} from './cloudSyncTransport';
import type { CloudSyncCredentialRecord } from './cloudSyncCredentials';

export interface S3SigV4Config {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface S3SignedRequest {
  url: string;
  headers: Record<string, string>;
  payloadHash: string;
  amzDate: string;
  credentialScope: string;
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

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function endpointSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        throw new CloudSyncError('invalid-config', 'S3 Endpoint 路径编码无效。');
      }
    });
}

function validateBucket(bucket: string): string {
  const normalized = bucket.trim();
  if (!normalized || normalized.length > 255 || normalized.includes('/') || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new CloudSyncError('invalid-config', 'S3 Bucket 无效。');
  }
  return normalized;
}

function validateRegion(region: string): string {
  const normalized = region.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/u.test(normalized) && normalized !== 'us-east-1') {
    throw new CloudSyncError('invalid-config', 'S3 Region 无效。');
  }
  return normalized;
}

function validateCredential(
  value: string,
  label: string,
  maximum: number,
  trim = false
): string {
  const normalized = trim ? value.trim() : value;
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new CloudSyncError('credentials', `${label} 无效。`);
  }
  return normalized;
}

function encodedObjectPath(endpoint: string, bucket: string, remotePath: string, key: string): {
  url: URL;
  canonicalUri: string;
} {
  const url = new URL(transportConfig(() => canonicalCloudSyncEndpoint(endpoint)));
  const keySegments = key.split('/').filter(Boolean);
  if (!keySegments.length || keySegments.some((segment) => segment === '.' || segment === '..')) {
    throw new CloudSyncError('invalid-config', 'S3 对象键包含非法路径段。');
  }
  const segments = [
    ...endpointSegments(url.pathname),
    validateBucket(bucket),
    ...transportConfig(() => canonicalCloudSyncRemotePath(remotePath)).split('/'),
    ...keySegments,
  ];
  const encoded = segments.map(awsEncode);
  url.pathname = `/${encoded.join('/')}`;
  url.search = '';
  url.hash = '';
  return { url, canonicalUri: `/${encoded.join('/')}` };
}

function normalizeHeaderValue(value: string): string {
  return value.trim().replace(/[ \t]+/gu, ' ');
}

function canonicalHeaders(headers: Record<string, string>): { text: string; signed: string } {
  const entries = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase().trim(), normalizeHeaderValue(value)] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return {
    text: entries.map(([name, value]) => `${name}:${value}\n`).join(''),
    signed: entries.map(([name]) => name).join(';'),
  };
}

function toAmzDate(value: Date | string | undefined): { amzDate: string; dateStamp: string } {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new CloudSyncError('invalid-config', 'S3 签名时间无效。');
  const iso = date.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function signingKey(secretAccessKey: string, dateStamp: string, region: string): Uint8Array {
  const dateKey = hmac(sha256, utf8ToBytes(`AWS4${secretAccessKey}`), utf8ToBytes(dateStamp));
  const regionKey = hmac(sha256, dateKey, utf8ToBytes(region));
  const serviceKey = hmac(sha256, regionKey, utf8ToBytes('s3'));
  const signing = hmac(sha256, serviceKey, utf8ToBytes('aws4_request'));
  dateKey.fill(0);
  regionKey.fill(0);
  serviceKey.fill(0);
  return signing;
}

function bodyBytes(body: Uint8Array | string | undefined): Uint8Array {
  return body === undefined ? new Uint8Array() : typeof body === 'string' ? utf8ToBytes(body) : Uint8Array.from(body);
}

/** Builds an AWS Signature V4 request for S3-compatible path-style endpoints. */
export function signS3Request(
  config: S3SigV4Config,
  request: {
    method: 'GET' | 'HEAD' | 'PUT';
    remotePath: string;
    key: string;
    body?: Uint8Array | string;
    contentType?: string;
    conditions?: CloudSyncPutConditions;
    now?: Date | string;
  }
): S3SignedRequest {
  const endpoint = transportConfig(() => canonicalCloudSyncEndpoint(config.endpoint));
  const bucket = validateBucket(config.bucket);
  const region = validateRegion(config.region);
  const accessKeyId = validateCredential(config.accessKeyId, 'S3 Access Key ID', 512, true);
  const secretAccessKey = validateCredential(config.secretAccessKey, 'S3 Secret Access Key', 1024);
  const sessionToken = config.sessionToken
    ? validateCredential(config.sessionToken, 'S3 Session Token', 4096)
    : undefined;
  const { url, canonicalUri } = encodedObjectPath(endpoint, bucket, request.remotePath, request.key);
  if (request.conditions?.ifMatch && request.conditions.ifNoneMatch) {
    throw new CloudSyncError('invalid-config', '同步写入条件不能同时使用 If-Match 和 If-None-Match。');
  }
  const bytes = bodyBytes(request.body);
  if (bytes.byteLength > MAX_SYNC_OBJECT_BYTES) {
    throw new CloudSyncError('too-large', 'S3 上传对象超过 10 MiB 安全上限。');
  }
  const payloadHash = bytesToHex(sha256(bytes));
  const { amzDate, dateStamp } = toAmzDate(request.now);
  const host = url.host;
  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...(request.contentType ? { 'content-type': request.contentType } : {}),
    ...(config.sessionToken ? { 'x-amz-security-token': sessionToken! } : {}),
    ...(request.conditions?.ifMatch ? { 'if-match': request.conditions.ifMatch } : {}),
    ...(request.conditions?.ifNoneMatch ? { 'if-none-match': request.conditions.ifNoneMatch } : {}),
  };
  const canonical = canonicalHeaders(headers);
  const canonicalRequest = [
    request.method,
    canonicalUri,
    '',
    canonical.text,
    canonical.signed,
    payloadHash,
  ].join('\n');
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    bytesToHex(sha256(utf8ToBytes(canonicalRequest))),
  ].join('\n');
  const key = signingKey(secretAccessKey, dateStamp, region);
  const signature = bytesToHex(hmac(sha256, key, utf8ToBytes(stringToSign)));
  key.fill(0);
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${canonical.signed}, Signature=${signature}`;

  // Host is included in the signature but intentionally omitted from fetch's
  // mutable header map; browsers forbid setting Host and native stacks fill it
  // from the URL. All other signed headers are sent verbatim.
  const outputHeaders: Record<string, string> = {
    Authorization: authorization,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...(request.contentType ? { 'Content-Type': request.contentType } : {}),
    ...(sessionToken ? { 'x-amz-security-token': sessionToken } : {}),
    ...(request.conditions?.ifMatch ? { 'If-Match': request.conditions.ifMatch } : {}),
    ...(request.conditions?.ifNoneMatch ? { 'If-None-Match': request.conditions.ifNoneMatch } : {}),
  };
  return {
    url: url.toString(),
    headers: outputHeaders,
    payloadHash,
    amzDate,
    credentialScope: scope,
  };
}

export interface S3TransportConfig extends CloudSyncTransportOptions {
  endpoint: string;
  remotePath: string;
  bucket: string;
  region: string;
  credentials: Pick<CloudSyncCredentialRecord, 'accessKeyId' | 'secretAccessKey' | 'sessionToken'>;
}

function responseContentLength(response: Response): number | undefined {
  const raw = response.headers.get('content-length');
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function createS3Transport(config: S3TransportConfig): CloudSyncTransport {
  const endpoint = transportConfig(() => canonicalCloudSyncEndpoint(config.endpoint));
  const remotePath = transportConfig(() => canonicalCloudSyncRemotePath(config.remotePath));
  const bucket = validateBucket(config.bucket);
  const region = validateRegion(config.region);
  const accessKeyId = validateCredential(
    config.credentials.accessKeyId ?? '',
    'S3 Access Key ID',
    512,
    true
  );
  const secretAccessKey = validateCredential(
    config.credentials.secretAccessKey ?? '',
    'S3 Secret Access Key',
    1024
  );
  const fetchImpl = config.fetchImpl ?? fetch;

  async function request(
    method: 'GET' | 'HEAD' | 'PUT',
    key: string,
    options: {
      body?: Uint8Array;
      contentType?: string;
      conditions?: CloudSyncPutConditions;
      signal?: AbortSignal;
    } = {}
  ): Promise<Response> {
    const signed = signS3Request(
      { endpoint, bucket, region, accessKeyId, secretAccessKey, sessionToken: config.credentials.sessionToken },
      { method, remotePath, key, ...options }
    );
    try {
      return await fetchWithTimeout(
        fetchImpl,
        signed.url,
        {
          method,
          headers: signed.headers,
          ...(options.body ? { body: options.body as unknown as BodyInit } : {}),
        },
        config.timeoutMs,
        options.signal
      );
    } catch (error) {
      throw abortAwareError(error, options.signal);
    }
  }

  async function head(key: string, options: { signal?: AbortSignal } = {}): Promise<CloudSyncObjectMetadata | null> {
    const response = await request('HEAD', key, options);
    if (response.status === 404) return null;
    if (!response.ok) await throwForResponse(response, 'S3 HEAD', options.signal);
    const size = responseContentLength(response);
    if (size !== undefined && size > MAX_SYNC_OBJECT_BYTES) {
      throw new CloudSyncError('too-large', 'S3 对象超过 10 MiB 安全上限。');
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
    if (!response.ok) await throwForResponse(response, 'S3 GET', options.signal);
    const body = await readBoundedBytes(response, limit, 'S3 对象', options.signal);
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
      throw new CloudSyncError('too-large', 'S3 上传对象超过 10 MiB 安全上限。');
    }
    const response = await request('PUT', key, { ...options, body: bytes });
    if (!response.ok) await throwForResponse(response, 'S3 PUT', options.signal);
    return {
      key,
      etag: normalizeEtag(response.headers.get('etag')),
      size: bytes.byteLength,
      ...(responseUpdatedAt(response) !== undefined ? { updatedAt: responseUpdatedAt(response) } : {}),
    };
  }

  return {
    kind: 's3',
    head,
    get,
    put,
  };
}
