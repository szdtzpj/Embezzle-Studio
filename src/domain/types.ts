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
  | 'tool-calling'
  | 'streaming'
  | 'mcp';

export type MessageRole = 'system' | 'user' | 'assistant';

export type MessageStatus = 'ready' | 'pending' | 'error';

export type AttachmentKind = 'image' | 'video' | 'file';

export type ReasoningEffort = 'default' | 'off' | 'low' | 'medium' | 'high' | 'max';

export type ModelTask = 'chat' | 'image-generation' | 'video-generation' | 'embedding' | 'rerank';

export interface ModelInfo {
  id: string;
  name?: string;
  capabilities: Capability[];
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
  generationTask?: GenerationTaskInfo;
  error?: string;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  type: 'mobile-js' | 'remote-mcp';
  permissions: Array<'network' | 'files' | 'clipboard' | 'tools'>;
  transport?: 'streamable-http' | 'sse';
  endpoint?: string;
}

export interface AppWorkspace {
  providers: ProviderProfile[];
  activeProviderId: string;
  activeModelIdByProvider: Record<string, string>;
  reasoningEffortByModel: Record<string, ReasoningEffort>;
  modelCandidatesByProvider: Record<string, ModelInfo[]>;
  messages: ChatMessage[];
  plugins: PluginManifest[];
}

export interface ChatCompletionResult {
  content: string;
  reasoningContent?: string;
  usage?: ChatTokenUsage;
  attachments?: MediaAttachment[];
  generationTask?: GenerationTaskInfo;
  raw: unknown;
}
