import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../src/domain/types';
import {
  LOCAL_KNOWLEDGE_CONTEXT_MESSAGE_ID,
  MAX_KNOWLEDGE_CONTEXT_CHARACTERS,
  composeRequestTranscript,
  estimateTextTokens,
  inspectRequestContext,
} from '../src/services/contextInspector';

function message(id: string, role: ChatMessage['role'], content: string): ChatMessage {
  return { id, role, content, createdAt: Number(id.replace(/\D/g, '')) || 1, status: 'ready' };
}

describe('request context inspector', () => {
  it('uses the exact composed transcript and inserts bounded knowledge after system instructions', () => {
    const transcript = composeRequestTranscript([
      message('s1', 'system', 'project instruction'),
      message('u1', 'user', 'question'),
    ], { knowledgeContext: 'quoted project source' });

    expect(transcript.map(({ id }) => id)).toEqual([
      's1',
      LOCAL_KNOWLEDGE_CONTEXT_MESSAGE_ID,
      'u1',
    ]);
    expect(transcript[1].content).toBe('quoted project source');
  });

  it('carries selected-source inclusion metadata into the exact local inspection', () => {
    const inspection = inspectRequestContext([message('u1', 'user', 'question')], {
      knowledgeContext: 'quoted source',
      knowledgeContextResult: {
        text: 'quoted source',
        citations: [],
        includedSourceIds: ['included'],
        missingSourceIds: ['missing'],
        omittedSourceIds: ['omitted'],
        truncated: true,
        characterCount: 13,
      },
    });

    expect(inspection).toMatchObject({
      includedKnowledgeSourceIds: ['included'],
      missingKnowledgeSourceIds: ['missing'],
      omittedKnowledgeSourceIds: ['omitted'],
      knowledgeTruncated: true,
    });
  });

  it('reports included, excluded, trimmed, and pinned messages without mutation', () => {
    const messages = [
      { ...message('u1', 'user', 'pinned'), pinnedForContext: true },
      message('a1', 'assistant', 'pinned answer'),
      { ...message('u2', 'user', 'excluded'), excludedFromContext: true },
      message('a2', 'assistant', 'excluded answer'),
      message('u3', 'user', 'middle'),
      message('a3', 'assistant', 'middle answer'),
      message('u4', 'user', 'latest'),
      message('a4', 'assistant', 'latest answer'),
    ];
    const snapshot = structuredClone(messages);
    const inspection = inspectRequestContext(messages, { maxMessages: 4 });

    expect(inspection.includedMessageIds).toEqual(['u1', 'a1', 'u4', 'a4']);
    expect(inspection.excludedMessageIds).toEqual(['u2']);
    expect(inspection.trimmedMessageIds).toEqual(expect.arrayContaining(['a2', 'u3', 'a3']));
    expect(inspection.pinnedMessageIds).toEqual(['u1']);
    expect(messages).toEqual(snapshot);
  });

  it('bounds knowledge and exposes attachment uncertainty instead of pricing it as zero', () => {
    const withAttachment: ChatMessage = {
      ...message('u1', 'user', 'inspect file'),
      attachments: [
        { id: 'file', kind: 'file', uri: 'file:///doc.txt', name: 'doc.txt' },
        { id: 'image', kind: 'image', uri: 'file:///image.png', name: 'image.png' },
      ],
    };
    const inspection = inspectRequestContext([withAttachment], {
      knowledgeContext: '知'.repeat(MAX_KNOWLEDGE_CONTEXT_CHARACTERS + 50),
      contextWindow: 100_000,
    });

    expect(inspection.knowledgeCharacters).toBe(MAX_KNOWLEDGE_CONTEXT_CHARACTERS);
    expect(inspection.attachmentCount).toBe(2);
    expect(inspection.unknownAttachmentTokenCount).toBe(2);
    expect(inspection.contextBudgetUncertain).toBe(true);
    expect(inspection.contextWindowRemainingEstimate).toBeUndefined();
    expect(inspection.estimatedInputTokens).toBeGreaterThan(0);
  });

  it('provides a conservative multilingual estimate and a context-window warning', () => {
    expect(estimateTextTokens('中文测试')).toBeGreaterThan(estimateTextTokens('test'));
    const inspection = inspectRequestContext([
      message('u1', 'user', '中'.repeat(900)),
    ], { contextWindow: 1_000 });

    expect(inspection.exceedsRecommendedContextBudget).toBe(true);
    expect(inspection.exceedsContextWindow).toBe(true);
    expect(inspection.contextWindowRemainingEstimate).toBeLessThan(200);
  });

  it.each([
    ['Arabic', 'ع'.repeat(91)],
    ['Devanagari', 'क'.repeat(91)],
    ['emoji', '😀'.repeat(23)],
    ['many newlines', `x${'\n'.repeat(91)}`],
  ])('fails the hard context gate for conservatively estimated %s input', (_, content) => {
    const inspection = inspectRequestContext(
      [message('u1', 'user', content)],
      { contextWindow: 100 }
    );

    expect(inspection.transcript.map(({ id }) => id)).toEqual(['u1']);
    expect(inspection.estimatedInputTokens).toBeGreaterThan(90);
    expect(inspection.exceedsRecommendedContextBudget).toBe(true);
    expect(inspection.exceedsContextWindow).toBe(true);
  });
});
