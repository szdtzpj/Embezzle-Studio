# Continuation Checkpoint — 2026-07-12 (`1.4.0`)

## Identity and publication state

- Release PR [#15](https://github.com/szdtzpj/Embezzle-Studio/pull/15) used head commit `1176df7964712078d58c5eade50d781a8245d52e` and merged into public `main` as `f83cea7fae36fcbaa0bff361fac2113c3edfb3d7`.
- Tag `v1.4.0` points exactly to `f83cea7fae36fcbaa0bff361fac2113c3edfb3d7`; application metadata is `1.4.0`, Android versionCode `10`.
- Public [`v1.4.0`](https://github.com/szdtzpj/Embezzle-Studio/releases/tag/v1.4.0) is the stable, non-prerelease, immutable Latest Release. It was rebuilt and signed by the protected GitHub Actions workflow rather than uploading the local acceptance candidate.
- Embezzle Studio still operates no production API, proxy, MCP gateway, approval server, task worker, telemetry backend, or app-funded quota. Every provider and remote-tool call uses the user's configured account, entitlement, quota, and billing.
- GitHub's personal-repository model cannot make a collaborator a second owner. `BlueOcean223` has the platform's maximum collaborator permission (`write`) and a `pull_request` bypass on the owner-gated main-update ruleset, so they can merge PRs after the required Quality check passes; they are not the owner, and owner-only release-tag creation, signing secrets, and production workflow gates remain unchanged.

## Implemented v1.4 boundary

1. Only the dedicated `openai-compatible` profile whose inspected canonical Base URL is exactly `https://api.openai.com/v1` can execute provider-hosted MCP. Lookalike hosts, custom ports, abnormal paths, custom/relay profiles, Ark, and Bailian fail closed.
2. Every OpenAI request repeats a non-empty exact `allowed_tools` allowlist, `require_approval: "always"`, `store: false`, `parallel_tool_calls: false`, and `include: ["reasoning.encrypted_content"]`. Continuations manually replay the complete local context rather than using `previous_response_id`.
3. Every tool pauses on a full-screen, safe-area-aware approval page showing provider, model, MCP server, server label, HTTPS endpoint, exact tool, exact raw JSON, and UTF-8 byte count. Approve, deny, and cancel are distinct; no approval is remembered, and one turn is capped at four approvals.
4. Approval settlement is bound to both the provider approval ID and a local nonce. Double taps are synchronously blocked, backgrounding cancels the whole MCP lifecycle, and every initial/continuation send rechecks the active request, AbortSignal, and foreground state after local ledger persistence.
5. MCP Responses, approval IDs, call IDs, raw arguments, call outputs, and authorization are strictly correlated and bounded. Replays, ambiguous list-tools results, missing encrypted reasoning state, redirects, unknown items, malformed arguments, or mismatched calls terminate the turn. Raw approval arguments are capped at 32 KiB UTF-8 for bounded Android rendering.
6. Re-running a branch cannot erase evidence after a provider request or possible tool side effect. The restored branch receives a local audit stub that is excluded from model context and contains only bounded, secret-free activity metadata; uncertain side effects stay marked `unknown`.
7. Provider deletion removes all bound MCP entries in the same state transition. The existing transactional persistence path deletes provider and MCP secrets only after the reference-free workspace commit succeeds.
8. Backup export excludes provider/MCP secrets, media, the local request-attempt ledger, and MCP activity summaries. Backup import always restores remote MCP entries disabled; internal storage also disables every non-exact-OpenAI binding.
9. `store: false` controls Responses object storage only. It does not override OpenAI organization data controls, provider security logs, or the remote MCP server's own logging and retention policy.

## Final local evidence

- `npm.cmd run check` passes 41 test files / 749 tests; TypeScript and zero-warning ESLint are clean.
- Final Web export passes at 3,264 modules with a 7.4 MB main bundle.
- A 390×844 real-browser session used only a local intercepted provider fixture. It exercised full-argument approval, approve, deny, and cancel; verified both initial and approved/denied continuation bodies used `store:false`, `parallel_tool_calls:false`, and exactly `allowed_tools:["search_docs"]`; confirmed cancel made no continuation; and rendered the bounded MCP activity panel. After a clean reload of the final code, approve was repeated successfully. Network history contained only loopback `127.0.0.1:8787/proxy` POSTs, console errors were zero, and the only two warnings were React Native Web deprecations for `shadow*` and `props.pointerEvents`.
- `npx.cmd expo install --check` reports current dependencies and Expo Doctor passes 20/20.
- All 3 workflow YAML files parse, all 35 embedded Bash blocks pass `bash -n`, all 16 GitHub-owned Actions use full 40-character SHAs, `git diff --check` passes, and changed-file credential/keystore scans find no production secret artifact.
- `npm audit --omit=dev --audit-level=high` exits zero. Twelve moderate findings remain in Expo's `uuid -> xcode -> @expo/config-plugins` toolchain; the offered force fix would install an incompatible Expo package and was not applied blindly.
- Clean Expo Android prebuild and `clean assembleRelease --no-daemon` pass after removing the generated debug Release signing assignment. The built input is proven unsigned before local signing.
- The local production-signed candidate is `D:\EmbezzleStudio-Releases\v1.4.0-candidate\Embezzle-Studio-v1.4.0-candidate-release.apk`, 97,518,039 bytes, SHA-256 `683eb6e98efec3e301594e59c627b3698b410c2a58f841b3c3c3642b1a2a20ed`.
- `aapt` identifies `com.szdtzpj.embezzlestudio`, version `1.4.0` / code `10`, minSdk `24`, targetSdk `36`, `allowBackup=false`, and `adjustResize`. Intentional `RECORD_AUDIO`/audio permissions are present; CAMERA and `SYSTEM_ALERT_WINDOW` are absent.
- `apksigner` reports exactly one signer with production certificate SHA-256 `F5746B0DC5BD3F6E640F693FDE171BD0CD87A919998CD6CA3F8F26748ABE6C02`; APK Signature Schemes v2/v3 and zip alignment pass.
- `adb devices -l` is empty. No physical-device or real-provider-account result is claimed.

## Formal GitHub release evidence

- PR Quality run [`29182946741`](https://github.com/szdtzpj/Embezzle-Studio/actions/runs/29182946741), post-merge `main` Quality run [`29183001171`](https://github.com/szdtzpj/Embezzle-Studio/actions/runs/29183001171), pre-tag Pages run [`29183001176`](https://github.com/szdtzpj/Embezzle-Studio/actions/runs/29183001176), production Android run [`29183097617`](https://github.com/szdtzpj/Embezzle-Studio/actions/runs/29183097617), and post-release Pages run [`29183525831`](https://github.com/szdtzpj/Embezzle-Studio/actions/runs/29183525831) all succeeded.
- The immutable Release contains exactly 3 `github-actions[bot]`-uploaded assets. Release attestation and all 3 asset attestations verify, and the tag, `main`, Release target, and workflow source all resolve to `f83cea7fae36fcbaa0bff361fac2113c3edfb3d7`.
- The formal `Embezzle-Studio-v1.4.0-release.apk` is 97,518,039 bytes with SHA-256 `c650e142e221821f8da91e37fefd76dad0e7ad94c0348a3d7749b69f14fc67eb`. It is intentionally distinguished from the same-size local candidate whose SHA-256 is `683eb6e98efec3e301594e59c627b3698b410c2a58f841b3c3c3642b1a2a20ed`.
- Independent `aapt` inspection identifies package `com.szdtzpj.embezzlestudio`, version `1.4.0` / code `10`, minSdk `24`, targetSdk `36`, `allowBackup=false`, and `adjustResize`. Intentional `RECORD_AUDIO` is present; CAMERA and `SYSTEM_ALERT_WINDOW` are absent.
- Independent `apksigner` inspection reports exactly one signer with production certificate SHA-256 `F5746B0DC5BD3F6E640F693FDE171BD0CD87A919998CD6CA3F8F26748ABE6C02`; APK Signature Schemes v2/v3 and zip alignment pass.
- Formal assets are stored under `D:\EmbezzleStudio-Releases\v1.4.0`. The Pages manifest, `release.html`, APK `HEAD`, and full APK download all return anonymous HTTP 200 and match the Release metadata and bytes; the public verification copy under `D:\EmbezzleStudio-Releases\v1.4.0-pages-public-verify-20260712-150424` has the same size and SHA-256.

## Remaining external/manual boundary

- Android devices: install or upgrade to the formal Actions APK on representative gesture-navigation and three-button phones; verify the approval page, 32 KiB argument rejection/performance, background cancellation, process death, branch audit retention, provider deletion/restart persistence, and sustained Chat/Settings switching.
- User-owned OpenAI account and trusted test MCP server: with strict account limits, complete one read-only call, one explicit denial, one cancel, and one observable reversible write; then compare provider/MCP logs and billing with the local conservative request-attempt ledger. Review both parties' data-retention policies before sending sensitive data.
- Ark: prove with a real account that a complete `store:false` approval continuation works from locally replayed context before enabling runtime execution.
- Bailian: keep execution disabled unless its official Responses contract exposes an equivalent pre-execution approval pause and response mechanism.
