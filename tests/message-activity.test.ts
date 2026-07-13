import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../src/domain/types';
import {
  buildMessageActivityModules,
  completeOpenThinkingSteps,
  displayModuleTitle,
  finalizeActivityTimelineForTerminalMessage,
  formatActivityElapsed,
  formatSearchActivityTitle,
  nextTimelineSequence,
  parseSearchToolDetail,
  toolActivityTitle,
  toolItemsFromMcpActivity,
  toolItemsFromWebSearchEvidence,
  upsertTimelineStep,
  upsertToolActivity,
} from '../src/services/messageActivity';

function message(partial: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: '',
    createdAt: 1_000,
    status: 'ready',
    ...partial,
  };
}

describe('message activity modules', () => {
  it('builds a running thinking module while the assistant is pending with reasoning text', () => {
    const modules = buildMessageActivityModules(
      message({
        status: 'pending',
        reasoningContent: 'step by step…',
      })
    );
    expect(modules[0]).toMatchObject({
      kind: 'thinking',
      status: 'running',
      content: 'step by step…',
    });
    expect(modules[0]?.title).toMatch(/^深度思考/);
  });

  it('does not invent a thinking module before reasoning evidence arrives', () => {
    const modules = buildMessageActivityModules(message({ status: 'pending', content: '' }));
    expect(modules).toEqual([]);
  });

  it('preserves thought → tool → thought order from activityTimeline', () => {
    const modules = buildMessageActivityModules(
      message({
        content: 'final answer',
        activityTimeline: [
          {
            id: 't1',
            kind: 'thinking',
            sequence: 0,
            status: 'completed',
            title: '深度思考',
            content: 'need search',
          },
          {
            id: 'search-1',
            kind: 'tool',
            sequence: 1,
            status: 'completed',
            toolName: 'search_web',
            title: '联网搜索：news',
            summary: '返回 3 条结果',
          },
          {
            id: 't2',
            kind: 'thinking',
            sequence: 2,
            status: 'completed',
            title: '继续思考 #2',
            content: 'compose answer',
          },
        ],
      })
    );

    expect(modules.map((item) => item.kind)).toEqual(['thinking', 'tool', 'thinking']);
    expect(modules.map((item) => item.id)).toEqual(['t1', 'search-1', 't2']);
  });

  it('maps MCP and web-search evidence into tool modules', () => {
    const modules = buildMessageActivityModules(
      message({
        content: 'done',
        webSearchTriggered: true,
        citations: [{ url: 'https://example.com', title: 'Example' }],
        mcpActivity: {
          serverLabel: 'docs',
          providerRequestCount: 2,
          approvals: [{ toolName: 'read_file', decision: 'approve' }],
          calls: [{ toolName: 'read_file', outcome: 'completed' }],
        },
      })
    );
    expect(modules.some((item) => item.kind === 'tool' && item.title.includes('read_file'))).toBe(true);
    expect(modules.some((item) => item.kind === 'tool' && item.toolName === 'web_search')).toBe(true);
  });

  it('formats search steps for humans and parses tool JSON detail', () => {
    expect(
      formatSearchActivityTitle({
        status: 'running',
        query: '阿根廷 瑞士 比赛',
      })
    ).toBe('正在搜索「阿根廷 瑞士 比赛」');
    expect(
      formatSearchActivityTitle({
        status: 'completed',
        query: 'news',
        resultCount: 5,
      })
    ).toBe('搜索「news」 · 5 条');
    expect(toolActivityTitle('search_web', { query: 'hello world' })).toBe(
      '搜索「hello world」'
    );

    const parsed = parseSearchToolDetail(
      JSON.stringify({
        items: [
          { title: 'A', url: 'https://example.com/a', text: 'body' },
          { title: 'B', url: 'https://example.com/b' },
        ],
      })
    );
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]?.title).toBe('A');

    const modules = buildMessageActivityModules(
      message({
        content: 'ok',
        activityTimeline: [
          {
            id: 's1',
            kind: 'tool',
            sequence: 0,
            status: 'completed',
            toolName: 'search_web',
            title: '联网检索: old',
            summary: '返回 2 条结果',
            arguments: { query: '阿根廷 瑞士' },
            content: JSON.stringify({
              items: [{ title: 'Hit', url: 'https://example.com' }],
            }),
          },
        ],
      })
    );
    expect(displayModuleTitle(modules[0]!)).toBe('搜索「阿根廷 瑞士」 · 2 条');
  });

  it('stops live thinking timers once the message is terminal', () => {
    const modules = buildMessageActivityModules(
      message({
        status: 'error',
        createdAt: 1_000,
        content: 'fail',
        error: 'boom',
        requestMetrics: { durationMs: 4_000 },
        activityTimeline: [
          {
            id: 't-run',
            kind: 'thinking',
            sequence: 0,
            status: 'running',
            title: '深度思考',
            content: 'still open',
            startedAt: 1_000,
          },
        ],
      })
    );
    expect(modules[0]).toMatchObject({
      kind: 'thinking',
      status: 'completed',
      finishedAt: 5_000,
    });
    expect(modules[0]?.title).toMatch(/深度思考 \(4\.0s\)/);

    const frozen = finalizeActivityTimelineForTerminalMessage(
      [
        {
          id: 't1',
          kind: 'thinking',
          sequence: 0,
          status: 'running',
          startedAt: 100,
        },
      ],
      { messageStatus: 'error', finishedAt: 900 }
    );
    expect(frozen?.[0]).toMatchObject({ status: 'completed', finishedAt: 900 });
  });

  it('prefers explicit toolActivity over synthetic web-search evidence', () => {
    const items = toolItemsFromWebSearchEvidence({
      triggered: true,
      citations: [{ url: 'https://example.com' }],
      existing: [
        {
          id: 'call-1',
          toolName: 'search_web',
          status: 'completed',
        },
      ],
    });
    expect(items).toEqual([]);
  });

  it('does not render a failed search when the model simply skipped web search', () => {
    expect(toolItemsFromWebSearchEvidence({ triggered: false })).toEqual([]);
    expect(
      buildMessageActivityModules(message({ content: 'answer', webSearchTriggered: false }))
    ).toEqual([]);
  });

  it('upserts tool activity and timeline steps by id', () => {
    const first = upsertToolActivity(undefined, {
      id: 't1',
      toolName: 'search_web',
      status: 'running',
    });
    const second = upsertToolActivity(first, {
      id: 't1',
      toolName: 'search_web',
      status: 'completed',
      summary: 'ok',
    });
    expect(second).toHaveLength(1);
    expect(second[0]?.status).toBe('completed');
    expect(second[0]?.summary).toBe('ok');

    let timeline = upsertTimelineStep(undefined, {
      id: 'think-1',
      kind: 'thinking',
      sequence: 0,
      status: 'running',
      content: 'a',
    });
    timeline = completeOpenThinkingSteps(timeline, 2_000);
    timeline = upsertTimelineStep(timeline, {
      id: 'tool-1',
      kind: 'tool',
      sequence: nextTimelineSequence(timeline),
      status: 'completed',
      toolName: 'search_web',
    });
    expect(timeline.map((step) => step.kind)).toEqual(['thinking', 'tool']);
    expect(timeline[0]?.status).toBe('completed');
    expect(timeline[1]?.sequence).toBe(1);
  });

  it('formats search tool titles and elapsed time', () => {
    expect(toolActivityTitle('search_web', { query: 'latest news' })).toBe(
      '搜索「latest news」'
    );
    expect(formatActivityElapsed(0, 1500)).toBe('1.5s');
    expect(
      toolItemsFromMcpActivity({
        serverLabel: 's',
        providerRequestCount: 1,
        approvals: [],
        calls: [{ toolName: 'x', outcome: 'failed' }],
      })[0]?.status
    ).toBe('failed');
  });
});
