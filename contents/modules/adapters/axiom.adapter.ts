import type { SiteAdapter } from "./base-adapter"
import { extractCAFromPathname, pathnameChanged } from "./base-adapter"

/**
 * Axiom adapter
 *
 * FIX: Do NOT fall back to DOM scoreAddresses().
 * Only extract CA from the URL pathname.
 */
export const AxiomAdapter: SiteAdapter = {
  name: "Axiom",
  hostnames: ["axiom.trade"],
  initialDelay: 400,
  extractCA(url: URL, _doc: Document): string {
    return extractCAFromPathname(url)
  },
  isNewToken: pathnameChanged
}
