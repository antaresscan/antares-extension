import type { SiteAdapter } from "./base-adapter"
import { extractCAFromPathname, pathnameChanged, scoreAddresses } from "./base-adapter"

/**
 * Photon (TinyAstro) adapter
 * URL pattern: photon-sol.tinyastro.io/en/lp/{CA} or /en/r/.../{CA}
 * SPECIAL: Must skip /lp/ pages (liquidity pool, not token)
 */
export const PhotonAdapter: SiteAdapter = {
  name: "Photon",
  hostnames: ["photon-sol.tinyastro.io"],
  initialDelay: 400,

  extractCA(url: URL, doc: Document): string {
    // Skip liquidity pool pages entirely
    if (url.pathname.includes("/lp/")) return ""
    const ca = extractCAFromPathname(url)
    if (ca) return ca
    return scoreAddresses(doc, url.href)
  },

  isNewToken(prev: URL, next: URL): boolean {
    return pathnameChanged(prev, next)
  }
}
