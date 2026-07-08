import type { PluginManifest } from '../domain/types';

export const mobileMcpTransports = ['streamable-http', 'sse'] as const;

export const pluginPermissionLabels: Record<PluginManifest['permissions'][number], string> = {
  network: '网络',
  files: '文件',
  clipboard: '剪贴板',
  tools: '工具调用',
};

export function isRemoteMcpPlugin(plugin: PluginManifest): boolean {
  return plugin.type === 'remote-mcp' && Boolean(plugin.endpoint);
}
