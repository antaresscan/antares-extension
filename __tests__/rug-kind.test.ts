import { describe, it, expect } from "vitest";
import { rugKindOf } from "../api/_lib/pipeline";
import { layerDexScreener, layerGoPlus } from "../api/_lib/layers";
import type { DexScreenerPair, GoPlusTokenResult, LayerResult, Verdict } from "../api/_lib/types";

// What a RUG verdict means: "confirmed" when a layer observed a fact showing a rug happened to the token, "risk" when the verdict
// comes from the token's structure alone. The kind is read from the evidence layers record, never from the flags' texts, and it
// never moves a verdict.

const layer = (over: Partial<LayerResult> = {}): LayerResult => ({
  source: "dexscreener", trust: 1, available: true, flags: [], forceRug: false, safeBlocked: false, ...over,
});

const pair = (liq: number | undefined, vol = 100, extra: Partial<DexScreenerPair> = {}): DexScreenerPair => ({
  ...(liq === undefined ? {} : { liquidity: { usd: liq } }),
  volume: { h24: vol },
  priceChange: {},
  txns: { m5: { buys: 1, sells: 1 } },
  info: { socials: [{ type: "twitter", url: "https://twitter.com/t" }], websites: [{ url: "https://t.example" }] },
  ...extra,
});

describe("rugKindOf", () => {
  it("is null for every verdict that is not RUG, even when a layer holds evidence", () => {
    const evidence = [layer({ rugEvidence: ["pool_abandoned"] })];
    for (const v of ["SAFE", "CAUTION", "DANGER"] as Verdict[]) expect(rugKindOf(v, evidence)).toBeNull();
  });

  it('is "risk" for a RUG verdict with no evidence: the structure alone made it RUG', () => {
    expect(rugKindOf("RUG", [layer({ forceRug: true }), layer({ source: "helius", forceRug: true })])).toBe("risk");
    expect(rugKindOf("RUG", [])).toBe("risk");
  });

  it('is "confirmed" for a RUG verdict when an available layer observed an event', () => {
    expect(rugKindOf("RUG", [layer(), layer({ source: "dexscreener", rugEvidence: ["pool_abandoned"] })])).toBe("confirmed");
  });

  it("ignores an empty evidence list and the evidence of a layer that was not available", () => {
    expect(rugKindOf("RUG", [layer({ rugEvidence: [] })])).toBe("risk");
    expect(rugKindOf("RUG", [layer({ available: false, rugEvidence: ["pool_abandoned"] })])).toBe("risk");
  });

  it("does not read the flags' texts: a flag that says 'abandoned pool' proves nothing without the evidence", () => {
    const flags = [{ label: "Volume with zero liquidity — abandoned pool", severity: "critical" as const, impact: 0 }];
    expect(rugKindOf("RUG", [layer({ flags, forceRug: true })])).toBe("risk");
  });
});

describe("layerDexScreener records rug evidence", () => {
  it("abandoned pool: zero liquidity and volume over $10k", () => {
    const r = layerDexScreener(pair(0, 50_000), null, null);
    expect(r.forceRug).toBe(true);
    expect(r.rugEvidence).toEqual(["pool_abandoned"]);
  });

  it("an abandoned pool is recorded whatever the age of the pair", () => {
    expect(layerDexScreener(pair(0, 50_000), null, 1000).rugEvidence).toEqual(["pool_abandoned"]);
  });

  // The measured trap: liquid-staking tokens and tokenised stocks (BBSOL, BONKSOL, JNJX, CSCOX...) hold almost nothing on a DEX pool
  // and are not rugs. A thin pool does not say whether the liquidity was removed or never existed, so it is not evidence.
  it("witnesses: a thin pool on an old pair is NOT evidence, and the layer is the same as for a young pair", () => {
    const old = layerDexScreener(pair(120), null, 100_000);
    const young = layerDexScreener(pair(120), null, 100);
    expect(old.rugEvidence).toBeUndefined();
    expect(old.trust).toBe(young.trust);
    expect(old.flags).toEqual(young.flags);
    expect(old.forceRug).toBe(young.forceRug);
    expect(old.safeBlocked).toBe(young.safeBlocked);
  });

  it("witnesses: no evidence when the age is unknown", () => {
    expect(layerDexScreener(pair(120), null, null).rugEvidence).toBeUndefined();
  });

  it("witnesses: no evidence for a young token still on its bonding curve (liquidity unknown, not zero)", () => {
    const curve = layerDexScreener(pair(undefined, 20_000, { dexId: "pumpfun" }), null, 120);
    expect(curve.rugEvidence).toBeUndefined();
    expect(curve.forceRug).toBe(false);
  });

  it("witnesses: a healthy pair has no evidence field at all", () => {
    const r = layerDexScreener(pair(100_000, 50_000), 500_000, 1440);
    expect("rugEvidence" in r).toBe(false);
  });
});

describe("layerGoPlus records rug evidence", () => {
  it("witness: a GoPlus answer with no sell restriction has no evidence field", () => {
    const r = layerGoPlus({ holder_count: "10" } as GoPlusTokenResult);
    expect("rugEvidence" in r).toBe(false);
  });
});
