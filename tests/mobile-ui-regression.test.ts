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

  it('keeps multi-model comparison group-scoped and explicit about provider billing', async () => {
    const appSource = await source('App.tsx');
    const comparisonSource = appSource.slice(
      appSource.indexOf('async function sendComparisonMessage'),
      appSource.indexOf('async function sendMessage')
    );

    expect(appSource).toContain("const comparisonGroupId = createId('compare');");
    expect(appSource).toContain('await Promise.all(');
    expect(appSource).toContain('finishRequest: false');
    expect(appSource).toContain('finishActiveRequest(controller);');
    expect(appSource).toContain('applyComparisonSelection(comparisonGroupId');
    expect(appSource).toContain('以此回答继续');
    expect(appSource).toContain('费用由对应服务商从你的账户结算');
    expect(comparisonSource.indexOf('assertProviderWebSearchMessagesSupported')).toBeGreaterThan(-1);
    expect(comparisonSource.indexOf('assertProviderWebSearchMessagesSupported')).toBeLessThan(
      comparisonSource.indexOf("beginActiveRequest('多模型对比')")
    );
  });

  it('exposes only evidence-backed provider search with visible clickable citations', async () => {
    const [appSource, searchSource] = await Promise.all([
      source('App.tsx'),
      source('src/services/providerWebSearch.ts'),
    ]);

    expect(appSource).toContain('function WebCitationList');
    expect(appSource).toContain('accessibilityRole="link"');
    expect(appSource).toContain('本次响应未提供已触发联网搜索的证据');
    expect(searchSource).toContain("item.type === 'web_search_call'");
    expect(searchSource).toContain('usage.x_tools.web_search.count');
  });

  it('ships the local productivity centers without an app-owned service dependency', async () => {
    const appSource = await source('App.tsx');

    expect(appSource).toContain('testID="prompt-library-settings-card"');
    expect(appSource).toContain('testID="usage-dashboard-card"');
    expect(appSource).toContain('testID="media-task-center-card"');
    expect(appSource).toContain('testID="encrypted-backup-card"');
    expect(appSource).toContain('testID="mcp-tool-center-card"');
    expect(appSource).toContain('默认关闭且不会自动调用');
    expect(appSource).toContain('API Key 不从备份导入');
  });

  it('keeps request-based voice Android-only and disables background audio services', async () => {
    const [appSource, appConfigSource, audioSource] = await Promise.all([
      source('App.tsx'),
      source('app.json'),
      source('src/services/providerAudio.ts'),
    ]);
    const appConfig = JSON.parse(appConfigSource);

    const imagePickerPlugin = appConfig.expo.plugins.find(
      (plugin: unknown) => Array.isArray(plugin) && plugin[0] === 'expo-image-picker'
    );
    expect(imagePickerPlugin?.[1]).toMatchObject({ cameraPermission: false });
    expect(imagePickerPlugin?.[1]).not.toHaveProperty('microphonePermission');

    expect(appConfig.expo.plugins).toContainEqual([
      'expo-audio',
      {
        microphonePermission: '允许 Embezzle Studio 录制语音并发送给你选择的服务商进行转写。',
        enableBackgroundRecording: false,
        enableBackgroundPlayback: false,
      },
    ]);
    expect(appSource).toContain('语音已转写到输入框，尚未自动发送');
    expect(appSource).toContain('正在播放 AI 合成语音');
    expect(appSource).toContain('activeAudioOperationRef.current = operation');
    expect(appSource).toContain('应用进入后台，录音已停止并丢弃，未发送给任何服务商');
    expect(audioSource).toContain("if (platform !== 'android')");
    expect(audioSource).toContain('An API key supplied by the user is required');
    expect(audioSource).toContain('buildOpenAiFileBackedTranscriptionRequest');
  });
});
