# BYOK Productivity Suite

## Non-negotiable cost boundary

Embezzle Studio does not own or operate a model proxy, search service, voice service, MCP gateway, telemetry backend, sync server, or push worker. Network features use only the provider profile and credentials supplied by the user. A feature is unavailable unless all three conditions hold:

1. the provider or discovered model advertises the capability, or the user explicitly overrides it;
2. this client has a tested serializer/parser for that exact provider protocol;
3. the current device has the user's required credential and configuration.

The application must fail closed when one layer is missing. A capability label is not evidence that the adapter is implemented, and an enabled switch is not evidence that a provider actually invoked a paid tool.

## Local `1.1.0` implementation

- Multi-model comparison runs 2–4 independent requests against the selected user providers. The entire group shares one cancellation lifecycle, partial failures do not discard successful candidates, and exactly one successful candidate is selected for later conversation context. The composer states the number of billable provider calls before sending.
- Usage analytics aggregate the locally retained conversations by provider/model. Token counts and latency come from recorded responses. Prices are optional values entered by the user per million tokens; CNY and USD remain separate, cached input follows the configured cached rate, and reasoning tokens are not billed twice. The dashboard shows per-currency known subtotals and unknown coverage, not a complete bill: search-tool charges, voice, media tasks, and other provider surcharges are excluded.
- Prompt templates remain local. Composer templates insert editable text without sending it; system templates add one identifiable system message to the current conversation.
- The media task center is derived from persisted conversation messages instead of maintaining a second task database. Refresh is manual and uses the task's recorded provider/model, so the app does not poll providers in the background.
- Encrypted export uses XChaCha20-Poly1305 with a scrypt-derived key, random salt and nonce. API keys, MCP authorization, attachment bytes/URIs, and sensitive MCP query strings are removed before encryption. Import validates the complete envelope before one workspace write. A local provider key is inherited only when ID, provider kind, and canonical Base URL all match; MCP authorization additionally requires the same plugin type, transport, and canonical endpoint.
- MCP configuration accepts only remote HTTPS endpoints, rejects embedded credentials/query strings/private hosts, stores authorization separately, defaults to disabled, and requires a permission confirmation before enabling. Tool execution is intentionally still fail closed until the provider-specific approval-response loop is implemented and tested with a real account/server.

## Provider-hosted web search

Search is implemented through provider-owned Responses endpoints and the user's key:

Any search charges are billed by that provider to the user's own account. Embezzle Studio does not buy, resell, subsidize, or proxy search capacity.

| Provider | Request contract | Client evidence required |
| --- | --- | --- |
| OpenAI | `/v1/responses`, `tools: [{ "type": "web_search" }]` | `web_search_call` or a valid `url_citation` |
| Volcengine Ark | `/api/v3/responses`, bounded `web_search` tool (`max_keyword: 3`, `limit: 10`) | search call or valid citation |
| Alibaba Bailian | `/compatible-mode/v1/responses`, `web_search` tool | search call/citation or `usage.x_tools.web_search.count > 0` |

Inline citations are retained as structured HTTPS URL/title/range data and rendered as visible links. Private, local, credential-bearing, malformed, or invalid-range citation URLs are discarded. If the response has no invocation evidence, the UI says that search was not proven rather than claiming an online answer.

Official contracts checked on 2026-07-11:

- [OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search)
- [Volcengine Ark web search](https://www.volcengine.com/docs/82379/1756990)
- [Alibaba Bailian web search](https://help.aliyun.com/zh/model-studio/web-search)

## Request-based voice

Voice is Android-only in this phase. Recording is foreground-only, is never sent automatically, and transcription only inserts editable text into the composer. Speech output is disclosed as AI-generated audio and is downloaded to the app cache before playback.

Any transcription or synthesis charges are billed by the selected provider to the user's own account. Embezzle Studio supplies neither voice credits nor a relay service.

| Provider | Transcription | Speech synthesis |
| --- | --- | --- |
| OpenAI official | `/v1/audio/transcriptions`, file-backed multipart file/model, maximum 25 MiB | `/v1/audio/speech`, maximum 4,096 input code points |
| Alibaba Bailian | `qwen3-asr-flash` compatible chat `input_audio`, maximum 10 MiB | provider-native multimodal generation; temporary URL is immediately downloaded |
| Volcengine | Not enabled through an Ark key | Not enabled through an Ark key |

Volcengine speech products use separate AppID/access-token/resource credentials and must not be inferred from an Ark API key. OpenAI Realtime is also excluded because a safe browser/mobile WebRTC setup requires an ephemeral-token broker, which conflicts with the no-owned-server constraint.

Official contracts checked on 2026-07-11:

- [OpenAI speech to text](https://developers.openai.com/api/docs/guides/speech-to-text)
- [OpenAI text to speech](https://developers.openai.com/api/docs/guides/text-to-speech)
- [Bailian Qwen ASR](https://help.aliyun.com/zh/model-studio/qwen-asr-api-reference)
- [Bailian Qwen TTS](https://help.aliyun.com/en/model-studio/qwen-tts-api)
- [Volcengine file ASR](https://www.volcengine.com/docs/6561/1631584?lang=zh)
- [Volcengine TTS](https://www.volcengine.com/docs/6561/2228192?lang=zh)

## Platform and verification boundary

- Android calls the official/user-configured provider directly. The operating-system secure store holds provider keys and MCP authorization.
- Web model calls remain a local-development feature through `127.0.0.1:8787`; this path requires development mode, the explicit launcher flag set by `npm run web`, and a loopback page origin at the same time. The public Pages build fails before serializing or sending provider credentials and has no Embezzle-owned proxy. Provider audio is disabled on Web.
- Automated tests can prove request shapes, routing, parsing, encryption, secret exclusion, comparison context, and fail-closed behavior. They cannot prove that a user's account has activated a paid search/voice product or that a real MCP server behaves safely.
- Real-account checks must use low limits and explicit user authorization. Android microphone, playback, permission prompts, additional system-bar variants, and sustained multi-request load still require physical-device acceptance.

## Local verification evidence (2026-07-11)

- `npm.cmd run check` passes TypeScript, ESLint with zero warnings, 21 test files, and 423 tests. The suite includes protocol routing, public-Web proxy denial, multi-provider search serialization, unsafe citation filtering, comparison context/preflight, audio cancellation/cache cleanup, usage unknown coverage, storage v3 migration, and encrypted-backup endpoint binding.
- `npx.cmd expo install --check` reports current dependencies and Expo Doctor passes 20/20. The final Web export passes with 3,249 modules and a 7.2 MB main bundle.
- A clean 390×844 exported-Web session renders the new settings centers without clipping. A prompt template was saved and inserted into the composer. A fake provider key plus a real send click returned the production-Web fail-closed message before any proxy request; the browser recorded zero errors and zero warnings.
- All three workflow YAML files parse, all 35 embedded Bash blocks pass `bash -n`, and `git diff --check` passes.
- Clean Expo Android prebuild and `NODE_ENV=production` unsigned Release assembly pass. The resulting local candidate is `D:\EmbezzleStudio-Releases\v1.1.0-candidate\Embezzle-Studio-v1.1.0-candidate-release.apk`, 97,198,551 bytes, SHA-256 `f4a0062fc03d320bb5e3915b6b9a0cdb3a80ee16b4ad18cce78edfd79f92cd80`. `aapt` reports package `com.szdtzpj.embezzlestudio`, version `1.1.0`/code 7, minSdk 24, targetSdk 36, and the intentional `RECORD_AUDIO` permission; camera and overlay permissions are absent. The candidate has exactly one production signer with certificate SHA-256 `F5746B0DC5BD3F6E640F693FDE171BD0CD87A919998CD6CA3F8F26748ABE6C02`; APK Signature Schemes v2/v3 and zipalign pass.
- This candidate is local evidence only. It is not tagged, pushed, uploaded, or published, and it must not be confused with an Actions-rebuilt release asset.
