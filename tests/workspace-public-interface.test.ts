import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Workspace public interface', () => {
  it('exposes selectors/status but no generic mutation hook or legacy adapter', async () => {
    const provider = await readFile(
      path.resolve('src/app/workspace/WorkspaceSessionProvider.tsx'),
      'utf8'
    );
    const chatBarrel = await readFile(path.resolve('src/features/chat/index.ts'), 'utf8');

    expect(provider).toContain('useWorkspaceSelector');
    expect(provider).toContain('useWorkspaceStatus');
    expect(provider).not.toContain('useLegacyWorkspaceMutation');
    expect(provider).not.toContain('LegacyWorkspaceMutationAdapter');
    expect(chatBarrel).not.toContain('ChatPaneWorkspaceRuntime');
    expect(chatBarrel).not.toContain('commitProjection');
  });
});
