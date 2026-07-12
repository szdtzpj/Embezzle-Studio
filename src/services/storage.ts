import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { isArkStaticDoubaoModelId, isVolcengineArkProvider } from '../data/arkModels';
import {
  createDefaultWorkspace,
  defaultCostGuardSettings,
  defaultParameterSettings,
} from '../data/providerCatalog';
import type {
  AppWorkspace,
  AttachmentKind,
  Capability,
  ChatConversation,
  ChatMessage,
  ChatTokenUsage,
  ColorMode,
  CostEstimate,
  CostGuardSettings,
  MediaAttachment,
  McpActivitySummary,
  ModelPricing,
  ModelInfo,
  ModelParameterSettings,
  ModelTargetRef,
  ModelTask,
  PluginManifest,
  PricingCurrency,
  PromptTemplate,
  ProviderKind,
  ProviderProfile,
  ProviderUsageEvent,
  ProviderUsageKind,
  ProjectKnowledgeKind,
  ProjectKnowledgeSource,
  RequestMetrics,
  ReasoningEffort,
  UnknownCostComponent,
  VoiceSettings,
  WebCitation,
  WebSearchSettings,
  WorkspaceProject,
  WorkspaceArtifact,
  WorkspaceArtifactFormat,
  WorkspaceArtifactRevision,
} from '../domain/types';
import {
  MAX_MCP_ALLOWED_TOOLS,
  MAX_PLUGIN_MANIFESTS,
  getRemoteMcpExecutableReadiness,
  normalizeMcpAllowedTools,
  normalizeMcpAuthorization,
  normalizeMcpDescription,
  normalizeMcpServerLabel,
  normalizeMcpToolName,
  normalizeRemoteMcpEndpoint,
  remoteMcpBindingFingerprint,
} from '../plugins/contracts';
import { createModelInfoFromId, inferModelTask } from './modelCapabilities';
import { attachmentForPersistence, flushPendingAttachmentDeletions } from './mediaStorage';
import {
  MAX_PROMPT_TEMPLATE_CONTENT_LENGTH,
  MAX_PROMPT_TEMPLATE_NAME_LENGTH,
  MAX_PROMPT_TEMPLATES,
} from './promptTemplates';
import {
  MAX_PROJECT_KNOWLEDGE_MIME_TYPE_CHARACTERS,
  MAX_PROJECT_KNOWLEDGE_CONTEXT_SOURCES,
  MAX_PROJECT_KNOWLEDGE_FILE_NAME_CHARACTERS,
  MAX_PROJECT_KNOWLEDGE_SOURCE_CHARACTERS,
  MAX_PROJECT_KNOWLEDGE_SOURCES,
  MAX_PROJECT_KNOWLEDGE_TITLE_CHARACTERS,
  MAX_PROJECT_KNOWLEDGE_TOTAL_BYTES,
  projectKnowledgeContentBytes,
} from './projectKnowledge';
import {
  isExactOfficialOpenAiProvider,
  providerEndpointFingerprint,
} from './providerSetup';
import { sliceUnicodeCharacters, unicodeCharacterLengthExceeds } from './textBounds';
import {
  MAX_WORKSPACE_ARTIFACT_CONTENT_LENGTH,
  MAX_WORKSPACE_ARTIFACT_LANGUAGE_LENGTH,
  MAX_WORKSPACE_ARTIFACT_REVISIONS,
  MAX_WORKSPACE_ARTIFACT_TITLE_LENGTH,
  MAX_WORKSPACE_ARTIFACTS,
  MAX_WORKSPACE_ARTIFACT_TOTAL_BYTES,
  workspaceArtifactContentBytes,
} from './workspaceArtifacts';
import {
  MAX_WORKSPACE_PROJECT_NAME_LENGTH,
  MAX_WORKSPACE_PROJECT_SYSTEM_PROMPT_LENGTH,
  MAX_WORKSPACE_PROJECTS,
} from './workspaceProjects';
import {
  isColonCapableWorkspaceEntityId,
  isLegacyWorkspaceId,
  providerModelCurrencyIdentityKey,
  providerModelIdentityKey,
} from './workspaceEntityIds';
import { toWorkspaceSaveError } from './workspaceSaveError';

export {
  WorkspaceSaveError,
  isWorkspaceSaveError,
  type WorkspaceSaveCommitStage,
} from './workspaceSaveError';

const LEGACY_WORKSPACE_KEYS = [
  '@embezzle-studio/workspace-v5',
  '@embezzle-studio/workspace-v4',
  '@embezzle-studio/workspace-v3',
  '@embezzle-studio/workspace-v2',
  '@embezzle-studio/workspace-v1',
] as const;
const LEGACY_WORKSPACE_BACKUPS: Partial<Record<(typeof LEGACY_WORKSPACE_KEYS)[number], string>> = {
  '@embezzle-studio/workspace-v5': '@embezzle-studio/workspace-v5.backup',
  '@embezzle-studio/workspace-v4': '@embezzle-studio/workspace-v4.backup',
  '@embezzle-studio/workspace-v3': '@embezzle-studio/workspace-v3.backup',
  '@embezzle-studio/workspace-v2': '@embezzle-studio/workspace-v2.backup',
};
const WORKSPACE_KEY = '@embezzle-studio/workspace-v6';
const WORKSPACE_BACKUP_KEY = '@embezzle-studio/workspace-v6.backup';
const WORKSPACE_RECOVERY_KEY = '@embezzle-studio/workspace-recovery-v6';
const COLOR_MODE_KEY = '@embezzle-studio/color-mode-v1';
const SECRET_PREFIX = 'embezzle-studio.provider-key';
const PLUGIN_SECRET_PREFIX = 'embezzle-studio.plugin-authorization';
const BOUND_SECRET_SCHEMA_VERSION = 1;
const STORAGE_SCHEMA_VERSION = 6;
const INTERRUPTED_MESSAGE = '上次请求在应用退出前未完成，已标记为中断。';

const providerKinds = new Set<ProviderKind>([
  'openai-compatible',
  'volcengine-ark',
  'bailian-compatible',
  'new-api-relay',
  'custom',
]);
const capabilities = new Set<Capability>([
  'text',
  'image-input',
  'video-input',
  'file-input',
  'tool-calling',
  'reasoning',
  'web-search',
  'image-generation',
  'video-generation',
  'speech-to-text',
  'text-to-speech',
  'embedding',
  'rerank',
  'streaming',
  'mcp',
]);
const reasoningEfforts = new Set<ReasoningEffort>([
  'default',
  'off',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
const modelTasks = new Set<ModelTask>([
  'chat',
  'image-generation',
  'video-generation',
  'audio-transcription',
  'speech-generation',
  'embedding',
  'rerank',
]);
const attachmentKinds = new Set<AttachmentKind>(['image', 'video', 'file']);
const pluginPermissions = new Set<PluginManifest['permissions'][number]>(['network', 'files', 'clipboard', 'tools']);
const pricingCurrencies = new Set<PricingCurrency>(['CNY', 'USD']);
const speechFormats = new Set<VoiceSettings['speechFormat']>(['mp3', 'opus', 'aac', 'wav']);
const searchContextSizes = new Set<WebSearchSettings['searchContextSize']>(['low', 'medium', 'high']);
const providerUsageKinds = new Set<ProviderUsageKind>([
  'chat',
  'web-search',
  'image-generation',
  'video-generation',
  'audio-transcription',
  'speech-generation',
]);
const artifactFormats = new Set<WorkspaceArtifactFormat>([
  'markdown',
  'plain-text',
  'code',
  'json',
  'html',
]);
const knowledgeKinds = new Set<ProjectKnowledgeKind>(['text', 'artifact', 'message', 'file']);

type PersistedProvider = Omit<ProviderProfile, 'apiKey'>;
type PersistedPlugin = Omit<PluginManifest, 'authorization'>;
type PersistedWorkspace = Omit<AppWorkspace, 'providers' | 'messages' | 'plugins'> & {
  providers: PersistedProvider[];
  plugins: PersistedPlugin[];
};

interface PersistedWorkspaceEnvelope {
  schemaVersion: typeof STORAGE_SCHEMA_VERSION;
  revision: number;
  savedAt: number;
  workspace: PersistedWorkspace;
}

interface DecodedWorkspace {
  revision: number;
  snapshot: Record<string, unknown>;
}

interface BoundSecretEnvelope {
  schemaVersion: typeof BOUND_SECRET_SCHEMA_VERSION;
  bindingFingerprint: string;
  secret: string;
}

let secureStoreAvailable = false;
let loadFailure: Error | null = null;
let recoveryNotice: string | null = null;
let saveQueue: Promise<void> = Promise.resolve();
let requestedRevision = 0;
const secretValues = new Map<string, BoundSecretEnvelope | undefined>();
const pluginSecretValues = new Map<string, BoundSecretEnvelope | undefined>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function shapeError(message: string): Error {
  return new Error(`工作区数据格式无效：${message}`);
}

class PersistedWorkspaceBudgetError extends Error {
  constructor(message: string) {
    super(`工作区持久化预算超限：${message}`);
    this.name = 'PersistedWorkspaceBudgetError';
  }
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function boundedCharacters(value: string, maximum: number): string {
  return sliceUnicodeCharacters(value, maximum);
}

function arrayField(value: unknown, label: string): unknown[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw shapeError(`${label} 必须是数组。`);
  }
  return value;
}

function recordField(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw shapeError(`${label} 必须是对象。`);
  }
  return value;
}

function normalizeCapabilities(value: unknown, fallback: Capability[] = []): Capability[] {
  if (value === undefined) {
    return [...fallback];
  }
  if (!Array.isArray(value)) {
    throw shapeError('capabilities 必须是数组。');
  }
  return Array.from(
    new Set(value.filter((item): item is Capability => typeof item === 'string' && capabilities.has(item as Capability)))
  );
}

function normalizeReasoningEfforts(value: unknown): ReasoningEffort[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw shapeError('supportedReasoningEfforts 必须是数组。');
  }
  const normalized = Array.from(
    new Set(
      value.filter(
        (item): item is ReasoningEffort => typeof item === 'string' && reasoningEfforts.has(item as ReasoningEffort)
      )
    )
  );
  return normalized.length ? normalized : undefined;
}

function normalizeCapabilityOverrides(
  value: unknown
): Partial<Record<Capability, boolean>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw shapeError('capabilityOverrides 必须是对象。');
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [Capability, boolean] =>
      capabilities.has(entry[0] as Capability) && typeof entry[1] === 'boolean'
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function normalizeModel(value: unknown, provider: ProviderProfile, label: string): ModelInfo {
  if (!isRecord(value)) {
    throw shapeError(`${label} 必须是对象。`);
  }
  const id = nonEmptyString(value.id);
  if (!id) {
    throw shapeError(`${label}.id 不能为空。`);
  }
  const source = value.source === 'preset' || value.source === 'remote' || value.source === 'manual'
    ? value.source
    : 'manual';
  const inferred = createModelInfoFromId(provider, id, source, {
    id,
    name: nonEmptyString(value.name),
  });
  const task = typeof value.task === 'string' && modelTasks.has(value.task as ModelTask)
    ? (value.task as ModelTask)
    : inferred.task;
  const contextWindow = optionalFiniteNumber(value.contextWindow);
  const capabilityOverrides = normalizeCapabilityOverrides(value.capabilityOverrides);

  return {
    id,
    name: nonEmptyString(value.name) ?? id,
    capabilities: normalizeCapabilities(value.capabilities, inferred.capabilities),
    ...(capabilityOverrides ? { capabilityOverrides } : {}),
    supportedReasoningEfforts: normalizeReasoningEfforts(value.supportedReasoningEfforts),
    ...(contextWindow && contextWindow > 0 ? { contextWindow } : {}),
    task,
    source,
  };
}

function normalizeProvider(value: unknown, index: number): PersistedProvider {
  if (!isRecord(value)) {
    throw shapeError(`providers[${index}] 必须是对象。`);
  }
  const id = nonEmptyString(value.id);
  if (!isLegacyWorkspaceId(id)) {
    throw shapeError(`providers[${index}].id 不能为空，且只能包含字母、数字、点、横线和下划线。`);
  }
  const kind = typeof value.kind === 'string' && providerKinds.has(value.kind as ProviderKind)
    ? (value.kind as ProviderKind)
    : 'custom';
  const provider: ProviderProfile = {
    id,
    name: nonEmptyString(value.name) ?? id,
    kind,
    baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl.trim() : '',
    capabilities: normalizeCapabilities(value.capabilities, ['text', 'streaming']),
    models: [],
    ...(typeof value.notes === 'string' ? { notes: value.notes } : {}),
    ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
  };
  provider.models = arrayField(value.models, `providers[${index}].models`).map((model, modelIndex) =>
    normalizeModel(model, provider, `providers[${index}].models[${modelIndex}]`)
  );
  return provider;
}

function defaultPersistedProviders(): PersistedProvider[] {
  return createDefaultWorkspace().providers.map((provider) => ({
    ...stripSecret(provider),
    capabilities: [...provider.capabilities],
    models: provider.models.map((model) => ({ ...model, capabilities: [...model.capabilities] })),
  }));
}

function normalizePersistedProviders(value: unknown): PersistedProvider[] {
  if (value === undefined) {
    return defaultPersistedProviders();
  }
  if (!Array.isArray(value)) {
    throw shapeError('providers 必须是数组。');
  }
  const normalized = value.map(normalizeProvider);
  return normalized.length ? normalized : defaultPersistedProviders();
}

function normalizeAttachment(value: unknown, label: string): MediaAttachment {
  if (!isRecord(value)) {
    throw shapeError(`${label} 必须是对象。`);
  }
  const kind = typeof value.kind === 'string' && attachmentKinds.has(value.kind as AttachmentKind)
    ? (value.kind as AttachmentKind)
    : 'file';
  return {
    id: nonEmptyString(value.id) ?? `${label.replace(/[^A-Za-z0-9]+/g, '-')}`,
    kind,
    uri: typeof value.uri === 'string' ? value.uri : '',
    name: nonEmptyString(value.name) ?? 'attachment',
    ...(typeof value.mimeType === 'string' ? { mimeType: value.mimeType } : {}),
    ...(optionalFiniteNumber(value.size) !== undefined ? { size: optionalFiniteNumber(value.size) } : {}),
    ...(optionalFiniteNumber(value.width) !== undefined ? { width: optionalFiniteNumber(value.width) } : {}),
    ...(optionalFiniteNumber(value.height) !== undefined ? { height: optionalFiniteNumber(value.height) } : {}),
    ...(optionalFiniteNumber(value.durationMs) !== undefined ? { durationMs: optionalFiniteNumber(value.durationMs) } : {}),
    ...(typeof value.base64 === 'string' || value.base64 === null ? { base64: value.base64 } : {}),
  };
}

function nonNegativeFiniteNumber(value: unknown): number | undefined {
  const normalized = optionalFiniteNumber(value);
  return normalized !== undefined && normalized >= 0 ? normalized : undefined;
}

function normalizeTokenUsage(value: unknown, label: string): ChatTokenUsage | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw shapeError(`${label} 必须是对象。`);
  }
  const usage: ChatTokenUsage = {
    inputTokens: nonNegativeFiniteNumber(value.inputTokens),
    outputTokens: nonNegativeFiniteNumber(value.outputTokens),
    reasoningTokens: nonNegativeFiniteNumber(value.reasoningTokens),
    cachedInputTokens: nonNegativeFiniteNumber(value.cachedInputTokens),
    totalTokens: nonNegativeFiniteNumber(value.totalTokens),
  };
  return Object.values(usage).some((item) => item !== undefined) ? usage : undefined;
}

function normalizeGenerationTask(value: unknown, label: string): ChatMessage['generationTask'] {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw shapeError(`${label} 必须是对象。`);
  }
  const providerId = nonEmptyString(value.providerId);
  const modelId = nonEmptyString(value.modelId);
  const taskId = nonEmptyString(value.taskId);
  if (!providerId || !modelId || !taskId || value.kind !== 'video') {
    throw shapeError(`${label} 缺少有效的 providerId、modelId、taskId 或 kind。`);
  }
  return {
    providerId,
    modelId,
    taskId,
    kind: 'video',
    ...(nonEmptyString(value.status) ? { status: nonEmptyString(value.status) } : {}),
  };
}

function isPrivateOrReservedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (
    !host ||
    (!host.includes('.') && !host.includes(':')) ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    host.endsWith('.home.arpa')
  ) {
    return true;
  }

  if (host.includes(':')) {
    const segments = host.split(':');
    const first = Number.parseInt(segments[0] || '0', 16);
    const second = Number.parseInt(segments[1] || '0', 16);
    const third = Number.parseInt(segments[2] || '0', 16);
    return (
      host.startsWith('::') ||
      host.startsWith('64:ff9b:') ||
      host.startsWith('100::') ||
      host.startsWith('2002:') ||
      first === 0x5f00 ||
      (first >= 0xfc00 && first <= 0xfdff) ||
      (first >= 0xfe80 && first <= 0xfeff) ||
      (first >= 0xff00 && first <= 0xffff) ||
      (first === 0x3fff && second <= 0x0fff) ||
      (first === 0x2001 &&
        (second === 0 ||
          (second === 2 && third === 0) ||
          second === 0x0db8 ||
          (second >= 0x10 && second <= 0x2f)))
    );
  }

  const octets = host.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  ) {
    return /^[0-9.]+$/.test(host);
  }
  const [a, b, c] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function parseSafePublicHttpsUrl(value: string, allowQueryAndFragment: boolean): URL | undefined {
  if (
    !value ||
    value.length > 8_192 ||
    /[\u0000-\u0020\u007f]/.test(value)
  ) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !url.hostname ||
      isPrivateOrReservedHostname(url.hostname) ||
      (!allowQueryAndFragment && (value.includes('?') || value.includes('#')))
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function normalizeCitations(value: unknown, label: string): WebCitation[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = arrayField(value, label).slice(0, 100).flatMap((citation, index) => {
    if (!isRecord(citation)) {
      throw shapeError(`${label}[${index}] 必须是对象。`);
    }
    const rawUrl = nonEmptyString(citation.url);
    if (!rawUrl) {
      return [];
    }
    const url = parseSafePublicHttpsUrl(rawUrl, true);
    if (!url) {
      return [];
    }
    const startIndex = nonNegativeFiniteNumber(citation.startIndex);
    const endIndex = nonNegativeFiniteNumber(citation.endIndex);
    return [{
      url: url.toString(),
      ...(nonEmptyString(citation.title) ? { title: nonEmptyString(citation.title) } : {}),
      ...(startIndex !== undefined ? { startIndex: Math.trunc(startIndex) } : {}),
      ...(endIndex !== undefined ? { endIndex: Math.trunc(endIndex) } : {}),
    }];
  });
  return normalized.length ? normalized : undefined;
}

function normalizeRequestMetrics(value: unknown, label: string): RequestMetrics | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw shapeError(`${label} 必须是对象。`);
  }
  const durationMs = nonNegativeFiniteNumber(value.durationMs);
  const timeToFirstTokenMs = nonNegativeFiniteNumber(value.timeToFirstTokenMs);
  const metrics: RequestMetrics = {
    ...(durationMs !== undefined ? { durationMs: Math.min(durationMs, 24 * 60 * 60 * 1_000) } : {}),
    ...(timeToFirstTokenMs !== undefined
      ? { timeToFirstTokenMs: Math.min(timeToFirstTokenMs, 24 * 60 * 60 * 1_000) }
      : {}),
  };
  return Object.keys(metrics).length ? metrics : undefined;
}

function normalizeCostEstimate(value: unknown, label: string): CostEstimate | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw shapeError(`${label} 必须是对象。`);
  }
  const amount = nonNegativeFiniteNumber(value.amount);
  const pricingUpdatedAt = nonNegativeFiniteNumber(value.pricingUpdatedAt);
  const currency = typeof value.currency === 'string' && pricingCurrencies.has(value.currency as PricingCurrency)
    ? (value.currency as PricingCurrency)
    : undefined;
  if (amount === undefined || pricingUpdatedAt === undefined || !currency || value.source !== 'user-configured') {
    return undefined;
  }
  return { amount, currency, source: 'user-configured', pricingUpdatedAt };
}

function normalizeMcpActivity(
  value: unknown,
  label: string
): McpActivitySummary | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw shapeError(`${label} 必须是对象。`);
  }
  const serverLabel = normalizeMcpServerLabel(value.serverLabel);
  if (!serverLabel) {
    throw shapeError(`${label}.serverLabel 无效。`);
  }
  const providerRequestCount = value.providerRequestCount;
  if (
    !Number.isSafeInteger(providerRequestCount) ||
    (providerRequestCount as number) <= 0 ||
    (providerRequestCount as number) > 5
  ) {
    throw shapeError(`${label}.providerRequestCount 必须是 1 到 5 的整数。`);
  }
  const rawApprovals = arrayField(value.approvals, `${label}.approvals`);
  const rawCalls = arrayField(value.calls, `${label}.calls`);
  if (rawApprovals.length > 4) {
    throw shapeError(`${label}.approvals 最多允许 4 项。`);
  }
  if (rawCalls.length > 4) {
    throw shapeError(`${label}.calls 最多允许 4 项。`);
  }
  const approvals: McpActivitySummary['approvals'] = rawApprovals.map((entry, index) => {
    if (!isRecord(entry)) {
      throw shapeError(`${label}.approvals[${index}] 必须是对象。`);
    }
    const toolName = normalizeMcpToolName(entry.toolName);
    if (!toolName || (entry.decision !== 'approve' && entry.decision !== 'deny')) {
      throw shapeError(`${label}.approvals[${index}] 无效。`);
    }
    return { toolName, decision: entry.decision };
  });
  const calls: McpActivitySummary['calls'] = rawCalls.map((entry, index) => {
    if (!isRecord(entry)) {
      throw shapeError(`${label}.calls[${index}] 必须是对象。`);
    }
    const toolName = normalizeMcpToolName(entry.toolName);
    if (
      !toolName ||
      (entry.outcome !== 'completed' &&
        entry.outcome !== 'failed' &&
        entry.outcome !== 'unknown')
    ) {
      throw shapeError(`${label}.calls[${index}] 无效。`);
    }
    return { toolName, outcome: entry.outcome };
  });
  return {
    serverLabel,
    providerRequestCount: providerRequestCount as number,
    approvals,
    calls,
  };
}

function normalizeMessage(value: unknown, label: string, fallbackCreatedAt: number): ChatMessage {
  if (!isRecord(value)) {
    throw shapeError(`${label} 必须是对象。`);
  }
  const role = value.role === 'system' || value.role === 'user' || value.role === 'assistant'
    ? value.role
    : 'assistant';
  const storedStatus = value.status === 'ready' || value.status === 'pending' || value.status === 'error' || value.status === 'cancelled'
    ? value.status
    : 'ready';
  const interrupted = storedStatus === 'pending';
  const content = typeof value.content === 'string' ? value.content : '';
  const attachments = value.attachments === undefined
    ? undefined
    : arrayField(value.attachments, `${label}.attachments`).map((attachment, index) =>
        normalizeAttachment(attachment, `${label}.attachments[${index}]`)
      );
  const usage = normalizeTokenUsage(value.usage, `${label}.usage`);
  const citations = normalizeCitations(value.citations, `${label}.citations`);
  const generationTask = normalizeGenerationTask(value.generationTask, `${label}.generationTask`);
  const requestMetrics = normalizeRequestMetrics(value.requestMetrics, `${label}.requestMetrics`);
  const costEstimate = normalizeCostEstimate(value.costEstimate, `${label}.costEstimate`);
  const mcpActivity = normalizeMcpActivity(value.mcpActivity, `${label}.mcpActivity`);

  return {
    id: nonEmptyString(value.id) ?? label.replace(/[^A-Za-z0-9]+/g, '-'),
    ...(nonEmptyString(value.originMessageId)
      ? { originMessageId: nonEmptyString(value.originMessageId) }
      : {}),
    role,
    content: interrupted && !content.trim() ? INTERRUPTED_MESSAGE : content,
    createdAt: finiteNumber(value.createdAt, fallbackCreatedAt),
    status: interrupted ? 'error' : storedStatus,
    ...(attachments ? { attachments } : {}),
    ...(typeof value.reasoningContent === 'string' ? { reasoningContent: value.reasoningContent } : {}),
    ...(usage ? { usage } : {}),
    ...(citations ? { citations } : {}),
    ...(typeof value.webSearchTriggered === 'boolean'
      ? { webSearchTriggered: value.webSearchTriggered }
      : {}),
    ...(nonEmptyString(value.promptTemplateId) ? { promptTemplateId: nonEmptyString(value.promptTemplateId) } : {}),
    ...(nonEmptyString(value.projectInstructionId)
      ? { projectInstructionId: nonEmptyString(value.projectInstructionId) }
      : {}),
    ...(generationTask ? { generationTask } : {}),
    ...(nonEmptyString(value.comparisonGroupId) ? { comparisonGroupId: nonEmptyString(value.comparisonGroupId) } : {}),
    ...(value.selectedForContext === true ? { selectedForContext: true } : {}),
    ...(value.excludedFromContext === true ? { excludedFromContext: true } : {}),
    ...(value.pinnedForContext === true && value.excludedFromContext !== true
      ? { pinnedForContext: true }
      : {}),
    ...(requestMetrics ? { requestMetrics } : {}),
    ...(costEstimate ? { costEstimate } : {}),
    ...(mcpActivity ? { mcpActivity } : {}),
    ...(typeof value.modelId === 'string' ? { modelId: value.modelId } : {}),
    ...(typeof value.providerId === 'string' ? { providerId: value.providerId } : {}),
    ...(typeof value.providerName === 'string' ? { providerName: value.providerName } : {}),
    ...(interrupted
      ? { error: INTERRUPTED_MESSAGE }
      : typeof value.error === 'string'
        ? { error: value.error }
        : {}),
  };
}

function conversationTitle(messages: ChatMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === 'user');
  const content = firstUserMessage?.content.trim().replace(/\s+/g, ' ') ?? '';
  if (content) {
    return content.length > 28 ? `${content.slice(0, 28)}...` : content;
  }
  return firstUserMessage?.attachments?.length ? '附件对话' : '新对话';
}

function normalizeConversation(value: unknown, index: number, now: number): ChatConversation {
  if (!isRecord(value)) {
    throw shapeError(`conversations[${index}] 必须是对象。`);
  }
  const id = nonEmptyString(value.id) ?? `conversation-recovered-${index + 1}`;
  const createdAt = finiteNumber(value.createdAt, now);
  const messages = arrayField(value.messages, `conversations[${index}].messages`).map((message, messageIndex) =>
    normalizeMessage(message, `conversation-${index + 1}-message-${messageIndex + 1}`, createdAt + messageIndex)
  );
  const pinnedAt = optionalFiniteNumber(value.pinnedAt);
  const knowledgeSourceIds = Array.from(
    new Set(
      arrayField(value.knowledgeSourceIds, `conversations[${index}].knowledgeSourceIds`)
        .flatMap((candidate) => nonEmptyString(candidate) ?? [])
    )
  ).slice(0, MAX_PROJECT_KNOWLEDGE_CONTEXT_SOURCES);
  return {
    id,
    title: nonEmptyString(value.title) ?? conversationTitle(messages),
    ...(value.customTitle === true ? { customTitle: true } : {}),
    ...(pinnedAt !== undefined ? { pinnedAt } : {}),
    ...(nonEmptyString(value.projectId) ? { projectId: nonEmptyString(value.projectId) } : {}),
    ...(nonEmptyString(value.parentConversationId)
      ? { parentConversationId: nonEmptyString(value.parentConversationId) }
      : {}),
    ...(nonEmptyString(value.branchPointMessageId)
      ? { branchPointMessageId: nonEmptyString(value.branchPointMessageId) }
      : {}),
    ...(knowledgeSourceIds.length ? { knowledgeSourceIds } : {}),
    createdAt,
    updatedAt: finiteNumber(value.updatedAt, createdAt),
    messages,
  };
}

function normalizeLegacyMessages(value: unknown, now: number): ChatMessage[] {
  return arrayField(value, 'messages').map((message, index) =>
    normalizeMessage(message, `legacy-message-${index + 1}`, now + index)
  );
}

function normalizeConversations(snapshot: Record<string, unknown>, now: number): ChatConversation[] {
  const legacyMessages = snapshot.messages === undefined ? [] : normalizeLegacyMessages(snapshot.messages, now);
  let normalized: ChatConversation[];

  if (snapshot.conversations === undefined) {
    normalized = legacyMessages.length
      ? [
          {
            id: nonEmptyString(snapshot.activeConversationId) ?? 'conversation-default',
            title: conversationTitle(legacyMessages),
            createdAt: legacyMessages[0]?.createdAt ?? now,
            updatedAt: legacyMessages[legacyMessages.length - 1]?.createdAt ?? now,
            messages: legacyMessages,
          },
        ]
      : [];
  } else {
    normalized = arrayField(snapshot.conversations, 'conversations').map((conversation, index) =>
      normalizeConversation(conversation, index, now)
    );
    if (!normalized.length && legacyMessages.length) {
      normalized = [
        {
          id: nonEmptyString(snapshot.activeConversationId) ?? 'conversation-default',
          title: conversationTitle(legacyMessages),
          createdAt: legacyMessages[0]?.createdAt ?? now,
          updatedAt: legacyMessages[legacyMessages.length - 1]?.createdAt ?? now,
          messages: legacyMessages,
        },
      ];
    }
  }

  if (!normalized.length) {
    return createDefaultWorkspace().conversations;
  }

  const seen = new Set<string>();
  return normalized.map((conversation, index) => {
    if (!seen.has(conversation.id)) {
      seen.add(conversation.id);
      return conversation;
    }
    const id = `${conversation.id}-recovered-${index + 1}`;
    seen.add(id);
    return { ...conversation, id };
  });
}

function normalizeParameterSettings(value: unknown): ModelParameterSettings {
  const settings = recordField(value, 'parameterSettings');
  const bounded = (candidate: unknown, fallback: number, min: number, max: number) =>
    Math.max(min, Math.min(max, finiteNumber(candidate, fallback)));
  return {
    enabled: typeof settings.enabled === 'boolean' ? settings.enabled : defaultParameterSettings.enabled,
    temperature: bounded(settings.temperature, defaultParameterSettings.temperature, 0, 2),
    topP: bounded(settings.topP, defaultParameterSettings.topP, 0, 1),
    presencePenalty: bounded(settings.presencePenalty, defaultParameterSettings.presencePenalty, -2, 2),
    frequencyPenalty: bounded(settings.frequencyPenalty, defaultParameterSettings.frequencyPenalty, -2, 2),
  };
}

function normalizePlugins(
  value: unknown,
  providers: ProviderProfile[],
  includeAuthorization = false
): PluginManifest[] {
  const candidates = arrayField(value, 'plugins');
  if (candidates.length > MAX_PLUGIN_MANIFESTS) {
    throw shapeError(`plugins 最多允许 ${MAX_PLUGIN_MANIFESTS} 项。`);
  }
  const providerIds = new Set(providers.map((provider) => provider.id));
  const providersById = new Map(providers.map((provider) => [provider.id, provider] as const));
  const pluginIds = new Set<string>();
  const serverLabels = new Set<string>();
  return candidates.map((plugin, index) => {
    if (!isRecord(plugin)) {
      throw shapeError(`plugins[${index}] 必须是对象。`);
    }
    const id = nonEmptyString(plugin.id);
    if (!id || !isLegacyWorkspaceId(id)) {
      throw shapeError(`plugins[${index}].id 无效。`);
    }
    if (pluginIds.has(id)) {
      throw shapeError(`plugins[${index}].id 与其他插件重复。`);
    }
    pluginIds.add(id);
    const type = plugin.type === 'remote-mcp' ? 'remote-mcp' : 'mobile-js';
    const permissions = Array.isArray(plugin.permissions)
      ? Array.from(
          new Set(
            plugin.permissions.filter(
              (permission): permission is PluginManifest['permissions'][number] =>
                typeof permission === 'string' && pluginPermissions.has(permission as PluginManifest['permissions'][number])
            )
          )
        )
      : [];
    const transport = plugin.transport === 'streamable-http' || plugin.transport === 'sse'
      ? plugin.transport
      : undefined;
    const allowedTools = normalizeMcpAllowedTools(plugin.allowedTools);
    if (
      plugin.allowedTools !== undefined &&
      (!Array.isArray(plugin.allowedTools) ||
        plugin.allowedTools.length > MAX_MCP_ALLOWED_TOOLS ||
        (plugin.allowedTools.length > 0 && allowedTools.length === 0))
    ) {
      throw shapeError(`plugins[${index}].allowedTools 无效。`);
    }
    let endpoint: string | undefined;
    if (typeof plugin.endpoint === 'string' && plugin.endpoint.trim()) {
      endpoint = normalizeRemoteMcpEndpoint(plugin.endpoint);
      if (!endpoint) {
        throw shapeError(
          `plugins[${index}].endpoint 无效：MCP endpoint 必须是无内嵌凭据、查询参数和片段的远程公网 HTTPS URL。`
        );
      }
    }
    const serverLabel = plugin.serverLabel === undefined
      ? undefined
      : normalizeMcpServerLabel(plugin.serverLabel);
    if (plugin.serverLabel !== undefined && !serverLabel) {
      throw shapeError(`plugins[${index}].serverLabel 无效。`);
    }
    if (serverLabel && serverLabels.has(serverLabel)) {
      throw shapeError(`plugins[${index}].serverLabel 与其他插件重复。`);
    }
    if (serverLabel) serverLabels.add(serverLabel);
    const providerId = nonEmptyString(plugin.providerId);
    if (
      plugin.providerId !== undefined &&
      (!providerId || !isLegacyWorkspaceId(providerId) || !providerIds.has(providerId))
    ) {
      throw shapeError(`plugins[${index}].providerId 不存在。`);
    }
    const description = plugin.description === undefined
      ? undefined
      : normalizeMcpDescription(plugin.description);
    if (plugin.description !== undefined && !description) {
      throw shapeError(`plugins[${index}].description 无效。`);
    }
    const authorization = !includeAuthorization || plugin.authorization === undefined
      ? undefined
      : normalizeMcpAuthorization(plugin.authorization);
    if (includeAuthorization && plugin.authorization !== undefined && !authorization) {
      throw shapeError(`plugins[${index}].authorization 无效。`);
    }
    const normalized: PluginManifest = {
      id,
      name: nonEmptyString(plugin.name) ?? id,
      ...(description ? { description } : {}),
      version: nonEmptyString(plugin.version) ?? '0.0.0',
      type,
      permissions,
      allowedTools,
      ...(transport ? { transport } : {}),
      ...(endpoint ? { endpoint } : {}),
      ...(type === 'remote-mcp' ? { enabled: plugin.enabled === true } : {}),
      ...(serverLabel ? { serverLabel } : {}),
      ...(providerId ? { providerId } : {}),
      ...(authorization ? { authorization } : {}),
      ...(plugin.approvalPolicy === 'always' ? { approvalPolicy: 'always' as const } : {}),
    };
    if (
      normalized.enabled === true &&
      (
        !getRemoteMcpExecutableReadiness(normalized, providerIds).executable ||
        !providerId ||
        !isExactOfficialOpenAiProvider(providersById.get(providerId)!)
      )
    ) {
      normalized.enabled = false;
    }
    return normalized;
  });
}

export async function loadColorMode(): Promise<ColorMode> {
  const value = await AsyncStorage.getItem(COLOR_MODE_KEY);
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

export async function saveColorMode(colorMode: ColorMode): Promise<void> {
  await AsyncStorage.setItem(COLOR_MODE_KEY, colorMode);
}

function normalizeModelCapabilities(provider: ProviderProfile, model: ModelInfo): ModelInfo {
  const inferred = createModelInfoFromId(provider, model.id, model.source, { id: model.id, name: model.name });
  const applyOverrides = (base: Capability[]) => {
    const resolved = new Set(base);
    for (const [capability, enabled] of Object.entries(model.capabilityOverrides ?? {}) as Array<
      [Capability, boolean]
    >) {
      if (enabled) resolved.add(capability);
      else resolved.delete(capability);
    }
    return Array.from(resolved);
  };

  if (model.source === 'remote') {
    return {
      ...model,
      capabilities: applyOverrides(model.capabilities?.length ? model.capabilities : inferred.capabilities),
      supportedReasoningEfforts: model.supportedReasoningEfforts ?? inferred.supportedReasoningEfforts,
      task: model.task ?? inferred.task,
    };
  }

  return {
    ...model,
    capabilities: applyOverrides(Array.from(new Set([...(model.capabilities ?? []), ...inferred.capabilities]))),
    supportedReasoningEfforts: model.supportedReasoningEfforts ?? inferred.supportedReasoningEfforts,
    task: model.task ?? inferred.task ?? inferModelTask(model),
  };
}

function normalizeModelCandidates(value: unknown, providers: ProviderProfile[]): Record<string, ModelInfo[]> {
  const candidates = recordField(value, 'modelCandidatesByProvider');
  return Object.fromEntries(
    providers.map((provider) => {
      const providerCandidates = candidates[provider.id];
      if (providerCandidates === undefined) {
        return [provider.id, []];
      }
      return [
        provider.id,
        arrayField(providerCandidates, `modelCandidatesByProvider.${provider.id}`).map((model, index) =>
          normalizeModel(model, provider, `modelCandidatesByProvider.${provider.id}[${index}]`)
        ),
      ];
    })
  );
}

function normalizeReasoningMap(value: unknown): Record<string, ReasoningEffort> {
  const map = recordField(value, 'reasoningEffortByModel');
  return Object.fromEntries(
    Object.entries(map).filter(
      (entry): entry is [string, ReasoningEffort] =>
        typeof entry[1] === 'string' && reasoningEfforts.has(entry[1] as ReasoningEffort)
    )
  );
}

function normalizeActiveModels(value: unknown, providers: ProviderProfile[]): Record<string, string> {
  const stored = recordField(value, 'activeModelIdByProvider');
  return Object.fromEntries(
    providers.map((provider): readonly [string, string] => {
      const storedValue = stored[provider.id];
      const selected = typeof storedValue === 'string' ? storedValue : '';
      return [
        provider.id,
        provider.models.some((model) => model.id === selected) ? selected : provider.models[0]?.id ?? '',
      ];
    })
  );
}

function normalizePromptTemplates(value: unknown): PromptTemplate[] {
  const seen = new Set<string>();
  return arrayField(value, 'promptTemplates').slice(0, MAX_PROMPT_TEMPLATES).flatMap((template, index) => {
    if (!isRecord(template)) {
      throw shapeError(`promptTemplates[${index}] 必须是对象。`);
    }
    const id = nonEmptyString(template.id);
    const name = nonEmptyString(template.name);
    const content = typeof template.content === 'string' ? template.content : '';
    if (
      !id ||
      seen.has(id) ||
      !name ||
      unicodeCharacterLengthExceeds(name, MAX_PROMPT_TEMPLATE_NAME_LENGTH) ||
      !content.trim() ||
      unicodeCharacterLengthExceeds(content, MAX_PROMPT_TEMPLATE_CONTENT_LENGTH)
    ) {
      return [];
    }
    seen.add(id);
    const createdAt = nonNegativeFiniteNumber(template.createdAt) ?? Date.now();
    const updatedAt = nonNegativeFiniteNumber(template.updatedAt) ?? createdAt;
    const pinnedAt = nonNegativeFiniteNumber(template.pinnedAt);
    return [{
      id,
      name,
      content,
      mode: template.mode === 'system' ? 'system' as const : 'composer' as const,
      createdAt,
      updatedAt,
      ...(pinnedAt !== undefined ? { pinnedAt } : {}),
    }];
  });
}

function normalizeModelTarget(
  value: unknown,
  providers: ProviderProfile[]
): ModelTargetRef | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const providerId = nonEmptyString(value.providerId);
  const modelId = nonEmptyString(value.modelId);
  const provider = providers.find((candidate) => candidate.id === providerId);
  if (!provider || !modelId || !provider.models.some((model) => model.id === modelId)) {
    return undefined;
  }
  return { providerId: provider.id, modelId };
}

function normalizeProjects(
  value: unknown,
  providers: ProviderProfile[],
  now: number
): WorkspaceProject[] {
  const fallback = createDefaultWorkspace().projects[0];
  if (value === undefined) {
    return [{ ...fallback, createdAt: now, updatedAt: now }];
  }
  const seen = new Set<string>();
  const projects = arrayField(value, 'projects').slice(0, MAX_WORKSPACE_PROJECTS).flatMap((candidate, index) => {
    if (!isRecord(candidate)) {
      throw shapeError(`projects[${index}] 必须是对象。`);
    }
    const id = nonEmptyString(candidate.id);
    if (!isLegacyWorkspaceId(id)) {
      throw shapeError(`projects[${index}].id 无效。`);
    }
    if (seen.has(id)) {
      throw shapeError(`projects 中存在重复 ID「${id}」。`);
    }
    seen.add(id);
    const createdAt = finiteNumber(candidate.createdAt, now);
    const defaultTarget = normalizeModelTarget(candidate.defaultTarget, providers);
    const systemPrompt = typeof candidate.systemPrompt === 'string' && candidate.systemPrompt.trim()
      ? boundedCharacters(candidate.systemPrompt, MAX_WORKSPACE_PROJECT_SYSTEM_PROMPT_LENGTH)
      : undefined;
    return [{
      id,
      name: nonEmptyString(candidate.name)
        ? boundedCharacters(nonEmptyString(candidate.name)!, MAX_WORKSPACE_PROJECT_NAME_LENGTH)
        : `项目 ${index + 1}`,
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(defaultTarget ? { defaultTarget } : {}),
      createdAt,
      updatedAt: finiteNumber(candidate.updatedAt, createdAt),
    }];
  });
  return projects.length ? projects : [{ ...fallback, createdAt: now, updatedAt: now }];
}

function validWorkspaceEntityId(value: unknown): string | undefined {
  const id = nonEmptyString(value);
  return isColonCapableWorkspaceEntityId(id) ? id : undefined;
}

function messageLookup(conversations: ChatConversation[]): {
  conversationById: Map<string, ChatConversation>;
  messagesByProjectId: Map<string, Set<string>>;
} {
  const conversationById = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  const messagesByProjectId = new Map<string, Set<string>>();
  conversations.forEach((conversation) => {
    if (!conversation.projectId) return;
    const ids = messagesByProjectId.get(conversation.projectId) ?? new Set<string>();
    conversation.messages.forEach((message) => ids.add(message.id));
    messagesByProjectId.set(conversation.projectId, ids);
  });
  return { conversationById, messagesByProjectId };
}

function normalizeArtifactRevision(
  value: unknown,
  label: string,
  fallbackCreatedAt: number,
  messageIds: Set<string>
): WorkspaceArtifactRevision | undefined {
  if (!isRecord(value)) {
    throw shapeError(`${label} 必须是对象。`);
  }
  const id = validWorkspaceEntityId(value.id);
  if (!id || typeof value.content !== 'string') {
    return undefined;
  }
  const sourceMessageId = validWorkspaceEntityId(value.sourceMessageId);
  return {
    id,
    content: boundedCharacters(value.content, MAX_WORKSPACE_ARTIFACT_CONTENT_LENGTH),
    createdAt: finiteNumber(value.createdAt, fallbackCreatedAt),
    author: value.author === 'assistant' ? 'assistant' : 'user',
    ...(sourceMessageId && messageIds.has(sourceMessageId) ? { sourceMessageId } : {}),
  };
}

function normalizeArtifacts(
  value: unknown,
  projects: WorkspaceProject[],
  conversations: ChatConversation[],
  now: number
): WorkspaceArtifact[] {
  if (value === undefined) {
    return [];
  }
  const projectIds = new Set(projects.map((project) => project.id));
  const { conversationById, messagesByProjectId } = messageLookup(conversations);
  const seenArtifactIds = new Set<string>();
  const normalized = arrayField(value, 'artifacts').slice(0, MAX_WORKSPACE_ARTIFACTS).flatMap((candidate, index) => {
    if (!isRecord(candidate)) {
      throw shapeError(`artifacts[${index}] 必须是对象。`);
    }
    const id = validWorkspaceEntityId(candidate.id);
    const projectId = validWorkspaceEntityId(candidate.projectId);
    if (!id || seenArtifactIds.has(id) || !projectId || !projectIds.has(projectId)) {
      return [];
    }
    const createdAt = finiteNumber(candidate.createdAt, now);
    const projectMessageIds = messagesByProjectId.get(projectId) ?? new Set<string>();
    const seenRevisionIds = new Set<string>();
    const revisions = arrayField(candidate.revisions, `artifacts[${index}].revisions`)
      .slice(-MAX_WORKSPACE_ARTIFACT_REVISIONS)
      .flatMap((revision, revisionIndex) => {
        const normalized = normalizeArtifactRevision(
          revision,
          `artifacts[${index}].revisions[${revisionIndex}]`,
          createdAt + revisionIndex,
          projectMessageIds
        );
        if (!normalized || seenRevisionIds.has(normalized.id)) {
          return [];
        }
        seenRevisionIds.add(normalized.id);
        return [normalized];
      });
    if (!revisions.length) {
      return [];
    }
    const format = typeof candidate.format === 'string' && artifactFormats.has(candidate.format as WorkspaceArtifactFormat)
      ? (candidate.format as WorkspaceArtifactFormat)
      : 'plain-text';
    const requestedActiveRevisionId = validWorkspaceEntityId(candidate.activeRevisionId);
    const activeRevisionId = requestedActiveRevisionId && seenRevisionIds.has(requestedActiveRevisionId)
      ? requestedActiveRevisionId
      : revisions[revisions.length - 1].id;
    const requestedConversationId = validWorkspaceEntityId(candidate.sourceConversationId);
    const sourceConversation = requestedConversationId
      ? conversationById.get(requestedConversationId)
      : undefined;
    const sourceConversationId = sourceConversation?.projectId === projectId
      ? sourceConversation.id
      : undefined;
    const requestedMessageId = validWorkspaceEntityId(candidate.sourceMessageId);
    const sourceMessageId = requestedMessageId && (
      sourceConversationId
        ? sourceConversation!.messages.some((message) => message.id === requestedMessageId)
        : projectMessageIds.has(requestedMessageId)
    )
      ? requestedMessageId
      : undefined;
    seenArtifactIds.add(id);
    return [{
      id,
      projectId,
      title: nonEmptyString(candidate.title)
        ? boundedCharacters(nonEmptyString(candidate.title)!, MAX_WORKSPACE_ARTIFACT_TITLE_LENGTH)
        : `成果 ${index + 1}`,
      format,
      ...(nonEmptyString(candidate.language)
        ? { language: boundedCharacters(nonEmptyString(candidate.language)!, MAX_WORKSPACE_ARTIFACT_LANGUAGE_LENGTH) }
        : {}),
      revisions,
      activeRevisionId,
      ...(sourceConversationId ? { sourceConversationId } : {}),
      ...(sourceMessageId ? { sourceMessageId } : {}),
      createdAt,
      updatedAt: finiteNumber(candidate.updatedAt, createdAt),
    }];
  });
  if (workspaceArtifactContentBytes(normalized) > MAX_WORKSPACE_ARTIFACT_TOTAL_BYTES) {
    throw new PersistedWorkspaceBudgetError(
      `成果全部版本正文超过 ${MAX_WORKSPACE_ARTIFACT_TOTAL_BYTES} UTF-8 字节；拒绝静默删除任何成果。`
    );
  }
  return normalized;
}

function normalizeKnowledgeSources(
  value: unknown,
  projects: WorkspaceProject[],
  artifacts: WorkspaceArtifact[],
  conversations: ChatConversation[],
  now: number
): ProjectKnowledgeSource[] {
  if (value === undefined) {
    return [];
  }
  const projectIds = new Set(projects.map((project) => project.id));
  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const { conversationById, messagesByProjectId } = messageLookup(conversations);
  const seen = new Set<string>();
  const normalized = arrayField(value, 'knowledgeSources').slice(0, MAX_PROJECT_KNOWLEDGE_SOURCES).flatMap((candidate, index) => {
    if (!isRecord(candidate)) {
      throw shapeError(`knowledgeSources[${index}] 必须是对象。`);
    }
    const id = validWorkspaceEntityId(candidate.id);
    const projectId = validWorkspaceEntityId(candidate.projectId);
    if (!id || seen.has(id) || !projectId || !projectIds.has(projectId) || typeof candidate.content !== 'string') {
      return [];
    }
    const kind = typeof candidate.kind === 'string' && knowledgeKinds.has(candidate.kind as ProjectKnowledgeKind)
      ? (candidate.kind as ProjectKnowledgeKind)
      : 'text';
    const projectMessageIds = messagesByProjectId.get(projectId) ?? new Set<string>();
    const requestedArtifactId = validWorkspaceEntityId(candidate.sourceArtifactId);
    const sourceArtifactId = requestedArtifactId && artifactById.get(requestedArtifactId)?.projectId === projectId
      ? requestedArtifactId
      : undefined;
    const requestedConversationId = validWorkspaceEntityId(candidate.sourceConversationId);
    const sourceConversation = requestedConversationId
      ? conversationById.get(requestedConversationId)
      : undefined;
    const sourceConversationId = sourceConversation?.projectId === projectId
      ? sourceConversation.id
      : undefined;
    const requestedMessageId = validWorkspaceEntityId(candidate.sourceMessageId);
    const sourceMessageId = requestedMessageId && (
      sourceConversationId
        ? sourceConversation!.messages.some((message) => message.id === requestedMessageId)
        : projectMessageIds.has(requestedMessageId)
    )
      ? requestedMessageId
      : undefined;
    const createdAt = finiteNumber(candidate.createdAt, now);
    seen.add(id);
    return [{
      id,
      projectId,
      title: nonEmptyString(candidate.title)
        ? boundedCharacters(nonEmptyString(candidate.title)!, MAX_PROJECT_KNOWLEDGE_TITLE_CHARACTERS)
        : `资料 ${index + 1}`,
      kind,
      content: boundedCharacters(candidate.content, MAX_PROJECT_KNOWLEDGE_SOURCE_CHARACTERS),
      ...(nonEmptyString(candidate.mimeType)
        ? { mimeType: boundedCharacters(nonEmptyString(candidate.mimeType)!, MAX_PROJECT_KNOWLEDGE_MIME_TYPE_CHARACTERS) }
        : {}),
      ...(nonEmptyString(candidate.fileName)
        ? { fileName: boundedCharacters(nonEmptyString(candidate.fileName)!, MAX_PROJECT_KNOWLEDGE_FILE_NAME_CHARACTERS) }
        : {}),
      ...(sourceArtifactId ? { sourceArtifactId } : {}),
      ...(sourceConversationId ? { sourceConversationId } : {}),
      ...(sourceMessageId ? { sourceMessageId } : {}),
      createdAt,
      updatedAt: finiteNumber(candidate.updatedAt, createdAt),
    }];
  });
  if (projectKnowledgeContentBytes(normalized) > MAX_PROJECT_KNOWLEDGE_TOTAL_BYTES) {
    throw new PersistedWorkspaceBudgetError(
      `项目资料正文超过 ${MAX_PROJECT_KNOWLEDGE_TOTAL_BYTES} UTF-8 字节；拒绝静默删除任何资料。`
    );
  }
  return normalized;
}

function normalizeConversationKnowledgeRefs(
  conversations: ChatConversation[],
  knowledgeSources: ProjectKnowledgeSource[]
): ChatConversation[] {
  const knowledgeById = new Map(knowledgeSources.map((source) => [source.id, source]));
  return conversations.map((conversation) => {
    const knowledgeSourceIds = Array.from(new Set(conversation.knowledgeSourceIds ?? []))
      .filter((id) => knowledgeById.get(id)?.projectId === conversation.projectId)
      .slice(0, MAX_PROJECT_KNOWLEDGE_CONTEXT_SOURCES);
    return {
      ...conversation,
      ...(knowledgeSourceIds.length ? { knowledgeSourceIds } : { knowledgeSourceIds: undefined }),
    };
  });
}

function normalizeConversationStructure(
  conversations: ChatConversation[],
  projects: WorkspaceProject[]
): ChatConversation[] {
  const projectIds = new Set(projects.map((project) => project.id));
  const defaultProjectId = projects[0].id;
  const projectNormalized = conversations.map((conversation) => ({
    ...conversation,
    projectId: conversation.projectId && projectIds.has(conversation.projectId)
      ? conversation.projectId
      : defaultProjectId,
  }));
  const conversationMap = new Map(
    projectNormalized.map((conversation) => [conversation.id, conversation])
  );
  const normalized = projectNormalized.map((conversation) => {
    const parent = conversation.parentConversationId
      ? conversationMap.get(conversation.parentConversationId)
      : undefined;
    const branchPointValid = Boolean(
      parent &&
      parent.id !== conversation.id &&
      parent.projectId === conversation.projectId &&
      conversation.branchPointMessageId &&
      conversation.branchPointMessageId !== 'welcome' &&
      parent.messages.some((message) => message.id === conversation.branchPointMessageId)
    );
    return {
      ...conversation,
      ...(branchPointValid
        ? {
            parentConversationId: parent!.id,
            branchPointMessageId: conversation.branchPointMessageId,
          }
        : {
            parentConversationId: undefined,
            branchPointMessageId: undefined,
          }),
    };
  });
  const byId = new Map(normalized.map((conversation) => [conversation.id, conversation]));
  return normalized.map((conversation) => {
    const visited = new Set([conversation.id]);
    let parentId = conversation.parentConversationId;
    while (parentId) {
      if (visited.has(parentId)) {
        return { ...conversation, parentConversationId: undefined, branchPointMessageId: undefined };
      }
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentConversationId;
    }
    return conversation;
  });
}

function normalizeComparisonTargets(value: unknown, providers: ProviderProfile[]): ModelTargetRef[] {
  const seen = new Set<string>();
  return arrayField(value, 'comparisonTargets').slice(0, 4).flatMap((target, index) => {
    const normalized = normalizeModelTarget(target, providers);
    if (!normalized) {
      return [];
    }
    const provider = providers.find((candidate) => candidate.id === normalized.providerId)!;
    const model = provider.models.find((candidate) => candidate.id === normalized.modelId)!;
    const key = providerModelIdentityKey(normalized.providerId, normalized.modelId);
    if (seen.has(key) || inferModelTask(model) !== 'chat') {
      return [];
    }
    seen.add(key);
    return [normalized];
  });
}

function normalizeModelPricing(value: unknown, providers: ProviderProfile[]): ModelPricing[] {
  const seen = new Set<string>();
  return arrayField(value, 'modelPricing').slice(0, 1_000).flatMap((entry, index) => {
    if (!isRecord(entry)) {
      throw shapeError(`modelPricing[${index}] 必须是对象。`);
    }
    const target = normalizeModelTarget(entry, providers);
    const currency = typeof entry.currency === 'string' && pricingCurrencies.has(entry.currency as PricingCurrency)
      ? (entry.currency as PricingCurrency)
      : undefined;
    if (!target || !currency) {
      return [];
    }
    const key = providerModelCurrencyIdentityKey(target.providerId, target.modelId, currency);
    if (seen.has(key)) {
      return [];
    }
    const boundedPrice = (candidate: unknown) => {
      const price = nonNegativeFiniteNumber(candidate);
      return price === undefined ? undefined : Math.min(price, 1_000_000_000);
    };
    const inputPerMillion = boundedPrice(entry.inputPerMillion);
    const cachedInputPerMillion = boundedPrice(entry.cachedInputPerMillion);
    const outputPerMillion = boundedPrice(entry.outputPerMillion);
    if (inputPerMillion === undefined && cachedInputPerMillion === undefined && outputPerMillion === undefined) {
      return [];
    }
    seen.add(key);
    return [{
      ...target,
      currency,
      ...(inputPerMillion !== undefined ? { inputPerMillion } : {}),
      ...(cachedInputPerMillion !== undefined ? { cachedInputPerMillion } : {}),
      ...(outputPerMillion !== undefined ? { outputPerMillion } : {}),
      updatedAt: nonNegativeFiniteNumber(entry.updatedAt) ?? Date.now(),
    }];
  });
}

function normalizeWebSearchSettings(value: unknown): WebSearchSettings {
  const settings = recordField(value, 'webSearch');
  const searchContextSize = typeof settings.searchContextSize === 'string' &&
      searchContextSizes.has(settings.searchContextSize as WebSearchSettings['searchContextSize'])
    ? (settings.searchContextSize as WebSearchSettings['searchContextSize'])
    : 'medium';
  return {
    enabled: settings.enabled === true,
    searchContextSize,
  };
}

function normalizeVoiceSettings(value: unknown, providers: ProviderProfile[]): VoiceSettings {
  const settings = recordField(value, 'voice');
  const transcriptionTarget = normalizeModelTarget(
    settings.transcriptionTarget,
    providers
  );
  const speechTarget = normalizeModelTarget(settings.speechTarget, providers);
  const speechFormat = typeof settings.speechFormat === 'string' &&
      speechFormats.has(settings.speechFormat as VoiceSettings['speechFormat'])
    ? (settings.speechFormat as VoiceSettings['speechFormat'])
    : 'mp3';
  return {
    ...(transcriptionTarget ? { transcriptionTarget } : {}),
    ...(speechTarget ? { speechTarget } : {}),
    speechVoice: nonEmptyString(settings.speechVoice)?.slice(0, 120) ?? 'alloy',
    speechFormat,
  };
}

function normalizeCostGuardSettings(value: unknown): CostGuardSettings {
  const settings = value === undefined ? {} : recordField(value, 'costGuard');
  const integer = (candidate: unknown, fallback: number, min: number, max: number) =>
    Math.max(min, Math.min(max, Math.trunc(finiteNumber(candidate, fallback))));
  const nonNegative = (candidate: unknown, fallback: number) =>
    Math.max(0, Math.min(1_000_000_000, finiteNumber(candidate, fallback)));
  const maxComparisonTargets = integer(
    settings.maxComparisonTargets,
    defaultCostGuardSettings.maxComparisonTargets,
    2,
    4
  ) as CostGuardSettings['maxComparisonTargets'];
  return {
    enabled: settings.enabled === true,
    maxOutputTokens: integer(
      settings.maxOutputTokens,
      defaultCostGuardSettings.maxOutputTokens,
      64,
      131_072
    ),
    maxComparisonTargets,
    dailyRequestLimit: integer(
      settings.dailyRequestLimit,
      defaultCostGuardSettings.dailyRequestLimit,
      0,
      10_000
    ),
    dailyCnyBudget: nonNegative(settings.dailyCnyBudget, defaultCostGuardSettings.dailyCnyBudget),
    dailyUsdBudget: nonNegative(settings.dailyUsdBudget, defaultCostGuardSettings.dailyUsdBudget),
    limitAction: settings.limitAction === 'warn' ? 'warn' : 'block',
    unknownCostAction: settings.unknownCostAction === 'block' ? 'block' : 'warn',
    confirmPotentialMultipleCharges: settings.confirmPotentialMultipleCharges !== false,
  };
}

function localDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  const part = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}`;
}

function validLocalDateKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function inferredUsageKind(message: ChatMessage): ProviderUsageKind {
  if (message.generationTask?.kind === 'video' || message.attachments?.some((item) => item.kind === 'video')) {
    return 'video-generation';
  }
  if (message.attachments?.some((item) => item.kind === 'image')) {
    return 'image-generation';
  }
  return message.webSearchTriggered ? 'web-search' : 'chat';
}

function derivedProviderUsageEvents(conversations: ChatConversation[]): ProviderUsageEvent[] {
  const seen = new Set<string>();
  return conversations.flatMap((conversation) => conversation.messages.flatMap((message) => {
    if (message.role !== 'assistant' || !message.providerId || !message.modelId || message.id === 'welcome') {
      return [];
    }
    const canonicalId = message.originMessageId ?? message.id;
    if (seen.has(canonicalId)) {
      return [];
    }
    seen.add(canonicalId);
    const kind = inferredUsageKind(message);
    return [{
      id: `migrated-${canonicalId}`,
      kind,
      status: message.status === 'cancelled'
        ? 'cancelled' as const
        : message.status === 'error'
          ? 'failed' as const
          : 'succeeded' as const,
      providerRequestCount: 1,
      providerId: message.providerId,
      modelId: message.modelId,
      createdAt: message.createdAt,
      localDateKey: localDateKey(message.createdAt),
      completedAt: message.createdAt,
      messageId: canonicalId,
      ...(message.comparisonGroupId ? { comparisonGroupId: message.comparisonGroupId } : {}),
      ...(message.costEstimate ? { knownCostEstimate: { ...message.costEstimate } } : {}),
      unknownCostComponents: [
        ...(!message.costEstimate ? ['input-tokens', 'output-tokens'] as UnknownCostComponent[] : []),
        ...(kind === 'web-search' ? ['web-search-tool'] as UnknownCostComponent[] : []),
        ...(kind === 'image-generation' ? ['image-output'] as UnknownCostComponent[] : []),
        ...(kind === 'video-generation' ? ['video-output'] as UnknownCostComponent[] : []),
        ...(message.status === 'error' || message.status === 'cancelled'
          ? ['failed-or-cancelled-request'] as UnknownCostComponent[]
          : []),
      ],
    }];
  }));
}

function normalizeProviderUsageEvents(
  value: unknown,
  conversations: ChatConversation[]
): ProviderUsageEvent[] {
  if (value === undefined) {
    return derivedProviderUsageEvents(conversations).slice(-10_000);
  }
  const seen = new Set<string>();
  return arrayField(value, 'providerUsageEvents').slice(-10_000).map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw shapeError(`providerUsageEvents[${index}] 必须是对象。`);
    }
    const id = nonEmptyString(candidate.id);
    const providerId = nonEmptyString(candidate.providerId);
    const modelId = nonEmptyString(candidate.modelId);
    const kind = typeof candidate.kind === 'string' && providerUsageKinds.has(candidate.kind as ProviderUsageKind)
      ? candidate.kind as ProviderUsageKind
      : undefined;
    if (!id || !providerId || !modelId || !kind || seen.has(id)) {
      throw shapeError(`providerUsageEvents[${index}] 缺少有效且唯一的字段。`);
    }
    seen.add(id);
    const status = candidate.status === 'started' || candidate.status === 'succeeded' ||
      candidate.status === 'failed' || candidate.status === 'cancelled'
      ? candidate.status
      : 'failed';
    const knownCostEstimate = normalizeCostEstimate(
      candidate.knownCostEstimate,
      `providerUsageEvents[${index}].knownCostEstimate`
    );
    const providerRequestCount = candidate.providerRequestCount === undefined
      ? 1
      : candidate.providerRequestCount;
    if (!Number.isSafeInteger(providerRequestCount) || (providerRequestCount as number) <= 0) {
      throw shapeError(
        `providerUsageEvents[${index}].providerRequestCount 必须是正安全整数。`
      );
    }
    const unknownCostComponents = candidate.unknownCostComponents === undefined
      ? []
      : Array.from(new Set(
          arrayField(candidate.unknownCostComponents, `providerUsageEvents[${index}].unknownCostComponents`)
            .filter((component): component is UnknownCostComponent => typeof component === 'string' && [
              'input-tokens',
              'output-tokens',
              'web-search-tool',
              'speech',
              'transcription',
              'image-output',
              'video-output',
              'provider-surcharge',
              'failed-or-cancelled-request',
            ].includes(component))
        ));
    const createdAt = finiteNumber(candidate.createdAt, Date.now());
    return {
      id,
      kind,
      status,
      providerRequestCount: providerRequestCount as number,
      providerId,
      modelId,
      createdAt,
      localDateKey: validLocalDateKey(candidate.localDateKey)
        ? candidate.localDateKey
        : localDateKey(createdAt),
      ...(optionalFiniteNumber(candidate.completedAt) !== undefined
        ? { completedAt: optionalFiniteNumber(candidate.completedAt) }
        : {}),
      ...(nonEmptyString(candidate.messageId) ? { messageId: nonEmptyString(candidate.messageId) } : {}),
      ...(nonEmptyString(candidate.comparisonGroupId)
        ? { comparisonGroupId: nonEmptyString(candidate.comparisonGroupId) }
        : {}),
      ...(knownCostEstimate ? { knownCostEstimate } : {}),
      unknownCostComponents,
    };
  });
}

function normalizeWorkspace(snapshot: Record<string, unknown>, providers: ProviderProfile[]): AppWorkspace {
  const now = Date.now();
  const modelCandidatesByProvider = normalizeModelCandidates(snapshot.modelCandidatesByProvider, providers);
  const normalizedProviders = providers.map((provider) => {
    const isArkProvider = isVolcengineArkProvider(provider);
    const addedModels = provider.models
      .filter(
        (model) => model.source !== 'preset' && !(isArkProvider && model.source !== 'remote' && isArkStaticDoubaoModelId(model.id))
      )
      .map((model) => normalizeModelCapabilities(provider, model));
    const retainedCandidates = (modelCandidatesByProvider[provider.id] ?? [])
      .filter(
        (model) => model.source !== 'preset' && !(isArkProvider && model.source !== 'remote' && isArkStaticDoubaoModelId(model.id))
      )
      .map((model) => normalizeModelCapabilities(provider, model));
    modelCandidatesByProvider[provider.id] = retainedCandidates;
    return { ...provider, models: addedModels };
  });
  const projects = normalizeProjects(snapshot.projects, normalizedProviders, now);
  const structuredConversations = normalizeConversationStructure(normalizeConversations(snapshot, now), projects);
  const artifacts = normalizeArtifacts(snapshot.artifacts, projects, structuredConversations, now);
  const knowledgeSources = normalizeKnowledgeSources(
    snapshot.knowledgeSources,
    projects,
    artifacts,
    structuredConversations,
    now
  );
  const conversations = normalizeConversationKnowledgeRefs(structuredConversations, knowledgeSources);
  const requestedConversationId = nonEmptyString(snapshot.activeConversationId);
  const activeConversationId = conversations.some((conversation) => conversation.id === requestedConversationId)
    ? requestedConversationId!
    : conversations[0].id;
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId)!;
  const activeProjectId = activeConversation.projectId ?? projects[0].id;
  const requestedProviderId = nonEmptyString(snapshot.activeProviderId);
  const activeProviderId = normalizedProviders.some((provider) => provider.id === requestedProviderId)
    ? requestedProviderId!
    : normalizedProviders[0].id;
  const comparisonTargets = normalizeComparisonTargets(snapshot.comparisonTargets, normalizedProviders);

  return {
    providers: normalizedProviders,
    activeProviderId,
    activeModelIdByProvider: normalizeActiveModels(snapshot.activeModelIdByProvider, normalizedProviders),
    reasoningEffortByModel: normalizeReasoningMap(snapshot.reasoningEffortByModel),
    parameterSettings: normalizeParameterSettings(snapshot.parameterSettings),
    modelCandidatesByProvider,
    activeProjectId,
    projects,
    artifacts,
    knowledgeSources,
    activeConversationId,
    conversations,
    messages: activeConversation.messages,
    plugins: normalizePlugins(snapshot.plugins, normalizedProviders),
    promptTemplates: normalizePromptTemplates(snapshot.promptTemplates),
    comparisonEnabled: snapshot.comparisonEnabled === true && comparisonTargets.length >= 2,
    comparisonTargets,
    modelPricing: normalizeModelPricing(snapshot.modelPricing, normalizedProviders),
    costGuard: normalizeCostGuardSettings(snapshot.costGuard),
    providerUsageEvents: normalizeProviderUsageEvents(snapshot.providerUsageEvents, conversations),
    webSearch: normalizeWebSearchSettings(snapshot.webSearch),
    voice: normalizeVoiceSettings(snapshot.voice, normalizedProviders),
  };
}

function secretKey(providerId: string): string {
  return `${SECRET_PREFIX}.${providerId}`;
}

function pluginSecretKey(pluginId: string): string {
  return `${PLUGIN_SECRET_PREFIX}.${pluginId}`;
}

function providerBindingsById(
  providers: readonly ProviderProfile[]
): ReadonlyMap<string, string> {
  const bindings = new Map<string, string>();
  for (const provider of providers) {
    const binding = providerEndpointFingerprint(provider);
    if (binding) bindings.set(provider.id, binding);
  }
  return bindings;
}

function decodeBoundSecret(value: string | null): BoundSecretEnvelope | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !isRecord(parsed) ||
      parsed.schemaVersion !== BOUND_SECRET_SCHEMA_VERSION ||
      typeof parsed.bindingFingerprint !== 'string' ||
      !parsed.bindingFingerprint ||
      typeof parsed.secret !== 'string' ||
      !parsed.secret
    ) {
      return undefined;
    }
    return {
      schemaVersion: BOUND_SECRET_SCHEMA_VERSION,
      bindingFingerprint: parsed.bindingFingerprint,
      secret: parsed.secret,
    };
  } catch {
    return undefined;
  }
}

function secretForBinding(
  envelope: BoundSecretEnvelope | undefined,
  bindingFingerprint: string | undefined
): string | undefined {
  return envelope && bindingFingerprint === envelope.bindingFingerprint
    ? envelope.secret
    : undefined;
}

function boundSecret(
  bindingFingerprint: string | undefined,
  secret: string
): BoundSecretEnvelope {
  if (!bindingFingerprint) {
    throw new Error('无法把密钥安全绑定到无效或未完成的服务端配置。');
  }
  return {
    schemaVersion: BOUND_SECRET_SCHEMA_VERSION,
    bindingFingerprint,
    secret,
  };
}

function browserSessionStorage(): Storage | undefined {
  if (Platform.OS !== 'web') {
    return undefined;
  }
  try {
    return typeof globalThis.sessionStorage === 'undefined' ? undefined : globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

async function requireNativeSecureStore(): Promise<void> {
  if (secureStoreAvailable) {
    return;
  }
  let available: boolean;
  try {
    available = await SecureStore.isAvailableAsync();
  } catch (error) {
    throw new Error(`安全存储检查失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!available) {
    throw new Error('当前原生环境无法使用安全存储；为避免 API Key 明文落盘，已拒绝继续。');
  }
  secureStoreAvailable = true;
}

async function readSecret(provider: Pick<ProviderProfile, 'id' | 'kind' | 'baseUrl'>): Promise<string | undefined> {
  const bindingFingerprint = providerEndpointFingerprint(provider);
  if (secretValues.has(provider.id)) {
    return secretForBinding(secretValues.get(provider.id), bindingFingerprint);
  }
  const key = secretKey(provider.id);
  let value: string | null;
  if (Platform.OS === 'web') {
    const session = browserSessionStorage();
    value = session?.getItem(key) ?? null;
    const legacyValue = await AsyncStorage.getItem(key);
    if (legacyValue !== null) {
      await AsyncStorage.removeItem(key);
      if (value === null) {
        value = legacyValue;
      }
    }
  } else {
    await requireNativeSecureStore();
    value = await SecureStore.getItemAsync(key);
  }
  let envelope = decodeBoundSecret(value);
  if (value !== null && !envelope && bindingFingerprint) {
    // One-time v1.1 migration: the decoded workspace is the only persisted
    // configuration available to bind against. Rewrite before returning so
    // every subsequent hydrate can enforce an exact protocol/endpoint match.
    await writeSecret(provider.id, bindingFingerprint, value);
    envelope = secretValues.get(provider.id);
  } else if (value !== null && !envelope) {
    // Without a valid persisted binding, a legacy bare value cannot be safely
    // attributed and must never be hydrated.
    try {
      if (Platform.OS === 'web') {
        browserSessionStorage()?.removeItem(key);
      } else {
        await SecureStore.deleteItemAsync(key);
      }
    } catch {
      // Cleanup is best-effort; an undecodable value is never returned.
    }
  }
  secretValues.set(provider.id, envelope);
  return secretForBinding(envelope, bindingFingerprint);
}

async function writeSecret(
  providerId: string,
  bindingFingerprint: string | undefined,
  value?: string
): Promise<void> {
  const key = secretKey(providerId);
  const envelope = value
    ? boundSecret(bindingFingerprint, value)
    : undefined;
  const serialized = envelope ? JSON.stringify(envelope) : undefined;
  if (Platform.OS === 'web') {
    const session = browserSessionStorage();
    try {
      if (serialized) {
        session?.setItem(key, serialized);
      } else {
        session?.removeItem(key);
      }
    } catch {
      // In-memory secretValues below remains the fail-safe for this tab.
    }
    // Remove any plaintext value left by versions that used persistent Web storage.
    await AsyncStorage.removeItem(key);
  } else {
    await requireNativeSecureStore();
    if (serialized) {
      await SecureStore.setItemAsync(key, serialized);
    } else {
      await SecureStore.deleteItemAsync(key);
    }
  }
  secretValues.set(providerId, envelope);
}

async function readPluginSecret(
  plugin: PluginManifest,
  providerBindings: ReadonlyMap<string, string>
): Promise<string | undefined> {
  const bindingFingerprint = remoteMcpBindingFingerprint(plugin, providerBindings);
  if (pluginSecretValues.has(plugin.id)) {
    return secretForBinding(pluginSecretValues.get(plugin.id), bindingFingerprint);
  }
  const key = pluginSecretKey(plugin.id);
  let value: string | null;
  if (Platform.OS === 'web') {
    value = browserSessionStorage()?.getItem(key) ?? null;
    await AsyncStorage.removeItem(key);
  } else {
    await requireNativeSecureStore();
    value = await SecureStore.getItemAsync(key);
  }
  let envelope = decodeBoundSecret(value);
  if (value !== null && !envelope && bindingFingerprint) {
    await writePluginSecret(plugin.id, bindingFingerprint, value);
    envelope = pluginSecretValues.get(plugin.id);
  } else if (value !== null && !envelope) {
    try {
      if (Platform.OS === 'web') {
        browserSessionStorage()?.removeItem(key);
      } else {
        await SecureStore.deleteItemAsync(key);
      }
    } catch {
      // Cleanup is best-effort; an undecodable value is never returned.
    }
  }
  pluginSecretValues.set(plugin.id, envelope);
  return secretForBinding(envelope, bindingFingerprint);
}

async function writePluginSecret(
  pluginId: string,
  bindingFingerprint: string | undefined,
  value?: string
): Promise<void> {
  const key = pluginSecretKey(pluginId);
  const envelope = value
    ? boundSecret(bindingFingerprint, value)
    : undefined;
  const serialized = envelope ? JSON.stringify(envelope) : undefined;
  if (Platform.OS === 'web') {
    const session = browserSessionStorage();
    try {
      if (serialized) {
        session?.setItem(key, serialized);
      } else {
        session?.removeItem(key);
      }
    } catch {
      // Keep the authorization in memory for this tab only.
    }
    await AsyncStorage.removeItem(key);
  } else {
    await requireNativeSecureStore();
    if (serialized) {
      await SecureStore.setItemAsync(key, serialized);
    } else {
      await SecureStore.deleteItemAsync(key);
    }
  }
  pluginSecretValues.set(pluginId, envelope);
}

function decodeWorkspace(raw: string): DecodedWorkspace {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw shapeError(`JSON 无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) {
    throw shapeError('根节点必须是对象。');
  }

  if (parsed.schemaVersion !== undefined) {
    if (![2, 3, 4, 5, STORAGE_SCHEMA_VERSION].includes(parsed.schemaVersion as number)) {
      throw shapeError(`不支持 schemaVersion=${String(parsed.schemaVersion)}。`);
    }
    if (!isRecord(parsed.workspace)) {
      throw shapeError('workspace 必须是对象。');
    }
    return {
      revision: Math.max(0, Math.trunc(finiteNumber(parsed.revision, 0))),
      snapshot: parsed.workspace,
    };
  }

  const looksLegacy = ['providers', 'messages', 'conversations', 'activeProviderId'].some((key) => key in parsed);
  if (!looksLegacy) {
    throw shapeError('无法识别旧版工作区结构。');
  }
  return { revision: 0, snapshot: parsed };
}

async function preserveFailedSnapshot(sourceKey: string, raw: string | null, error: unknown): Promise<void> {
  try {
    await AsyncStorage.setItem(
      WORKSPACE_RECOVERY_KEY,
      JSON.stringify({
        capturedAt: Date.now(),
        sourceKey,
        error: error instanceof Error ? error.message : String(error),
        raw,
      })
    );
  } catch {
    // 保留原主键不动；即使恢复副本因配额问题写入失败，也绝不覆盖原数据。
  }
}

function blockedSaveError(): Error {
  return new Error(
    `工作区加载失败后已暂停自动保存，以免覆盖原数据。原始快照会尽力保存在 ${WORKSPACE_RECOVERY_KEY}。${
      loadFailure ? ` 原因：${loadFailure.message}` : ''
    }`
  );
}

async function hydrateWorkspace(decoded: DecodedWorkspace): Promise<AppWorkspace> {
  const persistedProviders = normalizePersistedProviders(decoded.snapshot.providers);
  const providers = await Promise.all(
    persistedProviders.map(async (provider) => ({
      ...provider,
      apiKey: await readSecret(provider),
    }))
  );
  const workspace = normalizeWorkspace(decoded.snapshot, providers);
  const providerBindings = providerBindingsById(workspace.providers);
  workspace.plugins = await Promise.all(
    workspace.plugins.map(async (plugin) => ({
      ...plugin,
      authorization: await readPluginSecret(plugin, providerBindings),
    }))
  );
  requestedRevision = Math.max(requestedRevision, decoded.revision);
  return workspace;
}

/** Returns a one-shot notice when loadWorkspace recovered from its backup. */
export function consumeStorageRecoveryNotice(): string | null {
  const notice = recoveryNotice;
  recoveryNotice = null;
  return notice;
}

export async function loadWorkspace(): Promise<AppWorkspace | null> {
  loadFailure = null;
  recoveryNotice = null;
  let sourceKey = WORKSPACE_KEY;
  let raw: string | null = null;
  try {
    raw = await AsyncStorage.getItem(WORKSPACE_KEY);
    if (raw === null) {
      for (const legacyKey of LEGACY_WORKSPACE_KEYS) {
        const legacyRaw = await AsyncStorage.getItem(legacyKey);
        if (legacyRaw !== null) {
          sourceKey = legacyKey;
          raw = legacyRaw;
          break;
        }
      }
    }
    if (raw === null) {
      loadFailure = null;
      recoveryNotice = null;
      return null;
    }

    const decoded = decodeWorkspace(raw);
    const workspace = await hydrateWorkspace(decoded);
    loadFailure = null;
    recoveryNotice = null;
    return workspace;
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    await preserveFailedSnapshot(sourceKey, raw, normalizedError);

    if (normalizedError instanceof PersistedWorkspaceBudgetError) {
      loadFailure = normalizedError;
      throw new Error(
        `工作区加载失败，已进入只读恢复状态以保护超预算原始数据；自动保存已禁用。可以从 ${WORKSPACE_RECOVERY_KEY} 恢复。${normalizedError.message}`
      );
    }

    const backupKey = sourceKey === WORKSPACE_KEY
      ? WORKSPACE_BACKUP_KEY
      : LEGACY_WORKSPACE_BACKUPS[sourceKey as (typeof LEGACY_WORKSPACE_KEYS)[number]];
    if (backupKey) {
      try {
        const backupRaw = await AsyncStorage.getItem(backupKey);
        if (backupRaw) {
          const workspace = await hydrateWorkspace(decodeWorkspace(backupRaw));
          loadFailure = null;
          recoveryNotice = '主工作区快照损坏，已自动从最近备份恢复；原始数据已保留在恢复区。';
          return workspace;
        }
      } catch (backupError) {
        const backupMessage = backupError instanceof Error ? backupError.message : String(backupError);
        loadFailure = new Error(`${normalizedError.message}；备份恢复也失败：${backupMessage}`);
      }
    }

    loadFailure ??= normalizedError;
    throw new Error(
      `工作区加载失败，已禁止自动保存以保护原数据。可从 ${WORKSPACE_RECOVERY_KEY} 恢复。${loadFailure.message}`
    );
  }
}

function stripSecret(provider: ProviderProfile): PersistedProvider {
  const persistedProvider = { ...provider };
  delete persistedProvider.apiKey;
  return persistedProvider;
}

function stripPluginSecret(plugin: PluginManifest): PersistedPlugin {
  const persistedPlugin = { ...plugin };
  delete persistedPlugin.authorization;
  return persistedPlugin;
}

function messagesForPersistence(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message, index) => {
    const normalized = message.excludedFromContext === true && message.pinnedForContext === true
      ? { ...message, pinnedForContext: undefined }
      : message;
    const mcpActivity = normalizeMcpActivity(
      normalized.mcpActivity,
      `messages[${index}].mcpActivity`
    );
    const persisted: ChatMessage = { ...normalized };
    delete persisted.mcpActivity;
    if (mcpActivity) persisted.mcpActivity = mcpActivity;
    return persisted.attachments?.length
      ? { ...persisted, attachments: persisted.attachments.map(attachmentForPersistence) }
      : persisted;
  });
}

function persistedConversations(workspace: AppWorkspace): ChatConversation[] {
  const activeId = workspace.activeConversationId || 'conversation-default';
  const existing = workspace.conversations.find((conversation) => conversation.id === activeId);
  const activeConversation: ChatConversation = {
    id: activeId,
    title: existing?.title ?? conversationTitle(workspace.messages),
    ...(existing?.customTitle ? { customTitle: true } : {}),
    ...(existing?.pinnedAt !== undefined ? { pinnedAt: existing.pinnedAt } : {}),
    projectId: existing?.projectId ?? workspace.activeProjectId ?? workspace.projects[0]?.id,
    ...(existing?.parentConversationId
      ? { parentConversationId: existing.parentConversationId }
      : {}),
    ...(existing?.branchPointMessageId
      ? { branchPointMessageId: existing.branchPointMessageId }
      : {}),
    ...(existing?.knowledgeSourceIds?.length
      ? { knowledgeSourceIds: [...existing.knowledgeSourceIds] }
      : {}),
    createdAt: existing?.createdAt ?? workspace.messages[0]?.createdAt ?? Date.now(),
    updatedAt: existing?.updatedAt ?? workspace.messages[workspace.messages.length - 1]?.createdAt ?? Date.now(),
    messages: messagesForPersistence(workspace.messages),
  };
  return [
    activeConversation,
    ...workspace.conversations
      .filter((conversation) => conversation.id !== activeId)
      .map((conversation) => ({
        ...conversation,
        messages: messagesForPersistence(conversation.messages),
      })),
  ];
}

function createEnvelope(
  workspace: AppWorkspace,
  revision: number,
  plugins: PluginManifest[]
): PersistedWorkspaceEnvelope {
  const providers = workspace.providers.length ? workspace.providers : createDefaultWorkspace().providers;
  const projects = workspace.projects.map((project) => ({
    ...project,
    ...(project.defaultTarget ? { defaultTarget: { ...project.defaultTarget } } : {}),
  }));
  const persistedConversationList = persistedConversations(workspace);
  const artifacts = normalizeArtifacts(workspace.artifacts, projects, persistedConversationList, Date.now());
  const knowledgeSources = normalizeKnowledgeSources(
    workspace.knowledgeSources,
    projects,
    artifacts,
    persistedConversationList,
    Date.now()
  );
  const conversations = normalizeConversationKnowledgeRefs(persistedConversationList, knowledgeSources);
  const activeProviderId = providers.some((provider) => provider.id === workspace.activeProviderId)
    ? workspace.activeProviderId
    : providers[0].id;
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    revision,
    savedAt: Date.now(),
    workspace: {
      providers: providers.map(stripSecret),
      activeProviderId,
      activeModelIdByProvider: { ...workspace.activeModelIdByProvider },
      reasoningEffortByModel: { ...workspace.reasoningEffortByModel },
      parameterSettings: { ...defaultParameterSettings, ...workspace.parameterSettings },
      modelCandidatesByProvider: { ...workspace.modelCandidatesByProvider },
      activeProjectId: workspace.projects.some((project) => project.id === workspace.activeProjectId)
        ? workspace.activeProjectId
        : workspace.projects[0]?.id ?? 'project-default',
      projects,
      artifacts,
      knowledgeSources,
      activeConversationId: conversations.some((conversation) => conversation.id === workspace.activeConversationId)
        ? workspace.activeConversationId
        : conversations[0].id,
      conversations,
      plugins: plugins.map(stripPluginSecret),
      promptTemplates: [...workspace.promptTemplates],
      comparisonEnabled: workspace.comparisonEnabled,
      comparisonTargets: workspace.comparisonTargets.map((target) => ({ ...target })),
      modelPricing: workspace.modelPricing.map((pricing) => ({ ...pricing })),
      costGuard: { ...workspace.costGuard },
      providerUsageEvents: normalizeProviderUsageEvents(
        workspace.providerUsageEvents,
        conversations
      ).slice(-10_000).map((event) => ({
        ...event,
        ...(event.knownCostEstimate ? { knownCostEstimate: { ...event.knownCostEstimate } } : {}),
      })),
      webSearch: { ...workspace.webSearch },
      voice: {
        ...workspace.voice,
        ...(workspace.voice.transcriptionTarget
          ? { transcriptionTarget: { ...workspace.voice.transcriptionTarget } }
          : {}),
        ...(workspace.voice.speechTarget ? { speechTarget: { ...workspace.voice.speechTarget } } : {}),
      },
    },
  };
}

async function persistSecrets(providers: ProviderProfile[], plugins: PluginManifest[]): Promise<void> {
  const providersById = new Map(providers.map((provider) => [provider.id, provider] as const));
  const providerBindings = providerBindingsById(providers);
  for (const providerId of Array.from(secretValues.keys())) {
    if (!providersById.has(providerId)) {
      const cached = secretValues.get(providerId);
      if (cached) {
        await writeSecret(providerId, undefined, undefined);
      }
      secretValues.delete(providerId);
    }
  }
  for (const provider of providers) {
    const value = provider.apiKey || undefined;
    const bindingFingerprint = providerEndpointFingerprint(provider);
    const cached = secretValues.get(provider.id);
    if (
      !secretValues.has(provider.id) ||
      cached?.bindingFingerprint !== bindingFingerprint ||
      cached?.secret !== value
    ) {
      await writeSecret(provider.id, bindingFingerprint, value);
    }
  }
  const pluginsById = new Map(plugins.map((plugin) => [plugin.id, plugin] as const));
  for (const pluginId of Array.from(pluginSecretValues.keys())) {
    if (!pluginsById.has(pluginId)) {
      const cached = pluginSecretValues.get(pluginId);
      if (cached) {
        await writePluginSecret(pluginId, undefined, undefined);
      }
      pluginSecretValues.delete(pluginId);
    }
  }
  for (const plugin of plugins) {
    const requestedValue = normalizeMcpAuthorization(plugin.authorization);
    const bindingFingerprint = remoteMcpBindingFingerprint(plugin, providerBindings);
    const cached = pluginSecretValues.get(plugin.id);
    const carriesStaleAuthorization = Boolean(
      requestedValue &&
      cached &&
      cached.bindingFingerprint !== bindingFingerprint &&
      cached.secret === requestedValue
    );
    const value = carriesStaleAuthorization ? undefined : requestedValue;
    if (
      !pluginSecretValues.has(plugin.id) ||
      cached?.bindingFingerprint !== bindingFingerprint ||
      cached?.secret !== value
    ) {
      await writePluginSecret(plugin.id, bindingFingerprint, value);
    }
  }
}

export function saveWorkspace(workspace: AppWorkspace): Promise<void> {
  if (loadFailure) {
    return Promise.reject(toWorkspaceSaveError(blockedSaveError(), 'before-public-commit'));
  }
  if (workspaceArtifactContentBytes(workspace.artifacts) > MAX_WORKSPACE_ARTIFACT_TOTAL_BYTES) {
    return Promise.reject(toWorkspaceSaveError(
      new Error('成果全部版本超过本机持久化预算，未写入任何工作区数据。'),
      'before-public-commit'
    ));
  }
  if (projectKnowledgeContentBytes(workspace.knowledgeSources) > MAX_PROJECT_KNOWLEDGE_TOTAL_BYTES) {
    return Promise.reject(toWorkspaceSaveError(
      new Error('项目资料正文超过本机持久化预算，未写入任何工作区数据。'),
      'before-public-commit'
    ));
  }

  const revision = requestedRevision + 1;
  requestedRevision = revision;
  const providers = workspace.providers.length ? workspace.providers : createDefaultWorkspace().providers;
  let plugins: PluginManifest[];
  let serialized: string;
  try {
    plugins = normalizePlugins(workspace.plugins, providers, true);
    serialized = JSON.stringify(createEnvelope(workspace, revision, plugins));
  } catch (error) {
    return Promise.reject(toWorkspaceSaveError(error, 'before-public-commit'));
  }
  const queuedSave = saveQueue
    .catch(() => undefined)
    .then(async () => {
      let publicWorkspaceCommitted = false;
      try {
        if (loadFailure) {
          throw blockedSaveError();
        }
        const previous = await AsyncStorage.getItem(WORKSPACE_KEY);
        if (previous && previous !== serialized) {
          await AsyncStorage.setItem(WORKSPACE_BACKUP_KEY, previous);
        }
        await AsyncStorage.setItem(WORKSPACE_KEY, serialized);
        publicWorkspaceCommitted = true;
        // Commit the versioned public configuration before mutating secrets. A
        // workspace write failure therefore leaves the previous workspace and
        // its credentials intact. If SecureStore fails afterward, this save
        // still rejects, while binding fingerprints prevent the newly committed
        // configuration from hydrating a stale credential on restart.
        await persistSecrets(providers, plugins);
        const referencedAttachments = persistedConversations(workspace).flatMap((conversation) =>
          conversation.messages.flatMap((message) => message.attachments ?? [])
        );
        await flushPendingAttachmentDeletions(referencedAttachments);
      } catch (error) {
        throw toWorkspaceSaveError(
          error,
          publicWorkspaceCommitted ? 'after-public-commit' : 'before-public-commit'
        );
      }
    });
  saveQueue = queuedSave;
  return queuedSave;
}
