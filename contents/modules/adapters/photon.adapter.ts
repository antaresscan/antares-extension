import type { SiteAdapter } from "./base-adapter"
import { pathnameChanged, scoreAddresses } from "./base-adapter"
import { INITIAL_POLL_DELAY } from "../constants"

/**
 * Photon (TinyAstro) adapter
 *
 * Token pages use /en/lp/{POOL_ADDRESS} — the URL contains the LP pair
 * address, NOT the token CA. The real token CA must be extracted from
 * the DOM (e.g. solscan links, data attributes, or text nodes).
 *
 * Non-token pages (memescope, trending, new-pairs, tracker, etc.)
 * should be skipped entirely.
 */

/** Pages that are NOT token pages — skip scanning */
const NON_TOKEN_PATHS = [
  "/memescope",
  "/trending",
  "/new-pairs",
  "/tracker",
  "/orders",
  "/portfolio",
  "/discover",
]

export const PhotonAdapter: SiteAdapter = {
  name: "Photon",
  hostnames: ["photon-sol.tinyastro.io"],
  initialDelay: INITIAL_POLL_DELAY,

  extractCA(url: URL, doc: Document): string {
    const path = url.pathname.toLowerCase()

    // Skip non-token pages (memescope, trending, etc.)
    for (const skip of NON_TOKEN_PATHS) {
      if (path.includes(skip)) return ""
    }

    // Only scan on /en/lp/ pages (actual token pages)
    if (!path.includes("/lp/")) return ""

    // On /en/lp/ pages, the URL contains the POOL address, not the token.
    // Use scoreAddresses to find the real token CA from the DOM
    // (solscan links, pump.fun links, data attributes, text nodes).
    return scoreAddresses(doc, url.href)
  },

  isNewToken(prev: URL, next: URL): boolean {
    return pathnameChanged(prev, next)
  }
}
