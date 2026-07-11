import { describe, expect, it, vi } from 'vitest';

import type { ProviderProfile } from '../src/domain/types';
import {
  BAILIAN_AUDIO_MAX_BYTES,
  OPENAI_AUDIO_MAX_BYTES,
  PROVIDER_AUDIO_MAX_TEXT_CODE_POINTS,
  ProviderAudioProtocolError,
  buildAudioTranscriptionRequest,
  buildOpenAiFileBackedTranscriptionRequest,
  buildSpeechSynthesisRequest,
  getProviderAudioEndpoints,
  getProviderAudioReadiness,
  parseAudioTranscriptionResponse,
  parseSpeechSynthesisResponse,
  resolveProviderAudioProtocol,
  synthesizeSpeech,
  transcribeAudio,
  validateProviderAudioDownloadUrl,
  type PreparedProviderAudioFile,
  type ProviderAudioFetch,
  type ProviderAudioFileAdapter,
} from '../src/services/providerAudio';

const platform = vi.hoisted(() => ({ OS: 'android' }));

vi.mock('react-native', () => ({ Platform: platform }));

function provider(
  kind: ProviderProfile['kind'],
  baseUrl: string,
  overrides: Partial<ProviderProfile> = {}
): ProviderProfile {
  return {
    id: `provider-${kind}`,
    name: kind,
    kind,
    baseUrl,
    apiKey: ' user-api-key ',
    capabilities: ['speech-to-text', 'text-to-speech'],
    models: [],
    ...overrides,
  };
}

const openAi = provider('custom', 'https://api.openai.com/v1');
const bailian = provider(
  'bailian-compatible',
  'https://dashscope.aliyuncs.com/compatible-mode/v1'
);

function audioFile(overrides: Partial<PreparedProviderAudioFile> = {}): PreparedProviderAudioFile {
  return {
    base64: 'aGVsbG8=',
    size: 5,
    name: 'voice.mp3',
    mimeType: 'audio/mpeg',
    ...overrides,
  };
}

function injectedFiles(
  file: PreparedProviderAudioFile = audioFile()
): ProviderAudioFileAdapter & {
  readBase64: ReturnType<typeof vi.fn>;
  writeCacheBytes: ReturnType<typeof vi.fn>;
  deleteCacheFile: ReturnType<typeof vi.fn>;
} {
  return {
    readBase64: vi.fn(async () => file),
    writeCacheBytes: vi.fn(async () => 'file:///cache/generated-speech.mp3'),
    deleteCacheFile: vi.fn(async () => undefined),
  };
}

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function binaryResponse(
  bytes = Uint8Array.from([1, 2, 3]),
  contentType = 'audio/mpeg',
  headers: Record<string, string> = {}
): Response {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Response(buffer, {
    status: 200,
    headers: { 'content-type': contentType, ...headers },
  });
}

describe('provider audio readiness and official routing', () => {
  it('enables official OpenAI and Bailian audio only on Android with a user key', () => {
    expect(getProviderAudioReadiness(openAi, 'android')).toMatchObject({
      ready: true,
      protocol: 'openai-official',
      canTranscribe: true,
      canSynthesize: true,
    });
    expect(getProviderAudioReadiness(bailian, 'android')).toMatchObject({
      ready: true,
      protocol: 'bailian-compatible',
    });
    expect(getProviderAudioReadiness(openAi, 'web')).toMatchObject({
      ready: false,
      reason: 'unsupported-platform',
    });
    expect(getProviderAudioReadiness({ ...openAi, apiKey: ' ' }, 'android')).toMatchObject({
      ready: false,
      reason: 'missing-api-key',
    });
  });

  it('derives only the documented official endpoints from an allowed origin', () => {
    expect(getProviderAudioEndpoints(openAi)).toEqual({
      transcription: 'https://api.openai.com/v1/audio/transcriptions',
      speech: 'https://api.openai.com/v1/audio/speech',
    });
    expect(getProviderAudioEndpoints(bailian)).toEqual({
      transcription: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      speech:
        'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    });
  });

  it('accepts official Bailian workspace hosts but requires the matching provider kind', () => {
    const workspace = provider(
      'bailian-compatible',
      'https://llm-cn-test.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/models'
    );
    expect(resolveProviderAudioProtocol(workspace)).toBe('bailian-compatible');
    expect(() =>
      resolveProviderAudioProtocol({ ...workspace, kind: 'openai-compatible' })
    ).toThrow(ProviderAudioProtocolError);
  });

  it.each([
    provider('custom', 'https://api.openai.com.evil.example/v1'),
    provider('custom', 'http://api.openai.com/v1'),
    provider('custom', 'https://api.openai.com:444/v1'),
    provider('custom', 'https://api.openai.com/v1?redirect=evil'),
    provider('custom', 'https://api.openai.com/not-an-api-path'),
    provider('bailian-compatible', 'https://dashscope.aliyuncs.com.evil.example/compatible-mode/v1'),
    provider('bailian-compatible', 'https://dashscope.aliyuncs.com/api/v3'),
    provider('volcengine-ark', 'https://ark.cn-beijing.volces.com/api/v3'),
    provider('new-api-relay', 'https://api.openai.com/v1'),
  ])('rejects lookalike, insecure, malformed, Ark, and relay routes: $baseUrl', (candidate) => {
    expect(() => resolveProviderAudioProtocol(candidate)).toThrow(ProviderAudioProtocolError);
  });
});

describe('provider audio request construction', () => {
  it('builds OpenAI multipart transcription with file and model and no manual boundary header', async () => {
    const request = buildAudioTranscriptionRequest({
      provider: openAi,
      modelId: ' gpt-4o-mini-transcribe ',
      file: audioFile(),
      platform: 'android',
    });

    expect(request.protocol).toBe('openai-official');
    expect(request.url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(request.headers.Authorization).toBe('Bearer user-api-key');
    expect(request.headers).not.toHaveProperty('Content-Type');
    expect(request.body).toBeInstanceOf(FormData);
    const form = request.body as FormData;
    expect(form.get('model')).toBe('gpt-4o-mini-transcribe');
    const uploaded = form.get('file');
    expect(uploaded).toBeInstanceOf(Blob);
    expect((uploaded as Blob).type).toBe('audio/mpeg');
    expect(Array.from(new Uint8Array(await (uploaded as Blob).arrayBuffer()))).toEqual([
      104, 101, 108, 108, 111,
    ]);
  });

  it('builds the production OpenAI multipart body around a file-backed Blob without Base64', async () => {
    const file = new Blob([Uint8Array.from([1, 2, 3, 4])], { type: 'audio/mp4' });
    const request = buildOpenAiFileBackedTranscriptionRequest({
      provider: openAi,
      modelId: 'gpt-4o-mini-transcribe',
      source: { uri: 'file:///recording.m4a', name: 'recording.m4a', mimeType: 'audio/mp4' },
      file,
      platform: 'android',
    });

    const form = request.body as FormData;
    expect(request.headers).not.toHaveProperty('Content-Type');
    expect(form.get('model')).toBe('gpt-4o-mini-transcribe');
    const uploaded = form.get('file') as Blob;
    expect(uploaded.size).toBe(4);
    expect(Array.from(new Uint8Array(await uploaded.arrayBuffer()))).toEqual([1, 2, 3, 4]);
  });

  it('builds Bailian qwen3-asr-flash compatible chat input_audio as a data URL', () => {
    const request = buildAudioTranscriptionRequest({
      provider: bailian,
      modelId: 'qwen3-asr-flash',
      file: audioFile(),
      platform: 'android',
    });
    expect(request.url).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
    );
    expect(JSON.parse(request.body as string)).toEqual({
      model: 'qwen3-asr-flash',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'input_audio',
              input_audio: { data: 'data:audio/mpeg;base64,aGVsbG8=' },
            },
          ],
        },
      ],
      stream: false,
    });
  });

  it('enforces the provider-specific source limits before decoding a large payload', () => {
    expect(() =>
      buildAudioTranscriptionRequest({
        provider: openAi,
        modelId: 'gpt-4o-transcribe',
        file: audioFile({ size: OPENAI_AUDIO_MAX_BYTES + 1, base64: 'AA==' }),
        platform: 'android',
      })
    ).toThrow(/25 MB/);
    expect(() =>
      buildAudioTranscriptionRequest({
        provider: bailian,
        modelId: 'qwen3-asr-flash',
        file: audioFile({ size: BAILIAN_AUDIO_MAX_BYTES + 1, base64: 'AA==' }),
        platform: 'android',
      })
    ).toThrow(/10 MB/);
  });

  it('rejects mismatched Base64 sizes, unsupported MIME, and the wrong Bailian ASR model', () => {
    expect(() =>
      buildAudioTranscriptionRequest({
        provider: openAi,
        modelId: 'gpt-4o-transcribe',
        file: audioFile({ size: 6 }),
        platform: 'android',
      })
    ).toThrow(/does not match/);
    expect(() =>
      buildAudioTranscriptionRequest({
        provider: openAi,
        modelId: 'gpt-4o-transcribe',
        file: audioFile({ mimeType: 'text/plain' }),
        platform: 'android',
      })
    ).toThrow(/MIME/);
    expect(() =>
      buildAudioTranscriptionRequest({
        provider: bailian,
        modelId: 'qwen2-audio',
        file: audioFile(),
        platform: 'android',
      })
    ).toThrow(/qwen3-asr-flash/);
  });

  it('builds OpenAI speech JSON with the official response_format field', () => {
    const request = buildSpeechSynthesisRequest({
      provider: openAi,
      modelId: 'gpt-4o-mini-tts',
      text: 'Hello from the app.',
      voice: 'coral',
      responseFormat: 'opus',
      platform: 'android',
    });
    expect(request.url).toBe('https://api.openai.com/v1/audio/speech');
    expect(request.responseKind).toBe('audio');
    expect(JSON.parse(request.body as string)).toEqual({
      model: 'gpt-4o-mini-tts',
      input: 'Hello from the app.',
      voice: 'coral',
      response_format: 'opus',
    });
  });

  it('builds Bailian multimodal-generation speech JSON without an invented format field', () => {
    const request = buildSpeechSynthesisRequest({
      provider: bailian,
      modelId: 'qwen3-tts-flash',
      text: '你好。',
      voice: 'Cherry',
      responseFormat: 'mp3',
      languageType: 'Chinese',
      platform: 'android',
    });
    expect(request.url).toBe(
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'
    );
    expect(JSON.parse(request.body as string)).toEqual({
      model: 'qwen3-tts-flash',
      input: { text: '你好。', voice: 'Cherry', language_type: 'Chinese' },
    });
  });

  it('rejects missing keys, Web construction, overlong text, and wrong Bailian TTS models', () => {
    expect(() =>
      buildSpeechSynthesisRequest({
        provider: { ...openAi, apiKey: '' },
        modelId: 'gpt-4o-mini-tts',
        text: 'hello',
        voice: 'coral',
        platform: 'android',
      })
    ).toThrow(/API key/);
    expect(() =>
      buildSpeechSynthesisRequest({
        provider: openAi,
        modelId: 'gpt-4o-mini-tts',
        text: 'hello',
        voice: 'coral',
        platform: 'web',
      })
    ).toThrow(/Android only/);
    expect(() =>
      buildSpeechSynthesisRequest({
        provider: openAi,
        modelId: 'gpt-4o-mini-tts',
        text: '文'.repeat(PROVIDER_AUDIO_MAX_TEXT_CODE_POINTS + 1),
        voice: 'coral',
        platform: 'android',
      })
    ).toThrow(/4096/);
    expect(() =>
      buildSpeechSynthesisRequest({
        provider: bailian,
        modelId: 'qwen-tts',
        text: 'hello',
        voice: 'Cherry',
        platform: 'android',
      })
    ).toThrow(/qwen3-tts-flash/);
  });
});

describe('provider audio response parsing and download policy', () => {
  it('parses OpenAI and Bailian transcripts with normalized usage', () => {
    expect(
      parseAudioTranscriptionResponse(
        openAi,
        JSON.stringify({
          text: 'openai transcript',
          usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
        })
      )
    ).toEqual({
      text: 'openai transcript',
      usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
    });
    expect(
      parseAudioTranscriptionResponse(bailian, {
        choices: [{ message: { content: '百炼转写' } }],
        usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
      })
    ).toEqual({
      text: '百炼转写',
      usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
    });
  });

  it('rejects provider errors, malformed transcript shapes, and oversized JSON', () => {
    expect(() =>
      parseAudioTranscriptionResponse(openAi, { error: { message: 'bad audio' } })
    ).toThrow(/bad audio/);
    expect(() => parseAudioTranscriptionResponse(bailian, { choices: [] })).toThrow(
      /transcript text/
    );
    expect(() => parseAudioTranscriptionResponse(openAi, `{"text":"${'x'.repeat(1024 * 1024)}"}`))
      .toThrow(/safe size limit/);
  });

  it('parses a Bailian temporary HTTPS speech URL and OpenAI audio bytes', () => {
    const url =
      'https://dashscope-result-sh.oss-cn-shanghai.aliyuncs.com/audio/result.wav?Expires=123&Signature=test';
    expect(
      parseSpeechSynthesisResponse(bailian, { output: { audio: { url } } })
    ).toEqual({ kind: 'download', url });
    expect(
      parseSpeechSynthesisResponse(openAi, Uint8Array.from([1, 2]), {
        contentType: 'audio/opus; charset=binary',
        responseFormat: 'opus',
      })
    ).toMatchObject({
      kind: 'bytes',
      mimeType: 'audio/opus',
      extension: 'opus',
    });
  });

  it.each([
    'http://public.example/audio.wav',
    'https://localhost/audio.wav',
    'https://127.0.0.1/audio.wav',
    'https://10.1.2.3/audio.wav',
    'https://169.254.1.2/audio.wav',
    'https://[::1]/audio.wav',
    'https://[::ffff:127.0.0.1]/audio.wav',
    'https://user:password@public.example/audio.wav',
    'https://host.local/audio.wav',
    'https://intranet/audio.wav',
    'https://public.example:8443/audio.wav',
    'https://public.example/audio.wav#fragment',
  ])('rejects malicious or non-public speech URL %s', (url) => {
    expect(() => validateProviderAudioDownloadUrl(url)).toThrow(ProviderAudioProtocolError);
    expect(() =>
      parseSpeechSynthesisResponse(bailian, { output: { audio: { url } } })
    ).toThrow(ProviderAudioProtocolError);
  });

  it('rejects unsafe binary response content types and empty speech bodies', () => {
    expect(() =>
      parseSpeechSynthesisResponse(openAi, Uint8Array.from([1]), {
        contentType: 'text/html',
      })
    ).toThrow(/Content-Type/);
    expect(() => parseSpeechSynthesisResponse(openAi, new Uint8Array())).toThrow(/audio bytes/);
  });
});

describe('provider audio injected I/O', () => {
  it('fails closed on Web before reading a file or starting the network', async () => {
    const files = injectedFiles();
    const fetchImpl = vi.fn(async () => jsonResponse({ text: 'must not happen' }));
    await expect(
      transcribeAudio({
        provider: openAi,
        modelId: 'gpt-4o-mini-transcribe',
        source: { uri: 'file:///recording.mp3' },
        platform: 'web',
        fileAdapter: files,
        fetchImpl,
      })
    ).rejects.toThrow(/Android only/);
    expect(files.readBase64).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('transcribes through Bailian with injected file and network access', async () => {
    const files = injectedFiles();
    let requestSignal: AbortSignal | undefined;
    const fetchImpl: ProviderAudioFetch = vi.fn(async (_url, init) => {
      requestSignal = init?.signal as AbortSignal;
      return jsonResponse({
        choices: [{ message: { content: 'injected transcript' } }],
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
      });
    });
    await expect(
      transcribeAudio({
        provider: bailian,
        modelId: 'qwen3-asr-flash',
        source: { uri: 'file:///recording.mp3' },
        platform: 'android',
        fileAdapter: files,
        fetchImpl,
      })
    ).resolves.toEqual({
      protocol: 'bailian-compatible',
      text: 'injected transcript',
      usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
    });
    expect(files.readBase64).toHaveBeenCalledTimes(1);
    expect(files.readBase64.mock.calls[0][1]).toBe(BAILIAN_AUDIO_MAX_BYTES);
    expect(requestSignal).toBeInstanceOf(AbortSignal);
  });

  it('downloads Bailian speech immediately and returns only an app-cache URI', async () => {
    const files = injectedFiles();
    const temporaryUrl = 'https://result.example.com/generated/audio.wav?signature=short-lived';
    const fetchImpl: ProviderAudioFetch = vi.fn(async (url, init) => {
      if (url.includes('/multimodal-generation/generation')) {
        return jsonResponse({ output: { audio: { url: temporaryUrl } } });
      }
      expect(url).toBe(temporaryUrl);
      expect(init?.method).toBe('GET');
      expect(init?.redirect).toBe('error');
      return binaryResponse(Uint8Array.from([9, 8, 7, 6]), 'audio/wav');
    });
    await expect(
      synthesizeSpeech({
        provider: bailian,
        modelId: 'qwen3-tts-flash',
        text: '缓存我',
        voice: 'Cherry',
        platform: 'android',
        fileAdapter: files,
        fetchImpl,
      })
    ).resolves.toEqual({
      protocol: 'bailian-compatible',
      uri: 'file:///cache/generated-speech.mp3',
      size: 4,
      mimeType: 'audio/wav',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(files.writeCacheBytes).toHaveBeenCalledTimes(1);
    expect(Array.from(files.writeCacheBytes.mock.calls[0][1] as Uint8Array)).toEqual([9, 8, 7, 6]);
  });

  it('writes OpenAI binary speech directly to app cache in one request', async () => {
    const files = injectedFiles();
    const fetchImpl: ProviderAudioFetch = vi.fn(async () =>
      binaryResponse(Uint8Array.from([5, 4, 3]), 'audio/opus')
    );
    await expect(
      synthesizeSpeech({
        provider: openAi,
        modelId: 'gpt-4o-mini-tts',
        text: 'Cache this.',
        voice: 'coral',
        responseFormat: 'opus',
        platform: 'android',
        fileAdapter: files,
        fetchImpl,
      })
    ).resolves.toMatchObject({
      protocol: 'openai-official',
      size: 3,
      mimeType: 'audio/opus',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(files.writeCacheBytes.mock.calls[0][0]).toMatch(/\.opus$/);
  });

  it('rolls back a generated cache file when cancellation wins immediately after the write', async () => {
    const controller = new AbortController();
    const files = injectedFiles();
    files.writeCacheBytes.mockImplementation(async () => {
      controller.abort();
      return 'file:///cache/cancelled-speech.mp3';
    });
    const fetchImpl: ProviderAudioFetch = vi.fn(async () =>
      binaryResponse(Uint8Array.from([5, 4, 3]), 'audio/mpeg')
    );

    await expect(synthesizeSpeech({
      provider: openAi,
      modelId: 'gpt-4o-mini-tts',
      text: 'Cancel this cache write.',
      voice: 'coral',
      platform: 'android',
      signal: controller.signal,
      fileAdapter: files,
      fetchImpl,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(files.deleteCacheFile).toHaveBeenCalledWith('file:///cache/cancelled-speech.mp3');
  });

  it('enforces timeout even when an injected fetch ignores AbortSignal', async () => {
    const files = injectedFiles();
    const fetchImpl: ProviderAudioFetch = vi.fn(() => new Promise<Response>(() => undefined));
    await expect(
      synthesizeSpeech({
        provider: openAi,
        modelId: 'gpt-4o-mini-tts',
        text: 'Timeout.',
        voice: 'coral',
        platform: 'android',
        timeoutMs: 10,
        fileAdapter: files,
        fetchImpl,
      })
    ).rejects.toThrow(/timed out/);
    expect(files.writeCacheBytes).not.toHaveBeenCalled();
  });

  it('rejects a declared oversized speech response before caching it', async () => {
    const files = injectedFiles();
    const fetchImpl: ProviderAudioFetch = vi.fn(async () =>
      binaryResponse(Uint8Array.from([1]), 'audio/mpeg', {
        'content-length': String(64 * 1024 * 1024 + 1),
      })
    );
    await expect(
      synthesizeSpeech({
        provider: openAi,
        modelId: 'gpt-4o-mini-tts',
        text: 'Too large.',
        voice: 'coral',
        platform: 'android',
        fileAdapter: files,
        fetchImpl,
      })
    ).rejects.toThrow(/Content-Length/);
    expect(files.writeCacheBytes).not.toHaveBeenCalled();
  });
});
