import type { SiteAdapter } from "./base-adapter"
import { pathnameChanged, scoreAddresses } from "./base-adapter"
import { INITIAL_POLL_DELAY } from "../constants"

/**
 * GeckoTerminal adapter
 * URL: geckoterminal.com/solana/pools/{poolAddress}
 * NOTE: URL contains POOL address, not token address.
 * Must rely on DOM scoring to find the actual token CA.
 *
 * FIX: Only use scoreAddresses on /pools/ pages.
 * Non-pool pages (trending, top pools list, etc.) contain
 * many token addresses and should NOT trigger a scan.
 */
export const GeckoTerminalAdapter: SiteAdapter = {
  name: "GeckoTerminal",
  hostnames: ["geckoterminal.com"],
  initialDelay: INITIAL_POLL_DELAY,
  extractCA(url: URL, doc: Document): string {
    // Only scan on pool detail pages
    if (url.pathname.includes("/pools/")) {
      return scoreAddresses(doc, url.href)
    }
    // Non-pool pages — do NOT scan
    return ""
  },
  isNewToken: pathnameChanged
}
