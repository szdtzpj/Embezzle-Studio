import type {
  ChatCompletionResult,
  ChatMessage,
  MediaAttachment,
  ModelInfo,
  ProviderProfile,
} from '../domain/types';

interface ChatCompletionArgs {
  provider: ProviderProfile;
  modelId: string;
  messages: ChatMessage[];
}

interface RemoteModel {
  id?: string;
  object?: string;
  owned_by?: string;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/(?:chat\/completions|models)$/i, '');
}

function authHeaders(provider: ProviderProfile): HeadersInit {
  if (!provider.apiKey?.trim()) {
    throw new Error('请先填写当前服务商的 API Key。');
  }

  return {
    Authorization: `Bearer ${provider.apiKey.trim()}`,
    'Content-Type': 'application/json',
  };
}

function assertBaseUrl(provider: ProviderProfile): string {
  const baseUrl = normalizeBaseUrl(provider.baseUrl);
  if (!baseUrl) {
    throw new Error('请先填写当前服务商的 Base URL。');
  }
  return baseUrl;
}

function imageContent(attachment: MediaAttachment) {
  if (attachment.kind !== 'image') {
    throw new Error('当前通用适配器只支持图片附件；视频需要 provider-specific 适配器。');
  }

  const mimeType = attachment.mimeType || 'image/jpeg';
  const url = attachment.base64?.startsWith('data:')
    ? attachment.base64
    : attachment.base64
      ? `data:${mimeType};base64,${attachment.base64}`
      : attachment.uri;

  return {
    type: 'image_url',
    image_url: {
      url,
    },
  };
}

function toOpenAiMessage(message: ChatMessage) {
  if (message.role === 'user' && message.attachments?.length) {
    return {
      role: message.role,
      content: [
        {
          type: 'text',
          text: message.content || '请分析附件。',
        },
        ...message.attachments.map(imageContent),
      ],
    };
  }

  return {
    role: message.role,
    content: message.content,
  };
}

function readAssistantText(payload: any): string {
  const content = payload?.choices?.[0]?.message?.content;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        return part?.text ?? '';
      })
      .join('')
      .trim();
  }

  if (typeof payload?.output_text === 'string') {
    return payload.output_text;
  }

  return '模型返回了空内容。';
}

export async function fetchOpenAiCompatibleModels(provider: ProviderProfile): Promise<ModelInfo[]> {
  const baseUrl = assertBaseUrl(provider);
  const response = await fetch(`${baseUrl}/models`, {
    method: 'GET',
    headers: authHeaders(provider),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`模型列表获取失败：${response.status} ${body.slice(0, 240)}`);
  }

  const payload = (await response.json()) as { data?: RemoteModel[] };
  const remoteModels = Array.isArray(payload.data) ? payload.data : [];

  return remoteModels
    .filter((model) => typeof model.id === 'string' && model.id.length > 0)
    .map((model) => ({
      id: model.id as string,
      name: model.id,
      capabilities: provider.capabilities,
      source: 'remote',
    }));
}

export async function sendOpenAiCompatibleChat({
  provider,
  modelId,
  messages,
}: ChatCompletionArgs): Promise<ChatCompletionResult> {
  const baseUrl = assertBaseUrl(provider);

  if (!modelId) {
    throw new Error('请先选择一个模型。');
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: authHeaders(provider),
    body: JSON.stringify({
      model: modelId,
      messages: messages.map(toOpenAiMessage),
      temperature: 0.7,
      stream: false,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`对话请求失败：${response.status} ${body.slice(0, 320)}`);
  }

  const payload = await response.json();

  return {
    content: readAssistantText(payload),
    raw: payload,
  };
}
