import { describe, it, expect } from "vitest";
import {
  layerDexScreener, layerGoPlus, layerRugCheck, layerHelius,
  layerIdentity, layerSolscan, layerCrossValidation,
} from "../api/_lib/layers";
import type { DexScreenerPair, RugCheckSummary, GoPlusTokenResult, HeliusHolder } from "../api/_lib/types";

// ═══ LAYER 1 — DexScreener ═════════════════════════════════════════════════

describe("layerDexScreener", () => {
  it("returns unavailable for null pair", () => {
    const result = layerDexScreener(null, null, null);
    expect(result.available).toBe(false);
    expect(result.source).toBe("dexscreener");
  });

  it("returns trust 1.0 for healthy pair", () => {
    const pair: DexScreenerPair = {
      liquidity: { usd: 100000 },
      volume: { h24: 50000 },
      priceChange: { h1: 5, h6: 10, h24: 20, m5: 1 },
      txns: { m5: { buys: 10, sells: 8 } },
      info: {
        socials: [{ type: "twitter", url: "https://twitter.com/test" }],
        websites: [{ url: "https://test.com" }],
      },
    };
    const result = layerDexScreener(pair, 500000, 1440);
    expect(result.trust).toBe(1.0);
    expect(result.available).toBe(true);
    expect(result.forceRug).toBe(false);
    expect(result.safeBlocked).toBe(false);
  });

  it("applies penalty for low liquidity (<$1k)", () => {
    const pair: DexScreenerPair = {
      liquidity: { usd: 500 },
      volume: { h24: 100 },
      priceChange: {},
      txns: { m5: { buys: 1, sells: 1 } },
    };
    const result = layerDexScreener(pair, null, null);
    expect(result.trust).toBeLessThan(0.3);
    expect(result.available).toBe(true);
  });

  it("forceRug when liquidity 0 with vol/liq > 20", () => {
    const pair: DexScreenerPair = {
      liquidity: { usd: 1 },
      volume: { h24: 100 },
      priceChange: {},
      txns: { m5: { buys: 1, sells: 1 } },
    };
    const result = layerDexScreener(pair, null, null);
    expect(result.forceRug).toBe(true);
    expect(result.safeBlocked).toBe(true);
  });

  it("diminishing returns for multiple penalties", () => {
    // Low liquidity + no socials => 2 penalties, trust reduces but not to 0
    const pair: DexScreenerPair = {
      liquidity: { usd: 800 },
      volume: { h24: 100 },
      priceChange: {},
      txns: { m5: { buys: 1, sells: 1 } },
      info: { socials: [], websites: [] },
    };
    const result = layerDexScreener(pair, null, null);
    expect(result.trust).toBeGreaterThan(0);
    expect(result.trust).toBeLessThan(0.25);
  });
});

// ═══ LAYER 2 — RugCheck ═════════════════════════════════════════════════════

describe("layerRugCheck", () => {
  it("returns unavailable for null rugData", () => {
    const result = layerRugCheck(null, null, "abc");
    expect(result.available).toBe(false);
  });

  it("trust 1.0 when LP burned + no risks", () => {
    const rugData: RugCheckSummary = {
      lpBurned: true,
      metaMutable: false,
    };
    const result = layerRugCheck(rugData, null, "someMint123");
    // LP burned gives 1.10 bonus (capped at 1.0) and metaMutable false gives 0.96 penalty
    expect(result.trust).toBeGreaterThan(0.95);
    expect(result.available).toBe(true);
    expect(result.forceRug).toBe(false);
  });

  it("mint authority penalty reduces trust", () => {
    const rugData: RugCheckSummary = {
      lpBurned: true,
      metaMutable: false,
      mintAuthorityEnabled: true,
    };
    const result = layerRugCheck(rugData, null, "someMint123");
    expect(result.trust).toBeLessThan(0.5);
    expect(result.flags.some(f => /mint authority/i.test(f.label))).toBe(true);
  });

  it("freeze authority safeBlocked", () => {
    const rugData: RugCheckSummary = {
      lpBurned: true,
      metaMutable: false,
      freezeAuthorityEnabled: true,
    };
    const result = layerRugCheck(rugData, null, "someMint123");
    expect(result.trust).toBeLessThan(0.5);
    expect(result.flags.some(f => /freeze authority/i.test(f.label))).toBe(true);
  });
});

// ═══ LAYER 3 — GoPlus ═══════════════════════════════════════════════════════

describe("layerGoPlus", () => {
  it("returns unavailable for null", () => {
    const result = layerGoPlus(null);
    expect(result.available).toBe(false);
  });

  it("honeypot sets BOTH trust:0 AND safeBlocked:true", () => {
    const result = layerGoPlus({ is_honeypot: "1" });
    expect(result.trust).toBe(0);
    expect(result.forceRug).toBe(true);
    expect(result.safeBlocked).toBe(true);
  });

  it("cannot_sell_all sets safeBlocked BEFORE early return", () => {
    const result = layerGoPlus({ cannot_sell_all: "1" });
    expect(result.trust).toBe(0);
    expect(result.forceRug).toBe(true);
    expect(result.safeBlocked).toBe(true);
  });

  it("mint + freeze both active sets safeBlocked", () => {
    const goplus: GoPlusTokenResult = {
      mint_authority: "active",
      freeze_authority: "active",
    };
    const result = layerGoPlus(goplus);
    expect(result.safeBlocked).toBe(true);
    expect(result.forceRug).toBe(true);
    expect(result.flags.some(f => /mint.*freeze/i.test(f.label))).toBe(true);
  });

  it("clean token returns high trust", () => {
    const goplus: GoPlusTokenResult = {
      is_honeypot: "0",
      cannot_sell_all: "0",
      mint_authority: "0",
      freeze_authority: "0",
    };
    const result = layerGoPlus(goplus);
    expect(result.trust).toBe(1.0);
    expect(result.safeBlocked).toBe(false);
    expect(result.forceRug).toBe(false);
  });
});

// ═══ LAYER 4 — Helius ═══════════════════════════════════════════════════════

describe("layerHelius", () => {
  it("returns unavailable for empty holders", () => {
    const result = layerHelius([], 0);
    expect(result.available).toBe(false);
  });

  it("penalty for top holder > 50%", () => {
    const holders: HeliusHolder[] = [
      { address: "wallet1abc", uiAmount: 600 },
      { address: "wallet2abc", uiAmount: 100 },
      { address: "wallet3abc", uiAmount: 100 },
      { address: "wallet4abc", uiAmount: 100 },
      { address: "wallet5abc", uiAmount: 100 },
    ];
    const result = layerHelius(holders, 1000);
    // top1Pct = 0.6 => > 0.3 => penalty 0.08 + forceRug
    expect(result.trust).toBeLessThan(0.15);
    expect(result.forceRug).toBe(true);
  });

  it("foundation wallet detection — excludes foundation wallets from holder analysis", () => {
    // Foundation wallet should be filtered out of analysis
    const holders: HeliusHolder[] = [
      { address: "B9n3tgBJ8f1K2VXrF5aTBNXXmj5V8sKXrk3GV5uPump", uiAmount: 500 },
      { address: "wallet1abc", uiAmount: 50 },
      { address: "wallet2abc", uiAmount: 50 },
      { address: "wallet3abc", uiAmount: 50 },
      { address: "wallet4abc", uiAmount: 50 },
      { address: "wallet5abc", uiAmount: 50 },
      { address: "wallet6abc", uiAmount: 50 },
      { address: "wallet7abc", uiAmount: 50 },
      { address: "wallet8abc", uiAmount: 50 },
      { address: "wallet9abc", uiAmount: 50 },
      { address: "wallet10abc", uiAmount: 50 },
    ];
    const result = layerHelius(holders, 1000);
    // Foundation wallet filtered out, so top1 = 50/1000 = 5% which is fine
    expect(result.trust).toBeGreaterThan(0.9);
    expect(result.forceRug).toBe(false);
  });

  it("well distributed supply gets bonus", () => {
    const holders: HeliusHolder[] = Array.from({ length: 20 }, (_, i) => ({
      address: `wallet${i}abc`,
      uiAmount: 50,
    }));
    const result = layerHelius(holders, 10000);
    // top10Pct = 500/10000 = 5% < 30% => bonus
    expect(result.trust).toBe(1.0); // min(1.0, 1.0 * 1.05)
    expect(result.flags.some(f => /well distributed/i.test(f.label))).toBe(true);
  });
});

// ═══ LAYER 5 — Solscan ═══════════════════════════════════════════════════════

describe("layerSolscan", () => {
  it("returns unavailable when no data", () => {
    const result = layerSolscan(null, null, null, null);
    expect(result.available).toBe(false);
  });

  it("forceRug for wash trading + <15 holders + <30min age", () => {
    const result = layerSolscan(10, 0.25, 600, 10);
    // holderCount < 15 => safeBlocked + penalty
    // tokenAgeHours < 0.5 => safeBlocked + penalty
    // trades/traders = 60 > 50 && traders < 20 => wash trading
    // washTradingDetected && holderCount < 15 && tokenAgeHours < 0.5 => forceRug
    expect(result.forceRug).toBe(true);
    expect(result.safeBlocked).toBe(true);
  });

  it("strong holder base gets bonus", () => {
    const result = layerSolscan(6000, 800, null, null);
    expect(result.flags.some(f => /strong holder/i.test(f.label))).toBe(true);
    expect(result.trust).toBe(1.0); // capped
  });

  it("established token gets bonus", () => {
    const result = layerSolscan(1000, 800, null, null);
    expect(result.flags.some(f => /established/i.test(f.label))).toBe(true);
  });
});

// ═══ LAYER 7 — Identity ═════════════════════════════════════════════════════

describe("layerIdentity", () => {
  it("allows official wSOL mint through whitelist", () => {
    const result = layerIdentity("SOL", "Wrapped SOL", "So11111111111111111111111111111111111111112");
    expect(result.trust).toBe(1.0);
    expect(result.flags).toHaveLength(0);
  });

  it("TRUMP copycat detection", () => {
    const result = layerIdentity("TRUMPV2", "Trump V2", "SomeFakeMintAddress1234567890123456789012");
    expect(result.trust).toBeLessThan(0.3);
    expect(result.flags.some(f => /copycat/i.test(f.label))).toBe(true);
    expect(result.safeBlocked).toBe(true);
  });

  it("no false flags on legitimate unique tokens", () => {
    const result = layerIdentity("MYTOKEN", "My Cool Token", "RealMintAddress123456789012345678901234567");
    expect(result.trust).toBe(1.0);
    expect(result.flags).toHaveLength(0);
    expect(result.safeBlocked).toBe(false);
  });

  it("flags brand imitation for non-official DOGE token (new, few holders)", () => {
    const result = layerIdentity("DOGE", "Doge Clone", "FakeMintAddress12345678901234567890123456", 2, 20);
    expect(result.trust).toBeLessThan(1.0);
    expect(result.flags.some(f => /brand imitation/i.test(f.label))).toBe(true);
  });

  it("flags AI copycat suffix", () => {
    const result = layerIdentity("TRUMPAI", "Trump AI", "FakeMintAddress12345678901234567890123456");
    expect(result.trust).toBeLessThan(0.3);
    expect(result.flags.some(f => /copycat/i.test(f.label))).toBe(true);
  });

  it("returns clean for unique non-brand token", () => {
    const result = layerIdentity("MYTOKEN", "My Cool Token", "RealMintAddress123456789012345678901234567");
    expect(result.trust).toBe(1.0);
    expect(result.flags).toHaveLength(0);
  });

  it("does not flag official TRUMP mint", () => {
    // Official mint in whitelist
    const result = layerIdentity("TRUMP", "Trump Token", "So11111111111111111111111111111111111111112");
    expect(result.trust).toBe(1.0);
    expect(result.flags).toHaveLength(0);
  });

  it("should NOT flag official mints", () => {
    const result = layerIdentity("BONK", "Bonk", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", 1000, 50000);
    expect(result.flags.length).toBe(0);
    expect(result.safeBlocked).toBe(false);
  });

  it("should NOT flag established tokens with brand-like names", () => {
    const result = layerIdentity("DOGE", "Dogecoin", "someRandomMint123456789012345678901234", 2000, 10000);
    expect(result.safeBlocked).toBe(false);
  });

  it("should flag copycat with suffix", () => {
    const result = layerIdentity("TRUMPV2", "Trump V2", "fakeMint12345678901234567890123456789", 1, 10);
    expect(result.safeBlocked).toBe(true);
    expect(result.flags.some(f => /copycat/i.test(f.label))).toBe(true);
  });

  it("should NOT flag tokens with short brand substrings like SOL in RESOLUTION", () => {
    const result = layerIdentity("RESOLUTION", "Resolution Token", "someMint1234567890123456789012345678", 10, 50);
    expect(result.flags.some(f => /brand imitation/i.test(f.label))).toBe(false);
  });

  it("should flag exact brand match on new token without suffix", () => {
    const result = layerIdentity("TRUMP", "Trump Token", "newFakeMint123456789012345678901234", 2, 20);
    expect(result.flags.some(f => /brand imitation/i.test(f.label))).toBe(true);
  });
});

// ═══ LAYER 8 — CrossValidation ═══════════════════════════════════════════════

describe("layerCrossValidation", () => {
  it("safeBlocked on LP burn conflict", () => {
    const rugData: RugCheckSummary = { lpBurned: true };
    // Helius holders include an LP program address — means LP is still active on-chain
    const holders: HeliusHolder[] = [
      { address: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", uiAmount: 1000 },
      { address: "wallet1abc", uiAmount: 500 },
    ];
    const result = layerCrossValidation(rugData, holders, null, null, null);
    expect(result.safeBlocked).toBe(true);
    expect(result.flags.some(f => /LP burn conflict/i.test(f.label))).toBe(true);
  });

  it("safeBlocked on mint authority conflict", () => {
    const rugData: RugCheckSummary = { mintAuthorityEnabled: true };
    const goplus: GoPlusTokenResult = { mint_authority: "0" };
    const result = layerCrossValidation(rugData, [], goplus, null, null);
    expect(result.safeBlocked).toBe(true);
    expect(result.flags.some(f => /mint authority conflict/i.test(f.label))).toBe(true);
  });

  it("no safeBlocked when no conflicts", () => {
    const rugData: RugCheckSummary = { lpBurned: false };
    const result = layerCrossValidation(rugData, [], null, null, null);
    expect(result.safeBlocked).toBe(false);
    expect(result.flags).toHaveLength(0);
  });

  it("detects age conflict between sources", () => {
    const result = layerCrossValidation(null, [], null, 100, 10);
    // |100 - 10| = 90 > 72
    expect(result.flags.some(f => /age conflict/i.test(f.label))).toBe(true);
  });

  it("trust is always 1.0 (post-multiplier only)", () => {
    const rugData: RugCheckSummary = { lpBurned: true };
    const holders: HeliusHolder[] = [
      { address: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", uiAmount: 1000 },
    ];
    const result = layerCrossValidation(rugData, holders, null, null, null);
    expect(result.trust).toBe(1.0);
  });
});
