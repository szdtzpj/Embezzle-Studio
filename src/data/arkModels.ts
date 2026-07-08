import type { Capability, ModelInfo, ProviderProfile } from '../domain/types';

const arkTextVisionVideo: Capability[] = [
  'text',
  'image-input',
  'video-input',
  'tool-calling',
  'streaming',
];

const arkTextVision: Capability[] = ['text', 'image-input', 'tool-calling', 'streaming'];
const arkText: Capability[] = ['text', 'tool-calling', 'streaming'];

export const arkPresetModels: ModelInfo[] = [
  {
    id: 'doubao-seed-evolving',
    name: 'Doubao Seed Evolving',
    capabilities: arkTextVisionVideo,
    contextWindow: 262144,
    source: 'preset',
  },
  {
    id: 'doubao-seed-2-1-pro',
    name: 'Doubao Seed 2.1 Pro',
    capabilities: arkTextVisionVideo,
    contextWindow: 262144,
    source: 'preset',
  },
  {
    id: 'doubao-seed-2-1-turbo',
    name: 'Doubao Seed 2.1 Turbo',
    capabilities: arkTextVisionVideo,
    contextWindow: 262144,
    source: 'preset',
  },
  {
    id: 'doubao-seed-2-0-pro-260215',
    name: 'Doubao Seed 2.0 Pro',
    capabilities: arkTextVisionVideo,
    contextWindow: 262144,
    source: 'preset',
  },
  {
    id: 'doubao-seed-2-0-lite-260215',
    name: 'Doubao Seed 2.0 Lite',
    capabilities: arkTextVisionVideo,
    contextWindow: 262144,
    source: 'preset',
  },
  {
    id: 'doubao-seed-2-0-mini-260215',
    name: 'Doubao Seed 2.0 Mini',
    capabilities: arkTextVisionVideo,
    contextWindow: 262144,
    source: 'preset',
  },
  {
    id: 'doubao-seed-2-0-code-preview-260215',
    name: 'Doubao Seed 2.0 Code Preview',
    capabilities: arkText,
    contextWindow: 262144,
    source: 'preset',
  },
  {
    id: 'doubao-seed-1-8-251215',
    name: 'Doubao Seed 1.8',
    capabilities: arkTextVisionVideo,
    contextWindow: 262144,
    source: 'preset',
  },
  {
    id: 'doubao-seed-code-preview-251028',
    name: 'Doubao Seed Code Preview',
    capabilities: arkText,
    contextWindow: 262144,
    source: 'preset',
  },
  {
    id: 'doubao-seed-1-6-251015',
    name: 'Doubao Seed 1.6',
    capabilities: arkTextVisionVideo,
    contextWindow: 262144,
    source: 'preset',
  },
  {
    id: 'doubao-seed-1-6-flash-250828',
    name: 'Doubao Seed 1.6 Flash',
    capabilities: arkTextVisionVideo,
    contextWindow: 262144,
    source: 'preset',
  },
  {
    id: 'doubao-seed-1-6-vision-250815',
    name: 'Doubao Seed 1.6 Vision',
    capabilities: arkTextVisionVideo,
    contextWindow: 262144,
    source: 'preset',
  },
  {
    id: 'doubao-1-5-thinking-pro',
    name: 'Doubao 1.5 Thinking Pro',
    capabilities: arkText,
    source: 'preset',
  },
  {
    id: 'doubao-1-5-thinking-vision-pro',
    name: 'Doubao 1.5 Thinking Vision Pro',
    capabilities: arkTextVision,
    source: 'preset',
  },
  {
    id: 'doubao-1-5-vision-pro',
    name: 'Doubao 1.5 Vision Pro',
    capabilities: arkTextVision,
    contextWindow: 32768,
    source: 'preset',
  },
  {
    id: 'doubao-1-5-pro-32k-250115',
    name: 'Doubao 1.5 Pro 32k',
    capabilities: arkText,
    contextWindow: 32768,
    source: 'preset',
  },
  {
    id: 'doubao-1-5-lite-32k-250115',
    name: 'Doubao 1.5 Lite 32k',
    capabilities: arkText,
    contextWindow: 32768,
    source: 'preset',
  },
];

export function isVolcengineArkProvider(provider: ProviderProfile): boolean {
  const host = provider.baseUrl.toLowerCase();
  const name = provider.name.toLowerCase();

  return (
    provider.kind === 'volcengine-ark' ||
    host.includes('ark.cn-beijing.volces.com') ||
    host.includes('ark.cn-beijing.volcengineapi.com') ||
    name.includes('volcengine') ||
    name.includes('火山') ||
    name.includes('doubao') ||
    name.includes('豆包')
  );
}
