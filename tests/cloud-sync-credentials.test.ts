import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as SecureStore from 'expo-secure-store';

import {
  CLOUD_SYNC_CREDENTIAL_KEY,
  CloudSyncCredentialError,
  canonicalCloudSyncEndpoint,
  canonicalCloudSyncRemotePath,
  clearCloudSyncCredentials,
  cloudSyncBindingFingerprint,
  readCloudSyncCredentials,
  writeCloudSyncCredentials,
  type CloudSyncCredentialBinding,
  type CloudSyncCredentialStoreAdapter,
} from '../src/services/cloudSyncCredentials';

const mocks = vi.hoisted(() => ({
  platform: { OS: 'web' },
}));

vi.mock('react-native', () => ({ Platform: mocks.platform }));
vi.mock('expo-secure-store', () => ({
  isAvailableAsync: vi.fn(async () => true),
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

function memoryAdapter(values = new Map<string, string>()): CloudSyncCredentialStoreAdapter {
  return {
    platform: 'native',
    async getItem(key) {
      return values.get(key) ?? null;
    },
    async setItem(key, value) {
      values.set(key, value);
    },
    async deleteItem(key) {
      values.delete(key);
    },
  };
}

const webDavBinding: CloudSyncCredentialBinding = {
  provider: 'webdav',
  endpoint: 'https://dav.example.com/root/',
  remotePath: '/Embezzle Studio/device/',
};

describe('cloud sync credential boundary', () => {
  beforeEach(() => {
    mocks.platform.OS = 'web';
    vi.mocked(SecureStore.isAvailableAsync).mockReset();
    vi.mocked(SecureStore.isAvailableAsync).mockResolvedValue(true);
    vi.mocked(SecureStore.deleteItemAsync).mockReset();
    vi.mocked(SecureStore.deleteItemAsync).mockResolvedValue(undefined);
  });

  it('canonicalizes only HTTPS or loopback endpoints and rejects embedded credentials', () => {
    expect(canonicalCloudSyncEndpoint('HTTPS://DAV.Example.COM:443/root/')).toBe(
      'https://dav.example.com/root'
    );
    expect(canonicalCloudSyncEndpoint('http://127.0.0.1:9000/dav')).toBe(
      'http://127.0.0.1:9000/dav'
    );
    expect(() => canonicalCloudSyncEndpoint('http://dav.example.com/root')).toThrow(
      /HTTPS/
    );
    expect(() => canonicalCloudSyncEndpoint('https://user:pass@dav.example.com/root')).toThrow(
      /不得包含账号/
    );
    expect(() => canonicalCloudSyncEndpoint('https://dav.example.com/root?token=secret')).toThrow(
      /查询参数/
    );
  });

  it('normalizes remote paths and blocks traversal', () => {
    expect(canonicalCloudSyncRemotePath('/Embezzle Studio/device/')).toBe(
      'Embezzle Studio/device'
    );
    expect(() => canonicalCloudSyncRemotePath('../escape')).toThrow(/非法路径段/);
    expect(() => canonicalCloudSyncRemotePath('safe/%2e%2e/escape')).toThrow(/非法路径段/);
  });

  it('stores credentials only behind their exact non-secret binding', async () => {
    const values = new Map<string, string>();
    const adapter = memoryAdapter(values);
    const credentials = {
      username: 'alice',
      password: 'app-password',
      encryptionPassword: 'backup-password',
    };
    await writeCloudSyncCredentials(webDavBinding, credentials, adapter);
    expect(await readCloudSyncCredentials(webDavBinding, adapter)).toEqual(credentials);

    const raw = values.get(CLOUD_SYNC_CREDENTIAL_KEY) ?? '';
    expect(raw).toContain('app-password');
    expect(cloudSyncBindingFingerprint(webDavBinding)).not.toContain('app-password');
    expect(
      await readCloudSyncCredentials(
        { ...webDavBinding, endpoint: 'https://other.example.com/root' },
        adapter
      )
    ).toBeUndefined();
    expect(values.has(CLOUD_SYNC_CREDENTIAL_KEY)).toBe(false);
  });

  it('does not Unicode-normalize or trim secret material', async () => {
    const adapter = memoryAdapter();
    const credentials = {
      username: ' alice ',
      password: '  pass\u00a0word  ',
      encryptionPassword: '  sync\u00a0password  ',
    };
    await writeCloudSyncCredentials(webDavBinding, credentials, adapter);
    await expect(readCloudSyncCredentials(webDavBinding, adapter)).resolves.toEqual({
      username: 'alice',
      password: '  pass\u00a0word  ',
      encryptionPassword: '  sync\u00a0password  ',
    });
  });

  it('validates provider-specific credentials and the encryption password', async () => {
    const adapter = memoryAdapter();
    await expect(
      writeCloudSyncCredentials(
        webDavBinding,
        { username: 'alice', password: 'pw', encryptionPassword: 'short' },
        adapter
      )
    ).rejects.toMatchObject({ code: 'invalid-credentials' });

    const s3Binding: CloudSyncCredentialBinding = {
      provider: 's3',
      endpoint: 'https://s3.example.com',
      remotePath: 'Embezzle-Studio',
      bucket: 'user-bucket',
      region: 'auto',
    };
    await expect(
      writeCloudSyncCredentials(
        s3Binding,
        { encryptionPassword: 'long-enough-password' },
        adapter
      )
    ).rejects.toBeInstanceOf(CloudSyncCredentialError);
  });

  it('fails closed when native secure storage is unavailable during credential deletion', async () => {
    mocks.platform.OS = 'android';
    vi.mocked(SecureStore.isAvailableAsync).mockResolvedValueOnce(false);

    await expect(clearCloudSyncCredentials()).rejects.toMatchObject({
      code: 'secure-store-unavailable',
      message: expect.stringContaining('无法确认'),
    });
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it('reports native secure-store deletion failures instead of claiming success', async () => {
    mocks.platform.OS = 'android';
    vi.mocked(SecureStore.deleteItemAsync).mockRejectedValueOnce(new Error('keystore busy'));

    await expect(clearCloudSyncCredentials()).rejects.toMatchObject({
      code: 'secure-store-unavailable',
      message: expect.stringContaining('清除本机安全存储'),
    });
  });
});
