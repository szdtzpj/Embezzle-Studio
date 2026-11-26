import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function escapeJsUnicode(text) {
  return [...text]
    .map((ch) => {
      const code = ch.charCodeAt(0);
      return code > 0x7f ? `\\u${code.toString(16).padStart(4, '0')}` : ch;
    })
    .join('');
}

function resolveDistDir() {
  const dirArg = process.argv.find((arg) => arg.startsWith('--dist-dir='));
  if (dirArg) {
    return path.resolve(dirArg.slice('--dist-dir='.length));
  }
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), '..', 'dist');
}

function verifyWebDistBundle() {
  const distDir = resolveDistDir();
  const indexHtmlPath = path.join(distDir, 'index.html');
  if (!fs.existsSync(indexHtmlPath)) {
    throw new Error(`Web 构建产物缺失: ${indexHtmlPath} 不存在，请先执行 npm run build:web`);
  }

  const html = fs.readFileSync(indexHtmlPath, 'utf8');
  if (!html.includes('<div id="root"></div>')) {
    throw new Error(`Web 入口校验失败: ${indexHtmlPath} 缺少 <div id="root"></div>`);
  }

  const scriptMatch = html.match(
    /src="(?:\/Embezzle-Studio)?\/?(_expo\/static\/js\/web\/[^"]+\.js)"/
  );
  if (!scriptMatch?.[1]) {
    throw new Error(`Web 入口校验失败: ${indexHtmlPath} 未匹配到 _expo/static/js/web/*.js`);
  }

  const bundlePath = path.join(distDir, scriptMatch[1]);
  if (!fs.existsSync(bundlePath)) {
    throw new Error(`Web bundle 缺失: ${bundlePath} 不存在`);
  }

  const bundleContent = fs.readFileSync(bundlePath, 'utf8');
  if (bundleContent.length <= 100_000) {
    throw new Error(`Web bundle 体积异常过小 (${bundleContent.length} bytes): ${bundlePath}`);
  }

  const normalizedBundle = bundleContent.toLowerCase();
  const requiredAnchors = [
    'composer-search-menu',
    'composer-search-tags',
    'chat-scroll-to-bottom',
    'app-dialog-host',
    '关闭聊天记录遮罩',
    '100dvh',
  ];

  for (const anchor of requiredAnchors) {
    const escaped = escapeJsUnicode(anchor).toLowerCase();
    if (!bundleContent.includes(anchor) && !normalizedBundle.includes(escaped)) {
      throw new Error(`Web bundle 校验失败: 缺少核心 M2 锚点 "${anchor}"`);
    }
  }

  process.stdout.write(
    `[verify-web-dist-bundle] PASS: ${bundlePath} (${bundleContent.length} bytes, ${requiredAnchors.length} anchors verified)\n`
  );
}

verifyWebDistBundle();
