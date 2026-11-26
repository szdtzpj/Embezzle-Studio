import type {
  AppWorkspace,
  Capability,
  CostGuardSettings,
  ExternalSearchSettings,
  ModelInfo,
  ModelParameterSettings,
  ModelTask,
  ProviderProfile,
  ReasoningEffort,
} from '../domain/types';

export const defaultExternalSearchSettings: ExternalSearchSettings = {
  enabled: false,
  maxResults: 5,
  maxToolRounds: 3,
  // Free anonymous engines available out of the box (no API key).
  selectedServiceId: 'ext-search-bing',
  services: [
    { id: 'ext-search-bing', kind: 'bing', name: 'Bing（免费）' },
    { id: 'ext-search-ddg', kind: 'duckduckgo', name: 'DuckDuckGo' },
  ],
};

const textOnly: Capability[] = ['text', 'streaming'];
const vision: Capability[] = ['text', 'image-input', 'streaming'];
const video: Capability[] = ['text', 'image-input', 'video-input', 'streaming'];

export const defaultParameterSettings: ModelParameterSettings = {
  enabled: false,
  temperature: 1,
  topP: 1,
  presencePenalty: 0,
  frequencyPenalty: 0,
};

export const defaultCostGuardSettings: CostGuardSettings = {
  enabled: false,
  maxOutputTokens: 4096,
  maxComparisonTargets: 4,
  dailyRequestLimit: 0,
  dailyCnyBudget: 0,
  dailyUsdBudget: 0,
  limitAction: 'block',
  unknownCostAction: 'warn',
  confirmPotentialMultipleCharges: true,
};

function presetModel(
  id: string,
  name: string,
  capabilities: Capability[],
  options: {
    contextWindow?: number;
    task?: ModelTask;
    supportedReasoningEfforts?: ReasoningEffort[];
  } = {}
): ModelInfo {
  return {
    id,
    name,
    capabilities,
    ...(options.supportedReasoningEfforts
      ? { supportedReasoningEfforts: options.supportedReasoningEfforts }
      : {}),
    ...(options.contextWindow ? { contextWindow: options.contextWindow } : {}),
    task: options.task ?? 'chat',
    source: 'preset',
  };
}

export const defaultProviders: ProviderProfile[] = [
  {
    id: 'volcengine-ark',
    name: 'Volcengine Ark',
    kind: 'volcengine-ark',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    capabilities: video,
    models: [],
    notes: 'Use Ark-compatible endpoints first; add a dedicated video adapter for Doubao media flows.',
  },
  {
    id: 'bailian-compatible',
    name: 'Alibaba Bailian',
    kind: 'bailian-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    capabilities: vision,
    models: [],
    notes: 'Targets Bailian compatible mode before provider-specific extensions.',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    authHeaderMode: 'bearer',
    imageApiMode: 'auto',
    capabilities: [
      'text',
      'image-input',
      'file-input',
      'tool-calling',
      'reasoning',
      'web-search',
      'image-generation',
      'streaming',
      'mcp',
    ],
    models: [
      presetModel('gpt-6.2-astra', 'GPT-6.2 Astra', ['text', 'image-input', 'file-input', 'tool-calling', 'reasoning', 'web-search', 'streaming', 'mcp'], { contextWindow: 400_000 }),
      presetModel('gpt-6.2-sol', 'GPT-6.2 Sol', ['text', 'image-input', 'file-input', 'tool-calling', 'reasoning', 'web-search', 'streaming', 'mcp'], { contextWindow: 400_000 }),
      presetModel('gpt-5.5', 'GPT-5.5', ['text', 'image-input', 'file-input', 'tool-calling', 'reasoning', 'web-search', 'streaming', 'mcp'], { contextWindow: 400_000 }),
      presetModel('gpt-5.4', 'GPT-5.4', ['text', 'image-input', 'file-input', 'tool-calling', 'reasoning', 'web-search', 'streaming', 'mcp'], { contextWindow: 400_000 }),
      presetModel('gpt-4.1', 'GPT-4.1', ['text', 'image-input', 'file-input', 'tool-calling', 'web-search', 'streaming'], { contextWindow: 1_047_576 }),
      presetModel('o3', 'o3', ['text', 'image-input', 'file-input', 'tool-calling', 'reasoning', 'web-search', 'streaming'], { contextWindow: 200_000 }),
      presetModel('o4-mini', 'o4-mini', ['text', 'image-input', 'file-input', 'tool-calling', 'reasoning', 'web-search', 'streaming'], { contextWindow: 200_000 }),
      presetModel('gpt-image-2.5-sunburst', 'GPT Image 2.5 Sunburst', ['text', 'image-input', 'image-generation'], { task: 'image-generation' }),
      presetModel('gpt-image-2.5-flare', 'GPT Image 2.5 Flare', ['text', 'image-input', 'image-generation'], { task: 'image-generation' }),
    ],
    notes: 'Official OpenAI API supporting Responses, streaming, web search, MCP, and GPT Image 2.5.',
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    authHeaderMode: 'x-api-key',
    imageApiMode: 'unsupported',
    capabilities: ['text', 'image-input', 'file-input', 'tool-calling', 'reasoning', 'web-search', 'streaming'],
    models: [
      presetModel('claude-sonnet-5-5', 'Claude Sonnet 5.5', ['text', 'image-input', 'file-input', 'tool-calling', 'reasoning', 'web-search', 'streaming'], { contextWindow: 200_000 }),
      presetModel('claude-opus-5-5', 'Claude Opus 5.5', ['text', 'image-input', 'file-input', 'tool-calling', 'reasoning', 'web-search', 'streaming'], { contextWindow: 200_000 }),
      presetModel('claude-haiku-5-5', 'Claude Haiku 5.5', ['text', 'image-input', 'file-input', 'tool-calling', 'reasoning', 'web-search', 'streaming'], { contextWindow: 200_000 }),
      presetModel('claude-fable-5-2', 'Claude Fable 5.2', ['text', 'image-input', 'file-input', 'tool-calling', 'reasoning', 'web-search', 'streaming'], { contextWindow: 1_000_000 }),
      presetModel('claude-sonnet-4-6', 'Claude Sonnet 4.6', ['text', 'image-input', 'file-input', 'tool-calling', 'reasoning', 'web-search', 'streaming'], { contextWindow: 200_000 }),
    ],
    notes: 'Official Anthropic Messages API with extended/adaptive thinking and built-in web search.',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    authHeaderMode: 'x-goog-api-key',
    imageApiMode: 'gemini-generate-content',
    capabilities: [
      'text',
      'image-input',
      'video-input',
      'file-input',
      'tool-calling',
      'reasoning',
      'web-search',
      'image-generation',
      'streaming',
    ],
    models: [
      presetModel('gemini-3.8-flash', 'Gemini 3.8 Flash', ['text', 'image-input', 'video-input', 'file-input', 'tool-calling', 'reasoning', 'web-search', 'streaming'], { contextWindow: 1_048_576 }),
      presetModel('gemini-3.1-pro', 'Gemini 3.1 Pro', ['text', 'image-input', 'video-input', 'file-input', 'tool-calling', 'reasoning', 'web-search', 'streaming'], { contextWindow: 2_097_152 }),
      presetModel('gemini-2.5-pro', 'Gemini 2.5 Pro', ['text', 'image-input', 'video-input', 'file-input', 'tool-calling', 'reasoning', 'web-search', 'streaming'], { contextWindow: 1_048_576 }),
      presetModel('gemini-2.5-flash', 'Gemini 2.5 Flash', ['text', 'image-input', 'video-input', 'file-input', 'tool-calling', 'reasoning', 'web-search', 'streaming'], { contextWindow: 1_048_576 }),
      presetModel('gemini-3.1-flash-image', 'Gemini 3.1 Flash Image', ['text', 'image-input', 'image-generation'], { task: 'image-generation' }),
      presetModel('gemini-2.5-flash-image', 'Gemini 2.5 Flash Image', ['text', 'image-input', 'image-generation'], { task: 'image-generation' }),
    ],
    notes: 'Official Gemini native API with Google Search Grounding, thinking, and image generation.',
  },
  {
    id: 'xai-grok',
    name: 'xAI Grok',
    kind: 'xai-grok',
    baseUrl: 'https://api.x.ai/v1',
    authHeaderMode: 'bearer',
    imageApiMode: 'xai-json',
    capabilities: ['text', 'image-input', 'tool-calling', 'reasoning', 'web-search', 'image-generation', 'streaming'],
    models: [
      presetModel('grok-4.7', 'Grok 4.7', ['text', 'image-input', 'tool-calling', 'reasoning', 'web-search', 'streaming'], { contextWindow: 256_000 }),
      presetModel('grok-4.3', 'Grok 4.3', ['text', 'image-input', 'tool-calling', 'reasoning', 'web-search', 'streaming'], { contextWindow: 256_000 }),
      presetModel('grok-4.5', 'Grok 4.5', ['text', 'image-input', 'tool-calling', 'reasoning', 'web-search', 'streaming'], { contextWindow: 256_000 }),
      presetModel('grok-3-mini', 'Grok 3 Mini', ['text', 'tool-calling', 'reasoning', 'web-search', 'streaming'], { contextWindow: 131_072 }),
      presetModel('grok-imagine-image-2.0', 'Grok Imagine Image 2.0', ['text', 'image-input', 'image-generation'], { task: 'image-generation' }),
    ],
    notes: 'Official xAI Grok API supporting Responses, web/X search, and Grok Imagine image generation.',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    authHeaderMode: 'bearer',
    imageApiMode: 'unsupported',
    capabilities: ['text', 'image-input', 'tool-calling', 'reasoning', 'web-search', 'streaming'],
    models: [
      presetModel('deepseek-flash', 'DeepSeek Flash', ['text', 'image-input', 'tool-calling', 'reasoning', 'web-search', 'streaming'], { contextWindow: 1_000_000 }),
      presetModel('deepseek-v4-pro', 'DeepSeek V4 Pro', ['text', 'tool-calling', 'reasoning', 'web-search', 'streaming'], { contextWindow: 1_000_000 }),
    ],
    notes: 'Direct DeepSeek API with V4/Flash reasoning and official web search support.',
  },
  {
    id: 'new-api-relay',
    name: 'New API Relay',
    kind: 'new-api-relay',
    baseUrl: 'https://your-relay.example.com/v1',
    capabilities: ['text', 'image-input', 'tool-calling', 'streaming'],
    models: [],
    notes: 'Replace the base URL with your New API or One API relay.',
  },
  {
    id: 'custom-openai',
    name: 'Custom OpenAI-Compatible',
    kind: 'custom',
    baseUrl: 'https://api.openai.com/v1',
    capabilities: textOnly,
    models: [],
  },
];

const defaultProviderIds = new Set(defaultProviders.map((provider) => provider.id));

export function isUserCreatedProvider(provider: Pick<ProviderProfile, 'id'>): boolean {
  return !defaultProviderIds.has(provider.id);
}

export function createDefaultWorkspace(): AppWorkspace {
  const now = Date.now();
  const deviceId = `device-${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const initialConversationId = 'conversation-default';
  const initialProjectId = 'project-default';
  const welcomeMessage = {
    id: 'welcome',
    role: 'assistant' as const,
    content: '配置服务商后即可开始移动端多模型对话。',
    createdAt: now,
    status: 'ready' as const,
  };
  const providers = defaultProviders.map((provider) => ({
    ...provider,
    models: provider.models.map((model) => ({
      ...model,
      capabilities: [...model.capabilities],
      ...(model.capabilityOverrides
        ? { capabilityOverrides: { ...model.capabilityOverrides } }
        : {}),
      ...(model.supportedReasoningEfforts
        ? { supportedReasoningEfforts: [...model.supportedReasoningEfforts] }
        : {}),
    })),
    capabilities: [...provider.capabilities],
    ...(provider.customHeaders
      ? { customHeaders: provider.customHeaders.map((header) => ({ ...header })) }
      : {}),
  }));

  return {
    providers,
    activeProviderId: providers[0].id,
    activeModelIdByProvider: Object.fromEntries(
      providers.map((provider) => [provider.id, provider.models[0]?.id ?? ''])
    ),
    reasoningEffortByModel: {},
    parameterSettings: defaultParameterSettings,
    modelCandidatesByProvider: {},
    activeProjectId: initialProjectId,
    projects: [
      {
        id: initialProjectId,
        name: '默认项目',
        createdAt: now,
        updatedAt: now,
      },
    ],
    artifacts: [],
    knowledgeSources: [],
    activeConversationId: initialConversationId,
    conversations: [
      {
        id: initialConversationId,
        title: '新对话',
        projectId: initialProjectId,
        createdAt: now,
        updatedAt: now,
        messages: [welcomeMessage],
      },
    ],
    messages: [welcomeMessage],
    plugins: [],
    promptTemplates: [],
    comparisonEnabled: false,
    comparisonTargets: [],
    modelPricing: [],
    costGuard: { ...defaultCostGuardSettings },
    providerUsageEvents: [],
    webSearch: {
      enabled: false,
      searchContextSize: 'medium',
    },
    externalSearch: {
      ...defaultExternalSearchSettings,
      services: defaultExternalSearchSettings.services.map((service) => ({ ...service })),
    },
    voice: {
      speechVoice: 'alloy',
      speechFormat: 'mp3',
    },
    experienceMode: 'simple',
    onboarding: {
      status: 'pending',
      lastStep: 'provider',
    },
    composerDrafts: [],
    backupPreferences: {
      reminderIntervalDays: 14,
    },
    cloudSync: {
      enabled: false,
      provider: 'webdav',
      endpoint: '',
      remotePath: 'Embezzle-Studio',
      deviceId,
      lastStatus: 'idle',
      conflicts: [],
    },
  };
}
