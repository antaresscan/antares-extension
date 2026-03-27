import type { SiteAdapter } from "./base-adapter"
import { pathnameChanged, scoreAddresses } from "./base-adapter"

/**
 * Generic fallback adapter
 * Used for any site not matched by a specific adapter.
 * Uses full scoreAddresses() and pathname-based nav detection.
 */
export const GenericAdapter: SiteAdapter = {
  name: "Generic",
  hostnames: [],
  initialDelay: 500,

  extractCA(url: URL, doc: Document): string {
    return scoreAddresses(doc, url.href)
  },

  isNewToken(prev: URL, next: URL): boolean {
    return pathnameChanged(prev, next)
  }
}
