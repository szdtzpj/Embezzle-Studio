import { describe, expect, it } from 'vitest';

import { MemoryWorkspacePersistenceAdapter } from '../src/app/workspace/adapters/memoryWorkspacePersistenceAdapter';
import { WorkspaceSession } from '../src/app/workspace/WorkspaceSession';
import { createDefaultWorkspace } from '../src/data/providerCatalog';
import type { ModelInfo } from '../src/domain/types';
import { ChatWorkspaceRuntime } from '../src/features/chat/internal/ChatWorkspaceRuntime';
import { SettingsWorkspaceRuntime } from '../src/features/settings/internal/SettingsWorkspaceRuntime';
import { DEFAULT_GROK_SEARCH_MODEL } from '../src/services/externalSearch';
import { mutateSessionForTest } from './helpers/workspaceSessionTestHarness';

function createRuntimes() {
  const persistence = new MemoryWorkspacePersistenceAdapter({
    initial: createDefaultWorkspace(),
  });
  const session = new WorkspaceSession({ persistence, autoBoot: false });
  return {
    session,
    chat: new ChatWorkspaceRuntime(session),
    settings: new SettingsWorkspaceRuntime(session),
  };
}

describe('feature workspace runtimes', () => {
  it('lets Settings configure models while Chat only selects an existing target', async () => {
    const { session, chat, settings } = createRuntimes();
    await session.boot();
    const provider = session.getSnapshot().providers[0];
    const model: ModelInfo = {
      id: 'chat-model',
      name: 'Chat model',
      source: 'manual' as const,
      capabilities: ['text', 'streaming'],
    };

    await settings.execute({ type: 'model.add', providerId: provider.id, model });
    await chat.execute({
      type: 'model.select',
      providerId: provider.id,
      modelId: model.id,
      activateProvider: true,
    });

    expect(session.getSnapshot().activeProviderId).toBe(provider.id);
    expect(session.getSnapshot().activeModelIdByProvider[provider.id]).toBe(model.id);
  });

  it('removes every provider-bound reference when a model is deleted', async () => {
    const { session, settings } = createRuntimes();
    await session.boot();
    const provider = session.getSnapshot().providers[0];
    const model: ModelInfo = {
      id: 'voice-model',
      name: 'Voice model',
      source: 'manual' as const,
      task: 'speech-generation' as const,
      capabilities: ['text-to-speech'],
    };
    await settings.execute({ type: 'model.add', providerId: provider.id, model });
    await mutateSessionForTest(session, (workspace) => ({
      ...workspace,
      comparisonTargets: [{ providerId: provider.id, modelId: model.id }],
      comparisonEnabled: true,
      voice: {
        ...workspace.voice,
        speechTarget: { providerId: provider.id, modelId: model.id },
      },
      projects: workspace.projects.map((project) => ({
        ...project,
        defaultTarget: { providerId: provider.id, modelId: model.id },
      })),
      reasoningEffortByModel: {
        ...workspace.reasoningEffortByModel,
        [`${provider.id}:${model.id}`]: 'high',
      },
    }));

    await settings.execute({
      type: 'model.remove',
      providerId: provider.id,
      modelId: model.id,
      now: 10,
    });

    const workspace = session.getSnapshot();
    expect(workspace.comparisonTargets).toEqual([]);
    expect(workspace.comparisonEnabled).toBe(false);
    expect(workspace.voice.speechTarget).toBeUndefined();
    expect(workspace.projects.every((project) => !project.defaultTarget)).toBe(true);
    expect(workspace.reasoningEffortByModel[`${provider.id}:${model.id}`]).toBeUndefined();
  });

  it('uses the shared Grok default when settings create an external search service', async () => {
    const { session, settings } = createRuntimes();
    await session.boot();

    await settings.execute({
      type: 'external-search.upsert',
      input: {
        kind: 'grok',
        newId: 'grok-search',
      },
    });

    expect(session.getSnapshot().externalSearch.services).toContainEqual(
      expect.objectContaining({
        id: 'grok-search',
        kind: 'grok',
        model: DEFAULT_GROK_SEARCH_MODEL,
      })
    );
  });

  it('updates a message only in the requested conversation projection', async () => {
    const { session, chat } = createRuntimes();
    await session.boot();
    const active = session.getSnapshot().conversations[0];
    const shared = {
      id: 'shared-message',
      role: 'assistant' as const,
      content: 'old',
      status: 'ready' as const,
      createdAt: 1,
    };
    await mutateSessionForTest(session, (workspace) => ({
      ...workspace,
      messages: [shared],
      conversations: [
        { ...active, id: 'conversation-a', messages: [shared] },
        { ...active, id: 'conversation-b', messages: [shared] },
      ],
      activeConversationId: 'conversation-a',
    }));

    await chat.execute({
      type: 'message.update',
      messageId: shared.id,
      conversationId: 'conversation-a',
      patch: { content: 'new' },
      now: 2,
    });

    const workspace = session.getSnapshot();
    expect(workspace.messages[0].content).toBe('new');
    expect(workspace.conversations.find((item) => item.id === 'conversation-a')?.messages[0].content)
      .toBe('new');
    expect(workspace.conversations.find((item) => item.id === 'conversation-b')?.messages[0].content)
      .toBe('old');
  });

  it('removes one system message everywhere without truncating later history', async () => {
    const { session, chat } = createRuntimes();
    await session.boot();
    const active = session.getSnapshot().conversations[0];
    const system = {
      id: 'system-1',
      role: 'system' as const,
      content: 'instruction',
      status: 'ready' as const,
      createdAt: 1,
    };
    const user = {
      id: 'user-1',
      role: 'user' as const,
      content: 'keep me',
      status: 'ready' as const,
      createdAt: 2,
    };
    await mutateSessionForTest(session, (workspace) => ({
      ...workspace,
      messages: [system, user],
      conversations: [{ ...active, messages: [system, user] }],
    }));

    await chat.execute({
      type: 'message.remove-everywhere',
      messageId: system.id,
      now: 3,
    });

    expect(session.getSnapshot().messages.map((message) => message.id)).toEqual([user.id]);
    expect(session.getSnapshot().conversations[0].messages.map((message) => message.id)).toEqual([
      user.id,
    ]);
  });
});
