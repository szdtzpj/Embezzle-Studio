import { indexedDB } from 'fake-indexeddb';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultWorkspace } from '../src/data/providerCatalog';
import type { MediaAttachment } from '../src/domain/types';

const platform = vi.hoisted(() => ({ OS: 'web' }));
const asyncStorageStore = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native', () => ({ Platform: platform }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => asyncStorageStore.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      asyncStorageStore.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      asyncStorageStore.delete(key);
    }),
    getAllKeys: vi.fn(async () => [...asyncStorageStore.keys()]),
    multiGet: vi.fn(async (keys: readonly string[]) =>
      keys.map((key) => [key, asyncStorageStore.get(key) ?? null] as const)
    ),
    multiRemove: vi.fn(async (keys: readonly string[]) => {
      for (const key of keys) {
        asyncStorageStore.delete(key);
      }
    }),
  },
}));
vi.mock('expo-sharing', () => ({
  isAvailableAsync: async () => false,
  shareAsync: async () => undefined,
}));

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
  asyncStorageStore.clear();
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

  it('protects composerDrafts, active messages, and outbox attachments during cleanupMediaCache and localDiagnostics', async () => {
    const {
      cleanupOrphanedMediaStorage,
      materializeAttachment,
      persistAttachment,
    } = await import('../src/services/mediaStorage');
    const {
      createRedactedDiagnosticBundle,
      resolveReferencedAttachmentsForMediaCleanup,
    } = await import('../src/services/localDiagnostics');

    const draftAttachment = await persistAttachment({
      id: 'draft-img-keep',
      kind: 'image',
      uri: 'data:image/png;base64,ZHJhZnQ=',
      name: 'draft.png',
      mimeType: 'image/png',
    });
    const activeMsgAttachment = await persistAttachment({
      id: 'active-msg-img-keep',
      kind: 'image',
      uri: 'data:image/png;base64,YWN0aXZl',
      name: 'active.png',
      mimeType: 'image/png',
    });
    const outboxAttachment = await persistAttachment({
      id: 'outbox-img-keep',
      kind: 'image',
      uri: 'data:image/png;base64,b3V0Ym94',
      name: 'outbox.png',
      mimeType: 'image/png',
    });
    const orphanAttachment = await persistAttachment({
      id: 'true-orphan-img',
      kind: 'image',
      uri: 'data:image/png;base64,b3JwaGFu',
      name: 'orphan.png',
      mimeType: 'image/png',
    });

    const workspace = createDefaultWorkspace();
    workspace.composerDrafts = [
      {
        conversationId: workspace.activeConversationId,
        text: '以此图继续编辑',
        attachments: [draftAttachment],
        updatedAt: 100,
      },
    ];
    workspace.messages = [
      {
        id: 'm-active-1',
        role: 'assistant',
        content: '生成结果',
        createdAt: 99,
        status: 'ready',
        attachments: [activeMsgAttachment],
      },
    ];

    // 1) localDiagnostics 不将草稿附件或活跃消息附件误报为孤儿（仅 true-orphan 与未纳入 outbox 的媒体计为孤儿）
    const bundle = await createRedactedDiagnosticBundle(workspace, {
      phase: 'ready',
      revision: 1,
      dirty: false,
    });
    expect(bundle.mediaStorage.fileCount).toBe(4);
    expect(bundle.mediaStorage.orphanCount).toBe(2);

    // 2) SettingsToolsSectionView cleanupMediaCache 路径（含 outbox）仅删除真正孤儿，保留草稿/活跃/outbox 附件
    const settingsToolsSource = await readFile(
      path.resolve('src/features/settings/internal/SettingsToolsSectionView.tsx'),
      'utf8'
    );
    expect(settingsToolsSource).toContain('resolveReferencedAttachmentsForMediaCleanup(snapshot)');

    const referenced = await resolveReferencedAttachmentsForMediaCleanup(workspace, async () => [
      { attachments: [outboxAttachment] },
    ]);
    const cleanupResult = await cleanupOrphanedMediaStorage(referenced);
    expect(cleanupResult.deletedCount).toBe(1);
    expect(cleanupResult.orphanCount).toBe(0);

    await expect(materializeAttachment(draftAttachment)).resolves.toMatchObject({ base64: 'ZHJhZnQ=' });
    await expect(materializeAttachment(activeMsgAttachment)).resolves.toMatchObject({ base64: 'YWN0aXZl' });
    await expect(materializeAttachment(outboxAttachment)).resolves.toMatchObject({ base64: 'b3V0Ym94' });
    await expect(materializeAttachment(orphanAttachment)).rejects.toThrow(/浏览器存储已丢失/);
  });

  it('reports zero orphanCount and orphanBytes in createRedactedDiagnosticBundle immediately after cleaning up media with outbox attachments', async () => {
    const {
      cleanupOrphanedMediaStorage,
      materializeAttachment,
      persistAttachment,
    } = await import('../src/services/mediaStorage');
    const {
      createRedactedDiagnosticBundle,
      resolveReferencedAttachmentsForMediaCleanup,
    } = await import('../src/services/localDiagnostics');
    const {
      createGenerationTaskOutboxEntry,
      upsertGenerationTaskOutbox,
    } = await import('../src/services/generationTaskOutbox');

    const outboxAttachment = await persistAttachment({
      id: 'outbox-diag-keep',
      kind: 'image',
      uri: 'data:image/png;base64,b3V0Ym94',
      name: 'outbox.png',
      mimeType: 'image/png',
    });
    const orphanAttachment = await persistAttachment({
      id: 'orphan-diag-remove',
      kind: 'image',
      uri: 'data:image/png;base64,b3JwaGFu',
      name: 'orphan.png',
      mimeType: 'image/png',
    });

    const workspace = createDefaultWorkspace();
    const outboxEntry = createGenerationTaskOutboxEntry({
      conversationId: workspace.activeConversationId,
      messageId: 'm-bg-1',
      task: {
        providerId: 'openai',
        modelId: 'sora-2',
        taskId: 'task-outbox-1',
        kind: 'video',
        status: 'completed',
      },
      state: 'completed',
      attemptCount: 1,
      attachments: [outboxAttachment],
      now: 1234,
    });
    await upsertGenerationTaskOutbox(outboxEntry);

    const referenced = await resolveReferencedAttachmentsForMediaCleanup(workspace);
    const cleanupResult = await cleanupOrphanedMediaStorage(referenced);
    expect(cleanupResult.deletedCount).toBe(1);
    expect(cleanupResult.orphanCount).toBe(0);
    expect(cleanupResult.orphanBytes).toBe(0);

    const bundle = await createRedactedDiagnosticBundle(workspace, {
      phase: 'ready',
      revision: 2,
      dirty: false,
    });
    expect(bundle.mediaStorage.fileCount).toBe(1);
    expect(bundle.mediaStorage.orphanCount).toBe(0);
    expect(bundle.mediaStorage.orphanBytes).toBe(0);

    await expect(materializeAttachment(outboxAttachment)).resolves.toMatchObject({ base64: 'b3V0Ym94' });
    await expect(materializeAttachment(orphanAttachment)).rejects.toThrow(/浏览器存储已丢失/);
  });

  it('blocks remote SSRF/HTTP/non-443 downloads and enforces Web proxy boundary when downloadRemote=true', async () => {
    const { persistAttachment } = await import('../src/services/mediaStorage');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const unsafeUrls = [
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      'https://169.254.169.254/latest/meta-data/',
      'https://[::ffff:169.254.169.254]/a.png',
      'https://100.100.100.200/a.png',
      'https://cdn.example.com:8443/a.png',
      'https://user:pass@cdn.example.com/a.png',
    ];
    for (const unsafeUrl of unsafeUrls) {
      await expect(
        persistAttachment(
          {
            id: 'unsafe-remote',
            kind: 'image',
            uri: unsafeUrl,
            name: 'unsafe.png',
          },
          { downloadRemote: true }
        )
      ).rejects.toThrow(/公开 HTTPS/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();

    // Web 生产态未启用开发代理时对公网 HTTPS 同样 fail-closed，禁止直接 fetch(source)
    vi.stubEnv('EXPO_PUBLIC_ENABLE_WEB_DEV_PROXY', '0');
    await expect(
      persistAttachment(
        {
          id: 'web-prod-remote',
          kind: 'image',
          uri: 'https://cdn.example.com/ok.png',
          name: 'ok.png',
        },
        { downloadRemote: true }
      )
    ).rejects.toThrow(/正式 Web 构建不会发送/);
    expect(fetchSpy).not.toHaveBeenCalled();

    // 显式开启受控 Web 调试代理时经 127.0.0.1:8787/proxy 下载并落入 IndexedDB
    vi.stubGlobal('__DEV__', true);
    vi.stubEnv('EXPO_PUBLIC_ENABLE_WEB_DEV_PROXY', '1');
    vi.stubGlobal('window', { location: { protocol: 'http:', hostname: '127.0.0.1' } });
    const proxyFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('http://127.0.0.1:8787/proxy');
      const envelope = JSON.parse(String(init?.body)) as { url: string; method: string };
      expect(envelope.url).toBe('https://cdn.example.com/ok.png');
      expect(envelope.method).toBe('GET');
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    });
    vi.stubGlobal('fetch', proxyFetch);

    try {
      const persisted = await persistAttachment(
        {
          id: 'web-proxy-remote',
          kind: 'image',
          uri: 'https://cdn.example.com/ok.png',
          name: 'ok.png',
        },
        { downloadRemote: true }
      );
      expect(proxyFetch).toHaveBeenCalledTimes(1);
      expect(persisted.uri).toBe('embezzle-web-attachment://web-proxy-remote');
      expect(persisted.size).toBe(4);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});
