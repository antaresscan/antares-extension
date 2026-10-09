// Use env var for API URL so local dev can point to localhost
// Plasmo exposes PLASMO_PUBLIC_* vars to content scripts at build time
export const API           = process.env.PLASMO_PUBLIC_API_URL || "https://antares-extension.vercel.app/api/scan"
export const ANALYSIS_PAGE = process.env.PLASMO_PUBLIC_ANALYSIS_URL || "https://antares-extension.vercel.app/token.html"
export const PRICING_URL   = "https://antaresscan.com/pricing"
/**
 * LEGACY page-localStorage prefix. Earlier versions mirrored scans (plus the
 * session JWT) into the HOST SITE's localStorage under this prefix. It is now
 * only used to purge those leftovers (cache.ts purgeLegacyPageStorage) —
 * never write anything under it again.
 */
export const LS_PREFIX     = "antares_scan_"
/**
 * Scan-cache key prefix in chrome.storage.local (extension-private: host
 * pages can neither read nor forge it). Deliberately NOT "antares_scan_":
 * that prefix also matches `antares_scan_history`, which a prefix-wide
 * sweep or clear would wipe.
 */
export const SCAN_CACHE_PREFIX = "antares_cache:scan:"
/** Upper bound on persisted scans (a scan payload is ~15-40 KB). */
export const SCAN_CACHE_MAX_ENTRIES = 60
export const CACHE_TTL    = 5 * 60 * 1000
export const POS_KEY       = "antares_popup_pos"

/**
 * Single uniform delay before the first poll fires after page load.
 *
 * Per-adapter delays (400-1200ms) used to vary the experience across
 * sites — fast on dexscreener, slow on Birdeye. We unified to one value
 * so the overlay's first appearance feels consistent everywhere, no
 * matter what site the user is on.
 *
 * 1000ms picked because:
 *  - Birdeye SPA hydrates in 800-1200ms (the longest in the matrix);
 *    1000ms lands inside that window and works for the majority of
 *    Birdeye loads. Earlier adapter-specific value was 1200ms — we
 *    accept slightly tighter timing to keep all sites uniform.
 *  - Other sites (dexscreener, pump.fun, axiom, etc.) only needed
 *    400-800ms but the extra ~300ms is imperceptible relative to the
 *    network round-trip on the scan call that follows immediately.
 *  - Single source of truth: tune in this file if site SPAs change.
 *
 * Minimum visible loading time on the silent-rescan shimmer is gated
 * separately (see scanner.ts MIN_REFRESH_MS) — that one keeps the
 * shimmer on screen for at least ~500ms even when the API is fast,
 * so login/logout never produces a sub-perceptible flash.
 */
export const INITIAL_POLL_DELAY = 1000

export const RISK_CLASS: Record<string, string> = {
  SAFE:    "safe",
  CAUTION: "caution",
  DANGER:  "danger",
  RUG:     "rug"
}

export const LABELS: Record<string, string> = {
  SAFE: "SAFE", CAUTION: "CAUTION", DANGER: "DANGER", RUG: "RUG PULL"
}

// NON-global regex: callers must use new RegExp or matchAll to avoid lastIndex issues
// Use makeSOLAddrRegex() for each independent match operation
export const SOL_ADDR     = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g
/** Create a fresh non-stateful SOL address regex for independent match operations */
export function makeSOLAddrRegex(): RegExp {
  return /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g
}
export const WALKER_LIMIT = 500
export const IGNORE = new Set([
  "11111111111111111111111111111111",
  "So11111111111111111111111111111112",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "SysvarRent111111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111",
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
  "TokenzQdBNbequAOoiqaLs8AA6CRCmvsembyniztzCFm",
  "ComputeBudget111111111111111111111111111111",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
])

export const SVG_MOVE = `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 1L5.5 3h3L7 1Z" fill="currentColor"/><line x1="7" y1="2.5" x2="7" y2="6.5" stroke="currentColor" stroke-width=".9" stroke-linecap="round"/><path d="M7 13L5.5 11h3L7 13Z" fill="currentColor"/><line x1="7" y1="11.5" x2="7" y2="7.5" stroke="currentColor" stroke-width=".9" stroke-linecap="round"/><path d="M1 7L3 5.5V8.5L1 7Z" fill="currentColor"/><line x1="2.5" y1="7" x2="6.5" y2="7" stroke="currentColor" stroke-width=".9" stroke-linecap="round"/><path d="M13 7L11 5.5V8.5L13 7Z" fill="currentColor"/><line x1="11.5" y1="7" x2="7.5" y2="7" stroke="currentColor" stroke-width=".9" stroke-linecap="round"/></svg>`

export const SVG_CLOSE = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg"><line x1="2" y1="2" x2="11" y2="11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><line x1="11" y1="2" x2="2" y2="11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`

export const VERDICT_COLORS: Record<string, string> = {
  SAFE: "#00e5b0", CAUTION: "#f5d000", DANGER: "#ff5f5f", RUG: "#ff2244",
}

// ─── Affiliate ────────────────────────────────────────────────────────────────
// Set PLASMO_PUBLIC_PHOTON_REF at build time (or hardcode here once we have a
// real referral handle). When empty the affiliate row is hidden — no link is
// shown to users until we actually have an upstream affiliate relationship.
//
// Free users only: Pro/Lifetime get a clean overlay (one of the things they
// paid for is "no affiliate prompts"). Safe tokens only: never recommend
// trading on a DANGER/RUG verdict, that would be reputational suicide.
export const PHOTON_REF = process.env.PLASMO_PUBLIC_PHOTON_REF || ""

/** Build a Photon trade URL with our referral handle baked in. */
export function buildPhotonUrl(tokenAddress: string): string {
  if (!PHOTON_REF) return ""
  const encoded = encodeURIComponent(tokenAddress)
  // Photon's referral URL format is `/en/r/<handle>/<token-address>` — confirm
  // when signing up for the program and adjust if their schema differs.
  return `https://photon-sol.tinyastro.io/en/r/${encodeURIComponent(PHOTON_REF)}/${encoded}`
}
