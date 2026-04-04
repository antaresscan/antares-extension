import type { SiteAdapter } from "./base-adapter"
import { extractCAFromPathname, pathnameChanged } from "./base-adapter"

/**
 * GMGN adapter
 * URL pattern: gmgn.ai/sol/token/{CA}
 *
 * FIX: Do NOT fall back to DOM scoreAddresses().
 * Only extract CA from /token/ URL paths.
 */
export const GMGNAdapter: SiteAdapter = {
  name: "GMGN",
  hostnames: ["gmgn.ai"],
  initialDelay: 400,
  extractCA(url: URL, _doc: Document): string {
    // gmgn.ai/sol/token/{CA}
    if (url.pathname.includes("/token/")) {
      return extractCAFromPathname(url)
    }
    // Non-token pages — do NOT fall back to DOM scanning
    return ""
  },
  isNewToken: pathnameChanged
}
