import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { describe, expect, it, vi } from 'vitest';

import { createDefaultWorkspace } from '../src/data/providerCatalog';
import type { AppWorkspace, ChatConversation, ChatMessage, PluginManifest, ProviderProfile } from '../src/domain/types';
import {
  MAX_PROJECT_KNOWLEDGE_SOURCE_CHARACTERS,
  MAX_PROJECT_KNOWLEDGE_TOTAL_BYTES,
} from '../src/services/projectKnowledge';
import {
  MAX_BACKUP_PASSWORD_LENGTH,
  MAX_ENCRYPTED_BACKUP_BYTES,
  MAX_PLAINTEXT_BACKUP_BYTES,
  WORKSPACE_BACKUP_SCRYPT_PARAMS,
  WorkspaceBackupError,
  createWorkspaceBackupEnvelope,
  exportEncryptedWorkspaceBackup,
  importEncryptedWorkspaceBackup,
  sanitizeWorkspaceForBackup,
  validateWorkspaceBackupEnvelope,
  type WorkspaceBackupEnvelope,
} from '../src/services/workspaceBackup';
import {
  MAX_WORKSPACE_ARTIFACT_CONTENT_LENGTH,
  MAX_WORKSPACE_ARTIFACT_TOTAL_BYTES,
} from '../src/services/workspaceArtifacts';

const cryptoMocks = vi.hoisted(() => ({
  getRandomBytesAsync: vi.fn(async (length: number) => new Uint8Array(length).fill(37)),
}));

vi.mock('expo-crypto', () => ({
  getRandomBytesAsync: cryptoMocks.getRandomBytesAsync,
}));

const password = 'correct horse battery staple';
const encryptionContext = new TextEncoder().encode('embezzle-studio-encrypted-backup:v1');

function deterministicRandom(seed = 1) {
  let cursor = seed;
  return async (length: number) => {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      bytes[index] = cursor % 256;
      cursor += 1;
    }
    return bytes;
  };
}

function plugin(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'plugin-shared',
    name: 'Shared MCP',
    description: 'Portable MCP server',
    version: '1.0.0',
    type: 'remote-mcp',
    permissions: ['network', 'tools'],
    allowedTools: ['search', 'fetch'],
    transport: 'streamable-http',
    endpoint: 'https://mcp.example.com/rpc',
    enabled: true,
    serverLabel: 'shared_mcp',
    providerId: 'volcengine-ark',
    approvalPolicy: 'always',
    ...overrides,
  };
}

function providerFrom(source: ProviderProfile, overrides: Partial<ProviderProfile>): ProviderProfile {
  return {
    ...source,
    capabilities: [...source.capabilities],
    models: source.models.map((model) => ({ ...model, capabilities: [...model.capabilities] })),
    ...overrides,
  };
}

function generatedMessage(): ChatMessage {
  return {
    id: 'generated-message',
    role: 'assistant',
    content: '视频生成任务已提交',
    createdAt: 200,
    status: 'ready',
    attachments: [
      {
        id: 'secret-video',
        kind: 'video',
        uri: 'https://media.example.com/video.mp4?signature=SIGNED-URI-SECRET',
        name: 'video.mp4',
        mimeType: 'video/mp4',
        base64: 'ATTACHMENT-BASE64-SECRET',
      },
    ],
    generationTask: {
      providerId: 'volcengine-ark',
      modelId: 'seedance-1-0-pro',
      taskId: 'cgt-task-123',
      kind: 'video',
      status: 'running',
    },
    mcpActivity: {
      serverLabel: 'portable_server',
      providerRequestCount: 3,
      approvals: [{ toolName: 'search.docs', decision: 'approve' }],
      calls: [{ toolName: 'search.docs', outcome: 'completed' }],
    },
    modelId: 'seedance-1-0-pro',
    providerId: 'volcengine-ark',
    providerName: 'Volcengine Ark',
  };
}

function populatedWorkspace(): AppWorkspace {
  const workspace = createDefaultWorkspace();
  const primary = providerFrom(workspace.providers[0], { apiKey: 'BACKUP-PROVIDER-API-KEY' });
  const added = providerFrom(workspace.providers[1], {
    id: 'provider-new',
    name: 'Imported provider',
    apiKey: 'NEW-PROVIDER-API-KEY',
  });
  const message = generatedMessage();
  message.pinnedForContext = true;
  const activeConversation = workspace.conversations[0];
  const artifact = {
    id: 'artifact-portable',
    projectId: workspace.activeProjectId,
    title: 'Portable markdown',
    format: 'markdown' as const,
    revisions: [{
      id: 'artifact-revision-1',
      content: '# Portable artifact text',
      createdAt: 200,
      author: 'assistant' as const,
      sourceMessageId: message.id,
    }],
    activeRevisionId: 'artifact-revision-1',
    sourceConversationId: activeConversation.id,
    sourceMessageId: message.id,
    createdAt: 200,
    updatedAt: 200,
  };
  const knowledgeSource = {
    id: 'knowledge-portable',
    projectId: workspace.activeProjectId,
    title: 'Portable project knowledge',
    kind: 'artifact' as const,
    content: '# Portable knowledge text',
    sourceArtifactId: artifact.id,
    sourceConversationId: activeConversation.id,
    sourceMessageId: message.id,
    createdAt: 200,
    updatedAt: 200,
  };
  return {
    ...workspace,
    providers: [primary, added, ...workspace.providers.slice(2)],
    messages: [message],
    conversations: [{
      ...activeConversation,
      updatedAt: 200,
      messages: [message],
      knowledgeSourceIds: [knowledgeSource.id],
    }],
    artifacts: [artifact],
    knowledgeSources: [knowledgeSource],
    plugins: [
      plugin({
        endpoint: 'https://mcp.example.com/rpc?token=PLUGIN-QUERY-SECRET',
        authorization: 'BACKUP-PLUGIN-AUTHORIZATION',
      }),
      plugin({
        id: 'plugin-new',
        name: 'New MCP',
        serverLabel: 'new_mcp',
        endpoint: 'https://new-mcp.example.com/rpc',
        authorization: 'NEW-PLUGIN-AUTHORIZATION',
      }),
    ],
    promptTemplates: [
      {
        id: 'template-1',
        name: '翻译',
        content: '请翻译 {{text}}',
        mode: 'composer',
        createdAt: 100,
        updatedAt: 100,
      },
    ],
    providerUsageEvents: [{
      id: 'source-device-ledger-event',
      kind: 'chat',
      status: 'succeeded',
      providerRequestCount: 1,
      providerId: primary.id,
      modelId: 'source-model',
      createdAt: 100,
      localDateKey: '2026-07-10',
      unknownCostComponents: ['provider-surcharge'],
    }],
  };
}

function currentWorkspaceWithLocalSecrets(): AppWorkspace {
  const current = createDefaultWorkspace();
  return {
    ...current,
    providers: current.providers.map((item, index) =>
      index === 0 ? { ...item, apiKey: 'CURRENT-DEVICE-API-KEY' } : item
    ),
    plugins: [
      plugin({
        endpoint: 'https://current.example.com/rpc',
        authorization: 'CURRENT-DEVICE-PLUGIN-AUTH',
      }),
      plugin({
        id: 'plugin-new',
        name: 'New MCP',
        serverLabel: 'new_mcp',
        endpoint: 'https://new-mcp.example.com/rpc',
        authorization: 'CURRENT-DEVICE-MATCHING-PLUGIN-AUTH',
      }),
    ],
    providerUsageEvents: [{
      id: 'current-device-ledger-event',
      kind: 'chat',
      status: 'succeeded',
      providerRequestCount: 1,
      providerId: current.providers[0].id,
      modelId: 'current-model',
      createdAt: 200,
      completedAt: 201,
      localDateKey: '2026-07-11',
      knownCostEstimate: {
        amount: 0.25,
        currency: 'CNY',
        source: 'user-configured',
        pricingUpdatedAt: 199,
      },
      unknownCostComponents: [],
    }],
  };
}

async function encryptPlainEnvelope(envelope: WorkspaceBackupEnvelope): Promise<string> {
  const salt = new Uint8Array(32).fill(7);
  const nonce = new Uint8Array(24).fill(9);
  const key = await scryptAsync(password, salt, {
    N: WORKSPACE_BACKUP_SCRYPT_PARAMS.N,
    r: WORKSPACE_BACKUP_SCRYPT_PARAMS.r,
    p: WORKSPACE_BACKUP_SCRYPT_PARAMS.p,
    dkLen: WORKSPACE_BACKUP_SCRYPT_PARAMS.dkLen,
    asyncTick: 8,
    maxmem: 64 * 1024 * 1024,
  });
  try {
    const plaintext = new TextEncoder().encode(JSON.stringify(envelope));
    const ciphertext = xchacha20poly1305(key, nonce, encryptionContext).encrypt(plaintext);
    return JSON.stringify({
      magic: 'embezzle-studio-encrypted-backup',
      version: 1,
      kdf: {
        ...WORKSPACE_BACKUP_SCRYPT_PARAMS,
        salt: Buffer.from(salt).toString('base64'),
      },
      cipher: {
        name: 'xchacha20-poly1305',
        nonce: Buffer.from(nonce).toString('base64'),
      },
      ciphertext: Buffer.from(ciphertext).toString('base64'),
    });
  } finally {
    key.fill(0);
  }
}

const boundaryBackupNow = 1_700_000_000_000;

function boundedAsciiChunks(totalBytes: number, maximumChunkBytes: number): string[] {
  const chunks: string[] = [];
  let remaining = totalBytes;
  while (remaining > 0) {
    const length = Math.min(remaining, maximumChunkBytes);
    chunks.push('x'.repeat(length));
    remaining -= length;
  }
  return chunks;
}

function maximumMixedWorkspaceAtPlaintextBytes(targetBytes: number): AppWorkspace {
  const workspace = createDefaultWorkspace();
  const conversation = workspace.conversations[0];
  const boundaryMessage: ChatMessage = {
    id: 'boundary-message',
    role: 'user',
    content: '',
    createdAt: 100,
    status: 'ready',
  };
  const artifactChunks = boundedAsciiChunks(
    MAX_WORKSPACE_ARTIFACT_TOTAL_BYTES,
    MAX_WORKSPACE_ARTIFACT_CONTENT_LENGTH
  );
  const knowledgeChunks = boundedAsciiChunks(
    MAX_PROJECT_KNOWLEDGE_TOTAL_BYTES,
    MAX_PROJECT_KNOWLEDGE_SOURCE_CHARACTERS
  );
  const knowledgeSources = knowledgeChunks.map((content, index) => ({
    id: `boundary-knowledge-${index}`,
    projectId: workspace.activeProjectId,
    title: `Boundary knowledge ${index}`,
    kind: 'text' as const,
    content,
    createdAt: 100 + index,
    updatedAt: 100 + index,
  }));
  workspace.messages = [boundaryMessage];
  workspace.conversations = [{
    ...conversation,
    updatedAt: 200,
    messages: [boundaryMessage],
    knowledgeSourceIds: knowledgeSources.map(({ id }) => id),
  }];
  workspace.artifacts = [{
    id: 'boundary-artifact',
    projectId: workspace.activeProjectId,
    title: 'Maximum mixed artifact',
    format: 'plain-text',
    revisions: artifactChunks.map((content, index) => ({
      id: `boundary-artifact-revision-${index}`,
      content,
      createdAt: 100 + index,
      author: 'user' as const,
    })),
    activeRevisionId: `boundary-artifact-revision-${artifactChunks.length - 1}`,
    createdAt: 100,
    updatedAt: 100 + artifactChunks.length - 1,
  }];
  workspace.knowledgeSources = knowledgeSources;

  const initialBytes = new TextEncoder().encode(
    JSON.stringify(createWorkspaceBackupEnvelope(workspace, boundaryBackupNow))
  ).length;
  const paddingBytes = targetBytes - initialBytes;
  if (paddingBytes < 0) {
    throw new Error(`Mixed workspace baseline ${initialBytes} exceeds target ${targetBytes}.`);
  }
  boundaryMessage.content = 'm'.repeat(paddingBytes);
  const exactBytes = new TextEncoder().encode(
    JSON.stringify(createWorkspaceBackupEnvelope(workspace, boundaryBackupNow))
  ).length;
  if (exactBytes !== targetBytes) {
    throw new Error(`Expected ${targetBytes} plaintext bytes, received ${exactBytes}.`);
  }
  return workspace;
}

function envelopeWithValidBranch(): WorkspaceBackupEnvelope {
  const workspace = createDefaultWorkspace();
  const rootPoint: ChatMessage = {
    id: 'root-branch-point',
    role: 'user',
    content: 'branch here',
    createdAt: 2,
    status: 'ready',
  };
  const childMessage: ChatMessage = {
    id: 'child-message',
    role: 'assistant',
    content: 'child',
    createdAt: 3,
    status: 'ready',
  };
  workspace.messages = [...workspace.messages, rootPoint];
  workspace.conversations = [
    { ...workspace.conversations[0], messages: workspace.messages },
    {
      id: 'child-conversation',
      title: 'Child',
      projectId: workspace.activeProjectId,
      parentConversationId: workspace.activeConversationId,
      branchPointMessageId: rootPoint.id,
      createdAt: 3,
      updatedAt: 3,
      messages: [childMessage],
    },
  ];
  return createWorkspaceBackupEnvelope(workspace, 1_700_000_000_000);
}

describe('workspace backup sanitization', () => {
  it('removes every structured secret and all attachment data while retaining text and task metadata', () => {
    const workspace = populatedWorkspace();
    Object.assign(workspace.messages[0].mcpActivity!, {
      authorization: 'RAW-BACKUP-MCP-AUTHORIZATION',
      requestId: 'RAW-BACKUP-MCP-REQUEST-ID',
    });
    Object.assign(workspace.messages[0].mcpActivity!.approvals[0], {
      arguments: 'RAW-BACKUP-MCP-ARGUMENTS',
      approvalId: 'RAW-BACKUP-MCP-APPROVAL-ID',
    });
    Object.assign(workspace.messages[0].mcpActivity!.calls[0], {
      output: 'RAW-BACKUP-MCP-OUTPUT',
      callId: 'RAW-BACKUP-MCP-CALL-ID',
    });
    Object.assign(workspace.plugins[1], {
      lastToolArguments: 'RAW-BACKUP-TOOL-ARGUMENTS',
      lastToolOutput: 'RAW-BACKUP-TOOL-OUTPUT',
    });
    const safe = sanitizeWorkspaceForBackup(workspace);
    const serialized = JSON.stringify(safe);

    expect(serialized).not.toContain('BACKUP-PROVIDER-API-KEY');
    expect(serialized).not.toContain('NEW-PROVIDER-API-KEY');
    expect(serialized).not.toContain('BACKUP-PLUGIN-AUTHORIZATION');
    expect(serialized).not.toContain('NEW-PLUGIN-AUTHORIZATION');
    expect(serialized).not.toContain('PLUGIN-QUERY-SECRET');
    expect(serialized).not.toContain('SIGNED-URI-SECRET');
    expect(serialized).not.toContain('ATTACHMENT-BASE64-SECRET');
    expect(serialized).not.toContain('"apiKey":');
    expect(serialized).not.toContain('"authorization":');
    expect(serialized).not.toContain('"attachments":');
    expect(serialized).not.toContain('providerUsageEvents');
    expect(serialized).not.toContain('source-device-ledger-event');
    expect(serialized).not.toContain('RAW-BACKUP-TOOL-ARGUMENTS');
    expect(serialized).not.toContain('RAW-BACKUP-TOOL-OUTPUT');
    expect(serialized).not.toContain('"mcpActivity"');
    expect(serialized).not.toContain('RAW-BACKUP-MCP-AUTHORIZATION');
    expect(serialized).not.toContain('RAW-BACKUP-MCP-REQUEST-ID');
    expect(serialized).not.toContain('RAW-BACKUP-MCP-ARGUMENTS');
    expect(serialized).not.toContain('RAW-BACKUP-MCP-APPROVAL-ID');
    expect(serialized).not.toContain('RAW-BACKUP-MCP-OUTPUT');
    expect(serialized).not.toContain('RAW-BACKUP-MCP-CALL-ID');

    const message = safe.conversations[0].messages[0];
    expect(message.content).toBe('视频生成任务已提交');
    expect(message.pinnedForContext).toBe(true);
    expect(message.generationTask).toMatchObject({ taskId: 'cgt-task-123', status: 'running' });
    expect(safe.artifacts?.[0].revisions[0].content).toBe('# Portable artifact text');
    expect(safe.knowledgeSources?.[0].content).toBe('# Portable knowledge text');
    expect(safe.conversations[0].knowledgeSourceIds).toEqual(['knowledge-portable']);
    expect(safe.plugins[0].endpoint).toBeUndefined();
    expect(safe.plugins[1].endpoint).toBe('https://new-mcp.example.com/rpc');
    expect(safe.plugins[1]).toMatchObject({
      description: 'Portable MCP server',
      allowedTools: ['search', 'fetch'],
      serverLabel: 'new_mcp',
      providerId: 'volcengine-ark',
    });
  });

  it('deduplicates the bounded allowlist before it enters a portable backup', () => {
    const workspace = populatedWorkspace();
    workspace.plugins[1].allowedTools = ['search', 'search', 'fetch'];

    const safe = sanitizeWorkspaceForBackup(workspace);

    expect(safe.plugins[1].allowedTools).toEqual(['search', 'fetch']);
  });

  it('rejects a provider endpoint with structured secrets before randomness or encryption', async () => {
    const workspace = createDefaultWorkspace();
    workspace.providers[0] = providerFrom(workspace.providers[0], {
      baseUrl: 'https://backup-user:USERINFO-SECRET@api.example.com/v1?api_key=QUERY-SECRET#FRAGMENT-SECRET',
    });
    const randomBytes = vi.fn(deterministicRandom(31));

    await expect(
      exportEncryptedWorkspaceBackup(workspace, password, { randomBytes })
    ).rejects.toMatchObject({ code: 'invalid-format' });
    expect(randomBytes).not.toHaveBeenCalled();
  });

  it.each([
    'https://api.example.com/v1',
    'http://localhost:11434/v1',
    'http://127.0.0.1:8080/v1',
    'http://[::1]:8080/v1',
  ])('retains a safe HTTPS or loopback HTTP provider endpoint: %s', (baseUrl) => {
    const workspace = createDefaultWorkspace();
    workspace.providers[0] = providerFrom(workspace.providers[0], { baseUrl });
    expect(sanitizeWorkspaceForBackup(workspace).providers[0].baseUrl).toBe(baseUrl);
  });

  it('creates a versioned plaintext envelope that explicitly excludes keys and media', () => {
    const envelope = createWorkspaceBackupEnvelope(populatedWorkspace(), 1_700_000_000_000);
    expect(envelope).toMatchObject({
      magic: 'embezzle-studio-backup',
      version: 1,
      exportedAt: '2023-11-14T22:13:20.000Z',
      includes: { apiKeys: false, mediaFiles: false },
    });
  });

  it('captures a newly opened active conversation even before it enters the history list', () => {
    const workspace = createDefaultWorkspace();
    workspace.activeConversationId = 'conversation-empty-new';
    workspace.messages = [];
    const safe = sanitizeWorkspaceForBackup(workspace);
    expect(safe.conversations[0]).toMatchObject({
      id: 'conversation-empty-new',
      title: '新对话',
      messages: [],
    });
  });
});

describe('encrypted workspace backup round trip', () => {
  it('uses expo-crypto as the default random source for a 32-byte salt and 24-byte nonce', async () => {
    cryptoMocks.getRandomBytesAsync.mockClear();
    await exportEncryptedWorkspaceBackup(createDefaultWorkspace(), password, {
      now: 1_700_000_000_000,
    });
    expect(cryptoMocks.getRandomBytesAsync.mock.calls.map(([length]) => length)).toEqual([32, 24]);
  }, 20_000);

  it('uses XChaCha20-Poly1305 and scrypt, then restores only matching local secrets without network access', async () => {
    const source = populatedWorkspace();
    const current = currentWorkspaceWithLocalSecrets();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const encrypted = await exportEncryptedWorkspaceBackup(source, password, {
        now: 1_700_000_000_000,
        randomBytes: deterministicRandom(11),
      });
      const outer = JSON.parse(encrypted);
      expect(outer).toMatchObject({
        magic: 'embezzle-studio-encrypted-backup',
        version: 1,
        kdf: WORKSPACE_BACKUP_SCRYPT_PARAMS,
        cipher: { name: 'xchacha20-poly1305' },
      });
      expect(Buffer.from(outer.kdf.salt, 'base64')).toHaveLength(32);
      expect(Buffer.from(outer.cipher.nonce, 'base64')).toHaveLength(24);

      const imported = await importEncryptedWorkspaceBackup(encrypted, password, current);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(imported.providers.find((item) => item.id === 'volcengine-ark')?.apiKey).toBe('CURRENT-DEVICE-API-KEY');
      expect(imported.providers.find((item) => item.id === 'provider-new')).not.toHaveProperty('apiKey');
      expect(imported.plugins.find((item) => item.id === 'plugin-shared')).not.toHaveProperty('authorization');
      expect(imported.plugins.find((item) => item.id === 'plugin-new')?.authorization).toBe('CURRENT-DEVICE-MATCHING-PLUGIN-AUTH');
      expect(imported.plugins.filter((item) => item.type === 'remote-mcp')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'plugin-shared', enabled: false }),
          expect.objectContaining({ id: 'plugin-new', enabled: false }),
        ])
      );
      expect(imported.messages[0]).not.toHaveProperty('attachments');
      expect(imported.messages[0].generationTask).toMatchObject({ taskId: 'cgt-task-123' });
      expect(imported.messages[0]).not.toHaveProperty('mcpActivity');
      expect(imported.messages[0].pinnedForContext).toBe(true);
      expect(imported.artifacts[0].revisions[0].content).toBe('# Portable artifact text');
      expect(imported.knowledgeSources[0].content).toBe('# Portable knowledge text');
      expect(imported.conversations[0].knowledgeSourceIds).toEqual(['knowledge-portable']);
      expect(imported.promptTemplates[0].content).toBe('请翻译 {{text}}');
      expect(imported.providerUsageEvents).toEqual(current.providerUsageEvents);
      expect(imported.providerUsageEvents).not.toBe(current.providerUsageEvents);
      expect(imported.providerUsageEvents[0].knownCostEstimate).not.toBe(
        current.providerUsageEvents[0].knownCostEstimate
      );
      expect(imported.providerUsageEvents[0].unknownCostComponents).not.toBe(
        current.providerUsageEvents[0].unknownCostComponents
      );
      expect(current.providers[0].apiKey).toBe('CURRENT-DEVICE-API-KEY');
    } finally {
      vi.unstubAllGlobals();
    }
  }, 20_000);

  it('does not bind a local API key or MCP authorization to a same-ID backup entry at a different endpoint', async () => {
    const source = populatedWorkspace();
    source.providers[0] = {
      ...source.providers[0],
      baseUrl: 'https://ark.cn-beijing.volcengineapi.com/api/v3',
    };
    const encrypted = await exportEncryptedWorkspaceBackup(source, password, {
      randomBytes: deterministicRandom(17),
    });
    const imported = await importEncryptedWorkspaceBackup(
      encrypted,
      password,
      currentWorkspaceWithLocalSecrets()
    );

    expect(imported.providers[0]).not.toHaveProperty('apiKey');
    expect(imported.plugins.find((item) => item.id === 'plugin-shared')).not.toHaveProperty('authorization');
    expect(imported.plugins.find((item) => item.id === 'plugin-new')).not.toHaveProperty(
      'authorization'
    );
  }, 20_000);

  it.each([
    ['Base URL', () => {
      const source = populatedWorkspace();
      const current = currentWorkspaceWithLocalSecrets();
      source.providers[0] = {
        ...source.providers[0],
        baseUrl: 'https://ark.cn-beijing.volcengineapi.com/api/v3',
      };
      return { source, current };
    }],
    ['kind', () => {
      const source = populatedWorkspace();
      const current = currentWorkspaceWithLocalSecrets();
      const baseUrl = 'https://relay.example.com/v1';
      source.providers[0] = {
        ...source.providers[0],
        kind: 'openai-compatible',
        baseUrl,
      };
      current.providers[0] = {
        ...current.providers[0],
        kind: 'custom',
        baseUrl,
      };
      return { source, current };
    }],
  ] as const)(
    'does not inherit MCP authorization when the same provider ID changes %s',
    async (_kind, setup) => {
      const { source, current } = setup();
      const encrypted = await exportEncryptedWorkspaceBackup(source, password, {
        randomBytes: deterministicRandom(19),
      });

      const imported = await importEncryptedWorkspaceBackup(encrypted, password, current);

      expect(imported.plugins.find((item) => item.id === 'plugin-new')).not.toHaveProperty(
        'authorization'
      );
    },
    20_000
  );

  it.each([
    ['allowlist', (source: AppWorkspace) => {
      source.plugins[1].allowedTools = ['search'];
    }],
    ['provider binding', (source: AppWorkspace) => {
      source.plugins[1].providerId = 'provider-new';
    }],
  ] as const)('does not inherit local MCP authorization after a %s change', async (_kind, mutate) => {
    const source = populatedWorkspace();
    mutate(source);
    const encrypted = await exportEncryptedWorkspaceBackup(source, password, {
      randomBytes: deterministicRandom(23),
    });

    const imported = await importEncryptedWorkspaceBackup(
      encrypted,
      password,
      currentWorkspaceWithLocalSecrets()
    );

    expect(imported.plugins.find((item) => item.id === 'plugin-new')).not.toHaveProperty(
      'authorization'
    );
  }, 20_000);

  it('imports an old backup without an MCP allowlist as disabled and without local authorization', async () => {
    const envelope = createWorkspaceBackupEnvelope(populatedWorkspace(), 1_700_000_000_000);
    const legacyPlugin = envelope.workspace.plugins.find((item) => item.id === 'plugin-new')!;
    delete (legacyPlugin as Partial<PluginManifest>).allowedTools;
    const encrypted = await encryptPlainEnvelope(envelope);

    const imported = await importEncryptedWorkspaceBackup(
      encrypted,
      password,
      currentWorkspaceWithLocalSecrets()
    );

    expect(imported.plugins.find((item) => item.id === 'plugin-new')).toMatchObject({
      allowedTools: [],
      enabled: false,
    });
    expect(imported.plugins.find((item) => item.id === 'plugin-new')).not.toHaveProperty(
      'authorization'
    );
  }, 20_000);

  it('imports an older v1 backup without project or cost-guard fields and retains the device ledger', async () => {
    const envelope = createWorkspaceBackupEnvelope(populatedWorkspace(), 1_700_000_000_000);
    delete envelope.workspace.projects;
    delete envelope.workspace.activeProjectId;
    delete envelope.workspace.artifacts;
    delete envelope.workspace.knowledgeSources;
    delete envelope.workspace.costGuard;
    envelope.workspace.conversations = envelope.workspace.conversations.map((conversation) => {
      const legacy = { ...conversation };
      delete legacy.projectId;
      delete legacy.parentConversationId;
      delete legacy.branchPointMessageId;
      delete legacy.knowledgeSourceIds;
      return legacy;
    });
    const current = currentWorkspaceWithLocalSecrets();
    const encrypted = await encryptPlainEnvelope(envelope);

    const imported = await importEncryptedWorkspaceBackup(encrypted, password, current);

    expect(imported.projects).toHaveLength(1);
    expect(imported.activeProjectId).toBe(imported.projects[0].id);
    expect(imported.conversations.every((conversation) => conversation.projectId === imported.activeProjectId)).toBe(true);
    expect(imported.costGuard).toMatchObject({ enabled: false, maxOutputTokens: 4096 });
    expect(imported.artifacts).toEqual([]);
    expect(imported.knowledgeSources).toEqual([]);
    expect(imported.providerUsageEvents).toEqual(current.providerUsageEvents);
  }, 20_000);
});

describe('encrypted workspace backup size boundaries', () => {
  it('derives an exact plaintext cap from authentication and Base64 envelope growth', () => {
    const fixedEnvelopeBytes = Buffer.byteLength(JSON.stringify({
      magic: 'embezzle-studio-encrypted-backup',
      version: 1,
      kdf: {
        ...WORKSPACE_BACKUP_SCRYPT_PARAMS,
        salt: Buffer.alloc(32).toString('base64'),
      },
      cipher: {
        name: 'xchacha20-poly1305',
        nonce: Buffer.alloc(24).toString('base64'),
      },
      ciphertext: '',
    }));
    const outerBytesFor = (plaintextBytes: number) =>
      fixedEnvelopeBytes + 4 * Math.ceil((plaintextBytes + 16) / 3);

    expect(outerBytesFor(MAX_PLAINTEXT_BACKUP_BYTES)).toBeLessThanOrEqual(
      MAX_ENCRYPTED_BACKUP_BYTES
    );
    expect(outerBytesFor(MAX_PLAINTEXT_BACKUP_BYTES + 1)).toBeGreaterThan(
      MAX_ENCRYPTED_BACKUP_BYTES
    );
    expect(
      MAX_ENCRYPTED_BACKUP_BYTES - outerBytesFor(MAX_PLAINTEXT_BACKUP_BYTES)
    ).toBeLessThan(4);
  });

  it('round-trips an exact-boundary mixed workspace and rejects one more byte before KDF', async () => {
    const workspace = maximumMixedWorkspaceAtPlaintextBytes(MAX_PLAINTEXT_BACKUP_BYTES);
    const encrypted = await exportEncryptedWorkspaceBackup(workspace, password, {
      now: boundaryBackupNow,
      randomBytes: deterministicRandom(41),
    });

    expect(Buffer.byteLength(encrypted)).toBeLessThanOrEqual(MAX_ENCRYPTED_BACKUP_BYTES);
    expect(MAX_ENCRYPTED_BACKUP_BYTES - Buffer.byteLength(encrypted)).toBeLessThan(4);

    const overflowMessage: ChatMessage = {
      ...workspace.messages[0],
      content: `${workspace.messages[0].content}x`,
    };
    workspace.messages = [overflowMessage];
    workspace.conversations = workspace.conversations.map((conversation) =>
      conversation.id === workspace.activeConversationId
        ? { ...conversation, messages: [overflowMessage] }
        : conversation
    );
    const overflowRandom = vi.fn(deterministicRandom(43));
    await expect(
      exportEncryptedWorkspaceBackup(workspace, password, {
        now: boundaryBackupNow,
        randomBytes: overflowRandom,
      })
    ).rejects.toMatchObject({ code: 'too-large' });
    expect(overflowRandom).not.toHaveBeenCalled();

    const imported = await importEncryptedWorkspaceBackup(
      encrypted,
      password,
      createDefaultWorkspace()
    );
    const artifactBytes = imported.artifacts[0].revisions.reduce(
      (total, item) => total + Buffer.byteLength(item.content),
      0
    );
    const knowledgeBytes = imported.knowledgeSources.reduce(
      (total, item) => total + Buffer.byteLength(item.content),
      0
    );
    expect(artifactBytes).toBe(MAX_WORKSPACE_ARTIFACT_TOTAL_BYTES);
    expect(knowledgeBytes).toBe(MAX_PROJECT_KNOWLEDGE_TOTAL_BYTES);
    expect(imported.messages[0].id).toBe('boundary-message');
  }, 60_000);
});

describe('encrypted workspace backup rejection paths', () => {
  it('returns the same safe error for a wrong password and authenticated-ciphertext tampering', async () => {
    const encrypted = await exportEncryptedWorkspaceBackup(populatedWorkspace(), password, {
      randomBytes: deterministicRandom(21),
    });
    const outer = JSON.parse(encrypted);
    const middle = Math.floor(outer.ciphertext.length / 2);
    outer.ciphertext = `${outer.ciphertext.slice(0, middle)}${outer.ciphertext[middle] === 'A' ? 'B' : 'A'}${outer.ciphertext.slice(middle + 1)}`;
    const tampered = JSON.stringify(outer);

    for (const attempt of [
      importEncryptedWorkspaceBackup(encrypted, 'wrong password value', createDefaultWorkspace()),
      importEncryptedWorkspaceBackup(tampered, password, createDefaultWorkspace()),
    ]) {
      await expect(attempt).rejects.toMatchObject({
        code: 'decrypt-failed',
        message: '无法解密备份：密码错误或文件已损坏。',
      });
    }
  }, 20_000);

  it('enforces password and 10 MB input limits before decryption', async () => {
    await expect(exportEncryptedWorkspaceBackup(createDefaultWorkspace(), 'short')).rejects.toMatchObject({
      code: 'password-policy',
    });
    await expect(
      exportEncryptedWorkspaceBackup(createDefaultWorkspace(), 'x'.repeat(MAX_BACKUP_PASSWORD_LENGTH + 1))
    ).rejects.toMatchObject({ code: 'password-policy' });
    await expect(
      importEncryptedWorkspaceBackup('x'.repeat(MAX_ENCRYPTED_BACKUP_BYTES + 1), password, createDefaultWorkspace())
    ).rejects.toMatchObject({ code: 'too-large' });
  });

  it('rejects an authenticated import whose provider endpoint contains structured secrets', async () => {
    const envelope = createWorkspaceBackupEnvelope(createDefaultWorkspace(), boundaryBackupNow);
    envelope.workspace.providers[0].baseUrl =
      'https://import-user:IMPORT-PASSWORD@api.example.com/v1?token=IMPORT-QUERY#IMPORT-FRAGMENT';
    const encrypted = await encryptPlainEnvelope(envelope);

    await expect(
      importEncryptedWorkspaceBackup(encrypted, password, createDefaultWorkspace())
    ).rejects.toMatchObject({ code: 'invalid-format' });
  }, 20_000);

  it.each([
    'https://user:password@api.example.com/v1',
    'https://api.example.com/v1?token=secret',
    'https://api.example.com/v1#secret',
    'http://api.example.com/v1',
  ])('rejects an unsafe plaintext provider endpoint during strict validation: %s', (baseUrl) => {
    const envelope = createWorkspaceBackupEnvelope(createDefaultWorkspace(), boundaryBackupNow);
    envelope.workspace.providers[0].baseUrl = baseUrl;
    expect(() => validateWorkspaceBackupEnvelope(envelope)).toThrow(/baseUrl/);
  });

  it('rejects invalid random-source output before encryption', async () => {
    await expect(
      exportEncryptedWorkspaceBackup(createDefaultWorkspace(), password, {
        randomBytes: async (length) => new Uint8Array(length - 1),
      })
    ).rejects.toMatchObject({ code: 'random-source' });
  });
});

describe('strict backup validation', () => {
  it.each([
    ['provider', (workspace: AppWorkspace) => {
      workspace.providers.push(providerFrom(workspace.providers[0], { id: workspace.providers[0].id }));
    }],
    ['conversation', (workspace: AppWorkspace) => {
      const duplicate: ChatConversation = {
        id: 'duplicate-conversation',
        title: 'Duplicate',
        createdAt: 1,
        updatedAt: 1,
        messages: [],
      };
      workspace.conversations.push(duplicate, { ...duplicate });
    }],
    ['message', (workspace: AppWorkspace) => {
      const duplicate = generatedMessage();
      workspace.messages = [duplicate, { ...duplicate }];
    }],
    ['template', (workspace: AppWorkspace) => {
      const duplicate = {
        id: 'duplicate-template',
        name: 'Duplicate',
        content: 'content',
        mode: 'composer' as const,
        createdAt: 1,
        updatedAt: 1,
      };
      workspace.promptTemplates = [duplicate, { ...duplicate }];
    }],
    ['plugin', (workspace: AppWorkspace) => {
      const duplicate = plugin({ id: 'duplicate-plugin' });
      workspace.plugins = [duplicate, { ...duplicate }];
    }],
    ['artifact', (workspace: AppWorkspace) => {
      const duplicate = {
        id: 'duplicate-artifact',
        projectId: workspace.activeProjectId,
        title: 'Duplicate',
        format: 'plain-text' as const,
        revisions: [{ id: 'revision-one', content: 'text', createdAt: 1, author: 'user' as const }],
        activeRevisionId: 'revision-one',
        createdAt: 1,
        updatedAt: 1,
      };
      workspace.artifacts = [duplicate, { ...duplicate, revisions: duplicate.revisions.map((item) => ({ ...item })) }];
    }],
    ['artifact revision', (workspace: AppWorkspace) => {
      const revision = { id: 'duplicate-revision', content: 'text', createdAt: 1, author: 'user' as const };
      workspace.artifacts = [{
        id: 'artifact-one',
        projectId: workspace.activeProjectId,
        title: 'Duplicate revision',
        format: 'plain-text',
        revisions: [revision, { ...revision }],
        activeRevisionId: revision.id,
        createdAt: 1,
        updatedAt: 1,
      }];
    }],
    ['knowledge source', (workspace: AppWorkspace) => {
      const duplicate = {
        id: 'duplicate-knowledge',
        projectId: workspace.activeProjectId,
        title: 'Duplicate',
        kind: 'text' as const,
        content: 'text',
        createdAt: 1,
        updatedAt: 1,
      };
      workspace.knowledgeSources = [duplicate, { ...duplicate }];
    }],
  ])('rejects duplicate %s IDs before encryption', (_kind, mutate) => {
    const workspace = createDefaultWorkspace();
    mutate(workspace);
    expect(() => createWorkspaceBackupEnvelope(workspace)).toThrow(WorkspaceBackupError);
    try {
      createWorkspaceBackupEnvelope(workspace);
    } catch (error) {
      expect(error).toMatchObject({ code: 'duplicate-id' });
    }
  });

  it('rejects duplicate IDs in an authenticated imported payload', async () => {
    const envelope = createWorkspaceBackupEnvelope(createDefaultWorkspace(), 1_700_000_000_000);
    const message = envelope.workspace.conversations[0].messages[0];
    envelope.workspace.conversations[0].messages.push({ ...message });
    const encrypted = await encryptPlainEnvelope(envelope);

    await expect(
      importEncryptedWorkspaceBackup(encrypted, password, createDefaultWorkspace())
    ).rejects.toMatchObject({ code: 'duplicate-id' });
  }, 20_000);

  it.each([
    ['provider', (envelope: WorkspaceBackupEnvelope) => {
      envelope.workspace.providers[0].id = 'provider:colon-is-invalid';
    }],
    ['project', (envelope: WorkspaceBackupEnvelope) => {
      envelope.workspace.projects![0].id = 'project:colon-is-invalid';
    }],
  ] as const)('rejects an authenticated payload with a colon in a legacy %s ID', async (_kind, mutate) => {
    const envelope = createWorkspaceBackupEnvelope(createDefaultWorkspace(), 1_700_000_000_000);
    mutate(envelope);
    const encrypted = await encryptPlainEnvelope(envelope);

    await expect(
      importEncryptedWorkspaceBackup(encrypted, password, createDefaultWorkspace())
    ).rejects.toMatchObject({ code: 'invalid-format' });
  }, 20_000);

  it('rejects unknown fields, attachment fields, and unsafe plugin endpoints in plaintext envelopes', () => {
    const base = createWorkspaceBackupEnvelope(populatedWorkspace(), 1_700_000_000_000);
    const unknown = structuredClone(base) as WorkspaceBackupEnvelope & { unexpected?: boolean };
    unknown.unexpected = true;
    expect(() => validateWorkspaceBackupEnvelope(unknown)).toThrow(/未允许的字段/);

    const attachment = structuredClone(base) as WorkspaceBackupEnvelope;
    Object.assign(attachment.workspace.conversations[0].messages[0], { attachments: [] });
    expect(() => validateWorkspaceBackupEnvelope(attachment)).toThrow(/attachments/);

    const localLedger = structuredClone(base) as WorkspaceBackupEnvelope;
    Object.assign(localLedger.workspace, { providerUsageEvents: [] });
    expect(() => validateWorkspaceBackupEnvelope(localLedger)).toThrow(/providerUsageEvents/);

    const unsafeEndpoint = structuredClone(base) as WorkspaceBackupEnvelope;
    unsafeEndpoint.workspace.plugins[1].endpoint = 'https://example.com/rpc?token=secret';
    expect(() => validateWorkspaceBackupEnvelope(unsafeEndpoint)).toThrow(/endpoint/);

    const activitySummary = structuredClone(base) as WorkspaceBackupEnvelope;
    Object.assign(activitySummary.workspace.conversations[0].messages[0], {
      mcpActivity: {
        serverLabel: 'must_not_be_portable',
        providerRequestCount: 1,
        approvals: [],
        calls: [],
      },
    });
    expect(() => validateWorkspaceBackupEnvelope(activitySummary)).toThrow(/mcpActivity/);
  });

  it.each([
    ['missing active revision', (envelope: WorkspaceBackupEnvelope) => {
      envelope.workspace.artifacts![0].activeRevisionId = 'missing-revision';
    }, /activeRevisionId/],
    ['stale artifact conversation', (envelope: WorkspaceBackupEnvelope) => {
      envelope.workspace.artifacts![0].sourceConversationId = 'missing-conversation';
    }, /sourceConversationId/],
    ['stale artifact message', (envelope: WorkspaceBackupEnvelope) => {
      envelope.workspace.artifacts![0].sourceMessageId = 'missing-message';
    }, /sourceMessageId/],
    ['stale knowledge artifact', (envelope: WorkspaceBackupEnvelope) => {
      envelope.workspace.knowledgeSources![0].sourceArtifactId = 'missing-artifact';
    }, /sourceArtifactId/],
    ['stale conversation knowledge reference', (envelope: WorkspaceBackupEnvelope) => {
      envelope.workspace.conversations[0].knowledgeSourceIds = ['missing-knowledge'];
    }, /knowledgeSourceIds/],
    ['conflicting context flags', (envelope: WorkspaceBackupEnvelope) => {
      envelope.workspace.conversations[0].messages[0].excludedFromContext = true;
      envelope.workspace.conversations[0].messages[0].pinnedForContext = true;
    }, /不能同时排除并置顶/],
  ] as const)('rejects %s', (_name, mutate, expected) => {
    const envelope = createWorkspaceBackupEnvelope(populatedWorkspace(), 1_700_000_000_000);
    mutate(envelope);

    expect(() => validateWorkspaceBackupEnvelope(envelope)).toThrow(expected);
  });

  it('rejects oversized artifact and knowledge text plus collection counts above their limits', () => {
    const artifactText = createWorkspaceBackupEnvelope(populatedWorkspace(), 1_700_000_000_000);
    artifactText.workspace.artifacts![0].revisions[0].content = 'x'.repeat(500_001);
    expect(() => validateWorkspaceBackupEnvelope(artifactText)).toThrow(/content/);

    const knowledgeText = createWorkspaceBackupEnvelope(populatedWorkspace(), 1_700_000_000_000);
    knowledgeText.workspace.knowledgeSources![0].content = 'x'.repeat(500_001);
    expect(() => validateWorkspaceBackupEnvelope(knowledgeText)).toThrow(/content/);

    const artifactCount = createWorkspaceBackupEnvelope(createDefaultWorkspace(), 1_700_000_000_000);
    artifactCount.workspace.artifacts = Array.from({ length: 201 }, (_, index) => ({
      id: `artifact-${index}`,
      projectId: artifactCount.workspace.activeProjectId!,
      title: `Artifact ${index}`,
      format: 'plain-text' as const,
      revisions: [{ id: `revision-${index}`, content: 'x', createdAt: index, author: 'user' as const }],
      activeRevisionId: `revision-${index}`,
      createdAt: index,
      updatedAt: index,
    }));
    expect(() => validateWorkspaceBackupEnvelope(artifactCount)).toThrow(/数量超过上限 200/);

    const knowledgeCount = createWorkspaceBackupEnvelope(createDefaultWorkspace(), 1_700_000_000_000);
    knowledgeCount.workspace.knowledgeSources = Array.from({ length: 501 }, (_, index) => ({
      id: `knowledge-${index}`,
      projectId: knowledgeCount.workspace.activeProjectId!,
      title: `Knowledge ${index}`,
      kind: 'text' as const,
      content: 'x',
      createdAt: index,
      updatedAt: index,
    }));
    expect(() => validateWorkspaceBackupEnvelope(knowledgeCount)).toThrow(/数量超过上限 500/);
  });

  it.each([
    ['missing branch point', (envelope: WorkspaceBackupEnvelope) => {
      envelope.workspace.conversations[1].branchPointMessageId = 'missing-message';
    }],
    ['welcome branch point', (envelope: WorkspaceBackupEnvelope) => {
      envelope.workspace.conversations[1].branchPointMessageId = 'welcome';
    }],
    ['parent cycle', (envelope: WorkspaceBackupEnvelope) => {
      const root = envelope.workspace.conversations[0];
      root.parentConversationId = envelope.workspace.conversations[1].id;
      root.branchPointMessageId = 'child-message';
    }],
    ['cross-project parent', (envelope: WorkspaceBackupEnvelope) => {
      envelope.workspace.projects!.push({
        id: 'second-project',
        name: 'Second',
        createdAt: 1,
        updatedAt: 1,
      });
      envelope.workspace.conversations[1].projectId = 'second-project';
    }],
  ])('rejects a branch with %s', (_kind, mutate) => {
    const envelope = envelopeWithValidBranch();
    mutate(envelope);

    expect(() => validateWorkspaceBackupEnvelope(envelope)).toThrow(WorkspaceBackupError);
  });

  it('rejects a project default model target that is not present in the provider catalog', () => {
    const envelope = createWorkspaceBackupEnvelope(createDefaultWorkspace(), 1_700_000_000_000);
    envelope.workspace.projects![0].defaultTarget = {
      providerId: envelope.workspace.providers[0].id,
      modelId: 'missing-model',
    };

    expect(() => validateWorkspaceBackupEnvelope(envelope)).toThrow(/defaultTarget/);
  });

  it.each([
    ['maxOutputTokens', 63],
    ['maxOutputTokens', 131_073],
    ['maxOutputTokens', 64.5],
    ['dailyRequestLimit', -1],
    ['dailyRequestLimit', 10_001],
    ['dailyRequestLimit', 1.5],
    ['dailyCnyBudget', -1],
    ['dailyUsdBudget', 1_000_000_001],
  ] as const)('rejects an out-of-range cost guard %s value', (field, value) => {
    const envelope = createWorkspaceBackupEnvelope(createDefaultWorkspace(), 1_700_000_000_000);
    Object.assign(envelope.workspace.costGuard!, { [field]: value });

    expect(() => validateWorkspaceBackupEnvelope(envelope)).toThrow(new RegExp(field));
  });

  it.each([
    ['non-HTTPS', 'http://www.example.com/source'],
    ['embedded credentials', 'https://user:secret@www.example.com/source'],
    ['localhost', 'https://localhost/source'],
    ['private IPv4', 'https://192.168.1.9/source'],
    ['reserved IPv4', 'https://198.51.100.9/source'],
    ['private IPv6', 'https://[fd00::9]/source'],
    ['reserved IPv6', 'https://[2001:db8::9]/source'],
  ])('rejects a %s citation URL in a plaintext envelope', (_kind, url) => {
    const envelope = createWorkspaceBackupEnvelope(populatedWorkspace(), 1_700_000_000_000);
    envelope.workspace.conversations[0].messages[0].citations = [{ url }];

    expect(() => validateWorkspaceBackupEnvelope(envelope)).toThrow(/citations\[0\]\.url/);
  });

  it('allows normal citation query parameters and fragments', () => {
    const envelope = createWorkspaceBackupEnvelope(populatedWorkspace(), 1_700_000_000_000);
    envelope.workspace.conversations[0].messages[0].citations = [{
      url: 'https://www.example.com/search?q=public%20source#result-1',
    }];

    expect(validateWorkspaceBackupEnvelope(envelope)).toBe(envelope);
  });

  it.each([
    ['HTTP loopback', 'http://127.0.0.1:3000/mcp'],
    ['HTTPS localhost', 'https://localhost/mcp'],
    ['private IPv4', 'https://10.0.0.8/mcp'],
    ['reserved IPv4', 'https://203.0.113.8/mcp'],
    ['private IPv6', 'https://[fc00::8]/mcp'],
    ['embedded credentials', 'https://user:secret@mcp.example.com/mcp'],
    ['query', 'https://mcp.example.com/mcp?token=secret'],
    ['fragment', 'https://mcp.example.com/mcp#tools'],
  ])('rejects a %s MCP endpoint in a plaintext envelope', (_kind, endpoint) => {
    const envelope = createWorkspaceBackupEnvelope(populatedWorkspace(), 1_700_000_000_000);
    envelope.workspace.plugins[1].endpoint = endpoint;

    expect(() => validateWorkspaceBackupEnvelope(envelope)).toThrow(/endpoint/);
  });

  it.each([
    ['duplicate server label', (envelope: WorkspaceBackupEnvelope) => {
      envelope.workspace.plugins[1].serverLabel = envelope.workspace.plugins[0].serverLabel;
    }],
    ['missing provider binding', (envelope: WorkspaceBackupEnvelope) => {
      envelope.workspace.plugins[1].providerId = 'missing-provider';
    }],
    ['too many allowed tools', (envelope: WorkspaceBackupEnvelope) => {
      envelope.workspace.plugins[1].allowedTools = Array.from(
        { length: 65 },
        (_, index) => `tool_${index}`
      );
    }],
    ['invalid allowed tool name', (envelope: WorkspaceBackupEnvelope) => {
      envelope.workspace.plugins[1].allowedTools = ['invalid tool name'];
    }],
    ['oversized description', (envelope: WorkspaceBackupEnvelope) => {
      envelope.workspace.plugins[1].description = 'x'.repeat(2_049);
    }],
  ] as const)('rejects MCP plugin metadata with %s', (_kind, mutate) => {
    const envelope = createWorkspaceBackupEnvelope(populatedWorkspace(), 1_700_000_000_000);
    mutate(envelope);

    expect(() => validateWorkspaceBackupEnvelope(envelope)).toThrow(WorkspaceBackupError);
  });
});
