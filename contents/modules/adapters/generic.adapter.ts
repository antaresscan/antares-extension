import type { SiteAdapter } from "./base-adapter"
import { extractCAFromPathname, pathnameChanged } from "./base-adapter"

/**
 * Generic fallback adapter
 * Used for any site not matched by a specific adapter.
 *
 * FIX: Do NOT use scoreAddresses() as it picks up random tokens
 * from listing/profile pages. Only extract CA from the URL pathname.
 */
export const GenericAdapter: SiteAdapter = {
  name: "Generic",
  hostnames: [],
  initialDelay: 500,

  extractCA(url: URL, _doc: Document): string {
    return extractCAFromPathname(url)
  },

  isNewToken(prev: URL, next: URL): boolean {
    return pathnameChanged(prev, next)
  }
}
