import type { SiteAdapter } from "./base-adapter"
import { extractCAFromPathname, pathnameChanged } from "./base-adapter"
import { makeSOLAddrRegex, INITIAL_POLL_DELAY } from "../constants"
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
 *
 * WHAT THE URL HOLDS (audit A-07): the address in /solana/{address} is the PAIR's, not the token's. When it happens to be valid
 * base58 (about one page in two) it used to be sent as the token, and RugCheck answers 400 for a pair: bundle, snipers, rug history
 * and creator sells were skipped. The page lists, in this order, the pair (solscan.io/account/{pair}), the base token
 * (solscan.io/token/{mint}) and the quote token (checked on live pages: SOL/USDC, Bonk/SOL). So the token is read from the page
 * first, but only after the link of THIS URL's pair: while a single-page navigation has not re-rendered yet, the page still shows the
 * previous token's links, and those must never be taken for the new page's.
 */

const BASE58_ADDRESS = "[1-9A-HJ-NP-Za-km-z]{32,44}"

/**
 * The base token's mint, from the Solscan links of the page, when the page is the one of the pair named by `urlAddress`
 * (compared case-insensitively: DexScreener lowercases the URL). "" when the page is not ready, or shows another pair.
 */
export function mintOfPairFromLinks(doc: Document | null, urlAddress: string): string {
  if (!doc || !urlAddress) return ""
  const wanted = urlAddress.toLowerCase()
  const accountRe = new RegExp(`solscan\\.io/account/(${BASE58_ADDRESS})`)
  const tokenRe = new RegExp(`solscan\\.io/token/(${BASE58_ADDRESS})`)
  let onThisPair = false
  for (const a of doc.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") || ""
    const account = href.match(accountRe)
    if (account) {
      onThisPair = account[1].toLowerCase() === wanted
      continue
    }
    if (!onThisPair) continue
    const token = href.match(tokenRe)
    if (token && isValid(token[1])) return token[1] // the first token link after the pair is the base token
  }
  return ""
}

/**
 * True when the page shows the link of a pair and none of them is the pair named by `urlAddress`: the page on screen is the PREVIOUS
 * one. Measured on dexscreener.com (2026-10-17): after a click to another pair the URL changes at once, and the page keeps the previous
 * pair's links for about 0.9 s, longer than the 800 ms the detector waits (address-detector.ts onNav). The only solscan.io/account links
 * of a pair page are the pair's own (checked on Bonk/SOL and Nubi/SOL: no wallet links).
 */
export function pageShowsAnotherPair(doc: Document | null, urlAddress: string): boolean {
  if (!doc || !urlAddress) return false
  const wanted = urlAddress.toLowerCase()
  const accountRe = new RegExp(`solscan\\.io/account/(${BASE58_ADDRESS})`)
  let showsAPair = false
  for (const a of doc.querySelectorAll("a[href]")) {
    const account = (a.getAttribute("href") || "").match(accountRe)
    if (!account) continue
    if (account[1].toLowerCase() === wanted) return false
    showsAPair = true
  }
  return showsAPair
}

export const DexScreenerAdapter: SiteAdapter = {
  name: "DexScreener",
  hostnames: ["dexscreener.com"],
  initialDelay: INITIAL_POLL_DELAY,

  extractCA(url: URL, doc: Document): string {
    // Only operate on /solana/* pages
    if (!url.pathname.startsWith("/solana/")) {
      return ""
    }

    // 1. The token itself, read from the page next to the pair of this URL (see the note above): the URL holds the pair's address.
    const pairInUrl = url.pathname.split("/")[2] ?? ""
    const fromPage = mintOfPairFromLinks(doc, pairInUrl)
    if (fromPage) return fromPage

    // 2. The page is not ready (or is not a pair page): the URL (works if the address is valid base58). The API resolves a pair
    //    address to its token itself, with every check.
    const fromUrl = extractCAFromPathname(url)
    if (fromUrl) return fromUrl

    // 3. URL extraction failed (lowercased address).
    //    Extract token mint from Solscan token links in the DOM.
    //    These links use the real mixed-case base58 address.
    //    Never while the page still shows ANOTHER pair: its first token link is the previous token, and the detector, finding the token
    //    it already shows, would keep the previous verdict on this page. Nothing yet: the detector looks again (pollAfterNav).
    if (pageShowsAnotherPair(doc, pairInUrl)) return ""
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

    // 4. If still nothing, this might be a listing page or DOM not ready yet
    return ""
  },

  isNewToken(prev: URL, next: URL): boolean {
    // Only pathname changes matter on DexScreener
    return pathnameChanged(prev, next)
  }
}
