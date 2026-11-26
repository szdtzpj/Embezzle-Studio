export type ProviderKind =
  | 'openai-compatible'
  | 'anthropic'
  | 'gemini'
  | 'xai-grok'
  | 'deepseek'
  | 'volcengine-ark'
  | 'bailian-compatible'
  | 'new-api-relay'
  | 'custom';

export type Capability =
  | 'text'
  | 'image-input'
  | 'video-input'
  | 'file-input'
  | 'tool-calling'
  | 'reasoning'
  | 'web-search'
  | 'image-generation'
  | 'video-generation'
  | 'speech-to-text'
  | 'text-to-speech'
  | 'embedding'
  | 'rerank'
  | 'streaming'
  | 'mcp';

export type MessageRole = 'system' | 'user' | 'assistant';

export type MessageStatus = 'ready' | 'pending' | 'error' | 'cancelled';

export type AttachmentKind = 'image' | 'video' | 'file';

export type ReasoningEffort =
  | 'default'
  | 'off'
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

export type ColorMode = 'system' | 'light' | 'dark';

export type ExperienceMode = 'simple' | 'advanced';

export type OnboardingStep =
  | 'provider'
  | 'credentials'
  | 'connection'
  | 'models'
  | 'sample';

export interface OnboardingState {
  status: 'pending' | 'completed' | 'dismissed';
  lastStep: OnboardingStep;
  completedAt?: number;
  dismissedAt?: number;
}

export interface ConversationDraft {
  conversationId: string;
  text: string;
  updatedAt: number;
  /** Persisted, app-owned attachments waiting in the composer. */
  attachments?: MediaAttachment[];
}

export interface BackupPreferences {
  reminderIntervalDays: 0 | 7 | 14 | 30;
  lastExportedAt?: number;
  lastVerifiedAt?: number;
  snoozedUntil?: number;
}

export type CloudSyncProviderKind = 'webdav' | 's3';
export type CloudSyncStatus = 'idle' | 'syncing' | 'synced' | 'conflict' | 'error';

export interface CloudSyncConflict {
  id: string;
  detectedAt: number;
  localDigest: string;
  remoteDigest: string;
  baseDigest?: string;
  localObjectKey?: string;
  remoteObjectKey: string;
  remoteUpdatedAt?: number;
}

/**
 * Non-secret cloud-sync configuration. Usernames, passwords, access keys and
 * the backup encryption password live in SecureStore (or tab-session memory on Web).
 */
export interface CloudSyncSettings {
  enabled: boolean;
  provider: CloudSyncProviderKind;
  endpoint: string;
  remotePath: string;
  bucket?: string;
  region?: string;
  deviceId: string;
  lastStatus: CloudSyncStatus;
  lastSyncAt?: number;
  lastSyncedDigest?: string;
  lastRemoteDigest?: string;
  lastError?: string;
  conflicts: CloudSyncConflict[];
}

export type ModelTask =
  | 'chat'
  | 'image-generation'
  | 'video-generation'
  | 'audio-transcription'
  | 'speech-generation'
  | 'embedding'
  | 'rerank';

export interface ModelParameterSettings {
  enabled: boolean;
  temperature: number;
  topP: number;
  presencePenalty: number;
  frequencyPenalty: number;
}

export interface ModelInfo {
  id: string;
  name?: string;
  capabilities: Capability[];
  capabilityOverrides?: Partial<Record<Capability, boolean>>;
  supportedReasoningEfforts?: ReasoningEffort[];
  contextWindow?: number;
  task?: ModelTask;
  source: 'preset' | 'remote' | 'manual';
}

/** 服务商自定义请求头配置项。 */
export interface ProviderCustomHeader {
  key: string;
  value: string;
  enabled?: boolean;
}

/** 服务商鉴权请求头注入模式。 */
export type ProviderAuthHeaderMode =
  | 'auto'
  | 'bearer'
  | 'x-api-key'
  | 'x-goog-api-key'
  | 'custom';

/** 服务商生图接口协议模式。 */
export type ProviderImageApiMode =
  | 'auto'
  | 'openai-images'
  | 'openai-responses'
  | 'gemini-generate-content'
  | 'xai-json'
  | 'unsupported';

export interface ProviderProfile {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey?: string;
  customHeaders?: ProviderCustomHeader[];
  authHeaderMode?: ProviderAuthHeaderMode;
  imageApiMode?: ProviderImageApiMode;
  capabilities: Capability[];
  models: ModelInfo[];
  notes?: string;
  enabled?: boolean;
}

/** 契约兼容别名，等价于 ProviderProfile。 */
export type ProviderConfig = ProviderProfile;

export interface MediaAttachment {
  id: string;
  kind: AttachmentKind;
  uri: string;
  name: string;
  mimeType?: string;
  size?: number;
  width?: number;
  height?: number;
  durationMs?: number | null;
  base64?: string | null;
}

/** 契约兼容别名，等价于 MediaAttachment。 */
export type AttachmentItem = MediaAttachment;

export interface ChatTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
}

export interface ModelTargetRef {
  providerId: string;
  modelId: string;
}

export interface WorkspaceProject {
  id: string;
  name: string;
  systemPrompt?: string;
  defaultTarget?: ModelTargetRef;
  createdAt: number;
  updatedAt: number;
}

export type WorkspaceArtifactFormat = 'markdown' | 'plain-text' | 'code' | 'json' | 'html';

export interface WorkspaceArtifactRevision {
  id: string;
  content: string;
  createdAt: number;
  author: 'user' | 'assistant';
  sourceMessageId?: string;
}

export interface WorkspaceArtifact {
  id: string;
  projectId: string;
  title: string;
  format: WorkspaceArtifactFormat;
  language?: string;
  revisions: WorkspaceArtifactRevision[];
  activeRevisionId: string;
  sourceConversationId?: string;
  sourceMessageId?: string;
  favorite?: boolean;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
}

export type ProjectKnowledgeKind = 'text' | 'artifact' | 'message' | 'file';

export interface ProjectKnowledgeSource {
  id: string;
  projectId: string;
  title: string;
  kind: ProjectKnowledgeKind;
  content: string;
  mimeType?: string;
  fileName?: string;
  sourceArtifactId?: string;
  sourceConversationId?: string;
  sourceMessageId?: string;
  createdAt: number;
  updatedAt: number;
}

export type ProviderUsageKind =
  | 'chat'
  | 'web-search'
  | 'image-generation'
  | 'video-generation'
  | 'audio-transcription'
  | 'speech-generation';

export type ProviderUsageStatus = 'started' | 'succeeded' | 'failed' | 'cancelled';

export type UnknownCostComponent =
  | 'input-tokens'
  | 'output-tokens'
  | 'web-search-tool'
  | 'speech'
  | 'transcription'
  | 'image-output'
  | 'video-output'
  | 'provider-surcharge'
  | 'failed-or-cancelled-request';

export interface ProviderUsageEvent {
  id: string;
  kind: ProviderUsageKind;
  status: ProviderUsageStatus;
  providerRequestCount: number;
  providerId: string;
  modelId: string;
  createdAt: number;
  localDateKey: string;
  completedAt?: number;
  messageId?: string;
  comparisonGroupId?: string;
  knownCostEstimate?: CostEstimate;
  unknownCostComponents: UnknownCostComponent[];
}

export type CostGuardAction = 'warn' | 'block';

export interface CostGuardSettings {
  enabled: boolean;
  maxOutputTokens: number;
  maxComparisonTargets: 2 | 3 | 4;
  dailyRequestLimit: number;
  dailyCnyBudget: number;
  dailyUsdBudget: number;
  limitAction: CostGuardAction;
  unknownCostAction: CostGuardAction;
  confirmPotentialMultipleCharges: boolean;
}

export interface RequestMetrics {
  durationMs?: number;
  timeToFirstTokenMs?: number;
}

export type PricingCurrency = 'CNY' | 'USD';

export interface ModelPricing {
  providerId: string;
  modelId: string;
  currency: PricingCurrency;
  inputPerMillion?: number;
  cachedInputPerMillion?: number;
  outputPerMillion?: number;
  updatedAt: number;
}

export interface CostEstimate {
  amount: number;
  currency: PricingCurrency;
  source: 'user-configured';
  pricingUpdatedAt: number;
}

export interface PromptTemplate {
  id: string;
  name: string;
  content: string;
  mode: 'composer' | 'system';
  createdAt: number;
  updatedAt: number;
  pinnedAt?: number;
}

export interface WebCitation {
  url: string;
  title?: string;
  /** Optional snippet / body text from search adapters. */
  text?: string;
  /** Stable external-search result id used by inline citation links. */
  id?: string;
  /** One-based external-search result index used by inline citation links. */
  index?: number;
  startIndex?: number;
  endIndex?: number;
}

export interface WebSearchSettings {
  enabled: boolean;
  searchContextSize: 'low' | 'medium' | 'high';
}

/**
 * 用户自定义的第三方外部网络搜索服务（独立于模型服务商内置搜索）。
 * Bing、DuckDuckGo、Firecrawl 与自托管 SearXNG 可在无 API Key 下运行（其中 SearXNG
 * 必须配置合法的公网 HTTPS 实例地址）；Tavily、Brave、Grok、DeepSeek、Bocha 与 Exa 需配置 API Key。
 */
export type ExternalSearchProviderKind =
  | 'tavily'
  | 'brave'
  | 'grok'
  | 'bing'
  | 'duckduckgo'
  | 'firecrawl'
  | 'deepseek'
  | 'bocha'
  | 'exa'
  | 'searxng';

export interface ExternalSearchService {
  id: string;
  kind: ExternalSearchProviderKind;
  name: string;
  /** Runtime-only; never persisted in plain workspace JSON. Optional for free/anonymous kinds. */
  apiKey?: string;
  /** Optional HTTPS override for the provider endpoint. */
  endpoint?: string;
  /** Grok/xAI model id when kind is grok. */
  model?: string;
}

export interface ExternalSearchSettings {
  enabled: boolean;
  selectedServiceId?: string;
  maxResults: number;
  maxToolRounds: number;
  services: ExternalSearchService[];
}

export interface VoiceSettings {
  transcriptionTarget?: ModelTargetRef;
  speechTarget?: ModelTargetRef;
  speechVoice: string;
  speechFormat: 'mp3' | 'opus' | 'aac' | 'wav';
}

export interface GenerationTaskInfo {
  providerId: string;
  modelId: string;
  taskId: string;
  kind: 'video';
  status?: string;
  lastCheckedAt?: number;
  nextCheckAt?: number;
  attemptCount?: number;
  notifiedStatus?: 'completed' | 'failed';
}

export interface McpActivitySummary {
  serverLabel: string;
  providerRequestCount: number;
  approvals: Array<{
    toolName: string;
    decision: 'approve' | 'deny';
  }>;
  calls: Array<{
    toolName: string;
    outcome: 'completed' | 'failed' | 'unknown';
  }>;
}

/** Modular timeline of model tool use (search / MCP / function calls). */
export interface ToolActivityItem {
  id: string;
  toolName: string;
  title?: string;
  arguments?: Record<string, unknown>;
  status: 'running' | 'completed' | 'failed';
  summary?: string;
  content?: string;
  startedAt?: number;
  finishedAt?: number;
  /** Stable order in the activity timeline (lower first). */
  sequence?: number;
}

/**
 * Ordered chain-of-thought steps: thinking segments and tool calls interleaved
 * by `sequence` so the UI can show "thought → tool → thought → answer".
 */
export interface ActivityTimelineStep {
  id: string;
  kind: 'thinking' | 'tool';
  sequence: number;
  status: 'running' | 'completed' | 'failed';
  title?: string;
  content?: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
  summary?: string;
  startedAt?: number;
  finishedAt?: number;
}

/**
 * 多轮对话中需原样回传的服务商状态续接块（严格可 JSON 序列化）。
 */
export type ProviderContinuationBlock =
  | {
      provider: 'anthropic';
      type: 'thinking';
      thinking: string;
      signature: string;
    }
  | {
      provider: 'anthropic';
      type: 'redacted_thinking';
      data: string;
    }
  | {
      provider: 'anthropic';
      type: 'server_tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      provider: 'anthropic';
      type: 'web_search_tool_result';
      toolUseId: string;
      content: unknown[];
    }
  | {
      provider: 'gemini';
      type: 'thought_signature';
      thoughtSignature: string;
      partRole?: 'text' | 'image' | 'function_call';
      attachmentId?: string;
    }
  | {
      provider: 'openai' | 'xai';
      type: 'reasoning_encrypted';
      id?: string;
      encryptedContent: string;
      summary?: string[];
    }
  | {
      provider: 'deepseek';
      type: 'server_tool_calls';
      serverToolCalls: unknown[];
    };

/** 生图画面比例。 */
export type ImageAspectRatio =
  | '1:1'
  | '3:2'
  | '2:3'
  | '4:3'
  | '3:4'
  | '16:9'
  | '9:16'
  | '21:9';

/** 跨协议生图请求参数。 */
export interface ImageGenerationOptions {
  aspectRatio?: ImageAspectRatio;
  quality?: 'low' | 'medium' | 'high' | 'auto';
  resolution?: '1k' | '2k' | '4k';
  count?: number;
  referenceImages?: MediaAttachment[];
}

/** 统一流式对话事件回调接口。 */
export interface StreamChatCallbacks {
  onTextDelta?: (delta: string, snapshot?: string) => void;
  onThinkingDelta?: (delta: string, snapshot?: string) => void;
  onThinkingComplete?: (durationMs: number) => void;
  onToolActivity?: (items: ToolActivityItem[], timeline?: ActivityTimelineStep[]) => void;
  onCitations?: (citations: WebCitation[], webSearchTriggered?: boolean) => void;
  onImageGenerated?: (attachments: MediaAttachment[]) => void;
  onContinuationBlocks?: (blocks: ProviderContinuationBlock[]) => void;
  onUsage?: (usage: ChatTokenUsage) => void;
  onDone?: (result: ChatCompletionResult) => void;
  onError?: (error: Error) => void;
}

export interface ChatMessage {
  id: string;
  originMessageId?: string;
  role: MessageRole;
  content: string;
  createdAt: number;
  status: MessageStatus;
  attachments?: MediaAttachment[];
  reasoningContent?: string;
  thinkingDurationMs?: number;
  providerContinuations?: ProviderContinuationBlock[];
  usage?: ChatTokenUsage;
  citations?: WebCitation[];
  webSearchTriggered?: boolean;
  toolActivity?: ToolActivityItem[];
  activityTimeline?: ActivityTimelineStep[];
  promptTemplateId?: string;
  projectInstructionId?: string;
  comparisonGroupId?: string;
  selectedForContext?: boolean;
  excludedFromContext?: boolean;
  pinnedForContext?: boolean;
  requestMetrics?: RequestMetrics;
  costEstimate?: CostEstimate;
  generationTask?: GenerationTaskInfo;
  mcpActivity?: McpActivitySummary;
  modelId?: string;
  providerId?: string;
  providerName?: string;
  error?: string;
}

export interface ChatConversation {
  id: string;
  title: string;
  customTitle?: boolean;
  pinnedAt?: number;
  projectId?: string;
  parentConversationId?: string;
  branchPointMessageId?: string;
  knowledgeSourceIds?: string[];
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export interface PluginManifest {
  id: string;
  name: string;
  description?: string;
  version: string;
  type: 'mobile-js' | 'remote-mcp';
  permissions: Array<'network' | 'files' | 'clipboard' | 'tools'>;
  allowedTools: string[];
  transport?: 'streamable-http' | 'sse';
  endpoint?: string;
  enabled?: boolean;
  serverLabel?: string;
  providerId?: string;
  authorization?: string;
  approvalPolicy?: 'always';
}

export interface AppWorkspace {
  providers: ProviderProfile[];
  activeProviderId: string;
  activeModelIdByProvider: Record<string, string>;
  reasoningEffortByModel: Record<string, ReasoningEffort>;
  parameterSettings: ModelParameterSettings;
  modelCandidatesByProvider: Record<string, ModelInfo[]>;
  activeProjectId: string;
  projects: WorkspaceProject[];
  artifacts: WorkspaceArtifact[];
  knowledgeSources: ProjectKnowledgeSource[];
  activeConversationId: string;
  conversations: ChatConversation[];
  messages: ChatMessage[];
  plugins: PluginManifest[];
  promptTemplates: PromptTemplate[];
  comparisonEnabled: boolean;
  comparisonTargets: ModelTargetRef[];
  modelPricing: ModelPricing[];
  costGuard: CostGuardSettings;
  providerUsageEvents: ProviderUsageEvent[];
  webSearch: WebSearchSettings;
  externalSearch: ExternalSearchSettings;
  voice: VoiceSettings;
  experienceMode: ExperienceMode;
  onboarding: OnboardingState;
  composerDrafts: ConversationDraft[];
  backupPreferences: BackupPreferences;
  cloudSync: CloudSyncSettings;
}

export interface ChatCompletionResult {
  content: string;
  reasoningContent?: string;
  thinkingDurationMs?: number;
  providerContinuations?: ProviderContinuationBlock[];
  usage?: ChatTokenUsage;
  citations?: WebCitation[];
  webSearchTriggered?: boolean;
  toolActivity?: ToolActivityItem[];
  activityTimeline?: ActivityTimelineStep[];
  attachments?: MediaAttachment[];
  generationTask?: GenerationTaskInfo;
  mcpActivity?: McpActivitySummary;
  raw: unknown;
}
