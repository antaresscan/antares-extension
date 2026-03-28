import type { SiteAdapter } from "./base-adapter"
import { extractCAFromPathname, pathnameChanged, scoreAddresses } from "./base-adapter"

export const GMGNAdapter: SiteAdapter = {
  name: "GMGN",
  hostnames: ["gmgn.ai"],
  initialDelay: 400,
  extractCA(url: URL, doc: Document): string {
    // gmgn.ai/sol/token/{CA}
    if (url.pathname.includes("/token/")) {
      const ca = extractCAFromPathname(url)
      if (ca) return ca
    }
    return scoreAddresses(doc, url.href)
  },
  isNewToken: pathnameChanged
}
