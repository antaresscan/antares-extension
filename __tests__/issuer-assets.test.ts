import { describe, it, expect } from "vitest";
import { issuerKindOf, judgeIssuerAsset, lstPriceInSol, NON_USD_STABLE, LST_PEG_WARN, LST_PEG_CRITICAL, type IssuerInput } from "../api/_lib/issuer-assets";
import { LST_MINTS, STABLE_MINTS, TOKENIZED_MINTS } from "../api/_lib/issuer-assets.data";
import type { DexScreenerPair, LayerResult, RugEvidence, ScanFlag } from "../api/_lib/types";

// Stablecoins and tokenized stocks are built as their issuer built them. Read as meme coins they came out RUG (all 46 tokenized stocks of the
// replay corpus). They are judged on their MARKET: the owner's rule (2026-10-13) — with a healthy market, a stablecoin AND a tokenized stock /
// real-world asset are SAFE (the SAFE of Antares is "no rug signal found", as for a meme coin).

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const PYUSD = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";
const AAPLX = "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp"; // Apple xStock (the owner's screenshot: "XsbE...JzJp")
const SOL = "So11111111111111111111111111111111111111112";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const JITOSOL = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
const MSOL = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";
const EURC = "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr";

describe("the registry: by mint address, from Jupiter's verified list", () => {
  const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

  it("holds real mints only, none twice, none in both kinds", () => {
    for (const list of [STABLE_MINTS, TOKENIZED_MINTS]) {
      expect(list.every((m) => BASE58.test(m))).toBe(true);
      expect(new Set(list).size).toBe(list.length);
    }
    expect(LST_MINTS.every((m) => BASE58.test(m)) && new Set(LST_MINTS).size === LST_MINTS.length).toBe(true);
    expect(STABLE_MINTS.filter((m) => TOKENIZED_MINTS.includes(m))).toEqual([]);
    expect(LST_MINTS.filter((m) => STABLE_MINTS.includes(m) || TOKENIZED_MINTS.includes(m))).toEqual([]);
    expect(LST_MINTS.length).toBeGreaterThanOrEqual(50);
    expect(LST_MINTS).not.toContain(SOL); // wrapped SOL is what LSTs are priced in, not one of them
    for (const m of NON_USD_STABLE) expect(STABLE_MINTS).toContain(m);
    expect(STABLE_MINTS.length).toBeGreaterThanOrEqual(10);
    expect(TOKENIZED_MINTS.length).toBeGreaterThanOrEqual(1000);
  });

  it("knows the big stablecoins and the Apple xStock", () => {
    expect(issuerKindOf(USDC)).toBe("stable");
    expect(issuerKindOf(USDT)).toBe("stable");
    expect(issuerKindOf(PYUSD)).toBe("stable");
    expect(issuerKindOf(AAPLX)).toBe("tokenized");
    expect(issuerKindOf(JITOSOL)).toBe("lst");
    expect(issuerKindOf(MSOL)).toBe("lst");
  });

  it("knows nothing else: SOL, BONK, JUP, a random address, null", () => {
    for (const m of [SOL, BONK, JUP, "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", "", null, undefined]) expect(issuerKindOf(m)).toBeNull();
  });

  it("is read by ADDRESS: a look-alike of a registry mint (one character off) is not in it", () => {
    expect(issuerKindOf(AAPLX.slice(0, -1) + "K")).toBeNull();
    expect(issuerKindOf(USDC.toLowerCase())).toBeNull();
  });
});

const flag = (severity: ScanFlag["severity"], label: string, tags?: ScanFlag["tags"]): ScanFlag => ({ label, severity, impact: 0, ...(tags ? { tags } : {}) });
const layer = (source: string, flags: ScanFlag[] = [], over: Partial<LayerResult> = {}): LayerResult => ({ source, trust: 1, available: true, flags, forceRug: false, safeBlocked: false, ...over });

// What the general engine says about a healthy stablecoin / stock: every one of these is the issuer's structure.
const BY_DESIGN: ScanFlag[] = [
  flag("critical", "Freeze authority active — wallets can be frozen"),
  flag("critical", "Mint authority active — supply can be inflated"),
  flag("critical", "Top 10 hold 98% — extreme concentration"),
  flag("critical", "LP not burned or locked — dev can rug liquidity (contract not clean)"),
  flag("critical", "Permanent Control Enabled"),
  flag("critical", "Pausable token — an authority can pause every transfer"),
  flag("critical", "Permanent delegate — an address can move or burn any holder's tokens"),
  flag("warning", "RugCheck: High ownership"),
  flag("warning", "Large Amount of LP Unlocked (100.00%)"),
  flag("critical", "No website / Twitter / Telegram — high rug risk"),
  flag("critical", "High vol/liquidity ratio (>10×) — probable wash volume"),
  flag("critical", "Deceptive name — impersonates real institution"),
];
const input = (over: Partial<IssuerInput> = {}): IssuerInput => {
  const kind = over.kind ?? "tokenized";
  return {
    kind, mint: kind === "stable" ? USDT : kind === "lst" ? JITOSOL : AAPLX, layers: [layer("dexscreener"), layer("chart")], flags: BY_DESIGN, sourcesUsedCount: 5,
    priceChange24hPct: 1.2, priceChange1hPct: 0.1, priceUsd: kind === "stable" ? 1.0004 : 341.28, poolLiquidityUsd: 329_000, priceInSol: kind === "lst" ? 1.27 : null, ...over,
  };
};
const sevOf = (r: NonNullable<ReturnType<typeof judgeIssuerAsset>>, label: RegExp) => r.flags.find((f) => label.test(f.label))?.severity;

describe("judgeIssuerAsset: the verdict of an issuer-backed token, from its market", () => {
  it("a healthy stablecoin is SAFE: authorities, concentration, LP, links, volume, name are information", () => {
    const r = judgeIssuerAsset(input({ kind: "stable" }))!;
    expect(r.risk).toBe("SAFE");
    expect(r.score).toBe(950);
    expect(r.rugKind).toBeNull();
    expect(r.safeBlocked).toBe(false);
    expect(r.flags.filter((f) => f.severity === "critical" || f.severity === "warning")).toEqual([]);
    expect(r.flags[0].label).toMatch(/^Stablecoin — the issuer holds/);
    expect(r.flags[0].severity).toBe("info");
    // nothing is hidden: every flag of the general engine is still there, with its own words
    for (const f of BY_DESIGN) expect(r.flags.some((x) => x.label === f.label && x.severity === "info")).toBe(true);
  });

  it("a healthy tokenized stock is SAFE too (the owner's rule: the same as a stablecoin): what its issuer can do is an information line", () => {
    const r = judgeIssuerAsset(input({ kind: "tokenized" }))!;
    expect(r.risk).toBe("SAFE");
    expect(r.score).toBe(950);
    expect(r.safeBlocked).toBe(false);
    expect(r.flags.filter((f) => f.severity === "critical" || f.severity === "warning")).toEqual([]);
    expect(r.flags[0]).toMatchObject({ severity: "info" });
    expect(r.flags[0].label).toMatch(/^Tokenized asset — the issuer can freeze, pause or reissue/);
    for (const f of BY_DESIGN) expect(r.flags.some((x) => x.label === f.label && x.severity === "info")).toBe(true);
  });

  it("a stock with no flag at all is SAFE", () => {
    expect(judgeIssuerAsset(input({ flags: [] }))!.risk).toBe("SAFE");
  });

  it("a real market problem still counts: under $1k of liquidity is DANGER, under $5k a warning (CAUTION)", () => {
    const veryLow = judgeIssuerAsset(input({ flags: [...BY_DESIGN, flag("critical", "Very low liquidity (<$1k)")] }))!;
    expect(veryLow.risk).toBe("DANGER");
    expect(sevOf(veryLow, /^Very low liquidity/)).toBe("critical");
    const low = judgeIssuerAsset(input({ flags: [...BY_DESIGN, flag("warning", "Low liquidity (<$5k)")] }))!;
    expect(low.risk).toBe("CAUTION");
    expect(sevOf(low, /^Low liquidity/)).toBe("warning");
    expect(judgeIssuerAsset(input({ kind: "stable", flags: [...BY_DESIGN, flag("warning", "Low liquidity (<$5k)")] }))!.risk).toBe("CAUTION");
  });

  it("a price crash still counts: a collapse, a sharp crash, a 24 h dump", () => {
    for (const label of ["Collapsed -80% from its high 3 days ago", "Sharp crash: -63% on 6h + -22% on 1h", "Brutal dump 24h (-80%)"]) {
      for (const kind of ["stable", "tokenized"] as const) {
        const r = judgeIssuerAsset(input({ kind, flags: [...BY_DESIGN, flag("critical", label)] }))!;
        expect(r.risk, `${kind}: ${label}`).toBe("DANGER");
        expect(sevOf(r, /Collapsed|Sharp crash|Brutal dump/)).toBe("critical");
      }
    }
  });

  it("a drained pool is a RUG whatever the structure: a confirmed fact, for both kinds", () => {
    const drained = [layer("dexscreener", [flag("critical", "Volume with zero liquidity — abandoned pool", ["rug_evidence"])], { rugEvidence: ["pool_abandoned" as RugEvidence] }), layer("chart")];
    for (const kind of ["stable", "tokenized"] as const) {
      const r = judgeIssuerAsset(input({ kind, layers: drained, flags: [...BY_DESIGN, flag("critical", "Volume with zero liquidity — abandoned pool", ["rug_evidence"])] }))!;
      expect(r.risk).toBe("RUG");
      expect(r.rugKind).toBe("confirmed");
      expect(r.score).toBeLessThanOrEqual(100);
    }
  });

  it("blocked sales are a RUG whatever the structure: the honeypot facts are kept", () => {
    const hp = [layer("dexscreener"), layer("goplus", [flag("critical", "Honeypot detected — cannot sell", ["rug_evidence"])], { rugEvidence: ["sells_blocked" as RugEvidence] })];
    const r = judgeIssuerAsset(input({ kind: "stable", layers: hp, flags: [...BY_DESIGN, flag("critical", "Honeypot detected — cannot sell", ["rug_evidence"])] }))!;
    expect(r.risk).toBe("RUG");
    expect(r.rugKind).toBe("confirmed");
    expect(sevOf(r, /^Honeypot/)).toBe("critical");
  });

  it("a stablecoin that loses its peg: a warning from 3 %, critical from 10 %, up or down, over an hour or a day", () => {
    const peg = (h24: number | null, h1: number | null) => judgeIssuerAsset(input({ kind: "stable", flags: [], priceChange24hPct: h24, priceChange1hPct: h1 }))!;
    expect(peg(2.9, 0.4).risk).toBe("SAFE");
    expect(peg(null, null).risk).toBe("SAFE");
    const three = peg(3, 0);
    expect(three.risk).toBe("CAUTION");
    expect(three.flags.find((f) => f.severity === "warning")?.label).toBe("Stablecoin price moved 3% — it may have lost its peg");
    expect(peg(0, -4.4).flags.find((f) => f.severity === "warning")?.label).toBe("Stablecoin price moved 4.4% — it may have lost its peg");
    const ten = peg(-12.4, 1);
    expect(ten.risk).toBe("DANGER");
    expect(ten.flags.find((f) => f.severity === "critical")?.label).toBe("Stablecoin price moved 12% — it may have lost its peg");
  });

  it("a stock's price moves are not a peg: +8 % on earnings is not a flag", () => {
    expect(judgeIssuerAsset(input({ kind: "tokenized", flags: [], priceChange24hPct: 8, priceChange1hPct: 3 }))!.risk).toBe("SAFE");
    expect(judgeIssuerAsset(input({ kind: "tokenized", flags: [], priceChange24hPct: 8, priceChange1hPct: 3 }))!.flags.some((f) => /peg/.test(f.label))).toBe(false);
  });

  it("no market reading (DexScreener unavailable): no judgement, the general decision stands", () => {
    expect(judgeIssuerAsset(input({ layers: [layer("dexscreener", [], { available: false }), layer("chart")] }))).toBeNull();
    expect(judgeIssuerAsset(input({ layers: [layer("chart")] }))).toBeNull();
  });

  it("not enough sources is not a clean bill of health: on 2 sources it is CAUTION, not SAFE (stablecoin or stock)", () => {
    for (const kind of ["stable", "tokenized"] as const) {
      expect(judgeIssuerAsset(input({ kind, flags: [], sourcesUsedCount: 2 }))!.risk).toBe("CAUTION");
      expect(judgeIssuerAsset(input({ kind, flags: [], sourcesUsedCount: 3 }))!.risk).toBe("SAFE");
    }
  });

  it("the flags come most severe first, and the input is not modified", () => {
    const flags = [...BY_DESIGN, flag("critical", "Very low liquidity (<$1k)"), flag("info", "Established token (30d+) ✓"), flag("bonus", "Verified by someone")];
    const copy = JSON.parse(JSON.stringify(flags)) as ScanFlag[];
    const r = judgeIssuerAsset(input({ flags }))!;
    const order = r.flags.map((f) => f.severity);
    expect(order).toEqual([...order].sort((a, b) => ["critical", "warning", "info", "bonus"].indexOf(a) - ["critical", "warning", "info", "bonus"].indexOf(b)));
    expect(flags).toEqual(copy);
    expect(r.flags.some((f) => f.label === "Established token (30d+) ✓" && f.severity === "info")).toBe(true);
  });
});

// ─── Liquid staking tokens, and the distance to $1 of a stablecoin ───────────────────────────────────────────────────────────────
describe("liquid staking tokens: SAFE with their peg to SOL read", () => {
  const lst = (over: Partial<IssuerInput> = {}) => judgeIssuerAsset(input({ kind: "lst", ...over }))!;

  it("a healthy LST (about 1.27 SOL: it accrues the staking rewards) is SAFE; the stake pool's structure is information", () => {
    const r = lst();
    expect(r.risk).toBe("SAFE");
    expect(r.score).toBe(950);
    expect(r.flags[0]).toMatchObject({ severity: "info" });
    expect(r.flags[0].label).toMatch(/^Liquid staking token — the stake pool holds the mint authority/);
    expect(r.flags.filter((f) => f.severity === "critical" || f.severity === "warning")).toEqual([]);
    for (const f of BY_DESIGN) expect(r.flags.some((x) => x.label === f.label && x.severity === "info")).toBe(true);
  });

  it("the peg to SOL: under 0.97 a warning, under 0.90 critical; 0.97 itself is fine", () => {
    expect(LST_PEG_WARN).toBe(0.97);
    expect(LST_PEG_CRITICAL).toBe(0.9);
    expect(lst({ priceInSol: 0.97 }).risk).toBe("SAFE");
    const warn = lst({ priceInSol: 0.96 });
    expect(warn.risk).toBe("CAUTION");
    expect(warn.flags.find((f) => f.severity === "warning")?.label).toBe("Liquid staking token trades at 0.9600 SOL — it may have lost its peg to SOL");
    expect(lst({ priceInSol: 0.9 }).risk).toBe("CAUTION");
    const crit = lst({ priceInSol: 0.89 });
    expect(crit.risk).toBe("DANGER");
    expect(crit.flags.find((f) => f.severity === "critical")?.label).toBe("Liquid staking token trades at 0.8900 SOL — it may have lost its peg to SOL");
  });

  it("a price in SOL that cannot be read is not a clean bill of health: CAUTION, with a warning that says why (never SAFE, never judged as a meme coin)", () => {
    for (const priceInSol of [null, 0, -1, NaN]) {
      const r = lst({ priceInSol });
      expect(r.risk).toBe("CAUTION");
      expect(r.flags.find((f) => f.severity === "warning")?.label).toMatch(/^Liquid staking token — its price in SOL could not be read/);
      expect(r.flags.filter((f) => f.severity === "critical")).toEqual([]);
    }
  });

  it("a USD move is not a peg for an LST: it follows SOL (+12 % in a day is nothing)", () => {
    expect(lst({ priceChange24hPct: 12, priceChange1hPct: 5 }).risk).toBe("SAFE");
  });

  it("the market still counts: a thin pool, a collapse, a drained pool", () => {
    expect(lst({ flags: [...BY_DESIGN, flag("critical", "Very low liquidity (<$1k)")] }).risk).toBe("DANGER");
    expect(lst({ flags: [...BY_DESIGN, flag("warning", "Low liquidity (<$5k)")] }).risk).toBe("CAUTION");
    const drained = [layer("dexscreener", [], { rugEvidence: ["pool_abandoned" as RugEvidence] }), layer("chart")];
    expect(lst({ layers: drained, flags: [...BY_DESIGN, flag("critical", "Volume with zero liquidity — abandoned pool", ["rug_evidence"])] }).risk).toBe("RUG");
  });
});

describe("lstPriceInSol: the price of an LST in SOL, from its deepest SOL-quoted pool", () => {
  const pool = (base: string, quote: { address?: string; symbol?: string }, liq: number, native: string | undefined): DexScreenerPair => ({
    baseToken: { address: base }, quoteToken: quote, liquidity: { usd: liq }, ...(native !== undefined ? { priceNative: native } : {}),
  });
  const WSOL_Q = { address: SOL, symbol: "SOL" };

  it("takes the deepest SOL-quoted pool of the token", () => {
    expect(lstPriceInSol([pool(JITOSOL, WSOL_Q, 20_000, "1.2600"), pool(JITOSOL, WSOL_Q, 900_000, "1.2701"), pool(JITOSOL, { symbol: "USDC" }, 5_000_000, "232.5")], JITOSOL)).toBe(1.2701);
  });

  it("a pool quoted in USDC (or in another LST) says nothing about the price in SOL", () => {
    expect(lstPriceInSol([pool(JITOSOL, { address: USDC, symbol: "USDC" }, 5_000_000, "232.5"), pool(JITOSOL, { symbol: "INF" }, 900_000, "0.9")], JITOSOL)).toBeNull();
  });

  it("a SOL-quoted pool must be the token's own (a pool where it is only the quote does not count) and must hold at least $5k", () => {
    expect(lstPriceInSol([pool("OtherToken1111111111111111111111111111111111", WSOL_Q, 900_000, "1.3")], JITOSOL)).toBeNull();
    expect(lstPriceInSol([pool(JITOSOL, WSOL_Q, 4_999, "1.27")], JITOSOL)).toBeNull();
    expect(lstPriceInSol([pool(JITOSOL, WSOL_Q, 5_000, "1.27")], JITOSOL)).toBe(1.27);
  });

  it("an unusable price is not a price", () => {
    for (const bad of [undefined, "", "abc", "0", "-1"]) expect(lstPriceInSol([pool(JITOSOL, WSOL_Q, 900_000, bad)], JITOSOL)).toBeNull();
    expect(lstPriceInSol(null, JITOSOL)).toBeNull();
    expect(lstPriceInSol(undefined, JITOSOL)).toBeNull();
    expect(lstPriceInSol([], JITOSOL)).toBeNull();
  });
});

describe("a stablecoin's distance to $1 (a sustained depeg that no price MOVE shows)", () => {
  const stable = (over: Partial<IssuerInput> = {}) => judgeIssuerAsset(input({ kind: "stable", flags: [], ...over }))!;

  it("a stablecoin sitting at $0.95 for days (no move in 24 h) is a warning; at $0.89 critical; above 1 as well", () => {
    const warn = stable({ priceUsd: 0.95, priceChange24hPct: 0, priceChange1hPct: 0 });
    expect(warn.risk).toBe("CAUTION");
    expect(warn.flags.find((f) => f.severity === "warning")?.label).toBe("Stablecoin trades at $0.9500, 5% from its $1 peg");
    const crit = stable({ priceUsd: 0.89, priceChange24hPct: 0, priceChange1hPct: 0 });
    expect(crit.risk).toBe("DANGER");
    expect(crit.flags.find((f) => f.severity === "critical")?.label).toBe("Stablecoin trades at $0.8900, 11% from its $1 peg");
    expect(stable({ priceUsd: 1.04 }).risk).toBe("CAUTION");
  });

  it("the edges: 3 % off is a warning, just under is fine (USDC at $1.0015 and DAI at $0.989 are fine)", () => {
    expect(stable({ priceUsd: 1.0015 }).risk).toBe("SAFE");
    expect(stable({ priceUsd: 0.989 }).risk).toBe("SAFE");
    expect(stable({ priceUsd: 0.9701 }).risk).toBe("SAFE");
    expect(stable({ priceUsd: 0.97 }).risk).toBe("CAUTION");
    expect(stable({ priceUsd: 1.1 }).risk).toBe("DANGER");
  });

  it("only one flag for one depeg: a move AND a distance say it once, the worse reading", () => {
    const r = stable({ priceUsd: 0.9, priceChange24hPct: -5, priceChange1hPct: 0 });
    expect(r.flags.filter((f) => /peg|Stablecoin (trades|price)/.test(f.label) && f.severity !== "info")).toHaveLength(1);
    expect(r.flags.find((f) => f.severity === "critical")?.label).toBe("Stablecoin trades at $0.9000, 10% from its $1 peg");
  });

  it("EURC follows the euro: $1.11 is its peg, not a depeg (its moves still count)", () => {
    expect(NON_USD_STABLE.has(EURC)).toBe(true);
    expect(judgeIssuerAsset(input({ kind: "stable", mint: EURC, flags: [], priceUsd: 1.11 }))!.risk).toBe("SAFE");
    expect(judgeIssuerAsset(input({ kind: "stable", mint: EURC, flags: [], priceUsd: 1.11, priceChange24hPct: -6 }))!.risk).toBe("CAUTION");
  });

  it("the price of a pool with almost no liquidity says nothing (wYLDS at $0.95 on a $0k pool): unknown liquidity or under $25k is not read", () => {
    expect(stable({ priceUsd: 0.95, poolLiquidityUsd: 24_999 }).risk).toBe("SAFE");
    expect(stable({ priceUsd: 0.95, poolLiquidityUsd: null }).risk).toBe("SAFE");
    expect(stable({ priceUsd: 0.95, poolLiquidityUsd: 25_000 }).risk).toBe("CAUTION");
    expect(stable({ priceUsd: null }).risk).toBe("SAFE");
  });
});

