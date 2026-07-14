import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createDefaultWorkspace } from '../src/data/providerCatalog';
import {
  createRemoteMcpPlugin,
  prepareRemoteMcpEnable,
} from '../src/features/settings/internal/settingsMcpPolicy';

async function source(filePath: string): Promise<string> {
  return readFile(path.resolve(filePath), 'utf8');
}

function sliceBetween(value: string, start: string, end: string): string {
  const startIndex = value.indexOf(start);
  const endIndex = value.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return value.slice(startIndex, endIndex);
}

describe('MCP approval UI safety regressions', () => {
  it('requires a nonempty exact allowed-tools list and rejects wildcard expectations', async () => {
    const settingsViewSource = await source(
      'src/features/settings/internal/SettingsToolsSectionView.tsx'
    );
    const settingsSource = sliceBetween(
      settingsViewSource,
      '<View style={styles.settingsCard} testID="mcp-tool-center-card">',
      '{notice ? <Text style={styles.settingsNotice}>{notice}</Text> : null}'
    );

    expect(settingsSource).toContain('<Text style={styles.fieldLabel}>允许的精确工具名</Text>');
    expect(settingsSource).toContain('testID="mcp-allowed-tools-input"');
    expect(settingsSource).toContain('value={mcpAllowedTools}');
    expect(settingsSource).toContain('必须至少填写一个工具名；不支持 *、自动导入全部工具或模糊匹配。');
    const provider = createDefaultWorkspace().providers[0];
    expect(
      createRemoteMcpPlugin(
        { name: 'Remote', endpoint: 'https://mcp.example.com', description: '', allowedTools: '*', authorization: '' },
        provider,
        'mcp-1'
      )
    ).toMatchObject({ ok: false, notice: expect.stringContaining('不支持通配符') });
    expect(
      createRemoteMcpPlugin(
        { name: 'Remote', endpoint: 'https://mcp.example.com', description: '', allowedTools: 'read_file, write_file', authorization: '' },
        provider,
        'mcp-2'
      )
    ).toMatchObject({ ok: true, value: { allowedTools: ['read_file', 'write_file'], enabled: false } });
  });

  it('discloses billing, Authorization transmission, per-call approval, and irreversible side effects before enabling', () => {
    const workspace = createDefaultWorkspace();
    const provider = {
      ...workspace.providers[0],
      kind: 'openai-compatible' as const,
      baseUrl: 'https://api.openai.com/v1',
      enabled: true,
    };
    const created = createRemoteMcpPlugin(
      {
        name: 'Remote',
        endpoint: 'https://mcp.example.com',
        description: '',
        allowedTools: 'read_file',
        authorization: 'Bearer secret',
      },
      provider,
      'mcp-1'
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const prepared = prepareRemoteMcpEnable(
      {
        ...workspace,
        providers: [provider],
        activeProviderId: provider.id,
        plugins: [created.value],
      },
      created.value.id
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.title).toBe('授权并启用这个 MCP 服务？');
    expect(prepared.value.description).toContain('MCP Authorization 会随每次请求发送给你选择的 OpenAI 账号');
    expect(prepared.value.description).toContain('OpenAI 和远程 MCP 服务都会接触获批的工具参数，并可能分别计费');
    expect(prepared.value.description).toContain('每次真实工具调用仍会展示完整参数并单独询问，不会记住批准');
    expect(prepared.value.description).toContain('工具可能修改外部数据，批准后的副作用无法由本应用撤销');
  });

  it('revalidates MCP policy and activity after the asynchronous confirmation', async () => {
    const settingsSource = await source(
      'src/features/settings/internal/SettingsToolsSectionView.tsx'
    );
    const toggleSource = sliceBetween(
      settingsSource,
      'async function toggleRemoteMcpServer',
      'function removeRemoteMcpServer'
    );
    const confirmationIndex = toggleSource.indexOf('const confirmed = await requestConfirm({');
    const activityIndex = toggleSource.indexOf('chatActivityRef.current.configurationLocked');
    const revalidationIndex = toggleSource.indexOf(
      'prepareRemoteMcpEnable(session.getSnapshot(), pluginId)'
    );
    const commitIndex = toggleSource.indexOf("type: 'plugin.set-enabled'");

    expect(confirmationIndex).toBeGreaterThanOrEqual(0);
    expect(activityIndex).toBeGreaterThan(confirmationIndex);
    expect(revalidationIndex).toBeGreaterThan(activityIndex);
    expect(commitIndex).toBeGreaterThan(revalidationIndex);
  });

  it('shows complete approval context, raw payload size, three actions, and Android safe-area protection', async () => {
    const [modalSource, decisionSource] = await Promise.all([
      source('src/components/McpApprovalModal.tsx'),
      source('src/features/chat/internal/decisions/useChatRequestDecisions.ts'),
    ]);

    expect(modalSource).toContain("import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';");
    expect(modalSource).toContain('const insets = useSafeAreaInsets();');
    expect(modalSource).toContain('navigationBarTranslucent');
    expect(modalSource).toContain("onRequestClose={() => settleOnce('cancel')}");
    expect(modalSource).toContain('<SafeAreaView style={styles.root}>');
    expect(modalSource).toContain('contentContainerStyle={[styles.content, { paddingBottom: Math.max(24, insets.bottom + 16) }]}');
    expect(modalSource).toContain('style={[styles.footer, { paddingBottom: Math.max(12, insets.bottom) }]}');

    for (const field of [
      'request.providerName',
      'request.modelId',
      'request.serverName',
      'request.serverLabel',
      'request.endpoint',
      'request.toolName',
    ]) {
      expect(modalSource).toContain(field);
    }
    expect(modalSource).toContain('argumentBytes: number;');
    expect(modalSource).toContain('formatByteLength(request.argumentBytes)');
    expect(modalSource).toContain("const exact = `${bytes.toLocaleString('en-US')} B`;");
    expect(decisionSource).toContain('argumentBytes: request.argumentBytes');
    expect(modalSource).toContain('以下为服务商拟发送给 MCP 服务的完整原始参数；内容仅作为文本显示。');
    expect(modalSource).toContain("{request.argumentsText || '{}'}");

    expect(modalSource).toContain("onPress={() => settleOnce('approve')}");
    expect(modalSource).toContain("onPress={() => settleOnce('deny')}");
    expect(modalSource).toContain("onPress={() => settleOnce('cancel')}");
    expect(modalSource).toContain('disabled={decisionPending}');
    expect(modalSource).toContain('<Text style={styles.approveButtonText}>批准一次</Text>');
    expect(modalSource).toContain('<Text style={styles.denyButtonText}>拒绝并继续</Text>');
    expect(modalSource).toContain('<Text style={styles.cancelButtonText}>取消整轮</Text>');
    expect(modalSource).toContain('拒绝并继续：不执行此工具，但会再请求模型继续回答，可能产生额外费用。');
  });

  it('settles an open approval as cancel on Abort and component unmount', async () => {
    const [decisionSource, appSource] = await Promise.all([
      source('src/features/chat/internal/decisions/useChatRequestDecisions.ts'),
      source('src/features/chat/ChatPane.tsx'),
    ]);

    expect(decisionSource).toContain("const onAbort = () => settle('cancel');");
    expect(decisionSource).toContain("signal?.addEventListener('abort', onAbort, { once: true });");
    expect(decisionSource).toContain("signal?.removeEventListener('abort', onAbort);");
    expect(decisionSource).toContain("return Promise.resolve('cancel');");
    expect(decisionSource).toContain('let settled = false;');
    expect(decisionSource).toContain('queue.activate();');
    expect(decisionSource).toContain('return () => queue.dispose();');
    expect(decisionSource).toContain("this.pendingMcp?.settle('cancel');");
    expect(appSource).toContain('chatOrchestration.stop();');
    expect(appSource).toContain('cancelRequestDecisions();');
    expect(appSource).toContain('if (chatOrchestration.current()?.mcpActive)');
    expect(appSource).toContain("应用进入后台，本次 MCP 审批与回答已取消；不会自动重放批准。");
  });

  it('stores only bounded activity metadata and marks post-approval interruption as uncertain', async () => {
    const [messageSource, executionSource] = await Promise.all([
      source('src/features/chat/internal/presentation/ChatMessagePresentation.tsx'),
      source('src/features/chat/internal/requests/ChatRequestExecution.ts'),
    ]);
    const activityPanelSource = sliceBetween(
      messageSource,
      'function McpActivityPanel',
      'function TokenUsageLine'
    );
    const assistantRequestSource = sliceBetween(
      executionSource,
      'async execute({',
      'private providerRequestOperation('
    );

    expect(activityPanelSource).toContain('MCP 工具记录');
    expect(activityPanelSource).toContain('{activity.providerRequestCount} 次发送前登记的请求尝试');
    expect(activityPanelSource).toContain("call.outcome === 'unknown'");
    expect(activityPanelSource).toContain('外部副作用可能已经发生，本应用无法确认或撤销');
    expect(assistantRequestSource).toContain("outcome: 'unknown'");
    expect(assistantRequestSource).toContain('mcpActivity: pendingMcpActivity');
    expect(assistantRequestSource).not.toContain('rawArguments: request.rawArguments');
  });

  it('keeps Web Search and comparison mutually exclusive with MCP in both toggle directions', async () => {
    const appSource = await source('src/features/chat/ChatPane.tsx');
    const comparisonToggleSource = sliceBetween(
      appSource,
      'function setComparisonEnabled',
      'function hasBlockingMcpForSearch'
    );
    const searchToggleSource = sliceBetween(
      appSource,
      'function applyComposerSearchMode',
      'const composerSearchSummary'
    );
    const comparisonSendSource = sliceBetween(
      appSource,
      'async function sendComparisonMessage',
      'async function sendMessage'
    );

    expect(comparisonToggleSource).toContain("plugin.type === 'remote-mcp'");
    expect(comparisonToggleSource).toContain('plugin.enabled === true');
    expect(comparisonToggleSource).toContain('请先关闭对比目标绑定的 MCP');
    expect(searchToggleSource).toContain('hasBlockingMcpForSearch');
    expect(searchToggleSource).toContain('请先关闭当前服务商的 MCP');

    const workspace = createDefaultWorkspace();
    const provider = {
      ...workspace.providers[0],
      kind: 'openai-compatible' as const,
      baseUrl: 'https://api.openai.com/v1',
      enabled: true,
    };
    const created = createRemoteMcpPlugin(
      { name: 'Remote', endpoint: 'https://mcp.example.com', description: '', allowedTools: 'read_file', authorization: '' },
      provider,
      'mcp-1'
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const base = {
      ...workspace,
      providers: [provider],
      activeProviderId: provider.id,
      plugins: [created.value],
    };
    expect(prepareRemoteMcpEnable({ ...base, webSearch: { ...base.webSearch, enabled: true } }, 'mcp-1'))
      .toMatchObject({ ok: false, notice: expect.stringContaining('关闭联网搜索') });
    expect(prepareRemoteMcpEnable({
      ...base,
      comparisonEnabled: true,
      comparisonTargets: [{ providerId: provider.id, modelId: 'model-a' }],
    }, 'mcp-1')).toMatchObject({ ok: false, notice: expect.stringContaining('关闭多模型对比') });
    expect(comparisonSendSource).toContain('对比请求未发出：v1.4 的 MCP 与多模型对比互斥');
  });

  it('authorizes each continuation charge before persisting providerRequestCount plus one', async () => {
    const appSource = await source(
      'src/features/chat/internal/requests/ChatRequestExecution.ts'
    );
    const continuationSource = sliceBetween(
      appSource,
      'beforeContinuation: async (context) => {',
      'onStreamUpdate: (update) => {'
    );

    const authorizationIndex = continuationSource.indexOf('const authorized = await this.host.authorize({');
    const incrementIndex = continuationSource.indexOf(
      'providerRequestCount: trackedUsageEvent.providerRequestCount + 1'
    );
    const persistenceIndex = continuationSource.indexOf('await this.host.persistUsageEvents([nextUsageEvent]);');
    expect(authorizationIndex).toBeGreaterThanOrEqual(0);
    expect(incrementIndex).toBeGreaterThan(authorizationIndex);
    expect(persistenceIndex).toBeGreaterThan(incrementIndex);
    expect(continuationSource).toContain('if (!authorized || context.signal?.aborted)');
    expect(continuationSource).toContain('trackedUsageEvent = nextUsageEvent;');
  });

  it('authorizes and records every external-search model continuation', async () => {
    const appSource = await source(
      'src/features/chat/internal/requests/ChatRequestExecution.ts'
    );
    const continuationSource = sliceBetween(
      appSource,
      'beforeExternalSearchProviderRequest: async (context) => {',
      '...(mcpPlugin'
    );

    const authorizationIndex = continuationSource.indexOf(
      'const authorized = await this.host.authorize({'
    );
    const countIndex = continuationSource.indexOf(
      'providerRequestCount: context.requestNumber'
    );
    const persistenceIndex = continuationSource.indexOf(
      'await this.host.persistUsageEvents([nextUsageEvent]);'
    );
    expect(continuationSource).toContain(
      'if (context.requestNumber <= trackedUsageEvent.providerRequestCount)'
    );
    expect(authorizationIndex).toBeGreaterThanOrEqual(0);
    expect(countIndex).toBeGreaterThan(authorizationIndex);
    expect(persistenceIndex).toBeGreaterThan(countIndex);
    expect(continuationSource).toContain('trackedUsageEvent = nextUsageEvent;');
    expect(continuationSource).toContain('this.assertCurrentProviderSendAllowed(controller, context.signal);');
  });

  it('passes only enabled provider-bound plugins and revalidates official routing plus model MCP capability', async () => {
    const [appSource, routeSource] = await Promise.all([
      source('src/features/chat/internal/requests/ChatRequestExecution.ts'),
      source('src/services/openAiCompatible.ts'),
    ]);
    const enabledFilterSource = sliceBetween(
      appSource,
      'export function enabledRemoteMcpPluginsForProvider(',
      '/**\n * Owns a provider call'
    );
    const assistantRequestSource = sliceBetween(
      appSource,
      'async execute({',
      'private providerRequestOperation('
    );
    const mcpRouteSource = sliceBetween(
      routeSource,
      'if (mcp) {',
      "if (webSearch?.enabled) {\n    if (!provider.apiKey?.trim())"
    );

    expect(enabledFilterSource).toContain("plugin.type === 'remote-mcp'");
    expect(enabledFilterSource).toContain('plugin.enabled === true');
    expect(enabledFilterSource).toContain('plugin.providerId === providerId');
    expect(assistantRequestSource).toContain('const enabledMcpPlugins = enabledRemoteMcpPluginsForProvider(');
    expect(assistantRequestSource).toContain('const mcpPlugin = enabledMcpPlugins[0];');
    expect(assistantRequestSource).toContain('...(mcpPlugin');
    expect(assistantRequestSource).toContain('plugin: mcpPlugin');

    expect(mcpRouteSource).toContain('if (!isOfficialOpenAiProvider(provider))');
    expect(mcpRouteSource).toContain("if (!requestModel.capabilities.includes('mcp'))");
    expect(mcpRouteSource.indexOf('if (!isOfficialOpenAiProvider(provider))')).toBeLessThan(
      mcpRouteSource.indexOf('const run = await runOpenAiProviderMcp({')
    );
    expect(mcpRouteSource.indexOf("if (!requestModel.capabilities.includes('mcp'))")).toBeLessThan(
      mcpRouteSource.indexOf('const run = await runOpenAiProviderMcp({')
    );
  });
});
