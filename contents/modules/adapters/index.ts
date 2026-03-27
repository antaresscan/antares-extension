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
import { SOL_ADDR } from "../constants"
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

const BullXAdapter: SiteAdapter = {
  name: "BullX",
  hostnames: ["neo.bullx.io"],
  initialDelay: 400,
  extractCA(url: URL, doc: Document): string {
    const ca = extractCAFromPathname(url)
    return ca || scoreAddresses(doc, url.href)
  },
  isNewToken: pathnameChanged
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
    // Check query params first (outputMint, inputMint)
    for (const param of ["outputMint", "inputMint"]) {
      const val = url.searchParams.get(param)
      if (val && val !== "sol" && SOL_ADDR.test(val)) {
        SOL_ADDR.lastIndex = 0
        if (isValid(val)) return val
      }
      SOL_ADDR.lastIndex = 0
    }
    // Fallback to pathname then DOM
    const ca = extractCAFromPathname(url)
    return ca || scoreAddresses(doc, url.href)
  },
  isNewToken(prev: URL, next: URL): boolean {
    // On Raydium, both pathname AND search params matter
    return prev.pathname !== next.pathname || prev.search !== next.search
  }
}

/**
 * Jupiter adapter
 * URL: jup.ag/swap/SOL-{CA}
 * CA embedded in pathname segment after dash separator
 */
const JupiterAdapter: SiteAdapter = {
  name: "Jupiter",
  hostnames: ["jup.ag"],
  initialDelay: 400,
  extractCA(url: URL, doc: Document): string {
    const ca = extractCAFromPathname(url)
    return ca || scoreAddresses(doc, url.href)
  },
  isNewToken(prev: URL, next: URL): boolean {
    // Jupiter: both pathname AND search params matter (swap pairs)
    return prev.pathname !== next.pathname || prev.search !== next.search
  }
}

/**
 * GeckoTerminal adapter
 * URL: geckoterminal.com/solana/pools/{poolAddress}
 * NOTE: URL contains POOL address, not token address.
 * Must rely on DOM scoring to find the actual token CA.
 */
const GeckoTerminalAdapter: SiteAdapter = {
  name: "GeckoTerminal",
  hostnames: ["geckoterminal.com"],
  initialDelay: 600,
  extractCA(url: URL, doc: Document): string {
    // DO NOT extract from pathname — it's a pool address, not a token CA
    // Go straight to DOM scoring
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
