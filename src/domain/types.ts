export type ProviderKind =
  | 'openai-compatible'
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

export interface ProviderProfile {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey?: string;
  capabilities: Capability[];
  models: ModelInfo[];
  notes?: string;
}

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
  startIndex?: number;
  endIndex?: number;
}

export interface WebSearchSettings {
  enabled: boolean;
  searchContextSize: 'low' | 'medium' | 'high';
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

export interface ChatMessage {
  id: string;
  originMessageId?: string;
  role: MessageRole;
  content: string;
  createdAt: number;
  status: MessageStatus;
  attachments?: MediaAttachment[];
  reasoningContent?: string;
  usage?: ChatTokenUsage;
  citations?: WebCitation[];
  webSearchTriggered?: boolean;
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
  voice: VoiceSettings;
}

export interface ChatCompletionResult {
  content: string;
  reasoningContent?: string;
  usage?: ChatTokenUsage;
  citations?: WebCitation[];
  webSearchTriggered?: boolean;
  attachments?: MediaAttachment[];
  generationTask?: GenerationTaskInfo;
  mcpActivity?: McpActivitySummary;
  raw: unknown;
}
