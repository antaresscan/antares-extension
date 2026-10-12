import { describe, it, expect } from "vitest";
import { issuerKindOf, judgeIssuerAsset, type IssuerInput } from "../api/_lib/issuer-assets";
import { STABLE_MINTS, TOKENIZED_MINTS } from "../api/_lib/issuer-assets.data";
import type { LayerResult, RugEvidence, ScanFlag } from "../api/_lib/types";

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

describe("the registry: by mint address, from Jupiter's verified list", () => {
  const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

  it("holds real mints only, none twice, none in both kinds", () => {
    for (const list of [STABLE_MINTS, TOKENIZED_MINTS]) {
      expect(list.every((m) => BASE58.test(m))).toBe(true);
      expect(new Set(list).size).toBe(list.length);
    }
    expect(STABLE_MINTS.filter((m) => TOKENIZED_MINTS.includes(m))).toEqual([]);
    expect(STABLE_MINTS.length).toBeGreaterThanOrEqual(10);
    expect(TOKENIZED_MINTS.length).toBeGreaterThanOrEqual(1000);
  });

  it("knows the big stablecoins and the Apple xStock", () => {
    expect(issuerKindOf(USDC)).toBe("stable");
    expect(issuerKindOf(USDT)).toBe("stable");
    expect(issuerKindOf(PYUSD)).toBe("stable");
    expect(issuerKindOf(AAPLX)).toBe("tokenized");
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
const input = (over: Partial<IssuerInput> = {}): IssuerInput => ({
  kind: "tokenized", layers: [layer("dexscreener"), layer("chart")], flags: BY_DESIGN, sourcesUsedCount: 5, priceChange24hPct: 1.2, priceChange1hPct: 0.1, ...over,
});
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
