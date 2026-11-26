import { request as httpRequest, type Server } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

// The production entry point intentionally remains an ESM JavaScript script so it can
// still be launched directly by `node scripts/dev-proxy.mjs`.
// @ts-ignore -- no declaration file is needed for this script-only module.
import {
  OFFICIAL_PROVIDER_HOSTS,
  createOriginPolicy,
  createProxyServer,
} from '../scripts/dev-proxy.mjs';

const localOrigin = 'http://localhost:8081';
const openServers = new Set<Server>();

async function startProxy(options: Record<string, unknown> = {}) {
  const server = createProxyServer(options) as Server;
  openServers.add(server);

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Proxy did not expose a TCP address.');
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function closeServer(server: Server) {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
    server.closeAllConnections?.();
  });
}

function proxyHeaders(origin = localOrigin) {
  return {
    Origin: origin,
    'Content-Type': 'application/json',
  };
}

afterEach(async () => {
  const servers = [...openServers];
  openServers.clear();
  await Promise.all(servers.map(closeServer));
  vi.restoreAllMocks();
});

describe('dev proxy origin policy', () => {
  it('accepts only the exact default Expo origins by default', () => {
    const policy = createOriginPolicy();

    expect(policy.resolve('http://localhost:8081')).toBe('http://localhost:8081');
    expect(policy.resolve('http://127.0.0.1:8081')).toBe('http://127.0.0.1:8081');
    expect(policy.resolve('http://localhost:19006')).toBeNull();
    expect(policy.resolve('https://127.0.0.1:8443')).toBeNull();
    expect(policy.resolve('http://localhost.evil.test:19006')).toBeNull();
    expect(policy.resolve('https://example.test')).toBeNull();
    expect(policy.resolve('null')).toBeNull();
    expect(policy.resolve(undefined)).toBeNull();
  });

  it('appends explicit configured origins without removing the exact local defaults', () => {
    const policy = createOriginPolicy('https://preview.example.test/, http://dev.example.test:3000');

    expect(policy.resolve('https://preview.example.test')).toBe('https://preview.example.test');
    expect(policy.resolve('http://dev.example.test:3000')).toBe('http://dev.example.test:3000');
    expect(policy.resolve('http://localhost:9999')).toBeNull();
    expect(policy.resolve('https://preview.example.test.evil')).toBeNull();
  });

  it('rejects wildcard or path-based configured origins', () => {
    expect(() => createOriginPolicy('*')).toThrow(/explicit http\(s\) origins/i);
    expect(() => createOriginPolicy('https://preview.example.test/path')).toThrow(/without a path/i);
  });
});

describe('dev proxy request handling', () => {
  it('allows an explicit local provider target and strips dangerous upstream headers', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('upstream ok', {
        status: 201,
        headers: { 'Content-Type': 'text/plain' },
      })
    );
    const { baseUrl } = await startProxy({ fetchImpl });

    const response = await fetch(`${baseUrl}/proxy`, {
      method: 'POST',
      headers: proxyHeaders(),
      body: JSON.stringify({
        url: 'http://127.0.0.1:4567/v1/models',
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer local-provider-key',
          'X-Api-Key': 'provider-specific-key',
          Host: 'attacker.test',
          Cookie: 'session=secret',
          Origin: 'https://attacker.test',
          Referer: 'https://attacker.test/page',
          Connection: 'keep-alive, x-hop',
          'X-Hop': 'remove-me',
          'X-Forwarded-For': '203.0.113.10',
          'X-Http-Method-Override': 'DELETE',
          'X-Original-URL': '/admin',
          'Sec-Fetch-Site': 'same-origin',
        },
      }),
    });

    expect(response.status).toBe(201);
    expect(await response.text()).toBe('upstream ok');
    expect(response.headers.get('access-control-allow-origin')).toBe(localOrigin);
    expect(response.headers.get('vary')).toMatch(/origin/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [target, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(target)).toBe('http://127.0.0.1:4567/v1/models');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.redirect).toBe('error');
    expect(init.headers).toEqual({
      accept: 'application/json',
      authorization: 'Bearer local-provider-key',
      'x-api-key': 'provider-specific-key',
    });
  });

  it.each([
    ['a non-local site', 'https://example.test'],
    ['a localhost lookalike', 'http://localhost.evil.test:8081'],
    ['a missing Origin', undefined],
  ])('rejects %s before contacting upstream', async (_label, origin) => {
    const fetchImpl = vi.fn();
    const { baseUrl } = await startProxy({ fetchImpl });
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (origin) {
      headers.Origin = origin;
    }

    const response = await fetch(`${baseUrl}/proxy`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: 'http://127.0.0.1:4567/v1/models', method: 'GET' }),
    });

    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('vary')).toMatch(/origin/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('echoes an explicitly configured origin and still allows preflight only for POST/content-type', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'));
    const { baseUrl } = await startProxy({
      fetchImpl,
      allowedOrigins: 'https://preview.example.test',
    });

    const allowed = await fetch(`${baseUrl}/proxy`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://preview.example.test',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://preview.example.test');
    expect(allowed.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
    expect(allowed.headers.get('vary')).toMatch(/origin/i);

    const deniedMethod = await fetch(`${baseUrl}/proxy`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://preview.example.test',
        'Access-Control-Request-Method': 'PUT',
      },
    });
    expect(deniedMethod.status).toBe(405);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('enforces the proxy route, HTTP method, JSON content type, and upstream method', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'));
    const { baseUrl } = await startProxy({ fetchImpl });

    const wrongRoute = await fetch(`${baseUrl}/other`, {
      method: 'POST',
      headers: proxyHeaders(),
      body: '{}',
    });
    expect(wrongRoute.status).toBe(404);

    const wrongHttpMethod = await fetch(`${baseUrl}/proxy`, {
      method: 'PUT',
      headers: proxyHeaders(),
      body: '{}',
    });
    expect(wrongHttpMethod.status).toBe(405);
    expect(wrongHttpMethod.headers.get('allow')).toBe('POST, OPTIONS');

    const wrongContentType = await fetch(`${baseUrl}/proxy`, {
      method: 'POST',
      headers: { Origin: localOrigin, 'Content-Type': 'text/plain' },
      body: '{}',
    });
    expect(wrongContentType.status).toBe(415);

    const wrongUpstreamMethod = await fetch(`${baseUrl}/proxy`, {
      method: 'POST',
      headers: proxyHeaders(),
      body: JSON.stringify({ url: 'https://provider.example.test/v1/models', method: 'DELETE' }),
    });
    expect(wrongUpstreamMethod.status).toBe(400);
    expect(await wrongUpstreamMethod.json()).toMatchObject({
      error: expect.stringMatching(/GET or POST/i),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns 413 without contacting upstream when the proxy body exceeds the limit', async () => {
    const fetchImpl = vi.fn();
    const { baseUrl } = await startProxy({ fetchImpl, maxBodyBytes: 128 });

    const response = await fetch(`${baseUrl}/proxy`, {
      method: 'POST',
      headers: proxyHeaders(),
      body: JSON.stringify({
        url: 'https://provider.example.test/v1/chat/completions',
        method: 'POST',
        body: 'x'.repeat(256),
      }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: expect.stringMatching(/exceeds 128 bytes/i),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('aborts a timed-out upstream request and returns 504 with CORS headers', async () => {
    let upstreamSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_target: URL, init: RequestInit) => {
      upstreamSignal = init.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        upstreamSignal?.addEventListener(
          'abort',
          () => reject(upstreamSignal?.reason ?? new Error('aborted')),
          { once: true }
        );
      });
    });
    const { baseUrl } = await startProxy({ fetchImpl, upstreamTimeoutMs: 25 });

    const response = await fetch(`${baseUrl}/proxy`, {
      method: 'POST',
      headers: proxyHeaders(),
      body: JSON.stringify({ url: 'https://provider.example.test/v1/models', method: 'GET' }),
    });

    expect(response.status).toBe(504);
    expect(response.headers.get('access-control-allow-origin')).toBe(localOrigin);
    expect(response.headers.get('vary')).toMatch(/origin/i);
    expect(upstreamSignal?.aborted).toBe(true);
    expect(await response.json()).toMatchObject({
      error: expect.stringMatching(/timed out/i),
    });
  });

  it('aborts the upstream fetch when the downstream client disconnects', async () => {
    let markStarted!: () => void;
    let markAborted!: (reason: unknown) => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const aborted = new Promise<unknown>((resolve) => {
      markAborted = resolve;
    });
    const fetchImpl = vi.fn((_target: URL, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      markStarted();
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            markAborted(signal.reason);
            reject(signal.reason);
          },
          { once: true }
        );
      });
    });
    const { baseUrl } = await startProxy({ fetchImpl, upstreamTimeoutMs: 10_000 });
    const proxyUrl = new URL(`${baseUrl}/proxy`);
    const body = JSON.stringify({ url: 'https://provider.example.test/v1/models', method: 'GET' });

    const clientRequest = httpRequest({
      hostname: proxyUrl.hostname,
      port: proxyUrl.port,
      path: proxyUrl.pathname,
      method: 'POST',
      headers: {
        ...proxyHeaders(),
        'Content-Length': Buffer.byteLength(body),
      },
    });
    clientRequest.on('error', () => {});
    clientRequest.end(body);

    await started;
    clientRequest.destroy();

    await expect(aborted).resolves.toBeInstanceOf(Error);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('forwards multi-protocol provider headers, exposes safe rate-limit headers, and blocks set-cookie', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Request-Id': 'req-123',
          'Retry-After': '15',
          'Anthropic-Ratelimit-Requests-Remaining': '42',
          'X-Ratelimit-Remaining': '99',
          'Set-Cookie': 'session=leak; HttpOnly',
        },
      })
    );
    const { baseUrl } = await startProxy({ fetchImpl });

    const response = await fetch(`${baseUrl}/proxy`, {
      method: 'POST',
      headers: proxyHeaders(),
      body: JSON.stringify({
        url: 'https://api.anthropic.com/v1/messages',
        method: 'POST',
        headers: {
          'x-api-key': 'sk-ant-test',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'web-search-2025-03-05',
          'x-goog-api-key': 'AIza-test',
          'x-grok-conv-id': 'conv-99',
          'X-Custom-Tag': 'hello',
        },
        body: JSON.stringify({ model: 'claude-sonnet-5-5' }),
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('req-123');
    expect(response.headers.get('retry-after')).toBe('15');
    expect(response.headers.get('anthropic-ratelimit-requests-remaining')).toBe('42');
    expect(response.headers.get('x-ratelimit-remaining')).toBe('99');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('access-control-expose-headers')).toContain('x-request-id');

    const [, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(init.headers).toEqual({
      'x-api-key': 'sk-ant-test',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'web-search-2025-03-05',
      'x-goog-api-key': 'AIza-test',
      'x-grok-conv-id': 'conv-99',
      'x-custom-tag': 'hello',
    });
  });

  it.each([
    ['non-loopback plaintext http', 'http://provider.example.test/v1/models', 400],
    ['cloud metadata IPv4', 'http://169.254.169.254/latest/meta-data/', 403],
    ['cloud metadata IPv4 HTTPS', 'https://169.254.169.254/latest/meta-data/', 403],
    ['Alibaba Cloud metadata IPv4 (100.64.0.0/10)', 'https://100.100.100.200/latest/meta-data', 403],
    ['unspecified IPv4 (0.0.0.0/8)', 'https://0.0.0.0/', 403],
    ['unspecified IPv6 (::/128)', 'https://[::]/', 403],
    ['IPv6 ULA / AWS IPv6 IMDS (fc00::/7)', 'https://[fd00:ec2::254]/latest/meta-data', 403],
    ['IPv6 ULA fc00::1', 'https://[fc00::1]/', 403],
    ['IPv6 link-local (fe80::/10)', 'https://[fe80::1]/', 403],
    ['IPv4-mapped metadata IPv6', 'http://[::ffff:169.254.169.254]/latest/meta-data/', 403],
    ['IPv4-mapped unspecified IPv6', 'https://[::ffff:0.0.0.0]/', 403],
    ['IPv4-mapped Alibaba metadata IPv6', 'https://[::ffff:100.100.100.200]/', 403],
    ['IPv4-mapped spoofed loopback IPv6', 'https://[::ffff:7f00:1]/', 403],
    ['IPv4-compatible metadata IPv6', 'https://[::169.254.169.254]/', 403],
    ['NAT64 metadata IPv6', 'https://[64:ff9b::169.254.169.254]/', 403],
    ['NAT64 spoofed loopback IPv6', 'https://[64:ff9b::7f00:1]/', 403],
    ['NAT64 local-use IPv6 (64:ff9b:1::/48)', 'https://[64:ff9b:1::8.8.8.8]/', 403],
    ['6to4 metadata IPv6', 'https://[2002:a9fe:a9fe::]/', 403],
    ['6to4 general IPv6 (2002::/16)', 'https://[2002:0808:0808::1]/', 403],
    ['Teredo IPv6 (2001::/32)', 'https://[2001:0000:4136:e378:8000:63bf:3fff:fdd2]/v1/models', 403],
    ['ISATAP link-local IPv6 (*::5efe)', 'https://[fe80::5efe:169.254.169.254]/', 403],
    ['ISATAP tunnel IPv6 (*::200:5efe)', 'https://[2001:470::200:5efe:127.0.0.1]/', 403],
    ['IPv4-mapped public IPv6 (::ffff:0:0/96)', 'https://[::ffff:1.1.1.1]/', 403],
    ['IPv4-compatible IPv6 (::/96)', 'https://[::1.1.1.1]/', 403],
    ['IPv4 multicast (224.0.0.0/4)', 'https://224.0.0.1/', 403],
    ['IPv4 reserved (240.0.0.0/4)', 'https://240.0.0.1/', 403],
    ['IPv6 site-local (fec0::/10)', 'https://[fec0::1]/', 403],
    ['IPv6 multicast (ff00::/8)', 'https://[ff02::1]/', 403],
    ['GCP metadata hostname', 'https://metadata.google.internal/computeMetadata/v1/', 403],
  ])('blocks unsafe SSRF target (%s) before contacting upstream', async (_label, targetUrl, expectedStatus) => {
    const fetchImpl = vi.fn();
    const { baseUrl } = await startProxy({ fetchImpl });

    const response = await fetch(`${baseUrl}/proxy`, {
      method: 'POST',
      headers: proxyHeaders(),
      body: JSON.stringify({ url: targetUrl, method: 'GET' }),
    });

    expect(response.status).toBe(expectedStatus);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['localhost loopback HTTP', 'http://localhost:11434/v1/models'],
    ['IPv4 loopback HTTP', 'http://127.0.0.1:11434/v1/models'],
    ['IPv6 loopback HTTP', 'http://[::1]:11434/v1/models'],
    ['public HTTPS domain', 'https://api.openai.com/v1/models'],
    ['public IPv6 HTTPS', 'https://[2606:4700:4700::1111]/v1/models'],
  ])('allows legitimate target (%s) through SSRF policy', async (_label, targetUrl) => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const { baseUrl } = await startProxy({ fetchImpl });

    const response = await fetch(`${baseUrl}/proxy`, {
      method: 'POST',
      headers: proxyHeaders(),
      body: JSON.stringify({ url: targetUrl, method: 'GET' }),
    });

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('enforces allowedTargetHosts allowlist when configured and supports OFFICIAL_PROVIDER_HOSTS', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const { baseUrl } = await startProxy({
      fetchImpl,
      allowedTargetHosts: OFFICIAL_PROVIDER_HOSTS,
    });

    const allowed = await fetch(`${baseUrl}/proxy`, {
      method: 'POST',
      headers: proxyHeaders(),
      body: JSON.stringify({
        url: 'https://workspace-1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/models',
        method: 'GET',
      }),
    });
    expect(allowed.status).toBe(200);

    const denied = await fetch(`${baseUrl}/proxy`, {
      method: 'POST',
      headers: proxyHeaders(),
      body: JSON.stringify({
        url: 'https://untrusted-relay.example/v1/models',
        method: 'GET',
      }),
    });
    expect(denied.status).toBe(403);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('decodes base64 upstream bodies and rejects invalid base64 or CRLF headers', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));
    const { baseUrl } = await startProxy({ fetchImpl });
    const binaryPayload = Buffer.from([1, 2, 3, 4]).toString('base64');

    const ok = await fetch(`${baseUrl}/proxy`, {
      method: 'POST',
      headers: proxyHeaders(),
      body: JSON.stringify({
        url: 'https://api.openai.com/v1/images/edits',
        method: 'POST',
        bodyEncoding: 'base64',
        body: binaryPayload,
      }),
    });
    expect(ok.status).toBe(200);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(Buffer.isBuffer(init.body)).toBe(true);
    expect(Array.from(init.body as Buffer)).toEqual([1, 2, 3, 4]);

    const badBase64 = await fetch(`${baseUrl}/proxy`, {
      method: 'POST',
      headers: proxyHeaders(),
      body: JSON.stringify({
        url: 'https://api.openai.com/v1/images/edits',
        method: 'POST',
        bodyEncoding: 'base64',
        body: '***not-base64***',
      }),
    });
    expect(badBase64.status).toBe(400);

    const badHeader = await fetch(`${baseUrl}/proxy`, {
      method: 'POST',
      headers: proxyHeaders(),
      body: JSON.stringify({
        url: 'https://api.openai.com/v1/models',
        method: 'GET',
        headers: { 'X-Inject': 'a\r\nb' },
      }),
    });
    expect(badHeader.status).toBe(400);
  });
});
