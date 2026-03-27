import type { SiteAdapter } from "./base-adapter"
import { extractCAFromPathname, scoreAddresses } from "./base-adapter"

/**
 * Extract the token CA from a Birdeye URL pathname.
 * Handles both formats:
 *   /token/{CA}          (legacy)
 *   /solana/token/{CA}   (canonical)
 * Returns empty string if no CA found.
 */
function caFromBirdeyePath(url: URL): string {
  if (!url.pathname.includes("/token/")) return ""
  return extractCAFromPathname(url)
}

/**
 * Birdeye adapter
 *
 * ROOT CAUSE OF DOUBLE SCAN (now fixed):
 *   Birdeye redirects /token/{CA}?chain=solana -> /solana/token/{CA}
 *   via history.replaceState. The old isNewToken() compared raw pathnames,
 *   so "/token/BONK" vs "/solana/token/BONK" was seen as a NEW token,
 *   triggering resetState() + scan() — then the initial setTimeout poll
 *   fired a SECOND scan.
 *
 * FIX: isNewToken() now extracts the CA from both URLs and compares CAs.
 *   /token/BONK -> CA=BONK, /solana/token/BONK -> CA=BONK => same token.
 */
export const BirdeyeAdapter: SiteAdapter = {
  name: "Birdeye",
  hostnames: ["birdeye.so"],
  initialDelay: 400,

  extractCA(url: URL, doc: Document): string {
    // Birdeye canonical: /solana/token/{CA} or legacy /token/{CA}
    const ca = caFromBirdeyePath(url)
    if (ca) return ca
    // Fallback: score DOM addresses
    return scoreAddresses(doc, url.href)
  },

  isNewToken(prev: URL, next: URL): boolean {
    // Extract CA from both URLs and compare.
    // This handles the redirect /token/{CA} -> /solana/token/{CA}
    // which changes the pathname but NOT the token.
    const prevCA = caFromBirdeyePath(prev)
    const nextCA = caFromBirdeyePath(next)

    // If both URLs have a CA in the path, compare them directly
    if (prevCA && nextCA) return prevCA !== nextCA

    // If one has a CA and the other doesn't, it's a different page type
    if (prevCA !== nextCA) return true

    // Neither has a CA (e.g. /trending -> /trending), compare pathnames
    return prev.pathname !== next.pathname
  }
}
