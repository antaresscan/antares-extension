// __tests__/pro-gate.test.ts
//
// The Pro/Free line, drawn on the server (api/_lib/pro-gate.ts). Until now /api/scan sent every caller the full analysis and the
// overlay only greyed out the buttons: anybody could read the Pro content by calling the API or opening token.html.
//
// What is pinned here:
//  - a Free caller receives the verdict, the score, the Sell/Mint/Freeze/LP line and public market data, and NOTHING of the analysis;
//  - the list is an allowlist: a field added to the scan tomorrow is Pro, not Free;
//  - the one-line summary of the Free overlay ("3 flags — 1 critical") reads the same on the Free view as on the full scan: this is
//    a safety matter (a DANGER token must never read "No issues found" because its flags were hidden);
//  - a Pro caller (and an error body) is untouched.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { VercelResponse } from "@vercel/node";
import { FREE_SCAN_FIELDS, PRO_FLAG_PLACEHOLDER, PRO_SCAN_FIELDS, enforceProGate, isScanBody, redactScanForFree } from "../api/_lib/pro-gate";
import { PIPELINE_STATUS_PATTERN, countsInOverlaySummary } from "../shared/flag-summary";
import { isHoldersUnverifiedFlag } from "../shared/holders-unverified";
import golden from "./replay/golden.json";

const full = {
  score: 410,
  risk: "RUG",
  rugKind: "risk",
  flags: [
    { label: "Top 10 holders > 70%", severity: "critical", impact: -200 },
    { label: "Mint authority active", severity: "warning", impact: -80 },
    { label: "LP Burned ✓", severity: "bonus", impact: 50 },
    { label: "Mutable metadata", severity: "info", impact: 0 },
    { label: "GoPlus timed out", severity: "warning", impact: 0 },
    { label: "Helius unavailable — holder concentration unverified", severity: "warning", impact: -30 },
  ],
  pair: { baseToken: { symbol: "TKN", name: "Token" }, liquidity: { usd: 42000 } },
  resolvedMint: "So11111111111111111111111111111111111111112",
  confidence: 0.8,
  sources_used: ["rugcheck", "goplus"],
  holders: 1234,
  marketCap: 1_000_000,
  priceUsd: 0.5,
  liquidity: 42000,
  volume24h: 9000,
  volume1h: 100,
  priceChange5m: 1,
  priceChange1h: 2,
  priceChange24h: 3,
  tokenSymbol: "TKN",
  tokenName: "Token",
  pairCreatedAt: 1_700_000_000_000,
  safeBlocked: true,
  safeBlockedReasons: ["age"],
  tokenLogo: "https://example.com/logo.png",
  tokenCreator: "CreatorWallet1111111111111111111111111111111",
  tokenDecimals: 6,
  tokenSupply: 1_000_000_000,
  recentTransfers: [{ from_address: "a", to_address: "b", amount: 1 }],
  solscanTokenAgeHours: 12,
  solscanVolume24h: 1,
  solscanTrades24h: 2,
  solscanTraders24h: 3,
  layers: { rugcheck: { trust: 0.9, available: true } },
  scoring_version: "v3.2",
  fetchedAt: 1_760_000_000_000,
  honeypot: false,
  mintAuthority: true,
  freezeAuthority: false,
  requestId: "req-1",
  lpBurned: false,
  candles: [{ close: 1 }, { close: 2 }],
  aiSummary: "A long paragraph that is the Pro AI summary.",
  lpLocked: false,
  lpLockedPct: 0,
  lpLockDurationDays: null,
  topHolderPct: 40,
  top10HolderPct: 75,
  criticalActors: [{ type: "dev", tag: "Dev", pct: 12, addr: "x", repLbl: "r", repWidth: 1, repWarn: true, desc: "d" }],
  verdictHistory: [{ ts: 1, verdict: "DANGER", score: 410, event: "e" }],
  holderActivity: { rows: [], netFlowPct: 0, netFlowDirection: "flat" },
};

/** The overlay's own rule (contents/modules/components.ts, buildResultNode), on the shape /api/scan answers. */
function overlaySummary(flags: Array<{ label: string; severity: string }>) {
  const PIPELINE = /^(Helius|GoPlus|RugCheck|Solscan|DexScreener|Birdeye|Helius RPC) (unavailable|rate[- ]limited|timed out|degraded)\b|Holder data unreliable|broken upstream/i;
  const counted = flags.filter((f) => {
    if (f.severity === "bonus" || f.severity === "info") return false;
    if (PIPELINE.test(f.label) && !isHoldersUnverifiedFlag(f.label)) return false;
    return true;
  });
  return { flagCount: counted.length, critCount: counted.filter((f) => f.severity === "critical").length };
}

describe("what a Free caller receives", () => {
  const view = redactScanForFree(full);

  it("the verdict, the score, the Sell/Mint/Freeze/LP line and the public market data", () => {
    expect(view.risk).toBe("RUG");
    expect(view.score).toBe(410);
    expect([view.honeypot, view.mintAuthority, view.freezeAuthority, view.lpBurned, view.lpLocked]).toEqual([false, true, false, false, false]);
    expect(view.liquidity).toBe(42000);
    expect(view.pair).toEqual(full.pair);
    expect(view.tokenSymbol).toBe("TKN");
    expect(view.candles).toEqual(full.candles);
    expect(view.resolvedMint).toBe(full.resolvedMint);
  });

  it("the verdict word is the same for Free and Pro: rugKind (RUG PULL / RUG RISK) is in the Free view", () => {
    expect(view.rugKind).toBe("risk");
    expect(redactScanForFree({ ...full, rugKind: "confirmed" }).rugKind).toBe("confirmed");
  });

  it("says it is the Free view, so token.html can show the Pro message instead of an empty page", () => {
    expect(view.proLocked).toBe(true);
  });

  it("NOTHING of the analysis: no layers, no sources, no AI summary, no holders, no actors, no history, no creator", () => {
    for (const pro of [
      "layers", "sources_used", "confidence", "aiSummary", "holders", "topHolderPct", "top10HolderPct", "criticalActors", "verdictHistory",
      "holderActivity", "tokenCreator", "recentTransfers", "safeBlocked", "safeBlockedReasons", "tokenDecimals", "tokenSupply",
      "solscanTokenAgeHours", "solscanVolume24h", "solscanTrades24h", "solscanTraders24h",
    ]) {
      expect(view, pro).not.toHaveProperty(pro);
    }
  });

  it("is an allowlist: a field added to the scan tomorrow is Pro until someone decides otherwise", () => {
    const view2 = redactScanForFree({ ...full, aNewPaidThing: { secret: 1 }, anotherOne: "x" });
    expect(view2).not.toHaveProperty("aNewPaidThing");
    expect(view2).not.toHaveProperty("anotherOne");
    const allowed = new Set<string>([...FREE_SCAN_FIELDS, "flags", "proLocked"]);
    expect(Object.keys(view2).filter((k) => !allowed.has(k))).toEqual([]);
  });

  it("the text of the flags is gone: placeholders only, with their severity and no weight", () => {
    const text = JSON.stringify(view.flags);
    for (const f of full.flags) expect(text).not.toContain(f.label);
    for (const f of view.flags as Array<{ label: string; impact: number }>) {
      expect(f.label).toBe(PRO_FLAG_PLACEHOLDER);
      expect(f.impact).toBe(0);
    }
  });

  it("does not modify the full scan it is given (the cache keeps the whole thing for the Pro callers)", () => {
    const copy = JSON.parse(JSON.stringify(full)) as typeof full;
    redactScanForFree(full);
    expect(full).toEqual(copy);
  });

  it("is idempotent", () => {
    expect(redactScanForFree(view as never)).toEqual(view);
  });
});

describe("every field of a scan is on one side of the line, on purpose", () => {
  // The fields of ScanResult, read from its declaration: a field someone adds to the scan fails here until it is put in FREE_SCAN_FIELDS or
  // PRO_SCAN_FIELDS. The gate is an allowlist, so an unlisted field would silently be Pro, and a part of the verdict could vanish for Free callers.
  const declared = (() => {
    // Without a backslash escape in sight: the carriage returns a Windows checkout may add are removed by their character code.
    const src = readFileSync(fileURLToPath(new URL("../api/_lib/types.ts", import.meta.url)), "utf8").split(String.fromCharCode(13)).join("");
    const block = src.slice(src.indexOf("export interface ScanResult {"));
    const body = block.slice(0, block.indexOf("\n}\n"));
    return Array.from(body.matchAll(/^\s+([A-Za-z0-9_]+)\??:/gm)).map((m) => m[1]);
  })();

  it("finds the declaration (the guard is not blind)", () => {
    expect(declared.length).toBeGreaterThan(40);
    expect(declared).toContain("risk");
    expect(declared).toContain("aiSummary");
  });

  it("every field of ScanResult is Free, Pro, or the flags", () => {
    const known = new Set<string>([...FREE_SCAN_FIELDS, ...PRO_SCAN_FIELDS, "flags"]);
    expect(declared.filter((k) => !known.has(k)), "a field of ScanResult is neither in FREE_SCAN_FIELDS nor in PRO_SCAN_FIELDS (api/_lib/pro-gate.ts): decide which side of the line it is on").toEqual([]);
  });

  it("no field is on both sides, and no listed field is unknown to ScanResult", () => {
    const free = new Set<string>(FREE_SCAN_FIELDS);
    expect(PRO_SCAN_FIELDS.filter((k) => free.has(k))).toEqual([]);
    const all = new Set(declared);
    expect([...FREE_SCAN_FIELDS, ...PRO_SCAN_FIELDS].filter((k) => !all.has(k)), "a listed field is not in ScanResult any more: remove it").toEqual([]);
  });
});

describe("the one-line summary of the Free overlay reads the same as on the full scan (safety)", () => {
  it("on a mix of critical, warning, bonus, info and plumbing flags", () => {
    const view = redactScanForFree(full);
    const before = overlaySummary(full.flags);
    const after = overlaySummary(view.flags as Array<{ label: string; severity: string }>);
    expect(before).toEqual({ flagCount: 3, critCount: 1 }); // critical + warning + "holder concentration unverified"; not the bonus, the info, nor "GoPlus timed out"
    expect(after).toEqual(before);
  });

  it("a DANGER token never reads 'No issues found' because its flags were hidden", () => {
    const view = redactScanForFree({ ...full, flags: [{ label: "Honeypot", severity: "critical", impact: -500 }] });
    expect(overlaySummary(view.flags as Array<{ label: string; severity: string }>)).toEqual({ flagCount: 1, critCount: 1 });
  });

  it("a clean token has no flag to count, on either side", () => {
    const view = redactScanForFree({ ...full, risk: "SAFE", flags: [{ label: "LP Burned ✓", severity: "bonus", impact: 50 }] });
    expect(view.flags).toEqual([]);
  });

  it("on every real token of the replay corpus (31 recorded scans): same count, same critical count", () => {
    const entries = Object.entries(golden as unknown as Record<string, { flags: string[] }>);
    expect(entries.length).toBeGreaterThanOrEqual(30);
    for (const [symbol, g] of entries) {
      const flags = g.flags.map((s) => {
        const i = s.indexOf(":");
        return { severity: s.slice(0, i), label: s.slice(i + 1), impact: 0 };
      });
      const view = redactScanForFree({ ...full, flags });
      expect(overlaySummary(view.flags as Array<{ label: string; severity: string }>), symbol).toEqual(overlaySummary(flags));
    }
  });

  it("the server's rule is the overlay's: the regex is the very one in contents/modules/components.ts", () => {
    const src = readFileSync(fileURLToPath(new URL("../contents/modules/components.ts", import.meta.url)), "utf8");
    const m = src.match(/PIPELINE_STATUS_PATTERN_C\s*=\s*\n?\s*(\/.*\/i)/);
    expect(m, "the overlay's PIPELINE_STATUS_PATTERN_C was not found: the rule moved, update shared/flag-summary.ts with it").not.toBeNull();
    expect(PIPELINE_STATUS_PATTERN.toString()).toBe(m![1]);
  });

  it("countsInOverlaySummary on the edges", () => {
    expect(countsInOverlaySummary({ label: "x", severity: "bonus" })).toBe(false);
    expect(countsInOverlaySummary({ label: "x", severity: "info" })).toBe(false);
    expect(countsInOverlaySummary({ label: "Helius rate-limited", severity: "warning" })).toBe(false);
    expect(countsInOverlaySummary({ label: "Helius unavailable — holder concentration unverified", severity: "warning" })).toBe(true);
    expect(countsInOverlaySummary({ label: "Anything else", severity: "warning" })).toBe(true);
    expect(countsInOverlaySummary({ severity: "critical" })).toBe(true);
  });
});

describe("isScanBody", () => {
  it("is true for a scan, false for an error body or anything else", () => {
    expect(isScanBody(full)).toBe(true);
    expect(isScanBody({ error: "Daily limit reached" })).toBe(false);
    expect(isScanBody({ risk: "SAFE" })).toBe(false);
    expect(isScanBody(null)).toBe(false);
    expect(isScanBody("x")).toBe(false);
  });
});

describe("enforceProGate", () => {
  function fakeRes() {
    const sent: unknown[] = [];
    const res = { json: vi.fn((b: unknown) => { sent.push(b); return res; }) } as unknown as VercelResponse;
    return { res, sent };
  }

  it("a Free caller is sent the Free view, whatever path of the handler calls res.json", () => {
    const { res, sent } = fakeRes();
    enforceProGate(res, "free");
    res.json(full);
    res.json(full); // a second answer (another path) is covered as well
    for (const body of sent) {
      expect(body).toHaveProperty("proLocked", true);
      expect(body).not.toHaveProperty("layers");
      expect(body).not.toHaveProperty("aiSummary");
    }
  });

  it.each(["pro", "yearly", "lifetime"] as const)("a %s caller is sent the full scan, untouched", (tier) => {
    const { res, sent } = fakeRes();
    enforceProGate(res, tier);
    res.json(full);
    expect(sent[0]).toBe(full);
  });

  it("an error body is never rewritten, for a Free caller either", () => {
    const { res, sent } = fakeRes();
    enforceProGate(res, "free");
    res.json({ error: "Invalid token address." });
    expect(sent[0]).toEqual({ error: "Invalid token address." });
  });
});
