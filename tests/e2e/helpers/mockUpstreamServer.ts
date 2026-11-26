import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/**
 * 解析后的 Multipart 表单分段（二进制安全，支持文件与文本字段）。
 */
export interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  headers: Record<string, string>;
  data: Buffer;
  text: string;
}

/**
 * Mock 上游服务器记录到的每笔完整请求审计信息。
 */
export interface RecordedUpstreamRequest {
  id: number;
  method: string;
  url: string;
  pathname: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string>;
  rawBody: Buffer;
  bodyText: string;
  jsonBody?: unknown;
  multipartParts?: MultipartPart[];
  receivedAt: number;
}

/**
 * 单个 SSE Chunk 的构造描述。
 */
export type SseChunkSpec =
  | string
  | { raw: string; delayMs?: number }
  | { event?: string; data: unknown | string; delayMs?: number };

/**
 * Mock 响应动作描述，支持 JSON、纯文本、错误故障注入与可控 SSE 流式输出。
 */
export type MockResponseAction =
  | {
      kind: 'json';
      status?: number;
      headers?: Record<string, string>;
      body: unknown;
      delayMs?: number;
    }
  | {
      kind: 'text';
      status?: number;
      headers?: Record<string, string>;
      body: string;
      delayMs?: number;
    }
  | {
      kind: 'error';
      status: number;
      body: unknown | string;
      headers?: Record<string, string>;
      delayMs?: number;
    }
  | {
      kind: 'sse';
      status?: number;
      headers?: Record<string, string>;
      chunks: SseChunkSpec[];
      chunkDelayMs?: number;
      /** 发送完该索引（从 0 开始）的 chunk 后立即中断连接 */
      abortAfterChunkIndex?: number;
      abortMode?: 'destroy-socket' | 'premature-end';
    };

export type MockRouteMatcher =
  | {
      method?: string;
      pathname?: string | RegExp | ((pathname: string, req: RecordedUpstreamRequest) => boolean);
    }
  | ((req: RecordedUpstreamRequest) => boolean);

export type MockRouteHandler =
  | MockResponseAction
  | ((req: RecordedUpstreamRequest) => MockResponseAction | Promise<MockResponseAction>);

export interface MockRequestFilter {
  method?: string;
  pathname?: string | RegExp;
}

interface RouteEntry {
  matcher: MockRouteMatcher;
  handler: MockRouteHandler;
  once: boolean;
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeHeaders(rawHeaders: http.IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (value === undefined) continue;
    const lowerKey = key.toLowerCase();
    result[lowerKey] = Array.isArray(value) ? value.join(', ') : value;
  }
  return result;
}

function parseQuery(searchParams: URLSearchParams): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const key of new Set(searchParams.keys())) {
    const values = searchParams.getAll(key);
    result[key] = values.length <= 1 ? (values[0] ?? '') : values;
  }
  return result;
}

/**
 * 在 Buffer 上基于 boundary 二进制安全解析 multipart/form-data。
 */
function parseMultipartBuffer(body: Buffer, contentTypeHeader: string): MultipartPart[] | undefined {
  if (!/multipart\/form-data/i.test(contentTypeHeader)) {
    return undefined;
  }
  // 独立提取 boundary，兼容前置参数（如 `multipart/form-data; charset=utf-8; boundary=...`）
  const match = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentTypeHeader);
  if (!match) {
    return undefined;
  }
  const boundary = match[1] ?? match[2];
  if (!boundary) {
    return undefined;
  }

  const boundaryMarker = Buffer.from(`--${boundary}`, 'latin1');
  const parts: MultipartPart[] = [];
  let searchPos = body.indexOf(boundaryMarker);

  while (searchPos !== -1) {
    const afterBoundary = searchPos + boundaryMarker.length;
    // 检查是否为结束标记 "--boundary--"
    if (
      body[afterBoundary] === 0x2d &&
      body[afterBoundary + 1] === 0x2d
    ) {
      break;
    }

    // 跳过 boundary 后的 \r\n（兼容 \n）
    let partStart = afterBoundary;
    if (body[partStart] === 0x0d && body[partStart + 1] === 0x0a) {
      partStart += 2;
    } else if (body[partStart] === 0x0a) {
      partStart += 1;
    } else {
      searchPos = body.indexOf(boundaryMarker, afterBoundary);
      continue;
    }

    const nextBoundaryPos = body.indexOf(boundaryMarker, partStart);
    if (nextBoundaryPos === -1) {
      break;
    }

    // 去除紧邻下一个 boundary 前的 CRLF/LF
    let partEnd = nextBoundaryPos;
    if (partEnd >= 2 && body[partEnd - 2] === 0x0d && body[partEnd - 1] === 0x0a) {
      partEnd -= 2;
    } else if (partEnd >= 1 && body[partEnd - 1] === 0x0a) {
      partEnd -= 1;
    }

    const partSlice = body.subarray(partStart, partEnd);
    let headerSepOffset = partSlice.indexOf('\r\n\r\n');
    let sepLength = 4;
    if (headerSepOffset === -1) {
      headerSepOffset = partSlice.indexOf('\n\n');
      sepLength = 2;
    }

    if (headerSepOffset !== -1) {
      const rawHeaderText = partSlice.subarray(0, headerSepOffset).toString('utf8');
      const dataBuffer = Buffer.from(partSlice.subarray(headerSepOffset + sepLength));
      const headers: Record<string, string> = {};

      for (const line of rawHeaderText.split(/\r?\n/)) {
        const colonIdx = line.indexOf(':');
        if (colonIdx <= 0) continue;
        const hKey = line.slice(0, colonIdx).trim().toLowerCase();
        const hVal = line.slice(colonIdx + 1).trim();
        headers[hKey] = hVal;
      }

      const disposition = headers['content-disposition'] ?? '';
      const nameMatch = /;\s*name=(?:"([^"]*)"|([^;\s]+))/i.exec(disposition);
      const filenameMatch = /;\s*filename=(?:"([^"]*)"|([^;\s]+))/i.exec(disposition);
      const partName = nameMatch?.[1] ?? nameMatch?.[2] ?? '';
      const partFilename = filenameMatch?.[1] ?? filenameMatch?.[2];

      parts.push({
        name: partName,
        ...(partFilename !== undefined ? { filename: partFilename } : {}),
        ...(headers['content-type'] ? { contentType: headers['content-type'] } : {}),
        headers,
        data: dataBuffer,
        text: dataBuffer.toString('utf8'),
      });
    }

    searchPos = nextBoundaryPos;
  }

  return parts;
}

function matchesRoute(matcher: MockRouteMatcher, req: RecordedUpstreamRequest): boolean {
  if (typeof matcher === 'function') {
    return matcher(req);
  }
  if (matcher.method && matcher.method.toUpperCase() !== req.method.toUpperCase()) {
    return false;
  }
  if (matcher.pathname !== undefined) {
    if (typeof matcher.pathname === 'string') {
      return req.pathname === matcher.pathname;
    }
    if (matcher.pathname instanceof RegExp) {
      return matcher.pathname.test(req.pathname);
    }
    return matcher.pathname(req.pathname, req);
  }
  return true;
}

function serializeSseChunk(spec: SseChunkSpec): { payload: string; delayMs?: number } {
  if (typeof spec === 'string') {
    return { payload: spec };
  }
  if ('raw' in spec) {
    return { payload: spec.raw, delayMs: spec.delayMs };
  }
  const serializedData = typeof spec.data === 'string' ? spec.data : JSON.stringify(spec.data);
  const lines: string[] = [];
  if (spec.event) {
    lines.push(`event: ${spec.event}`);
  }
  for (const dataLine of serializedData.split(/\r?\n/)) {
    lines.push(`data: ${dataLine}`);
  }
  return {
    payload: `${lines.join('\n')}\n\n`,
    delayMs: spec.delayMs,
  };
}

function writeChunkAndFlush(res: http.ServerResponse, payload: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (res.destroyed || res.writableEnded) {
      resolve();
      return;
    }
    res.write(payload, 'utf8', (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

/**
 * 本地可控多协议 Mock 上游服务器（基于 node:http 监听 127.0.0.1 随机端口）。
 * 专用于 E2E 验证请求路径、Headers、Multipart 解析、SSE 分片与故障/断流注入。
 */
export class MockUpstreamServer {
  private server: http.Server | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly requests: RecordedUpstreamRequest[] = [];
  private readonly routes: RouteEntry[] = [];
  private defaultHandler: MockRouteHandler | null = null;
  private waitListeners: Array<{ count: number; resolve: (reqs: RecordedUpstreamRequest[]) => void }> = [];
  private nextRequestId = 1;
  private listeningPort = 0;

  get baseUrl(): string {
    if (!this.listeningPort) {
      throw new Error('MockUpstreamServer 尚未启动，请先调用 start()。');
    }
    return `http://127.0.0.1:${this.listeningPort}`;
  }

  get port(): number {
    return this.listeningPort;
  }

  async start(): Promise<{ baseUrl: string; port: number }> {
    if (this.server) {
      return { baseUrl: this.baseUrl, port: this.listeningPort };
    }

    const server = http.createServer((req, res) => {
      void this.handleIncomingRequest(req, res);
    });

    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => {
        this.sockets.delete(socket);
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

    const address = server.address() as AddressInfo | null;
    if (!address || typeof address.port !== 'number') {
      throw new Error('MockUpstreamServer 启动后无法获取监听端口。');
    }

    this.server = server;
    this.listeningPort = address.port;
    return { baseUrl: this.baseUrl, port: this.listeningPort };
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }
    this.server = null;
    this.listeningPort = 0;

    server.closeAllConnections?.();
    for (const socket of this.sockets) {
      if (!socket.destroyed) {
        socket.destroy();
      }
    }
    this.sockets.clear();

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  /** 注册持久路由（后注册的同优先级匹配靠前或按插入顺序？此处按插入顺序匹配，先匹配的命中） */
  on(matcher: MockRouteMatcher, handler: MockRouteHandler): this {
    this.routes.push({ matcher, handler, once: false });
    return this;
  }

  /** 注册一次性队列路由（命中使用一次后自动移除，优先于持久路由） */
  enqueue(matcher: MockRouteMatcher, handler: MockRouteHandler): this {
    // 一次性队列插到持久路由之前，并按 enqueue 顺序 FIFO 执行
    const firstPersistentIdx = this.routes.findIndex((entry) => !entry.once);
    const entry: RouteEntry = { matcher, handler, once: true };
    if (firstPersistentIdx === -1) {
      this.routes.push(entry);
    } else {
      this.routes.splice(firstPersistentIdx, 0, entry);
    }
    return this;
  }

  setDefault(handler: MockRouteHandler): this {
    this.defaultHandler = handler;
    return this;
  }

  getRequests(filter?: MockRequestFilter): RecordedUpstreamRequest[] {
    if (!filter) {
      return this.requests.slice();
    }
    return this.requests.filter((req) => {
      if (filter.method && req.method.toUpperCase() !== filter.method.toUpperCase()) {
        return false;
      }
      if (filter.pathname !== undefined) {
        if (typeof filter.pathname === 'string') {
          return req.pathname === filter.pathname;
        }
        return filter.pathname.test(req.pathname);
      }
      return true;
    });
  }

  getLastRequest(filter?: MockRequestFilter): RecordedUpstreamRequest | undefined {
    const matched = this.getRequests(filter);
    return matched.length ? matched[matched.length - 1] : undefined;
  }

  waitForRequestCount(count: number, timeoutMs = 5000): Promise<RecordedUpstreamRequest[]> {
    if (this.requests.length >= count) {
      return Promise.resolve(this.requests.slice());
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waitListeners = this.waitListeners.filter((item) => item.resolve !== onResolved);
        reject(
          new Error(
            `等待上游请求数量达到 ${count} 超时（${timeoutMs}ms），当前实际收到 ${this.requests.length} 笔。`
          )
        );
      }, timeoutMs);

      const onResolved = (reqs: RecordedUpstreamRequest[]) => {
        clearTimeout(timer);
        resolve(reqs);
      };

      this.waitListeners.push({ count, resolve: onResolved });
    });
  }

  clearRequests(): void {
    this.requests.length = 0;
  }

  resetRoutes(): void {
    this.routes.length = 0;
    this.defaultHandler = null;
  }

  reset(): void {
    this.clearRequests();
    this.resetRoutes();
  }

  private resolveHandler(req: RecordedUpstreamRequest): MockRouteHandler | null {
    const matchedIdx = this.routes.findIndex((entry) => matchesRoute(entry.matcher, req));
    if (matchedIdx !== -1) {
      const entry = this.routes[matchedIdx];
      if (entry.once) {
        this.routes.splice(matchedIdx, 1);
      }
      return entry.handler;
    }
    return this.defaultHandler;
  }

  private notifyWaiters(): void {
    if (!this.waitListeners.length) return;
    const pending = this.waitListeners.slice();
    for (const waiter of pending) {
      if (this.requests.length >= waiter.count) {
        this.waitListeners = this.waitListeners.filter((item) => item !== waiter);
        waiter.resolve(this.requests.slice());
      }
    }
  }

  private async handleIncomingRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    try {
      const rawUrl = req.url ?? '/';
      const parsedUrl = new URL(rawUrl, 'http://127.0.0.1');
      const headers = normalizeHeaders(req.headers);

      const bodyChunks: Buffer[] = [];
      for await (const chunk of req) {
        bodyChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const rawBody = Buffer.concat(bodyChunks);
      const bodyText = rawBody.toString('utf8');

      let jsonBody: unknown;
      const contentType = headers['content-type'] ?? '';
      if (
        bodyText.trim().length > 0 &&
        (contentType.includes('application/json') ||
          bodyText.trimStart().startsWith('{') ||
          bodyText.trimStart().startsWith('['))
      ) {
        try {
          jsonBody = JSON.parse(bodyText) as unknown;
        } catch {
          jsonBody = undefined;
        }
      }

      const multipartParts = contentType.toLowerCase().includes('multipart/form-data')
        ? parseMultipartBuffer(rawBody, contentType)
        : undefined;

      const recorded: RecordedUpstreamRequest = {
        id: this.nextRequestId++,
        method: (req.method ?? 'GET').toUpperCase(),
        url: rawUrl,
        pathname: parsedUrl.pathname,
        query: parseQuery(parsedUrl.searchParams),
        headers,
        rawBody,
        bodyText,
        ...(jsonBody !== undefined ? { jsonBody } : {}),
        ...(multipartParts ? { multipartParts } : {}),
        receivedAt: Date.now(),
      };

      this.requests.push(recorded);
      this.notifyWaiters();

      const handler = this.resolveHandler(recorded);
      if (!handler) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(
          JSON.stringify({
            error: `MockUpstreamServer 未匹配到路由: ${recorded.method} ${recorded.pathname}`,
          })
        );
        return;
      }

      const action = typeof handler === 'function' ? await handler(recorded) : handler;
      await this.dispatchAction(action, res);
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          })
        );
      } else if (!res.destroyed) {
        res.socket?.destroy();
      }
    }
  }

  private async dispatchAction(
    action: MockResponseAction,
    res: http.ServerResponse
  ): Promise<void> {
    if (action.kind === 'json') {
      if (action.delayMs) await delay(action.delayMs);
      res.statusCode = action.status ?? 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      for (const [k, v] of Object.entries(action.headers ?? {})) {
        res.setHeader(k, v);
      }
      res.end(JSON.stringify(action.body));
      return;
    }

    if (action.kind === 'text') {
      if (action.delayMs) await delay(action.delayMs);
      res.statusCode = action.status ?? 200;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      for (const [k, v] of Object.entries(action.headers ?? {})) {
        res.setHeader(k, v);
      }
      res.end(action.body);
      return;
    }

    if (action.kind === 'error') {
      if (action.delayMs) await delay(action.delayMs);
      res.statusCode = action.status;
      const isStringBody = typeof action.body === 'string';
      res.setHeader(
        'Content-Type',
        isStringBody ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8'
      );
      for (const [k, v] of Object.entries(action.headers ?? {})) {
        res.setHeader(k, v);
      }
      res.end(isStringBody ? action.body : JSON.stringify(action.body));
      return;
    }

    // SSE 流式分片发送与故障注入
    res.statusCode = action.status ?? 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    for (const [k, v] of Object.entries(action.headers ?? {})) {
      res.setHeader(k, v);
    }
    res.flushHeaders?.();

    const defaultDelay = action.chunkDelayMs ?? 0;
    const abortIdx = action.abortAfterChunkIndex;

    for (let idx = 0; idx < action.chunks.length; idx += 1) {
      if (res.destroyed || res.writableEnded) {
        return;
      }
      const { payload, delayMs } = serializeSseChunk(action.chunks[idx]);
      const waitMs = delayMs ?? defaultDelay;
      if (waitMs > 0) {
        await delay(waitMs);
      }
      if (res.destroyed || res.writableEnded) {
        return;
      }

      await writeChunkAndFlush(res, payload);

      if (abortIdx !== undefined && idx === abortIdx) {
        if (action.abortMode === 'destroy-socket') {
          // 轻微让出微任务/事件循环以确保已写入帧发往对端后再强制断开 Socket
          await delay(5);
          res.socket?.destroy();
          return;
        }
        // 默认 premature-end：不发送剩余帧，直接结束流
        res.end();
        return;
      }
    }

    if (!res.destroyed && !res.writableEnded) {
      res.end();
    }
  }
}

export function createMockUpstreamServer(): MockUpstreamServer {
  return new MockUpstreamServer();
}
