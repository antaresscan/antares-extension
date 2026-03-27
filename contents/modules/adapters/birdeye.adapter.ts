import type { SiteAdapter } from "./base-adapter"
import { extractCAFromPathname, scoreAddresses } from "./base-adapter"

/**
 * Birdeye adapter
 * URL pattern: birdeye.so/token/{CA}?chain=solana&tab=overview...
 * SPA: React — adds query params progressively WITHOUT changing token
 * KEY ISSUE: MutationObserver must compare PATHNAME only, not full href
 */
export const BirdeyeAdapter: SiteAdapter = {
  name: "Birdeye",
  hostnames: ["birdeye.so"],
  initialDelay: 300,

  extractCA(url: URL, doc: Document): string {
    // birdeye.so/token/{CA} — CA is in the pathname
    if (url.pathname.startsWith("/token/")) {
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
