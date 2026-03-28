/**
 * Adapter Registry
 * Central registry of all site adapters. Resolves the correct adapter
 * based on the current hostname. Falls back to GenericAdapter.
 *
 * To add a new site:
 * 1. Create a new file: {site}.adapter.ts
 * 2. Import and add it to the ADAPTERS array below
 * That's it — no other file needs to change.
 */

import type { SiteAdapter } from "./base-adapter"
import { extractCAFromPathname, pathnameChanged, scoreAddresses } from "./base-adapter"
import { makeSOLAddrRegex } from "../constants"
import { isValid } from "../scanner"

// Adapters with site-specific logic (separate files)
import { DexScreenerAdapter } from "./dexscreener.adapter"
import { BirdeyeAdapter } from "./birdeye.adapter"
import { PumpAdapter } from "./pump.adapter"
import { PhotonAdapter } from "./photon.adapter"
import { SolscanAdapter } from "./solscan.adapter"
import { GenericAdapter } from "./generic.adapter"

/* ------------------------------------------------------------------ */
/*  Simple adapters (pathname-based, no special logic needed)          */
/* ------------------------------------------------------------------ */

const AxiomAdapter: SiteAdapter = {
  name: "Axiom",
  hostnames: ["axiom.trade"],
  initialDelay: 400,
  extractCA(url: URL, doc: Document): string {
    const ca = extractCAFromPathname(url)
    return ca || scoreAddresses(doc, url.href)
  },
  isNewToken: pathnameChanged
}

/**
 * BullX adapter
 * Handles both:
 *   neo.bullx.io/terminal?address={CA}  (query param)
 *   neo.bullx.io/{path}/{CA}            (pathname)
 */
const BullXAdapter: SiteAdapter = {
  name: "BullX",
  hostnames: ["neo.bullx.io", "bullx.io"],
  initialDelay: 400,
  extractCA(url: URL, doc: Document): string {
    // Check query params first (BullX terminal uses ?address=)
    const re = makeSOLAddrRegex()
    for (const param of ["address", "token", "mint"]) {
      const val = url.searchParams.get(param)
      if (val && re.test(val) && isValid(val)) return val
      re.lastIndex = 0
    }
    const ca = extractCAFromPathname(url)
    return ca || scoreAddresses(doc, url.href)
  },
  isNewToken(prev: URL, next: URL): boolean {
    return prev.pathname !== next.pathname || prev.search !== next.search
  }
}

/**
 * Raydium adapter
 * URL: raydium.io/swap/?inputMint=sol&outputMint={CA}
 * CA is in QUERY PARAMS (outputMint or inputMint), not pathname
 */
const RaydiumAdapter: SiteAdapter = {
  name: "Raydium",
  hostnames: ["raydium.io"],
  initialDelay: 500,
  extractCA(url: URL, doc: Document): string {
    const re = makeSOLAddrRegex()
    for (const param of ["outputMint", "inputMint"]) {
      const val = url.searchParams.get(param)
      if (val && val !== "sol" && re.test(val)) {
        re.lastIndex = 0
        if (isValid(val)) return val
      }
      re.lastIndex = 0
    }
    const ca = extractCAFromPathname(url)
    return ca || scoreAddresses(doc, url.href)
  },
  isNewToken(prev: URL, next: URL): boolean {
    return prev.pathname !== next.pathname || prev.search !== next.search
  }
}

/**
 * Jupiter adapter
 * URL: jup.ag/swap/SOL-{CA} or jup.ag/swap/{CA1}-{CA2}
 * Extracts the non-SOL token from the swap pair.
 */
const JupiterAdapter: SiteAdapter = {
  name: "Jupiter",
  hostnames: ["jup.ag"],
  initialDelay: 400,
  extractCA(url: URL, doc: Document): string {
    // jup.ag/swap/{tokenA}-{tokenB}: try to find the non-SOL token
    if (url.pathname.startsWith("/swap/")) {
      const swapSegment = url.pathname.split("/").find(s => s.includes("-"))
      if (swapSegment) {
        const re = makeSOLAddrRegex()
        const parts = swapSegment.split("-")
        const SOL_SYMBOLS = new Set(["SOL", "sol"])
        for (const part of parts.reverse()) { // prefer last token (output)
          if (!SOL_SYMBOLS.has(part) && re.test(part) && isValid(part)) return part
          re.lastIndex = 0
        }
      }
    }
    const ca = extractCAFromPathname(url)
    return ca || scoreAddresses(doc, url.href)
  },
  isNewToken(prev: URL, next: URL): boolean {
    return prev.pathname !== next.pathname || prev.search !== next.search
  }
}

/**
 * GeckoTerminal adapter
 * URL: geckoterminal.com/solana/pools/{poolAddress}
 * NOTE: URL contains POOL address, not token address.
 * Must rely on DOM scoring to find the actual token CA.
 * Pool addresses are excluded by the IGNORE set and scoring heuristics.
 */
const GeckoTerminalAdapter: SiteAdapter = {
  name: "GeckoTerminal",
  hostnames: ["geckoterminal.com"],
  initialDelay: 600,
  extractCA(url: URL, doc: Document): string {
    // DO NOT extract from pathname — it's a pool address, not a token CA
    // scoreAddresses() will find the mint address from data-* attributes or explorer links
    return scoreAddresses(doc, url.href)
  },
  isNewToken: pathnameChanged
}

const GMGNAdapter: SiteAdapter = {
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

const TelemetryAdapter: SiteAdapter = {
  name: "Telemetry",
  hostnames: ["app.telemetry.io"],
  initialDelay: 500,
  extractCA(url: URL, doc: Document): string {
    const ca = extractCAFromPathname(url)
    return ca || scoreAddresses(doc, url.href)
  },
  isNewToken: pathnameChanged
}

/* ------------------------------------------------------------------ */
/*  Registry                                                           */
/* ------------------------------------------------------------------ */

/** All registered adapters, ordered by specificity */
const ADAPTERS: SiteAdapter[] = [
  DexScreenerAdapter,
  BirdeyeAdapter,
  PumpAdapter,
  PhotonAdapter,
  SolscanAdapter,
  AxiomAdapter,
  BullXAdapter,
  RaydiumAdapter,
  JupiterAdapter,
  GeckoTerminalAdapter,
  GMGNAdapter,
  TelemetryAdapter,
]

/**
 * Resolve the correct adapter for the given hostname.
 * Falls back to GenericAdapter if no match found.
 */
export function getAdapter(hostname: string): SiteAdapter {
  for (const adapter of ADAPTERS) {
    if (adapter.hostnames.some(h => hostname.includes(h))) {
      return adapter
    }
  }
  return GenericAdapter
}

/** Re-export for external use */
export type { SiteAdapter } from "./base-adapter"
