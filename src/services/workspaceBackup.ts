import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { bytesToUtf8, utf8ToBytes } from '@noble/ciphers/utils.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { getRandomBytesAsync } from 'expo-crypto';

import { defaultCostGuardSettings } from '../data/providerCatalog';
import type {
  AppWorkspace,
  Capability,
  ChatConversation,
  ChatMessage,
  ModelInfo,
  ModelPricing,
  ModelTargetRef,
  PluginManifest,
  PromptTemplate,
  ProviderKind,
  ProviderProfile,
  ProjectKnowledgeSource,
  ReasoningEffort,
  WorkspaceArtifact,
  WorkspaceProject,
} from '../domain/types';
import {
  MAX_MCP_ALLOWED_TOOLS,
  MAX_PLUGIN_MANIFESTS,
  getRemoteMcpExecutableReadiness,
  normalizeMcpAllowedTools,
  normalizeMcpDescription,
  normalizeMcpServerLabel,
  normalizeRemoteMcpEndpoint,
  remoteMcpBindingFingerprint,
} from '../plugins/contracts';
import {
  MAX_PROMPT_TEMPLATE_CONTENT_LENGTH,
  MAX_PROMPT_TEMPLATE_NAME_LENGTH,
  MAX_PROMPT_TEMPLATES,
} from './promptTemplates';
import {
  MAX_PROJECT_KNOWLEDGE_CONTEXT_SOURCES,
  MAX_PROJECT_KNOWLEDGE_FILE_NAME_CHARACTERS,
  MAX_PROJECT_KNOWLEDGE_MIME_TYPE_CHARACTERS,
  MAX_PROJECT_KNOWLEDGE_SOURCE_CHARACTERS,
  MAX_PROJECT_KNOWLEDGE_SOURCES,
  MAX_PROJECT_KNOWLEDGE_TITLE_CHARACTERS,
  MAX_PROJECT_KNOWLEDGE_TOTAL_BYTES,
} from './projectKnowledge';
import { externalSearchProviderKinds } from './externalSearch';
import { providerEndpointFingerprint } from './providerSetup';
import { unicodeCharacterLengthExceeds } from './textBounds';
import {
  MAX_WORKSPACE_ARTIFACT_CONTENT_LENGTH,
  MAX_WORKSPACE_ARTIFACT_LANGUAGE_LENGTH,
  MAX_WORKSPACE_ARTIFACT_REVISIONS,
  MAX_WORKSPACE_ARTIFACT_TITLE_LENGTH,
  MAX_WORKSPACE_ARTIFACTS,
  MAX_WORKSPACE_ARTIFACT_TOTAL_BYTES,
} from './workspaceArtifacts';
import {
  MAX_WORKSPACE_ENTITY_ID_CHARACTERS,
  isColonCapableWorkspaceEntityId,
  isLegacyWorkspaceId,
} from './workspaceEntityIds';
import {
  MAX_WORKSPACE_PROJECT_NAME_LENGTH,
  MAX_WORKSPACE_PROJECT_SYSTEM_PROMPT_LENGTH,
  MAX_WORKSPACE_PROJECTS,
} from './workspaceProjects';

export const MAX_ENCRYPTED_BACKUP_BYTES = 10 * 1024 * 1024;
export const MIN_BACKUP_PASSWORD_LENGTH = 8;
export const MAX_BACKUP_PASSWORD_LENGTH = 1024;
export const WORKSPACE_BACKUP_SCRYPT_PARAMS = Object.freeze({
  name: 'scrypt' as const,
  N: 2 ** 15,
  r: 8,
  p: 1,
  dkLen: 32,
});

const scryptMaxMemoryBytes = 64 * 1024 * 1024;
const backupSaltBytes = 32;
const backupNonceBytes = 24;
const backupAuthTagBytes = 16;
const encryptionContext = utf8ToBytes('embezzle-studio-encrypted-backup:v1');
const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const base64Values = new Int16Array(128).fill(-1);
for (let index = 0; index < base64Alphabet.length; index += 1) {
  base64Values[base64Alphabet.charCodeAt(index)] = index;
}

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
const forbiddenRecordKeys = new Set(['__proto__', 'constructor', 'prototype']);
const artifactFormats = new Set(['markdown', 'plain-text', 'code', 'json', 'html']);
const knowledgeKinds = new Set(['text', 'artifact', 'message', 'file']);

type BackupProvider = Omit<ProviderProfile, 'apiKey'>;
type BackupPlugin = Omit<PluginManifest, 'authorization'>;
type BackupMessage = Omit<ChatMessage, 'attachments' | 'mcpActivity'>;
type BackupConversation = Omit<ChatConversation, 'messages'> & { messages: BackupMessage[] };

export interface SanitizedWorkspaceBackup {
  providers: BackupProvider[];
  activeProviderId: string;
  activeModelIdByProvider: Record<string, string>;
  reasoningEffortByModel: Record<string, ReasoningEffort>;
  parameterSettings: AppWorkspace['parameterSettings'];
  modelCandidatesByProvider: Record<string, ModelInfo[]>;
  activeProjectId?: string;
  projects?: WorkspaceProject[];
  artifacts?: WorkspaceArtifact[];
  knowledgeSources?: ProjectKnowledgeSource[];
  activeConversationId: string;
  conversations: BackupConversation[];
  plugins: BackupPlugin[];
  promptTemplates: PromptTemplate[];
  comparisonEnabled: boolean;
  comparisonTargets: ModelTargetRef[];
  modelPricing: ModelPricing[];
  costGuard?: AppWorkspace['costGuard'];
  webSearch: AppWorkspace['webSearch'];
  externalSearch?: AppWorkspace['externalSearch'];
  voice: AppWorkspace['voice'];
}

export interface WorkspaceBackupEnvelope {
  magic: 'embezzle-studio-backup';
  version: 1;
  exportedAt: string;
  includes: {
    apiKeys: false;
    mediaFiles: false;
  };
  workspace: SanitizedWorkspaceBackup;
}

export interface EncryptedWorkspaceBackupEnvelope {
  magic: 'embezzle-studio-encrypted-backup';
  version: 1;
  kdf: typeof WORKSPACE_BACKUP_SCRYPT_PARAMS & { salt: string };
  cipher: {
    name: 'xchacha20-poly1305';
    nonce: string;
  };
  ciphertext: string;
}

function base64EncodedLength(byteLength: number): number {
  return 4 * Math.ceil(byteLength / 3);
}

const encryptedBackupFixedEnvelopeBytes = utf8ToBytes(JSON.stringify({
  magic: 'embezzle-studio-encrypted-backup',
  version: 1,
  kdf: {
    ...WORKSPACE_BACKUP_SCRYPT_PARAMS,
    salt: 'A'.repeat(base64EncodedLength(backupSaltBytes)),
  },
  cipher: {
    name: 'xchacha20-poly1305',
    nonce: 'A'.repeat(base64EncodedLength(backupNonceBytes)),
  },
  ciphertext: '',
} satisfies EncryptedWorkspaceBackupEnvelope)).length;

/**
 * Largest authenticated plaintext that is mathematically guaranteed to fit
 * the 10 MiB encrypted JSON envelope after the 16-byte tag and Base64 growth.
 */
export const MAX_PLAINTEXT_BACKUP_BYTES =
  Math.floor((MAX_ENCRYPTED_BACKUP_BYTES - encryptedBackupFixedEnvelopeBytes) / 4) * 3 -
  backupAuthTagBytes;

function encryptedEnvelopeBytesForPlaintext(plaintextBytes: number): number {
  return encryptedBackupFixedEnvelopeBytes +
    base64EncodedLength(plaintextBytes + backupAuthTagBytes);
}

export type WorkspaceBackupErrorCode =
  | 'password-policy'
  | 'too-large'
  | 'invalid-format'
  | 'duplicate-id'
  | 'decrypt-failed'
  | 'random-source';

export class WorkspaceBackupError extends Error {
  readonly code: WorkspaceBackupErrorCode;

  constructor(code: WorkspaceBackupErrorCode, message: string) {
    super(message);
    this.name = 'WorkspaceBackupError';
    this.code = code;
  }
}

export type WorkspaceBackupRandomSource = (
  byteCount: number
) => Uint8Array | Promise<Uint8Array>;

export interface ExportWorkspaceBackupOptions {
  now?: number;
  randomBytes?: WorkspaceBackupRandomSource;
}

function invalidFormat(message: string): never {
  throw new WorkspaceBackupError('invalid-format', `备份格式无效：${message}`);
}

function duplicateId(kind: string, id: string): never {
  throw new WorkspaceBackupError('duplicate-id', `备份中存在重复的 ${kind} ID：${id}`);
}

function decryptFailed(): WorkspaceBackupError {
  return new WorkspaceBackupError('decrypt-failed', '无法解密备份：密码错误或文件已损坏。');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    invalidFormat(`${path} 必须是对象。`);
  }
  return value;
}

function requireExactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      invalidFormat(`${path} 包含未允许的字段 ${key}。`);
    }
  }
  for (const key of allowed) {
    if (!(key in value)) {
      invalidFormat(`${path} 缺少字段 ${key}。`);
    }
  }
}

function requireString(value: unknown, path: string, options: { nonEmpty?: boolean; max?: number } = {}): string {
  if (typeof value !== 'string') {
    invalidFormat(`${path} 必须是字符串。`);
  }
  if (options.nonEmpty && !value.trim()) {
    invalidFormat(`${path} 不能为空。`);
  }
  if (options.max !== undefined && unicodeCharacterLengthExceeds(value, options.max)) {
    invalidFormat(`${path} 超过 ${options.max} 个字符。`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalidFormat(`${path} 必须是有限数字。`);
  }
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    invalidFormat(`${path} 必须是布尔值。`);
  }
  return value;
}

function requireArray(value: unknown, path: string, maximum = 10_000): unknown[] {
  if (!Array.isArray(value)) {
    invalidFormat(`${path} 必须是数组。`);
  }
  if (value.length > maximum) {
    invalidFormat(`${path} 数量超过上限 ${maximum}。`);
  }
  return value;
}

function requireId(value: unknown, path: string): string {
  const id = requireString(value, path, {
    nonEmpty: true,
    max: MAX_WORKSPACE_ENTITY_ID_CHARACTERS,
  });
  if (!isColonCapableWorkspaceEntityId(id)) {
    invalidFormat(`${path} 包含不允许的字符。`);
  }
  return id;
}

function requireLegacyId(value: unknown, path: string): string {
  const id = requireString(value, path, {
    nonEmpty: true,
    max: MAX_WORKSPACE_ENTITY_ID_CHARACTERS,
  });
  if (!isLegacyWorkspaceId(id)) {
    invalidFormat(`${path} 只能包含字母、数字、点、横线和下划线，不能包含冒号。`);
  }
  return id;
}

function requireOptionalString(value: unknown, path: string): void {
  if (value !== undefined) {
    requireString(value, path);
  }
}

function requireOptionalNumber(value: unknown, path: string): void {
  if (value !== undefined) {
    requireFiniteNumber(value, path);
  }
}

function validateStringRecord(value: unknown, path: string, allowedValues?: ReadonlySet<string>): void {
  const record = requireRecord(value, path);
  for (const [key, item] of Object.entries(record)) {
    if (forbiddenRecordKeys.has(key)) {
      invalidFormat(`${path} 包含不安全的键。`);
    }
    const text = requireString(item, `${path}.${key}`);
    if (allowedValues && !allowedValues.has(text)) {
      invalidFormat(`${path}.${key} 值无效。`);
    }
  }
}

function validateEnumArray(value: unknown, allowed: ReadonlySet<string>, path: string): void {
  const items = requireArray(value, path, 100);
  const seen = new Set<string>();
  for (let index = 0; index < items.length; index += 1) {
    const item = requireString(items[index], `${path}[${index}]`);
    if (!allowed.has(item) || seen.has(item)) {
      invalidFormat(`${path}[${index}] 值无效或重复。`);
    }
    seen.add(item);
  }
}

function validateModel(value: unknown, path: string): void {
  const model = requireRecord(value, path);
  const required = ['id', 'capabilities', 'source'];
  const optional = ['name', 'capabilityOverrides', 'supportedReasoningEfforts', 'contextWindow', 'task'];
  requireExactKeysWithOptional(model, required, optional, path);
  requireString(model.id, `${path}.id`, { nonEmpty: true, max: 512 });
  requireOptionalString(model.name, `${path}.name`);
  validateEnumArray(model.capabilities, capabilities, `${path}.capabilities`);
  if (model.capabilityOverrides !== undefined) {
    const overrides = requireRecord(model.capabilityOverrides, `${path}.capabilityOverrides`);
    for (const [key, enabled] of Object.entries(overrides)) {
      if (!capabilities.has(key as Capability) || typeof enabled !== 'boolean') {
        invalidFormat(`${path}.capabilityOverrides.${key} 无效。`);
      }
    }
  }
  if (model.supportedReasoningEfforts !== undefined) {
    validateEnumArray(model.supportedReasoningEfforts, reasoningEfforts, `${path}.supportedReasoningEfforts`);
  }
  requireOptionalNumber(model.contextWindow, `${path}.contextWindow`);
  if (
    model.task !== undefined &&
    ![
      'chat',
      'image-generation',
      'video-generation',
      'audio-transcription',
      'speech-generation',
      'embedding',
      'rerank',
    ].includes(String(model.task))
  ) {
    invalidFormat(`${path}.task 无效。`);
  }
  if (!['preset', 'remote', 'manual'].includes(String(model.source))) {
    invalidFormat(`${path}.source 无效。`);
  }
}

function requireExactKeysWithOptional(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      invalidFormat(`${path} 包含未允许的字段 ${key}。`);
    }
  }
  for (const key of required) {
    if (!(key in value)) {
      invalidFormat(`${path} 缺少字段 ${key}。`);
    }
  }
}

function validateProvider(value: unknown, path: string): string {
  const provider = requireRecord(value, path);
  requireExactKeysWithOptional(
    provider,
    ['id', 'name', 'kind', 'baseUrl', 'capabilities', 'models'],
    ['notes', 'enabled'],
    path
  );
  const id = requireLegacyId(provider.id, `${path}.id`);
  requireString(provider.name, `${path}.name`, { nonEmpty: true, max: 256 });
  if (!providerKinds.has(provider.kind as ProviderKind)) {
    invalidFormat(`${path}.kind 无效。`);
  }
  const baseUrl = requireString(provider.baseUrl, `${path}.baseUrl`, {
    nonEmpty: true,
    max: 8_192,
  });
  if (!isSafeProviderBaseUrl(baseUrl)) {
    invalidFormat(
      `${path}.baseUrl 必须使用 HTTPS（本机回环可使用 HTTP），且不能包含用户名、密码、查询参数或片段。`
    );
  }
  validateEnumArray(provider.capabilities, capabilities, `${path}.capabilities`);
  requireOptionalString(provider.notes, `${path}.notes`);
  if (provider.enabled !== undefined) {
    requireBoolean(provider.enabled, `${path}.enabled`);
  }
  const models = requireArray(provider.models, `${path}.models`, 10_000);
  const modelIds = new Set<string>();
  models.forEach((model, index) => {
    validateModel(model, `${path}.models[${index}]`);
    const modelId = (model as Record<string, unknown>).id as string;
    if (modelIds.has(modelId)) duplicateId('model', `${id}:${modelId}`);
    modelIds.add(modelId);
  });
  return id;
}

function validateTokenUsage(value: unknown, path: string): void {
  const usage = requireRecord(value, path);
  requireExactKeysWithOptional(usage, [], ['inputTokens', 'outputTokens', 'reasoningTokens', 'cachedInputTokens', 'totalTokens'], path);
  Object.entries(usage).forEach(([key, item]) => requireFiniteNumber(item, `${path}.${key}`));
}

function validateGenerationTask(value: unknown, path: string): void {
  const task = requireRecord(value, path);
  requireExactKeysWithOptional(task, ['providerId', 'modelId', 'taskId', 'kind'], ['status'], path);
  requireLegacyId(task.providerId, `${path}.providerId`);
  requireString(task.modelId, `${path}.modelId`, { nonEmpty: true, max: 512 });
  requireString(task.taskId, `${path}.taskId`, { nonEmpty: true, max: 512 });
  if (task.kind !== 'video') invalidFormat(`${path}.kind 无效。`);
  requireOptionalString(task.status, `${path}.status`);
}

function validateMessage(value: unknown, path: string): string {
  const message = requireRecord(value, path);
  requireExactKeysWithOptional(
    message,
    ['id', 'role', 'content', 'createdAt', 'status'],
    [
      'reasoningContent',
      'usage',
      'citations',
      'originMessageId',
      'comparisonGroupId',
      'projectInstructionId',
      'selectedForContext',
      'excludedFromContext',
      'pinnedForContext',
      'requestMetrics',
      'costEstimate',
      'generationTask',
      'modelId',
      'providerId',
      'providerName',
      'error',
    ],
    path
  );
  const id = requireId(message.id, `${path}.id`);
  requireOptionalString(message.originMessageId, `${path}.originMessageId`);
  if (!['system', 'user', 'assistant'].includes(String(message.role))) invalidFormat(`${path}.role 无效。`);
  requireString(message.content, `${path}.content`);
  requireFiniteNumber(message.createdAt, `${path}.createdAt`);
  if (!['ready', 'pending', 'error', 'cancelled'].includes(String(message.status))) invalidFormat(`${path}.status 无效。`);
  requireOptionalString(message.reasoningContent, `${path}.reasoningContent`);
  if (message.usage !== undefined) validateTokenUsage(message.usage, `${path}.usage`);
  if (message.citations !== undefined) {
    requireArray(message.citations, `${path}.citations`, 1_000).forEach((citation, index) => {
      const record = requireRecord(citation, `${path}.citations[${index}]`);
      requireExactKeysWithOptional(record, ['url'], ['title', 'startIndex', 'endIndex'], `${path}.citations[${index}]`);
      const citationUrl = requireString(record.url, `${path}.citations[${index}].url`, {
        nonEmpty: true,
        max: 8_192,
      });
      if (!safePublicHttpsUrl(citationUrl, true)) {
        invalidFormat(`${path}.citations[${index}].url 必须是安全公网 HTTPS URL。`);
      }
      requireOptionalString(record.title, `${path}.citations[${index}].title`);
      requireOptionalNumber(record.startIndex, `${path}.citations[${index}].startIndex`);
      requireOptionalNumber(record.endIndex, `${path}.citations[${index}].endIndex`);
    });
  }
  requireOptionalString(message.comparisonGroupId, `${path}.comparisonGroupId`);
  requireOptionalString(message.projectInstructionId, `${path}.projectInstructionId`);
  if (message.selectedForContext !== undefined) requireBoolean(message.selectedForContext, `${path}.selectedForContext`);
  if (message.excludedFromContext !== undefined) requireBoolean(message.excludedFromContext, `${path}.excludedFromContext`);
  if (message.pinnedForContext !== undefined) requireBoolean(message.pinnedForContext, `${path}.pinnedForContext`);
  if (message.excludedFromContext === true && message.pinnedForContext === true) {
    invalidFormat(`${path} 不能同时排除并置顶上下文。`);
  }
  if (message.requestMetrics !== undefined) {
    const metrics = requireRecord(message.requestMetrics, `${path}.requestMetrics`);
    requireExactKeysWithOptional(metrics, [], ['durationMs', 'timeToFirstTokenMs'], `${path}.requestMetrics`);
    requireOptionalNumber(metrics.durationMs, `${path}.requestMetrics.durationMs`);
    requireOptionalNumber(metrics.timeToFirstTokenMs, `${path}.requestMetrics.timeToFirstTokenMs`);
  }
  if (message.costEstimate !== undefined) {
    const cost = requireRecord(message.costEstimate, `${path}.costEstimate`);
    requireExactKeys(cost, ['amount', 'currency', 'source', 'pricingUpdatedAt'], `${path}.costEstimate`);
    requireFiniteNumber(cost.amount, `${path}.costEstimate.amount`);
    if (!['CNY', 'USD'].includes(String(cost.currency))) invalidFormat(`${path}.costEstimate.currency 无效。`);
    if (cost.source !== 'user-configured') invalidFormat(`${path}.costEstimate.source 无效。`);
    requireFiniteNumber(cost.pricingUpdatedAt, `${path}.costEstimate.pricingUpdatedAt`);
  }
  if (message.generationTask !== undefined) validateGenerationTask(message.generationTask, `${path}.generationTask`);
  requireOptionalString(message.modelId, `${path}.modelId`);
  requireOptionalString(message.providerId, `${path}.providerId`);
  requireOptionalString(message.providerName, `${path}.providerName`);
  requireOptionalString(message.error, `${path}.error`);
  return id;
}

function validateConversation(value: unknown, path: string, globalMessageIds: Set<string>): string {
  const conversation = requireRecord(value, path);
  requireExactKeysWithOptional(
    conversation,
    ['id', 'title', 'createdAt', 'updatedAt', 'messages'],
    ['customTitle', 'pinnedAt', 'projectId', 'parentConversationId', 'branchPointMessageId', 'knowledgeSourceIds'],
    path
  );
  const id = requireId(conversation.id, `${path}.id`);
  requireString(conversation.title, `${path}.title`, { nonEmpty: true });
  if (conversation.customTitle !== undefined) requireBoolean(conversation.customTitle, `${path}.customTitle`);
  requireOptionalNumber(conversation.pinnedAt, `${path}.pinnedAt`);
  requireOptionalString(conversation.projectId, `${path}.projectId`);
  requireOptionalString(conversation.parentConversationId, `${path}.parentConversationId`);
  requireOptionalString(conversation.branchPointMessageId, `${path}.branchPointMessageId`);
  if (conversation.knowledgeSourceIds !== undefined) {
    const seenKnowledgeIds = new Set<string>();
    requireArray(
      conversation.knowledgeSourceIds,
      `${path}.knowledgeSourceIds`,
      MAX_PROJECT_KNOWLEDGE_CONTEXT_SOURCES
    ).forEach((candidate, index) => {
      const knowledgeId = requireId(candidate, `${path}.knowledgeSourceIds[${index}]`);
      if (seenKnowledgeIds.has(knowledgeId)) {
        duplicateId('conversation knowledge reference', knowledgeId);
      }
      seenKnowledgeIds.add(knowledgeId);
    });
  }
  requireFiniteNumber(conversation.createdAt, `${path}.createdAt`);
  requireFiniteNumber(conversation.updatedAt, `${path}.updatedAt`);
  requireArray(conversation.messages, `${path}.messages`, 10_000).forEach((message, index) => {
    const messageId = validateMessage(message, `${path}.messages[${index}]`);
    if (globalMessageIds.has(messageId)) duplicateId('message', messageId);
    globalMessageIds.add(messageId);
  });
  return id;
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

function isLoopbackProviderHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.+$/, '');
  return normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]';
}

function providerProtocolAllowed(url: URL): boolean {
  return url.protocol === 'https:' ||
    (url.protocol === 'http:' && isLoopbackProviderHostname(url.hostname));
}

function isSafeProviderBaseUrl(value: string): boolean {
  const candidate = value.trim();
  if (
    !candidate ||
    candidate !== value ||
    candidate.length > 8_192 ||
    /[\u0000-\u0020\u007f]/.test(candidate)
  ) {
    return false;
  }
  try {
    const url = new URL(candidate);
    return Boolean(url.hostname) &&
      providerProtocolAllowed(url) &&
      !url.username &&
      !url.password &&
      !candidate.includes('?') &&
      !candidate.includes('#');
  } catch {
    return false;
  }
}

function requireSafeProviderBaseUrlForBackup(value: string): string {
  if (!isSafeProviderBaseUrl(value)) {
    invalidFormat(
      'workspace.providers[].baseUrl 不安全；请先移除用户名、密码、查询参数或片段，并使用 HTTPS（本机回环可使用 HTTP）。'
    );
  }
  return value;
}

function safePublicHttpsUrl(value: string | undefined, allowQueryAndFragment: boolean): string | undefined {
  const candidate = value?.trim();
  if (
    !candidate ||
    candidate !== value ||
    candidate.length > 8_192 ||
    /[\u0000-\u0020\u007f]/.test(candidate)
  ) {
    return undefined;
  }
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !url.hostname ||
      isPrivateOrReservedHostname(url.hostname) ||
      (!allowQueryAndFragment && (candidate.includes('?') || candidate.includes('#')))
    ) {
      return undefined;
    }
    return candidate;
  } catch {
    return undefined;
  }
}

function validatePlugin(value: unknown, path: string): string {
  const plugin = requireRecord(value, path);
  requireExactKeysWithOptional(
    plugin,
    ['id', 'name', 'version', 'type', 'permissions'],
    [
      'description',
      'allowedTools',
      'transport',
      'endpoint',
      'enabled',
      'serverLabel',
      'providerId',
      'approvalPolicy',
    ],
    path
  );
  const id = requireId(plugin.id, `${path}.id`);
  requireString(plugin.name, `${path}.name`, { nonEmpty: true });
  if (plugin.description !== undefined) {
    const description = requireString(plugin.description, `${path}.description`, { nonEmpty: true });
    if (!normalizeMcpDescription(description)) invalidFormat(`${path}.description 无效。`);
  }
  requireString(plugin.version, `${path}.version`, { nonEmpty: true });
  if (!['mobile-js', 'remote-mcp'].includes(String(plugin.type))) invalidFormat(`${path}.type 无效。`);
  validateEnumArray(plugin.permissions, new Set(['network', 'files', 'clipboard', 'tools']), `${path}.permissions`);
  if (plugin.allowedTools !== undefined) {
    const rawAllowedTools = requireArray(
      plugin.allowedTools,
      `${path}.allowedTools`,
      MAX_MCP_ALLOWED_TOOLS
    );
    if (rawAllowedTools.length > 0 && normalizeMcpAllowedTools(rawAllowedTools).length === 0) {
      invalidFormat(`${path}.allowedTools 无效。`);
    }
  }
  if (plugin.transport !== undefined && !['streamable-http', 'sse'].includes(String(plugin.transport))) invalidFormat(`${path}.transport 无效。`);
  if (plugin.endpoint !== undefined) {
    const endpoint = requireString(plugin.endpoint, `${path}.endpoint`, { nonEmpty: true });
    if (!normalizeRemoteMcpEndpoint(endpoint)) invalidFormat(`${path}.endpoint 不安全。`);
  }
  if (plugin.enabled !== undefined) requireBoolean(plugin.enabled, `${path}.enabled`);
  if (plugin.serverLabel !== undefined) {
    const serverLabel = requireString(plugin.serverLabel, `${path}.serverLabel`, { nonEmpty: true });
    if (!normalizeMcpServerLabel(serverLabel)) invalidFormat(`${path}.serverLabel 无效。`);
  }
  if (plugin.providerId !== undefined) {
    requireLegacyId(plugin.providerId, `${path}.providerId`);
  }
  if (plugin.approvalPolicy !== undefined && plugin.approvalPolicy !== 'always') invalidFormat(`${path}.approvalPolicy 无效。`);
  return id;
}

function validatePromptTemplate(value: unknown, path: string): string {
  const template = requireRecord(value, path);
  requireExactKeysWithOptional(template, ['id', 'name', 'content', 'mode', 'createdAt', 'updatedAt'], ['pinnedAt'], path);
  const id = requireId(template.id, `${path}.id`);
  requireString(template.name, `${path}.name`, {
    nonEmpty: true,
    max: MAX_PROMPT_TEMPLATE_NAME_LENGTH,
  });
  requireString(template.content, `${path}.content`, {
    nonEmpty: true,
    max: MAX_PROMPT_TEMPLATE_CONTENT_LENGTH,
  });
  if (!['composer', 'system'].includes(String(template.mode))) invalidFormat(`${path}.mode 无效。`);
  requireFiniteNumber(template.createdAt, `${path}.createdAt`);
  requireFiniteNumber(template.updatedAt, `${path}.updatedAt`);
  requireOptionalNumber(template.pinnedAt, `${path}.pinnedAt`);
  return id;
}

function validateTarget(value: unknown, path: string): void {
  const target = requireRecord(value, path);
  requireExactKeys(target, ['providerId', 'modelId'], path);
  requireLegacyId(target.providerId, `${path}.providerId`);
  requireString(target.modelId, `${path}.modelId`, { nonEmpty: true });
}

function validatePricing(value: unknown, path: string): void {
  const pricing = requireRecord(value, path);
  requireExactKeysWithOptional(
    pricing,
    ['providerId', 'modelId', 'currency', 'updatedAt'],
    ['inputPerMillion', 'cachedInputPerMillion', 'outputPerMillion'],
    path
  );
  requireLegacyId(pricing.providerId, `${path}.providerId`);
  requireString(pricing.modelId, `${path}.modelId`, { nonEmpty: true });
  if (!['CNY', 'USD'].includes(String(pricing.currency))) invalidFormat(`${path}.currency 无效。`);
  requireFiniteNumber(pricing.updatedAt, `${path}.updatedAt`);
  requireOptionalNumber(pricing.inputPerMillion, `${path}.inputPerMillion`);
  requireOptionalNumber(pricing.cachedInputPerMillion, `${path}.cachedInputPerMillion`);
  requireOptionalNumber(pricing.outputPerMillion, `${path}.outputPerMillion`);
}

function validateProject(value: unknown, path: string): string {
  const project = requireRecord(value, path);
  requireExactKeysWithOptional(
    project,
    ['id', 'name', 'createdAt', 'updatedAt'],
    ['systemPrompt', 'defaultTarget'],
    path
  );
  const id = requireLegacyId(project.id, `${path}.id`);
  requireString(project.name, `${path}.name`, {
    nonEmpty: true,
    max: MAX_WORKSPACE_PROJECT_NAME_LENGTH,
  });
  if (project.systemPrompt !== undefined) {
    requireString(project.systemPrompt, `${path}.systemPrompt`, {
      max: MAX_WORKSPACE_PROJECT_SYSTEM_PROMPT_LENGTH,
    });
  }
  if (project.defaultTarget !== undefined) validateTarget(project.defaultTarget, `${path}.defaultTarget`);
  requireFiniteNumber(project.createdAt, `${path}.createdAt`);
  requireFiniteNumber(project.updatedAt, `${path}.updatedAt`);
  return id;
}

function validateArtifact(value: unknown, path: string): string {
  const artifact = requireRecord(value, path);
  requireExactKeysWithOptional(
    artifact,
    ['id', 'projectId', 'title', 'format', 'revisions', 'activeRevisionId', 'createdAt', 'updatedAt'],
    ['language', 'sourceConversationId', 'sourceMessageId'],
    path
  );
  const id = requireId(artifact.id, `${path}.id`);
  requireLegacyId(artifact.projectId, `${path}.projectId`);
  requireString(artifact.title, `${path}.title`, { nonEmpty: true, max: MAX_WORKSPACE_ARTIFACT_TITLE_LENGTH });
  if (!artifactFormats.has(String(artifact.format))) invalidFormat(`${path}.format 无效。`);
  if (artifact.language !== undefined) {
    requireString(artifact.language, `${path}.language`, { nonEmpty: true, max: MAX_WORKSPACE_ARTIFACT_LANGUAGE_LENGTH });
  }
  const revisionIds = new Set<string>();
  const revisions = requireArray(artifact.revisions, `${path}.revisions`, MAX_WORKSPACE_ARTIFACT_REVISIONS);
  if (!revisions.length) invalidFormat(`${path}.revisions 不能为空。`);
  revisions.forEach((candidate, index) => {
    const revisionPath = `${path}.revisions[${index}]`;
    const revision = requireRecord(candidate, revisionPath);
    requireExactKeysWithOptional(
      revision,
      ['id', 'content', 'createdAt', 'author'],
      ['sourceMessageId'],
      revisionPath
    );
    const revisionId = requireId(revision.id, `${revisionPath}.id`);
    if (revisionIds.has(revisionId)) duplicateId('artifact revision', `${id}:${revisionId}`);
    revisionIds.add(revisionId);
    requireString(revision.content, `${revisionPath}.content`, { max: MAX_WORKSPACE_ARTIFACT_CONTENT_LENGTH });
    requireFiniteNumber(revision.createdAt, `${revisionPath}.createdAt`);
    if (!['user', 'assistant'].includes(String(revision.author))) {
      invalidFormat(`${revisionPath}.author 无效。`);
    }
    if (revision.sourceMessageId !== undefined) {
      requireId(revision.sourceMessageId, `${revisionPath}.sourceMessageId`);
    }
  });
  const activeRevisionId = requireId(artifact.activeRevisionId, `${path}.activeRevisionId`);
  if (!revisionIds.has(activeRevisionId)) invalidFormat(`${path}.activeRevisionId 不存在。`);
  if (artifact.sourceConversationId !== undefined) {
    requireId(artifact.sourceConversationId, `${path}.sourceConversationId`);
  }
  if (artifact.sourceMessageId !== undefined) {
    requireId(artifact.sourceMessageId, `${path}.sourceMessageId`);
  }
  requireFiniteNumber(artifact.createdAt, `${path}.createdAt`);
  requireFiniteNumber(artifact.updatedAt, `${path}.updatedAt`);
  return id;
}

function validateKnowledgeSource(value: unknown, path: string): string {
  const source = requireRecord(value, path);
  requireExactKeysWithOptional(
    source,
    ['id', 'projectId', 'title', 'kind', 'content', 'createdAt', 'updatedAt'],
    [
      'mimeType',
      'fileName',
      'sourceArtifactId',
      'sourceConversationId',
      'sourceMessageId',
    ],
    path
  );
  const id = requireId(source.id, `${path}.id`);
  requireLegacyId(source.projectId, `${path}.projectId`);
  requireString(source.title, `${path}.title`, { nonEmpty: true, max: MAX_PROJECT_KNOWLEDGE_TITLE_CHARACTERS });
  if (!knowledgeKinds.has(String(source.kind))) invalidFormat(`${path}.kind 无效。`);
  requireString(source.content, `${path}.content`, { max: MAX_PROJECT_KNOWLEDGE_SOURCE_CHARACTERS });
  if (source.mimeType !== undefined) {
    requireString(source.mimeType, `${path}.mimeType`, { nonEmpty: true, max: MAX_PROJECT_KNOWLEDGE_MIME_TYPE_CHARACTERS });
  }
  if (source.fileName !== undefined) {
    requireString(source.fileName, `${path}.fileName`, { nonEmpty: true, max: MAX_PROJECT_KNOWLEDGE_FILE_NAME_CHARACTERS });
  }
  if (source.sourceArtifactId !== undefined) {
    requireId(source.sourceArtifactId, `${path}.sourceArtifactId`);
  }
  if (source.sourceConversationId !== undefined) {
    requireId(source.sourceConversationId, `${path}.sourceConversationId`);
  }
  if (source.sourceMessageId !== undefined) {
    requireId(source.sourceMessageId, `${path}.sourceMessageId`);
  }
  requireFiniteNumber(source.createdAt, `${path}.createdAt`);
  requireFiniteNumber(source.updatedAt, `${path}.updatedAt`);
  return id;
}

function validateCostGuard(value: unknown, path: string): void {
  const guard = requireRecord(value, path);
  requireExactKeys(guard, [
    'enabled',
    'maxOutputTokens',
    'maxComparisonTargets',
    'dailyRequestLimit',
    'dailyCnyBudget',
    'dailyUsdBudget',
    'limitAction',
    'unknownCostAction',
    'confirmPotentialMultipleCharges',
  ], path);
  requireBoolean(guard.enabled, `${path}.enabled`);
  if (!['warn', 'block'].includes(String(guard.limitAction))) invalidFormat(`${path}.limitAction 无效。`);
  if (!['warn', 'block'].includes(String(guard.unknownCostAction))) invalidFormat(`${path}.unknownCostAction 无效。`);
  requireBoolean(guard.confirmPotentialMultipleCharges, `${path}.confirmPotentialMultipleCharges`);
  for (const key of ['maxOutputTokens', 'maxComparisonTargets', 'dailyRequestLimit', 'dailyCnyBudget', 'dailyUsdBudget']) {
    requireFiniteNumber(guard[key], `${path}.${key}`);
  }
  if (![2, 3, 4].includes(Number(guard.maxComparisonTargets))) {
    invalidFormat(`${path}.maxComparisonTargets 无效。`);
  }
  const maxOutputTokens = Number(guard.maxOutputTokens);
  const dailyRequestLimit = Number(guard.dailyRequestLimit);
  const dailyCnyBudget = Number(guard.dailyCnyBudget);
  const dailyUsdBudget = Number(guard.dailyUsdBudget);
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 64 || maxOutputTokens > 131_072) {
    invalidFormat(`${path}.maxOutputTokens 超出允许范围。`);
  }
  if (!Number.isInteger(dailyRequestLimit) || dailyRequestLimit < 0 || dailyRequestLimit > 10_000) {
    invalidFormat(`${path}.dailyRequestLimit 超出允许范围。`);
  }
  if (dailyCnyBudget < 0 || dailyCnyBudget > 1_000_000_000) {
    invalidFormat(`${path}.dailyCnyBudget 超出允许范围。`);
  }
  if (dailyUsdBudget < 0 || dailyUsdBudget > 1_000_000_000) {
    invalidFormat(`${path}.dailyUsdBudget 超出允许范围。`);
  }
}

function validateBackupWorkspace(value: unknown): asserts value is SanitizedWorkspaceBackup {
  const workspace = requireRecord(value, 'workspace');
  requireExactKeysWithOptional(
    workspace,
    [
      'providers',
      'activeProviderId',
      'activeModelIdByProvider',
      'reasoningEffortByModel',
      'parameterSettings',
      'modelCandidatesByProvider',
      'activeConversationId',
      'conversations',
      'plugins',
      'promptTemplates',
      'comparisonEnabled',
      'comparisonTargets',
      'modelPricing',
      'webSearch',
      'voice',
    ],
    ['activeProjectId', 'projects', 'artifacts', 'knowledgeSources', 'costGuard', 'externalSearch'],
    'workspace'
  );

  const providerIds = new Set<string>();
  const modelIdsByProvider = new Map<string, Set<string>>();
  const providerList = requireArray(workspace.providers, 'workspace.providers', 500);
  if (!providerList.length) invalidFormat('workspace.providers 不能为空。');
  providerList.forEach((provider, index) => {
    const id = validateProvider(provider, `workspace.providers[${index}]`);
    if (providerIds.has(id)) duplicateId('provider', id);
    providerIds.add(id);
    const providerRecord = requireRecord(provider, `workspace.providers[${index}]`);
    modelIdsByProvider.set(
      id,
      new Set(
        requireArray(providerRecord.models, `workspace.providers[${index}].models`, 10_000)
          .map((model, modelIndex) =>
            requireString(
              requireRecord(model, `workspace.providers[${index}].models[${modelIndex}]`).id,
              `workspace.providers[${index}].models[${modelIndex}].id`,
              { nonEmpty: true }
            )
          )
      )
    );
  });
  const activeProviderId = requireLegacyId(workspace.activeProviderId, 'workspace.activeProviderId');
  if (!providerIds.has(activeProviderId)) invalidFormat('workspace.activeProviderId 不存在。');
  validateStringRecord(workspace.activeModelIdByProvider, 'workspace.activeModelIdByProvider');
  validateStringRecord(workspace.reasoningEffortByModel, 'workspace.reasoningEffortByModel', reasoningEfforts);

  const parameters = requireRecord(workspace.parameterSettings, 'workspace.parameterSettings');
  requireExactKeys(parameters, ['enabled', 'temperature', 'topP', 'presencePenalty', 'frequencyPenalty'], 'workspace.parameterSettings');
  requireBoolean(parameters.enabled, 'workspace.parameterSettings.enabled');
  ['temperature', 'topP', 'presencePenalty', 'frequencyPenalty'].forEach((key) =>
    requireFiniteNumber(parameters[key], `workspace.parameterSettings.${key}`)
  );

  const candidates = requireRecord(workspace.modelCandidatesByProvider, 'workspace.modelCandidatesByProvider');
  for (const [providerId, models] of Object.entries(candidates)) {
    if (forbiddenRecordKeys.has(providerId) || !providerIds.has(providerId)) invalidFormat(`workspace.modelCandidatesByProvider.${providerId} 无效。`);
    requireArray(models, `workspace.modelCandidatesByProvider.${providerId}`, 10_000).forEach((model, index) =>
      validateModel(model, `workspace.modelCandidatesByProvider.${providerId}[${index}]`)
    );
  }

  const conversationIds = new Set<string>();
  const messageIds = new Set<string>();
  const messageConversationById = new Map<string, string>();
  const conversationsById = new Map<string, Record<string, unknown>>();
  const conversationList = requireArray(workspace.conversations, 'workspace.conversations', 500);
  if (!conversationList.length) invalidFormat('workspace.conversations 不能为空。');
  conversationList.forEach((conversation, index) => {
    const id = validateConversation(conversation, `workspace.conversations[${index}]`, messageIds);
    if (conversationIds.has(id)) duplicateId('conversation', id);
    conversationIds.add(id);
    const conversationRecord = requireRecord(conversation, `workspace.conversations[${index}]`);
    conversationsById.set(id, conversationRecord);
    requireArray(conversationRecord.messages, `workspace.conversations[${index}].messages`, 10_000)
      .forEach((message, messageIndex) => {
        const messageId = requireId(
          requireRecord(message, `workspace.conversations[${index}].messages[${messageIndex}]`).id,
          `workspace.conversations[${index}].messages[${messageIndex}].id`
        );
        messageConversationById.set(messageId, id);
      });
  });
  const activeConversationId = requireId(workspace.activeConversationId, 'workspace.activeConversationId');
  if (!conversationIds.has(activeConversationId)) invalidFormat('workspace.activeConversationId 不存在。');

  const projectIds = new Set<string>();
  if (workspace.projects !== undefined || workspace.activeProjectId !== undefined) {
    if (workspace.projects === undefined || workspace.activeProjectId === undefined) {
      invalidFormat('workspace.projects 与 activeProjectId 必须同时存在。');
    }
    requireArray(workspace.projects, 'workspace.projects', MAX_WORKSPACE_PROJECTS).forEach((project, index) => {
      const id = validateProject(project, `workspace.projects[${index}]`);
      if (projectIds.has(id)) duplicateId('project', id);
      projectIds.add(id);
      const projectRecord = requireRecord(project, `workspace.projects[${index}]`);
      if (projectRecord.defaultTarget !== undefined) {
        const target = requireRecord(
          projectRecord.defaultTarget,
          `workspace.projects[${index}].defaultTarget`
        );
        const providerId = requireLegacyId(
          target.providerId,
          `workspace.projects[${index}].defaultTarget.providerId`
        );
        const modelId = requireString(
          target.modelId,
          `workspace.projects[${index}].defaultTarget.modelId`,
          { nonEmpty: true }
        );
        if (!providerIds.has(providerId) || !modelIdsByProvider.get(providerId)?.has(modelId)) {
          invalidFormat(`workspace.projects[${index}].defaultTarget 不存在。`);
        }
      }
    });
    if (!projectIds.size) invalidFormat('workspace.projects 不能为空。');
    const activeProjectId = requireLegacyId(workspace.activeProjectId, 'workspace.activeProjectId');
    if (!projectIds.has(activeProjectId)) invalidFormat('workspace.activeProjectId 不存在。');
    conversationList.forEach((candidate, index) => {
      const conversation = requireRecord(candidate, `workspace.conversations[${index}]`);
      const projectId = requireString(conversation.projectId, `workspace.conversations[${index}].projectId`, { nonEmpty: true });
      if (!projectIds.has(projectId)) invalidFormat(`workspace.conversations[${index}].projectId 不存在。`);
      if (conversation.parentConversationId !== undefined) {
        const parentId = requireId(conversation.parentConversationId, `workspace.conversations[${index}].parentConversationId`);
        if (parentId === conversation.id || !conversationIds.has(parentId)) {
          invalidFormat(`workspace.conversations[${index}].parentConversationId 无效。`);
        }
        requireString(conversation.branchPointMessageId, `workspace.conversations[${index}].branchPointMessageId`, { nonEmpty: true });
      } else if (conversation.branchPointMessageId !== undefined) {
        invalidFormat(`workspace.conversations[${index}].branchPointMessageId 缺少父分支。`);
      }
    });
  }

  if (
    ((Array.isArray(workspace.artifacts) && workspace.artifacts.length > 0) ||
      (Array.isArray(workspace.knowledgeSources) && workspace.knowledgeSources.length > 0)) &&
    !projectIds.size
  ) {
    invalidFormat('workspace.artifacts 与 knowledgeSources 需要项目结构。');
  }
  const artifactIds = new Set<string>();
  const artifactsById = new Map<string, Record<string, unknown>>();
  let artifactContentBytes = 0;
  requireArray(workspace.artifacts ?? [], 'workspace.artifacts', MAX_WORKSPACE_ARTIFACTS).forEach((candidate, index) => {
    const path = `workspace.artifacts[${index}]`;
    const id = validateArtifact(candidate, path);
    if (artifactIds.has(id)) duplicateId('artifact', id);
    artifactIds.add(id);
    const artifact = requireRecord(candidate, path);
    artifactsById.set(id, artifact);
    const projectId = requireLegacyId(artifact.projectId, `${path}.projectId`);
    if (!projectIds.has(projectId)) invalidFormat(`${path}.projectId 不存在。`);
    const sourceConversationId = artifact.sourceConversationId as string | undefined;
    if (sourceConversationId !== undefined) {
      const sourceConversation = conversationsById.get(sourceConversationId);
      if (!sourceConversation || sourceConversation.projectId !== projectId) {
        invalidFormat(`${path}.sourceConversationId 不存在或跨项目。`);
      }
    }
    const validateSourceMessage = (sourceMessageId: unknown, sourcePath: string): void => {
      if (sourceMessageId === undefined) return;
      const messageId = requireId(sourceMessageId, sourcePath);
      const conversationId = messageConversationById.get(messageId);
      const conversation = conversationId ? conversationsById.get(conversationId) : undefined;
      if (
        !conversation ||
        conversation.projectId !== projectId ||
        (sourceConversationId !== undefined && conversationId !== sourceConversationId)
      ) {
        invalidFormat(`${sourcePath} 不存在或跨项目。`);
      }
    };
    validateSourceMessage(artifact.sourceMessageId, `${path}.sourceMessageId`);
    requireArray(artifact.revisions, `${path}.revisions`, MAX_WORKSPACE_ARTIFACT_REVISIONS)
      .forEach((revision, revisionIndex) => {
        const revisionRecord = requireRecord(revision, `${path}.revisions[${revisionIndex}]`);
        artifactContentBytes += utf8ToBytes(requireString(
          revisionRecord.content,
          `${path}.revisions[${revisionIndex}].content`
        )).length;
        if (artifactContentBytes > MAX_WORKSPACE_ARTIFACT_TOTAL_BYTES) {
          invalidFormat(`workspace.artifacts 正文合计超过 ${MAX_WORKSPACE_ARTIFACT_TOTAL_BYTES} UTF-8 字节。`);
        }
        validateSourceMessage(
          revisionRecord.sourceMessageId,
          `${path}.revisions[${revisionIndex}].sourceMessageId`
        );
      });
  });

  const knowledgeIds = new Set<string>();
  const knowledgeById = new Map<string, Record<string, unknown>>();
  let knowledgeContentBytes = 0;
  requireArray(
    workspace.knowledgeSources ?? [],
    'workspace.knowledgeSources',
    MAX_PROJECT_KNOWLEDGE_SOURCES
  ).forEach((candidate, index) => {
    const path = `workspace.knowledgeSources[${index}]`;
    const id = validateKnowledgeSource(candidate, path);
    if (knowledgeIds.has(id)) duplicateId('knowledge source', id);
    knowledgeIds.add(id);
    const source = requireRecord(candidate, path);
    knowledgeContentBytes += utf8ToBytes(requireString(source.content, `${path}.content`)).length;
    if (knowledgeContentBytes > MAX_PROJECT_KNOWLEDGE_TOTAL_BYTES) {
      invalidFormat(`workspace.knowledgeSources 正文合计超过 ${MAX_PROJECT_KNOWLEDGE_TOTAL_BYTES} UTF-8 字节。`);
    }
    knowledgeById.set(id, source);
    const projectId = requireLegacyId(source.projectId, `${path}.projectId`);
    if (!projectIds.has(projectId)) invalidFormat(`${path}.projectId 不存在。`);
    if (source.sourceArtifactId !== undefined) {
      const sourceArtifactId = requireId(source.sourceArtifactId, `${path}.sourceArtifactId`);
      if (artifactsById.get(sourceArtifactId)?.projectId !== projectId) {
        invalidFormat(`${path}.sourceArtifactId 不存在或跨项目。`);
      }
    }
    const sourceConversationId = source.sourceConversationId as string | undefined;
    if (sourceConversationId !== undefined) {
      const sourceConversation = conversationsById.get(sourceConversationId);
      if (!sourceConversation || sourceConversation.projectId !== projectId) {
        invalidFormat(`${path}.sourceConversationId 不存在或跨项目。`);
      }
    }
    if (source.sourceMessageId !== undefined) {
      const sourceMessageId = requireId(source.sourceMessageId, `${path}.sourceMessageId`);
      const conversationId = messageConversationById.get(sourceMessageId);
      const conversation = conversationId ? conversationsById.get(conversationId) : undefined;
      if (
        !conversation ||
        conversation.projectId !== projectId ||
        (sourceConversationId !== undefined && conversationId !== sourceConversationId)
      ) {
        invalidFormat(`${path}.sourceMessageId 不存在或跨项目。`);
      }
    }
  });

  conversationList.forEach((candidate, index) => {
    const conversation = requireRecord(candidate, `workspace.conversations[${index}]`);
    const projectId = conversation.projectId as string | undefined;
    requireArray(
      conversation.knowledgeSourceIds ?? [],
      `workspace.conversations[${index}].knowledgeSourceIds`,
      MAX_PROJECT_KNOWLEDGE_CONTEXT_SOURCES
    ).forEach((knowledgeId, knowledgeIndex) => {
      const id = requireId(
        knowledgeId,
        `workspace.conversations[${index}].knowledgeSourceIds[${knowledgeIndex}]`
      );
      if (!projectId || knowledgeById.get(id)?.projectId !== projectId) {
        invalidFormat(`workspace.conversations[${index}].knowledgeSourceIds[${knowledgeIndex}] 不存在或跨项目。`);
      }
    });
  });

  conversationList.forEach((candidate, index) => {
    const path = `workspace.conversations[${index}]`;
    const conversation = requireRecord(candidate, path);
    if (conversation.parentConversationId !== undefined) {
      const parentId = requireId(conversation.parentConversationId, `${path}.parentConversationId`);
      const parent = conversationsById.get(parentId);
      if (parentId === conversation.id || !parent) {
        invalidFormat(`${path}.parentConversationId 无效。`);
      }
      const branchPointMessageId = requireString(
        conversation.branchPointMessageId,
        `${path}.branchPointMessageId`,
        { nonEmpty: true }
      );
      if (branchPointMessageId === 'welcome') {
        invalidFormat(`${path}.branchPointMessageId 不能指向欢迎消息。`);
      }
      const branchPointExists = requireArray(
        parent.messages,
        `${path}.parentConversation.messages`,
        10_000
      ).some((message, messageIndex) =>
        requireRecord(message, `${path}.parentConversation.messages[${messageIndex}]`).id === branchPointMessageId
      );
      if (!branchPointExists) {
        invalidFormat(`${path}.branchPointMessageId 不属于父分支。`);
      }
      if (
        conversation.projectId !== undefined &&
        parent.projectId !== undefined &&
        conversation.projectId !== parent.projectId
      ) {
        invalidFormat(`${path} 与父分支不属于同一项目。`);
      }
    } else if (conversation.branchPointMessageId !== undefined) {
      invalidFormat(`${path}.branchPointMessageId 缺少父分支。`);
    }

    const visited = new Set([requireId(conversation.id, `${path}.id`)]);
    let parentId = conversation.parentConversationId as string | undefined;
    while (parentId) {
      if (visited.has(parentId)) {
        invalidFormat(`${path}.parentConversationId 包含循环。`);
      }
      visited.add(parentId);
      parentId = conversationsById.get(parentId)?.parentConversationId as string | undefined;
    }
  });

  const pluginIds = new Set<string>();
  const pluginServerLabels = new Set<string>();
  requireArray(workspace.plugins, 'workspace.plugins', MAX_PLUGIN_MANIFESTS).forEach((plugin, index) => {
    const id = validatePlugin(plugin, `workspace.plugins[${index}]`);
    if (pluginIds.has(id)) duplicateId('plugin', id);
    pluginIds.add(id);
    const pluginRecord = requireRecord(plugin, `workspace.plugins[${index}]`);
    if (pluginRecord.providerId !== undefined) {
      const providerId = requireLegacyId(
        pluginRecord.providerId,
        `workspace.plugins[${index}].providerId`
      );
      if (!providerIds.has(providerId)) {
        invalidFormat(`workspace.plugins[${index}].providerId 不存在。`);
      }
    }
    if (pluginRecord.serverLabel !== undefined) {
      const serverLabel = normalizeMcpServerLabel(pluginRecord.serverLabel)!;
      if (pluginServerLabels.has(serverLabel)) {
        invalidFormat(`workspace.plugins[${index}].serverLabel 与其他插件重复。`);
      }
      pluginServerLabels.add(serverLabel);
    }
  });

  const templateIds = new Set<string>();
  requireArray(workspace.promptTemplates, 'workspace.promptTemplates', MAX_PROMPT_TEMPLATES).forEach((template, index) => {
    const id = validatePromptTemplate(template, `workspace.promptTemplates[${index}]`);
    if (templateIds.has(id)) duplicateId('template', id);
    templateIds.add(id);
  });

  requireBoolean(workspace.comparisonEnabled, 'workspace.comparisonEnabled');
  requireArray(workspace.comparisonTargets, 'workspace.comparisonTargets', 20).forEach((target, index) =>
    validateTarget(target, `workspace.comparisonTargets[${index}]`)
  );
  requireArray(workspace.modelPricing, 'workspace.modelPricing', 10_000).forEach((pricing, index) =>
    validatePricing(pricing, `workspace.modelPricing[${index}]`)
  );
  if (workspace.costGuard !== undefined) validateCostGuard(workspace.costGuard, 'workspace.costGuard');

  const webSearch = requireRecord(workspace.webSearch, 'workspace.webSearch');
  requireExactKeys(webSearch, ['enabled', 'searchContextSize'], 'workspace.webSearch');
  requireBoolean(webSearch.enabled, 'workspace.webSearch.enabled');
  if (!['low', 'medium', 'high'].includes(String(webSearch.searchContextSize))) invalidFormat('workspace.webSearch.searchContextSize 无效。');

  if (workspace.externalSearch !== undefined) {
    const externalSearch = requireRecord(workspace.externalSearch, 'workspace.externalSearch');
    requireBoolean(externalSearch.enabled, 'workspace.externalSearch.enabled');
    if (externalSearch.selectedServiceId !== undefined) {
      requireString(externalSearch.selectedServiceId, 'workspace.externalSearch.selectedServiceId', { nonEmpty: true });
    }
    if (externalSearch.maxResults !== undefined) {
      const maxResults = Number(externalSearch.maxResults);
      if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 10) {
        invalidFormat('workspace.externalSearch.maxResults 无效。');
      }
    }
    if (externalSearch.maxToolRounds !== undefined) {
      const maxToolRounds = Number(externalSearch.maxToolRounds);
      if (!Number.isInteger(maxToolRounds) || maxToolRounds < 1 || maxToolRounds > 4) {
        invalidFormat('workspace.externalSearch.maxToolRounds 无效。');
      }
    }
    requireArray(externalSearch.services ?? [], 'workspace.externalSearch.services', 16).forEach((service, index) => {
      const row = requireRecord(service, `workspace.externalSearch.services[${index}]`);
      requireString(row.id, `workspace.externalSearch.services[${index}].id`, { nonEmpty: true });
      requireString(row.kind, `workspace.externalSearch.services[${index}].kind`, { nonEmpty: true });
      if (
        !externalSearchProviderKinds.includes(
          String(row.kind) as (typeof externalSearchProviderKinds)[number]
        )
      ) {
        invalidFormat(`workspace.externalSearch.services[${index}].kind 无效。`);
      }
      if (row.apiKey !== undefined) {
        invalidFormat('外部搜索 API Key 不得进入备份。');
      }
    });
  }

  const voice = requireRecord(workspace.voice, 'workspace.voice');
  requireExactKeysWithOptional(voice, ['speechVoice', 'speechFormat'], ['transcriptionTarget', 'speechTarget'], 'workspace.voice');
  if (voice.transcriptionTarget !== undefined) validateTarget(voice.transcriptionTarget, 'workspace.voice.transcriptionTarget');
  if (voice.speechTarget !== undefined) validateTarget(voice.speechTarget, 'workspace.voice.speechTarget');
  requireString(voice.speechVoice, 'workspace.voice.speechVoice', { nonEmpty: true });
  if (!['mp3', 'opus', 'aac', 'wav'].includes(String(voice.speechFormat))) invalidFormat('workspace.voice.speechFormat 无效。');
}

function sanitizeModel(model: ModelInfo): ModelInfo {
  return {
    id: model.id,
    ...(model.name !== undefined ? { name: model.name } : {}),
    capabilities: [...model.capabilities],
    ...(model.capabilityOverrides ? { capabilityOverrides: { ...model.capabilityOverrides } } : {}),
    ...(model.supportedReasoningEfforts ? { supportedReasoningEfforts: [...model.supportedReasoningEfforts] } : {}),
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.task !== undefined ? { task: model.task } : {}),
    source: model.source,
  };
}

function sanitizeProvider(provider: ProviderProfile): BackupProvider {
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    baseUrl: requireSafeProviderBaseUrlForBackup(provider.baseUrl),
    capabilities: [...provider.capabilities],
    models: provider.models.map(sanitizeModel),
    enabled: provider.enabled !== false,
    ...(provider.notes !== undefined ? { notes: provider.notes } : {}),
  };
}

function sanitizeMessage(message: ChatMessage): BackupMessage {
  return {
    id: message.id,
    ...(message.originMessageId !== undefined ? { originMessageId: message.originMessageId } : {}),
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    status: message.status,
    ...(message.reasoningContent !== undefined ? { reasoningContent: message.reasoningContent } : {}),
    ...(message.usage ? { usage: { ...message.usage } } : {}),
    ...(message.citations ? { citations: message.citations.map((citation) => ({ ...citation })) } : {}),
    ...(message.comparisonGroupId !== undefined ? { comparisonGroupId: message.comparisonGroupId } : {}),
    ...(message.projectInstructionId !== undefined ? { projectInstructionId: message.projectInstructionId } : {}),
    ...(message.selectedForContext !== undefined ? { selectedForContext: message.selectedForContext } : {}),
    ...(message.excludedFromContext !== undefined ? { excludedFromContext: message.excludedFromContext } : {}),
    ...(message.pinnedForContext !== undefined ? { pinnedForContext: message.pinnedForContext } : {}),
    ...(message.requestMetrics ? { requestMetrics: { ...message.requestMetrics } } : {}),
    ...(message.costEstimate ? { costEstimate: { ...message.costEstimate } } : {}),
    ...(message.generationTask ? { generationTask: { ...message.generationTask } } : {}),
    ...(message.modelId !== undefined ? { modelId: message.modelId } : {}),
    ...(message.providerId !== undefined ? { providerId: message.providerId } : {}),
    ...(message.providerName !== undefined ? { providerName: message.providerName } : {}),
    ...(message.error !== undefined ? { error: message.error } : {}),
  };
}

function sanitizeConversation(conversation: ChatConversation, messages = conversation.messages): BackupConversation {
  return {
    id: conversation.id,
    title: conversation.title,
    ...(conversation.customTitle !== undefined ? { customTitle: conversation.customTitle } : {}),
    ...(conversation.pinnedAt !== undefined ? { pinnedAt: conversation.pinnedAt } : {}),
    ...(conversation.projectId !== undefined ? { projectId: conversation.projectId } : {}),
    ...(conversation.parentConversationId !== undefined
      ? { parentConversationId: conversation.parentConversationId }
      : {}),
    ...(conversation.branchPointMessageId !== undefined
      ? { branchPointMessageId: conversation.branchPointMessageId }
      : {}),
    ...(conversation.knowledgeSourceIds?.length
      ? { knowledgeSourceIds: [...conversation.knowledgeSourceIds] }
      : {}),
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messages: messages.map(sanitizeMessage),
  };
}

function sanitizePlugin(
  plugin: PluginManifest,
  providerIds: ReadonlySet<string>
): BackupPlugin {
  const endpoint = normalizeRemoteMcpEndpoint(plugin.endpoint);
  const description = normalizeMcpDescription(plugin.description);
  const serverLabel = normalizeMcpServerLabel(plugin.serverLabel);
  const allowedTools = normalizeMcpAllowedTools(plugin.allowedTools);
  const sanitized: BackupPlugin = {
    id: plugin.id,
    name: plugin.name,
    ...(description ? { description } : {}),
    version: plugin.version,
    type: plugin.type,
    permissions: [...plugin.permissions],
    allowedTools,
    ...(plugin.transport !== undefined ? { transport: plugin.transport } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(plugin.type === 'remote-mcp' ? { enabled: plugin.enabled === true } : {}),
    ...(serverLabel ? { serverLabel } : {}),
    ...(plugin.providerId !== undefined ? { providerId: plugin.providerId } : {}),
    ...(plugin.approvalPolicy === 'always' ? { approvalPolicy: 'always' as const } : {}),
  };
  if (
    sanitized.enabled === true &&
    !getRemoteMcpExecutableReadiness(sanitized, providerIds).executable
  ) {
    sanitized.enabled = false;
  }
  return sanitized;
}

/** Produces a strict external-backup payload with no structured secrets or media references. */
export function sanitizeWorkspaceForBackup(workspace: AppWorkspace): SanitizedWorkspaceBackup {
  const existingActiveConversation = workspace.conversations.find(
    (conversation) => conversation.id === workspace.activeConversationId
  );
  const activeCreatedAt =
    existingActiveConversation?.createdAt ?? workspace.messages[0]?.createdAt ?? 0;
  const activeConversation: ChatConversation = {
    id: workspace.activeConversationId,
    title: existingActiveConversation?.title ?? '新对话',
    ...(existingActiveConversation?.customTitle !== undefined
      ? { customTitle: existingActiveConversation.customTitle }
      : {}),
    ...(existingActiveConversation?.pinnedAt !== undefined
      ? { pinnedAt: existingActiveConversation.pinnedAt }
      : {}),
    projectId: existingActiveConversation?.projectId ?? workspace.activeProjectId,
    ...(existingActiveConversation?.parentConversationId
      ? { parentConversationId: existingActiveConversation.parentConversationId }
      : {}),
    ...(existingActiveConversation?.branchPointMessageId
      ? { branchPointMessageId: existingActiveConversation.branchPointMessageId }
      : {}),
    ...(existingActiveConversation?.knowledgeSourceIds?.length
      ? { knowledgeSourceIds: [...existingActiveConversation.knowledgeSourceIds] }
      : {}),
    createdAt: activeCreatedAt,
    updatedAt:
      existingActiveConversation?.updatedAt ??
      workspace.messages.at(-1)?.createdAt ??
      activeCreatedAt,
    messages: workspace.messages,
  };
  const conversations = [
    sanitizeConversation(activeConversation),
    ...workspace.conversations
      .filter((conversation) => conversation.id !== workspace.activeConversationId)
      .map((conversation) => sanitizeConversation(conversation)),
  ];
  const providerIds = new Set(workspace.providers.map((provider) => provider.id));
  const sanitized: SanitizedWorkspaceBackup = {
    providers: workspace.providers.map(sanitizeProvider),
    activeProviderId: workspace.activeProviderId,
    activeModelIdByProvider: { ...workspace.activeModelIdByProvider },
    reasoningEffortByModel: { ...workspace.reasoningEffortByModel },
    parameterSettings: { ...workspace.parameterSettings },
    modelCandidatesByProvider: Object.fromEntries(
      Object.entries(workspace.modelCandidatesByProvider).map(([providerId, models]) => [
        providerId,
        models.map(sanitizeModel),
      ])
    ),
    activeProjectId: workspace.activeProjectId,
    projects: workspace.projects.map((project) => ({
      ...project,
      ...(project.defaultTarget ? { defaultTarget: { ...project.defaultTarget } } : {}),
    })),
    artifacts: workspace.artifacts.map((artifact) => ({
      ...artifact,
      revisions: artifact.revisions.map((revision) => ({ ...revision })),
    })),
    knowledgeSources: workspace.knowledgeSources.map((source) => ({ ...source })),
    activeConversationId: workspace.activeConversationId,
    conversations,
    plugins: workspace.plugins.map((plugin) => sanitizePlugin(plugin, providerIds)),
    promptTemplates: workspace.promptTemplates.map((template) => ({ ...template })),
    comparisonEnabled: workspace.comparisonEnabled,
    comparisonTargets: workspace.comparisonTargets.map((target) => ({ ...target })),
    modelPricing: workspace.modelPricing.map((pricing) => ({ ...pricing })),
    costGuard: { ...workspace.costGuard },
    webSearch: { ...workspace.webSearch },
    externalSearch: {
      ...workspace.externalSearch,
      enabled: false,
      services: workspace.externalSearch.services.map(({ apiKey: _apiKey, ...service }) => ({ ...service })),
    },
    voice: {
      ...(workspace.voice.transcriptionTarget ? { transcriptionTarget: { ...workspace.voice.transcriptionTarget } } : {}),
      ...(workspace.voice.speechTarget ? { speechTarget: { ...workspace.voice.speechTarget } } : {}),
      speechVoice: workspace.voice.speechVoice,
      speechFormat: workspace.voice.speechFormat,
    },
  };
  validateBackupWorkspace(sanitized);
  return sanitized;
}

export function createWorkspaceBackupEnvelope(
  workspace: AppWorkspace,
  now = Date.now()
): WorkspaceBackupEnvelope {
  if (!Number.isFinite(now)) {
    throw new WorkspaceBackupError('invalid-format', '备份时间无效。');
  }
  let exportedAt: string;
  try {
    exportedAt = new Date(now).toISOString();
  } catch {
    throw new WorkspaceBackupError('invalid-format', '备份时间无效。');
  }
  const envelope: WorkspaceBackupEnvelope = {
    magic: 'embezzle-studio-backup',
    version: 1,
    exportedAt,
    includes: {
      apiKeys: false,
      mediaFiles: false,
    },
    workspace: sanitizeWorkspaceForBackup(workspace),
  };
  return validateWorkspaceBackupEnvelope(envelope);
}

export function validateWorkspaceBackupEnvelope(value: unknown): WorkspaceBackupEnvelope {
  const envelope = requireRecord(value, 'backup');
  requireExactKeys(envelope, ['magic', 'version', 'exportedAt', 'includes', 'workspace'], 'backup');
  if (envelope.magic !== 'embezzle-studio-backup' || envelope.version !== 1) {
    invalidFormat('不支持的明文备份版本。');
  }
  const exportedAt = requireString(envelope.exportedAt, 'backup.exportedAt', { nonEmpty: true });
  if (!Number.isFinite(Date.parse(exportedAt))) invalidFormat('backup.exportedAt 无效。');
  const includes = requireRecord(envelope.includes, 'backup.includes');
  requireExactKeys(includes, ['apiKeys', 'mediaFiles'], 'backup.includes');
  if (includes.apiKeys !== false || includes.mediaFiles !== false) {
    invalidFormat('备份不得包含 API Key 或媒体文件。');
  }
  validateBackupWorkspace(envelope.workspace);
  return value as WorkspaceBackupEnvelope;
}

function validatePassword(password: string): void {
  const length = Array.from(password).length;
  if (length < MIN_BACKUP_PASSWORD_LENGTH || length > MAX_BACKUP_PASSWORD_LENGTH) {
    throw new WorkspaceBackupError(
      'password-policy',
      `备份密码必须为 ${MIN_BACKUP_PASSWORD_LENGTH}-${MAX_BACKUP_PASSWORD_LENGTH} 个字符。`
    );
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let part = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
    part += base64Alphabet[first >> 2];
    part += base64Alphabet[((first & 3) << 4) | (second >> 4)];
    part += index + 1 < bytes.length ? base64Alphabet[((second & 15) << 2) | (third >> 6)] : '=';
    part += index + 2 < bytes.length ? base64Alphabet[third & 63] : '=';
    if (part.length >= 32_768) {
      parts.push(part);
      part = '';
    }
  }
  if (part) parts.push(part);
  return parts.join('');
}

function base64ToBytes(value: string): Uint8Array {
  if (!value || value.length % 4 !== 0) throw new Error('invalid base64');
  let padding = 0;
  if (value.endsWith('==')) padding = 2;
  else if (value.endsWith('=')) padding = 1;
  const output = new Uint8Array((value.length / 4) * 3 - padding);
  let outputIndex = 0;
  for (let index = 0; index < value.length; index += 4) {
    const codes = [value.charCodeAt(index), value.charCodeAt(index + 1), value.charCodeAt(index + 2), value.charCodeAt(index + 3)];
    const values = codes.map((code, offset) => {
      if (code === 61 && index + offset >= value.length - padding) return 0;
      if (code >= base64Values.length || base64Values[code] < 0) throw new Error('invalid base64');
      return base64Values[code];
    });
    const packed = (values[0] << 18) | (values[1] << 12) | (values[2] << 6) | values[3];
    if (outputIndex < output.length) output[outputIndex++] = (packed >> 16) & 255;
    if (outputIndex < output.length) output[outputIndex++] = (packed >> 8) & 255;
    if (outputIndex < output.length) output[outputIndex++] = packed & 255;
  }
  return output;
}

function plaintextTooLarge(): WorkspaceBackupError {
  return new WorkspaceBackupError(
    'too-large',
    `备份明文超过 ${MAX_PLAINTEXT_BACKUP_BYTES} UTF-8 字节安全上限，无法装入 10 MiB 加密文件。`
  );
}

function encryptedBackupTooLarge(): WorkspaceBackupError {
  return new WorkspaceBackupError(
    'too-large',
    `加密备份文件超过 ${MAX_ENCRYPTED_BACKUP_BYTES} 字节（10 MiB）上限。`
  );
}

function encodeBoundedPlaintext(serialized: string): Uint8Array {
  // Every UTF-8 encoding is at least as large as its JS code-unit length. This
  // rejects obviously oversized sources before allocating another large copy.
  if (serialized.length > MAX_PLAINTEXT_BACKUP_BYTES) {
    throw plaintextTooLarge();
  }
  const plaintext = utf8ToBytes(serialized);
  if (
    plaintext.length > MAX_PLAINTEXT_BACKUP_BYTES ||
    encryptedEnvelopeBytesForPlaintext(plaintext.length) > MAX_ENCRYPTED_BACKUP_BYTES
  ) {
    plaintext.fill(0);
    throw plaintextTooLarge();
  }
  return plaintext;
}

function requireEncryptedBackupInputSize(serialized: string): void {
  // Cheap preflight prevents a second multi-megabyte allocation for obvious
  // oversized input. The UTF-8 check then handles non-ASCII attack strings.
  if (serialized.length > MAX_ENCRYPTED_BACKUP_BYTES) {
    throw encryptedBackupTooLarge();
  }
  const encoded = utf8ToBytes(serialized);
  const tooLarge = encoded.length > MAX_ENCRYPTED_BACKUP_BYTES;
  encoded.fill(0);
  if (tooLarge) throw encryptedBackupTooLarge();
}

async function secureRandomBytes(
  byteCount: number,
  source: WorkspaceBackupRandomSource
): Promise<Uint8Array> {
  const value = await source(byteCount);
  if (!(value instanceof Uint8Array) || value.length !== byteCount) {
    throw new WorkspaceBackupError('random-source', '安全随机数源返回了无效数据。');
  }
  return Uint8Array.from(value);
}

async function deriveBackupKey(password: string, salt: Uint8Array): Promise<Uint8Array> {
  return scryptAsync(password, salt, {
    N: WORKSPACE_BACKUP_SCRYPT_PARAMS.N,
    r: WORKSPACE_BACKUP_SCRYPT_PARAMS.r,
    p: WORKSPACE_BACKUP_SCRYPT_PARAMS.p,
    dkLen: WORKSPACE_BACKUP_SCRYPT_PARAMS.dkLen,
    asyncTick: 8,
    maxmem: scryptMaxMemoryBytes,
  });
}

/** Encrypts a secret-free backup envelope locally with XChaCha20-Poly1305. */
export async function exportEncryptedWorkspaceBackup(
  workspace: AppWorkspace,
  password: string,
  options: ExportWorkspaceBackupOptions = {}
): Promise<string> {
  validatePassword(password);
  const plaintextJson = JSON.stringify(createWorkspaceBackupEnvelope(workspace, options.now));
  const plaintext = encodeBoundedPlaintext(plaintextJson);
  const source = options.randomBytes ?? getRandomBytesAsync;
  const salt = await secureRandomBytes(backupSaltBytes, source);
  const nonce = await secureRandomBytes(backupNonceBytes, source);
  const key = await deriveBackupKey(password, salt);
  let ciphertext: Uint8Array | undefined;
  try {
    ciphertext = xchacha20poly1305(key, nonce, encryptionContext).encrypt(plaintext);
    const outer: EncryptedWorkspaceBackupEnvelope = {
      magic: 'embezzle-studio-encrypted-backup',
      version: 1,
      kdf: {
        ...WORKSPACE_BACKUP_SCRYPT_PARAMS,
        salt: bytesToBase64(salt),
      },
      cipher: {
        name: 'xchacha20-poly1305',
        nonce: bytesToBase64(nonce),
      },
      ciphertext: bytesToBase64(ciphertext),
    };
    const serialized = JSON.stringify(outer);
    // The exact pre-KDF formula above guarantees this ASCII JSON fits. Keep an
    // invariant check here without allocating a redundant UTF-8 copy.
    if (serialized.length > MAX_ENCRYPTED_BACKUP_BYTES) {
      throw encryptedBackupTooLarge();
    }
    return serialized;
  } finally {
    key.fill(0);
    plaintext.fill(0);
    ciphertext?.fill(0);
  }
}

function parseEncryptedEnvelope(serialized: string): EncryptedWorkspaceBackupEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw decryptFailed();
  }
  try {
    const envelope = requireRecord(parsed, 'encryptedBackup');
    requireExactKeys(envelope, ['magic', 'version', 'kdf', 'cipher', 'ciphertext'], 'encryptedBackup');
    if (envelope.magic !== 'embezzle-studio-encrypted-backup' || envelope.version !== 1) throw decryptFailed();
    const kdf = requireRecord(envelope.kdf, 'encryptedBackup.kdf');
    requireExactKeys(kdf, ['name', 'N', 'r', 'p', 'dkLen', 'salt'], 'encryptedBackup.kdf');
    if (
      kdf.name !== WORKSPACE_BACKUP_SCRYPT_PARAMS.name ||
      kdf.N !== WORKSPACE_BACKUP_SCRYPT_PARAMS.N ||
      kdf.r !== WORKSPACE_BACKUP_SCRYPT_PARAMS.r ||
      kdf.p !== WORKSPACE_BACKUP_SCRYPT_PARAMS.p ||
      kdf.dkLen !== WORKSPACE_BACKUP_SCRYPT_PARAMS.dkLen
    ) throw decryptFailed();
    requireString(kdf.salt, 'encryptedBackup.kdf.salt', { nonEmpty: true });
    const cipher = requireRecord(envelope.cipher, 'encryptedBackup.cipher');
    requireExactKeys(cipher, ['name', 'nonce'], 'encryptedBackup.cipher');
    if (cipher.name !== 'xchacha20-poly1305') throw decryptFailed();
    requireString(cipher.nonce, 'encryptedBackup.cipher.nonce', { nonEmpty: true });
    requireString(envelope.ciphertext, 'encryptedBackup.ciphertext', { nonEmpty: true });
    return parsed as EncryptedWorkspaceBackupEnvelope;
  } catch {
    throw decryptFailed();
  }
}

function mergeImportedWorkspace(
  imported: SanitizedWorkspaceBackup,
  currentWorkspace: AppWorkspace
): AppWorkspace {
  const canonicalBindingUrl = (value: string | undefined): string | undefined => {
    if (!value || !isSafeProviderBaseUrl(value)) return undefined;
    try {
      const url = new URL(value.trim());
      const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
      return `${url.origin}${path}`;
    } catch {
      return undefined;
    }
  };
  const currentProviders = new Map(
    currentWorkspace.providers.map((provider) => [provider.id, provider] as const)
  );
  const providers: ProviderProfile[] = imported.providers.map((provider) => {
    const current = currentProviders.get(provider.id);
    const importedBinding = canonicalBindingUrl(provider.baseUrl);
    const apiKey =
      current &&
      current.kind === provider.kind &&
      importedBinding !== undefined &&
      canonicalBindingUrl(current.baseUrl) === importedBinding
        ? current.apiKey
        : undefined;
    return {
      ...provider,
      enabled: provider.enabled !== false,
      models: provider.models.map(sanitizeModel),
      capabilities: [...provider.capabilities],
      ...(apiKey !== undefined ? { apiKey } : {}),
    };
  });
  const recoveredFromAllProvidersDisabled = !providers.some(
    (provider) => provider.enabled !== false
  );
  if (recoveredFromAllProvidersDisabled) {
    providers[0] = { ...providers[0], enabled: true };
  }
  const enabledProviderTarget = (target: ModelTargetRef | undefined): target is ModelTargetRef => {
    if (!target) {
      return false;
    }
    const provider = providers.find((candidate) => candidate.id === target.providerId);
    return Boolean(
      provider &&
      provider.enabled !== false &&
      provider.models.some((model) => model.id === target.modelId)
    );
  };
  const activeProviderId = providers.some(
    (provider) => provider.id === imported.activeProviderId && provider.enabled !== false
  )
    ? imported.activeProviderId
    : providers.find((provider) => provider.enabled !== false)!.id;
  const currentPlugins = new Map(
    currentWorkspace.plugins.map((plugin) => [plugin.id, plugin] as const)
  );
  const importedProviderIds = new Set(providers.map((provider) => provider.id));
  const endpointBindings = (providerList: readonly ProviderProfile[]) =>
    new Map(
      providerList.flatMap((provider) => {
        const binding = providerEndpointFingerprint(provider);
        return binding ? [[provider.id, binding] as const] : [];
      })
    );
  const importedProviderBindings = endpointBindings(providers);
  const currentProviderBindings = endpointBindings(currentWorkspace.providers);
  const plugins: PluginManifest[] = imported.plugins.map((plugin) => {
    const current = currentPlugins.get(plugin.id);
    const endpoint = normalizeRemoteMcpEndpoint(plugin.endpoint);
    const description = normalizeMcpDescription(plugin.description);
    const serverLabel = normalizeMcpServerLabel(plugin.serverLabel);
    const allowedTools = normalizeMcpAllowedTools(plugin.allowedTools);
    const normalized: PluginManifest = {
      id: plugin.id,
      name: plugin.name,
      ...(description ? { description } : {}),
      version: plugin.version,
      type: plugin.type,
      permissions: [...plugin.permissions],
      allowedTools,
      ...(plugin.transport !== undefined ? { transport: plugin.transport } : {}),
      ...(endpoint ? { endpoint } : {}),
      // Import never re-arms a remote execution path. The user must review and
      // enable every restored MCP configuration again on this device.
      ...(plugin.type === 'remote-mcp' ? { enabled: false } : {}),
      ...(serverLabel ? { serverLabel } : {}),
      ...(plugin.providerId !== undefined ? { providerId: plugin.providerId } : {}),
      ...(plugin.approvalPolicy === 'always' ? { approvalPolicy: 'always' } : {}),
    };
    if (
      normalized.enabled === true &&
      !getRemoteMcpExecutableReadiness(normalized, importedProviderIds).executable
    ) {
      normalized.enabled = false;
    }
    const importedBinding = remoteMcpBindingFingerprint(
      normalized,
      importedProviderBindings
    );
    const authorization =
      current &&
      importedBinding !== undefined &&
      remoteMcpBindingFingerprint(current, currentProviderBindings) === importedBinding
        ? current.authorization
        : undefined;
    return {
      ...normalized,
      ...(authorization !== undefined ? { authorization } : {}),
    };
  });
  const importedAt = Date.now();
  const projects: WorkspaceProject[] = imported.projects?.length
    ? imported.projects.map((project) => ({
        ...project,
        ...(enabledProviderTarget(project.defaultTarget)
          ? { defaultTarget: { ...project.defaultTarget } }
          : { defaultTarget: undefined }),
      }))
    : [{
        id: 'project-default',
        name: '默认项目',
        createdAt: importedAt,
        updatedAt: importedAt,
      }];
  const projectIds = new Set(projects.map((project) => project.id));
  const conversations = imported.conversations.map((conversation): ChatConversation => ({
    ...conversation,
    projectId: conversation.projectId && projectIds.has(conversation.projectId)
      ? conversation.projectId
      : projects[0].id,
    ...(conversation.knowledgeSourceIds?.length
      ? { knowledgeSourceIds: [...conversation.knowledgeSourceIds] }
      : {}),
    messages: conversation.messages.map((message): ChatMessage => ({ ...message })),
  }));
  const artifacts: WorkspaceArtifact[] = (imported.artifacts ?? []).map((artifact) => ({
    ...artifact,
    revisions: artifact.revisions.map((revision) => ({ ...revision })),
  }));
  const knowledgeSources: ProjectKnowledgeSource[] = (imported.knowledgeSources ?? []).map(
    (source) => ({ ...source })
  );
  const activeConversation = conversations.find(
    (conversation) => conversation.id === imported.activeConversationId
  )!;
  const comparisonTargets = imported.comparisonTargets
    .filter(enabledProviderTarget)
    .map((target) => ({ ...target }));
  const transcriptionTarget = enabledProviderTarget(imported.voice.transcriptionTarget)
    ? { ...imported.voice.transcriptionTarget }
    : undefined;
  const speechTarget = enabledProviderTarget(imported.voice.speechTarget)
    ? { ...imported.voice.speechTarget }
    : undefined;
  return {
    providers,
    activeProviderId,
    activeModelIdByProvider: { ...imported.activeModelIdByProvider },
    reasoningEffortByModel: { ...imported.reasoningEffortByModel },
    parameterSettings: { ...imported.parameterSettings },
    modelCandidatesByProvider: Object.fromEntries(
      Object.entries(imported.modelCandidatesByProvider).map(([providerId, models]) => [
        providerId,
        models.map(sanitizeModel),
      ])
    ),
    activeProjectId: activeConversation.projectId ?? projects[0].id,
    projects,
    artifacts,
    knowledgeSources,
    activeConversationId: imported.activeConversationId,
    conversations,
    messages: activeConversation.messages,
    plugins,
    promptTemplates: imported.promptTemplates.map((template) => ({ ...template })),
    comparisonEnabled: imported.comparisonEnabled && comparisonTargets.length >= 2,
    comparisonTargets,
    modelPricing: imported.modelPricing.map((pricing) => ({ ...pricing })),
    costGuard: { ...(imported.costGuard ?? defaultCostGuardSettings) },
    providerUsageEvents: currentWorkspace.providerUsageEvents.map((event) => ({
      ...event,
      unknownCostComponents: [...event.unknownCostComponents],
      ...(event.knownCostEstimate ? { knownCostEstimate: { ...event.knownCostEstimate } } : {}),
    })),
    webSearch: {
      ...imported.webSearch,
      enabled: recoveredFromAllProvidersDisabled ? false : imported.webSearch.enabled,
    },
    externalSearch: {
      enabled: false,
      maxResults:
        typeof imported.externalSearch?.maxResults === 'number'
          ? imported.externalSearch.maxResults
          : 5,
      maxToolRounds:
        typeof imported.externalSearch?.maxToolRounds === 'number'
          ? imported.externalSearch.maxToolRounds
          : 3,
      selectedServiceId: imported.externalSearch?.selectedServiceId,
      services: (imported.externalSearch?.services ?? []).map((service) => ({
        id: service.id,
        kind: service.kind,
        name: service.name,
        ...(service.endpoint ? { endpoint: service.endpoint } : {}),
        ...(service.model ? { model: service.model } : {}),
      })),
    },
    voice: {
      ...(transcriptionTarget ? { transcriptionTarget } : {}),
      ...(speechTarget ? { speechTarget } : {}),
      speechVoice: imported.voice.speechVoice,
      speechFormat: imported.voice.speechFormat,
    },
  };
}

/** Decrypts, authenticates, validates, then inherits secrets only for the same ID, protocol, and endpoint. */
export async function importEncryptedWorkspaceBackup(
  serialized: string,
  password: string,
  currentWorkspace: AppWorkspace
): Promise<AppWorkspace> {
  validatePassword(password);
  requireEncryptedBackupInputSize(serialized);
  const outer = parseEncryptedEnvelope(serialized);
  let salt: Uint8Array;
  let nonce: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    salt = base64ToBytes(outer.kdf.salt);
    nonce = base64ToBytes(outer.cipher.nonce);
    ciphertext = base64ToBytes(outer.ciphertext);
    if (salt.length !== backupSaltBytes || nonce.length !== backupNonceBytes || ciphertext.length < backupAuthTagBytes) {
      throw new Error('invalid encrypted payload');
    }
  } catch {
    throw decryptFailed();
  }

  const key = await deriveBackupKey(password, salt);
  let plaintext: Uint8Array;
  try {
    plaintext = xchacha20poly1305(key, nonce, encryptionContext).decrypt(ciphertext);
  } catch {
    throw decryptFailed();
  } finally {
    key.fill(0);
  }

  try {
    if (plaintext.length > MAX_PLAINTEXT_BACKUP_BYTES) {
      throw plaintextTooLarge();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytesToUtf8(plaintext));
    } catch {
      invalidFormat('解密后的数据不是有效 JSON。');
    }
    const envelope = validateWorkspaceBackupEnvelope(parsed);
    return mergeImportedWorkspace(envelope.workspace, currentWorkspace);
  } finally {
    plaintext.fill(0);
    ciphertext.fill(0);
  }
}
