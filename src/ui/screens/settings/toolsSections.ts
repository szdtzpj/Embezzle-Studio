import type { SettingsToolsSection } from '../../../app/navigation/settingsNavigation';

export type { SettingsToolsSection } from '../../../app/navigation/settingsNavigation';

export const settingsToolsSectionTitles: Record<SettingsToolsSection, string> = {
  workspace: '项目工作台',
  comparison: '多模型对比',
  webSearch: '搜索服务',
  prompts: '提示词与角色模板',
  costGuard: '费用保险丝',
  usage: '用量与费用',
  media: '媒体任务中心',
  backup: '本地加密备份',
  sync: '用户自有存储同步',
  diagnostics: '本地诊断中心',
  voice: '语音',
  mcp: 'MCP 工具',
};
