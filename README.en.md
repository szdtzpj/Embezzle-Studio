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

`.github/workflows/android-apk.yml` permits signing only with a stable production key. Before signing, it uses `aapt` from the latest installed Android build-tools to verify the packaged APK's application ID, version, min/target SDK levels, and absence of CAMERA, RECORD_AUDIO, and SYSTEM_ALERT_WINDOW permissions. It no longer treats the debug keystore generated by Gradle as a release key. The workflow fails if any signing secret is missing, the artifact violates its contract, the certificate fingerprint does not match, or an `Android Debug` certificate is detected.

First create the `android-release` environment under `Settings -> Environments` in the GitHub repository, restrict its deployment branch policy to `main`, and configure the following Environment secrets. If the repository or organization plan supports deployment protection rules, also enable required reviewers and `Prevent self-review`. The [official GitHub Environments limitations](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments) state that required reviewers on Free, Pro, or Team are available only for public repositories; Environment secrets and deployment branches/tags in private repositories require at least Pro/Team, while keeping the repository private and gaining required reviewers requires Enterprise. Therefore, if this repository remains a private personal repository on Pro/Team, the only available reduced protection is “allow `main` only, without manual approval.” On Free, even these private-environment secrets and branch restrictions are unavailable. Before adding a production key to the environment, confirm the effective plan capabilities and either trust every collaborator with repository write access or tighten their access first. Do not describe the reduced configuration as equivalent to two-person approval.

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
4. Create the same-name GitHub Release as a non-draft, non-prerelease release first, then manually run the Android workflow from the default `main` branch.
5. The workflow checks out the tag's commit, builds an unsigned APK, uses the production keystore with `zipalign` and `apksigner`, verifies the certificate fingerprint, creates a `.sha256` file, and finally attaches the APK and verification files to the Release. End the release freeze only after this workflow and the automatically triggered Pages workflow both succeed and the public bytes have been verified.

Example:

```powershell
git fetch origin
$mergeSha = git rev-parse origin/main
git tag -a v1.0.4 $mergeSha -m "Embezzle Studio v1.0.4"
git push origin v1.0.4
gh release create v1.0.4 --repo szdtzpj/Embezzle-Studio --verify-tag --title "Embezzle Studio v1.0.4" --generate-notes
gh workflow run android-apk.yml --repo szdtzpj/Embezzle-Studio --ref main -f release_tag=v1.0.4
```

The existing APKs for `v1.0.3` and earlier use generated debug signing. They are test packages only and cannot serve as the trust anchor for production releases. Android will not allow a newly production-signed APK to replace these debug-signed installations directly. Migration requires uninstalling the test package, which clears the app's local data, or designing a separate data-migration path before the production release.

The in-app update check does not carry a GitHub token. A private repository's Releases API and download pages return `404` to ordinary app users, so after a signed release succeeds, the Pages workflow runs again automatically and processes the latest stable Release through `scripts/stage-release-for-pages.mjs`. The script selects only an asset named exactly `Embezzle-Studio-${tag}-release.apk` and requires either a same-name `.apk.sha256` file or an entry in `SHA256SUMS` bound to that exact APK filename. Only after the APK's actual bytes match this digest exactly does the script stage the APK in the public Pages artifact, generate a trusted `release.html` download page, and point `releaseUrl` in `release-manifest.json` to that page. The download page displays the version, file size, full SHA-256 digest, and HTML-escaped release notes; the APK name is URL-encoded as one path segment.

If the expected APK or checksum is missing, the script generates only a fail-closed manifest with `apk: null` and does not generate the download page. A digest mismatch, an untrusted source URL, an APK over 256 MiB, or a checksum file over 64 KiB fails the Pages build; both declared response sizes and the bytes actually consumed from the stream are bounded. The download page also makes clear that a matching SHA-256 only proves that the public bytes match the Release checksum file; it does not replace the workflow's `apksigner` verification against the production certificate. The client reads only the fixed public manifest, accepts only exact GitHub Release paths for this repository or constrained paths under `https://szdtzpj.github.io/Embezzle-Studio/`, shows the digest in Settings, and then opens the trusted release page rather than installing an APK directly. Never embed a GitHub PAT in the client.

Uploading multiple GitHub Release assets is not transactional. If only some of the APK, `.sha256`, and `apksigner-report.txt` assets were uploaded, the workflow refuses to overwrite them and stops. A maintainer must inspect the existing assets on the Release page, delete only the incomplete assets confirmed to belong to that failed run, and then rerun the workflow. Do not enable overwriting published assets merely to make retries automatic.

## Docs

- [Product and Architecture](./docs/product-architecture.md)
- [Provider Protocol Matrix](./docs/provider-protocols.md)
- [Roadmap](./docs/roadmap.md)
