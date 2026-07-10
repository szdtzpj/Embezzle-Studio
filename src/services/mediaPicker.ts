import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';

import type { AttachmentKind, MediaAttachment } from '../domain/types';
import { createId } from './id';
import { discardUncommittedAttachments, persistAttachment } from './mediaStorage';

export const maxAttachmentCount = 6;
const maxImageBytes = 10 * 1024 * 1024;
const maxVideoBytes = 100 * 1024 * 1024;
const maxFileBytes = 20 * 1024 * 1024;
const maxTotalBytes = 120 * 1024 * 1024;
const maxImagePixels = 32_000_000;

function estimatedAttachmentBytes(attachment: MediaAttachment): number {
  if (typeof attachment.size === 'number' && Number.isFinite(attachment.size)) {
    return attachment.size;
  }
  if (attachment.base64) {
    return Math.ceil(attachment.base64.length * 0.75);
  }
  return 0;
}

export function validateAttachments(attachments: MediaAttachment[]): void {
  if (attachments.length > maxAttachmentCount) {
    throw new Error(`一次最多添加 ${maxAttachmentCount} 个附件。`);
  }

  let totalBytes = 0;
  for (const attachment of attachments) {
    const bytes = estimatedAttachmentBytes(attachment);
    totalBytes += bytes;
    const limit = attachment.kind === 'image' ? maxImageBytes : attachment.kind === 'video' ? maxVideoBytes : maxFileBytes;
    if (bytes > limit) {
      throw new Error(`附件「${attachment.name}」过大（${attachment.kind === 'video' ? '100' : attachment.kind === 'image' ? '10' : '20'} MB 上限）。`);
    }
    if (
      attachment.kind === 'image' &&
      attachment.width &&
      attachment.height &&
      attachment.width * attachment.height > maxImagePixels
    ) {
      throw new Error(`图片「${attachment.name}」分辨率过高，请压缩后重试。`);
    }
  }

  if (totalBytes > maxTotalBytes) {
    throw new Error('附件总大小超过 120 MB，请减少附件后重试。');
  }
}

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
