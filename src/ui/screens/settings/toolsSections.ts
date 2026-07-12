export type SettingsToolsSection =
  | 'workspace'
  | 'providerSetup'
  | 'comparison'
  | 'webSearch'
  | 'prompts'
  | 'costGuard'
  | 'usage'
  | 'media'
  | 'backup'
  | 'voice'
  | 'mcp';

export const settingsToolsSectionTitles: Record<SettingsToolsSection, string> = {
  workspace: '项目工作台',
  providerSetup: '服务商配置与模型',
  comparison: '多模型对比',
  webSearch: '联网搜索',
  prompts: '提示词与角色模板',
  costGuard: '费用保险丝',
  usage: '用量与费用',
  media: '媒体任务中心',
  backup: '本地加密备份',
  voice: '语音',
  mcp: 'MCP 工具',
};
