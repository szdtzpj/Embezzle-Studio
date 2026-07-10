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
});
