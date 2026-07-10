import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PROXY_PORT = 8787;
export const DEFAULT_MAX_BODY_BYTES = 20 * 1024 * 1024;
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 120_000;
export const DEFAULT_WEB_ORIGINS = Object.freeze([
  'http://localhost:8081',
  'http://127.0.0.1:8081',
]);

const blockedUpstreamHeaders = new Set([
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'cf-connecting-ip',
  'client-ip',
  'connection',
  'constructor',
  'content-length',
  'cookie',
  'cookie2',
  'expect',
  'forwarded',
  'host',
  'keep-alive',
  'origin',
  'proxy-authenticate',
  'proxy-authorization',
  'prototype',
  'referer',
  'te',
  'trailer',
  'transfer-encoding',
  'true-client-ip',
  'upgrade',
  'via',
  'x-http-method',
  'x-http-method-override',
  'x-method-override',
  'x-original-url',
  'x-real-ip',
  'x-rewrite-url',
  '__proto__',
]);

class ProxyHttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'ProxyHttpError';
    this.statusCode = statusCode;
  }
}

function positiveInteger(value, fallback, label) {
  if (value == null || value === '') {
    return fallback;
  }

  const parsed = typeof value === 'number' ? value : Number(String(value));
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function appendVary(headers, value) {
  const current = headers.Vary;
  if (!current) {
    headers.Vary = value;
    return;
  }

  const values = current.split(',').map((item) => item.trim().toLowerCase());
  if (!values.includes(value.toLowerCase())) {
    headers.Vary = `${current}, ${value}`;
  }
}

function corsHeaders(origin) {
  const headers = {};
  appendVary(headers, 'Origin');
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function canWrite(response) {
  return !response.destroyed && !response.writableEnded;
}

function sendJson(response, statusCode, payload, origin, extraHeaders = {}) {
  if (!canWrite(response)) {
    return;
  }

  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    ...corsHeaders(origin),
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  response.end(body);
}

function sendCorsPreflight(response, origin) {
  response.writeHead(204, {
    ...corsHeaders(origin),
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '600',
  });
  response.end();
}

function canonicalConfiguredOrigin(value) {
  const candidate = value.trim();
  if (!candidate || candidate === '*') {
    throw new Error('WEB_PROXY_ALLOWED_ORIGINS must contain explicit http(s) origins, not wildcards.');
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`Invalid allowed origin: ${candidate}`);
  }

  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== '/' && parsed.pathname !== '') ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`Allowed origin must be an http(s) origin without a path: ${candidate}`);
  }

  return parsed.origin;
}

function parseConfiguredOrigins(value) {
  if (value == null || value === '') {
    return new Set();
  }

  const entries = Array.isArray(value) ? value : String(value).split(',');
  return new Set(entries.filter((entry) => String(entry).trim()).map((entry) => canonicalConfiguredOrigin(String(entry))));
}

function parseRequestOrigin(value) {
  if (typeof value !== 'string' || !value || value === 'null' || value.includes(',')) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.origin !== value
  ) {
    return null;
  }

  return parsed;
}

export function createOriginPolicy(additionalOrigins = '') {
  const configuredOrigins = new Set([
    ...DEFAULT_WEB_ORIGINS,
    ...parseConfiguredOrigins(additionalOrigins),
  ]);

  return {
    resolve(originHeader) {
      const parsed = parseRequestOrigin(originHeader);
      if (!parsed) {
        return null;
      }

      return configuredOrigins.has(parsed.origin) ? parsed.origin : null;
    },
  };
}

function contentLength(request) {
  const value = request.headers['content-length'];
  if (value == null) {
    return null;
  }
  if (Array.isArray(value) || !/^\d+$/.test(value)) {
    throw new ProxyHttpError(400, 'Invalid Content-Length header.');
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ProxyHttpError(400, 'Invalid Content-Length header.');
  }
  return parsed;
}

function readBody(request, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    let declaredLength;
    try {
      declaredLength = contentLength(request);
    } catch (error) {
      request.resume();
      reject(error);
      return;
    }

    if (declaredLength != null && declaredLength > maxBodyBytes) {
      request.resume();
      reject(new ProxyHttpError(413, `Proxy request body exceeds ${maxBodyBytes} bytes.`));
      return;
    }

    const chunks = [];
    let total = 0;
    let settled = false;

    const cleanup = () => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onAborted);
    };
    const finish = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };
    const onData = (chunk) => {
      total += chunk.length;
      if (total > maxBodyBytes) {
        finish(() => reject(new ProxyHttpError(413, `Proxy request body exceeds ${maxBodyBytes} bytes.`)));
        request.resume();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish(() => resolve(Buffer.concat(chunks).toString('utf8')));
    const onError = (error) => finish(() => reject(error));
    const onAborted = () => finish(() => reject(new ProxyHttpError(499, 'Client closed the request.')));

    request.on('data', onData);
    request.on('end', onEnd);
    request.on('error', onError);
    request.on('aborted', onAborted);
  });
}

function isBlockedUpstreamHeader(name, connectionTokens) {
  return (
    blockedUpstreamHeaders.has(name) ||
    connectionTokens.has(name) ||
    name.startsWith('access-control-') ||
    name.startsWith('proxy-') ||
    name.startsWith('sec-') ||
    name.startsWith('x-forwarded-')
  );
}

export function cleanUpstreamHeaders(headers) {
  if (headers == null) {
    return {};
  }
  if (typeof headers !== 'object' || Array.isArray(headers)) {
    throw new ProxyHttpError(400, 'Proxy headers must be an object of string values.');
  }

  const entries = Object.entries(headers);
  const connectionTokens = new Set();
  for (const [key, value] of entries) {
    if (key.toLowerCase() === 'connection' && typeof value === 'string') {
      for (const token of value.split(',')) {
        if (token.trim()) {
          connectionTokens.add(token.trim().toLowerCase());
        }
      }
    }
  }

  const result = {};
  for (const [key, value] of entries) {
    const lowerKey = key.toLowerCase();
    if (isBlockedUpstreamHeader(lowerKey, connectionTokens)) {
      continue;
    }
    if (typeof value !== 'string') {
      throw new ProxyHttpError(400, `Proxy header ${key} must be a string.`);
    }
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(key) || /[\r\n]/.test(value)) {
      throw new ProxyHttpError(400, `Invalid proxy header: ${key}`);
    }
    result[lowerKey] = value;
  }
  return result;
}

function parseProxyPayload(rawBody, maxBodyBytes) {
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new ProxyHttpError(400, 'Invalid JSON body.');
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ProxyHttpError(400, 'Proxy body must be a JSON object.');
  }

  const targetUrl = typeof payload.url === 'string' ? payload.url : '';
  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    throw new ProxyHttpError(400, 'Invalid target URL.');
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new ProxyHttpError(400, 'Only http and https targets are allowed.');
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new ProxyHttpError(400, 'Target URL credentials are not allowed; use an Authorization header instead.');
  }

  const method = typeof payload.method === 'string' ? payload.method.trim().toUpperCase() : 'GET';
  if (!['GET', 'POST'].includes(method)) {
    throw new ProxyHttpError(400, 'Upstream method must be GET or POST.');
  }
  if (payload.body != null && typeof payload.body !== 'string') {
    throw new ProxyHttpError(400, 'Upstream body must be a string.');
  }
  if (method === 'GET' && payload.body != null) {
    throw new ProxyHttpError(400, 'GET upstream requests cannot include a body.');
  }
  if (typeof payload.body === 'string' && Buffer.byteLength(payload.body) > maxBodyBytes) {
    throw new ProxyHttpError(413, `Upstream body exceeds ${maxBodyBytes} bytes.`);
  }

  return {
    targetUrl: parsedUrl,
    method,
    headers: cleanUpstreamHeaders(payload.headers),
    body: payload.body == null ? undefined : payload.body,
  };
}

function waitForDrain(response, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('Upstream request aborted.'));
      return;
    }
    if (!canWrite(response)) {
      reject(new Error('Downstream connection closed.'));
      return;
    }

    const cleanup = () => {
      response.off('drain', onDrain);
      response.off('close', onClose);
      response.off('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const settle = (callback) => {
      cleanup();
      callback();
    };
    const onDrain = () => settle(resolve);
    const onClose = () => settle(() => reject(new Error('Downstream connection closed.')));
    const onError = (error) => settle(() => reject(error));
    const onAbort = () => settle(() => reject(signal.reason ?? new Error('Upstream request aborted.')));

    response.once('drain', onDrain);
    response.once('close', onClose);
    response.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function readUpstreamChunk(reader, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('Upstream request aborted.'));
      return;
    }

    const onAbort = () => {
      reject(signal.reason ?? new Error('Upstream request aborted.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

async function pipeUpstreamBody(upstream, response, signal) {
  if (!upstream.body) {
    const body = await upstream.arrayBuffer();
    if (canWrite(response)) {
      response.end(Buffer.from(body));
    }
    return;
  }

  const reader = upstream.body.getReader();
  let completed = false;
  try {
    while (true) {
      if (signal.aborted) {
        throw signal.reason ?? new Error('Upstream request aborted.');
      }
      if (!canWrite(response)) {
        throw new Error('Downstream connection closed.');
      }

      const { value, done } = await readUpstreamChunk(reader, signal);
      if (done) {
        completed = true;
        break;
      }
      if (value && !response.write(Buffer.from(value))) {
        await waitForDrain(response, signal);
      }
    }

    if (canWrite(response)) {
      response.end();
    }
  } finally {
    if (!completed) {
      void reader.cancel(signal.reason).catch(() => {});
    }
  }
}

function validatePreflight(request) {
  const requestedMethod = request.headers['access-control-request-method'];
  if (requestedMethod && String(requestedMethod).toUpperCase() !== 'POST') {
    throw new ProxyHttpError(405, 'CORS preflight only allows POST.');
  }

  const requestedHeaders = request.headers['access-control-request-headers'];
  if (requestedHeaders) {
    const headers = String(requestedHeaders)
      .split(',')
      .map((header) => header.trim().toLowerCase())
      .filter(Boolean);
    if (headers.some((header) => header !== 'content-type')) {
      throw new ProxyHttpError(400, 'CORS preflight only allows the Content-Type request header.');
    }
  }
}

function isJsonRequest(request) {
  const contentType = request.headers['content-type'];
  return typeof contentType === 'string' && /^application\/json(?:\s*;|$)/i.test(contentType);
}

async function handleProxy(request, response, options) {
  let payload;
  try {
    const rawBody = await readBody(request, options.maxBodyBytes);
    payload = parseProxyPayload(rawBody, options.maxBodyBytes);
  } catch (error) {
    const statusCode = error instanceof ProxyHttpError ? error.statusCode : 400;
    if (statusCode !== 499) {
      sendJson(response, statusCode, {
        error: error instanceof Error ? error.message : 'Invalid proxy request.',
      }, options.origin);
    }
    return;
  }

  if (!canWrite(response)) {
    return;
  }

  const controller = new AbortController();
  let downstreamClosed = false;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Upstream request timed out after ${options.upstreamTimeoutMs} ms.`));
  }, options.upstreamTimeoutMs);
  timeout.unref?.();

  const onDownstreamClose = () => {
    if (!response.writableEnded) {
      downstreamClosed = true;
      controller.abort(new Error('Downstream connection closed.'));
    }
  };
  const onRequestAborted = () => {
    downstreamClosed = true;
    controller.abort(new Error('Downstream request aborted.'));
  };
  response.once('close', onDownstreamClose);
  request.once('aborted', onRequestAborted);

  try {
    const upstream = await options.fetchImpl(payload.targetUrl, {
      method: payload.method,
      headers: payload.headers,
      body: payload.body,
      signal: controller.signal,
    });

    if (!canWrite(response)) {
      controller.abort(new Error('Downstream connection closed.'));
      return;
    }

    response.writeHead(upstream.status, {
      ...corsHeaders(options.origin),
      'Cache-Control': 'no-cache, no-transform',
      'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      'X-Accel-Buffering': 'no',
    });
    await pipeUpstreamBody(upstream, response, controller.signal);
  } catch (error) {
    if (downstreamClosed || !canWrite(response)) {
      return;
    }
    if (response.headersSent) {
      response.destroy();
      return;
    }

    sendJson(
      response,
      timedOut ? 504 : 502,
      {
        error: timedOut
          ? `Upstream request timed out after ${options.upstreamTimeoutMs} ms.`
          : error instanceof Error
            ? error.message
            : 'Proxy upstream request failed.',
      },
      options.origin
    );
  } finally {
    clearTimeout(timeout);
    response.off('close', onDownstreamClose);
    request.off('aborted', onRequestAborted);
  }
}

export function createProxyServer({
  fetchImpl = globalThis.fetch,
  allowedOrigins = process.env.WEB_PROXY_ALLOWED_ORIGINS ?? '',
  maxBodyBytes = positiveInteger(
    process.env.WEB_PROXY_MAX_BODY_BYTES,
    DEFAULT_MAX_BODY_BYTES,
    'WEB_PROXY_MAX_BODY_BYTES'
  ),
  upstreamTimeoutMs = positiveInteger(
    process.env.WEB_PROXY_UPSTREAM_TIMEOUT_MS,
    DEFAULT_UPSTREAM_TIMEOUT_MS,
    'WEB_PROXY_UPSTREAM_TIMEOUT_MS'
  ),
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required.');
  }

  const originPolicy = createOriginPolicy(allowedOrigins);
  const resolvedMaxBodyBytes = positiveInteger(maxBodyBytes, DEFAULT_MAX_BODY_BYTES, 'maxBodyBytes');
  const resolvedUpstreamTimeoutMs = positiveInteger(
    upstreamTimeoutMs,
    DEFAULT_UPSTREAM_TIMEOUT_MS,
    'upstreamTimeoutMs'
  );

  return http.createServer((request, response) => {
    const origin = originPolicy.resolve(request.headers.origin);
    if (!origin) {
      sendJson(response, 403, { error: 'Origin is not allowed.' }, null);
      request.resume();
      return;
    }

    if (request.url !== '/proxy') {
      sendJson(response, 404, { error: 'Not found.' }, origin);
      request.resume();
      return;
    }

    if (request.method === 'OPTIONS') {
      try {
        validatePreflight(request);
        sendCorsPreflight(response, origin);
      } catch (error) {
        const statusCode = error instanceof ProxyHttpError ? error.statusCode : 400;
        sendJson(response, statusCode, {
          error: error instanceof Error ? error.message : 'Invalid CORS preflight.',
        }, origin, statusCode === 405 ? { Allow: 'POST, OPTIONS' } : {});
      }
      return;
    }

    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'Method not allowed.' }, origin, { Allow: 'POST, OPTIONS' });
      request.resume();
      return;
    }

    if (!isJsonRequest(request)) {
      sendJson(response, 415, { error: 'Content-Type must be application/json.' }, origin);
      request.resume();
      return;
    }

    void handleProxy(request, response, {
      fetchImpl,
      maxBodyBytes: resolvedMaxBodyBytes,
      upstreamTimeoutMs: resolvedUpstreamTimeoutMs,
      origin,
    }).catch((error) => {
      if (!response.headersSent) {
        sendJson(response, 500, {
          error: error instanceof Error ? error.message : 'Unexpected proxy failure.',
        }, origin);
      } else if (canWrite(response)) {
        response.destroy();
      }
    });
  });
}

export function startProxyServer({
  port = positiveInteger(process.env.WEB_PROXY_PORT, DEFAULT_PROXY_PORT, 'WEB_PROXY_PORT'),
  host = '127.0.0.1',
  logger = console,
  ...serverOptions
} = {}) {
  const server = createProxyServer(serverOptions);
  server.listen(port, host, () => {
    const address = server.address();
    const listeningPort = typeof address === 'object' && address ? address.port : port;
    logger.log(`Embezzle Studio dev proxy listening on http://${host}:${listeningPort}`);
  });
  return server;
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = path.resolve(fileURLToPath(import.meta.url));
const isDirectRun = Boolean(
  entryPath &&
    (process.platform === 'win32'
      ? entryPath.toLowerCase() === modulePath.toLowerCase()
      : entryPath === modulePath)
);

if (isDirectRun) {
  startProxyServer();
}
