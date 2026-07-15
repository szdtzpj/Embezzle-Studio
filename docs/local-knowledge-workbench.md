# Local Knowledge and Artifact Workbench (`1.8.0`)

`1.3.0` introduced the device-local workspace for reusable text outcomes and project reference material. The `1.8.0` P0/P1 work extends its import and lifecycle boundaries without adding an Embezzle Studio API, server, telemetry backend, vector database, or hosted model quota. Optional sync uses only a storage account owned by the user; it is documented separately below.

## Artifact workspace

- An artifact belongs to one local project and has a title, an inert text format (`markdown`, `plain-text`, `code`, `json`, or `html`), optional language metadata, and revision history.
- Users can create a blank artifact or capture a message as an artifact, edit it, append a new revision, inspect a bounded line-level difference, restore an older revision by creating a new revision, rename it, move it with project migration, delete it, and export its active revision.
- Revision restore is non-destructive: it appends a copy as the new active revision instead of deleting later history.
- Limits are enforced locally: at most 200 artifacts, 50 revisions per artifact, 500,000 characters per revision, and 2,000,000 UTF-8 bytes across all artifact revisions. The diff and initial chat/workbench rendering are also bounded.
- `html` and `code` are stored, edited, and diffed as text. HTML exports use `.html.txt` plus `text/plain`, so the app does not hand an executable Web page to a browser or share target. The app does not evaluate scripts, run code, or load an HTML preview.

## Workspace lifecycle and durable media

- The workbench is stored in workspace schema v7. Migration and normalization complete before the ready phase; first-run setup, simple/advanced mode, draft recovery, and authenticated backup replacement are explicit workflows. Artifacts, sources, projects, favorites/tags, and branches remain local records rather than server-backed entities.
- Deleting a conversation or message does not immediately assume that every attachment or task reference is safe to remove. A device-local cleanup journal records tombstones after a clean workspace snapshot, then drains stale outbox entries and orphaned app-owned media only after the replacement snapshot is durable. Journal state is excluded from backup and WebDAV/S3 sync.
- Android media tasks are projections of durable conversation/task records. A persisted per-entry outbox and local notification state support bounded retry; terminal task states never regress to pending, newer metadata wins within a lifecycle, notification `sent` is not downgraded, and writes are read back before being accepted. No Embezzle Studio worker or cloud job database is involved.
- Android system-share intake merges captions and streams in bounded batches, rolls back the entire batch on copy failure, and clears temporary `cacheDir/expo-sharing` files after success or failure. URL captions are retained as opaque authored text and do not trigger a network fetch.

## Project reference material

- A project can contain manually authored text, a snapshot captured from a message, a snapshot captured from an artifact revision, or an explicitly reviewed import draft.
- Import supports bounded plain-text/code, HTML, DOCX, XLSX, PPTX, Android-native PDF text extraction, web pages over public HTTPS, and images/PDF pages through explicit local OCR. A source is limited to 500,000 characters, an imported file to 20,000,000 bytes, and all source bodies together to 2,000,000 UTF-8 bytes; ZIP entry, page, sheet, slide, and compression-ratio limits also apply.
- Office parsing is inert XML/text extraction only. Legacy binary Office, OpenDocument, media, archives, APK, and executable parsing is not supported. Web or module-less builds do not pretend to parse scanned PDF/image content: they keep a pending-OCR draft until the user explicitly selects a configured provider vision model or uses Android local OCR. Renaming an unsupported format is not a conversion path.
- PDF records use stable page-number IDs and are deduplicated before they enter the project. Mixed PDFs add only missing OCR placeholders; an OCR completion updates the exact page record rather than appending a duplicate. Picker cache files are reclaimed when parsing or reading fails.
- Local search normalizes and chunks text, then performs bounded literal/token matching over the selected project. It does not create embeddings, call a remote retrieval API, or claim to be vector RAG.
- Search indexing is bounded to 2,000 chunks and returned results are bounded. Search text stays on the device.
- Imported or captured text is reference data, not an instruction with system-level authority. The client cannot reliably detect every prompt-injection sentence inside arbitrary reference material, so users must review what they select.

## Explicit request context

- Project sources are not sent merely because they exist or match a search. A conversation stores an explicit list of selected source IDs; only those selected sources can be composed into that conversation's next provider request.
- The selected reference block is bounded to 30,000 characters and inserted as a distinct local-knowledge system record. Missing, omitted, and truncated source IDs remain observable to the local builder.
- For chat and comparison, the context inspector uses the same local composer as the request path and previews include/exclude/trim/pin decisions, a conservative text-token estimate, attachment uncertainty, and each selected source's included/omitted/missing state. Comparison targets share one transcript based on their smallest context window.
- Image/video adapters intentionally receive only the newest text prompt. Context inspection and compression are hidden for those models, so the UI does not claim that chat history or project references reach a media endpoint.
- A user can exclude a message from future context or pin its complete causal turn. Excluding a user message removes its original user-led turn so an orphan assistant reply is not attached to an older prompt.
- Token estimates are local planning estimates, not provider billing data. Media/file token use can remain unknown; the UI must not present unknown usage as zero.
- The compression entry only writes a reviewable compression prompt into the composer. It does not call a model by itself; a provider call happens only if the user later sends that draft through the normal user-account and cost-guard path.
- History is trimmed after reserving the selected-reference text budget. If required text still exceeds the model window's safety threshold, sending is blocked before provider authorization or usage-ledger insertion. Attachment tokens remain unknown without provider-specific encoding details.
- There is no automatic memory, silent background summarization, or automatic source selection.

## Cost, privacy, and trust boundary

- All local create/edit/version/diff/search/export/context-preview actions work without a model call and without an Embezzle Studio server.
- If a selected context is sent to a model, the request uses the user's configured provider endpoint, API key, product entitlement, quota, and billing. Embezzle Studio does not buy, subsidize, resell, or proxy that usage.
- There is no Embezzle-operated cloud sync or telemetry upload for artifacts or project sources. Optional sync writes only authenticated encrypted snapshots to a user-owned WebDAV/S3 endpoint; media, API keys, sync credentials, and the device-local usage ledger are excluded, and CAS failures/conflicts fail closed. Artifacts and sources otherwise live in the versioned local workspace and are included as ordinary authored text in authenticated encrypted backup exports. Users must not paste secrets into artifact or reference text; those free-text fields are preserved as authored and are not secret-scanned.
- API keys remain outside workspace text storage and exported backup payloads under the existing credential boundary.

## Verification boundary

### Current `1.8.0` P0/P1 local evidence

The active local truth is [the v1.8.0 continuation checkpoint](./CONTINUATION_CHECKPOINT_2026-07-14_V1.8.md). It records the completed P0/P1 implementation and the release boundary; this document does not imply a GitHub tag, Release, Actions APK, or production publication.

`npm.cmd run check` passes 76 test files / 1,012 tests with clean TypeScript and ESLint. The Web export contains 3,483 modules and an approximately 8.2 MB main bundle. `npx.cmd expo install --check` passes and Expo Doctor is 20/20.

Three workflow YAML files parse, 36 Bash run blocks pass `bash -n`, all 16 action references are full SHA pins, `git diff --check` passes, and the reverse `expo-sharing` patch check passes. High-severity dependency audit exits 0; twelve moderate `uuid -> xcode -> @expo/config-plugins` findings remain and no force-upgrade was applied.

In-app Browser smoke passes at desktop and true 390x844 viewports for first-run configuration, Chat, Projects, artifacts/search, Settings, and WebDAV/S3 forms with no app console errors. The only warning is the documented Expo Notifications web push-token limitation; browser evidence does not replace Android-device evidence.

The P0/P1 work covered schema-v7 setup/recovery, artifact/source lifecycle, stable PDF import and explicit OCR placeholders, Android background media outbox/notifications, cleanup journaling and orphan-media reclamation, atomic system-share intake, and optional fail-closed user-owned WebDAV/S3 sync. P2 biometric lock remains deferred.

Clean prebuild and offline Release assembly pass. The local production-signed candidate is `D:\EmbezzleStudio-Releases\v1.8.0-candidate\Embezzle-Studio-v1.8.0-candidate-release.apk`, 152,673,746 bytes, SHA-256 `0DCB06FE4D8D2D018B78E1F6A7A684BCD66BB525682B622DA0399B289DFD3143`. It identifies as `com.szdtzpj.embezzlestudio` version `1.8.0`/code `14`, minSdk `24`/targetSdk `36`, `allowBackup=false`, `adjustResize`, intentional `RECORD_AUDIO`, and no camera, overlay, install-packages, biometric, or fingerprint permissions. Exactly one production signer is present (`F5746B0DC5BD3F6E640F693FDE171BD0CD87A919998CD6CA3F8F26748ABE6C02`); v2/v3 and zipalign pass. The candidate predates only the final iOS-only Face ID metadata hardening. The current tree was rebuilt cleanly for Android and its manifest rechecked, but that rebuild is debug-signed; exact current-tree production signing remains a protected-environment boundary.

`adb devices -l` is empty for this run. Real-device install/launch, native keyboard/system-bar variants, native picker/filesystem and SAF cancellation/low-space behavior, background-task survival, performance/stress, live WebDAV/S3 CAS/conflict behavior, broad real-provider entitlement/billing, and long-running media acceptance remain external. No P2 biometric API or flow was added.

### Historical `1.3.0` provenance

The historical `1.3.0` source passed `npm.cmd run check` with 38 test files / 634 tests. Its Web export passed at 3,259 modules / 7.4 MB. A fresh 390x844 exported-Web session verified inert HTML `.html.txt` export/content, artifact version history, artifact-to-knowledge capture, bounded local search, explicit source selection changing the actual count from 0 to 1, and context compression producing a draft without sending it; it recorded 0 console errors, 0 warnings, and no non-static requests.

Clean prebuild and `clean assembleRelease` pass. The local signed candidate is `D:\EmbezzleStudio-Releases\v1.3.0-candidate\Embezzle-Studio-v1.3.0-candidate-release.apk`, 97,448,407 bytes, SHA-256 `c95dafe6e6eb77f3a1a4c7504c6ad05c27218b45972de2e247db264ec4c777d4`. It identifies as `com.szdtzpj.embezzlestudio` version `1.3.0`/code 9, minSdk 24/targetSdk 36, `allowBackup=false`, intentional `RECORD_AUDIO`, and no CAMERA or `SYSTEM_ALERT_WINDOW`. Exactly one expected production signer is present with certificate SHA-256 `F5746B0DC5BD3F6E640F693FDE171BD0CD87A919998CD6CA3F8F26748ABE6C02`; v2/v3 and zipalign pass.

PR [#13](https://github.com/szdtzpj/Embezzle-Studio/pull/13) merged as `ea9409f1ea3540520eaf469a0c777fe1bc87e7f8`; PR Quality `29176034579`, `main` Quality `29176125303`, initial Pages `29176125307`, production Android `29176245049`, and post-release Pages `29176763721` all succeeded. Tag `v1.3.0` points exactly to that commit. The public [`v1.3.0` Release](https://github.com/szdtzpj/Embezzle-Studio/releases/tag/v1.3.0) was Latest when published and is now historical; it remains immutable, non-prerelease, and has exactly 3 assets, while the Release attestation and all 3 asset attestations pass.

The formal `Embezzle-Studio-v1.3.0-release.apk` is 97,448,407 bytes with SHA-256 `b5e48387e62d99512ae18a2c4f4a80ddf482c3c1b489768e924845e0adceb7fe`. It identifies as `com.szdtzpj.embezzlestudio` version `1.3.0`/code 9, minSdk 24/targetSdk 36, `allowBackup=false`, intentional `RECORD_AUDIO`, and no CAMERA or `SYSTEM_ALERT_WINDOW`; it has one signer with certificate SHA-256 `F5746B0DC5BD3F6E640F693FDE171BD0CD87A919998CD6CA3F8F26748ABE6C02`, while v2/v3 and zipalign pass. It is distinct from the same-size local candidate whose SHA-256 is `c95dafe6e6eb77f3a1a4c7504c6ad05c27218b45972de2e247db264ec4c777d4`. Formal assets are stored under `D:\EmbezzleStudio-Releases\v1.3.0`. The post-release manifest and `release.html` return anonymous HTTP 200 and match the Release exactly; a full public APK download under `D:\EmbezzleStudio-Releases\v1.3.0-pages-public-verify-20260712-103132` matches the formal size and hash.

`adb devices -l` is still empty, so the final Actions APK has not been exercised on a connected Android device; additional-device, native picker/filesystem, performance, and stress paths remain unverified. No real-provider-account behavior or billing acceptance is claimed.
