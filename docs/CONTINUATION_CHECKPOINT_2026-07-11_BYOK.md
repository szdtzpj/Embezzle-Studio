# Continuation checkpoint — 2026-07-11 BYOK/BYOS productivity suite

## Authoritative state

- Workspace: `C:\Python_project\EmbezzleStudio`
- Branch: `codex/byok-productivity-suite`
- Base: `origin/main` at `553e2c1`
- Development version: `1.1.0`, Android versionCode `7`
- Public stable release: `v1.0.6`
- The current working tree contains the complete task changes and is authoritative. Do not reset, checkout, or overwrite it.
- No push, tag, Pull Request, GitHub Release, production-secret change, or remote protection change has been performed for `1.1.0`.

## Implemented boundary

Embezzle Studio owns no production API, model/search/voice credits, proxy, MCP gateway, sync server, telemetry backend, task worker, or pricing service. Network features use only user-supplied provider credentials and provider-hosted capability. Public Web model/audio requests fail closed; the local Web proxy is available only through `npm run web` with development mode, an explicit build flag, and a loopback page origin.

Implemented locally:

- 2–4 model comparison with one group cancellation lifecycle, full preflight, partial-result preservation, and one explicit context candidate.
- Official OpenAI, Volcengine Ark, and Alibaba Bailian Responses web-search serializers, evidence-backed status, and public-HTTPS citations.
- Local prompt/persona templates, media task center, and per-provider/model token/latency/user-price analytics with unknown coverage.
- Android request-based OpenAI/Bailian transcription and TTS; foreground-only recording, operation ownership, cancellation, temporary-file cleanup, and AI-voice disclosure.
- XChaCha20-Poly1305 + scrypt encrypted backup/import with no provider key, MCP authorization, or media. Local secrets are inherited only across an identical protocol/endpoint binding.
- Remote HTTPS MCP configuration, separate secure authorization, default-off permission confirmation, and deliberately disabled tool execution.

## Local evidence

- Full check: 21 files / 423 tests; TypeScript and ESLint pass with zero warnings.
- Expo: dependency check current; Doctor 20/20.
- Web: the final export passes at 3,249 modules / 7.2 MB. Clean 390×844 browser covered settings, prompt-template save/apply, and production-Web fail-closed provider send; 0 console errors / 0 warnings and no proxy request.
- Workflows: 3 YAML files parse; 35 Bash blocks pass `bash -n`; `git diff --check` passes.
- Native: `npx expo prebuild --platform android --clean --no-install` passes. Remove generated release debug signing before local unsigned assembly, as CI already does. With `ANDROID_HOME` set to the installed SDK and `NODE_ENV=production`, `assembleRelease --no-daemon` passes.
- Windows note: running Gradle `clean` after a prior new-architecture build can fail because CMake clean references codegen JNI directories that another clean task already removed. This did not affect the clean Expo prebuild or final assembly; rerunning `assembleRelease` regenerated codegen and passed.

Local candidate:

- Path: `D:\EmbezzleStudio-Releases\v1.1.0-candidate\Embezzle-Studio-v1.1.0-candidate-release.apk`
- Bytes: `97,198,551`
- SHA-256: `f4a0062fc03d320bb5e3915b6b9a0cdb3a80ee16b4ad18cce78edfd79f92cd80`
- Package/version: `com.szdtzpj.embezzlestudio`, `1.1.0` / code `7`
- SDK: min 24 / target 36 / compile 36
- Permissions: intentional `RECORD_AUDIO`; no `CAMERA` or `SYSTEM_ALERT_WINDOW`
- Signing: exactly one production signer, certificate SHA-256 `F5746B0DC5BD3F6E640F693FDE171BD0CD87A919998CD6CA3F8F26748ABE6C02`, v2/v3 true, zipalign verified

## External acceptance still required

- Android physical-device recording permission, microphone capture, transcription insertion, TTS playback/stop, background cancellation, and long-audio memory behavior.
- Real user-provider accounts for low-limit OpenAI/Ark/Bailian search, comparison billing, OpenAI/Bailian STT/TTS, and provider-console charge evidence.
- Real MCP server/provider approval protocol before any tool execution is enabled. Current MCP remains configuration-only and fail-closed.
- Additional Android devices, system-bar variants, large media sessions, SAF cancellation/failure/low-space paths, remote-media expiry, and sustained parallel stress.
- If publication is later authorized: review the complete diff, commit, push a branch, open/merge a PR, freeze `main`, create exact `v1.1.0` tag and owner draft, run the protected Android workflow, then verify the immutable Release and Pages bytes. Do not upload this local candidate as the formal Actions asset.

## Sensitive files

Never read into logs, commit, or publish:

- `api_key.txt`
- `.claude/settings.local.json`
- passwords or recovery contents under `D:\EmbezzleStudio-Release-Signing`
