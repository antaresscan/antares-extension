import type { SiteAdapter } from "./base-adapter"
import { pathnameChanged, scoreAddresses } from "./base-adapter"

/**
 * GeckoTerminal adapter
 * URL: geckoterminal.com/solana/pools/{poolAddress}
 * NOTE: URL contains POOL address, not token address.
 * Must rely on DOM scoring to find the actual token CA.
 */
export const GeckoTerminalAdapter: SiteAdapter = {
  name: "GeckoTerminal",
  hostnames: ["geckoterminal.com"],
  initialDelay: 600,
  extractCA(url: URL, doc: Document): string {
    return scoreAddresses(doc, url.href)
  },
  isNewToken: pathnameChanged
}
