import type {
  ChatCompletionResult,
  GenerationTaskInfo,
  ModelInfo,
  ProviderProfile,
} from '../../../domain/types';
import { createAnthropicProviderAdapter } from '../../../services/anthropicMessages';
import { createGeminiNativeProviderAdapter } from '../../../services/geminiNative';
import { createModelInfoFromId, inferModelTask } from '../../../services/modelCapabilities';
import {
  queryGenerationTask,
  sendOpenAiCompatibleChat,
} from '../../../services/openAiCompatible';
import {
  inspectProviderEndpoint,
  isExactOfficialAnthropicProvider,
  isExactOfficialGeminiProvider,
  isExactOfficialXaiProvider,
  isRelayOrCustomProvider,
} from '../../../services/providerSetup';
import {
  createXaiGrokProviderAdapter,
  isXaiMediaGenerationModel,
} from '../../../services/xaiGrok';

export type ProviderOperation = 'chat' | 'generation-task';

export type ChatProviderRequest = Parameters<typeof sendOpenAiCompatibleChat>[0];

export interface GenerationTaskProviderRequest {
  provider: ProviderProfile;
  task: GenerationTaskInfo;
  signal?: AbortSignal;
}

export interface ProviderTarget {
  provider: ProviderProfile;
  modelId: string;
  model?: ModelInfo;
}

export interface ProviderAdapter {
  run(request: ChatProviderRequest): Promise<ChatCompletionResult>;
  queryTask(request: GenerationTaskProviderRequest): Promise<ChatCompletionResult>;
}

export interface ProviderAdapterRegistry {
  resolve(target: ProviderTarget, operation: ProviderOperation): ProviderAdapter;
}

class OpenAiCompatibleProviderAdapter implements ProviderAdapter {
  run(request: ChatProviderRequest): Promise<ChatCompletionResult> {
    return sendOpenAiCompatibleChat(request);
  }

  queryTask(request: GenerationTaskProviderRequest): Promise<ChatCompletionResult> {
    return queryGenerationTask(request.provider, request.task, request.signal);
  }
}

/**
 * xAI Grok 注册表包装适配器：
 * 当仅开启客户端外部搜索（`externalSearch`）或传入 `mcp` 校验时，降级委托至
 * `openAiCompatible` 执行完整的 `search_web` 工具循环或 MCP 阻断校验；其余场景走原生 Grok 协议。
 */
class XaiGrokRegistryAdapter implements ProviderAdapter {
  constructor(
    private readonly primary: ProviderAdapter,
    private readonly openAiCompatible: ProviderAdapter
  ) {}

  run(request: ChatProviderRequest): Promise<ChatCompletionResult> {
    if ((request.externalSearch?.enabled && !request.webSearch?.enabled) || request.mcp) {
      return this.openAiCompatible.run(request);
    }
    return this.primary.run(request);
  }

  queryTask(request: GenerationTaskProviderRequest): Promise<ChatCompletionResult> {
    return this.primary.queryTask(request);
  }
}

/**
 * 检测用户是否显式填写了 Google Gemini 的 OpenAI 兼容端点路径（`/v1beta/openai` 或 `/openai`），
 * 避免被 `inspectProviderEndpoint` 自动规范化为 `/v1beta` 后误分流至原生 Gemini 协议。
 */
function isGeminiOpenAiCompatBaseUrl(rawBaseUrl: string): boolean {
  try {
    const url = new URL(rawBaseUrl.trim());
    const path = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '').toLowerCase();
    return (
      path === '/v1beta/openai' ||
      path.startsWith('/v1beta/openai/') ||
      path === '/openai' ||
      path.startsWith('/openai/')
    );
  } catch {
    return false;
  }
}

function assertProviderEndpointAllowed(provider: ProviderProfile): void {
  if (provider.kind === 'custom' || provider.kind === 'new-api-relay') {
    return;
  }
  const inspection = inspectProviderEndpoint(provider.baseUrl, { kind: provider.kind });
  if (isRelayOrCustomProvider(provider)) {
    return;
  }
  if (
    inspection.family === 'bailian-coding-plan' ||
    inspection.family === 'bailian-token-plan'
  ) {
    throw new Error(inspection.errors[0] || '该端点已被安全策略限制，无法使用。');
  }
  if (inspection.official && !inspection.kindCompatible) {
    const mismatchError = inspection.errors.find((msg) => msg.includes('类型与端点协议不一致'));
    throw new Error(
      mismatchError ??
        inspection.errors[0] ??
        '当前服务商类型与端点协议不一致，请修正服务商类型或 Base URL。'
    );
  }
  if (inspection.policy === 'blocked') {
    throw new Error(inspection.errors[0] || '该端点已被安全策略限制，无法使用。');
  }
}

function assertKindMatchesOfficialTarget(provider: ProviderProfile): void {
  const inspection = inspectProviderEndpoint(provider.baseUrl, { kind: provider.kind });
  if (inspection.official && !inspection.kindCompatible) {
    throw new Error(
      inspection.errors[0] ?? '当前服务商类型与端点协议不一致，请修正服务商类型或 Base URL。'
    );
  }
}

/**
 * 生产环境多协议适配器注册中心：
 * 按 `ProviderKind`、官方主机精确校验、Gemini OpenAI 兼容路径与模型任务类型，
 * 将请求精确分流至 Anthropic、Gemini、xAI Grok 原生适配器或 OpenAI 兼容总线。
 */
export class ProductionProviderAdapterRegistry implements ProviderAdapterRegistry {
  private readonly openAiCompatible = new OpenAiCompatibleProviderAdapter();
  private readonly anthropic = createAnthropicProviderAdapter();
  private readonly gemini = createGeminiNativeProviderAdapter();
  private readonly xaiGrok = new XaiGrokRegistryAdapter(
    createXaiGrokProviderAdapter(),
    this.openAiCompatible
  );

  resolve(target: ProviderTarget, operation: ProviderOperation): ProviderAdapter {
    if (!target.provider || !target.modelId) {
      throw new Error(
        operation === 'generation-task'
          ? '生成任务缺少服务商或模型信息。'
          : '请先选择可用的服务商和模型。'
      );
    }

    const provider = target.provider;
    assertProviderEndpointAllowed(provider);

    if (operation === 'generation-task') {
      return this.openAiCompatible;
    }

    const requestModel = target.model ?? createModelInfoFromId(provider, target.modelId, 'manual');
    const task = inferModelTask(requestModel);

    if (task !== 'chat') {
      // 官方 Gemini 原生生图模型走 Gemini 原生协议；其余非 chat 任务（含 xAI 媒体模型、OpenAI 生图、Ark 视频等）走兼容总线。
      if (
        provider.kind === 'gemini' &&
        task === 'image-generation' &&
        isExactOfficialGeminiProvider(provider) &&
        !isGeminiOpenAiCompatBaseUrl(provider.baseUrl)
      ) {
        return this.gemini;
      }
      return this.openAiCompatible;
    }

    if (provider.kind === 'anthropic') {
      if (isExactOfficialAnthropicProvider(provider)) {
        return this.anthropic;
      }
      if (isRelayOrCustomProvider(provider)) {
        return this.openAiCompatible;
      }
      assertKindMatchesOfficialTarget(provider);
      return this.anthropic;
    }

    if (provider.kind === 'gemini') {
      if (isExactOfficialGeminiProvider(provider)) {
        return isGeminiOpenAiCompatBaseUrl(provider.baseUrl)
          ? this.openAiCompatible
          : this.gemini;
      }
      if (isRelayOrCustomProvider(provider)) {
        return this.openAiCompatible;
      }
      assertKindMatchesOfficialTarget(provider);
      return this.gemini;
    }

    if (provider.kind === 'xai-grok') {
      if (isXaiMediaGenerationModel(target.modelId)) {
        return this.openAiCompatible;
      }
      if (isExactOfficialXaiProvider(provider)) {
        return this.xaiGrok;
      }
      if (isRelayOrCustomProvider(provider)) {
        return this.openAiCompatible;
      }
      assertKindMatchesOfficialTarget(provider);
      return this.xaiGrok;
    }

    return this.openAiCompatible;
  }
}

export function createProductionProviderAdapterRegistry(): ProviderAdapterRegistry {
  return new ProductionProviderAdapterRegistry();
}
