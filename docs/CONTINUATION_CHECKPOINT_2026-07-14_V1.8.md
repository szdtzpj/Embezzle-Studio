# Embezzle Studio 1.8.0 P0/P1 continuation checkpoint — 2026-07-14

This checkpoint is the current local truth for the P0/P1 implementation. The
working tree remains authoritative. Existing user changes, ignored local
credentials, generated Android files, and feedback images were not reset or
discarded. P2 biometric lock is explicitly deferred.

## Scope completed

- Workspace schema v7 migration, first-run setup, simple/advanced modes,
  draft/backup recovery, projects, artifacts, favorites/tags, branches and
  bounded cross-project local search.
- Android background media tasks, persisted per-entry outbox, bounded retry and
  local notification handling.
- Device-local cleanup journal for destructive conversation/message edits. It
  drains only after a clean workspace snapshot, writes conversation/task
  tombstones, removes stale outbox entries, and reclaims orphaned app media.
  The journal is AsyncStorage device state and is not part of backup or cloud
  sync payloads.
- Outbox writes are monotonic: terminal states cannot regress to pending, newer
  task metadata wins within a lifecycle, notification `sent` is not downgraded,
  and per-entry writes are read-back verified.
- Android system-share intake now merges captions and streams, performs bounded
  atomic cache copies with batch rollback, clears `cacheDir/expo-sharing`, and
  treats URL captions as opaque text without network requests.
- Document import now uses stable page-number IDs, deduplicates PDF records,
  adds only missing mixed-PDF OCR placeholders, updates the exact OCR page, and
  cleans picker cache files on parse/read failure.
- User-owned WebDAV/S3 encrypted sync remains optional and fail-closed. API
  keys, sync credentials, media bytes, and the local usage ledger stay local;
  no Embezzle Studio server or quota was added.
- Android workflow gates now cover `allowBackup=false`, `adjustResize`,
  `REQUEST_INSTALL_PACKAGES`/biometric/fingerprint absence, and both APK v2/v3
  signature schemes. Prebuild uses `CI=1` and `--clean --no-install`.

## Local verification evidence

- `npm.cmd run check`: 76 test files / 1,012 tests passed; TypeScript and ESLint
  are clean.
- Ark wire-protocol tests mock the unrelated media-persistence boundary, whose
  native behavior remains covered by the dedicated media-storage/export tests.
  This removes full-suite worker starvation without reducing Vitest's normal
  file parallelism.
- `npm.cmd run build:web`: 3,483 modules; the main web bundle is about 8.2 MB.
- `npx.cmd expo install --check`: passed. `npx.cmd expo-doctor`: 20/20.
- Three workflow YAML files parse; 36 Bash run blocks pass Git Bash `bash -n`;
  all 16 action references are full SHA pins; `git diff --check` passes.
- `git apply --check --reverse -- patches/expo-sharing+57.0.3.patch` passes.
- In-app Browser smoke passed at the normal desktop viewport and after a true
  390×844 override: first-run configuration, Chat, Projects, Artifacts/search,
  Settings, and WebDAV/S3 forms rendered and navigated. No app console errors
  were observed. The only Web warning is Expo Notifications' documented
  “push token changes are not fully supported on web” notice.
- `npm audit --omit=dev --audit-level=high` exits 0. Twelve moderate
  `uuid -> xcode -> @expo/config-plugins` findings remain; `npm audit fix
  --force` would install an incompatible Expo toolchain and was not applied.

## Android candidate evidence

Clean prebuild used:

```powershell
$env:NODE_ENV='production'
$env:ANDROID_HOME='C:\Users\555\AppData\Local\Android\Sdk'
$env:ANDROID_SDK_ROOT=$env:ANDROID_HOME
npx.cmd expo prebuild --platform android --clean --no-install
```

The second incremental `assembleRelease --no-daemon --offline` invocation
exited 0 after the first outer Gradle wrapper invocation timed out while waiting
to return. The resulting unsigned artifact was independently checked before
signing:

- `android/app/build/outputs/apk/release/app-release-unsigned.apk`
- package `com.szdtzpj.embezzlestudio`, version `1.8.0`, versionCode `14`
- minSdk `24`, targetSdk `36`, `android:allowBackup="false"`,
  `android:windowSoftInputMode="adjustResize"`
- intentional `RECORD_AUDIO`; no `CAMERA`, `SYSTEM_ALERT_WINDOW`,
  `REQUEST_INSTALL_PACKAGES`, `USE_BIOMETRIC`, or `USE_FINGERPRINT`
- `expo-notifications` contributes dormant Firebase/launcher integration
  components and related manifest permissions even though this app requests no
  push token and configures no FCM backend; a smaller native local-notification
  module is a future least-privilege hardening option that requires device/OEM
  acceptance
- unsigned verification correctly fails before signing

The local production-signed acceptance candidate is:

`D:\EmbezzleStudio-Releases\v1.8.0-candidate\Embezzle-Studio-v1.8.0-candidate-release.apk`

- size: `152,673,746` bytes
- SHA-256: `0DCB06FE4D8D2D018B78E1F6A7A684BCD66BB525682B622DA0399B289DFD3143`
- exactly one signer; certificate SHA-256:
  `F5746B0DC5BD3F6E640F693FDE171BD0CD87A919998CD6CA3F8F26748ABE6C02`
- APK Signature Schemes v2 and v3: true; zipalign: pass; no Android Debug
  certificate
- checksum and `apksigner-report.txt` are stored beside the candidate. No
  keystore, password, or private key is in the repository or report.

After the iOS-only `faceIDPermission: false` hardening, a fresh Android clean
prebuild and offline `assembleRelease` were rerun. The generated
`android/app/build/outputs/apk/release/app-release.apk` is a 1.8.0/code-14
debug-signed validation artifact (SHA-256
`36EAFAF0CCBA964126564C718B47F9558ECB55266CB88FE82DFD1D6026023E01`, v2
true, v3 false, Android Debug signer); it confirms the current Android
manifest but must not be published. The production-signed candidate above
predates only that iOS metadata change, so its Android permissions and runtime
scope remain applicable, but an exact current-tree production-signed APK now
requires the protected release keystore/Actions environment.

This is a local acceptance candidate, not a GitHub asset or public release.

## External and manual boundary

- `adb devices -l` is empty for this run. Install/launch, native keyboard and
  system-bar behavior, share providers, PDF/OCR, SAF cancellation/low-space,
  background task survival, performance, and sustained stress still need real
  device coverage.
- A real WebDAV/S3 account was not configured here; CAS/conflict behavior is
  covered by local tests but not by a live user-owned storage service.
- Broad real-provider billing/entitlement, long-running media, upload/reference,
  and provider-specific error acceptance remains outside local automation.
- No push, tag, GitHub Release, Actions run, production secret configuration,
  collaborator/branch-rule change, or remote protection change was performed.
- P2 biometric lock remains deferred. The blocked biometric permissions are a
  release hardening gate only; no biometric API or user flow was added.
