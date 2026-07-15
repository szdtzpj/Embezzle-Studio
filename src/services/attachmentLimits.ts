import type { MediaAttachment } from '../domain/types';

export const MAX_ATTACHMENT_COUNT = 6;
export const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_ATTACHMENT_BYTES = 100 * 1024 * 1024;
export const MAX_FILE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 120 * 1024 * 1024;
export const MAX_IMAGE_ATTACHMENT_PIXELS = 32_000_000;

function estimatedAttachmentBytes(attachment: MediaAttachment): number {
  if (typeof attachment.size === 'number' && Number.isFinite(attachment.size)) {
    return Math.max(0, Math.trunc(attachment.size));
  }
  if (attachment.base64) return Math.ceil(attachment.base64.length * 0.75);
  return 0;
}

export function validateAttachments(attachments: readonly MediaAttachment[]): void {
  if (attachments.length > MAX_ATTACHMENT_COUNT) {
    throw new Error(`一次最多添加 ${MAX_ATTACHMENT_COUNT} 个附件。`);
  }

  let totalBytes = 0;
  for (const attachment of attachments) {
    const bytes = estimatedAttachmentBytes(attachment);
    totalBytes += bytes;
    const limit = attachment.kind === 'image'
      ? MAX_IMAGE_ATTACHMENT_BYTES
      : attachment.kind === 'video'
        ? MAX_VIDEO_ATTACHMENT_BYTES
        : MAX_FILE_ATTACHMENT_BYTES;
    if (bytes > limit) {
      const limitMb = attachment.kind === 'video' ? 100 : attachment.kind === 'image' ? 10 : 20;
      throw new Error(`附件“${attachment.name}”过大（${limitMb} MB 上限）。`);
    }
    if (
      attachment.kind === 'image' &&
      attachment.width &&
      attachment.height &&
      attachment.width * attachment.height > MAX_IMAGE_ATTACHMENT_PIXELS
    ) {
      throw new Error(`图片“${attachment.name}”分辨率过高，请压缩后重试。`);
    }
  }

  if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new Error('附件总大小超过 120 MB，请减少附件后重试。');
  }
}
