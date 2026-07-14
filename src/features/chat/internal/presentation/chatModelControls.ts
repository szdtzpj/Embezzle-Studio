import type {
  ModelParameterSettings,
  ModelTask,
  ProviderProfile,
} from '../../../../domain/types';
import {
  isArkStaticDoubaoModelId,
  isVolcengineArkProvider,
} from '../../../../data/arkModels';

export type ParameterKey = Exclude<keyof ModelParameterSettings, 'enabled'>;

export const parameterControls: Array<{
  key: ParameterKey;
  label: string;
  min: number;
  max: number;
  step: number;
  description: string;
}> = [
  {
    key: 'temperature',
    label: '温度',
    min: 0,
    max: 2,
    step: 0.01,
    description: '越低越稳定，越高越发散。',
  },
  {
    key: 'topP',
    label: 'Top P',
    min: 0,
    max: 1,
    step: 0.01,
    description: '控制采样候选范围，一般保持 1。',
  },
  {
    key: 'presencePenalty',
    label: '存在惩罚',
    min: -2,
    max: 2,
    step: 0.01,
    description: '正值会鼓励引入新话题。',
  },
  {
    key: 'frequencyPenalty',
    label: '频率惩罚',
    min: -2,
    max: 2,
    step: 0.01,
    description: '正值会减少重复表达。',
  },
];

export const modelTaskLabel: Record<ModelTask, string> = {
  chat: '对话',
  'image-generation': '图片生成',
  'video-generation': '视频生成',
  'audio-transcription': '语音转写',
  'speech-generation': '语音合成',
  embedding: '嵌入',
  rerank: '重排',
};

export function parameterRuntimeSummary(settings: ModelParameterSettings): string {
  if (!settings.enabled) return '参数默认';
  return `温度 ${settings.temperature.toFixed(2)} · Top P ${settings.topP.toFixed(2)}`;
}

export function normalizeParameterValue(
  value: number,
  min: number,
  max: number,
  step: number
): number {
  return clampParameterValue(
    snapParameterValue(clampParameterValue(value, min, max), step),
    min,
    max
  );
}

export function formatParameterValue(value: number): string {
  return value.toFixed(2).replace(/\.?0+$/, '');
}

export function getSelectableModels(provider: ProviderProfile) {
  return provider.models.filter(
    (model) =>
      model.source !== 'preset' &&
      !(
        isVolcengineArkProvider(provider) &&
        model.source !== 'remote' &&
        isArkStaticDoubaoModelId(model.id)
      )
  );
}

function clampParameterValue(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function snapParameterValue(value: number, step: number): number {
  return Math.round(value / step) * step;
}
