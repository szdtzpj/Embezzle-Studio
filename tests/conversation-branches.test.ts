import { describe, expect, it } from 'vitest';

import type { ChatConversation, ChatMessage } from '../src/domain/types';
import {
  buildConversationBranchForest,
  canonicalMessageId,
  forkConversationAtMessage,
  removeConversationPreservingBranches,
} from '../src/services/conversationBranches';

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'message-1',
    role: 'user',
    content: '内容',
    createdAt: 1,
    status: 'ready',
    ...overrides,
  };
}

function conversation(overrides: Partial<ChatConversation> = {}): ChatConversation {
  return {
    id: 'conversation-parent',
    title: '父对话',
    projectId: 'project-1',
    createdAt: 1,
    updatedAt: 5,
    messages: [],
    ...overrides,
  };
}

function deterministicMetadata(conversationId = 'conversation-branch') {
  let messageSequence = 0;
  let groupSequence = 0;
  return {
    conversationId,
    now: 20,
    createMessageId: () => `${conversationId}-message-${++messageSequence}`,
    createComparisonGroupId: () => `${conversationId}-group-${++groupSequence}`,
  };
}

describe('conversation branching', () => {
  it('clones a prefix with globally new IDs, isolated comparison groups, and canonical origins', () => {
    const attachment = {
      id: 'attachment-1',
      kind: 'image' as const,
      uri: 'file:///shared.png',
      name: 'shared.png',
    };
    const parent = conversation({
      messages: [
        message({ id: 'welcome', role: 'assistant', content: '欢迎' }),
        message({ id: 'user-1', content: '比较一下' }),
        message({
          id: 'assistant-a',
          role: 'assistant',
          comparisonGroupId: 'compare-parent',
          selectedForContext: true,
          providerId: 'provider-1',
          modelId: 'model-a',
          usage: { inputTokens: 10, outputTokens: 5 },
          attachments: [attachment],
        }),
        message({
          id: 'assistant-b',
          role: 'assistant',
          comparisonGroupId: 'compare-parent',
          selectedForContext: false,
          providerId: 'provider-1',
          modelId: 'model-b',
        }),
        message({ id: 'later-user', content: '不应复制' }),
      ],
    });

    const branch = forkConversationAtMessage(
      [parent],
      parent.id,
      'assistant-b',
      deterministicMetadata()
    );

    expect(branch).toMatchObject({
      id: 'conversation-branch',
      title: '父对话 · 分支',
      projectId: 'project-1',
      parentConversationId: parent.id,
      branchPointMessageId: 'assistant-b',
      createdAt: 20,
      updatedAt: 20,
    });
    expect(branch.messages.map((item) => item.id)).toEqual([
      'conversation-branch-message-1',
      'conversation-branch-message-2',
      'conversation-branch-message-3',
    ]);
    expect(branch.messages.map(canonicalMessageId)).toEqual(['user-1', 'assistant-a', 'assistant-b']);
    expect(branch.messages.map((item) => item.comparisonGroupId)).toEqual([
      undefined,
      'conversation-branch-group-1',
      'conversation-branch-group-1',
    ]);
    expect(branch.messages.some((item) => item.id === 'welcome')).toBe(false);
    expect(parent.messages).toHaveLength(5);
    expect(parent.messages[2].comparisonGroupId).toBe('compare-parent');
    expect(branch.messages[1].attachments?.[0]).not.toBe(attachment);
    expect(branch.messages[1].attachments?.[0].uri).toBe(attachment.uri);
    expect(branch.messages[1].usage).not.toBe(parent.messages[2].usage);
  });

  it('retains the first canonical origin when branching an existing branch', () => {
    const parent = conversation({ messages: [message({ id: 'root-message' })] });
    const first = forkConversationAtMessage(
      [parent],
      parent.id,
      'root-message',
      deterministicMetadata('first-branch')
    );
    const second = forkConversationAtMessage(
      [parent, first],
      first.id,
      first.messages[0].id,
      deterministicMetadata('second-branch')
    );
    expect(second.messages[0].originMessageId).toBe('root-message');
    expect(canonicalMessageId(second.messages[0])).toBe('root-message');
  });

  it('fails closed on missing branch points and duplicate generated identities', () => {
    const parent = conversation({ messages: [message({ id: 'parent-message' })] });
    expect(() =>
      forkConversationAtMessage([parent], parent.id, 'missing', deterministicMetadata())
    ).toThrow(/分支消息/);
    expect(() =>
      forkConversationAtMessage([parent], parent.id, 'parent-message', {
        ...deterministicMetadata(),
        createMessageId: () => 'parent-message',
      })
    ).toThrow(/重复/);
    expect(() =>
      forkConversationAtMessage([parent], parent.id, 'parent-message', {
        ...deterministicMetadata(),
        conversationId: parent.id,
      })
    ).toThrow(/已存在/);
  });

  it('rejects a pending branch point so a clone cannot become permanently pending', () => {
    const parent = conversation({
      messages: [message({ id: 'pending', role: 'assistant', status: 'pending' })],
    });
    expect(() =>
      forkConversationAtMessage([parent], parent.id, 'pending', deterministicMetadata())
    ).toThrow(/仍在生成/);
  });
});

describe('branch tree maintenance', () => {
  it('builds a stable forest and promotes orphans and cycles instead of recursing forever', () => {
    const root = conversation({ id: 'root', updatedAt: 1 });
    const child = conversation({ id: 'child', parentConversationId: 'root', updatedAt: 3 });
    const orphan = conversation({ id: 'orphan', parentConversationId: 'missing', updatedAt: 4 });
    const cycleA = conversation({ id: 'cycle-a', parentConversationId: 'cycle-b', updatedAt: 5 });
    const cycleB = conversation({ id: 'cycle-b', parentConversationId: 'cycle-a', updatedAt: 6 });
    const forest = buildConversationBranchForest([root, child, orphan, cycleA, cycleB]);

    expect(forest.map((node) => node.conversation.id)).toEqual(['cycle-b', 'cycle-a', 'orphan', 'root']);
    expect(forest.at(-1)?.children.map((node) => node.conversation.id)).toEqual(['child']);
  });

  it('deletes only one node and safely remaps or detaches direct children', () => {
    const root = conversation({
      id: 'root',
      messages: [message({ id: 'root-message', originMessageId: 'canonical-message' })],
    });
    const middle = conversation({
      id: 'middle',
      parentConversationId: 'root',
      branchPointMessageId: 'root-message',
      messages: [
        message({ id: 'middle-message', originMessageId: 'canonical-message' }),
        message({ id: 'middle-only-message', originMessageId: 'middle-only-canonical' }),
      ],
    });
    const leaf = conversation({
      id: 'leaf',
      parentConversationId: 'middle',
      branchPointMessageId: 'middle-message',
    });
    const detachedLeaf = conversation({
      id: 'detached-leaf',
      parentConversationId: 'middle',
      branchPointMessageId: 'middle-only-message',
    });
    const result = removeConversationPreservingBranches(
      [root, middle, leaf, detachedLeaf],
      'middle'
    );
    expect(result.map((item) => item.id)).toEqual(['root', 'leaf', 'detached-leaf']);
    expect(result[1].parentConversationId).toBe('root');
    expect(result[1].branchPointMessageId).toBe('root-message');
    expect(result[2].parentConversationId).toBeUndefined();
    expect(result[2].branchPointMessageId).toBeUndefined();
    expect(leaf.parentConversationId).toBe('middle');
    expect(() => removeConversationPreservingBranches([root], 'missing')).toThrow(/找不到/);
  });
});
