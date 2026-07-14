import type { SetStateAction } from 'react';

import type { WorkspaceSession } from '../../src/app/workspace/WorkspaceSession';
import type { AppWorkspace } from '../../src/domain/types';

/** Test-only setup helper; production code cannot import from tests/. */
export async function mutateSessionForTest(
  session: WorkspaceSession,
  update: SetStateAction<AppWorkspace>
): Promise<void> {
  const commit = session.bindCommitPort<
    { type: 'test.mutate'; update: SetStateAction<AppWorkspace> },
    void
  >((workspace, command) => ({
    workspace:
      typeof command.update === 'function'
        ? command.update(workspace)
        : command.update,
    result: undefined,
  }));
  await commit.execute({ type: 'test.mutate', update });
}
