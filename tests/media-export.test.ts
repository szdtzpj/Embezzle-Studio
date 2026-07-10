import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MediaAttachment } from '../src/domain/types';
import {
  AttachmentSaveError,
  sanitizeAttachmentFilename,
  saveAttachmentToDevice,
} from '../src/services/mediaExport';

const mocks = vi.hoisted(() => ({
  platform: { OS: 'android' },
  discardUncommittedAttachments: vi.fn(),
  persistAttachment: vi.fn(),
  resolveAttachmentDisplayUri: vi.fn(),
  sharingAvailable: vi.fn(),
  shareAsync: vi.fn(),
  requestDirectoryPermissionsAsync: vi.fn(),
  getUriForDirectoryInRoot: vi.fn((name: string) => `content://root/${name}`),
  createFileAsync: vi.fn(),
  deleteAsync: vi.fn(),
  sourceExists: true,
  sourceReadBytes: vi.fn(),
  sourceClose: vi.fn(),
  destinationWriteBytes: vi.fn(),
  destinationClose: vi.fn(),
  openedFiles: [] as Array<{ uri: string; mode: string }>,
}));

vi.mock('react-native', () => ({ Platform: mocks.platform }));
vi.mock('../src/services/mediaStorage', () => ({
  discardUncommittedAttachments: mocks.discardUncommittedAttachments,
  persistAttachment: mocks.persistAttachment,
  resolveAttachmentDisplayUri: mocks.resolveAttachmentDisplayUri,
}));
vi.mock('expo-sharing', () => ({
  isAvailableAsync: mocks.sharingAvailable,
  shareAsync: mocks.shareAsync,
}));
vi.mock('expo-file-system/legacy', () => ({
  StorageAccessFramework: {
    requestDirectoryPermissionsAsync: mocks.requestDirectoryPermissionsAsync,
    getUriForDirectoryInRoot: mocks.getUriForDirectoryInRoot,
    createFileAsync: mocks.createFileAsync,
    deleteAsync: mocks.deleteAsync,
  },
}));
vi.mock('expo-file-system', () => ({
  FileMode: { ReadOnly: 'r', WriteOnly: 'w' },
  File: class MockFile {
    readonly uri: string;
    readonly exists: boolean;

    constructor(uri: string) {
      this.uri = uri;
      this.exists = uri.startsWith('file://') ? mocks.sourceExists : true;
    }

    open(mode: string) {
      mocks.openedFiles.push({ uri: this.uri, mode });
      if (mode === 'r') {
        return {
          readBytes: mocks.sourceReadBytes,
          close: mocks.sourceClose,
        };
      }
      return {
        writeBytes: mocks.destinationWriteBytes,
        close: mocks.destinationClose,
      };
    }
  },
}));

const videoAttachment: MediaAttachment = {
  id: 'video-1',
  kind: 'video',
  uri: 'https://media.example.test/generated.mp4',
  name: 'doubao-seedance-2-0.mp4',
};

beforeEach(() => {
  mocks.platform.OS = 'android';
  mocks.discardUncommittedAttachments.mockReset();
  mocks.discardUncommittedAttachments.mockResolvedValue(undefined);
  mocks.persistAttachment.mockReset();
  mocks.resolveAttachmentDisplayUri.mockReset();
  mocks.sharingAvailable.mockReset();
  mocks.shareAsync.mockReset();
  mocks.requestDirectoryPermissionsAsync.mockReset();
  mocks.getUriForDirectoryInRoot.mockClear();
  mocks.createFileAsync.mockReset();
  mocks.deleteAsync.mockReset();
  mocks.sourceExists = true;
  mocks.sourceReadBytes.mockReset();
  mocks.sourceClose.mockReset();
  mocks.destinationWriteBytes.mockReset();
  mocks.destinationClose.mockReset();
  mocks.openedFiles.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('attachment export filenames', () => {
  it('removes path, control, and bidirectional characters while preserving an extension', () => {
    const safe = sanitizeAttachmentFilename('  ..\\NUL:<demo>?\u202E.mp4  ', 'video');

    expect(safe).not.toMatch(/[\\/:*?"<>|\u202A-\u202E]/);
    expect(safe).toMatch(/\.mp4$/);
    expect(safe).not.toBe('');
  });

  it('uses a kind-specific fallback and caps Unicode length without dropping the extension', () => {
    expect(sanitizeAttachmentFilename('', 'image')).toBe('image.jpg');

    const long = sanitizeAttachmentFilename(`${'😀'.repeat(140)}.webp`, 'image');
    expect(Array.from(long)).toHaveLength(120);
    expect(long.endsWith('.webp')).toBe(true);
  });

  it('prefixes reserved device names', () => {
    expect(sanitizeAttachmentFilename('NUL.mp4', 'video')).toBe('_NUL.mp4');
  });
});

describe('saveAttachmentToDevice', () => {
  it('downloads a remote Android attachment privately, then streams it into a user-selected SAF file', async () => {
    const localAttachment = {
      ...videoAttachment,
      uri: 'file:///documents/embezzle-attachments/generated-video.mp4',
      size: 3,
    };
    mocks.persistAttachment.mockResolvedValue(localAttachment);
    mocks.requestDirectoryPermissionsAsync.mockResolvedValue({
      granted: true,
      directoryUri: 'content://downloads',
    });
    mocks.createFileAsync.mockResolvedValue('content://downloads/result.mp4');
    mocks.sourceReadBytes
      .mockReturnValueOnce(new Uint8Array([1, 2, 3]))
      .mockReturnValueOnce(new Uint8Array());

    await expect(saveAttachmentToDevice(videoAttachment)).resolves.toEqual({
      status: 'saved',
      method: 'android-saf',
      name: videoAttachment.name,
      uri: 'content://downloads/result.mp4',
    });

    expect(mocks.persistAttachment).toHaveBeenCalledWith(videoAttachment, { downloadRemote: true });
    expect(mocks.requestDirectoryPermissionsAsync).toHaveBeenCalledWith('content://root/Download');
    expect(mocks.createFileAsync).toHaveBeenCalledWith(
      'content://downloads',
      'doubao-seedance-2-0',
      'video/mp4'
    );
    expect(mocks.openedFiles).toEqual([
      { uri: localAttachment.uri, mode: 'r' },
      { uri: 'content://downloads/result.mp4', mode: 'w' },
    ]);
    expect(mocks.destinationWriteBytes).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
    expect(mocks.sourceClose).toHaveBeenCalledOnce();
    expect(mocks.destinationClose).toHaveBeenCalledOnce();
    expect(mocks.discardUncommittedAttachments).toHaveBeenCalledWith([localAttachment]);
  });

  it('returns cancellation without creating a file when the Android directory picker is dismissed', async () => {
    mocks.requestDirectoryPermissionsAsync.mockResolvedValue({ granted: false });

    await expect(saveAttachmentToDevice({
      ...videoAttachment,
      uri: 'file:///documents/generated.mp4',
    })).resolves.toEqual({
      status: 'cancelled',
      method: 'android-saf',
      name: videoAttachment.name,
    });

    expect(mocks.createFileAsync).not.toHaveBeenCalled();
    expect(mocks.persistAttachment).not.toHaveBeenCalled();
    expect(mocks.discardUncommittedAttachments).not.toHaveBeenCalled();
  });

  it('deletes an incomplete SAF document and throws a typed error when copying fails', async () => {
    mocks.requestDirectoryPermissionsAsync.mockResolvedValue({
      granted: true,
      directoryUri: 'content://downloads',
    });
    mocks.createFileAsync.mockResolvedValue('content://downloads/broken.mp4');
    mocks.sourceReadBytes.mockReturnValueOnce(new Uint8Array([1]));
    mocks.destinationWriteBytes.mockImplementation(() => {
      throw new Error('disk full');
    });

    const promise = saveAttachmentToDevice({
      ...videoAttachment,
      uri: 'file:///documents/generated.mp4',
    });

    await expect(promise).rejects.toEqual(expect.objectContaining<Partial<AttachmentSaveError>>({
      name: 'AttachmentSaveError',
      code: 'android-save-failed',
    }));
    expect(mocks.deleteAsync).toHaveBeenCalledWith('content://downloads/broken.mp4', {
      idempotent: true,
    });
    expect(mocks.sourceClose).toHaveBeenCalledOnce();
    expect(mocks.destinationClose).toHaveBeenCalledOnce();
  });

  it('creates a browser download from the resolved durable Blob URL and revokes it later', async () => {
    vi.useFakeTimers();
    mocks.platform.OS = 'web';
    const stored = { ...videoAttachment, uri: 'embezzle-web-attachment://video-1' };
    mocks.persistAttachment.mockResolvedValue(stored);
    mocks.resolveAttachmentDisplayUri.mockResolvedValue('blob:generated-video');
    const link = {
      href: '',
      download: '',
      rel: '',
      style: { display: '' },
      click: vi.fn(),
      remove: vi.fn(),
    };
    const appendChild = vi.fn();
    const createElement = vi.fn(() => link);
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('document', { body: { appendChild }, createElement });
    vi.stubGlobal('URL', { revokeObjectURL });

    await expect(saveAttachmentToDevice(videoAttachment)).resolves.toEqual({
      status: 'saved',
      method: 'web-download',
      name: videoAttachment.name,
    });

    expect(mocks.persistAttachment).toHaveBeenCalledWith(videoAttachment, { downloadRemote: true });
    expect(mocks.resolveAttachmentDisplayUri).toHaveBeenCalledWith(stored);
    expect(link).toMatchObject({
      href: 'blob:generated-video',
      download: videoAttachment.name,
      rel: 'noopener',
    });
    expect(appendChild).toHaveBeenCalledWith(link);
    expect(link.click).toHaveBeenCalledOnce();
    expect(link.remove).toHaveBeenCalledOnce();
    expect(mocks.discardUncommittedAttachments).toHaveBeenCalledWith([stored]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:generated-video');
  });

  it('uses the native share sheet outside Android after making a remote attachment durable', async () => {
    mocks.platform.OS = 'ios';
    const stored = { ...videoAttachment, uri: 'file:///documents/generated.mp4' };
    mocks.persistAttachment.mockResolvedValue(stored);
    mocks.sharingAvailable.mockResolvedValue(true);
    mocks.shareAsync.mockResolvedValue(undefined);

    await expect(saveAttachmentToDevice(videoAttachment)).resolves.toEqual({
      status: 'shared',
      method: 'native-share',
      name: videoAttachment.name,
      uri: stored.uri,
    });
    expect(mocks.shareAsync).toHaveBeenCalledWith(stored.uri, {
      dialogTitle: `导出 ${videoAttachment.name}`,
      mimeType: 'video/mp4',
    });
    expect(mocks.discardUncommittedAttachments).toHaveBeenCalledWith([stored]);
  });
});
