import { describe, it, expect } from "vitest";
import { isAthFlagCandidate, layerChart } from "../api/_lib/layers";
import { decide, type DecideInput } from "../api/_lib/decide";
import { deriveAuthorityFacts } from "../api/_lib/facts";
import type { DexScreenerPair, OHLCVCandle } from "../api/_lib/types";

// A token that lost 90 % or more from its highest price says so (the owner's rule, 2026-10-16: a token that lost more than 90 % has rugged). It is a WARNING: the token is never
// SAFE, and with two other warnings it is a DANGER (GRIFFAIN, -98 %). Never a critical on its own: BONK (-95 %), WIF (-96 %), PYTH and JTO (-92 %) are real tokens.

const DAY = 1440;

describe("isAthFlagCandidate: which tokens are read for it", () => {
  const ok = { tokenAgeMinutes: 400 * DAY, marketCapUsd: 50_000_000, issuerBacked: false };
  it("a token of 90 days and $5M of cap or more is read", () => {
    expect(isAthFlagCandidate(ok)).toBe(true);
    expect(isAthFlagCandidate({ ...ok, tokenAgeMinutes: 90 * DAY, marketCapUsd: 5_000_000 })).toBe(true);
  });
  it.each([
    ["under 90 days (the 90-day collapse rule reads it)", { tokenAgeMinutes: 89 * DAY }],
    ["under $5M of cap", { marketCapUsd: 4_999_999 }],
    ["an unknown age", { tokenAgeMinutes: null }],
    ["an unknown cap", { marketCapUsd: null }],
    ["a token of the issuer registry (HSOL: the feeds say -98 %, a glitch)", { issuerBacked: true }],
  ] as Array<[string, Partial<typeof ok>]>)("is not read with %s", (_n, over) => {
    expect(isAthFlagCandidate({ ...ok, ...over })).toBe(false);
  });
});

const candle = (c: number, i: number): OHLCVCandle => ({ ts: 1_700_000_000 + i * 300, o: c, h: c, l: c, c, v: 1000 });
const flat = (n = 40): OHLCVCandle[] => Array.from({ length: n }, (_, i) => candle(1, i));
const pair = (over: Partial<DexScreenerPair> = {}): DexScreenerPair => ({
  liquidity: { usd: 2_000_000 }, volume: { h24: 400_000 }, priceChange: { h1: 0.1, h6: 0.2, h24: -1, m5: 0 }, txns: { m5: { buys: 6, sells: 5 } },
  info: { socials: [{ type: "twitter", url: "https://twitter.com/t" }], websites: [{ url: "https://t.example" }] }, ...over,
});
const ctx = (athDropPct: number | null, athDate: string | null = "2024-11-13T00:00:00.000Z") => ({
  holders: 60_000, liquidity: 2_000_000, tokenAgeHours: 700 * 24, mintAuthority: false, freezeAuthority: false, honeypot: false, athDropPct, athDate,
});

describe("layerChart: the flag", () => {
  it("94 % below the high: one warning that names its source (Solscan) and the month of the high, the token is kept out of SAFE", () => {
    const r = layerChart(flat(), pair(), 700 * DAY, ctx(94.2));
    const f = r.flags.filter((x) => /all-time high/.test(x.label));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "warning", label: "Down 94% from its all-time high (Solscan, 2024-11)" });
    expect(r.safeBlocked).toBe(true);
    expect(r.forceRug).toBe(false);
    expect(r.flags.some((x) => x.severity === "critical")).toBe(false);
    expect(r.trust).toBeLessThan(layerChart(flat(), pair(), 700 * DAY, ctx(50)).trust);
  });
  it("the line is 90 % (read on Solscan's numbers as it is): 89.9 % says nothing, 90 % says it, and the number shown is never rounded up to the line", () => {
    expect(layerChart(flat(), pair(), 700 * DAY, ctx(89.9)).flags.some((x) => /all-time high/.test(x.label))).toBe(false);
    expect(layerChart(flat(), pair(), 700 * DAY, ctx(90)).flags.some((x) => /^Down 90% from/.test(x.label))).toBe(true);
    expect(layerChart(flat(), pair(), 700 * DAY, ctx(89.99)).flags.some((x) => /all-time high/.test(x.label))).toBe(false);
  });
  it("the memory of the line decides: -88 % says it for a token that had collapsed, and -92 % says nothing for one that never crossed", () => {
    const c = (drop: number, collapsed: boolean | null) => layerChart(flat(), pair(), 700 * DAY, { ...ctx(drop), athCollapsed: collapsed }).flags.some((x) => /all-time high/.test(x.label));
    expect(c(88, true)).toBe(true);
    expect(c(88, false)).toBe(false);
    expect(c(92, false)).toBe(false);
    expect(c(92, true)).toBe(true);
    expect(c(92, null)).toBe(true);  // no memory: the plain line
    expect(c(88, null)).toBe(false);
  });
  it("an unknown fall (no high, no price) says nothing", () => {
    expect(layerChart(flat(), pair(), 700 * DAY, ctx(null)).flags.some((x) => /all-time high/.test(x.label))).toBe(false);
    expect(layerChart(flat(), pair(), 700 * DAY).flags.some((x) => /all-time high/.test(x.label))).toBe(false);
  });
  it("a missing or odd date does not stop the flag", () => {
    expect(layerChart(flat(), pair(), 700 * DAY, ctx(95, null)).flags.find((x) => /all-time high/.test(x.label))?.label).toBe("Down 95% from its all-time high (Solscan)");
    expect(layerChart(flat(), pair(), 700 * DAY, ctx(95, "soon")).flags.find((x) => /all-time high/.test(x.label))?.label).toBe("Down 95% from its all-time high (Solscan)");
  });
  it("a token with nothing traded in the last hours (no candles) still says it", () => {
    const r = layerChart([], pair(), 700 * DAY, ctx(97));
    expect(r.available).toBe(true);
    expect(r.flags).toHaveLength(1);
    expect(r.flags[0].severity).toBe("warning");
    expect(r.safeBlocked).toBe(true);
  });
});

describe("decide: the flag, for the tokens that are read for it", () => {
  const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
  const input = (over: Partial<DecideInput> = {}): DecideInput => ({
    pair: { baseToken: { address: MINT, symbol: "TKN", name: "Token" }, priceUsd: "0.05", pairCreatedAt: 1_700_000_000_000, marketCap: 300_000_000, ...pair() },
    dexData: null, resolvedMint: MINT, marketCap: 300_000_000, tokenAgeMinutes: 700 * DAY, holders: 600_000,
    rugData: null, rugReport: null, tokenName: "Token", goplus: null, authFacts: deriveAuthorityFacts(null, null, MINT),
    totalSupplyUi: 1_000_000, solscanTokenAgeHours: 700 * 24, dexTokenAgeHours: 700 * 24, resolvedHolderAccounts: [],
    solscanTrades24h: null, solscanTraders24h: null, solscanAnswered: false, candles: flat(), dailyCandles: [], recentTransfers: [], creatorReputation: null, ...over,
  });
  const high = (ath: number) => ({ ath, athDate: "2024-11-13" });
  const hasFlag = (d: ReturnType<typeof decide>) => d.flags.some((f) => /all-time high/.test(f.label));

  it("95 % below its high: the flag is there and it is a warning, never a critical", () => {
    const d = decide(input({ allTimeHigh: high(1) })); // price 0.05 vs high 1 = -95 %
    expect(hasFlag(d)).toBe(true);
    expect(d.flags.find((f) => /all-time high/.test(f.label))?.severity).toBe("warning");
    expect(d.risk).not.toBe("SAFE");
  });
  it("the flag names Solscan and the month of the high", () => {
    expect(decide(input({ allTimeHigh: high(1) })).flags.find((f) => /all-time high/.test(f.label))?.label).toBe("Down 95% from its all-time high (Solscan, 2024-11)");
  });
  it("20 % below its high, an unknown high, or a high that Solscan does not give: no flag", () => {
    expect(hasFlag(decide(input({ allTimeHigh: high(0.0625) })))).toBe(false);
    expect(hasFlag(decide(input({ allTimeHigh: null })))).toBe(false);
    expect(hasFlag(decide(input()))).toBe(false);
  });
  it("a token that is not read for it never carries the flag, whatever the high: under 90 days, under $5M of cap", () => {
    expect(hasFlag(decide(input({ tokenAgeMinutes: 80 * DAY, allTimeHigh: high(1) })))).toBe(false);
    expect(hasFlag(decide(input({ marketCap: 4_000_000, allTimeHigh: high(1) })))).toBe(false);
  });
  it("a token of the issuer registry never carries it (jitoSOL: a liquid-staking token whose 'high' is a data glitch)", () => {
    const JITOSOL = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
    const d = decide(input({ resolvedMint: JITOSOL, allTimeHigh: high(1) }));
    expect(hasFlag(d)).toBe(false);
  });
});
