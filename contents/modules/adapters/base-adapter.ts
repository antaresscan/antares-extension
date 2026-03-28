import { makeSOLAddrRegex, WALKER_LIMIT } from "../constants"
import { isValid } from "../scanner"

/**
 * Interface that every site adapter must implement.
 * Each adapter encapsulates the site-specific logic for:
 * - Extracting a Solana token address (CA) from the page
 * - Detecting SPA navigations that change the current token
 */
export interface SiteAdapter {
  /** Human-readable name for logging / debugging */
  readonly name: string

  /** Domain(s) this adapter handles (matched via hostname.includes) */
  readonly hostnames: string[]

  /** Milliseconds to wait before first poll (site-specific DOM readiness) */
  readonly initialDelay: number

  /**
   * Extract the best token CA from the current page.
   * Returns empty string if nothing found.
   */
  extractCA(url: URL, doc: Document): string

  /**
   * Determine if a URL change is meaningful (= new token) or cosmetic
   * (query param change, tab switch, etc.).
   * When true, the orchestrator resets state and re-scans.
   * When false, the navigation is ignored.
   */
  isNewToken(prevUrl: URL, newUrl: URL): boolean
}

/* ------------------------------------------------------------------ */
/*  Shared helpers — reusable by any adapter                          */
/* ------------------------------------------------------------------ */

/** Score-based address finder shared across adapters */
export function scoreAddresses(doc: Document, url: string): string {
  const scores = new Map<string, number>()
  const add = (addr: string, pts: number) => {
    if (!isValid(addr)) return
    scores.set(addr, (scores.get(addr) || 0) + pts)
  }

  // Each call gets its own fresh regex to avoid lastIndex state bugs
  const re1 = makeSOLAddrRegex()
  const re2 = makeSOLAddrRegex()
  const re3 = makeSOLAddrRegex()
  const re4 = makeSOLAddrRegex()

  // 1. data-* attributes (highest confidence)
  const dataAttrs = [
    "data-address", "data-token", "data-mint", "data-ca",
    "data-contract", "data-token-address", "data-mint-address"
  ]
  for (const el of doc.querySelectorAll(dataAttrs.map(a => `[${a}]`).join(","))) {
    for (const attr of dataAttrs) {
      for (const m of ((el.getAttribute(attr) || "").match(re1) || [])) add(m, 200)
      re1.lastIndex = 0
    }
  }

  // 2. Links to known explorers
  for (const a of doc.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") || ""
    if (/solscan\.io\/token|solscan\.io\/address|explorer\.solana\.com\/address|solana\.fm\/address/.test(href)) {
      for (const m of (href.match(re2) || [])) add(m, 180)
      re2.lastIndex = 0
    }
  }

  // 3. URL itself
  for (const m of (url.match(re3) || [])) add(m, 60)

  // 4. Fallback: walk text nodes (expensive, only if nothing found yet)
  if (scores.size === 0) {
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, null)
    let node: Node | null, count = 0
    while ((node = walker.nextNode()) && count < WALKER_LIMIT) {
      count++
      const t = (node.textContent || "").trim()
      if (t.length >= 32 && t.length <= 50) {
        for (const m of (t.match(re4) || [])) add(m, 120)
        re4.lastIndex = 0
      }
    }
  }

  if (scores.size === 0) return ""

  // Bonus heuristics
  for (const [addr, s] of scores) {
    if (addr.endsWith("pump")) scores.set(addr, s + 100)
    if (/[A-Z]/.test(addr) && /[a-z]/.test(addr)) scores.set(addr, (scores.get(addr) || 0) + 30)
  }

  return [...scores.entries()].sort((a, b) => b[1] - a[1])[0][0]
}

/** Simple pathname-based comparison (ignores query & hash) */
export function pathnameChanged(prev: URL, next: URL): boolean {
  return prev.pathname !== next.pathname
}

/** Extract a CA from a URL pathname segment matching SOL_ADDR */
export function extractCAFromPathname(url: URL): string {
  const re = makeSOLAddrRegex()
  const segments = url.pathname.split("/")
  for (const seg of segments) {
    if (re.test(seg)) {
      re.lastIndex = 0
      const m = seg.match(makeSOLAddrRegex())
      if (m && isValid(m[0])) return m[0]
    }
    re.lastIndex = 0
  }
  return ""
}
