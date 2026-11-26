import type { MediaAttachment, ModelInfo } from '../../domain/types';
import { inferModelTask } from '../../services/modelCapabilities';

export interface BuildEditWithImageDraftArgs {
  attachment: MediaAttachment;
  existingText?: string;
  prompt?: string;
  currentModelId?: string;
  availableModels?: readonly ModelInfo[];
}

export interface EditWithImageDraftResult {
  attachments: MediaAttachment[];
  text: string;
  suggestedModelId?: string;
}

function isImageGenerationModel(model: ModelInfo): boolean {
  return inferModelTask(model) === 'image-generation' || model.capabilities.includes('image-generation');
}

function isLegacyGptImage1(modelId: string): boolean {
  return modelId.trim().toLowerCase() === 'gpt-image-1';
}

function assertEditableImageAttachment(attachment: MediaAttachment | undefined | null): void {
  if (!attachment || attachment.kind !== 'image') {
    throw new Error('仅支持对图片附件执行“以此图继续编辑”。');
  }
  const normalizedMime = attachment.mimeType?.split(';', 1)[0]?.trim().toLowerCase();
  if (normalizedMime && !normalizedMime.startsWith('image/')) {
    throw new Error(`附件「${attachment.name || attachment.id}」不是有效的图片 MIME 类型。`);
  }
  if (!attachment.uri?.trim() && !attachment.base64?.trim()) {
    throw new Error('当前图片附件缺少可用的图片数据或地址。');
  }
}

/**
 * 构造“以此图继续编辑”的 Composer 草稿补丁：
 * - 严格校验目标附件为有效图片，防止非图片附件被误注入参考图槽位；
 * - 若当前模型不具备生图能力且可用列表中存在生图模型（优先非旧版 `gpt-image-1`），给出切换推荐。
 */
export function buildEditWithImageDraft(
  args: BuildEditWithImageDraftArgs
): EditWithImageDraftResult {
  assertEditableImageAttachment(args.attachment);

  const text = args.prompt ?? args.existingText ?? '';
  const attachments: MediaAttachment[] = [{ ...args.attachment }];
  const models = args.availableModels ?? [];
  const currentModelId = args.currentModelId?.trim();

  if (models.length === 0) {
    return { attachments, text };
  }

  const currentModel = currentModelId
    ? models.find((model) => model.id === currentModelId)
    : undefined;

  if (currentModel && isImageGenerationModel(currentModel)) {
    return { attachments, text };
  }

  const imageModels = models.filter(isImageGenerationModel);
  if (imageModels.length === 0) {
    return { attachments, text };
  }

  const preferred = imageModels.find((model) => !isLegacyGptImage1(model.id)) ?? imageModels[0];
  const suggestedModelId =
    preferred && preferred.id !== currentModelId ? preferred.id : undefined;

  return {
    attachments,
    text,
    ...(suggestedModelId ? { suggestedModelId } : {}),
  };
}
