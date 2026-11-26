import { Platform } from 'react-native';
import {
  createAbortError,
  createAbortPromise,
  isAbortError,
  isBlockedPublicHost,
  isLoopbackHostname,
  resolveStreamAbortError,
} from './ssrfGuard';

export {
  createAbortError,
  createAbortPromise,
  isAbortError,
  isBlockedPublicHost,
  isLoopbackHostname,
  resolveStreamAbortError,
};

export const webDevProxyUrl = 'http://127.0.0.1:8787/proxy';
const defaultRequestTimeoutMs = 120_000;
const responseAbortCleanups = new WeakMap<Response, () => void>();
const responseRequestSignals = new WeakMap<Response, AbortSignal>();

export interface WebDevelopmentProxyRuntime {
  platform?: string;
  development?: boolean;
  explicitlyEnabled?: boolean;
  location?: {
    protocol: string;
    hostname: string;
  };
}

/** 提取 `response` 内部关联的请求信号（若有）。 */
export function getResponseRequestSignal(response: Response): AbortSignal | undefined {
  return responseRequestSignals.get(response);
}

/** 释放 `providerFetch` 为 `response` 注册的定时器与取消监听器。 */
export function cleanupResponseRequestAbort(response: Response): void {
  responseAbortCleanups.get(response)?.();
  responseAbortCleanups.delete(response);
  responseRequestSignals.delete(response);
}

/** 判断当前 Web 运行时是否处于显式开启的本机开发调试代理环境。 */
export function isWebDevelopmentProxyAllowed({
  platform = Platform.OS,
  development = typeof __DEV__ !== 'undefined' && __DEV__ === true,
  explicitlyEnabled = process.env.EXPO_PUBLIC_ENABLE_WEB_DEV_PROXY === '1',
  location = typeof window !== 'undefined'
    ? { protocol: window.location.protocol, hostname: window.location.hostname }
    : undefined,
}: WebDevelopmentProxyRuntime = {}): boolean {
  return Boolean(
    platform === 'web' &&
      development &&
      explicitlyEnabled &&
      location &&
      (location.protocol === 'http:' || location.protocol === 'https:') &&
      isLoopbackHostname(location.hostname)
  );
}

function headersToObject(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...(headers as Record<string, string>) };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function serializeWebProxyPayloadBody(
  rawBody: RequestInit['body'],
  outboundHeaders: Record<string, string>
): Promise<{ body?: string; bodyEncoding?: 'base64' }> {
  if (rawBody == null) {
    return {};
  }
  if (typeof rawBody === 'string') {
    return { body: rawBody };
  }
  if (typeof FormData !== 'undefined' && rawBody instanceof FormData) {
    const serialized = new Response(rawBody);
    const serializedContentType = serialized.headers.get('content-type');
    for (const existingKey of Object.keys(outboundHeaders)) {
      if (existingKey.toLowerCase() === 'content-type') {
        delete outboundHeaders[existingKey];
      }
    }
    if (serializedContentType) {
      outboundHeaders['Content-Type'] = serializedContentType;
    }
    return {
      body: arrayBufferToBase64(await serialized.arrayBuffer()),
      bodyEncoding: 'base64',
    };
  }
  if (typeof URLSearchParams !== 'undefined' && rawBody instanceof URLSearchParams) {
    const hasContentType = Object.keys(outboundHeaders).some(
      (key) => key.toLowerCase() === 'content-type'
    );
    if (!hasContentType) {
      outboundHeaders['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    }
    return { body: rawBody.toString() };
  }
  if (rawBody instanceof ArrayBuffer) {
    return {
      body: arrayBufferToBase64(rawBody),
      bodyEncoding: 'base64',
    };
  }
  if (ArrayBuffer.isView(rawBody)) {
    const view = new Uint8Array(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
    const copy = new Uint8Array(view.byteLength);
    copy.set(view);
    return {
      body: arrayBufferToBase64(copy.buffer),
      bodyEncoding: 'base64',
    };
  }
  if (typeof Blob !== 'undefined' && rawBody instanceof Blob) {
    const hasContentType = Object.keys(outboundHeaders).some(
      (key) => key.toLowerCase() === 'content-type'
    );
    if (rawBody.type && !hasContentType) {
      outboundHeaders['Content-Type'] = rawBody.type;
    }
    return {
      body: arrayBufferToBase64(await rawBody.arrayBuffer()),
      bodyEncoding: 'base64',
    };
  }
  throw new Error(
    'Web 调试代理不支持该请求体类型；仅支持 string、FormData、URLSearchParams、Blob 或二进制缓冲区。'
  );
}

/**
 * 通过指定 `rawFetch` 执行受限网络传输：
 * - Native 环境直接发往目标 URL；
 * - 正式 Web 构建未启用受控本机调试代理时强制 fail-closed 拦截；
 * - 本机开发 Web 代理启用时单层包装为代理 JSON 信封发往 `127.0.0.1:8787/proxy`。
 */
export async function transportFetch(
  url: string,
  init: RequestInit,
  rawFetch: typeof fetch = fetch
): Promise<Response> {
  if (init.signal?.aborted) {
    throw createAbortError();
  }
  if (Platform.OS !== 'web') {
    return rawFetch(url, init);
  }
  if (!isWebDevelopmentProxyAllowed()) {
    throw new Error(
      '正式 Web 构建不会发送 API Key 或模型请求。仅可在本机通过 npm run web 显式启动受限调试代理。'
    );
  }

  const outboundHeaders = headersToObject(init.headers);
  const serializedBody = await serializeWebProxyPayloadBody(init.body, outboundHeaders);

  try {
    return await rawFetch(webDevProxyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        method: init.method ?? 'GET',
        headers: outboundHeaders,
        ...serializedBody,
      }),
      signal: init.signal,
    });
  } catch (error) {
    if (isAbortError(error) || init.signal?.aborted) {
      throw error;
    }
    throw new Error('Web 调试代理未启动或不可访问。请用 npm run web 启动应用，或确认 127.0.0.1:8787 可访问。');
  }
}

/** 带默认超时保护的内部传输封装。 */
export async function providerFetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = defaultRequestTimeoutMs
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(init.signal?.reason ?? createAbortError());
  if (init.signal?.aborted) {
    throw createAbortError();
  }
  init.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(createAbortError('请求超时。'));
  }, timeoutMs);
  const cleanup = () => {
    clearTimeout(timeout);
    init.signal?.removeEventListener('abort', abortFromCaller);
  };

  try {
    const response = await transportFetch(url, {
      ...init,
      signal: controller.signal,
    });
    responseAbortCleanups.set(response, cleanup);
    responseRequestSignals.set(response, controller.signal);
    return response;
  } catch (error) {
    cleanup();
    if (timedOut) {
      const timeoutError = createAbortError(`请求超过 ${Math.round(timeoutMs / 1000)} 秒，已自动停止。`);
      timeoutError.name = 'TimeoutError';
      throw timeoutError;
    }
    if (init.signal?.aborted) {
      throw createAbortError();
    }
    throw error;
  }
}

/**
 * 全应用共享的安全 API 传输入口：
 * Native 直连、Web 调试走受控本地代理、正式 Web 构建严格 fail-closed。
 */
export const guardedApiFetch: typeof fetch = async (input, init) => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url;
  const requestInit = init ?? {};
  // 外部调用方已自带 signal 时直接走无额外计时器的 transportFetch，避免覆盖长超时或定时器泄漏
  if (requestInit.signal) {
    return transportFetch(url, requestInit);
  }
  const response = await providerFetchWithTimeout(url, requestInit);
  cleanupResponseRequestAbort(response);
  return response;
};
