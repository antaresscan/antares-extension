import type { SiteAdapter } from "./base-adapter"
import { extractCAFromPathname, pathnameChanged } from "./base-adapter"

/**
 * DexScreener adapter
 * URL pattern: dexscreener.com/solana/{CA}
 * SPA: Next.js — pathname changes on token switch, stable DOM
 *
 * FIX: Do NOT fall back to DOM scoreAddresses().
 * DexScreener listing pages (trending, new pairs, etc.) contain
 * many token addresses. Only extract CA from the URL.
 */
export const DexScreenerAdapter: SiteAdapter = {
  name: "DexScreener",
  hostnames: ["dexscreener.com"],
  initialDelay: 300,

  extractCA(url: URL, _doc: Document): string {
    // DexScreener puts the CA directly in /solana/{CA}
    if (url.pathname.startsWith("/solana/")) {
      return extractCAFromPathname(url)
    }
    // Non-token pages — do NOT fall back to DOM scanning
    return ""
  },

  isNewToken(prev: URL, next: URL): boolean {
    // Only pathname changes matter on DexScreener
    return pathnameChanged(prev, next)
  }
}
