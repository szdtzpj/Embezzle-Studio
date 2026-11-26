import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import path from 'node:path';

export interface StaticDistServerOptions {
  /** 静态产物目录，默认为项目根目录下的 dist */
  distDir?: string;
  /** 匹配 app.json experiments.baseUrl 的前缀，默认 '/Embezzle-Studio' */
  baseUrlPrefix?: string;
}

const MIME_MAP: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.cjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] ?? 'application/octet-stream';
}

function isStaticAssetRequest(relativeSubpath: string): boolean {
  const normalized = relativeSubpath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalized.startsWith('_expo/') || normalized.startsWith('assets/')) {
    return true;
  }
  const baseName = path.posix.basename(normalized);
  return path.posix.extname(baseName).length > 0;
}

function sendTextStatus(
  res: http.ServerResponse,
  statusCode: number,
  message: string,
  extraHeaders?: Record<string, string>
): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(extraHeaders ?? {})) {
    res.setHeader(k, v);
  }
  res.end(message);
}

/**
 * 适配 app.json `"baseUrl": "/Embezzle-Studio"` 的生产构建静态 HTTP 服务器。
 * 特性：
 * - 映射 /Embezzle-Studio、/Embezzle-Studio/、/Embezzle-Studio/* 与 /*；
 * - 缺失的静态资源（带扩展名或 /_expo/、/assets/）严格返回 404，绝不误 fallback 到 index.html；
 * - 无扩展名 SPA 路由 fallback 至 dist/index.html；
 * - 仅允许 GET/HEAD（其他返回 405）；严格校验 URL 解码、空字节（400）与目录穿越（403）。
 */
export class StaticDistServer {
  private readonly distRoot: string;
  private readonly baseUrlPrefix: string;
  private server: http.Server | null = null;
  private readonly sockets = new Set<Socket>();
  private listeningPort = 0;

  constructor(options: StaticDistServerOptions = {}) {
    this.distRoot = path.resolve(options.distDir ?? path.resolve(process.cwd(), 'dist'));
    const rawPrefix = options.baseUrlPrefix ?? '/Embezzle-Studio';
    const trimmed = rawPrefix.replace(/\/+$/, '');
    this.baseUrlPrefix = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  }

  get baseUrl(): string {
    if (!this.listeningPort) {
      throw new Error('StaticDistServer 尚未启动，请先调用 start()。');
    }
    return `http://127.0.0.1:${this.listeningPort}`;
  }

  get appBaseUrl(): string {
    return `${this.baseUrl}${this.baseUrlPrefix}`;
  }

  get port(): number {
    return this.listeningPort;
  }

  async start(): Promise<{ baseUrl: string; appBaseUrl: string; port: number }> {
    if (this.server) {
      return {
        baseUrl: this.baseUrl,
        appBaseUrl: this.appBaseUrl,
        port: this.listeningPort,
      };
    }

    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
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
      throw new Error('StaticDistServer 启动后无法获取监听端口。');
    }

    this.server = server;
    this.listeningPort = address.port;
    return {
      baseUrl: this.baseUrl,
      appBaseUrl: this.appBaseUrl,
      port: this.listeningPort,
    };
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

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      sendTextStatus(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
      return;
    }

    const rawUrl = req.url ?? '/';
    const queryIdx = rawUrl.indexOf('?');
    const rawPathOnly = queryIdx === -1 ? rawUrl : rawUrl.slice(0, queryIdx);

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(rawPathOnly);
    } catch {
      sendTextStatus(res, 400, 'Bad Request: Malformed URL encoding');
      return;
    }

    if (decodedPath.includes('\0')) {
      sendTextStatus(res, 400, 'Bad Request: Null byte in path');
      return;
    }

    // 在折叠前直接检测显式目录穿越段（..），避免 URL 折叠掩盖穿越企图
    const rawSegments = decodedPath.split(/[\\/]+/);
    if (rawSegments.includes('..')) {
      sendTextStatus(res, 403, 'Forbidden: Path traversal detected');
      return;
    }

    // 剥离 baseUrlPrefix（如 /Embezzle-Studio）
    let mappedSubpath: string;
    if (
      decodedPath === '/' ||
      decodedPath === this.baseUrlPrefix ||
      decodedPath === `${this.baseUrlPrefix}/`
    ) {
      mappedSubpath = 'index.html';
    } else if (decodedPath.startsWith(`${this.baseUrlPrefix}/`)) {
      mappedSubpath = decodedPath.slice(this.baseUrlPrefix.length + 1);
    } else {
      mappedSubpath = decodedPath.replace(/^\/+/, '');
    }

    // 防范 Windows 反斜杠绕过并再次基于 path.relative 校验边界
    const safeRelativeInput = mappedSubpath.replace(/\\/g, '/');
    const resolvedTarget = path.resolve(this.distRoot, safeRelativeInput);
    const relativeCheck = path.relative(this.distRoot, resolvedTarget);
    if (
      relativeCheck.startsWith('..') ||
      path.isAbsolute(relativeCheck)
    ) {
      sendTextStatus(res, 403, 'Forbidden: Escapes dist root');
      return;
    }

    const served = await this.tryServeFile(resolvedTarget, method, res);
    if (served) {
      return;
    }

    // 缺失带扩展名资源或 /_expo/、/assets/ 路径必须严格 404，绝不误 fallback 到 index.html
    if (isStaticAssetRequest(safeRelativeInput)) {
      sendTextStatus(res, 404, `Not Found: ${safeRelativeInput}`);
      return;
    }

    // 无扩展名 SPA 路由 fallback 至 dist/index.html
    const indexHtmlPath = path.join(this.distRoot, 'index.html');
    const servedIndex = await this.tryServeFile(indexHtmlPath, method, res);
    if (!servedIndex) {
      sendTextStatus(res, 404, 'Not Found: dist/index.html does not exist');
    }
  }

  private async tryServeFile(
    targetPath: string,
    method: string,
    res: http.ServerResponse
  ): Promise<boolean> {
    let candidate = targetPath;
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) {
        candidate = path.join(candidate, 'index.html');
        const indexStat = await fs.stat(candidate);
        if (!indexStat.isFile()) {
          return false;
        }
      } else if (!stat.isFile()) {
        return false;
      }

      const content = await fs.readFile(candidate);
      res.statusCode = 200;
      res.setHeader('Content-Type', getMimeType(candidate));
      res.setHeader('Content-Length', String(content.byteLength));
      res.setHeader('Cache-Control', 'no-store');
      if (method === 'HEAD') {
        res.end();
      } else {
        res.end(content);
      }
      return true;
    } catch {
      return false;
    }
  }
}

export function createStaticDistServer(options?: StaticDistServerOptions): StaticDistServer {
  return new StaticDistServer(options);
}
