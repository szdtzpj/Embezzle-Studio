import {
  MAX_PROJECT_KNOWLEDGE_IMPORT_BYTES,
  MAX_PROJECT_KNOWLEDGE_SOURCE_CHARACTERS,
  SUPPORTED_PROJECT_KNOWLEDGE_GENERIC_MIME_TYPES,
  SUPPORTED_PROJECT_KNOWLEDGE_TEXT_MIME_TYPES,
  validateProjectKnowledgeTextFile,
} from './projectKnowledge';

export const MAX_KNOWLEDGE_FILE_BYTES = MAX_PROJECT_KNOWLEDGE_IMPORT_BYTES;
export const MAX_KNOWLEDGE_FILE_CHARACTERS = MAX_PROJECT_KNOWLEDGE_SOURCE_CHARACTERS;

const allowedMimeTypes = [...new Set([
  'text/*',
  ...SUPPORTED_PROJECT_KNOWLEDGE_TEXT_MIME_TYPES,
  ...SUPPORTED_PROJECT_KNOWLEDGE_GENERIC_MIME_TYPES,
])];

export interface PickedKnowledgeTextFile {
  title: string;
  content: string;
  fileName: string;
  mimeType?: string;
}

export function assertSupportedKnowledgeTextFile(
  name: string,
  mimeType: string | null | undefined,
  size?: number | null
): void {
  try {
    validateProjectKnowledgeTextFile({
      fileName: name,
      ...(mimeType ? { mimeType } : {}),
      ...(size != null ? { sizeBytes: size } : {}),
    });
  } catch (error) {
    if (size != null && size > MAX_KNOWLEDGE_FILE_BYTES) {
      throw new Error('项目资料文件必须小于 2 MB（2,000,000 字节）。');
    }
    throw error;
  }
}

function boundedText(content: string): string {
  const characters = Array.from(content.replace(/^\uFEFF/u, ''));
  if (characters.length > MAX_KNOWLEDGE_FILE_CHARACTERS) {
    throw new Error('项目资料正文超过 500,000 字符上限。');
  }
  const normalized = characters.join('').replace(/\u0000/g, '');
  if (!normalized.trim()) throw new Error('所选资料文件没有可用文本。');
  return normalized;
}

function titleFromFilename(name: string): string {
  const index = name.lastIndexOf('.');
  const extension = index >= 0 ? name.slice(index + 1).toLowerCase() : '';
  const stem = extension ? name.slice(0, -(extension.length + 1)) : name;
  return Array.from(stem.normalize('NFKC').trim() || '导入资料').slice(0, 120).join('');
}

export async function pickProjectKnowledgeTextFile(): Promise<PickedKnowledgeTextFile | null> {
  const DocumentPicker = await import('expo-document-picker');
  const result = await DocumentPicker.getDocumentAsync({
    type: [...allowedMimeTypes],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  assertSupportedKnowledgeTextFile(asset.name, asset.mimeType, asset.size);

  const { Platform } = await import('react-native');
  if (Platform.OS === 'web' && asset.file) {
    assertSupportedKnowledgeTextFile(asset.name, asset.file.type, asset.file.size);
    return {
      title: titleFromFilename(asset.name),
      content: boundedText(await asset.file.text()),
      fileName: asset.name,
      ...(asset.mimeType ? { mimeType: asset.mimeType } : {}),
    };
  }

  const { File } = await import('expo-file-system');
  const file = new File(asset.uri);
  if (!file.exists || file.size == null) throw new Error('无法确认所选资料文件，已拒绝读取。');
  assertSupportedKnowledgeTextFile(asset.name, asset.mimeType, file.size);
  try {
    return {
      title: titleFromFilename(asset.name),
      content: boundedText(await file.text()),
      fileName: asset.name,
      ...(asset.mimeType ? { mimeType: asset.mimeType } : {}),
    };
  } finally {
    try {
      if (file.exists) file.delete();
    } catch {
      // Best-effort cleanup of the document picker's cache copy.
    }
  }
}
