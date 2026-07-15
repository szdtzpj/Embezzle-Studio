export type SettingsToolsSection =
  | 'workspace'
  | 'comparison'
  | 'webSearch'
  | 'prompts'
  | 'costGuard'
  | 'usage'
  | 'media'
  | 'backup'
  | 'sync'
  | 'diagnostics'
  | 'voice'
  | 'mcp';

/** One application-level destination contract shared by Chat and Settings. */
export type SettingsDestination =
  | { kind: 'home' }
  | { kind: 'providers' }
  | { kind: 'provider-models'; providerId?: string }
  | { kind: 'tool'; tool: SettingsToolsSection };
