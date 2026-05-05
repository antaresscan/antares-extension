import type { SiteAdapter } from "./base-adapter"
import { extractCAFromPathname, pathnameChanged } from "./base-adapter"
import { INITIAL_POLL_DELAY } from "../constants"

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
  initialDelay: INITIAL_POLL_DELAY,
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
