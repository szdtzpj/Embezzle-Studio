import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

describe('Settings public seam', () => {
  it('exposes only the final SettingsDestination shape', async () => {
    const navigation = await readFile(
      path.resolve('src/app/navigation/settingsNavigation.ts'),
      'utf8'
    );
    expect(navigation).toContain("| { kind: 'providers' }");
    expect(navigation).toContain("| { kind: 'provider-models'; providerId?: string }");
    expect(navigation).toContain("| { kind: 'tool'; tool: SettingsToolsSection }");
    expect(navigation).not.toContain('LegacySettingsDestination');
    expect(navigation).not.toContain('toSettingsDestination');
  });

  it('does not export SettingsScreenProps as a public 52-member interface', async () => {
    const settingsScreen = await readFile(
      path.resolve('src/features/settings/internal/SettingsScreen.tsx'),
      'utf8'
    );
    const barrel = await readFile(path.resolve('src/features/settings/index.ts'), 'utf8');

    expect(settingsScreen).not.toMatch(/export interface SettingsScreenProps/);
    expect(settingsScreen).toContain('export interface SettingsScreenModel');
    expect(barrel).not.toContain('SettingsScreenProps');
    expect(barrel).not.toContain('SettingsScreenModel');
    expect(barrel).toContain('useSettingsLauncher');
    expect(barrel).toContain('SettingsPane');
    expect(barrel).toContain('SettingsProductivityProvider');
  });

  it('keeps Settings navigation and tools section types on the public barrel only as destinations', async () => {
    const barrel = await readFile(path.resolve('src/features/settings/index.ts'), 'utf8');
    expect(barrel).toContain('SettingsDestination');
    expect(barrel).not.toContain('renderToolsSection');
    expect(barrel).not.toContain('renderToolsHeaderRight');
  });
});
