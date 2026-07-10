# Embezzle Studio continuation checkpoint — 2026-07-10

This file is the authoritative handoff for the interrupted audit/fix session. The working tree is intentionally dirty and contains the implementation; do not reset, discard, or recreate it.

## Original objective

Continue the deep, end-to-end audit of the entire Embezzle Studio application. Read the official OpenAI, Volcengine Ark, and Alibaba Bailian documentation carefully; verify model routing, request bodies, reasoning controls, task capabilities, storage, UI state, media handling, security, Web/Android builds, and the release/update chain. Correct errors and risks, and continue until the real external/manual boundary.

## Continuation completion — current authoritative state

The continuation reached the locally provable boundary on 2026-07-10, after which the user authorized the GitHub continuation. The historical interruption/evidence/action sections later in this file are retained for traceability, but this section and the remote evidence below supersede their stale status.

### Closed implementation and audit items

- `stage-release-for-pages.mjs` now selects only `Embezzle-Studio-${tag}-release.apk`, binds it to its same-name `.sha256` or the exact filename entry in `SHA256SUMS`, and enforces 256 MiB APK / 64 KiB checksum limits from both `Content-Length` and streamed bytes.
- `release.html` and the Pages APK are written only for an owner-published GitHub Immutable Release whose exact APK/checksum assets are `uploaded` by `github-actions[bot]`, carry valid GitHub digests, and match after both assets are downloaded and hashed. The page escapes release text, encodes the APK as one URL path segment, displays version/size/full digest, and states that immutable/digest/checksum evidence is not production-signature verification. Valid manifests point to `release.html`; 404/mutable/non-owner/missing or metadata-untrusted assets remain `apk: null` and remove stale managed outputs.
- Incremental current-doc review added native GPT-5.6 `max` effort without collapsing it to `xhigh`, and explicitly rejects the nonexistent `gpt-5.6-pro` slug as a Responses-only Pro model. Existing GPT-5 through GPT-5.5/o-series matrices remain covered.
- Ark protocol detection now requires the explicit Ark provider kind or an exact official data-plane hostname. Display names and lookalike hostnames cannot suppress normal `/models` discovery or activate Ark-only request parameters.
- Android CI now uses `aapt` on the unsigned artifact to enforce package/version/minSdk/targetSdk and reject overlay/camera/microphone permissions before signing. Owner/rerun gates precede build, secret-backed signing, publication, and Pages deployment; the release workflow rechecks the exact tag/main commit and all three assets before and after freezing the draft as immutable. All 15 official GitHub Action uses are pinned to GitHub-verified latest-stable full commit SHAs.
- The update checker announces an available version only when the manifest also contains a trusted APK asset. A newer fail-closed `apk: null` manifest now renders as “暂无可用的可信更新” rather than falsely claiming that the pending version is downloadable or already installed.
- README/product/roadmap documentation now matches Web tab-session API keys, IndexedDB/native attachment lifecycles, capability-gated image/video/file UI, Bailian video bounds, the public checksum page, and the production release boundary.

### Current local evidence

- `npm.cmd run check`: passed — 12 test files, 195 tests; TypeScript and ESLint zero errors/warnings.
- Release stager/update checker focus: 38/38 tests passed, including missing release booleans, both asset uploaders/states/digests, downloaded-byte versus GitHub-digest mismatches, and newer-version `apk: null` behavior. An authenticated live smoke against the current mutable v1.0.3 Release wrote `apk: null` with the public base URL and no `release.html` or `downloads/` directory.
- `npm.cmd run build:web`: passed after the final UI/update-checker edits — 3133 modules, 6.9 MB main bundle. `npx.cmd expo-doctor`: 20/20.
- Exported Web artifact browser smoke passed at the normal desktop viewport and 390×844: chat, settings, return navigation, history dialog, Web key notice, and update state were visible/operable. Against the live `apk: null` manifest, the final UI showed “暂无可用的可信更新”, the full trust-chain notice, and “查看发布状态”; both viewport console warning/error lists were empty.
- `git diff --check` passed for tracked changes and an additional no-index check passed for the original 22 untracked files. All 3 workflow YAML files parsed, all 34 embedded Bash blocks passed Git Bash `bash -n`, and all 15 official Action uses passed full-SHA validation. The eight distinct Action tag commits were also resolved through the official GitHub repositories and matched the pinned SHAs.
- `npm audit --omit=dev --audit-level=high` exited 0. The remaining 11 moderate `uuid -> xcode -> @expo/config-plugins` advisories require a breaking Expo downgrade/change from `npm audit fix --force`, so no blind force-fix was applied.
- After the final update-checker/UI fix, a new clean Expo Android prebuild and `gradlew clean assembleRelease --no-daemon` completed with `NODE_ENV=production`, explicit installed SDK path `C:\Users\555\AppData\Local\Android\Sdk`, and Build Tools 36.0.0. The first Gradle attempt correctly failed after clean prebuild removed `local.properties` and the shell lacked `ANDROID_HOME`; rerunning the same clean tree with the verified SDK path succeeded. The complete Git status entry set was unchanged across the successful build.
- Final local APK: `android/app/build/outputs/apk/release/app-release.apk`, written `2026-07-10 10:54:01 +08:00`, later than the final `App.tsx` and `updateChecker.ts` edits.
  - package `com.szdtzpj.embezzlestudio`; version `1.0.4`; versionCode `4`; minSdk `24`; targetSdk `36`
  - size `92,979,061` bytes
  - SHA-256 `945031C481475DA160267E2C56A7738DC609D2930EF69136E198392EFDA1E211`
  - permissions: INTERNET, legacy read/write storage with maxSdk 32, VIBRATE, biometric/fingerprint, and the app-scoped dynamic receiver permission; no SYSTEM_ALERT_WINDOW, CAMERA, or RECORD_AUDIO
  - `apksigner` verifies APK Signature Scheme v2 (`v3: false`); `zipalign -c -P 16 4` succeeds
  - signer is intentionally local-only `CN=Android Debug`; certificate SHA-256 `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`. This artifact must not be published as the production release.
- A disposable **non-production** PKCS12 preflight exercised the same pinned Build Tools 36.0.0 zipalign/apksigner path against the rebuilt unsigned bytes. Package/version/SDK checks passed, v2/v3 verification passed, the single signer matched the disposable certificate, and the temporary keystore/password variables/output were removed. This proves the mechanics only; its certificate and APK are explicitly not publication artifacts.
- At the local-boundary snapshot, final status/diff scope, untracked sizes, common secret patterns, and keystore/private-key file extensions were inspected; no generated source artifact or secret material was found. GitHub changes described below happened only after the user subsequently authorized them.

### GitHub continuation evidence

- PR [#1](https://github.com/szdtzpj/Embezzle-Studio/pull/1) merged the audited implementation as `9d87de076e4f58d2ae1b4e77d12cf21c893a0644`; its final head Quality run `29062677804` and the exact merge-SHA Quality run `29062764033` succeeded.
- The first merge-SHA Pages run `29062764034` exposed a real integration gap: the build job's `configure-pages` call could not read the Pages site with a contents-only token. PR [#2](https://github.com/szdtzpj/Embezzle-Studio/pull/2) added only `contents: read` plus `pages: read` to that job, retained `pages: write`/`id-token: write` only in deploy, upgraded the three Pages actions to their GitHub-verified Node 24 stable SHAs, and explicitly included `.nojekyll` in the v5 artifact. It merged as `a7bfe09bf7f57b5341f594093bb2f2b85efebf70`.
- On that Pages-fix merge SHA, Quality run `29063138324` succeeded and Pages run `29063138326` completed both build and deploy. Anonymous HTTPS checks returned `200` for the site root and `release-manifest.json`, and `404` for `release.html` and the old v1.0.3 download path. The published manifest identifies v1.0.3 but has `apk: null`, so the existing debug-signed asset was not exposed as a trusted update.
- PR [#3](https://github.com/szdtzpj/Embezzle-Studio/pull/3) recorded the remote evidence as merge `61eb73e33526f34873b98a228f494b93a577800e`; its exact-SHA Quality run `29063440376` and Pages run `29063440384` both succeeded.
- PR [#4](https://github.com/szdtzpj/Embezzle-Studio/pull/4) merged the immutable draft pipeline, rerun guards, latest Action pins, stricter stager, and client fail-closed fix as `4e079c09ff946ccfaa330bb2ff1e6b29115eb983`. Head Quality run `29065832341`, exact merge-SHA Quality run `29065999627`, and exact merge-SHA Pages build/deploy run `29065999628` all succeeded under the selected-Actions policy.
- Anonymous post-deploy HTTPS checks again returned `200` for the site root and manifest, with schema 1/version 1.0.3/`apk: null`/public base release URL, while `release.html` and the old v1.0.3 APK path returned `404`. This proves the stricter owner/immutable/uploader/digest path fails closed against the existing mutable debug Release in the real Pages deployment.
- Active remote protection now layers: main ruleset `18749435` (no deletion/force-push, mandatory PR with resolved discussions, and strict required `Typecheck, test, lint, and build web`; current owner bypass is `never`), `v*` ruleset `18749437` (no deletion or ref movement), owner-through-PR-only main update ruleset `18752786`, and owner-only `v*` creation/update ruleset `18752793`. The tag owner bypass is `always` so the owner can create the release tag; the no-bypass immutability rules still prevent moving or deleting it afterward.
- Repository Actions policy is enabled with `allowed_actions: selected`, `github_owned_allowed: true`, `verified_allowed: false`, and `sha_pinning_required: true`; every current workflow action is under `actions/*` and pinned to its verified full SHA. The default workflow token remains read-only.
- Immutable Releases is enabled (`enabled: true`, `enforced_by_owner: false`) only after PR #4 merged. Existing v1.0.0–v1.0.3 remain mutable and are not retroactively trusted; v1.0.4 still has no tag or Release.
- Environment `android-release` exists with a custom deployment branch policy allowing only `main`; it has zero production secrets and no reviewer. GitHub does not offer required Environment reviewers for this private personal repository without Enterprise. A private personal repository has no direct-collaborator read role: `BlueOcean223` still has write and must remain explicitly trusted, be removed, or be reassigned after moving the repository to an organization before production secrets are installed.

### Not locally verified

- `adb devices -l` is empty. Android install, launch, permission prompts, sharing/export, attachment picker, back handling, update-link handoff, and upgrade/uninstall behavior remain unverified on a real device/emulator.
- No real OpenAI, Volcengine Ark, or Alibaba Bailian account/key was used. Live entitlement, billing, provider-side model availability, long-running generation, media upload, and error-shape smoke remain unverified.
- Browser verification is complete for the exported Web artifact; there is no remaining “browser unavailable” gap.
- The fail-closed public Pages pre-release state and future immutable-Release configuration are now proved remotely. Production signing and the valid `release.html`/public APK path remain unproved until a stable signing identity is safely backed up, installed as Environment secrets, and used for the v1.0.4 Release assets.

## Historical interruption point (resolved)

The four items in this section describe the state at the original interruption; all were closed by the continuation evidence above.

The last edit extended `src/services/updateChecker.ts` so update URLs may come only from this repository's exact `github.com` release paths or `https://szdtzpj.github.io/Embezzle-Studio/...` Pages paths. It also added a Pages-path test.

That change is **not yet fully closed**:

1. `scripts/stage-release-for-pages.mjs` still writes `releaseUrl: publicBaseUrl`; it does **not** yet generate the planned `release.html` page containing the verified APK link, SHA-256, size, version, and escaped release notes.
2. The latest update-checker test changes have not been rerun.
3. The current APK was built at 07:50, before the update-checker Pages-path edit at 07:54, so it must be rebuilt once more.
4. README/product/roadmap docs still need a final consistency pass for Web session-only API keys, IndexedDB attachments, image/video/file attachment support, the public release page, and the final verification state.

Start with the release page/stager closure; do not begin by re-auditing completed provider matrices from scratch.

## Implemented work

### Provider protocols

- OpenAI:
  - Chat Completions is the normal path.
  - official `api.openai.com` Responses-only Pro models route to `/responses` without streaming/sampling fields;
  - Responses requests set `store: false` and Pro gets a 10-minute abortable timeout;
  - official GPT reasoning matrices distinguish `none`, `minimal`, `xhigh`, and Pro restrictions;
  - GPT Image uses `output_format`, while DALL-E requests `b64_json` for durable storage;
  - official OpenAI file input now serializes `file` for Chat Completions and `input_file` for Responses, only when the model explicitly has `file-input`; compatible relays are rejected before fetch.
- Volcengine Ark:
  - uses a local official versioned catalog (26 IDs) and never assumes an undocumented bearer `GET /models`;
  - supports manual Model ID/Endpoint ID;
  - correct `thinking` and `reasoning_effort` mappings, including current GLM/DeepSeek matrices;
  - custom profiles pointed at the official Ark host use the same protocol;
  - Seedance task submission/query, image/video references, terminal expired/cancelled handling.
- Alibaba Bailian:
  - distinguishes mixed-thinking and thinking-only Qwen/QwQ/QVQ/DeepSeek/GLM families;
  - no invented off/budget values for thinking-only models;
  - GLM effort mapping fixed;
  - `temperature=2` and `top_p=0` are normalized to Bailian-valid `1.99` and `0.01` at the final wire boundary;
  - inline video Data URL is rejected before Base64 materialization when it would exceed 10 MiB; public URL remains supported.

### App state and storage

- Abort/stop lifecycle, throttled streaming UI, preservation of streamed partials.
- Context building uses a token/context-aware helper rather than a fixed last-12 slice.
- Persistence is versioned, serialized, backed up, corruption-recoverable, and fail-closed on native SecureStore failure.
- A workspace load failure now enters persistent read-only mode; mutations are guarded and a durable error banner is shown.
- Historical messages with a deleted explicit `providerId` no longer fall back to the active provider.
- Regenerate/edit-rerun restores the original branch on request failure/cancel; removed attachments are queued only after success. Explicit destructive branch operations confirm first.
- Web API keys migrate out of persistent AsyncStorage/localStorage and are kept only in the current tab session; Android uses SecureStore.
- Native attachments use app-owned document storage. Web attachments use IndexedDB Blob storage and short-lived `blob:` preview URLs rather than embedding Base64 in the workspace JSON.
- Physical deletion is committed only after a successful workspace snapshot no longer references the attachment. Uncommitted picker failures are reclaimed immediately.
- Generated images/videos are copied to durable storage when possible; temporary provider URLs surface an expiry/export warning.
- `expo-sharing` is installed so local Android media/files use the system export/share sheet rather than unreliable direct `file://` opening.

### UI/product behavior

- Clipboard works on native/Web; auto-scroll respects users reading older content; Android back closes overlays.
- Per-model task and capability overrides persist.
- Image/video/file attachment entries are capability-gated; file input is additionally restricted to official OpenAI.
- Embedding/rerank models can be inspected but the chat composer is explicitly disabled until a dedicated workflow exists.
- Sampling controls are shown only for chat tasks and warn that active reasoning suppresses unsupported sampling parameters.
- Core icon controls and the custom parameter slider received accessibility labels/value/actions.
- Update UI opens a trusted release page rather than pretending to verify/install a direct APK itself.

### Security and release

- Base URLs require HTTPS except loopback; response sizes, timeouts, aborts, model-list bounds, and SSE parsing were hardened.
- Development proxy strips dangerous headers and now trusts only the exact Expo Web origin (default port 8081 or the explicit `--port` propagated by `start-web.mjs`), rather than every localhost port.
- App version is `1.0.4`, Android `versionCode` is `4` in `app.json`, `package.json`, `package-lock.json`, and `src/data/appInfo.ts`.
- `android.permission.SYSTEM_ALERT_WINDOW`, CAMERA, and RECORD_AUDIO are blocked/absent from the built APK.
- Android workflow builds unsigned, signs only inside protected `android-release`, rejects missing secrets/debug cert/wrong fingerprint, verifies zipalign/apksigner, publishes SHA and signing report, accepts only stable releases/tags reachable from `origin/main`, enforces increasing versionCode, and refuses to overwrite existing release assets.
- Pages write/id-token permissions are scoped only to the deploy job.

## Historical evidence before continuation

- `npm.cmd run check`: passed after OpenAI file support — 11 test files, 163 tests, TypeScript and ESLint zero warnings. This was **before** the final Pages URL test edit, so rerun it.
- `npm.cmd run build:web`: passed earlier — 3185 modules, 6.9 MB main Web bundle. This was before some later edits, so rerun it.
- `npx.cmd expo-doctor`: 20/20 earlier. Rerun after all dependency/config changes.
- clean Expo Android prebuild: passed.
- Android Release build: passed after native cache cleanup.
- Built artifact (now stale only with respect to the final update-checker edit):
  - package: `com.szdtzpj.embezzlestudio`
  - version: `1.0.4`, versionCode `4`
  - minSdk `24`, targetSdk `36`
  - size `92,978,685` bytes
  - SHA-256 `56DFC46C1A823A9C6C1F8C85367F335AF54976A4EEA50534138F8825E15B2AFB`
  - permissions contain INTERNET, legacy storage maxSdk32, VIBRATE, biometric/fingerprint; no overlay/camera/microphone.
  - local Release uses Android Debug cert by generated local config. This is only a build-validation artifact; CI intentionally removes debug signing and applies the protected production key.
- GitHub workflow YAML parses, and every Android embedded Bash block passes `bash -n`.
- `npm audit --omit=dev --audit-level=high` exits 0. There are 11 moderate transitive `uuid -> xcode -> @expo/config-plugins` advisories; `npm audit fix --force` proposes incompatible/breaking Expo package changes and must not be applied blindly.
- No Android device is connected (`adb devices` empty), so install/runtime smoke remains unexecuted.
- In-app browser automation was unavailable in the prior session, so visual click/screenshot regression remains unexecuted; do not claim it passed.

## Historical next actions (completed locally)

1. Finish `scripts/stage-release-for-pages.mjs`:
   - generate `dist/release.html` only after APK bytes match the published `.sha256`;
   - use escaped text for release name/body and URL-safe APK link;
   - show version, size, full SHA-256, and a clear download button;
   - set manifest `releaseUrl` to `${publicBaseUrl}/release.html` for a valid release;
   - keep fail-closed `apk: null` behavior when release/assets/checksum are absent.
2. Add or adjust tests for the stager/update URL pinning if practical; at minimum run the script against its 404/fail-closed path in a temporary output directory and inspect JSON/HTML.
3. Update README and docs for the current behavior and release workflow. Remove the stale statement that local video upload has no UI.
4. Run:
   - `npm.cmd run check`
   - `npm.cmd run build:web`
   - `npx.cmd expo-doctor`
   - `git diff --check`
   - YAML parse and embedded `bash -n` checks again.
5. Run clean Android prebuild and `assembleRelease` with:
   - `NODE_ENV=production`
   - `ANDROID_HOME=C:\Users\555\AppData\Local\Android\Sdk`
6. Inspect the final APK with latest Android build-tools `aapt.exe` and `apksigner.bat`; confirm version 1.0.4/code4 and absence of overlay/camera/microphone.
7. Review `git status`/diff for accidental generated artifacts or secret material. Do not push, tag, create a Release, or configure secrets without explicit user authorization.

## External/manual release boundary

These are the remaining user/security boundaries after the remote work above:

- Decide whether to trust the existing write collaborator with no-reviewer release authority, remove that collaborator, or move to an organization/plan that supports a granular role and required reviewers. A private personal repository has no read-only direct-collaborator downgrade. [GitHub's environment limits](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments) make required reviewers public-only on Free/Pro/Team.
- Connect suitable encrypted removable storage, generate and test at least one offline recovery copy of the stable signing identity, then configure the five production secrets:
  - `ANDROID_KEYSTORE_BASE64`
  - `ANDROID_KEY_ALIAS`
  - `ANDROID_KEYSTORE_PASSWORD`
  - `ANDROID_KEY_PASSWORD`
  - `ANDROID_SIGNING_CERT_SHA256`
- After the signing boundary is resolved, create the immutable v1.0.4 tag and stable Release from the exact final `origin/main`, dispatch the Android workflow from `main`, and verify all Release/Pages assets and hashes. Do not create the Release early because the stager always selects the latest stable Release.
- The existing `v1.0.3` APK is debug-signed; the first production-signed release cannot update over it without uninstall/data migration.
- Run representative real-device and real-provider-account smoke tests before calling the production release complete.

## Live-provider and GitHub continuation evidence

- `api_key.txt` is now explicitly ignored by Git. The three supplied credentials were read only from that local ignored file; no key value was printed, staged, committed, placed in a command argument, or copied into a build/Release artifact.
- Low-cost live discovery and text smoke tests completed on 2026-07-10:
  - Volcengine Ark: compatibility `GET /api/v3/models` returned HTTP 200 with 129 raw entries; `doubao-seed-2-0-lite-260428` Chat returned HTTP 200 and non-empty text.
  - Alibaba Bailian: `GET /compatible-mode/v1/models` returned HTTP 200 with 224 entries; `qwen-turbo` Chat returned HTTP 200 and non-empty text. `MiniMax/MiniMax-M3` also accepted the documented `thinking: { type: "disabled" }` request. `kimi/kimi-k2.6` returned a sanitized HTTP 400 `invalid_parameter_error` stating that the product is not activated, so Kimi live inference remains an account boundary rather than a claimed success.
  - The supplied third-party OpenAI-compatible host returned HTML at its root and valid JSON only under `/v1`; the app's existing root normalization matches that behavior. `/v1/models` returned 41 entries and `cc-Doubao-seed-2.0-lite` Chat returned HTTP 200 and non-empty text.
- The observed Ark `/models` response is useful but is **not** listed in the official Ark data-plane API reference. Discovery now probes it only on the exact official Ark host, filters shutdown and unsupported task metadata, labels retiring entries, and falls back to curated candidates maintained from the official model catalog. A `volcengine-ark` profile pointed at any other host never sends its API key during automatic discovery.
- Ark metadata no longer routes 3D, pure speech-to-text, audio-output, unknown structured tasks, pure image-editing, or conflicting tasks into Chat. Manual and remote generation models expose only adapters the app actually implements. Ark reference-video generation and custom-kind profiles on the exact official host use the same protocol; Ark Chat video understanding remains intentionally unavailable until a dedicated input/upload adapter exists.
- Bailian thinking and sampling now distinguish Qwen, DeepSeek, GLM, Kimi, MiniMax, and Stepfun families. `default` remains wire-neutral; MiniMax M3 uses its native thinking object; budget presets are labelled as 1K/4K/8K/16K token caps; namespaced fixed-parameter suppliers hide their controls; and UI ranges/fields share the serializer's constraints.
- Current source validation after these fixes: `npm.cmd run check` passed 12 files / 231 tests, `npm.cmd run build:web` passed (3179 modules, 6.9 MB main bundle), Expo Doctor passed 20/20, all 3 workflow YAML files parsed, all 34 embedded Bash blocks passed `bash -n`, all 15 Action uses remained GitHub-owned full SHAs, and `git diff --check` passed.
- GitHub now has immutable test prerelease [`v1.0.4-debug.1`](https://github.com/szdtzpj/Embezzle-Studio/releases/tag/v1.0.4-debug.1) from main SHA `54f7ef75b924aeec072befe761734a37bc9be5b5`. Its debug-signed APK is 92,979,061 bytes with SHA-256 `945031c481475da160267e2c56a7738dc609d2930ef69136e198392efda1e211`; the release also contains the matching checksum and apksigner report. Stable Latest remains v1.0.3. Because this prerelease predates the provider fixes above, it is an intermediate test artifact and must be superseded by a new debug prerelease built from the final merged main.

## Official references already used

- OpenAI Chat Completions: https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
- OpenAI reasoning: https://developers.openai.com/api/docs/guides/reasoning
- OpenAI Responses migration: https://developers.openai.com/api/docs/guides/migrate-to-responses
- OpenAI latest-model parameters: https://developers.openai.com/api/docs/guides/latest-model
- OpenAI image generation: https://developers.openai.com/api/reference/resources/images/methods/generate
- OpenAI vision/files: https://developers.openai.com/api/docs/guides/images-vision
- Ark auth/base URL: https://www.volcengine.com/docs/82379/1298459?lang=zh
- Ark public model catalog / OpenAI compatibility: https://www.volcengine.com/docs/82379/1330310 and https://www.volcengine.com/docs/82379/1330626
- Ark chat: https://www.volcengine.com/docs/82379/1494384?lang=zh
- Ark thinking: https://www.volcengine.com/docs/82379/1449737?lang=zh
- Ark Responses / Responses thinking: https://www.volcengine.com/docs/82379/1569618 and https://www.volcengine.com/docs/82379/1956279
- Ark create/query video: https://www.volcengine.com/docs/82379/1520757?lang=zh and https://www.volcengine.com/docs/82379/1521309?lang=zh
- Bailian compatible chat: https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions
- Bailian compatible Responses: https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-responses
- Bailian deep thinking: https://help.aliyun.com/zh/model-studio/deep-thinking/
- Bailian visual reasoning: https://help.aliyun.com/zh/model-studio/visual-reasoning
- Bailian GLM/DeepSeek: https://help.aliyun.com/zh/model-studio/glm and https://help.aliyun.com/zh/model-studio/deepseek-api
- Bailian Kimi/MiniMax/Stepfun: https://help.aliyun.com/zh/model-studio/kimi-api, https://help.aliyun.com/zh/model-studio/kimi-api-by-moonshot-ai, https://help.aliyun.com/zh/model-studio/minimax-api, https://help.aliyun.com/zh/model-studio/minimax-api-by-minimax, and https://help.aliyun.com/zh/model-studio/stepfun

## Historical continuation prompt (no longer current)

The prompt below is retained only to explain how this continuation was started; do not use it as the current status.

```text
请继续处理 C:\Python_project\EmbezzleStudio。上一次任务被中断，工作树中有大量尚未提交但属于本任务的修改，绝对不要 reset、checkout 或覆盖它们。

先完整阅读 docs/CONTINUATION_CHECKPOINT_2026-07-10.md，并以当前工作树为权威状态。原目标不变：继续对整个 Embezzle Studio 做端到端深度审计和修复，严格核对 OpenAI、火山方舟、阿里百炼官方文档中的模型路由、请求结构、思考强度和参数，不要只做表面检查，也不要重复重做已经完成且有测试证据的部分。

从断点的第一项开始：完成 scripts/stage-release-for-pages.mjs 的可信 release.html 下载页与 manifest releaseUrl 闭环，然后更新文档，跑全量 check、Web export、Expo Doctor、diff/YAML/Bash 检查，再干净 prebuild 并重建 Android 1.0.4 Release，使用 aapt/apksigner 复核版本、权限和签名。当前 APK 比最后的 updateChecker 修改早几分钟，不能当最终产物。

请持续执行到真正的外部/人工边界；不要未经我授权 push、tag、创建 GitHub Release、配置生产密钥或改远端保护规则。最终必须明确区分：已由本机证据验证、尚无设备/浏览器所以未验证、以及需要我在 GitHub/真机/真实服务商账号上完成的事项。
```
