import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createE2EWorkspaceHarness,
  installMockFetchRouter,
  safeImportModule,
  type E2EImageGenerationOptions,
  type E2EProviderProfile,
} from '../helpers/e2eWorkspaceHarness';
import { createMockUpstreamServer, type MockUpstreamServer } from '../helpers/mockUpstreamServer';
import {
  buildGeminiGenerateContentJson,
  buildOpenAiImageGenerationJson,
  buildOpenAiResponsesSseChunks,
  buildXaiImageGenerationJson,
  TINY_PNG_BASE64,
} from '../helpers/sseFixtures';
import { setE2EPlatformOs } from '../helpers/vitestE2eSetup';
import type {
  ChatCompletionResult,
  ChatMessage,
  MediaAttachment,
  ProviderContinuationBlock,
} from '../../../src/domain/types';
import { defaultProviders } from '../../../src/data/providerCatalog';
import { cleanupOrphanedMediaStorage } from '../../../src/services/mediaStorage';

/**
 * F5：全协议文生图、图生图与参数约束 E2E 测试（Tiers 1–2）
 *
 * 约定契约（M3 统一生图服务 `src/services/imageGeneration.ts`）：
 * - `resolveImageApiMode(provider, modelId?)`:
 *     返回 `'openai-images' | 'openai-responses' | 'gemini-generate-content' | 'xai-json' | 'unsupported'`
 * - `generateImages(args: UnifiedImageGenerationRequest)`:
 *     接收 `{ provider, modelId, prompt, options?, continuationBlocks?, messages?, signal? }`
 *     返回 `Promise<ChatCompletionResult>`（含 `attachments`, `content`, `providerContinuations?`, `usage?`）
 */
interface ImageGenerationServiceContract {
  resolveImageApiMode: (
    provider: E2EProviderProfile,
    modelId?: string
  ) =>
    | 'openai-images'
    | 'openai-responses'
    | 'gemini-generate-content'
    | 'xai-json'
    | 'unsupported';
  generateImages: (args: {
    provider: E2EProviderProfile;
    modelId: string;
    prompt: string;
    options?: E2EImageGenerationOptions;
    continuationBlocks?: ProviderContinuationBlock[];
    messages?: ChatMessage[];
    signal?: AbortSignal;
  }) => Promise<ChatCompletionResult>;
}

function getDefaultProvider(id: string): E2EProviderProfile {
  const found = defaultProviders.find((item) => item.id === id);
  if (!found) {
    throw new Error(`未在 defaultProviders 中找到服务商预设：${id}`);
  }
  return {
    ...found,
    apiKey: `sk-e2e-${id}`,
    models: [...found.models],
    capabilities: [...found.capabilities],
  } as E2EProviderProfile;
}

function createSamplePngAttachment(id = 'ref-img-1', name = 'input.png'): MediaAttachment {
  return {
    id,
    kind: 'image',
    uri: `data:image/png;base64,${TINY_PNG_BASE64}`,
    name,
    mimeType: 'image/png',
    base64: TINY_PNG_BASE64,
    width: 1,
    height: 1,
  };
}

/**
 * Node E2E 测试环境缺少浏览器原生 `FileReader`，
 * 为 `mediaStorage.materializeAttachment`（`blobToBase64`）提供最小兼容桩。
 */
class TestFileReader {
  result: string | ArrayBuffer | null = null;
  error: Error | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  readAsDataURL(blob: Blob): void {
    void blob.arrayBuffer().then(
      (buffer) => {
        const mimeType = blob.type.split(';', 1)[0]?.trim() || 'application/octet-stream';
        this.result = `data:${mimeType};base64,${Buffer.from(buffer).toString('base64')}`;
        this.onload?.();
      },
      (error: unknown) => {
        this.error = error instanceof Error ? error : new Error(String(error));
        this.onerror?.();
      }
    );
  }
}

describe('F5 全协议生图、图生图与参考图/参数约束 E2E', () => {
  const activeServers: MockUpstreamServer[] = [];
  const restoreCallbacks: Array<() => void> = [];

  beforeEach(() => {
    if (typeof globalThis.FileReader === 'undefined') {
      const hadOwnFileReader = Object.prototype.hasOwnProperty.call(globalThis, 'FileReader');
      const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'FileReader');
      Reflect.set(globalThis, 'FileReader', TestFileReader);
      restoreCallbacks.push(() => {
        if (hadOwnFileReader && originalDescriptor) {
          Object.defineProperty(globalThis, 'FileReader', originalDescriptor);
        } else {
          Reflect.deleteProperty(globalThis, 'FileReader');
        }
      });
    }
  });

  afterEach(async () => {
    while (restoreCallbacks.length > 0) {
      const restore = restoreCallbacks.pop();
      restore?.();
    }
    while (activeServers.length > 0) {
      const server = activeServers.pop();
      await server?.close();
    }
    // 清理测试写入 fake-indexeddb 的临时图片附件，避免跨用例污染
    setE2EPlatformOs('web');
    try {
      await cleanupOrphanedMediaStorage([]);
    } finally {
      setE2EPlatformOs('android');
    }
  });

  async function setupMockInfra(extraHosts: string[] = []): Promise<MockUpstreamServer> {
    const server = createMockUpstreamServer();
    activeServers.push(server);
    const { baseUrl } = await server.start();
    const baseFetch = globalThis.fetch;
    const router = installMockFetchRouter(baseUrl, {
      enableWebDevProxy: true,
      targetHosts: [
        'api.openai.com',
        'api.anthropic.com',
        'generativelanguage.googleapis.com',
        'api.x.ai',
        'api.deepseek.com',
        'ark.cn-beijing.volces.com',
        'dashscope.aliyuncs.com',
        'your-relay.example.com',
        ...extraHosts,
      ],
    });
    const routedFetch = globalThis.fetch;
    const wrappedFetch: typeof fetch = (input, init) => {
      const rawUrl =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const normalizedUrl = rawUrl.trimStart().toLowerCase();
      // 放行 Web 端 mediaStorage 解码本地附件用的 data:/blob: 内联 URI，其余请求继续走 Network Guard
      if (normalizedUrl.startsWith('data:') || normalizedUrl.startsWith('blob:')) {
        return baseFetch(input, init);
      }
      return routedFetch(input, init);
    };
    globalThis.fetch = wrappedFetch;

    restoreCallbacks.push(() => {
      if (globalThis.fetch === wrappedFetch) {
        globalThis.fetch = routedFetch;
      }
      router.restore();
    });
    return server;
  }

  describe('Tier 1：核心正向生图与改图协议链路', () => {
    it('[F5-T1-01] OpenAI /v1/images/generations 文生图透传 aspectRatio/quality/count 并持久化多张附件', async () => {
      setE2EPlatformOs('web');
      const server = await setupMockInfra();
      const harness = await createE2EWorkspaceHarness();
      restoreCallbacks.push(() => harness.dispose());

      server.on(
        { method: 'POST', pathname: '/v1/images/generations' },
        {
          kind: 'json',
          body: buildOpenAiImageGenerationJson({
            count: 2,
            revisedPrompt: 'Sunset over neon mountains',
          }),
        }
      );

      const imageGenService = await safeImportModule<ImageGenerationServiceContract>(
        'src/services/imageGeneration.ts',
        ['generateImages', 'resolveImageApiMode']
      );

      const openai = getDefaultProvider('openai');
      const options: E2EImageGenerationOptions = {
        aspectRatio: '16:9',
        quality: 'high',
        resolution: '2k',
        count: 2,
      };

      const result = await imageGenService.generateImages({
        provider: openai,
        modelId: 'gpt-image-2.5-sunburst',
        prompt: '日落下的赛博朋克雪山',
        options,
      });

      const recorded = server.getLastRequest({ pathname: '/v1/images/generations' });
      expect(recorded).toBeDefined();
      expect(recorded?.headers.authorization).toBe(`Bearer ${openai.apiKey}`);

      const body = recorded?.jsonBody as Record<string, unknown>;
      expect(body.model).toBe('gpt-image-2.5-sunburst');
      expect(body.prompt).toContain('赛博朋克雪山');
      expect(body.n).toBe(2);
      expect(body.quality).toBe('high');
      expect(typeof body.size).toBe('string');
      expect(String(body.size)).toMatch(/^\d+x\d+$/);
      const [widthPx, heightPx] = String(body.size).split('x').map(Number);
      expect(widthPx).toBeGreaterThan(heightPx);
      expect(widthPx).toBeGreaterThanOrEqual(1024);
      expect(heightPx).toBeGreaterThanOrEqual(512);

      expect(result.attachments?.length).toBe(2);
      for (const attachment of result.attachments ?? []) {
        expect(attachment.kind).toBe('image');
        expect(attachment.uri).toMatch(/^embezzle-web-attachment:\/\//);
      }

      // 将生成的持久化图片附件写入工作区会话并 flush，验证持久化快照无裸 Base64 残留
      const convId = harness.session.getSnapshot().activeConversationId;
      await harness.chatRuntime.execute({
        type: 'chat.append-messages',
        conversationId: convId,
        messages: [
          {
            id: harness.ids.createId('msg'),
            role: 'assistant',
            content: result.content || '已生成 2 张图片。',
            createdAt: harness.clock.now(),
            status: 'ready',
            attachments: result.attachments,
          },
        ],
        now: harness.clock.now(),
      });
      await harness.flush();

      const stored = harness.persistence.getStoredSnapshot();
      const persistedConv = stored?.conversations.find((item) => item.id === convId);
      const lastMsg = persistedConv?.messages[persistedConv.messages.length - 1];
      expect(lastMsg?.attachments?.length).toBe(2);
      for (const att of lastMsg?.attachments ?? []) {
        expect(att.uri).toMatch(/^embezzle-web-attachment:\/\//);
        expect(att.base64 ?? null).toBeNull();
      }
    });

    it('[F5-T1-02] OpenAI 图生图使用 multipart/form-data 请求 /v1/images/edits 且无损上传参考图二进制', async () => {
      setE2EPlatformOs('web');
      const server = await setupMockInfra();

      server.on(
        { method: 'POST', pathname: '/v1/images/edits' },
        {
          kind: 'json',
          body: buildOpenAiImageGenerationJson({
            revisedPrompt: 'Starry night background edit',
          }),
        }
      );

      const imageGenService = await safeImportModule<ImageGenerationServiceContract>(
        'src/services/imageGeneration.ts',
        ['generateImages']
      );

      const openai = getDefaultProvider('openai');
      const refImage = createSamplePngAttachment('ref-openai-edit', 'sketch.png');
      const expectedBytes = Buffer.from(TINY_PNG_BASE64, 'base64');

      const result = await imageGenService.generateImages({
        provider: openai,
        modelId: 'gpt-image-2.5-flare',
        prompt: '把背景改为璀璨星空',
        options: {
          aspectRatio: '1:1',
          quality: 'medium',
          referenceImages: [refImage],
        },
      });

      const recorded = server.getLastRequest({ pathname: '/v1/images/edits' });
      expect(recorded).toBeDefined();
      expect(recorded?.headers['content-type']).toContain('multipart/form-data');
      expect(recorded?.multipartParts?.length).toBeGreaterThanOrEqual(3);

      const modelPart = recorded?.multipartParts?.find((part) => part.name === 'model');
      const promptPart = recorded?.multipartParts?.find((part) => part.name === 'prompt');
      const imagePart = recorded?.multipartParts?.find(
        (part) => part.name === 'image' || part.name === 'image[]'
      );

      expect(modelPart?.text).toBe('gpt-image-2.5-flare');
      expect(promptPart?.text).toContain('璀璨星空');
      expect(imagePart).toBeDefined();
      expect(imagePart?.data.equals(expectedBytes)).toBe(true);
      expect(result.attachments?.length).toBe(1);
    });

    it('[F5-T1-03] OpenAI Responses 内置 image_generation 工具生图正确解析 b64Result', async () => {
      setE2EPlatformOs('web');
      const server = await setupMockInfra();

      server.on(
        { method: 'POST', pathname: '/v1/responses' },
        {
          kind: 'sse',
          chunks: buildOpenAiResponsesSseChunks({
            model: 'gpt-5.4',
            textDeltas: ['已通过 Responses 工具完成绘图。'],
            imageGenerationCall: {
              id: 'img_call_e2e_1',
              b64Result: TINY_PNG_BASE64,
              revisedPrompt: 'Minimalist studio emblem',
            },
          }),
        }
      );

      const imageGenService = await safeImportModule<ImageGenerationServiceContract>(
        'src/services/imageGeneration.ts',
        ['generateImages', 'resolveImageApiMode']
      );

      const openaiResponsesProvider: E2EProviderProfile = {
        ...getDefaultProvider('openai'),
        imageApiMode: 'openai-responses',
      };
      expect(imageGenService.resolveImageApiMode(openaiResponsesProvider, 'gpt-5.4')).toBe(
        'openai-responses'
      );

      const result = await imageGenService.generateImages({
        provider: openaiResponsesProvider,
        modelId: 'gpt-5.4',
        prompt: '绘制极简工作室徽标',
        options: { aspectRatio: '1:1', quality: 'high' },
      });

      const recorded = server.getLastRequest({ pathname: '/v1/responses' });
      expect(recorded).toBeDefined();
      const body = recorded?.jsonBody as {
        model?: string;
        input?: unknown;
        stream?: unknown;
        tools?: Array<{ type?: string }>;
      };
      expect(body.model).toBe('gpt-5.4');
      expect(body.stream).toBe(true);
      expect(body.input).toBeDefined();
      expect(JSON.stringify(body.input)).toContain('绘制极简工作室徽标');
      expect(body.tools?.some((tool) => tool.type === 'image_generation')).toBe(true);

      expect(result.attachments?.length).toBe(1);
      expect(result.attachments?.[0]?.kind).toBe('image');
      expect(result.attachments?.[0]?.uri).toMatch(/^embezzle-web-attachment:\/\//);
      expect(result.content).toContain('已通过 Responses 工具完成绘图');
      const serializedOutputMeta = `${result.content}\n${JSON.stringify(result.raw ?? {})}\n${JSON.stringify(result.attachments ?? [])}`;
      expect(serializedOutputMeta).toContain('Minimalist studio emblem');
    });

    it('[F5-T1-04] Gemini 原生 generateContent 文生图与携带 thoughtSignature 多轮改图', async () => {
      setE2EPlatformOs('web');
      const server = await setupMockInfra();

      server.enqueue(
        { method: 'POST', pathname: '/v1beta/models/gemini-3.1-flash-image:generateContent' },
        {
          kind: 'json',
          body: buildGeminiGenerateContentJson({
            modelVersion: 'gemini-3.1-flash-image',
            textDeltas: ['已生成初始构图。'],
            inlineImages: [
              {
                mimeType: 'image/png',
                data: TINY_PNG_BASE64,
                thoughtSignature: 'gem_thought_sig_round1',
              },
            ],
          }),
        }
      );

      server.enqueue(
        { method: 'POST', pathname: '/v1beta/models/gemini-3.1-flash-image:generateContent' },
        {
          kind: 'json',
          body: buildGeminiGenerateContentJson({
            modelVersion: 'gemini-3.1-flash-image',
            textDeltas: ['已完成多轮修改。'],
            inlineImages: [
              {
                mimeType: 'image/png',
                data: TINY_PNG_BASE64,
                thoughtSignature: 'gem_thought_sig_round2',
              },
            ],
          }),
        }
      );

      const imageGenService = await safeImportModule<ImageGenerationServiceContract>(
        'src/services/imageGeneration.ts',
        ['generateImages', 'resolveImageApiMode']
      );

      const gemini = getDefaultProvider('gemini');
      expect(imageGenService.resolveImageApiMode(gemini, 'gemini-3.1-flash-image')).toBe(
        'gemini-generate-content'
      );

      // 第一轮：文生图
      const round1 = await imageGenService.generateImages({
        provider: gemini,
        modelId: 'gemini-3.1-flash-image',
        prompt: '画一只戴宇航员头盔的橘猫',
        options: { aspectRatio: '16:9', resolution: '2k' },
      });

      const req1 = server.getRequests({
        pathname: '/v1beta/models/gemini-3.1-flash-image:generateContent',
      })[0];
      expect(req1?.headers['x-goog-api-key']).toBe(gemini.apiKey);
      const body1 = req1?.jsonBody as {
        generationConfig?: {
          responseModalities?: string[];
          imageConfig?: { aspectRatio?: string };
        };
      };
      expect(body1.generationConfig?.responseModalities).toContain('IMAGE');
      expect(body1.generationConfig?.imageConfig?.aspectRatio).toBe('16:9');
      expect(round1.attachments?.length).toBe(1);
      expect(
        round1.providerContinuations?.some(
          (block) =>
            block.provider === 'gemini' &&
            block.type === 'thought_signature' &&
            block.thoughtSignature === 'gem_thought_sig_round1'
        )
      ).toBe(true);

      // 第二轮：携带参考图与 thoughtSignature 多轮改图
      const round2 = await imageGenService.generateImages({
        provider: gemini,
        modelId: 'gemini-3.1-flash-image',
        prompt: '给头盔加上金色反光面罩',
        options: {
          aspectRatio: '16:9',
          referenceImages: round1.attachments,
        },
        continuationBlocks: round1.providerContinuations,
      });

      const reqs = server.getRequests({
        pathname: '/v1beta/models/gemini-3.1-flash-image:generateContent',
      });
      expect(reqs.length).toBe(2);
      const req2RawText = JSON.stringify(reqs[1]?.jsonBody ?? {});
      expect(req2RawText).toContain('gem_thought_sig_round1');
      expect(req2RawText).toContain('inlineData');
      expect(round2.attachments?.length).toBe(1);
    });

    it('[F5-T1-05] xAI grok-imagine-image-2.0 文生图与 JSON /v1/images/edits 改图', async () => {
      setE2EPlatformOs('web');
      const server = await setupMockInfra();

      server.on(
        { method: 'POST', pathname: '/v1/images/generations' },
        {
          kind: 'json',
          body: buildXaiImageGenerationJson({ revisedPrompt: 'Grok generated landscape' }),
        }
      );
      server.on(
        { method: 'POST', pathname: '/v1/images/edits' },
        {
          kind: 'json',
          body: buildXaiImageGenerationJson({ revisedPrompt: 'Grok edited landscape' }),
        }
      );

      const imageGenService = await safeImportModule<ImageGenerationServiceContract>(
        'src/services/imageGeneration.ts',
        ['generateImages', 'resolveImageApiMode']
      );

      const xai = getDefaultProvider('xai-grok');
      expect(imageGenService.resolveImageApiMode(xai, 'grok-imagine-image-2.0')).toBe('xai-json');

      const genResult = await imageGenService.generateImages({
        provider: xai,
        modelId: 'grok-imagine-image-2.0',
        prompt: '赛博霓虹雨夜街道',
        options: { aspectRatio: '3:2' },
      });
      expect(genResult.attachments?.length).toBe(1);
      expect(genResult.attachments?.[0]?.uri).toMatch(/^embezzle-web-attachment:\/\//);

      const genReq = server.getLastRequest({ pathname: '/v1/images/generations' });
      expect(genReq).toBeDefined();
      expect(genReq?.headers.authorization).toBe(`Bearer ${xai.apiKey}`);
      const genBody = genReq?.jsonBody as Record<string, unknown> | undefined;
      expect(genBody?.model).toBe('grok-imagine-image-2.0');
      expect(String(genBody?.prompt ?? '')).toContain('赛博霓虹雨夜街道');

      const editResult = await imageGenService.generateImages({
        provider: xai,
        modelId: 'grok-imagine-image-2.0',
        prompt: '将雨水替换为飘雪',
        options: {
          aspectRatio: '3:2',
          referenceImages: [createSamplePngAttachment('xai-ref-1', 'street.png')],
        },
      });

      const editReq = server.getLastRequest({ pathname: '/v1/images/edits' });
      expect(editReq).toBeDefined();
      expect(editReq?.headers.authorization).toBe(`Bearer ${xai.apiKey}`);
      expect(editReq?.headers['content-type']).toContain('application/json');
      expect(editReq?.multipartParts).toBeUndefined();

      const editBody = editReq?.jsonBody as Record<string, unknown> | undefined;
      expect(editBody).toBeDefined();
      expect(editBody?.model).toBe('grok-imagine-image-2.0');
      expect(typeof editBody?.prompt).toBe('string');
      expect(String(editBody?.prompt)).toContain('飘雪');
      // 显式校验 image（字符串或 { url }）或 images 字段承载参考图数据，防止塞入无关字段
      const explicitImageField = editBody?.image ?? editBody?.images;
      expect(explicitImageField).toBeDefined();
      expect(JSON.stringify(explicitImageField)).toContain(TINY_PNG_BASE64);
      expect(editResult.attachments?.length).toBe(1);
      expect(editResult.attachments?.[0]?.uri).toMatch(/^embezzle-web-attachment:\/\//);
    });

    it('[F5-T1-06] 火山方舟（Ark）与阿里百炼（Bailian）兼容生图经统一生图服务路由正常落盘', async () => {
      setE2EPlatformOs('web');
      const server = await setupMockInfra();

      server.on(
        { method: 'POST', pathname: '/api/v3/images/generations' },
        {
          kind: 'json',
          body: buildOpenAiImageGenerationJson({ revisedPrompt: 'Ark Seedream image' }),
        }
      );
      server.on(
        { method: 'POST', pathname: '/compatible-mode/v1/images/generations' },
        {
          kind: 'json',
          body: buildOpenAiImageGenerationJson({ revisedPrompt: 'Bailian Qwen image' }),
        }
      );

      const imageGenService = await safeImportModule<ImageGenerationServiceContract>(
        'src/services/imageGeneration.ts',
        ['generateImages', 'resolveImageApiMode']
      );

      const ark = getDefaultProvider('volcengine-ark');
      expect(imageGenService.resolveImageApiMode(ark, 'doubao-seedream-4-5')).toBe(
        'openai-images'
      );

      const arkResult = await imageGenService.generateImages({
        provider: ark,
        modelId: 'doubao-seedream-4-5',
        prompt: '水墨山水画',
        options: { aspectRatio: '4:3' },
      });
      expect(arkResult.attachments?.length).toBe(1);
      expect(arkResult.attachments?.[0]?.uri).toMatch(/^embezzle-web-attachment:\/\//);
      const arkReq = server.getLastRequest({ pathname: '/api/v3/images/generations' });
      expect(arkReq).toBeDefined();
      expect(arkReq?.headers.authorization).toBe(`Bearer ${ark.apiKey}`);
      const arkBody = arkReq?.jsonBody as Record<string, unknown> | undefined;
      expect(arkBody?.model).toBe('doubao-seedream-4-5');
      expect(typeof arkBody?.prompt).toBe('string');
      expect(String(arkBody?.prompt)).toContain('水墨山水画');

      const bailian = getDefaultProvider('bailian-compatible');
      expect(imageGenService.resolveImageApiMode(bailian, 'qwen-image-plus')).toBe(
        'openai-images'
      );

      const bailianResult = await imageGenService.generateImages({
        provider: bailian,
        modelId: 'qwen-image-plus',
        prompt: '江南烟雨古镇',
        options: { aspectRatio: '1:1' },
      });
      expect(bailianResult.attachments?.length).toBe(1);
      expect(bailianResult.attachments?.[0]?.uri).toMatch(/^embezzle-web-attachment:\/\//);
      const bailianReq = server.getLastRequest({
        pathname: '/compatible-mode/v1/images/generations',
      });
      expect(bailianReq).toBeDefined();
      expect(bailianReq?.headers.authorization).toBe(`Bearer ${bailian.apiKey}`);
      const bailianBody = bailianReq?.jsonBody as Record<string, unknown> | undefined;
      expect(bailianBody?.model).toBe('qwen-image-plus');
      expect(typeof bailianBody?.prompt).toBe('string');
      expect(String(bailianBody?.prompt)).toContain('江南烟雨古镇');
    });
  });

  describe('Tier 2：参数校验、错误边界与降级处理', () => {
    it('[F5-T2-01] Anthropic Claude 与 DeepSeek（imageApiMode: unsupported）零外发拦截并给出明确切换引导', async () => {
      const server = await setupMockInfra();
      const imageGenService = await safeImportModule<ImageGenerationServiceContract>(
        'src/services/imageGeneration.ts',
        ['generateImages', 'resolveImageApiMode']
      );

      const anthropic = getDefaultProvider('anthropic');
      const deepseek = getDefaultProvider('deepseek');

      expect(imageGenService.resolveImageApiMode(anthropic, 'claude-sonnet-5-5')).toBe(
        'unsupported'
      );
      expect(imageGenService.resolveImageApiMode(deepseek, 'deepseek-v4-pro')).toBe(
        'unsupported'
      );

      let anthropicError: unknown;
      try {
        await imageGenService.generateImages({
          provider: anthropic,
          modelId: 'claude-sonnet-5-5',
          prompt: '画一只猫',
        });
      } catch (error) {
        anthropicError = error;
      }
      expect(anthropicError).toBeInstanceOf(Error);
      const anthropicMessage = (anthropicError as Error).message;
      expect(anthropicMessage).toMatch(/不支持.*生图/);
      expect(anthropicMessage).toMatch(/(?:切换|改用|选择).*(?:OpenAI|Gemini|xAI)/i);

      let deepseekError: unknown;
      try {
        await imageGenService.generateImages({
          provider: deepseek,
          modelId: 'deepseek-v4-pro',
          prompt: '画一座桥',
        });
      } catch (error) {
        deepseekError = error;
      }
      expect(deepseekError).toBeInstanceOf(Error);
      const deepseekMessage = (deepseekError as Error).message;
      expect(deepseekMessage).toMatch(/不支持.*生图/);
      expect(deepseekMessage).toMatch(/(?:切换|改用|选择).*(?:OpenAI|Gemini|xAI)/i);

      // 确保零网络请求外发
      expect(server.getRequests().length).toBe(0);
    });

    it('[F5-T2-02] 参考图数量超限与非法 MIME 类型前置拦截（零网络请求）', async () => {
      const server = await setupMockInfra();
      const imageGenService = await safeImportModule<ImageGenerationServiceContract>(
        'src/services/imageGeneration.ts',
        ['generateImages']
      );

      const openai = getDefaultProvider('openai');
      const tooManyImages = Array.from({ length: 12 }, (_, idx) =>
        createSamplePngAttachment(`ref-overflow-${idx}`, `img-${idx}.png`)
      );

      await expect(
        imageGenService.generateImages({
          provider: openai,
          modelId: 'gpt-image-2.5-sunburst',
          prompt: '合并这些图片',
          options: { referenceImages: tooManyImages },
        })
      ).rejects.toThrow(/参考图|图片.*(?:上限|最多|超过)/);

      const invalidMimeAttachment: MediaAttachment = {
        id: 'bad-mime-1',
        kind: 'file',
        uri: 'data:application/pdf;base64,JVBERi0xLjQK',
        name: 'spec.pdf',
        mimeType: 'application/pdf',
      };

      await expect(
        imageGenService.generateImages({
          provider: openai,
          modelId: 'gpt-image-2.5-sunburst',
          prompt: '编辑该文件',
          options: { referenceImages: [invalidMimeAttachment] },
        })
      ).rejects.toThrow(/图片|格式|MIME|参考图/);

      expect(server.getRequests().length).toBe(0);
    });

    it('[F5-T2-03] 空提示词与越界 count（<=0 或超大）安全校验不发起畸形请求', async () => {
      const server = await setupMockInfra();
      const imageGenService = await safeImportModule<ImageGenerationServiceContract>(
        'src/services/imageGeneration.ts',
        ['generateImages']
      );

      const openai = getDefaultProvider('openai');

      await expect(
        imageGenService.generateImages({
          provider: openai,
          modelId: 'gpt-image-2.5-sunburst',
          prompt: '   \n\t  ',
        })
      ).rejects.toThrow(/提示词|prompt/i);

      await expect(
        imageGenService.generateImages({
          provider: openai,
          modelId: 'gpt-image-2.5-sunburst',
          prompt: '生成壁纸',
          options: { count: 99 },
        })
      ).rejects.toThrow(/数量|count|上限|最多/i);

      expect(server.getRequests().length).toBe(0);
    });

    it('[F5-T2-04] 上游 HTTP 400 内容安全拒绝与 429 限流/空图片数组清晰反馈错误', async () => {
      const server = await setupMockInfra();
      const imageGenService = await safeImportModule<ImageGenerationServiceContract>(
        'src/services/imageGeneration.ts',
        ['generateImages']
      );

      const openai = getDefaultProvider('openai');

      server.enqueue(
        { method: 'POST', pathname: '/v1/images/generations' },
        {
          kind: 'error',
          status: 400,
          body: {
            error: {
              code: 'content_policy_violation',
              message: 'Your request was rejected as a result of our safety system.',
            },
          },
        }
      );

      await expect(
        imageGenService.generateImages({
          provider: openai,
          modelId: 'gpt-image-2.5-sunburst',
          prompt: '触发安全策略的测试提示',
        })
      ).rejects.toThrow(/400|safety|content_policy|失败/i);

      server.enqueue(
        { method: 'POST', pathname: '/v1/images/generations' },
        {
          kind: 'error',
          status: 429,
          headers: { 'Retry-After': '10' },
          body: { error: { message: 'Rate limit exceeded' } },
        }
      );

      await expect(
        imageGenService.generateImages({
          provider: openai,
          modelId: 'gpt-image-2.5-sunburst',
          prompt: '正常绘图',
        })
      ).rejects.toThrow(/429|Rate limit|失败/i);

      server.enqueue(
        { method: 'POST', pathname: '/v1/images/generations' },
        {
          kind: 'json',
          status: 200,
          body: { created: 1764000000, data: [] },
        }
      );

      await expect(
        imageGenService.generateImages({
          provider: openai,
          modelId: 'gpt-image-2.5-sunburst',
          prompt: '返回空图片数组边界测试',
        })
      ).rejects.toThrow(/未返回|空|没有生成|image|图片/i);
    });

    it('[F5-T2-05] 中转站（new-api-relay）auto 模式降级兼容路径并正确透传启用中的 customHeaders', async () => {
      setE2EPlatformOs('web');
      const server = await setupMockInfra();

      server.on(
        { method: 'POST', pathname: '/v1/images/generations' },
        {
          kind: 'json',
          body: buildOpenAiImageGenerationJson({ revisedPrompt: 'Relay image' }),
        }
      );

      const imageGenService = await safeImportModule<ImageGenerationServiceContract>(
        'src/services/imageGeneration.ts',
        ['generateImages', 'resolveImageApiMode']
      );

      const relay: E2EProviderProfile = {
        ...getDefaultProvider('new-api-relay'),
        imageApiMode: 'auto',
        customHeaders: [
          { key: 'X-Relay-Tenant', value: 'studio-e2e', enabled: true },
          { key: 'X-Relay-Disabled', value: 'should-not-send', enabled: false },
        ],
      };

      expect(imageGenService.resolveImageApiMode(relay, 'gemini-3.1-flash-image')).toBe(
        'openai-images'
      );

      const result = await imageGenService.generateImages({
        provider: relay,
        modelId: 'gemini-3.1-flash-image',
        prompt: '通过中转站生成像素风城堡',
      });

      const recorded = server.getLastRequest({ pathname: '/v1/images/generations' });
      expect(recorded).toBeDefined();
      expect(recorded?.headers['x-relay-tenant']).toBe('studio-e2e');
      expect(recorded?.headers['x-relay-disabled']).toBeUndefined();
      expect(result.attachments?.length).toBe(1);
    });

    it('[F5-T2-06] 远程 URL 图片下载 404 优雅降级告警与 AbortSignal 中断取消清理', async () => {
      setE2EPlatformOs('web');
      const server = await setupMockInfra();

      server.enqueue(
        { method: 'POST', pathname: '/v1/images/generations' },
        {
          kind: 'json',
          body: buildOpenAiImageGenerationJson({
            url: 'https://api.openai.com/files/expired-temp-image.png',
          }),
        }
      );
      server.enqueue(
        { method: 'GET', pathname: '/files/expired-temp-image.png' },
        {
          kind: 'error',
          status: 404,
          body: { error: { message: 'Not Found' } },
        }
      );

      const imageGenService = await safeImportModule<ImageGenerationServiceContract>(
        'src/services/imageGeneration.ts',
        ['generateImages']
      );

      const openai = getDefaultProvider('openai');
      const fallbackResult = await imageGenService.generateImages({
        provider: openai,
        modelId: 'dall-e-3',
        prompt: '返回远程过期 URL 的图像',
      });

      expect(fallbackResult.attachments?.length).toBe(1);
      expect(fallbackResult.attachments?.[0]?.uri).toContain('expired-temp-image.png');
      expect(fallbackResult.content).toMatch(/未能复制|导出|失效/);

      // AbortSignal 中断取消边界
      const controller = new AbortController();
      controller.abort();

      await expect(
        imageGenService.generateImages({
          provider: openai,
          modelId: 'gpt-image-2.5-sunburst',
          prompt: '将被立即中止的生图请求',
          signal: controller.signal,
        })
      ).rejects.toThrow(/abort|取消/i);
    });
  });
});
