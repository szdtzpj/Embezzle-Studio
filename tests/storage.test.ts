import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultWorkspace } from '../src/data/providerCatalog';
import type {
  AppWorkspace,
  ChatMessage,
  McpActivitySummary,
  PluginManifest,
  ProviderUsageEvent,
} from '../src/domain/types';
import {
  normalizeMcpAuthorization,
  normalizeMcpToolName,
  normalizeRemoteMcpEndpoint,
} from '../src/plugins/contracts';
import { createPromptTemplate } from '../src/services/promptTemplates';
import {
  buildProjectKnowledgeContext,
  deleteProjectKnowledgeSource,
  updateProjectKnowledgeSource,
} from '../src/services/projectKnowledge';
import {
  exportEncryptedWorkspaceBackup,
  importEncryptedWorkspaceBackup,
} from '../src/services/workspaceBackup';
import { createWorkspaceProject } from '../src/services/workspaceProjects';

const LEGACY_WORKSPACE_KEY = '@embezzle-studio/workspace-v1';
const V2_WORKSPACE_KEY = '@embezzle-studio/workspace-v2';
const V2_WORKSPACE_BACKUP_KEY = '@embezzle-studio/workspace-v2.backup';
const V3_WORKSPACE_KEY = '@embezzle-studio/workspace-v3';
const V4_WORKSPACE_KEY = '@embezzle-studio/workspace-v4';
const V5_WORKSPACE_KEY = '@embezzle-studio/workspace-v5';
const V5_WORKSPACE_BACKUP_KEY = '@embezzle-studio/workspace-v5.backup';
const WORKSPACE_KEY = '@embezzle-studio/workspace-v6';
const WORKSPACE_BACKUP_KEY = '@embezzle-studio/workspace-v6.backup';
const WORKSPACE_RECOVERY_KEY = '@embezzle-studio/workspace-recovery-v6';
const COLOR_MODE_KEY = '@embezzle-studio/color-mode-v1';
const SECRET_PREFIX = 'embezzle-studio.provider-key';
const PLUGIN_SECRET_PREFIX = 'embezzle-studio.plugin-authorization';
const DEFAULT_PROVIDER_BINDING =
  'volcengine-ark::https://ark.cn-beijing.volces.com/api/v3';

function mcpBindingFingerprint(options: {
  transport: 'streamable-http' | 'sse';
  endpoint: string;
  serverLabel: string;
  providerId: string;
  providerBinding?: string;
  allowedTools?: string[];
}): string {
  return JSON.stringify([
    'remote-mcp-v3',
    options.transport,
    options.endpoint,
    options.serverLabel,
    options.providerId,
    options.providerBinding ?? DEFAULT_PROVIDER_BINDING,
    [...(options.allowedTools ?? ['search'])].sort(),
    'always',
  ]);
}

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

vi.mock('expo-crypto', () => ({
  getRandomBytesAsync: async (length: number) => new Uint8Array(length).fill(29),
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

function v5Envelope(workspace: AppWorkspace, revision = 1) {
  return {
    ...v4Envelope(workspace, revision),
    schemaVersion: 5,
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

describe('MCP storage contract boundaries', () => {
  it('accepts a 128-character tool name and rejects 129 characters, slash, and colon', () => {
    expect(normalizeMcpToolName('a'.repeat(128))).toBe('a'.repeat(128));
    expect(normalizeMcpToolName('a'.repeat(129))).toBeUndefined();
    expect(normalizeMcpToolName('files/read')).toBeUndefined();
    expect(normalizeMcpToolName('files:read')).toBeUndefined();
  });

  it('accepts an exact 2048-character public endpoint and rejects 2049 characters', () => {
    const prefix = 'https://mcp.example.com/';
    const exact = `${prefix}${'a'.repeat(2_048 - prefix.length)}`;
    const oversized = `${exact}a`;

    expect(normalizeRemoteMcpEndpoint(exact)).toBe(exact);
    expect(normalizeRemoteMcpEndpoint(oversized)).toBeUndefined();
  });

  it('allows printable ASCII authorization only', () => {
    expect(normalizeMcpAuthorization('  Bearer printable-ASCII_123  ')).toBe(
      'Bearer printable-ASCII_123'
    );
    expect(normalizeMcpAuthorization('Bearer 密钥')).toBeUndefined();
    expect(normalizeMcpAuthorization('Bearer first\nsecond')).toBeUndefined();
  });
});

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

describe('workspace save commit-stage signaling', () => {
  it('marks a SecureStore failure after the AsyncStorage primary snapshot has committed', async () => {
    mocks.platform.OS = 'android';
    const workspace = workspaceWithTitle('public snapshot committed');
    workspace.providers[0] = {
      ...workspace.providers[0],
      apiKey: 'postcommit-provider-secret',
    };
    mocks.secureSet.mockRejectedValueOnce(new Error('simulated postcommit SecureStore failure'));
    const storage = await subject();

    let failure: unknown;
    try {
      await storage.saveWorkspace(workspace);
    } catch (error) {
      failure = error;
    }

    expect(storage.isWorkspaceSaveError(failure)).toBe(true);
    expect(failure).toMatchObject({
      name: 'WorkspaceSaveError',
      commitStage: 'after-public-commit',
      publicWorkspaceCommitted: true,
      message: 'simulated postcommit SecureStore failure',
    });
    const committed = JSON.parse(mocks.values.get(WORKSPACE_KEY) ?? '{}');
    expect(committed.workspace.conversations[0].title).toBe('public snapshot committed');
  });

  it('marks a failed primary AsyncStorage write as not committed', async () => {
    mocks.asyncSet.mockImplementation(async (key, value) => {
      if (key === WORKSPACE_KEY) throw new Error('simulated primary write failure');
      mocks.values.set(key, value);
    });
    const storage = await subject();

    let failure: unknown;
    try {
      await storage.saveWorkspace(workspaceWithTitle('must not commit'));
    } catch (error) {
      failure = error;
    }

    expect(storage.isWorkspaceSaveError(failure)).toBe(true);
    expect(failure).toMatchObject({
      commitStage: 'before-public-commit',
      publicWorkspaceCommitted: false,
      message: 'simulated primary write failure',
    });
    expect(mocks.values.has(WORKSPACE_KEY)).toBe(false);
  });
});

describe('workspace storage migrations and recovery', () => {
  it('loads a v2 envelope from the previous key and writes the next save as v6', async () => {
    const workspace = workspaceWithTitle('v2 migration');
    mocks.values.set(V2_WORKSPACE_KEY, JSON.stringify(v2Envelope(workspace, 4)));
    const { loadWorkspace, saveWorkspace } = await subject();

    const loaded = await loadWorkspace();
    expect(loaded?.conversations[0].title).toBe('v2 migration');
    await saveWorkspace(loaded!);

    const v6 = JSON.parse(mocks.values.get(WORKSPACE_KEY) ?? '{}');
    expect(v6.schemaVersion).toBe(6);
    expect(v6.revision).toBe(5);
    expect(mocks.values.has(V2_WORKSPACE_KEY)).toBe(true);
  });

  it('loads a v3 envelope, creates the default project, and writes the next save as v6', async () => {
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
    const v6 = JSON.parse(mocks.values.get(WORKSPACE_KEY) ?? '{}');
    expect(v6).toMatchObject({ schemaVersion: 6, revision: 10 });
    expect(v6.workspace.projects).toHaveLength(1);
    expect(mocks.values.has(V3_WORKSPACE_KEY)).toBe(true);
  });

  it('loads the previous v4 key, initializes v1.3 collections, and preserves the legacy snapshot', async () => {
    const workspace = workspaceWithTitle('v4 migration');
    const legacy = v4Envelope(workspace, 14);
    delete (legacy.workspace as Partial<AppWorkspace>).artifacts;
    delete (legacy.workspace as Partial<AppWorkspace>).knowledgeSources;
    mocks.values.set(V4_WORKSPACE_KEY, JSON.stringify(legacy));
    const { loadWorkspace, saveWorkspace } = await subject();

    const loaded = await loadWorkspace();

    expect(loaded?.conversations[0].title).toBe('v4 migration');
    expect(loaded?.artifacts).toEqual([]);
    expect(loaded?.knowledgeSources).toEqual([]);
    await saveWorkspace(loaded!);

    expect(JSON.parse(mocks.values.get(WORKSPACE_KEY) ?? '{}')).toMatchObject({
      schemaVersion: 6,
      revision: 15,
      workspace: { artifacts: [], knowledgeSources: [] },
    });
    expect(mocks.values.get(V4_WORKSPACE_KEY)).toBe(JSON.stringify(legacy));
  });

  it('loads the previous v5 key, writes v6, and preserves the v5 snapshot', async () => {
    const workspace = workspaceWithTitle('v5 migration');
    const legacy = v5Envelope(workspace, 20);
    const legacyRaw = JSON.stringify(legacy);
    mocks.values.set(V5_WORKSPACE_KEY, legacyRaw);
    const { loadWorkspace, saveWorkspace } = await subject();

    const loaded = await loadWorkspace();
    expect(loaded?.conversations[0].title).toBe('v5 migration');
    await saveWorkspace(loaded!);

    expect(JSON.parse(mocks.values.get(WORKSPACE_KEY) ?? '{}')).toMatchObject({
      schemaVersion: 6,
      revision: 21,
    });
    expect(mocks.values.get(V5_WORKSPACE_KEY)).toBe(legacyRaw);
  });

  it('recovers a corrupt v5 primary from its v5 backup during migration', async () => {
    const backupWorkspace = workspaceWithTitle('v5 backup recovery');
    mocks.values.set(V5_WORKSPACE_KEY, '{broken-v5');
    mocks.values.set(
      V5_WORKSPACE_BACKUP_KEY,
      JSON.stringify(v5Envelope(backupWorkspace, 22))
    );
    const { consumeStorageRecoveryNotice, loadWorkspace } = await subject();

    const loaded = await loadWorkspace();

    expect(loaded?.conversations[0].title).toBe('v5 backup recovery');
    expect(consumeStorageRecoveryNotice()).toMatch(/自动从最近备份恢复/);
    expect(mocks.values.get(V5_WORKSPACE_KEY)).toBe('{broken-v5');
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
      providerRequestCount: 1,
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
      providerRequestCount: 1,
      providerId,
      modelId: 'chat-model',
      createdAt,
      localDateKey: '2026-02-31',
      unknownCostComponents: ['input-tokens', 'input-tokens'],
    }];
    const raw = v4Envelope(workspace, 12);
    delete (raw.workspace.providerUsageEvents[0] as Partial<ProviderUsageEvent>)
      .providerRequestCount;
    (raw.workspace.providerUsageEvents[0] as unknown as Record<string, unknown>).status = 'unexpected';
    (raw.workspace.providerUsageEvents[0] as unknown as Record<string, unknown>).unknownCostComponents = [
      'input-tokens', 'input-tokens', 'not-a-component',
    ];
    mocks.values.set(V4_WORKSPACE_KEY, JSON.stringify(raw));
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
      providerRequestCount: 1,
      localDateKey: expectedDateKey,
      unknownCostComponents: ['input-tokens'],
    });
  });

  it.each([0, -2, 1.5])(
    'rejects persisted providerRequestCount=%s instead of undercounting it',
    async (providerRequestCount) => {
      const workspace = createDefaultWorkspace();
      workspace.providerUsageEvents = [{
        id: 'invalid-request-count',
        kind: 'chat',
        status: 'started',
        providerRequestCount: 1,
        providerId: workspace.providers[0].id,
        modelId: 'model-a',
        createdAt: 1,
        localDateKey: '2026-07-11',
        unknownCostComponents: [],
      }];
      const persisted = v4Envelope(workspace);
      persisted.workspace.providerUsageEvents[0].providerRequestCount = providerRequestCount;
      const raw = JSON.stringify(persisted);
      mocks.values.set(V4_WORKSPACE_KEY, raw);
      const { loadWorkspace } = await subject();

      await expect(loadWorkspace()).rejects.toThrow(/providerRequestCount.*正安全整数/);
      expect(mocks.values.get(V4_WORKSPACE_KEY)).toBe(raw);
    }
  );

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
  it.each([
    [
      'Volcengine Ark',
      { kind: 'volcengine-ark' as const, baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
    ],
    [
      'Alibaba Bailian',
      { kind: 'bailian-compatible' as const, baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    ],
    [
      'a custom provider pointed at OpenAI',
      { kind: 'custom' as const, baseUrl: 'https://api.openai.com/v1' },
    ],
  ])('persists and loads remote MCP as disabled for %s', async (_label, binding) => {
    const workspace = createDefaultWorkspace();
    const provider = { ...workspace.providers[0], ...binding };
    workspace.providers[0] = provider;
    workspace.plugins = [{
      id: 'disabled-non-openai-mcp',
      name: 'Disabled non-OpenAI MCP',
      version: '1.0.0',
      type: 'remote-mcp',
      permissions: ['network', 'tools'],
      allowedTools: ['search'],
      transport: 'streamable-http',
      endpoint: 'https://mcp.example.com/mcp',
      serverLabel: 'disabled_non_openai_mcp',
      providerId: provider.id,
      approvalPolicy: 'always',
      enabled: true,
    }];
    const storage = await subject();

    await storage.saveWorkspace(workspace);

    const persisted = JSON.parse(mocks.values.get(WORKSPACE_KEY) ?? '{}');
    expect(persisted.workspace.plugins[0].enabled).toBe(false);
    const loaded = await storage.loadWorkspace();
    expect(loaded?.plugins[0].enabled).toBe(false);
  });

  it('retains enabled only for the exact OpenAI protocol kind and canonical official base', async () => {
    const workspace = createDefaultWorkspace();
    const provider = {
      ...workspace.providers[0],
      kind: 'openai-compatible' as const,
      baseUrl: 'https://api.openai.com/v1',
    };
    workspace.providers[0] = provider;
    workspace.plugins = [{
      id: 'exact-openai-mcp',
      name: 'Exact OpenAI MCP',
      version: '1.0.0',
      type: 'remote-mcp',
      permissions: ['network', 'tools'],
      allowedTools: ['search'],
      transport: 'streamable-http',
      endpoint: 'https://mcp.example.com/mcp',
      serverLabel: 'exact_openai_mcp',
      providerId: provider.id,
      approvalPolicy: 'always',
      enabled: true,
    }];
    const storage = await subject();

    await storage.saveWorkspace(workspace);
    const loaded = await storage.loadWorkspace();

    expect(loaded?.plugins[0].enabled).toBe(true);
  });

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
      allowedTools: ['search'],
      transport: 'streamable-http',
      endpoint: 'https://mcp.example.com/mcp',
      serverLabel: 'bound_mcp',
      providerId: provider.id,
      approvalPolicy: 'always',
      authorization: 'Bearer mcp-roundtrip-secret',
      enabled: true,
    }];
    Object.assign(workspace.plugins[0], {
      lastToolArguments: 'RAW-TOOL-ARGUMENTS-MUST-NOT-PERSIST',
      lastToolOutput: 'RAW-TOOL-OUTPUT-MUST-NOT-PERSIST',
    });
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
      bindingFingerprint: mcpBindingFingerprint({
        transport: 'streamable-http',
        endpoint: 'https://mcp.example.com/mcp',
        serverLabel: 'bound_mcp',
        providerId: provider.id,
      }),
      secret: 'Bearer mcp-roundtrip-secret',
    });
    expect(mocks.values.get(WORKSPACE_KEY)).not.toContain('roundtrip-secret');
    expect(mocks.values.get(WORKSPACE_KEY)).not.toContain('RAW-TOOL-ARGUMENTS-MUST-NOT-PERSIST');
    expect(mocks.values.get(WORKSPACE_KEY)).not.toContain('RAW-TOOL-OUTPUT-MUST-NOT-PERSIST');
    expect(JSON.parse(mocks.values.get(WORKSPACE_KEY) ?? '{}').workspace.plugins[0]).toMatchObject({
      allowedTools: ['search'],
      serverLabel: 'bound_mcp',
      providerId: provider.id,
    });

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
      allowedTools: ['search'],
      transport: 'sse',
      endpoint: 'https://transport.mcp.example.com/mcp',
      serverLabel: 'transport_mcp',
      providerId: workspace.providers[0].id,
      approvalPolicy: 'always',
      enabled: true,
    }];
    mocks.values.set(WORKSPACE_KEY, JSON.stringify(v4Envelope(workspace)));
    mocks.secureValues.set(`${PLUGIN_SECRET_PREFIX}.transport-bound-mcp`, JSON.stringify({
      schemaVersion: 1,
      bindingFingerprint: mcpBindingFingerprint({
        transport: 'streamable-http',
        endpoint: 'https://transport.mcp.example.com/mcp',
        serverLabel: 'transport_mcp',
        providerId: workspace.providers[0].id,
      }),
      secret: 'Bearer wrong-transport-secret',
    }));
    const { loadWorkspace } = await subject();

    const loaded = await loadWorkspace();

    expect(loaded?.plugins[0].authorization).toBeUndefined();
  });

  it('intentionally invalidates a remote-mcp-v2 secret envelope without migrating it', async () => {
    mocks.platform.OS = 'android';
    const workspace = createDefaultWorkspace();
    const providerId = workspace.providers[0].id;
    workspace.plugins = [{
      id: 'v2-bound-mcp',
      name: 'V2-bound MCP',
      version: '1.0.0',
      type: 'remote-mcp',
      permissions: ['network', 'tools'],
      allowedTools: ['search'],
      transport: 'streamable-http',
      endpoint: 'https://v2-bound.example.com/mcp',
      enabled: true,
      serverLabel: 'v2_bound_mcp',
      providerId,
      approvalPolicy: 'always',
    }];
    mocks.values.set(WORKSPACE_KEY, JSON.stringify(v5Envelope(workspace)));
    mocks.secureValues.set(`${PLUGIN_SECRET_PREFIX}.v2-bound-mcp`, JSON.stringify({
      schemaVersion: 1,
      bindingFingerprint: JSON.stringify([
        'remote-mcp-v2',
        'streamable-http',
        'https://v2-bound.example.com/mcp',
        'v2_bound_mcp',
        providerId,
        ['search'],
        'always',
      ]),
      secret: 'Bearer v2-secret-must-expire',
    }));
    const { loadWorkspace } = await subject();

    const loaded = await loadWorkspace();

    expect(loaded?.plugins[0].authorization).toBeUndefined();
  });

  it.each([
    ['allowlist', (plugin: PluginManifest) => ({ ...plugin, allowedTools: ['fetch'] })],
    ['provider binding', (plugin: PluginManifest, workspace: AppWorkspace) => ({
      ...plugin,
      providerId: workspace.providers[1].id,
    })],
  ] as const)('does not hydrate MCP authorization after a %s change', async (_kind, mutate) => {
    mocks.platform.OS = 'android';
    const workspace = createDefaultWorkspace();
    const providerId = workspace.providers[0].id;
    const original: PluginManifest = {
      id: 'changed-binding-mcp',
      name: 'Changed binding MCP',
      version: '1.0.0',
      type: 'remote-mcp',
      permissions: ['network', 'tools'],
      allowedTools: ['search'],
      transport: 'streamable-http',
      endpoint: 'https://changed-binding.example.com/mcp',
      enabled: true,
      serverLabel: 'changed_binding_mcp',
      providerId,
      approvalPolicy: 'always',
    };
    workspace.plugins = [mutate(original, workspace)];
    mocks.values.set(WORKSPACE_KEY, JSON.stringify(v4Envelope(workspace)));
    mocks.secureValues.set(`${PLUGIN_SECRET_PREFIX}.${original.id}`, JSON.stringify({
      schemaVersion: 1,
      bindingFingerprint: mcpBindingFingerprint({
        transport: 'streamable-http',
        endpoint: original.endpoint!,
        serverLabel: original.serverLabel!,
        providerId,
        allowedTools: original.allowedTools,
      }),
      secret: 'Bearer stale-binding-secret',
    }));
    const { loadWorkspace } = await subject();

    const loaded = await loadWorkspace();

    expect(loaded?.plugins[0].authorization).toBeUndefined();
  });

  it('migrates an old plugin without an allowlist as disabled and removes its unbound secret', async () => {
    mocks.platform.OS = 'android';
    const workspace = createDefaultWorkspace();
    const providerId = workspace.providers[0].id;
    const legacyPlugin: PluginManifest = {
      id: 'pre-allowlist-mcp',
      name: 'Pre-allowlist MCP',
      version: '1.0.0',
      type: 'remote-mcp',
      permissions: ['network', 'tools'],
      allowedTools: ['search'],
      transport: 'streamable-http',
      endpoint: 'https://pre-allowlist.example.com/mcp',
      enabled: true,
      serverLabel: 'pre_allowlist_mcp',
      providerId,
      approvalPolicy: 'always',
    };
    workspace.plugins = [legacyPlugin];
    const persisted = v4Envelope(workspace);
    delete (persisted.workspace.plugins[0] as Partial<PluginManifest>).allowedTools;
    mocks.values.set(WORKSPACE_KEY, JSON.stringify(persisted));
    mocks.secureValues.set(`${PLUGIN_SECRET_PREFIX}.${legacyPlugin.id}`, 'Bearer old-plugin-secret');
    const { loadWorkspace } = await subject();

    const loaded = await loadWorkspace();

    expect(loaded?.plugins[0]).toMatchObject({ allowedTools: [], enabled: false });
    expect(loaded?.plugins[0].authorization).toBeUndefined();
    expect(mocks.secureValues.has(`${PLUGIN_SECRET_PREFIX}.${legacyPlugin.id}`)).toBe(false);
  });

  it('drops an unchanged authorization when the allowlist binding changes during save', async () => {
    mocks.platform.OS = 'android';
    const workspace = createDefaultWorkspace();
    workspace.plugins = [{
      id: 'save-binding-mcp',
      name: 'Save binding MCP',
      version: '1.0.0',
      type: 'remote-mcp',
      permissions: ['network', 'tools'],
      allowedTools: ['search'],
      transport: 'streamable-http',
      endpoint: 'https://save-binding.example.com/mcp',
      enabled: true,
      serverLabel: 'save_binding_mcp',
      providerId: workspace.providers[0].id,
      authorization: 'Bearer unchanged-stale-secret',
      approvalPolicy: 'always',
    }];
    let storage = await subject();
    await storage.saveWorkspace(workspace);

    await storage.saveWorkspace({
      ...workspace,
      plugins: [{ ...workspace.plugins[0], allowedTools: ['fetch'] }],
    });

    expect(mocks.secureValues.has(`${PLUGIN_SECRET_PREFIX}.save-binding-mcp`)).toBe(false);
    vi.resetModules();
    storage = await subject();
    const loaded = await storage.loadWorkspace();
    expect(loaded?.plugins[0]).toMatchObject({ allowedTools: ['fetch'] });
    expect(loaded?.plugins[0].authorization).toBeUndefined();
  });

  it.each([
    ['Base URL', (provider: AppWorkspace['providers'][number]) => ({
      ...provider,
      baseUrl: 'https://ark.cn-beijing.volcengineapi.com/api/v3',
    })],
    ['kind', (provider: AppWorkspace['providers'][number]) => ({
      ...provider,
      kind: 'custom' as const,
    })],
  ] as const)(
    'clears unchanged MCP authorization when the bound provider %s changes',
    async (_kind, mutateProvider) => {
      mocks.platform.OS = 'android';
      const workspace = createDefaultWorkspace();
      workspace.plugins = [{
        id: 'provider-endpoint-bound-mcp',
        name: 'Provider endpoint-bound MCP',
        version: '1.0.0',
        type: 'remote-mcp',
        permissions: ['network', 'tools'],
        allowedTools: ['search'],
        transport: 'streamable-http',
        endpoint: 'https://provider-endpoint-bound.example.com/mcp',
        enabled: true,
        serverLabel: 'provider_endpoint_bound_mcp',
        providerId: workspace.providers[0].id,
        authorization: 'Bearer provider-bound-secret',
        approvalPolicy: 'always',
      }];
      let storage = await subject();
      await storage.saveWorkspace(workspace);

      await storage.saveWorkspace({
        ...workspace,
        providers: workspace.providers.map((provider, index) =>
          index === 0 ? mutateProvider(provider) : provider
        ),
      });

      expect(
        mocks.secureValues.has(`${PLUGIN_SECRET_PREFIX}.provider-endpoint-bound-mcp`)
      ).toBe(false);
      vi.resetModules();
      storage = await subject();
      const loaded = await storage.loadWorkspace();
      expect(loaded?.plugins[0].authorization).toBeUndefined();
    }
  );

  it.each([
    ['duplicate plugin ID', (workspace: AppWorkspace, base: PluginManifest) => [base, { ...base }]],
    ['duplicate server label', (workspace: AppWorkspace, base: PluginManifest) => [
      base,
      { ...base, id: 'second-mcp', endpoint: 'https://second.example.com/mcp' },
    ]],
    ['missing provider binding', (_workspace: AppWorkspace, base: PluginManifest) => [
      { ...base, providerId: 'missing-provider' },
    ]],
  ] as const)('rejects %s before committing public workspace data', async (_kind, pluginsFor) => {
    const workspace = createDefaultWorkspace();
    const base: PluginManifest = {
      id: 'unique-mcp',
      name: 'Unique MCP',
      version: '1.0.0',
      type: 'remote-mcp',
      permissions: ['network', 'tools'],
      allowedTools: ['search'],
      transport: 'streamable-http',
      endpoint: 'https://unique.example.com/mcp',
      enabled: true,
      serverLabel: 'unique_mcp',
      providerId: workspace.providers[0].id,
      approvalPolicy: 'always',
    };
    workspace.plugins = pluginsFor(workspace, base);
    const { saveWorkspace } = await subject();

    await expect(saveWorkspace(workspace)).rejects.toThrow(/plugins|providerId|serverLabel/);
    expect(mocks.values.has(WORKSPACE_KEY)).toBe(false);
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
      allowedTools: ['search'],
      transport: 'streamable-http',
      endpoint: 'https://a.mcp.example.com/mcp',
      serverLabel: 'partial_mcp',
      providerId: workspaceA.providers[0].id,
      approvalPolicy: 'always',
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
      mcpBindingFingerprint({
        transport: 'streamable-http',
        endpoint: 'https://a.mcp.example.com/mcp',
        serverLabel: 'partial_mcp',
        providerId: workspaceA.providers[0].id,
      })
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
      allowedTools: ['search'],
      transport: 'streamable-http',
      endpoint: 'https://removable-mcp.example/mcp',
      serverLabel: 'removable_mcp',
      providerId: 'removable-provider',
      approvalPolicy: 'always',
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

  it('deletes provider and MCP secrets only after their workspace removal commits', async () => {
    mocks.platform.OS = 'android';
    const workspaceA = createDefaultWorkspace();
    workspaceA.providers.push({
      id: 'committed-removal-provider',
      name: 'Committed removal provider',
      kind: 'custom',
      baseUrl: 'https://committed-removal.example/v1',
      capabilities: ['text'],
      models: [],
      apiKey: 'committed-provider-secret',
    });
    workspaceA.plugins = [{
      id: 'committed-removal-mcp',
      name: 'Committed removal MCP',
      version: '1.0.0',
      type: 'remote-mcp',
      permissions: ['network', 'tools'],
      allowedTools: ['search'],
      transport: 'streamable-http',
      endpoint: 'https://committed-removal-mcp.example/mcp',
      serverLabel: 'committed_removal_mcp',
      providerId: 'committed-removal-provider',
      approvalPolicy: 'always',
      authorization: 'Bearer committed-mcp-secret',
      enabled: false,
    }];
    let storage = await subject();
    await storage.saveWorkspace(workspaceA);

    expect(mocks.secureValues.has(`${SECRET_PREFIX}.committed-removal-provider`)).toBe(true);
    expect(mocks.secureValues.has(`${PLUGIN_SECRET_PREFIX}.committed-removal-mcp`)).toBe(true);

    await storage.saveWorkspace({
      ...workspaceA,
      providers: workspaceA.providers.filter(
        (provider) => provider.id !== 'committed-removal-provider'
      ),
      plugins: [],
    });

    expect(mocks.secureValues.has(`${SECRET_PREFIX}.committed-removal-provider`)).toBe(false);
    expect(mocks.secureValues.has(`${PLUGIN_SECRET_PREFIX}.committed-removal-mcp`)).toBe(false);
    expect(mocks.secureDelete).toHaveBeenCalledWith(
      `${SECRET_PREFIX}.committed-removal-provider`
    );
    expect(mocks.secureDelete).toHaveBeenCalledWith(
      `${PLUGIN_SECRET_PREFIX}.committed-removal-mcp`
    );

    vi.resetModules();
    storage = await subject();
    const restarted = await storage.loadWorkspace();
    expect(restarted?.providers.some(
      (provider) => provider.id === 'committed-removal-provider'
    )).toBe(false);
    expect(restarted?.plugins).toEqual([]);
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
      permissions: ['network', 'tools'],
      allowedTools: ['search'],
      transport: 'sse',
      endpoint: 'https://legacy.mcp.example.com/sse',
      serverLabel: 'legacy_mcp',
      providerId,
      approvalPolicy: 'always',
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
      bindingFingerprint: mcpBindingFingerprint({
        transport: 'sse',
        endpoint: 'https://legacy.mcp.example.com/sse',
        serverLabel: 'legacy_mcp',
        providerId,
      }),
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
      allowedTools: [],
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
  it('round-trips only a bounded MCP activity summary and strips every raw field', async () => {
    const workspace = createDefaultWorkspace();
    const mcpActivity: McpActivitySummary = {
      serverLabel: 'safe_server',
      providerRequestCount: 3,
      approvals: [
        { toolName: 'search.docs', decision: 'approve' },
        { toolName: 'delete_item', decision: 'deny' },
      ],
      calls: [
        { toolName: 'search.docs', outcome: 'completed' },
        { toolName: 'read_file', outcome: 'unknown' },
      ],
    };
    Object.assign(mcpActivity, {
      authorization: 'RAW-MCP-AUTHORIZATION',
      requestId: 'RAW-MCP-REQUEST-ID',
    });
    Object.assign(mcpActivity.approvals[0], {
      arguments: 'RAW-MCP-ARGUMENTS',
      approvalId: 'RAW-MCP-APPROVAL-ID',
    });
    Object.assign(mcpActivity.calls[0], {
      output: 'RAW-MCP-OUTPUT',
      callId: 'RAW-MCP-CALL-ID',
    });
    const message: ChatMessage = {
      id: 'mcp-summary-message',
      role: 'assistant',
      content: 'MCP completed',
      createdAt: 10,
      status: 'ready',
      mcpActivity,
    };
    workspace.messages = [message];
    workspace.conversations = [{
      ...workspace.conversations[0],
      messages: [message],
    }];
    const { loadWorkspace, saveWorkspace } = await subject();

    await saveWorkspace(workspace);
    const serialized = mocks.values.get(WORKSPACE_KEY) ?? '';
    for (const rawValue of [
      'RAW-MCP-AUTHORIZATION',
      'RAW-MCP-REQUEST-ID',
      'RAW-MCP-ARGUMENTS',
      'RAW-MCP-APPROVAL-ID',
      'RAW-MCP-OUTPUT',
      'RAW-MCP-CALL-ID',
    ]) {
      expect(serialized).not.toContain(rawValue);
    }

    const loaded = await loadWorkspace();
    expect(loaded?.messages[0].mcpActivity).toEqual({
      serverLabel: 'safe_server',
      providerRequestCount: 3,
      approvals: [
        { toolName: 'search.docs', decision: 'approve' },
        { toolName: 'delete_item', decision: 'deny' },
      ],
      calls: [
        { toolName: 'search.docs', outcome: 'completed' },
        { toolName: 'read_file', outcome: 'unknown' },
      ],
    });
  });

  it.each([
    ['unsafe server label', (summary: McpActivitySummary) => {
      summary.serverLabel = 'unsafe/server';
    }],
    ['zero request count', (summary: McpActivitySummary) => {
      summary.providerRequestCount = 0;
    }],
    ['request count above five', (summary: McpActivitySummary) => {
      summary.providerRequestCount = 6;
    }],
    ['more than four approvals', (summary: McpActivitySummary) => {
      summary.approvals = Array.from({ length: 5 }, () => ({
        toolName: 'search',
        decision: 'approve' as const,
      }));
    }],
    ['more than four calls', (summary: McpActivitySummary) => {
      summary.calls = Array.from({ length: 5 }, () => ({
        toolName: 'search',
        outcome: 'completed' as const,
      }));
    }],
    ['unsafe tool name', (summary: McpActivitySummary) => {
      summary.calls[0].toolName = 'unsafe/tool';
    }],
    ['invalid decision', (summary: McpActivitySummary) => {
      (summary.approvals[0] as unknown as Record<string, unknown>).decision = 'always';
    }],
    ['invalid outcome', (summary: McpActivitySummary) => {
      (summary.calls[0] as unknown as Record<string, unknown>).outcome = 'running';
    }],
  ] as const)('rejects MCP activity with %s before public commit', async (_kind, mutate) => {
    const workspace = createDefaultWorkspace();
    const summary: McpActivitySummary = {
      serverLabel: 'safe_server',
      providerRequestCount: 1,
      approvals: [{ toolName: 'search', decision: 'approve' }],
      calls: [{ toolName: 'search', outcome: 'completed' }],
    };
    mutate(summary);
    const message: ChatMessage = {
      id: 'invalid-mcp-summary',
      role: 'assistant',
      content: 'invalid',
      createdAt: 1,
      status: 'ready',
      mcpActivity: summary,
    };
    workspace.messages = [message];
    workspace.conversations = [{ ...workspace.conversations[0], messages: [message] }];
    const { saveWorkspace } = await subject();

    await expect(saveWorkspace(workspace)).rejects.toThrow(/mcpActivity/);
    expect(mocks.values.has(WORKSPACE_KEY)).toBe(false);
  });

  it('writes a v6 envelope without a duplicate top-level messages field or provider secrets', async () => {
    const workspace = createDefaultWorkspace();
    workspace.providers[0] = { ...workspace.providers[0], apiKey: 'web-only-test-key' };
    const { saveWorkspace } = await subject();

    await saveWorkspace(workspace);

    const envelope = JSON.parse(mocks.values.get(WORKSPACE_KEY) ?? '{}');
    expect(envelope.schemaVersion).toBe(6);
    expect(envelope.revision).toBe(1);
    expect(envelope.workspace.messages).toBeUndefined();
    expect(envelope.workspace.conversations[0].messages).toEqual(workspace.messages);
    expect(envelope.workspace.providers[0].apiKey).toBeUndefined();
    expect(mocks.values.has(`${SECRET_PREFIX}.${workspace.providers[0].id}`)).toBe(false);
  });

  it('round-trips v5 projects, branch metadata, cost guard, and the device-local usage ledger', async () => {
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
      providerRequestCount: 3,
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

  it('normalizes v5 artifacts, knowledge, context flags, references, active revisions, and text bounds', async () => {
    const workspace = createDefaultWorkspace();
    const projectId = workspace.activeProjectId;
    const conversationId = workspace.activeConversationId;
    const sourceMessage: ChatMessage = {
      id: 'source-message',
      role: 'assistant',
      content: 'source',
      createdAt: 2,
      status: 'ready',
      excludedFromContext: true,
      pinnedForContext: true,
    };
    workspace.messages = [sourceMessage];
    workspace.conversations = [{
      ...workspace.conversations[0],
      messages: [sourceMessage],
      knowledgeSourceIds: ['knowledge:one', 'knowledge:one', 'knowledge-two', 'missing'],
    }];
    const overlong = 'x'.repeat(500_007);
    workspace.artifacts = [
      {
        id: 'artifact:one',
        projectId,
        title: 'Artifact',
        format: 'markdown',
        revisions: [
          { id: 'revision-one', content: overlong, createdAt: 2, author: 'assistant', sourceMessageId: sourceMessage.id },
          { id: 'revision-one', content: 'duplicate', createdAt: 3, author: 'user' },
        ],
        activeRevisionId: 'missing-revision',
        sourceConversationId: 'missing-conversation',
        sourceMessageId: 'missing-message',
        createdAt: 2,
        updatedAt: 3,
      },
      {
        id: 'artifact:one',
        projectId,
        title: 'Duplicate artifact',
        format: 'plain-text',
        revisions: [{ id: 'revision-two', content: 'drop', createdAt: 3, author: 'user' }],
        activeRevisionId: 'revision-two',
        createdAt: 3,
        updatedAt: 3,
      },
      {
        id: 'wrong-project-artifact',
        projectId: 'missing-project',
        title: 'Wrong project',
        format: 'plain-text',
        revisions: [{ id: 'revision-three', content: 'drop', createdAt: 3, author: 'user' }],
        activeRevisionId: 'revision-three',
        createdAt: 3,
        updatedAt: 3,
      },
    ];
    workspace.knowledgeSources = [
      {
        id: 'knowledge:one',
        projectId,
        title: 'Artifact source',
        kind: 'artifact',
        content: overlong,
        sourceArtifactId: 'artifact:one',
        sourceConversationId: conversationId,
        sourceMessageId: sourceMessage.id,
        createdAt: 3,
        updatedAt: 3,
      },
      {
        id: 'knowledge:one',
        projectId,
        title: 'Duplicate source',
        kind: 'text',
        content: 'drop',
        createdAt: 3,
        updatedAt: 3,
      },
      {
        id: 'knowledge-two',
        projectId,
        title: 'Stale links',
        kind: 'file',
        content: 'portable text',
        sourceArtifactId: 'missing-artifact',
        sourceConversationId: 'missing-conversation',
        sourceMessageId: 'missing-message',
        createdAt: 3,
        updatedAt: 3,
      },
    ];
    const raw = { ...v4Envelope(workspace, 3), schemaVersion: 5 };
    mocks.values.set(WORKSPACE_KEY, JSON.stringify(raw));
    const { loadWorkspace } = await subject();

    const loaded = await loadWorkspace();

    expect(loaded?.messages[0]).toMatchObject({ excludedFromContext: true });
    expect(loaded?.messages[0].pinnedForContext).toBeUndefined();
    expect(loaded?.artifacts).toHaveLength(1);
    expect(loaded?.artifacts[0]).toMatchObject({
      id: 'artifact:one',
      activeRevisionId: 'revision-one',
      revisions: [{ id: 'revision-one', sourceMessageId: sourceMessage.id }],
    });
    expect(loaded?.artifacts[0].revisions[0].content).toHaveLength(500_000);
    expect(loaded?.artifacts[0].sourceConversationId).toBeUndefined();
    expect(loaded?.artifacts[0].sourceMessageId).toBeUndefined();
    expect(loaded?.knowledgeSources).toHaveLength(2);
    expect(loaded?.knowledgeSources[0].content).toHaveLength(500_000);
    expect(loaded?.knowledgeSources[1]).not.toHaveProperty('sourceArtifactId');
    expect(loaded?.knowledgeSources[1]).not.toHaveProperty('sourceConversationId');
    expect(loaded?.knowledgeSources[1]).not.toHaveProperty('sourceMessageId');
    expect(loaded?.conversations[0].knowledgeSourceIds).toEqual(['knowledge:one', 'knowledge-two']);
  });

  it('caps v5 artifact, revision, knowledge, and conversation-reference counts', async () => {
    const workspace = createDefaultWorkspace();
    const projectId = workspace.activeProjectId;
    workspace.artifacts = Array.from({ length: 205 }, (_, index) => ({
      id: `artifact-${index}`,
      projectId,
      title: `Artifact ${index}`,
      format: 'plain-text' as const,
      revisions: Array.from({ length: index === 0 ? 55 : 1 }, (__, revisionIndex) => ({
        id: `revision-${index}-${revisionIndex}`,
        content: 'x',
        createdAt: revisionIndex,
        author: 'user' as const,
      })),
      activeRevisionId: `revision-${index}-${index === 0 ? 54 : 0}`,
      createdAt: index,
      updatedAt: index,
    }));
    workspace.knowledgeSources = Array.from({ length: 505 }, (_, index) => ({
      id: `knowledge-${index}`,
      projectId,
      title: `Knowledge ${index}`,
      kind: 'text' as const,
      content: 'x',
      createdAt: index,
      updatedAt: index,
    }));
    workspace.conversations[0] = {
      ...workspace.conversations[0],
      knowledgeSourceIds: workspace.knowledgeSources.map((source) => source.id),
    };
    workspace.messages = workspace.conversations[0].messages;
    const raw = { ...v4Envelope(workspace, 4), schemaVersion: 5 };
    mocks.values.set(WORKSPACE_KEY, JSON.stringify(raw));
    const { loadWorkspace } = await subject();

    const loaded = await loadWorkspace();

    expect(loaded?.artifacts).toHaveLength(200);
    expect(loaded?.artifacts[0].revisions).toHaveLength(50);
    expect(loaded?.artifacts[0].revisions[0].id).toBe('revision-0-5');
    expect(loaded?.knowledgeSources).toHaveLength(500);
    expect(loaded?.conversations[0].knowledgeSourceIds).toHaveLength(50);
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
      allowedTools: ['search'],
      transport: 'streamable-http',
      endpoint: 'https://mcp.example.com/mcp',
      serverLabel: 'mcp_1',
      providerId: provider.id,
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
      allowedTools: ['search'],
      transport: 'streamable-http',
      endpoint,
      serverLabel: 'unsafe_mcp',
      providerId: workspace.providers[0].id,
      approvalPolicy: 'always',
      enabled: true,
    }];
    const raw = JSON.stringify(v2Envelope(workspace));
    mocks.values.set(V2_WORKSPACE_KEY, raw);
    const { loadWorkspace } = await subject();

    await expect(loadWorkspace()).rejects.toThrow(/endpoint 无效/);
    expect(mocks.values.get(V2_WORKSPACE_KEY)).toBe(raw);
  });

  it('round-trips 200, 201, and 256-character colon entity IDs through backup import, save, reload, select, update, and delete', async () => {
    const colonId = (prefix: string, length: number) => `${prefix}:${'x'.repeat(length - prefix.length - 1)}`;
    const knowledgeIds = [200, 201, 256].map((length) => colonId('knowledge', length));
    const artifactId = colonId('artifact', 256);
    const revisionId = colonId('revision', 256);
    const source = createDefaultWorkspace();
    source.artifacts = [{
      id: artifactId,
      projectId: source.activeProjectId,
      title: 'Colon ID artifact',
      format: 'plain-text',
      revisions: [{ id: revisionId, content: 'artifact content', createdAt: 1, author: 'user' }],
      activeRevisionId: revisionId,
      createdAt: 1,
      updatedAt: 1,
    }];
    source.knowledgeSources = knowledgeIds.map((id, index) => ({
      id,
      projectId: source.activeProjectId,
      title: `Knowledge ${id.length}`,
      kind: 'artifact' as const,
      content: `knowledge content ${index}`,
      sourceArtifactId: artifactId,
      createdAt: index + 1,
      updatedAt: index + 1,
    }));
    source.conversations = source.conversations.map((conversation) => ({
      ...conversation,
      knowledgeSourceIds: knowledgeIds,
    }));

    const encrypted = await exportEncryptedWorkspaceBackup(
      source,
      'backup boundary password',
      { randomBytes: async (length) => new Uint8Array(length).fill(31) }
    );
    const imported = await importEncryptedWorkspaceBackup(
      encrypted,
      'backup boundary password',
      createDefaultWorkspace()
    );
    expect(
      buildProjectKnowledgeContext(imported.knowledgeSources, imported.activeProjectId, knowledgeIds)
        .includedSourceIds
    ).toEqual(knowledgeIds);

    let updated = imported.knowledgeSources;
    knowledgeIds.forEach((id, index) => {
      updated = updateProjectKnowledgeSource(updated, id, { title: `Updated ${index}` }, 20 + index);
    });
    const { loadWorkspace, saveWorkspace } = await subject();
    await saveWorkspace({ ...imported, knowledgeSources: updated });
    const loaded = await loadWorkspace();

    expect(loaded?.knowledgeSources.map((item) => item.id)).toEqual(knowledgeIds);
    expect(loaded?.knowledgeSources.map((item) => item.title)).toEqual([
      'Updated 0', 'Updated 1', 'Updated 2',
    ]);
    expect(loaded?.artifacts[0].id).toBe(artifactId);
    expect(loaded?.artifacts[0].activeRevisionId).toBe(revisionId);
    expect(loaded?.artifacts[0].revisions[0].id).toBe(revisionId);

    let deleted = loaded!.knowledgeSources;
    knowledgeIds.forEach((id) => {
      deleted = deleteProjectKnowledgeSource(deleted, id);
    });
    await saveWorkspace({ ...loaded!, knowledgeSources: deleted });
    const afterDelete = await loadWorkspace();
    expect(afterDelete?.knowledgeSources).toEqual([]);
    expect(afterDelete?.conversations[0].knowledgeSourceIds).toBeUndefined();
  }, 20_000);

  it('round-trips code-point boundaries for emoji project names, system prompts, and prompt templates', async () => {
    const projectName = '🧠'.repeat(60);
    const projectPrompt = '📘'.repeat(20_000);
    const templateName = '🧩'.repeat(60);
    const templateContent = '✨'.repeat(20_000);
    const source = createDefaultWorkspace();
    source.projects = createWorkspaceProject(
      source.projects,
      { name: projectName, systemPrompt: projectPrompt },
      { id: 'emoji-boundary-project', now: 10 }
    );
    source.activeProjectId = 'emoji-boundary-project';
    source.conversations = source.conversations.map((conversation) => ({
      ...conversation,
      projectId: source.activeProjectId,
    }));
    source.promptTemplates = createPromptTemplate(
      [],
      { name: templateName, content: templateContent },
      { id: 'emoji-boundary-template', now: 10 }
    );
    const { loadWorkspace, saveWorkspace } = await subject();

    await saveWorkspace(source);
    const loaded = await loadWorkspace();
    const loadedProject = loaded?.projects.find((project) => project.id === 'emoji-boundary-project');
    expect(loadedProject?.name).toBe(projectName);
    expect(loadedProject?.systemPrompt).toBe(projectPrompt);
    expect(loaded?.promptTemplates[0].name).toBe(templateName);
    expect(loaded?.promptTemplates[0].content).toBe(templateContent);

    const encrypted = await exportEncryptedWorkspaceBackup(
      loaded!,
      'emoji boundary password',
      { randomBytes: async (length) => new Uint8Array(length).fill(33) }
    );
    const imported = await importEncryptedWorkspaceBackup(
      encrypted,
      'emoji boundary password',
      createDefaultWorkspace()
    );
    const importedProject = imported.projects.find((project) => project.id === 'emoji-boundary-project');
    expect(importedProject?.name).toBe(projectName);
    expect(importedProject?.systemPrompt).toBe(projectPrompt);
    expect(imported.promptTemplates[0].name).toBe(templateName);
    expect(imported.promptTemplates[0].content).toBe(templateContent);
  }, 20_000);

  it.each([
    ['artifact', (workspace: AppWorkspace) => {
      workspace.artifacts = [{
        id: 'over-budget-artifact',
        projectId: workspace.activeProjectId,
        title: 'Over budget artifact',
        format: 'plain-text',
        revisions: Array.from({ length: 5 }, (_, index) => ({
          id: `over-budget-revision-${index}`,
          content: 'a'.repeat(500_000),
          createdAt: index,
          author: 'user' as const,
        })),
        activeRevisionId: 'over-budget-revision-4',
        createdAt: 1,
        updatedAt: 1,
      }];
    }],
    ['knowledge', (workspace: AppWorkspace) => {
      workspace.knowledgeSources = Array.from({ length: 5 }, (_, index) => ({
        id: `over-budget-knowledge-${index}`,
        projectId: workspace.activeProjectId,
        title: `Over budget knowledge ${index}`,
        kind: 'text' as const,
        content: 'k'.repeat(500_000),
        createdAt: index,
        updatedAt: index,
      }));
    }],
  ] as const)('fails closed instead of silently filtering persisted over-budget %s data', async (_kind, mutate) => {
    const workspace = createDefaultWorkspace();
    mutate(workspace);
    const raw = JSON.stringify(v4Envelope(workspace));
    mocks.values.set(WORKSPACE_KEY, raw);
    const { loadWorkspace, saveWorkspace } = await subject();

    await expect(loadWorkspace()).rejects.toThrow(/只读恢复状态/);
    expect(mocks.values.get(WORKSPACE_KEY)).toBe(raw);
    expect(JSON.parse(mocks.values.get(WORKSPACE_RECOVERY_KEY) ?? '{}').raw).toBe(raw);
    await expect(saveWorkspace(createDefaultWorkspace())).rejects.toThrow(/暂停自动保存/);
    expect(mocks.values.get(WORKSPACE_KEY)).toBe(raw);
  }, 20_000);

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
