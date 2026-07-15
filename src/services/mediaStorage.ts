import { Platform } from 'react-native';

import type { MediaAttachment } from '../domain/types';

const attachmentDirectoryName = 'embezzle-attachments';
const webAttachmentDatabaseName = 'embezzle-studio-attachments';
const webAttachmentStoreName = 'attachments';
const webAttachmentUriPrefix = 'embezzle-web-attachment://';
const pendingAttachmentDeletions = new Map<string, MediaAttachment>();
const maxDownloadedImageBytes = 40 * 1024 * 1024;
const maxDownloadedVideoBytes = 500 * 1024 * 1024;

export interface MediaStorageDiagnostics {
  fileCount: number;
  totalBytes: number;
  orphanCount: number;
  orphanBytes: number;
  missingReferencedCount: number;
}

export interface MediaStorageCleanupResult extends MediaStorageDiagnostics {
  deletedCount: number;
  deletedBytes: number;
}

function sanitizedFileStem(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'attachment';
}

function extensionFor(attachment: MediaAttachment): string {
  const nameExtension = attachment.name.match(/(\.[A-Za-z0-9]{1,10})$/)?.[1];
  if (nameExtension) {
    return nameExtension.toLowerCase();
  }

  const mimeExtensions: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'application/pdf': '.pdf',
  };
  return mimeExtensions[attachment.mimeType ?? ''] ?? '';
}

function dataUriBase64(value: string): string | undefined {
  const match = value.match(/^data:[^;,]+;base64,([A-Za-z0-9+/=\s]+)$/i);
  return match?.[1]?.replace(/\s+/g, '');
}

function isRemoteUri(uri: string): boolean {
  return /^https?:\/\//i.test(uri);
}

function maxRemoteDownloadBytes(attachment: MediaAttachment): number {
  return attachment.kind === 'video' ? maxDownloadedVideoBytes : maxDownloadedImageBytes;
}

function assertRemoteDownloadMetadata(response: Response, attachment: MediaAttachment): void {
  const declaredBytes = Number(response.headers.get('content-length'));
  const limit = maxRemoteDownloadBytes(attachment);
  if (Number.isFinite(declaredBytes) && declaredBytes > limit) {
    throw new Error(`远程附件「${attachment.name}」超过 ${Math.round(limit / 1024 / 1024)} MB 下载上限。`);
  }
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType && attachment.kind !== 'file' && !contentType.startsWith(`${attachment.kind}/`)) {
    throw new Error(`远程附件「${attachment.name}」返回了不匹配的 Content-Type：${contentType}`);
  }
}

function isWebAttachmentUri(uri: string): boolean {
  return uri.startsWith(webAttachmentUriPrefix);
}

function webAttachmentKey(uri: string): string {
  return decodeURIComponent(uri.slice(webAttachmentUriPrefix.length));
}

function webAttachmentUri(id: string): string {
  return `${webAttachmentUriPrefix}${encodeURIComponent(id)}`;
}

function openWebAttachmentDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('当前浏览器不支持 IndexedDB，无法安全保存附件。'));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(webAttachmentDatabaseName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(webAttachmentStoreName)) {
        request.result.createObjectStore(webAttachmentStoreName);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('打开附件数据库失败。'));
    request.onblocked = () => reject(new Error('附件数据库升级被其他页面阻塞，请关闭其他页面后重试。'));
  });
}

async function withWebAttachmentStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const database = await openWebAttachmentDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(webAttachmentStoreName, mode);
      const request = operation(transaction.objectStore(webAttachmentStoreName));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('附件数据库操作失败。'));
      transaction.onabort = () => reject(transaction.error ?? new Error('附件数据库事务已中止。'));
    });
  } finally {
    database.close();
  }
}

async function writeWebAttachment(id: string, blob: Blob): Promise<void> {
  await withWebAttachmentStore('readwrite', (store) => store.put(blob, id));
}

async function readWebAttachment(id: string): Promise<Blob | undefined> {
  return withWebAttachmentStore<Blob | undefined>('readonly', (store) => store.get(id));
}

async function deleteWebAttachment(id: string): Promise<void> {
  await withWebAttachmentStore('readwrite', (store) => store.delete(id));
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const encoded = dataUriBase64(result);
      if (!encoded) {
        reject(new Error('浏览器无法读取附件数据。'));
        return;
      }
      resolve(encoded);
    };
    reader.onerror = () => reject(reader.error ?? new Error('浏览器无法读取附件数据。'));
    reader.readAsDataURL(blob);
  });
}

async function webAttachmentBlob(
  attachment: MediaAttachment,
  downloadRemote: boolean
): Promise<Blob | undefined> {
  if (isRemoteUri(attachment.uri) && !downloadRemote) {
    return undefined;
  }
  const inline = attachment.base64?.trim();
  const source = inline
    ? inline.startsWith('data:')
      ? inline
      : `data:${attachment.mimeType ?? 'application/octet-stream'};base64,${inline}`
    : attachment.uri;
  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`附件“${attachment.name}”读取失败：HTTP ${response.status}`);
  }
  if (isRemoteUri(source)) {
    assertRemoteDownloadMetadata(response, attachment);
  }
  const blob = await response.blob();
  if (blob.size > maxRemoteDownloadBytes(attachment)) {
    throw new Error(`远程附件「${attachment.name}」超过安全下载上限。`);
  }
  return blob;
}

/** Copies an attachment into app-owned durable storage on native platforms. */
export async function persistAttachment(
  attachment: MediaAttachment,
  options: { downloadRemote?: boolean } = {}
): Promise<MediaAttachment> {
  if (Platform.OS === 'web') {
    if (isWebAttachmentUri(attachment.uri)) {
      return { ...attachment, base64: null };
    }
    const blob = await webAttachmentBlob(attachment, options.downloadRemote === true);
    if (!blob) {
      return { ...attachment, base64: null };
    }
    await writeWebAttachment(attachment.id, blob);
    return {
      ...attachment,
      uri: webAttachmentUri(attachment.id),
      size: blob.size,
      mimeType: attachment.mimeType ?? blob.type ?? undefined,
      base64: null,
    };
  }

  const { Directory, EncodingType, File, Paths } = await import('expo-file-system');
  const directory = new Directory(Paths.document, attachmentDirectoryName);
  directory.create({ intermediates: true, idempotent: true });
  const destination = new File(
    directory,
    `${sanitizedFileStem(attachment.id)}${extensionFor(attachment)}`
  );
  const inlineBase64 = attachment.base64?.startsWith('data:')
    ? dataUriBase64(attachment.base64)
    : attachment.base64?.replace(/\s+/g, '');
  const uriBase64 = dataUriBase64(attachment.uri);
  const encoded = inlineBase64 || uriBase64;

  if (encoded) {
    destination.create({ intermediates: true, overwrite: true });
    destination.write(encoded, { encoding: EncodingType.Base64 });
  } else if (isRemoteUri(attachment.uri)) {
    if (!options.downloadRemote) {
      return { ...attachment, base64: null };
    }
    await File.downloadFileAsync(attachment.uri, destination, { idempotent: true });
    if ((destination.size ?? 0) > maxRemoteDownloadBytes(attachment)) {
      destination.delete();
      throw new Error(`远程附件「${attachment.name}」超过安全下载上限。`);
    }
  } else {
    const source = new File(attachment.uri);
    if (!source.exists) {
      throw new Error(`附件「${attachment.name}」已不可访问，请重新选择。`);
    }
    await source.copy(destination, { overwrite: true });
  }

  const destinationSize = destination.size;
  return {
    ...attachment,
    uri: destination.uri,
    // The bytes written to app-owned storage are authoritative. Upstream
    // picker/ContentProvider metadata can be stale or deliberately understated.
    size: typeof destinationSize === 'number' ? destinationSize : attachment.size,
    base64: null,
  };
}

/** Reads a durable local attachment only when a request actually needs it. */
export async function materializeAttachment(
  attachment: MediaAttachment,
  options: { maxSourceBytes?: number } = {}
): Promise<MediaAttachment> {
  if (attachment.base64 || attachment.uri.startsWith('data:') || isRemoteUri(attachment.uri)) {
    return attachment;
  }
  if (Platform.OS === 'web') {
    if (!isWebAttachmentUri(attachment.uri)) {
      throw new Error(`附件「${attachment.name}」缺少可发送的数据，请重新选择。`);
    }
    const blob = await readWebAttachment(webAttachmentKey(attachment.uri));
    if (!blob) {
      throw new Error(`附件「${attachment.name}」的浏览器存储已丢失，请重新选择。`);
    }
    if (options.maxSourceBytes !== undefined && blob.size > options.maxSourceBytes) {
      throw new Error(`附件「${attachment.name}」过大，无法作为 Base64 Data URL 安全发送。`);
    }
    return {
      ...attachment,
      size: attachment.size ?? blob.size,
      mimeType: attachment.mimeType ?? blob.type ?? undefined,
      base64: await blobToBase64(blob),
    };
  }

  const { File } = await import('expo-file-system');
  const file = new File(attachment.uri);
  if (!file.exists) {
    throw new Error(`附件「${attachment.name}」的本地文件已丢失，请重新选择。`);
  }
  // The on-disk size is authoritative; persisted picker metadata can be
  // missing or stale after a restore.
  const sourceBytes = file.size ?? attachment.size ?? undefined;
  if (
    options.maxSourceBytes !== undefined &&
    sourceBytes !== undefined &&
    sourceBytes > options.maxSourceBytes
  ) {
    throw new Error(`附件「${attachment.name}」过大，无法作为 Base64 Data URL 安全发送。`);
  }
  return {
    ...attachment,
    size: sourceBytes,
    base64: await file.base64(),
  };
}

/** Resolves an IndexedDB-backed Web attachment into a short-lived display URL. */
export async function resolveAttachmentDisplayUri(attachment: MediaAttachment): Promise<string> {
  if (Platform.OS !== 'web' || !isWebAttachmentUri(attachment.uri)) {
    return attachment.uri;
  }
  const blob = await readWebAttachment(webAttachmentKey(attachment.uri));
  if (!blob) {
    throw new Error(`附件「${attachment.name}」的浏览器存储已丢失。`);
  }
  return URL.createObjectURL(blob);
}

/** Queues owned files for deletion after the workspace snapshot commits. */
export async function deletePersistedAttachments(attachments: MediaAttachment[]): Promise<void> {
  if (!attachments.length) {
    return;
  }

  if (Platform.OS === 'web') {
    for (const attachment of attachments) {
      if (isWebAttachmentUri(attachment.uri)) {
        pendingAttachmentDeletions.set(attachment.uri, attachment);
      }
    }
    return;
  }

  const { Directory, Paths } = await import('expo-file-system');
  const directory = new Directory(Paths.document, attachmentDirectoryName);
  const ownedPrefix = directory.uri.endsWith('/') ? directory.uri : `${directory.uri}/`;
  for (const attachment of attachments) {
    if (attachment.uri.startsWith(ownedPrefix)) {
      pendingAttachmentDeletions.set(attachment.uri, attachment);
    }
  }
}

/** Immediately removes files that failed before they were ever committed to a workspace. */
export async function discardUncommittedAttachments(attachments: MediaAttachment[]): Promise<void> {
  if (!attachments.length) {
    return;
  }
  if (Platform.OS === 'web') {
    for (const attachment of attachments) {
      if (!isWebAttachmentUri(attachment.uri)) continue;
      try {
        await deleteWebAttachment(webAttachmentKey(attachment.uri));
      } catch {
        // A later browser storage cleanup can reclaim an orphan if this fails.
      }
    }
    return;
  }

  const { Directory, File, Paths } = await import('expo-file-system');
  const directory = new Directory(Paths.document, attachmentDirectoryName);
  const ownedPrefix = directory.uri.endsWith('/') ? directory.uri : `${directory.uri}/`;
  for (const attachment of attachments) {
    if (!attachment.uri.startsWith(ownedPrefix)) continue;
    try {
      const file = new File(attachment.uri);
      if (file.exists) file.delete();
    } catch {
      // A later app-storage cleanup can reclaim an orphan if this fails.
    }
  }
}

/** Commits queued deletions only after a new workspace snapshot was saved. */
export async function flushPendingAttachmentDeletions(
  referencedAttachments: MediaAttachment[]
): Promise<void> {
  if (!pendingAttachmentDeletions.size) {
    return;
  }
  const referencedUris = new Set(referencedAttachments.map((attachment) => attachment.uri));
  for (const attachment of Array.from(pendingAttachmentDeletions.values())) {
    if (referencedUris.has(attachment.uri)) {
      pendingAttachmentDeletions.delete(attachment.uri);
      continue;
    }
    try {
      if (Platform.OS === 'web') {
        if (isWebAttachmentUri(attachment.uri)) {
          await deleteWebAttachment(webAttachmentKey(attachment.uri));
        }
      } else {
        const { File } = await import('expo-file-system');
        const file = new File(attachment.uri);
        if (file.exists) {
          file.delete();
        }
      }
      pendingAttachmentDeletions.delete(attachment.uri);
    } catch {
      // Keep the candidate queued for the next successful save.
    }
  }
}

/** Inspects app-owned media without opening or uploading any attachment bytes. */
export async function inspectMediaStorage(
  referencedAttachments: readonly MediaAttachment[]
): Promise<MediaStorageDiagnostics> {
  if (Platform.OS === 'web') {
    const keys = await withWebAttachmentStore<IDBValidKey[]>('readonly', (store) => store.getAllKeys());
    const keyStrings = keys.map(String);
    const referencedKeys = new Set(
      referencedAttachments
        .filter((attachment) => isWebAttachmentUri(attachment.uri))
        .map((attachment) => webAttachmentKey(attachment.uri))
    );
    let totalBytes = 0;
    let orphanBytes = 0;
    for (const key of keyStrings) {
      const blob = await readWebAttachment(key);
      const size = blob?.size ?? 0;
      totalBytes += size;
      if (!referencedKeys.has(key)) orphanBytes += size;
    }
    const stored = new Set(keyStrings);
    return {
      fileCount: keyStrings.length,
      totalBytes,
      orphanCount: keyStrings.filter((key) => !referencedKeys.has(key)).length,
      orphanBytes,
      missingReferencedCount: [...referencedKeys].filter((key) => !stored.has(key)).length,
    };
  }

  const { Directory, File, Paths } = await import('expo-file-system');
  const directory = new Directory(Paths.document, attachmentDirectoryName);
  const referencedUris = new Set(referencedAttachments.map((attachment) => attachment.uri));
  if (!directory.exists) {
    return {
      fileCount: 0,
      totalBytes: 0,
      orphanCount: 0,
      orphanBytes: 0,
      missingReferencedCount: referencedAttachments.filter((attachment) =>
        attachment.uri.includes(`/${attachmentDirectoryName}/`)
      ).length,
    };
  }
  const files = directory.list().filter((entry): entry is InstanceType<typeof File> => entry instanceof File);
  let totalBytes = 0;
  let orphanBytes = 0;
  for (const file of files) {
    const size = file.size ?? 0;
    totalBytes += size;
    if (!referencedUris.has(file.uri)) orphanBytes += size;
  }
  const storedUris = new Set(files.map((file) => file.uri));
  return {
    fileCount: files.length,
    totalBytes,
    orphanCount: files.filter((file) => !referencedUris.has(file.uri)).length,
    orphanBytes,
    missingReferencedCount: [...referencedUris].filter((uri) =>
      uri.includes(`/${attachmentDirectoryName}/`) && !storedUris.has(uri)
    ).length,
  };
}

/** Deletes only app-owned files that are not referenced by the supplied workspace snapshot. */
export async function cleanupOrphanedMediaStorage(
  referencedAttachments: readonly MediaAttachment[]
): Promise<MediaStorageCleanupResult> {
  let deletedCount = 0;
  let deletedBytes = 0;
  if (Platform.OS === 'web') {
    const referencedKeys = new Set(
      referencedAttachments
        .filter((attachment) => isWebAttachmentUri(attachment.uri))
        .map((attachment) => webAttachmentKey(attachment.uri))
    );
    const keys = await withWebAttachmentStore<IDBValidKey[]>('readonly', (store) => store.getAllKeys());
    for (const rawKey of keys) {
      const key = String(rawKey);
      if (referencedKeys.has(key)) continue;
      const blob = await readWebAttachment(key);
      await deleteWebAttachment(key);
      deletedCount += 1;
      deletedBytes += blob?.size ?? 0;
    }
  } else {
    const { Directory, File, Paths } = await import('expo-file-system');
    const directory = new Directory(Paths.document, attachmentDirectoryName);
    if (directory.exists) {
      const referencedUris = new Set(referencedAttachments.map((attachment) => attachment.uri));
      for (const entry of directory.list()) {
        if (!(entry instanceof File) || referencedUris.has(entry.uri)) continue;
        const size = entry.size ?? 0;
        entry.delete();
        deletedCount += 1;
        deletedBytes += size;
      }
    }
  }
  const after = await inspectMediaStorage(referencedAttachments);
  return { ...after, deletedCount, deletedBytes };
}

export function attachmentForPersistence(attachment: MediaAttachment): MediaAttachment {
  if (!attachment.base64) {
    return attachment;
  }
  if (Platform.OS === 'web' && !isWebAttachmentUri(attachment.uri)) {
    // Keep legacy inline Web attachments readable until they are re-selected.
    return attachment;
  }
  const persisted = { ...attachment };
  delete persisted.base64;
  return persisted;
}
