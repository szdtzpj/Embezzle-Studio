import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

async function source(filePath: string): Promise<string> {
  return readFile(path.resolve(filePath), 'utf8');
}

function section(value: string, start: string, end: string): string {
  const startIndex = value.indexOf(start);
  const endIndex = value.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return value.slice(startIndex, endIndex);
}

function functionBlock(value: string, name: string): string {
  const startIndex = value.indexOf(`function ${name}(`);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const bodyStart = value.indexOf('{', startIndex);
  expect(bodyStart).toBeGreaterThan(startIndex);
  let depth = 0;
  for (let index = bodyStart; index < value.length; index += 1) {
    if (value[index] === '{') depth += 1;
    if (value[index] === '}') {
      depth -= 1;
      if (depth === 0) return value.slice(startIndex, index + 1);
    }
  }
  throw new Error(`Unterminated function ${name}.`);
}

describe('Chat and Settings coordination', () => {
  it('invalidates unsent attachments after every Settings target/workspace replacement', async () => {
    const [modelSource, toolsSource, chatSource, settingsScreenSource] = await Promise.all([
      source('src/features/settings/internal/useSettingsScreenModel.ts'),
      source('src/features/settings/internal/SettingsToolsSectionView.tsx'),
      source('src/features/chat/ChatPane.tsx'),
      source('src/features/settings/internal/SettingsScreen.tsx'),
    ]);

    for (const functionName of [
      'persistProviderDraft',
      'selectProvider',
      'toggleProviderEnabled',
      'addCustomProvider',
      'deleteProvider',
      'selectModel',
      'addManualModel',
      'addCandidateModel',
      'removeModel',
      'setActiveModelTask',
      'toggleActiveModelCapability',
    ]) {
      expect(functionBlock(modelSource, functionName)).toContain(
        'chatProjectNavigation.discardPendingAttachments()'
      );
    }
    for (const functionName of ['toggleComparisonTarget', 'setComparisonEnabled']) {
      expect(functionBlock(toolsSource, functionName)).toContain(
        'chatProjectNavigation.discardPendingAttachments()'
      );
    }
    expect(functionBlock(modelSource, 'persistProviderDraft')).toContain(
      'binding.changed || apiKeyChanged'
    );
    expect(functionBlock(modelSource, 'toggleActiveModelCapability')).toContain(
      "capability === 'file-input'"
    );
    expect(functionBlock(modelSource, 'selectProvider').indexOf('return true')).toBeLessThan(
      functionBlock(modelSource, 'selectProvider').indexOf(
        'chatProjectNavigation.discardPendingAttachments()'
      )
    );
    expect(functionBlock(modelSource, 'selectModel').indexOf('return true')).toBeLessThan(
      functionBlock(modelSource, 'selectModel').indexOf(
        'chatProjectNavigation.discardPendingAttachments()'
      )
    );
    const importSource = section(
      toolsSource,
      'async function importEncryptedBackup()',
      'function addRemoteMcpServer()'
    );
    expect(importSource.indexOf('await session.replace')).toBeLessThan(
      importSource.indexOf('chatProjectNavigation.resetComposer()')
    );
    expect(importSource.indexOf('await importEncryptedWorkspaceBackup')).toBeLessThan(
      importSource.indexOf('await deletePersistedAttachments')
    );
    expect(importSource.indexOf('await deletePersistedAttachments')).toBeLessThan(
      importSource.indexOf('return importedWorkspace')
    );
    expect(importSource.indexOf('return importedWorkspace')).toBeLessThan(
      importSource.indexOf('await flushPendingAttachmentDeletions(importedAttachments)')
    );
    expect(importSource.indexOf('await flushPendingAttachmentDeletions(importedAttachments)')).toBeLessThan(
      importSource.indexOf('chatProjectNavigation.resetComposer()')
    );
    expect(chatSource).toContain('discardPendingAttachments: clearPendingAttachments');
    expect(functionBlock(chatSource, 'setComparisonEnabled')).toContain('clearPendingAttachments()');
    expect(settingsScreenSource).toContain(
      'if (!(await props.providers.select(providerId))) return;'
    );
  });

  it('applies Projects Chat effects through one shared helper and one prompt implementation', async () => {
    const [toolsSource, drawerSource, chatSource, settingsRuntime] = await Promise.all([
      source('src/features/settings/internal/SettingsToolsSectionView.tsx'),
      source('src/features/projects/ProjectDrawer.tsx'),
      source('src/features/chat/ChatPane.tsx'),
      source('src/features/settings/internal/SettingsWorkspaceRuntime.ts'),
    ]);

    expect(toolsSource).toContain('applyProjectConversationChatEffects(result, {');
    expect(drawerSource).toContain('applyProjectConversationChatEffects(result, chat)');
    expect(chatSource).toContain('applyProjectConversationChatEffects(result, {');
    expect(toolsSource).toContain('chatProjectNavigation.applyPromptTemplate(templateId)');
    expect(settingsRuntime).not.toContain("type: 'prompt.apply'");
  });

  it('owns one task runtime instance and connects global stop to real task cancellation', async () => {
    const [providerSource, taskSource, leaseSource, chatSource] = await Promise.all([
      source('src/features/chat/ChatProvider.tsx'),
      source('src/features/chat/useChatTaskActions.ts'),
      source('src/features/chat/orchestration/ChatTaskLease.ts'),
      source('src/features/chat/ChatPane.tsx'),
    ]);

    expect(providerSource.match(/<ChatTaskRuntimeProvider/g)).toHaveLength(1);
    expect(taskSource).toContain("createContext<ChatTaskRuntime | null>(null)");
    expect(taskSource).toContain('new ChatTaskLeaseCoordinator(');
    expect(leaseSource).toContain('bindTaskLeaseAbort(lease.controller.signal, onAbort)');
    expect(chatSource).toContain("chatActivity.phase === 'task-query'");
  });

  it('awaits all visible-message commits before provider execution can continue', async () => {
    const chatSource = await source('src/features/chat/ChatPane.tsx');
    const appendCallbacks = [...chatSource.matchAll(/appendVisibleMessages: async \(\) => \{/g)];
    expect(appendCallbacks).toHaveLength(4);
    expect(chatSource).not.toMatch(/appendVisibleMessages:[\s\S]{0,500}void commitWorkspaceCommand/);
    expect(
      chatSource.match(
        /appendVisibleMessages: async \(\) => \{(?=[\s\S]{0,800}const accepted = await commitWorkspaceCommand\()/g
      )
    ).toHaveLength(4);
  });
});
