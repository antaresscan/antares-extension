import type { SiteAdapter } from "./base-adapter"
import { extractCAFromPathname, pathnameChanged, scoreAddresses } from "./base-adapter"

export const TelemetryAdapter: SiteAdapter = {
  name: "Telemetry",
  hostnames: ["app.telemetry.io"],
  initialDelay: 500,
  extractCA(url: URL, doc: Document): string {
    const ca = extractCAFromPathname(url)
    return ca || scoreAddresses(doc, url.href)
  },
  isNewToken: pathnameChanged
}
