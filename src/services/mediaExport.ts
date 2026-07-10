import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

import type { AttachmentKind, MediaAttachment } from '../domain/types';
import {
  discardUncommittedAttachments,
  persistAttachment,
  resolveAttachmentDisplayUri,
} from './mediaStorage';

const androidCopyChunkBytes = 4 * 1024 * 1024;
const maxFilenameCharacters = 120;

export type AttachmentSaveMethod = 'android-saf' | 'web-download' | 'native-share';

export type AttachmentSaveResult =
  | {
      status: 'saved';
      method: 'android-saf' | 'web-download';
      name: string;
      uri?: string;
    }
  | {
      status: 'shared';
      method: 'native-share';
      name: string;
      uri: string;
    }
  | {
      status: 'cancelled';
      method: 'android-saf';
      name: string;
    };

export type AttachmentSaveErrorCode =
  | 'prepare-failed'
  | 'android-save-failed'
  | 'web-download-unavailable'
  | 'sharing-unavailable'
  | 'native-share-failed';

export class AttachmentSaveError extends Error {
  readonly code: AttachmentSaveErrorCode;
  readonly cause?: unknown;

  constructor(code: AttachmentSaveErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'AttachmentSaveError';
    this.code = code;
    this.cause = cause;
  }
}

const mimeTypeByExtension: Record<string, string> = {
  gif: 'image/gif',
  heic: 'image/heic',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  pdf: 'application/pdf',
  png: 'image/png',
  txt: 'text/plain',
  webm: 'video/webm',
  webp: 'image/webp',
  zip: 'application/zip',
};

function defaultFilename(kind: AttachmentKind): string {
  if (kind === 'image') return 'image.jpg';
  if (kind === 'video') return 'video.mp4';
  return 'attachment.bin';
}

function splitFilename(filename: string): { stem: string; extension: string } {
  const separator = filename.lastIndexOf('.');
  if (separator <= 0 || separator === filename.length - 1) {
    return { stem: filename, extension: '' };
  }

  const extension = filename.slice(separator);
  if (Array.from(extension).length > 12) {
    return { stem: filename, extension: '' };
  }
  return { stem: filename.slice(0, separator), extension };
}

function truncateFilename(filename: string): string {
  const characters = Array.from(filename);
  if (characters.length <= maxFilenameCharacters) {
    return filename;
  }

  const { stem, extension } = splitFilename(filename);
  const extensionCharacters = Array.from(extension);
  const stemLimit = Math.max(1, maxFilenameCharacters - extensionCharacters.length);
  return `${Array.from(stem).slice(0, stemLimit).join('')}${extension}`;
}

/** Produces a conservative cross-platform display name for SAF and browser downloads. */
export function sanitizeAttachmentFilename(name: string, kind: AttachmentKind = 'file'): string {
  const fallback = defaultFilename(kind);
  const normalized = (name || fallback)
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  const candidate = normalized || fallback;
  const { stem } = splitFilename(candidate);
  const windowsReservedName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem);
  return truncateFilename(`${windowsReservedName ? '_' : ''}${candidate}`);
}

function filenameStem(filename: string): string {
  const { stem } = splitFilename(filename);
  return stem || 'attachment';
}

function attachmentMimeType(attachment: MediaAttachment, filename: string): string {
  const declared = attachment.mimeType?.trim().toLowerCase();
  if (declared && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(declared)) {
    return declared;
  }

  const extension = splitFilename(filename).extension.slice(1).toLowerCase();
  if (extension && mimeTypeByExtension[extension]) {
    return mimeTypeByExtension[extension];
  }
  if (attachment.kind === 'image') return 'image/jpeg';
  if (attachment.kind === 'video') return 'video/mp4';
  return 'application/octet-stream';
}

function isRemoteUri(uri: string): boolean {
  return /^https?:\/\//i.test(uri);
}

type PreparedAttachment = {
  attachment: MediaAttachment;
  transient: boolean;
};

async function prepareAttachmentForSave(attachment: MediaAttachment): Promise<PreparedAttachment> {
  const mustPersist =
    Platform.OS === 'web'
      ? isRemoteUri(attachment.uri) ||
        attachment.uri.startsWith('data:') ||
        Boolean(attachment.base64)
      : !/^file:\/\//i.test(attachment.uri);

  if (!mustPersist) {
    return { attachment, transient: false };
  }

  try {
    const persisted = await persistAttachment(attachment, { downloadRemote: true });
    if (Platform.OS !== 'web' && !/^file:\/\//i.test(persisted.uri)) {
      throw new Error('附件没有可供导出的本地文件。');
    }
    return {
      attachment: persisted,
      transient: persisted.uri !== attachment.uri,
    };
  } catch (error) {
    throw new AttachmentSaveError(
      'prepare-failed',
      `无法准备附件“${attachment.name}”，请检查网络或本机存储空间后重试。`,
      error
    );
  }
}

async function cleanupPreparedAttachment(prepared: PreparedAttachment): Promise<void> {
  if (!prepared.transient) {
    return;
  }
  await discardUncommittedAttachments([prepared.attachment]);
}

async function copyFileToSaf(sourceUri: string, destinationUri: string): Promise<void> {
  const { File, FileMode } = await import('expo-file-system');
  const source = new File(sourceUri);
  if (!source.exists) {
    throw new Error('附件的本地文件已丢失。');
  }

  const destination = new File(destinationUri);
  const reader = source.open(FileMode.ReadOnly);
  let writer: ReturnType<typeof destination.open> | undefined;

  try {
    writer = destination.open(FileMode.WriteOnly);
    while (true) {
      const bytes = reader.readBytes(androidCopyChunkBytes);
      if (bytes.length === 0) break;
      writer.writeBytes(bytes);
      // Keep long video copies from monopolizing the JavaScript event loop.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    try {
      reader.close();
    } finally {
      writer?.close();
    }
  }
}

async function saveOnAndroid(
  attachment: MediaAttachment,
  filename: string,
  mimeType: string
): Promise<AttachmentSaveResult> {
  const { StorageAccessFramework } = await import('expo-file-system/legacy');
  let destinationUri: string | undefined;
  let prepared: PreparedAttachment | undefined;

  try {
    const permission = await StorageAccessFramework.requestDirectoryPermissionsAsync(
      StorageAccessFramework.getUriForDirectoryInRoot('Download')
    );
    if (!permission.granted) {
      return { status: 'cancelled', method: 'android-saf', name: filename };
    }

    destinationUri = await StorageAccessFramework.createFileAsync(
      permission.directoryUri,
      filenameStem(filename),
      mimeType
    );
    prepared = await prepareAttachmentForSave(attachment);
    await copyFileToSaf(prepared.attachment.uri, destinationUri);
    return {
      status: 'saved',
      method: 'android-saf',
      name: filename,
      uri: destinationUri,
    };
  } catch (error) {
    if (destinationUri) {
      try {
        await StorageAccessFramework.deleteAsync(destinationUri, { idempotent: true });
      } catch {
        // Preserve the original copy error; a zero-byte document may remain.
      }
    }
    if (error instanceof AttachmentSaveError) {
      throw error;
    }
    throw new AttachmentSaveError('android-save-failed', `无法将“${filename}”保存到所选目录。`, error);
  } finally {
    if (prepared) {
      await cleanupPreparedAttachment(prepared);
    }
  }
}

async function saveOnWeb(
  attachment: MediaAttachment,
  filename: string
): Promise<AttachmentSaveResult> {
  if (typeof document === 'undefined' || !document.body) {
    throw new AttachmentSaveError('web-download-unavailable', '当前浏览器无法创建下载任务。');
  }

  let displayUri: string;
  try {
    displayUri = await resolveAttachmentDisplayUri(attachment);
  } catch (error) {
    throw new AttachmentSaveError(
      'prepare-failed',
      `无法读取附件“${filename}”的浏览器存储。`,
      error
    );
  }

  const link = document.createElement('a');
  try {
    link.href = displayUri;
    link.download = filename;
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
  } catch (error) {
    throw new AttachmentSaveError(
      'web-download-unavailable',
      `浏览器无法下载“${filename}”。`,
      error
    );
  } finally {
    link.remove();
    if (displayUri.startsWith('blob:')) {
      setTimeout(() => URL.revokeObjectURL(displayUri), 1000);
    }
  }

  return { status: 'saved', method: 'web-download', name: filename };
}

async function shareOnNative(
  attachment: MediaAttachment,
  filename: string,
  mimeType: string
): Promise<AttachmentSaveResult> {
  let sharingAvailable: boolean;
  try {
    sharingAvailable = await Sharing.isAvailableAsync();
  } catch (error) {
    throw new AttachmentSaveError(
      'sharing-unavailable',
      '无法检查当前设备的文件导出能力。',
      error
    );
  }
  if (!sharingAvailable) {
    throw new AttachmentSaveError('sharing-unavailable', '当前设备没有可用的文件导出应用。');
  }

  try {
    await Sharing.shareAsync(attachment.uri, {
      dialogTitle: `导出 ${filename}`,
      mimeType,
    });
    return {
      status: 'shared',
      method: 'native-share',
      name: filename,
      uri: attachment.uri,
    };
  } catch (error) {
    throw new AttachmentSaveError('native-share-failed', `无法导出“${filename}”。`, error);
  }
}

/** Saves an attachment without requesting broad media-library permissions. */
export async function saveAttachmentToDevice(
  attachment: MediaAttachment
): Promise<AttachmentSaveResult> {
  const filename = sanitizeAttachmentFilename(attachment.name, attachment.kind);
  const mimeType = attachmentMimeType(attachment, filename);

  if (Platform.OS === 'android') {
    return saveOnAndroid(attachment, filename, mimeType);
  }
  const prepared = await prepareAttachmentForSave(attachment);
  try {
    if (Platform.OS === 'web') {
      return await saveOnWeb(prepared.attachment, filename);
    }
    return await shareOnNative(prepared.attachment, filename, mimeType);
  } finally {
    await cleanupPreparedAttachment(prepared);
  }
}
