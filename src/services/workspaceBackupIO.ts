import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

import { MAX_ENCRYPTED_BACKUP_BYTES } from './workspaceBackup';

const backupMimeType = 'application/json';

function backupFilename(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `Embezzle-Studio-backup-${timestamp}.embezzle-backup.json`;
}

function assertBackupSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ENCRYPTED_BACKUP_BYTES) {
    throw new Error('备份文件超过 10 MB 安全上限。');
  }
}

export async function exportWorkspaceBackupFile(serialized: string): Promise<'downloaded' | 'shared'> {
  const encodedBytes = new TextEncoder().encode(serialized).byteLength;
  assertBackupSize(encodedBytes);
  const filename = backupFilename();

  if (Platform.OS === 'web') {
    if (typeof document === 'undefined' || !document.body) {
      throw new Error('当前浏览器无法创建备份下载。');
    }
    const url = URL.createObjectURL(new Blob([serialized], { type: backupMimeType }));
    const link = document.createElement('a');
    try {
      link.href = url;
      link.download = filename;
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

  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('当前设备没有可用的文件分享或保存应用。');
  }
  const { File, Paths } = await import('expo-file-system');
  const file = new File(Paths.cache, filename);
  file.create({ overwrite: true, intermediates: true });
  try {
    file.write(serialized);
    await Sharing.shareAsync(file.uri, {
      dialogTitle: '导出 Embezzle Studio 加密备份',
      mimeType: backupMimeType,
    });
    return 'shared';
  } finally {
    try {
      if (file.exists) file.delete();
    } catch {
      // Best-effort cleanup after the system share sheet has finished.
    }
  }
}

export async function pickWorkspaceBackupFile(): Promise<string | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: [backupMimeType, 'text/json', 'text/plain'],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) {
    return null;
  }
  const asset = result.assets[0];
  if (!asset) {
    return null;
  }
  if (typeof asset.size === 'number') {
    assertBackupSize(asset.size);
  }

  if (Platform.OS === 'web' && asset.file) {
    assertBackupSize(asset.file.size);
    const text = await asset.file.text();
    assertBackupSize(new TextEncoder().encode(text).byteLength);
    return text;
  }

  const { File } = await import('expo-file-system');
  const file = new File(asset.uri);
  if (!file.exists) {
    throw new Error('所选备份文件已不可访问。');
  }
  try {
    if (file.size == null) {
      throw new Error('无法确认所选备份文件大小，已拒绝读取。');
    }
    assertBackupSize(file.size);
    const text = await file.text();
    assertBackupSize(new TextEncoder().encode(text).byteLength);
    return text;
  } finally {
    try {
      if (file.exists) file.delete();
    } catch {
      // Best-effort cleanup of the document picker's encrypted cache copy.
    }
  }
}
