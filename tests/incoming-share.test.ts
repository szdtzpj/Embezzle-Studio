import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  incomingShareItemToAttachment,
  MAX_INCOMING_SHARE_ITEMS,
  normalizeIncomingSharePayloads,
  persistIncomingShareAttachments,
  persistIncomingShareAttachmentsIfCurrent,
} from '../src/services/incomingShare';
import { shouldReplaceIncomingShareSnapshot } from '../src/features/share/IncomingShareProvider';

const mediaMocks = vi.hoisted(() => ({
  persistAttachment: vi.fn(),
  discardUncommittedAttachments: vi.fn(async () => undefined),
}));
const fileMocks = vi.hoisted(() => ({
  sizes: new Map<string, number>(),
  missing: new Set<string>(),
}));

vi.mock('../src/services/mediaStorage', () => mediaMocks);
vi.mock('expo-file-system', () => ({
  File: class {
    constructor(readonly uri: string) {}
    get exists() {
      return !fileMocks.missing.has(this.uri);
    }
    get size() {
      return fileMocks.sizes.get(this.uri);
    }
  },
}));

vi.mock('expo-sharing', () => ({
  getSharedPayloads: vi.fn(() => []),
  getResolvedSharedPayloadsAsync: vi.fn(async () => []),
  clearSharedPayloads: vi.fn(),
}));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));

beforeEach(() => {
  mediaMocks.persistAttachment.mockReset();
  mediaMocks.discardUncommittedAttachments.mockClear();
  fileMocks.sizes.clear();
  fileMocks.missing.clear();
});

describe('incoming share normalization', () => {
  it('keeps shared text and URLs as previewable content rather than auto-sending them', () => {
    const snapshot = normalizeIncomingSharePayloads(
      [
        { value: '一段待确认的文字', shareType: 'text', mimeType: 'text/plain' },
        { value: 'https://example.com/article', shareType: 'url', mimeType: 'text/plain' },
      ],
      false
    );

    expect(snapshot.text).toEqual(['一段待确认的文字']);
    expect(snapshot.urls).toEqual(['https://example.com/article']);
    expect(snapshot.attachments).toEqual([]);
    expect(snapshot.items.every((item) => item.resolved === false)).toBe(true);
  });

  it('maps a resolved Android content URI copy into the existing attachment contract', () => {
    const snapshot = normalizeIncomingSharePayloads(
      [
        {
          value: 'content://provider/document/7',
          shareType: 'image',
          mimeType: 'image/png',
          contentUri: 'file:///data/user/0/app/cache/shared.png',
          contentType: 'image',
          contentMimeType: 'image/png',
          originalName: 'shared.png',
          contentSize: 42_000,
        },
      ],
      true
    );

    expect(snapshot.attachments).toHaveLength(1);
    const attachment = incomingShareItemToAttachment(snapshot.attachments[0]);
    expect(attachment).toMatchObject({
      kind: 'image',
      uri: 'file:///data/user/0/app/cache/shared.png',
      name: 'shared.png',
      mimeType: 'image/png',
      size: 42_000,
    });
  });

  it('maps shared audio to a generic file because the workspace attachment schema is explicit', () => {
    const snapshot = normalizeIncomingSharePayloads(
      [
        {
          value: 'content://provider/audio/1',
          shareType: 'audio',
          mimeType: 'audio/mpeg',
          contentUri: 'file:///data/user/0/app/cache/audio.mp3',
          contentType: 'audio',
          contentMimeType: 'audio/mpeg',
          originalName: 'audio.mp3',
          contentSize: 1024,
        },
      ],
      true
    );

    expect(incomingShareItemToAttachment(snapshot.attachments[0])?.kind).toBe('file');
  });

  it('prefers the resolved content MIME type after a redirected URL or provider normalization', () => {
    const snapshot = normalizeIncomingSharePayloads(
      [
        {
          value: 'https://example.com/download',
          shareType: 'file',
          mimeType: 'text/plain',
          contentUri: 'file:///data/user/0/app/cache/download.bin',
          contentType: 'file',
          contentMimeType: 'application/zip',
          originalName: 'download.bin',
          contentSize: 128,
        },
      ],
      true
    );

    expect(snapshot.attachments[0]?.mimeType).toBe('application/zip');
  });

  it('bounds multi-share intake before rendering or persisting untrusted payloads', () => {
    const snapshot = normalizeIncomingSharePayloads(
      Array.from({ length: MAX_INCOMING_SHARE_ITEMS + 10 }, (_, index) => ({
        value: `item-${index}`,
        shareType: 'text' as const,
        mimeType: 'text/plain',
      })),
      false
    );
    expect(snapshot.items).toHaveLength(MAX_INCOMING_SHARE_ITEMS);
  });

  it('rejects more composer attachments before copying any shared file', async () => {
    const snapshot = normalizeIncomingSharePayloads(
      Array.from({ length: 7 }, (_, index) => ({
        value: `content://provider/image/${index}`,
        shareType: 'image' as const,
        mimeType: 'image/png',
        contentUri: `file:///cache/${index}.png`,
        contentType: 'image',
        contentMimeType: 'image/png',
        originalName: `${index}.png`,
        contentSize: 1024,
      })),
      true
    );

    await expect(persistIncomingShareAttachments(snapshot.attachments)).rejects.toThrow('最多添加 6 个附件');
    expect(mediaMocks.persistAttachment).not.toHaveBeenCalled();
  });

  it('uses the resolved cache file size instead of trusting understated provider metadata', async () => {
    const snapshot = normalizeIncomingSharePayloads(
      [
        {
          value: 'content://provider/image/large',
          shareType: 'image',
          mimeType: 'image/png',
          contentUri: 'file:///cache/large.png',
          contentType: 'image',
          contentMimeType: 'image/png',
          originalName: 'large.png',
          contentSize: 1,
        },
      ],
      true
    );
    fileMocks.sizes.set('file:///cache/large.png', 11 * 1024 * 1024);

    await expect(persistIncomingShareAttachments(snapshot.attachments)).rejects.toThrow('10 MB 上限');
    expect(mediaMocks.persistAttachment).not.toHaveBeenCalled();
  });

  it('does not discard a resolved preview when AppState re-activation rereads the same raw share', () => {
    const resolved = normalizeIncomingSharePayloads(
      [
        {
          value: 'https://example.com/file',
          shareType: 'url',
          mimeType: 'text/plain',
          contentUri: 'file:///cache/file.pdf',
          contentType: 'file',
          contentMimeType: 'application/pdf',
          originalName: 'file.pdf',
          contentSize: 32,
        },
      ],
      true
    );
    const raw = normalizeIncomingSharePayloads(
      [{ value: 'https://example.com/file', shareType: 'url', mimeType: 'text/plain' }],
      false
    );

    expect(shouldReplaceIncomingShareSnapshot(resolved, raw)).toBe(false);
    expect(shouldReplaceIncomingShareSnapshot(resolved, { ...raw, items: [{ ...raw.items[0], value: 'other' }] })).toBe(true);
  });

  it('rolls back earlier copied attachments when a later shared item fails', async () => {
    const snapshot = normalizeIncomingSharePayloads(
      [
        {
          value: 'content://provider/image/1',
          shareType: 'image',
          mimeType: 'image/png',
          contentUri: 'file:///cache/one.png',
          contentType: 'image',
          contentMimeType: 'image/png',
          originalName: 'one.png',
          contentSize: 1024,
        },
        {
          value: 'content://provider/image/2',
          shareType: 'image',
          mimeType: 'image/png',
          contentUri: 'file:///cache/two.png',
          contentType: 'image',
          contentMimeType: 'image/png',
          originalName: 'two.png',
          contentSize: 2048,
        },
      ],
      true
    );
    const first = incomingShareItemToAttachment(snapshot.attachments[0])!;
    mediaMocks.persistAttachment
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error('copy failed'));

    await expect(persistIncomingShareAttachments(snapshot.attachments)).rejects.toThrow('copy failed');
    expect(mediaMocks.discardUncommittedAttachments).toHaveBeenCalledWith([first]);
  });

  it('reclaims copied files when a newer system share supersedes the reviewed snapshot', async () => {
    const snapshot = normalizeIncomingSharePayloads(
      [
        {
          value: 'content://provider/image/1',
          shareType: 'image',
          mimeType: 'image/png',
          contentUri: 'file:///cache/one.png',
          contentType: 'image',
          contentMimeType: 'image/png',
          originalName: 'one.png',
          contentSize: 1024,
        },
      ],
      true
    );
    const persisted = incomingShareItemToAttachment(snapshot.attachments[0])!;
    let current = true;
    mediaMocks.persistAttachment.mockImplementationOnce(async () => {
      current = false;
      return persisted;
    });

    await expect(
      persistIncomingShareAttachmentsIfCurrent(snapshot.attachments, () => current)
    ).rejects.toThrow('系统分享内容已更新');
    expect(mediaMocks.discardUncommittedAttachments).toHaveBeenCalledWith([persisted]);
  });
});
