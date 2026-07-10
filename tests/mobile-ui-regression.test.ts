import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

async function source(filePath: string): Promise<string> {
  return readFile(path.resolve(filePath), 'utf8');
}

function pngDimensions(buffer: Buffer): { width: number; height: number } {
  expect(buffer.subarray(1, 4).toString('ascii')).toBe('PNG');
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
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

  it('keeps the model picker above Android system navigation controls', async () => {
    const appSource = await source('App.tsx');

    expect(appSource).toContain('SafeAreaView, useSafeAreaInsets');
    expect(appSource).toContain('const insets = useSafeAreaInsets();');
    expect(appSource).toContain('style={[styles.modelPickerSheet, { paddingBottom: insets.bottom }]}');
    expect(appSource).toContain('style={styles.modelPickerScroll}');
    expect(appSource).toMatch(/modelPickerScroll:\s*\{[\s\S]*?flexShrink:\s*1,[\s\S]*?minHeight:\s*0,/);
  });

  it('uses one seamless folding glyph instead of three bouncing thinking dots', async () => {
    const appSource = await source('App.tsx');

    expect(appSource).toContain('function ThinkingGlyph()');
    expect(appSource).toContain('cancelAnimation(progress)');
    expect(appSource).toContain('<ThinkingGlyph />');
    expect(appSource).toContain('thinkingGlyphBand');
    expect(appSource).not.toContain('function ThinkingDot(');
    expect(appSource).not.toContain('<ThinkingDots />');
    expect(appSource).not.toContain('withDelay(');
  });

  it('uses the production S mark for app, adaptive, themed, splash, and web icons', async () => {
    const [appConfigSource, packageSource] = await Promise.all([
      source('app.json'),
      source('package.json'),
    ]);
    const appConfig = JSON.parse(appConfigSource);
    const packageJson = JSON.parse(packageSource);
    const expo = appConfig.expo;

    expect(expo.backgroundColor).toBe('#F4F4F4');
    expect(expo.icon).toBe('./assets/icon.png');
    expect(expo.android.adaptiveIcon).toMatchObject({
      backgroundColor: '#F4F4F4',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    });
    expect(expo.web.favicon).toBe('./assets/favicon.png');
    expect(expo.plugins).toContainEqual([
      'expo-splash-screen',
      {
        backgroundColor: '#F4F4F4',
        image: './assets/splash-icon.png',
        imageWidth: 184,
        resizeMode: 'contain',
      },
    ]);
    expect(packageJson.dependencies['expo-splash-screen']).toMatch(/^~57\./);

    const expectedSizes = new Map<string, number>([
      ['assets/brand-mark.png', 1024],
      ['assets/icon.png', 1024],
      ['assets/android-icon-foreground.png', 1024],
      ['assets/android-icon-background.png', 1024],
      ['assets/android-icon-monochrome.png', 1024],
      ['assets/splash-icon.png', 1024],
      ['assets/favicon.png', 96],
    ]);

    await Promise.all([...expectedSizes].map(async ([filePath, expectedSize]) => {
      const buffer = await readFile(path.resolve(filePath));
      expect(buffer.byteLength).toBeGreaterThan(4_000);
      expect(pngDimensions(buffer)).toEqual({ width: expectedSize, height: expectedSize });
    }));
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
