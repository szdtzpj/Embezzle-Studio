import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const defaultRepository = 'szdtzpj/Embezzle-Studio';
const defaultMaxApkBytes = 256 * 1024 * 1024;
const defaultMaxChecksumBytes = 64 * 1024;
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

function parseRepository(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error('GITHUB_REPOSITORY must be an owner/repository pair.');
  }
  const [owner, repo] = value.split('/');
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') {
    throw new Error('GITHUB_REPOSITORY contains an invalid path segment.');
  }
  return { owner, repo };
}

function normalizePublicBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('PUBLIC_RELEASE_BASE_URL must be a valid HTTPS URL.');
  }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error('PUBLIC_RELEASE_BASE_URL must be a credential-free HTTPS URL without a query or fragment.');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${pathname === '/' ? '' : pathname}`;
}

function safeApkName(value) {
  if (
    typeof value !== 'string'
    || value.length > 200
    || !/^[A-Za-z0-9][A-Za-z0-9._ -]*\.apk$/i.test(value)
    || value.includes('..')
    || path.posix.basename(value) !== value
    || path.win32.basename(value) !== value
  ) {
    return undefined;
  }
  return value;
}

function safeAssetApiUrl(value, repository) {
  if (typeof value !== 'string') {
    return undefined;
  }
  try {
    const url = new URL(value);
    const expectedPrefix = `/repos/${repository}/releases/assets/`.toLowerCase();
    if (
      url.protocol !== 'https:'
      || url.hostname.toLowerCase() !== 'api.github.com'
      || url.username
      || url.password
      || url.search
      || url.hash
      || !url.pathname.toLowerCase().startsWith(expectedPrefix)
      || !/^\d+$/.test(url.pathname.slice(expectedPrefix.length))
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function checksumAssetFor(assets, apkName) {
  const expectedNames = new Set([`${apkName}.sha256`, 'SHA256SUMS']);
  return assets.find((asset) => typeof asset?.name === 'string' && expectedNames.has(asset.name));
}

function hasTrustedAssetMetadata(asset) {
  return asset?.state === 'uploaded'
    && asset?.uploader?.login === 'github-actions[bot]'
    && typeof asset?.digest === 'string'
    && /^sha256:[a-f0-9]{64}$/i.test(asset.digest);
}

function checksumForApk(checksumText, apkName, checksumName) {
  const isChecksumList = checksumName === 'SHA256SUMS';
  for (const line of checksumText.split(/\r?\n/)) {
    const match = line.match(/^([a-f\d]{64})(?:[ \t]+[*]?(.+?))?[ \t]*$/i);
    if (!match) {
      continue;
    }
    const declaredName = match[2]?.replace(/^\.\//, '');
    if (declaredName === apkName || (!declaredName && !isChecksumList)) {
      return match[1].toLowerCase();
    }
  }
  return undefined;
}

function encodePathSegment(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function byteLimit(value, fallback, label) {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return limit;
}

async function readBoundedResponse(response, limit, label) {
  const declaredText = response.headers.get('content-length')?.trim();
  if (declaredText && /^\d+$/.test(declaredText)) {
    const declared = Number(declaredText);
    if (!Number.isSafeInteger(declared) || declared > limit) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`${label} exceeds the ${limit}-byte limit declared by Content-Length.`);
    }
  }

  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error(`${label} exceeds the ${limit}-byte streamed-body limit.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function formatSize(size) {
  const exact = `${size.toLocaleString('en-US')} 字节`;
  if (size < 1024) {
    return exact;
  }
  const units = ['KiB', 'MiB', 'GiB'];
  let amount = size;
  let unitIndex = -1;
  do {
    amount /= 1024;
    unitIndex += 1;
  } while (amount >= 1024 && unitIndex < units.length - 1);
  return `${amount.toFixed(2)} ${units[unitIndex]}（${exact}）`;
}

function renderReleasePage({
  version,
  releaseName,
  releaseNotes,
  publishedAt,
  apkName,
  apkSize,
  apkSha256,
  downloadUrl,
}) {
  const safeReleaseName = escapeHtml(releaseName);
  const publication = publishedAt
    ? `<div><dt>发布时间</dt><dd>${escapeHtml(publishedAt)}</dd></div>`
    : '';
  const notes = typeof releaseNotes === 'string' && releaseNotes.trim()
    ? escapeHtml(releaseNotes)
    : '本次发布未提供附加说明。';

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; object-src 'none'">
  <title>${safeReleaseName} · Embezzle Studio</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f6f3ee; color: #1f2933; }
    main { width: min(760px, calc(100% - 32px)); margin: 48px auto; }
    article { padding: clamp(24px, 5vw, 48px); border: 1px solid #ded7cc; border-radius: 24px; background: #fffdf9; box-shadow: 0 18px 45px rgba(64, 51, 35, .09); }
    .eyebrow { margin: 0 0 10px; color: #6b6257; font-size: .82rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(2rem, 6vw, 3.25rem); line-height: 1.08; overflow-wrap: anywhere; }
    .intro { margin: 14px 0 30px; color: #5f574e; line-height: 1.7; }
    dl { display: grid; gap: 12px; margin: 0 0 28px; }
    dl div { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 16px; padding-bottom: 12px; border-bottom: 1px solid #eee8df; }
    dt { color: #70675d; font-weight: 650; }
    dd { margin: 0; overflow-wrap: anywhere; }
    code { font: .9rem/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; word-break: break-all; }
    .download { display: inline-flex; min-height: 48px; align-items: center; justify-content: center; padding: 0 22px; border-radius: 999px; background: #b84d2e; color: #fff; font-weight: 750; text-decoration: none; }
    .download:focus-visible { outline: 3px solid #1f2933; outline-offset: 4px; }
    .notes-title { margin: 36px 0 12px; font-size: 1.15rem; }
    .notes { color: #403a34; line-height: 1.75; overflow-wrap: anywhere; white-space: pre-wrap; }
    .trust { margin: 30px 0 0; color: #70675d; font-size: .88rem; line-height: 1.6; }
    @media (max-width: 520px) { main { margin: 16px auto; } article { border-radius: 18px; } dl div { grid-template-columns: 1fr; gap: 4px; } }
  </style>
</head>
<body>
  <main>
    <article>
      <p class="eyebrow">Checksum-matched Android release</p>
      <h1>${safeReleaseName}</h1>
      <p class="intro">此页面中的 APK 来自仓库所有者发布的 GitHub Immutable Release，并已在部署时与 Actions 上传的 SHA-256 校验文件及 GitHub asset digest 逐字节核对。</p>
      <dl>
        <div><dt>版本</dt><dd>${escapeHtml(version)}</dd></div>
        ${publication}
        <div><dt>文件</dt><dd>${escapeHtml(apkName)}</dd></div>
        <div><dt>大小</dt><dd>${escapeHtml(formatSize(apkSize))}</dd></div>
        <div><dt>SHA-256</dt><dd><code>${escapeHtml(apkSha256)}</code></dd></div>
      </dl>
      <a class="download" href="${escapeHtml(downloadUrl)}" download="${escapeHtml(apkName)}">下载已校验摘要的 APK</a>
      <h2 class="notes-title">发布说明</h2>
      <div class="notes">${notes}</div>
      <p class="trust">Immutable Release、GitHub asset digest 与校验文件的一致性共同保护发布字节，但仍不等同于生产签名验证。生产发布还必须使用 apksigner 对照正式证书指纹；Android 能否覆盖安装也取决于新旧 APK 签名是否一致。</p>
    </article>
  </main>
</body>
</html>
`;
}

async function resetManagedOutput(outputDir) {
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    rm(path.join(outputDir, 'release-manifest.json'), { force: true }),
    rm(path.join(outputDir, 'release.html'), { force: true }),
    rm(path.join(outputDir, 'downloads'), { recursive: true, force: true }),
  ]);
}

async function writeManifest(outputDir, manifest) {
  await writeFile(
    path.join(outputDir, 'release-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  );
}

function releaseFields(release, fallbackVersion) {
  const tag = typeof release?.tag_name === 'string' && release.tag_name.trim()
    ? release.tag_name.trim()
    : `v${fallbackVersion}`;
  return {
    version: tag.replace(/^v/i, ''),
    releaseName: typeof release?.name === 'string' && release.name.trim()
      ? release.name.trim()
      : tag,
    releaseNotes: typeof release?.body === 'string' ? release.body : '',
    publishedAt: typeof release?.published_at === 'string' ? release.published_at : undefined,
  };
}

export async function stageReleaseForPages(options = {}) {
  const outputDir = path.resolve(options.outputDir ?? process.argv[2] ?? 'dist');
  const repository = options.repository ?? process.env.GITHUB_REPOSITORY ?? defaultRepository;
  const token = options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const packageVersion = options.packageVersion ?? packageJson.version;
  const maxApkBytes = byteLimit(options.maxApkBytes, defaultMaxApkBytes, 'maxApkBytes');
  const maxChecksumBytes = byteLimit(
    options.maxChecksumBytes,
    defaultMaxChecksumBytes,
    'maxChecksumBytes'
  );
  const { owner, repo } = parseRepository(repository);
  const publicBaseUrl = normalizePublicBaseUrl(
    options.publicBaseUrl
      ?? process.env.PUBLIC_RELEASE_BASE_URL
      ?? `https://${owner}.github.io/${repo}`
  );

  if (typeof fetchImpl !== 'function') {
    throw new Error('A Fetch-compatible implementation is required.');
  }

  async function githubFetch(url, accept = 'application/vnd.github+json') {
    return fetchImpl(url, {
      headers: {
        Accept: accept,
        'User-Agent': 'Embezzle-Studio-release-stager',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  }

  await resetManagedOutput(outputDir);

  const releaseResponse = await githubFetch(`https://api.github.com/repos/${repository}/releases/latest`);
  if (releaseResponse.status === 404) {
    const manifest = {
      schemaVersion: 1,
      version: packageVersion,
      releaseName: `v${packageVersion}`,
      releaseUrl: publicBaseUrl,
      releaseNotes: '当前还没有可通过公开 SHA-256 校验链验证的 Android 安装包。',
      apk: null,
    };
    await writeManifest(outputDir, manifest);
    return manifest;
  }
  if (!releaseResponse.ok) {
    throw new Error(`Unable to read latest GitHub release: ${releaseResponse.status}`);
  }

  const release = await releaseResponse.json();
  const fields = releaseFields(release, packageVersion);
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  if (
    release?.immutable !== true
    || release?.draft !== false
    || release?.prerelease !== false
    || release?.author?.login !== owner
  ) {
    const manifest = {
      schemaVersion: 1,
      ...fields,
      releaseUrl: publicBaseUrl,
      releaseNotes: '最新 Release 不是由仓库所有者发布的 GitHub Immutable Release，因此不会公开为应用内更新。',
      apk: null,
    };
    await writeManifest(outputDir, manifest);
    return manifest;
  }
  const expectedApkName = `Embezzle-Studio-${typeof release?.tag_name === 'string' ? release.tag_name.trim() : ''}-release.apk`;
  const apkAsset = assets.find((asset) => asset?.name === expectedApkName);
  const apkName = safeApkName(apkAsset?.name);
  const checksumAsset = apkName ? checksumAssetFor(assets, apkName) : undefined;
  const apkAssetUrl = safeAssetApiUrl(apkAsset?.url, repository);
  const checksumAssetUrl = safeAssetApiUrl(checksumAsset?.url, repository);

  if (
    !apkAsset
    || !apkName
    || !checksumAsset
    || !apkAssetUrl
    || !checksumAssetUrl
    || !hasTrustedAssetMetadata(apkAsset)
    || !hasTrustedAssetMetadata(checksumAsset)
  ) {
    const manifest = {
      schemaVersion: 1,
      ...fields,
      releaseUrl: publicBaseUrl,
      releaseNotes: '该 Release 没有同时提供安全命名的 APK 和匹配的 SHA-256 校验文件，因此不会公开为应用内更新。',
      apk: null,
    };
    await writeManifest(outputDir, manifest);
    return manifest;
  }

  if (
    (Number.isFinite(apkAsset.size) && apkAsset.size > maxApkBytes)
    || (Number.isFinite(checksumAsset.size) && checksumAsset.size > maxChecksumBytes)
  ) {
    throw new Error('Release asset metadata exceeds the configured byte limit.');
  }

  const checksumResponse = await githubFetch(checksumAssetUrl, 'application/octet-stream');
  if (!checksumResponse.ok) {
    throw new Error(`Unable to download the release checksum asset: ${checksumResponse.status}`);
  }
  const checksumBytes = await readBoundedResponse(checksumResponse, maxChecksumBytes, 'Release checksum asset');
  const checksumAssetSha256 = createHash('sha256').update(checksumBytes).digest('hex');
  if (checksumAsset.digest.toLowerCase() !== `sha256:${checksumAssetSha256}`) {
    throw new Error('Release checksum bytes do not match the GitHub asset digest.');
  }
  const checksumText = checksumBytes.toString('utf8');
  const expectedSha256 = checksumForApk(checksumText, apkName, checksumAsset.name);
  if (!expectedSha256) {
    throw new Error('Release checksum asset does not contain a SHA-256 entry for the selected APK.');
  }

  const apkResponse = await githubFetch(apkAssetUrl, 'application/octet-stream');
  if (!apkResponse.ok) {
    throw new Error(`Unable to download the release APK asset: ${apkResponse.status}`);
  }
  const apkBytes = await readBoundedResponse(apkResponse, maxApkBytes, 'Release APK asset');
  const actualSha256 = createHash('sha256').update(apkBytes).digest('hex');
  if (apkAsset.digest.toLowerCase() !== `sha256:${actualSha256}`) {
    throw new Error('Release APK bytes do not match the GitHub asset digest.');
  }
  if (expectedSha256 !== actualSha256) {
    throw new Error('Release APK SHA-256 does not match its checksum asset.');
  }

  const downloadsDir = path.join(outputDir, 'downloads');
  const downloadUrl = `${publicBaseUrl}/downloads/${encodePathSegment(apkName)}`;
  const releaseUrl = `${publicBaseUrl}/release.html`;
  const manifest = {
    schemaVersion: 1,
    ...fields,
    releaseUrl,
    apk: {
      name: apkName,
      contentType: 'application/vnd.android.package-archive',
      size: apkBytes.byteLength,
      downloadUrl,
      sha256: actualSha256,
    },
  };
  const releasePage = renderReleasePage({
    ...fields,
    apkName,
    apkSize: apkBytes.byteLength,
    apkSha256: actualSha256,
    downloadUrl,
  });

  await mkdir(downloadsDir, { recursive: true });
  await writeFile(path.join(downloadsDir, apkName), apkBytes);
  await writeFile(path.join(outputDir, 'release.html'), releasePage, 'utf8');
  await writeManifest(outputDir, manifest);
  return manifest;
}

const isDirectInvocation = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectInvocation) {
  await stageReleaseForPages();
}
