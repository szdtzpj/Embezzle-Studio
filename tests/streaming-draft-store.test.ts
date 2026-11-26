import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryWorkspacePersistenceAdapter } from '../src/app/workspace/adapters/memoryWorkspacePersistenceAdapter';
import { WorkspaceSession } from '../src/app/workspace/WorkspaceSession';
import { createDefaultWorkspace } from '../src/data/providerCatalog';
import type { ActivityTimelineStep, ToolActivityItem, WebCitation } from '../src/domain/types';
import {
  ChatWorkspaceRuntime,
  clearStreamingDraft,
  createStreamingDraftStore,
  publishStreamingDraft,
  streamingDraftStore,
  useStreamingDraftSelector,
} from '../src/features/chat/internal/ChatWorkspaceRuntime';
import { mutateSessionForTest } from './helpers/workspaceSessionTestHarness';

// 仅桩化 useMemo 与 useSyncExternalStore，验证与 E2E 一致的精简 React 钩子约束
vi.mock('react', () => ({
  useMemo: <T,>(factory: () => T) => factory(),
  useSyncExternalStore: <T,>(
    subscribe: (listener: () => void) => () => void,
    getSnapshot: () => T
  ) => {
    const unsubscribe = subscribe(() => undefined);
    const snapshot = getSnapshot();
    unsubscribe();
    return snapshot;
  },
}));

describe('streamingDraftStore 与 ChatWorkspaceRuntime 流式隔离', () => {
  beforeEach(() => {
    streamingDraftStore.clearAll();
  });

  it('发布、合并增量草稿并保护空标识与默认值', () => {
    const store = createStreamingDraftStore();

    // 空会话或空消息 ID 应安全忽略
    store.publish('', 'msg-1', { content: 'ignored' });
    store.publish('conv-1', '', { content: 'ignored' });
    expect(store.get('', 'msg-1')).toBeNull();
    expect(store.get('conv-1', '')).toBeNull();

    // 首个分片仅有思考增量与思考耗时时，自动补齐 content 与 pending 状态
    store.publish('conv-1', 'msg-1', {
      reasoningContent: '先分析需求',
      thinkingDurationMs: 180,
      status: 'pending',
    });
    const first = store.get('conv-1', 'msg-1');
    expect(first).toMatchObject({
      conversationId: 'conv-1',
      messageId: 'msg-1',
      content: '',
      reasoningContent: '先分析需求',
      thinkingDurationMs: 180,
      status: 'pending',
    });

    const citations: WebCitation[] = [
      { title: '文档', url: 'https://example.test/doc' },
    ];
    const toolActivity: ToolActivityItem[] = [
      { id: 'tool-1', toolName: 'web-search', title: '联网检索', status: 'running', startedAt: 100 },
    ];
    const activityTimeline: ActivityTimelineStep[] = [
      {
        id: 'step-1',
        kind: 'thinking',
        sequence: 1,
        title: '深度思考',
        status: 'running',
        startedAt: 100,
      },
    ];

    // 后续分片合并保留先前字段，且始终生成新不可变对象引用
    store.publish('conv-1', 'msg-1', {
      content: '正文结果',
      citations,
      webSearchTriggered: true,
      usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46 },
      toolActivity,
      activityTimeline,
    });
    const second = store.get('conv-1', 'msg-1');
    expect(second).not.toBe(first);
    expect(first?.content).toBe('');
    expect(second).toMatchObject({
      content: '正文结果',
      reasoningContent: '先分析需求',
      thinkingDurationMs: 180,
      citations,
      webSearchTriggered: true,
      usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46 },
      toolActivity,
      activityTimeline,
      status: 'pending',
    });
  });

  it('满足 useSyncExternalStore 引用稳定性并通过 useStreamingDraftSelector 返回最新切片', () => {
    expect(streamingDraftStore.get('conv-a', 'missing')).toBeNull();
    expect(useStreamingDraftSelector('conv-a', 'msg-hook')).toBeNull();
    expect(useStreamingDraftSelector(undefined, 'msg-hook')).toBeNull();

    publishStreamingDraft('conv-a', 'msg-hook', { content: '第一段', thinkingDurationMs: 90 });
    const snapshot1 = streamingDraftStore.get('conv-a', 'msg-hook');
    const snapshot2 = streamingDraftStore.get('conv-a', 'msg-hook');
    expect(snapshot1).toBe(snapshot2);

    const selected = useStreamingDraftSelector('conv-a', 'msg-hook');
    expect(selected).toBe(snapshot1);
    expect(selected).toMatchObject({
      content: '第一段',
      thinkingDurationMs: 90,
      status: 'pending',
    });
  });

  it('按 (conversationId, messageId) 分片隔离通知并在取消订阅后停止通知', () => {
    const store = createStreamingDraftStore();
    const convAMsg1Listener = vi.fn();
    const convAMsg2Listener = vi.fn();
    const convBMsg1Listener = vi.fn();

    const unsub1 = store.subscribe('conv-a', 'msg-1', convAMsg1Listener);
    const unsub2 = store.subscribe('conv-a', 'msg-2', convAMsg2Listener);
    const unsub3 = store.subscribe('conv-b', 'msg-1', convBMsg1Listener);

    for (let index = 1; index <= 220; index += 1) {
      store.publish('conv-a', 'msg-1', { content: `chunk-${index}` });
    }

    expect(convAMsg1Listener).toHaveBeenCalledTimes(220);
    expect(convAMsg2Listener).not.toHaveBeenCalled();
    expect(convBMsg1Listener).not.toHaveBeenCalled();

    unsub1();
    store.publish('conv-a', 'msg-1', { content: 'after-unsubscribe' });
    expect(convAMsg1Listener).toHaveBeenCalledTimes(220);

    unsub2();
    unsub3();
  });

  it('精确执行单条、整会话与全局清理且不产生冗余通知', () => {
    const listenerA1 = vi.fn();
    const listenerA2 = vi.fn();
    const listenerB1 = vi.fn();

    const unsubA1 = streamingDraftStore.subscribe('conv-a', 'msg-1', listenerA1);
    const unsubA2 = streamingDraftStore.subscribe('conv-a', 'msg-2', listenerA2);
    const unsubB1 = streamingDraftStore.subscribe('conv-b', 'msg-1', listenerB1);

    publishStreamingDraft('conv-a', 'msg-1', { content: 'A1' });
    publishStreamingDraft('conv-a', 'msg-2', { content: 'A2' });
    publishStreamingDraft('conv-b', 'msg-1', { content: 'B1' });

    // 清理单条与重复清理
    clearStreamingDraft('conv-a', 'msg-1');
    clearStreamingDraft('conv-a', 'msg-1');
    expect(streamingDraftStore.get('conv-a', 'msg-1')).toBeNull();
    expect(listenerA1).toHaveBeenCalledTimes(2);
    expect(listenerA2).toHaveBeenCalledTimes(1);
    expect(listenerB1).toHaveBeenCalledTimes(1);

    // 整会话清理仅影响目标会话
    clearStreamingDraft('conv-a');
    expect(streamingDraftStore.get('conv-a', 'msg-2')).toBeNull();
    expect(streamingDraftStore.get('conv-b', 'msg-1')?.content).toBe('B1');
    expect(listenerA2).toHaveBeenCalledTimes(2);
    expect(listenerB1).toHaveBeenCalledTimes(1);

    // 全局清理通知剩余活跃订阅
    streamingDraftStore.clearAll();
    expect(streamingDraftStore.get('conv-b', 'msg-1')).toBeNull();
    expect(listenerB1).toHaveBeenCalledTimes(2);

    unsubA1();
    unsubA2();
    unsubB1();
  });

  it('在高频流式期间零 WorkspaceSession 广播与零落盘，仅在终态或覆写提交成功后清理草稿', async () => {
    const initial = createDefaultWorkspace();
    const persistence = new MemoryWorkspacePersistenceAdapter({ initial });
    const saveSpy = vi.spyOn(persistence, 'save');
    const session = new WorkspaceSession({ persistence, autoBoot: false });
    await session.boot();

    const conversationId = session.getSnapshot().activeConversationId;
    const chatRuntime = new ChatWorkspaceRuntime(session);
    const assistantId = 'assistant-stream-1';

    await chatRuntime.execute({
      type: 'chat.append-messages',
      conversationId,
      messages: [
        {
          id: assistantId,
          role: 'assistant',
          content: '',
          createdAt: 100,
          status: 'pending',
        },
      ],
      now: 100,
    });
    saveSpy.mockClear();

    const sessionListener = vi.fn();
    const unsubscribe = session.subscribe(sessionListener);

    for (let index = 1; index <= 220; index += 1) {
      publishStreamingDraft(conversationId, assistantId, {
        content: `流式文本 ${index}`,
        thinkingDurationMs: 120,
      });
    }

    expect(sessionListener).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
    expect(streamingDraftStore.get(conversationId, assistantId)?.content).toBe('流式文本 220');

    // 终态 message.update 提交成功后自动清理对应草稿
    const committed = await chatRuntime.execute({
      type: 'message.update',
      conversationId,
      messageId: assistantId,
      patch: {
        content: '流式文本 220',
        thinkingDurationMs: 120,
        status: 'ready',
      },
      now: 200,
    });
    expect(committed).toBe(true);
    expect(sessionListener).toHaveBeenCalledTimes(1);
    expect(streamingDraftStore.get(conversationId, assistantId)).toBeNull();

    // conversation.set-messages 提交成功后清理整会话草稿（含复用 ID 的重生成场景）
    publishStreamingDraft(conversationId, assistantId, { content: '待重置草稿' });
    await chatRuntime.execute({
      type: 'conversation.set-messages',
      conversationId,
      messages: [],
      now: 300,
    });
    expect(streamingDraftStore.get(conversationId, assistantId)).toBeNull();

    // message.remove-through 清理截断范围草稿；message.remove-everywhere 清理跨会话残余草稿
    await mutateSessionForTest(session, (workspace) => ({
      ...workspace,
      messages: [
        { id: 'u1', role: 'user', content: 'hi', createdAt: 1, status: 'ready' },
        { id: 'a1', role: 'assistant', content: 'old', createdAt: 2, status: 'pending' },
      ],
      conversations: [
        {
          ...workspace.conversations[0],
          id: conversationId,
          messages: [
            { id: 'u1', role: 'user', content: 'hi', createdAt: 1, status: 'ready' },
            { id: 'a1', role: 'assistant', content: 'old', createdAt: 2, status: 'pending' },
          ],
        },
      ],
    }));
    publishStreamingDraft(conversationId, 'a1', { content: '将被截断' });
    await chatRuntime.execute({
      type: 'message.remove-through',
      messageId: 'a1',
      now: 400,
    });
    expect(streamingDraftStore.get(conversationId, 'a1')).toBeNull();

    unsubscribe();
  });
});
