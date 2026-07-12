# BYOK Productivity Suite

## Non-negotiable cost boundary

Embezzle Studio does not own or operate a model proxy, search service, voice service, MCP gateway, telemetry backend, sync server, exchange-rate service, task worker, or push worker. It does not buy, resell, subsidize, or pool provider capacity. Network features use only the provider profile and credentials supplied by the user, and all provider charges belong to that user's account. A feature is unavailable unless all three conditions hold:

1. the provider or discovered model advertises the capability, or the user explicitly overrides it;
2. this client has a tested serializer/parser for that exact provider protocol;
3. the current device has the user's required credential and configuration.

The application must fail closed when one layer is missing. A capability label is not evidence that the adapter is implemented, and an enabled switch is not evidence that a provider actually invoked a paid tool.

## Local `1.2.0` implementation

- Project workspaces are local records with a name, optional project instruction, optional default model, and conversation membership. Creating, editing, selecting, or deleting a project needs no network service. Project deletion migrates conversations to another local project instead of silently deleting them.
- A conversation can branch from a selected message without a provider call. Every cloned message and comparison group receives a new ID; canonical `originMessageId` values preserve lineage. Usage analytics and the generation task center deduplicate by this canonical origin so inherited history is not counted as newly generated work.
- Global search is a bounded, literal, NFKC-normalized local scan across projects, prompt templates, conversations, and messages. Query length, scanned document count, and result count are capped. Provider profiles, API keys, plugin/MCP configuration, and usage-ledger inputs are not indexed or transmitted.
- The provider setup wizard keeps provider kind, endpoint, and key in an independent draft. If the kind or canonical endpoint changes, saving clears the previous key, models, and candidates before discovery can run against the new destination. Bailian Coding Plan/Token Plan endpoints and `sk-sp-` subscription credentials are blocked because those plans are not authorized for custom-application API use.
- The capability matrix is evidence-backed: provider/model declarations and client-implemented protocol support are separate columns. It can explain that a provider advertises a task while the current client has no serializer/parser, and never turns a display label into a network route by itself.
- The cost guard runs locally. It can bound output tokens, comparison targets, and daily request attempts; it can warn or block at configured limits and require confirmation before potentially multi-charge actions. CNY/USD thresholds inspect only the day's already completed, locally known subtotal and gate the next attempt after that subtotal reaches the configured threshold; they do not project whether the current request will cross it. Currencies remain separate with no Embezzle-owned exchange-rate conversion. The attempt ledger records started/completed/failed/cancelled work and retains unknown components as unknown rather than zero.

- Multi-model comparison runs 2–4 independent requests against the selected user providers. The entire group shares one cancellation lifecycle, partial failures do not discard successful candidates, and exactly one successful candidate is selected for later conversation context. The composer states the number of billable provider calls before sending.
- Usage analytics aggregate the locally retained canonical conversation events by provider/model. Token counts and latency come from recorded responses. Prices are optional values entered by the user per million tokens; CNY and USD remain separate, cached input follows the configured cached rate, and reasoning tokens are not billed twice. The dashboard shows per-currency known subtotals and unknown coverage, not a complete bill: search-tool charges, voice, media tasks, and other provider surcharges are excluded.
- Prompt templates remain local. Composer templates insert editable text without sending it; system templates add one identifiable system message to the current conversation.
- The media task center is derived from persisted conversation messages instead of maintaining a second task database. Refresh is manual and uses the task's recorded provider/model, so the app does not poll providers in the background.
- Encrypted export uses XChaCha20-Poly1305 with a scrypt-derived key, random salt and nonce. Structured API-key/MCP-authorization fields, attachment bytes/URIs, sensitive MCP query strings, and `providerUsageEvents` are removed before encryption. Ordinary conversation, project-prompt, template, provider-note, and error text is preserved as authored and is not secret-scanned, so users must not paste credentials into those fields. Import validates the complete envelope before one workspace write, preserves the current device's local attempt ledger, and never imports another device's ledger. Android also sets `allowBackup: false`, so users should use this explicit authenticated export rather than Android/Google automatic app backup for migration; both the clean `1.2.0` generated Manifest and the packaged APK verify `android:allowBackup="false"`. A local provider key is inherited only when ID, provider kind, and canonical Base URL all match; MCP authorization additionally requires the same plugin type, transport, and canonical endpoint.
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

## Output-token guard wire mapping

The local maximum-output setting is serialized only where the selected route documents an output cap:

| Route | Wire field |
| --- | --- |
| OpenAI Responses and provider-hosted Responses search | `max_output_tokens` |
| OpenAI official Chat Completions | `max_completion_tokens` |
| Volcengine Ark ordinary Chat | `max_tokens` |
| Alibaba Bailian compatible Chat | `max_tokens` |
| New API/custom OpenAI-compatible Chat | best-effort `max_tokens`; support is not guaranteed |

Image/video generation does not pretend that a text output-token cap controls provider media billing. A request limit also does not prove the final charge: retries, search tools, voice, media tasks, provider rounding, and server-side work may add unknown cost. Those unknown components stay visible and can be configured to warn or block.

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

## Historical `1.2.0` checkpoint evidence (2026-07-11)

- The development target at this checkpoint was `1.2.0` / Android versionCode 8. That candidate was not tagged, uploaded, or published, and public stable was still `v1.0.6` at the time; current release status is recorded in the project README and release checkpoint.
- `npm.cmd run check` passes TypeScript, zero-warning ESLint, 27 test files, and 528 tests. Focused suites cover project CRUD/migration, branch ID remapping and canonical deduplication, bounded secret-free local search, endpoint/key rebinding and Bailian subscription-endpoint rejection, declared-versus-client capability evidence, cost-guard limits/unknown-cost behavior, atomic endpoint-bound secret persistence, backup-import replacement locking, storage/backup handling, and exact output-token wire fields.
- Provider protocol tests cover OpenAI Responses `max_output_tokens`, OpenAI official Chat `max_completion_tokens`, Ark/Bailian compatible Chat `max_tokens`, the official Bailian US host for search/audio, and fail-closed endpoint classification. These are serializer/parser and policy tests, not evidence that any user's paid product is activated or that the provider charged a particular amount.
- The final Web export passes with 3,254 modules and a 7.3 MB main bundle. A clean 390×844 browser session verifies `v1.2.0`, the project/provider/capability/cost/backup/voice/MCP settings, project creation and global local search, search-result navigation from Settings back to Chat, endpoint edits clearing a draft Key, and an 8,192-token draft surviving the guard toggle; console evidence is 0 errors / 0 warnings. `expo install --check` is current, Expo Doctor passes 20/20, all three workflow YAML files parse, all 35 embedded Bash blocks pass `bash -n`, all 16 official Actions remain full-SHA pinned, and `git diff --check` passes.
- Clean Expo prebuild and `NODE_ENV=production` `clean assembleRelease` pass. The packaged Manifest verifies `android:allowBackup="false"`. The production-signed local candidate is `D:\EmbezzleStudio-Releases\v1.2.0-candidate\Embezzle-Studio-v1.2.0-candidate-release.apk`, 97,313,239 bytes, SHA-256 `872f32a48320f2a20dadee6fc0f699668666d067a60e546a19467ed922082da0`. `aapt` reports package `com.szdtzpj.embezzlestudio`, version `1.2.0`/code 8, minSdk 24, targetSdk 36, intentional `RECORD_AUDIO`, and no camera/overlay permission. Exactly one expected production signer, APK Signature Schemes v2/v3, and zip alignment verify. This is local evidence only: no push, tag, upload, or GitHub Release was performed.

## Historical `1.1.0` verification evidence (2026-07-11)

The following evidence belongs to the previous `1.1.0` / code 7 development candidate. It remains useful history but does not validate the changed `1.2.0` source:

- `npm.cmd run check` passes TypeScript, ESLint with zero warnings, 21 test files, and 423 tests. The suite includes protocol routing, public-Web proxy denial, multi-provider search serialization, unsafe citation filtering, comparison context/preflight, audio cancellation/cache cleanup, usage unknown coverage, storage v3 migration, and encrypted-backup endpoint binding.
- `npx.cmd expo install --check` reports current dependencies and Expo Doctor passes 20/20. The final Web export passes with 3,249 modules and a 7.2 MB main bundle.
- A clean 390×844 exported-Web session renders the new settings centers without clipping. A prompt template was saved and inserted into the composer. A fake provider key plus a real send click returned the production-Web fail-closed message before any proxy request; the browser recorded zero errors and zero warnings.
- All three workflow YAML files parse, all 35 embedded Bash blocks pass `bash -n`, and `git diff --check` passes.
- Clean Expo Android prebuild and `NODE_ENV=production` unsigned Release assembly pass. The resulting local candidate is `D:\EmbezzleStudio-Releases\v1.1.0-candidate\Embezzle-Studio-v1.1.0-candidate-release.apk`, 97,198,551 bytes, SHA-256 `f4a0062fc03d320bb5e3915b6b9a0cdb3a80ee16b4ad18cce78edfd79f92cd80`. `aapt` reports package `com.szdtzpj.embezzlestudio`, version `1.1.0`/code 7, minSdk 24, targetSdk 36, and the intentional `RECORD_AUDIO` permission; camera and overlay permissions are absent. The candidate has exactly one production signer with certificate SHA-256 `F5746B0DC5BD3F6E640F693FDE171BD0CD87A919998CD6CA3F8F26748ABE6C02`; APK Signature Schemes v2/v3 and zipalign pass.
- This `1.1.0` candidate is historical local evidence only. It is not tagged, pushed, uploaded, or published, and it must not be confused with a `1.2.0` build or an Actions-rebuilt release asset.
