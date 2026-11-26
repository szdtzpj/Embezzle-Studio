import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { promisify } from 'node:util';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  createE2EWorkspaceHarness,
  installMockFetchRouter,
  safeImportModule,
} from './e2eWorkspaceHarness';
import { createMockUpstreamServer, type MockUpstreamServer } from './mockUpstreamServer';
import {
  buildAnthropicMessagesSseChunks,
  buildBochaSearchJson,
  buildDeepSeekChatSseChunks,
  buildDeepSeekToolsSearchJson,
  buildExaSearchJson,
  buildGeminiGenerateContentJson,
  buildGeminiStreamSseChunks,
  buildOpenAiImageGenerationJson,
  buildOpenAiResponsesJson,
  buildOpenAiResponsesSseChunks,
  buildSearxngSearchJson,
  buildXaiDeprecatedSearchParameters410Response,
  buildXaiImageGenerationJson,
  buildXaiResponsesSseChunks,
  generateHighFrequencyTextDeltas,
  TINY_PNG_BASE64,
} from './sseFixtures';
import { createStaticDistServer, type StaticDistServer } from './staticDistServer';
import {
  buildInjectedWebProbesScript,
  CORE_WEB_INTERACTIVE_TARGETS,
} from './webGeometryProbes';

const execFileAsync = promisify(execFile);
const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..', '..', '..');
const RUN_E2E_SCRIPT = path.join(REPO_ROOT, 'scripts', 'run-e2e.mjs');

/**
 * 使用原生 node:http 发原始路径请求（避免 WHATWG fetch 自动折叠 `..` 分段，真实测试服务器目录穿越防御）。
 */
function rawHttpGet(
  port: number,
  rawPath: string,
  method = 'GET'
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: rawPath,
        method,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer | string) => {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('E2E-M1 基础设施端到端冒烟验证', () => {
  const activeServers: Array<MockUpstreamServer | StaticDistServer> = [];
  const restoreCallbacks: Array<() => void> = [];

  afterEach(async () => {
    while (restoreCallbacks.length > 0) {
      const restore = restoreCallbacks.pop();
      restore?.();
    }
    while (activeServers.length > 0) {
      const server = activeServers.pop();
      await server?.close();
    }
  });

  describe('mockUpstreamServer', () => {
    it('支持逐 chunk 延时 SSE、无 [DONE] 结束与全量请求/JSON/Query/Headers 审计记录', async () => {
      const server = createMockUpstreamServer();
      activeServers.push(server);
      const { baseUrl } = await server.start();

      const anthropicChunks = buildAnthropicMessagesSseChunks({
        thinkingBlocks: [{ thinking: '先思考关键边界', signature: 'sig_abc_123' }],
        textDeltas: ['你好，', '世界！'],
      });

      server.on(
        { method: 'POST', pathname: '/v1/messages' },
        {
          kind: 'sse',
          chunkDelayMs: 5,
          chunks: anthropicChunks,
        }
      );

      const res = await fetch(`${baseUrl}/v1/messages?beta=true`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': 'sk-ant-test',
          'Anthropic-Version': '2023-06-01',
        },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', stream: true }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const streamText = await res.text();
      expect(streamText).toContain('event: message_start');
      expect(streamText).toContain('thinking_delta');
      expect(streamText).toContain('signature_delta');
      expect(streamText).toContain('event: message_stop');
      expect(streamText).not.toContain('[DONE]');

      const recorded = server.getLastRequest({ pathname: '/v1/messages' });
      expect(recorded).toBeDefined();
      expect(recorded?.method).toBe('POST');
      expect(recorded?.query).toEqual({ beta: 'true' });
      expect(recorded?.headers['x-api-key']).toBe('sk-ant-test');
      expect(recorded?.headers['anthropic-version']).toBe('2023-06-01');
      expect(recorded?.jsonBody).toEqual({ model: 'claude-sonnet-4-6', stream: true });
    });

    it('支持 multipart/form-data 二进制文件与表单字段解析', async () => {
      const server = createMockUpstreamServer();
      activeServers.push(server);
      const { baseUrl } = await server.start();

      server.on(
        { method: 'POST', pathname: '/v1/images/edits' },
        {
          kind: 'json',
          body: buildOpenAiImageGenerationJson({ revisedPrompt: 'edited' }),
        }
      );

      const pngBytes = Buffer.from(TINY_PNG_BASE64, 'base64');
      const form = new FormData();
      form.append('model', 'gpt-image-1.5');
      form.append('prompt', '把背景改为星空');
      form.append('image', new Blob([pngBytes], { type: 'image/png' }), 'input.png');

      const res = await fetch(`${baseUrl}/v1/images/edits`, {
        method: 'POST',
        body: form,
      });

      expect(res.status).toBe(200);
      const req = server.getLastRequest({ pathname: '/v1/images/edits' });
      expect(req?.multipartParts?.length).toBe(3);

      const modelPart = req?.multipartParts?.find((p) => p.name === 'model');
      const promptPart = req?.multipartParts?.find((p) => p.name === 'prompt');
      const imagePart = req?.multipartParts?.find((p) => p.name === 'image');

      expect(modelPart?.text).toBe('gpt-image-1.5');
      expect(promptPart?.text).toBe('把背景改为星空');
      expect(imagePart?.filename).toBe('input.png');
      expect(imagePart?.contentType).toBe('image/png');
      expect(imagePart?.data.equals(pngBytes)).toBe(true);
    });

    it('支持 multipart 前置参数（charset）与无引号 Content-Disposition 字段名/文件名解析', async () => {
      const server = createMockUpstreamServer();
      activeServers.push(server);
      const { port } = await server.start();

      server.on(
        { method: 'POST', pathname: '/v1/images/edits' },
        { kind: 'json', body: { ok: true } }
      );

      const boundary = '----E2EUnquotedBoundary123';
      const pngBytes = Buffer.from(TINY_PNG_BASE64, 'base64');
      const payload = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name=model\r\n\r\ngpt-image-2\r\n` +
            `--${boundary}\r\nContent-Disposition: form-data; name=image; filename=a.png\r\nContent-Type: image/png\r\n\r\n`,
          'utf8'
        ),
        pngBytes,
        Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
      ]);

      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            path: '/v1/images/edits',
            method: 'POST',
            headers: {
              'Content-Type': `multipart/form-data; charset=utf-8; boundary=${boundary}`,
              'Content-Length': String(payload.byteLength),
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          }
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
      });

      expect(status).toBe(200);
      const recorded = server.getLastRequest({ pathname: '/v1/images/edits' });
      expect(recorded?.multipartParts?.length).toBe(2);
      const modelPart = recorded?.multipartParts?.find((p) => p.name === 'model');
      const imagePart = recorded?.multipartParts?.find((p) => p.name === 'image');
      expect(modelPart?.text).toBe('gpt-image-2');
      expect(imagePart?.filename).toBe('a.png');
      expect(imagePart?.data.equals(pngBytes)).toBe(true);
    });

    it('支持 premature-end 与 destroy-socket 两种 SSE 中途断流模式及 410/429 故障注入', async () => {
      const server = createMockUpstreamServer();
      activeServers.push(server);
      const { baseUrl } = await server.start();

      server.enqueue(
        { method: 'POST', pathname: '/v1/responses' },
        {
          kind: 'error',
          status: 410,
          body: buildXaiDeprecatedSearchParameters410Response(),
        }
      );
      server.enqueue(
        { method: 'POST', pathname: '/v1/responses' },
        {
          kind: 'error',
          status: 429,
          headers: { 'Retry-After': '3' },
          body: { error: { message: 'rate limited' } },
        }
      );
      server.enqueue(
        { method: 'POST', pathname: '/v1/responses' },
        {
          kind: 'sse',
          abortAfterChunkIndex: 1,
          abortMode: 'premature-end',
          chunks: [
            { event: 'response.created', data: { type: 'response.created' } },
            { event: 'response.output_text.delta', data: { delta: '半截内容' } },
            { event: 'response.completed', data: { type: 'response.completed' } },
          ],
        }
      );
      server.enqueue(
        { method: 'POST', pathname: '/v1/responses' },
        {
          kind: 'sse',
          abortAfterChunkIndex: 0,
          abortMode: 'destroy-socket',
          chunks: [
            { event: 'response.created', data: { type: 'response.created' } },
            { event: 'response.output_text.delta', data: { delta: '不会发出' } },
          ],
        }
      );

      const r410 = await fetch(`${baseUrl}/v1/responses`, { method: 'POST' });
      expect(r410.status).toBe(410);
      expect((await r410.json()) as { code: string }).toMatchObject({ code: 'GONE' });

      const r429 = await fetch(`${baseUrl}/v1/responses`, { method: 'POST' });
      expect(r429.status).toBe(429);
      expect(r429.headers.get('retry-after')).toBe('3');

      const rPremature = await fetch(`${baseUrl}/v1/responses`, { method: 'POST' });
      expect(rPremature.status).toBe(200);
      const prematureText = await rPremature.text();
      expect(prematureText).toContain('半截内容');
      expect(prematureText).not.toContain('response.completed');

      const rDestroy = await fetch(`${baseUrl}/v1/responses`, { method: 'POST' });
      expect(rDestroy.status).toBe(200);
      await expect(rDestroy.text()).rejects.toThrow(/terminated|aborted|closed|socket|ECONNRESET/i);

      const allReqs = await server.waitForRequestCount(4);
      expect(allReqs.length).toBe(4);
    });
  });

  describe('staticDistServer', () => {
    const tempRoot = path.join(
      process.env.USERPROFILE || REPO_ROOT,
      '.gemini',
      'antigravity',
      'scratch',
      'teamwork_tmp',
      'e2e-m1-static-dist-smoke'
    );

    afterAll(async () => {
      await fs.rm(tempRoot, { recursive: true, force: true });
    });

    it('正确映射 /Embezzle-Studio、MIME、SPA fallback、404 静态资源隔离、403 目录穿越与 405 方法拒绝', async () => {
      const distDir = path.join(tempRoot, `dist-${Date.now()}`);
      await fs.mkdir(path.join(distDir, '_expo', 'static', 'js', 'web'), { recursive: true });
      await fs.mkdir(path.join(distDir, 'assets'), { recursive: true });
      await fs.writeFile(
        path.join(distDir, 'index.html'),
        '<!doctype html><html><body><div id="root">Embezzle</div></body></html>',
        'utf8'
      );
      await fs.writeFile(
        path.join(distDir, '_expo', 'static', 'js', 'web', 'app.js'),
        'console.log("ok");',
        'utf8'
      );
      await fs.writeFile(
        path.join(distDir, 'assets', 'logo.png'),
        Buffer.from(TINY_PNG_BASE64, 'base64')
      );

      const server = createStaticDistServer({ distDir });
      activeServers.push(server);
      const { baseUrl, port } = await server.start();

      // baseUrl 与根路径均返回 index.html
      for (const route of ['/Embezzle-Studio', '/Embezzle-Studio/', '/']) {
        const res = await fetch(`${baseUrl}${route}`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/html');
        expect(await res.text()).toContain('Embezzle');
      }

      // 静态资源 MIME 校验
      const jsRes = await fetch(`${baseUrl}/Embezzle-Studio/_expo/static/js/web/app.js`);
      expect(jsRes.status).toBe(200);
      expect(jsRes.headers.get('content-type')).toContain('application/javascript');

      const pngRes = await fetch(`${baseUrl}/assets/logo.png`);
      expect(pngRes.status).toBe(200);
      expect(pngRes.headers.get('content-type')).toBe('image/png');

      // 无扩展名 SPA 路由 fallback 到 index.html
      const spaRes = await fetch(`${baseUrl}/Embezzle-Studio/chat/conv-1`);
      expect(spaRes.status).toBe(200);
      expect(await spaRes.text()).toContain('Embezzle');

      // 缺失的静态资源必须返回 404，绝不误 fallback 到 index.html
      const missingJs = await fetch(`${baseUrl}/Embezzle-Studio/_expo/static/js/web/missing.js`);
      expect(missingJs.status).toBe(404);
      const missingPng = await fetch(`${baseUrl}/Embezzle-Studio/assets/missing.png`);
      expect(missingPng.status).toBe(404);

      // 目录穿越与畸形编码拦截
      const traversal1 = await rawHttpGet(port, '/Embezzle-Studio/%2e%2e/package.json');
      expect(traversal1.statusCode).toBe(403);
      const traversal2 = await rawHttpGet(port, '/../../package.json');
      expect(traversal2.statusCode).toBe(403);
      const badEncoding = await rawHttpGet(port, '/%E0%A4%A');
      expect(badEncoding.statusCode).toBe(400);

      // 非 GET/HEAD 拒绝
      const postRes = await rawHttpGet(port, '/Embezzle-Studio/', 'POST');
      expect(postRes.statusCode).toBe(405);
      expect(postRes.headers.allow).toBe('GET, HEAD');

      // HEAD 请求返回 200 且无 body
      const headRes = await rawHttpGet(port, '/Embezzle-Studio/', 'HEAD');
      expect(headRes.statusCode).toBe(200);
      expect(headRes.body).toBe('');
    });
  });

  describe('sseFixtures', () => {
    it('生成符合 OpenAI Responses、Anthropic、Gemini、xAI、DeepSeek 与生图规范的夹具', () => {
      const openaiChunks = buildOpenAiResponsesSseChunks({
        reasoningSummaryDeltas: ['推理摘要'],
        encryptedReasoningContent: 'enc_openai_1',
        webSearchQuery: 'latest model',
        citations: [{ url: 'https://openai.com', title: 'OpenAI' }],
        imageGenerationCall: { b64Result: TINY_PNG_BASE64 },
        textDeltas: ['答案文本'],
      });
      expect(openaiChunks.some((c) => c.includes('response.reasoning_summary_text.delta'))).toBe(true);
      expect(openaiChunks.some((c) => c.includes('enc_openai_1'))).toBe(true);
      expect(openaiChunks.some((c) => c.includes('response.completed'))).toBe(true);

      const incompleteOpenai = buildOpenAiResponsesSseChunks({
        textDeltas: ['截断'],
        omitCompleted: true,
      });
      expect(incompleteOpenai.some((c) => c.includes('response.completed'))).toBe(false);

      const openaiJson = buildOpenAiResponsesJson({
        textDeltas: ['完整 JSON'],
        encryptedReasoningContent: 'enc_json_1',
      });
      expect(openaiJson.status).toBe('completed');
      expect(openaiJson.output_text).toBe('完整 JSON');

      const claudeChunks = buildAnthropicMessagesSseChunks({
        thinkingBlocks: [{ thinking: '思考', signature: 'sig_1' }],
        redactedThinkingData: 'redacted_blob',
        serverWebSearch: {
          query: 'claude web search',
          results: [{ url: 'https://anthropic.com', title: 'Anthropic' }],
        },
        textDeltas: ['Claude 回复'],
      });
      expect(claudeChunks.every((c) => !c.includes('[DONE]'))).toBe(true);
      expect(claudeChunks.some((c) => c.includes('redacted_thinking'))).toBe(true);
      expect(claudeChunks.some((c) => c.includes('server_tool_use'))).toBe(true);

      const geminiChunks = buildGeminiStreamSseChunks({
        thoughtParts: [{ text: 'Gemini 思考', thoughtSignature: 'tsig_1' }],
        textDeltas: ['Gemini 回复'],
        finalThoughtSignature: 'tsig_final',
        groundingChunks: [{ uri: 'https://ai.google.dev', title: 'Google AI' }],
      });
      expect(geminiChunks.every((c) => !c.startsWith('event:') && !c.includes('[DONE]'))).toBe(true);
      expect(geminiChunks.some((c) => c.includes('thoughtSignature'))).toBe(true);
      expect(geminiChunks.some((c) => c.includes('groundingMetadata'))).toBe(true);

      // textDeltas + inlineImages + grounding 同时传入时，groundingMetadata 必须附在最后图片终止帧
      const geminiCombinedChunks = buildGeminiStreamSseChunks({
        textDeltas: ['参考以下搜索图解'],
        inlineImages: [{ mimeType: 'image/png', data: TINY_PNG_BASE64, thoughtSignature: 'img_sig_comb' }],
        webSearchQueries: ['gemini diagram'],
        groundingChunks: [{ uri: 'https://ai.google.dev/images', title: 'Gemini Images' }],
      });
      const lastCombined = geminiCombinedChunks[geminiCombinedChunks.length - 1] ?? '';
      expect(lastCombined).toContain('inlineData');
      expect(lastCombined).toContain('groundingMetadata');
      expect(lastCombined).toContain('"finishReason":"STOP"');

      // 仅传入 grounding 无文本无图片时，仍补发带 groundingMetadata 与 STOP 的尾帧
      const geminiGroundingOnly = buildGeminiStreamSseChunks({
        textDeltas: [],
        groundingChunks: [{ uri: 'https://ai.google.dev/only', title: 'Only Grounding' }],
      });
      expect(geminiGroundingOnly.length).toBe(1);
      expect(geminiGroundingOnly[0]).toContain('groundingMetadata');
      expect(geminiGroundingOnly[0]).toContain('"finishReason":"STOP"');

      const geminiJson = buildGeminiGenerateContentJson({
        textDeltas: [],
        inlineImages: [
          { mimeType: 'image/png', data: TINY_PNG_BASE64, thoughtSignature: 'img_sig_1' },
        ],
      });
      expect(JSON.stringify(geminiJson)).toContain('img_sig_1');

      const xaiChunks = buildXaiResponsesSseChunks({
        webSearchQuery: 'grok x search',
        webSearchActionType: 'x_search_call',
        encryptedReasoningContent: 'xai_enc_1',
        textDeltas: ['Grok 回复'],
      });
      expect(xaiChunks.some((c) => c.includes('x_search_call'))).toBe(true);
      expect(buildXaiDeprecatedSearchParameters410Response().code).toBe('GONE');

      const dsChunks = buildDeepSeekChatSseChunks({
        reasoningDeltas: ['DS 思考'],
        serverToolCalls: [
          { id: 'ds_tool_1', type: 'deepseek_web_search', input: { query: 'test' } },
          { id: 'ds_tool_2', type: 'deepseek_read_url', input: { url: 'https://example.com' } },
        ],
        textDeltas: ['DS 回答'],
      });
      expect(dsChunks.some((c) => c.includes('deepseek_web_search'))).toBe(true);
      expect(dsChunks.some((c) => c.includes('deepseek_read_url'))).toBe(true);
      expect(dsChunks.some((c) => c.includes('server_tool_calls'))).toBe(true);

      const sampleSearch = [{ title: 'T1', url: 'https://example.com', snippet: 'S1' }];
      expect(buildDeepSeekToolsSearchJson(sampleSearch)).toHaveProperty('results');
      expect(buildBochaSearchJson(sampleSearch)).toHaveProperty('data.webPages.value');
      expect(buildExaSearchJson(sampleSearch)).toHaveProperty('results');
      expect(buildSearxngSearchJson('q', sampleSearch)).toHaveProperty('number_of_results', 1);

      const decodedPng = Buffer.from(TINY_PNG_BASE64, 'base64');
      expect(decodedPng.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      expect(buildXaiImageGenerationJson()).toHaveProperty('data.0.mime_type', 'image/png');
      expect(generateHighFrequencyTextDeltas(200).length).toBe(200);
    });
  });

  describe('e2eWorkspaceHarness', () => {
    it('可装配真实 WorkspaceSession/Runtime 并完成持久化与安全 fetch 路由及 fail-loud 契约探测', async () => {
      const harness = await createE2EWorkspaceHarness();
      restoreCallbacks.push(() => harness.dispose());

      expect(harness.session.isWritable()).toBe(true);

      await harness.addAndSelectProvider(
        {
          id: 'e2e-openai',
          name: 'E2E OpenAI',
          kind: 'openai-compatible',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-e2e-test',
          capabilities: ['text', 'streaming', 'reasoning', 'web-search'],
          models: [
            {
              id: 'gpt-5',
              capabilities: ['text', 'streaming', 'reasoning', 'web-search'],
              source: 'manual',
            },
          ],
          authHeaderMode: 'bearer',
        },
        undefined
      );

      await harness.chatRuntime.execute({
        type: 'chat.append-messages',
        conversationId: harness.session.getSnapshot().activeConversationId,
        messages: [
          {
            id: harness.ids.createId('msg'),
            role: 'user',
            content: '测试工作区持久化和状态同步',
            createdAt: harness.clock.now(),
            status: 'ready',
          },
        ],
        now: harness.clock.now(),
      });

      await harness.flush();

      const stored = harness.persistence.getStoredSnapshot();
      expect(stored?.activeProviderId).toBe('e2e-openai');
      expect(stored?.activeModelIdByProvider['e2e-openai']).toBe('gpt-5');
      expect(stored?.messages.some((m) => m.content === '测试工作区持久化和状态同步')).toBe(true);
      expect(harness.trace.names()).toContain('persistence.save.success');

      // 测试 MockFetchRouter 转发官方 HTTPS URL 到本地 MockUpstreamServer
      const upstream = createMockUpstreamServer();
      activeServers.push(upstream);
      const { baseUrl } = await upstream.start();
      upstream.on(
        { method: 'POST', pathname: '/v1/responses' },
        {
          kind: 'json',
          body: buildOpenAiResponsesJson({ textDeltas: ['通过路由转发成功'] }),
        }
      );

      const router = installMockFetchRouter(baseUrl);
      restoreCallbacks.push(() => router.restore());

      const routedResp = await fetch('https://api.openai.com/v1/responses?api-version=2026', {
        method: 'POST',
        headers: { Authorization: 'Bearer sk-e2e-test', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5', input: 'ping' }),
      });

      expect(routedResp.status).toBe(200);
      const payload = (await routedResp.json()) as { output_text: string };
      expect(payload.output_text).toBe('通过路由转发成功');
      expect(router.getRoutedCount()).toBe(1);

      const recorded = upstream.getLastRequest({ pathname: '/v1/responses' });
      expect(recorded?.headers.authorization).toBe('Bearer sk-e2e-test');
      expect(recorded?.query['api-version']).toBe('2026');

      // 未授权外网地址必须 fail-loud 拦截，同时 data: URI 直接放行不触发拦截也不计入转发次数
      const routedBeforeData = router.getRoutedCount();
      const dataResp = await fetch(`data:image/png;base64,${TINY_PNG_BASE64}`);
      expect(dataResp.status).toBe(200);
      expect(router.getRoutedCount()).toBe(routedBeforeData);

      await expect(fetch('https://evil.example.org/leak')).rejects.toThrow(/Network Guard/);

      // FileReader polyfill 校验：剥离 MIME 分号参数、空 MIME 兜底与事件触发
      expect(typeof globalThis.FileReader).toBe('function');
      const readDataUrl = (blob: Blob) =>
        new Promise<string>((resolve, reject) => {
          const reader = new globalThis.FileReader();
          let listenerFired = false;
          reader.addEventListener('load', () => {
            listenerFired = true;
          });
          reader.onloadend = () => {
            if (!listenerFired) {
              reject(new Error('FileReader load listener did not fire.'));
              return;
            }
            resolve(String(reader.result ?? ''));
          };
          reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
          reader.readAsDataURL(blob);
        });

      const withCharset = await readDataUrl(new Blob(['hello'], { type: 'text/plain; charset=utf-8' }));
      expect(withCharset).toBe(`data:text/plain;base64,${Buffer.from('hello').toString('base64')}`);

      const emptyMime = await readDataUrl(new Blob([Uint8Array.from([1, 2, 3])]));
      expect(emptyMime).toBe(
        `data:application/octet-stream;base64,${Buffer.from([1, 2, 3]).toString('base64')}`
      );

      // safeImportModule 成功与 fail-loud 校验
      const catalog = await safeImportModule<{ createDefaultWorkspace: () => unknown }>(
        'src/data/providerCatalog.ts',
        ['createDefaultWorkspace']
      );
      expect(typeof catalog.createDefaultWorkspace).toBe('function');

      await expect(
        safeImportModule('src/services/__non_existent_contract__.ts', ['foo'])
      ).rejects.toThrow(/E2E Contract Missing/);

      await expect(
        safeImportModule('src/data/providerCatalog.ts', ['definitelyMissingExportSymbol'])
      ).rejects.toThrow(/缺少约定导出符号/);
    });
  });

  describe('webGeometryProbes & run-e2e CLI', () => {
    it('注入脚本语法合法且在浏览器沙箱挂载全部探针函数', () => {
      const scriptText = buildInjectedWebProbesScript();
      const fakeWindow: Record<string, unknown> = {};
      vm.runInNewContext(scriptText, { window: fakeWindow });

      const probes = fakeWindow.__embezzleE2EProbes as Record<string, unknown>;
      expect(probes).toBeDefined();
      expect(typeof probes.probeElementGeometryAndOcclusion).toBe('function');
      expect(typeof probes.installLongTaskCollector).toBe('function');
      expect(typeof probes.readLongTaskStats).toBe('function');
      expect(typeof probes.probeOverlayResidual).toBe('function');
      expect(CORE_WEB_INTERACTIVE_TARGETS.length).toBeGreaterThanOrEqual(6);

      // 验证注入后的 probeOverlayResidual 完全自包含且可识别 opacity:1 透明/半透明遮罩与 ariaLabel 遮罩
      const styleMap = new Map<unknown, Record<string, string>>();
      const makeOverlayEl = (
        attrs: Record<string, string>,
        style: Record<string, string>
      ) => {
        const el = {
          tagName: 'DIV',
          getAttribute: (name: string) => attrs[name] ?? null,
          getBoundingClientRect: () => ({
            left: 0,
            top: 0,
            right: 390,
            bottom: 844,
            width: 390,
            height: 844,
          }),
        };
        styleMap.set(el, style);
        return el;
      };

      const fakeEls = [
        makeOverlayEl({}, { display: 'flex', visibility: 'visible', pointerEvents: 'auto', position: 'fixed', zIndex: '20', opacity: '1', backgroundColor: 'transparent' }),
        makeOverlayEl({}, { display: 'flex', visibility: 'visible', pointerEvents: 'auto', position: 'fixed', zIndex: '21', opacity: '1', backgroundColor: 'rgba(0, 0, 0, 0.35)' }),
        makeOverlayEl({}, { display: 'flex', visibility: 'visible', pointerEvents: 'auto', position: 'absolute', zIndex: '22', opacity: '1', backgroundColor: 'rgb(0 0 0 / 0.2)' }),
        makeOverlayEl({ 'aria-label': '关闭抽屉遮罩' }, { display: 'flex', visibility: 'visible', pointerEvents: 'auto', position: 'fixed', zIndex: '23', opacity: '1', backgroundColor: 'rgb(255, 255, 255)' }),
        // 普通不透明全屏容器不应被误报为透明遮罩
        makeOverlayEl({}, { display: 'flex', visibility: 'visible', pointerEvents: 'auto', position: 'fixed', zIndex: '24', opacity: '1', backgroundColor: 'rgb(255, 255, 255)' }),
      ];

      const overlayWin: Record<string, unknown> = {
        innerWidth: 390,
        innerHeight: 844,
        getComputedStyle: (el: unknown) => styleMap.get(el) ?? {},
      };
      const overlayDoc = {
        documentElement: {},
        body: {},
        querySelectorAll: () => fakeEls,
      };
      vm.runInNewContext(scriptText, { window: overlayWin, document: overlayDoc });
      const injectedOverlayProbes = overlayWin.__embezzleE2EProbes as {
        probeOverlayResidual: () => { hasBlockingOverlay: boolean; residuals: Array<{ zIndex: number }> };
      };
      const overlayReport = injectedOverlayProbes.probeOverlayResidual();
      expect(overlayReport.hasBlockingOverlay).toBe(true);
      expect(overlayReport.residuals.map((r) => r.zIndex)).toEqual([20, 21, 22, 23]);
    });

    it('scripts/run-e2e.mjs 支持 --help 且严格拒绝冲突参数与未知参数', async () => {
      const helpRes = await execFileAsync(process.execPath, [RUN_E2E_SCRIPT, '--help'], {
        cwd: REPO_ROOT,
      });
      expect(helpRes.stdout).toContain('--core-only');
      expect(helpRes.stdout).toContain('--web-only');

      for (const badArgs of [['--core-only', '--web-only'], ['--unknown-e2e-flag']]) {
        let exitCode = 0;
        let stderr = '';
        try {
          await execFileAsync(process.execPath, [RUN_E2E_SCRIPT, ...badArgs], {
            cwd: REPO_ROOT,
          });
        } catch (error) {
          const err = error as { code?: number; stderr?: string };
          exitCode = err.code ?? 1;
          stderr = err.stderr ?? '';
        }
        expect(exitCode).toBe(2);
        expect(stderr).toContain('参数');
      }
    });
  });
});
