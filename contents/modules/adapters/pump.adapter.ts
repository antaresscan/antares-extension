import type { SiteAdapter } from "./base-adapter"
import { extractCAFromPathname, pathnameChanged, scoreAddresses } from "./base-adapter"

/**
 * Pump.fun adapter
 * URL pattern: pump.fun/coin/{CA} or pump.fun/{CA}
 * SPA: React — DOM replaced entirely on navigation
 */
export const PumpAdapter: SiteAdapter = {
  name: "Pump.fun",
  hostnames: ["pump.fun"],
  initialDelay: 500,

  extractCA(url: URL, doc: Document): string {
    if (url.pathname.startsWith("/coin/") || url.pathname.split("/").length === 2) {
      const ca = extractCAFromPathname(url)
      if (ca) return ca
    }
    return scoreAddresses(doc, url.href)
  },

  isNewToken(prev: URL, next: URL): boolean {
    return pathnameChanged(prev, next)
  }
}
