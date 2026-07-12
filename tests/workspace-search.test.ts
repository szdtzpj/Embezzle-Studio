import { describe, expect, it } from 'vitest';

import type {
  ChatConversation,
  PromptTemplate,
  WorkspaceProject,
} from '../src/domain/types';
import {
  MAX_WORKSPACE_SEARCH_DOCUMENTS,
  MAX_WORKSPACE_SEARCH_QUERY_LENGTH,
  MAX_WORKSPACE_SEARCH_RESULTS,
  MAX_WORKSPACE_SEARCH_FIELD_LENGTH,
  buildWorkspaceSearchIndex,
  normalizeWorkspaceSearchQuery,
  searchWorkspace,
  searchWorkspaceIndex,
  type WorkspaceSearchSource,
} from '../src/services/workspaceSearch';

function project(overrides: Partial<WorkspaceProject> = {}): WorkspaceProject {
  return {
    id: 'project-1',
    name: 'ＡＩ 研究',
    systemPrompt: '关注可靠证据',
    createdAt: 1,
    updatedAt: 10,
    ...overrides,
  };
}

function conversation(overrides: Partial<ChatConversation> = {}): ChatConversation {
  return {
    id: 'conversation-1',
    title: '季度报告',
    projectId: 'project-1',
    createdAt: 1,
    updatedAt: 20,
    messages: [
      {
        id: 'message-1',
        role: 'user',
        content: '分析 Blue Ocean 的季度数据',
        reasoningContent: '隐藏推理关键字',
        attachments: [{
          id: 'attachment-1',
          kind: 'file',
          uri: 'file:///quarter.csv',
          name: 'quarter.csv',
        }],
        createdAt: 11,
        status: 'ready',
      },
    ],
    ...overrides,
  };
}

function promptTemplate(overrides: Partial<PromptTemplate> = {}): PromptTemplate {
  return {
    id: 'template-1',
    name: '代码审查',
    content: '检查并解释潜在问题',
    mode: 'composer',
    createdAt: 1,
    updatedAt: 15,
    ...overrides,
  };
}

function source(overrides: Partial<WorkspaceSearchSource> = {}): WorkspaceSearchSource {
  return {
    projects: [project()],
    conversations: [conversation()],
    promptTemplates: [promptTemplate()],
    ...overrides,
  };
}

describe('bounded local workspace search', () => {
  it('normalizes NFKC text and returns navigable project, conversation, message, and template results', () => {
    expect(normalizeWorkspaceSearchQuery('  ai\t研究  ')).toBe('ai 研究');
    expect(searchWorkspace(source(), 'ai')[0]).toMatchObject({
      kind: 'project',
      projectId: 'project-1',
      title: 'ＡＩ 研究',
    });
    expect(searchWorkspace(source(), '季度报告')[0]).toMatchObject({
      kind: 'conversation',
      conversationId: 'conversation-1',
    });
    expect(searchWorkspace(source(), 'Blue Ocean')[0]).toMatchObject({
      kind: 'message',
      conversationId: 'conversation-1',
      messageId: 'message-1',
      matchedField: 'content',
    });
    expect(searchWorkspace(source(), 'quarter.csv')[0]).toMatchObject({
      kind: 'message',
      matchedField: 'attachment',
    });
    expect(searchWorkspace(source(), '潜在问题')[0]).toMatchObject({
      kind: 'prompt-template',
      id: 'prompt-template:template-1',
    });
  });

  it('indexes only explicit content collections and never provider or plugin secrets', () => {
    const sourceWithSecrets = {
      ...source(),
      providers: [{ apiKey: 'PROVIDER-SECRET-NEVER-INDEX' }],
      plugins: [{ authorization: 'PLUGIN-SECRET-NEVER-INDEX' }],
    };
    const index = buildWorkspaceSearchIndex(sourceWithSecrets);
    const serialized = JSON.stringify(index);
    expect(serialized).not.toContain('PROVIDER-SECRET-NEVER-INDEX');
    expect(serialized).not.toContain('PLUGIN-SECRET-NEVER-INDEX');
    expect(searchWorkspaceIndex(index, 'PROVIDER-SECRET-NEVER-INDEX')).toEqual([]);
    expect(searchWorkspaceIndex(index, 'PLUGIN-SECRET-NEVER-INDEX')).toEqual([]);
  });

  it('treats search input literally and never evaluates it as a regular expression', () => {
    const literal = source({
      conversations: [conversation({ title: '数组 [index] 说明', messages: [] })],
    });
    expect(searchWorkspace(literal, '[index]')[0]).toMatchObject({ kind: 'conversation' });
    expect(() => searchWorkspace(literal, '[*+?')).not.toThrow();
  });

  it('bounds query, indexed field, document result, and caller limit sizes', () => {
    const longQuery = 'x'.repeat(MAX_WORKSPACE_SEARCH_QUERY_LENGTH + 20);
    expect(Array.from(normalizeWorkspaceSearchQuery(longQuery))).toHaveLength(
      MAX_WORKSPACE_SEARCH_QUERY_LENGTH
    );
    expect(Array.from(normalizeWorkspaceSearchQuery('ﬃ'.repeat(200)))).toHaveLength(
      MAX_WORKSPACE_SEARCH_QUERY_LENGTH
    );

    const manyProjects = Array.from({ length: 150 }, (_, index) =>
      project({ id: `project-${index}`, name: `共同关键字 ${index}`, updatedAt: index })
    );
    expect(searchWorkspace(source({ projects: manyProjects }), '共同关键字')).toHaveLength(80);
    expect(searchWorkspace(source({ projects: manyProjects }), '共同关键字', { limit: 500 })).toHaveLength(
      MAX_WORKSPACE_SEARCH_RESULTS
    );
    expect(searchWorkspace(source({ projects: manyProjects }), '共同关键字', { limit: 3 })).toHaveLength(3);
    expect(searchWorkspace(source({ projects: manyProjects }), '共同关键字', { limit: 0 })).toEqual([]);

    const beyondFieldLimit = conversation({
      messages: [{
        id: 'too-long',
        role: 'user',
        content: `${'x'.repeat(MAX_WORKSPACE_SEARCH_FIELD_LENGTH)}UNINDEXED-SUFFIX`,
        createdAt: 1,
        status: 'ready',
      }],
    });
    expect(searchWorkspace(source({ conversations: [beyondFieldLimit] }), 'UNINDEXED-SUFFIX')).toEqual([]);
  });

  it('ranks exact title matches ahead of content matches and provides a bounded snippet', () => {
    const ranked = source({
      conversations: [
        conversation({ id: 'content', title: '其他', updatedAt: 100 }),
        conversation({ id: 'title', title: 'Blue Ocean', messages: [], updatedAt: 1 }),
      ],
    });
    const results = searchWorkspace(ranked, 'Blue Ocean');
    expect(results[0]).toMatchObject({ kind: 'conversation', conversationId: 'title' });
    const messageResult = results.find((result) => result.kind === 'message');
    expect(messageResult?.snippet).toContain('Blue Ocean');
    expect(Array.from(messageResult?.snippet ?? '').length).toBeLessThan(170);
  });

  it('retains newest messages first when the bounded document cap is reached', () => {
    const messages = Array.from(
      { length: MAX_WORKSPACE_SEARCH_DOCUMENTS + 25 },
      (_, index) => ({
        id: `message-${index}`,
        role: 'user' as const,
        content: index === 0
          ? 'oldest-cap-marker'
          : index === MAX_WORKSPACE_SEARCH_DOCUMENTS + 24
            ? 'newest-cap-marker'
            : `bounded message ${index}`,
        createdAt: index,
        status: 'ready' as const,
      })
    );
    const cappedIndex = buildWorkspaceSearchIndex(source({
      projects: [],
      promptTemplates: [],
      conversations: [conversation({ messages, updatedAt: messages.length })],
    }));

    expect(cappedIndex.documents).toHaveLength(MAX_WORKSPACE_SEARCH_DOCUMENTS);
    expect(searchWorkspaceIndex(cappedIndex, 'newest-cap-marker')).toMatchObject([
      { kind: 'message', messageId: `message-${MAX_WORKSPACE_SEARCH_DOCUMENTS + 24}` },
    ]);
    expect(searchWorkspaceIndex(cappedIndex, 'oldest-cap-marker')).toEqual([]);
  });
});
