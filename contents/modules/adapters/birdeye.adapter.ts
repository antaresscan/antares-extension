import type { SiteAdapter } from "./base-adapter"
import { extractCAFromPathname } from "./base-adapter"

/**
 * Extract the token CA from a Birdeye URL pathname.
 * Handles both formats:
 *   /token/{CA}           (legacy, redirects to canonical)
 *   /solana/token/{CA}    (canonical)
 * Returns empty string if no CA found in path.
 * NOTE: We intentionally do NOT fall back to DOM scoring on Birdeye.
 * The DOM contains many addresses (portfolio, watchlist, trending).
 * Falling back produces wrong analyses for the wrong token.
 */
function caFromBirdeyePath(url: URL): string {
  if (!url.pathname.includes("/token/")) return ""
  return extractCAFromPathname(url)
}

/**
 * Birdeye adapter
 *
 * ROOT CAUSE OF DOUBLE SCAN (2 sources):
 *
 * 1) Birdeye redirects /token/{CA}?chain=solana -> /solana/token/{CA}
 *    via history.replaceState. The old isNewToken() compared raw pathnames,
 *    so "/token/BONK" vs "/solana/token/BONK" was seen as a NEW token,
 *    triggering resetState() + scan() — then the initial setTimeout poll
 *    fired a SECOND scan.
 *    FIX: isNewToken() extracts the CA from both URLs and compares CAs.
 *
 * 2) The MutationObserver in setupNavListeners fires onNav() at the same
 *    time as replaceState, causing a race condition on state.lastUrl.
 *    FIX: isNewToken() is idempotent — comparing same CA always returns false.
 *
 * ROOT CAUSE OF BAD ANALYSES:
 *    initialDelay: 400ms was too short. Birdeye SPA takes 800-1200ms to
 *    render the token address in the URL after a navigation or redirect.
 *    With only 400ms, extractCA ran BEFORE the URL settled on /solana/token/{CA},
 *    found nothing in the path, fell back to DOM scoreAddresses(), and picked
 *    a random address from the trending/portfolio section.
 *    FIX: initialDelay: 1200ms + no DOM fallback on Birdeye.
 */
export const BirdeyeAdapter: SiteAdapter = {
  name: "Birdeye",
  hostnames: ["birdeye.so"],
  // 1200ms: gives Birdeye SPA enough time to redirect and settle on
  // the canonical /solana/token/{CA} URL before we extract the address.
  initialDelay: 1200,
  extractCA(url: URL, _doc: Document): string {
    // Birdeye canonical: /solana/token/{CA} or legacy /token/{CA}
    // Do NOT fall back to DOM — Birdeye pages contain hundreds of
    // unrelated addresses (portfolio, watchlist, trending bars).
    return caFromBirdeyePath(url)
  },
  isNewToken(prev: URL, next: URL): boolean {
    // Extract CA from both URLs and compare.
    // This handles the redirect /token/{CA} -> /solana/token/{CA}
    // which changes the pathname but NOT the token.
    const prevCA = caFromBirdeyePath(prev)
    const nextCA = caFromBirdeyePath(next)
    // If both URLs have a CA in the path, compare them directly
    if (prevCA && nextCA) return prevCA !== nextCA
    // If one has a CA and the other doesn't, it's a different page type
    if (prevCA !== nextCA) return true
    // Neither has a CA (e.g. /trending -> /trending), compare pathnames
    return prev.pathname !== next.pathname
  }
}
