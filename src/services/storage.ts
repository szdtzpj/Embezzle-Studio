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
  CostEstimate,
  CostGuardSettings,
  MediaAttachment,
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
  RequestMetrics,
  ReasoningEffort,
  UnknownCostComponent,
  VoiceSettings,
  WebCitation,
  WebSearchSettings,
  WorkspaceProject,
} from '../domain/types';
import { createModelInfoFromId, inferModelTask } from './modelCapabilities';
import { attachmentForPersistence, flushPendingAttachmentDeletions } from './mediaStorage';
import { providerEndpointFingerprint } from './providerSetup';

const LEGACY_WORKSPACE_KEYS = [
  '@embezzle-studio/workspace-v3',
  '@embezzle-studio/workspace-v2',
  '@embezzle-studio/workspace-v1',
] as const;
const LEGACY_WORKSPACE_BACKUPS: Partial<Record<(typeof LEGACY_WORKSPACE_KEYS)[number], string>> = {
  '@embezzle-studio/workspace-v3': '@embezzle-studio/workspace-v3.backup',
  '@embezzle-studio/workspace-v2': '@embezzle-studio/workspace-v2.backup',
};
const WORKSPACE_KEY = '@embezzle-studio/workspace-v4';
const WORKSPACE_BACKUP_KEY = '@embezzle-studio/workspace-v4.backup';
const WORKSPACE_RECOVERY_KEY = '@embezzle-studio/workspace-recovery-v4';
const SECRET_PREFIX = 'embezzle-studio.provider-key';
const PLUGIN_SECRET_PREFIX = 'embezzle-studio.plugin-authorization';
const BOUND_SECRET_SCHEMA_VERSION = 1;
const STORAGE_SCHEMA_VERSION = 4;
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

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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
  if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) {
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
    ...(requestMetrics ? { requestMetrics } : {}),
    ...(costEstimate ? { costEstimate } : {}),
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

function normalizePlugins(value: unknown): PluginManifest[] {
  return arrayField(value, 'plugins').map((plugin, index) => {
    if (!isRecord(plugin)) {
      throw shapeError(`plugins[${index}] 必须是对象。`);
    }
    const id = nonEmptyString(plugin.id);
    if (!id) {
      throw shapeError(`plugins[${index}].id 不能为空。`);
    }
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
    let endpoint: string | undefined;
    if (typeof plugin.endpoint === 'string' && plugin.endpoint.trim()) {
      try {
        const parsed = parseSafePublicHttpsUrl(plugin.endpoint.trim(), false);
        if (!parsed) {
          throw new Error('MCP endpoint 必须是无内嵌凭据、查询参数和片段的远程公网 HTTPS URL。');
        }
        endpoint = parsed.toString();
      } catch (error) {
        throw shapeError(
          `plugins[${index}].endpoint 无效：${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return {
      id,
      name: nonEmptyString(plugin.name) ?? id,
      version: nonEmptyString(plugin.version) ?? '0.0.0',
      type,
      permissions,
      ...(transport ? { transport } : {}),
      ...(endpoint ? { endpoint } : {}),
      ...(plugin.enabled === true && endpoint && type === 'remote-mcp' ? { enabled: true } : {}),
      ...(nonEmptyString(plugin.serverLabel) ? { serverLabel: nonEmptyString(plugin.serverLabel) } : {}),
      ...(nonEmptyString(plugin.providerId) ? { providerId: nonEmptyString(plugin.providerId) } : {}),
      ...(plugin.approvalPolicy === 'always' ? { approvalPolicy: 'always' as const } : {}),
    };
  });
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
  return arrayField(value, 'promptTemplates').slice(0, 100).flatMap((template, index) => {
    if (!isRecord(template)) {
      throw shapeError(`promptTemplates[${index}] 必须是对象。`);
    }
    const id = nonEmptyString(template.id);
    const name = nonEmptyString(template.name);
    const content = typeof template.content === 'string' ? template.content : '';
    if (!id || seen.has(id) || !name || name.length > 60 || !content.trim() || content.length > 20_000) {
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
  const projects = arrayField(value, 'projects').slice(0, 50).flatMap((candidate, index) => {
    if (!isRecord(candidate)) {
      throw shapeError(`projects[${index}] 必须是对象。`);
    }
    const id = nonEmptyString(candidate.id);
    if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) {
      throw shapeError(`projects[${index}].id 无效。`);
    }
    if (seen.has(id)) {
      throw shapeError(`projects 中存在重复 ID「${id}」。`);
    }
    seen.add(id);
    const createdAt = finiteNumber(candidate.createdAt, now);
    const defaultTarget = normalizeModelTarget(candidate.defaultTarget, providers);
    return [{
      id,
      name: nonEmptyString(candidate.name)?.slice(0, 80) ?? `项目 ${index + 1}`,
      ...(nonEmptyString(candidate.systemPrompt)
        ? { systemPrompt: nonEmptyString(candidate.systemPrompt)!.slice(0, 20_000) }
        : {}),
      ...(defaultTarget ? { defaultTarget } : {}),
      createdAt,
      updatedAt: finiteNumber(candidate.updatedAt, createdAt),
    }];
  });
  return projects.length ? projects : [{ ...fallback, createdAt: now, updatedAt: now }];
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
    const key = `${normalized.providerId}:${normalized.modelId}`;
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
    const key = `${target.providerId}:${target.modelId}:${currency}`;
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
  const conversations = normalizeConversationStructure(normalizeConversations(snapshot, now), projects);
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
    activeConversationId,
    conversations,
    messages: activeConversation.messages,
    plugins: normalizePlugins(snapshot.plugins),
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

function pluginBindingFingerprint(
  plugin: Pick<PluginManifest, 'type' | 'transport' | 'endpoint'>
): string | undefined {
  if (plugin.type !== 'remote-mcp' || !plugin.endpoint) {
    return undefined;
  }
  const endpoint = parseSafePublicHttpsUrl(plugin.endpoint.trim(), false);
  if (!endpoint) {
    return undefined;
  }
  return `${plugin.type}::${plugin.transport ?? 'unspecified'}::${endpoint.toString()}`;
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
  plugin: Pick<PluginManifest, 'id' | 'type' | 'transport' | 'endpoint'>
): Promise<string | undefined> {
  const bindingFingerprint = pluginBindingFingerprint(plugin);
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
    if (![2, 3, STORAGE_SCHEMA_VERSION].includes(parsed.schemaVersion as number)) {
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
  workspace.plugins = await Promise.all(
    workspace.plugins.map(async (plugin) => ({
      ...plugin,
      authorization: await readPluginSecret(plugin),
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
  return messages.map((message) =>
    message.attachments?.length
      ? { ...message, attachments: message.attachments.map(attachmentForPersistence) }
      : message
  );
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

function createEnvelope(workspace: AppWorkspace, revision: number): PersistedWorkspaceEnvelope {
  const providers = workspace.providers.length ? workspace.providers : createDefaultWorkspace().providers;
  const conversations = persistedConversations(workspace);
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
      projects: workspace.projects.map((project) => ({
        ...project,
        ...(project.defaultTarget ? { defaultTarget: { ...project.defaultTarget } } : {}),
      })),
      activeConversationId: conversations.some((conversation) => conversation.id === workspace.activeConversationId)
        ? workspace.activeConversationId
        : conversations[0].id,
      conversations,
      plugins: workspace.plugins.map(stripPluginSecret),
      promptTemplates: [...workspace.promptTemplates],
      comparisonEnabled: workspace.comparisonEnabled,
      comparisonTargets: workspace.comparisonTargets.map((target) => ({ ...target })),
      modelPricing: workspace.modelPricing.map((pricing) => ({ ...pricing })),
      costGuard: { ...workspace.costGuard },
      providerUsageEvents: workspace.providerUsageEvents.slice(-10_000).map((event) => ({
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
    const value = plugin.authorization?.trim() || undefined;
    const bindingFingerprint = pluginBindingFingerprint(plugin);
    const cached = pluginSecretValues.get(plugin.id);
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
    return Promise.reject(blockedSaveError());
  }

  const revision = requestedRevision + 1;
  requestedRevision = revision;
  const providers = workspace.providers.length ? workspace.providers : createDefaultWorkspace().providers;
  const serialized = JSON.stringify(createEnvelope(workspace, revision));
  const queuedSave = saveQueue
    .catch(() => undefined)
    .then(async () => {
      if (loadFailure) {
        throw blockedSaveError();
      }
      const previous = await AsyncStorage.getItem(WORKSPACE_KEY);
      if (previous && previous !== serialized) {
        await AsyncStorage.setItem(WORKSPACE_BACKUP_KEY, previous);
      }
      await AsyncStorage.setItem(WORKSPACE_KEY, serialized);
      // Commit the versioned public configuration before mutating secrets. A
      // workspace write failure therefore leaves the previous workspace and
      // its credentials intact. If SecureStore fails afterward, this save
      // still rejects, while binding fingerprints prevent the newly committed
      // configuration from hydrating a stale credential on restart.
      await persistSecrets(providers, workspace.plugins);
      const referencedAttachments = persistedConversations(workspace).flatMap((conversation) =>
        conversation.messages.flatMap((message) => message.attachments ?? [])
      );
      await flushPendingAttachmentDeletions(referencedAttachments);
    });
  saveQueue = queuedSave;
  return queuedSave;
}
