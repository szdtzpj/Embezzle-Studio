import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

import type { MediaAttachment } from '../domain/types';
import { validateAttachments } from './attachmentLimits';
import { createId } from './id';
import { discardUncommittedAttachments, persistAttachment } from './mediaStorage';

export type IncomingShareKind = 'text' | 'url' | 'image' | 'video' | 'file' | 'audio';

/** Defensive limits for untrusted ACTION_SEND/ACTION_SEND_MULTIPLE payloads. */
export const MAX_INCOMING_SHARE_ITEMS = 32;
export const MAX_INCOMING_SHARE_TEXT_LENGTH = 16_384;
export const INCOMING_SHARE_SUPERSEDED_ERROR = '系统分享内容已更新，请重新选择保存位置。';

export interface IncomingShareItem {
  id: string;
  kind: IncomingShareKind;
  value: string;
  uri?: string;
  name?: string;
  mimeType?: string;
  size?: number;
  contentType?: string;
  /** True when this item came from a resolved native content URI. */
  resolved: boolean;
}

export interface IncomingShareSnapshot {
  items: IncomingShareItem[];
  text: string[];
  urls: string[];
  attachments: IncomingShareItem[];
}

function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return Array.from(value.normalize('NFKC')).slice(0, maximum).join('');
}

function kindFromMimeType(mimeType: string | undefined): IncomingShareKind {
  const normalized = mimeType?.toLowerCase() ?? '';
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('video/')) return 'video';
  if (normalized.startsWith('audio/')) return 'audio';
  if (normalized.startsWith('text/')) return 'text';
  return 'file';
}

function normalizeItem(input: {
  value: unknown;
  shareType?: unknown;
  mimeType?: unknown;
  contentUri?: unknown;
  contentType?: unknown;
  originalName?: unknown;
  contentSize?: unknown;
  resolved: boolean;
}): IncomingShareItem | undefined {
  const value = boundedText(input.value, MAX_INCOMING_SHARE_TEXT_LENGTH);
  if (!value) return undefined;
  const mimeType = boundedText(input.mimeType, 256);
  const contentType = boundedText(input.contentType, 64);
  const shareType = boundedText(input.shareType, 16);
  const kind: IncomingShareKind =
    shareType === 'url' || contentType === 'website'
      ? 'url'
      : shareType === 'text' || contentType === 'text'
        ? 'text'
        : kindFromMimeType(mimeType);
  const uri = boundedText(input.contentUri, 16_384);
  const name = boundedText(input.originalName, 512);
  const size =
    typeof input.contentSize === 'number' && Number.isFinite(input.contentSize) && input.contentSize >= 0
      ? Math.trunc(input.contentSize)
      : undefined;
  return {
    id: createId('shared'),
    kind,
    value,
    ...(uri ? { uri } : {}),
    ...(name ? { name } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(contentType ? { contentType } : {}),
    resolved: input.resolved,
  };
}

export function normalizeIncomingSharePayloads(
  payloads: readonly Sharing.SharePayload[] | readonly Sharing.ResolvedSharePayload[],
  resolved: boolean
): IncomingShareSnapshot {
  const items = payloads
    .slice(0, MAX_INCOMING_SHARE_ITEMS)
    .map((payload) =>
      normalizeItem({
        value: payload.value,
        shareType: payload.shareType,
        // Resolved payloads expose the MIME type of the downloaded/content URI
        // separately from the MIME type originally supplied by the share
        // sender. Prefer the resolved value so attachment routing and previews
        // do not misclassify a redirected URL or a provider-normalized file.
        mimeType: resolved
          ? (payload as Sharing.ResolvedSharePayload).contentMimeType ?? payload.mimeType
          : payload.mimeType,
        contentUri: resolved ? (payload as Sharing.ResolvedSharePayload).contentUri : undefined,
        contentType: resolved ? (payload as Sharing.ResolvedSharePayload).contentType : undefined,
        originalName: resolved ? (payload as Sharing.ResolvedSharePayload).originalName : undefined,
        contentSize: resolved ? (payload as Sharing.ResolvedSharePayload).contentSize : undefined,
        resolved,
      })
    )
    .filter((item): item is IncomingShareItem => Boolean(item));
  return snapshotFromItems(items);
}

function snapshotFromItems(items: IncomingShareItem[]): IncomingShareSnapshot {
  return {
    items,
    text: items.filter((item) => item.kind === 'text').map((item) => item.value),
    urls: items.filter((item) => item.kind === 'url').map((item) => item.value),
    attachments: items.filter((item) =>
      ['image', 'video', 'file', 'audio'].includes(item.kind)
    ),
  };
}

export function emptyIncomingShareSnapshot(): IncomingShareSnapshot {
  return { items: [], text: [], urls: [], attachments: [] };
}

/** Reads only the raw payload. On Android this does not fetch a shared URL. */
export function readIncomingSharePayloads(): IncomingShareSnapshot {
  if (Platform.OS === 'web') return emptyIncomingShareSnapshot();
  try {
    return normalizeIncomingSharePayloads(Sharing.getSharedPayloads(), false);
  } catch {
    return emptyIncomingShareSnapshot();
  }
}

/**
 * Resolves native stream/content URIs into app-cache file URIs after preview.
 * The pinned expo-sharing patch keeps URL captions as opaque text and never
 * performs a network request while resolving an Android share intent.
 */
export async function resolveIncomingSharePayloads(): Promise<IncomingShareSnapshot> {
  if (Platform.OS === 'web') return emptyIncomingShareSnapshot();
  const resolved = await Sharing.getResolvedSharedPayloadsAsync();
  return normalizeIncomingSharePayloads(resolved, true);
}

export function incomingShareItemToAttachment(item: IncomingShareItem): MediaAttachment | undefined {
  if (!item.uri || !['image', 'video', 'file', 'audio'].includes(item.kind)) return undefined;
  return {
    id: item.id,
    kind: item.kind === 'image' ? 'image' : item.kind === 'video' ? 'video' : 'file',
    uri: item.uri,
    name: item.name ?? `shared-${item.id}`,
    ...(item.mimeType ? { mimeType: item.mimeType } : {}),
    ...(item.size !== undefined ? { size: item.size } : {}),
  };
}

async function inspectIncomingShareAttachmentSizes(
  attachments: readonly MediaAttachment[]
): Promise<MediaAttachment[]> {
  if (Platform.OS === 'web') return attachments.map((attachment) => ({ ...attachment }));
  const { File } = await import('expo-file-system');
  return attachments.map((attachment) => {
    const source = new File(attachment.uri);
    if (!source.exists) {
      throw new Error(`共享附件“${attachment.name}”已不可访问，请重新分享。`);
    }
    return {
      ...attachment,
      // The copied cache file is authoritative; ContentProvider metadata is
      // untrusted and can be missing or deliberately understated.
      size: source.size ?? attachment.size,
    };
  });
}

/** Copies resolved share files from the transient cache into app-owned storage. */
export async function persistIncomingShareAttachments(
  items: readonly IncomingShareItem[]
): Promise<MediaAttachment[]> {
  const candidates = items
    .map(incomingShareItemToAttachment)
    .filter((attachment): attachment is MediaAttachment => Boolean(attachment));
  validateAttachments(candidates);
  const inspected = await inspectIncomingShareAttachmentSizes(candidates);
  validateAttachments(inspected);
  const persisted: MediaAttachment[] = [];
  try {
    for (const attachment of inspected) {
      const copied = await persistAttachment(attachment, { downloadRemote: false });
      validateAttachments([...persisted, copied]);
      persisted.push(copied);
    }
    return persisted;
  } catch (error) {
    // A multi-share copy is one logical operation. If item N fails, reclaim
    // items 1..N-1 so an aborted share cannot leak app-scoped media files.
    if (persisted.length) {
      try {
        await discardUncommittedAttachments(persisted);
      } catch {
        // Preserve the original copy failure; cleanup can be retried by the
        // normal attachment sweep without hiding the actionable error.
      }
    }
    throw error;
  }
}

/**
 * Persists one reviewed share snapshot only while its operation token remains
 * current. If another Android share arrives during the copy, reclaim the
 * files just created and leave the newer payload untouched.
 */
export async function persistIncomingShareAttachmentsIfCurrent(
  items: readonly IncomingShareItem[],
  isCurrent: () => boolean
): Promise<MediaAttachment[]> {
  if (!isCurrent()) throw new Error(INCOMING_SHARE_SUPERSEDED_ERROR);
  const persisted = await persistIncomingShareAttachments(items);
  if (isCurrent()) return persisted;
  await discardUncommittedAttachments(persisted);
  throw new Error(INCOMING_SHARE_SUPERSEDED_ERROR);
}

export function clearIncomingSharePayloads(): void {
  if (Platform.OS === 'web') return;
  try {
    Sharing.clearSharedPayloads();
  } catch {
    // The payload is best-effort cleared after the foreground commit. A later
    // refresh can still show it if the native module rejected the clear call.
  }
}
