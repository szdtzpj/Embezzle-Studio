import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../src/domain/types';
import { buildChatTranscript } from '../src/services/conversationContext';

function message(
  id: string,
  role: ChatMessage['role'],
  content: string,
  status: ChatMessage['status'] = 'ready'
): ChatMessage {
  return { id, role, content, status, createdAt: Number(id.replace(/\D/g, '')) || 1 };
}

describe('buildChatTranscript', () => {
  it('keeps system instructions and trims only at user-led turn boundaries', () => {
    const transcript = buildChatTranscript(
      [
        message('s1', 'system', 'system'),
        message('u1', 'user', 'old question'),
        message('a1', 'assistant', 'old answer'),
        message('u2', 'user', 'new question'),
        message('a2', 'assistant', 'new answer'),
      ],
      undefined,
      3
    );

    expect(transcript.map(({ id }) => id)).toEqual(['s1', 'u2', 'a2']);
  });

  it('drops welcome, pending, failed, cancelled, and orphan assistant messages', () => {
    const transcript = buildChatTranscript([
      message('welcome', 'assistant', 'hello'),
      message('a0', 'assistant', 'orphan'),
      message('u1', 'user', 'usable'),
      message('a1', 'assistant', 'partial', 'pending'),
      message('a2', 'assistant', 'failed', 'error'),
      message('a3', 'assistant', 'stopped', 'cancelled'),
    ]);

    expect(transcript.map(({ id }) => id)).toEqual(['u1']);
  });

  it('always retains the newest long user turn', () => {
    const latest = message('u2', 'user', 'x'.repeat(250_000));
    const transcript = buildChatTranscript([
      message('u1', 'user', 'old'),
      message('a1', 'assistant', 'answer'),
      latest,
    ]);

    expect(transcript).toEqual([latest]);
  });

  it('keeps only the comparison candidate selected for future context', () => {
    const first = {
      ...message('a1', 'assistant', 'first answer'),
      comparisonGroupId: 'compare-1',
    };
    const selected = {
      ...message('a2', 'assistant', 'selected answer'),
      comparisonGroupId: 'compare-1',
      selectedForContext: true,
    };

    const transcript = buildChatTranscript([
      message('u1', 'user', 'question'),
      first,
      selected,
      message('u2', 'user', 'follow-up'),
    ]);

    expect(transcript.map(({ id }) => id)).toEqual(['u1', 'a2', 'u2']);
  });

  it('fails closed when a comparison group has no selected candidate', () => {
    const transcript = buildChatTranscript([
      message('u1', 'user', 'question'),
      { ...message('a1', 'assistant', 'candidate one'), comparisonGroupId: 'compare-1' },
      { ...message('a2', 'assistant', 'candidate two'), comparisonGroupId: 'compare-1' },
      message('u2', 'user', 'follow-up'),
    ]);

    expect(transcript.map(({ id }) => id)).toEqual(['u1', 'u2']);
  });

  it('excludes explicitly disabled messages and keeps their assistant from becoming orphaned', () => {
    const transcript = buildChatTranscript([
      message('u1', 'user', 'excluded question'),
      { ...message('a1', 'assistant', 'excluded answer'), excludedFromContext: true },
      { ...message('u2', 'user', 'also excluded'), excludedFromContext: true },
      message('a2', 'assistant', 'must not become an orphan'),
      message('u3', 'user', 'latest'),
    ]);

    expect(transcript.map(({ id }) => id)).toEqual(['u1', 'u3']);
  });

  it('retains the complete pinned turn ahead of newer bounded history', () => {
    const transcript = buildChatTranscript(
      [
        { ...message('u1', 'user', 'pinned question'), pinnedForContext: true },
        message('a1', 'assistant', 'pinned answer'),
        message('u2', 'user', 'middle question'),
        message('a2', 'assistant', 'middle answer'),
        message('u3', 'user', 'latest question'),
        message('a3', 'assistant', 'latest answer'),
      ],
      undefined,
      4
    );

    expect(transcript.map(({ id }) => id)).toEqual(['u1', 'a1', 'u3', 'a3']);
  });

  it('supports ephemeral exclusion and pin policies without mutating messages', () => {
    const messages = [
      message('u1', 'user', 'old question'),
      message('a1', 'assistant', 'old answer'),
      message('u2', 'user', 'new question'),
    ];
    const snapshot = structuredClone(messages);
    const transcript = buildChatTranscript(messages, undefined, 2, {
      excludedMessageIds: ['u2'],
      pinnedMessageIds: ['a1'],
    });

    expect(transcript.map(({ id }) => id)).toEqual(['u1', 'a1']);
    expect(messages).toEqual(snapshot);
  });

  it('does not let many persisted pins bypass the transcript message cap', () => {
    const messages: ChatMessage[] = [];
    for (let index = 1; index <= 20; index += 1) {
      messages.push({
        ...message(`u${index}`, 'user', `question ${index}`),
        ...(index < 20 ? { pinnedForContext: true } : {}),
      });
      messages.push(message(`a${index}`, 'assistant', `answer ${index}`));
    }

    const transcript = buildChatTranscript(messages, undefined, 4);

    expect(transcript.map(({ id }) => id)).toEqual(['u19', 'a19', 'u20', 'a20']);
    expect(transcript).toHaveLength(4);
  });
});
