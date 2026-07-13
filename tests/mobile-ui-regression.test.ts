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

    expect(appConfig.expo.android.allowBackup).toBe(false);
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
    expect(appSource).toContain('{settingsMounted && activeProvider ? (');
    expect(appSource).toContain('<SettingsScreen');
    expect(appSource).toContain('style={[styles.screenPane, settingsOpen && styles.screenPaneHidden]}');
    expect(appSource).toContain('Keyboard.dismiss();');
    expect(appSource).toMatch(
      /if \(Platform\.OS === 'android'\) \{\s*return <AndroidPressable \{\.\.\.props\} \/>;/
    );
  });

  it('uses static Android fallbacks for reusable settings motion and press controls', async () => {
    const [pressableSource, motionSource] = await Promise.all([
      source('src/ui/components/AnimatedPressable.tsx'),
      source('src/ui/components/Motion.tsx'),
    ]);

    expect(pressableSource).toMatch(
      /export function AnimatedPressable[\s\S]*?if \(Platform\.OS === 'android'\) \{\s*return <AndroidPressable \{\.\.\.props\} \/>;/
    );
    const androidPressableSource = pressableSource.slice(
      pressableSource.indexOf('function AndroidPressable('),
      pressableSource.indexOf('function AnimatedPressableImpl('),
    );
    expect(androidPressableSource).toContain('<Pressable');
    expect(androidPressableSource).not.toContain('useSharedValue(');
    expect(androidPressableSource).not.toContain('createAnimatedComponent');

    expect(motionSource).toMatch(
      /export function MotionSwitch[\s\S]*?Platform\.OS === 'android'[\s\S]*?<StaticMotionSwitch \{\.\.\.props\} \/>/
    );
    expect(motionSource).toMatch(
      /export function MotionItem[\s\S]*?Platform\.OS === 'android'[\s\S]*?return <View style=\{props\.style\}>\{props\.children\}<\/View>/
    );
    expect(motionSource).toMatch(
      /export function MotionPresence[\s\S]*?Platform\.OS === 'android'[\s\S]*?props\.visible \? <View/
    );
    expect(motionSource).toMatch(
      /export function MotionSwap[\s\S]*?Platform\.OS === 'android'[\s\S]*?<View style=\{props\.contentStyle\}>/
    );
  });

  it('routes Android back through the settings stack and resets hidden sensitive state on close', async () => {
    const [appSource, settingsSource, providerDetailSource] = await Promise.all([
      source('App.tsx'),
      source('src/ui/screens/SettingsScreen.tsx'),
      source('src/ui/screens/settings/ProviderDetailScreen.tsx'),
    ]);

    expect(settingsSource).toContain('export interface SettingsScreenHandle');
    expect(settingsSource).toContain('handleBack: () => boolean;');
    expect(settingsSource).toContain('resetNavigation: () => void;');
    expect(settingsSource).toContain('openToolsSection: (section: SettingsToolsSection) => void;');
    expect(settingsSource).toContain('useImperativeHandle(ref');
    expect(settingsSource).toContain("setStack([{ key: 'main' }]);");
    expect(settingsSource).toContain("openToolsSection: (section: SettingsToolsSection) => {");

    expect(appSource).toContain('useRef<SettingsScreenHandle>(null)');
    expect(appSource).toContain('ref={settingsScreenRef}');
    expect(appSource).toContain('settingsScreenRef.current?.handleBack()');
    expect(appSource).toContain('settingsScreenRef.current?.resetNavigation()');
    expect(appSource).toContain("settingsScreenRef.current?.openToolsSection('webSearch')");
    expect(appSource).toMatch(
      /if \(settingsOpen\) \{[\s\S]*?settingsScreenRef\.current\?\.handleBack\(\)[\s\S]*?closeSettings\(\);[\s\S]*?return true;/
    );
    expect(providerDetailSource).toMatch(
      /useEffect\(\(\) => \{[\s\S]*?setShowKey\(false\);[\s\S]*?\}, \[provider\.id\]\);/
    );
    expect(providerDetailSource).toContain('key={provider.id}');
  });

  it('keeps the model picker above Android system navigation controls', async () => {
    const appSource = await source('App.tsx');

    expect(appSource).toContain('SafeAreaView, useSafeAreaInsets');
    expect(appSource).toContain('const insets = useSafeAreaInsets();');
    expect(appSource).toContain('style={[styles.modelPickerSheet, { paddingBottom: insets.bottom }]}');
    expect(appSource).toContain('style={styles.modelPickerScroll}');
    expect(appSource).toMatch(/modelPickerScroll:\s*\{[\s\S]*?flexShrink:\s*1,[\s\S]*?minHeight:\s*0,/);
  });

  it('turns empty model selection and provider discovery into navigable settings flows', async () => {
    const [appSource, settingsSource, providerDetailSource] = await Promise.all([
      source('App.tsx'),
      source('src/ui/screens/SettingsScreen.tsx'),
      source('src/ui/screens/settings/ProviderDetailScreen.tsx'),
    ]);

    expect(appSource).toContain('testID="model-picker-open-providers"');
    expect(appSource).toContain('testID="model-picker-open-models"');
    expect(appSource).toContain("onOpenProviders={() => openSettingsDestination({ key: 'providers' })}");
    expect(appSource).toContain("onOpenModels={() => openSettingsDestination({ key: 'providerModels' })}");
    expect(appSource).toContain('pendingSettingsDestination');
    expect(appSource).toContain('settings.openActiveProviderModels()');

    expect(settingsSource).toContain("| { key: 'providerModels' }");
    expect(settingsSource).toContain('openProviders: () => void;');
    expect(settingsSource).toContain('openActiveProviderModels: () => void;');
    expect(settingsSource).toContain('openToolsSection: (section: SettingsToolsSection) => void;');
    expect(settingsSource).toContain("{ key: 'providerDetail' },");
    expect(settingsSource).toContain("{ key: 'providerModels' },");

    expect(providerDetailSource).toContain('testID="provider-models-entry"');
    expect(providerDetailSource).toContain('已获取 ${candidateModelCount} 个模型候选');
    expect(providerDetailSource).toContain('前往模型配置');
    expect(providerDetailSource).toContain('export function ProviderModelsScreen');
    expect(providerDetailSource).not.toContain('bottomTabs');
    expect(providerDetailSource).not.toContain('function TabButton(');
  });

  it('keeps model discovery success transient while preserving Ark risk warnings', async () => {
    const appSource = await source('App.tsx');
    const refreshSource = appSource.slice(
      appSource.indexOf('async function refreshModels()'),
      appSource.indexOf('function resetComposerForConversationChange()')
    );

    expect(refreshSource).toContain("if (result.tone === 'success')");
    expect(refreshSource).toContain("setNotice('');");
    expect(refreshSource).toContain('showToast(result.notice);');
    expect(refreshSource).toMatch(/else \{\s*setNotice\(result\.notice\);\s*\}/);
  });

  it('keeps the parameter panel reachable and dismisses the keyboard by dragging', async () => {
    const appSource = await source('App.tsx');
    const menuSource = appSource.slice(
      appSource.indexOf('{parameterMenuOpen && canConfigureParameters ? ('),
      appSource.indexOf('<View style={styles.composer}>')
    );

    expect(appSource).toContain('const parameterMenuMaxHeight = composerLayoutY > 0');
    expect(appSource).toContain('Math.max(0, Math.floor(composerLayoutY - 12))');
    expect(appSource).not.toContain('Math.max(120, Math.floor(composerLayoutY - 12))');
    expect(appSource).toContain('onLayout={(event) => setComposerLayoutY(event.nativeEvent.layout.y)}');
    expect(menuSource).toContain('testID="parameter-menu-scroll"');
    expect(menuSource).toContain("keyboardDismissMode={Platform.OS === 'android' ? 'on-drag' : 'interactive'}");
    expect(menuSource).toContain('keyboardShouldPersistTaps="handled"');
    expect(menuSource).toContain('onScrollBeginDrag={Keyboard.dismiss}');
    expect(menuSource).toContain('maxHeight: parameterMenuMaxHeight');
    expect(appSource).toContain('onSubmitEditing={Keyboard.dismiss}');
    expect(appSource).toMatch(/accessibilityLabel="调整生成参数"[\s\S]*?Keyboard\.dismiss\(\);/);
  });

  it('exposes a composer search sheet with service rows and dynamic globe icon', async () => {
    const [appSource, panelSource] = await Promise.all([
      source('App.tsx'),
      source('src/ui/components/SearchServicesPanel.tsx'),
    ]);
    expect(appSource).toContain('testID="composer-search-globe"');
    expect(appSource).toContain('ComposerSearchSheet');
    expect(appSource).toContain('SearchServiceIcon');
    expect(appSource).toContain('resolveActiveSearchIconKind');
    expect(appSource).toContain('SearchServicesPanel');
    expect(appSource).toContain("function applyComposerSearchMode(");
    expect(panelSource).toContain('testID="composer-search-menu"');
    expect(panelSource).toContain('testID="composer-search-tags"');
    expect(panelSource).toContain('testID="composer-search-toggle"');
    expect(panelSource).toContain('搜索设置');
    expect(panelSource).toContain('网络搜索');
    expect(panelSource).toContain('服务商内置');
    expect(panelSource).toContain('composerSheet');
    expect(panelSource).toContain('serviceCard');
    expect(panelSource).toContain('masterCard');
    expect(panelSource).toContain('export function ComposerSearchSheet');
    expect(panelSource).toContain('export function SearchServiceIcon');
    expect(panelSource).toContain("variant?: 'badge' | 'toolbar'");
    expect(panelSource).toContain('Bing.Color');
    expect(panelSource).toContain('Tavily.Color');
    expect(panelSource).toContain('BraveMark');
    expect(panelSource).toContain('FirecrawlMark');
    expect(panelSource).toContain('SectionCard');
    expect(panelSource).toContain('openAdd');
    expect(panelSource).toContain('testID="search-service-row-builtin"');
    expect(panelSource).toContain('testID="search-service-actions"');
    expect(panelSource).toContain('测试连接');
    expect(panelSource).toContain('onLongPress');
    expect(panelSource).toContain('openEditForm(service)');
    expect(panelSource).toContain('对话页点地球图标');
    expect(panelSource).not.toContain('onSelectExternalService');
    expect(panelSource).not.toContain('onSetProviderEnabled');
    expect(panelSource).toContain("kind === 'bing' || kind === 'duckduckgo'");
    expect(panelSource).toContain('bing');
    expect(panelSource).toContain('duckduckgo');
    expect(panelSource).toContain('firecrawl');
    expect(panelSource).toContain('externalSearchProviderAllowsAnonymous');
    expect(panelSource).not.toContain('免费 · 点按选用');
    expect(appSource).not.toContain('testID="composer-search-chip"');
    expect(appSource).toContain('testID="search-service-add"');
    expect(appSource).toContain("variant=\"toolbar\"");
    expect(appSource).toContain("openToolsSection('webSearch')");
    expect(appSource).toContain('isExternalSearchServiceConfigured');
    expect(appSource).toContain('renderToolsHeaderRight');
  });

  it('renders assistant message content as Markdown', async () => {
    const [appSource, mdSource] = await Promise.all([
      source('App.tsx'),
      source('src/ui/components/MessageMarkdown.tsx'),
    ]);
    expect(appSource).toContain('MessageMarkdown');
    expect(appSource).toContain('<MessageMarkdown content={message.content} />');
    expect(mdSource).toContain('react-native-markdown-display');
    expect(mdSource).toContain('export function MessageMarkdown');
  });

  it('renders modular thinking and tool activity cards instead of three bouncing dots', async () => {
    const [appSource, activityUiSource, activitySource] = await Promise.all([
      source('App.tsx'),
      source('src/ui/components/MessageActivityModules.tsx'),
      source('src/services/messageActivity.ts'),
    ]);

    expect(appSource).toContain('<MessageActivityModules message={message} />');
    expect(activityUiSource).toContain('testID="message-activity-modules"');
    expect(activityUiSource).toContain('testID="search-step-detail"');
    expect(activityUiSource).toContain('reasoningCard');
    expect(activityUiSource).toContain('Lightbulb');
    expect(activityUiSource).toContain('MessageMarkdown');
    expect(activityUiSource).toContain("variant=\"muted\"");
    expect(activityUiSource).toContain('SearchStepDetail');
    expect(activityUiSource).toContain('展开');
    expect(activityUiSource).toContain('useState(false)');
    expect(activityUiSource).not.toContain("useState(module.status === 'running')");
    expect(activitySource).toContain('深度思考');
    expect(activitySource).toContain('formatSearchActivityTitle');
    expect(activitySource).toContain('parseSearchToolDetail');
    expect(activitySource).toContain('activityTimeline');
    expect(activitySource).toContain('isSearchToolName');
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

  it('guides unconfigured comparison and offers local project presets without network defaults', async () => {
    const [appSource, presetSource] = await Promise.all([
      source('App.tsx'),
      source('src/data/workspaceProjectPresets.ts'),
    ]);
    const comparisonHandler = appSource.slice(
      appSource.indexOf('async function handleComposerComparisonPress()'),
      appSource.indexOf('function setWebSearchEnabled(')
    );
    const projectCreation = appSource.slice(
      appSource.indexOf('function createProjectFromInput('),
      appSource.indexOf('function saveActiveProject(')
    );

    expect(comparisonHandler).toContain("title: '先设置对比模型'");
    expect(comparisonHandler).toContain("confirmLabel: '去设置'");
    expect(comparisonHandler).toContain("openSettingsDestination({ key: 'tools', section: 'comparison' })");
    expect(appSource).toContain('onPress={() => { void handleComposerComparisonPress(); }}');
    expect(appSource).toContain('key={`compare-provider:${provider.id}`}');
    expect(appSource).toContain('workspace.providers.filter(isProviderEnabled)');
    expect(appSource).toContain('onPress={() => setComparisonConfigProviderId(provider.id)}');
    expect(appSource).not.toContain('onPress={() => selectProvider(provider.id)}');

    expect(appSource).toContain('workspaceProjectPresets.map((preset) => (');
    expect(appSource).toContain('预设只写入本机项目指令');
    expect(projectCreation).toContain('projectInstructionMessage(project, now)');
    expect(projectCreation).toContain('conversations: sortConversations');
    expect(presetSource).not.toContain('defaultTarget');
    expect(presetSource).not.toContain('apiKey');
    expect(presetSource).not.toContain('baseUrl');
  });

  it('exposes only evidence-backed provider search with visible clickable citations', async () => {
    const [appSource, searchSource] = await Promise.all([
      source('App.tsx'),
      source('src/services/providerWebSearch.ts'),
    ]);

    expect(appSource).toContain('function WebCitationList');
    expect(appSource).toContain('testID="web-citation-chip"');
    expect(appSource).toContain('testID="web-citation-sheet"');
    expect(appSource).toContain('个引用');
    expect(appSource).toContain('搜索结果');
    expect(appSource).toContain('accessibilityRole="link"');
    expect(await source('src/services/messageActivity.ts')).toContain(
      '响应未提供已触发联网搜索的证据'
    );
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

  it('exposes local projects, branching, and bounded global search without a hosted index', async () => {
    const [appSource, branchSource, searchSource] = await Promise.all([
      source('App.tsx'),
      source('src/services/conversationBranches.ts'),
      source('src/services/workspaceSearch.ts'),
    ]);

    expect(appSource).toContain('testID="project-workspace-settings-card"');
    expect(appSource).toContain('testID="project-switcher"');
    expect(appSource).toContain('testID="global-search-results"');
    expect(appSource).toContain('forkConversationAtMessage(');
    expect(appSource).toContain('创建分支');
    expect(branchSource).toContain('originMessageId: message.originMessageId ?? message.id');
    expect(searchSource).toContain('MAX_WORKSPACE_SEARCH_DOCUMENTS = 1_500');
    expect(searchSource).toContain('MAX_WORKSPACE_SEARCH_FIELD_LENGTH = 4_000');
    expect(searchSource).not.toContain('ProviderProfile');
    expect(searchSource).not.toContain('apiKey');
  });

  it('keeps provider setup and cost limits user-funded, local, and confirmed before requests', async () => {
    const [appSource, providerDetailSource] = await Promise.all([
      source('App.tsx'),
      source('src/ui/screens/settings/ProviderDetailScreen.tsx'),
    ]);
    const sendSource = appSource.slice(
      appSource.indexOf('async function sendMessage'),
      appSource.indexOf('function toggleSettingsScreen')
    );
    const requestSource = appSource.slice(
      appSource.indexOf('async function runAssistantRequest'),
      appSource.indexOf('function toggleReasoning')
    );

    expect(providerDetailSource).toContain('testID="provider-setup-wizard-card"');
    expect(providerDetailSource).toContain('testID="model-capability-tags-card"');
    expect(providerDetailSource).toContain('不会使用 Embezzle Studio 的额度或服务器');
    const tagSource = await source('src/ui/utils/modelDisplay.ts');
    expect(tagSource).toContain('export function modelCapabilityTags');
    expect(tagSource).toContain("'image-input': '视觉'");
    expect(appSource).toContain('testID="cost-guard-settings-card"');
    expect(appSource).toContain('Free / Trial 字样 ≠ 免费额度');
    expect(appSource).toContain('providerKeyBindingFingerprint !== finalFingerprint');
    expect(sendSource.indexOf('authorizeProviderRequestPlan')).toBeGreaterThan(-1);
    expect(sendSource.indexOf('authorizeProviderRequestPlan')).toBeLessThan(
      sendSource.indexOf("beginActiveRequest('回答生成', { mcpActive })")
    );
    expect(sendSource.indexOf('persistProviderUsageEvents')).toBeLessThan(
      sendSource.indexOf('runAssistantRequest')
    );
    expect(requestSource).toContain('maxOutputTokens: workspaceRef.current.costGuard.enabled');
  });

  it('blocks provider changes and media refreshes across every active provider runtime', async () => {
    const appSource = await source('App.tsx');
    const idleGateSource = appSource.slice(
      appSource.indexOf('function ensureProviderConfigurationIdle()'),
      appSource.indexOf('function beginActiveRequest('),
    );
    const toggleProviderSource = appSource.slice(
      appSource.indexOf('function toggleProviderEnabled('),
      appSource.indexOf('function selectProvider('),
    );
    const refreshTaskSource = appSource.slice(
      appSource.indexOf('async function refreshGenerationTask('),
      appSource.indexOf('function refreshTaskCenterItem('),
    );

    expect(idleGateSource).toContain('activeRequestRef.current');
    expect(idleGateSource).toContain('activeAudioOperationRef.current');
    expect(idleGateSource).toContain('generationTaskControllersRef.current.size > 0');
    expect(toggleProviderSource).toContain(
      'if (!ensureWorkspaceWritable() || !ensureProviderConfigurationIdle())'
    );

    const providerLookupIndex = refreshTaskSource.indexOf(
      'workspaceRef.current.providers.find((item) => item.id === task.providerId)'
    );
    const disabledGateIndex = refreshTaskSource.indexOf('if (!isProviderEnabled(provider))');
    const requestIndex = refreshTaskSource.indexOf('queryGenerationTask(provider, task, controller.signal)');
    expect(providerLookupIndex).toBeGreaterThan(-1);
    expect(disabledGateIndex).toBeGreaterThan(providerLookupIndex);
    expect(requestIndex).toBeGreaterThan(disabledGateIndex);
  });

  it('keeps v1.2 cross-feature state coherent under streaming, rebinding, and navigation', async () => {
    const [appSource, branchSource] = await Promise.all([
      source('App.tsx'),
      source('src/services/conversationBranches.ts'),
    ]);
    const ledgerSource = appSource.slice(
      appSource.indexOf('async function persistProviderUsageEvents'),
      appSource.indexOf('function requestUsageKind')
    );

    expect(appSource).toContain('const setWorkspace = useCallback');
    expect(appSource.indexOf('workspaceRef.current = next;')).toBeLessThan(
      appSource.indexOf('setWorkspaceState(next);')
    );
    expect(appSource).toContain('providerKeyBindingFingerprint !== finalFingerprint');
    expect(appSource).toContain("delete pendingMessage.originMessageId");
    expect(branchSource).toContain("source.messages[branchPointIndex].status === 'pending'");
    expect(appSource).toContain('userAlreadySelected');
    expect(appSource).toContain('InteractionManager.runAfterInteractions');
    expect(appSource).toContain('searchWorkspaceIndex(globalSearchIndex');
    expect(appSource).toContain('scrollToSearchMessage');
    expect(appSource).toContain('highlightedSearchMessageId === message.id');
    expect(appSource).toContain("Platform.OS === 'android' ? 120 : 60");
    expect(ledgerSource).toContain('insertedEventIds');
    expect(ledgerSource).toContain('providerUsageEvents: workspaceRef.current.providerUsageEvents.filter');
  });

  it('revalidates project defaults and audio model tasks at the point of use', async () => {
    const appSource = await source('App.tsx');

    expect(appSource).toContain('syncProjectInstructionSnapshot');
    expect(appSource).toContain('resolveProjectDefaultTarget(project, workspace.providers)');
    expect(appSource).toContain("? 'audio-transcription'");
    expect(appSource).toContain(": 'speech-generation';");
    expect(appSource).toContain('inferModelTask(model) !== expectedTask');
    expect(appSource).toContain('跨项目的资料选择、分支关联和来源追踪已安全清理');
  });

  it('removes only the selected system instruction and preserves later conversation history', async () => {
    const appSource = await source('App.tsx');
    const handlerSource = appSource.slice(
      appSource.indexOf('async function removeSystemInstruction'),
      appSource.indexOf('async function removeMessage')
    );
    const systemCardSource = appSource.slice(
      appSource.indexOf(") : message.role === 'system' ? ("),
      appSource.indexOf('<AssistantMessageHeader')
    );

    expect(handlerSource).toContain("message.role !== 'system'");
    expect(handlerSource).toContain(
      'messages.filter((candidate) => candidate.id !== message.id)'
    );
    expect(handlerSource).toContain('messages: removeFrom(current.messages)');
    expect(handlerSource).toContain('messages: removeFrom(conversation.messages)');
    expect(handlerSource).not.toContain('.slice(0,');
    expect(handlerSource).not.toContain('deletePersistedAttachments');
    expect(systemCardSource).toContain(
      'onPress={() => void removeSystemInstruction(message)}'
    );
    expect(systemCardSource).not.toContain('removeMessage(message)');
  });

  it('keeps assistant editing unavailable in both direct and overflow message actions', async () => {
    const appSource = await source('App.tsx');
    const editHandlerSource = appSource.slice(
      appSource.indexOf('function beginEditUserMessage'),
      appSource.indexOf('function cancelEditUserMessage')
    );
    const directActionsSource = appSource.slice(
      appSource.indexOf('function MessageActions('),
      appSource.indexOf('function MessageInlineEditor(')
    );
    const overflowActionsSource = appSource.slice(
      appSource.indexOf('function MessageActionMenu('),
      appSource.indexOf('function WebCitationList(')
    );

    expect(editHandlerSource).toContain("if (message.role !== 'user')");
    expect(directActionsSource).toContain("{role === 'assistant' ? (");
    expect(directActionsSource).toContain('accessibilityLabel="分享消息"');
    expect(directActionsSource).toContain('accessibilityLabel="编辑消息"');
    expect(overflowActionsSource).toContain("{role === 'user' ? (");
    expect(overflowActionsSource).toContain('onPress={onEdit}');
  });

  it('clears removed model references from comparison, voice, and reasoning prefs', async () => {
    // Settings redesign no longer exposes in-place model task/capability overrides.
    // Reference cleanup still happens when a model is removed from a provider.
    const appSource = await source('App.tsx');
    const removeModelSource = appSource.slice(
      appSource.indexOf('function removeModel('),
      appSource.indexOf('async function refreshModels(')
    );

    expect(removeModelSource).toContain(
      'const comparisonTargets = current.comparisonTargets.filter('
    );
    expect(removeModelSource).toContain('delete voice.transcriptionTarget');
    expect(removeModelSource).toContain('delete voice.speechTarget');
    expect(removeModelSource).toContain(
      'delete reasoningEffortByModel[`${activeProvider.id}:${modelId}`]'
    );
    expect(removeModelSource).toContain(
      'comparisonEnabled: current.comparisonEnabled && comparisonTargets.length >= 2'
    );
    // Removing a model may clear a project default that pointed at it.
    expect(removeModelSource).toContain('defaultTarget');
    expect(removeModelSource).toContain('projects:');
  });

  it('keeps manual model task and capability overrides available after the settings redesign', async () => {
    const [appSource, settingsSource, providerDetailSource] = await Promise.all([
      source('App.tsx'),
      source('src/ui/screens/SettingsScreen.tsx'),
      source('src/ui/screens/settings/ProviderDetailScreen.tsx'),
    ]);

    expect(appSource).toContain('function setActiveModelTask(');
    expect(appSource).toContain('function toggleActiveModelCapability(');
    expect(providerDetailSource).toContain('testID="active-model-overrides-card"');
    expect(providerDetailSource).toContain('>模型用途</Text>');
    expect(providerDetailSource).toContain('能力覆盖');
    expect(providerDetailSource).toContain('自动识别不准确时可手动覆盖');
    expect(settingsSource).toContain('onSetActiveModelTask={props.onSetActiveModelTask}');
    expect(settingsSource).toContain(
      'onToggleActiveModelCapability={props.onToggleActiveModelCapability}'
    );
    expect(appSource).toContain('onSetActiveModelTask={setActiveModelTask}');
    expect(appSource).toContain(
      'onToggleActiveModelCapability={toggleActiveModelCapability}'
    );
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
