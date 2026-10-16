import { describe, it, expect } from "vitest";
import { isTop10Candidate, isTop10Proven, layerHelius, layerRugCheck, type Top10ReliefFacts } from "../api/_lib/layers";
import { decide, top10ReliefFactsOf, type DecideInput } from "../api/_lib/decide";
import { deriveAuthorityFacts } from "../api/_lib/facts";
import { athDropPct } from "../api/_lib/ath";
import type { DexScreenerPair, HeliusHolder, RugCheckSummary } from "../api/_lib/types";

// CARDS (31 000 holders, $4M pool, $246M cap, 407 days) was DANGER because its top 10 holds 73 %: exchanges, treasuries and vaults. MET was RUG (82 %). A token the market has
// proven keeps a concentrated top 10 as a warning (CAUTION), unless it already fell most of the way from its all-time high (MELANIA -99 %, YZY -90 %: the insiders sold).
// The line is 89 % on Solscan's DAILY highs (90 % on an intraday one): SPX (-84.6 %), JUP (-84.3 %) and RAY (-88 % daily), which the owner names as real tokens, are under it; ZEREBRO, TRUNK,
// LUNA, MELANIA are over it. A launch that pumped and dumped within hours (YZY) has a daily high far under its real one and stands under the line too: it is the LIVING MARKET (Jupiter's
// organic score) that refuses it, not the line.

const DAY = 1440;
/** CARDS-like: everything the relief asks for, one number at a time can be taken away. */
const proven = (over: Partial<Top10ReliefFacts> = {}): Top10ReliefFacts => ({
  tokenAgeMinutes: 400 * DAY, liquidityUsd: 4_000_000, poolDepthUsd: 5_600_000, marketCapUsd: 246_000_000, holders: 31_000, mintActive: false, freezeActive: false, ...over,
});

describe("isTop10Candidate / isTop10Proven: what the market must say, one condition at a time", () => {
  it("a token that has all of it is a candidate, and is proven when its market is alive and its all-time high is within reach", () => {
    expect(isTop10Candidate(proven())).toBe(true);
    expect(isTop10Proven({ ...proven(), athDropPct: 9, livingMarket: true })).toBe(true);
  });
  it("a candidate whose market is NOT alive (BAN, JELLYJELLY, ALCH: organic score 0) or not known is not proven, whatever its history says", () => {
    expect(isTop10Proven({ ...proven(), athDropPct: 9, livingMarket: false })).toBe(false);
    expect(isTop10Proven({ ...proven(), athDropPct: 9, livingMarket: null })).toBe(false);
    expect(isTop10Proven({ ...proven(), athDropPct: 9 })).toBe(false);
  });
  it.each([
    ["too young (59 days)", { tokenAgeMinutes: 59 * DAY }],
    ["a pool under $100k", { liquidityUsd: 99_000 }],
    ["a cap under $25M", { marketCapUsd: 24_000_000, poolDepthUsd: 5_600_000 }],
    ["pools under $1M together", { poolDepthUsd: 999_000 }],
    ["pools under 0.1 % of the cap (a faked cap: WLFI $5.7B with $28k of pools)", { marketCapUsd: 5_700_000_000, liquidityUsd: 13_000, poolDepthUsd: 28_000 }],
    ["pools worth $1M but under 0.1 % of a very big cap", { marketCapUsd: 1_200_000_000, liquidityUsd: 1_000_000, poolDepthUsd: 1_000_000 }],
    ["an unknown depth", { poolDepthUsd: null }],
    ["under 10 000 holders", { holders: 9_999 }],
    ["an unknown number of holders", { holders: null }],
    ["an unknown age", { tokenAgeMinutes: null }],
    ["an unknown pool", { liquidityUsd: null }],
    ["an unknown cap", { marketCapUsd: null }],
    ["an active mint authority", { mintActive: true }],
    ["an active freeze authority", { freezeActive: true }],
  ] as Array<[string, Partial<Top10ReliefFacts>]>)("is not a candidate with %s", (_name, over) => {
    expect(isTop10Candidate(proven(over))).toBe(false);
    expect(isTop10Proven({ ...proven(over), athDropPct: 0, livingMarket: true })).toBe(false);
  });
  it("a token whose liquidity is split between many pools is read on ALL of them (JUP: $2.2M in its biggest pool, $4.6M together, for a $1.2B cap)", () => {
    const jup = proven({ marketCapUsd: 1_200_000_000, liquidityUsd: 2_200_000, poolDepthUsd: 4_600_000, holders: 830_000 });
    expect(isTop10Candidate(jup)).toBe(true);
    // The biggest pool alone is $700k here: a $1M market only when the pools are added up.
    expect(isTop10Candidate(proven({ marketCapUsd: 500_000_000, liquidityUsd: 700_000, poolDepthUsd: 1_400_000 }))).toBe(true);
    expect(isTop10Candidate(proven({ marketCapUsd: 500_000_000, liquidityUsd: 700_000, poolDepthUsd: 700_000 }))).toBe(false);
  });
  it("is not proven when it fell 89 % or more from its all-time high, or when that high is unknown", () => {
    const alive = { ...proven(), livingMarket: true };
    expect(isTop10Proven({ ...alive, athDropPct: 84.6 })).toBe(true);  // SPX
    expect(isTop10Proven({ ...alive, athDropPct: 84.3 })).toBe(true);  // JUP
    expect(isTop10Proven({ ...alive, athDropPct: 88.0 })).toBe(true);  // RAY, by a daily high
    expect(isTop10Proven({ ...alive, athDropPct: 88.99 })).toBe(true);
    expect(isTop10Proven({ ...alive, athDropPct: 89 })).toBe(false);
    expect(isTop10Proven({ ...alive, athDropPct: 89.4 })).toBe(false); // YZY, by a daily high
    expect(isTop10Proven({ ...alive, athDropPct: 96.3 })).toBe(false); // TRUNK
    expect(isTop10Proven({ ...alive, athDropPct: 99.3 })).toBe(false); // MELANIA
    expect(isTop10Proven({ ...alive, athDropPct: null })).toBe(false);
    expect(isTop10Proven({ ...alive, athDropPct: undefined })).toBe(false);
    expect(isTop10Proven({ ...alive, athDropPct: Number.NaN })).toBe(false);
  });
});

describe("isTop10Proven with the memory of the line (athCollapsed): the side of the line decides, not the spot price", () => {
  const alive = { ...proven(), livingMarket: true };
  it("a token that has collapsed stays refused between 84 % and 89 % (a token at -87 % after a good week)", () => {
    expect(isTop10Proven({ ...alive, athDropPct: 87, athCollapsed: true })).toBe(false);
    expect(isTop10Proven({ ...alive, athDropPct: 87, athCollapsed: false })).toBe(true);
    expect(isTop10Proven({ ...alive, athDropPct: 87 })).toBe(true); // no memory: the plain line
  });
  it("a token that was clean keeps its relief at -91 % if the memory says it never crossed (it is the memory that moves it, once, at the crossing)", () => {
    expect(isTop10Proven({ ...alive, athDropPct: 91, athCollapsed: false })).toBe(true);
    expect(isTop10Proven({ ...alive, athDropPct: 91, athCollapsed: true })).toBe(false);
  });
  it("an unknown fall is never relief, whatever the memory says", () => {
    expect(isTop10Proven({ ...alive, athDropPct: null, athCollapsed: false })).toBe(false);
  });
});

describe("athDropPct", () => {
  const ath = { ath: 2, athDate: "2025-01-19" };
  it("is how far the price stands below the high, in percent, and never negative", () => {
    expect(athDropPct(ath, 1)).toBeCloseTo(50, 6);
    expect(athDropPct(ath, 0.02)).toBeCloseTo(99, 6);
    expect(athDropPct(ath, 3)).toBe(0); // a new high
  });
  it("is unknown, not zero, when either number is missing or not positive", () => {
    expect(athDropPct(null, 1)).toBeNull();
    expect(athDropPct(ath, null)).toBeNull();
    expect(athDropPct(ath, 0)).toBeNull();
    expect(athDropPct(ath, Number.NaN)).toBeNull();
    expect(athDropPct({ ath: 0, athDate: null }, 1)).toBeNull();
  });
});

// ── The layers ─────────────────────────────────────────────────────────────────────────────────────────────
const SUPPLY = 1_000_000;
/** A top 10 that holds `top10Pct` % of the supply, the biggest wallet `top1Pct` %: ten wallets and a long tail. */
function holdersOf(top1Pct: number, top10Pct: number): HeliusHolder[] {
  const rest = (top10Pct - top1Pct) / 9;
  return [
    { address: "w0", owner: "w0", uiAmount: (SUPPLY * top1Pct) / 100 },
    ...Array.from({ length: 9 }, (_, i) => ({ address: `w${i + 1}`, owner: `w${i + 1}`, uiAmount: (SUPPLY * rest) / 100 })),
    ...Array.from({ length: 100 }, (_, i) => ({ address: `t${i}`, owner: `t${i}`, uiAmount: (SUPPLY * Math.max(0, 100 - top10Pct)) / 100 / 100 })),
  ];
}
const ctx = (top10Proven: boolean) => ({
  holders: 31_000, liquidity: 4_000_000, tokenAgeHours: 407 * 24, mintAuthority: false, freezeAuthority: false, honeypot: false, lpBurned: false, top10Proven,
});
const texts = (r: { flags: Array<{ label: string; severity: string }> }, sev: string) => r.flags.filter((f) => f.severity === sev).map((f) => f.label);

describe("layerHelius: the top-10 ladder of a token the market has proven", () => {
  it("without the relief, a top 10 at 73-82 % is critical and 82 % forces the RUG (as always)", () => {
    const r73 = layerHelius(holdersOf(10, 73), SUPPLY, ctx(false));
    expect(texts(r73, "critical").some((l) => /Top 10 hold 73%/.test(l))).toBe(true);
    const r82 = layerHelius(holdersOf(10, 82), SUPPLY, ctx(false));
    expect(texts(r82, "critical").some((l) => /Top 10 hold 82%/.test(l))).toBe(true);
    expect(r82.forceRug).toBe(true);
  });
  it("with the relief, 73 % and 82 % are ONE warning, with the soft reason, and never a forced RUG", () => {
    for (const top10 of [65, 73, 82, 89]) {
      const r = layerHelius(holdersOf(10, top10), SUPPLY, ctx(true));
      expect(texts(r, "critical")).toEqual([]);
      expect(texts(r, "warning").filter((l) => /^Top 10 hold/.test(l))).toHaveLength(1);
      expect(r.flags.find((f) => /^Top 10 hold/.test(f.label))?.reasons).toEqual(["concentration_light"]);
      expect(r.forceRug).toBe(false);
      expect(r.safeBlocked).toBe(true); // never SAFE on this rule
    }
  });
  it("with the relief, a top 10 at 90 % or more is control whatever the market says: critical, RUG forced", () => {
    const r = layerHelius(holdersOf(10, 92), SUPPLY, ctx(true));
    expect(texts(r, "critical").some((l) => /Top 10 hold 92%/.test(l))).toBe(true);
    expect(r.forceRug).toBe(true);
  });
  it("one big wallet: 55 % is context under the relief (the ladder already said it), 65 % is still a critical", () => {
    const r55 = layerHelius(holdersOf(55, 82), SUPPLY, ctx(true));
    expect(texts(r55, "critical")).toEqual([]);
    expect(texts(r55, "warning").filter((l) => /Single wallet/.test(l))).toEqual([]); // not a second warning: three warnings make a DANGER
    expect(texts(r55, "info").some((l) => /Single wallet holds 55%/.test(l))).toBe(true);
    const r65 = layerHelius(holdersOf(65, 82), SUPPLY, ctx(true));
    expect(texts(r65, "critical").some((l) => /Single wallet holds 65%/.test(l))).toBe(true);
  });
  it("one big wallet alone (the ladder has nothing to say about the top 10): a warning, the penalty only once", () => {
    const r = layerHelius(holdersOf(41, 43), SUPPLY, ctx(true));
    expect(texts(r, "critical")).toEqual([]);
    expect(texts(r, "warning").some((l) => /Single wallet holds 41% — high · established token/.test(l))).toBe(true);
  });
  it("a token that is not established gets no relief even if the context says so (the relief is for the established tier)", () => {
    const young = { ...ctx(true), tokenAgeHours: 10 * 24, holders: 1_000 };
    const r = layerHelius(holdersOf(10, 82), SUPPLY, young);
    expect(texts(r, "critical").length).toBeGreaterThan(0);
  });
});

describe("layerRugCheck: RugCheck's concentration is counted once on a token the market has proven", () => {
  const summary = (top10: number): RugCheckSummary => ({ lpBurned: false, lpLocked: false, metaMutable: false, topHolders: { top10Percentage: top10, top1Percentage: 10 }, risks: [] } as unknown as RugCheckSummary);
  const rugCtx = (top10Proven: boolean) => ({ holders: 31_000, liquidity: 4_000_000, tokenAgeHours: 407 * 24, mintAuthority: false, freezeAuthority: false, honeypot: false, top10Proven });
  it("a top 10 over 70 % is a critical (and a penalty) without the relief, information with it", () => {
    const without = layerRugCheck(summary(82), null, "M", "Token", rugCtx(false));
    expect(texts(without, "critical")).toContain("Top 10 holders > 70% (RugCheck)");
    const withRelief = layerRugCheck(summary(82), null, "M", "Token", rugCtx(true));
    expect(texts(withRelief, "critical")).toEqual([]);
    expect(texts(withRelief, "info")).toContain("Top 10 holders > 70% (RugCheck)");
    expect(withRelief.trust).toBeGreaterThan(without.trust);
  });
  // RugCheck's risks come with the summary; the report says who the biggest wallet is.
  const withRisks = (names: string[]): RugCheckSummary => ({ ...summary(40), risks: names.map((name) => ({ name, level: "danger", description: "", score: 1000 })) } as unknown as RugCheckSummary);
  const report = (top1Pct: number) => ({ risks: [], topHolders: [{ pct: top1Pct }] }) as unknown as Parameters<typeof layerRugCheck>[1];
  const rc = (r: { flags: Array<{ label: string; severity: string }> }, sev: string) => texts(r, sev).filter((l) => /^RugCheck:/.test(l)).sort();
  it("its risk names that say the same thing are information with the relief, a warning without it; the other risks are not touched", () => {
    const names = ["Top 10 holders high ownership", "High ownership", "Single holder ownership", "Some other danger"];
    const off = layerRugCheck(withRisks(names), report(20), "M", "Token", rugCtx(false));
    expect(rc(off, "warning")).toHaveLength(4);
    const on = layerRugCheck(withRisks(names), report(20), "M", "Token", rugCtx(true));
    expect(rc(on, "info")).toEqual(["RugCheck: High ownership", "RugCheck: Single holder ownership", "RugCheck: Top 10 holders high ownership"]);
    expect(rc(on, "warning")).toEqual(["RugCheck: Some other danger"]);
    expect(on.trust).toBeGreaterThan(off.trust);
  });
  it("'Single holder ownership' stays a warning when RugCheck's own report puts the biggest wallet above the ceiling (60 %), or does not say", () => {
    expect(rc(layerRugCheck(withRisks(["Single holder ownership"]), report(70), "M", "Token", rugCtx(true)), "warning")).toEqual(["RugCheck: Single holder ownership"]);
    expect(rc(layerRugCheck(withRisks(["Single holder ownership"]), null, "M", "Token", rugCtx(true)), "warning")).toEqual(["RugCheck: Single holder ownership"]);
    expect(rc(layerRugCheck(withRisks(["Single holder ownership"]), report(60), "M", "Token", rugCtx(true)), "info")).toEqual(["RugCheck: Single holder ownership"]);
  });
});

// ── The decision ───────────────────────────────────────────────────────────────────────────────────────────
describe("decide: CARDS and MELANIA, the same top 10, two histories", () => {
  const MINT = "CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp";
  const pair = (): DexScreenerPair => ({
    baseToken: { address: MINT, symbol: "CARDS", name: "Collector Crypt" },
    priceUsd: "0.347", liquidity: { usd: 4_000_000 }, volume: { h24: 600_000, h1: 20_000 },
    priceChange: { m5: 0.1, h1: 0.2, h6: -0.5, h24: -1 }, txns: { m5: { buys: 6, sells: 5 } },
    pairCreatedAt: 1_700_000_000_000, marketCap: 246_000_000,
    info: { socials: [{ type: "twitter", url: "https://twitter.com/t" }], websites: [{ url: "https://t.example" }] },
  });
  // CARDS: Jupiter's organic score is 95 (a living market) unless a test says otherwise.
  const input = (allTimeHigh: DecideInput["allTimeHigh"], organicScore: number | null | undefined = 95): DecideInput => ({
    pair: pair(), dexData: null, resolvedMint: MINT, marketCap: 246_000_000, tokenAgeMinutes: 407 * DAY, holders: 31_000,
    rugData: null, rugReport: null, tokenName: "Collector Crypt", goplus: null, authFacts: deriveAuthorityFacts(null, null, MINT),
    totalSupplyUi: SUPPLY, solscanTokenAgeHours: 407 * 24, dexTokenAgeHours: 407 * 24, resolvedHolderAccounts: holdersOf(10, 73),
    solscanTrades24h: null, solscanTraders24h: null, solscanAnswered: false, candles: [], dailyCandles: [], recentTransfers: [], creatorReputation: null, allTimeHigh, organicScore,
  });

  it("the scan asks for the all-time high only for a candidate (top10ReliefFactsOf feeds isTop10Candidate), with the pools of the token added up", () => {
    expect(isTop10Candidate(top10ReliefFactsOf(input(null)))).toBe(true);
    const split = input(null);
    split.pair = { ...pair(), liquidity: { usd: 700_000 } };
    split.marketCap = 500_000_000;
    const pool = (usd: number): DexScreenerPair => ({ ...pair(), liquidity: { usd } });
    split.dexData = { pairs: [pool(700_000), pool(400_000), pool(300_000)] } as unknown as DecideInput["dexData"];
    expect(top10ReliefFactsOf(split).poolDepthUsd).toBe(1_400_000);
    expect(isTop10Candidate(top10ReliefFactsOf(split))).toBe(true);
    const thin = input(null); thin.pair = { ...pair(), liquidity: { usd: 20_000 } };
    expect(isTop10Candidate(top10ReliefFactsOf(thin))).toBe(false);
  });
  it("-9 % from its high: the top 10 at 73 % is a warning, the verdict is not DANGER", () => {
    const d = decide(input({ ath: 0.381, athDate: "2025-09-14" }));
    expect(d.flags.filter((f) => f.severity === "critical")).toEqual([]);
    expect(d.risk).toBe("CAUTION");
  });
  it("-99 % from its high: the same top 10 is the critical it always was", () => {
    const d = decide(input({ ath: 34.7, athDate: "2025-01-19" }));
    expect(d.flags.some((f) => f.severity === "critical" && /Top 10 hold 73%/.test(f.label))).toBe(true);
    expect(d.risk).toBe("DANGER");
  });
  it("its all-time high unknown (Solscan silent or without a price for it): no relief, the verdict the engine gave before", () => {
    expect(decide(input(null)).risk).toBe("DANGER");
    expect(decide(input(undefined)).risk).toBe("DANGER");
  });
  // A daily price history cannot see a launch that pumped and dumped within hours (YZY): its daily high is far under the real one, it stands under the line and its history looks clean.
  // What stops the relief is that its market is not alive.
  it("a clean history but a market that is NOT alive (organic score 0: BAN, JELLYJELLY, ALCH, YZY): the top 10 at 73 % is the critical it always was", () => {
    const d = decide(input({ ath: 0.381, athDate: "2025-09-14" }, 0));
    expect(d.flags.some((f) => f.severity === "critical" && /Top 10 hold 73%/.test(f.label))).toBe(true);
    expect(d.risk).toBe("DANGER");
  });
  it("a market nobody could read (Jupiter silent or not listing the token): no relief, the verdict of before", () => {
    expect(decide(input({ ath: 0.381, athDate: "2025-09-14" }, null)).risk).toBe("DANGER");
    expect(decide({ ...input({ ath: 0.381, athDate: "2025-09-14" }), organicScore: undefined }).risk).toBe("DANGER");
  });
  it("the least active token that is relieved today (BC, organic 49) keeps its relief; 29 does not, 30 does", () => {
    expect(decide(input({ ath: 0.381, athDate: "2025-09-14" }, 49)).risk).toBe("CAUTION");
    expect(decide(input({ ath: 0.381, athDate: "2025-09-14" }, 30)).risk).toBe("CAUTION");
    expect(decide(input({ ath: 0.381, athDate: "2025-09-14" }, 29)).risk).toBe("DANGER");
  });
});
