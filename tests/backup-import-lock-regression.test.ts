import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

async function appSource(): Promise<string> {
  return readFile(path.resolve('App.tsx'), 'utf8');
}

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);

  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe('encrypted backup import replacement lock', () => {
  it('holds the replacement lock from the final in-flight check through persistence and state replacement', async () => {
    const source = await appSource();
    const importSource = section(
      source,
      'async function importEncryptedBackup()',
      'function addRemoteMcpServer()'
    );
    const inFlightChecks = [...importSource.matchAll(/if \(hasInFlightWorkspaceOperation\(\)\)/g)];
    const lockStart = importSource.indexOf('workspaceReplacementInProgressRef.current = true;');
    const lockOwnership = importSource.indexOf('replacementLockAcquired = true;');
    const workspaceFlush = importSource.indexOf('await flushWorkspace();');
    const decryptStart = importSource.indexOf('await importEncryptedWorkspaceBackup(');
    const saveStart = importSource.indexOf('await saveWorkspace(imported);');
    const stateReplacement = importSource.indexOf('setWorkspace(imported);');
    const lockEnd = importSource.indexOf('workspaceReplacementInProgressRef.current = false;');

    expect(source).toContain('const workspaceReplacementInProgressRef = useRef(false);');
    expect(importSource).toContain('let replacementLockAcquired = false;');
    expect(importSource).toContain('Boolean(costConfirmationResolverRef.current)');
    expect(inFlightChecks).toHaveLength(2);
    expect(lockStart).toBeGreaterThan(inFlightChecks[1].index ?? -1);
    expect(lockStart).toBeLessThan(lockOwnership);
    expect(lockOwnership).toBeLessThan(workspaceFlush);
    expect(workspaceFlush).toBeLessThan(decryptStart);
    expect(decryptStart).toBeLessThan(saveStart);
    expect(saveStart).toBeLessThan(stateReplacement);
    expect(stateReplacement).toBeLessThan(lockEnd);
    expect(importSource.indexOf('} finally {')).toBeLessThan(lockEnd);
    expect(importSource).toContain(
      'if (replacementLockAcquired) {\n        workspaceReplacementInProgressRef.current = false;'
    );
  });

  it('fails closed at every request and mutation entry point while replacement is active', async () => {
    const source = await appSource();
    const writableSource = section(
      source,
      'function ensureWorkspaceWritable()',
      'function beginActiveRequest('
    );
    const requestSource = section(
      source,
      'function beginActiveRequest(',
      'function beginAudioOperation('
    );
    const audioSource = section(
      source,
      'function beginAudioOperation(',
      'function transitionAudioOperation('
    );
    const authorizationSource = section(
      source,
      'async function authorizeProviderRequestPlan(',
      'async function persistProviderUsageEvents('
    );
    const generationRefreshSource = section(
      source,
      'async function refreshGenerationTask(',
      'function refreshTaskCenterItem('
    );
    const lockCheck = 'if (workspaceReplacementInProgressRef.current) {';

    expect(writableSource.indexOf(lockCheck)).toBeLessThan(
      writableSource.indexOf('if (persistenceReadyRef.current)')
    );
    expect(requestSource.indexOf(lockCheck)).toBeLessThan(
      requestSource.indexOf('if (activeRequestRef.current)')
    );
    expect(audioSource.indexOf(lockCheck)).toBeLessThan(
      audioSource.indexOf('if (activeAudioOperationRef.current)')
    );
    expect(authorizationSource.indexOf(lockCheck)).toBeLessThan(
      authorizationSource.indexOf('const current = workspaceRef.current;')
    );

    const confirmationStart = authorizationSource.indexOf(
      'const confirmed = await requestCostConfirmation(evaluation.reason);'
    );
    const confirmationRecheck = authorizationSource.indexOf(lockCheck, confirmationStart);
    expect(confirmationStart).toBeGreaterThanOrEqual(0);
    expect(confirmationRecheck).toBeGreaterThan(confirmationStart);
    expect(confirmationRecheck).toBeLessThan(authorizationSource.indexOf('return confirmed;'));
    expect(generationRefreshSource.indexOf('if (!ensureWorkspaceWritable())')).toBeLessThan(
      generationRefreshSource.indexOf('await queryGenerationTask(')
    );
  });
});
