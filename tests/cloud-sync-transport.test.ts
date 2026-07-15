import { describe, expect, it, vi } from 'vitest';

import { CloudSyncError, redactSensitiveText } from '../src/services/cloudSyncTransport';
import { createS3Transport, signS3Request } from '../src/services/s3SigV4';
import { createWebDavTransport } from '../src/services/webDavTransport';

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('expo-secure-store', () => ({
  isAvailableAsync: vi.fn(async () => true),
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

describe('WebDAV cloud-sync transport', () => {
  it('redacts JSON, header-style, and query-string credentials before diagnostics', () => {
    const redacted = redactSensitiveText(
      '{"password":"topsecret","token":"abc","x-amz-security-token":"session"} Authorization: Bearer value https://example.test/?signature=deadbeef'
    );
    expect(redacted).not.toContain('topsecret');
    expect(redacted).not.toContain('abc');
    expect(redacted).not.toContain('session');
    expect(redacted).not.toContain('Bearer value');
    expect(redacted).not.toContain('deadbeef');
  });

  it('keeps credentials out of the URL and sends conditional PUT over an encoded path', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(null, { status: 204, headers: { etag: '"etag-2"' } })
    );
    const transport = createWebDavTransport({
      endpoint: 'https://dav.example.com/root',
      remotePath: 'Embezzle Studio/device',
      credentials: { username: 'user', password: 'pass' },
      fetchImpl,
    });

    await transport.put('manifest.json', '{"ok":true}', {
      contentType: 'application/json',
      conditions: { ifMatch: '"etag-1"' },
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://dav.example.com/root/Embezzle%20Studio/device/manifest.json'
    );
    expect(url).not.toContain('user');
    expect(url).not.toContain('pass');
    expect(init.method).toBe('PUT');
    expect(init.redirect).toBe('error');
    expect(init.headers).toMatchObject({
      Authorization: 'Basic dXNlcjpwYXNz',
      'If-Match': '"etag-1"',
      'Content-Type': 'application/json',
    });
  });

  it('maps failed conditional writes and rejects oversized downloads before allocation', async () => {
    const conflictTransport = createWebDavTransport({
      endpoint: 'https://dav.example.com',
      remotePath: 'sync',
      credentials: { username: 'user', password: 'pass' },
      fetchImpl: async () => new Response('changed', { status: 412 }),
    });
    await expect(
      conflictTransport.put('manifest.json', 'next', {
        conditions: { ifMatch: '"old"' },
      })
    ).rejects.toMatchObject({ code: 'precondition-failed', status: 412 });

    const oversizedTransport = createWebDavTransport({
      endpoint: 'https://dav.example.com',
      remotePath: 'sync',
      credentials: { username: 'user', password: 'pass' },
      fetchImpl: async () =>
        new Response('x', {
          status: 200,
          headers: { 'content-length': String(10 * 1024 * 1024 + 1) },
        }),
    });
    await expect(oversizedTransport.get('snapshot.enc.json')).rejects.toMatchObject({
      code: 'too-large',
    });
  });
});

describe('S3 Signature V4 cloud-sync transport', () => {
  const config = {
    endpoint: 'https://s3.us-east-1.amazonaws.com',
    bucket: 'examplebucket',
    region: 'us-east-1',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  };

  it('matches an independently calculated deterministic SigV4 vector', () => {
    const signed = signS3Request(config, {
      method: 'GET',
      remotePath: 'Embezzle-Studio',
      key: 'test.txt',
      now: '2013-05-24T00:00:00.000Z',
    });
    expect(signed.url).toBe(
      'https://s3.us-east-1.amazonaws.com/examplebucket/Embezzle-Studio/test.txt'
    );
    expect(signed.payloadHash).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
    expect(signed.headers.Authorization).toContain(
      'Signature=334468719da90c53f38bfd001bd99c71d478b3aa8fa1851b8be0ad6c52dd00e1'
    );
    expect(signed.headers.Authorization).toContain(
      'SignedHeaders=host;x-amz-content-sha256;x-amz-date'
    );
  });

  it('signs conditional headers and a temporary session token without exposing secrets in the URL', () => {
    const signed = signS3Request(
      { ...config, sessionToken: 'temporary-session-token' },
      {
        method: 'PUT',
        remotePath: 'Embezzle Studio',
        key: 'manifest.json',
        body: '{}',
        contentType: 'application/json',
        conditions: { ifNoneMatch: '*' },
        now: '2026-07-14T01:02:03.000Z',
      }
    );
    expect(signed.headers['If-None-Match']).toBe('*');
    expect(signed.headers['x-amz-security-token']).toBe('temporary-session-token');
    expect(signed.headers.Authorization).toContain('content-type');
    expect(signed.headers.Authorization).toContain('if-none-match');
    expect(signed.url).not.toContain('AKIDEXAMPLE');
    expect(signed.url).not.toContain('temporary-session-token');
  });

  it('creates signed path-style S3 requests and fails closed on authorization errors', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response('<Error>Denied</Error>', { status: 403 })
    );
    const transport = createS3Transport({
      endpoint: config.endpoint,
      remotePath: 'Embezzle-Studio',
      bucket: config.bucket,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      fetchImpl,
    });
    await expect(transport.head('manifest.json')).rejects.toMatchObject({
      code: 'forbidden',
      status: 403,
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/examplebucket/Embezzle-Studio/manifest.json');
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^AWS4-HMAC-SHA256 /u);
    expect(init.redirect).toBe('error');
  });

  it('rejects malformed S3 configuration before any network request', () => {
    expect(() =>
      createS3Transport({
        endpoint: 'http://s3.example.com',
        remotePath: 'sync',
        bucket: 'bucket',
        region: 'auto',
        credentials: { accessKeyId: 'id', secretAccessKey: 'secret' },
      })
    ).toThrow(CloudSyncError);
  });
});
