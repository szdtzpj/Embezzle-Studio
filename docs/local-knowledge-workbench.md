# Local Knowledge and Artifact Workbench (`1.3.0`)

`1.3.0` adds a device-local workspace for reusable text outcomes and project reference material. It does not add an Embezzle Studio API, server, cloud account, synchronization service, telemetry backend, vector database, or hosted model quota.

## Artifact workspace

- An artifact belongs to one local project and has a title, an inert text format (`markdown`, `plain-text`, `code`, `json`, or `html`), optional language metadata, and revision history.
- Users can create a blank artifact or capture a message as an artifact, edit it, append a new revision, inspect a bounded line-level difference, restore an older revision by creating a new revision, rename it, move it with project migration, delete it, and export its active revision.
- Revision restore is non-destructive: it appends a copy as the new active revision instead of deleting later history.
- Limits are enforced locally: at most 200 artifacts, 50 revisions per artifact, 500,000 characters per revision, and 2,000,000 UTF-8 bytes across all artifact revisions. The diff and initial chat/workbench rendering are also bounded.
- `html` and `code` are stored, edited, and diffed as text. HTML exports use `.html.txt` plus `text/plain`, so the app does not hand an executable Web page to a browser or share target. The app does not evaluate scripts, run code, or load an HTML preview.

## Project reference material

- A project can contain manually authored text, a snapshot captured from a message, a snapshot captured from an artifact revision, or an imported text/code file.
- Import is intentionally restricted to a documented allowlist of plain-text/code extensions and MIME types. A source is limited to 500,000 characters, an imported file to 2,000,000 bytes, and all source bodies together to 2,000,000 UTF-8 bytes.
- PDF, Word, Excel, PowerPoint, OpenDocument, media, archive, APK, and executable parsing is not supported. Renaming one of these formats to a text extension is not a supported conversion path.
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
- There is no cloud sync or telemetry upload for artifacts or project sources. They live in the versioned local workspace and are included as ordinary authored text in authenticated encrypted backup exports. Users must not paste secrets into artifact or reference text; those free-text fields are preserved as authored and are not secret-scanned.
- API keys remain outside workspace text storage and exported backup payloads under the existing credential boundary.

## Verification boundary

The final local source passes `npm.cmd run check` with 38 test files / 634 tests and clean TypeScript/ESLint. Audit regressions cover conservative Unicode/emoji token gating, 200/201/256-character entity IDs, Unicode code-point limits, aggregate storage budgets that fail closed instead of dropping records, bounded backup sizing, endpoint-secret rejection, and atomic import replacement.

The final Web export passes at 3,259 modules / 7.4 MB. A fresh 390×844 exported-Web session verified inert HTML `.html.txt` export/content, artifact version history, artifact-to-knowledge capture, bounded local search, an explicit source-selection count changing from 0 to 1, and context compression producing a draft without sending it. It recorded 0 console errors, 0 warnings, and no non-static requests. `expo install --check`, Expo Doctor 20/20, 3 workflow YAML files, 35 Bash blocks, 16 full official-Action SHAs, and diff/secret-boundary checks also pass.

Clean prebuild and `clean assembleRelease` pass. The local signed candidate is `D:\EmbezzleStudio-Releases\v1.3.0-candidate\Embezzle-Studio-v1.3.0-candidate-release.apk`, 97,448,407 bytes, SHA-256 `c95dafe6e6eb77f3a1a4c7504c6ad05c27218b45972de2e247db264ec4c777d4`. It identifies as `com.szdtzpj.embezzlestudio` version `1.3.0`/code 9, minSdk 24/targetSdk 36, `allowBackup=false`, intentional `RECORD_AUDIO`, and no CAMERA or `SYSTEM_ALERT_WINDOW`. Exactly one expected production signer is present with certificate SHA-256 `F5746B0DC5BD3F6E640F693FDE171BD0CD87A919998CD6CA3F8F26748ABE6C02`; v2/v3 and zipalign pass.

`adb devices -l` is empty, so Android-native workbench, picker/filesystem, performance, and stress paths remain unverified on a device. No real-provider-account behavior or billing is claimed. No push, tag, upload, GitHub Release, Pages update, or public `1.3.0` APK has occurred; public stable remains `v1.0.6`.
