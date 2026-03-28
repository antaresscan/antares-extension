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

import { DexScreenerAdapter } from "./dexscreener.adapter"
import { BirdeyeAdapter } from "./birdeye.adapter"
import { PumpAdapter } from "./pump.adapter"
import { PhotonAdapter } from "./photon.adapter"
import { AxiomAdapter } from "./axiom.adapter"
import { GeckoTerminalAdapter } from "./geckoterminal.adapter"
import { GMGNAdapter } from "./gmgn.adapter"
import { TelemetryAdapter } from "./telemetry.adapter"
import { GenericAdapter } from "./generic.adapter"

/** All registered adapters, ordered by specificity */
const ADAPTERS: SiteAdapter[] = [
  DexScreenerAdapter,
  BirdeyeAdapter,
  PumpAdapter,
  PhotonAdapter,
  AxiomAdapter,
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
