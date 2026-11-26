import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createProxyServer, OFFICIAL_PROVIDER_HOSTS } from '../../../scripts/dev-proxy.mjs';
import { createMockUpstreamServer } from '../helpers/mockUpstreamServer.ts';
import { runDistModeSuite, runDevStreamingModeSuite } from './web-e2e-suites.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..', '..', '..');
const DEFAULT_DIST_DIR = path.join(REPO_ROOT, 'dist');
const EXPO_CLI = path.join(REPO_ROOT, 'node_modules', 'expo', 'bin', 'cli');

const MOCKABLE_EXTRA_HOSTS = new Set([
  'api.bochaai.com',
  'api.exa.ai',
  'api.tavily.com',
  'api.search.brave.com',
  'searx.example.com',
  'your-relay.example.com',
]);

/**
 * 打印 Web E2E Runner 命令行帮助。
 */
function printUsage() {
  process.stdout.write(
    [
      'Embezzle Studio Tier 4 Web Playwright E2E 运行器',
      '',
      '用法:',
      '  node tests/e2e/web/run-web-e2e.mjs [选项]',
      '',
      '选项:',
      '  --mode=dist   仅运行 Mode A（dist/ 生产静态产物多视口几何与安全拦截验收）',
      '  --mode=dev    仅运行 Mode B（expo start --web + dev-proxy + MockUpstream SSE 压测）',
      '  -h, --help    显示本帮助并退出',
      '',
      '默认行为：依次执行 Mode A 与 Mode B。',
      '缺少 playwright 或浏览器可执行文件时将按 fail-closed 原则返回退出码 1。',
      '',
    ].join('\n')
  );
}

/**
 * 解析命令行参数。
 * @param {string[]} argv 命令行参数列表
 * @returns {{ mode: 'all' | 'dist' | 'dev' | 'help' }} 解析结果
 */
function parseArgs(argv) {
  let mode = 'all';
  let hasExplicitMode = false;

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      return { mode: 'help' };
    }
    if (arg === '--mode=dist') {
      if (hasExplicitMode && mode !== 'dist') {
        throw new Error('参数冲突：不能同时指定多个不同 --mode。');
      }
      mode = 'dist';
      hasExplicitMode = true;
    } else if (arg === '--mode=dev') {
      if (hasExplicitMode && mode !== 'dev') {
        throw new Error('参数冲突：不能同时指定多个不同 --mode。');
      }
      mode = 'dev';
      hasExplicitMode = true;
    } else {
      throw new Error(`未知参数: ${arg}。请使用 --help 查看可用选项。`);
    }
  }

  return { mode };
}

/**
 * 默认严格通过标准 `import('playwright')` 加载 Playwright；
 * 仅在显式设置 `PLAYWRIGHT_MODULE_PATH` 时加载显式路径，禁止隐式偷加载缓存。
 * @returns {Promise<typeof import('playwright')>} Playwright 模块
 */
async function loadPlaywrightOrFail() {
  const explicitModulePath = process.env.PLAYWRIGHT_MODULE_PATH?.trim();
  if (explicitModulePath) {
    const resolved = path.resolve(explicitModulePath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`PLAYWRIGHT_MODULE_PATH 指定的路径不存在: ${resolved}`);
    }
    const mod = await import(pathToFileURL(resolved).href);
    return mod.default ?? mod;
  }

  try {
    // playwright 已作为 devDependency 注册；若运行环境缺失依赖则按 fail-closed 返回退出码 1
    const mod = await import('playwright');
    return mod.default ?? mod;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `缺少 "playwright" 依赖包，无法运行 Tier 4 Web 浏览器 E2E 测试（fail-closed）。\n` +
        `安装指引：请在仓库根目录执行 "npm install -D playwright"（或显式设置 PLAYWRIGHT_MODULE_PATH）。\n` +
        `详细原因: ${detail}`
    );
  }
}

/**
 * 按约定优先级探测可用的 Chromium/Chrome/Edge 浏览器可执行文件路径。
 * 优先级：PLAYWRIGHT_CHROMIUM_EXECUTABLE -> chromium.executablePath() -> %LOCALAPPDATA%\ms-playwright -> 系统 Chrome/Edge。
 * @param {import('playwright').BrowserType} chromiumType Playwright chromium 启动器
 * @returns {string} 可执行文件绝对路径
 */
function resolveChromiumExecutable(chromiumType) {
  const explicitExec = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?.trim();
  if (explicitExec) {
    const resolved = path.resolve(explicitExec);
    if (!fs.existsSync(resolved)) {
      throw new Error(`PLAYWRIGHT_CHROMIUM_EXECUTABLE 指定的浏览器不存在: ${resolved}`);
    }
    return resolved;
  }

  try {
    const managedPath = chromiumType.executablePath?.();
    if (managedPath && fs.existsSync(managedPath)) {
      return managedPath;
    }
  } catch {
    // 忽略并继续走本地缓存与系统浏览器探测
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const msPlaywrightRoot = path.join(localAppData, 'ms-playwright');
    if (fs.existsSync(msPlaywrightRoot)) {
      const entries = fs.readdirSync(msPlaywrightRoot, { withFileTypes: true });
      const chromiumDirs = entries
        .filter((e) => e.isDirectory() && e.name.startsWith('chromium-'))
        .map((e) => e.name)
        .sort()
        .reverse();
      for (const dirName of chromiumDirs) {
        for (const sub of ['chrome-win64', 'chrome-win']) {
          const candidate = path.join(msPlaywrightRoot, dirName, sub, 'chrome.exe');
          if (fs.existsSync(candidate)) {
            return candidate;
          }
        }
      }
      const shellDirs = entries
        .filter((e) => e.isDirectory() && e.name.startsWith('chromium_headless_shell-'))
        .map((e) => e.name)
        .sort()
        .reverse();
      for (const dirName of shellDirs) {
        const candidate = path.join(
          msPlaywrightRoot,
          dirName,
          'chrome-headless-shell-win64',
          'chrome-headless-shell.exe'
        );
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }
  }

  const systemCandidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        ];

  for (const candidate of systemCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    '未找到可用的 Chromium / Chrome / Edge 浏览器可执行文件（fail-closed）。' +
      '请运行 "npx playwright install chromium" 或设置 PLAYWRIGHT_CHROMIUM_EXECUTABLE。'
  );
}

/**
 * 探测本机可用的临时随机空闲端口（避开固定端口冲突）。
 * @returns {Promise<number>} 空闲端口号
 */
function allocateFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close(() => reject(new Error('无法分配临时空闲端口')));
        return;
      }
      const freePort = address.port;
      probe.close((closeErr) => {
        if (closeErr) reject(closeErr);
        else resolve(freePort);
      });
    });
  });
}

/**
 * 彻底终止子进程及其派生进程树（Windows 使用 taskkill /T /F）。
 * @param {import('node:child_process').ChildProcess | null} child 子进程句柄
 */
function killProcessTree(child) {
  if (!child || child.pid == null) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    // 进程可能已自行退出
  }
}

/**
 * 等待 HTTP 服务在指定端口就绪。
 * @param {string} url 目标地址
 * @param {number} timeoutMs 超时毫秒数
 * @param {() => boolean} hasExited 判断子进程是否已提前退出
 */
async function waitForHttpReady(url, timeoutMs, hasExited) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasExited()) {
      throw new Error(`Web 开发服务器提前退出，未能在 ${url} 就绪`);
    }
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.ok) {
        return;
      }
    } catch {
      // 服务尚未监听，继续轮询
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`等待 Web 开发服务器就绪超时 (${timeoutMs}ms): ${url}`);
}

/**
 * 判断主机名是否允许由 Mode B dev-proxy 透明转发至本地 MockUpstreamServer。
 * @param {string} hostname 主机名
 * @returns {boolean} 是否命中代理白名单
 */
function isMockRoutableHost(hostname) {
  const lower = hostname.toLowerCase();
  if (MOCKABLE_EXTRA_HOSTS.has(lower)) {
    return true;
  }
  return OFFICIAL_PROVIDER_HOSTS.some((pattern) => {
    const clean = pattern.toLowerCase();
    if (clean.startsWith('*.')) {
      return lower.endsWith(clean.slice(1));
    }
    return lower === clean;
  });
}

/**
 * 启动隔离端口的 Mode B 基础设施（MockUpstreamServer + 进程内 dev-proxy + expo start --web）。
 * @returns {Promise<{
 *   expoBaseUrl: string;
 *   proxyPort: number;
 *   mockServer: import('../helpers/mockUpstreamServer.ts').MockUpstreamServer;
 *   cleanup: () => Promise<void>;
 * }>} 环境句柄与清理函数
 */
async function startDevModeInfrastructure() {
  if (!fs.existsSync(EXPO_CLI)) {
    throw new Error(`未找到 Expo CLI (${EXPO_CLI})，请先执行 "npm ci"。`);
  }

  const mockServer = createMockUpstreamServer();
  const { baseUrl: mockBaseUrl } = await mockServer.start();
  const proxyPort = await allocateFreePort();
  const expoPort = await allocateFreePort();

  const proxyFetchImpl = async (input, init) => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const parsed = new URL(rawUrl);
    if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
      return globalThis.fetch(input, init);
    }
    if (!isMockRoutableHost(parsed.hostname)) {
      throw new Error(`[Web E2E Proxy Guard] 拒绝转发未知外部主机: ${parsed.href}`);
    }
    const targetUrl = `${mockBaseUrl}${parsed.pathname}${parsed.search}`;
    return globalThis.fetch(targetUrl, init);
  };

  const proxyServer = createProxyServer({
    fetchImpl: proxyFetchImpl,
    allowedOrigins: `http://localhost:${expoPort},http://127.0.0.1:${expoPort}`,
    allowedTargetHosts: [...OFFICIAL_PROVIDER_HOSTS, ...MOCKABLE_EXTRA_HOSTS].join(','),
  });

  await new Promise((resolve, reject) => {
    proxyServer.once('error', reject);
    proxyServer.listen(proxyPort, '127.0.0.1', () => {
      proxyServer.off('error', reject);
      resolve();
    });
  });

  let expoExited = false;
  let expoOutput = '';
  const expoChild = spawn(
    process.execPath,
    [EXPO_CLI, 'start', '--web', '--port', String(expoPort)],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        BROWSER: 'none',
        CI: '1',
        EXPO_PUBLIC_ENABLE_WEB_DEV_PROXY: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }
  );

  expoChild.stdout?.on('data', (chunk) => {
    expoOutput = `${expoOutput}${chunk.toString()}`.slice(-4000);
  });
  expoChild.stderr?.on('data', (chunk) => {
    expoOutput = `${expoOutput}${chunk.toString()}`.slice(-4000);
  });
  expoChild.on('exit', () => {
    expoExited = true;
  });

  const cleanup = async () => {
    killProcessTree(expoChild);
    await new Promise((resolve) => {
      proxyServer.close(() => resolve());
    });
    await mockServer.close();
  };

  try {
    const expoBaseUrl = `http://127.0.0.1:${expoPort}/Embezzle-Studio`;
    await waitForHttpReady(`http://127.0.0.1:${expoPort}/`, 90_000, () => expoExited);
    return { expoBaseUrl, proxyPort, mockServer, cleanup };
  } catch (error) {
    await cleanup();
    const errMsg = error instanceof Error ? error.message : String(error);
    throw new Error(`${errMsg}\nExpo 输出片段:\n${expoOutput}`);
  }
}

/**
 * Web E2E 总入口函数。
 */
async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[Web E2E] 参数错误: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
    return;
  }

  if (parsed.mode === 'help') {
    printUsage();
    process.exitCode = 0;
    return;
  }

  const runDist = parsed.mode === 'all' || parsed.mode === 'dist';
  const runDev = parsed.mode === 'all' || parsed.mode === 'dev';

  if (runDist && !fs.existsSync(path.join(DEFAULT_DIST_DIR, 'index.html'))) {
    process.stderr.write(
      `[Web E2E] 缺少 dist/index.html (${DEFAULT_DIST_DIR})，请先执行 "npm run build:web"（fail-closed）。\n`
    );
    process.exitCode = 1;
    return;
  }

  let playwrightMod;
  let executablePath;
  try {
    playwrightMod = await loadPlaywrightOrFail();
    executablePath = resolveChromiumExecutable(playwrightMod.chromium);
  } catch (error) {
    process.stderr.write(`[Web E2E] 环境检查失败 (fail-closed):\n${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  let browser = null;
  let devCleanup = null;
  let signalHandling = false;

  const handleSignal = () => {
    if (signalHandling) {
      return;
    }
    signalHandling = true;
    const forceTimer = setTimeout(() => {
      process.exit(1);
    }, 5_000);
    forceTimer.unref();

    const activeBrowser = browser;
    const activeDevCleanup = devCleanup;
    browser = null;
    devCleanup = null;

    void Promise.allSettled([
      Promise.resolve().then(() => activeDevCleanup?.()),
      Promise.resolve().then(() => activeBrowser?.close()),
    ]).finally(() => {
      clearTimeout(forceTimer);
      process.exit(1);
    });
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  try {
    browser = await playwrightMod.chromium.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });

    const summaries = [];
    if (runDist) {
      summaries.push(await runDistModeSuite({ browser, distDir: DEFAULT_DIST_DIR }));
    }

    if (runDev) {
      const devInfra = await startDevModeInfrastructure();
      devCleanup = devInfra.cleanup;
      try {
        summaries.push(
          await runDevStreamingModeSuite({
            browser,
            expoBaseUrl: devInfra.expoBaseUrl,
            proxyPort: devInfra.proxyPort,
            mockServer: devInfra.mockServer,
          })
        );
      } finally {
        await devInfra.cleanup();
        devCleanup = null;
      }
    }

    process.stdout.write('\n[Web E2E] 全部套件通过:\n');
    for (const item of summaries) {
      process.stdout.write(` - [PASS] ${item.suite}: ${item.checks.length} 项校验\n`);
      for (const checkItem of item.checks) {
        process.stdout.write(`    · ${checkItem}\n`);
      }
    }
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(
      `\n[Web E2E] 执行失败:\n${error instanceof Error ? error.stack ?? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
    if (devCleanup) {
      await devCleanup();
    }
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() ===
    path.resolve(fileURLToPath(import.meta.url)).toLowerCase();

if (isDirectRun) {
  await main();
}
