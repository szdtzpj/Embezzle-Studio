import { describe, expect, it } from 'vitest';

import {
  normalizeConversationDrafts,
  upsertConversationDraft,
} from '../src/services/workspaceProductState';

const attachment = {
  id: 'draft-image',
  kind: 'image' as const,
  uri: 'file:///documents/draft-image.png',
  name: 'draft-image.png',
  mimeType: 'image/png',
  size: 1024,
  base64: 'should-not-survive',
};

describe('conversation draft persistence', () => {
  it('keeps attachment-only drafts and strips base64 payloads', () => {
    const drafts = normalizeConversationDrafts(
      [{ conversationId: 'conversation-a', text: '', updatedAt: 4, attachments: [attachment] }],
      new Set(['conversation-a'])
    );

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ conversationId: 'conversation-a', text: '' });
    expect(drafts[0].attachments?.[0]).toMatchObject({ uri: attachment.uri, base64: null });
  });

  it('drops an unsafe oversized draft attachment set instead of restoring unbounded data', () => {
    const drafts = normalizeConversationDrafts(
      [{
        conversationId: 'conversation-a',
        text: 'keep text',
        updatedAt: 4,
        attachments: Array.from({ length: 7 }, (_, index) => ({
          ...attachment,
          id: `draft-${index}`,
          uri: `file:///documents/draft-${index}.png`,
        })),
      }],
      new Set(['conversation-a'])
    );

    expect(drafts).toHaveLength(1);
    expect(drafts[0].text).toBe('keep text');
    expect(drafts[0].attachments).toBeUndefined();
  });

  it('supports adding and clearing attachment-only drafts without mutating callers', () => {
    const original = [{ conversationId: 'conversation-a', text: 'old', updatedAt: 1 }];
    const updated = upsertConversationDraft(original, 'conversation-a', '', 2, [attachment]);

    expect(original[0]).toEqual({ conversationId: 'conversation-a', text: 'old', updatedAt: 1 });
    expect(updated[0].attachments?.[0].uri).toBe(attachment.uri);
    const cleared = upsertConversationDraft(updated, 'conversation-a', '', 3, []);
    expect(cleared).toEqual([]);
  });
});
