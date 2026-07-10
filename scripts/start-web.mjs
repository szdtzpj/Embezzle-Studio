import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeExecutable = process.execPath;
const expoCli = path.join(rootDir, 'node_modules', 'expo', 'bin', 'cli');
const extraArgs = process.argv.slice(2);

const children = [];

function start(name, command, args, envOverrides = {}) {
  const child = spawn(command, args, {
    cwd: rootDir,
    env: {
      ...process.env,
      BROWSER: process.env.BROWSER ?? 'none',
      ...envOverrides,
    },
    stdio: 'inherit',
    windowsHide: true,
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      return;
    }
    if (code && code !== 0) {
      console.error(`${name} exited with code ${code}`);
      shutdown(code);
    }
  });

  children.push(child);
  return child;
}

function resolveExpoPort(args) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const inlineMatch = /^--port=(\d+)$/.exec(argument);
    const candidate = inlineMatch?.[1] ?? (argument === '--port' ? args[index + 1] : undefined);
    if (candidate != null) {
      const port = Number(candidate);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new Error(`Invalid Expo web port: ${candidate}`);
      }
      return port;
    }
  }
  return 8081;
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) {
      child.kill();
    }
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const expoPort = resolveExpoPort(extraArgs);
const localWebOrigins = `http://localhost:${expoPort},http://127.0.0.1:${expoPort}`;
start('dev proxy', nodeExecutable, [path.join(rootDir, 'scripts', 'dev-proxy.mjs')], {
  WEB_PROXY_ALLOWED_ORIGINS: process.env.WEB_PROXY_ALLOWED_ORIGINS
    ? `${localWebOrigins},${process.env.WEB_PROXY_ALLOWED_ORIGINS}`
    : localWebOrigins,
});
start('expo web', nodeExecutable, [expoCli, 'start', '--web', ...extraArgs]);
