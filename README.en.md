<p align="center">
  <img src="./assets/brand-mark.png" width="280" alt="Embezzle Studio Logo" />
</p>

<h1 align="center">Embezzle Studio</h1>

<p align="center">
  <strong>Bring your models, knowledge, and creative work into one mobile workspace you control.</strong>
</p>

<p align="center">
  A BYOK multi-model chat, creation, and local-knowledge workspace for Android
</p>

<p align="center">
  <a href="https://szdtzpj.github.io/Embezzle-Studio/release.html"><img alt="Latest Release" src="https://img.shields.io/github/v/release/szdtzpj/Embezzle-Studio?display_name=tag&amp;sort=semver&amp;style=for-the-badge&amp;color=7C3AED" /></a>
  <a href="https://github.com/szdtzpj/Embezzle-Studio/actions/workflows/quality.yml"><img alt="Quality" src="https://img.shields.io/github/actions/workflow/status/szdtzpj/Embezzle-Studio/quality.yml?branch=main&amp;style=for-the-badge&amp;label=quality" /></a>
  <img alt="Android 24+" src="https://img.shields.io/badge/Android-24%2B-3DDC84?style=for-the-badge&amp;logo=android&amp;logoColor=white" />
  <img alt="BYOK" src="https://img.shields.io/badge/BYOK-user--funded-0EA5E9?style=for-the-badge" />
</p>

<p align="center">
  <a href="https://szdtzpj.github.io/Embezzle-Studio/release.html"><strong>Download for Android</strong></a>
  · <a href="./docs/local-knowledge-workbench.md">Local Knowledge Workbench</a>
  · <a href="./docs/product-architecture.md">Architecture &amp; Trust Boundaries</a>
  · <a href="./README.md">简体中文</a>
</p>

<table>
  <tr>
    <td width="50%" valign="top"><strong>🔑 Bring your own providers</strong><br /><sub>Model, search, voice, and media calls use the user's own endpoint, API key, quota, and billing.</sub></td>
    <td width="50%" valign="top"><strong>🛡️ Local-first</strong><br /><sub>Projects, conversations, artifacts, references, search, and cost estimates stay on-device without an Embezzle Studio server.</sub></td>
  </tr>
  <tr>
    <td width="50%" valign="top"><strong>⚡ One multi-model workspace</strong><br /><sub>Manage OpenAI-compatible APIs, Volcengine Ark, Alibaba Bailian, and personal relays with explicit multi-model comparison.</sub></td>
    <td width="50%" valign="top"><strong>📚 From chat to durable work</strong><br /><sub>Turn answers into versioned artifacts and project references, then inspect exact context and token risk before sending.</sub></td>
  </tr>
</table>

## Current Features

- Provider configuration: supports OpenAI-compatible APIs, Volcengine Ark, Bailian compatible mode, New API relays, and custom relay endpoints. The local `1.2.0` setup wizard validates provider kind, endpoint, and key binding in an independent draft. Changing the kind or canonical endpoint clears the old key, models, and candidates before any discovery request, so a credential is not reused against a new destination. Bailian Coding Plan/Token Plan endpoints that are not permitted for custom applications are blocked.
- Model discovery: OpenAI and compatible providers attempt to use their model-list endpoints. Volcengine Ark probes the undocumented compatibility `/models` response only on an exact official data-plane host, falls back to curated candidates maintained from the official catalog when the probe is unavailable or incompatible, and always allows manual Model ID or Endpoint ID entry.
- Model selection: the chat page lists added models by provider and lets users switch the currently active model. An evidence-backed capability matrix separates provider/model declarations from protocols actually implemented and tested by this client; a catalog label alone never proves adapter support.
- Conversation protocols: Chat Completions streams by default; OpenAI Responses-only Pro models automatically switch to the non-streaming `/responses` protocol, with token usage recorded.
- Multi-model comparison: 2–4 user-provider models can answer one prompt independently, share one cancel lifecycle, survive partial failure, and expose one explicitly selected answer to later conversation context. The UI states the number of provider-billed calls before sending.
- Evidence-backed web search: the user's key calls official OpenAI, Volcengine Ark, or Alibaba Bailian Responses search protocols. The UI claims a search only when the response contains a search call, a valid citation, or Bailian search-count evidence, and renders HTTPS sources as visible links.
- Reasoning settings: reasoning effort is saved per exact model family, with distinct support for `off`, `none`, `minimal`, `xhigh`, and `max`, and is mapped separately to the OpenAI, Volcengine Ark, and Bailian protocols.
- Parameter tuning: only provider/model parameters and ranges implemented on the wire are shown. Active reasoning or fixed-parameter models display an explicit notice or hide ineffective controls; disabling tuning leaves values to provider defaults.
- Multimodal entry points: image, video, and file pickers are shown according to model capabilities. Images can be sent to vision models; Bailian compatible mode supports bounded local-video `video_url` input; file input is available only to explicitly `file-input`-capable official OpenAI models. The app also supports text-to-image generation and submitting and later querying Volcengine Ark video tasks with reference images or videos.
- Media preview and export: pending images render as square thumbnails. Videos in conversations use native `expo-video` controls for inline playback and fullscreen. The video filename and Save/Share controls live in a separate action area; Android saves through the system Storage Access Framework directory picker, Web uses a browser download, and other native platforms fall back to the system share sheet.
- Android layout and navigation: the main chat surface and rename dialog avoid the software keyboard, while Android uses `resize` window behavior. Chat stays mounted when Settings opens, Settings is reused after its first mount, and remote model candidates render in bounded batches to reduce page-switch and large-list pressure.
- Local project workspaces: projects, project instructions, default models, and conversation membership stay on-device. Deleting a project explicitly migrates its conversations and requires no Embezzle-owned sync service.
- Local artifact workbench: `1.3.0` can capture a message as a project artifact or create Markdown/plain-text/code/JSON/HTML artifacts. Edits append bounded revisions, restoring an old revision creates a new revision without erasing later history, and the active revision supports bounded line diffs and export. HTML exports as `.html.txt`/`text/plain`; scripts, code, and network previews are not executed.
- Project references and local search: users can author text, capture message/artifact snapshots, or import supported plain-text/code files. Project search and chunking are bounded and device-local. PDF/Word/Excel/PowerPoint/OpenDocument parsing is not supported, and this is not advertised as vector RAG, automatic memory, or a cloud knowledge base.
- Explicit context control: project sources can enter a chat request only after they are selected for that conversation. The inspector shows conservative text-token estimates, actually included/trimmed/excluded/pinned messages, attachment uncertainty, and included/omitted sources. Comparison targets share one smallest-window transcript; image/video adapters receive only the newest prompt. Compression only creates an editable draft and never calls a provider automatically.
- Conversation history and global search: local conversations support pin, rename, share, and delete actions. A bounded literal search spans projects, templates, conversations, and messages without sending its query or indexed text to a provider.
- Message actions and conversation branches: native/Web copy, share, stop, partial-stream retention, regenerate, edit, causal deletion, and local branching from any message are supported. A branch receives new message/comparison-group IDs and carries canonical `originMessageId` values so usage analytics and the task center do not count cloned history twice.
- Local productivity and cost controls: prompt/persona templates, a cross-conversation media-task center, token/latency analytics, user-entered price estimates, and the cost guard all run on-device. The guard can cap output tokens, daily request attempts, comparison targets, and confirm potentially multi-charge actions. CNY/USD thresholds inspect only the day's already completed, locally known subtotal and warn/block the next request after that subtotal reaches the threshold; they do not project whether the current request will cross it. The local attempt ledger keeps unknown costs unknown rather than treating them as zero and is not a provider bill.
- Request-based voice: Android can use the user's official OpenAI or Bailian account for transcription and synthesized read-aloud. Transcription edits the composer without auto-sending; generated speech is cached locally and disclosed as AI-generated. Ark keys are never misused as Volcengine speech credentials.
- Encrypted backup and MCP safety: password-protected local exports exclude structured API-key/MCP-authorization fields, media, and the device-local attempt ledger `providerUsageEvents`. Ordinary conversations, prompts, templates, and error text are exported as authored, so secrets must not be pasted into those fields. Android automatic app backup is disabled, so device migration should use the explicit authenticated encrypted export; the historical `1.2.0` candidate and final local `1.3.0` candidate independently verify `android:allowBackup="false"`. Remote MCP configuration is disabled by default and permission-gated; tool execution remains fail closed until a provider-specific per-call approval loop is complete.
- Update checks: checks a fixed public Pages manifest for version and verified APK metadata, then opens a trusted release page. The app does not present itself as an APK verifier or installer.
- Local storage: Android API keys use SecureStore. Web API keys remain only in the current tab's `sessionStorage`/memory, and legacy persistent values are migrated and removed. The workspace uses versioned AsyncStorage snapshots with backups; native attachments are copied into the app's files directory, while Web attachments are stored as Blobs in IndexedDB so large Base64 payloads are not written into workspace JSON.

## Still Being Improved

The pending release is `1.3.0` / Android versionCode 9 and has a locally verified candidate. Public stable remains `v1.0.6` until the exact tag, protected Android workflow, Immutable Release, and Pages download chain all complete. The existing local `1.2.0` candidate is historical evidence for the previous development phase, not a `1.3.0` APK or a public Release asset.

Embezzle Studio does not buy, resell, subsidize, or proxy model, search, voice, or media capacity, and operates no production API, exchange-rate service, cloud sync, telemetry backend, or task worker. Every provider call and charge belongs to the user-configured account. The local cost guard performs no FX conversion, and its estimates/attempt ledger cannot replace the provider's bill.

- Chat video attachments currently implement `video_url` transport only for Bailian compatible mode; other providers still require their own upload, transcoding, or reference protocols.
- The user has confirmed on one Android phone that the main IME-avoidance, Seedance preview/download, image-sizing, and Chat/Settings-switching paths are fixed. Additional devices, system-directory cancellation/failure/low-space behavior, remote-media expiry, and sustained stress still require acceptance; Web evidence does not replace those extended native checks.
- Remote MCP configuration and permission confirmation are implemented, but the actual tool-call/approval-response loop is not enabled yet.
- Search and voice wire contracts have automated coverage, while paid-product activation, real billing evidence, microphone/playback behavior, and sustained parallel use still need representative provider accounts and Android devices.
- The official OpenAI API does not return the original hidden chain of thought; the app can only display returned reasoning summaries, `reasoning_content`, or token usage.
- Building an Android installation package requires a local Android toolchain, or a CI/EAS-based build flow.

## Attachment Limits and Storage Boundaries

- A pending message can contain at most 6 attachments. Each image is limited to 10 MiB and 32 megapixels, each video to 100 MiB, each ordinary file to 20 MiB, and all attachments combined to 120 MiB.
- A local Bailian video is converted to a Base64 Data URL before sending. The complete encoded Data URL must also remain within 10 MiB, so the picker's general 100 MiB video limit does not mean Bailian inline requests can send videos of that size. Use a provider-supported public HTTPS URL or an external upload flow when this limit is exceeded.
- Web attachments persist as IndexedDB Blobs; the UI creates short-lived `blob:` URLs only for previews. Native attachments persist in the app-owned documents directory. When an attachment is deleted, its physical data is removed only after a new workspace snapshot has been saved successfully and no longer references it.
- File attachments are sent only to the official OpenAI API: Chat Completions uses `file` content, while Responses uses `input_file`. Compatible relays are not assumed to support the same file protocol.

## Tech Stack

- Expo SDK 57
- React Native 0.86
- React 19.2
- TypeScript 6
- React Native Reanimated
- React Native Gesture Handler
- Expo Video
- Expo Audio
- Expo Crypto + Noble Ciphers/Hashes
- AsyncStorage
- SecureStore

## Local Development

```powershell
npm.cmd ci
npm.cmd run typecheck
npm.cmd run test
npm.cmd run lint
npm.cmd run build:web
npm.cmd start
```

For Web debugging, use:

```powershell
npm.cmd run web
```

The proxy started by this command is for local development only: it listens only on loopback and accepts only the exact origin of the current Expo Web session. It can still access any user-configured HTTP(S) upstream on behalf of that page, so it must not be deployed as a production proxy, and untrusted scripts must not run on the same development origin.

Pull Requests and pushes to `main` trigger `.github/workflows/quality.yml`. Changes should be merged only when dependency installation, TypeScript checks, tests, Lint, and the Web build all pass. Configure `Quality / Typecheck, test, lint, and build web` as a required check on `main` where the repository plan supports it.

## Android Production Signing and Release

`.github/workflows/android-apk.yml` permits only the repository owner to sign from `main` with a stable production key. The `contents: write` permission needed to inspect an owner-authored Draft exists only in the short `release_contract` preflight job; preflight and publication are both constrained by the main-only `android-release` Environment, while the npm/Expo/Gradle build retains the repository-wide `contents: read` permission and does not persist checkout credentials. Before signing, pinned Android Build Tools 36.0.0 verifies the APK identity, version, SDK levels, forbidden permissions, and absence of a pre-existing valid signature. After signing, exactly one non-debug signer must match the pinned fingerprint. Missing secrets or any artifact, toolchain, or certificate mismatch fails closed. Every official Action uses a GitHub-verified latest-stable full SHA on the Node 24 generation.

The first production-signed release, [`v1.0.4`](https://github.com/szdtzpj/Embezzle-Studio/releases/tag/v1.0.4), first exercised the production-signing, immutable Release, and trusted Pages chain on 2026-07-10. The current stable Latest is [`v1.0.6`](https://github.com/szdtzpj/Embezzle-Studio/releases/tag/v1.0.6): protected [Android run `29092367202`](https://github.com/szdtzpj/Embezzle-Studio/actions/runs/29092367202) rebuilt exact commit `888db913c154fc60fdc7fa4b9de947be55ab10c0` and signed a 96,805,335-byte APK with SHA-256 `1a1fa2d5dc2bac2293994a92e0e65e7033bb4006082e503125d580c778d104f9`. The production certificate remains SHA-256 `F5746B0DC5BD3F6E640F693FDE171BD0CD87A919998CD6CA3F8F26748ABE6C02`. The Release attestation, all three downloaded assets, checksum, GitHub asset digests/uploaders, `aapt`, `apksigner`, zipalign, and the anonymous public APK bytes after [Pages run `29094337390`](https://github.com/szdtzpj/Embezzle-Studio/actions/runs/29094337390) were independently verified; the public entry point is the [trusted download page](https://szdtzpj.github.io/Embezzle-Studio/release.html).

The published `1.0.6` / Android versionCode 6 includes the earlier `1.0.5` keyboard, image/video preview, export, and page-switch fixes. The model-picker `Modal` now consumes the real bottom safe-area inset and lets its list shrink, keeping the last model row above three-button navigation controls. The Expo template icon and construction grid are replaced by one double-ribbon S identity across the app, adaptive and monochrome Android icons, favicon, and an explicit `expo-splash-screen` launch screen. The three bouncing pending dots are replaced by one folding glyph.

The `1.0.6` release source passes `npm.cmd run check` (15 test files, 252 tests, with zero TypeScript or ESLint errors/warnings), the Web export (3137 modules, 6.9 MB main bundle), Expo Doctor 20/20, and `expo install --check`. A clean 390×844 exported-Web session covered Chat, the model picker, Settings, and return navigation with zero console errors or warnings. A separate delayed loopback response exercised the new folding glyph and completed with the expected assistant text. All 3 workflow YAML files and 35 embedded Bash blocks also pass parsing/`bash -n`.

The pre-publication, production-signed local candidate remains under `D:\EmbezzleStudio-Releases\v1.0.6-candidate`; it proves the final source and production certificate also pass the local toolchain but is not a public asset. The three formal GitHub assets were downloaded to `D:\EmbezzleStudio-Releases\v1.0.6`. `aapt` identifies the formal APK as `com.szdtzpj.embezzlestudio` version `1.0.6`/versionCode 6 with minSdk 24 and targetSdk 36. `apksigner` reports exactly one signer with production certificate SHA-256 `F5746B0DC5BD3F6E640F693FDE171BD0CD87A919998CD6CA3F8F26748ABE6C02`; APK Signature Schemes v2/v3 and zipalign pass, with no overlay, camera, or microphone permission. The user confirmed the four earlier main paths on an Android phone and subsequently authorized publication; that authorization is not a connected-device test log for the final Actions-built APK. `adb devices -l` remains empty, so the new system inset, launcher/themed icons, splash, native animation, additional-device coverage, SAF cancellation/failure/low-space paths, remote-media expiry, and sustained stress remain open for independent verification.

The historical `1.2.0` / versionCode 8 development build passed its local quality gate, Web export and 390×844 browser regression, Expo Doctor 20/20, three workflow YAML files, 35 Bash blocks, clean Android prebuild/Release assembly, and production-certificate candidate signing. The candidate APK is `D:\EmbezzleStudio-Releases\v1.2.0-candidate\Embezzle-Studio-v1.2.0-candidate-release.apk`, 97,313,239 bytes, SHA-256 `872f32a48320f2a20dadee6fc0f699668666d067a60e546a19467ed922082da0`. `aapt` and the packaged Manifest verify its identity, SDKs, intentional `RECORD_AUDIO`, and `allowBackup=false`; camera and overlay are absent. `apksigner` verifies exactly one expected production signer, v2/v3, and zip alignment. This is evidence for the previous source tree, not `1.3.0`, a GitHub Release, or a public APK.

The final local `1.3.0` gate passes: `npm.cmd run check` reports 38 test files / 634 tests with clean TypeScript and ESLint, while the Web export reports 3,259 modules / a 7.4 MB main bundle. A fresh 390×844 exported-Web session verified inert HTML `.html.txt` export/content, artifact version history, artifact-to-knowledge capture, bounded local search, explicit source selection changing the actual count from 0 to 1, and context compression producing a draft without sending. It recorded 0 console errors, 0 warnings, and no non-static requests. `expo install --check`, Expo Doctor 20/20, 3 YAML workflows, 35 Bash blocks under `bash -n`, 16 official Actions pinned to full SHAs, and diff/secret-boundary checks pass. Final audit fixes include conservative Unicode/emoji token gating, ID/Unicode round trips, fail-closed aggregate storage budgets, bounded backup sizing, endpoint-secret rejection, and atomic import replacement.

Clean prebuild, `clean assembleRelease`, and local production signing pass. The candidate is `D:\EmbezzleStudio-Releases\v1.3.0-candidate\Embezzle-Studio-v1.3.0-candidate-release.apk`, 97,448,407 bytes, SHA-256 `c95dafe6e6eb77f3a1a4c7504c6ad05c27218b45972de2e247db264ec4c777d4`. It identifies as `com.szdtzpj.embezzlestudio` version `1.3.0`/code 9, minSdk 24/targetSdk 36, `allowBackup=false`, intentional `RECORD_AUDIO`, and no CAMERA or `SYSTEM_ALERT_WINDOW`. Exactly one expected production signer is present with certificate SHA-256 `F5746B0DC5BD3F6E640F693FDE171BD0CD87A919998CD6CA3F8F26748ABE6C02`; v2/v3 and zipalign pass.

`adb devices -l` is empty, so this run claims no Android-device or real-provider-account/billing acceptance. At the time the local-candidate evidence was recorded, `1.3.0` had not been tagged, uploaded, released through GitHub, staged to Pages, or made public. Use the dynamic badge above and the [trusted download page](https://szdtzpj.github.io/Embezzle-Studio/release.html) for the later public state. See [Local Knowledge and Artifact Workbench](./docs/local-knowledge-workbench.md) for the capability/security contract and the [`1.3.0` continuation checkpoint](./docs/CONTINUATION_CHECKPOINT_2026-07-12_V1.3.md) for complete local evidence and external boundaries.

This repository now has the `android-release` environment under `Settings -> Environments`, restricts its deployment branch policy to `main`, and has the five Environment secrets below configured; the table and commands also serve as the environment-rebuild or key-rotation runbook. The [official GitHub Environments limitations](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments) require at least Pro/Team for private-repository Environment secrets and deployment branch/tag policies, make required reviewers public-only on Free/Pro/Team, and require Enterprise for that reviewer gate on a private repository. A direct collaborator on a private personal repository also has no read-only role to downgrade to. By maintainer decision, `BlueOcean223` remains an explicitly trusted write collaborator, accepting the residual lack of two-person approval. Do not describe the `main` restriction and owner workflow gate as equivalent to two-person approval.

| Secret | Contents |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Base64 text of the release keystore file |
| `ANDROID_KEY_ALIAS` | Production signing alias in the keystore |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_PASSWORD` | Alias private-key password |
| `ANDROID_SIGNING_CERT_SHA256` | SHA-256 fingerprint of the production certificate, with or without colons |

Generate a long-lived keystore once, outside the repository:

```powershell
keytool -genkeypair -v `
  -storetype PKCS12 `
  -keystore "$HOME\embezzle-studio-release.p12" `
  -alias embezzle-studio `
  -keyalg RSA `
  -keysize 4096 `
  -validity 10000

$keystore = (Resolve-Path "$HOME\embezzle-studio-release.p12").Path
[Convert]::ToBase64String([IO.File]::ReadAllBytes($keystore)) | Set-Clipboard
keytool -list -v -keystore $keystore -alias embezzle-studio | Select-String 'SHA256'
```

Save the Base64 text from the clipboard as `ANDROID_KEYSTORE_BASE64`, and save the SHA-256 fingerprint printed by `keytool` as `ANDROID_SIGNING_CERT_SHA256`. The compatible PKCS12 path across the Android/JDK toolchain requires the key password and store password to use the same strong random value, so both GitHub password secrets should contain that same value. Never write the keystore, its Base64 text, or its password into the repository, a Release, Actions logs, or ordinary build artifacts. Keep at least two encrypted offline backups. If the production key is lost, existing users will not be able to upgrade in place to APKs signed by a new key.

For each release, follow this order:

1. Update `expo.version` in `app.json`, increment `android.versionCode`, and update the versions in `package.json`, `package-lock.json`, and `src/data/appInfo.ts` together.
2. Pass the same quality checks locally as CI, merge through a Pull Request into `main`, and wait for both Quality and the push-triggered Pages workflow on that merge commit to succeed.
3. Pause other `main` merges and newer-version Releases. Create and push a tag matching the application version, such as the current development version `v1.3.0`, from the exact latest `origin/main` commit.
4. Confirm Immutable Releases is enabled, then have `szdtzpj` create an empty same-name draft that is not a prerelease. Run the Android workflow from the default `main` branch; never publish an empty Release first.
5. The workflow requires the tag to equal the exact current `origin/main`, builds and signs the APK, and rechecks the tag/main commit plus every GitHub asset digest, state, and uploader both before and after freezing the draft as the latest immutable Release. End the freeze only after Android, the automatically triggered Pages deployment, the Release attestation, and the public APK byte checks all succeed.

Example:

```powershell
git fetch origin
$mergeSha = git rev-parse origin/main
git tag -a v1.3.0 $mergeSha -m "Embezzle Studio v1.3.0"
git push origin v1.3.0
gh api --method PUT repos/szdtzpj/Embezzle-Studio/immutable-releases
gh release create v1.3.0 --repo szdtzpj/Embezzle-Studio --verify-tag --draft --title "Embezzle Studio v1.3.0" --notes "Android production release v1.3.0."
gh workflow run android-apk.yml --repo szdtzpj/Embezzle-Studio --ref main -f release_tag=v1.3.0
```

The Release title, body, and publication time are copied into the public Pages manifest and download page. Review them as public content before creating the draft, never include private repository, account, customer, or secret information, and do not use automatically generated release notes without inspecting them first.

The APKs for `v1.0.3` and earlier, plus the `v1.0.4-debug.*` prereleases, use generated debug signing. They are test packages only and cannot serve as the production trust anchor. Before moving to production `v1.0.4` or later, export important data, uninstall the test package (which clears local app data), and install the production APK; Android cannot replace those debug-signed installations directly with the production certificate.

The in-app update check carries no GitHub token. After signing succeeds, Pages processes the latest stable Release through `scripts/stage-release-for-pages.mjs`. It accepts only an owner-published GitHub Immutable Release whose exact APK and checksum assets are uploaded by `github-actions[bot]`, are in the uploaded state, and carry GitHub SHA-256 digests. It then downloads both assets, recomputes their digests, and binds the checksum entry to the exact `Embezzle-Studio-${tag}-release.apk` filename before staging any public download or `release.html` page.

If the expected APK or checksum is missing, or the Release/asset source URL, state, uploader, or digest metadata does not satisfy the trust contract, the script generates only a fail-closed manifest with `apk: null` and removes stale managed downloads. Actual bytes that disagree with the GitHub digest/checksum, an APK over 256 MiB, or a checksum file over 64 KiB fail the Pages build; both declared response sizes and the bytes actually consumed from the stream are bounded. The download page also makes clear that an Immutable Release plus matching GitHub asset digests and checksum still does not replace the workflow's `apksigner` verification against the production certificate. The client reads only the fixed public manifest, accepts only exact GitHub Release paths for this repository or constrained paths under `https://szdtzpj.github.io/Embezzle-Studio/`, and reports an available update only when a trusted install asset is present and its version is newer. It shows the digest in Settings and opens the trusted release page rather than installing an APK directly. Never embed a GitHub PAT in the client.

Uploading multiple Release assets is not transactional. The workflow uploads only into an empty owner-authored draft and attempts to remove expected partial assets written by `github-actions[bot]` after failure; assets from another uploader or states that cannot be cleaned automatically still require manual review. Only a fully verified three-asset draft is published, and the immutable snapshot's refs, exact asset set, digests, states, and uploaders are verified again after publication. GitHub then locks the Release's tag and assets and generates its attestation; published assets are never overwritten for automatic retry.

## Docs

- [Product and Architecture](./docs/product-architecture.md)
- [Provider Protocol Matrix](./docs/provider-protocols.md)
- [BYOK Productivity Suite](./docs/byok-productivity-suite.md)
- [Roadmap](./docs/roadmap.md)
