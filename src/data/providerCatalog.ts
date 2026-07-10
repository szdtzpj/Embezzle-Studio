import type { AppWorkspace, Capability, ModelParameterSettings, ProviderProfile } from '../domain/types';

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

export function isUserCreatedProvider(provider: Pick<ProviderProfile, 'id' | 'kind'>): boolean {
  return provider.kind === 'custom' && !defaultProviderIds.has(provider.id);
}

export function createDefaultWorkspace(): AppWorkspace {
  const now = Date.now();
  const initialConversationId = 'conversation-default';
  const welcomeMessage = {
    id: 'welcome',
    role: 'assistant' as const,
    content: '配置服务商后即可开始移动端多模型对话。',
    createdAt: now,
    status: 'ready' as const,
  };
  const providers = defaultProviders.map((provider) => ({
    ...provider,
    models: provider.models.map((model) => ({ ...model })),
    capabilities: [...provider.capabilities],
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
    activeConversationId: initialConversationId,
    conversations: [
      {
        id: initialConversationId,
        title: '新对话',
        createdAt: now,
        updatedAt: now,
        messages: [welcomeMessage],
      },
    ],
    messages: [welcomeMessage],
    plugins: [],
  };
}
