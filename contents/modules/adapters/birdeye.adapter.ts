import type { SiteAdapter } from "./base-adapter"
import { extractCAFromPathname, scoreAddresses } from "./base-adapter"

/**
 * Birdeye adapter
 * URL patterns:
 *   - birdeye.so/token/{CA}?chain=solana  (old, redirects)
 *   - birdeye.so/solana/token/{CA}         (current canonical URL)
 * SPA: React — adds query params progressively WITHOUT changing token
 * KEY ISSUE: MutationObserver must compare PATHNAME only, not full href
 */
export const BirdeyeAdapter: SiteAdapter = {
  name: "Birdeye",
  hostnames: ["birdeye.so"],
  initialDelay: 300,

  extractCA(url: URL, doc: Document): string {
    // Birdeye canonical: /solana/token/{CA} or legacy /token/{CA}
    if (url.pathname.includes("/token/")) {
      const ca = extractCAFromPathname(url)
      if (ca) return ca
    }
    return scoreAddresses(doc, url.href)
  },

  isNewToken(prev: URL, next: URL): boolean {
    // CRITICAL: Birdeye adds ?chain=solana, &tab=overview, etc.
    // These are NOT token changes — only pathname matters
    return prev.pathname !== next.pathname
  }
}
