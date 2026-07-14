import { Platform } from 'react-native';

import type {
  AppWorkspace,
  ChatTokenUsage,
  ModelInfo,
  ProviderProfile,
} from '../domain/types';
import { inferModelTask } from './modelCapabilities';
import { isProviderEnabled } from './workspaceRuntime';

export type ProviderAudioProtocol = 'openai-official' | 'bailian-compatible';

export type OpenAiSpeechFormat = 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';

export interface ProviderAudioReadiness {
  ready: boolean;
  canTranscribe: boolean;
  canSynthesize: boolean;
  protocol?: ProviderAudioProtocol;
  reason?:
    | 'unsupported-platform'
    | 'missing-api-key'
    | 'unsupported-provider'
    | 'invalid-base-url';
  message?: string;
}

export type ProviderAudioTargetKind = 'transcription' | 'speech';

export interface ResolvedProviderAudioTarget {
  provider: ProviderProfile;
  model: ModelInfo;
  modelId: string;
}

export interface ProviderAudioEndpoints {
  transcription: string;
  speech: string;
}

export interface ProviderAudioSource {
  uri: string;
  name?: string;
  mimeType?: string;
}

export interface PreparedProviderAudioFile {
  base64: string;
  size: number;
  name: string;
  mimeType: string;
}

export interface ProviderAudioFileAdapter {
  readBase64(source: ProviderAudioSource, maxBytes?: number): Promise<PreparedProviderAudioFile>;
  writeCacheBytes(fileName: string, bytes: Uint8Array): Promise<string>;
  deleteCacheFile?(uri: string): Promise<void>;
}

export interface ProviderAudioHttpRequest {
  protocol: ProviderAudioProtocol;
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: FormData | string;
  responseKind: 'json' | 'audio';
}

export interface BuildAudioTranscriptionRequestArgs {
  provider: ProviderProfile;
  modelId: string;
  file: PreparedProviderAudioFile;
  platform?: string;
}

export interface BuildOpenAiFileBackedTranscriptionRequestArgs {
  provider: ProviderProfile;
  modelId: string;
  source: ProviderAudioSource;
  file: Blob;
  platform?: string;
}

export interface BuildSpeechSynthesisRequestArgs {
  provider: ProviderProfile;
  modelId: string;
  text: string;
  voice: string;
  responseFormat?: OpenAiSpeechFormat;
  languageType?: string;
  platform?: string;
}

export interface ParsedAudioTranscription {
  text: string;
  usage?: ChatTokenUsage;
}

export type ParsedSpeechSynthesisResponse =
  | {
      kind: 'bytes';
      bytes: Uint8Array;
      mimeType: string;
      extension: string;
    }
  | {
      kind: 'download';
      url: string;
    };

export interface TranscribeAudioArgs {
  provider: ProviderProfile;
  modelId: string;
  source: ProviderAudioSource;
  platform?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: ProviderAudioFetch;
  fileAdapter?: ProviderAudioFileAdapter;
}

export interface TranscribeAudioResult extends ParsedAudioTranscription {
  protocol: ProviderAudioProtocol;
}

export interface SynthesizeSpeechArgs extends BuildSpeechSynthesisRequestArgs {
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: ProviderAudioFetch;
  fileAdapter?: ProviderAudioFileAdapter;
}

export interface SynthesizeSpeechResult {
  protocol: ProviderAudioProtocol;
  uri: string;
  size: number;
  mimeType: string;
}

export type ProviderAudioFetch = (input: string, init?: RequestInit) => Promise<Response>;

export class ProviderAudioProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderAudioProtocolError';
  }
}

const mib = 1024 * 1024;
export const OPENAI_AUDIO_MAX_BYTES = 25 * mib;
export const BAILIAN_AUDIO_MAX_BYTES = 10 * mib;
export const PROVIDER_AUDIO_MAX_TEXT_CODE_POINTS = 4096;

const maxJsonResponseBytes = 1 * mib;
const maxErrorResponseBytes = 256 * 1024;
const maxSpeechResponseBytes = 24 * mib;
const maxTranscriptCodePoints = 1_000_000;
const defaultTimeoutMs = 120_000;
const maxTimeoutMs = 300_000;

const bailianLegacyHosts = new Set([
  'dashscope.aliyuncs.com',
  'dashscope-intl.aliyuncs.com',
  'dashscope-us.aliyuncs.com',
]);
const bailianWorkspaceHost = /^[a-z0-9][a-z0-9-]*\.(?:cn-beijing|ap-southeast-1|ap-northeast-1|eu-central-1|us-east-1)\.maas\.aliyuncs\.com$/;

const openAiPaths = new Set([
  '',
  '/v1',
  '/v1/responses',
  '/v1/chat/completions',
  '/v1/models',
  '/v1/audio/transcriptions',
  '/v1/audio/speech',
]);
const bailianPaths = new Set([
  '/compatible-mode/v1',
  '/compatible-mode/v1/responses',
  '/compatible-mode/v1/chat/completions',
  '/compatible-mode/v1/models',
  '/api/v1/services/aigc/multimodal-generation/generation',
]);

const acceptedAudioMimeTypes = new Set([
  'audio/aac',
  'audio/flac',
  'audio/m4a',
  'audio/mp3',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'audio/x-m4a',
  'audio/x-wav',
  'video/mp4',
]);

const mimeByExtension: Record<string, string> = {
  aac: 'audio/aac',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  mp4: 'audio/mp4',
  mpeg: 'audio/mpeg',
  mpga: 'audio/mpeg',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  webm: 'audio/webm',
};

const extensionByMime: Record<string, string> = {
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/m4a': 'm4a',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'audio/x-m4a': 'm4a',
  'audio/x-wav': 'wav',
  'application/octet-stream': 'bin',
  'video/mp4': 'mp4',
};

const speechMimeByFormat: Record<OpenAiSpeechFormat, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/opus',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'application/octet-stream',
};

const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function protocolError(message: string): never {
  throw new ProviderAudioProtocolError(message);
}

function normalizedPath(url: URL): string {
  return url.pathname.replace(/\/+$/, '').toLowerCase();
}

function parseStrictProviderUrl(provider: ProviderProfile): URL {
  let url: URL;
  try {
    url = new URL(provider.baseUrl.trim());
  } catch {
    return protocolError('Provider Base URL is not a valid URL.');
  }

  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    return protocolError(
      'Audio requires an official HTTPS Base URL without credentials, a custom port, query parameters, or a fragment.'
    );
  }
  return url;
}

function assertSupportedPath(url: URL, paths: ReadonlySet<string>, label: string): void {
  if (!paths.has(normalizedPath(url))) {
    protocolError(`${label} Base URL path is not supported for audio.`);
  }
}

export function resolveProviderAudioProtocol(provider: ProviderProfile): ProviderAudioProtocol {
  const url = parseStrictProviderUrl(provider);
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');

  if (provider.kind === 'bailian-compatible') {
    if (!bailianLegacyHosts.has(host) && !bailianWorkspaceHost.test(host)) {
      return protocolError('Bailian audio only accepts an official DashScope or Bailian workspace host.');
    }
    assertSupportedPath(url, bailianPaths, 'Bailian');
    return 'bailian-compatible';
  }

  if (provider.kind === 'custom' || provider.kind === 'openai-compatible') {
    if (host !== 'api.openai.com') {
      return protocolError('OpenAI audio only accepts the official api.openai.com host.');
    }
    assertSupportedPath(url, openAiPaths, 'OpenAI');
    return 'openai-official';
  }

  return protocolError(`Provider kind ${provider.kind} is not enabled for audio.`);
}

export function getProviderAudioReadiness(
  provider: ProviderProfile,
  platform: string = Platform.OS
): ProviderAudioReadiness {
  if (platform !== 'android') {
    return {
      ready: false,
      canTranscribe: false,
      canSynthesize: false,
      reason: 'unsupported-platform',
      message: 'Request-based provider audio is currently enabled on Android only.',
    };
  }

  let protocol: ProviderAudioProtocol;
  try {
    protocol = resolveProviderAudioProtocol(provider);
  } catch (error) {
    return {
      ready: false,
      canTranscribe: false,
      canSynthesize: false,
      reason:
        error instanceof ProviderAudioProtocolError && /Base URL|host/i.test(error.message)
          ? 'invalid-base-url'
          : 'unsupported-provider',
      message: error instanceof Error ? error.message : 'Provider audio is not supported.',
    };
  }

  if (!provider.apiKey?.trim()) {
    return {
      ready: false,
      canTranscribe: false,
      canSynthesize: false,
      protocol,
      reason: 'missing-api-key',
      message: 'An API key supplied by the user is required for provider audio.',
    };
  }

  return {
    ready: true,
    canTranscribe: true,
    canSynthesize: true,
    protocol,
  };
}

/**
 * Resolve a configured voice target only when Chat can execute it now.
 * Settings and Chat share this rule so validity labels and runtime controls
 * cannot drift on provider state, model semantics, platform, or protocol.
 */
export function resolveConfiguredProviderAudioTarget(
  workspace: Pick<AppWorkspace, 'providers' | 'voice'>,
  kind: ProviderAudioTargetKind,
  platform: string = Platform.OS
): ResolvedProviderAudioTarget | null {
  const target =
    kind === 'transcription'
      ? workspace.voice.transcriptionTarget
      : workspace.voice.speechTarget;
  if (!target) return null;

  const provider = workspace.providers.find((item) => item.id === target.providerId);
  const model = provider?.models.find((item) => item.id === target.modelId);
  const expectedTask =
    kind === 'transcription' ? 'audio-transcription' : 'speech-generation';
  const capability = kind === 'transcription' ? 'speech-to-text' : 'text-to-speech';
  if (
    !isProviderEnabled(provider) ||
    !model ||
    inferModelTask(model) !== expectedTask ||
    !model.capabilities.includes(capability)
  ) {
    return null;
  }

  const readiness = getProviderAudioReadiness(provider, platform);
  if (kind === 'transcription' ? !readiness.canTranscribe : !readiness.canSynthesize) {
    return null;
  }
  return { provider, model, modelId: model.id };
}

function assertProviderAudioReady(
  provider: ProviderProfile,
  platform: string = Platform.OS
): ProviderAudioProtocol {
  const readiness = getProviderAudioReadiness(provider, platform);
  if (!readiness.ready || !readiness.protocol) {
    return protocolError(readiness.message ?? 'Provider audio is not ready.');
  }
  return readiness.protocol;
}

export function getProviderAudioEndpoints(provider: ProviderProfile): ProviderAudioEndpoints {
  const protocol = resolveProviderAudioProtocol(provider);
  const origin = parseStrictProviderUrl(provider).origin;
  if (protocol === 'openai-official') {
    return {
      transcription: `${origin}/v1/audio/transcriptions`,
      speech: `${origin}/v1/audio/speech`,
    };
  }
  return {
    transcription: `${origin}/compatible-mode/v1/chat/completions`,
    speech: `${origin}/api/v1/services/aigc/multimodal-generation/generation`,
  };
}

function boundedIdentifier(value: string, label: string, maximum = 200): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    return protocolError(`${label} is missing, too long, or contains control characters.`);
  }
  return normalized;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function boundedSpeechText(value: string): string {
  if (!value.trim()) {
    return protocolError('Speech input text cannot be empty.');
  }
  if (codePointLength(value) > PROVIDER_AUDIO_MAX_TEXT_CODE_POINTS) {
    return protocolError(
      `Speech input exceeds ${PROVIDER_AUDIO_MAX_TEXT_CODE_POINTS} Unicode code points.`
    );
  }
  return value;
}

function canonicalMimeType(value: string, name: string): string {
  const supplied = value.split(';', 1)[0]?.trim().toLowerCase();
  const nameExtension = name.match(/\.([A-Za-z0-9]{1,10})$/)?.[1]?.toLowerCase();
  const inferred = nameExtension ? mimeByExtension[nameExtension] : undefined;
  const mimeType = supplied === 'application/octet-stream' ? inferred : supplied || inferred;
  if (!mimeType || !acceptedAudioMimeTypes.has(mimeType)) {
    return protocolError('The selected file does not use a supported audio MIME type.');
  }
  return mimeType;
}

function sanitizedAudioName(value: string, mimeType: string): string {
  const basename = value.replace(/\\/g, '/').split('/').pop()?.trim() ?? '';
  let sanitized = basename
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 120);
  if (!sanitized) {
    sanitized = `audio.${extensionByMime[mimeType] ?? 'bin'}`;
  } else if (!/\.[A-Za-z0-9]{1,10}$/.test(sanitized)) {
    sanitized = `${sanitized}.${extensionByMime[mimeType] ?? 'bin'}`;
  }
  return sanitized;
}

function normalizedBase64(value: string): { encoded: string; decodedSize: number } {
  const compact = value.replace(/\s+/g, '');
  if (
    !compact ||
    compact.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(compact) ||
    compact.slice(0, -2).includes('=')
  ) {
    return protocolError('The selected audio file contains invalid Base64 data.');
  }
  const encoded = compact.padEnd(compact.length + ((4 - (compact.length % 4)) % 4), '=');
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  return {
    encoded,
    decodedSize: (encoded.length / 4) * 3 - padding,
  };
}

function base64ToBytes(encoded: string, expectedSize: number): Uint8Array {
  const bytes = new Uint8Array(expectedSize);
  let output = 0;
  for (let index = 0; index < encoded.length; index += 4) {
    const a = base64Alphabet.indexOf(encoded[index]);
    const b = base64Alphabet.indexOf(encoded[index + 1]);
    const c = encoded[index + 2] === '=' ? 0 : base64Alphabet.indexOf(encoded[index + 2]);
    const d = encoded[index + 3] === '=' ? 0 : base64Alphabet.indexOf(encoded[index + 3]);
    if (a < 0 || b < 0 || c < 0 || d < 0) {
      return protocolError('The selected audio file contains invalid Base64 data.');
    }
    const value = (a << 18) | (b << 12) | (c << 6) | d;
    if (output < expectedSize) bytes[output++] = (value >> 16) & 0xff;
    if (output < expectedSize) bytes[output++] = (value >> 8) & 0xff;
    if (output < expectedSize) bytes[output++] = value & 0xff;
  }
  return bytes;
}

function validatePreparedAudioFile(
  file: PreparedProviderAudioFile,
  limit: number,
  decodeBytes: boolean
): PreparedProviderAudioFile & { encoded: string; bytes?: Uint8Array } {
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    return protocolError('The selected audio file has an invalid or empty size.');
  }
  if (file.size > limit) {
    return protocolError(`The selected audio file exceeds the ${Math.round(limit / mib)} MB limit.`);
  }
  const mimeType = canonicalMimeType(file.mimeType, file.name);
  const name = sanitizedAudioName(file.name, mimeType);
  const { encoded, decodedSize } = normalizedBase64(file.base64);
  if (decodedSize !== file.size) {
    return protocolError('The selected audio file size does not match its encoded data.');
  }
  return {
    ...file,
    name,
    mimeType,
    encoded,
    ...(decodeBytes ? { bytes: base64ToBytes(encoded, decodedSize) } : {}),
  };
}

function authHeaders(provider: ProviderProfile): Record<string, string> {
  const apiKey = provider.apiKey?.trim();
  if (!apiKey) {
    return protocolError('An API key supplied by the user is required for provider audio.');
  }
  return { Authorization: `Bearer ${apiKey}` };
}

export function buildAudioTranscriptionRequest({
  provider,
  modelId,
  file,
  platform = Platform.OS,
}: BuildAudioTranscriptionRequestArgs): ProviderAudioHttpRequest {
  const protocol = assertProviderAudioReady(provider, platform);
  const model = boundedIdentifier(modelId, 'Transcription model');
  const endpoints = getProviderAudioEndpoints(provider);
  const validated = validatePreparedAudioFile(
    file,
    protocol === 'openai-official' ? OPENAI_AUDIO_MAX_BYTES : BAILIAN_AUDIO_MAX_BYTES,
    protocol === 'openai-official'
  );

  if (protocol === 'bailian-compatible') {
    if (model !== 'qwen3-asr-flash') {
      return protocolError('Bailian transcription currently requires the official qwen3-asr-flash model.');
    }
    return {
      protocol,
      url: endpoints.transcription,
      method: 'POST',
      headers: {
        ...authHeaders(provider),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'input_audio',
                input_audio: {
                  data: `data:${validated.mimeType};base64,${validated.encoded}`,
                },
              },
            ],
          },
        ],
        stream: false,
      }),
      responseKind: 'json',
    };
  }

  const form = new FormData();
  if (!validated.bytes) {
    return protocolError('OpenAI multipart transcription requires decoded audio bytes.');
  }
  const buffer = validated.bytes.buffer.slice(
    validated.bytes.byteOffset,
    validated.bytes.byteOffset + validated.bytes.byteLength
  ) as ArrayBuffer;
  const blob = new Blob([buffer], { type: validated.mimeType });
  form.append('file', blob, validated.name);
  form.append('model', model);
  return {
    protocol,
    url: endpoints.transcription,
    method: 'POST',
    headers: {
      ...authHeaders(provider),
      Accept: 'application/json',
    },
    body: form,
    responseKind: 'json',
  };
}

/**
 * Builds OpenAI multipart form data around an Expo File/Blob without copying the
 * recording through Base64 and a second Uint8Array in the JavaScript heap.
 */
export function buildOpenAiFileBackedTranscriptionRequest({
  provider,
  modelId,
  source,
  file,
  platform = Platform.OS,
}: BuildOpenAiFileBackedTranscriptionRequestArgs): ProviderAudioHttpRequest {
  const protocol = assertProviderAudioReady(provider, platform);
  if (protocol !== 'openai-official') {
    return protocolError('File-backed multipart transcription is only enabled for OpenAI official audio.');
  }
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > OPENAI_AUDIO_MAX_BYTES) {
    return protocolError(`The selected audio file is empty, invalid, or exceeds the ${Math.round(OPENAI_AUDIO_MAX_BYTES / mib)} MB limit.`);
  }
  const requestedName = source.name?.trim() || 'audio';
  const mimeType = canonicalMimeType(source.mimeType?.trim() || file.type || '', requestedName);
  const name = sanitizedAudioName(requestedName, mimeType);
  const form = new FormData();
  form.append('file', file, name);
  form.append('model', boundedIdentifier(modelId, 'Transcription model'));
  return {
    protocol,
    url: getProviderAudioEndpoints(provider).transcription,
    method: 'POST',
    headers: {
      ...authHeaders(provider),
      Accept: 'application/json',
    },
    body: form,
    responseKind: 'json',
  };
}

export function buildSpeechSynthesisRequest({
  provider,
  modelId,
  text,
  voice,
  responseFormat = 'mp3',
  languageType,
  platform = Platform.OS,
}: BuildSpeechSynthesisRequestArgs): ProviderAudioHttpRequest {
  const protocol = assertProviderAudioReady(provider, platform);
  const model = boundedIdentifier(modelId, 'Speech model');
  const input = boundedSpeechText(text);
  const normalizedVoice = boundedIdentifier(voice, 'Speech voice', 100);
  const endpoints = getProviderAudioEndpoints(provider);
  if (!Object.hasOwn(speechMimeByFormat, responseFormat)) {
    return protocolError('Speech response_format is not supported.');
  }

  if (protocol === 'bailian-compatible') {
    if (model !== 'qwen3-tts-flash') {
      return protocolError('Bailian speech currently requires the official qwen3-tts-flash model.');
    }
    const normalizedLanguage = languageType
      ? boundedIdentifier(languageType, 'Bailian language_type', 50)
      : undefined;
    return {
      protocol,
      url: endpoints.speech,
      method: 'POST',
      headers: {
        ...authHeaders(provider),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: {
          text: input,
          voice: normalizedVoice,
          ...(normalizedLanguage ? { language_type: normalizedLanguage } : {}),
        },
      }),
      responseKind: 'json',
    };
  }

  return {
    protocol,
    url: endpoints.speech,
    method: 'POST',
    headers: {
      ...authHeaders(provider),
      Accept: speechMimeByFormat[responseFormat],
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input,
      voice: normalizedVoice,
      response_format: responseFormat,
    }),
    responseKind: 'audio',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function boundedJsonPayload(payload: unknown): Record<string, unknown> {
  let parsed = payload;
  if (typeof payload === 'string') {
    if (utf8ByteLength(payload) > maxJsonResponseBytes) {
      return protocolError('Provider JSON response exceeded the safe size limit.');
    }
    try {
      parsed = JSON.parse(payload);
    } catch {
      return protocolError('Provider returned invalid JSON.');
    }
  }
  if (!isRecord(parsed)) {
    return protocolError('Provider response must be a JSON object.');
  }
  return parsed;
}

function providerErrorFromPayload(payload: Record<string, unknown>): string | undefined {
  if (isRecord(payload.error) && typeof payload.error.message === 'string') {
    return payload.error.message.slice(0, 1000);
  }
  if (typeof payload.message === 'string' && (payload.code != null || payload.status_code != null)) {
    return payload.message.slice(0, 1000);
  }
  return undefined;
}

function safeNonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

function parseTokenUsage(payload: Record<string, unknown>): ChatTokenUsage | undefined {
  if (!isRecord(payload.usage)) {
    return undefined;
  }
  const usage = payload.usage;
  const inputTokens = safeNonNegativeInteger(usage.input_tokens ?? usage.prompt_tokens);
  const outputTokens = safeNonNegativeInteger(usage.output_tokens ?? usage.completion_tokens);
  const totalTokens = safeNonNegativeInteger(usage.total_tokens);
  if (inputTokens == null && outputTokens == null && totalTokens == null) {
    return undefined;
  }
  return { inputTokens, outputTokens, totalTokens };
}

function bailianTranscript(payload: Record<string, unknown>): string | undefined {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = isRecord(choices[0]) ? choices[0] : undefined;
  const message = first && isRecord(first.message) ? first.message : undefined;
  if (!message) return undefined;
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return undefined;
  const parts: string[] = [];
  for (const part of message.content) {
    if (isRecord(part) && typeof part.text === 'string') parts.push(part.text);
  }
  return parts.length ? parts.join('') : undefined;
}

export function parseAudioTranscriptionResponse(
  provider: ProviderProfile,
  payload: unknown
): ParsedAudioTranscription {
  const protocol = resolveProviderAudioProtocol(provider);
  const parsed = boundedJsonPayload(payload);
  const providerError = providerErrorFromPayload(parsed);
  if (providerError) {
    return protocolError(`Provider transcription failed: ${providerError}`);
  }
  const text = protocol === 'openai-official'
    ? typeof parsed.text === 'string'
      ? parsed.text
      : undefined
    : bailianTranscript(parsed);
  if (text == null) {
    return protocolError('Provider transcription response did not contain transcript text.');
  }
  if (codePointLength(text) > maxTranscriptCodePoints) {
    return protocolError('Provider transcript exceeded the safe size limit.');
  }
  return { text, usage: parseTokenUsage(parsed) };
}

function privateOrLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (
    !host ||
    !host.includes('.') && !host.includes(':') ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan')
  ) {
    return true;
  }

  if (host.includes(':')) {
    return (
      host === '::' ||
      host === '::1' ||
      host.startsWith('::ffff:') ||
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      /^fe[89ab]/.test(host)
    );
  }

  const octets = host.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  ) {
    return false;
  }
  const [a, b, c] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

export function validateProviderAudioDownloadUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192) {
    return protocolError('Provider speech download URL is missing or too long.');
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return protocolError('Provider speech download URL is invalid.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    url.hash ||
    privateOrLocalHost(url.hostname)
  ) {
    return protocolError(
      'Provider speech download URL must be a public HTTPS URL without credentials or a fragment.'
    );
  }
  return url.href;
}

function bytesFromUnknown(payload: unknown): Uint8Array | undefined {
  if (payload instanceof Uint8Array) return payload;
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  return undefined;
}

function normalizedResponseContentType(value: string | undefined): string | undefined {
  return value?.split(';', 1)[0]?.trim().toLowerCase() || undefined;
}

export function parseSpeechSynthesisResponse(
  provider: ProviderProfile,
  payload: unknown,
  options: { contentType?: string; responseFormat?: OpenAiSpeechFormat } = {}
): ParsedSpeechSynthesisResponse {
  const protocol = resolveProviderAudioProtocol(provider);
  if (protocol === 'bailian-compatible') {
    const parsed = boundedJsonPayload(payload);
    const providerError = providerErrorFromPayload(parsed);
    if (providerError) {
      return protocolError(`Provider speech synthesis failed: ${providerError}`);
    }
    const output = isRecord(parsed.output) ? parsed.output : undefined;
    const audio = output && isRecord(output.audio) ? output.audio : undefined;
    return {
      kind: 'download',
      url: validateProviderAudioDownloadUrl(audio?.url),
    };
  }

  const bytes = bytesFromUnknown(payload);
  if (!bytes?.byteLength) {
    return protocolError('OpenAI speech response did not contain audio bytes.');
  }
  if (bytes.byteLength > maxSpeechResponseBytes) {
    return protocolError('OpenAI speech response exceeded the safe size limit.');
  }
  const fallbackFormat = options.responseFormat ?? 'mp3';
  const mimeType = normalizedResponseContentType(options.contentType) ?? speechMimeByFormat[fallbackFormat];
  if (!mimeType.startsWith('audio/') && mimeType !== 'application/octet-stream') {
    return protocolError(`OpenAI speech response returned an unsafe Content-Type: ${mimeType}`);
  }
  return {
    kind: 'bytes',
    bytes,
    mimeType,
    extension:
      extensionByMime[mimeType] ?? (fallbackFormat === 'pcm' ? 'pcm' : fallbackFormat),
  };
}

function abortError(message = 'Provider audio request was cancelled.'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function normalizedTimeout(value?: number): number {
  const timeout = value ?? defaultTimeoutMs;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > maxTimeoutMs) {
    return protocolError(`Audio timeout must be between 1 and ${maxTimeoutMs} milliseconds.`);
  }
  return Math.floor(timeout);
}

async function withTimeout<T>(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  throwIfAborted(signal);
  const controller = new AbortController();
  let rejectBoundary: ((reason: Error) => void) | undefined;
  const boundary = new Promise<never>((_resolve, reject) => {
    rejectBoundary = reject;
  });
  const onAbort = () => {
    controller.abort();
    rejectBoundary?.(abortError());
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort();
    rejectBoundary?.(abortError('Provider audio request timed out.'));
  }, normalizedTimeout(timeoutMs));

  try {
    return await Promise.race([operation(controller.signal), boundary]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function declaredContentLength(response: Response): number | undefined {
  const raw = response.headers.get('content-length');
  if (!raw) return undefined;
  const size = Number(raw);
  return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
}

async function readBoundedBytes(
  response: Response,
  limit: number,
  signal: AbortSignal
): Promise<Uint8Array> {
  const declared = declaredContentLength(response);
  if (declared != null && declared > limit) {
    return protocolError('Provider response Content-Length exceeded the safe size limit.');
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throwIfAborted(signal);
    const bytes = new Uint8Array(await response.arrayBuffer());
    throwIfAborted(signal);
    if (bytes.byteLength > limit) {
      return protocolError('Provider response exceeded the safe size limit.');
    }
    return bytes;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return protocolError('Provider response exceeded the safe size limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return protocolError('Provider returned invalid UTF-8 text.');
  }
}

async function readBoundedText(
  response: Response,
  limit: number,
  signal: AbortSignal
): Promise<string> {
  return decodeUtf8(await readBoundedBytes(response, limit, signal));
}

async function assertSuccessfulResponse(response: Response, signal: AbortSignal): Promise<void> {
  if (response.ok) return;
  let detail = '';
  try {
    detail = (await readBoundedText(response, maxErrorResponseBytes, signal))
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .trim()
      .slice(0, 1000);
  } catch {
    // Status remains enough evidence when an error body is malformed or oversized.
  }
  protocolError(`Provider audio request failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}.`);
}

function effectiveFetch(fetchImpl?: ProviderAudioFetch): ProviderAudioFetch {
  if (fetchImpl) return fetchImpl;
  if (typeof globalThis.fetch !== 'function') {
    return protocolError('This runtime does not provide fetch for provider audio.');
  }
  return globalThis.fetch.bind(globalThis) as ProviderAudioFetch;
}

async function effectiveFileBackedFetch(fetchImpl?: ProviderAudioFetch): Promise<ProviderAudioFetch> {
  if (fetchImpl) return fetchImpl;
  const expoFetch = (await import('expo/fetch')).fetch;
  return expoFetch as ProviderAudioFetch;
}

export function createExpoProviderAudioFileAdapter(): ProviderAudioFileAdapter {
  return {
    async readBase64(source, maxBytes) {
      const { File } = await import('expo-file-system');
      const file = new File(source.uri);
      if (!file.exists) {
        return protocolError('The selected local audio file no longer exists.');
      }
      const size = file.size;
      if (!Number.isSafeInteger(size) || (size ?? 0) <= 0) {
        return protocolError('The selected local audio file is empty or has an invalid size.');
      }
      if (maxBytes != null && (size as number) > maxBytes) {
        return protocolError(
          `The selected audio file exceeds the ${Math.round(maxBytes / mib)} MB limit.`
        );
      }
      return {
        base64: await file.base64(),
        size: size as number,
        name: source.name?.trim() || file.name || 'audio',
        mimeType: source.mimeType?.trim() || file.type || '',
      };
    },
    async writeCacheBytes(fileName, bytes) {
      const { File, Paths } = await import('expo-file-system');
      const safeName = fileName
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '')
        .slice(0, 120);
      if (!safeName || !bytes.byteLength || bytes.byteLength > maxSpeechResponseBytes) {
        return protocolError('Generated speech cache data is invalid.');
      }
      const destination = new File(Paths.cache, safeName);
      try {
        destination.create({ intermediates: true, overwrite: true });
        destination.write(bytes);
        return destination.uri;
      } catch (error) {
        try {
          if (destination.exists) destination.delete();
        } catch {
          // Best-effort cleanup of a partial cache file.
        }
        throw error;
      }
    },
    async deleteCacheFile(uri) {
      const { File } = await import('expo-file-system');
      const file = new File(uri);
      if (file.exists) file.delete();
    },
  };
}

function cacheFileName(extension: string): string {
  const nonce = Math.random().toString(36).slice(2, 10);
  return `embezzle-speech-${Date.now()}-${nonce}.${extension.replace(/[^a-z0-9]/gi, '') || 'bin'}`;
}

function requestInit(request: ProviderAudioHttpRequest, signal: AbortSignal): RequestInit {
  return {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal,
    redirect: 'error',
  };
}

export async function transcribeAudio({
  provider,
  modelId,
  source,
  platform = Platform.OS,
  signal,
  timeoutMs,
  fetchImpl,
  fileAdapter,
}: TranscribeAudioArgs): Promise<TranscribeAudioResult> {
  const protocol = assertProviderAudioReady(provider, platform);
  throwIfAborted(signal);
  let request: ProviderAudioHttpRequest;
  let usesFileBackedMultipart = false;
  if (protocol === 'openai-official' && !fileAdapter) {
    const { File } = await import('expo-file-system');
    const localFile = new File(source.uri);
    if (!localFile.exists) {
      return protocolError('The selected local audio file no longer exists.');
    }
    request = buildOpenAiFileBackedTranscriptionRequest({
      provider,
      modelId,
      source: {
        ...source,
        name: source.name?.trim() || localFile.name,
        mimeType: source.mimeType?.trim() || localFile.type,
      },
      file: localFile,
      platform,
    });
    usesFileBackedMultipart = true;
  } else {
    const adapter = fileAdapter ?? createExpoProviderAudioFileAdapter();
    const file = await adapter.readBase64(
      source,
      protocol === 'openai-official' ? OPENAI_AUDIO_MAX_BYTES : BAILIAN_AUDIO_MAX_BYTES
    );
    request = buildAudioTranscriptionRequest({ provider, modelId, file, platform });
  }
  throwIfAborted(signal);
  const fetcher = usesFileBackedMultipart
    ? await effectiveFileBackedFetch(fetchImpl)
    : effectiveFetch(fetchImpl);
  const payload = await withTimeout(signal, timeoutMs, async (requestSignal) => {
    const response = await fetcher(request.url, requestInit(request, requestSignal));
    await assertSuccessfulResponse(response, requestSignal);
    return readBoundedText(response, maxJsonResponseBytes, requestSignal);
  });
  return { protocol, ...parseAudioTranscriptionResponse(provider, payload) };
}

async function fetchSpeechBytes(
  url: string,
  init: RequestInit,
  fetcher: ProviderAudioFetch,
  signal: AbortSignal,
  fallbackFormat: OpenAiSpeechFormat
): Promise<{ bytes: Uint8Array; mimeType: string; extension: string }> {
  const response = await fetcher(url, { ...init, signal, redirect: 'error' });
  await assertSuccessfulResponse(response, signal);
  if (response.url) validateProviderAudioDownloadUrl(response.url);
  const bytes = await readBoundedBytes(response, maxSpeechResponseBytes, signal);
  const contentType = normalizedResponseContentType(response.headers.get('content-type') ?? undefined);
  const mimeType = contentType ?? speechMimeByFormat[fallbackFormat];
  if (!mimeType.startsWith('audio/') && mimeType !== 'application/octet-stream') {
    return protocolError(`Provider speech download returned an unsafe Content-Type: ${mimeType}`);
  }
  return {
    bytes,
    mimeType,
    extension: extensionByMime[mimeType] ?? (fallbackFormat === 'pcm' ? 'pcm' : fallbackFormat),
  };
}

export async function synthesizeSpeech({
  provider,
  modelId,
  text,
  voice,
  responseFormat = 'mp3',
  languageType,
  platform = Platform.OS,
  signal,
  timeoutMs,
  fetchImpl,
  fileAdapter,
}: SynthesizeSpeechArgs): Promise<SynthesizeSpeechResult> {
  const protocol = assertProviderAudioReady(provider, platform);
  const request = buildSpeechSynthesisRequest({
    provider,
    modelId,
    text,
    voice,
    responseFormat,
    languageType,
    platform,
  });
  const fetcher = effectiveFetch(fetchImpl);
  const adapter = fileAdapter ?? createExpoProviderAudioFileAdapter();

  let speech: { bytes: Uint8Array; mimeType: string; extension: string };
  if (protocol === 'openai-official') {
    speech = await withTimeout(signal, timeoutMs, async (requestSignal) => {
      const response = await fetcher(request.url, requestInit(request, requestSignal));
      await assertSuccessfulResponse(response, requestSignal);
      const bytes = await readBoundedBytes(response, maxSpeechResponseBytes, requestSignal);
      const parsed = parseSpeechSynthesisResponse(provider, bytes, {
        contentType: response.headers.get('content-type') ?? undefined,
        responseFormat,
      });
      if (parsed.kind !== 'bytes') {
        return protocolError('OpenAI speech response unexpectedly required a download URL.');
      }
      return parsed;
    });
  } else {
    const downloadUrl = await withTimeout(signal, timeoutMs, async (requestSignal) => {
      const response = await fetcher(request.url, requestInit(request, requestSignal));
      await assertSuccessfulResponse(response, requestSignal);
      const payload = await readBoundedText(response, maxJsonResponseBytes, requestSignal);
      const parsed = parseSpeechSynthesisResponse(provider, payload, { responseFormat });
      if (parsed.kind !== 'download') {
        return protocolError('Bailian speech response did not provide a download URL.');
      }
      return parsed.url;
    });
    speech = await withTimeout(signal, timeoutMs, (requestSignal) =>
      fetchSpeechBytes(
        validateProviderAudioDownloadUrl(downloadUrl),
        { method: 'GET' },
        fetcher,
        requestSignal,
        responseFormat
      )
    );
  }

  throwIfAborted(signal);
  if (!speech.bytes.byteLength) {
    return protocolError('Provider returned an empty speech file.');
  }
  const uri = await adapter.writeCacheBytes(cacheFileName(speech.extension), speech.bytes);
  try {
    throwIfAborted(signal);
  } catch (error) {
    try {
      await adapter.deleteCacheFile?.(uri);
    } catch {
      // Preserve the cancellation result; cache cleanup remains best effort.
    }
    throw error;
  }
  return {
    protocol,
    uri,
    size: speech.bytes.byteLength,
    mimeType: speech.mimeType,
  };
}
