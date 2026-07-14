import type { AppWorkspace, PluginManifest, ProviderProfile } from '../../../domain/types';
import {
  getRemoteMcpExecutableReadiness,
  normalizeMcpAllowedTools,
  normalizeMcpAuthorization,
  normalizeMcpDescription,
  normalizeRemoteMcpEndpoint,
} from '../../../plugins/contracts';
import { isExactOfficialOpenAiProvider } from '../../../services/providerSetup';
import { isProviderEnabled } from '../../../services/workspaceRuntime';

export type SettingsPolicyResult<T> =
  | { ok: true; value: T }
  | { ok: false; notice: string };

export interface RemoteMcpDraft {
  name: string;
  endpoint: string;
  description: string;
  allowedTools: string;
  authorization: string;
}

export function createRemoteMcpPlugin(
  draft: RemoteMcpDraft,
  provider: ProviderProfile | undefined,
  id: string
): SettingsPolicyResult<PluginManifest> {
  const name = draft.name.trim();
  if (!name) return { ok: false, notice: '请填写 MCP 服务名称。' };
  const endpoint = normalizeRemoteMcpEndpoint(draft.endpoint);
  if (!endpoint) {
    return {
      ok: false,
      notice: 'MCP Endpoint 必须是无凭据、查询参数、片段和私网地址的 HTTPS URL。',
    };
  }
  const allowedTools = normalizeMcpAllowedTools(
    draft.allowedTools
      .split(/[\n,]/)
      .map((tool) => tool.trim())
      .filter(Boolean)
  );
  if (!allowedTools.length) {
    return {
      ok: false,
      notice: '请填写至少一个精确工具名；使用逗号或换行分隔，不支持通配符。',
    };
  }
  const descriptionInput = draft.description.trim();
  const description = descriptionInput ? normalizeMcpDescription(descriptionInput) : undefined;
  if (descriptionInput && !description) {
    return { ok: false, notice: 'MCP 描述过长或无效，请缩短后重试。' };
  }
  const authorizationInput = draft.authorization.trim();
  const authorization = authorizationInput
    ? normalizeMcpAuthorization(authorizationInput)
    : undefined;
  if (authorizationInput && !authorization) {
    return { ok: false, notice: 'MCP Authorization 过长或包含不安全控制字符。' };
  }
  if (!provider) return { ok: false, notice: '请先启用并选择一个服务商。' };

  return {
    ok: true,
    value: {
      id,
      name,
      version: '1.0.0',
      type: 'remote-mcp',
      permissions: ['network', 'tools'],
      transport: 'streamable-http',
      endpoint,
      serverLabel: `mcp_${id.replace(/[^A-Za-z0-9_-]/g, '_')}`,
      providerId: provider.id,
      allowedTools,
      description,
      authorization,
      approvalPolicy: 'always',
      enabled: false,
    },
  };
}

export interface RemoteMcpEnableConfirmation {
  plugin: PluginManifest;
  title: string;
  description: string;
}

export function prepareRemoteMcpEnable(
  workspace: AppWorkspace,
  pluginId: string
): SettingsPolicyResult<RemoteMcpEnableConfirmation> {
  const plugin = workspace.plugins.find((item) => item.id === pluginId);
  if (!plugin) return { ok: false, notice: '找不到要启用的 MCP 配置。' };
  const provider = workspace.providers.find((item) => item.id === plugin.providerId);
  const readiness = getRemoteMcpExecutableReadiness(
    { ...plugin, enabled: true },
    new Set(workspace.providers.map((item) => item.id))
  );
  if (!readiness.executable) {
    return {
      ok: false,
      notice: 'MCP 无法启用：请检查公网 HTTPS 地址、服务商绑定、工具白名单与逐次审批设置。',
    };
  }
  if (!isProviderEnabled(provider) || !provider || !isExactOfficialOpenAiProvider(provider)) {
    const providerName = provider?.name ?? '已删除的服务商';
    return {
      ok: false,
      notice: `MCP 无法启用：${providerName} 当前只保存配置。v1.4 仅对精确的 OpenAI 官方 api.openai.com Responses 路由开放逐次审批执行。`,
    };
  }
  if (
    (workspace.webSearch.enabled || workspace.externalSearch.enabled) &&
    workspace.activeProviderId === plugin.providerId
  ) {
    return {
      ok: false,
      notice: '请先关闭联网搜索（服务商或外部）；不在同一轮混用联网搜索与 MCP。',
    };
  }
  if (
    workspace.comparisonEnabled &&
    workspace.comparisonTargets.some((target) => target.providerId === plugin.providerId)
  ) {
    return { ok: false, notice: '请先关闭多模型对比；v1.4 不在对比分支中执行 MCP。' };
  }

  return {
    ok: true,
    value: {
      plugin,
      title: '授权并启用这个 MCP 服务？',
      description: `服务：${plugin.name}\n地址：${readiness.endpoint}\n精确工具白名单：${readiness.allowedTools.join(', ')}\n\nMCP Authorization 会随每次请求发送给你选择的 OpenAI 账号；OpenAI 和远程 MCP 服务都会接触获批的工具参数，并可能分别计费。store: false 只关闭 Responses 对象存储，不会替代你的 OpenAI 组织数据控制、服务商安全日志或远程 MCP 自身的日志与保留政策。每次真实工具调用仍会展示完整参数并单独询问，不会记住批准。工具可能修改外部数据，批准后的副作用无法由本应用撤销。`,
    },
  };
}
