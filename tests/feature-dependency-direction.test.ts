import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

async function source(filePath: string): Promise<string> {
  return readFile(path.resolve(filePath), 'utf8');
}

describe('feature dependency direction', () => {
  it('keeps Settings on Chat public capabilities and out of Chat internals', async () => {
    const settingsSources = await Promise.all([
      source('src/features/settings/internal/useSettingsScreenModel.ts'),
      source('src/features/settings/internal/SettingsToolsSectionView.tsx'),
      source('src/features/settings/SettingsPane.tsx'),
    ]);
    const combined = settingsSources.join('\n');

    expect(combined).not.toContain("from '../../chat/internal/");
    expect(combined).not.toContain("from '../../chat/ChatProvider'");
    expect(combined).toContain('useChatConfigurationActions');
    expect(combined).toContain('useChatTaskActions');
  });

  it('keeps Chat independent of Settings implementation files', async () => {
    const chatPane = await source('src/features/chat/ChatPane.tsx');

    expect(chatPane).not.toContain('features/settings');
    expect(chatPane).not.toContain('settings/internal');
  });

  it('uses separate closed command interfaces for Settings, Chat, and Projects', async () => {
    const [settingsRuntime, chatRuntime, projectCommands] = await Promise.all([
      source('src/features/settings/internal/SettingsWorkspaceRuntime.ts'),
      source('src/features/chat/internal/ChatWorkspaceRuntime.ts'),
      source('src/features/projects/projectConversationCommands.ts'),
    ]);

    expect(settingsRuntime).toContain("type: 'provider.save'");
    expect(settingsRuntime).not.toContain("type: 'message.update'");
    expect(chatRuntime).toContain("type: 'message.update'");
    expect(chatRuntime).not.toContain("type: 'provider.save'");
    expect(chatRuntime).not.toContain("type: 'artifact.create'");
    expect(projectCommands).toContain("type: 'artifact.create'");
    expect(projectCommands).toContain("type: 'conversation.fork'");
  });
});
