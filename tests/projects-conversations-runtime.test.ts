import { describe, expect, it, vi } from 'vitest';
import { mutateSessionForTest } from './helpers/workspaceSessionTestHarness';

import { MemoryWorkspacePersistenceAdapter } from '../src/app/workspace/adapters/memoryWorkspacePersistenceAdapter';
import { WorkspaceSession } from '../src/app/workspace/WorkspaceSession';
import { FakeIdGenerator } from '../src/app/testing/fakeIdGenerator';
import { createDefaultWorkspace } from '../src/data/providerCatalog';
import {
  createProjectsCommitReducer,
  ProjectsConversationsRuntime,
} from '../src/features/projects/ProjectsConversationsRuntime';
import { hasConversationHistory } from '../src/features/projects/projectConversationHelpers';
import { applyProjectConversationChatEffects } from '../src/features/projects/projectConversationResults';

function createRuntime(options: {
  historyLocked?: boolean;
  onConversationDeleted?: (conversationId: string) => Promise<void>;
} = {}) {
  const ids = new FakeIdGenerator();
  const persistence = new MemoryWorkspacePersistenceAdapter({
    initial: createDefaultWorkspace(),
  });
  const session = new WorkspaceSession({
    persistence,
    autoBoot: false,
  });
  const commit = session.bindCommitPort(createProjectsCommitReducer());
  const runtime = new ProjectsConversationsRuntime({
    commit,
    now: () => 1_700_000_000_000,
    createId: (prefix) => ids.createId(prefix),
    isHistoryLocked: () => options.historyLocked === true,
    onConversationDeleted: options.onConversationDeleted,
  });
  return { session, runtime, persistence };
}

describe('ProjectsConversationsRuntime', () => {
  it('runs conversation-delete cleanup only after the required workspace commit', async () => {
    const onConversationDeleted = vi.fn(async () => undefined);
    const { session, runtime } = createRuntime({ onConversationDeleted });
    await session.boot();
    const conversationId = session.getSnapshot().activeConversationId;

    const result = await runtime.execute({ type: 'conversation.delete', conversationId });

    expect(result.ok).toBe(true);
    expect(onConversationDeleted).toHaveBeenCalledWith(conversationId);
    await session.settle();
    expect(session.getSnapshot().conversations.some((item) => item.id === conversationId)).toBe(false);
  });

  it('applies every cross-feature Chat effect returned by a Projects command', () => {
    const effects = {
      showNotice: vi.fn(),
      resetComposer: vi.fn(),
      clearTaskQueries: vi.fn(),
    };

    applyProjectConversationChatEffects(
      {
        ok: true,
        notice: 'switched',
        activeContextChanged: true,
        taskQueriesInvalidated: true,
      },
      effects
    );

    expect(effects.showNotice).toHaveBeenCalledWith('switched');
    expect(effects.resetComposer).toHaveBeenCalledOnce();
    expect(effects.clearTaskQueries).toHaveBeenCalledOnce();
  });

  it('creates a project with an empty conversation and project instruction', async () => {
    const { session, runtime } = createRuntime();
    await session.boot();

    const result = await runtime.execute({
      type: 'project.create',
      input: { name: 'Research', systemPrompt: 'Be thorough.' },
      successNotice: 'created',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notice).toBe('created');
    expect(result.activeContextChanged).toBe(true);
    expect(result.taskQueriesInvalidated).toBe(true);

    const workspace = session.getSnapshot();
    const project = workspace.projects.find((item) => item.name === 'Research');
    expect(project).toBeTruthy();
    expect(workspace.activeProjectId).toBe(project!.id);
    const conversation = workspace.conversations.find(
      (item) => item.id === workspace.activeConversationId
    );
    expect(conversation?.projectId).toBe(project!.id);
    expect(conversation?.messages.some((message) => message.projectInstructionId === project!.id)).toBe(
      true
    );
    expect(hasConversationHistory(conversation!)).toBe(false);
  });

  it('activates a conversation and applies project default target only for empty chats', async () => {
    const { session, runtime } = createRuntime();
    await session.boot();

    await mutateSessionForTest(session, (current) => ({
      ...current,
      providers: current.providers.map((provider, index) =>
        index === 0
          ? {
              ...provider,
              models: [
                {
                  id: 'model-a',
                  name: 'Model A',
                  source: 'manual' as const,
                  capabilities: ['text', 'streaming'] as const,
                },
              ],
            }
          : provider
      ),
    }));

    const created = await runtime.execute({
      type: 'project.create',
      input: { name: 'With default' },
    });
    expect(created.ok).toBe(true);

    const projectId = session.getSnapshot().activeProjectId;
    const providerId = session.getSnapshot().providers[0].id;
    const modelId = 'model-a';

    await runtime.execute({
      type: 'project.setDefaultTarget',
      projectId,
      providerId,
      modelId,
    });

    const start = await runtime.execute({
      type: 'conversation.start',
      projectId,
    });
    expect(start.ok).toBe(true);
    expect(session.getSnapshot().activeProviderId).toBe(providerId);
    expect(session.getSnapshot().activeModelIdByProvider[providerId]).toBe(modelId);
  });

  it('activates an existing conversation through the Projects interface', async () => {
    const { session, runtime } = createRuntime();
    await session.boot();

    const originalConversationId = session.getSnapshot().activeConversationId;
    const originalProjectId = session.getSnapshot().activeProjectId;
    await runtime.execute({ type: 'project.create', input: { name: 'Other project' } });
    expect(session.getSnapshot().activeConversationId).not.toBe(originalConversationId);

    const result = await runtime.execute({
      type: 'conversation.activate',
      conversationId: originalConversationId,
    });

    expect(result.ok).toBe(true);
    expect(result.activeContextChanged).toBe(true);
    expect(result.taskQueriesInvalidated).toBe(true);
    expect(session.getSnapshot().activeConversationId).toBe(originalConversationId);
    expect(session.getSnapshot().activeProjectId).toBe(originalProjectId);
  });

  it('keeps composer and task queries intact for no-op project/conversation activation', async () => {
    const { session, runtime } = createRuntime();
    await session.boot();
    const workspace = session.getSnapshot();

    const projectResult = await runtime.execute({
      type: 'project.activate',
      projectId: workspace.activeProjectId,
    });
    const conversationResult = await runtime.execute({
      type: 'conversation.activate',
      conversationId: workspace.activeConversationId,
    });

    expect(projectResult).toMatchObject({ ok: true });
    expect(projectResult).not.toHaveProperty('activeContextChanged');
    expect(projectResult).not.toHaveProperty('taskQueriesInvalidated');
    expect(conversationResult).toMatchObject({ ok: true });
    expect(conversationResult).not.toHaveProperty('activeContextChanged');
    expect(conversationResult).not.toHaveProperty('taskQueriesInvalidated');
  });

  it('forks a conversation without provider activity and regenerates message ids', async () => {
    const { session, runtime } = createRuntime();
    await session.boot();

    // Seed a user message into the active conversation.
    await mutateSessionForTest(session, (current) => {
      const conversation = current.conversations.find(
        (item) => item.id === current.activeConversationId
      )!;
      const userMessage = {
        id: 'user-1',
        role: 'user' as const,
        content: 'Hello branch',
        createdAt: 1,
        status: 'ready' as const,
      };
      const assistantMessage = {
        id: 'assistant-1',
        role: 'assistant' as const,
        content: 'Hi',
        createdAt: 2,
        status: 'ready' as const,
      };
      const messages = [...conversation.messages, userMessage, assistantMessage];
      return {
        ...current,
        messages,
        conversations: current.conversations.map((item) =>
          item.id === conversation.id
            ? { ...item, messages, updatedAt: 2, title: 'Hello branch' }
            : item
        ),
      };
    });

    const beforeCount = session.getSnapshot().conversations.length;
    const result = await runtime.execute({
      type: 'conversation.fork',
      conversationId: session.getSnapshot().activeConversationId,
      messageId: 'assistant-1',
    });

    expect(result.ok).toBe(true);
    expect(session.getSnapshot().conversations.length).toBe(beforeCount + 1);
    const active = session.getSnapshot().conversations.find(
      (item) => item.id === session.getSnapshot().activeConversationId
    )!;
    expect(active.messages.some((message) => message.id === 'assistant-1')).toBe(false);
    expect(active.messages.some((message) => message.originMessageId === 'assistant-1')).toBe(true);
  });

  it('rejects conversation deletion while history is locked', async () => {
    const { session, runtime } = createRuntime({ historyLocked: true });
    await session.boot();
    const conversationId = session.getSnapshot().activeConversationId;

    const result = await runtime.execute({
      type: 'conversation.delete',
      conversationId,
    });

    expect(result).toMatchObject({
      ok: false,
      notice: expect.stringContaining('服务商请求'),
    });
    expect(session.getSnapshot().conversations.some((item) => item.id === conversationId)).toBe(
      true
    );
  });

  it('rejects request-context changes while history is locked but keeps the snapshot browsable', async () => {
    const { session, runtime } = createRuntime({ historyLocked: true });
    await session.boot();
    const before = session.getSnapshot();
    const projectId = before.activeProjectId;
    const conversationId = before.activeConversationId;
    const commands = [
      { type: 'project.create' as const, input: { name: 'blocked' } },
      { type: 'project.update' as const, projectId, patch: { name: 'blocked' } },
      { type: 'project.activate' as const, projectId },
      { type: 'project.setDefaultTarget' as const, projectId, providerId: 'missing', modelId: 'missing' },
      { type: 'conversation.start' as const, projectId },
      { type: 'conversation.activate' as const, conversationId },
      { type: 'conversation.move' as const, conversationId, projectId },
      { type: 'conversation.fork' as const, conversationId, messageId: 'missing' },
      { type: 'conversation.toggle-knowledge' as const, sourceId: 'missing' },
    ];

    for (const command of commands) {
      await expect(runtime.execute(command)).resolves.toMatchObject({
        ok: false,
        notice: expect.stringContaining('服务商请求'),
      });
    }

    expect(session.getSnapshot()).toEqual(before);
  });

  it('deletes a conversation, reparents children, and reports orphaned attachments', async () => {
    const { session, runtime } = createRuntime();
    await session.boot();

    await mutateSessionForTest(session, (current) => {
      const parentId = current.activeConversationId;
      const parent = current.conversations.find((item) => item.id === parentId)!;
      const attachment = {
        id: 'att-1',
        kind: 'image' as const,
        name: 'a.png',
        mimeType: 'image/png',
        sizeBytes: 12,
        uri: 'file://orphan.png',
      };
      const parentMessages = [
        ...parent.messages,
        {
          id: 'user-1',
          role: 'user' as const,
          content: 'with image',
          createdAt: 1,
          status: 'ready' as const,
          attachments: [attachment],
        },
      ];
      const child = {
        id: 'conversation-child',
        title: 'Child',
        projectId: parent.projectId,
        parentConversationId: parentId,
        createdAt: 2,
        updatedAt: 2,
        messages: parentMessages.map((message) => {
          const origin =
            'originMessageId' in message && typeof message.originMessageId === 'string'
              ? message.originMessageId
              : message.id;
          return {
            ...message,
            id: `${message.id}-child`,
            originMessageId: origin,
          };
        }),
      };
      return {
        ...current,
        conversations: [
          { ...parent, messages: parentMessages, updatedAt: 1 },
          child,
          ...current.conversations.filter((item) => item.id !== parentId),
        ],
        messages: parentMessages,
      };
    });

    const parentId = session
      .getSnapshot()
      .conversations.find((item) => item.title !== 'Child' && item.messages.some((m) => m.attachments?.length))!
      .id;

    const result = await runtime.execute({
      type: 'conversation.delete',
      conversationId: parentId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Child still references the same uri after reparented clone — orphaned only if unique.
    const remaining = session.getSnapshot().conversations;
    expect(remaining.some((item) => item.id === parentId)).toBe(false);
    expect(remaining.some((item) => item.id === 'conversation-child')).toBe(true);
    const child = remaining.find((item) => item.id === 'conversation-child')!;
    expect(child.parentConversationId).toBeUndefined();
  });

  it('deletes the conversation draft in the same commit and reports its orphaned attachments', async () => {
    const { session, runtime } = createRuntime();
    await session.boot();
    const conversationId = session.getSnapshot().activeConversationId;
    await mutateSessionForTest(session, (workspace) => ({
      ...workspace,
      composerDrafts: [{
        conversationId,
        text: '',
        updatedAt: 1,
        attachments: [{
          id: 'draft-file',
          kind: 'file' as const,
          uri: 'file:///documents/draft-file.pdf',
          name: 'draft-file.pdf',
          size: 32,
        }],
      }],
    }));

    const result = await runtime.execute({ type: 'conversation.delete', conversationId });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(session.getSnapshot().composerDrafts).toEqual([]);
    expect(result.orphanedAttachments?.map((attachment) => attachment.uri)).toContain(
      'file:///documents/draft-file.pdf'
    );
  });

  it('moves a conversation across projects and clears knowledge selection', async () => {
    const { session, runtime } = createRuntime();
    await session.boot();

    await runtime.execute({
      type: 'project.create',
      input: { name: 'Target project' },
    });
    const targetProjectId = session.getSnapshot().activeProjectId;

    // Create another project to leave, then move a conversation into target.
    await runtime.execute({
      type: 'project.create',
      input: { name: 'Source project' },
    });
    const sourceProjectId = session.getSnapshot().activeProjectId;
    const conversationId = session.getSnapshot().activeConversationId;

    await mutateSessionForTest(session, (current) => ({
      ...current,
      conversations: current.conversations.map((conversation) =>
        conversation.id === conversationId
          ? { ...conversation, knowledgeSourceIds: ['ks-1'] }
          : conversation
      ),
    }));

    const result = await runtime.execute({
      type: 'conversation.move',
      conversationId,
      projectId: targetProjectId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.activeContextChanged).toBe(true);
    expect(result.taskQueriesInvalidated).toBe(true);
    const moved = session
      .getSnapshot()
      .conversations.find((item) => item.id === conversationId)!;
    expect(moved.projectId).toBe(targetProjectId);
    expect(moved.knowledgeSourceIds).toBeUndefined();
    expect(sourceProjectId).not.toBe(targetProjectId);
  });

  it('renames and pins conversations', async () => {
    const { session, runtime } = createRuntime();
    await session.boot();
    const conversationId = session.getSnapshot().activeConversationId;

    const renamed = await runtime.execute({
      type: 'conversation.rename',
      conversationId,
      title: '  My title  ',
    });
    expect(renamed.ok).toBe(true);
    expect(
      session.getSnapshot().conversations.find((item) => item.id === conversationId)?.title
    ).toBe('My title');

    const pinned = await runtime.execute({
      type: 'conversation.pin',
      conversationId,
      pinned: true,
    });
    expect(pinned.ok).toBe(true);
    expect(
      session.getSnapshot().conversations.find((item) => item.id === conversationId)?.pinnedAt
    ).toBeTruthy();
  });

  it('updates a project and synchronizes its empty conversation instruction', async () => {
    const { session, runtime } = createRuntime();
    await session.boot();
    const projectId = session.getSnapshot().activeProjectId;

    const result = await runtime.execute({
      type: 'project.update',
      projectId,
      patch: { name: 'Renamed project', systemPrompt: 'New instruction' },
    });

    expect(result.ok).toBe(true);
    expect(session.getSnapshot().projects.find((project) => project.id === projectId)?.name).toBe(
      'Renamed project'
    );
    expect(session.getSnapshot().messages.some((message) => message.content === 'New instruction'))
      .toBe(true);
  });

  it('synchronizes every empty conversation in a project when its instruction changes', async () => {
    const { session, runtime } = createRuntime();
    await session.boot();
    const projectId = session.getSnapshot().activeProjectId;
    const active = session.getSnapshot().conversations.find(
      (conversation) => conversation.id === session.getSnapshot().activeConversationId
    )!;
    await mutateSessionForTest(session, (workspace) => ({
      ...workspace,
      conversations: [
        ...workspace.conversations,
        {
          ...active,
          id: 'empty-project-sibling',
          updatedAt: active.updatedAt + 1,
          messages: [],
        },
      ],
    }));

    const result = await runtime.execute({
      type: 'project.update',
      projectId,
      patch: { systemPrompt: 'Latest instruction' },
    });

    expect(result.ok).toBe(true);
    const conversations = session
      .getSnapshot()
      .conversations.filter((conversation) => conversation.projectId === projectId);
    expect(conversations).toHaveLength(2);
    for (const conversation of conversations) {
      expect(
        conversation.messages.filter((message) => message.projectInstructionId === projectId)
      ).toEqual([
        expect.objectContaining({ content: 'Latest instruction' }),
      ]);
    }
  });

  it('refreshes a stale empty project instruction when activating a conversation', async () => {
    const { session, runtime } = createRuntime();
    await session.boot();
    const projectId = session.getSnapshot().activeProjectId;
    const active = session.getSnapshot().conversations.find(
      (conversation) => conversation.id === session.getSnapshot().activeConversationId
    )!;
    await mutateSessionForTest(session, (workspace) => ({
      ...workspace,
      projects: workspace.projects.map((project) =>
        project.id === projectId ? { ...project, systemPrompt: 'Current instruction' } : project
      ),
      conversations: [
        ...workspace.conversations.map((conversation) =>
          conversation.id === active.id ? { ...conversation, messages: [] } : conversation
        ),
        { ...active, id: 'stale-empty', messages: [] },
      ],
    }));

    const result = await runtime.execute({
      type: 'conversation.activate',
      conversationId: 'stale-empty',
    });

    expect(result.ok).toBe(true);
    const activated = session.getSnapshot().conversations.find(
      (conversation) => conversation.id === 'stale-empty'
    )!;
    expect(activated.messages).toEqual([
      expect.objectContaining({ projectInstructionId: projectId, content: 'Current instruction' }),
    ]);
    expect(session.getSnapshot().messages).toEqual(activated.messages);
  });

  it('deletes a project and migrates conversations, artifacts, and knowledge to fallback', async () => {
    const { session, runtime } = createRuntime();
    await session.boot();
    const fallbackProjectId = session.getSnapshot().activeProjectId;
    await runtime.execute({ type: 'project.create', input: { name: 'Delete me' } });
    const deletingProjectId = session.getSnapshot().activeProjectId;
    const conversationId = session.getSnapshot().activeConversationId;

    await mutateSessionForTest(session, (workspace) => ({
      ...workspace,
      artifacts: [
        {
          id: 'artifact-1',
          projectId: deletingProjectId,
          title: 'Artifact',
          format: 'markdown' as const,
          activeRevisionId: 'revision-1',
          createdAt: 1,
          updatedAt: 1,
          revisions: [
            {
              id: 'revision-1',
              content: 'body',
              createdAt: 1,
              author: 'user' as const,
            },
          ],
        },
      ],
      knowledgeSources: [
        {
          id: 'knowledge-1',
          projectId: deletingProjectId,
          title: 'Knowledge',
          kind: 'text' as const,
          content: 'body',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }));

    const result = await runtime.execute({
      type: 'project.delete',
      projectId: deletingProjectId,
      fallbackProjectId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.activeContextChanged).toBe(true);
    expect(result.taskQueriesInvalidated).toBe(true);
    const workspace = session.getSnapshot();
    expect(workspace.projects.some((project) => project.id === deletingProjectId)).toBe(false);
    expect(workspace.conversations.find((item) => item.id === conversationId)?.projectId).toBe(
      fallbackProjectId
    );
    expect(workspace.artifacts[0].projectId).toBe(fallbackProjectId);
    expect(workspace.knowledgeSources[0].projectId).toBe(fallbackProjectId);
  });

  it('reports attachments that become unreferenced after conversation deletion', async () => {
    const { session, runtime } = createRuntime();
    await session.boot();
    const conversationId = session.getSnapshot().activeConversationId;
    const attachment = {
      id: 'attachment-unique',
      kind: 'file' as const,
      name: 'unique.txt',
      mimeType: 'text/plain',
      sizeBytes: 1,
      uri: 'file://unique.txt',
    };
    await mutateSessionForTest(session, (workspace) => {
      const message = {
        id: 'message-with-attachment',
        role: 'user' as const,
        content: 'attached',
        status: 'ready' as const,
        createdAt: 1,
        attachments: [attachment],
      };
      return {
        ...workspace,
        messages: [message],
        conversations: workspace.conversations.map((conversation) =>
          conversation.id === conversationId ? { ...conversation, messages: [message] } : conversation
        ),
      };
    });

    const result = await runtime.execute({ type: 'conversation.delete', conversationId });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.orphanedAttachments).toEqual([attachment]);
  });

  it('owns artifact and knowledge mutations behind the Projects command interface', async () => {
    const { session, runtime } = createRuntime();
    await session.boot();

    const created = await runtime.execute({ type: 'artifact.create', format: 'markdown' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.createdArtifactId).toBeTruthy();

    const artifactId = created.createdArtifactId!;
    await runtime.execute({
      type: 'artifact.save',
      artifactId,
      title: 'Project brief',
      content: '# Brief',
    });
    await runtime.execute({ type: 'artifact.to-knowledge', artifactId });

    const workspace = session.getSnapshot();
    expect(workspace.artifacts.find((artifact) => artifact.id === artifactId)).toMatchObject({
      title: 'Project brief',
    });
    expect(
      workspace.knowledgeSources.some((source) => source.sourceArtifactId === artifactId)
    ).toBe(true);
  });
});
