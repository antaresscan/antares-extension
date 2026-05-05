import type { SiteAdapter } from "./base-adapter"
import { extractCAFromPathname, pathnameChanged } from "./base-adapter"
import { INITIAL_POLL_DELAY } from "../constants"

/**
 * Axiom adapter
 *
 * FIX: Do NOT fall back to DOM scoreAddresses().
 * Only extract CA from the URL pathname.
 */
export const AxiomAdapter: SiteAdapter = {
  name: "Axiom",
  hostnames: ["axiom.trade"],
  initialDelay: INITIAL_POLL_DELAY,
  extractCA(url: URL, _doc: Document): string {
    return extractCAFromPathname(url)
  },
  isNewToken: pathnameChanged
}
