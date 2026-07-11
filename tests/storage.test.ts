import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultWorkspace } from '../src/data/providerCatalog';
import type { AppWorkspace, ChatMessage } from '../src/domain/types';

const LEGACY_WORKSPACE_KEY = '@embezzle-studio/workspace-v1';
const V2_WORKSPACE_KEY = '@embezzle-studio/workspace-v2';
const V2_WORKSPACE_BACKUP_KEY = '@embezzle-studio/workspace-v2.backup';
const V3_WORKSPACE_KEY = '@embezzle-studio/workspace-v3';
const WORKSPACE_KEY = '@embezzle-studio/workspace-v4';
const WORKSPACE_BACKUP_KEY = '@embezzle-studio/workspace-v4.backup';
const WORKSPACE_RECOVERY_KEY = '@embezzle-studio/workspace-recovery-v4';
const SECRET_PREFIX = 'embezzle-studio.provider-key';
const PLUGIN_SECRET_PREFIX = 'embezzle-studio.plugin-authorization';

const mocks = vi.hoisted(() => ({
  values: new Map<string, string>(),
  secureValues: new Map<string, string>(),
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

function v3Envelope(workspace: AppWorkspace, revision = 1) {
  return {
    ...v2Envelope(workspace, revision),
    schemaVersion: 3,
  };
}

function v4Envelope(workspace: AppWorkspace, revision = 1) {
  return {
    schemaVersion: 4,
    revision,
    savedAt: 1,
    workspace: {
      ...workspace,
      providers: stripSecrets(workspace),
      messages: undefined,
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
  mocks.secureValues.clear();
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
  mocks.secureGet.mockImplementation(async (key) => mocks.secureValues.get(key) ?? null);
  mocks.secureSet.mockImplementation(async (key, value) => {
    mocks.secureValues.set(key, value);
  });
  mocks.secureDelete.mockImplementation(async (key) => {
    mocks.secureValues.delete(key);
  });
});

describe('workspace storage migrations and recovery', () => {
  it('loads a v2 envelope from the previous key and writes the next save as v4', async () => {
    const workspace = workspaceWithTitle('v2 migration');
    mocks.values.set(V2_WORKSPACE_KEY, JSON.stringify(v2Envelope(workspace, 4)));
    const { loadWorkspace, saveWorkspace } = await subject();

    const loaded = await loadWorkspace();
    expect(loaded?.conversations[0].title).toBe('v2 migration');
    await saveWorkspace(loaded!);

    const v4 = JSON.parse(mocks.values.get(WORKSPACE_KEY) ?? '{}');
    expect(v4.schemaVersion).toBe(4);
    expect(v4.revision).toBe(5);
    expect(mocks.values.has(V2_WORKSPACE_KEY)).toBe(true);
  });

  it('loads a v3 envelope, creates the default project, and writes the next save as v4', async () => {
    const workspace = workspaceWithTitle('v3 migration');
    const legacy = v3Envelope(workspace, 9);
    delete (legacy.workspace as Partial<AppWorkspace>).projects;
    delete (legacy.workspace as Partial<AppWorkspace>).activeProjectId;
    delete (legacy.workspace as Partial<AppWorkspace>).costGuard;
    delete (legacy.workspace as Partial<AppWorkspace>).providerUsageEvents;
    legacy.workspace.conversations = legacy.workspace.conversations.map((conversation) => {
      const migrated = { ...conversation };
      delete migrated.projectId;
      return migrated;
    });
    mocks.values.set(V3_WORKSPACE_KEY, JSON.stringify(legacy));
    const { loadWorkspace, saveWorkspace } = await subject();

    const loaded = await loadWorkspace();

    expect(loaded?.projects).toHaveLength(1);
    expect(loaded?.activeProjectId).toBe(loaded?.projects[0].id);
    expect(loaded?.conversations[0]).toMatchObject({
      title: 'v3 migration',
      projectId: loaded?.projects[0].id,
    });
    expect(loaded?.costGuard).toMatchObject({ enabled: false, maxOutputTokens: 4096 });
    expect(loaded?.providerUsageEvents).toEqual([]);

    await saveWorkspace(loaded!);
    const v4 = JSON.parse(mocks.values.get(WORKSPACE_KEY) ?? '{}');
    expect(v4).toMatchObject({ schemaVersion: 4, revision: 10 });
    expect(v4.workspace.projects).toHaveLength(1);
    expect(mocks.values.has(V3_WORKSPACE_KEY)).toBe(true);
  });

  it('can recover a corrupt v2 primary from its v2 backup during migration', async () => {
    const backupWorkspace = workspaceWithTitle('v2 backup recovery');
    mocks.values.set(V2_WORKSPACE_KEY, '{broken-v2');
    mocks.values.set(V2_WORKSPACE_BACKUP_KEY, JSON.stringify(v2Envelope(backupWorkspace, 8)));
    const { consumeStorageRecoveryNotice, loadWorkspace } = await subject();

    const loaded = await loadWorkspace();

    expect(loaded?.conversations[0].title).toBe('v2 backup recovery');
    expect(consumeStorageRecoveryNotice()).toMatch(/自动从最近备份恢复/);
  });

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

  it('derives one canonical local usage event from v3 branch copies', async () => {
    const workspace = createDefaultWorkspace();
    const original: ChatMessage = {
      id: 'assistant-original',
      role: 'assistant',
      content: 'original answer',
      createdAt: 1_700_000_000_000,
      status: 'ready',
      providerId: workspace.providers[0].id,
      modelId: 'legacy-chat-model',
      webSearchTriggered: true,
    };
    const inherited: ChatMessage = {
      ...original,
      id: 'assistant-inherited',
      originMessageId: original.id,
    };
    workspace.messages = [original];
    workspace.conversations = [
      {
        id: 'root-conversation',
        title: 'Root',
        createdAt: 1,
        updatedAt: 2,
        messages: [original],
      },
      {
        id: 'branch-conversation',
        title: 'Branch',
        createdAt: 3,
        updatedAt: 4,
        messages: [inherited],
      },
    ];
    workspace.activeConversationId = 'root-conversation';
    const legacy = v3Envelope(workspace, 3);
    mocks.values.set(V3_WORKSPACE_KEY, JSON.stringify(legacy));
    const { loadWorkspace } = await subject();

    const loaded = await loadWorkspace();

    expect(loaded?.providerUsageEvents).toHaveLength(1);
    expect(loaded?.providerUsageEvents[0]).toMatchObject({
      id: 'migrated-assistant-original',
      kind: 'web-search',
      status: 'succeeded',
      messageId: 'assistant-original',
      unknownCostComponents: ['input-tokens', 'output-tokens', 'web-search-tool'],
    });
  });

  it('normalizes v4 project, branch, cost-guard, and local-ledger structure', async () => {
    const workspace = createDefaultWorkspace();
    const providerId = workspace.providers[0].id;
    workspace.providers[0] = {
      ...workspace.providers[0],
      models: [{
        id: 'chat-model',
        name: 'Chat model',
        source: 'manual',
        task: 'chat',
        capabilities: ['text'],
      }],
    };
    workspace.projects = [
      {
        id: 'project-one',
        name: 'One',
        defaultTarget: { providerId, modelId: 'chat-model' },
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'project-two',
        name: 'Two',
        defaultTarget: { providerId, modelId: 'missing-model' },
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    workspace.activeProjectId = 'project-one';
    const message = (id: string): ChatMessage => ({
      id,
      role: 'user',
      content: id,
      createdAt: 1,
      status: 'ready',
    });
    workspace.conversations = [
      {
        id: 'root', title: 'Root', projectId: 'project-one', createdAt: 1, updatedAt: 1,
        messages: [message('welcome'), message('root-message')],
      },
      {
        id: 'valid-child', title: 'Valid', projectId: 'project-one', createdAt: 1, updatedAt: 1,
        parentConversationId: 'root', branchPointMessageId: 'root-message', messages: [message('child-message')],
      },
      {
        id: 'wrong-point', title: 'Wrong point', projectId: 'project-one', createdAt: 1, updatedAt: 1,
        parentConversationId: 'root', branchPointMessageId: 'missing-message', messages: [message('wrong-message')],
      },
      {
        id: 'welcome-point', title: 'Welcome point', projectId: 'project-one', createdAt: 1, updatedAt: 1,
        parentConversationId: 'root', branchPointMessageId: 'welcome', messages: [message('welcome-child-message')],
      },
      {
        id: 'cross-project', title: 'Cross project', projectId: 'project-two', createdAt: 1, updatedAt: 1,
        parentConversationId: 'root', branchPointMessageId: 'root-message', messages: [message('cross-message')],
      },
      {
        id: 'cycle-a', title: 'Cycle A', projectId: 'project-one', createdAt: 1, updatedAt: 1,
        parentConversationId: 'cycle-b', branchPointMessageId: 'cycle-b-message', messages: [message('cycle-a-message')],
      },
      {
        id: 'cycle-b', title: 'Cycle B', projectId: 'project-one', createdAt: 1, updatedAt: 1,
        parentConversationId: 'cycle-a', branchPointMessageId: 'cycle-a-message', messages: [message('cycle-b-message')],
      },
    ];
    workspace.activeConversationId = 'valid-child';
    workspace.messages = workspace.conversations[1].messages;
    workspace.costGuard = {
      enabled: true,
      maxOutputTokens: 1,
      maxComparisonTargets: 4,
      dailyRequestLimit: -10,
      dailyCnyBudget: -1,
      dailyUsdBudget: 2_000_000_000,
      limitAction: 'warn',
      unknownCostAction: 'block',
      confirmPotentialMultipleCharges: false,
    };
    const createdAt = 1_700_000_000_000;
    workspace.providerUsageEvents = [{
      id: 'usage-1',
      kind: 'chat',
      status: 'succeeded',
      providerId,
      modelId: 'chat-model',
      createdAt,
      localDateKey: '2026-02-31',
      unknownCostComponents: ['input-tokens', 'input-tokens'],
    }];
    const raw = v4Envelope(workspace, 12);
    (raw.workspace.providerUsageEvents[0] as unknown as Record<string, unknown>).status = 'unexpected';
    (raw.workspace.providerUsageEvents[0] as unknown as Record<string, unknown>).unknownCostComponents = [
      'input-tokens', 'input-tokens', 'not-a-component',
    ];
    mocks.values.set(WORKSPACE_KEY, JSON.stringify(raw));
    const { loadWorkspace } = await subject();

    const loaded = await loadWorkspace();
    const byId = new Map(loaded?.conversations.map((conversation) => [conversation.id, conversation]));
    const date = new Date(createdAt);
    const expectedDateKey = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-');

    expect(loaded?.projects[0].defaultTarget).toEqual({ providerId, modelId: 'chat-model' });
    expect(loaded?.projects[1].defaultTarget).toBeUndefined();
    expect(byId.get('valid-child')).toMatchObject({
      parentConversationId: 'root',
      branchPointMessageId: 'root-message',
    });
    for (const id of ['wrong-point', 'welcome-point', 'cross-project', 'cycle-a', 'cycle-b']) {
      expect(byId.get(id)?.parentConversationId).toBeUndefined();
      expect(byId.get(id)?.branchPointMessageId).toBeUndefined();
    }
    expect(loaded?.costGuard).toEqual({
      enabled: true,
      maxOutputTokens: 64,
      maxComparisonTargets: 4,
      dailyRequestLimit: 0,
      dailyCnyBudget: 0,
      dailyUsdBudget: 1_000_000_000,
      limitAction: 'warn',
      unknownCostAction: 'block',
      confirmPotentialMultipleCharges: false,
    });
    expect(loaded?.providerUsageEvents[0]).toMatchObject({
      id: 'usage-1',
      status: 'failed',
      localDateKey: expectedDateKey,
      unknownCostComponents: ['input-tokens'],
    });
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
  it('migrates a legacy persistent Web key to the exact current binding and removes plaintext storage', async () => {
    const workspace = createDefaultWorkspace();
    const providerId = workspace.providers[0].id;
    mocks.values.set(WORKSPACE_KEY, JSON.stringify(v2Envelope(workspace)));
    mocks.values.set(`${SECRET_PREFIX}.${providerId}`, 'legacy-web-key');
    const { loadWorkspace } = await subject();

    const loaded = await loadWorkspace();

    expect(loaded?.providers[0].apiKey).toBe('legacy-web-key');
    expect(mocks.values.has(`${SECRET_PREFIX}.${providerId}`)).toBe(false);
  });

  it('round-trips provider and MCP secrets only inside versioned binding envelopes', async () => {
    mocks.platform.OS = 'android';
    const workspace = createDefaultWorkspace();
    const provider = workspace.providers[0];
    workspace.providers[0] = { ...provider, apiKey: 'provider-roundtrip-secret' };
    workspace.plugins = [{
      id: 'bound-mcp',
      name: 'Bound MCP',
      version: '1.0.0',
      type: 'remote-mcp',
      permissions: ['network', 'tools'],
      transport: 'streamable-http',
      endpoint: 'https://mcp.example.com/mcp',
      authorization: 'Bearer mcp-roundtrip-secret',
      enabled: true,
    }];
    let storage = await subject();

    await storage.saveWorkspace(workspace);

    const providerEnvelope = JSON.parse(
      mocks.secureValues.get(`${SECRET_PREFIX}.${provider.id}`) ?? '{}'
    );
    const pluginEnvelope = JSON.parse(
      mocks.secureValues.get(`${PLUGIN_SECRET_PREFIX}.bound-mcp`) ?? '{}'
    );
    expect(providerEnvelope).toEqual({
      schemaVersion: 1,
      bindingFingerprint: `volcengine-ark::${provider.baseUrl}`,
      secret: 'provider-roundtrip-secret',
    });
    expect(pluginEnvelope).toEqual({
      schemaVersion: 1,
      bindingFingerprint: 'remote-mcp::streamable-http::https://mcp.example.com/mcp',
      secret: 'Bearer mcp-roundtrip-secret',
    });
    expect(mocks.values.get(WORKSPACE_KEY)).not.toContain('roundtrip-secret');

    vi.resetModules();
    storage = await subject();
    const loaded = await storage.loadWorkspace();

    expect(loaded?.providers[0].apiKey).toBe('provider-roundtrip-secret');
    expect(loaded?.plugins[0].authorization).toBe('Bearer mcp-roundtrip-secret');
  });

  it('does not hydrate a provider secret whose binding fingerprint belongs to another endpoint', async () => {
    mocks.platform.OS = 'android';
    const workspace = createDefaultWorkspace();
    const provider = workspace.providers[0];
    mocks.values.set(WORKSPACE_KEY, JSON.stringify(v4Envelope(workspace)));
    mocks.secureValues.set(`${SECRET_PREFIX}.${provider.id}`, JSON.stringify({
      schemaVersion: 1,
      bindingFingerprint: 'custom::https://api.openai.com/v1',
      secret: 'wrong-endpoint-secret',
    }));
    const { loadWorkspace } = await subject();

    const loaded = await loadWorkspace();

    expect(loaded?.providers[0].apiKey).toBeUndefined();
  });

  it('does not hydrate MCP authorization when the persisted transport differs', async () => {
    mocks.platform.OS = 'android';
    const workspace = createDefaultWorkspace();
    workspace.plugins = [{
      id: 'transport-bound-mcp',
      name: 'Transport-bound MCP',
      version: '1.0.0',
      type: 'remote-mcp',
      permissions: ['network', 'tools'],
      transport: 'sse',
      endpoint: 'https://transport.mcp.example.com/mcp',
      enabled: true,
    }];
    mocks.values.set(WORKSPACE_KEY, JSON.stringify(v4Envelope(workspace)));
    mocks.secureValues.set(`${PLUGIN_SECRET_PREFIX}.transport-bound-mcp`, JSON.stringify({
      schemaVersion: 1,
      bindingFingerprint: 'remote-mcp::streamable-http::https://transport.mcp.example.com/mcp',
      secret: 'Bearer wrong-transport-secret',
    }));
    const { loadWorkspace } = await subject();

    const loaded = await loadWorkspace();

    expect(loaded?.plugins[0].authorization).toBeUndefined();
  });

  it('keeps a stale provider envelope from crossing endpoints when the post-workspace secret write fails', async () => {
    mocks.platform.OS = 'android';
    const workspaceA = createDefaultWorkspace();
    const providerA = workspaceA.providers[0];
    workspaceA.providers[0] = { ...providerA, apiKey: 'endpoint-a-secret' };
    let storage = await subject();
    await storage.saveWorkspace(workspaceA);

    const workspaceB: AppWorkspace = {
      ...workspaceA,
      providers: workspaceA.providers.map((provider, index) => index === 0
        ? {
            ...provider,
            kind: 'custom',
            baseUrl: 'https://api.openai.com/v1',
            apiKey: 'endpoint-b-secret',
          }
        : provider),
    };
    mocks.secureSet.mockImplementation(async (key, value) => {
      if (
        key === `${SECRET_PREFIX}.${providerA.id}` &&
        JSON.parse(value).secret === 'endpoint-b-secret'
      ) {
        throw new Error('simulated provider secret write failure');
      }
      mocks.secureValues.set(key, value);
    });

    await expect(storage.saveWorkspace(workspaceB)).rejects.toThrow(/simulated provider secret write failure/);
    const secureEnvelope = JSON.parse(
      mocks.secureValues.get(`${SECRET_PREFIX}.${providerA.id}`) ?? '{}'
    );
    expect(secureEnvelope).toMatchObject({
      bindingFingerprint: `volcengine-ark::${providerA.baseUrl}`,
      secret: 'endpoint-a-secret',
    });
    expect(JSON.parse(mocks.values.get(WORKSPACE_KEY) ?? '{}').workspace.providers[0]).toMatchObject({
      kind: 'custom',
      baseUrl: 'https://api.openai.com/v1',
    });

    const loadedInProcess = await storage.loadWorkspace();
    expect(loadedInProcess?.providers[0]).toMatchObject({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: undefined,
    });

    vi.resetModules();
    storage = await subject();
    const loadedAfterRestart = await storage.loadWorkspace();
    expect(loadedAfterRestart?.providers[0]).toMatchObject({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: undefined,
    });
  });

  it('keeps stale MCP authorization from crossing endpoints when the post-workspace secret write fails', async () => {
    mocks.platform.OS = 'android';
    const workspaceA = createDefaultWorkspace();
    workspaceA.plugins = [{
      id: 'partial-mcp',
      name: 'Partial MCP',
      version: '1.0.0',
      type: 'remote-mcp',
      permissions: ['network', 'tools'],
      transport: 'streamable-http',
      endpoint: 'https://a.mcp.example.com/mcp',
      authorization: 'Bearer endpoint-a',
      enabled: true,
    }];
    let storage = await subject();
    await storage.saveWorkspace(workspaceA);

    const workspaceB: AppWorkspace = {
      ...workspaceA,
      plugins: [{
        ...workspaceA.plugins[0],
        endpoint: 'https://b.mcp.example.com/mcp',
        authorization: 'Bearer endpoint-b',
      }],
    };
    mocks.secureSet.mockImplementation(async (key, value) => {
      if (
        key === `${PLUGIN_SECRET_PREFIX}.partial-mcp` &&
        JSON.parse(value).secret === 'Bearer endpoint-b'
      ) {
        throw new Error('simulated plugin secret write failure');
      }
      mocks.secureValues.set(key, value);
    });

    await expect(storage.saveWorkspace(workspaceB)).rejects.toThrow(/simulated plugin secret write failure/);
    expect(JSON.parse(
      mocks.secureValues.get(`${PLUGIN_SECRET_PREFIX}.partial-mcp`) ?? '{}'
    ).bindingFingerprint).toBe(
      'remote-mcp::streamable-http::https://a.mcp.example.com/mcp'
    );
    expect(JSON.parse(mocks.values.get(WORKSPACE_KEY) ?? '{}').workspace.plugins[0].endpoint).toBe(
      'https://b.mcp.example.com/mcp'
    );

    vi.resetModules();
    storage = await subject();
    const loaded = await storage.loadWorkspace();
    expect(loaded?.plugins[0]).toMatchObject({
      endpoint: 'https://b.mcp.example.com/mcp',
      authorization: undefined,
    });
  });

  it('does not delete provider or MCP secrets when the workspace deletion commit fails', async () => {
    mocks.platform.OS = 'android';
    const workspaceA = createDefaultWorkspace();
    workspaceA.providers.push({
      id: 'removable-provider',
      name: 'Removable provider',
      kind: 'custom',
      baseUrl: 'https://removable-provider.example/v1',
      capabilities: ['text'],
      models: [],
      apiKey: 'removable-provider-secret',
    });
    workspaceA.plugins = [{
      id: 'removable-mcp',
      name: 'Removable MCP',
      version: '1.0.0',
      type: 'remote-mcp',
      permissions: ['network', 'tools'],
      transport: 'streamable-http',
      endpoint: 'https://removable-mcp.example/mcp',
      authorization: 'Bearer removable-mcp-secret',
      enabled: true,
    }];
    let storage = await subject();
    await storage.saveWorkspace(workspaceA);
    const providerSecretBefore = mocks.secureValues.get(`${SECRET_PREFIX}.removable-provider`);
    const pluginSecretBefore = mocks.secureValues.get(`${PLUGIN_SECRET_PREFIX}.removable-mcp`);
    const secureDeletesBefore = mocks.secureDelete.mock.calls.length;
    const workspaceB: AppWorkspace = {
      ...workspaceA,
      providers: workspaceA.providers.filter((provider) => provider.id !== 'removable-provider'),
      plugins: [],
    };
    mocks.asyncSet.mockImplementation(async (key, value) => {
      if (key === WORKSPACE_KEY) {
        throw new Error('simulated deletion workspace write failure');
      }
      mocks.values.set(key, value);
    });

    await expect(storage.saveWorkspace(workspaceB)).rejects.toThrow(/simulated deletion workspace write failure/);

    expect(mocks.secureValues.get(`${SECRET_PREFIX}.removable-provider`)).toBe(providerSecretBefore);
    expect(mocks.secureValues.get(`${PLUGIN_SECRET_PREFIX}.removable-mcp`)).toBe(pluginSecretBefore);
    expect(mocks.secureDelete.mock.calls).toHaveLength(secureDeletesBefore);

    vi.resetModules();
    storage = await subject();
    const restarted = await storage.loadWorkspace();
    expect(restarted?.providers.find((provider) => provider.id === 'removable-provider')?.apiKey).toBe(
      'removable-provider-secret'
    );
    expect(restarted?.plugins.find((plugin) => plugin.id === 'removable-mcp')?.authorization).toBe(
      'Bearer removable-mcp-secret'
    );
  });

  it('migrates legacy bare native provider and MCP strings to binding envelopes before hydrating', async () => {
    mocks.platform.OS = 'android';
    const workspace = createDefaultWorkspace();
    const providerId = workspace.providers[0].id;
    workspace.plugins = [{
      id: 'legacy-mcp',
      name: 'Legacy MCP',
      version: '1.0.0',
      type: 'remote-mcp',
      permissions: ['network'],
      transport: 'sse',
      endpoint: 'https://legacy.mcp.example.com/sse',
      enabled: true,
    }];
    mocks.values.set(WORKSPACE_KEY, JSON.stringify(v4Envelope(workspace)));
    mocks.secureValues.set(`${SECRET_PREFIX}.${providerId}`, 'legacy-provider-secret');
    mocks.secureValues.set(`${PLUGIN_SECRET_PREFIX}.legacy-mcp`, 'Bearer legacy-plugin-secret');
    let storage = await subject();

    const loaded = await storage.loadWorkspace();

    expect(loaded?.providers[0].apiKey).toBe('legacy-provider-secret');
    expect(loaded?.plugins[0].authorization).toBe('Bearer legacy-plugin-secret');
    expect(JSON.parse(
      mocks.secureValues.get(`${SECRET_PREFIX}.${providerId}`) ?? '{}'
    )).toMatchObject({
      schemaVersion: 1,
      bindingFingerprint: `volcengine-ark::${workspace.providers[0].baseUrl}`,
      secret: 'legacy-provider-secret',
    });
    expect(JSON.parse(
      mocks.secureValues.get(`${PLUGIN_SECRET_PREFIX}.legacy-mcp`) ?? '{}'
    )).toMatchObject({
      schemaVersion: 1,
      bindingFingerprint: 'remote-mcp::sse::https://legacy.mcp.example.com/sse',
      secret: 'Bearer legacy-plugin-secret',
    });

    vi.resetModules();
    storage = await subject();
    const restarted = await storage.loadWorkspace();
    expect(restarted?.providers[0].apiKey).toBe('legacy-provider-secret');
    expect(restarted?.plugins[0].authorization).toBe('Bearer legacy-plugin-secret');
  });

  it('rejects and removes a legacy bare secret when persisted configuration has no valid binding', async () => {
    mocks.platform.OS = 'android';
    const workspace = createDefaultWorkspace();
    const providerId = workspace.providers[0].id;
    workspace.providers[0] = {
      ...workspace.providers[0],
      baseUrl: 'not-a-valid-url',
    };
    workspace.plugins = [{
      id: 'unbound-plugin',
      name: 'Unbound plugin',
      version: '1.0.0',
      type: 'mobile-js',
      permissions: [],
    }];
    mocks.values.set(WORKSPACE_KEY, JSON.stringify(v4Envelope(workspace)));
    mocks.secureValues.set(`${SECRET_PREFIX}.${providerId}`, 'unbound-provider-secret');
    mocks.secureValues.set(`${PLUGIN_SECRET_PREFIX}.unbound-plugin`, 'unbound-plugin-secret');
    const { loadWorkspace } = await subject();

    const loaded = await loadWorkspace();

    expect(loaded?.providers[0].apiKey).toBeUndefined();
    expect(loaded?.plugins[0].authorization).toBeUndefined();
    expect(mocks.secureValues.has(`${SECRET_PREFIX}.${providerId}`)).toBe(false);
    expect(mocks.secureValues.has(`${PLUGIN_SECRET_PREFIX}.unbound-plugin`)).toBe(false);
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
  it('writes a v4 envelope without a duplicate top-level messages field or provider secrets', async () => {
    const workspace = createDefaultWorkspace();
    workspace.providers[0] = { ...workspace.providers[0], apiKey: 'web-only-test-key' };
    const { saveWorkspace } = await subject();

    await saveWorkspace(workspace);

    const envelope = JSON.parse(mocks.values.get(WORKSPACE_KEY) ?? '{}');
    expect(envelope.schemaVersion).toBe(4);
    expect(envelope.revision).toBe(1);
    expect(envelope.workspace.messages).toBeUndefined();
    expect(envelope.workspace.conversations[0].messages).toEqual(workspace.messages);
    expect(envelope.workspace.providers[0].apiKey).toBeUndefined();
    expect(mocks.values.has(`${SECRET_PREFIX}.${workspace.providers[0].id}`)).toBe(false);
  });

  it('round-trips v4 projects, branch metadata, cost guard, and the device-local usage ledger', async () => {
    const workspace = createDefaultWorkspace();
    const providerId = workspace.providers[0].id;
    workspace.providers[0] = {
      ...workspace.providers[0],
      models: [{
        id: 'roundtrip-model',
        source: 'manual',
        task: 'chat',
        capabilities: ['text'],
      }],
    };
    workspace.projects[0] = {
      ...workspace.projects[0],
      systemPrompt: 'Project instruction',
      defaultTarget: { providerId, modelId: 'roundtrip-model' },
    };
    const rootPoint: ChatMessage = {
      id: 'roundtrip-root-point',
      role: 'user',
      content: 'Root',
      createdAt: 10,
      status: 'ready',
    };
    const branchMessage: ChatMessage = {
      id: 'roundtrip-branch-message',
      originMessageId: 'canonical-message',
      role: 'assistant',
      content: 'Branch',
      createdAt: 11,
      status: 'ready',
      providerId,
      modelId: 'roundtrip-model',
      projectInstructionId: workspace.projects[0].id,
    };
    workspace.conversations = [
      {
        id: 'roundtrip-root',
        title: 'Root',
        projectId: workspace.projects[0].id,
        createdAt: 10,
        updatedAt: 10,
        messages: [rootPoint],
      },
      {
        id: 'roundtrip-branch',
        title: 'Branch',
        projectId: workspace.projects[0].id,
        parentConversationId: 'roundtrip-root',
        branchPointMessageId: rootPoint.id,
        createdAt: 11,
        updatedAt: 11,
        messages: [branchMessage],
      },
    ];
    workspace.activeConversationId = 'roundtrip-branch';
    workspace.messages = [branchMessage];
    workspace.costGuard = {
      enabled: true,
      maxOutputTokens: 2048,
      maxComparisonTargets: 3,
      dailyRequestLimit: 20,
      dailyCnyBudget: 10,
      dailyUsdBudget: 2,
      limitAction: 'warn',
      unknownCostAction: 'block',
      confirmPotentialMultipleCharges: false,
    };
    workspace.providerUsageEvents = [{
      id: 'roundtrip-usage',
      kind: 'chat',
      status: 'succeeded',
      providerId,
      modelId: 'roundtrip-model',
      createdAt: 11,
      completedAt: 12,
      localDateKey: '2026-07-11',
      messageId: 'canonical-message',
      knownCostEstimate: {
        amount: 0.5,
        currency: 'CNY',
        source: 'user-configured',
        pricingUpdatedAt: 9,
      },
      unknownCostComponents: ['provider-surcharge'],
    }];
    const { loadWorkspace, saveWorkspace } = await subject();

    await saveWorkspace(workspace);
    const loaded = await loadWorkspace();

    expect(loaded?.projects[0]).toMatchObject({
      systemPrompt: 'Project instruction',
      defaultTarget: { providerId, modelId: 'roundtrip-model' },
    });
    expect(loaded?.conversations.find((item) => item.id === 'roundtrip-branch')).toMatchObject({
      parentConversationId: 'roundtrip-root',
      branchPointMessageId: 'roundtrip-root-point',
    });
    expect(loaded?.messages[0]).toMatchObject({
      originMessageId: 'canonical-message',
      projectInstructionId: workspace.projects[0].id,
    });
    expect(loaded?.costGuard).toEqual(workspace.costGuard);
    expect(loaded?.providerUsageEvents).toEqual(workspace.providerUsageEvents);
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

  it('round-trips productivity settings, request evidence, and plugin auth without serializing secrets', async () => {
    const workspace = createDefaultWorkspace();
    const provider = workspace.providers[0];
    const model = {
      id: 'productivity-chat',
      name: 'Productivity Chat',
      source: 'manual' as const,
      task: 'chat' as const,
      capabilities: ['text', 'web-search'] as const,
    };
    workspace.providers[0] = { ...provider, models: [{ ...model, capabilities: [...model.capabilities] }] };
    workspace.activeModelIdByProvider[provider.id] = model.id;
    workspace.promptTemplates = [{
      id: 'prompt-1',
      name: 'Template',
      content: 'Review {{topic}}',
      mode: 'composer',
      createdAt: 1,
      updatedAt: 2,
    }];
    workspace.comparisonEnabled = false;
    workspace.comparisonTargets = [{ providerId: provider.id, modelId: model.id }];
    workspace.modelPricing = [{
      providerId: provider.id,
      modelId: model.id,
      currency: 'CNY',
      inputPerMillion: 1,
      outputPerMillion: 2,
      updatedAt: 3,
    }];
    workspace.webSearch = { enabled: true, searchContextSize: 'high' };
    workspace.voice = {
      transcriptionTarget: { providerId: provider.id, modelId: model.id },
      speechVoice: 'alloy',
      speechFormat: 'mp3',
    };
    workspace.plugins = [{
      id: 'mcp-1',
      name: 'MCP',
      version: '1.0.0',
      type: 'remote-mcp',
      permissions: ['network', 'tools'],
      transport: 'streamable-http',
      endpoint: 'https://mcp.example.com/mcp',
      authorization: 'Bearer plugin-secret',
      approvalPolicy: 'always',
      enabled: true,
    }];
    const assistant: ChatMessage = {
      id: 'assistant-evidence',
      role: 'assistant',
      content: 'answer',
      createdAt: 10,
      status: 'ready',
      providerId: provider.id,
      modelId: model.id,
      comparisonGroupId: 'compare-1',
      selectedForContext: true,
      webSearchTriggered: true,
      citations: [{ url: 'https://example.com/source', title: 'Source', startIndex: 0, endIndex: 6 }],
      requestMetrics: { durationMs: 1200, timeToFirstTokenMs: 200 },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    };
    workspace.messages = [assistant];
    workspace.conversations = [{ ...workspace.conversations[0], messages: [assistant] }];
    const { loadWorkspace, saveWorkspace } = await subject();

    await saveWorkspace(workspace);
    const serialized = mocks.values.get(WORKSPACE_KEY) ?? '';
    expect(serialized).not.toContain('plugin-secret');
    const loaded = await loadWorkspace();

    expect(loaded?.promptTemplates).toEqual(workspace.promptTemplates);
    expect(loaded?.comparisonTargets).toEqual(workspace.comparisonTargets);
    expect(loaded?.modelPricing).toEqual(workspace.modelPricing);
    expect(loaded?.webSearch).toEqual(workspace.webSearch);
    expect(loaded?.messages[0]).toMatchObject({
      comparisonGroupId: 'compare-1',
      selectedForContext: true,
      webSearchTriggered: true,
      requestMetrics: { durationMs: 1200, timeToFirstTokenMs: 200 },
    });
    expect(loaded?.plugins[0].authorization).toBe('Bearer plugin-secret');
  });

  it('drops non-public persisted citations while retaining public HTTPS query and fragment URLs', async () => {
    const workspace = createDefaultWorkspace();
    const assistant: ChatMessage = {
      id: 'citation-safety',
      role: 'assistant',
      content: 'answer',
      createdAt: 10,
      status: 'ready',
      citations: [
        { url: 'https://www.example.com/search?q=public#result' },
        { url: 'http://www.example.com/insecure' },
        { url: 'https://user:secret@www.example.com/source' },
        { url: 'https://localhost/source' },
        { url: 'https://192.168.1.4/source' },
        { url: 'https://198.51.100.4/source' },
        { url: 'https://[fd00::4]/source' },
      ],
    };
    workspace.messages = [assistant];
    workspace.conversations = [{ ...workspace.conversations[0], messages: [assistant] }];
    mocks.values.set(V2_WORKSPACE_KEY, JSON.stringify(v2Envelope(workspace)));
    const { loadWorkspace } = await subject();

    const loaded = await loadWorkspace();

    expect(loaded?.messages[0].citations).toEqual([
      { url: 'https://www.example.com/search?q=public#result' },
    ]);
  });

  it.each([
    ['HTTP loopback', 'http://127.0.0.1:3000/mcp'],
    ['HTTPS localhost', 'https://localhost/mcp'],
    ['private IPv4', 'https://172.16.0.8/mcp'],
    ['reserved IPv4', 'https://192.0.2.8/mcp'],
    ['private IPv6', 'https://[fe80::8]/mcp'],
    ['embedded credentials', 'https://user:secret@mcp.example.com/mcp'],
    ['query', 'https://mcp.example.com/mcp?token=secret'],
    ['fragment', 'https://mcp.example.com/mcp#tools'],
  ])('rejects a persisted %s MCP endpoint', async (_kind, endpoint) => {
    const workspace = createDefaultWorkspace();
    workspace.plugins = [{
      id: 'unsafe-mcp',
      name: 'Unsafe MCP',
      version: '1.0.0',
      type: 'remote-mcp',
      permissions: ['network', 'tools'],
      transport: 'streamable-http',
      endpoint,
      enabled: true,
    }];
    const raw = JSON.stringify(v2Envelope(workspace));
    mocks.values.set(V2_WORKSPACE_KEY, raw);
    const { loadWorkspace } = await subject();

    await expect(loadWorkspace()).rejects.toThrow(/endpoint 无效/);
    expect(mocks.values.get(V2_WORKSPACE_KEY)).toBe(raw);
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
