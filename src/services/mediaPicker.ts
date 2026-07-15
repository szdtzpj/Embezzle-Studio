import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';

import type { AttachmentKind, MediaAttachment } from '../domain/types';
import { MAX_ATTACHMENT_COUNT, validateAttachments } from './attachmentLimits';
import { createId } from './id';
import { discardUncommittedAttachments, persistAttachment } from './mediaStorage';

export const maxAttachmentCount = MAX_ATTACHMENT_COUNT;
export { validateAttachments };

function kindFromMimeType(mimeType?: string): AttachmentKind {
  if (mimeType?.startsWith('image/')) {
    return 'image';
  }

  if (mimeType?.startsWith('video/')) {
    return 'video';
  }

  return 'file';
}

async function persistValidatedAttachments(
  attachments: MediaAttachment[]
): Promise<MediaAttachment[]> {
  validateAttachments(attachments);
  const persisted: MediaAttachment[] = [];
  try {
    for (const attachment of attachments) {
      persisted.push(await persistAttachment(attachment));
    }
    validateAttachments(persisted);
    return persisted;
  } catch (error) {
    await discardUncommittedAttachments(persisted);
    throw error;
  }
}

export async function pickImages(): Promise<MediaAttachment[]> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    throw new Error('需要相册权限才能选择图片。');
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    // Native can copy the picker URI into app-owned storage directly. Asking
    // the picker for Base64 duplicates the full image in the JS heap and can
    // create a large memory spike for modern high-resolution photos.
    base64: Platform.OS === 'web',
    quality: 0.82,
  });

  if (result.canceled) {
    return [];
  }

  const attachments: MediaAttachment[] = result.assets.map((asset) => ({
      id: createId('image'),
      kind: 'image',
      uri: asset.uri,
      name: asset.fileName ?? 'image.jpg',
      mimeType: asset.mimeType ?? 'image/jpeg',
      size: asset.fileSize,
      width: asset.width,
      height: asset.height,
      base64: asset.base64,
    }));
  return persistValidatedAttachments(attachments);
}

export async function pickVideos(): Promise<MediaAttachment[]> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    throw new Error('需要相册权限才能选择视频。');
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['videos'],
    allowsMultipleSelection: true,
    quality: 1,
  });

  if (result.canceled) {
    return [];
  }

  const attachments: MediaAttachment[] = result.assets.map((asset) => ({
      id: createId('video'),
      kind: 'video',
      uri: asset.uri,
      name: asset.fileName ?? 'video.mp4',
      mimeType: asset.mimeType ?? 'video/mp4',
      size: asset.fileSize,
      width: asset.width,
      height: asset.height,
      durationMs: asset.duration,
    }));
  return persistValidatedAttachments(attachments);
}

export async function pickFiles(): Promise<MediaAttachment[]> {
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    multiple: true,
    copyToCacheDirectory: true,
    base64: false,
  });

  if (result.canceled) {
    return [];
  }

  const attachments: MediaAttachment[] = result.assets.map((asset) => ({
      id: createId('file'),
      kind: kindFromMimeType(asset.mimeType),
      uri: asset.uri,
      name: asset.name,
      mimeType: asset.mimeType,
      size: asset.size,
    }));
  return persistValidatedAttachments(attachments);
}
