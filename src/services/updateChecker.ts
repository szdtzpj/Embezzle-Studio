import { appInfo } from '../data/appInfo';

interface GitHubReleaseAsset {
  name?: string;
  content_type?: string;
  size?: number;
  browser_download_url?: string;
}

interface GitHubReleaseResponse {
  tag_name?: string;
  name?: string;
  html_url?: string;
  body?: string;
  published_at?: string;
  assets?: GitHubReleaseAsset[];
}

export interface ReleaseAssetInfo {
  name: string;
  contentType?: string;
  size?: number;
  downloadUrl: string;
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

function normalizeVersion(version: string) {
  return version.trim().replace(/^v/i, '');
}

function versionParts(version: string) {
  const clean = normalizeVersion(version).split(/[+-]/)[0] ?? '';
  const parts = clean.split('.').map((part) => Number.parseInt(part, 10));

  return parts.every((part) => Number.isFinite(part)) ? parts : null;
}

function compareVersions(left: string, right: string) {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);

  if (!leftParts || !rightParts) {
    return normalizeVersion(left) === normalizeVersion(right) ? 0 : Number.NaN;
  }

  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;

    if (leftPart > rightPart) {
      return 1;
    }
    if (leftPart < rightPart) {
      return -1;
    }
  }

  return 0;
}

function isInstallAsset(asset: ReleaseAssetInfo) {
  const name = asset.name.toLowerCase();
  const contentType = asset.contentType?.toLowerCase() ?? '';

  return (
    name.endsWith('.apk') ||
    contentType.includes('android.package-archive') ||
    name.endsWith('.aab') ||
    name.endsWith('.ipa')
  );
}

function toAssetInfo(asset: GitHubReleaseAsset): ReleaseAssetInfo | null {
  if (!asset.name || !asset.browser_download_url) {
    return null;
  }

  return {
    name: asset.name,
    contentType: asset.content_type,
    size: asset.size,
    downloadUrl: asset.browser_download_url,
  };
}

export async function checkForAppUpdate(): Promise<AppUpdateInfo> {
  const response = await fetch(appInfo.latestReleaseApiUrl, {
    headers: {
      Accept: 'application/vnd.github+json',
    },
  });

  if (response.status === 404) {
    throw new Error('暂未找到 GitHub Release。请先在仓库发布一个 Release。');
  }

  if (!response.ok) {
    throw new Error(`GitHub 更新检查失败：${response.status}`);
  }

  const release = (await response.json()) as GitHubReleaseResponse;
  const latestVersion = normalizeVersion(release.tag_name ?? '');

  if (!latestVersion || !release.html_url) {
    throw new Error('GitHub Release 信息不完整。');
  }

  const comparison = compareVersions(latestVersion, appInfo.version);
  const updateAvailable = Number.isNaN(comparison)
    ? normalizeVersion(latestVersion) !== normalizeVersion(appInfo.version)
    : comparison > 0;
  const assets = (release.assets ?? []).map(toAssetInfo).filter((asset): asset is ReleaseAssetInfo => Boolean(asset));

  return {
    currentVersion: appInfo.version,
    latestVersion,
    releaseName: release.name ?? `v${latestVersion}`,
    releaseUrl: release.html_url,
    releaseNotes: release.body,
    publishedAt: release.published_at,
    updateAvailable,
    installAsset: assets.find(isInstallAsset) ?? assets[0],
  };
}
