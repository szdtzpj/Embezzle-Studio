import { appInfo } from '../data/appInfo';

interface PublicReleaseManifest {
  schemaVersion?: number;
  version?: string;
  releaseName?: string;
  releaseUrl?: string;
  releaseNotes?: string;
  publishedAt?: string;
  apk?: {
    name?: string;
    contentType?: string;
    size?: number;
    downloadUrl?: string;
    sha256?: string;
  } | null;
}

export interface ReleaseAssetInfo {
  name: string;
  contentType?: string;
  size?: number;
  downloadUrl: string;
  sha256?: string;
}

export interface AppUpdateInfo {
  currentVersion: string;
  latestVersion: string;
  releaseName: string;
  releaseUrl: string;
  releaseNotes?: string;
  publishedAt?: string;
  updateAvailable: boolean;
  installAsset?: ReleaseAssetInfo;
}

const updateTimeoutMs = 15_000;
const maxManifestBytes = 512 * 1024;

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '');
}

interface ParsedVersion {
  core: number[];
  prerelease: string[];
}

function parseVersion(version: string): ParsedVersion | null {
  const withoutBuild = normalizeVersion(version).split('+', 1)[0] ?? '';
  const prereleaseSeparator = withoutBuild.indexOf('-');
  const coreText = prereleaseSeparator >= 0 ? withoutBuild.slice(0, prereleaseSeparator) : withoutBuild;
  const prereleaseText = prereleaseSeparator >= 0 ? withoutBuild.slice(prereleaseSeparator + 1) : '';
  if (!/^\d+(?:\.\d+){0,3}$/.test(coreText)) {
    return null;
  }
  const prerelease = prereleaseText ? prereleaseText.split('.') : [];
  if (prerelease.some((part) => !part || !/^[0-9A-Za-z-]+$/.test(part))) {
    return null;
  }
  return { core: coreText.split('.').map((part) => Number(part)), prerelease };
}

export function compareVersions(left: string, right: string): number {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  if (!leftVersion || !rightVersion) {
    return normalizeVersion(left) === normalizeVersion(right) ? 0 : Number.NaN;
  }

  const length = Math.max(leftVersion.core.length, rightVersion.core.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftVersion.core[index] ?? 0;
    const rightPart = rightVersion.core[index] ?? 0;
    if (leftPart !== rightPart) {
      return leftPart > rightPart ? 1 : -1;
    }
  }

  if (!leftVersion.prerelease.length || !rightVersion.prerelease.length) {
    if (leftVersion.prerelease.length === rightVersion.prerelease.length) {
      return 0;
    }
    return leftVersion.prerelease.length ? -1 : 1;
  }
  const prereleaseLength = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < prereleaseLength; index += 1) {
    const leftPart = leftVersion.prerelease[index];
    const rightPart = rightVersion.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) {
      continue;
    }
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return Number(leftPart) > Number(rightPart) ? 1 : -1;
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

function safeHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function safeRepositoryUrl(value: unknown, kind: 'release' | 'asset'): string | undefined {
  const normalized = safeHttpsUrl(value);
  if (!normalized) {
    return undefined;
  }
  const url = new URL(normalized);
  const repositoryPrefix = `/${appInfo.githubOwner}/${appInfo.githubRepo}/releases`;
  const path = url.pathname.toLowerCase();
  const expectedPrefix = repositoryPrefix.toLowerCase();
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'github.com') {
    if (kind === 'asset') {
      return path.startsWith(`${expectedPrefix}/download/`) ? url.toString() : undefined;
    }
    return path === expectedPrefix || path === `${expectedPrefix}/` || path.startsWith(`${expectedPrefix}/tag/`)
      ? url.toString()
      : undefined;
  }
  const pagesHost = `${appInfo.githubOwner.toLowerCase()}.github.io`;
  const pagesPrefix = `/${appInfo.githubRepo.toLowerCase()}`;
  if (hostname !== pagesHost) {
    return undefined;
  }
  if (kind === 'asset') {
    return path.startsWith(`${pagesPrefix}/downloads/`) ? url.toString() : undefined;
  }
  return path === pagesPrefix || path === `${pagesPrefix}/` || path === `${pagesPrefix}/release.html`
    ? url.toString()
    : undefined;
}

function parseInstallAsset(manifest: PublicReleaseManifest): ReleaseAssetInfo | undefined {
  const asset = manifest.apk;
  const downloadUrl = safeRepositoryUrl(asset?.downloadUrl, 'asset');
  const sha256 = typeof asset?.sha256 === 'string' && /^[a-f\d]{64}$/i.test(asset.sha256)
    ? asset.sha256.toLowerCase()
    : undefined;
  if (!asset?.name?.toLowerCase().endsWith('.apk') || !downloadUrl || !sha256) {
    return undefined;
  }

  return {
    name: asset.name,
    contentType: asset.contentType,
    size: typeof asset.size === 'number' && Number.isFinite(asset.size) ? asset.size : undefined,
    downloadUrl,
    sha256,
  };
}

async function fetchReleaseManifest(): Promise<PublicReleaseManifest> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), updateTimeoutMs);
  try {
    const response = await fetch(appInfo.publicReleaseManifestUrl, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (response.status === 404) {
      throw new Error('暂未发布可公开访问的 Android 更新包。');
    }
    if (!response.ok) {
      throw new Error(`更新清单获取失败：${response.status}`);
    }

    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxManifestBytes) {
      throw new Error('更新清单异常：响应过大。');
    }
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > maxManifestBytes) {
      throw new Error('更新清单异常：响应过大。');
    }
    try {
      return JSON.parse(body) as PublicReleaseManifest;
    } catch {
      throw new Error('更新清单不是有效 JSON。');
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('更新检查超时，请稍后重试。');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkForAppUpdate(): Promise<AppUpdateInfo> {
  const manifest = await fetchReleaseManifest();
  const latestVersion = normalizeVersion(manifest.version ?? '');
  const releaseUrl = safeRepositoryUrl(manifest.releaseUrl, 'release') ?? appInfo.releasesUrl;
  if (manifest.schemaVersion !== 1 || !parseVersion(latestVersion)) {
    throw new Error('公开更新清单信息不完整。');
  }

  const comparison = compareVersions(latestVersion, appInfo.version);
  const installAsset = parseInstallAsset(manifest);
  const hasNewerVersion = Number.isNaN(comparison)
    ? latestVersion !== normalizeVersion(appInfo.version)
    : comparison > 0;
  return {
    currentVersion: appInfo.version,
    latestVersion,
    releaseName: manifest.releaseName?.trim() || `v${latestVersion}`,
    releaseUrl,
    releaseNotes: manifest.releaseNotes,
    publishedAt: manifest.publishedAt,
    updateAvailable: Boolean(installAsset) && hasNewerVersion,
    installAsset,
  };
}
