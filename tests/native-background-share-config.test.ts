import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

async function readJson(relativePath: string): Promise<any> {
  return JSON.parse(await readFile(path.resolve(relativePath), 'utf8'));
}

async function readSource(relativePath: string): Promise<string> {
  return readFile(path.resolve(relativePath), 'utf8');
}

describe('native background/share configuration', () => {
  it('pins the Expo SDK 57 native modules and opts into Android receive-share filters', async () => {
    const [packageJson, appJson] = await Promise.all([
      readJson('package.json'),
      readJson('app.json'),
    ]);
    expect(packageJson.dependencies['expo-notifications']).toMatch(/^~57\./);
    expect(packageJson.dependencies['expo-background-task']).toMatch(/^~57\./);
    expect(packageJson.dependencies['expo-task-manager']).toMatch(/^~57\./);

    expect(appJson.expo.plugins).toContain('expo-notifications');
    expect(appJson.expo.plugins).toContain('expo-background-task');
    const secureStore = appJson.expo.plugins.find(
      (plugin: unknown) => Array.isArray(plugin) && plugin[0] === 'expo-secure-store'
    );
    expect(secureStore?.[1]?.faceIDPermission).toBe(false);
    expect(appJson.expo.android.blockedPermissions).toEqual(
      expect.arrayContaining([
        'android.permission.USE_BIOMETRIC',
        'android.permission.USE_FINGERPRINT',
      ])
    );
    const sharing = appJson.expo.plugins.find(
      (plugin: unknown) => Array.isArray(plugin) && plugin[0] === 'expo-sharing'
    );
    expect(sharing?.[1]?.android?.enabled).toBe(true);
    expect(sharing?.[1]?.android?.singleShareMimeTypes).toEqual(
      expect.arrayContaining(['text/plain', 'text/html', 'image/*', 'video/*', 'application/pdf'])
    );
    expect(sharing?.[1]?.android?.multipleShareMimeTypes).toEqual(
      expect.arrayContaining(['image/*', 'video/*'])
    );
    expect(sharing?.[1]?.android?.singleShareMimeTypes).not.toContain('*/*');
    expect(sharing?.[1]?.android?.multipleShareMimeTypes).not.toContain('*/*');
  });

  it('keeps incoming share review-first and exposes explicit local destinations', async () => {
    const sheet = await readSource('src/features/share/IncomingShareSheet.tsx');
    expect(sheet).toContain('不会自动发送给模型');
    expect(sheet).toContain("onSelectDestination('conversation')");
    expect(sheet).toContain("onSelectDestination('knowledge')");
    expect(sheet).toContain("onSelectDestination('artifact')");
    expect(sheet).toContain('onResolve');
    expect(sheet).toContain('content://');
  });

  it('keeps notification permission requests behind an explicit action', async () => {
    const [service, button] = await Promise.all([
      readSource('src/services/generationTaskNotifications.ts'),
      readSource('src/features/background/GenerationTaskNotificationPermissionButton.tsx'),
    ]);
    expect(service).toContain('requestGenerationTaskNotificationPermission');
    expect(service).toContain('openGenerationTaskNotificationSettings');
    expect(button).toContain('onPress={() => void handlePress()}');
    expect(button).toContain('openGenerationTaskNotificationSettings()');
    expect(button).toContain('requestGenerationTaskNotificationPermission()');
    expect(button).not.toContain('requestGenerationTaskNotificationPermission();\n  useEffect');
  });

  it('handles background registration failures without an unhandled rejection', async () => {
    const source = await readSource('src/features/background/GenerationTaskBackgroundProvider.tsx');
    expect(source).toContain('ensureGenerationTaskBackgroundRegistration({');
    expect(source).toContain('}).catch(() => {');
    expect(source.match(/recoverNow\(\)\.catch\(\(\) => \{/g)).toHaveLength(2);
  });
});
