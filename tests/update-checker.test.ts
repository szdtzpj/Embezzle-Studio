import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkForAppUpdate, compareVersions } from '../src/services/updateChecker';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('compareVersions', () => {
  it.each([
    ['1.0.4', '1.0.3', 1],
    ['v1.0.3', '1.0.3+build.2', 0],
    ['1.0.3-beta.2', '1.0.3-beta.1', 1],
    ['1.0.3', '1.0.3-rc.1', 1],
    ['1.0.3-beta', '1.0.3', -1],
  ])('compares %s with %s', (left, right, expected) => {
    expect(compareVersions(left, right)).toBe(expected);
  });

  it('does not invent an ordering for invalid versions', () => {
    expect(compareVersions('latest', '1.0.3')).toBeNaN();
  });
});

describe('checkForAppUpdate', () => {
  it('accepts only a checksum-backed APK asset from this repository', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 1,
      version: '1.5.1',
      releaseName: 'Stable',
      releaseUrl: 'https://github.com/szdtzpj/Embezzle-Studio/releases/tag/v1.5.1',
      apk: {
        name: 'Embezzle-Studio.apk',
        downloadUrl: 'https://github.com/szdtzpj/Embezzle-Studio/releases/download/v1.5.1/Embezzle-Studio.apk',
        sha256: 'A'.repeat(64),
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const update = await checkForAppUpdate();

    expect(update.updateAvailable).toBe(true);
    expect(update.installAsset).toMatchObject({
      name: 'Embezzle-Studio.apk',
      sha256: 'a'.repeat(64),
    });
    expect(update.releaseUrl).toBe('https://github.com/szdtzpj/Embezzle-Studio/releases/tag/v1.5.1');
  });

  it('accepts the pinned public GitHub Pages download path used for private releases', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 1,
      version: '1.5.1',
      releaseUrl: 'https://szdtzpj.github.io/Embezzle-Studio/release.html',
      apk: {
        name: 'Embezzle-Studio-v1.5.1-release.apk',
        downloadUrl: 'https://szdtzpj.github.io/Embezzle-Studio/downloads/Embezzle-Studio-v1.5.1-release.apk',
        sha256: 'b'.repeat(64),
      },
    }), { status: 200 })));

    await expect(checkForAppUpdate()).resolves.toMatchObject({
      releaseUrl: 'https://szdtzpj.github.io/Embezzle-Studio/release.html',
      installAsset: {
        sha256: 'b'.repeat(64),
      },
    });
  });

  it.each([
    ['non-APK', { name: 'ios.ipa', downloadUrl: 'https://github.com/szdtzpj/Embezzle-Studio/releases/download/v1.5.1/ios.ipa', sha256: 'a'.repeat(64) }],
    ['HTTP URL', { name: 'app.apk', downloadUrl: 'http://github.com/szdtzpj/Embezzle-Studio/releases/download/v1.5.1/app.apk', sha256: 'a'.repeat(64) }],
    ['third-party URL', { name: 'app.apk', downloadUrl: 'https://example.com/app.apk', sha256: 'a'.repeat(64) }],
    ['wrong Pages path', { name: 'app.apk', downloadUrl: 'https://szdtzpj.github.io/other/downloads/app.apk', sha256: 'a'.repeat(64) }],
    ['missing checksum', { name: 'app.apk', downloadUrl: 'https://github.com/szdtzpj/Embezzle-Studio/releases/download/v1.5.1/app.apk' }],
  ])('does not expose an install target for %s', async (_label, apk) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 1,
      version: '1.5.1',
      apk,
    }), { status: 200 })));

    await expect(checkForAppUpdate()).resolves.toMatchObject({
      updateAvailable: false,
      installAsset: undefined,
    });
  });

  it('does not announce a newer manifest version until a trusted APK is staged', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 1,
      version: '1.5.1',
      releaseName: 'Release pending',
      releaseUrl: 'https://szdtzpj.github.io/Embezzle-Studio',
      apk: null,
    }), { status: 200 })));

    await expect(checkForAppUpdate()).resolves.toMatchObject({
      latestVersion: '1.5.1',
      updateAvailable: false,
      installAsset: undefined,
    });
  });

  it('falls back to the fixed repository release page for an injected release URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 1,
      version: '1.5.0',
      releaseUrl: 'https://attacker.example/download',
    }), { status: 200 })));

    await expect(checkForAppUpdate()).resolves.toMatchObject({
      releaseUrl: 'https://github.com/szdtzpj/Embezzle-Studio/releases',
    });
  });
});
