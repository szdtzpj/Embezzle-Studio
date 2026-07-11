import { describe, expect, it } from 'vitest';

import type {
  ChatConversation,
  ProviderProfile,
  WorkspaceProject,
} from '../src/domain/types';
import {
  MAX_WORKSPACE_PROJECTS,
  createWorkspaceProject,
  deleteWorkspaceProject,
  moveConversationToProject,
  resolveProjectDefaultTarget,
  updateWorkspaceProject,
} from '../src/services/workspaceProjects';

function project(overrides: Partial<WorkspaceProject> = {}): WorkspaceProject {
  return {
    id: 'project-1',
    name: '默认项目',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function conversation(overrides: Partial<ChatConversation> = {}): ChatConversation {
  return {
    id: 'conversation-1',
    title: '对话',
    projectId: 'project-1',
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    ...overrides,
  };
}

function provider(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'provider-1',
    name: 'Provider',
    kind: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    capabilities: ['text'],
    models: [{ id: 'model-1', capabilities: ['text'], source: 'manual' }],
    ...overrides,
  };
}

describe('local workspace project mutations', () => {
  it('creates and updates project metadata without mutating source objects', () => {
    const source = [project()];
    const created = createWorkspaceProject(
      source,
      {
        name: '  写作项目  ',
        systemPrompt: '  保留正文缩进  ',
        defaultTarget: { providerId: ' provider-1 ', modelId: ' model-1 ' },
      },
      { id: 'project-2', now: 10 }
    );

    expect(source).toHaveLength(1);
    expect(created[0]).toMatchObject({
      id: 'project-2',
      name: '写作项目',
      systemPrompt: '  保留正文缩进  ',
      defaultTarget: { providerId: 'provider-1', modelId: 'model-1' },
      createdAt: 10,
      updatedAt: 10,
    });

    const updated = updateWorkspaceProject(
      created,
      'project-2',
      { name: '研究项目', systemPrompt: null, defaultTarget: null },
      20
    );
    expect(updated[0]).toMatchObject({ id: 'project-2', name: '研究项目', updatedAt: 20 });
    expect(updated[0]).not.toHaveProperty('systemPrompt');
    expect(updated[0]).not.toHaveProperty('defaultTarget');
    expect(created[0].systemPrompt).toBe('  保留正文缩进  ');
  });

  it('enforces local collection and Unicode field limits', () => {
    const full = Array.from({ length: MAX_WORKSPACE_PROJECTS }, (_, index) =>
      project({ id: `project-${index}` })
    );
    expect(() =>
      createWorkspaceProject(full, { name: 'overflow' }, { id: 'overflow', now: 1 })
    ).toThrow(/50/);
    expect(() =>
      createWorkspaceProject([], { name: '项'.repeat(61) }, { id: 'long', now: 1 })
    ).toThrow(/60/);
    expect(() =>
      createWorkspaceProject([], { name: 'x', systemPrompt: '🧠'.repeat(20_001) }, { id: 'long', now: 1 })
    ).toThrow(/20000/);
    expect(() =>
      createWorkspaceProject([project()], { name: 'duplicate' }, { id: 'project-1', now: 1 })
    ).toThrow(/已存在/);
  });

  it('deletes only project metadata and moves its conversations to an explicit fallback', () => {
    const projects = [
      project({ id: 'default', name: '默认项目' }),
      project({ id: 'to-delete', name: '待删除', updatedAt: 2 }),
    ];
    const conversations = [
      conversation({ id: 'move-me', projectId: 'to-delete' }),
      conversation({ id: 'keep-me', projectId: 'default' }),
    ];

    const result = deleteWorkspaceProject(projects, conversations, 'to-delete', 'default');
    expect(result.projects.map((item) => item.id)).toEqual(['default']);
    expect(result.conversations).toEqual([
      expect.objectContaining({ id: 'move-me', projectId: 'default' }),
      expect.objectContaining({ id: 'keep-me', projectId: 'default' }),
    ]);
    expect(conversations[0].projectId).toBe('to-delete');
    expect(() => deleteWorkspaceProject([projects[0]], conversations, 'default', 'default')).toThrow(/至少/);
    expect(() => deleteWorkspaceProject(projects, conversations, 'default', 'default')).toThrow(/回退/);
  });

  it('moves conversations only to known local projects', () => {
    const projects = [project(), project({ id: 'project-2', name: '第二项目' })];
    const source = [conversation()];
    const moved = moveConversationToProject(source, 'conversation-1', 'project-2', projects);
    expect(moved[0].projectId).toBe('project-2');
    expect(moved[0].updatedAt).toBe(2);
    expect(source[0].projectId).toBe('project-1');
    expect(() => moveConversationToProject(source, 'missing', 'project-2', projects)).toThrow(/对话/);
    expect(() => moveConversationToProject(source, 'conversation-1', 'missing', projects)).toThrow(/项目/);
  });

  it('detaches every parent edge that would cross projects after a move', () => {
    const projects = [project(), project({ id: 'project-2', name: '第二项目' })];
    const source = [
      conversation({ id: 'root' }),
      conversation({
        id: 'middle',
        parentConversationId: 'root',
        branchPointMessageId: 'root-message',
      }),
      conversation({
        id: 'leaf',
        parentConversationId: 'middle',
        branchPointMessageId: 'middle-message',
      }),
    ];

    const moved = moveConversationToProject(source, 'middle', 'project-2', projects);
    expect(moved.find((item) => item.id === 'middle')).toMatchObject({ projectId: 'project-2' });
    expect(moved.find((item) => item.id === 'middle')).not.toHaveProperty('parentConversationId');
    expect(moved.find((item) => item.id === 'middle')).not.toHaveProperty('branchPointMessageId');
    expect(moved.find((item) => item.id === 'leaf')).not.toHaveProperty('parentConversationId');
    expect(moved.find((item) => item.id === 'leaf')).not.toHaveProperty('branchPointMessageId');
    expect(source.find((item) => item.id === 'middle')?.parentConversationId).toBe('root');
  });
});

describe('project default target resolution', () => {
  it('returns only targets that still exist in the user-configured provider catalog', () => {
    const configured = project({
      defaultTarget: { providerId: 'provider-1', modelId: 'model-1' },
    });
    expect(resolveProjectDefaultTarget(configured, [provider()])).toEqual({
      providerId: 'provider-1',
      modelId: 'model-1',
    });
    expect(resolveProjectDefaultTarget(configured, [provider({ models: [] })])).toBeUndefined();
    expect(resolveProjectDefaultTarget(undefined, [provider()])).toBeUndefined();
  });
});
