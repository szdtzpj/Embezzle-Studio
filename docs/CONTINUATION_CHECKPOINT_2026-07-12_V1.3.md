# Continuation Checkpoint — 2026-07-12 (`1.3.0`)

## Identity and publication state

- Evidence-recording branch: `codex/record-v1.3.0-release`.
- Released metadata: `1.3.0`, Android versionCode `9`.
- PR [#13](https://github.com/szdtzpj/Embezzle-Studio/pull/13) merged as exact release commit `ea9409f1ea3540520eaf469a0c777fe1bc87e7f8`; tag `v1.3.0` points to that commit.
- Public stable Latest is now [`v1.3.0`](https://github.com/szdtzpj/Embezzle-Studio/releases/tag/v1.3.0). The Release is immutable, non-prerelease, and contains exactly 3 assets.
- The signed `1.2.0` candidate is historical evidence for the previous source tree. Its bytes, versionCode, signature report, and browser evidence must not be relabeled as `1.3.0` evidence.

## Intended `1.3.0` scope in the working tree

1. Device-local artifacts with inert Markdown/plain-text/code/JSON/HTML content, bounded revision history, append-only restore, bounded diff, export, and message-to-artifact capture.
2. Project-scoped reference sources created manually, captured as message/artifact snapshots, or imported only from supported plain-text/code files.
3. Bounded local text search and context construction. This is not embedding retrieval, vector RAG, a hosted index, or automatic memory.
4. Explicit source selection per conversation before any project reference text can enter a provider request.
5. Context inspection with conservative token estimates, exact included/trimmed/excluded message visibility, causal-turn pin/exclude controls, attachment uncertainty, and selected-source visibility.
6. Workspace schema `v5` migration and authenticated encrypted backup normalization for artifacts and project sources, while keeping structured provider credentials and the local provider-attempt ledger outside exported backups.

The detailed product and security contract is [Local Knowledge and Artifact Workbench](./local-knowledge-workbench.md).

## Non-goals and hard boundaries

- No Embezzle Studio production API, proxy, server, worker, vector database, price/FX service, cloud synchronization, telemetry backend, or app-owned model quota.
- Model/search/voice/media calls, including any future explicit model-assisted compression, use the user's provider endpoint, API key, entitlement, quota, and billing.
- No PDF, Word, Excel, PowerPoint, OpenDocument, media, archive, APK, or executable parser.
- No claim of semantic/vector RAG, automatic memory, automatic project-source selection, or silent background summarization. The compression entry only creates a local, editable prompt draft; it does not silently call a provider.
- Artifact HTML/code is never executed and does not gain network or tool privileges.
- Reference text is data, not a trusted instruction. Prompt-injection-like text cannot be perfectly detected, so source selection remains explicit and reviewable.

## Final local evidence

- Version metadata is synchronized across `app.json`, `package.json`, `package-lock.json`, and `src/data/appInfo.ts`; Android versionCode is `9`.
- The update-checker future-release fixtures use `1.3.1`, keeping them newer than the development version.
- `npm.cmd run check` passes 38 test files / 634 tests; TypeScript and ESLint are clean.
- Final Web export passes at 3,259 modules with a 7.4 MB main bundle. A fresh 390×844 session against the exported build verified inert HTML `.html.txt` export and content, artifact version history, artifact-to-knowledge capture, bounded local search, explicit source selection changing the actual selected count from 0 to 1, and context compression creating a draft without sending it. The console had 0 errors / 0 warnings, and the session made no non-static network requests.
- `npx.cmd expo install --check` passes and Expo Doctor reports 20/20. All 3 workflow YAML files parse, all 35 documented Bash blocks pass `bash -n`, all 16 official Actions use full SHAs, and the diff/secret-boundary checks pass.
- Final audit fixes include a conservative Unicode/emoji token gate, 200/201/256-character entity-ID and Unicode code-point round trips, fail-closed aggregate artifact/knowledge storage budgets, bounded backup plaintext/encrypted sizing, provider-endpoint secret rejection, and an atomic backup-import replacement boundary.
- Clean Expo prebuild and `clean assembleRelease` pass. The local production-signed candidate is `D:\EmbezzleStudio-Releases\v1.3.0-candidate\Embezzle-Studio-v1.3.0-candidate-release.apk`, 97,448,407 bytes, SHA-256 `c95dafe6e6eb77f3a1a4c7504c6ad05c27218b45972de2e247db264ec4c777d4`.
- `aapt` and the packaged Manifest identify `com.szdtzpj.embezzlestudio`, version `1.3.0` / code 9, minSdk 24, targetSdk 36, and `allowBackup=false`. `RECORD_AUDIO` is intentional; CAMERA and `SYSTEM_ALERT_WINDOW` are absent. `apksigner` reports exactly one expected production signer with certificate SHA-256 `F5746B0DC5BD3F6E640F693FDE171BD0CD87A919998CD6CA3F8F26748ABE6C02`; v2/v3 are true and zip alignment passes.
- `adb devices -l` is empty. No Android-device or real-provider-account test is claimed.

## Completed local release gate

1. The complete repository check, final Web export/browser acceptance, Expo dependency/Doctor checks, workflow/script/security checks, clean Android prebuild/Release assembly, local production signing, and APK identity/permission/signature/alignment checks are complete.
2. The local candidate remains local and must not be conflated with the separately rebuilt Actions asset: both are 97,448,407 bytes, but the candidate SHA-256 is `c95dafe6e6eb77f3a1a4c7504c6ad05c27218b45972de2e247db264ec4c777d4`, while the formal APK SHA-256 is `b5e48387e62d99512ae18a2c4f4a80ddf482c3c1b489768e924845e0adceb7fe`.

## Formal GitHub release and public Pages evidence

- PR Quality run [`29176034579`](https://github.com/szdtzpj/Embezzle-Studio/actions/runs/29176034579), `main` Quality run [`29176125303`](https://github.com/szdtzpj/Embezzle-Studio/actions/runs/29176125303), and the initial Pages run [`29176125307`](https://github.com/szdtzpj/Embezzle-Studio/actions/runs/29176125307) all succeeded before release.
- Tag `v1.3.0` resolves exactly to merge commit `ea9409f1ea3540520eaf469a0c777fe1bc87e7f8`. Production Android run [`29176245049`](https://github.com/szdtzpj/Embezzle-Studio/actions/runs/29176245049) succeeded and published the immutable, non-prerelease Latest Release with exactly 3 assets.
- The formal `Embezzle-Studio-v1.3.0-release.apk` is 97,448,407 bytes with SHA-256 `b5e48387e62d99512ae18a2c4f4a80ddf482c3c1b489768e924845e0adceb7fe`. It identifies as `com.szdtzpj.embezzlestudio` version `1.3.0`/code 9, minSdk 24/targetSdk 36, and `allowBackup=false`; intentional `RECORD_AUDIO` is present, CAMERA and `SYSTEM_ALERT_WINDOW` are absent.
- The formal APK has exactly one signer with certificate SHA-256 `F5746B0DC5BD3F6E640F693FDE171BD0CD87A919998CD6CA3F8F26748ABE6C02`; v2/v3 and zipalign pass. Release attestation and all 3 asset attestations pass. The downloaded formal assets are stored under `D:\EmbezzleStudio-Releases\v1.3.0`.
- Post-release Pages run [`29176763721`](https://github.com/szdtzpj/Embezzle-Studio/actions/runs/29176763721) succeeded. The public manifest and `release.html` return anonymous HTTP 200 and match `v1.3.0` exactly. A complete anonymous APK download under `D:\EmbezzleStudio-Releases\v1.3.0-pages-public-verify-20260712-103132` matches the formal asset's exact size and SHA-256.

## Remaining external acceptance boundary

- Android device: exercise text import through the system picker, cancellation/failure/low-space paths, large artifact/source editing, revision restore, export/share, context controls, process restart persistence, and long Settings/Chat/Workbench switching sessions.
- Browser evidence is complete for the recorded 390×844 exported-Web paths; it does not prove Android-native picker, filesystem, rendering, or performance behavior.
- Provider accounts: verify that selected context reaches representative user-funded providers exactly once per intended request and that unselected sources never do. Provider billing and entitlement remain authoritative.
- GitHub publication, immutable assets, attestations, Pages manifest/download page, and anonymous APK bytes are complete. Remaining work is limited to device/provider acceptance and future maintenance, not publication of `v1.3.0`.
