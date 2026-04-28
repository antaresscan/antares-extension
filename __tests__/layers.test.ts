import { describe, it, expect } from "vitest";
import {
  layerChart, layerDexScreener, layerGoPlus, layerRugCheck, layerHelius,
  layerSolscan, layerCrossValidation,
} from "../api/_lib/layers";
import type { DexScreenerPair, RugCheckSummary, GoPlusTokenResult, HeliusHolder } from "../api/_lib/types";

// ═══ LAYER 1 — DexScreener ══════════════════════════════════════════════════

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

  it("forceRug when vol/liq > 20", () => {
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

  it("forceRug when liq=0 and high volume (abandoned pool)", () => {
    const pair: DexScreenerPair = {
      liquidity: { usd: 0 },
      volume: { h24: 50000 },
      priceChange: {},
      txns: { m5: { buys: 1, sells: 1 } },
    };
    const result = layerDexScreener(pair, null, null);
    expect(result.forceRug).toBe(true);
    expect(result.safeBlocked).toBe(true);
    expect(result.flags.some(f => /abandoned pool/i.test(f.label))).toBe(true);
  });

  it("diminishing returns for multiple penalties", () => {
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

    // Fix(EXTREME_PUMP_24H): Extreme 24h pump detection
  it("Fix(EXTREME_PUMP_24H): pc24 > 5000 sets forceRug and safeBlocked", () => {
    const pair: DexScreenerPair = {
      liquidity: { usd: 50000 },
      volume: { h24: 100000 },
      priceChange: { h24: 6000, h1: 10, h6: 50, m5: 2 },
      txns: { m5: { buys: 10, sells: 8 } },
      info: {
        socials: [{ type: "twitter", url: "https://twitter.com/test" }],
        websites: [{ url: "https://test.com" }],
      },
    };
    const result = layerDexScreener(pair, 500000, 1440);
    expect(result.forceRug).toBe(true);
    expect(result.safeBlocked).toBe(true);
    expect(result.flags.some(f => /extreme 24h pump/i.test(f.label))).toBe(true);
  });

  it("Fix(EXTREME_PUMP_24H): pc24 > 1000 sets safeBlocked (not forceRug)", () => {
    const pair: DexScreenerPair = {
      liquidity: { usd: 50000 },
      volume: { h24: 100000 },
      priceChange: { h24: 2000, h1: 10, h6: 50, m5: 2 },
      txns: { m5: { buys: 10, sells: 8 } },
      info: {
        socials: [{ type: "twitter", url: "https://twitter.com/test" }],
        websites: [{ url: "https://test.com" }],
      },
    };
    const result = layerDexScreener(pair, 500000, 1440);
    expect(result.forceRug).toBe(false);
    expect(result.safeBlocked).toBe(true);
    expect(result.flags.some(f => /extreme 24h pump/i.test(f.label))).toBe(true);
  });

  it("Fix(EXTREME_PUMP_24H): pc24 > 500 on token <24h sets safeBlocked", () => {
    const pair: DexScreenerPair = {
      liquidity: { usd: 50000 },
      volume: { h24: 100000 },
      priceChange: { h24: 600, h1: 10, h6: 50, m5: 2 },
      txns: { m5: { buys: 10, sells: 8 } },
      info: {
        socials: [{ type: "twitter", url: "https://twitter.com/test" }],
        websites: [{ url: "https://test.com" }],
      },
    };
    const result = layerDexScreener(pair, 500000, 720);
    expect(result.safeBlocked).toBe(true);
    expect(result.flags.some(f => /large 24h pump/i.test(f.label))).toBe(true);
  });

  it("Fix(EXTREME_PUMP_24H): pc24 = 400 does NOT trigger extreme pump flag", () => {
    const pair: DexScreenerPair = {
      liquidity: { usd: 50000 },
      volume: { h24: 100000 },
      priceChange: { h24: 400, h1: 10, h6: 50, m5: 2 },
      txns: { m5: { buys: 10, sells: 8 } },
      info: {
        socials: [{ type: "twitter", url: "https://twitter.com/test" }],
        websites: [{ url: "https://test.com" }],
      },
    };
    const result = layerDexScreener(pair, 500000, 1440);
    expect(result.flags.some(f => /extreme 24h pump|large 24h pump/i.test(f.label))).toBe(false);
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
    expect(result.trust).toBeGreaterThan(0.95);
    expect(result.available).toBe(true);
    expect(result.forceRug).toBe(false);
    expect(result.safeBlocked).toBe(false);
  });

  it("metaMutable undefined does NOT penalize (fix: only penalize if explicitly true)", () => {
    const rugData: RugCheckSummary = { lpBurned: true };
    const result = layerRugCheck(rugData, null, "someMint123");
    expect(result.trust).toBeGreaterThan(0.95);
    expect(result.flags.some(f => /metadata mutable/i.test(f.label))).toBe(false);
  });

  it("metaMutable true penalizes", () => {
    const rugData: RugCheckSummary = { lpBurned: true, metaMutable: true };
    const result = layerRugCheck(rugData, null, "someMint123");
    expect(result.flags.some(f => /metadata mutable/i.test(f.label))).toBe(true);
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

  it("Fix(DECEPTIVE_NAME): 'Vanguard' in name triggers safeBlocked", () => {
    const rugData: RugCheckSummary = { lpBurned: true, metaMutable: false };
    const result = layerRugCheck(rugData, null, "mintABC", "Vanguard Digital Oil Reserve");
    expect(result.safeBlocked).toBe(true);
    expect(result.flags.some(f => /deceptive name/i.test(f.label))).toBe(true);
  });

  it("Fix(DECEPTIVE_NAME): 'BlackRock' in name triggers safeBlocked", () => {
    const rugData: RugCheckSummary = { lpBurned: true, metaMutable: false };
    const result = layerRugCheck(rugData, null, "mintABC", "BlackRock Treasury Token");
    expect(result.safeBlocked).toBe(true);
  });

  it("Fix(DECEPTIVE_NAME): non-deceptive name does NOT trigger", () => {
    const rugData: RugCheckSummary = { lpBurned: true, metaMutable: false };
    const result = layerRugCheck(rugData, null, "mintABC", "Bonk");
    expect(result.flags.some(f => /deceptive name/i.test(f.label))).toBe(false);
  });

  it("Fix(LP_SAFE_BLOCK): LP not burned or locked sets safeBlocked=true", () => {
    const rugData: RugCheckSummary = {
      lpBurned: false,
      lpLocked: false,
    };
    const result = layerRugCheck(rugData, null, "someMint123");
    expect(result.safeBlocked).toBe(true);
    expect(result.flags.some(f => /LP not burned or locked/i.test(f.label))).toBe(true);
  });
});

// ═══ LAYER 3 — GoPlus ═══════════════════════════════════════════════════════

describe("layerGoPlus", () => {
  it("returns unavailable for null", () => {
    const result = layerGoPlus(null);
    expect(result.available).toBe(false);
  });

  it("honeypot sets trust:0 AND safeBlocked:true", () => {
    const result = layerGoPlus({ is_honeypot: "1" });
    expect(result.trust).toBe(0);
    expect(result.forceRug).toBe(true);
    expect(result.safeBlocked).toBe(true);
  });

  it("cannot_sell_all sets safeBlocked", () => {
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

  it("Fix(TAX_WARNING): sell_tax '10' (=10%) is at boundary — triggers warning (>0.02 && <=0.10)", () => {
    // sell_tax='10' -> normalized to 0.10 -> 0.10 > 0.02 && 0.10 <= 0.10 → TRUE → warning flag present
    const goplus: GoPlusTokenResult = { sell_tax: "10", buy_tax: "0" };
    const result = layerGoPlus(goplus);
    expect(result.flags.some(f => /sell tax.*suspicious/i.test(f.label))).toBe(true);
  });

  it("Fix(TAX_WARNING): sell_tax '4.5' (VDOR-style) triggers warning flag", () => {
    const goplus: GoPlusTokenResult = { sell_tax: "4.5", buy_tax: "0" };
    const result = layerGoPlus(goplus);
    expect(result.flags.some(f => /sell tax.*suspicious/i.test(f.label))).toBe(true);
    expect(result.trust).toBeLessThan(1.0);
  });

  it("Fix(TAX_WARNING): sell_tax '0.15' (=15%) is hard flagged as > 10%", () => {
    const goplus: GoPlusTokenResult = { sell_tax: "0.15", buy_tax: "0" };
    const result = layerGoPlus(goplus);
    expect(result.flags.some(f => /sell tax > 10%/i.test(f.label))).toBe(true);
  });

  it("Fix(TAX_WARNING): sell_tax '11' (=11%) is hard flagged as > 10%", () => {
    const goplus: GoPlusTokenResult = { sell_tax: "11", buy_tax: "0" };
    const result = layerGoPlus(goplus);
    expect(result.flags.some(f => /sell tax > 10%/i.test(f.label))).toBe(true);
  });

  it("clean token (sell_tax=0, buy_tax=0) returns trust 1.0", () => {
    const goplus: GoPlusTokenResult = {
      is_honeypot: "0",
      cannot_sell_all: "0",
      mint_authority: "0",
      freeze_authority: "0",
      sell_tax: "0",
      buy_tax: "0",
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

  it("penalty for top holder > 50% (concentration hard block, NOT forceRug)", () => {
    // Top1 > 30% used to trigger forceRug → RUG slam, which over-
    // flagged legitimate blue-chip memecoins like MEW (164k holders +
    // LP burned + a 35% whale) as RUG. Now it sets safeBlocked +
    // hard concentration reason, letting Path 3 decide whether
    // blue-chip signals warrant CAUTION rather than RUG. forceRug
    // stays reserved for honeypot / deceptive-name patterns.
    const holders: HeliusHolder[] = [
      { address: "wallet1abc", owner: "wallet1abc", uiAmount: 600 },
      { address: "wallet2abc", owner: "wallet2abc", uiAmount: 100 },
      { address: "wallet3abc", owner: "wallet3abc", uiAmount: 100 },
      { address: "wallet4abc", owner: "wallet4abc", uiAmount: 100 },
      { address: "wallet5abc", owner: "wallet5abc", uiAmount: 100 },
    ];
    const result = layerHelius(holders, 1000);
    expect(result.trust).toBeLessThan(0.15);
    expect(result.forceRug).toBe(false);
    expect(result.safeBlocked).toBe(true);
  });

  it("foundation wallet detection — excludes foundation wallets from holder analysis", () => {
    const holders: HeliusHolder[] = [
      { address: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", owner: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", uiAmount: 500 },
      { address: "wallet1abc", owner: "wallet1abc", uiAmount: 50 },
      { address: "wallet2abc", owner: "wallet2abc", uiAmount: 50 },
      { address: "wallet3abc", owner: "wallet3abc", uiAmount: 50 },
      { address: "wallet4abc", owner: "wallet4abc", uiAmount: 50 },
      { address: "wallet5abc", owner: "wallet5abc", uiAmount: 50 },
      { address: "wallet6abc", owner: "wallet6abc", uiAmount: 50 },
      { address: "wallet7abc", owner: "wallet7abc", uiAmount: 50 },
      { address: "wallet8abc", owner: "wallet8abc", uiAmount: 50 },
      { address: "wallet9abc", owner: "wallet9abc", uiAmount: 50 },
      { address: "wallet10abc", owner: "wallet10abc", uiAmount: 50 },
    ];
    const result = layerHelius(holders, 1000);
    expect(result.trust).toBeGreaterThan(0.9);
    expect(result.forceRug).toBe(false);
  });

  it("well distributed supply gets bonus", () => {
    const holders: HeliusHolder[] = Array.from({ length: 20 }, (_, i) => ({
      address: `wallet${i}abc`,
      owner: `wallet${i}abc`,
      uiAmount: 50,
    }));
    const result = layerHelius(holders, 10000);
    expect(result.trust).toBe(1.0);
    expect(result.flags.some(f => /well distributed/i.test(f.label))).toBe(true);
  });

  it("mature dampening: 35% top-1 on 100k+ holders + LP burned + 30d gets trust ≥ 0.65", () => {
    // Reproduce MEW: top-1 35%, top-10 65%, mature memecoin profile.
    // Without dampening trust collapses to ~0.046 → DANGER score.
    // With dampening trust floored at 0.65 → SAFE-band score.
    const holders: HeliusHolder[] = [
      { address: "whale", owner: "whale", uiAmount: 35_000 },
      ...Array.from({ length: 9 }, (_, i) => ({
        address: `top${i+2}`, owner: `top${i+2}`, uiAmount: 3_300,
      })),
      ...Array.from({ length: 90 }, (_, i) => ({
        address: `r${i}`, owner: `r${i}`, uiAmount: 35,
      })),
    ];
    const ctx = {
      holders: 164_000,
      liquidity: 9_000_000,
      tokenAgeHours: 760 * 24,
      mintAuthority: false,
      freezeAuthority: false,
      honeypot: false,
      lpBurned: true,
    };
    const result = layerHelius(holders, 100_000, ctx);
    expect(result.trust).toBeGreaterThanOrEqual(0.65);
    // Concentration flag still emitted so reviewers see the whale.
    expect(result.flags.some(f => /35%/.test(f.label))).toBe(true);
    // safeBlocked still set so Path 3 / DAO allowlist can decide.
    expect(result.safeBlocked).toBe(true);
  });

  it("mature dampening: same profile WITHOUT lpBurned does not get the floor", () => {
    const holders: HeliusHolder[] = [
      { address: "whale", owner: "whale", uiAmount: 35_000 },
      ...Array.from({ length: 9 }, (_, i) => ({
        address: `top${i+2}`, owner: `top${i+2}`, uiAmount: 3_300,
      })),
      ...Array.from({ length: 90 }, (_, i) => ({
        address: `r${i}`, owner: `r${i}`, uiAmount: 35,
      })),
    ];
    const ctx = {
      holders: 164_000,
      liquidity: 9_000_000,
      tokenAgeHours: 760 * 24,
      mintAuthority: false, freezeAuthority: false, honeypot: false,
      lpBurned: false,  // ← mature but LP not burned, no floor
    };
    const result = layerHelius(holders, 100_000, ctx);
    expect(result.trust).toBeLessThan(0.2);  // back to vanilla penalty
  });

  it("data-quality fallback: <200 reported holders + $250k+ liq + 30d+ floors trust at 0.4", () => {
    // Reproduce GOAT/PNUT: solscan only sees 20 wallets but the pair is
    // mature with deep liquidity → holder data is broken, don't drag the
    // score on a broken signal.
    const holders: HeliusHolder[] = [
      { address: "lp-ata-misclassified", owner: "lp-ata-misclassified", uiAmount: 99_000 },
      { address: "tail", owner: "tail", uiAmount: 100 },
    ];
    const ctx = {
      holders: 20,           // broken — real GOAT/PNUT have 100k+
      liquidity: 1_000_000,
      tokenAgeHours: 350 * 24,
      mintAuthority: false, freezeAuthority: false, honeypot: false,
      lpBurned: null,        // unknown
    };
    const result = layerHelius(holders, 100_000, ctx);
    expect(result.trust).toBeGreaterThanOrEqual(0.4);
    expect(result.flags.some(f => /Holder data unreliable/i.test(f.label))).toBe(true);
    // Misleading concentration flags are stripped — broken upstream
    // view shouldn't masquerade as a 99% whale.
    expect(result.flags.some(f => /supply/i.test(f.label))).toBe(false);
    // safeBlocked cleared because we don't trust the broken signal.
    expect(result.safeBlocked).toBe(false);
  });

  it("data-quality fallback does NOT trigger on real fresh-launch DANGER", () => {
    // 30 holders, $30k liq, 1 day old — real fresh-launch danger profile.
    // We must NOT dampen trust here.
    const holders: HeliusHolder[] = [
      { address: "whale", owner: "whale", uiAmount: 80_000 },
      ...Array.from({ length: 9 }, (_, i) => ({
        address: `t${i}`, owner: `t${i}`, uiAmount: 1_500,
      })),
    ];
    const ctx = {
      holders: 30,
      liquidity: 30_000,    // thin
      tokenAgeHours: 24,    // fresh
      mintAuthority: false, freezeAuthority: false, honeypot: false,
      lpBurned: null,
    };
    const result = layerHelius(holders, 100_000, ctx);
    expect(result.trust).toBeLessThan(0.2);
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
    expect(result.forceRug).toBe(true);
    expect(result.safeBlocked).toBe(true);
  });

  it("strong holder base gets bonus", () => {
    const result = layerSolscan(6000, 800, null, null);
    expect(result.flags.some(f => /strong holder/i.test(f.label))).toBe(true);
    expect(result.trust).toBe(1.0);
  });

  it("established token gets bonus", () => {
    const result = layerSolscan(1000, 800, null, null);
    expect(result.flags.some(f => /established/i.test(f.label))).toBe(true);
  });
});

// ═══ LAYER 7 (formerly 8) — CrossValidation ═════════════════════════════════

describe("layerCrossValidation", () => {
  it("safeBlocked on LP burn conflict", () => {
    const rugData: RugCheckSummary = { lpBurned: true };
    const holders: HeliusHolder[] = [
      { address: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", owner: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", uiAmount: 1000 },
      { address: "wallet1abc", owner: "wallet1abc", uiAmount: 500 },
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
    expect(result.flags.some(f => /age conflict/i.test(f.label))).toBe(true);
  });

  it("trust is always 1.0 (post-multiplier only)", () => {
    const rugData: RugCheckSummary = { lpBurned: true };
    const holders: HeliusHolder[] = [
      { address: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", owner: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", uiAmount: 1000 },
    ];
    const result = layerCrossValidation(rugData, holders, null, null, null);
    expect(result.trust).toBe(1.0);
  });
});


describe("layerChart", () => {
  const mkCandle = (o: number, h: number, l: number, c: number, v: number) => ({
    ts: Date.now(), o, h, l, c, v,
  });

  it("returns unavailable when candles array is empty", () => {
    const r = layerChart([], null, null);
    expect(r.available).toBe(false);
    expect(r.source).toBe("chart");
  });

  it("returns unavailable when fewer than 5 candles", () => {
    const candles = [mkCandle(1,2,0.5,1.5,100), mkCandle(1.5,2,1,1.8,200)];
    const r = layerChart(candles, null, null);
    expect(r.available).toBe(false);
  });

  it("returns high trust for stable healthy chart", () => {
    const candles = Array.from({length: 20}, (_, i) => {
      const base = 1 + i * 0.01;
      return mkCandle(base, base + 0.02, base - 0.01, base + 0.005, 1000 + i * 10);
    });
    const r = layerChart(candles, null, 1440);
    expect(r.available).toBe(true);
    expect(r.trust).toBeGreaterThanOrEqual(0);
  });

  it("detects parabolic pump pattern (>500% run-up)", () => {
    const candles = Array.from({length: 20}, (_, i) => {
      const price = 1 * Math.pow(1.15, i);
      return mkCandle(price * 0.95, price * 1.05, price * 0.9, price, 5000);
    });
    const r = layerChart(candles, null, 60);
    expect(r.available).toBe(true);
    expect(r.trust).toBeLessThan(100);
  });

  it("detects post-ATH dump pattern", () => {
    const up = Array.from({length: 10}, (_, i) => {
      const price = 1 + i * 0.5;
      return mkCandle(price - 0.2, price + 0.1, price - 0.3, price, 2000);
    });
    const peak = up[up.length - 1].c;
    const down = Array.from({length: 6}, (_, i) => {
      const price = peak * (1 - (i + 1) * 0.12);
      return mkCandle(price + 0.1, price + 0.2, price - 0.1, price, 3000);
    });
    const candles = [...up, ...down];
    const r = layerChart(candles, null, 120);
    expect(r.available).toBe(true);
    expect(r.trust).toBeLessThan(70);
  });

  it("detects wash trading (low volume variance)", () => {
    const candles = Array.from({length: 20}, () => {
      return mkCandle(1.0, 1.01, 0.99, 1.0, 100);
    });
    const r = layerChart(candles, null, 1440);
    expect(r.available).toBe(true);
  });

  it("handles pair liquidity data", () => {
    const candles = Array.from({length: 20}, (_, i) => {
      const base = 1 + i * 0.01;
      return mkCandle(base, base + 0.02, base - 0.01, base + 0.005, 1000);
    });
    const pair = { liquidity: { usd: 500 }, fdv: 100000 } as unknown as Parameters<typeof layerChart>[1];
    const r = layerChart(candles, pair, 1440);
    expect(r.available).toBe(true);
    expect(r.source).toBe("chart");
  });

  it("detects blow-off top with high green ratio", () => {
    const candles = Array.from({length: 20}, (_, i) => {
      const price = 1 + i * 0.3;
      return mkCandle(price - 0.1, price + 0.5, price - 0.2, price + 0.2, 10000);
    });
    const r = layerChart(candles, null, 30);
    expect(r.available).toBe(true);
  });
});
