import { describe, it, expect } from "vitest";
import { selectBestPair } from "../api/_lib/dex-pair-select";
import type { DexScreenerPair } from "../api/_lib/types";

// Regression suite for the Fartcoin 2026-05-26 incident.
//
// Background: DexScreener returns one DexScreenerPair per liquidity pool a
// token participates in. A blue-chip Solana token like Fartcoin has 30+
// pools — Orca/USDC, Raydium/SOL, Meteora/USDC, plus a long tail of
// memecoin-quoted pools (Fartcoin/PUMP, Fartcoin/BONK, …). Each pool
// reports its own priceChange.h24 — and when the quote token itself is
// volatile, that field reads like the base token pumped 4700×, not the
// real -5% move in USD.
//
// The old selector picked whichever pool had the highest USD liquidity
// regardless of quote token. On the incident day, FARTCOIN/PUMP on Orca
// reported $42M liquidity with priceChange.h24 = +466,736%, beating the
// real FARTCOIN/USDC pool ($645k, -6.24%). That value crossed the layer-1
// `pc24 > 5000` guard and force-rugged the verdict — Antares was telling
// users that a $175M-mcap token was a rug pull while the chart they were
// looking at showed it down 5% on the day.
//
// The fix is upstream of every signal that reads a pair field. If the
// wrong pair gets selected here, every subsequent signal (price, mcap,
// volume, priceChange, txns…) is computed against the wrong pool and
// no downstream rule can save you. So the rule is: filter to pairs
// whose quote token is stable enough that priceChange.h24 actually
// tracks the base token's USD movement, then pick by liquidity. The
// memecoin-quoted pools still exist for the token but they're no longer
// a valid source of USD-denominated signals.

function makePair(over: Partial<DexScreenerPair> & {
  quoteSymbol?: string;
  liqUsd?: number;
}): DexScreenerPair {
  const { quoteSymbol, liqUsd, ...rest } = over;
  return {
    pairAddress: "0xpair",
    baseToken: { address: "0xbase", symbol: "TOK", name: "Token" },
    quoteToken: quoteSymbol
      ? { address: "0xquote", symbol: quoteSymbol, name: quoteSymbol }
      : undefined,
    liquidity: { usd: liqUsd ?? 0 },
    ...rest,
  };
}

describe("selectBestPair", () => {
  it("returns null for null / undefined / empty input", () => {
    expect(selectBestPair(null)).toBeNull();
    expect(selectBestPair(undefined)).toBeNull();
    expect(selectBestPair([])).toBeNull();
  });

  it("returns the only pair when there's just one (no filtering even if quote is exotic)", () => {
    // Pre-graduation pump.fun pools only have one pool with a non-stable
    // quote — we still need to scan them, just with reduced confidence
    // downstream rather than refuse the scan here.
    const only = makePair({ quoteSymbol: "PUMP", liqUsd: 12_000 });
    expect(selectBestPair([only])).toBe(only);
  });

  it("Fartcoin incident: rejects FARTCOIN/PUMP $42M in favour of FARTCOIN/USDC $645k", () => {
    // The exact numbers logged at the API on the incident day.
    const fartcoinPump = makePair({
      pairAddress: "orca-fartcoin-pump",
      dexId: "orca",
      quoteSymbol: "PUMP",
      liqUsd: 42_578_647,
      priceChange: { h24: 466_736 },
    });
    const fartcoinUsdc = makePair({
      pairAddress: "orca-fartcoin-usdc",
      dexId: "orca",
      quoteSymbol: "USDC",
      liqUsd: 645_406,
      priceChange: { h24: -6.24 },
    });
    const picked = selectBestPair([fartcoinPump, fartcoinUsdc]);
    expect(picked?.pairAddress).toBe("orca-fartcoin-usdc");
    expect(picked?.priceChange?.h24).toBe(-6.24);
  });

  it("among stable-quoted pairs, picks the highest USD liquidity", () => {
    // Real Fartcoin shape: USDC pool small, SOL pool much bigger — pick
    // SOL since SOL is also a stable quote and has more liquidity.
    const orcaUsdc = makePair({ pairAddress: "orca-usdc", quoteSymbol: "USDC", liqUsd: 645_406 });
    const raydiumSol = makePair({ pairAddress: "raydium-sol", quoteSymbol: "SOL", liqUsd: 7_045_814 });
    const orcaSol = makePair({ pairAddress: "orca-sol", quoteSymbol: "SOL", liqUsd: 1_057_981 });
    const meteoraUsdc = makePair({ pairAddress: "meteora-usdc", quoteSymbol: "USDC", liqUsd: 105_394 });
    const picked = selectBestPair([orcaUsdc, raydiumSol, orcaSol, meteoraUsdc]);
    expect(picked?.pairAddress).toBe("raydium-sol");
  });

  it("falls back to all pairs when no stable-quoted pair exists", () => {
    // Pre-graduation pump.fun bond — only quoted against PUMP. We still
    // pick *something* so the rest of the scan can complete (the layers
    // downstream can apply their own confidence reductions).
    const bondA = makePair({ pairAddress: "pump-a", quoteSymbol: "PUMP", liqUsd: 8_000 });
    const bondB = makePair({ pairAddress: "pump-b", quoteSymbol: "PUMP", liqUsd: 25_000 });
    const picked = selectBestPair([bondA, bondB]);
    expect(picked?.pairAddress).toBe("pump-b");
  });

  it("ignores quote-symbol case and recognizes WSOL/WBTC/WETH as stable", () => {
    // DexScreener sometimes returns "wSOL" or "wsol" depending on the
    // chain/indexer. The whitelist match must be case-insensitive.
    const wsolLower = makePair({ pairAddress: "ray-wsol", quoteSymbol: "wsol", liqUsd: 500_000 });
    const memecoinUp = makePair({ pairAddress: "junk", quoteSymbol: "RANDOMCOIN", liqUsd: 5_000_000 });
    const picked = selectBestPair([memecoinUp, wsolLower]);
    expect(picked?.pairAddress).toBe("ray-wsol");
  });

  it("treats missing quoteToken as non-stable (defensive)", () => {
    // Older DexScreener responses occasionally drop quoteToken when the
    // pair is mid-indexing. Treat as unknown → not stable, so a real
    // stable pair always wins.
    const noQuote = makePair({ pairAddress: "unknown", liqUsd: 10_000_000 });
    const realUsdc = makePair({ pairAddress: "real-usdc", quoteSymbol: "USDC", liqUsd: 100_000 });
    const picked = selectBestPair([noQuote, realUsdc]);
    expect(picked?.pairAddress).toBe("real-usdc");
  });

  it("treats null liquidity as 0 (memecoin with broken indexing doesn't trump real pool)", () => {
    const broken = makePair({ pairAddress: "broken", quoteSymbol: "USDC", liqUsd: undefined });
    const real = makePair({ pairAddress: "real", quoteSymbol: "USDC", liqUsd: 50_000 });
    const picked = selectBestPair([broken, real]);
    expect(picked?.pairAddress).toBe("real");
  });
});
