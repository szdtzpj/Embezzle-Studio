# Continuation Checkpoint — 2026-07-13 (`1.7.0` release source)

## Identity and source truth

- Application metadata is `1.7.0`, Android versionCode `13`, package `com.szdtzpj.embezzlestudio`, minSdk `24`, targetSdk `36`.
- Source starts from BlueOcean223's merged PR [#21](https://github.com/szdtzpj/Embezzle-Studio/pull/21), merge commit `350f3330083cdd82ab09722e77d1c1c4fa3e2e2b`.
- Public stable Latest remains immutable [`v1.6.0`](https://github.com/szdtzpj/Embezzle-Studio/releases/tag/v1.6.0) until the protected `v1.7.0` workflow completes. The local APK below is an acceptance candidate, not a GitHub Release asset.
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

## Not yet verified at this checkpoint

- `adb devices -l` is empty. The candidate has not been installed in this session, so Android rendering, search-provider network behavior, Markdown/table scrolling, activity animation, process memory, keyboard/inset behavior, and upgrade acceptance are not claimed from a connected device.
- The browser smoke does not exhaust every Markdown construct, narrow-screen layout, long-table horizontal scrolling, animation, or local proxy path. Production Web intentionally rejects provider/search calls; only local explicit proxy mode can exercise them.
- No real Tavily, Brave, xAI, Firecrawl, Bing, or DuckDuckGo request was made. Entitlement, billing, quotas, provider-side retention, anti-bot behavior, regional availability, and live response variants remain user-account/network boundaries.

## Publication boundary after local acceptance

1. Commit only the tracked `1.7.0` release-source diff and push `codex/release-external-search-v1.7.0`.
2. Open a ready PR, wait for the required Quality workflow, and merge through the protected main branch.
3. Re-run Quality/Pages checks on the exact merge commit, create an annotated `v1.7.0` tag plus empty Draft Release, and dispatch the protected Android workflow.
4. Verify the immutable formal Release, three bot-uploaded assets and digests, formal APK identity/signature/permissions, Pages manifest, trusted `release.html`, anonymous HEAD, and a complete anonymous APK download.
5. Update README/checkpoint publication truth after the formal asset exists; never substitute the local candidate's size or digest for the Actions-built APK.
