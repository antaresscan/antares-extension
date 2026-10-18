import { describe, it, expect } from "vitest";
import { decide, type DecideInput } from "../api/_lib/decide";
import { deriveAuthorityFacts } from "../api/_lib/facts";
import type { DexScreenerPair, HeliusHolder } from "../api/_lib/types";

// decide() with a list of the biggest holders that came from RugCheck's report (api/_lib/holders-memory.ts): the concentration is read and counts, but no second source confirmed
// it, so SAFE stays blocked, for the reason it was blocked while the layer was missing, and a line says it. A list from Helius (live, or its last one) is read as it always was.

const MINT = "So1ana1111111111111111111111111111111111111";

const pair = (): DexScreenerPair => ({
  baseToken: { address: MINT, symbol: "TKN", name: "Token" },
  priceUsd: "0.01",
  liquidity: { usd: 400_000 },
  volume: { h24: 90_000, h1: 4_000 },
  priceChange: { m5: 0.2, h1: 1, h6: 2, h24: 3 },
  txns: { m5: { buys: 6, sells: 5 } },
  pairCreatedAt: 1_700_000_000_000,
  info: { socials: [{ type: "twitter", url: "https://twitter.com/t" }], websites: [{ url: "https://t.example" }] },
});

const holders = (shares: number[], supply = 1_000_000): HeliusHolder[] =>
  shares.map((s, i) => ({ address: `acct${i}`, owner: `owner${i}`, uiAmount: s * supply }) as HeliusHolder);

function input(over: Partial<DecideInput> = {}): DecideInput {
  return {
    pair: pair(),
    dexData: null,
    resolvedMint: MINT,
    marketCap: 5_000_000,
    tokenAgeMinutes: 60 * 24 * 400,
    holders: 12_000,
    rugData: null,
    rugReport: null,
    tokenName: "Token",
    goplus: null,
    authFacts: deriveAuthorityFacts(null, null, MINT),
    totalSupplyUi: 1_000_000,
    solscanTokenAgeHours: 24 * 400,
    dexTokenAgeHours: 24 * 400,
    resolvedHolderAccounts: holders(Array.from({ length: 20 }, () => 0.01)),
    solscanTrades24h: null,
    solscanTraders24h: null,
    solscanAnswered: false,
    candles: [],
    dailyCandles: [],
    recentTransfers: [],
    creatorReputation: null,
    ...over,
  };
}

const READ_FROM_RUGCHECK = /holder concentration read from rugcheck/i;

describe("decide — the list of the biggest holders comes from RugCheck", () => {
  it("the layer counts (the list is real), SAFE is blocked for the holders, and one information line says where the list came from", () => {
    const d = decide(input({ holdersSource: "rugcheck" }));
    expect(d.layersSnapshot.helius.available).toBe(true);
    expect(d.sources_used).toContain("helius");
    expect(d.risk).not.toBe("SAFE");
    expect(d.safeBlocked).toBe(true);
    expect(d.safeBlockedReasons).toContain("holders");
    const line = d.flags.filter((f) => READ_FROM_RUGCHECK.test(f.label));
    expect(line).toHaveLength(1);
    expect(line[0].severity).toBe("info");
    expect(d.flags.some((f) => /helius unavailable/i.test(f.label))).toBe(false);
    expect(d.notes.some((n) => /holder list from rugcheck/i.test(n.message))).toBe(true);
  });

  it("the same list from Helius is read as always: no line, no block that this source would add", () => {
    const fromHelius = decide(input({ holdersSource: "helius" }));
    const unsaid = decide(input());
    expect(fromHelius.flags.some((f) => READ_FROM_RUGCHECK.test(f.label))).toBe(false);
    expect(fromHelius.notes.some((n) => /holder list from/i.test(n.message))).toBe(false);
    expect(fromHelius.safeBlockedReasons).not.toContain("holders");
    // An absent source (every caller before this change) is the same as "helius".
    expect(unsaid.flags).toEqual(fromHelius.flags);
    expect(unsaid.score).toBe(fromHelius.score);
    expect(unsaid.risk).toBe(fromHelius.risk);
  });

  it("the last list from Helius is read as Helius's (it IS Helius's), with a note for the log", () => {
    const last = decide(input({ holdersSource: "helius-last" }));
    const live = decide(input({ holdersSource: "helius" }));
    expect(last.flags).toEqual(live.flags);
    expect(last.score).toBe(live.score);
    expect(last.risk).toBe(live.risk);
    expect(last.safeBlockedReasons).toEqual(live.safeBlockedReasons);
    expect(last.notes.some((n) => /last answer/i.test(n.message))).toBe(true);
    expect(live.notes.some((n) => /last answer/i.test(n.message))).toBe(false);
  });

  it("a concentrated list from RugCheck gives the flag and the verdict the same list from Helius gives (TRUMP: the top 10 hold 88 %)", () => {
    const concentrated = holders([0.7181, 0.051, 0.03, 0.02, 0.015, 0.012, 0.01, 0.01, 0.007, 0.006, 0.005, 0.004, 0.003, 0.003, 0.002, 0.002, 0.002, 0.001, 0.001, 0.001]);
    const rc = decide(input({ resolvedHolderAccounts: concentrated, holdersSource: "rugcheck" }));
    const he = decide(input({ resolvedHolderAccounts: concentrated, holdersSource: "helius" }));
    const critical = (d: ReturnType<typeof decide>) => d.flags.filter((f) => f.severity === "critical").map((f) => f.label).sort();
    expect(critical(rc)).toEqual(critical(he));
    expect(critical(rc).length).toBeGreaterThan(0);
    expect(rc.risk).toBe(he.risk);
    expect(rc.score).toBe(he.score);
  });

  it("no list at all is still the layer missing, with its warning, whatever the source says", () => {
    const d = decide(input({ resolvedHolderAccounts: [], holdersSource: "rugcheck" }));
    expect(d.layersSnapshot.helius.available).toBe(false);
    expect(d.flags.some((f) => /helius unavailable/i.test(f.label))).toBe(true);
    expect(d.flags.some((f) => READ_FROM_RUGCHECK.test(f.label))).toBe(false);
  });

  it("is pure: the same input gives the same decision, the line included", () => {
    expect(decide(input({ holdersSource: "rugcheck" }))).toEqual(decide(input({ holdersSource: "rugcheck" })));
  });
});
