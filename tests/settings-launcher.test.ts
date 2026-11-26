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

  it('re-runs an already-open destination and forwards a provider model target', async () => {
    const provider = await readFile(
      path.resolve('src/features/settings/SettingsProductivityProvider.tsx'),
      'utf8'
    );
    expect(provider).toContain('const [pendingDestination, setPendingDestination]');
    expect(provider).toContain('[isOpen, pendingDestination]');
    expect(provider).toContain('settings.openProviderModels(destination.providerId)');
    expect(provider).toContain('settings.openActiveProviderModels()');
  });

  it('unmounts closed Settings instead of keeping hidden mounted state', async () => {
    const pane = await readFile(path.resolve('src/features/settings/SettingsPane.tsx'), 'utf8');
    expect(pane).toContain('if (!isOpen)');
    expect(pane).toContain('return null;');
    expect(pane).not.toContain('hasMounted');
    expect(pane).not.toContain("display: 'none'");
    expect(pane).not.toContain('nativeHidden');
    expect(pane.indexOf('if (!isOpen)')).toBeLessThan(
      pane.indexOf('useSettingsScreenModel(props.close)')
    );
  });
});
