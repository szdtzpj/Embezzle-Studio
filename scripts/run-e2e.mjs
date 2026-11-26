import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, '..');
const TSC_ENTRY = path.join(ROOT_DIR, 'node_modules', 'typescript', 'lib', 'tsc.js');
const VITEST_ENTRY = path.join(ROOT_DIR, 'node_modules', 'vitest', 'vitest.mjs');
const WEB_E2E_ENTRY = path.join(ROOT_DIR, 'tests', 'e2e', 'web', 'run-web-e2e.mjs');

/**
 * 格式化耗时（毫秒转可读字符串）。
 * @param {number} durationMs 耗时毫秒数
 * @returns {string} 格式化后的耗时
 */
function formatDuration(durationMs) {
  if (durationMs < 1000) {
    return `${Math.round(durationMs)}ms`;
  }
  return `${(durationMs / 1000).toFixed(2)}s`;
}

/**
 * 打印命令行帮助说明。
 */
function printUsage() {
  process.stdout.write(
    [
      'Embezzle Studio E2E 统一编排运行器',
      '',
      '用法:',
      '  node scripts/run-e2e.mjs [选项]',
      '',
      '选项:',
      '  --core-only   仅执行 E2E 类型检查 (tsconfig.e2e.json)、E2E Lint (lint:e2e) 与 Core E2E (Tiers 0-4)',
      '  --web-only    仅执行 Tier 4 Web Playwright E2E (tests/e2e/web/run-web-e2e.mjs)',
      '  -h, --help    显示本帮助信息并退出',
      '',
      '默认行为（无参数）：',
      '  依次执行 E2E Typecheck -> E2E Lint -> Core Vitest E2E (Tiers 0-4) -> Web E2E (Tier 4)。',
      '  若依赖未安装或 Tier 4 入口缺失，脚本将严格以非 0 退出码失败（fail-closed）。',
      '',
    ].join('\n')
  );
}

/**
 * 解析命令行参数。
 * @param {string[]} argv 参数数组
 * @returns {{ mode: 'all' | 'core-only' | 'web-only' | 'help' }} 解析后的运行模式
 */
function parseArgs(argv) {
  let coreOnly = false;
  let webOnly = false;
  let help = false;

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--core-only') {
      coreOnly = true;
    } else if (arg === '--web-only') {
      webOnly = true;
    } else {
      throw new Error(`未知参数: ${arg}。请使用 --help 查看可用选项。`);
    }
  }

  if (coreOnly && webOnly) {
    throw new Error('参数冲突: --core-only 与 --web-only 不能同时指定。');
  }

  if (help) {
    return { mode: 'help' };
  }
  if (coreOnly) {
    return { mode: 'core-only' };
  }
  if (webOnly) {
    return { mode: 'web-only' };
  }
  return { mode: 'all' };
}

/**
 * 构建跨平台安全的子进程执行命令（规避 Windows Node 24 下 spawn npm.cmd 触发 EINVAL/DEP0190）。
 * @param {string} executable 可执行文件或 npm.cmd
 * @param {string[]} args 参数列表
 * @returns {{ command: string; args: string[] }} 规范化后的命令与参数
 */
export function buildCrossPlatformSpawnSpec(executable, args) {
  if (process.platform === 'win32' && executable.toLowerCase().endsWith('.cmd')) {
    const comspec = process.env.ComSpec || 'cmd.exe';
    return {
      command: comspec,
      args: ['/d', '/s', '/c', executable, ...args],
    };
  }
  return {
    command: executable,
    args,
  };
}

/**
 * 执行单个子进程阶段并收集退出状态与耗时。
 * @param {string} label 阶段名称
 * @param {string} command 可执行文件
 * @param {string[]} args 参数
 * @returns {Promise<{ label: string; ok: boolean; exitCode: number; durationMs: number; detail?: string }>} 阶段结果
 */
function runStageProcess(label, command, args) {
  const startedAt = Date.now();
  const spec = buildCrossPlatformSpawnSpec(command, args);
  process.stdout.write(`\n[E2E] >>> 开始阶段: ${label}\n`);
  process.stdout.write(`[E2E]     命令: ${spec.command} ${spec.args.join(' ')}\n`);

  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args, {
      cwd: ROOT_DIR,
      stdio: 'inherit',
      windowsHide: true,
    });

    child.on('error', (error) => {
      resolve({
        label,
        ok: false,
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        detail: `启动失败: ${error.message}`,
      });
    });

    child.on('close', (code, signal) => {
      const exitCode = typeof code === 'number' ? code : 1;
      resolve({
        label,
        ok: exitCode === 0,
        exitCode,
        durationMs: Date.now() - startedAt,
        detail: signal ? `收到信号终止: ${signal}` : undefined,
      });
    });
  });
}

/**
 * 校验本地依赖与必要入口是否就绪，缺失时按 fail-closed 原则返回错误结果。
 * @param {'all' | 'core-only' | 'web-only'} mode 当前模式
 * @returns {{ ok: boolean; missingMessage?: string }} 校验结果
 */
function verifyPrerequisites(mode) {
  const needsCore = mode === 'all' || mode === 'core-only';
  const needsWeb = mode === 'all' || mode === 'web-only';

  if (needsCore) {
    const nodeModulesDir = path.join(ROOT_DIR, 'node_modules');
    if (!fs.existsSync(nodeModulesDir)) {
      return {
        ok: false,
        missingMessage:
          '未检测到 node_modules 目录。请先由项目根目录执行 "npm ci" 安装依赖后再运行 E2E 测试。',
      };
    }
    if (!fs.existsSync(TSC_ENTRY)) {
      return {
        ok: false,
        missingMessage:
          `未找到 TypeScript CLI 入口: ${TSC_ENTRY}。请先执行 "npm ci" 恢复依赖。`,
      };
    }
    if (!fs.existsSync(VITEST_ENTRY)) {
      return {
        ok: false,
        missingMessage:
          `未找到 Vitest CLI 入口: ${VITEST_ENTRY}。请先执行 "npm ci" 恢复依赖。`,
      };
    }
    const eslintEntry = path.join(ROOT_DIR, 'node_modules', 'eslint', 'bin', 'eslint.js');
    if (!fs.existsSync(eslintEntry)) {
      return {
        ok: false,
        missingMessage:
          `未找到 ESLint CLI 入口: ${eslintEntry}。请先执行 "npm ci" 恢复依赖。`,
      };
    }
  }

  if (needsWeb && !fs.existsSync(WEB_E2E_ENTRY)) {
    return {
      ok: false,
      missingMessage:
        `未找到 Tier 4 Web E2E 入口文件: ${WEB_E2E_ENTRY}。\n` +
        '提示：当前可能尚未完成 E2E-M5（Tier 4 Playwright 套件）实施；若仅运行核心 E2E（Tiers 0-4），请使用：\n' +
        '  node scripts/run-e2e.mjs --core-only',
    };
  }

  return { ok: true };
}

/**
 * 打印各阶段分 Tier 汇总与总耗时。
 * @param {Array<{ label: string; ok: boolean; exitCode: number; durationMs: number; detail?: string }>} results 阶段结果列表
 * @param {number} totalDurationMs 总耗时
 */
function printSummary(results, totalDurationMs) {
  process.stdout.write('\n==================== E2E 执行汇总 ====================\n');
  for (const item of results) {
    const badge = item.ok ? 'PASS' : `FAIL(code=${item.exitCode})`;
    const suffix = item.detail ? ` — ${item.detail}` : '';
    process.stdout.write(
      ` - [${badge}] ${item.label} (${formatDuration(item.durationMs)})${suffix}\n`
    );
  }
  process.stdout.write(` 总耗时: ${formatDuration(totalDurationMs)}\n`);
  process.stdout.write('======================================================\n');
}

/**
 * 主执行入口。
 */
async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[E2E] 参数错误: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
    return;
  }

  if (parsed.mode === 'help') {
    printUsage();
    process.exitCode = 0;
    return;
  }

  const totalStartedAt = Date.now();
  const prereq = verifyPrerequisites(parsed.mode);
  if (!prereq.ok) {
    process.stderr.write(`\n[E2E] 前置条件检查失败 (fail-closed):\n${prereq.missingMessage}\n`);
    process.exitCode = 1;
    return;
  }

  /** @type {Array<{ label: string; ok: boolean; exitCode: number; durationMs: number; detail?: string }>} */
  const results = [];

  if (parsed.mode === 'all' || parsed.mode === 'core-only') {
    const tscResult = await runStageProcess(
      'Tier 0: E2E TypeScript 严格检查 (tsconfig.e2e.json)',
      process.execPath,
      ['--stack_size=16384', TSC_ENTRY, '--noEmit', '-p', 'tsconfig.e2e.json']
    );
    results.push(tscResult);

    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const lintResult = tscResult.ok
      ? await runStageProcess(
          'Tier 0: E2E ESLint 严格检查 (lint:e2e)',
          npmCmd,
          ['run', 'lint:e2e']
        )
      : {
          label: 'Tier 0: E2E ESLint 严格检查 (lint:e2e)',
          ok: false,
          exitCode: 1,
          durationMs: 0,
          detail: '因前置 Typecheck 失败而中止',
        };
    results.push(lintResult);

    if (tscResult.ok && lintResult.ok) {
      const vitestResult = await runStageProcess(
        'Tiers 0-4: Core Vitest E2E (vitest.e2e.config.ts)',
        process.execPath,
        [VITEST_ENTRY, 'run', '--config', 'vitest.e2e.config.ts']
      );
      results.push(vitestResult);
    } else {
      results.push({
        label: 'Tiers 0-4: Core Vitest E2E (vitest.e2e.config.ts)',
        ok: false,
        exitCode: 1,
        durationMs: 0,
        detail: '因前置 Typecheck / Lint 失败而中止',
      });
    }
  }

  if (parsed.mode === 'all' || parsed.mode === 'web-only') {
    const canRunWeb =
      parsed.mode === 'web-only' || results.every((item) => item.ok);
    if (canRunWeb) {
      const webResult = await runStageProcess(
        'Tier 4: Web Playwright E2E (tests/e2e/web/run-web-e2e.mjs)',
        process.execPath,
        [WEB_E2E_ENTRY]
      );
      results.push(webResult);
    } else {
      results.push({
        label: 'Tier 4: Web Playwright E2E (tests/e2e/web/run-web-e2e.mjs)',
        ok: false,
        exitCode: 1,
        durationMs: 0,
        detail: '因核心 E2E 阶段失败而中止',
      });
    }
  }

  printSummary(results, Date.now() - totalStartedAt);
  const allPassed = results.length > 0 && results.every((item) => item.ok);
  process.exitCode = allPassed ? 0 : 1;
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() ===
    path.resolve(fileURLToPath(import.meta.url)).toLowerCase();

if (isDirectRun) {
  await main();
}
