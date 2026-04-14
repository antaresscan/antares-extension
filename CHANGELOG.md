# Changelog

All notable changes to the Antares Extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- OHLCV v8 rug fingerprint patterns: Post-ATH dump, Dead Cat Bounce, Wick Trap, Rug Staircase, Micro-window pump
- Creator reputation detection (serial deployer flagging via Helius)
- Cross-validation layer with penalty multipliers (LP burn, mint authority, age, holder concentration)
- `lp_unverified` classification for mature tokens with unburned LP
- Smart LP maturity context (holders, liquidity, age thresholds)
- Deceptive name detection (financial institution impersonation)
- Adaptive cache TTL based on token age
- CI/CD pipelines: ci.yml, release.yml, secret-scan.yml, submit.yml
- Sentry error monitoring integration
- Shadow DOM font injection for extension overlay
- Bundle percentage extraction from RugCheck reports
- XSS sanitization helpers (sanitizeString, sanitizeUrl)
- Runtime type guards for all external API responses

### Changed
- Scoring engine: geometric weighted mean with diminishing penalties
- Layer weights centralized in constants.ts
- Cross-validation now applied as post-score multiplier
- ESTABLISHED_HOLDERS_THRESHOLD hardened from 1000 to 5000
- ESTABLISHED_BONUS_MULTIPLIER hardened from +15% to +5%
- Helius holder resolution: token accounts resolved to owner wallets
- LP program addresses expanded (Meteora DAMM v2, DBC, PumpSwap)

### Fixed
- LP not burned/locked now correctly blocks SAFE verdict
- Extreme 24h pump tokens (+1000-5000%) no longer pass as SAFE
- Tax between 2-10% now flagged (previously invisible)
- Low holders (<15) now a hard block reason
- Deceptive names now a hard block reason
- RugCheck layer with unmatched safeBlocked flags now classified correctly

### Removed
- Layer 7 (Identity/Copycat) removed due to massive false positives

## [4.5.3] - 2026-04-08

### Fixed
- Initial stable release with 6-layer scoring engine
- DexScreener, RugCheck, GoPlus, Helius, Solscan, Chart layers
