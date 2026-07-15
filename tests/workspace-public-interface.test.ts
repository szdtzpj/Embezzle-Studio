import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Workspace public interface', () => {
  it('exposes selectors/status but no generic mutation hook or legacy adapter', async () => {
    const provider = await readFile(
      path.resolve('src/app/workspace/WorkspaceSessionProvider.tsx'),
      'utf8'
    );
    const internalContext = await readFile(
      path.resolve('src/app/workspace/internal/WorkspaceSessionContext.ts'),
      'utf8'
    );
    const sessionConsumers = await Promise.all(
      [
        'src/features/chat/ChatPane.tsx',
        'src/features/chat/useChatTaskActions.ts',
        'src/features/chat/internal/voice/useChatVoice.ts',
        'src/features/projects/ProjectsConversationsProvider.tsx',
        'src/features/settings/SettingsProductivityProvider.tsx',
        'src/features/settings/internal/SettingsToolsSectionView.tsx',
        'src/features/settings/internal/useSettingsScreenModel.ts',
      ].map((filePath) => readFile(path.resolve(filePath), 'utf8'))
    );
    const chatBarrel = await readFile(path.resolve('src/features/chat/index.ts'), 'utf8');

    expect(provider).toContain('useWorkspaceSelector');
    expect(provider).toContain('useWorkspaceStatus');
    expect(provider).toContain('autoBoot: false');
    expect(provider).toContain('void session.boot();');
    expect(provider).toContain('const epoch = ++guard.disposeEpoch;');
    expect(provider).toContain('guard.disposeEpoch === epoch');
    expect(provider).not.toContain('export function useWorkspaceSession');
    expect(provider).toContain('const snapshot = useSyncExternalStore');
    expect(provider).toContain('return selector(snapshot);');
    expect(provider).not.toContain('selectorRef.current(session.getSnapshot())');
    expect(internalContext).toContain('export function useWorkspaceSession');
    for (const consumer of sessionConsumers) {
      expect(consumer).toContain('workspace/internal/WorkspaceSessionContext');
    }
    expect(provider).not.toContain('useLegacyWorkspaceMutation');
    expect(provider).not.toContain('LegacyWorkspaceMutationAdapter');
    expect(chatBarrel).not.toContain('ChatPaneWorkspaceRuntime');
    expect(chatBarrel).not.toContain('commitProjection');
  });
});
