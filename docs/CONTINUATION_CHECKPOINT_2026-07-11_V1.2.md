# Continuation Checkpoint — 2026-07-11 (`1.2.0`)

## Authority and safety boundary

- Repository: `C:\Python_project\EmbezzleStudio`
- Working branch: `codex/productivity-v1.2`
- Treat the current working tree as authoritative. It contains intentional uncommitted work; do not `reset`, `checkout`, or overwrite it.
- Development target: `1.2.0` / Android versionCode 8.
- Public stable Latest: `v1.0.6`. A verified production-signed **local candidate** now exists for `1.2.0`, but no `1.2.0` push, tag, GitHub Release, Pages update, or public asset has been created.
- Do not read, print, commit, or copy local API-key or signing-secret files. Do not push, tag, create a Release, change remote protection, or configure production secrets without the user's explicit authorization.

## Non-negotiable product cost boundary

Embezzle Studio does not buy, resell, subsidize, or proxy model, search, voice, or media capacity. It operates no production API/proxy, exchange-rate service, cloud-sync service, telemetry backend, MCP gateway, or task/push worker. Every provider request uses the user's endpoint, account, and credential, and every provider charge belongs to that user.

Local prices, limits, and attempt events are estimates and guardrails, not authoritative billing. CNY and USD remain separate with no owned FX conversion. Missing search/voice/media/retry/provider-side charges stay unknown rather than being rewritten as zero.

## Six `1.2.0` capabilities in the current tree

1. **Local projects**
   - Projects, optional project instructions/default models, and conversation membership are local workspace data.
   - Deleting a project migrates its conversations explicitly instead of silently deleting them.
   - Project features require no Embezzle-owned sync service.

2. **Conversation branches with canonical deduplication**
   - A branch can be cloned locally from a selected message without making a provider request.
   - Cloned messages and comparison groups receive new IDs; `originMessageId` preserves canonical lineage.
   - Usage analytics and the generation task center deduplicate by canonical origin so inherited history is not counted as new work.

3. **Bounded local global search**
   - Literal NFKC-normalized search covers projects, prompt templates, conversations, and messages.
   - Query length, scanned documents, and returned results are bounded.
   - Provider profiles, API keys, plugin/MCP data, and usage-ledger data are excluded and nothing is sent to a service provider.

4. **Provider setup wizard and endpoint/key rebinding**
   - Provider kind, canonical Endpoint, and Key are edited as one independent draft/binding.
   - A kind or endpoint change clears the old key, models, and candidates before model discovery can target the new destination.
   - Bailian Coding Plan/Token Plan endpoints and `sk-sp-` subscription credentials are blocked for custom-application use; valid pay-as-you-go endpoints require a fresh binding.

5. **Evidence-backed capability matrix**
   - Provider/model declarations and client-implemented/tested serializers/parsers are displayed separately.
   - A model-catalog label, discovery response, or user-visible switch does not by itself activate an unsupported route, attachment shape, hosted tool, or parameter.

6. **Local cost guard, output cap, and attempt ledger**
   - Before covered requests, the guard can apply the output-token cap, unknown-cost policy, comparison-target maximum, daily attempt limit, and potentially-multiple-charge confirmation.
   - Daily CNY/USD thresholds examine only the day's already completed, locally known subtotal. Once that subtotal reaches the threshold, the next attempt is warned or blocked. The client does not project the current request's cost and cannot promise that a request will not cross a provider budget.
   - `providerUsageEvents` records local started/completed/failed/cancelled attempts and known/unknown components. It is not a provider invoice or authoritative provider-usage record.

## Provider wire decisions covered by focused tests

| Route | Output cap field |
| --- | --- |
| OpenAI Responses and official hosted search | `max_output_tokens` |
| OpenAI official Chat Completions | `max_completion_tokens` |
| Volcengine Ark ordinary Chat | `max_tokens` |
| Alibaba Bailian compatible Chat | `max_tokens` |
| Ark/Bailian Responses search | `max_output_tokens` |
| New API/custom compatible Chat | best-effort `max_tokens`, never claimed as guaranteed |

- Image/video generation does not receive a text output-token cap.
- Official provider routing remains exact-host/path based. The Bailian Beijing, Singapore, and US pay-as-you-go hosts are explicitly handled for supported search/audio routes; lookalike hosts do not inherit official capabilities.
- Ark ordinary Chat and Responses remain separate request shapes. Bailian compatible Chat remains the broad family route; Responses is not inferred for arbitrary third-party families.

## Workspace, migration, backup, and privacy

- Workspace schema/storage is v4 and normalizes projects, branch lineage, cost settings, and usage attempts while migrating older snapshots.
- Encrypted/plain exported backups exclude structured API-key/MCP-authorization fields, attachment bytes/URIs, and `providerUsageEvents`. Ordinary conversations, prompts, templates, notes, and error text are preserved without secret scanning, so credentials must not be pasted into those fields. Import preserves the receiving device's existing attempt ledger rather than importing another device's ledger.
- Android configuration sets `android.allowBackup=false` so conversations and the local attempt ledger are not eligible for Android/Google automatic app backup. Users should migrate through the explicit authenticated encrypted export/import flow.
- The clean generated `1.2.0` Manifest and packaged APK both verify `android:allowBackup="false"`; packaged CAMERA and `SYSTEM_ALERT_WINDOW` permissions are absent.

## Evidence already recorded for `1.2.0`

- `npm.cmd run check` passes TypeScript, zero-warning ESLint, 27 test files, and 528 tests.
- Focused coverage includes project CRUD/migration, branch ID remapping/canonical deduplication, bounded secret-free local search, endpoint/key rebinding and Bailian subscription-plan rejection, declared-versus-client capability evidence, cost-limit/unknown-cost behavior, atomic endpoint-bound secret persistence, backup-import replacement locking, storage/backup handling, and exact output-token request fields.
- Web export passes with 3,254 modules and a 7.3 MB main bundle. A clean 390×844 browser session verified v1.2.0, project creation/global search/navigation, provider setup rebinding, the capability/cost/backup surfaces, endpoint edits clearing a temporary Key, and an 8,192-token draft surviving the guard toggle; the console had 0 errors / 0 warnings.
- `expo install --check` reports current dependencies, Expo Doctor passes 20/20, all 3 workflow YAML files parse, all 35 embedded Bash blocks pass `bash -n`, all 16 official Actions remain full-SHA pinned, and `git diff --check` passes.
- Clean Expo prebuild and `NODE_ENV=production` `clean assembleRelease` pass. The local production-signed candidate is `D:\EmbezzleStudio-Releases\v1.2.0-candidate\Embezzle-Studio-v1.2.0-candidate-release.apk`, 97,313,239 bytes, SHA-256 `872f32a48320f2a20dadee6fc0f699668666d067a60e546a19467ed922082da0`.
- `aapt` verifies `com.szdtzpj.embezzlestudio`, version `1.2.0`/code 8, minSdk 24, targetSdk 36, and intentional `RECORD_AUDIO`; camera/overlay are absent. `apksigner` verifies exactly one signer with production certificate SHA-256 `F5746B0DC5BD3F6E640F693FDE171BD0CD87A919998CD6CA3F8F26748ABE6C02`, v2/v3 true, and zipalign passes. The APK is newer than the final App/src/app configuration source.
- These results prove local code paths, serializers/parsers, fail-closed policy, Web rendering, and the local Android package/signing contract. They do not prove real paid-product activation, real provider billing, physical-device Android rendering, microphone/playback behavior, or sustained provider/device load.

## Locally completed; still pending only at external/manual boundaries

1. Install the candidate on representative Android devices and verify keyboard/system bars, project/branch/search flows, provider rebinding, cost-confirmation dialogs, media/voice behavior, SAF failure/cancellation/low-space paths, and sustained switching/load. No Android device was connected to this run.
2. Use real user-owned provider accounts with explicit low limits to confirm product activation, regional endpoints, account model access, search/voice/media billing, and server-side limits. No live provider request was needed merely to manufacture local evidence.
3. If publication is authorized later, merge through the protected process, freeze `main`, create the exact `v1.2.0` tag and owner-authored empty draft, run the protected Android workflow, and verify immutable Release/attestation/Pages/anonymous APK bytes. The local candidate must not be uploaded as a substitute for the Actions rebuild.

## Historical `1.1.0` evidence — do not relabel as `1.2.0`

- `1.1.0` / code 7 passed 21 test files / 423 tests, TypeScript, zero-warning ESLint, Web export (3,249 modules / 7.2 MB), Expo Doctor 20/20, `expo install --check`, a 390×844 browser path, 3 workflow YAML files, 35 Bash blocks, and `git diff --check`.
- Its clean Android prebuild/Release and production-signed local candidate remain at `D:\EmbezzleStudio-Releases\v1.1.0-candidate\Embezzle-Studio-v1.1.0-candidate-release.apk`, 97,198,551 bytes, SHA-256 `f4a0062fc03d320bb5e3915b6b9a0cdb3a80ee16b4ad18cce78edfd79f92cd80`.
- `aapt` identified `1.1.0`/code 7, minSdk 24, targetSdk 36, and intentional `RECORD_AUDIO`; camera/overlay were absent. One expected production signer, APK Signature Schemes v2/v3, and zip alignment passed.
- This candidate was not tagged, uploaded, or published. Its bytes and evidence do not validate the changed `1.2.0` source.

## External/manual boundary after local verification

- GitHub: merge through the protected process, freeze `main`, create exact `v1.2.0` tag and owner-authored empty draft, run the protected Android workflow, then verify immutable Release assets, attestation, Pages manifest/download page, and anonymous APK bytes. None of this is authorized merely by this checkpoint.
- Android devices: verify system bars, keyboard, project/branch/search flows, provider rebinding, cost-confirmation dialogs, media/voice behavior, SAF failure/cancellation/low-space paths, and sustained switching/load.
- Provider accounts: confirm the user's actual product activation, model access, search/voice/media billing, endpoint region, and server-side limits. The local ledger must be compared with provider consoles rather than presented as the bill.
