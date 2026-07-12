# Continuation Checkpoint — 2026-07-12 (`1.5.0` formal release)

## Identity and publication truth

- Collaborator Settings-redesign PR [#12](https://github.com/szdtzpj/Embezzle-Studio/pull/12), whose head was `cc129e48e235e15a3a532eb37b3717fe39f689fd`, merged into public `main` as `79226bfcfd50bbe799aadb3604d2c29051f7ae20`.
- Release PR [#17](https://github.com/szdtzpj/Embezzle-Studio/pull/17) used exact head `a5475a11ca5947ea255865f174f5ac0569d8fb07` and merged as `29409b13cc1599ba543f937c9ba5fc8b85cc46f7`.
- The release merge and annotated tag `v1.5.0` peeled commit are exactly `29409b13cc1599ba543f937c9ba5fc8b85cc46f7`; `origin/main` resolved to the same commit throughout the release freeze and production workflow. Application metadata is `1.5.0`, Android versionCode `11`.
- Public [`v1.5.0`](https://github.com/szdtzpj/Embezzle-Studio/releases/tag/v1.5.0) is the stable Latest Release. It is immutable, non-prerelease, and contains exactly three formal assets rebuilt by the protected production workflow rather than uploading the local acceptance candidate.
- Embezzle Studio still operates no production API, proxy, MCP gateway, approval server, task worker, telemetry backend, cloud sync, or app-funded quota. Provider and tool calls use the user's own account, entitlement, quota, and billing.

## `1.5.0` feature and audit boundary

1. Settings now supports persistent system, light, and dark themes and groups account, provider, model, and app controls into dedicated screens. Provider details centralize protocol, Endpoint, credential, model, and enabled-state management.
2. Manual and relay models retain explicit task and capability overrides. This restores the configuration boundary required for image/video generation and input, speech, file attachments, reasoning, and MCP routing instead of inferring unsupported capabilities from a model name alone.
3. `provider.enabled` is enforced at runtime. Disabled providers are excluded from active-model fallback, the model picker, retries, comparisons, voice, and project defaults. Disabling a provider cleans dependent targets, and the final enabled provider cannot be disabled. If storage recovery repairs legacy/corrupt state in which every provider was disabled, it also forces remote MCP off instead of silently reviving tool execution with the recovered provider.
4. User-created provider ownership is determined by the built-in ID set rather than the mutable protocol kind, so changing a custom profile's protocol cannot accidentally lock it while built-in profiles remain protected from deletion.
5. Android controls and repeated list items use a static press/motion fallback instead of creating Reanimated/Moti loops for every row. This preserves haptics while reducing the regression risk that previously appeared during repeated Chat/Settings switching.
6. Android system Back first closes an inner Settings flow, then Settings itself. Closing or changing providers clears deletion, credential-visibility, tab, selection, and manual-model transient state so details do not leak across profiles.
7. Dark-theme contrast was corrected for menus, inline editing, media overlays, warning actions, and workbench deletion/diff surfaces.
8. Confirmation and notice services now settle concurrent requests in FIFO order instead of overwriting an unresolved Promise. Long dialogs use bounded scrolling and keyboard avoidance so action buttons remain reachable on small Android screens.

## Current local quality evidence

- After the final backup/provider/media-task safety fixes, `npm.cmd run check` passes 43 test files / 779 tests; TypeScript and zero-warning ESLint are clean.
- The final Web export passes at 3,296 modules with a 7.5 MB main bundle.
- `npx.cmd expo install --check` reports current dependencies and Expo Doctor passes 20/20.
- A 390×844 dark-theme browser session completed with 0 console errors. The only two warnings were the known React Native Web deprecations for `shadow*` and `pointerEvents`.
- All 3 workflow YAML files parsed, all 35 embedded Bash blocks passed `bash -n`, and all 16 GitHub-owned Actions used full 40-character SHAs.
- `npm audit --omit=dev --audit-level=high` exited zero. Twelve moderate findings remained in Expo's toolchain dependency chain; no force fix that would replace compatible Expo packages was applied.
- The final source completed a fresh clean Expo Android prebuild, `clean assembleRelease --no-daemon`, unsigned-artifact verification, local production signing, and full APK inspection.
- `git diff --check` is the required final whitespace gate for the release worktree; this checkpoint must not be used to waive that gate after any later edit.
- The complete Web, Expo, dependency, workflow, diff, secret-boundary, and Android gates are green for the tagged release source; any later application or workflow source change requires fresh evidence for a newer build.

## Local Android candidate evidence

- The final unsigned input is 97,461,244 bytes and correctly fails `apksigner verify` before signing.
- The final local candidate is `D:\EmbezzleStudio-Releases\v1.5.0-candidate\Embezzle-Studio-v1.5.0-candidate-release.apk`, 97,595,863 bytes, SHA-256 `2456bdb7de0405f283a1a4fd0fffd0994dbcb37dd06e502e2b4aae6cbf90941f`.
- `aapt` and the packaged Manifest verify package `com.szdtzpj.embezzlestudio`, version `1.5.0` / code `11`, minSdk `24`, targetSdk `36`, `allowBackup=false`, and `adjustResize`.
- Intentional `RECORD_AUDIO` is present while CAMERA, `SYSTEM_ALERT_WINDOW`, and `REQUEST_INSTALL_PACKAGES` are absent.
- `apksigner` reports exactly one signer with production certificate SHA-256 `F5746B0DC5BD3F6E640F693FDE171BD0CD87A919998CD6CA3F8F26748ABE6C02`; APK Signature Schemes v2/v3 and zip alignment pass.
- The local candidate was not uploaded as the formal GitHub artifact. The protected workflow rebuilt from the exact tagged `main` commit; the formal APK has the same measured size but a distinct SHA-256, so the two artifacts remain explicitly distinguishable.

## Formal GitHub release evidence

- PR Quality run [`29195544004`](https://github.com/szdtzpj/Embezzle-Studio/actions/runs/29195544004), post-merge `main` Quality run [`29195629389`](https://github.com/szdtzpj/Embezzle-Studio/actions/runs/29195629389), initial Pages run [`29195629374`](https://github.com/szdtzpj/Embezzle-Studio/actions/runs/29195629374), production Android run [`29195736374`](https://github.com/szdtzpj/Embezzle-Studio/actions/runs/29195736374), and post-release Pages run [`29196365268`](https://github.com/szdtzpj/Embezzle-Studio/actions/runs/29196365268) all succeeded.
- The immutable, stable, non-prerelease [`v1.5.0` Release](https://github.com/szdtzpj/Embezzle-Studio/releases/tag/v1.5.0) contains exactly three formal assets. The Release attestation and all three asset attestations pass.
- The formal APK is stored at `D:\EmbezzleStudio-Releases\v1.5.0\Embezzle-Studio-v1.5.0-release.apk`, is 97,595,863 bytes, and has SHA-256 `bc1a3c434d00b5f4d99be29f4f1b5327d85e2efe9f7bd98286c8ce7b5614f622`.
- `aapt` and the packaged Manifest identify package `com.szdtzpj.embezzlestudio`, version `1.5.0` / code `11`, minSdk `24`, targetSdk `36`, `allowBackup=false`, and `adjustResize`. Intentional `RECORD_AUDIO` is present while CAMERA, `SYSTEM_ALERT_WINDOW`, and `REQUEST_INSTALL_PACKAGES` are absent.
- `apksigner` reports exactly one signer with production certificate SHA-256 `F5746B0DC5BD3F6E640F693FDE171BD0CD87A919998CD6CA3F8F26748ABE6C02`; APK Signature Schemes v2/v3 and zip alignment pass.
- The formal APK is the same 97,595,863-byte size as the local candidate but has a distinct hash: formal `bc1a3c434d00b5f4d99be29f4f1b5327d85e2efe9f7bd98286c8ce7b5614f622`, local candidate `2456bdb7de0405f283a1a4fd0fffd0994dbcb37dd06e502e2b4aae6cbf90941f`.
- The Pages manifest, trusted `release.html` page, and APK `HEAD` request return anonymous HTTP 200. A full anonymous download under `D:\EmbezzleStudio-Releases\v1.5.0-pages-public-verify-20260712-223505` matches the formal APK's 97,595,863-byte size and SHA-256 exactly.

## Not yet verified

- `adb devices -l` is empty. No installation or upgrade of the final Actions APK, system/light/dark theme switching, provider enable/disable cleanup, long-dialog scrolling, Settings Back flow, process-death recovery, or sustained Chat/Settings stress result is claimed for a connected Android device in this checkpoint.
- The browser result cannot replace gesture-navigation, three-button navigation, keyboard, low-memory, and long-running Android acceptance.
- No real OpenAI/MCP, Volcengine Ark, or Alibaba Bailian account was charged during this release gate. Paid-product entitlement, provider-side billing evidence, real microphone/playback behavior, and safe-MCP read/deny/cancel/reversible-write acceptance remain user-account and physical-device work.

## Remaining external/manual boundary

1. On representative gesture-navigation and three-button Android phones, install or upgrade to the formal Actions APK and exercise system/light/dark themes, provider enable/disable recovery, model task/capability overrides, long FIFO dialogs with the keyboard open, Settings Back navigation, process death, and sustained Chat/Settings switching.
2. With tightly limited user-owned OpenAI, Volcengine Ark, and Alibaba Bailian accounts, verify supported model discovery and calls, paid search/voice/media behavior, actual provider billing, and the local attempt ledger. With a trusted test MCP server, separately complete one read-only call, one denial, one cancellation, and one observable reversible write while reviewing provider and MCP retention logs.
