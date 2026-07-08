import type {
  ChatCompletionResult,
  ChatMessage,
  ChatTokenUsage,
  GenerationTaskInfo,
  MediaAttachment,
  ModelInfo,
  ModelTask,
  ProviderProfile,
  ReasoningEffort,
} from '../domain/types';
import { Platform } from 'react-native';

interface ChatCompletionArgs {
  provider: ProviderProfile;
  modelId: string;
  messages: ChatMessage[];
  reasoningEffort: ReasoningEffort;
  onStreamUpdate?: (update: ChatStreamUpdate) => void;
}

interface ChatStreamUpdate {
  content: string;
  reasoningContent?: string;
  usage?: ChatTokenUsage;
  raw?: unknown;
}

interface RemoteModel {
  id?: string;
  object?: string;
  owned_by?: string;
}

interface ArkVideoTaskResponse {
  id?: string;
  status?: string;
  content?: {
    video_url?: string;
    url?: string;
  };
  data?: {
    status?: string;
    content?: {
      video_url?: string;
      url?: string;
    };
  };
  error?: {
    message?: string;
  };
}

const webDevProxyUrl = 'http://127.0.0.1:8787/proxy';

function shouldAppendOpenAiVersion(baseUrl: string, provider: ProviderProfile): boolean {
  if (!['custom', 'new-api-relay', 'openai-compatible'].includes(provider.kind)) {
    return false;
  }

  try {
    const url = new URL(baseUrl);
    const path = url.pathname.replace(/\/+$/, '').toLowerCase();
    return path === '';
  } catch {
    return false;
  }
}

function normalizeBaseUrl(baseUrl: string, provider: ProviderProfile): string {
  const normalized = baseUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/(?:chat\/completions|models)$/i, '');

  if (normalized && shouldAppendOpenAiVersion(normalized, provider)) {
    return `${normalized}/v1`;
  }

  return normalized;
}

function authHeaders(provider: ProviderProfile): HeadersInit {
  if (!provider.apiKey?.trim()) {
    throw new Error('请先填写当前服务商的 API Key。');
  }

  return {
    Authorization: `Bearer ${provider.apiKey.trim()}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

function assertBaseUrl(provider: ProviderProfile): string {
  const baseUrl = normalizeBaseUrl(provider.baseUrl, provider);
  if (!baseUrl) {
    throw new Error('请先填写当前服务商的 Base URL。');
  }
  return baseUrl;
}

function compactResponseText(body: string): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, 260);
}

function looksLikeHtmlResponse(body: string, contentType: string): boolean {
  const text = body.trim().toLowerCase();
  return contentType.includes('text/html') || text.startsWith('<!doctype') || text.startsWith('<html');
}

async function readJsonResponse<T>(response: Response, requestUrl: string, label: string): Promise<T> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`${label}失败：${response.status} ${compactResponseText(body)}`);
  }

  if (looksLikeHtmlResponse(body, contentType)) {
    throw new Error(
      `${label}返回的是 HTML 页面，不是 JSON。当前请求地址：${requestUrl}。请确认 Base URL 是 OpenAI/New API 兼容接口地址，例如 https://new-api.zxzt123.com/v1；如果只填主站域名，服务端通常会返回管理后台页面。`
    );
  }

  try {
    return JSON.parse(body) as T;
  } catch (error) {
    throw new Error(
      `${label}返回内容不是有效 JSON：${error instanceof Error ? error.message : String(error)}。当前请求地址：${requestUrl}。响应片段：${compactResponseText(body)}`
    );
  }
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

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readTextParts(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.trim() ? [value.trim()] : [];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }

      return (
        part?.text ??
        part?.content ??
        part?.reasoning_content ??
        part?.reasoningContent ??
        ''
      );
    })
    .filter((text) => typeof text === 'string' && text.trim())
    .map((text) => text.trim());
}

function readReasoningText(payload: any): string | undefined {
  const message = payload?.choices?.[0]?.message;
  const direct =
    nonEmptyText(message?.reasoning_content) ??
    nonEmptyText(message?.reasoningContent) ??
    nonEmptyText(message?.reasoning);

  if (direct) {
    return direct;
  }

  const contentParts = readTextParts(message?.reasoning_details ?? message?.thinking ?? message?.thoughts);
  if (contentParts.length) {
    return contentParts.join('\n\n');
  }

  const responseReasoning = Array.isArray(payload?.output)
    ? payload.output
        .filter((item: any) => item?.type === 'reasoning')
        .flatMap((item: any) => readTextParts(item?.summary ?? item?.content ?? item?.text))
    : [];

  if (responseReasoning.length) {
    return responseReasoning.join('\n\n');
  }

  return undefined;
}

function readDeltaText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const text = value
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }

      return part?.text ?? part?.content ?? '';
    })
    .join('');

  return text || undefined;
}

function readStreamContentDelta(payload: any): string | undefined {
  const choice = payload?.choices?.[0];
  const delta = choice?.delta;

  return readDeltaText(delta?.content) ?? readDeltaText(choice?.message?.content);
}

function readStreamReasoningDelta(payload: any): string | undefined {
  const choice = payload?.choices?.[0];
  const delta = choice?.delta;

  return (
    readDeltaText(delta?.reasoning_content) ??
    readDeltaText(delta?.reasoningContent) ??
    readDeltaText(delta?.reasoning) ??
    readDeltaText(delta?.thinking) ??
    readDeltaText(delta?.thoughts) ??
    readDeltaText(delta?.reasoning_details)
  );
}

function readFinalChatPayload(payload: any): ChatCompletionResult {
  return {
    content: readAssistantText(payload),
    reasoningContent: readReasoningText(payload),
    usage: readTokenUsage(payload),
    raw: payload,
  };
}

function applyStreamPayload(
  payload: any,
  state: {
    content: string;
    reasoningContent: string;
    usage?: ChatTokenUsage;
    lastPayload?: unknown;
    sawStreamPayload: boolean;
  },
  onStreamUpdate?: (update: ChatStreamUpdate) => void
) {
  state.sawStreamPayload = true;
  state.lastPayload = payload;

  const contentDelta = readStreamContentDelta(payload);
  const reasoningDelta = readStreamReasoningDelta(payload);
  const usage = readTokenUsage(payload);

  if (typeof contentDelta === 'string') {
    state.content += contentDelta;
  }

  if (typeof reasoningDelta === 'string') {
    state.reasoningContent += reasoningDelta;
  }

  if (usage) {
    state.usage = usage;
  }

  if (contentDelta || reasoningDelta || usage) {
    onStreamUpdate?.({
      content: state.content,
      reasoningContent: state.reasoningContent || undefined,
      usage: state.usage,
      raw: payload,
    });
  }
}

function processSseBlock(
  block: string,
  state: {
    content: string;
    reasoningContent: string;
    usage?: ChatTokenUsage;
    lastPayload?: unknown;
    sawStreamPayload: boolean;
    done: boolean;
  },
  onStreamUpdate?: (update: ChatStreamUpdate) => void
) {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
    .trim();

  if (!data) {
    return;
  }

  if (data === '[DONE]') {
    state.done = true;
    return;
  }

  const payload = JSON.parse(data);
  if (payload?.error) {
    const message =
      typeof payload.error?.message === 'string'
        ? payload.error.message
        : compactResponseText(JSON.stringify(payload.error));
    throw new Error(`对话流式请求失败：${message}`);
  }
  applyStreamPayload(payload, state, onStreamUpdate);
}

function finalizeStreamResult(
  state: {
    content: string;
    reasoningContent: string;
    usage?: ChatTokenUsage;
    lastPayload?: unknown;
    sawStreamPayload: boolean;
  },
  fullText: string
): ChatCompletionResult {
  if (!state.sawStreamPayload) {
    const payload = JSON.parse(fullText);
    return readFinalChatPayload(payload);
  }

  return {
    content: state.content || (state.reasoningContent ? '' : '模型返回了空内容。'),
    reasoningContent: state.reasoningContent || undefined,
    usage: state.usage,
    raw: state.lastPayload ?? fullText,
  };
}

async function readStreamingChatCompletion(
  response: Response,
  onStreamUpdate?: (update: ChatStreamUpdate) => void
): Promise<ChatCompletionResult> {
  const state = {
    content: '',
    reasoningContent: '',
    usage: undefined as ChatTokenUsage | undefined,
    lastPayload: undefined as unknown,
    sawStreamPayload: false,
    done: false,
  };
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  const consumeText = (text: string) => {
    fullText += text;
    buffer += text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    let separatorIndex = buffer.indexOf('\n\n');
    while (separatorIndex >= 0) {
      const block = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      processSseBlock(block, state, onStreamUpdate);
      separatorIndex = buffer.indexOf('\n\n');
    }
  };

  const reader = response.body?.getReader();

  if (!reader) {
    consumeText(await response.text());
  } else {
    while (!state.done) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      consumeText(decoder.decode(value, { stream: true }));
    }
    consumeText(decoder.decode());
  }

  if (buffer.trim()) {
    processSseBlock(buffer, state, onStreamUpdate);
  }

  return finalizeStreamResult(state, fullText);
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readTokenUsage(payload: any): ChatTokenUsage | undefined {
  const usage = payload?.usage;
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }

  const tokenUsage: ChatTokenUsage = {
    inputTokens: optionalNumber(usage.prompt_tokens) ?? optionalNumber(usage.input_tokens),
    outputTokens: optionalNumber(usage.completion_tokens) ?? optionalNumber(usage.output_tokens),
    reasoningTokens:
      optionalNumber(usage.completion_tokens_details?.reasoning_tokens) ??
      optionalNumber(usage.output_tokens_details?.reasoning_tokens),
    cachedInputTokens:
      optionalNumber(usage.prompt_tokens_details?.cached_tokens) ??
      optionalNumber(usage.input_tokens_details?.cached_tokens),
    totalTokens: optionalNumber(usage.total_tokens),
  };

  return Object.values(tokenUsage).some((value) => typeof value === 'number') ? tokenUsage : undefined;
}

function modelText(modelId: string): string {
  return modelId.toLowerCase();
}

function inferModelTask(modelId: string): ModelTask {
  const text = modelText(modelId);

  if (text.includes('seedream') || text.includes('image-generation') || text.includes('text-to-image')) {
    return 'image-generation';
  }

  if (text.includes('seedance') || text.includes('video-generation') || text.includes('text-to-video')) {
    return 'video-generation';
  }

  if (text.includes('embedding') || text.includes('embed')) {
    return 'embedding';
  }

  if (text.includes('rerank') || text.includes('reranker')) {
    return 'rerank';
  }

  return 'chat';
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

  if (effort === 'max') {
    return 'high';
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
  const requestUrl = `${baseUrl}/models`;
  const response = await providerFetch(requestUrl, {
    method: 'GET',
    headers: authHeaders(provider),
  });

  const payload = await readJsonResponse<{ data?: RemoteModel[] }>(response, requestUrl, '模型列表获取');
  const remoteModels = Array.isArray(payload.data) ? payload.data : [];

  return remoteModels
    .filter((model) => typeof model.id === 'string' && model.id.length > 0)
    .map((model) => ({
      id: model.id as string,
      name: model.id,
      capabilities: provider.capabilities,
      task: inferModelTask(model.id as string),
      source: 'remote',
    }));
}

function latestUserPrompt(messages: ChatMessage[]): string {
  const message = [...messages].reverse().find((item) => item.role === 'user' && item.content.trim());
  return message?.content.trim() ?? '';
}

function generatedImageUrls(payload: any): string[] {
  if (!Array.isArray(payload?.data)) {
    return [];
  }

  return payload.data
    .map((image: any) => nonEmptyText(image?.url) ?? nonEmptyText(image?.image_url?.url) ?? nonEmptyText(image?.b64_json))
    .filter((url: string | undefined): url is string => Boolean(url));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function videoTaskStatus(task: ArkVideoTaskResponse): string | undefined {
  return task.status ?? task.data?.status;
}

function videoTaskUrl(task: ArkVideoTaskResponse): string | undefined {
  return nonEmptyText(task.content?.video_url) ??
    nonEmptyText(task.content?.url) ??
    nonEmptyText(task.data?.content?.video_url) ??
    nonEmptyText(task.data?.content?.url);
}

async function retrieveArkVideoTask(provider: ProviderProfile, taskId: string): Promise<ArkVideoTaskResponse> {
  const baseUrl = assertBaseUrl(provider);
  const response = await providerFetch(`${baseUrl}/contents/generations/tasks/${taskId}`, {
    method: 'GET',
    headers: authHeaders(provider),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`视频生成任务查询失败：${response.status} ${body.slice(0, 240)}`);
  }

  return (await response.json()) as ArkVideoTaskResponse;
}

function videoTaskAttachment(taskId: string, modelId: string, videoUrl: string): MediaAttachment {
  return {
    id: `generated-video-${taskId}`,
    kind: 'video',
    uri: videoUrl,
    name: `${modelId}.mp4`,
  };
}

export async function queryGenerationTask(
  provider: ProviderProfile,
  task: GenerationTaskInfo
): Promise<ChatCompletionResult> {
  if (task.kind !== 'video') {
    throw new Error('当前只支持查询视频生成任务。');
  }

  if (provider.kind !== 'volcengine-ark') {
    throw new Error('当前只适配了火山 Ark 的视频生成任务查询。');
  }

  const payload = await retrieveArkVideoTask(provider, task.taskId);
  const status = videoTaskStatus(payload) ?? task.status ?? 'submitted';
  const videoUrl = videoTaskUrl(payload);
  const generationTask: GenerationTaskInfo = {
    ...task,
    status,
  };

  if (status === 'failed') {
    throw new Error(`视频生成任务失败：${payload.error?.message ?? task.taskId}`);
  }

  if (videoUrl) {
    return {
      content: `视频生成完成。任务 ID：${task.taskId}`,
      attachments: [videoTaskAttachment(task.taskId, task.modelId, videoUrl)],
      generationTask,
      raw: payload,
    };
  }

  return {
    content: `视频生成任务尚未完成，任务 ID：${task.taskId}，当前状态：${status}。`,
    generationTask,
    raw: payload,
  };
}

async function sendImageGenerationRequest(
  provider: ProviderProfile,
  modelId: string,
  messages: ChatMessage[]
): Promise<ChatCompletionResult> {
  const baseUrl = assertBaseUrl(provider);
  const prompt = latestUserPrompt(messages);

  if (!prompt) {
    throw new Error('请先输入图片生成提示词。');
  }

  const response = await providerFetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: authHeaders(provider),
    body: JSON.stringify({
      model: modelId,
      prompt,
      response_format: 'url',
      size: '1024x1024',
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`图片生成请求失败：${response.status} ${body.slice(0, 320)}`);
  }

  const payload = await response.json();
  const attachments: MediaAttachment[] = generatedImageUrls(payload).map((imageUrl, index) => ({
    id: `generated-image-${Date.now()}-${index}`,
    kind: 'image',
    uri: imageUrl.startsWith('data:') ? imageUrl : imageUrl.startsWith('http') ? imageUrl : `data:image/png;base64,${imageUrl}`,
    name: `${modelId}-${index + 1}.png`,
  }));

  return {
    content: attachments.length ? '图片生成完成。' : '图片生成完成，但响应中没有可展示的图片 URL。',
    usage: readTokenUsage(payload),
    attachments,
    raw: payload,
  };
}

async function sendArkVideoGenerationRequest(
  provider: ProviderProfile,
  modelId: string,
  messages: ChatMessage[]
): Promise<ChatCompletionResult> {
  const baseUrl = assertBaseUrl(provider);
  const prompt = latestUserPrompt(messages);

  if (!prompt) {
    throw new Error('请先输入视频生成提示词。');
  }

  const response = await providerFetch(`${baseUrl}/contents/generations/tasks`, {
    method: 'POST',
    headers: authHeaders(provider),
    body: JSON.stringify({
      model: modelId,
      content: [
        {
          type: 'text',
          text: prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`视频生成任务提交失败：${response.status} ${body.slice(0, 320)}`);
  }

  const payload = (await response.json()) as ArkVideoTaskResponse;
  const taskId = payload.id;

  if (!taskId) {
    return {
      content: '视频生成任务已提交，但响应中没有返回任务 ID。',
      raw: payload,
    };
  }

  const generationTask: GenerationTaskInfo = {
    providerId: provider.id,
    modelId,
    taskId,
    kind: 'video',
    status: 'submitted',
  };

  let task = payload;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const status = videoTaskStatus(task);
    if (status === 'succeeded' || status === 'failed' || status === 'cancelled') {
      break;
    }

    await sleep(2500);
    task = await retrieveArkVideoTask(provider, taskId);
  }

  const status = videoTaskStatus(task) ?? 'submitted';
  const videoUrl = videoTaskUrl(task);
  const updatedTask: GenerationTaskInfo = {
    ...generationTask,
    status,
  };

  if (status === 'failed') {
    throw new Error(`视频生成任务失败：${task.error?.message ?? taskId}`);
  }

  if (videoUrl) {
    return {
      content: `视频生成完成。任务 ID：${taskId}`,
      attachments: [videoTaskAttachment(taskId, modelId, videoUrl)],
      generationTask: updatedTask,
      raw: task,
    };
  }

  return {
    content: `视频生成任务已提交，任务 ID：${taskId}，当前状态：${status}。生成时间较长时需要稍后查询任务结果。`,
    generationTask: updatedTask,
    raw: task,
  };
}

export async function sendOpenAiCompatibleChat({
  provider,
  modelId,
  messages,
  reasoningEffort,
  onStreamUpdate,
}: ChatCompletionArgs): Promise<ChatCompletionResult> {
  if (!modelId) {
    throw new Error('请先选择一个模型。');
  }

  const task = inferModelTask(modelId);

  if (task === 'image-generation') {
    return sendImageGenerationRequest(provider, modelId, messages);
  }

  if (task === 'video-generation') {
    if (provider.kind !== 'volcengine-ark') {
      throw new Error('当前只适配了火山 Ark 的视频生成任务接口。');
    }

    return sendArkVideoGenerationRequest(provider, modelId, messages);
  }

  if (task === 'embedding' || task === 'rerank') {
    throw new Error('当前模型不是对话模型，不能在聊天窗口中调用。请切换到文本/多模态对话模型。');
  }

  const baseUrl = assertBaseUrl(provider);
  const body: Record<string, unknown> = {
    model: modelId,
    messages: messages.map(toOpenAiMessage),
    temperature: 0.7,
    stream: true,
  };
  applyReasoningOptions(body, provider, modelId, reasoningEffort);

  const response = await providerFetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      ...authHeaders(provider),
      Accept: 'text/event-stream, application/json',
    },
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

  return readStreamingChatCompletion(response, onStreamUpdate);
}
