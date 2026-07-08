import type {
  ChatCompletionResult,
  ChatMessage,
  MediaAttachment,
  ModelInfo,
  ProviderProfile,
  ReasoningEffort,
} from '../domain/types';
import { Platform } from 'react-native';

interface ChatCompletionArgs {
  provider: ProviderProfile;
  modelId: string;
  messages: ChatMessage[];
  reasoningEffort: ReasoningEffort;
}

interface RemoteModel {
  id?: string;
  object?: string;
  owned_by?: string;
}

const webDevProxyUrl = 'http://127.0.0.1:8787/proxy';

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

function headersToObject(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }

  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  return headers as Record<string, string>;
}

async function providerFetch(url: string, init: RequestInit): Promise<Response> {
  if (Platform.OS !== 'web') {
    return fetch(url, init);
  }

  try {
    return await fetch(webDevProxyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        method: init.method ?? 'GET',
        headers: headersToObject(init.headers),
        body: typeof init.body === 'string' ? init.body : undefined,
      }),
    });
  } catch {
    throw new Error('Web 调试代理未启动或不可访问。请用 npm run web 启动应用，或确认 127.0.0.1:8787 可访问。');
  }
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

function modelText(modelId: string): string {
  return modelId.toLowerCase();
}

function isOpenAiBaseUrl(provider: ProviderProfile): boolean {
  return provider.baseUrl.toLowerCase().includes('api.openai.com');
}

function isQwenLikeModel(modelId: string): boolean {
  const text = modelText(modelId);
  return text.includes('qwen') || text.includes('qwq') || text.includes('qvq');
}

function isBailianReasoningEffortModel(modelId: string): boolean {
  const text = modelText(modelId);
  return text.includes('deepseek-v4') || text.includes('glm-5');
}

function qwenThinkingBudget(effort: ReasoningEffort): number | undefined {
  if (effort === 'low') {
    return 1024;
  }

  if (effort === 'medium') {
    return 4096;
  }

  if (effort === 'high') {
    return 8192;
  }

  if (effort === 'max') {
    return 16384;
  }

  return undefined;
}

function arkReasoningEffort(effort: ReasoningEffort): string | undefined {
  if (effort === 'default') {
    return undefined;
  }

  if (effort === 'off') {
    return 'minimal';
  }

  return effort;
}

function openAiReasoningEffort(effort: ReasoningEffort): string | undefined {
  if (effort === 'default') {
    return undefined;
  }

  if (effort === 'off') {
    return 'none';
  }

  if (effort === 'max') {
    return 'xhigh';
  }

  return effort;
}

function compatibleReasoningEffort(effort: ReasoningEffort): string | undefined {
  if (effort === 'default') {
    return undefined;
  }

  if (effort === 'off') {
    return 'minimal';
  }

  return effort === 'max' ? 'xhigh' : effort;
}

function applyReasoningOptions(
  body: Record<string, unknown>,
  provider: ProviderProfile,
  modelId: string,
  effort: ReasoningEffort
) {
  if (effort === 'default') {
    return;
  }

  if (provider.kind === 'volcengine-ark') {
    const value = arkReasoningEffort(effort);
    if (value) {
      body.reasoning_effort = value;
    }
    if (effort === 'off') {
      body.thinking = { type: 'disabled' };
    }
    return;
  }

  if (provider.kind === 'bailian-compatible') {
    if (effort === 'off') {
      body.enable_thinking = false;
      return;
    }

    body.enable_thinking = true;

    if (isBailianReasoningEffortModel(modelId)) {
      body.reasoning_effort = effort === 'max' ? 'max' : 'high';
      return;
    }

    if (isQwenLikeModel(modelId)) {
      const budget = qwenThinkingBudget(effort);
      if (budget) {
        body.thinking_budget = budget;
      }
    }
    return;
  }

  if (isOpenAiBaseUrl(provider)) {
    const value = openAiReasoningEffort(effort);
    if (value) {
      body.reasoning = { effort: value };
    }
    return;
  }

  const value = compatibleReasoningEffort(effort);
  if (value) {
    body.reasoning_effort = value;
  }
}

export async function fetchOpenAiCompatibleModels(provider: ProviderProfile): Promise<ModelInfo[]> {
  const baseUrl = assertBaseUrl(provider);
  const response = await providerFetch(`${baseUrl}/models`, {
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
  reasoningEffort,
}: ChatCompletionArgs): Promise<ChatCompletionResult> {
  const baseUrl = assertBaseUrl(provider);

  if (!modelId) {
    throw new Error('请先选择一个模型。');
  }

  const body: Record<string, unknown> = {
    model: modelId,
    messages: messages.map(toOpenAiMessage),
    temperature: 0.7,
    stream: false,
  };
  applyReasoningOptions(body, provider, modelId, reasoningEffort);

  const response = await providerFetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: authHeaders(provider),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 404 && body.includes('InvalidEndpointOrModel.NotFound')) {
      throw new Error(
        `对话请求失败：当前模型 ID「${modelId}」不存在或当前 API Key 无权调用。请在配置页点击“获取模型”，选择接口返回的可用模型；如果火山控制台显示的是专属 Endpoint ID，请手动添加那个 ID。`
      );
    }
    throw new Error(`对话请求失败：${response.status} ${body.slice(0, 320)}`);
  }

  const payload = await response.json();

  return {
    content: readAssistantText(payload),
    raw: payload,
  };
}
