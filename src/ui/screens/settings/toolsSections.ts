export type SettingsToolsSection =
  | 'workspace'
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
