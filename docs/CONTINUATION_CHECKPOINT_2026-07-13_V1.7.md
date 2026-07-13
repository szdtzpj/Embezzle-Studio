# Continuation Checkpoint — 2026-07-13 (`1.7.0` formal release)

## Identity and source truth

- Application metadata is `1.7.0`, Android versionCode `13`, package `com.szdtzpj.embezzlestudio`, minSdk `24`, targetSdk `36`.
- Source starts from BlueOcean223's merged PR [#21](https://github.com/szdtzpj/Embezzle-Studio/pull/21), merge commit `350f3330083cdd82ab09722e77d1c1c4fa3e2e2b`.
- Public stable Latest is the immutable [`v1.7.0`](https://github.com/szdtzpj/Embezzle-Studio/releases/tag/v1.7.0). The local APK below remains an acceptance candidate and is not substituted for the independently rebuilt Actions asset.
- User-owned untracked product-feedback Markdown/images and ignored local credentials remain outside the release diff. No reset, checkout overwrite, broad `git add -A`, production-key copy, or secret output was used.

## `1.7.0` scope

- External BYOK search for Tavily, Brave Search, xAI Grok Search, Firecrawl, Bing, and DuckDuckGo.
- A bounded OpenAI-compatible `search_web` function loop with at most four rounds, ten results per call, a 500-character query limit, fixed timeouts, response-size limits, HTTPS-only citation URLs, and a final no-tools answer when the round cap is reached.
- Search-service credentials use the same endpoint-bound Android SecureStore / Web session-only boundary as provider credentials. Plain workspace JSON and external encrypted/plain backups omit external-search API keys; imported search is disabled by default.
- Completed answers use a repository-owned bounded Markdown subset renderer for headings, lists, blockquotes, fenced/inline code, tables, emphasis, strike-through, and explicit links. Raw HTML and fuzzy automatic linkification are unsupported; links open only after the existing HTTPS/citation resolver accepts them.
- Genuine thinking and tool activity are shown in a stable ordered timeline. Search/tool arguments and activity are bounded in the device workspace and excluded from portable backups.

## Official-provider corrections applied before release

- Tavily matches the official `POST https://api.tavily.com/search` contract with `Authorization: Bearer`, `query`, `max_results`, and `include_answer`.
- Brave matches the official Web Search endpoint, `X-Subscription-Token`, `q`, `count`, `extra_snippets=true`, and `text_decorations=false`.
- xAI Responses uses `https://api.x.ai/v1/responses`, `web_search`, and `x_search`. The default was updated from the collaborator branch's stale `grok-4-1-fast-reasoning` to the current documented `grok-4.5`; users can still enter another entitled model ID explicitly.
- Firecrawl cloud uses `POST https://api.firecrawl.dev/v2/search`, Bearer authentication, `query`, and `limit`. UI/runtime now require a key for the official cloud endpoint; only an explicitly configured self-hosted endpoint may be left unauthenticated.
- Custom search endpoints reject credentials/query fragments, non-HTTPS schemes, localhost/local hostnames, direct loopback/private/reserved IPv4, and direct local/link/unique-local/multicast IPv6 literals before a key can be sent.
- Every external-search HTML/JSON/error response has a byte limit. The collaborator's Markdown dependency introduced a no-fix high-severity `linkify-it` advisory; it was removed and replaced by the bounded repository-owned renderer, restoring the production audit to zero high/critical findings.

Official references checked on 2026-07-13:

- Tavily Search: https://docs.tavily.com/documentation/api-reference/endpoint/search
- Brave Web Search: https://api-dashboard.search.brave.com/app/documentation/web-search/get-started
- xAI tools overview: https://docs.x.ai/developers/tools/overview
- xAI Web Search: https://docs.x.ai/developers/tools/web-search
- xAI X Search: https://docs.x.ai/developers/tools/x-search
- xAI models: https://docs.x.ai/developers/models
- Firecrawl Search: https://docs.firecrawl.dev/api-reference/endpoint/search

## Local validation evidence

- `npm.cmd ci` completed from the merged lockfile. Final `npm.cmd run check` passes TypeScript, zero-warning ESLint, and 46 test files / 821 tests.
- `npm.cmd run build:web` passes with 3,303 modules and a 7.6 MB main Web bundle. `npx.cmd expo install --check` reports current dependencies; Expo Doctor passes 20/20.
- A headed Playwright session opened the exported build at the repository base path, rendered the existing assistant message through the repository-owned Markdown component, navigated Chat -> Settings -> Search Services, showed migrated Bing/DuckDuckGo defaults, the corrected Firecrawl cloud/self-host hint, and the `grok-4.5` model placeholder. The browser recorded 0 console errors and 0 warnings; no provider or search request was sent.
- `npm.cmd audit --omit=dev --audit-level=high` exits zero after the Markdown dependency removal. Twelve moderate `uuid -> xcode -> @expo/config-plugins` toolchain findings remain; the offered force fix would replace compatible Expo packages and was not applied.
- All 3 workflow YAML files parse, all 35 embedded Bash blocks pass Git Bash `bash -n`, all 16 GitHub-owned Action references remain pinned to full 40-character SHAs, changed-file secret/keystore boundaries pass, and `git diff --check` passes.
- Clean `expo prebuild --platform android --clean --no-install` generated version `1.7.0` / code `13`, `allowBackup=false`, and `adjustResize`. Release debug signing was removed only from the generated ignored Android tree; `clean assembleRelease --no-daemon` produced an actually unsigned APK.
- The unsigned build is 97,597,492 bytes with SHA-256 `823F912E32C4930204069E939D12A1F475B0F5E9DC3E50137C299267A2FD54AE`. `apksigner` rejects it as unsigned before the isolated signing step.
- The existing D-drive production identity signed the local acceptance candidate:
  - path: `D:\EmbezzleStudio-Releases\v1.7.0-candidate\Embezzle-Studio-v1.7.0-candidate-release.apk`
  - size: 97,612,048 bytes
  - SHA-256: `D6FF4F94FEAF52B5EF0A7C4FE8B03EF747FF32409C1AE58CC27478C73FA89C3F`
  - package/version/code: `com.szdtzpj.embezzlestudio` / `1.7.0` / `13`; minSdk `24`, targetSdk `36`
  - permissions: `INTERNET`, `MODIFY_AUDIO_SETTINGS`, intentional `RECORD_AUDIO`, `VIBRATE`, `ACCESS_NETWORK_STATE`, `WAKE_LOCK`, biometric/fingerprint, legacy read/write storage capped at SDK 32, and the package-scoped dynamic-receiver permission; no `CAMERA`, `SYSTEM_ALERT_WINDOW`, or `REQUEST_INSTALL_PACKAGES`
  - exactly one signer, production certificate SHA-256 `F5746B0DC5BD3F6E640F693FDE171BD0CD87A919998CD6CA3F8F26748ABE6C02`; v2/v3 signatures and zipalign pass
  - final APK timestamp is later than every changed tracked source file

## Formal publication evidence

- Release-source PR [#22](https://github.com/szdtzpj/Embezzle-Studio/pull/22) passed the required Quality check and merged as `f32a6bcf72f1599885d30b50457e9b52e5c6991b`. Remote `main`, the Release target, and the annotated `v1.7.0` tag's peeled commit match that SHA.
- main Quality run [`29248074227`](https://github.com/szdtzpj/Embezzle-Studio/actions/runs/29248074227), protected Android run [`29249471821`](https://github.com/szdtzpj/Embezzle-Studio/actions/runs/29249471821), and post-release Pages run [`29250790845`](https://github.com/szdtzpj/Embezzle-Studio/actions/runs/29250790845) completed successfully.
- The formal Release is stable Latest, immutable, non-draft, and non-prerelease. Its three assets are all in `uploaded` state and were uploaded by `github-actions[bot]`; `gh release verify` and `gh release verify-asset` for every downloaded asset validate GitHub's signed release attestation.
- Formal assets are stored under `D:\EmbezzleStudio-Releases\v1.7.0`:
  - `Embezzle-Studio-v1.7.0-release.apk`: 97,731,031 bytes, SHA-256 `638fd7cbe378d76476f1147f3cd7fbbe491e8dfb048553491387ba77319938bf`
  - `Embezzle-Studio-v1.7.0-release.apk.sha256`: 101 bytes, GitHub digest `a081e769491ab24389bb84945d892f67d349ba33618bce288dc04893fe08b6a9`
  - `apksigner-report.txt`: 998 bytes, GitHub digest `864d896cd0dbb2ce91183de0121a23d064e0ed4e03988fc15f2411ec0785583f`
- Independent Build Tools 36.0.0 inspection of the formal APK confirms `com.szdtzpj.embezzlestudio` / version `1.7.0` / code `13`, minSdk `24`, targetSdk `36`, `allowBackup=false`, and `adjustResize`. Permissions are `INTERNET`, `MODIFY_AUDIO_SETTINGS`, intentional `RECORD_AUDIO`, `VIBRATE`, `ACCESS_NETWORK_STATE`, `WAKE_LOCK`, biometric/fingerprint, legacy storage capped at SDK 32, and the package-scoped dynamic-receiver permission; `CAMERA`, `SYSTEM_ALERT_WINDOW`, and `REQUEST_INSTALL_PACKAGES` are absent.
- `apksigner` confirms exactly one signer with production certificate SHA-256 `F5746B0DC5BD3F6E640F693FDE171BD0CD87A919998CD6CA3F8F26748ABE6C02`; v2/v3 pass and zipalign succeeds.
- The public Pages manifest, trusted `release.html`, and APK `HEAD` return anonymous HTTP 200 and match the formal Release version, size, SHA-256, and managed URL. A complete anonymous Pages download stored at `D:\EmbezzleStudio-Releases\v1.7.0-pages-public-verify-20260713-204649` is 97,731,031 bytes with the same SHA-256.
- A headed browser rendered the public release page title, formal version, timestamp, filename, byte size, SHA-256, trust explanation, and download control. It exposed one console error because browsers ignore `frame-ancestors` when delivered through a meta CSP; the follow-up source removes that unsupported directive while keeping the enforceable restrictive meta policy, and adds a regression assertion.

## Not yet verified at this checkpoint

- `adb devices -l` is empty. The formal Actions APK has not been installed in this session, so Android rendering, search-provider network behavior, Markdown/table scrolling, activity animation, process memory, keyboard/inset behavior, and upgrade acceptance are not claimed from a connected device.
- The browser smoke does not exhaust every Markdown construct, narrow-screen layout, long-table horizontal scrolling, animation, or local proxy path. Production Web intentionally rejects provider/search calls; only local explicit proxy mode can exercise them.
- No real Tavily, Brave, xAI, Firecrawl, Bing, or DuckDuckGo request was made. Entitlement, billing, quotas, provider-side retention, anti-bot behavior, regional availability, and live response variants remain user-account/network boundaries.

## Remaining external acceptance boundary

1. Install the formal Actions APK on representative Android devices, including an upgrade from the preceding production signature, and exercise keyboard/insets, Markdown/table scrolling, activity animation, media, search, memory pressure, and settings/chat switching.
2. Use explicitly authorized test accounts to exercise Tavily, Brave, xAI, Firecrawl, Bing, and DuckDuckGo, checking entitlement, quotas, billing, provider-side retention, regional behavior, and live response variants.
3. Keep the local candidate and formal Actions asset distinct; all public release claims and distribution must continue to use the formal 97,731,031-byte APK and its `638fd7...938bf` digest.
