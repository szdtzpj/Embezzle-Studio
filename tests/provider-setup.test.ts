import { describe, expect, it } from 'vitest';

import type { ModelInfo, ProviderProfile } from '../src/domain/types';
import {
  buildModelCapabilityMatrixRow,
  compareProviderEndpointBinding,
  inspectProviderEndpoint,
  providerEndpointFingerprint,
} from '../src/services/providerSetup';

function provider(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'provider-test',
    name: 'Provider',
    kind: 'custom',
    baseUrl: 'https://api.openai.com/v1',
    capabilities: ['text', 'streaming'],
    models: [],
    ...overrides,
  };
}

function model(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: 'gpt-5',
    name: 'GPT 5',
    capabilities: ['text', 'image-input', 'file-input', 'reasoning', 'web-search', 'streaming'],
    task: 'chat',
    source: 'remote',
    ...overrides,
  };
}

describe('provider endpoint inspection', () => {
  it('normalizes official OpenAI request URLs to the canonical API base', () => {
    const result = inspectProviderEndpoint('https://api.openai.com/v1/chat/completions/', {
      kind: 'custom',
    });

    expect(result).toMatchObject({
      valid: true,
      family: 'openai-official',
      official: true,
      policy: 'allowed',
      normalizedBaseUrl: 'https://api.openai.com/v1',
      recommendedKind: 'openai-compatible',
      modelDiscoveryMode: 'official-model-list',
    });
  });

  it.each([
    ['https://api.openai.com./v1', 'openai-official', 'https://api.openai.com/v1'],
    ['https://ark.cn-beijing.volces.com./api/v3', 'volcengine-ark', 'https://ark.cn-beijing.volces.com/api/v3'],
    ['https://dashscope-us.aliyuncs.com./compatible-mode/v1', 'bailian-payg', 'https://dashscope-us.aliyuncs.com/compatible-mode/v1'],
  ])('canonicalizes a valid trailing-dot official host %s', (baseUrl, family, normalizedBaseUrl) => {
    expect(inspectProviderEndpoint(baseUrl)).toMatchObject({
      valid: true,
      official: true,
      family,
      normalizedBaseUrl,
    });
  });

  it('recognizes only exact Ark data-plane hosts and canonical paths', () => {
    const official = inspectProviderEndpoint(
      'https://ark.cn-beijing.volcengineapi.com/api/v3/models',
      { kind: 'volcengine-ark' }
    );
    const lookalike = inspectProviderEndpoint(
      'https://ark.cn-beijing.volces.com.evil.example/api/v3',
      { kind: 'custom' }
    );

    expect(official).toMatchObject({
      valid: true,
      family: 'volcengine-ark',
      normalizedBaseUrl: 'https://ark.cn-beijing.volcengineapi.com/api/v3',
      modelDiscoveryMode: 'best-effort-compatible-list',
    });
    expect(official.warnings.join(' ')).toMatch(/不能证明账号有调用权限/);
    expect(lookalike).toMatchObject({
      valid: true,
      family: 'openai-compatible-custom',
      official: false,
    });
  });

  it.each([
    ['workspace-beijing.cn-beijing.maas.aliyuncs.com', 'cn-beijing', 'workspace-beijing'],
    ['workspace-sg.ap-southeast-1.maas.aliyuncs.com', 'ap-southeast-1', 'workspace-sg'],
    ['workspace-us.us-east-1.maas.aliyuncs.com', 'us-east-1', 'workspace-us'],
    ['workspace-de.eu-central-1.maas.aliyuncs.com', 'eu-central-1', 'workspace-de'],
    ['workspace-jp.ap-northeast-1.maas.aliyuncs.com', 'ap-northeast-1', 'workspace-jp'],
  ])('recognizes Bailian workspace host %s', (host, region, workspaceId) => {
    const result = inspectProviderEndpoint(`https://${host}/compatible-mode/v1/responses`, {
      kind: 'bailian-compatible',
    });

    expect(result).toMatchObject({
      valid: true,
      family: 'bailian-payg',
      policy: 'allowed',
      region,
      workspaceId,
      normalizedBaseUrl: `https://${host}/compatible-mode/v1`,
    });
  });

  it.each([
    ['dashscope.aliyuncs.com', 'cn-beijing'],
    ['dashscope-intl.aliyuncs.com', 'ap-southeast-1'],
    ['dashscope-us.aliyuncs.com', 'us-east-1'],
  ])('recognizes the documented Bailian pay-as-you-go host %s', (host, region) => {
    const result = inspectProviderEndpoint(`https://${host}/compatible-mode/v1`, {
      kind: 'bailian-compatible',
    });

    expect(result).toMatchObject({
      valid: true,
      family: 'bailian-payg',
      region,
    });
  });

  it.each([
    ['https://coding.dashscope.aliyuncs.com/v1', 'bailian-coding-plan'],
    ['https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', 'bailian-token-plan'],
  ])('blocks subscription endpoint %s for a custom application', (baseUrl, family) => {
    const result = inspectProviderEndpoint(baseUrl, { kind: 'bailian-compatible' });

    expect(result).toMatchObject({
      valid: false,
      family,
      policy: 'blocked',
      modelDiscoveryMode: 'blocked',
    });
    expect(result.errors.join(' ')).toMatch(/自定义应用/);
  });

  it('blocks a plan-only key without returning or exposing it', () => {
    const apiKey = 'sk-sp-sensitive-value';
    const result = inspectProviderEndpoint('https://dashscope.aliyuncs.com/compatible-mode/v1', {
      kind: 'bailian-compatible',
      apiKey,
    });

    expect(result.valid).toBe(false);
    expect(result.policy).toBe('blocked');
    expect(JSON.stringify(result)).not.toContain(apiKey);
    expect(result.errors.join(' ')).toMatch(/套餐专属 API Key/);
  });

  it('rejects credential-bearing, query-bearing, insecure remote, and mismatched provider URLs', () => {
    expect(inspectProviderEndpoint('https://user:pass@api.openai.com/v1').valid).toBe(false);
    expect(inspectProviderEndpoint('https://api.openai.com/v1?token=value').valid).toBe(false);
    expect(inspectProviderEndpoint('http://provider.example/v1').valid).toBe(false);
    expect(
      inspectProviderEndpoint('https://api.openai.com/v1', { kind: 'bailian-compatible' }).valid
    ).toBe(false);
    expect(
      inspectProviderEndpoint('https://api.openai.com:8443/v1', { kind: 'custom' }).valid
    ).toBe(false);
    expect(
      inspectProviderEndpoint('http://127.0.0.1:11434/v1', { kind: 'custom' }).valid
    ).toBe(true);
  });
});

describe('provider endpoint binding', () => {
  it('treats equivalent endpoint spellings as the same secret/model binding', () => {
    const previous = provider({ baseUrl: 'https://api.openai.com/v1/' });
    const next = provider({ baseUrl: 'https://api.openai.com/v1/models' });

    expect(providerEndpointFingerprint(previous)).toBe('custom::https://api.openai.com/v1');
    expect(compareProviderEndpointBinding(previous, next)).toMatchObject({
      changed: false,
      mustClearApiKey: false,
      mustClearModels: false,
      mustClearModelCandidates: false,
    });
  });

  it.each([
    [
      provider({ baseUrl: 'https://api.openai.com/v1' }),
      provider({ baseUrl: 'https://relay.example/v1' }),
    ],
    [
      provider({ kind: 'custom', baseUrl: 'https://relay.example/v1' }),
      provider({ kind: 'new-api-relay', baseUrl: 'https://relay.example/v1' }),
    ],
    [
      provider({ baseUrl: 'https://api.openai.com/v1' }),
      provider({ baseUrl: 'not a URL' }),
    ],
  ])('invalidates the old key and model cache when a binding changes', (previous, next) => {
    expect(compareProviderEndpointBinding(previous, next)).toMatchObject({
      changed: true,
      mustClearApiKey: true,
      mustClearModels: true,
      mustClearModelCandidates: true,
    });
  });
});

describe('model capability matrix', () => {
  it('separates declared model capabilities from client adapter availability', () => {
    const row = buildModelCapabilityMatrixRow(provider(), model(), { platform: 'android' });

    expect(row.task).toBe('chat');
    expect(row.cells.text).toMatchObject({ status: 'available', declared: true });
    expect(row.cells['image-input']).toMatchObject({ status: 'available' });
    expect(row.cells['file-input']).toMatchObject({ status: 'available' });
    expect(row.cells['web-search']).toMatchObject({ status: 'available' });
    expect(row.cells['tool-calling']).toMatchObject({ status: 'unknown', declared: false });
    expect(row.cells.embedding).toMatchObject({ status: 'unknown', declared: false });
  });

  it('shows user-disabled and provider-only capabilities without promoting them to usable', () => {
    const row = buildModelCapabilityMatrixRow(
      provider(),
      model({
        capabilities: ['text', 'image-input', 'tool-calling', 'embedding'],
        capabilityOverrides: { 'image-input': false, 'tool-calling': true },
      })
    );

    expect(row.cells['image-input']).toMatchObject({
      status: 'disabled',
      evidence: 'user-override',
    });
    expect(row.cells['tool-calling']).toMatchObject({
      status: 'provider-only',
      evidence: 'user-override',
    });
    expect(row.cells.embedding).toMatchObject({ status: 'provider-only' });
  });

  it('enables MCP only when an official OpenAI model explicitly declares it', () => {
    const official = provider({
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
    });
    const declared = buildModelCapabilityMatrixRow(
      official,
      model({ capabilities: ['text', 'mcp'] })
    );
    const undeclared = buildModelCapabilityMatrixRow(
      official,
      model({ capabilities: ['text'] })
    );

    expect(declared.cells.mcp).toMatchObject({
      declared: true,
      status: 'available',
    });
    expect(declared.cells.mcp.reason).toMatch(/api\.openai\.com.*store:false/);
    expect(undeclared.cells.mcp).toMatchObject({
      declared: false,
      status: 'unknown',
    });
  });

  it('does not enable MCP for an OpenAI-compatible relay that only claims the OpenAI kind', () => {
    const disguisedRelay = provider({
      kind: 'openai-compatible',
      baseUrl: 'https://relay.example/v1',
    });
    const row = buildModelCapabilityMatrixRow(
      disguisedRelay,
      model({ capabilities: ['text', 'mcp'] })
    );

    expect(row.cells.mcp).toMatchObject({
      declared: true,
      status: 'provider-only',
    });
    expect(row.cells.mcp.reason).toMatch(/精确的 api\.openai\.com 官方端点/);
  });

  it.each([
    [
      '火山方舟',
      provider({
        kind: 'volcengine-ark',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      }),
      /官方虽有工具审批协议.*真实账号验证 store:false 手动续接前/,
    ],
    [
      '阿里百炼',
      provider({
        kind: 'bailian-compatible',
        baseUrl: 'https://workspace-sg.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
      }),
      /Responses 缺少执行前审批协议/,
    ],
  ])('keeps %s MCP provider-only with its protocol-specific reason', (_name, target, reason) => {
    const row = buildModelCapabilityMatrixRow(
      target,
      model({ capabilities: ['text', 'mcp'] })
    );

    expect(row.cells.mcp).toMatchObject({
      declared: true,
      status: 'provider-only',
    });
    expect(row.cells.mcp.reason).toMatch(reason);
  });

  it('applies exact provider and platform gates to video, search, and audio cells', () => {
    const bailian = provider({
      kind: 'bailian-compatible',
      baseUrl: 'https://workspace-sg.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    });
    const multimodal = model({
      id: 'qwen-omni',
      capabilities: ['text', 'video-input', 'web-search'],
    });
    const android = buildModelCapabilityMatrixRow(bailian, multimodal, { platform: 'android' });
    const asr = model({
      id: 'qwen3-asr-flash',
      capabilities: ['speech-to-text'],
      task: 'audio-transcription',
    });
    const tts = model({
      id: 'qwen3-tts-flash',
      capabilities: ['text-to-speech'],
      task: 'speech-generation',
    });
    const androidAsr = buildModelCapabilityMatrixRow(bailian, asr, { platform: 'android' });
    const androidTts = buildModelCapabilityMatrixRow(bailian, tts, { platform: 'android' });
    const webAsr = buildModelCapabilityMatrixRow(bailian, asr, { platform: 'web' });

    expect(android.cells['video-input'].status).toBe('available');
    expect(android.cells['web-search'].status).toBe('available');
    expect(androidAsr.cells['speech-to-text'].status).toBe('available');
    expect(androidTts.cells['text-to-speech'].status).toBe('available');
    expect(webAsr.cells['speech-to-text']).toMatchObject({ status: 'provider-only' });
  });

  it('blocks every declared capability when the endpoint policy is invalid', () => {
    const codingPlan = provider({
      kind: 'bailian-compatible',
      baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
    });
    const row = buildModelCapabilityMatrixRow(codingPlan, model());

    expect(row.cells.text.status).toBe('blocked');
    expect(row.cells['web-search'].status).toBe('blocked');
    expect(row.cells['video-input'].status).toBe('unknown');
  });
});
