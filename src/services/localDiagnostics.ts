import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

import type { WorkspaceStatus } from '../app/workspace/workspaceStatus';
import { appInfo } from '../data/appInfo';
import type { AppWorkspace, MediaAttachment } from '../domain/types';
import { inspectMediaStorage, type MediaStorageDiagnostics } from './mediaStorage';
import { providerConfigurationHealth } from './providerDiagnostics';
import { redactSensitiveText } from './cloudSyncTransport';

export interface RedactedDiagnosticBundle {
  schemaVersion: 1;
  generatedAt: string;
  app: {
    version: string;
    platform: string;
  };
  workspace: {
    phase: WorkspaceStatus['phase'];
    revision: number;
    dirty: boolean;
    issue?: string;
    recoveryNotice?: string;
    projectCount: number;
    conversationCount: number;
    messageCount: number;
    artifactCount: number;
    knowledgeSourceCount: number;
    draftCount: number;
  };
  providers: Array<{
    id: string;
    name: string;
    kind: string;
    endpointHost: string;
    enabled: boolean;
    credentialPresent: boolean;
    modelCount: number;
    health: string;
    summary: string;
  }>;
  mediaStorage: MediaStorageDiagnostics;
  recentFailures: Array<{
    kind: 'message' | 'usage';
    id: string;
    providerId?: string;
    modelId?: string;
    createdAt: number;
    error?: string;
  }>;
  cloudSync: {
    enabled: boolean;
    provider: string;
    endpointHost: string;
    bucket?: string;
    lastStatus: string;
    lastSyncAt?: number;
    conflictCount: number;
    lastError?: string;
  };
  privacy: {
    apiKeysIncluded: false;
    messageContentIncluded: false;
    attachmentBytesIncluded: false;
    syncCredentialsIncluded: false;
  };
}

function endpointHost(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return value ? 'invalid-endpoint' : '';
  }
}

function boundedError(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return Array.from(redactSensitiveText(value, 500).normalize('NFKC')).slice(0, 500).join('');
}

function workspaceAttachments(workspace: AppWorkspace): MediaAttachment[] {
  return workspace.conversations.flatMap((conversation) =>
    conversation.messages.flatMap((message) => message.attachments ?? [])
  );
}

export async function createRedactedDiagnosticBundle(
  workspace: AppWorkspace,
  status: WorkspaceStatus,
  now = Date.now()
): Promise<RedactedDiagnosticBundle> {
  const mediaStorage = await inspectMediaStorage(workspaceAttachments(workspace));
  const messageFailures = workspace.conversations.flatMap((conversation) =>
    conversation.messages.flatMap((message) =>
      message.status === 'error' || message.error
        ? [{
            kind: 'message' as const,
            id: message.id,
            ...(message.providerId ? { providerId: message.providerId } : {}),
            ...(message.modelId ? { modelId: message.modelId } : {}),
            createdAt: message.createdAt,
            ...(boundedError(message.error) ? { error: boundedError(message.error) } : {}),
          }]
        : []
    )
  );
  const usageFailures = workspace.providerUsageEvents.flatMap((event) =>
    event.status === 'failed' || event.status === 'cancelled'
      ? [{
          kind: 'usage' as const,
          id: event.id,
          providerId: event.providerId,
          modelId: event.modelId,
          createdAt: event.completedAt ?? event.createdAt,
        }]
      : []
  );
  const recentFailures = [...messageFailures, ...usageFailures]
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, 50);

  return {
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    app: { version: appInfo.version, platform: Platform.OS },
    workspace: {
      phase: status.phase,
      revision: status.revision,
      dirty: status.dirty,
      ...(boundedError(status.issue) ? { issue: boundedError(status.issue) } : {}),
      ...(boundedError(status.recoveryNotice)
        ? { recoveryNotice: boundedError(status.recoveryNotice) }
        : {}),
      projectCount: workspace.projects.length,
      conversationCount: workspace.conversations.length,
      messageCount: workspace.conversations.reduce((sum, conversation) => sum + conversation.messages.length, 0),
      artifactCount: workspace.artifacts.length,
      knowledgeSourceCount: workspace.knowledgeSources.length,
      draftCount: workspace.composerDrafts.length,
    },
    providers: workspace.providers.map((provider) => {
      const health = providerConfigurationHealth(provider);
      return {
        id: provider.id,
        name: provider.name,
        kind: provider.kind,
        endpointHost: endpointHost(provider.baseUrl),
        enabled: provider.enabled !== false,
        credentialPresent: Boolean(provider.apiKey?.trim()),
        modelCount: provider.models.filter((model) => model.source !== 'remote').length,
        health: health.health,
        summary: health.summary,
      };
    }),
    mediaStorage,
    recentFailures,
    cloudSync: {
      enabled: workspace.cloudSync.enabled,
      provider: workspace.cloudSync.provider,
      endpointHost: endpointHost(workspace.cloudSync.endpoint),
      ...(workspace.cloudSync.bucket ? { bucket: workspace.cloudSync.bucket } : {}),
      lastStatus: workspace.cloudSync.lastStatus,
      ...(workspace.cloudSync.lastSyncAt !== undefined
        ? { lastSyncAt: workspace.cloudSync.lastSyncAt }
        : {}),
      conflictCount: workspace.cloudSync.conflicts.length,
      ...(boundedError(workspace.cloudSync.lastError)
        ? { lastError: boundedError(workspace.cloudSync.lastError) }
        : {}),
    },
    privacy: {
      apiKeysIncluded: false,
      messageContentIncluded: false,
      attachmentBytesIncluded: false,
      syncCredentialsIncluded: false,
    },
  };
}

function diagnosticFilename(): string {
  return `Embezzle-Studio-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
}

export async function exportRedactedDiagnosticBundle(
  bundle: RedactedDiagnosticBundle
): Promise<'downloaded' | 'shared'> {
  const serialized = JSON.stringify(bundle, null, 2);
  if (new TextEncoder().encode(serialized).byteLength > 256 * 1024) {
    throw new Error('诊断包超过 256 KB 安全上限。');
  }
  const filename = diagnosticFilename();
  if (Platform.OS === 'web') {
    if (typeof document === 'undefined' || !document.body) {
      throw new Error('当前浏览器无法创建诊断包下载。');
    }
    const url = URL.createObjectURL(new Blob([serialized], { type: 'application/json' }));
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
      dialogTitle: '导出 Embezzle Studio 脱敏诊断包',
      mimeType: 'application/json',
    });
    return 'shared';
  } finally {
    try {
      if (file.exists) file.delete();
    } catch {
      // Best-effort cleanup.
    }
  }
}
