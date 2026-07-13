# Continuation Checkpoint — 2026-07-13 (`1.6.0` formal release)

## Identity and publication truth

- The current application metadata is `1.6.0`, Android versionCode `12`.
- PR [#19](https://github.com/szdtzpj/Embezzle-Studio/pull/19) is merged. Its merge commit, remote `main`, and the annotated `v1.6.0` tag's peeled commit are exactly `80a60fd97c7618d98789a6784f697ab9caeaf8ec`.
- Public [`v1.6.0`](https://github.com/szdtzpj/Embezzle-Studio/releases/tag/v1.6.0) is the stable Latest Release. It is immutable, non-draft, and non-prerelease, is authored by `szdtzpj`, and contains exactly three formal assets uploaded by `github-actions[bot]`.
- The locally signed acceptance candidate remains pre-publication evidence and is not byte-identical to the Actions-built formal APK. Public installation evidence must use the formal APK size and digest recorded below.
- Embezzle Studio still operates no production API, model proxy, MCP gateway, approval server, task worker, telemetry backend, cloud sync, or app-funded quota. Provider and tool calls use the user's own account, entitlement, quota, and billing.

## `1.6.0` product-feedback scope

1. Chat empty states now provide direct routes into provider selection or model configuration instead of leaving users at a dead end. Settings exposes explicit deep-link destinations and gives model configuration a dedicated entry.
2. The dedicated model-configuration flow centralizes models across providers, current selection, and explicit task/capability overrides without removing the existing provider ownership and runtime boundaries.
3. Model discovery now classifies ordinary compatible-directory success separately from risk-bearing Ark results. Ordinary “models acquired” feedback uses a transient toast; Ark's undocumented compatibility probe and curated-catalog fallback remain persistent warnings so security and entitlement caveats stay readable.
4. The generation-parameter panel is bounded by the actual space above the composer and has its own vertical scroll surface. Dragging dismisses the Android keyboard; numeric submission, closing the panel, and tapping its backdrop also dismiss the keyboard instead of requiring the device Back action.
5. New projects can start from four entirely local presets: research analysis, writing/editing, software development, and study/organization. A preset only fills reviewable local project fields and does not call an API or Embezzle-owned server.
6. Multi-model comparison now guides an unconfigured user to the relevant Settings destination rather than showing only a non-actionable notice.

## Current local quality evidence

- `npm.cmd run check` passes 44 test files / 786 tests; TypeScript and zero-warning ESLint are clean.
- The Web export passes. This proves the export pipeline only; no browser visual or interaction acceptance is claimed below.
- Expo Doctor passes 20/20.
- All 3 workflow YAML files parse, all 35 embedded Bash blocks pass syntax validation, and all 16 official Action references remain pinned to full commit SHAs.
- The documentation/source diff whitespace gate passes.
- `npm audit` reports 0 high or critical findings. Twelve moderate findings remain in the Expo toolchain dependency chain; no compatibility-breaking force upgrade was applied.
- A release-mode `app-release-unsigned.apk` build completed before local production signing; `apksigner verify` rejected that input as unsigned before zipalignment and signing.

## Local Android candidate evidence

- Candidate path: `D:\EmbezzleStudio-Releases\v1.6.0-candidate\Embezzle-Studio-v1.6.0-candidate-release.apk`.
- Size: 97,480,976 bytes.
- SHA-256: `7C8BC0B8EA2C6E088FD7214398D4918A6787DBB52D17DB09335810A639055DFD`.
- Package identity: `com.szdtzpj.embezzlestudio`, version `1.6.0`, Android versionCode `12`.
- SDK boundary: minSdk `24`, targetSdk `36`, compileSdk `36`.
- The merged manifest keeps `android:allowBackup="false"` and the main activity's `android:windowSoftInputMode="adjustResize"` (`0x10`).
- Declared permissions are `INTERNET`, `MODIFY_AUDIO_SETTINGS`, `RECORD_AUDIO`, `VIBRATE`, `ACCESS_NETWORK_STATE`, `WAKE_LOCK`, `USE_BIOMETRIC`, `USE_FINGERPRINT`, and legacy read/write external storage capped at Android 12L (`maxSdkVersion=32`), plus the package-scoped dynamic-receiver permission. `CAMERA`, `SYSTEM_ALERT_WINDOW`, and `REQUEST_INSTALL_PACKAGES` are absent.
- `zipalign -c -v 4` succeeds.
- APK Signature Schemes v2 and v3 pass.
- Exactly one signer is present; its subject is the Embezzle Studio production release identity, not Android Debug.
- Production certificate SHA-256: `F5746B0DC5BD3F6E640F693FDE171BD0CD87A919998CD6CA3F8F26748ABE6C02`.
- These checks prove the local candidate's bytes, package identity, and signing identity. They do not turn it into the protected-workflow formal artifact or public Pages download.

## Formal GitHub release evidence

- Protected Android run [`29222449682`](https://github.com/szdtzpj/Embezzle-Studio/actions/runs/29222449682) completed successfully from the exact release commit.
- Post-release Pages workflow_run [`29223191138`](https://github.com/szdtzpj/Embezzle-Studio/actions/runs/29223191138) completed successfully.
- The stable Latest Release is immutable, non-draft, and non-prerelease, is authored by `szdtzpj`, and contains exactly three assets whose uploader is `github-actions[bot]`.
- Release integrity evidence for this round is limited to the immutable Release, GitHub asset digests, and checksum verification.
- The formal `Embezzle-Studio-v1.6.0-release.apk` is 97,599,959 bytes with SHA-256 `6D27F0EA3502C0841276E35C6513D6DD0C1A5BC24B49E15ACE96BB408FAF5ECA`.
- The formal APK identifies as package `com.szdtzpj.embezzlestudio`, version `1.6.0`, Android versionCode `12`. It has exactly one expected production signer with certificate SHA-256 `F5746B0DC5BD3F6E640F693FDE171BD0CD87A919998CD6CA3F8F26748ABE6C02`; APK Signature Schemes v2/v3 pass.
- The Pages manifest, trusted `release.html`, and APK HEAD request all return anonymous HTTP 200.
- A full anonymous Pages download under `D:\EmbezzleStudio-Releases\v1.6.0-pages-public-verify-20260713-121042` matches the formal 97,599,959-byte size and SHA-256 exactly.

## Not yet verified

- `adb devices -l` was empty. No installation, upgrade, gesture-navigation, three-button navigation, keyboard, process-death, low-memory, or sustained Chat/Settings stress result is claimed for the formal APK on a connected Android device.
- The task environment did not expose the built-in browser. The passing Web export therefore has no accompanying browser screenshot, console, responsive-layout, deep-link navigation, or interaction evidence for this round.
- No real OpenAI, Volcengine Ark, Alibaba Bailian, relay, voice, media, search, or MCP account was exercised. Provider entitlement, billing, discovery contents, paid calls, and provider-side retention remain outside this release gate.

## Remaining external/manual boundary

1. On representative gesture-navigation and three-button Android devices, install or upgrade to the formal APK and exercise empty-state deep links, the dedicated model screen, transient discovery success, persistent Ark warnings, parameter editing with the keyboard open, all four project presets, and comparison setup guidance.
2. When a browser surface is available, verify the exported Web build at desktop and narrow mobile widths, including Settings deep links, model configuration, parameter scrolling, toast dismissal, console output, and keyboard-equivalent focus behavior.
3. With tightly limited user-owned provider accounts, verify supported discovery and calls separately for each configured provider. Confirm entitlement and billing in the provider consoles rather than treating local estimates as authoritative.
