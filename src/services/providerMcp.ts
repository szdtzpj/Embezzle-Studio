import type { ChatCompletionResult, ChatTokenUsage } from '../domain/types';

export type ProviderMcpWireProtocol = 'openai-official' | 'volcengine-ark';
export type ProviderMcpApprovalDecision = 'approve' | 'deny' | 'cancel';

export interface ProviderMcpServerConfig {
  serverLabel: string;
  serverUrl: string;
  allowedTools: readonly string[];
  authorization?: string;
}

export type ProviderMcpAllowedToolsWire = string[] | { tool_names: string[] };

export interface ProviderMcpToolWireDefinition {
  type: 'mcp';
  server_label: string;
  server_url: string;
  authorization?: string;
  require_approval: 'always';
  allowed_tools: ProviderMcpAllowedToolsWire;
}

export interface ProviderMcpRequestBody {
  model: string;
  input: Record<string, unknown>[];
  tools: [ProviderMcpToolWireDefinition];
  store: false;
  include: ['reasoning.encrypted_content'];
  parallel_tool_calls: false;
  max_output_tokens?: number;
}

export interface BuildProviderMcpRequestArgs {
  protocol: ProviderMcpWireProtocol;
  modelId: string;
  input: readonly unknown[];
  server: ProviderMcpServerConfig;
  maxOutputTokens?: number;
}

export interface ProviderMcpApprovalRequest {
  id: string;
  serverLabel: string;
  toolName: string;
  rawArguments: string;
  arguments: Readonly<Record<string, unknown>>;
  argumentBytes: number;
}

export interface ProviderMcpApprovalReceipt {
  approvalRequestId: string;
  serverLabel: string;
  toolName: string;
  decision: Exclude<ProviderMcpApprovalDecision, 'cancel'>;
  argumentBytes: number;
}

export interface ProviderMcpCallReceipt {
  callId: string;
  approvalRequestId?: string;
  serverLabel: string;
  toolName: string;
  outcome: 'completed' | 'failed';
}

export interface ProviderMcpReceipt {
  protocol: 'openai-official';
  serverLabel: string;
  requestCount: number;
  responseIds: string[];
  listedTools: string[];
  approvals: ProviderMcpApprovalReceipt[];
  calls: ProviderMcpCallReceipt[];
  usage?: ChatTokenUsage;
}

export interface ProviderMcpRunResult {
  result: ChatCompletionResult;
  receipt: ProviderMcpReceipt;
  providerRequestCount: number;
}

export interface ProviderMcpSendContext {
  requestNumber: number;
  signal?: AbortSignal;
}

export interface ProviderMcpApprovalContext {
  approvalNumber: number;
  requestNumber: number;
  signal?: AbortSignal;
}

export interface ProviderMcpContinuationContext {
  nextRequestNumber: number;
  approvals: readonly ProviderMcpApprovalReceipt[];
  signal?: AbortSignal;
}

export interface RunOpenAiProviderMcpArgs
  extends Omit<BuildProviderMcpRequestArgs, 'protocol'> {
  protocol?: 'openai-official';
  sendRequest: (
    body: ProviderMcpRequestBody,
    context: ProviderMcpSendContext
  ) => Promise<unknown> | unknown;
  requestApproval: (
    request: ProviderMcpApprovalRequest,
    context: ProviderMcpApprovalContext
  ) => Promise<ProviderMcpApprovalDecision> | ProviderMcpApprovalDecision;
  beforeContinuation?: (
    context: ProviderMcpContinuationContext
  ) => Promise<void> | void;
  signal?: AbortSignal;
}

export const providerMcpLimits = Object.freeze({
  maxAllowedTools: 64,
  maxToolNameCharacters: 128,
  maxServerLabelCharacters: 64,
  maxServerUrlCharacters: 2_048,
  maxAuthorizationBytes: 64 * 1024,
  // Keep the exact approval payload safe to render in one React Native Text.
  maxArgumentsBytes: 32 * 1024,
  maxArgumentDepth: 16,
  maxArgumentKeys: 1_024,
  maxArgumentNodes: 8_192,
  maxArgumentKeyBytes: 1_024,
  maxResponseJsonBytes: 16 * 1024 * 1024,
  maxResponseOutputItems: 256,
  maxOutputCharacters: 2_000_000,
  maxApprovals: 4,
  maxInputItems: 1_000,
});

export class ProviderMcpProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderMcpProtocolError';
  }
}

export class ProviderMcpCancelledError extends Error {
  constructor() {
    super('MCP request was cancelled.');
    this.name = 'AbortError';
  }
}

interface NormalizedServerConfig {
  serverLabel: string;
  serverUrl: string;
  allowedTools: string[];
  allowedToolSet: Set<string>;
  authorization?: string;
}

interface ParsedMcpStep {
  responseId: string;
  output: Record<string, unknown>[];
  content?: string;
  reasoningContent?: string;
  usage?: ChatTokenUsage;
  listedTools: string[];
  approvalRequests: ProviderMcpApprovalRequest[];
  calls: ProviderMcpCallReceipt[];
}

interface ParseMcpStepContext {
  server: NormalizedServerConfig;
  knownListedTools: ReadonlySet<string>;
  seenApprovalRequestIds: ReadonlySet<string>;
  seenCallIds: ReadonlySet<string>;
  approvedRequests: ReadonlyMap<string, ApprovedRequestEvidence>;
  consumedApprovalRequestIds: ReadonlySet<string>;
}

interface ApprovedRequestEvidence {
  toolName: string;
  rawArguments: string;
}

const safeServerLabel = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const safeToolName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const safeWireId = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const responseId = /^resp_[A-Za-z0-9_-]{1,250}$/;
const unsafeArgumentKeyCodePoint = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u206f]/u;

function protocolError(message: string): never {
  throw new ProviderMcpProtocolError(message);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertSafeWireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !safeWireId.test(value)) {
    return protocolError(`${label} is missing or malformed.`);
  }
  return value;
}

function normalizedModelId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    return protocolError('MCP model id is missing or malformed.');
  }
  return normalized;
}

function privateIpv4(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return false;
  }
  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) {
    return true;
  }
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0 && octets[2] === 113) ||
    a >= 224
  );
}

function unsafeServerHostname(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');
  if (
    !normalized ||
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal') ||
    normalized.endsWith('.lan') ||
    normalized.endsWith('.home') ||
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized)
  ) {
    return true;
  }
  if (normalized.startsWith('::ffff:')) {
    return privateIpv4(normalized.slice('::ffff:'.length));
  }
  if (privateIpv4(normalized)) {
    return true;
  }
  return !normalized.includes('.') && !normalized.includes(':');
}

function normalizedServerUrl(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > providerMcpLimits.maxServerUrlCharacters) {
    return protocolError('MCP server URL is missing or too long.');
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return protocolError('MCP server URL is malformed.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    unsafeServerHostname(url.hostname)
  ) {
    return protocolError('MCP server URL must be a public HTTPS URL without credentials, query, or fragment.');
  }
  return url.toString();
}

export function normalizeProviderMcpAllowedTools(value: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    return protocolError('MCP allowedTools must contain at least one tool.');
  }
  if (value.length > providerMcpLimits.maxAllowedTools) {
    return protocolError(`MCP allowedTools exceeds the ${providerMcpLimits.maxAllowedTools}-tool limit.`);
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') {
      return protocolError('Every MCP allowed tool must be a string.');
    }
    const name = item.trim();
    if (!safeToolName.test(name)) {
      return protocolError('An MCP allowed tool name is malformed.');
    }
    if (seen.has(name)) {
      return protocolError('MCP allowedTools contains a duplicate tool name.');
    }
    seen.add(name);
    normalized.push(name);
  }
  return normalized;
}

function normalizedAuthorization(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !value ||
    value.trim() !== value ||
    utf8Bytes(value) > providerMcpLimits.maxAuthorizationBytes ||
    /[^\x20-\x7e]/u.test(value)
  ) {
    return protocolError('MCP authorization value is malformed or too large.');
  }
  return value;
}

function normalizeServer(server: ProviderMcpServerConfig): NormalizedServerConfig {
  if (!server || typeof server.serverLabel !== 'string' || !safeServerLabel.test(server.serverLabel)) {
    return protocolError('MCP server label is missing or malformed.');
  }
  const allowedTools = normalizeProviderMcpAllowedTools(server.allowedTools);
  return {
    serverLabel: server.serverLabel,
    serverUrl: normalizedServerUrl(server.serverUrl),
    allowedTools,
    allowedToolSet: new Set(allowedTools),
    authorization: normalizedAuthorization(server.authorization),
  };
}

function cloneInput(value: readonly unknown[], label: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > providerMcpLimits.maxInputItems) {
    return protocolError(`${label} must contain 1-${providerMcpLimits.maxInputItems} items.`);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return protocolError(`${label} is not JSON serializable.`);
  }
  if (!serialized || utf8Bytes(serialized) > providerMcpLimits.maxResponseJsonBytes) {
    return protocolError(`${label} is empty or too large.`);
  }
  const cloned = JSON.parse(serialized) as unknown;
  if (!Array.isArray(cloned) || cloned.some((item) => !isRecord(item))) {
    return protocolError(`${label} must contain JSON objects.`);
  }
  return cloned;
}

function normalizedOutputLimit(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 64 || value > 131_072) {
    return protocolError('MCP max_output_tokens must be an integer from 64 through 131072.');
  }
  return value;
}

function wireAllowedTools(
  protocol: ProviderMcpWireProtocol,
  allowedTools: string[]
): ProviderMcpAllowedToolsWire {
  return protocol === 'openai-official'
    ? [...allowedTools]
    : { tool_names: [...allowedTools] };
}

export function buildProviderMcpRequest({
  protocol,
  modelId,
  input,
  server,
  maxOutputTokens,
}: BuildProviderMcpRequestArgs): ProviderMcpRequestBody {
  if (protocol !== 'openai-official' && protocol !== 'volcengine-ark') {
    return protocolError('Unsupported MCP wire protocol.');
  }
  const normalizedServer = normalizeServer(server);
  const tool: ProviderMcpToolWireDefinition = {
    type: 'mcp',
    server_label: normalizedServer.serverLabel,
    server_url: normalizedServer.serverUrl,
    require_approval: 'always',
    allowed_tools: wireAllowedTools(protocol, normalizedServer.allowedTools),
  };
  if (normalizedServer.authorization !== undefined) {
    tool.authorization = normalizedServer.authorization;
  }
  const body: ProviderMcpRequestBody = {
    model: normalizedModelId(modelId),
    input: cloneInput(input, 'MCP input'),
    tools: [tool],
    store: false,
    include: ['reasoning.encrypted_content'],
    parallel_tool_calls: false,
  };
  const outputLimit = normalizedOutputLimit(maxOutputTokens);
  if (outputLimit !== undefined) {
    body.max_output_tokens = outputLimit;
  }
  return body;
}

interface BuildProviderMcpContinuationArgs
  extends Omit<BuildProviderMcpRequestArgs, 'input'> {
  conversationInput: readonly unknown[];
  approvals: readonly ProviderMcpApprovalReceipt[];
}

export function buildProviderMcpContinuationRequest({
  conversationInput,
  approvals,
  ...base
}: BuildProviderMcpContinuationArgs): ProviderMcpRequestBody {
  if (!Array.isArray(approvals) || approvals.length === 0) {
    return protocolError('MCP continuation requires at least one approval decision.');
  }
  const approvalItems = approvals.map((approval) => ({
    type: 'mcp_approval_response',
    approval_request_id: assertSafeWireId(approval.approvalRequestId, 'MCP approval request id'),
    approve: approval.decision === 'approve',
  }));
  return buildProviderMcpRequest({
    ...base,
    input: [...conversationInput, ...approvalItems],
  });
}

class ArgumentJsonParser {
  private index = 0;
  private keyCount = 0;
  private nodeCount = 0;

  constructor(private readonly source: string) {}

  parseObjectRoot(): Readonly<Record<string, unknown>> {
    this.skipWhitespace();
    if (this.source[this.index] !== '{') {
      return protocolError('MCP arguments must be a JSON object.');
    }
    const value = this.parseObject(1);
    this.skipWhitespace();
    if (this.index !== this.source.length) {
      return protocolError('MCP arguments contain trailing data.');
    }
    return deepFreezeJson(value) as Readonly<Record<string, unknown>>;
  }

  private countNode(): void {
    this.nodeCount += 1;
    if (this.nodeCount > providerMcpLimits.maxArgumentNodes) {
      return protocolError('MCP arguments contain too many JSON values.');
    }
  }

  private assertDepth(depth: number): void {
    if (depth > providerMcpLimits.maxArgumentDepth) {
      return protocolError('MCP arguments exceed the maximum JSON depth.');
    }
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.source[this.index] ?? '') && /[ \t\r\n]/.test(this.source[this.index])) {
      this.index += 1;
    }
  }

  private parseValue(depth: number): unknown {
    this.skipWhitespace();
    this.countNode();
    const character = this.source[this.index];
    if (character === '{') {
      this.assertDepth(depth);
      return this.parseObject(depth);
    }
    if (character === '[') {
      this.assertDepth(depth);
      return this.parseArray(depth);
    }
    if (character === '"') {
      return this.parseString();
    }
    if (character === 't' && this.consumeLiteral('true')) {
      return true;
    }
    if (character === 'f' && this.consumeLiteral('false')) {
      return false;
    }
    if (character === 'n' && this.consumeLiteral('null')) {
      return null;
    }
    return this.parseNumber();
  }

  private parseObject(depth: number): Record<string, unknown> {
    this.index += 1;
    const result = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.source[this.index] === '}') {
      this.index += 1;
      return result;
    }
    while (this.index < this.source.length) {
      this.skipWhitespace();
      if (this.source[this.index] !== '"') {
        return protocolError('MCP arguments contain a malformed object key.');
      }
      const key = this.parseString();
      assertSafeArgumentKey(key);
      this.keyCount += 1;
      if (this.keyCount > providerMcpLimits.maxArgumentKeys) {
        return protocolError('MCP arguments contain too many object keys.');
      }
      if (keys.has(key)) {
        return protocolError('MCP arguments contain a duplicate object key.');
      }
      keys.add(key);
      this.skipWhitespace();
      if (this.source[this.index] !== ':') {
        return protocolError('MCP arguments contain a malformed object member.');
      }
      this.index += 1;
      const value = this.parseValue(depth + 1);
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
      this.skipWhitespace();
      if (this.source[this.index] === '}') {
        this.index += 1;
        return result;
      }
      if (this.source[this.index] !== ',') {
        return protocolError('MCP arguments contain a malformed object.');
      }
      this.index += 1;
    }
    return protocolError('MCP arguments contain an unterminated object.');
  }

  private parseArray(depth: number): unknown[] {
    this.index += 1;
    const result: unknown[] = [];
    this.skipWhitespace();
    if (this.source[this.index] === ']') {
      this.index += 1;
      return result;
    }
    while (this.index < this.source.length) {
      result.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      if (this.source[this.index] === ']') {
        this.index += 1;
        return result;
      }
      if (this.source[this.index] !== ',') {
        return protocolError('MCP arguments contain a malformed array.');
      }
      this.index += 1;
    }
    return protocolError('MCP arguments contain an unterminated array.');
  }

  private parseString(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const code = this.source.charCodeAt(this.index);
      if (code < 0x20) {
        return protocolError('MCP arguments contain an invalid JSON string.');
      }
      if (code === 0x22) {
        this.index += 1;
        try {
          return JSON.parse(this.source.slice(start, this.index)) as string;
        } catch {
          return protocolError('MCP arguments contain an invalid JSON string.');
        }
      }
      if (code === 0x5c) {
        this.index += 1;
        const escape = this.source[this.index];
        if (!escape || !/["\\/bfnrtu]/.test(escape)) {
          return protocolError('MCP arguments contain an invalid JSON escape.');
        }
        if (escape === 'u') {
          const digits = this.source.slice(this.index + 1, this.index + 5);
          if (!/^[0-9A-Fa-f]{4}$/.test(digits)) {
            return protocolError('MCP arguments contain an invalid Unicode escape.');
          }
          this.index += 4;
        }
      }
      this.index += 1;
    }
    return protocolError('MCP arguments contain an unterminated JSON string.');
  }

  private consumeLiteral(literal: string): boolean {
    if (this.source.slice(this.index, this.index + literal.length) !== literal) {
      return false;
    }
    this.index += literal.length;
    return true;
  }

  private parseNumber(): number {
    const match = this.source
      .slice(this.index)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) {
      return protocolError('MCP arguments contain an invalid JSON value.');
    }
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) {
      return protocolError('MCP arguments contain a non-finite number.');
    }
    return value;
  }
}

function assertSafeArgumentKey(key: string): void {
  if (
    !key ||
    utf8Bytes(key) > providerMcpLimits.maxArgumentKeyBytes ||
    unsafeArgumentKeyCodePoint.test(key)
  ) {
    return protocolError('MCP arguments contain an unsafe object key.');
  }
  for (const character of key) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      return protocolError('MCP arguments contain an unsafe object key.');
    }
  }
}

function deepFreezeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreezeJson(item);
    }
    return Object.freeze(value);
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      deepFreezeJson(item);
    }
    return Object.freeze(value);
  }
  return value;
}

export function parseProviderMcpArguments(rawArguments: string): Readonly<Record<string, unknown>> {
  if (typeof rawArguments !== 'string') {
    return protocolError('MCP arguments must be a JSON string.');
  }
  if (utf8Bytes(rawArguments) > providerMcpLimits.maxArgumentsBytes) {
    return protocolError('MCP arguments exceed the 32 KiB UTF-8 limit.');
  }
  return new ArgumentJsonParser(rawArguments).parseObjectRoot();
}

function normalizedResponsePayload(payload: unknown): {
  parsed: Record<string, unknown>;
  serialized: string;
} {
  let serialized: string;
  if (typeof payload === 'string') {
    serialized = payload;
  } else {
    try {
      serialized = JSON.stringify(payload);
    } catch {
      return protocolError('MCP Responses payload is not valid JSON.');
    }
  }
  if (!serialized || utf8Bytes(serialized) > providerMcpLimits.maxResponseJsonBytes) {
    return protocolError('MCP Responses payload is empty or exceeds the response size limit.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return protocolError('MCP Responses payload is malformed JSON.');
  }
  if (!isRecord(parsed)) {
    return protocolError('MCP Responses payload must be a JSON object.');
  }
  return { parsed, serialized };
}

function responseContainsAuthorization(value: unknown, authorization: string | undefined): boolean {
  if (!authorization) {
    return false;
  }
  const stack: unknown[] = [value];
  let visited = 0;
  while (stack.length) {
    visited += 1;
    if (visited > 100_000) {
      return true;
    }
    const current = stack.pop();
    if (typeof current === 'string' && current.includes(authorization)) {
      return true;
    }
    if (Array.isArray(current)) {
      stack.push(...current);
    } else if (isRecord(current)) {
      stack.push(...Object.values(current));
    }
  }
  return false;
}

function assertExpectedServerLabel(value: unknown, expected: string, label: string): string {
  if (typeof value !== 'string' || value !== expected) {
    return protocolError(`${label} has an unknown server_label.`);
  }
  return value;
}

function assertAllowedTool(value: unknown, server: NormalizedServerConfig, label: string): string {
  if (typeof value !== 'string' || !safeToolName.test(value) || !server.allowedToolSet.has(value)) {
    return protocolError(`${label} references a tool outside allowedTools.`);
  }
  return value;
}

function boundedString(value: unknown, label: string, maxCharacters: number): string {
  if (typeof value !== 'string' || value.length > maxCharacters) {
    return protocolError(`${label} is missing or too large.`);
  }
  return value;
}

function optionalUsageNumber(
  object: Record<string, unknown>,
  key: string,
  label: string
): number | undefined {
  const value = object[key];
  if (value == null) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return protocolError(`${label}.${key} must be a non-negative safe integer.`);
  }
  return value as number;
}

function parseUsage(payload: Record<string, unknown>): ChatTokenUsage | undefined {
  if (payload.usage == null) {
    return undefined;
  }
  if (!isRecord(payload.usage)) {
    return protocolError('MCP Responses usage must be a JSON object.');
  }
  const inputDetails = isRecord(payload.usage.input_tokens_details)
    ? payload.usage.input_tokens_details
    : {};
  const outputDetails = isRecord(payload.usage.output_tokens_details)
    ? payload.usage.output_tokens_details
    : {};
  const usage: ChatTokenUsage = {
    inputTokens: optionalUsageNumber(payload.usage, 'input_tokens', 'usage'),
    outputTokens: optionalUsageNumber(payload.usage, 'output_tokens', 'usage'),
    reasoningTokens: optionalUsageNumber(
      outputDetails,
      'reasoning_tokens',
      'usage.output_tokens_details'
    ),
    cachedInputTokens: optionalUsageNumber(
      inputDetails,
      'cached_tokens',
      'usage.input_tokens_details'
    ),
    totalTokens: optionalUsageNumber(payload.usage, 'total_tokens', 'usage'),
  };
  return Object.values(usage).some((item) => item !== undefined) ? usage : undefined;
}

function parseMessageItem(item: Record<string, unknown>): string | undefined {
  if (!Array.isArray(item.content) || item.content.length > providerMcpLimits.maxResponseOutputItems) {
    return protocolError('MCP message output content is malformed or too large.');
  }
  const parts: string[] = [];
  for (const content of item.content) {
    if (!isRecord(content)) {
      return protocolError('MCP message output contains a malformed content item.');
    }
    if (content.type === 'output_text') {
      parts.push(boundedString(content.text, 'MCP output text', providerMcpLimits.maxOutputCharacters));
    } else if (content.type === 'refusal') {
      parts.push(boundedString(content.refusal, 'MCP refusal text', providerMcpLimits.maxOutputCharacters));
    } else {
      return protocolError('MCP message output contains an unsupported content type.');
    }
  }
  const joined = parts.join('');
  if (joined.length > providerMcpLimits.maxOutputCharacters) {
    return protocolError('MCP output text exceeds the character limit.');
  }
  return joined || undefined;
}

function parseReasoningItem(item: Record<string, unknown>): string | undefined {
  const encryptedContent = boundedString(
    item.encrypted_content,
    'MCP encrypted reasoning content',
    providerMcpLimits.maxResponseJsonBytes
  );
  if (!encryptedContent.trim()) {
    return protocolError(
      'MCP reasoning item is missing usable encrypted_content for stateless continuation.'
    );
  }
  if (item.summary == null) {
    return undefined;
  }
  if (!Array.isArray(item.summary) || item.summary.length > providerMcpLimits.maxResponseOutputItems) {
    return protocolError('MCP reasoning summary is malformed or too large.');
  }
  const summaries: string[] = [];
  for (const summary of item.summary) {
    if (!isRecord(summary) || summary.type !== 'summary_text') {
      return protocolError('MCP reasoning summary contains an unsupported item.');
    }
    const text = boundedString(
      summary.text,
      'MCP reasoning summary text',
      providerMcpLimits.maxOutputCharacters
    );
    if (text.trim()) {
      summaries.push(text.trim());
    }
  }
  const joined = summaries.join('\n\n');
  if (joined.length > providerMcpLimits.maxOutputCharacters) {
    return protocolError('MCP reasoning summary exceeds the character limit.');
  }
  return joined || undefined;
}

function parseListedTools(
  item: Record<string, unknown>,
  server: NormalizedServerConfig
): string[] {
  assertSafeWireId(item.id, 'mcp_list_tools id');
  assertExpectedServerLabel(item.server_label, server.serverLabel, 'mcp_list_tools');
  if (item.error != null) {
    return protocolError(
      Array.isArray(item.tools)
        ? 'mcp_list_tools cannot contain both an error and a tool list.'
        : 'mcp_list_tools returned an error.'
    );
  }
  if (!Array.isArray(item.tools) || item.tools.length > providerMcpLimits.maxAllowedTools) {
    return protocolError('mcp_list_tools.tools is malformed or too large.');
  }
  const listed: string[] = [];
  const seen = new Set<string>();
  for (const tool of item.tools) {
    if (!isRecord(tool)) {
      return protocolError('mcp_list_tools contains a malformed tool descriptor.');
    }
    const name = assertAllowedTool(tool.name, server, 'mcp_list_tools');
    if (seen.has(name)) {
      return protocolError('mcp_list_tools contains a duplicate tool.');
    }
    seen.add(name);
    listed.push(name);
  }
  return listed;
}

function parseApprovalRequest(
  item: Record<string, unknown>,
  context: ParseMcpStepContext,
  newlyListedTools: ReadonlySet<string>
): ProviderMcpApprovalRequest {
  const id = assertSafeWireId(item.id, 'mcp_approval_request id');
  if (context.seenApprovalRequestIds.has(id)) {
    return protocolError('MCP approval request id was replayed.');
  }
  const serverLabel = assertExpectedServerLabel(
    item.server_label,
    context.server.serverLabel,
    'mcp_approval_request'
  );
  const toolName = assertAllowedTool(item.name, context.server, 'mcp_approval_request');
  if (!context.knownListedTools.has(toolName) && !newlyListedTools.has(toolName)) {
    return protocolError('MCP approval request references a tool that was not listed by the server.');
  }
  if (typeof item.arguments !== 'string') {
    return protocolError('MCP approval request arguments must be a JSON string.');
  }
  const argumentBytes = utf8Bytes(item.arguments);
  const args = parseProviderMcpArguments(item.arguments);
  return Object.freeze({
    id,
    serverLabel,
    toolName,
    rawArguments: item.arguments,
    arguments: args,
    argumentBytes,
  });
}

function parseMcpCall(
  item: Record<string, unknown>,
  context: ParseMcpStepContext,
  matchedApprovalRequestIds: Set<string>,
  callIdsThisStep: Set<string>
): ProviderMcpCallReceipt {
  const callId = assertSafeWireId(item.id, 'mcp_call id');
  if (context.seenCallIds.has(callId) || callIdsThisStep.has(callId)) {
    return protocolError('MCP call id was replayed.');
  }
  callIdsThisStep.add(callId);
  const serverLabel = assertExpectedServerLabel(
    item.server_label,
    context.server.serverLabel,
    'mcp_call'
  );
  const toolName = assertAllowedTool(item.name, context.server, 'mcp_call');
  if (typeof item.arguments !== 'string') {
    return protocolError('mcp_call arguments must be a JSON string.');
  }
  parseProviderMcpArguments(item.arguments);
  let approvalRequestId: string | undefined;
  if (item.approval_request_id != null) {
    approvalRequestId = assertSafeWireId(item.approval_request_id, 'mcp_call approval_request_id');
    const evidence = context.approvedRequests.get(approvalRequestId);
    if (
      !evidence ||
      evidence.toolName !== toolName ||
      evidence.rawArguments !== item.arguments
    ) {
      return protocolError('mcp_call does not match an approved request.');
    }
  } else {
    const matches = [...context.approvedRequests.entries()].filter(
      ([id, evidence]) =>
        !context.consumedApprovalRequestIds.has(id) &&
        !matchedApprovalRequestIds.has(id) &&
        evidence.toolName === toolName &&
        evidence.rawArguments === item.arguments
    );
    if (matches.length !== 1) {
      return protocolError('mcp_call has no unique exact approved request match.');
    }
    approvalRequestId = matches[0][0];
  }
  if (
    context.consumedApprovalRequestIds.has(approvalRequestId) ||
    matchedApprovalRequestIds.has(approvalRequestId)
  ) {
    return protocolError('mcp_call replayed an already consumed approval.');
  }
  matchedApprovalRequestIds.add(approvalRequestId);
  return {
    callId,
    approvalRequestId,
    serverLabel,
    toolName,
    outcome: item.error == null ? 'completed' : 'failed',
  };
}

function parseMcpStep(payload: unknown, context: ParseMcpStepContext): ParsedMcpStep {
  const { parsed } = normalizedResponsePayload(payload);
  if (responseContainsAuthorization(parsed, context.server.authorization)) {
    return protocolError('MCP Responses payload was rejected because it exposed authorization data.');
  }
  if (parsed.error != null) {
    return protocolError('MCP Responses API returned an error.');
  }
  if (parsed.status !== 'completed') {
    return protocolError('MCP Responses API did not return a completed response.');
  }
  if (typeof parsed.id !== 'string' || !responseId.test(parsed.id)) {
    return protocolError('MCP Responses response id is missing or malformed.');
  }
  if (!Array.isArray(parsed.output) || parsed.output.length > providerMcpLimits.maxResponseOutputItems) {
    return protocolError('MCP Responses output is malformed or too large.');
  }
  const output = parsed.output;
  if (output.some((item) => !isRecord(item))) {
    return protocolError('MCP Responses output contains a malformed item.');
  }
  const clonedOutput = output as Record<string, unknown>[];
  const listedTools: string[] = [];
  const newlyListedTools = new Set<string>();
  for (const item of clonedOutput) {
    if (item.type !== 'mcp_list_tools') {
      continue;
    }
    for (const name of parseListedTools(item, context.server)) {
      if (newlyListedTools.has(name)) {
        return protocolError('MCP Responses repeated a listed tool across output items.');
      }
      newlyListedTools.add(name);
      listedTools.push(name);
    }
  }

  const messages: string[] = [];
  const reasoning: string[] = [];
  const approvalRequests: ProviderMcpApprovalRequest[] = [];
  const calls: ProviderMcpCallReceipt[] = [];
  const matchedApprovalRequestIds = new Set<string>();
  const callIdsThisStep = new Set<string>();
  const approvalIdsThisStep = new Set<string>();
  for (const item of clonedOutput) {
    if (item.type === 'message') {
      const text = parseMessageItem(item);
      if (text) {
        messages.push(text);
      }
    } else if (item.type === 'reasoning') {
      const summary = parseReasoningItem(item);
      if (summary) {
        reasoning.push(summary);
      }
    } else if (item.type === 'mcp_list_tools') {
      continue;
    } else if (item.type === 'mcp_approval_request') {
      const request = parseApprovalRequest(item, context, newlyListedTools);
      if (approvalIdsThisStep.has(request.id)) {
        return protocolError('MCP Responses repeated an approval request id.');
      }
      approvalIdsThisStep.add(request.id);
      approvalRequests.push(request);
    } else if (item.type === 'mcp_call') {
      calls.push(parseMcpCall(item, context, matchedApprovalRequestIds, callIdsThisStep));
    } else {
      return protocolError('MCP Responses output contains an unsupported item type.');
    }
  }

  const content = messages.join('\n\n');
  const reasoningContent = reasoning.join('\n\n');
  if (content.length > providerMcpLimits.maxOutputCharacters) {
    return protocolError('MCP Responses accumulated output text is too large.');
  }
  if (reasoningContent.length > providerMcpLimits.maxOutputCharacters) {
    return protocolError('MCP Responses accumulated reasoning summary is too large.');
  }
  return {
    responseId: parsed.id,
    output: clonedOutput,
    content: content || undefined,
    reasoningContent: reasoningContent || undefined,
    usage: parseUsage(parsed),
    listedTools,
    approvalRequests,
    calls,
  };
}

function mergeUsage(total: ChatTokenUsage | undefined, next: ChatTokenUsage | undefined): ChatTokenUsage | undefined {
  if (!next) {
    return total;
  }
  const merged: ChatTokenUsage = { ...(total ?? {}) };
  const keys: (keyof ChatTokenUsage)[] = [
    'inputTokens',
    'outputTokens',
    'reasoningTokens',
    'cachedInputTokens',
    'totalTokens',
  ];
  for (const key of keys) {
    if (next[key] !== undefined) {
      merged[key] = (merged[key] ?? 0) + next[key]!;
    }
  }
  return merged;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ProviderMcpCancelledError();
  }
}

async function awaitWithAbort<T>(value: Promise<T> | T, signal: AbortSignal | undefined): Promise<T> {
  throwIfAborted(signal);
  if (!signal) {
    return await value;
  }
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new ProviderMcpCancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(value).then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

function safeReceiptCopy(receipt: ProviderMcpReceipt): ProviderMcpReceipt {
  return {
    ...receipt,
    responseIds: [...receipt.responseIds],
    listedTools: [...receipt.listedTools],
    approvals: receipt.approvals.map((item) => ({ ...item })),
    calls: receipt.calls.map((item) => ({ ...item })),
    usage: receipt.usage ? { ...receipt.usage } : undefined,
  };
}

export async function runOpenAiProviderMcp({
  protocol = 'openai-official',
  modelId,
  input,
  server,
  maxOutputTokens,
  sendRequest,
  requestApproval,
  beforeContinuation,
  signal,
}: RunOpenAiProviderMcpArgs): Promise<ProviderMcpRunResult> {
  if (protocol !== 'openai-official') {
    return protocolError('The MCP approval loop is enabled only for official OpenAI Responses.');
  }
  const normalizedServer = normalizeServer(server);
  const buildArgs: BuildProviderMcpRequestArgs = {
    protocol,
    modelId,
    input,
    server,
    maxOutputTokens,
  };
  let body = buildProviderMcpRequest(buildArgs);
  const knownListedTools = new Set<string>();
  const seenResponseIds = new Set<string>();
  const seenApprovalRequestIds = new Set<string>();
  const seenCallIds = new Set<string>();
  const approvedRequests = new Map<string, ApprovedRequestEvidence>();
  const consumedApprovalRequestIds = new Set<string>();
  const content: string[] = [];
  const reasoningContent: string[] = [];
  let usage: ChatTokenUsage | undefined;
  const receipt: ProviderMcpReceipt = {
    protocol: 'openai-official',
    serverLabel: normalizedServer.serverLabel,
    requestCount: 0,
    responseIds: [],
    listedTools: [],
    approvals: [],
    calls: [],
  };
  let conversationInput = body.input.map((item) => ({ ...item }));

  while (true) {
    throwIfAborted(signal);
    receipt.requestCount += 1;
    let payload: unknown;
    try {
      payload = await awaitWithAbort(
        sendRequest(body, { requestNumber: receipt.requestCount, signal }),
        signal
      );
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new ProviderMcpCancelledError();
      }
      return protocolError('MCP Responses request failed.');
    }
    throwIfAborted(signal);
    const step = parseMcpStep(payload, {
      server: normalizedServer,
      knownListedTools,
      seenApprovalRequestIds,
      seenCallIds,
      approvedRequests,
      consumedApprovalRequestIds,
    });
    if (seenResponseIds.has(step.responseId)) {
      return protocolError('MCP Responses response id was replayed.');
    }
    seenResponseIds.add(step.responseId);
    receipt.responseIds.push(step.responseId);
    for (const toolName of step.listedTools) {
      if (!knownListedTools.has(toolName)) {
        knownListedTools.add(toolName);
        receipt.listedTools.push(toolName);
      }
    }
    receipt.calls.push(...step.calls);
    for (const call of step.calls) {
      seenCallIds.add(call.callId);
      if (call.approvalRequestId) {
        consumedApprovalRequestIds.add(call.approvalRequestId);
      }
    }
    if (step.content) {
      content.push(step.content);
    }
    if (step.reasoningContent) {
      reasoningContent.push(step.reasoningContent);
    }
    usage = mergeUsage(usage, step.usage);

    if (step.approvalRequests.length === 0) {
      const finalContent = content.join('\n\n');
      const finalReasoning = reasoningContent.join('\n\n');
      if (!finalContent.trim() && !finalReasoning.trim()) {
        return protocolError('MCP Responses completed without assistant text or reasoning summary.');
      }
      receipt.usage = usage ? { ...usage } : undefined;
      const safeReceipt = safeReceiptCopy(receipt);
      return {
        result: {
          content: finalContent,
          reasoningContent: finalReasoning || undefined,
          usage: usage ? { ...usage } : undefined,
          raw: {
            protocol: safeReceipt.protocol,
            responseIds: [...safeReceipt.responseIds],
            requestCount: safeReceipt.requestCount,
          },
        },
        receipt: safeReceipt,
        providerRequestCount: safeReceipt.requestCount,
      };
    }

    if (receipt.approvals.length + step.approvalRequests.length > providerMcpLimits.maxApprovals) {
      return protocolError(`MCP approval loop exceeds the ${providerMcpLimits.maxApprovals}-approval limit.`);
    }
    if (step.approvalRequests.length !== 1) {
      return protocolError('MCP Responses returned multiple approval requests despite serial tool calls.');
    }
    conversationInput = [...conversationInput, ...step.output];
    const decisions: ProviderMcpApprovalReceipt[] = [];
    for (const approvalRequest of step.approvalRequests) {
      seenApprovalRequestIds.add(approvalRequest.id);
      const approvalNumber = receipt.approvals.length + 1;
      const decision = await awaitWithAbort(
        requestApproval(approvalRequest, {
          approvalNumber,
          requestNumber: receipt.requestCount,
          signal,
        }),
        signal
      );
      throwIfAborted(signal);
      if (decision === 'cancel') {
        throw new ProviderMcpCancelledError();
      }
      if (decision !== 'approve' && decision !== 'deny') {
        return protocolError('MCP approval callback returned an unsupported decision.');
      }
      const approvalReceipt: ProviderMcpApprovalReceipt = {
        approvalRequestId: approvalRequest.id,
        serverLabel: approvalRequest.serverLabel,
        toolName: approvalRequest.toolName,
        decision,
        argumentBytes: approvalRequest.argumentBytes,
      };
      receipt.approvals.push(approvalReceipt);
      decisions.push(approvalReceipt);
      if (decision === 'approve') {
        approvedRequests.set(approvalRequest.id, {
          toolName: approvalRequest.toolName,
          rawArguments: approvalRequest.rawArguments,
        });
      }
    }
    if (beforeContinuation) {
      await awaitWithAbort(
        beforeContinuation({
          nextRequestNumber: receipt.requestCount + 1,
          approvals: decisions.map((item) => ({ ...item })),
          signal,
        }),
        signal
      );
    }
    throwIfAborted(signal);
    body = buildProviderMcpContinuationRequest({
      protocol,
      modelId,
      server,
      maxOutputTokens,
      conversationInput,
      approvals: decisions,
    });
    conversationInput = body.input.map((item) => ({ ...item }));
  }
}
