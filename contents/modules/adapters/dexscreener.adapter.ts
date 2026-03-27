import type { SiteAdapter } from "./base-adapter"
import { extractCAFromPathname, pathnameChanged, scoreAddresses } from "./base-adapter"

/**
 * DexScreener adapter
 * URL pattern: dexscreener.com/solana/{CA}
 * SPA: Next.js — pathname changes on token switch, stable DOM
 */
export const DexScreenerAdapter: SiteAdapter = {
  name: "DexScreener",
  hostnames: ["dexscreener.com"],
  initialDelay: 300,

  extractCA(url: URL, doc: Document): string {
    // DexScreener puts the CA directly in /solana/{CA}
    if (url.pathname.startsWith("/solana/")) {
      const ca = extractCAFromPathname(url)
      if (ca) return ca
    }
    // Fallback to generic scoring
    return scoreAddresses(doc, url.href)
  },

  isNewToken(prev: URL, next: URL): boolean {
    // Only pathname changes matter on DexScreener
    return pathnameChanged(prev, next)
  }
}
