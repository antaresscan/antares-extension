// Use env var for API URL so local dev can point to localhost
// Plasmo exposes PLASMO_PUBLIC_* vars to content scripts at build time
export const API           = process.env.PLASMO_PUBLIC_API_URL || "https://antares-extension.vercel.app/api/scan"
export const ANALYSIS_PAGE = process.env.PLASMO_PUBLIC_ANALYSIS_URL || "https://antares-extension.vercel.app/token.html"
// Derive sibling endpoints from the scan URL so all routes follow the same
// base — keeps local dev (localhost) and prod (vercel) in sync without
// needing extra env vars per endpoint.
const API_ORIGIN = (() => {
  try {
    return new URL(API).origin
  } catch {
    return "https://antares-extension.vercel.app"
  }
})()
export const WATCHLIST_API = `${API_ORIGIN}/api/watchlist`
export const PRICING_URL   = "https://antares-website.vercel.app/pricing"
export const LS_PREFIX     = "antares_scan_"
export const CACHE_TTL    = 5 * 60 * 1000
export const POS_KEY       = "antares_popup_pos"

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
