import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { isArkStaticDoubaoModelId, isVolcengineArkProvider } from '../data/arkModels';
import { createDefaultWorkspace, defaultParameterSettings } from '../data/providerCatalog';
import type {
  AppWorkspace,
  AttachmentKind,
  Capability,
  ChatConversation,
  ChatMessage,
  MediaAttachment,
  ModelInfo,
  ModelParameterSettings,
  ModelTask,
  PluginManifest,
  ProviderKind,
  ProviderProfile,
  ReasoningEffort,
} from '../domain/types';
import { createModelInfoFromId, inferModelTask } from './modelCapabilities';
import { attachmentForPersistence, flushPendingAttachmentDeletions } from './mediaStorage';

const LEGACY_WORKSPACE_KEY = '@embezzle-studio/workspace-v1';
const WORKSPACE_KEY = '@embezzle-studio/workspace-v2';
const WORKSPACE_BACKUP_KEY = '@embezzle-studio/workspace-v2.backup';
const WORKSPACE_RECOVERY_KEY = '@embezzle-studio/workspace-recovery-v2';
const SECRET_PREFIX = 'embezzle-studio.provider-key';
const STORAGE_SCHEMA_VERSION = 2;
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
const modelTasks = new Set<ModelTask>(['chat', 'image-generation', 'video-generation', 'embedding', 'rerank']);
const attachmentKinds = new Set<AttachmentKind>(['image', 'video', 'file']);
const pluginPermissions = new Set<PluginManifest['permissions'][number]>(['network', 'files', 'clipboard', 'tools']);

type PersistedProvider = Omit<ProviderProfile, 'apiKey'>;
type PersistedWorkspace = Omit<AppWorkspace, 'providers' | 'messages'> & {
  providers: PersistedProvider[];
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

let secureStoreAvailable = false;
let loadFailure: Error | null = null;
let recoveryNotice: string | null = null;
let saveQueue: Promise<void> = Promise.resolve();
let requestedRevision = 0;
const secretValues = new Map<string, string | undefined>();

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

  return {
    id: nonEmptyString(value.id) ?? label.replace(/[^A-Za-z0-9]+/g, '-'),
    role,
    content: interrupted && !content.trim() ? INTERRUPTED_MESSAGE : content,
    createdAt: finiteNumber(value.createdAt, fallbackCreatedAt),
    status: interrupted ? 'error' : storedStatus,
    ...(attachments ? { attachments } : {}),
    ...(typeof value.reasoningContent === 'string' ? { reasoningContent: value.reasoningContent } : {}),
    ...(isRecord(value.usage) ? { usage: value.usage as unknown as ChatMessage['usage'] } : {}),
    ...(isRecord(value.generationTask) ? { generationTask: value.generationTask as unknown as ChatMessage['generationTask'] } : {}),
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
    return {
      id,
      name: nonEmptyString(plugin.name) ?? id,
      version: nonEmptyString(plugin.version) ?? '0.0.0',
      type,
      permissions,
      ...(transport ? { transport } : {}),
      ...(typeof plugin.endpoint === 'string' ? { endpoint: plugin.endpoint.trim() } : {}),
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
  const conversations = normalizeConversations(snapshot, now);
  const requestedConversationId = nonEmptyString(snapshot.activeConversationId);
  const activeConversationId = conversations.some((conversation) => conversation.id === requestedConversationId)
    ? requestedConversationId!
    : conversations[0].id;
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId)!;
  const requestedProviderId = nonEmptyString(snapshot.activeProviderId);
  const activeProviderId = normalizedProviders.some((provider) => provider.id === requestedProviderId)
    ? requestedProviderId!
    : normalizedProviders[0].id;

  return {
    providers: normalizedProviders,
    activeProviderId,
    activeModelIdByProvider: normalizeActiveModels(snapshot.activeModelIdByProvider, normalizedProviders),
    reasoningEffortByModel: normalizeReasoningMap(snapshot.reasoningEffortByModel),
    parameterSettings: normalizeParameterSettings(snapshot.parameterSettings),
    modelCandidatesByProvider,
    activeConversationId,
    conversations,
    messages: activeConversation.messages,
    plugins: normalizePlugins(snapshot.plugins),
  };
}

function secretKey(providerId: string): string {
  return `${SECRET_PREFIX}.${providerId}`;
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

async function readSecret(providerId: string): Promise<string | undefined> {
  if (secretValues.has(providerId)) {
    return secretValues.get(providerId);
  }
  const key = secretKey(providerId);
  let value: string | null;
  if (Platform.OS === 'web') {
    const session = browserSessionStorage();
    value = session?.getItem(key) ?? null;
    const legacyValue = await AsyncStorage.getItem(key);
    if (legacyValue !== null) {
      await AsyncStorage.removeItem(key);
      if (value === null) {
        value = legacyValue;
        try {
          session?.setItem(key, legacyValue);
        } catch {
          // Keep the migrated key in memory when sessionStorage is unavailable.
        }
      }
    }
  } else {
    await requireNativeSecureStore();
    value = await SecureStore.getItemAsync(key);
  }
  const normalized = value ?? undefined;
  secretValues.set(providerId, normalized);
  return normalized;
}

async function writeSecret(providerId: string, value?: string): Promise<void> {
  const key = secretKey(providerId);
  if (Platform.OS === 'web') {
    const session = browserSessionStorage();
    try {
      if (value) {
        session?.setItem(key, value);
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
    if (value) {
      await SecureStore.setItemAsync(key, value);
    } else {
      await SecureStore.deleteItemAsync(key);
    }
  }
  secretValues.set(providerId, value);
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
    if (parsed.schemaVersion !== STORAGE_SCHEMA_VERSION) {
      throw shapeError(`不支持 schemaVersion=${String(parsed.schemaVersion)}。`);
    }
    if (!isRecord(parsed.workspace)) {
      throw shapeError('v2 workspace 必须是对象。');
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
      apiKey: await readSecret(provider.id),
    }))
  );
  const workspace = normalizeWorkspace(decoded.snapshot, providers);
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
      sourceKey = LEGACY_WORKSPACE_KEY;
      raw = await AsyncStorage.getItem(LEGACY_WORKSPACE_KEY);
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

    if (sourceKey === WORKSPACE_KEY) {
      try {
        const backupRaw = await AsyncStorage.getItem(WORKSPACE_BACKUP_KEY);
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
      activeConversationId: conversations.some((conversation) => conversation.id === workspace.activeConversationId)
        ? workspace.activeConversationId
        : conversations[0].id,
      conversations,
      plugins: [...workspace.plugins],
    },
  };
}

async function persistSecrets(providers: ProviderProfile[]): Promise<void> {
  const currentIds = new Set(providers.map((provider) => provider.id));
  for (const providerId of Array.from(secretValues.keys())) {
    if (!currentIds.has(providerId)) {
      await writeSecret(providerId, undefined);
      secretValues.delete(providerId);
    }
  }
  for (const provider of providers) {
    const value = provider.apiKey || undefined;
    if (!secretValues.has(provider.id) || secretValues.get(provider.id) !== value) {
      await writeSecret(provider.id, value);
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
      await persistSecrets(providers);
      const previous = await AsyncStorage.getItem(WORKSPACE_KEY);
      if (previous && previous !== serialized) {
        await AsyncStorage.setItem(WORKSPACE_BACKUP_KEY, previous);
      }
      await AsyncStorage.setItem(WORKSPACE_KEY, serialized);
      const referencedAttachments = persistedConversations(workspace).flatMap((conversation) =>
        conversation.messages.flatMap((message) => message.attachments ?? [])
      );
      await flushPendingAttachmentDeletions(referencedAttachments);
    });
  saveQueue = queuedSave;
  return queuedSave;
}
