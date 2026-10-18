// __tests__/audit-lot65.test.ts — Lot 65 of the file-by-file audit (2026-10-17): a preview READS its own insider graph too. Fails on the previous code.
//
// A preview deployment caches the insider graph under its own namespace (pv:<deployment>:, see deployment.ts), and that WRITE was tested. The READ was
// not: the cache lookup could go back to production's key with the whole suite green. A preview would then answer production's graph, built by
// production's code, for as long as it is cached, instead of building its own: the very code the preview is there to try would never run.

import { describe, it, expect, vi, afterEach } from "vitest"
import type { Redis } from "@upstash/redis"
import { INSIDER_GRAPH_CACHE_PREFIX } from "../api/_lib/constants"
import { buildInsiderGraph, initGraphCache } from "../api/_lib/insider-graph"

vi.mock("../api/_lib/helpers", () => ({ fetchJson: vi.fn().mockResolvedValue({ result: [] }) }))
vi.mock("../api/_lib/helius", () => ({ heliusRpc: vi.fn().mockResolvedValue({ result: [] }) }))

const MINT = "TokenMint111111111111111111111111111111111"
const holders = [
  { address: "WalletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", uiAmount: 5000 },
  { address: "WalletBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", uiAmount: 3000 },
]

const readsOf = async () => {
  const reads: string[] = []
  initGraphCache({ get: async (k: string) => { reads.push(k); return null }, set: async () => "OK" } as unknown as Redis)
  await buildInsiderGraph(MINT, holders, 100000, "test-helius-key", new Set<string>())
  return reads
}

describe("the insider graph cache, read side", () => {
  afterEach(() => { vi.unstubAllEnvs(); initGraphCache(null as unknown as Redis) })

  it("a preview looks the graph up under its own namespace, never under production's key", async () => {
    vi.stubEnv("VERCEL_ENV", "preview")
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_AAA")
    expect(await readsOf()).toEqual([`pv:dpl_AAA:${INSIDER_GRAPH_CACHE_PREFIX}${MINT}`])
  })

  it("witness: production reads the key it always had", async () => {
    vi.stubEnv("VERCEL_ENV", "production")
    expect(await readsOf()).toEqual([`${INSIDER_GRAPH_CACHE_PREFIX}${MINT}`])
  })
})
