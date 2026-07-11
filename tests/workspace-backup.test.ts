import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { describe, expect, it, vi } from 'vitest';

import { createDefaultWorkspace } from '../src/data/providerCatalog';
import type { AppWorkspace, ChatConversation, ChatMessage, PluginManifest, ProviderProfile } from '../src/domain/types';
import {
  MAX_BACKUP_PASSWORD_LENGTH,
  MAX_ENCRYPTED_BACKUP_BYTES,
  WORKSPACE_BACKUP_SCRYPT_PARAMS,
  WorkspaceBackupError,
  createWorkspaceBackupEnvelope,
  exportEncryptedWorkspaceBackup,
  importEncryptedWorkspaceBackup,
  sanitizeWorkspaceForBackup,
  validateWorkspaceBackupEnvelope,
  type WorkspaceBackupEnvelope,
} from '../src/services/workspaceBackup';

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
    version: '1.0.0',
    type: 'remote-mcp',
    permissions: ['network', 'tools'],
    transport: 'streamable-http',
    endpoint: 'https://mcp.example.com/rpc',
    enabled: true,
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
  const activeConversation = workspace.conversations[0];
  return {
    ...workspace,
    providers: [primary, added, ...workspace.providers.slice(2)],
    messages: [message],
    conversations: [{ ...activeConversation, updatedAt: 200, messages: [message] }],
    plugins: [
      plugin({
        endpoint: 'https://mcp.example.com/rpc?token=PLUGIN-QUERY-SECRET',
        authorization: 'BACKUP-PLUGIN-AUTHORIZATION',
      }),
      plugin({
        id: 'plugin-new',
        name: 'New MCP',
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
        endpoint: 'https://new-mcp.example.com/rpc',
        authorization: 'CURRENT-DEVICE-MATCHING-PLUGIN-AUTH',
      }),
    ],
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

describe('workspace backup sanitization', () => {
  it('removes every structured secret and all attachment data while retaining text and task metadata', () => {
    const safe = sanitizeWorkspaceForBackup(populatedWorkspace());
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

    const message = safe.conversations[0].messages[0];
    expect(message.content).toBe('视频生成任务已提交');
    expect(message.generationTask).toMatchObject({ taskId: 'cgt-task-123', status: 'running' });
    expect(safe.plugins[0].endpoint).toBeUndefined();
    expect(safe.plugins[1].endpoint).toBe('https://new-mcp.example.com/rpc');
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
      expect(imported.messages[0]).not.toHaveProperty('attachments');
      expect(imported.messages[0].generationTask).toMatchObject({ taskId: 'cgt-task-123' });
      expect(imported.promptTemplates[0].content).toBe('请翻译 {{text}}');
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
  }, 20_000);
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

  it('rejects unknown fields, attachment fields, and unsafe plugin endpoints in plaintext envelopes', () => {
    const base = createWorkspaceBackupEnvelope(populatedWorkspace(), 1_700_000_000_000);
    const unknown = structuredClone(base) as WorkspaceBackupEnvelope & { unexpected?: boolean };
    unknown.unexpected = true;
    expect(() => validateWorkspaceBackupEnvelope(unknown)).toThrow(/未允许的字段/);

    const attachment = structuredClone(base) as WorkspaceBackupEnvelope;
    Object.assign(attachment.workspace.conversations[0].messages[0], { attachments: [] });
    expect(() => validateWorkspaceBackupEnvelope(attachment)).toThrow(/attachments/);

    const unsafeEndpoint = structuredClone(base) as WorkspaceBackupEnvelope;
    unsafeEndpoint.workspace.plugins[1].endpoint = 'https://example.com/rpc?token=secret';
    expect(() => validateWorkspaceBackupEnvelope(unsafeEndpoint)).toThrow(/endpoint/);
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
});
