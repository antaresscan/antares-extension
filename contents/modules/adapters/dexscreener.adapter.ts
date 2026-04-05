import type { SiteAdapter } from "./base-adapter"
import { extractCAFromPathname, pathnameChanged, scoreAddresses } from "./base-adapter"
import { makeSOLAddrRegex } from "../constants"
import { isValid } from "../scanner"

/**
 * DexScreener adapter
 * URL pattern: dexscreener.com/solana/{address}
 * SPA: Next.js — pathname changes on token switch, stable DOM
 *
 * CRITICAL FIX: DexScreener lowercases all addresses in URLs.
 * e.g. /solana/azthnsj6jrsdjferxwk6jbqh4siljxshnqtp4k7vugq5
 * These lowercased addresses contain invalid base58 chars (like 'l', 'o')
 * and fail the SOL_ADDR regex match.
 *
 * Solution: When URL extraction fails, extract the token mint address
 * from Solscan explorer links in the DOM (solscan.io/token/{mint}).
 * This is safe on token pages because Solscan links point to the
 * actual mixed-case base58 token address.
 *
 * We do NOT use the generic scoreAddresses() fallback on listing pages
 * (trending, new pairs) — only on /solana/* token detail pages.
 */
export const DexScreenerAdapter: SiteAdapter = {
  name: "DexScreener",
  hostnames: ["dexscreener.com"],
  initialDelay: 500,

  extractCA(url: URL, doc: Document): string {
    // Only operate on /solana/* pages
    if (!url.pathname.startsWith("/solana/")) {
      return ""
    }

    // 1. Try URL extraction first (works if address is valid base58)
    const fromUrl = extractCAFromPathname(url)
    if (fromUrl) return fromUrl

    // 2. URL extraction failed (lowercased address).
    //    Extract token mint from Solscan token links in the DOM.
    //    These links use the real mixed-case base58 address.
    const re = makeSOLAddrRegex()
    for (const a of doc.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href") || ""
      if (/solscan\.io\/token\//.test(href)) {
        const matches = href.match(re)
        if (matches) {
          for (const m of matches) {
            if (isValid(m)) return m
          }
        }
        re.lastIndex = 0
      }
    }

    // 3. If still nothing, this might be a listing page or DOM not ready yet
    return ""
  },

  isNewToken(prev: URL, next: URL): boolean {
    // Only pathname changes matter on DexScreener
    return pathnameChanged(prev, next)
  }
}
