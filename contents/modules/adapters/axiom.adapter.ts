import type { SiteAdapter } from "./base-adapter"
import { extractCAFromPathname, pathnameChanged, scoreAddresses } from "./base-adapter"

export const AxiomAdapter: SiteAdapter = {
  name: "Axiom",
  hostnames: ["axiom.trade"],
  initialDelay: 400,
  extractCA(url: URL, doc: Document): string {
    const ca = extractCAFromPathname(url)
    return ca || scoreAddresses(doc, url.href)
  },
  isNewToken: pathnameChanged
}
