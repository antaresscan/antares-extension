// __tests__/audit-lot56.test.ts — Lot 56 of the file-by-file audit (2026-10-17): the layers tests.
//
// The owner's rule (#628): a pump ALONE is never critical, whatever the percentage; it takes a structural weakness next to it (thin
// liquidity, wash volume, one-sided trades) to make it an exit trap. A mutation probe turned the pump-alone flag critical in each branch of
// layerDexScreener: the 1 h and < 2 h branches were caught, but for the two YOUNGEST branches (< 30 min and < 1 h, the tokens the rule
// protects most) the whole suite stayed green. This pins both. It fails on a layers.ts where either flag is critical (checked with
// audit-lots/mutate.cjs, then restored).

import { describe, it, expect } from "vitest"
import { layerDexScreener } from "../api/_lib/layers"

/** A healthy pool: $50k of liquidity, $100k of volume (×2), a few trades both ways: no structural weakness. */
const pair = (pc1: number, liquidityUsd = 50_000) => ({
  liquidity: { usd: liquidityUsd },
  volume: { h24: 100_000 },
  priceChange: { h1: pc1, h6: pc1, h24: pc1, m5: 5 },
  txns: { m5: { buys: 6, sells: 4 } },
  dexId: "raydium",
  info: { websites: [{ url: "https://example.com" }], socials: [{ type: "twitter", url: "https://x.com/example" }] },
}) as never

const pumpFlags = (r: ReturnType<typeof layerDexScreener>) => r.flags.filter((f) => /pump/i.test(f.label))

describe("layerDexScreener — a pump alone is a warning, never critical (rule #628), on the youngest tokens too", () => {
  it("< 30 min, +200 % in 1 h, healthy pool: one pump flag, a WARNING, and no forced RUG", () => {
    const r = layerDexScreener(pair(200), 1_000_000, 20)
    const pumps = pumpFlags(r)
    expect(pumps.map((f) => f.label)).toEqual(["Extreme pump +200% on newborn token (<30min)"])
    expect(pumps[0].severity).toBe("warning")
    expect(r.forceRug).toBe(false)
  })

  it("< 1 h, +150 % in 1 h, healthy pool: one pump flag, a WARNING, and no forced RUG", () => {
    const r = layerDexScreener(pair(150), 1_000_000, 45)
    const pumps = pumpFlags(r)
    expect(pumps.map((f) => f.label)).toEqual(["Pump +150% on newborn token (<1h)"])
    expect(pumps[0].severity).toBe("warning")
    expect(r.forceRug).toBe(false)
  })

  it("the same pumps WITH a structural weakness (a $10k pool) are the critical exit trap (the test sees the difference)", () => {
    for (const [pc1, age] of [[200, 20], [150, 45]] as const) {
      const r = layerDexScreener(pair(pc1, 10_000), 1_000_000, age)
      const trap = r.flags.find((f) => /exit trap/.test(f.label))
      expect(trap?.severity, `${pc1}% at ${age} min`).toBe("critical")
      expect(r.forceRug).toBe(true)
    }
  })
})
