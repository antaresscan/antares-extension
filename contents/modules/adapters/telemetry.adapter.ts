import type { SiteAdapter } from "./base-adapter"
import { extractCAFromPathname, pathnameChanged } from "./base-adapter"

/**
 * Telemetry adapter
 *
 * FIX: Do NOT fall back to DOM scoreAddresses().
 * Only extract CA from the URL pathname.
 */
export const TelemetryAdapter: SiteAdapter = {
  name: "Telemetry",
  hostnames: ["app.telemetry.io"],
  initialDelay: 500,
  extractCA(url: URL, _doc: Document): string {
    return extractCAFromPathname(url)
  },
  isNewToken: pathnameChanged
}
