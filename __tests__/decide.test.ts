import { describe, it, expect, vi, afterEach } from "vitest";
import { decide, type DecideInput } from "../api/_lib/decide";
import { deriveAuthorityFacts } from "../api/_lib/facts";
import type { DexScreenerPair, GoPlusTokenResult, HeliusHolder } from "../api/_lib/types";

// decide() is the part of a scan that turns collected data into a verdict. It is pure: these tests call it with plain data, with no mock of
// the network, of Redis or of the clock. The replay (npm run replay) proves it gives the verdicts the scan always gave on real tokens.

const MINT = "So1ana1111111111111111111111111111111111111";

const healthyPair = (over: Partial<DexScreenerPair> = {}): DexScreenerPair => ({
  baseToken: { address: MINT, symbol: "TKN", name: "Token" },
  priceUsd: "0.01",
  liquidity: { usd: 400_000 },
  volume: { h24: 90_000, h1: 4_000 },
  priceChange: { m5: 0.2, h1: 1, h6: 2, h24: 3 },
  txns: { m5: { buys: 6, sells: 5 } },
  pairCreatedAt: 1_700_000_000_000,
  info: { socials: [{ type: "twitter", url: "https://twitter.com/t" }], websites: [{ url: "https://t.example" }] },
  ...over,
});

function input(over: Partial<DecideInput> = {}): DecideInput {
  return {
    pair: healthyPair(),
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
    resolvedHolderAccounts: [],
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

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("decide", () => {
  it("with nothing collected, gives DANGER, no source, no kind", () => {
    const d = decide(input({ pair: null, marketCap: null, tokenAgeMinutes: null, holders: null, totalSupplyUi: 0, solscanTokenAgeHours: null, dexTokenAgeHours: null }));
    expect(d.risk).toBe("DANGER");
    expect(d.rugKind).toBeNull();
    expect(d.sources_used).toEqual([]);
    expect(d.confidence).toBe(0);
  });

  it("a honeypot is a RUG, and a CONFIRMED one: the sale is blocked", () => {
    const goplus = { is_honeypot: "1" } as GoPlusTokenResult;
    const d = decide(input({ goplus, authFacts: deriveAuthorityFacts(null, goplus, MINT) }));
    expect(d.risk).toBe("RUG");
    expect(d.rugKind).toBe("confirmed");
    expect(d.score).toBe(0);
    expect(d.safeBlockedReasons).toContain("honeypot");
    expect(d.flags.some((f) => /honeypot/i.test(f.label))).toBe(true);
  });

  it("ten wallets holding 90 % of a small token is a RUG too, but only a RISK: nothing has happened", () => {
    const holders: HeliusHolder[] = [{ address: "w1", owner: "w1", uiAmount: 900_000 } as HeliusHolder];
    const d = decide(input({ resolvedHolderAccounts: holders, holders: 900, totalSupplyUi: 1_000_000 }));
    expect(d.risk).toBe("RUG");
    expect(d.rugKind).toBe("risk");
    expect(d.safeBlockedReasons).toContain("concentration");
  });

  it("never gives a kind to a verdict that is not RUG", () => {
    const d = decide(input());
    expect(d.risk).not.toBe("RUG");
    expect(d.rugKind).toBeNull();
  });

  it("returns the flags the way the clients and the verdict see them: one per signal, the most severe first", () => {
    const goplus = { is_honeypot: "1" } as GoPlusTokenResult;
    const d = decide(input({ goplus, authFacts: deriveAuthorityFacts(null, goplus, MINT) }));
    const rank = { critical: 0, warning: 1, info: 2, bonus: 3 } as const;
    const ranks = d.flags.map((f) => rank[f.severity]);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    expect(new Set(d.flags.map((f) => f.label)).size).toBe(d.flags.length);
  });
});

describe("decide is pure", () => {
  it("gives the same decision twice from the same input, and does not touch its input", () => {
    const goplus = { is_honeypot: "1" } as GoPlusTokenResult;
    const i = input({ goplus, authFacts: deriveAuthorityFacts(null, goplus, MINT) });
    const before = structuredClone(i);
    expect(decide(i)).toEqual(decide(i));
    expect(i).toEqual(before);
  });

  it("does not read the clock: the same decision a year apart", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const a = decide(input());
    vi.setSystemTime(new Date("2027-01-01T00:00:00Z"));
    expect(decide(input())).toEqual(a);
  });

  it("does not use the network", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    decide(input());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns what it would have logged as notes, and logs nothing itself", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const d = decide(input());
    expect(Array.isArray(d.notes)).toBe(true);
    expect(log).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });
});
