import { describe, expect, it } from 'vitest';

import type { ModelInfo, ProviderProfile } from '../src/domain/types';
import {
  buildModelCapabilityMatrixRow,
  buildModelDiscoveryRequest,
  compareProviderEndpointBinding,
  inspectProviderEndpoint,
  isExactOfficialAnthropicProvider,
  isExactOfficialDeepSeekProvider,
  isExactOfficialGeminiProvider,
  isExactOfficialOpenAiProvider,
  isExactOfficialXaiProvider,
  isRelayOrCustomProvider,
  parseDiscoveredModelsPayload,
  providerEndpointFingerprint,
  resolveProviderAuthHeaders,
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

  it('marks Anthropic native raster image generation as provider-only with guidance', () => {
    const anthropic = provider({
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
    });
    const row = buildModelCapabilityMatrixRow(
      anthropic,
      model({
        id: 'claude-image-placeholder',
        capabilities: ['text', 'image-generation'],
        task: 'image-generation',
      })
    );
    expect(row.cells['image-generation'].status).toBe('provider-only');
    expect(row.cells['image-generation'].reason).toMatch(/不提供原生光栅生图/);
  });
});

describe('2026 official provider inspection, auth headers, and model discovery helpers', () => {
  it.each([
    ['https://api.anthropic.com/v1/messages/', 'anthropic', 'anthropic-official', 'https://api.anthropic.com/v1'],
    ['https://generativelanguage.googleapis.com/v1beta/models', 'gemini', 'gemini-official', 'https://generativelanguage.googleapis.com/v1beta'],
    ['https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', 'gemini', 'gemini-official', 'https://generativelanguage.googleapis.com/v1beta'],
    ['https://api.x.ai/v1/responses', 'xai-grok', 'xai-official', 'https://api.x.ai/v1'],
    ['https://api.deepseek.com/anthropic/v1/messages', 'deepseek', 'deepseek-official', 'https://api.deepseek.com/v1'],
  ] as const)('normalizes official endpoint %s for %s', (baseUrl, kind, family, normalizedBaseUrl) => {
    const result = inspectProviderEndpoint(baseUrl, { kind });
    expect(result).toMatchObject({
      valid: true,
      official: true,
      family,
      policy: 'allowed',
      kindCompatible: true,
      normalizedBaseUrl,
      modelDiscoveryMode: 'official-model-list',
    });
  });

  it('rejects lookalike hosts, custom ports, and insecure HTTP for new official endpoints', () => {
    expect(inspectProviderEndpoint('https://api.anthropic.com.evil.example/v1', { kind: 'anthropic' }).valid).toBe(false);
    expect(inspectProviderEndpoint('https://api.anthropic.com:8443/v1', { kind: 'anthropic' }).valid).toBe(false);
    expect(inspectProviderEndpoint('http://api.x.ai/v1', { kind: 'xai-grok' }).valid).toBe(false);
    expect(inspectProviderEndpoint('https://generativelanguage.googleapis.com/v1beta', { kind: 'openai-compatible' }).valid).toBe(false);
  });

  it('strictly distinguishes exact official providers from custom and relay endpoints', () => {
    expect(isExactOfficialOpenAiProvider({ kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' })).toBe(true);
    expect(isExactOfficialOpenAiProvider({ kind: 'custom', baseUrl: 'https://api.openai.com/v1' })).toBe(false);
    expect(isExactOfficialOpenAiProvider({ kind: 'new-api-relay', baseUrl: 'https://api.openai.com/v1' })).toBe(false);
    expect(isExactOfficialOpenAiProvider({ kind: 'anthropic', baseUrl: 'https://api.openai.com/v1' })).toBe(false);

    expect(isExactOfficialAnthropicProvider({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com' })).toBe(true);
    expect(isExactOfficialAnthropicProvider({ kind: 'custom', baseUrl: 'https://api.anthropic.com/v1' })).toBe(false);

    expect(isExactOfficialGeminiProvider({ kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com' })).toBe(true);
    expect(isExactOfficialGeminiProvider({ kind: 'custom', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' })).toBe(false);

    expect(isExactOfficialXaiProvider({ kind: 'xai-grok', baseUrl: 'https://api.x.ai/v1' })).toBe(true);
    expect(isExactOfficialXaiProvider({ kind: 'new-api-relay', baseUrl: 'https://api.x.ai/v1' })).toBe(false);

    expect(isExactOfficialDeepSeekProvider({ kind: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' })).toBe(true);
    expect(isExactOfficialDeepSeekProvider({ kind: 'custom', baseUrl: 'https://api.deepseek.com/v1' })).toBe(true);
    expect(isExactOfficialDeepSeekProvider({ baseUrl: 'https://api.deepseek.com/' })).toBe(true);
    expect(isExactOfficialDeepSeekProvider({ kind: 'new-api-relay', baseUrl: 'https://api.deepseek.com/v1' })).toBe(false);
    expect(isExactOfficialDeepSeekProvider({ kind: 'deepseek', baseUrl: 'https://relay.example.com/v1' })).toBe(false);

    expect(isRelayOrCustomProvider({ kind: 'new-api-relay', baseUrl: 'https://relay.example.com/v1' })).toBe(true);
    expect(isRelayOrCustomProvider({ kind: 'custom', baseUrl: 'https://api.openai.com/v1' })).toBe(true);
    expect(isRelayOrCustomProvider({ kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' })).toBe(false);
    expect(isRelayOrCustomProvider({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' })).toBe(false);
    expect(isRelayOrCustomProvider({ kind: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' })).toBe(false);

    // E2E-M2 修复边界：官方 kind 配仿冒域名或合法第三方中转/回环地址应判定为 true
    expect(isRelayOrCustomProvider({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com.evil.example/v1' })).toBe(true);
    expect(isRelayOrCustomProvider({ kind: 'openai-compatible', baseUrl: 'https://api.openai.com.evil.example/v1' })).toBe(true);
    expect(isRelayOrCustomProvider({ kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com.evil.example/v1beta' })).toBe(true);
    expect(isRelayOrCustomProvider({ kind: 'xai-grok', baseUrl: 'https://api.x.ai.evil.example/v1' })).toBe(true);
    expect(isRelayOrCustomProvider({ kind: 'deepseek', baseUrl: 'https://api.deepseek.com.evil.example/v1' })).toBe(true);
    expect(isRelayOrCustomProvider({ kind: 'volcengine-ark', baseUrl: 'https://ark.cn-beijing.volces.com.evil.example/api/v3' })).toBe(true);
    expect(isRelayOrCustomProvider({ kind: 'bailian-compatible', baseUrl: 'https://dashscope.aliyuncs.com.evil.example/compatible-mode/v1' })).toBe(true);
    expect(isRelayOrCustomProvider({ kind: 'xai-grok', baseUrl: 'https://relay.example.com/v1' })).toBe(true);
    expect(isRelayOrCustomProvider({ kind: 'anthropic', baseUrl: 'http://127.0.0.1:8080/v1' })).toBe(true);

    // 合法官方 Ark / Bailian、错配其他官方主机与无效/不安全 URL 均返回 false
    expect(isRelayOrCustomProvider({ kind: 'volcengine-ark', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' })).toBe(false);
    expect(isRelayOrCustomProvider({ kind: 'bailian-compatible', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' })).toBe(false);
    expect(isRelayOrCustomProvider({ kind: 'anthropic', baseUrl: 'https://api.openai.com/v1' })).toBe(false);
    expect(isRelayOrCustomProvider({ kind: 'xai-grok', baseUrl: 'https://api.anthropic.com/v1' })).toBe(false);
    expect(isRelayOrCustomProvider({ kind: 'anthropic', baseUrl: '' })).toBe(false);
    expect(isRelayOrCustomProvider({ kind: 'anthropic', baseUrl: 'not-a-url' })).toBe(false);
    expect(isRelayOrCustomProvider({ kind: 'anthropic', baseUrl: 'http://relay.example.com/v1' })).toBe(false);
    expect(isRelayOrCustomProvider({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com:8443/v1' })).toBe(false);
    expect(isRelayOrCustomProvider({ kind: 'bailian-compatible', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1' })).toBe(false);
  });

  it('resolves protocol auth headers and filters disabled or dangerous custom headers', () => {
    expect(
      resolveProviderAuthHeaders({
        kind: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        apiKey: 'sk-ant-123',
        customHeaders: [
          { key: 'anthropic-beta', value: 'web-search-2025-03-05', enabled: true },
          { key: 'x-disabled', value: 'skip', enabled: false },
          { key: 'Host', value: 'evil.example' },
          { key: 'X-Bad-CRLF', value: 'ok\r\nInjected: 1' },
          { key: 'X-Forwarded-For', value: '127.0.0.1' },
        ],
      })
    ).toEqual({
      'x-api-key': 'sk-ant-123',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'web-search-2025-03-05',
    });

    expect(
      resolveProviderAuthHeaders({
        kind: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'AIza-test',
      })
    ).toEqual({
      'x-goog-api-key': 'AIza-test',
    });

    expect(
      resolveProviderAuthHeaders({
        kind: 'custom',
        baseUrl: 'https://relay.example.com/v1',
        apiKey: 'secret-ignored',
        authHeaderMode: 'custom',
        customHeaders: [{ key: 'X-Relay-Token', value: 'custom-secret' }],
      })
    ).toEqual({
      'X-Relay-Token': 'custom-secret',
    });
  });

  it('builds discovery requests without putting Gemini keys in URLs and normalizes multi-vendor payloads', () => {
    const anthropicReq = buildModelDiscoveryRequest({
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-key',
    });
    expect(anthropicReq).toEqual({
      protocol: 'anthropic',
      url: 'https://api.anthropic.com/v1/models',
      headers: {
        'x-api-key': 'sk-ant-key',
        'anthropic-version': '2023-06-01',
      },
    });

    const geminiReq = buildModelDiscoveryRequest({
      kind: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'AIza-secret',
    });
    expect(geminiReq.protocol).toBe('gemini');
    expect(geminiReq.url).toBe('https://generativelanguage.googleapis.com/v1beta/models');
    expect(geminiReq.url).not.toContain('AIza-secret');
    expect(geminiReq.headers['x-goog-api-key']).toBe('AIza-secret');

    const geminiParsed = parseDiscoveredModelsPayload(
      { kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
      {
        models: [
          {
            name: 'models/gemini-2.5-pro',
            displayName: 'Gemini 2.5 Pro',
            inputTokenLimit: 1048576,
            supportedGenerationMethods: ['generateContent'],
          },
        ],
      }
    );
    expect(geminiParsed).toHaveLength(1);
    expect(geminiParsed[0]).toMatchObject({
      id: 'gemini-2.5-pro',
      name: 'Gemini 2.5 Pro',
      token_limits: { context_window: 1048576 },
    });

    const anthropicParsed = parseDiscoveredModelsPayload(
      { kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' },
      {
        data: [{ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', type: 'model' }],
      }
    );
    expect(anthropicParsed).toHaveLength(1);
    expect(anthropicParsed[0]).toMatchObject({
      id: 'claude-sonnet-5-5',
      name: 'Claude Sonnet 5.5',
    });
  });
});
