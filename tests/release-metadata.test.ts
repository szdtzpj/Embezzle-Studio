import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { appInfo } from '../src/data/appInfo';

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), 'utf8')) as Record<string, unknown>;
}

describe('release metadata', () => {
  it('keeps every v1.5.0 version source synchronized with Android code 11', async () => {
    const [appConfig, packageJson, packageLock] = await Promise.all([
      readJson('app.json'),
      readJson('package.json'),
      readJson('package-lock.json'),
    ]);
    const expo = appConfig.expo as {
      version?: string;
      android?: { versionCode?: number };
    };
    const lockPackages = packageLock.packages as Record<string, { version?: string }>;

    expect(expo.version).toBe('1.5.0');
    expect(expo.android?.versionCode).toBe(11);
    expect(packageJson.version).toBe('1.5.0');
    expect(packageLock.version).toBe('1.5.0');
    expect(lockPackages['']?.version).toBe('1.5.0');
    expect(appInfo.version).toBe('1.5.0');
  });
});
