import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

// The production entry point remains directly executable ESM JavaScript.
// @ts-ignore -- no declaration file is needed for this script-only module.
import { stageReleaseForPages } from '../scripts/stage-release-for-pages.mjs';

const repository = 'szdtzpj/Embezzle-Studio';
const publicBaseUrl = 'https://szdtzpj.github.io/Embezzle-Studio';
const tempDirectories = new Set<string>();

async function createOutputDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), 'embezzle-release-stager-'));
  tempDirectories.add(directory);
  return directory;
}

async function exists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function seedStaleRelease(outputDir: string) {
  await mkdir(path.join(outputDir, 'downloads'));
  await Promise.all([
    writeFile(path.join(outputDir, 'release.html'), 'stale page'),
    writeFile(path.join(outputDir, 'release-manifest.json'), '{"stale":true}'),
    writeFile(path.join(outputDir, 'downloads', 'stale.apk'), 'stale apk'),
  ]);
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function binaryResponse(value: Uint8Array | string, status = 200, headers: Record<string, string> = {}) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/octet-stream', ...headers },
  });
}

function releaseAsset(id: number, name: string) {
  return {
    id,
    name,
    url: `https://api.github.com/repos/${repository}/releases/assets/${id}`,
  };
}

afterEach(async () => {
  const directories = [...tempDirectories];
  tempDirectories.clear();
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe('stageReleaseForPages', () => {
  it('publishes a same-origin download page only after the APK matches its named checksum', async () => {
    const outputDir = await createOutputDirectory();
    const apkName = 'Embezzle-Studio-v1.0.5-release.apk';
    const apkBytes = new TextEncoder().encode('verified apk bytes');
    const sha256 = createHash('sha256').update(apkBytes).digest('hex');
    const release = {
      tag_name: 'v1.0.5',
      name: 'Stable <img src=x onerror=alert(1)> & "safe"',
      body: '<script>alert("release notes")</script>\nUse A & B.',
      published_at: '2026-07-10T08:00:00Z',
      assets: [
        releaseAsset(100, 'decoy.apk'),
        releaseAsset(101, apkName),
        releaseAsset(102, `${apkName}.sha256`),
      ],
    };
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/releases/latest')) {
        return jsonResponse(release);
      }
      if (url.endsWith('/assets/101')) {
        return binaryResponse(apkBytes);
      }
      if (url.endsWith('/assets/102')) {
        return binaryResponse(`${sha256}\n`);
      }
      return new Response(null, { status: 404 });
    });

    const manifest = await stageReleaseForPages({
      outputDir,
      repository,
      publicBaseUrl,
      packageVersion: '1.0.4',
      fetchImpl,
    });

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      version: '1.0.5',
      releaseUrl: `${publicBaseUrl}/release.html`,
      apk: {
        name: apkName,
        size: apkBytes.byteLength,
        sha256,
        downloadUrl: `${publicBaseUrl}/downloads/Embezzle-Studio-v1.0.5-release.apk`,
      },
    });
    await expect(readFile(path.join(outputDir, 'downloads', apkName))).resolves.toEqual(Buffer.from(apkBytes));

    const persistedManifest = JSON.parse(await readFile(path.join(outputDir, 'release-manifest.json'), 'utf8'));
    expect(persistedManifest).toEqual(manifest);

    const html = await readFile(path.join(outputDir, 'release.html'), 'utf8');
    expect(html).toContain('Stable &lt;img src=x onerror=alert(1)&gt; &amp; &quot;safe&quot;');
    expect(html).toContain('&lt;script&gt;alert(&quot;release notes&quot;)&lt;/script&gt;\nUse A &amp; B.');
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('<div><dt>版本</dt><dd>1.0.5</dd></div>');
    expect(html).toContain(`<div><dt>大小</dt><dd>${apkBytes.byteLength} 字节</dd></div>`);
    expect(html).toContain(`<code>${sha256}</code>`);
    expect(html).toContain(`href="${publicBaseUrl}/downloads/Embezzle-Studio-v1.0.5-release.apk"`);
    expect(html).toContain('Checksum-matched Android release');
    expect(html).toContain('下载已校验摘要的 APK');
    expect(html).toContain('不等同于生产签名验证');
    expect(html).toContain('apksigner');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('binds SHA256SUMS entries to the APK filename instead of trusting the first hash', async () => {
    const outputDir = await createOutputDirectory();
    await seedStaleRelease(outputDir);
    const apkName = 'Embezzle-Studio-v1.0.5-release.apk';
    const apkBytes = new TextEncoder().encode('real apk');
    const actualSha256 = createHash('sha256').update(apkBytes).digest('hex');
    const wrongSha256 = '0'.repeat(64);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/releases/latest')) {
        return jsonResponse({
          tag_name: 'v1.0.5',
          assets: [releaseAsset(201, apkName), releaseAsset(202, 'SHA256SUMS')],
        });
      }
      if (url.endsWith('/assets/201')) {
        return binaryResponse(apkBytes);
      }
      return binaryResponse(`${actualSha256}  another.apk\n${wrongSha256}  ${apkName}\n`);
    });

    await expect(stageReleaseForPages({
      outputDir,
      repository,
      publicBaseUrl,
      fetchImpl,
    })).rejects.toThrow(/does not match/i);

    expect(await exists(path.join(outputDir, 'release.html'))).toBe(false);
    expect(await exists(path.join(outputDir, 'release-manifest.json'))).toBe(false);
    expect(await exists(path.join(outputDir, 'downloads'))).toBe(false);
  });

  it('writes apk:null and removes stale managed files when GitHub has no release', async () => {
    const outputDir = await createOutputDirectory();
    await seedStaleRelease(outputDir);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));

    const manifest = await stageReleaseForPages({
      outputDir,
      repository,
      publicBaseUrl,
      packageVersion: '1.0.4',
      fetchImpl,
    });

    expect(manifest).toEqual({
      schemaVersion: 1,
      version: '1.0.4',
      releaseName: 'v1.0.4',
      releaseUrl: publicBaseUrl,
      releaseNotes: '当前还没有可通过公开 SHA-256 校验链验证的 Android 安装包。',
      apk: null,
    });
    expect(JSON.parse(await readFile(path.join(outputDir, 'release-manifest.json'), 'utf8'))).toEqual(manifest);
    expect(await exists(path.join(outputDir, 'release.html'))).toBe(false);
    expect(await exists(path.join(outputDir, 'downloads'))).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a missing checksum asset', undefined],
    ['an untrusted APK asset API URL', 'https://attacker.example/app.apk'],
  ])('fails closed for %s without downloading any asset', async (_label, unsafeApkUrl) => {
    const outputDir = await createOutputDirectory();
    await seedStaleRelease(outputDir);
    const apkName = 'Embezzle-Studio-v1.0.5-release.apk';
    const apkAsset = releaseAsset(301, apkName);
    if (unsafeApkUrl) {
      apkAsset.url = unsafeApkUrl;
    }
    const assets = unsafeApkUrl
      ? [apkAsset, releaseAsset(302, `${apkName}.sha256`)]
      : [apkAsset];
    const fetchImpl = vi.fn(async () => jsonResponse({
      tag_name: 'v1.0.5',
      name: 'Stable',
      body: 'Untrusted asset metadata must not be published.',
      assets,
    }));

    const manifest = await stageReleaseForPages({
      outputDir,
      repository,
      publicBaseUrl,
      fetchImpl,
    });

    expect(manifest).toMatchObject({
      version: '1.0.5',
      releaseUrl: publicBaseUrl,
      apk: null,
    });
    expect(await exists(path.join(outputDir, 'release.html'))).toBe(false);
    expect(await exists(path.join(outputDir, 'downloads'))).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects an APK whose Content-Length exceeds the configured bound before reading it', async () => {
    const outputDir = await createOutputDirectory();
    await seedStaleRelease(outputDir);
    const apkName = 'Embezzle-Studio-v1.0.5-release.apk';
    const apkBytes = new TextEncoder().encode('12345678');
    const sha256 = createHash('sha256').update(apkBytes).digest('hex');
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/releases/latest')) {
        return jsonResponse({
          tag_name: 'v1.0.5',
          assets: [releaseAsset(401, apkName), releaseAsset(402, `${apkName}.sha256`)],
        });
      }
      if (url.endsWith('/assets/402')) {
        return binaryResponse(sha256);
      }
      return binaryResponse(apkBytes, 200, { 'Content-Length': '9' });
    });

    await expect(stageReleaseForPages({
      outputDir,
      repository,
      publicBaseUrl,
      fetchImpl,
      maxApkBytes: 8,
    })).rejects.toThrow(/Content-Length/i);

    expect(await exists(path.join(outputDir, 'release.html'))).toBe(false);
    expect(await exists(path.join(outputDir, 'release-manifest.json'))).toBe(false);
    expect(await exists(path.join(outputDir, 'downloads'))).toBe(false);
  });

  it('rejects a streamed checksum body that crosses the configured bound without Content-Length', async () => {
    const outputDir = await createOutputDirectory();
    const apkName = 'Embezzle-Studio-v1.0.5-release.apk';
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/releases/latest')) {
        return jsonResponse({
          tag_name: 'v1.0.5',
          assets: [releaseAsset(501, apkName), releaseAsset(502, `${apkName}.sha256`)],
        });
      }
      return binaryResponse(`${'a'.repeat(64)}\n`);
    });

    await expect(stageReleaseForPages({
      outputDir,
      repository,
      publicBaseUrl,
      fetchImpl,
      maxChecksumBytes: 64,
    })).rejects.toThrow(/streamed-body limit/i);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await exists(path.join(outputDir, 'release.html'))).toBe(false);
    expect(await exists(path.join(outputDir, 'release-manifest.json'))).toBe(false);
    expect(await exists(path.join(outputDir, 'downloads'))).toBe(false);
  });

  it.each([
    ['a non-HTTPS base URL', { publicBaseUrl: 'javascript:alert(1)' }],
    ['a credential-bearing base URL', { publicBaseUrl: 'https://user:secret@example.test/releases' }],
    ['a query-bearing base URL', { publicBaseUrl: 'https://example.test/releases?next=javascript:alert(1)' }],
    ['a fragment-bearing base URL', { publicBaseUrl: 'https://example.test/releases#\" onclick=alert(1)' }],
    ['a malformed repository', { repository: 'owner/repo/../../attacker' }],
  ])('rejects %s before it can form a release or APK href', async (_label, unsafeOptions) => {
    const outputDir = await createOutputDirectory();
    const fetchImpl = vi.fn();

    await expect(stageReleaseForPages({
      outputDir,
      repository,
      publicBaseUrl,
      fetchImpl,
      ...unsafeOptions,
    })).rejects.toThrow();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await exists(path.join(outputDir, 'release.html'))).toBe(false);
    expect(await exists(path.join(outputDir, 'release-manifest.json'))).toBe(false);
    expect(await exists(path.join(outputDir, 'downloads'))).toBe(false);
  });
});
