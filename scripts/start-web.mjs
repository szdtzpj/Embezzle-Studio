import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeExecutable = process.execPath;
const expoCli = path.join(rootDir, 'node_modules', 'expo', 'bin', 'cli');
const extraArgs = process.argv.slice(2);

const children = [];

function start(name, command, args) {
  const child = spawn(command, args, {
    cwd: rootDir,
    env: {
      ...process.env,
      BROWSER: process.env.BROWSER ?? 'none',
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

start('dev proxy', nodeExecutable, [path.join(rootDir, 'scripts', 'dev-proxy.mjs')]);
start('expo web', nodeExecutable, [expoCli, 'start', '--web', ...extraArgs]);
