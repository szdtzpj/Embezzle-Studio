import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

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
    const appSource = await source('App.tsx');
    const settingsSource = sliceBetween(
      appSource,
      '<View style={styles.settingsCard} testID="mcp-tool-center-card">',
      '{notice ? <Text style={styles.settingsNotice}>{notice}</Text> : null}'
    );
    const addServerSource = sliceBetween(
      appSource,
      'function addRemoteMcpServer()',
      'async function toggleRemoteMcpServer'
    );

    expect(settingsSource).toContain('<Text style={styles.fieldLabel}>允许的精确工具名</Text>');
    expect(settingsSource).toContain('testID="mcp-allowed-tools-input"');
    expect(settingsSource).toContain('value={mcpAllowedTools}');
    expect(settingsSource).toContain('必须至少填写一个工具名；不支持 *、自动导入全部工具或模糊匹配。');
    expect(addServerSource).toContain('const allowedTools = normalizeMcpAllowedTools(');
    expect(addServerSource).toContain('if (!allowedTools.length)');
    expect(addServerSource).toContain('请填写至少一个精确工具名；使用逗号或换行分隔，不支持通配符。');
    expect(addServerSource.indexOf('if (!allowedTools.length)')).toBeLessThan(
      addServerSource.indexOf('setWorkspace((current) =>')
    );
  });

  it('discloses billing, Authorization transmission, per-call approval, and irreversible side effects before enabling', async () => {
    const appSource = await source('App.tsx');
    const toggleSource = sliceBetween(
      appSource,
      'async function toggleRemoteMcpServer',
      'function removeRemoteMcpServer'
    );

    expect(toggleSource).toContain("'授权并启用这个 MCP 服务？'");
    expect(toggleSource).toContain('MCP Authorization 会随每次请求发送给你选择的 OpenAI 账号');
    expect(toggleSource).toContain('OpenAI 和远程 MCP 服务都会接触获批的工具参数，并可能分别计费');
    expect(toggleSource).toContain('每次真实工具调用仍会展示完整参数并单独询问，不会记住批准');
    expect(toggleSource).toContain('工具可能修改外部数据，批准后的副作用无法由本应用撤销');
    expect(toggleSource.indexOf('const confirmed = await confirmDestructiveAction(')).toBeLessThan(
      toggleSource.indexOf('setWorkspace((current) =>')
    );
  });

  it('shows complete approval context, raw payload size, three actions, and Android safe-area protection', async () => {
    const [modalSource, appSource] = await Promise.all([
      source('src/components/McpApprovalModal.tsx'),
      source('App.tsx'),
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
    expect(appSource).toContain('argumentBytes: request.argumentBytes');
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
    const appSource = await source('App.tsx');
    const requestSource = sliceBetween(
      appSource,
      'function requestMcpApproval(',
      'async function authorizeProviderRequestPlan'
    );
    const unmountSource = sliceBetween(
      appSource,
      'useEffect(() => {\n    const taskControllers = generationTaskControllersRef.current;',
      'useEffect(() => {\n    let mounted = true;'
    );

    expect(requestSource).toContain("const onAbort = () => settle('cancel');");
    expect(requestSource).toContain("signal?.addEventListener('abort', onAbort, { once: true });");
    expect(requestSource).toContain("signal?.removeEventListener('abort', onAbort);");
    expect(requestSource).toContain("return Promise.resolve('cancel');");
    expect(requestSource).toContain('let settled = false;');
    expect(unmountSource).toContain('mountedRef.current = false;');
    expect(unmountSource).toContain('activeRequestRef.current?.controller.abort();');
    expect(unmountSource).toContain("mcpApprovalResolverRef.current?.settle('cancel');");
    expect(unmountSource).toContain('mcpApprovalResolverRef.current = null;');
    expect(appSource).toContain('if (activeRequestRef.current?.mcpActive)');
    expect(appSource).toContain("应用进入后台，本次 MCP 审批与回答已取消；不会自动重放批准。");
  });

  it('stores only bounded activity metadata and marks post-approval interruption as uncertain', async () => {
    const appSource = await source('App.tsx');
    const activityPanelSource = sliceBetween(
      appSource,
      'function McpActivityPanel',
      'function TokenUsageLine'
    );
    const assistantRequestSource = sliceBetween(
      appSource,
      'async function runAssistantRequest({',
      'function toggleReasoning'
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
    const appSource = await source('App.tsx');
    const comparisonToggleSource = sliceBetween(
      appSource,
      'function setComparisonEnabled',
      'function setWebSearchEnabled'
    );
    const searchToggleSource = sliceBetween(
      appSource,
      'function setWebSearchEnabled',
      'function savePromptTemplate'
    );
    const mcpToggleSource = sliceBetween(
      appSource,
      'async function toggleRemoteMcpServer',
      'function removeRemoteMcpServer'
    );
    const comparisonSendSource = sliceBetween(
      appSource,
      'async function sendComparisonMessage',
      'async function sendMessage'
    );

    expect(comparisonToggleSource).toContain("plugin.type === 'remote-mcp'");
    expect(comparisonToggleSource).toContain('plugin.enabled === true');
    expect(comparisonToggleSource).toContain('请先关闭对比目标绑定的 MCP');
    expect(searchToggleSource).toContain("plugin.type === 'remote-mcp'");
    expect(searchToggleSource).toContain('plugin.enabled === true');
    expect(searchToggleSource).toContain('请先关闭当前服务商的 MCP');

    expect(mcpToggleSource).toContain('workspace.webSearch.enabled');
    expect(mcpToggleSource).toContain('请先关闭联网搜索');
    expect(mcpToggleSource).toContain('workspace.comparisonEnabled');
    expect(mcpToggleSource).toContain('请先关闭多模型对比');
    expect(mcpToggleSource.indexOf('workspace.webSearch.enabled')).toBeLessThan(
      mcpToggleSource.indexOf('const confirmed = await confirmDestructiveAction(')
    );
    expect(mcpToggleSource.indexOf('workspace.comparisonEnabled')).toBeLessThan(
      mcpToggleSource.indexOf('const confirmed = await confirmDestructiveAction(')
    );
    expect(comparisonSendSource).toContain('对比请求未发出：v1.4 的 MCP 与多模型对比互斥');
  });

  it('authorizes each continuation charge before persisting providerRequestCount plus one', async () => {
    const appSource = await source('App.tsx');
    const continuationSource = sliceBetween(
      appSource,
      'beforeContinuation: async (context) => {',
      'onStreamUpdate: (update) => {'
    );

    const authorizationIndex = continuationSource.indexOf('const authorized = await authorizeProviderRequestPlan({');
    const incrementIndex = continuationSource.indexOf(
      'providerRequestCount: trackedUsageEvent.providerRequestCount + 1'
    );
    const persistenceIndex = continuationSource.indexOf('await persistProviderUsageEvents([nextUsageEvent]);');
    expect(authorizationIndex).toBeGreaterThanOrEqual(0);
    expect(incrementIndex).toBeGreaterThan(authorizationIndex);
    expect(persistenceIndex).toBeGreaterThan(incrementIndex);
    expect(continuationSource).toContain('if (!authorized || context.signal?.aborted)');
    expect(continuationSource).toContain('trackedUsageEvent = nextUsageEvent;');
  });

  it('passes only enabled provider-bound plugins and revalidates official routing plus model MCP capability', async () => {
    const [appSource, routeSource] = await Promise.all([
      source('App.tsx'),
      source('src/services/openAiCompatible.ts'),
    ]);
    const enabledFilterSource = sliceBetween(
      appSource,
      'function enabledRemoteMcpPluginsForProvider(',
      "type AudioOperation = 'idle'"
    );
    const assistantRequestSource = sliceBetween(
      appSource,
      'async function runAssistantRequest({',
      'function toggleReasoning'
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
