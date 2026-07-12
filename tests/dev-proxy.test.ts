import { request as httpRequest, type Server } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

// The production entry point intentionally remains an ESM JavaScript script so it can
// still be launched directly by `node scripts/dev-proxy.mjs`.
// @ts-ignore -- no declaration file is needed for this script-only module.
import { createOriginPolicy, createProxyServer } from '../scripts/dev-proxy.mjs';

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
});
