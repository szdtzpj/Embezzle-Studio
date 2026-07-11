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

export interface ChatMessage {
  id: string;
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
  comparisonGroupId?: string;
  selectedForContext?: boolean;
  requestMetrics?: RequestMetrics;
  costEstimate?: CostEstimate;
  generationTask?: GenerationTaskInfo;
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
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  type: 'mobile-js' | 'remote-mcp';
  permissions: Array<'network' | 'files' | 'clipboard' | 'tools'>;
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
  activeConversationId: string;
  conversations: ChatConversation[];
  messages: ChatMessage[];
  plugins: PluginManifest[];
  promptTemplates: PromptTemplate[];
  comparisonEnabled: boolean;
  comparisonTargets: ModelTargetRef[];
  modelPricing: ModelPricing[];
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
  raw: unknown;
}
