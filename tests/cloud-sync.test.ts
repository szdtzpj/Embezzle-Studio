import { describe, expect, it, vi } from 'vitest';

import { createDefaultWorkspace } from '../src/data/providerCatalog';
import type { AppWorkspace, ChatMessage, ModelInfo, ModelTargetRef } from '../src/domain/types';
import {
  CLOUD_SYNC_MANIFEST_KEY,
  CLOUD_SYNC_PROBE_KEY,
  decideCloudSync,
  parseCloudSyncManifest,
  resolveCloudSyncConflict,
  snapshotObjectKey,
  synchronizeWorkspace,
  cloudSyncSettingsAfterError,
  verifyCloudSyncSnapshot,
  workspaceSyncContentDigest,
} from '../src/services/cloudSync';
import {
  CloudSyncError,
  type CloudSyncObject,
  type CloudSyncObjectMetadata,
  type CloudSyncPutConditions,
  type CloudSyncTransport,
} from '../src/services/cloudSyncTransport';

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('expo-secure-store', () => ({
  isAvailableAsync: vi.fn(async () => true),
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));
vi.mock('expo-crypto', () => ({
  getRandomBytesAsync: vi.fn(async (length: number) => new Uint8Array(length).fill(41)),
}));

interface StoredObject {
  body: Uint8Array;
  etag: string;
  updatedAt: number;
}

class MemorySyncTransport implements CloudSyncTransport {
  readonly kind = 'webdav' as const;
  readonly objects = new Map<string, StoredObject>();
  enforceConditions = true;
  private revision = 0;

  async head(key: string): Promise<CloudSyncObjectMetadata | null> {
    const entry = this.objects.get(key);
    return entry
      ? { key, etag: entry.etag, size: entry.body.byteLength, updatedAt: entry.updatedAt }
      : null;
  }

  async get(
    key: string,
    options: { limit?: number; signal?: AbortSignal } = {}
  ): Promise<CloudSyncObject> {
    if (options.signal?.aborted) throw new CloudSyncError('cancelled', 'cancelled');
    const entry = this.objects.get(key);
    if (!entry) throw new CloudSyncError('not-found', 'missing', { status: 404 });
    if (options.limit !== undefined && entry.body.byteLength > options.limit) {
      throw new CloudSyncError('too-large', 'too large');
    }
    return {
      key,
      body: Uint8Array.from(entry.body),
      etag: entry.etag,
      size: entry.body.byteLength,
      updatedAt: entry.updatedAt,
    };
  }

  async put(
    key: string,
    body: Uint8Array | string,
    options: {
      conditions?: CloudSyncPutConditions;
      signal?: AbortSignal;
    } = {}
  ): Promise<CloudSyncObjectMetadata> {
    if (options.signal?.aborted) throw new CloudSyncError('cancelled', 'cancelled');
    const current = this.objects.get(key);
    if (this.enforceConditions) {
      if (options.conditions?.ifNoneMatch === '*' && current) {
        throw new CloudSyncError('precondition-failed', 'exists', { status: 412 });
      }
      if (options.conditions?.ifMatch && current?.etag !== options.conditions.ifMatch) {
        throw new CloudSyncError('precondition-failed', 'changed', { status: 412 });
      }
    }
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : Uint8Array.from(body);
    this.revision += 1;
    const entry = {
      body: bytes,
      etag: `"memory-${this.revision}"`,
      updatedAt: this.revision,
    };
    this.objects.set(key, entry);
    return { key, etag: entry.etag, size: bytes.byteLength, updatedAt: entry.updatedAt };
  }
}

const encryptionPassword = 'correct horse battery staple';
const randomBytes = async (length: number) => new Uint8Array(length).fill(17);

function syncReadyWorkspace(deviceId: string): AppWorkspace {
  const workspace = createDefaultWorkspace();
  return {
    ...workspace,
    cloudSync: {
      ...workspace.cloudSync,
      enabled: true,
      endpoint: 'https://unused.example.com',
      remotePath: 'Embezzle-Studio',
      deviceId,
    },
  };
}

function withUserMessage(workspace: AppWorkspace, id: string, content: string): AppWorkspace {
  const message: ChatMessage = {
    id,
    role: 'user',
    content,
    createdAt: 1_800_000_000_000,
    status: 'ready',
  };
  const messages = [...workspace.messages, message];
  return {
    ...workspace,
    messages,
    conversations: workspace.conversations.map((conversation) =>
      conversation.id === workspace.activeConversationId
        ? { ...conversation, messages, updatedAt: message.createdAt }
        : conversation
    ),
  };
}

function credentials(password = encryptionPassword) {
  return { encryptionPassword: password };
}

describe('cloud sync reconciliation', () => {
  it('uses paired local/remote baselines to distinguish push, pull and conflict', () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    const c = 'c'.repeat(64);
    expect(decideCloudSync({ localDigest: a })).toBe('initialize');
    expect(decideCloudSync({ localDigest: a, remoteDigest: b })).toBe('conflict');
    expect(
      decideCloudSync({ localDigest: b, remoteDigest: a, lastLocalDigest: a, lastRemoteDigest: a })
    ).toBe('push');
    expect(
      decideCloudSync({ localDigest: a, remoteDigest: b, lastLocalDigest: a, lastRemoteDigest: a })
    ).toBe('pull');
    expect(
      decideCloudSync({ localDigest: b, remoteDigest: c, lastLocalDigest: a, lastRemoteDigest: a })
    ).toBe('conflict');
    expect(
      decideCloudSync({ localDigest: a, lastLocalDigest: a, lastRemoteDigest: b })
    ).toBe('remote-missing');
  });

  it('initializes with an immutable encrypted snapshot, proves CAS, then no-ops unchanged state', async () => {
    const transport = new MemorySyncTransport();
    const workspace = syncReadyWorkspace('device-a');
    workspace.providers[0].apiKey = 'must-never-appear-in-snapshot';
    const first = await synchronizeWorkspace({
      workspace,
      credentials: credentials(),
      transport,
      now: 1_800_000_000_100,
      randomBytes,
    });
    expect(first.outcome).toBe('initialized');
    expect(first.workspace.cloudSync.lastStatus).toBe('synced');
    expect(first.workspace.cloudSync.lastSyncedDigest).toBe(first.localDigest);
    expect(transport.objects.has(CLOUD_SYNC_PROBE_KEY)).toBe(true);

    const manifestObject = await transport.get(CLOUD_SYNC_MANIFEST_KEY);
    const manifest = parseCloudSyncManifest(manifestObject.body);
    expect(manifest.current.contentDigest).toBe(first.localDigest);
    expect(manifest.current.objectKey).toBe(snapshotObjectKey(manifest.current.objectDigest));
    const snapshot = await transport.get(manifest.current.objectKey);
    const encryptedText = new TextDecoder().decode(snapshot.body);
    expect(encryptedText).not.toContain('must-never-appear-in-snapshot');
    await expect(
      verifyCloudSyncSnapshot(encryptedText, encryptionPassword, manifest.current.objectDigest)
    ).resolves.toBeUndefined();

    const beforeKeys = [...transport.objects.keys()];
    const second = await synchronizeWorkspace({
      workspace: first.workspace,
      credentials: credentials(),
      transport,
      now: 1_800_000_000_200,
      randomBytes,
    });
    expect(second.outcome).toBe('unchanged');
    expect([...transport.objects.keys()]).toEqual(beforeKeys);
  });

  it('rejects a valid encrypted object when the manifest content digest is forged', async () => {
    const transport = new MemorySyncTransport();
    const initialized = await synchronizeWorkspace({
      workspace: syncReadyWorkspace('device-a'),
      credentials: credentials(),
      transport,
      now: 1_800_000_000_500,
      randomBytes,
    });
    const manifestObject = await transport.get(CLOUD_SYNC_MANIFEST_KEY);
    const manifest = parseCloudSyncManifest(manifestObject.body);
    manifest.current.contentDigest = 'f'.repeat(64);
    await transport.put(CLOUD_SYNC_MANIFEST_KEY, JSON.stringify(manifest), {
      conditions: { ifMatch: manifestObject.etag },
    });

    await expect(
      synchronizeWorkspace({
        workspace: initialized.workspace,
        credentials: credentials(),
        transport,
        now: 1_800_000_000_600,
        randomBytes,
      })
    ).rejects.toMatchObject({ code: 'integrity-mismatch' });
  });

  it('validates the portable payload before device-local disabled-target normalization', async () => {
    const transport = new MemorySyncTransport();
    const initialized = await synchronizeWorkspace({
      workspace: syncReadyWorkspace('device-a'),
      credentials: credentials(),
      transport,
      now: 1_800_000_000_700,
      randomBytes,
    });
    const deviceBBase: AppWorkspace = {
      ...initialized.workspace,
      cloudSync: { ...initialized.workspace.cloudSync, deviceId: 'device-b' },
    };
    const disabledProviderId = initialized.workspace.providers[0].id;
    const enabledProviderId = initialized.workspace.providers[1].id;
    const disabledModel: ModelInfo = {
      id: 'disabled-sync-model',
      capabilities: ['text'],
      source: 'manual',
    };
    const enabledModel: ModelInfo = {
      id: 'enabled-sync-model',
      capabilities: ['text'],
      source: 'manual',
    };
    const disabledTarget: ModelTargetRef = {
      providerId: disabledProviderId,
      modelId: disabledModel.id,
    };
    const enabledTarget: ModelTargetRef = {
      providerId: enabledProviderId,
      modelId: enabledModel.id,
    };
    const remoteWorkspace: AppWorkspace = {
      ...initialized.workspace,
      providers: initialized.workspace.providers.map((provider, index) =>
        index === 0
          ? { ...provider, enabled: false, models: [disabledModel] }
          : index === 1
            ? { ...provider, enabled: true, models: [enabledModel] }
            : provider
      ),
      activeProviderId: disabledProviderId,
      activeModelIdByProvider: {
        ...initialized.workspace.activeModelIdByProvider,
        [disabledProviderId]: disabledModel.id,
        [enabledProviderId]: enabledModel.id,
      },
      projects: initialized.workspace.projects.map((project, index) =>
        index === 0 ? { ...project, defaultTarget: disabledTarget } : project
      ),
      comparisonEnabled: true,
      comparisonTargets: [disabledTarget, enabledTarget],
      voice: {
        ...initialized.workspace.voice,
        transcriptionTarget: disabledTarget,
        speechTarget: disabledTarget,
      },
    };
    const pushed = await synchronizeWorkspace({
      workspace: remoteWorkspace,
      credentials: credentials(),
      transport,
      now: 1_800_000_000_800,
      randomBytes,
    });
    expect(pushed.outcome).toBe('pushed');

    const pulled = await synchronizeWorkspace({
      workspace: deviceBBase,
      credentials: credentials(),
      transport,
      now: 1_800_000_000_900,
      randomBytes,
    });
    expect(pulled.outcome).toBe('pulled');
    expect(pulled.workspace.providers.find((provider) => provider.id === disabledProviderId)?.enabled).toBe(false);
    expect(pulled.workspace.activeProviderId).toBe(enabledProviderId);
    expect(pulled.workspace.projects[0].defaultTarget).toBeUndefined();
    expect(pulled.workspace.comparisonTargets).toEqual([enabledTarget]);
    expect(pulled.workspace.comparisonEnabled).toBe(false);
    expect(pulled.workspace.voice.transcriptionTarget).toBeUndefined();
    expect(pulled.workspace.voice.speechTarget).toBeUndefined();
    expect(pulled.localDigest).not.toBe(pulled.remoteDigest);
  }, 20_000);

  it('accepts an authenticated all-disabled portable snapshot before safe local recovery', async () => {
    const transport = new MemorySyncTransport();
    const initialized = await synchronizeWorkspace({
      workspace: syncReadyWorkspace('device-a'),
      credentials: credentials(),
      transport,
      now: 1_800_000_000_950,
      randomBytes,
    });
    const deviceBBase: AppWorkspace = {
      ...initialized.workspace,
      cloudSync: { ...initialized.workspace.cloudSync, deviceId: 'device-b' },
    };
    const remoteWorkspace: AppWorkspace = {
      ...initialized.workspace,
      providers: initialized.workspace.providers.map((provider) => ({
        ...provider,
        enabled: false,
      })),
      webSearch: { ...initialized.workspace.webSearch, enabled: true },
    };
    const pushed = await synchronizeWorkspace({
      workspace: remoteWorkspace,
      credentials: credentials(),
      transport,
      now: 1_800_000_000_975,
      randomBytes,
    });
    expect(pushed.outcome).toBe('pushed');

    const pulled = await synchronizeWorkspace({
      workspace: deviceBBase,
      credentials: credentials(),
      transport,
      now: 1_800_000_001_000,
      randomBytes,
    });
    expect(pulled.outcome).toBe('pulled');
    expect(pulled.workspace.providers[0].enabled).toBe(true);
    expect(pulled.workspace.providers.slice(1).every((provider) => provider.enabled === false)).toBe(true);
    expect(pulled.workspace.webSearch.enabled).toBe(false);
    expect(pulled.localDigest).not.toBe(pulled.remoteDigest);
  }, 20_000);

  it('pulls remote-only changes and retains both immutable snapshots on a true conflict', async () => {
    const transport = new MemorySyncTransport();
    const initialized = await synchronizeWorkspace({
      workspace: syncReadyWorkspace('device-a'),
      credentials: credentials(),
      transport,
      now: 1_800_000_001_000,
      randomBytes,
    });
    const deviceBBase: AppWorkspace = {
      ...initialized.workspace,
      cloudSync: { ...initialized.workspace.cloudSync, deviceId: 'device-b' },
    };
    const deviceAChanged = withUserMessage(initialized.workspace, 'message-a', 'remote A change');
    const pushed = await synchronizeWorkspace({
      workspace: deviceAChanged,
      credentials: credentials(),
      transport,
      now: 1_800_000_001_100,
      randomBytes,
    });
    expect(pushed.outcome).toBe('pushed');

    const pulled = await synchronizeWorkspace({
      workspace: deviceBBase,
      credentials: credentials(),
      transport,
      now: 1_800_000_001_200,
      randomBytes,
    });
    expect(pulled.outcome).toBe('pulled');
    expect(pulled.workspace.messages.some((message) => message.content === 'remote A change')).toBe(true);

    const deviceBChanged = withUserMessage(deviceBBase, 'message-b', 'local B change');
    const conflicted = await synchronizeWorkspace({
      workspace: deviceBChanged,
      credentials: credentials(),
      transport,
      now: 1_800_000_001_300,
      randomBytes,
    });
    expect(conflicted.outcome).toBe('conflict');
    expect(conflicted.conflict).toMatchObject({
      localDigest: workspaceSyncContentDigest(deviceBChanged),
      remoteDigest: pushed.remoteDigest,
    });
    expect(conflicted.conflict?.localObjectKey).toBeTruthy();
    expect(transport.objects.has(conflicted.conflict!.localObjectKey!)).toBe(true);
    expect(transport.objects.has(conflicted.conflict!.remoteObjectKey)).toBe(true);
    const manifest = parseCloudSyncManifest((await transport.get(CLOUD_SYNC_MANIFEST_KEY)).body);
    expect(manifest.current.contentDigest).toBe(pushed.remoteDigest);
    await expect(
      synchronizeWorkspace({
        workspace: conflicted.workspace,
        credentials: credentials(),
        transport,
        now: 1_800_000_001_400,
        randomBytes,
      })
    ).rejects.toMatchObject({ code: 'precondition-failed' });

    const resolved = await resolveCloudSyncConflict({
      workspace: conflicted.workspace,
      credentials: credentials(),
      transport,
      conflictId: conflicted.conflict!.id,
      strategy: 'keep-local',
      now: 1_800_000_001_500,
      randomBytes,
    });
    expect(resolved.outcome).toBe('pushed');
    expect(resolved.workspace.cloudSync.conflicts).toHaveLength(0);
    expect(
      parseCloudSyncManifest((await transport.get(CLOUD_SYNC_MANIFEST_KEY)).body).current.contentDigest
    ).toBe(conflicted.localDigest);
  });

  it('rejects an ignored conditional header before writing the real manifest', async () => {
    const transport = new MemorySyncTransport();
    transport.enforceConditions = false;
    await expect(
      synchronizeWorkspace({
        workspace: syncReadyWorkspace('device-unsafe'),
        credentials: credentials(),
        transport,
        now: 1_800_000_002_000,
        randomBytes,
      })
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(transport.objects.has(CLOUD_SYNC_PROBE_KEY)).toBe(true);
    expect(transport.objects.has(CLOUD_SYNC_MANIFEST_KEY)).toBe(false);
  });

  it('fails before replacement on a wrong password or corrupted remote snapshot', async () => {
    const transport = new MemorySyncTransport();
    const initialized = await synchronizeWorkspace({
      workspace: syncReadyWorkspace('device-a'),
      credentials: credentials(),
      transport,
      now: 1_800_000_003_000,
      randomBytes,
    });
    const baseB: AppWorkspace = {
      ...initialized.workspace,
      cloudSync: { ...initialized.workspace.cloudSync, deviceId: 'device-b' },
    };
    const pushed = await synchronizeWorkspace({
      workspace: withUserMessage(initialized.workspace, 'remote-change', 'new remote'),
      credentials: credentials(),
      transport,
      now: 1_800_000_003_100,
      randomBytes,
    });
    expect(pushed.outcome).toBe('pushed');

    await expect(
      synchronizeWorkspace({
        workspace: baseB,
        credentials: credentials('wrong password value'),
        transport,
        now: 1_800_000_003_200,
        randomBytes,
      })
    ).rejects.toMatchObject({ code: 'decrypt-failed' });

    const manifest = parseCloudSyncManifest((await transport.get(CLOUD_SYNC_MANIFEST_KEY)).body);
    const stored = transport.objects.get(manifest.current.objectKey)!;
    const corrupted = Uint8Array.from(stored.body);
    corrupted[Math.floor(corrupted.length / 2)] ^= 1;
    transport.objects.set(manifest.current.objectKey, { ...stored, body: corrupted });
    await expect(
      synchronizeWorkspace({
        workspace: baseB,
        credentials: credentials(),
        transport,
        now: 1_800_000_003_300,
        randomBytes,
      })
    ).rejects.toMatchObject({ code: 'integrity-mismatch' });
  });
});

describe('cloud sync manifest validation', () => {
  it('rejects unknown fields, mismatched object keys and duplicate history', () => {
    const objectDigest = 'a'.repeat(64);
    const contentDigest = 'b'.repeat(64);
    const ref = {
      objectKey: snapshotObjectKey(objectDigest),
      objectDigest,
      contentDigest,
      size: 100,
      createdAt: 1,
      deviceId: 'device-a',
    };
    const valid = {
      magic: 'embezzle-studio-sync-manifest',
      version: 1,
      updatedAt: 1,
      current: ref,
      history: [],
    };
    expect(parseCloudSyncManifest(JSON.stringify(valid)).current).toEqual(ref);
    expect(() => parseCloudSyncManifest(JSON.stringify({ ...valid, secret: 'nope' }))).toThrow(
      /未知字段/
    );
    expect(() =>
      parseCloudSyncManifest(
        JSON.stringify({ ...valid, current: { ...ref, objectKey: 'other.enc.json' } })
      )
    ).toThrow(/不匹配/);
    expect(() => parseCloudSyncManifest(JSON.stringify({ ...valid, history: [ref] }))).toThrow(
      /重复快照/
    );
  });

  it('redacts credential-like values from persisted diagnostics errors', () => {
    const workspace = syncReadyWorkspace('device-redact');
    const settings = cloudSyncSettingsAfterError(
      workspace.cloudSync,
      new Error('HTTP 403 password=top-secret&token=abc123')
    );
    expect(settings.lastError).toBe('HTTP 403 password=[redacted]&token=[redacted]');
    const jsonSettings = cloudSyncSettingsAfterError(
      workspace.cloudSync,
      new Error('{"password":"top-secret","token":"abc123","x-amz-security-token":"session"}')
    );
    expect(jsonSettings.lastError).toBe('{"password=[redacted],"token=[redacted],"x-amz-security-token=[redacted]}');
  });
});
