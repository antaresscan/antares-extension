# Changelog

All notable changes to the Antares Extension are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.2.0] - 2026-04-25

### Added — scale & resilience
- Per-fetch deadline with graceful degradation when one upstream stalls;
  the scan now returns a partial verdict instead of a 504 ([#275](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/275))
- Runtime Zod validation for upstream GoPlus, RugCheck and Helius
  responses; schema drift now silently drops a layer instead of
  feeding garbage into the scoring engine ([#276](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/276))
- Structured `scan.outcome` telemetry on every completed scan and
  `scan.cache_hit` telemetry on cache-hit paths ([#277](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/277), [#279](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/279))
- Rate limiting can now key on `(ip, install)` when the extension
  sends an `X-Antares-Install` header — closes the shared-NAT quota
  starvation ([#278](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/278), client emission [#284](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/284))

### Added — listing readiness
- Comprehensive **Supported platforms** section in `README.md` with
  every adapter and its purpose ([#280](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/280))
- GDPR-compliant privacy policy at `/privacy.html` covering every
  processor (Vercel, Upstash, Gemini, Sentry, the six data sources)
  and full data-subject rights; `/api/privacy` now 301-redirects to
  the canonical document ([#282](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/282))
- Security policy switched to GitHub Private Vulnerability Reporting
  with a real intake URL and concrete SLAs ([#281](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/281))

### Added — backtest harness
- J1 scaffold: type contract for time-travel scoring, auto-label rules
  (RUG / DANGER / SAFE) with multi-oracle ground-truth confidence, and
  34 unit tests covering the labeling logic ([#296](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/296))

### Changed
- Default `fetchJson` / `fetchJsonPost` `maxRetries` lowered from 2 to 1
  to fit the Vercel 10s function budget ([#273](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/273))
- `RugCheck /report` timeout lowered from 8000 ms to 5000 ms; the four
  Helius POST helpers now opt out of the second retry explicitly so
  worst-case latency stays under budget ([#274](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/274))
- AI summary panel rendering rewritten with the DOM API
  (`createElement` + `textContent`) instead of `innerHTML` — the local
  `escapeHtml` helper is gone because `textContent` is structurally
  safe ([#283](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/283))
- SPA navigation listeners are now idempotent and provide a
  `cleanupNavListeners()` that disconnects the `MutationObserver` and
  restores the original `history.pushState` / `replaceState` on
  toggle-off ([#285](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/285))
- Overlay components now build DOM via `createElement` + `replaceChildren`
  end-to-end (skeleton + result + scanner) instead of template literal
  `innerHTML` strings — the entire scan-result pipeline is now structurally
  XSS-safe by construction ([#291](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/291), [#292](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/292), [#295](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/295))
- Cache TTL is now **asymmetric by verdict**: bad verdicts (RUG / DANGER)
  cache for 30 / 10 min, good verdicts on young tokens cache for 20 s. A
  stale-bad verdict is safe (user does not buy); a stale-good verdict is
  dangerous (user buys based on stale data). ([#298](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/298))
- All 14 `console.log` calls in the AI summary path replaced with the
  structured `logger` so production logs ship to telemetry instead of
  the browser console ([#299](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/299))

### Performance
- `getRecentRugs` now uses Redis `MGET` instead of N pipelined `GET`s,
  cutting the rug-DB round-trip from O(N) to O(1) ([#293](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/293))
- Insider-graph layer caps at 20 holders + per-wallet signature cache,
  keeping Helius parallel pressure bounded on whale-heavy tokens ([#294](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/294))
- `token.html` extracts inline scripts to external files with a 1-year
  immutable cache header — eliminates render-blocking inline JS and
  enables CDN caching ([#290](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/290))

### Fixed
- Verdict label was interpolated unescaped into `<h1>${label}</h1>`,
  making an upstream-controlled `risk` field exploitable as XSS;
  every interpolation in `buildResult` is now escaped ([#283](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/283))
- Permanent `history.pushState` / `replaceState` wrappers leaked
  across extension toggle cycles, measurably slowing host SPAs over
  time ([#285](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/285))

### Removed
- `bullx.io` and `neo.bullx.io` from `host_permissions` and the API
  CORS allowlist — they had no adapter and were dead permission
  surface ([#280](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/280))
- `security@antares.boo` from `SECURITY.md` — non-resolving address
  replaced with the GitHub Private Vulnerability Reporting flow ([#281](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/281))
- `validators.ts` and its tests — dead code superseded by the Zod
  upstream-schemas introduced in #276 ([#297](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/297))
- Legacy `index.html` from the extension repo; root path now redirects
  to the marketing site at `antares-website.vercel.app` so the two
  surfaces don't compete for SEO / canonical ([#287](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/287))
- Dead landing-page e2e tests + scope-clarifying README pass for the
  repo split ([#289](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/289))

### Dependencies
- Bumped to current minor / patch ranges: `@sentry/browser` 10.50.0,
  `@sentry/node` 10.50.0, `prettier` 3.8.3, `@types/chrome` 0.1.40,
  `@vitest/coverage-v8` 4.1.5, `trufflehog` action 3.95.2.
- Added: `zod` 3.25.x as an explicit production dependency;
  `happy-dom` as a vitest devDep so extension content scripts can be
  unit-tested.

## [1.1.0] - 2026-04-08

### Added
- OHLCV v8 rug fingerprint patterns: Post-ATH dump, Dead Cat Bounce,
  Wick Trap, Rug Staircase, Micro-window pump
- Creator reputation detection (serial deployer flagging via Helius)
- Cross-validation layer with penalty multipliers (LP burn, mint
  authority, age, holder concentration)
- `lp_unverified` classification for mature tokens with unburned LP
- Smart LP maturity context (holders, liquidity, age thresholds)
- Deceptive name detection (financial institution impersonation)
- Adaptive cache TTL based on token age
- CI/CD pipelines: `ci.yml`, `release.yml`, `secret-scan.yml`,
  `submit.yml`
- Sentry error monitoring integration
- Shadow DOM font injection for extension overlay
- Bundle percentage extraction from RugCheck reports
- XSS sanitization helpers (`sanitizeString`, `sanitizeUrl`)
- Runtime type guards for all external API responses

### Changed
- Scoring engine: geometric weighted mean with diminishing penalties
- Layer weights centralised in `constants.ts`
- Cross-validation now applied as post-score multiplier
- `ESTABLISHED_HOLDERS_THRESHOLD` hardened from 1000 to 5000
- `ESTABLISHED_BONUS_MULTIPLIER` hardened from +15% to +5%
- Helius holder resolution: token accounts resolved to owner wallets
- LP program addresses expanded (Meteora DAMM v2, DBC, PumpSwap)

### Fixed
- LP not burned / locked now correctly blocks SAFE verdict
- Extreme 24h pump tokens (+1000-5000%) no longer pass as SAFE
- Tax between 2-10% now flagged (previously invisible)
- Low holders (<15) now a hard block reason
- Deceptive names now a hard block reason
- RugCheck layer with unmatched `safeBlocked` flags now classified
  correctly

### Removed
- Layer 7 (Identity / Copycat) removed due to massive false positives
