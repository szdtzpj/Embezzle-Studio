import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('App workspace import transaction wiring', () => {
  it('uses a strict pre-import flush and reconciles the UI after postcommit failure', async () => {
    const appSource = await readFile(path.resolve('App.tsx'), 'utf8');

    expect(appSource).toContain('flushWorkspace({ propagateFailure: true })');
    expect(appSource).toContain('if (options.propagateFailure) throw failure;');
    expect(appSource).toContain(
      'if (!persistenceDirtyRef.current && !options.propagateFailure)'
    );
    expect(appSource).toContain('const replacement = await persistWorkspaceReplacement({');
    expect(appSource).toContain('applyImportedWorkspaceSnapshot(replacement.workspace);');
    expect(appSource).toContain("replacement.status === 'committed-with-postcommit-error'");
    expect(appSource).toContain('备份工作区已写入并切换，但安全凭据或保存收尾失败');
    expect(appSource).toContain('备份未解密、现有工作区未替换');
    expect(appSource).not.toContain('备份验证或导入失败，现有工作区未改动。');
  });
});
