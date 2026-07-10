import type { ModelTask } from '../../domain/types';

export type ModelIconKey =
  | 'claude'
  | 'gemini'
  | 'qwen'
  | 'deepseek'
  | 'doubao'
  | 'chatglm'
  | 'zhipu'
  | 'kimi'
  | 'minimax'
  | 'bailian'
  | 'volcengine'
  | 'newapi'
  | 'openai'
  | 'unknown';

export const modelTaskLabel: Record<ModelTask, string> = {
  chat: '对话',
  'image-generation': '图片生成',
  'video-generation': '视频生成',
  'audio-transcription': '语音转写',
  'speech-generation': '语音合成',
  embedding: '嵌入',
  rerank: '重排',
};

export function capitalizeFirstSegment(value: string) {
  return value.replace(/^[a-z]/, (char) => char.toUpperCase());
}

export function truncateModelLabel(value: string, maxLength = 18) {
  return value.length > maxLength ? `${value.slice(0, Math.max(1, maxLength - 3))}...` : value;
}

export function formatCompactModelName(modelId?: string, _providerName?: string, maxLength = 18) {
  const raw = (modelId ?? '').trim();
  const lower = raw.toLowerCase();
  let compact = raw;

  if (lower.includes('claude')) compact = raw.replace(/.*claude[- ]?/i, 'Claude ');
  else if (lower.includes('gemini')) compact = raw.replace(/.*gemini[- ]?/i, 'Gemini ');
  else if (lower.includes('gpt')) compact = raw.replace(/.*gpt[- ]?/i, 'GPT-');
  else if (lower.includes('qwen')) compact = raw.replace(/.*qwen[- ]?/i, 'Qwen ');
  else if (lower.includes('deepseek')) compact = raw.replace(/.*deepseek[- ]?/i, 'DeepSeek ');
  else if (lower.includes('doubao')) compact = raw.replace(/.*doubao[- ]?/i, 'Doubao ');
  else if (lower.includes('kimi')) compact = raw.replace(/.*kimi[- ]?/i, 'Kimi ');

  return truncateModelLabel(capitalizeFirstSegment(compact), maxLength);
}

export function modelIconKey(modelId?: string, providerName?: string): ModelIconKey {
  const modelText = (modelId ?? '').trim().toLowerCase();
  const providerText = (providerName ?? '').trim().toLowerCase();
  const text = `${modelText} ${providerText}`;

  if (text.includes('模型未记录') || text.includes('未知服务商')) return 'unknown';
  if (text.includes('gpt') || text.includes('openai') || text.includes('codex')) return 'openai';
  if (text.includes('claude') || text.includes('anthropic')) return 'claude';
  if (text.includes('gemini') || text.includes('google')) return 'gemini';
  if (
    modelText.includes('qwen') ||
    modelText.includes('qwq') ||
    modelText.includes('qvq') ||
    modelText.includes('tongyi')
  ) return 'qwen';
  if (text.includes('deepseek')) return 'deepseek';
  if (modelText.includes('doubao') || modelText.includes('seed')) return 'doubao';
  if (modelText.includes('chatglm')) return 'chatglm';
  if (
    /^glm(?:[-_.]|$)/.test(modelText) ||
    text.includes('zhipu') ||
    text.includes('bigmodel') ||
    text.includes('智谱')
  ) return 'zhipu';
  if (text.includes('kimi') || text.includes('moonshot')) return 'kimi';
  if (text.includes('minimax')) return 'minimax';
  if (
    providerText.includes('bailian') ||
    providerText.includes('dashscope') ||
    providerText.includes('aliyun')
  ) return 'bailian';
  if (
    providerText.includes('volc') ||
    providerText.includes('ark') ||
    providerText.includes('huoshan')
  ) return 'volcengine';
  if (
    providerText.includes('new api') ||
    providerText.includes('new-api') ||
    providerText.includes('newapi')
  ) return 'newapi';

  return 'unknown';
}
