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
export const OFFICIAL_PROVIDER_HOSTS = Object.freeze([
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'api.x.ai',
  'api.deepseek.com',
  'ark.cn-beijing.volces.com',
  'ark.cn-beijing.volcengineapi.com',
  'dashscope.aliyuncs.com',
  'dashscope-intl.aliyuncs.com',
  'dashscope-us.aliyuncs.com',
  '*.maas.aliyuncs.com',
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

function normalizeTargetHostname(hostname) {
  return String(hostname)
    .trim()
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.+$/, '');
}

function isLoopbackHostname(hostname) {
  const normalized = normalizeTargetHostname(hostname);
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function parseIpv4Octets(value) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
    return null;
  }
  const octets = value.split('.').map(Number);
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return octets;
}

function parseIpv6SegmentList(segmentText, allowTrailingIpv4) {
  if (!segmentText) {
    return [];
  }
  const parts = segmentText.split(':');
  const groups = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part) {
      return null;
    }
    if (allowTrailingIpv4 && index === parts.length - 1 && part.includes('.')) {
      const octets = parseIpv4Octets(part);
      if (!octets) {
        return null;
      }
      groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/i.test(part)) {
      return null;
    }
    groups.push(Number.parseInt(part, 16));
  }
  return groups;
}

function parseIpv6Groups(value) {
  if (!value || !value.includes(':') || value.includes('%')) {
    return null;
  }
  const compressionParts = value.split('::');
  if (compressionParts.length > 2) {
    return null;
  }
  if (compressionParts.length === 1) {
    const groups = parseIpv6SegmentList(compressionParts[0], true);
    return groups && groups.length === 8 ? groups : null;
  }

  const [headText, tailText] = compressionParts;
  const headGroups = parseIpv6SegmentList(headText, !tailText);
  const tailGroups = parseIpv6SegmentList(tailText, true);
  if (!headGroups || !tailGroups) {
    return null;
  }
  const missingCount = 8 - (headGroups.length + tailGroups.length);
  if (missingCount < 1) {
    return null;
  }
  return [...headGroups, ...new Array(missingCount).fill(0), ...tailGroups];
}

function isBlockedIpv4Octets(octets, { allowExactLoopback = false } = {}) {
  const [a, b, c, d] = octets;
  if (a === 0) {
    // 0.0.0.0/8 未指定网络
    return true;
  }
  if (a === 169 && b === 254) {
    // 169.254.0.0/16 链路本地与云元数据 (IMDS)
    return true;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    // 100.64.0.0/10 CGNAT / 阿里云 ECS 元数据 (100.100.100.200)
    return true;
  }
  if (a === 127) {
    // 仅放行显式 127.0.0.1；阻止 IPv6 映射/隧道封装伪装回环及 127.0.0.0/8 其他地址
    return !(allowExactLoopback && b === 0 && c === 0 && d === 1);
  }
  if (a >= 224) {
    // 224.0.0.0/4 组播与 240.0.0.0/4 保留地址
    return true;
  }
  return false;
}

function isBlockedIpv6Groups(groups, { allowExactLoopback = true } = {}) {
  const isAllZero = groups.every((group) => group === 0);
  if (isAllZero) {
    // ::/128 未指定地址
    return true;
  }
  const isLoopback = groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
  if (isLoopback) {
    // 仅在显式直接目标为 [::1] 时允许作为本机 IPv6 调试回环
    return !allowExactLoopback;
  }

  const first = groups[0];
  const second = groups[1];
  const third = groups[2];
  if ((first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0) {
    // fe80::/10 链路本地与 fec0::/10 站点本地
    return true;
  }
  if ((first & 0xfe00) === 0xfc00) {
    // fc00::/7 ULA 唯一本地地址（含 AWS IPv6 IMDS fd00:ec2::254）
    return true;
  }
  if ((first & 0xff00) === 0xff00) {
    // ff00::/8 组播地址
    return true;
  }

  // 严格拦截全部 IPv4-兼容(::/96)、IPv4-映射(::ffff:0:0/96)、IPv4-转换、NAT64(64:ff9b::/96 & 64:ff9b:1::/48)
  const isIpv4Compatible = groups.slice(0, 6).every((group) => group === 0);
  const isIpv4Mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  const isIpv4Translated =
    groups.slice(0, 4).every((group) => group === 0) && groups[4] === 0xffff && groups[5] === 0;
  const isNat64WellKnown =
    first === 0x0064 && second === 0xff9b && groups.slice(2, 6).every((group) => group === 0);
  const isNat64LocalUse = first === 0x0064 && second === 0xff9b && third === 0x0001;

  if (isIpv4Compatible || isIpv4Mapped || isIpv4Translated || isNat64WellKnown || isNat64LocalUse) {
    return true;
  }

  // 严格拦截 Teredo (2001::/32)、6to4 (2002::/16) 与 ISATAP (*::5efe:<ipv4>)
  const isTeredo = first === 0x2001 && second === 0x0000;
  const is6to4 = first === 0x2002;
  const isIsatap = (groups[4] & 0xfcff) === 0x0000 && groups[5] === 0x5efe;
  if (isTeredo || is6to4 || isIsatap) {
    return true;
  }

  return false;
}

function isBlockedMetadataOrLinkLocalHost(hostname) {
  const normalized = normalizeTargetHostname(hostname);
  if (!normalized) {
    return true;
  }
  if (
    normalized === 'metadata.google.internal' ||
    normalized === 'metadata' ||
    normalized.endsWith('.internal')
  ) {
    return true;
  }

  const ipv4Octets = parseIpv4Octets(normalized);
  if (ipv4Octets) {
    return isBlockedIpv4Octets(ipv4Octets, { allowExactLoopback: true });
  }

  if (normalized.includes(':')) {
    const ipv6Groups = parseIpv6Groups(normalized);
    if (!ipv6Groups) {
      return true;
    }
    return isBlockedIpv6Groups(ipv6Groups);
  }

  return false;
}

function parseAllowedTargetHosts(value) {
  if (value == null || value === '') {
    return null;
  }
  const entries = Array.isArray(value) ? value : String(value).split(',');
  const patterns = entries
    .map((entry) => normalizeTargetHostname(entry))
    .filter(Boolean);
  return patterns.length ? patterns : null;
}

function isTargetHostAllowed(hostname, allowedTargetHosts) {
  if (!allowedTargetHosts || !allowedTargetHosts.length) {
    return true;
  }
  const normalized = normalizeTargetHostname(hostname);
  return allowedTargetHosts.some((pattern) => {
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1);
      return normalized.length > suffix.length && normalized.endsWith(suffix);
    }
    return normalized === pattern;
  });
}

const blockedResponseHeaders = new Set([
  'set-cookie',
  'set-cookie2',
  'transfer-encoding',
  'content-length',
  'content-encoding',
  'connection',
  'keep-alive',
]);

function isSafeForwardedResponseHeader(lowerName) {
  if (blockedResponseHeaders.has(lowerName)) {
    return false;
  }
  return (
    lowerName === 'x-request-id' ||
    lowerName === 'request-id' ||
    lowerName === 'retry-after' ||
    lowerName.startsWith('x-ratelimit-') ||
    lowerName.startsWith('anthropic-ratelimit-') ||
    lowerName.startsWith('openai-') ||
    lowerName.startsWith('x-goog-') ||
    lowerName.startsWith('x-grok-')
  );
}

function extractForwardedResponseHeaders(upstreamHeaders) {
  const forwarded = {};
  if (!upstreamHeaders || typeof upstreamHeaders.forEach !== 'function') {
    return { headers: forwarded, exposed: [] };
  }
  upstreamHeaders.forEach((value, key) => {
    const lowerKey = String(key).toLowerCase();
    if (!isSafeForwardedResponseHeader(lowerKey)) {
      return;
    }
    if (typeof value !== 'string' || /[\r\n\0]/.test(value)) {
      return;
    }
    forwarded[lowerKey] = value;
  });
  return {
    headers: forwarded,
    exposed: Object.keys(forwarded),
  };
}

function decodeUpstreamBody(rawBody, bodyEncoding, maxBodyBytes) {
  if (bodyEncoding == null || bodyEncoding === 'utf8') {
    if (Buffer.byteLength(rawBody) > maxBodyBytes) {
      throw new ProxyHttpError(413, `Upstream body exceeds ${maxBodyBytes} bytes.`);
    }
    return rawBody;
  }
  if (bodyEncoding === 'base64') {
    const compact = rawBody.replace(/\s+/g, '');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
      throw new ProxyHttpError(400, 'Invalid base64 upstream body.');
    }
    const decoded = Buffer.from(compact, 'base64');
    if (decoded.byteLength > maxBodyBytes) {
      throw new ProxyHttpError(413, `Upstream body exceeds ${maxBodyBytes} bytes.`);
    }
    return decoded;
  }
  throw new ProxyHttpError(400, 'Unsupported bodyEncoding; expected utf8 or base64.');
}

function parseProxyPayload(rawBody, maxBodyBytes, allowedTargetHosts = null) {
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
  if (isBlockedMetadataOrLinkLocalHost(parsedUrl.hostname)) {
    throw new ProxyHttpError(403, 'Target host is blocked by proxy SSRF policy.');
  }
  if (parsedUrl.protocol === 'http:' && !isLoopbackHostname(parsedUrl.hostname)) {
    throw new ProxyHttpError(400, 'Plaintext http targets are only allowed for loopback hosts.');
  }
  if (!isTargetHostAllowed(parsedUrl.hostname, allowedTargetHosts)) {
    throw new ProxyHttpError(403, 'Target host is not in the allowed target hosts list.');
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

  const body = payload.body == null
    ? undefined
    : decodeUpstreamBody(payload.body, payload.bodyEncoding, maxBodyBytes);

  return {
    targetUrl: parsedUrl,
    method,
    headers: cleanUpstreamHeaders(payload.headers),
    body,
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
    payload = parseProxyPayload(rawBody, options.maxBodyBytes, options.allowedTargetHosts);
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
      // Never forward provider credentials across an upstream redirect. This
      // is a proxy-owned invariant, not a client-selectable payload option.
      redirect: 'error',
    });

    if (!canWrite(response)) {
      controller.abort(new Error('Downstream connection closed.'));
      return;
    }

    const forwarded = extractForwardedResponseHeaders(upstream.headers);
    const exposedHeaders = Array.from(
      new Set(['x-request-id', 'request-id', 'retry-after', ...forwarded.exposed])
    ).join(', ');

    response.writeHead(upstream.status, {
      ...corsHeaders(options.origin),
      ...forwarded.headers,
      'Access-Control-Expose-Headers': exposedHeaders,
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
  allowedTargetHosts = process.env.WEB_PROXY_ALLOWED_HOSTS ?? '',
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
  const parsedAllowedTargetHosts = parseAllowedTargetHosts(allowedTargetHosts);
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
      allowedTargetHosts: parsedAllowedTargetHosts,
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
