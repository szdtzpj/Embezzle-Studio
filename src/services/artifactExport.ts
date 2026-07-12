import type { WorkspaceArtifact } from '../domain/types';

const maxFilenameCharacters = 120;

function sanitizeArtifactFilename(name: string): string {
  const normalized = (name || 'file')
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '') || 'file';
  const separator = normalized.lastIndexOf('.');
  const extension = separator > 0 && Array.from(normalized.slice(separator)).length <= 12
    ? normalized.slice(separator)
    : '';
  const stem = extension ? normalized.slice(0, -extension.length) : normalized;
  const safeStem = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem) ? `_${stem}` : stem;
  const stemLimit = Math.max(1, maxFilenameCharacters - Array.from(extension).length);
  return `${Array.from(safeStem).slice(0, stemLimit).join('')}${extension}`;
}

const extensionByFormat = {
  markdown: 'md',
  'plain-text': 'txt',
  code: 'txt',
  json: 'json',
  html: 'html.txt',
} as const;

const mimeByFormat = {
  markdown: 'text/markdown',
  'plain-text': 'text/plain',
  code: 'text/plain',
  json: 'application/json',
  html: 'text/plain',
} as const;

export interface WorkspaceArtifactExportPayload {
  filename: string;
  mimeType: string;
  content: string;
}

function codeExtension(language: string | undefined): string {
  const normalized = language?.trim().toLowerCase().replace(/[^a-z0-9+#.-]/g, '');
  const known: Record<string, string> = {
    javascript: 'js', typescript: 'ts', python: 'py', java: 'java', kotlin: 'kt',
    swift: 'swift', rust: 'rs', go: 'go', c: 'c', 'c++': 'cpp', 'c#': 'cs',
    css: 'css', sql: 'sql', shell: 'sh', bash: 'sh', yaml: 'yaml', xml: 'xml',
  };
  return (normalized && known[normalized]) || 'txt';
}

export function workspaceArtifactExportPayload(artifact: WorkspaceArtifact): WorkspaceArtifactExportPayload {
  const revision = artifact.revisions.find((item) => item.id === artifact.activeRevisionId);
  if (!revision) throw new Error('成果当前版本不存在，无法导出。');
  const extension = artifact.format === 'code'
    ? codeExtension(artifact.language)
    : extensionByFormat[artifact.format];
  const filename = sanitizeArtifactFilename(`${artifact.title}.${extension}`);
  return { filename, mimeType: mimeByFormat[artifact.format], content: revision.content };
}

export async function exportWorkspaceArtifact(
  artifact: WorkspaceArtifact
): Promise<'downloaded' | 'shared'> {
  const payload = workspaceArtifactExportPayload(artifact);
  const { Platform } = await import('react-native');
  if (Platform.OS === 'web') {
    if (typeof document === 'undefined' || !document.body) {
      throw new Error('当前浏览器无法创建成果下载。');
    }
    const url = URL.createObjectURL(new Blob([payload.content], { type: payload.mimeType }));
    const link = document.createElement('a');
    try {
      link.href = url;
      link.download = payload.filename;
      link.rel = 'noopener';
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      return 'downloaded';
    } finally {
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    }
  }

  const Sharing = await import('expo-sharing');
  if (!(await Sharing.isAvailableAsync())) throw new Error('当前设备没有可用的保存或分享应用。');
  const { File, Paths } = await import('expo-file-system');
  const file = new File(Paths.cache, payload.filename);
  file.create({ overwrite: true, intermediates: true });
  try {
    file.write(payload.content);
    await Sharing.shareAsync(file.uri, {
      dialogTitle: '导出 Embezzle Studio 本地成果',
      mimeType: payload.mimeType,
    });
    return 'shared';
  } finally {
    try {
      if (file.exists) file.delete();
    } catch {
      // Best-effort cleanup after the share sheet closes.
    }
  }
}
