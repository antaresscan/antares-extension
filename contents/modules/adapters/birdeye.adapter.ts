import type { SiteAdapter } from "./base-adapter"
import { extractCAFromPathname, scoreAddresses } from "./base-adapter"

/**
 * Birdeye adapter
 * 
 * URL patterns:
 *   - birdeye.so/token/{CA}?chain=solana     (legacy, redirects to canonical)
 *   - birdeye.so/solana/token/{CA}            (current canonical URL)
 *   - birdeye.so/solana/token/{CA}?tab=overview&chain=solana  (tab changes)
 * 
 * DOUBLE SCAN PREVENTION:
 *   1. extractCA prioritizes pathname (most reliable on Birdeye)
 *   2. isNewToken compares pathname ONLY — query params are cosmetic
 *   3. scoreAddresses is only used as fallback (e.g. multi-chain pages)
 * 
 * KNOWN GOTCHA: Birdeye embeds a Jupiter swap widget that contains
 * SOL and other token addresses in the DOM. These must NOT be picked
 * up as the "main" token. Pathname extraction avoids this entirely.
 */
export const BirdeyeAdapter: SiteAdapter = {
  name: "Birdeye",
  hostnames: ["birdeye.so"],
  initialDelay: 400,

  extractCA(url: URL, doc: Document): string {
    // 1. Birdeye canonical: /solana/token/{CA} or legacy /token/{CA}
    //    This is the MOST reliable source — always prefer it
    if (url.pathname.includes("/token/")) {
      const ca = extractCAFromPathname(url)
      if (ca) return ca
    }

    // 2. Fallback: score DOM addresses
    //    Filter out Jupiter swap widget addresses to prevent false positives
    return scoreAddresses(doc, url.href)
  },

  isNewToken(prev: URL, next: URL): boolean {
    // CRITICAL: Birdeye progressively adds query params:
    //   ?chain=solana -> &tab=overview -> etc.
    // These are NOT token changes.
    // Also ignore hash changes (#chart, #trades, etc.)
    // ONLY pathname changes indicate a new token.
    return prev.pathname !== next.pathname
  }
}
