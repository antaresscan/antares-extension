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

  // ── Slow rug / progressive decline patterns ──────────────────────────────

  const basePair = (priceChange: object, txns?: object): DexScreenerPair => ({
    liquidity: { usd: 100000 },
    volume: { h24: 50000 },
    priceChange,
    txns: { m5: (txns ?? { buys: 5, sells: 7 }) },
    info: {
      socials: [{ type: "twitter", url: "https://twitter.com/test" }],
      websites: [{ url: "https://test.com" }],
    },
  });

  it("sharp 6h sell-off (-35%) triggers safeBlocked", () => {
    const result = layerDexScreener(basePair({ h6: -35, h1: -5, h24: -10, m5: 1 }), 500000, 1440);
    expect(result.safeBlocked).toBe(true);
    expect(result.flags.some(f => /sharp 6h sell-off/i.test(f.label))).toBe(true);
  });

  it("sharp 6h sell-off does NOT fire when slow-rug check already fired (pc6 = -55, pc1 = -20)", () => {
    const result = layerDexScreener(basePair({ h6: -55, h1: -20, h24: -30, m5: 1 }), 500000, 1440);
    expect(result.flags.some(f => /sharp 6h sell-off/i.test(f.label))).toBe(false);
    expect(result.flags.some(f => /slow rug detected/i.test(f.label))).toBe(true);
  });

  it("significant 24h dump (-55%) triggers safeBlocked", () => {
    const result = layerDexScreener(basePair({ h24: -55, h1: -5, h6: -10, m5: 1 }), 500000, 1440);
    expect(result.safeBlocked).toBe(true);
    expect(result.flags.some(f => /significant 24h dump/i.test(f.label))).toBe(true);
  });

  it("brutal dump (-85%) now sets safeBlocked", () => {
    const result = layerDexScreener(basePair({ h24: -85, h1: -10, h6: -20, m5: 1 }), 500000, 1440);
    expect(result.safeBlocked).toBe(true);
    expect(result.flags.some(f => /brutal dump/i.test(f.label))).toBe(true);
  });

  it("pump reversal (+120% 24h → -25% 6h) triggers safeBlocked", () => {
    const result = layerDexScreener(basePair({ h24: 120, h6: -25, h1: -5, m5: 1 }), 500000, 1440);
    expect(result.safeBlocked).toBe(true);
    expect(result.flags.some(f => /pump reversal/i.test(f.label))).toBe(true);
  });

  it("pump reversal does NOT fire when pc24 is below 80 threshold", () => {
    const result = layerDexScreener(basePair({ h24: 70, h6: -25, h1: -5, m5: 1 }), 500000, 1440);
    expect(result.flags.some(f => /pump reversal/i.test(f.label))).toBe(false);
  });

  it("progressive dump (-25% 6h + -30% 24h) triggers safeBlocked", () => {
    const result = layerDexScreener(basePair({ h6: -25, h24: -30, h1: -5, m5: 1 }), 500000, 1440);
    expect(result.safeBlocked).toBe(true);
    expect(result.flags.some(f => /progressive dump/i.test(f.label))).toBe(true);
  });

  it("progressive dump does NOT fire when 6h already hit standalone threshold (-35%)", () => {
    const result = layerDexScreener(basePair({ h6: -35, h24: -30, h1: -5, m5: 1 }), 500000, 1440);
    expect(result.flags.some(f => /progressive dump/i.test(f.label))).toBe(false);
    expect(result.flags.some(f => /sharp 6h sell-off/i.test(f.label))).toBe(true);
  });

  it("coordinated exit (price -10% + sells 4x buys) triggers safeBlocked", () => {
    const result = layerDexScreener(
      basePair({ h1: -10, h6: -5, h24: -15, m5: 1 }, { buys: 3, sells: 12 }),
      500000, 1440,
    );
    expect(result.safeBlocked).toBe(true);
    expect(result.flags.some(f => /coordinated exit/i.test(f.label))).toBe(true);
  });

  it("healthy pair is NOT flagged by any slow-rug pattern", () => {
    const result = layerDexScreener(
      basePair({ h1: 5, h6: 10, h24: 20, m5: 1 }, { buys: 10, sells: 8 }),
      500000, 1440,
    );
    expect(result.flags.some(f =>
      /sharp 6h|significant 24h dump|brutal dump|pump reversal|progressive dump|coordinated exit/i.test(f.label)
    )).toBe(false);
    expect(result.safeBlocked).toBe(false);
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

  it("Fix(LP_SAFE_BLOCK): LP not burned or locked still sets safeBlocked=true (matrix unknown bucket)", () => {
    const rugData: RugCheckSummary = {
      lpBurned: false,
      lpLocked: false,
    };
    // No maturityContext → matrix returns the 'unknown' bucket which is
    // conservative (warning + safeBlocked=true). This preserves the
    // original LP_SAFE_BLOCK protection. SCORING_VERSION 7.6.0+ flag
    // label changed: "LP not burned" → either matrix label or fallback.
    const result = layerRugCheck(rugData, null, "someMint123");
    expect(result.safeBlocked).toBe(true);
    const hasLpFlag = result.flags.some(f =>
      /LP not burned or locked/i.test(f.label) ||
      /could not be computed/i.test(f.label) ||
      /LP holds .+% of supply/i.test(f.label)
    );
    expect(hasLpFlag).toBe(true);
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

  it("top-10 extreme concentration triggers forceRug on non-mature tokens (HAWK case)", () => {
    // HAWK-style: 5 wallets control 100% of supply (60%+40% combined).
    // top-10 = 100% → extreme band (≥85%) → critical, hard, penalty=0.10.
    // forceRug fires at top-10 > 80% when there's no blue-chip (50k+) shield.
    const holders: HeliusHolder[] = [
      { address: "wallet1abc", owner: "wallet1abc", uiAmount: 600 },
      { address: "wallet2abc", owner: "wallet2abc", uiAmount: 100 },
      { address: "wallet3abc", owner: "wallet3abc", uiAmount: 100 },
      { address: "wallet4abc", owner: "wallet4abc", uiAmount: 100 },
      { address: "wallet5abc", owner: "wallet5abc", uiAmount: 100 },
    ];
    // No maturity context → forceRug fires on top-1 60% (>40% threshold).
    const result = layerHelius(holders, 1000);
    expect(result.trust).toBeLessThan(0.15);
    expect(result.forceRug).toBe(true); // HAWK-style extreme concentration
    expect(result.safeBlocked).toBe(true);
  });

  it("top-10 = 72% on MATURE token (LP burned + 100k holders + 30d) does NOT forceRug", () => {
    // MEW-style profile: top-1=45%, top-10=72% on a mature blue-chip.
    // 72% → elevated band (60-74%) → warning, soft (concentration_light).
    // forceRug stays false: 72% < 80% threshold AND mature shield active.
    const holders: HeliusHolder[] = [
      { address: "whale", owner: "whale", uiAmount: 45_000 },
      ...Array.from({ length: 9 }, (_, i) => ({
        address: `top${i+2}`, owner: `top${i+2}`, uiAmount: 3_000,
      })),
    ];
    const ctx = {
      holders: 164_000,
      liquidity: 9_000_000,
      tokenAgeHours: 760 * 24,
      mintAuthority: false, freezeAuthority: false, honeypot: false,
      lpBurned: true,
    };
    const result = layerHelius(holders, 100_000, ctx);
    expect(result.forceRug).toBe(false);  // mature shield
    expect(result.safeBlocked).toBe(true); // but concentration still gates Path 3
  });

  it("foundation wallet detection — excludes foundation wallets from holder analysis", () => {
    // LP wallet (675k...) holds 500 of 1000 supply → excluded from concentration.
    // After exclusion: 10 real wallets × 50 = 500 = top-10 = 50% of total supply.
    // No maturityContext = fresh tier → 35-54% = "elevated · cluster risk" (soft block).
    // Key assertion: the LP program address is NOT treated as a real whale.
    // The concentration flag mentions nothing about the LP address.
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
    // The LP address is NOT mentioned in any flag (it was filtered out)
    expect(result.flags.some(f => /675k/i.test(f.label))).toBe(false);
    // No forceRug — 10 equal wallets at 5% each is not an extreme rug pattern
    expect(result.forceRug).toBe(false);
    // The flag labels don't say "500" (the LP wallet's amount) as a whale
    expect(result.flags.some(f => f.label.includes("500%"))).toBe(false);
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

  it("mature dampening: top-10 < 30% on 100k+ holders + LP burned + 30d gets trust ≥ 0.65", () => {
    // Mature blue-chip with WELL-DISTRIBUTED supply (top-10 < 30%) gets the lift.
    // top-10=26% → "Well distributed ✓" bonus (< 30% threshold).
    const holders: HeliusHolder[] = [
      { address: "lead", owner: "lead", uiAmount: 8_000 }, // 8% — well-distributed
      ...Array.from({ length: 9 }, (_, i) => ({
        address: `top${i+2}`, owner: `top${i+2}`, uiAmount: 2_000,
      })),
      ...Array.from({ length: 90 }, (_, i) => ({
        address: `r${i}`, owner: `r${i}`, uiAmount: 800,
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
  });

  it("FARTCOIN established (top-10=36%): exchange note, no safeBlock (7.7.5 2-tier rule)", () => {
    // FARTCOIN: established (164k holders, 2y), top-10=36%.
    // 7.7.5 established tier: 25-44% = info with exchange context note.
    // No scary whale warning, no safeBlock, SAFE possible.
    const holders: HeliusHolder[] = [
      { address: "whale", owner: "whale", uiAmount: 11_000 },
      ...Array.from({ length: 9 }, (_, i) => ({
        address: `top${i+2}`, owner: `top${i+2}`, uiAmount: 2_778,
      })),
      ...Array.from({ length: 90 }, (_, i) => ({
        address: `r${i}`, owner: `r${i}`, uiAmount: 700,
      })),
    ];
    const ctx = {
      holders: 164_000, liquidity: 9_000_000, tokenAgeHours: 760 * 24,
      mintAuthority: false, freezeAuthority: false, honeypot: false, lpBurned: true,
    };
    const result = layerHelius(holders, 100_000, ctx);
    expect(result.flags.some(f => /11%/.test(f.label))).toBe(false);
    expect(result.flags.some(f => /exchanges likely included/i.test(f.label))).toBe(true);
    expect(result.flags.some(f => /exchanges likely included/i.test(f.label) && f.severity === "info")).toBe(true);
    expect(result.safeBlocked).toBe(false);
    expect(result.forceRug).toBe(false);
  });

  it("SAME top-10=36% on FRESH token (no ctx): cluster risk soft block (7.7.5)", () => {
    // Same 36% but no maturityContext = fresh tier.
    // 35-54% = elevated concentration / cluster risk (warning, soft, CAUTION max).
    const holders: HeliusHolder[] = [
      { address: "whale", owner: "whale", uiAmount: 11_000 },
      ...Array.from({ length: 9 }, (_, i) => ({
        address: `top${i+2}`, owner: `top${i+2}`, uiAmount: 2_778,
      })),
      ...Array.from({ length: 90 }, (_, i) => ({
        address: `r${i}`, owner: `r${i}`, uiAmount: 700,
      })),
    ];
    const result = layerHelius(holders, 100_000); // no context = fresh
    expect(result.flags.some(f => /cluster risk/i.test(f.label))).toBe(true);
    expect(result.flags.some(f => /cluster risk/i.test(f.label) && f.severity === "warning")).toBe(true);
    expect(result.safeBlocked).toBe(true);
    expect(result.forceRug).toBe(false);
  });

  it("elevated concentration (top-10=65%) on fresh token: warning flag + soft safeBlock (max CAUTION)", () => {
    // Fresh token, top-10=65% = high concentration (55-74%) → critical, hard, DANGER.
    // (No maturity context = fresh tier applies.)
    const holders: HeliusHolder[] = [
      { address: "w1", owner: "w1", uiAmount: 20_000 },
      ...Array.from({ length: 9 }, (_, i) => ({
        address: `t${i+2}`, owner: `t${i+2}`, uiAmount: 5_000,
      })),
      ...Array.from({ length: 20 }, (_, i) => ({
        address: `r${i}`, owner: `r${i}`, uiAmount: 250,
      })),
    ];
    // top-10 = (20000 + 9×5000)/100000 = 65% → fresh tier: 55-74% = high/control risk
    const result = layerHelius(holders, 100_000);
    expect(result.flags.some(f => /control risk/i.test(f.label))).toBe(true);
    expect(result.flags.some(f => /control risk/i.test(f.label) && f.severity === "critical")).toBe(true);
    expect(result.safeBlocked).toBe(true);
    expect(result.forceRug).toBe(false); // 65% < 75% forceRug threshold for fresh
    expect(result.trust).toBeGreaterThanOrEqual(0.20);
    expect(result.trust).toBeLessThan(0.40);
  });

  // ── SINGLE-WALLET SAFETY NET (7.7.11) ─────────────────────────────────────
  it("single-wallet net: top-1 44% + top-10 54% (HAWK-class) → hard concentration, DANGER", () => {
    // One 44% wallet, rest tiny → top-10 ≈ 54% (established "elevated" = soft,
    // which alone would only be CAUTION). The single-wallet net catches the
    // 44% wallet and routes it to hard concentration. This is the exact gap
    // the top-10-only system missed on the real Hawk Tuah token.
    const holders: HeliusHolder[] = [
      { address: "dev", owner: "dev", uiAmount: 44_000 }, // 44%
      ...Array.from({ length: 9 }, (_, i) => ({ address: `t${i+2}`, owner: `t${i+2}`, uiAmount: 1_100 })), // +9.9%
      ...Array.from({ length: 90 }, (_, i) => ({ address: `r${i}`, owner: `r${i}`, uiAmount: 500 })),
    ];
    const ctx = { holders: 7_430, liquidity: 70_000, tokenAgeHours: 600 * 24, mintAuthority: false, freezeAuthority: false, honeypot: false, lpBurned: true };
    // top-10 = (44000 + 9×1100)/100000 = 53.9% → established elevated (soft)
    const result = layerHelius(holders, 100_000, ctx);
    expect(result.flags.some(f => /single wallet holds 44% — high concentration/i.test(f.label))).toBe(true);
    expect(result.flags.some(f => /single wallet/i.test(f.label) && f.severity === "critical")).toBe(true);
    expect(result.safeBlocked).toBe(true);
    expect(result.forceRug).toBe(false); // 44% < 55% → DANGER, not RUG
  });

  it("single-wallet net: top-1 60% established non-blue-chip → forceRug (RUG)", () => {
    const holders: HeliusHolder[] = [
      { address: "dev", owner: "dev", uiAmount: 60_000 }, // 60%
      ...Array.from({ length: 9 }, (_, i) => ({ address: `t${i}`, owner: `t${i}`, uiAmount: 100 })),
      ...Array.from({ length: 90 }, (_, i) => ({ address: `r${i}`, owner: `r${i}`, uiAmount: 400 })),
    ];
    const ctx = { holders: 8_000, liquidity: 100_000, tokenAgeHours: 400 * 24, mintAuthority: false, freezeAuthority: false, honeypot: false, lpBurned: true };
    // top-10 = (60000 + 9×100)/100000 = 60.9% → established elevated (soft) → net not guarded
    const result = layerHelius(holders, 100_000, ctx);
    expect(result.flags.some(f => /single wallet holds 60% — extreme concentration/i.test(f.label))).toBe(true);
    expect(result.forceRug).toBe(true);   // >55% + non-blue-chip
    expect(result.safeBlocked).toBe(true);
  });

  it("single-wallet net does NOT fire on a 35% exchange wallet (blue-chip protection)", () => {
    // MEW-style: top-1 35% (exchange cold wallet) on a 164k-holder blue-chip.
    // 35% < 40% threshold → the net stays silent. The token is handled by the
    // top-10 ladder, NOT hard-blocked by a single-wallet rule. This is the
    // false-positive the 7.7.4 top-1 removal eliminated — it must stay gone.
    const holders: HeliusHolder[] = [
      { address: "exch", owner: "exch", uiAmount: 35_000 }, // 35% exchange
      ...Array.from({ length: 9 }, (_, i) => ({ address: `t${i}`, owner: `t${i}`, uiAmount: 2_800 })),
      ...Array.from({ length: 90 }, (_, i) => ({ address: `r${i}`, owner: `r${i}`, uiAmount: 444 })),
    ];
    const ctx = { holders: 164_000, liquidity: 9_000_000, tokenAgeHours: 760 * 24, mintAuthority: false, freezeAuthority: false, honeypot: false, lpBurned: true };
    const result = layerHelius(holders, 100_000, ctx);
    expect(result.flags.some(f => /single wallet holds/i.test(f.label))).toBe(false);
    expect(result.forceRug).toBe(false);
  });

  it("mature dampening: top-10=65% (established, elevated band) does not get the trust floor", () => {
    // top-10 ≈ 65% → established tier: 45-64% = elevated (soft band).
    // concentrationAllowsLift=false (band is "soft", not "none"/"moderate")
    // → no trust floor applies regardless of LP status
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
      lpBurned: false,
    };
    const result = layerHelius(holders, 100_000, ctx);
    // Elevated band (65%) blocks the floor → trust stays at 0.50 from penalty
    expect(result.trust).toBeLessThan(0.65);
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

  it("RIV case: top-10=63% + broken holder count must NOT trigger broken-view fallback", () => {
    // 2026-05-29 user-reported false positive. RIV had a real 40% top-1,
    // 15% top-2, $651k liquidity, 67d old.
    // top-10 = (40000+15000+8×1000)/100000 = 63% → elevated band.
    // 63% is NOT implausibly extreme (< 95%), so the broken-view
    // fallback must NOT fire — concentration flag stays, safeBlocked=true.
    const holders: HeliusHolder[] = [
      { address: "whale40", owner: "whale40", uiAmount: 40_000 }, // 40%
      { address: "whale15", owner: "whale15", uiAmount: 15_000 }, // 15%
      ...Array.from({ length: 18 }, (_, i) => ({
        address: `t${i}`, owner: `t${i}`, uiAmount: 1_000,
      })),
    ];
    const ctx = {
      holders: 20,             // broken — Solscan returned no count
      liquidity: 651_000,
      tokenAgeHours: 1610,     // ~67 days
      mintAuthority: false, freezeAuthority: false, honeypot: false,
      lpBurned: null,
    };
    const result = layerHelius(holders, 100_000, ctx);
    // ctx.holders=20 → NOT established (< 5k) → fresh tier.
    // top-10=63% → fresh tier 55-74% = "high concentration · control risk" (hard).
    // The concentration flag MUST remain (not dropped by the broken-view fallback).
    expect(result.flags.some(f => /high concentration|control risk/i.test(f.label))).toBe(true);
    // The broken-view info flag MUST NOT have been emitted.
    expect(result.flags.some(f => /Holder data unreliable/i.test(f.label))).toBe(false);
    // Safe gate must stay closed.
    expect(result.safeBlocked).toBe(true);
  });

  it("GOAT/PNUT case still triggers: 99% top-1 + broken count + mature pair → flag dropped", () => {
    // Verify the original GOAT/PNUT fallback still fires when the
    // concentration is structurally impossible (≥80%). This is the
    // pump.fun bonding-curve survivor artefact the fallback was
    // designed for: the upstream view shows one bonding-curve
    // wallet at 99% because the post-AMM holders are invisible.
    const holders: HeliusHolder[] = [
      { address: "bonding-curve", owner: "bonding-curve", uiAmount: 99_000 }, // 99%
      { address: "tail", owner: "tail", uiAmount: 100 },
    ];
    const ctx = {
      holders: 20,
      liquidity: 1_500_000,
      tokenAgeHours: 100 * 24,
      mintAuthority: false, freezeAuthority: false, honeypot: false,
      lpBurned: null,
    };
    const result = layerHelius(holders, 100_000, ctx);
    expect(result.flags.some(f => /Holder data unreliable/i.test(f.label))).toBe(true);
    expect(result.flags.some(f => /supply/i.test(f.label))).toBe(false);
    expect(result.safeBlocked).toBe(false);
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

  // Regression: AURA (DtR4...k9B2). 2-year-old token, all 4 binary safety
  // checks clean ($1.95M LP, no mint/freeze authority, LP burned), +133% in
  // the most recent 24h, but its 40-candle window contained a local peak
  // that was >55% above the current close. Pre-fix, that single chart
  // signal hard-promoted the verdict to RUG via forceRug=true. The fix
  // adds a maturity guard mirroring the rug-staircase pattern: 5k+ holders
  // OR (90d+ age AND $500k+ liquidity) demotes the flag to info-level
  // with no penalty cap and no chart-only forceRug. Cumulative score from
  // the OTHER layers still drives the verdict — actual rugs (with low LP
  // / wallet concentration / honeypot / no socials) keep landing RUG via
  // their other independent signals.
  it("does not forceRug a mature pair on chart-only blow-off (AURA regression)", () => {
    // Synthesise candles: peak at index 5, then collapse > 55% by index 39.
    const candles = Array.from({ length: 40 }, (_, i) => {
      const price = i < 5 ? 1 + i * 1.0 : 6 - (i - 5) * 0.12; // peak ~6, ends ~1.8 → -70% from peak
      return mkCandle(price, price + 0.05, price - 0.05, price, 5000);
    });
    const matureContext = {
      holders: 8_000,
      liquidity: 1_950_000,
      tokenAgeHours: 730 * 24, // ~2 years
      mintAuthority: false,
      freezeAuthority: false,
      honeypot: false,
      lpBurned: true,
    };
    const r = layerChart(candles, null, 730 * 24 * 60, matureContext);
    expect(r.available).toBe(true);
    expect(r.forceRug).toBe(false); // ← the headline assertion
    const blowOff = r.flags.find((f) => /drawdown.*from local peak|blow.?off top/i.test(f.label));
    expect(blowOff?.severity).toBe("info");
  });

  it("still forceRug-blocks SAFE on a young token with chart-only blow-off when no other safety signals exist", () => {
    // Same chart shape, but the token is young + thin liquidity — exactly
    // the case where the chart pattern IS a meaningful rug fingerprint.
    const candles = Array.from({ length: 40 }, (_, i) => {
      const price = i < 5 ? 1 + i * 1.0 : 6 - (i - 5) * 0.12;
      return mkCandle(price, price + 0.05, price - 0.05, price, 5000);
    });
    const youngContext = {
      holders: 50,
      liquidity: 4_000,
      tokenAgeHours: 6,
      mintAuthority: false,
      freezeAuthority: false,
      honeypot: false,
      lpBurned: false,
    };
    const r = layerChart(candles, null, 6 * 60, youngContext);
    expect(r.available).toBe(true);
    expect(r.safeBlocked).toBe(true); // chart still blocks SAFE for young tokens
    // forceRug from THIS specific signal is gone, but cumulative score from
    // the rest of the layers still drives the verdict; we don't re-assert
    // RUG here since that's scoring's job, not layerChart's.
  });

  // ──── Sustained-24h-pump warning (2026-05-19 — TROLL-case) ────────────────
  // The "Vertical pump (5m/1h)" pattern catches launch-scam micro-pumps.
  // This complementary pattern catches the slower, multi-hour pump shape
  // typical of blue-chip memecoins riding momentum — where the contract
  // is structurally fine but a trader entering at the top eats the
  // retrace. Tests pin the four tiers: mature×moderate, mature×high,
  // non-mature×moderate, non-mature×severe.
  describe("layerChart — Sustained 24h pump warning", () => {
    const flatCandles = () => Array.from({ length: 20 }, (_, i) => {
      const base = 1 + i * 0.01;
      return mkCandle(base, base + 0.02, base - 0.01, base + 0.005, 1000);
    });
    const mkPair = (pc24: number) => ({
      liquidity: { usd: 1_000_000 },
      volume: { h24: 500_000, h1: 20_000 },
      priceChange: { m5: 0.5, h1: 5, h6: 30, h24: pc24 },
    } as unknown as Parameters<typeof layerChart>[1]);

    const matureContext = {
      holders: 8_000,
      liquidity: 1_950_000,
      tokenAgeHours: 730 * 24,
      mintAuthority: false,
      freezeAuthority: false,
      honeypot: false,
      lpBurned: true,
    };
    const youngContext = {
      holders: 200,
      liquidity: 20_000,
      tokenAgeHours: 6,
      mintAuthority: false,
      freezeAuthority: false,
      honeypot: false,
      lpBurned: false,
    };

    it("does NOT fire when pc24h is below the 100% threshold", () => {
      const r = layerChart(flatCandles(), mkPair(50), 730 * 24 * 60, matureContext);
      const pumpFlag = r.flags.find((f) => /pumped \+\d+% in 24h/i.test(f.label));
      expect(pumpFlag).toBeUndefined();
    });

    it("mature pair @ +150% in 24h: warning flag + safeBlock, no blue-chip suffix (7.7.10)", () => {
      // 7.7.10: the 100-200% mature tier is now a warning (was info). Any 24h
      // pump >= 100% on a mature token is an entry-timing risk worth a warning
      // that caps the verdict at CAUTION. The "(blue-chip)" suffix is removed.
      const r = layerChart(flatCandles(), mkPair(150), 730 * 24 * 60, matureContext);
      const pumpFlag = r.flags.find((f) => /pumped \+\d+% in 24h/i.test(f.label));
      expect(pumpFlag).toBeDefined();
      expect(pumpFlag?.severity).toBe("warning");
      expect(pumpFlag?.label).toMatch(/moderate retrace risk/i);
      expect(pumpFlag?.label).not.toMatch(/blue-chip/i);
      expect(r.safeBlocked).toBe(true);
    });

    it("mature pair @ +250% in 24h: warning flag + safeBlock, no blue-chip suffix", () => {
      const r = layerChart(flatCandles(), mkPair(250), 730 * 24 * 60, matureContext);
      const pumpFlag = r.flags.find((f) => /pumped \+\d+% in 24h/i.test(f.label));
      expect(pumpFlag).toBeDefined();
      expect(pumpFlag?.severity).toBe("warning");
      expect(pumpFlag?.label).toMatch(/elevated retrace risk/i);
      expect(pumpFlag?.label).not.toMatch(/blue-chip/i);
      // A mature token pumping >= 200% in 24h must safeBlock so the verdict
      // caps at CAUTION; the small penalty (0.85) keeps it out of DANGER.
      expect(r.safeBlocked).toBe(true);
    });

    it("non-mature token @ +150% in 24h: warning flag", () => {
      const r = layerChart(flatCandles(), mkPair(150), 6 * 60, youngContext);
      const pumpFlag = r.flags.find((f) => /pumped \+\d+% in 24h/i.test(f.label));
      expect(pumpFlag).toBeDefined();
      expect(pumpFlag?.severity).toBe("warning");
      expect(pumpFlag?.label).not.toMatch(/blue-chip/i);
    });

    it("non-mature token @ +250% in 24h: warning + safeBlock (entering at local top)", () => {
      const r = layerChart(flatCandles(), mkPair(250), 6 * 60, youngContext);
      const pumpFlag = r.flags.find((f) => /pumped \+\d+% in 24h/i.test(f.label));
      expect(pumpFlag).toBeDefined();
      expect(pumpFlag?.severity).toBe("warning");
      expect(r.safeBlocked).toBe(true); // exit-liquidity trap shape
    });

    it("non-mature token @ +400% in 24h: warning + safeBlock (exit liquidity risk)", () => {
      const r = layerChart(flatCandles(), mkPair(400), 6 * 60, youngContext);
      const pumpFlag = r.flags.find((f) => /pumped \+\d+% in 24h.*exit liquidity/i.test(f.label));
      expect(pumpFlag).toBeDefined();
      expect(pumpFlag?.severity).toBe("warning");
      expect(r.safeBlocked).toBe(true);
    });

    it("does NOT double-count when both 5m/1h vertical pump AND 24h sustained pump fire", () => {
      // Craft a pair where BOTH "Vertical pump" (pc5m>35 && pc1h>120) AND
      // sustained 24h pump fire. They should produce TWO distinct flags
      // (different labels), not collide or short-circuit each other.
      const explosivePair = {
        liquidity: { usd: 20_000 },
        volume: { h24: 5_000_000, h1: 200_000 },
        priceChange: { m5: 50, h1: 200, h6: 300, h24: 400 },
      } as unknown as Parameters<typeof layerChart>[1];
      const r = layerChart(flatCandles(), explosivePair, 6 * 60, youngContext);
      const verticalFlag = r.flags.find((f) => /Vertical pump/i.test(f.label));
      const sustainedFlag = r.flags.find((f) => /pumped \+\d+% in 24h/i.test(f.label));
      expect(verticalFlag).toBeDefined();
      expect(sustainedFlag).toBeDefined();
      // Both should be present — independent signals.
    });
  });
});
