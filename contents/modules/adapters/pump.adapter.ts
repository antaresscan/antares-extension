import type { SiteAdapter } from "./base-adapter"
import { extractCAFromPathname, pathnameChanged } from "./base-adapter"

/**
 * Pages that are NOT token pages — skip scanning entirely.
 * Pump.fun profile pages, boards, and other listing pages contain
 * multiple token addresses in the DOM. Without this guard,
 * scoreAddresses() picks up a random token and triggers an
 * unwanted scan (the "DANGER 0/1000" popup on non-token pages).
 */
const NON_TOKEN_PATHS = [
  "/profile",
  "/board",
  "/advanced",
  "/create",
  "/settings",
  "/leaderboard",
]

/**
 * Pump.fun adapter
 * URL pattern: pump.fun/coin/{CA} or pump.fun/{CA}
 * SPA: React — DOM replaced entirely on navigation
 *
 * FIX: Do NOT fall back to DOM scoreAddresses().
 * Pump.fun profile pages and listing pages contain many token
 * addresses in the DOM. Falling back to scoreAddresses() caused
 * unwanted scans on non-token pages.
 * Only extract CA from the URL pathname.
 */
export const PumpAdapter: SiteAdapter = {
  name: "Pump.fun",
  hostnames: ["pump.fun"],
  initialDelay: 500,

  extractCA(url: URL, _doc: Document): string {
    const path = url.pathname.toLowerCase()

    // Skip non-token pages (profile, board, etc.)
    for (const skip of NON_TOKEN_PATHS) {
      if (path.startsWith(skip)) return ""
    }

    // Token pages: /coin/{CA} or /{CA}
    if (url.pathname.startsWith("/coin/") || url.pathname.split("/").length === 2) {
      return extractCAFromPathname(url)
    }

    // Any other unknown page — do NOT fall back to DOM scanning
    return ""
  },

  isNewToken(prev: URL, next: URL): boolean {
    return pathnameChanged(prev, next)
  }
}
