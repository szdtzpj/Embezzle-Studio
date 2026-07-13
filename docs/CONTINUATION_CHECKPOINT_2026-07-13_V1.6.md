# Continuation Checkpoint — 2026-07-13 (`1.6.0` local candidate)

## Identity and publication truth

- The current application metadata is `1.6.0`, Android versionCode `12`.
- Public stable Latest remains immutable, non-prerelease [`v1.5.0`](https://github.com/szdtzpj/Embezzle-Studio/releases/tag/v1.5.0). The local `1.6.0` candidate has not been pushed, tagged, published as a GitHub Release, or exposed through the public Pages download chain.
- The APK described below is a local acceptance candidate signed with the existing production certificate after a release-mode unsigned build. It is not an Actions-built formal asset and must not be represented as the public update.
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
- These checks prove the local candidate's bytes, package identity, and signing identity. They do not turn it into a protected-workflow artifact, immutable Release, attested asset, or public Pages download.

## Not yet verified

- `adb devices -l` was empty. No installation, upgrade, gesture-navigation, three-button navigation, keyboard, process-death, low-memory, or sustained Chat/Settings stress result is claimed for this candidate on a connected Android device.
- The task environment did not expose the built-in browser. The passing Web export therefore has no accompanying browser screenshot, console, responsive-layout, deep-link navigation, or interaction evidence for this round.
- No real OpenAI, Volcengine Ark, Alibaba Bailian, relay, voice, media, search, or MCP account was exercised. Provider entitlement, billing, discovery contents, paid calls, and provider-side retention remain outside this local gate.
- No `v1.6.0` push, tag, Draft Release, production Android workflow, immutable GitHub Release, Release/asset attestation, Pages manifest update, or anonymous public APK verification has occurred.

## Remaining external/manual boundary

1. On representative gesture-navigation and three-button Android devices, install or upgrade to the candidate and exercise empty-state deep links, the dedicated model screen, transient discovery success, persistent Ark warnings, parameter editing with the keyboard open, all four project presets, and comparison setup guidance.
2. When a browser surface is available, verify the exported Web build at desktop and narrow mobile widths, including Settings deep links, model configuration, parameter scrolling, toast dismissal, console output, and keyboard-equivalent focus behavior.
3. With tightly limited user-owned provider accounts, verify supported discovery and calls separately for each configured provider. Confirm entitlement and billing in the provider consoles rather than treating local estimates as authoritative.
4. Only after those gates and a final source freeze should the owner push the release source, merge through the required Quality check, create the protected annotated `v1.6.0` tag and Draft Release, run the protected Android production workflow, verify immutable Release and asset attestations, and confirm the anonymous Pages download chain.
