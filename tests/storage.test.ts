import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultWorkspace } from '../src/data/providerCatalog';
import type { AppWorkspace, ChatMessage } from '../src/domain/types';

const LEGACY_WORKSPACE_KEY = '@embezzle-studio/workspace-v1';
const WORKSPACE_KEY = '@embezzle-studio/workspace-v2';
const WORKSPACE_BACKUP_KEY = '@embezzle-studio/workspace-v2.backup';
const WORKSPACE_RECOVERY_KEY = '@embezzle-studio/workspace-recovery-v2';
const COLOR_MODE_KEY = '@embezzle-studio/color-mode-v1';
const SECRET_PREFIX = 'embezzle-studio.provider-key';

const mocks = vi.hoisted(() => ({
  values: new Map<string, string>(),
  platform: { OS: 'web' },
  asyncGet: vi.fn<(key: string) => Promise<string | null>>(),
  asyncSet: vi.fn<(key: string, value: string) => Promise<void>>(),
  asyncRemove: vi.fn<(key: string) => Promise<void>>(),
  secureAvailable: vi.fn<() => Promise<boolean>>(),
  secureGet: vi.fn<(key: string) => Promise<string | null>>(),
  secureSet: vi.fn<(key: string, value: string) => Promise<void>>(),
  secureDelete: vi.fn<(key: string) => Promise<void>>(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: mocks.asyncGet,
    setItem: mocks.asyncSet,
    removeItem: mocks.asyncRemove,
  },
}));

vi.mock('expo-secure-store', () => ({
  isAvailableAsync: mocks.secureAvailable,
  getItemAsync: mocks.secureGet,
  setItemAsync: mocks.secureSet,
  deleteItemAsync: mocks.secureDelete,
}));

vi.mock('react-native', () => ({
  Platform: mocks.platform,
}));

function stripSecrets(workspace: AppWorkspace) {
  return workspace.providers.map((provider) => {
    const persistedProvider = { ...provider };
    delete persistedProvider.apiKey;
    return persistedProvider;
  });
}

function v2Envelope(workspace: AppWorkspace, revision = 1) {
  return {
    schemaVersion: 2,
    revision,
    savedAt: 1,
    workspace: {
      providers: stripSecrets(workspace),
      activeProviderId: workspace.activeProviderId,
      activeModelIdByProvider: workspace.activeModelIdByProvider,
      reasoningEffortByModel: workspace.reasoningEffortByModel,
      parameterSettings: workspace.parameterSettings,
      modelCandidatesByProvider: workspace.modelCandidatesByProvider,
      activeConversationId: workspace.activeConversationId,
      conversations: workspace.conversations,
      plugins: workspace.plugins,
    },
  };
}

function workspaceWithTitle(title: string): AppWorkspace {
  const workspace = createDefaultWorkspace();
  return {
    ...workspace,
    conversations: workspace.conversations.map((conversation, index) =>
      index === 0 ? { ...conversation, title } : conversation
    ),
  };
}

async function subject() {
  return import('../src/services/storage');
}

beforeEach(() => {
  vi.resetModules();
  mocks.values.clear();
  mocks.platform.OS = 'web';
  mocks.asyncGet.mockReset();
  mocks.asyncSet.mockReset();
  mocks.asyncRemove.mockReset();
  mocks.secureAvailable.mockReset();
  mocks.secureGet.mockReset();
  mocks.secureSet.mockReset();
  mocks.secureDelete.mockReset();

  mocks.asyncGet.mockImplementation(async (key) => mocks.values.get(key) ?? null);
  mocks.asyncSet.mockImplementation(async (key, value) => {
    mocks.values.set(key, value);
  });
  mocks.asyncRemove.mockImplementation(async (key) => {
    mocks.values.delete(key);
  });
  mocks.secureAvailable.mockResolvedValue(true);
  mocks.secureGet.mockResolvedValue(null);
  mocks.secureSet.mockResolvedValue(undefined);
  mocks.secureDelete.mockResolvedValue(undefined);
});

describe('workspace storage migrations and recovery', () => {
  it('migrates a messages-only v1 snapshot and marks persisted pending messages as interrupted errors', async () => {
    const workspace = createDefaultWorkspace();
    const userMessage: ChatMessage = {
      id: 'legacy-user',
      role: 'user',
      content: '保留这条旧消息',
      createdAt: 10,
      status: 'ready',
    };
    const pendingMessage: ChatMessage = {
      id: 'legacy-pending',
      role: 'assistant',
      content: '已经生成的部分内容',
      createdAt: 11,
      status: 'pending',
    };
    const legacyRaw = JSON.stringify({
      providers: stripSecrets(workspace),
      activeProviderId: workspace.activeProviderId,
      activeModelIdByProvider: workspace.activeModelIdByProvider,
      parameterSettings: workspace.parameterSettings,
      modelCandidatesByProvider: {},
      reasoningEffortByModel: {},
      messages: [userMessage, pendingMessage],
      plugins: [],
    });
    mocks.values.set(LEGACY_WORKSPACE_KEY, legacyRaw);

    const { loadWorkspace, saveWorkspace } = await subject();
    const loaded = await loadWorkspace();

    expect(loaded).not.toBeNull();
    expect(loaded?.providers.length).toBeGreaterThan(0);
    expect(loaded?.conversations).toHaveLength(1);
    expect(loaded?.messages.map((message) => message.id)).toEqual(['legacy-user', 'legacy-pending']);
    expect(loaded?.messages[1]).toMatchObject({
      status: 'error',
      content: '已经生成的部分内容',
      error: expect.stringContaining('中断'),
    });

    await saveWorkspace(loaded!);
    expect(mocks.values.get(LEGACY_WORKSPACE_KEY)).toBe(legacyRaw);
    expect(mocks.values.has(WORKSPACE_KEY)).toBe(true);
  });

  it('normalizes missing providers and other optional legacy fields without returning an unusable workspace', async () => {
    mocks.values.set(
      LEGACY_WORKSPACE_KEY,
      JSON.stringify({
        messages: [
          {
            id: 'legacy-message',
            role: 'user',
            content: '旧消息',
            createdAt: 1,
          },
        ],
      })
    );

    const { loadWorkspace } = await subject();
    const loaded = await loadWorkspace();

    expect(loaded?.providers.length).toBeGreaterThan(0);
    expect(loaded?.activeProviderId).toBe(loaded?.providers[0].id);
    expect(loaded?.conversations[0].messages[0].content).toBe('旧消息');
    expect(loaded?.parameterSettings).toMatchObject({ enabled: false, temperature: 1, topP: 1 });
    expect(loaded?.plugins).toEqual([]);
  });

  it('quarantines corrupt JSON and blocks the App autosave path from replacing it with defaults', async () => {
    const corruptRaw = '{not-json';
    mocks.values.set(WORKSPACE_KEY, corruptRaw);
    const { loadWorkspace, saveWorkspace } = await subject();

    await expect(loadWorkspace()).rejects.toThrow(/禁止自动保存/);
    await expect(saveWorkspace(createDefaultWorkspace())).rejects.toThrow(/暂停自动保存/);

    expect(mocks.values.get(WORKSPACE_KEY)).toBe(corruptRaw);
    const recovery = JSON.parse(mocks.values.get(WORKSPACE_RECOVERY_KEY) ?? '{}');
    expect(recovery).toMatchObject({ sourceKey: WORKSPACE_KEY, raw: corruptRaw });
  });

  it('restores a valid backup when the primary snapshot is corrupt and reports the recovery once', async () => {
    const backupWorkspace = workspaceWithTitle('backup title');
    mocks.values.set(WORKSPACE_KEY, '{broken-primary');
    mocks.values.set(WORKSPACE_BACKUP_KEY, JSON.stringify(v2Envelope(backupWorkspace, 7)));
    const { consumeStorageRecoveryNotice, loadWorkspace, saveWorkspace } = await subject();

    const loaded = await loadWorkspace();

    expect(loaded?.conversations[0].title).toBe('backup title');
    expect(consumeStorageRecoveryNotice()).toMatch(/自动从最近备份恢复/);
    expect(consumeStorageRecoveryNotice()).toBeNull();
    await expect(saveWorkspace(loaded!)).resolves.toBeUndefined();
    const recovery = JSON.parse(mocks.values.get(WORKSPACE_RECOVERY_KEY) ?? '{}');
    expect(recovery.raw).toBe('{broken-primary');
  });

  it('treats an invalid providers shape as recoverable data instead of overwriting the source snapshot', async () => {
    const invalidRaw = JSON.stringify({ providers: 'not-an-array', messages: [] });
    mocks.values.set(LEGACY_WORKSPACE_KEY, invalidRaw);
    const { loadWorkspace, saveWorkspace } = await subject();

    await expect(loadWorkspace()).rejects.toThrow(/providers 必须是数组/);
    await expect(saveWorkspace(createDefaultWorkspace())).rejects.toThrow(/暂停自动保存/);
    expect(mocks.values.get(LEGACY_WORKSPACE_KEY)).toBe(invalidRaw);
  });
});

describe('secret storage policy', () => {
  it('migrates a legacy persistent Web key into the current tab and removes plaintext storage', async () => {
    const workspace = createDefaultWorkspace();
    const providerId = workspace.providers[0].id;
    mocks.values.set(WORKSPACE_KEY, JSON.stringify(v2Envelope(workspace)));
    mocks.values.set(`${SECRET_PREFIX}.${providerId}`, 'legacy-web-key');
    const { loadWorkspace } = await subject();

    const loaded = await loadWorkspace();

    expect(loaded?.providers[0].apiKey).toBe('legacy-web-key');
    expect(mocks.values.has(`${SECRET_PREFIX}.${providerId}`)).toBe(false);
  });

  it('fails closed on native when SecureStore reports unavailable and never reads a plaintext fallback key', async () => {
    mocks.platform.OS = 'android';
    mocks.secureAvailable.mockResolvedValue(false);
    mocks.values.set(WORKSPACE_KEY, JSON.stringify(v2Envelope(createDefaultWorkspace())));
    const { loadWorkspace } = await subject();

    await expect(loadWorkspace()).rejects.toThrow(/拒绝继续/);
    expect(
      mocks.asyncGet.mock.calls.some(([key]) => key.startsWith(SECRET_PREFIX))
    ).toBe(false);
  });

  it('blocks later saves when one native SecureStore read fails', async () => {
    mocks.platform.OS = 'android';
    mocks.secureGet.mockRejectedValueOnce(new Error('keystore temporarily unavailable'));
    const raw = JSON.stringify(v2Envelope(createDefaultWorkspace()));
    mocks.values.set(WORKSPACE_KEY, raw);
    const { loadWorkspace, saveWorkspace } = await subject();

    await expect(loadWorkspace()).rejects.toThrow(/keystore temporarily unavailable/);
    await expect(saveWorkspace(createDefaultWorkspace())).rejects.toThrow(/暂停自动保存/);
    expect(mocks.values.get(WORKSPACE_KEY)).toBe(raw);
    expect(mocks.secureSet).not.toHaveBeenCalled();
  });
});

describe('versioned and ordered saves', () => {
  it('writes a v2 envelope without a duplicate top-level messages field or provider secrets', async () => {
    const workspace = createDefaultWorkspace();
    workspace.providers[0] = { ...workspace.providers[0], apiKey: 'web-only-test-key' };
    const { saveWorkspace } = await subject();

    await saveWorkspace(workspace);

    const envelope = JSON.parse(mocks.values.get(WORKSPACE_KEY) ?? '{}');
    expect(envelope.schemaVersion).toBe(2);
    expect(envelope.revision).toBe(1);
    expect(envelope.workspace.messages).toBeUndefined();
    expect(envelope.workspace.conversations[0].messages).toEqual(workspace.messages);
    expect(envelope.workspace.providers[0].apiKey).toBeUndefined();
    expect(mocks.values.has(`${SECRET_PREFIX}.${workspace.providers[0].id}`)).toBe(false);
  });

  it('does not embed native attachment base64 blobs in the workspace envelope', async () => {
    mocks.platform.OS = 'android';
    const workspace = createDefaultWorkspace();
    const message: ChatMessage = {
      id: 'image-message',
      role: 'user',
      content: 'look',
      createdAt: 2,
      status: 'ready',
      attachments: [{
        id: 'image-1',
        kind: 'image',
        uri: 'file:///documents/embezzle-attachments/image-1.png',
        name: 'image.png',
        mimeType: 'image/png',
        base64: 'a'.repeat(4096),
      }],
    };
    workspace.messages = [message];
    workspace.conversations = [{
      ...workspace.conversations[0],
      messages: [message],
    }];
    const { saveWorkspace } = await subject();

    await saveWorkspace(workspace);

    const envelope = JSON.parse(mocks.values.get(WORKSPACE_KEY) ?? '{}');
    expect(envelope.workspace.conversations[0].messages[0].attachments[0].base64).toBeUndefined();
    expect(envelope.workspace.conversations[0].messages[0].attachments[0].uri).toContain('image-1.png');
  });

  it('persists manual capability overrides instead of re-adding a rejected inferred capability', async () => {
    const workspace = createDefaultWorkspace();
    workspace.providers[0] = {
      ...workspace.providers[0],
      models: [{
        id: 'deepseek-v4-pro-260425',
        name: 'DeepSeek V4',
        source: 'manual',
        task: 'chat',
        capabilities: ['text'],
        capabilityOverrides: { reasoning: false },
      }],
    };
    workspace.activeModelIdByProvider[workspace.providers[0].id] = 'deepseek-v4-pro-260425';
    const { loadWorkspace, saveWorkspace } = await subject();

    await saveWorkspace(workspace);
    const loaded = await loadWorkspace();
    const loadedModel = loaded?.providers[0].models[0];

    expect(loadedModel?.capabilityOverrides).toEqual({ reasoning: false });
    expect(loadedModel?.capabilities).not.toContain('reasoning');
  });

  it('preserves a disabled provider across the v2 normalization boundary', async () => {
    const workspace = createDefaultWorkspace();
    workspace.providers[0] = { ...workspace.providers[0], enabled: false };
    const { loadWorkspace, saveWorkspace } = await subject();

    await saveWorkspace(workspace);
    const loaded = await loadWorkspace();

    expect(loaded?.providers[0].enabled).toBe(false);
  });

  it('preserves authoritative remote model task and capabilities across a restart', async () => {
    const workspace = createDefaultWorkspace();
    workspace.providers[0] = {
      ...workspace.providers[0],
      models: [{
        id: 'provider-owned-special-model',
        name: 'Provider special model',
        source: 'remote',
        task: 'rerank',
        capabilities: ['text', 'rerank'],
      }],
    };
    const { loadWorkspace, saveWorkspace } = await subject();

    await saveWorkspace(workspace);
    const loaded = await loadWorkspace();

    expect(loaded?.providers[0].models[0]).toMatchObject({
      task: 'rerank',
      capabilities: ['text', 'rerank'],
    });
  });

  it('serializes concurrent saves so the latest requested workspace is the final primary snapshot', async () => {
    let releaseFirst!: () => void;
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let primaryWritesStarted = 0;
    mocks.asyncSet.mockImplementation(async (key, value) => {
      if (key === WORKSPACE_KEY) {
        primaryWritesStarted += 1;
        if (primaryWritesStarted === 1) {
          await firstWriteGate;
        }
      }
      mocks.values.set(key, value);
    });
    const { saveWorkspace } = await subject();

    const firstSave = saveWorkspace(workspaceWithTitle('first'));
    await vi.waitFor(() => expect(primaryWritesStarted).toBe(1));
    const secondSave = saveWorkspace(workspaceWithTitle('second'));
    await Promise.resolve();
    expect(primaryWritesStarted).toBe(1);

    releaseFirst();
    await Promise.all([firstSave, secondSave]);

    expect(primaryWritesStarted).toBe(2);
    const finalEnvelope = JSON.parse(mocks.values.get(WORKSPACE_KEY) ?? '{}');
    const backupEnvelope = JSON.parse(mocks.values.get(WORKSPACE_BACKUP_KEY) ?? '{}');
    expect(finalEnvelope.revision).toBe(2);
    expect(finalEnvelope.workspace.conversations[0].title).toBe('second');
    expect(backupEnvelope.revision).toBe(1);
    expect(backupEnvelope.workspace.conversations[0].title).toBe('first');
  });
});

describe('appearance storage', () => {
  it('defaults to the system color mode when no preference exists', async () => {
    const { loadColorMode } = await subject();

    await expect(loadColorMode()).resolves.toBe('system');
  });

  it('round-trips a saved color mode independently from workspace snapshots', async () => {
    const { loadColorMode, saveColorMode } = await subject();

    await saveColorMode('dark');

    expect(mocks.values.get(COLOR_MODE_KEY)).toBe('dark');
    await expect(loadColorMode()).resolves.toBe('dark');
    expect(mocks.values.has(WORKSPACE_KEY)).toBe(false);
  });
});
