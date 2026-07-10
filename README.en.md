# Embezzle Studio

[简体中文](./README.md) | [English](./README.en.md)

Embezzle Studio is an Android-focused mobile AI chat client. The project is still in early development. Its current goal is to bring commonly used OpenAI-compatible APIs, personal relay services, and Chinese model providers into one configurable mobile app for convenient model selection, conversations, and basic multimodal calls on mobile devices.

## Current Features

- Provider configuration: supports OpenAI-compatible APIs, Volcengine Ark, Bailian compatible mode, New API relays, and custom relay endpoints.
- Model discovery: OpenAI and compatible providers attempt to use their model-list endpoints; Volcengine Ark uses candidates from the official versioned model catalog and also supports manually adding a Model ID or Endpoint ID.
- Model selection: the chat page lists added models by provider and lets users switch the currently active model.
- Conversation protocols: Chat Completions streams by default; OpenAI Responses-only Pro models automatically switch to the non-streaming `/responses` protocol, with token usage recorded.
- Reasoning settings: reasoning effort is saved per exact model family, with distinct support for `off`, `none`, `minimal`, `xhigh`, and `max`, and is mapped separately to the OpenAI, Volcengine Ark, and Bailian protocols.
- Parameter tuning: temperature, top_p, repetition penalties, and other sampling parameters can be enabled as needed; when disabled, provider defaults are used.
- Multimodal entry points: image, video, and file pickers are shown according to model capabilities. Images can be sent to vision models; Bailian compatible mode supports bounded local-video `video_url` input; file input is available only to explicitly `file-input`-capable official OpenAI models. The app also supports text-to-image generation and submitting and later querying Volcengine Ark video tasks with reference images.
- Conversation history: historical conversations are saved locally, with search across user and model responses, plus pin, rename, share, and delete actions.
- Message actions: supports native/Web copy, sharing, stopping generation, retaining partial streamed content, regenerating, editing, and causal-branch deletion.
- Update checks: checks a fixed public Pages manifest for version and verified APK metadata, then opens a trusted release page. The app does not present itself as an APK verifier or installer.
- Local storage: Android API keys use SecureStore. Web API keys remain only in the current tab's `sessionStorage`/memory, and legacy persistent values are migrated and removed. The workspace uses versioned AsyncStorage snapshots with backups; native attachments are copied into the app's files directory, while Web attachments are stored as Blobs in IndexedDB so large Base64 payloads are not written into workspace JSON.

## Still Being Improved

- Chat video attachments currently implement `video_url` transport only for Bailian compatible mode; other providers still require their own upload, transcoding, or reference protocols.
- MCP, the plugin system, and web-search providers have not yet been integrated as stable features.
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

`.github/workflows/android-apk.yml` permits only the repository owner to sign from `main` with a stable production key. Before signing, pinned Android Build Tools 36.0.0 verifies the APK identity, version, SDK levels, forbidden permissions, and absence of a pre-existing valid signature. After signing, exactly one non-debug signer must match the pinned fingerprint. Missing secrets or any artifact, toolchain, or certificate mismatch fails closed. Every official Action uses a GitHub-verified latest-stable full SHA on the Node 24 generation.

First create the `android-release` environment under `Settings -> Environments`, restrict its deployment branch policy to `main`, and configure the Environment secrets below. The [official GitHub Environments limitations](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments) require at least Pro/Team for private-repository Environment secrets and deployment branch/tag policies, make required reviewers public-only on Free/Pro/Team, and require Enterprise for that reviewer gate on a private repository. A direct collaborator on a private personal repository also has no read-only role to downgrade to. Therefore `BlueOcean223` must either remain an explicitly trusted write collaborator, be removed, or be reassigned after moving the repository to an organization. Do not describe the `main` restriction and owner workflow gate as equivalent to two-person approval.

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
3. Pause other `main` merges and newer-version Releases. Create and push a tag matching the application version, such as `v1.0.4`, from the exact latest `origin/main` commit.
4. Confirm Immutable Releases is enabled, then have `szdtzpj` create an empty same-name draft that is not a prerelease. Run the Android workflow from the default `main` branch; never publish an empty Release first.
5. The workflow requires the tag to equal the exact current `origin/main`, builds and signs the APK, and rechecks the tag/main commit plus every GitHub asset digest, state, and uploader both before and after freezing the draft as the latest immutable Release. End the freeze only after Android, the automatically triggered Pages deployment, the Release attestation, and the public APK byte checks all succeed.

Example:

```powershell
git fetch origin
$mergeSha = git rev-parse origin/main
git tag -a v1.0.4 $mergeSha -m "Embezzle Studio v1.0.4"
git push origin v1.0.4
gh api --method PUT repos/szdtzpj/Embezzle-Studio/immutable-releases
gh release create v1.0.4 --repo szdtzpj/Embezzle-Studio --verify-tag --draft --title "Embezzle Studio v1.0.4" --notes "Android production release v1.0.4."
gh workflow run android-apk.yml --repo szdtzpj/Embezzle-Studio --ref main -f release_tag=v1.0.4
```

The Release title, body, and publication time are copied into the public Pages manifest and download page. Review them as public content before creating the draft, never include private repository, account, customer, or secret information, and do not use automatically generated release notes without inspecting them first.

The existing APKs for `v1.0.3` and earlier use generated debug signing. They are test packages only and cannot serve as the trust anchor for production releases. Android will not allow a newly production-signed APK to replace these debug-signed installations directly. Migration requires uninstalling the test package, which clears the app's local data, or designing a separate data-migration path before the production release.

The in-app update check carries no GitHub token. After signing succeeds, Pages processes the latest stable Release through `scripts/stage-release-for-pages.mjs`. It accepts only an owner-published GitHub Immutable Release whose exact APK and checksum assets are uploaded by `github-actions[bot]`, are in the uploaded state, and carry GitHub SHA-256 digests. It then downloads both assets, recomputes their digests, and binds the checksum entry to the exact `Embezzle-Studio-${tag}-release.apk` filename before staging any public download or `release.html` page.

If the expected APK or checksum is missing, or the Release/asset source URL, state, uploader, or digest metadata does not satisfy the trust contract, the script generates only a fail-closed manifest with `apk: null` and removes stale managed downloads. Actual bytes that disagree with the GitHub digest/checksum, an APK over 256 MiB, or a checksum file over 64 KiB fail the Pages build; both declared response sizes and the bytes actually consumed from the stream are bounded. The download page also makes clear that an Immutable Release plus matching GitHub asset digests and checksum still does not replace the workflow's `apksigner` verification against the production certificate. The client reads only the fixed public manifest, accepts only exact GitHub Release paths for this repository or constrained paths under `https://szdtzpj.github.io/Embezzle-Studio/`, and reports an available update only when a trusted install asset is present and its version is newer. It shows the digest in Settings and opens the trusted release page rather than installing an APK directly. Never embed a GitHub PAT in the client.

Uploading multiple Release assets is not transactional. The workflow uploads only into an empty owner-authored draft and attempts to remove expected partial assets written by `github-actions[bot]` after failure; assets from another uploader or states that cannot be cleaned automatically still require manual review. Only a fully verified three-asset draft is published, and the immutable snapshot's refs, exact asset set, digests, states, and uploaders are verified again after publication. GitHub then locks the Release's tag and assets and generates its attestation; published assets are never overwritten for automatic retry.

## Docs

- [Product and Architecture](./docs/product-architecture.md)
- [Provider Protocol Matrix](./docs/provider-protocols.md)
- [Roadmap](./docs/roadmap.md)
