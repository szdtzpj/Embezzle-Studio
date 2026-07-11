# Continuation Checkpoint — 2026-07-12 (`1.3.0`)

## Identity and publication state

- Working branch: `codex/local-knowledge-workbench-v1.3`.
- Development metadata: `1.3.0`, Android versionCode `9`.
- Public stable Latest remains `v1.0.6` at this checkpoint.
- `1.3.0` has not been pushed, tagged, uploaded, published, or staged to Pages. A production-signed candidate has been built and verified locally, but it is not a GitHub Release or public APK.
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
2. The candidate remains local. No push, tag, upload, GitHub Release, Pages update, or public APK was performed.

## External acceptance boundary

- Android device: exercise text import through the system picker, cancellation/failure/low-space paths, large artifact/source editing, revision restore, export/share, context controls, process restart persistence, and long Settings/Chat/Workbench switching sessions.
- Browser evidence is complete for the recorded 390×844 exported-Web paths; it does not prove Android-native picker, filesystem, rendering, or performance behavior.
- Provider accounts: verify that selected context reaches representative user-funded providers exactly once per intended request and that unselected sources never do. Provider billing and entitlement remain authoritative.
- GitHub: only after explicit authorization, merge through the protected process, freeze `main`, create the exact `v1.3.0` tag and owner-authored empty draft, run the protected Android workflow, and verify immutable assets, attestation, Pages manifest/download page, and anonymous APK bytes. Public stable remains `v1.0.6` until that separate process completes.
