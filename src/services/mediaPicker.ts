import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';

import type { AttachmentKind, MediaAttachment } from '../domain/types';
import { createId } from './id';

function kindFromMimeType(mimeType?: string): AttachmentKind {
  if (mimeType?.startsWith('image/')) {
    return 'image';
  }

  if (mimeType?.startsWith('video/')) {
    return 'video';
  }

  return 'file';
}

export async function pickImages(): Promise<MediaAttachment[]> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    throw new Error('需要相册权限才能选择图片。');
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    base64: true,
    quality: 0.82,
  });

  if (result.canceled) {
    return [];
  }

  return result.assets.map((asset) => ({
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

  return result.assets.map((asset) => ({
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

  return result.assets.map((asset) => ({
    id: createId('file'),
    kind: kindFromMimeType(asset.mimeType),
    uri: asset.uri,
    name: asset.name,
    mimeType: asset.mimeType,
    size: asset.size,
  }));
}
