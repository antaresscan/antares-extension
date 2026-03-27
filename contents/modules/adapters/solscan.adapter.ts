import type { SiteAdapter } from "./base-adapter"
import { extractCAFromPathname, pathnameChanged, scoreAddresses } from "./base-adapter"

/**
 * Solscan adapter
 * URL patterns: solscan.io/token/{CA}, solscan.io/account/{CA}
 * SPA: slow DOM loading, needs higher delay
 */
export const SolscanAdapter: SiteAdapter = {
  name: "Solscan",
  hostnames: ["solscan.io"],
  initialDelay: 600,

  extractCA(url: URL, doc: Document): string {
    if (url.pathname.startsWith("/token/") || url.pathname.startsWith("/account/")) {
      const ca = extractCAFromPathname(url)
      if (ca) return ca
    }
    return scoreAddresses(doc, url.href)
  },

  isNewToken(prev: URL, next: URL): boolean {
    return pathnameChanged(prev, next)
  }
}
