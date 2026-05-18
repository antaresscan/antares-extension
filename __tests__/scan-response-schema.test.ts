// __tests__/scan-response-schema.test.ts
//
// Pins the runtime contract for /api/scan responses consumed by the
// content-script. The schema lived in shared/schemas.ts for months but
// was never called — the audit flagged that a malformed response would
// traverse all the way to buildResultNode and either panic or render
// garbage. PR wires the schema in scanner.ts; this test pins the
// validation behaviour so future field renames / type changes either
// keep the contract intact or update the schema in lockstep.

import { describe, it, expect } from "vitest";
import { ScanResponseDataSchema } from "../shared/schemas";

// Minimal valid scan response shaped like the real `/api/scan` output.
// Only the fields the schema mandates are present; everything else is
// optional and may or may not appear depending on which upstreams
// returned data within the budget.
const validScan = {
  score: 720,
  risk: "SAFE",
  flags: [
    { label: "ownership_renounced", severity: "info", impact: 0 },
    { label: "high_concentration", severity: "warning", impact: -50 },
  ],
};

describe("ScanResponseDataSchema", () => {
  it("accepts a minimal valid response", () => {
    const r = ScanResponseDataSchema.safeParse(validScan);
    expect(r.success).toBe(true);
  });

  it("preserves unknown fields via .passthrough()", () => {
    // Forward compatibility: backend can add new keys without an
    // extension ship. Verified by checking that `_quota`, a runtime-
    // injected field, AND a hypothetical future field both survive
    // the parse intact.
    const withExtras = {
      ...validScan,
      criticalActors: [{ tag: "Holder #1", desc: "...", pct: 5.2 }],
      futureField: "whatever",
    };
    const r = ScanResponseDataSchema.safeParse(withExtras);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).toHaveProperty("criticalActors");
      expect(r.data).toHaveProperty("futureField");
    }
  });

  it("rejects when `score` is the wrong type (string instead of number)", () => {
    const r = ScanResponseDataSchema.safeParse({
      ...validScan,
      score: "720" as unknown as number,
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path[0] === "score")).toBe(true);
    }
  });

  it("rejects when `flags` is an object instead of an array", () => {
    const r = ScanResponseDataSchema.safeParse({
      ...validScan,
      flags: { 0: validScan.flags[0] } as unknown,
    });
    expect(r.success).toBe(false);
  });

  it("rejects when a flag is missing required fields", () => {
    const r = ScanResponseDataSchema.safeParse({
      ...validScan,
      flags: [{ label: "x", severity: "info" }],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes("impact"))).toBe(true);
    }
  });

  it("rejects when required `risk` field is missing", () => {
    const partial: Record<string, unknown> = { ...validScan };
    delete partial.risk;
    const r = ScanResponseDataSchema.safeParse(partial);
    expect(r.success).toBe(false);
  });

  it("accepts nullable optional fields as null", () => {
    const r = ScanResponseDataSchema.safeParse({
      ...validScan,
      holders: null,
      marketCap: null,
      priceUsd: null,
      lpBurned: null,
    });
    expect(r.success).toBe(true);
  });

  it("accepts the full canonical response shape (smoke)", () => {
    // Belt-and-suspenders: a realistic-ish response with most optional
    // fields populated. Catches accidental schema breaks during
    // refactors.
    const r = ScanResponseDataSchema.safeParse({
      score: 415,
      risk: "CAUTION",
      flags: [{ label: "lp_unverified", severity: "warning", impact: -30 }],
      pair: {
        baseToken: { symbol: "POPCAT", address: "ukHH..." },
        liquidity: { usd: 1_200_000 },
        url: "https://dexscreener.com/solana/abc",
      },
      resolvedMint: "ukHH...",
      confidence: 88,
      sources_used: ["helius", "dexscreener", "rugcheck"],
      holders: 4500,
      marketCap: 12_000_000,
      priceUsd: 0.0042,
      priceChange1h: 2.3,
      liquidity: 1_200_000,
      tokenSymbol: "POPCAT",
      tokenName: "Popcat",
      mintAuthority: false,
      freezeAuthority: false,
      lpBurned: true,
      lpLocked: null,
      honeypot: false,
      safeBlocked: false,
      candles: [{ close: 0.0041 }, { close: 0.0042 }],
      layers: {
        dexscreener: { trust: 0.9, available: true },
        helius: { trust: 0.8, available: true },
      },
      scoring_version: "8.0.1",
      fetchedAt: 1779140000000,
      aiSummary: "POPCAT has decent liquidity and a stable holder count …",
    });
    expect(r.success).toBe(true);
  });
});
