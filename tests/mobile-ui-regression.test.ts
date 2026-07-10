import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

async function source(filePath: string): Promise<string> {
  return readFile(path.resolve(filePath), 'utf8');
}

describe('Android mobile UI regressions', () => {
  it('keeps the Android keyboard in resize mode and actively avoids the IME', async () => {
    const [appConfigSource, appSource] = await Promise.all([
      source('app.json'),
      source('App.tsx'),
    ]);
    const appConfig = JSON.parse(appConfigSource);

    expect(appConfig.expo.android.softwareKeyboardLayoutMode).toBe('resize');
    expect(appSource).toContain(
      "behavior={Platform.OS === 'ios' ? 'padding' : Platform.OS === 'android' ? 'height' : undefined}"
    );
    expect(appSource).toContain('keyboardDismissMode={Platform.OS === \'android\' ? \'on-drag\' : \'interactive\'}');
  });

  it('keeps chat mounted across settings navigation and bounds remote model rendering', async () => {
    const appSource = await source('App.tsx');

    expect(appSource).toContain('const candidateModelPageSize = 60;');
    expect(appSource).toContain('filteredModelCandidates.slice(0, candidateModelRenderLimit)');
    expect(appSource).toContain('{settingsMounted ? (');
    expect(appSource).toContain('style={[styles.screenPane, settingsOpen && styles.screenPaneHidden]}');
    expect(appSource).toContain('Keyboard.dismiss();');
    expect(appSource).toMatch(
      /if \(Platform\.OS === 'android'\) \{\s*return <AndroidPressable \{\.\.\.props\} \/>;/
    );
  });

  it('uses square attachment thumbnails and a native inline video player with save controls', async () => {
    const [appSource, packageSource, mediaPickerSource] = await Promise.all([
      source('App.tsx'),
      source('package.json'),
      source('src/services/mediaPicker.ts'),
    ]);
    const packageJson = JSON.parse(packageSource);

    expect(packageJson.dependencies['expo-video']).toMatch(/^~57\./);
    expect(appSource).toContain('<PendingAttachmentPreview');
    expect(appSource).toMatch(/pendingAttachment:\s*\{[\s\S]*?aspectRatio:\s*1,/);
    expect(appSource).toContain('<VideoView');
    expect(appSource).toContain('fullscreenOptions={{ enable: true }}');
    expect(appSource).toContain(
      'videoActive={!settingsOpen && activeVideoAttachmentId === attachment.id}'
    );
    expect(appSource).toContain('saveAttachmentToDevice(attachment)');
    expect(mediaPickerSource).toContain("base64: Platform.OS === 'web'");
    expect(appSource).not.toContain("createElement('video'");
    expect(appSource).not.toContain('>VIDEO</Text>');
  });
});
