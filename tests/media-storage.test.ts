import { indexedDB } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MediaAttachment } from '../src/domain/types';

const platform = vi.hoisted(() => ({ OS: 'web' }));
vi.mock('react-native', () => ({ Platform: platform }));

class TestFileReader {
  result: string | ArrayBuffer | null = null;
  error: Error | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  readAsDataURL(blob: Blob) {
    void blob.arrayBuffer().then(
      (buffer) => {
        this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buffer).toString('base64')}`;
        this.onload?.();
      },
      (error) => {
        this.error = error instanceof Error ? error : new Error(String(error));
        this.onerror?.();
      }
    );
  }
}

async function deleteDatabase() {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('embezzle-studio-attachments');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('test database deletion was blocked'));
  });
}

beforeEach(async () => {
  platform.OS = 'web';
  vi.stubGlobal('indexedDB', indexedDB);
  vi.stubGlobal('FileReader', TestFileReader);
  await deleteDatabase();
});

describe('Web attachment persistence', () => {
  it('stores binary data in IndexedDB and materializes it only for a request', async () => {
    const {
      attachmentForPersistence,
      materializeAttachment,
      persistAttachment,
      resolveAttachmentDisplayUri,
    } = await import('../src/services/mediaStorage');
    const attachment: MediaAttachment = {
      id: 'web-image-1',
      kind: 'image',
      uri: 'data:image/png;base64,aGVsbG8=',
      name: 'hello.png',
      mimeType: 'image/png',
      base64: 'aGVsbG8=',
    };

    const persisted = await persistAttachment(attachment);

    expect(persisted.uri).toBe('embezzle-web-attachment://web-image-1');
    expect(persisted.base64).toBeNull();
    expect(attachmentForPersistence(persisted).base64).toBeNull();
    await expect(materializeAttachment(persisted)).resolves.toMatchObject({
      base64: 'aGVsbG8=',
      size: 5,
    });
    const displayUri = await resolveAttachmentDisplayUri(persisted);
    expect(displayUri).toMatch(/^blob:/);
    URL.revokeObjectURL(displayUri);
  });

  it('deletes an owned blob only after a successful snapshot no longer references it', async () => {
    const {
      deletePersistedAttachments,
      flushPendingAttachmentDeletions,
      materializeAttachment,
      persistAttachment,
    } = await import('../src/services/mediaStorage');
    const persisted = await persistAttachment({
      id: 'web-image-2',
      kind: 'image',
      uri: 'data:image/png;base64,aGVsbG8=',
      name: 'hello.png',
      mimeType: 'image/png',
    });

    await deletePersistedAttachments([persisted]);
    await flushPendingAttachmentDeletions([persisted]);
    await expect(materializeAttachment(persisted)).resolves.toMatchObject({ base64: 'aGVsbG8=' });

    await deletePersistedAttachments([persisted]);
    await flushPendingAttachmentDeletions([]);
    await expect(materializeAttachment(persisted)).rejects.toThrow(/浏览器存储已丢失/);
  });

  it('keeps a remote URL when explicit download was not requested', async () => {
    const { persistAttachment } = await import('../src/services/mediaStorage');
    const remote: MediaAttachment = {
      id: 'remote-1',
      kind: 'image',
      uri: 'https://images.example.test/result.png',
      name: 'result.png',
    };

    await expect(persistAttachment(remote)).resolves.toMatchObject({
      uri: remote.uri,
      base64: null,
    });
  });
});
