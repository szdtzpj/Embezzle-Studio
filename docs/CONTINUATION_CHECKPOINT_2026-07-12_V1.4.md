# Continuation Checkpoint — 2026-07-12 (`1.4.0`)

## Identity and publication state

- Local development branch: `codex/safe-mcp-tools-v1.4`, based on public `main` commit `bcca38af2ce195f2293bbdc16fc2a74816f21fec`.
- Development metadata: `1.4.0`, Android versionCode `10`.
- This checkpoint records a local acceptance candidate only. No v1.4 commit has been pushed, no tag or GitHub Release has been created, and public Latest remains `v1.3.0`.
- Embezzle Studio still operates no production API, proxy, MCP gateway, approval server, task worker, telemetry backend, or app-funded quota. Every provider and remote-tool call uses the user's configured account, entitlement, quota, and billing.

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

## Remaining external/manual boundary

- Android devices: install or upgrade to this candidate on representative gesture-navigation and three-button phones; verify the approval page, 32 KiB argument rejection/performance, background cancellation, process death, branch audit retention, provider deletion/restart persistence, and sustained Chat/Settings switching.
- User-owned OpenAI account and trusted test MCP server: with strict account limits, complete one read-only call, one explicit denial, one cancel, and one observable reversible write; then compare provider/MCP logs and billing with the local conservative request-attempt ledger. Review both parties' data-retention policies before sending sensitive data.
- Ark: prove with a real account that a complete `store:false` approval continuation works from locally replayed context before enabling runtime execution.
- Bailian: keep execution disabled unless its official Responses contract exposes an equivalent pre-execution approval pause and response mechanism.
- GitHub publication: only after explicit authorization, merge through the protected workflow, freeze exact `main`, create the matching `v1.4.0` tag and owner-authored empty draft, let Actions rebuild/sign, then verify the immutable Release, attestations, Pages manifest/download page, and anonymous APK bytes. The local candidate must not be uploaded as a substitute for that rebuild.
