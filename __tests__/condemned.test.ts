import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Redis } from "@upstash/redis";
import type { Decision } from "../api/_lib/decide";
import {
  initCondemned, getCondemned, condemn, condemnedEntryOf, shouldCondemn, applyCondemnation, type CondemnedEntry,
} from "../api/_lib/condemned";

// A token that has rugged stays a RUG (api/_lib/condemned.ts). The owner's words: "from the moment we flagged a rug, the token is condemned".

const MINT = "MintCondemned1111111111111111111111111111111";
const FLAGGED_AT = Date.UTC(2026, 5, 3);

function decision(over: Partial<Decision> = {}): Decision {
  return {
    score: 950, risk: "SAFE", rugKind: null, flags: [], safeBlocked: false, safeBlockedReasons: [], confidence: 95,
    sources_used: ["dexscreener", "rugcheck", "goplus", "helius", "solscan", "chart"], layersSnapshot: {},
    lpBurned: true, lpLocked: false, lpBurnedPct: 100, notes: [], issuerBacked: null, ...over,
  };
}

const entry: CondemnedEntry = { mint: MINT, symbol: "GONE", condemnedAt: FLAGGED_AT, evidence: ["Volume with zero liquidity — abandoned pool", "Honeypot detected — cannot sell"] };

describe("applyCondemnation: today's data does not undo a rug", () => {
  it.each(["SAFE", "CAUTION", "DANGER"] as const)("a condemned token that reads %s today is a RUG PULL", (risk) => {
    const out = applyCondemnation(decision({ risk, score: risk === "SAFE" ? 950 : risk === "CAUTION" ? 700 : 450 }), entry);
    expect(out.risk).toBe("RUG");
    expect(out.rugKind).toBe("confirmed");
    expect(out.score).toBeLessThanOrEqual(100);
    expect(out.safeBlocked).toBe(true);
  });

  it("a condemned token that reads 'RUG RISK' today (structure only) becomes the RUG PULL it was", () => {
    const out = applyCondemnation(decision({ risk: "RUG", rugKind: "risk", score: 80 }), entry);
    expect(out.risk).toBe("RUG");
    expect(out.rugKind).toBe("confirmed");
  });

  it("the flag says when and why, is critical, and comes first; the flags of today stay", () => {
    const today = [{ label: "Top 10 hold 80% — extreme concentration", severity: "critical" as const, impact: 0 }];
    const out = applyCondemnation(decision({ risk: "DANGER", flags: today }), entry);
    expect(out.flags[0].severity).toBe("critical");
    expect(out.flags[0].label).toBe("Flagged as a rug on 2026-06-03 (Volume with zero liquidity — abandoned pool) — a token that has rugged stays flagged");
    expect(out.flags.slice(1)).toEqual(today);
  });

  it("the age does not matter: a record from three years ago still holds (no expiry anywhere in the rule)", () => {
    const old: CondemnedEntry = { ...entry, condemnedAt: Date.UTC(2023, 0, 15) };
    const out = applyCondemnation(decision(), old);
    expect(out.risk).toBe("RUG");
    expect(out.flags[0].label).toContain("2023-01-15");
  });

  it("a record without evidence still holds, with a flag that needs no reason", () => {
    const out = applyCondemnation(decision(), { ...entry, evidence: [] });
    expect(out.risk).toBe("RUG");
    expect(out.flags[0].label).toBe("Flagged as a rug on 2026-06-03 — a token that has rugged stays flagged");
  });

  it("the log note says what the data said before it was held", () => {
    const out = applyCondemnation(decision({ risk: "SAFE", score: 950 }), entry);
    expect(out.notes.at(-1)).toEqual({ message: "condemned token held at RUG", data: { wasRisk: "SAFE", wasScore: 950, condemnedAt: FLAGGED_AT } });
  });

  it("a token that is not condemned comes back untouched (same object)", () => {
    const d = decision({ risk: "SAFE" });
    expect(applyCondemnation(d, null)).toBe(d);
  });

  it("a token that already reads RUG PULL comes back untouched: no second flag", () => {
    const d = decision({ risk: "RUG", rugKind: "confirmed", score: 60 });
    expect(applyCondemnation(d, entry)).toBe(d);
  });

  it("the input is not modified", () => {
    const d = decision({ risk: "SAFE" });
    applyCondemnation(d, entry);
    expect(d.risk).toBe("SAFE");
    expect(d.flags).toEqual([]);
  });
});

describe("shouldCondemn: only a rug proven by a fact, on complete data, from production", () => {
  const base = { risk: "RUG" as const, rugKind: "confirmed" as const, degraded: false, preview: false };

  it("a RUG PULL on complete data condemns", () => expect(shouldCondemn(base)).toBe(true));

  it("a RUG RISK (structure only: concentration, authorities, a young token) does not: it is a risk, and it can honestly go away", () => {
    expect(shouldCondemn({ ...base, rugKind: "risk" })).toBe(false);
    expect(shouldCondemn({ ...base, rugKind: null })).toBe(false);
  });

  it.each(["SAFE", "CAUTION", "DANGER"] as const)("a %s never condemns", (risk) => {
    expect(shouldCondemn({ ...base, risk, rugKind: null })).toBe(false);
  });

  it("a scan that ran out of time or had no source does not condemn: the data was not there", () => {
    expect(shouldCondemn({ ...base, degraded: true })).toBe(false);
  });

  it("a preview deployment does not condemn: it shares the database with production", () => {
    expect(shouldCondemn({ ...base, preview: true })).toBe(false);
  });
});

describe("condemnedEntryOf: the record keeps the critical flags that said it", () => {
  it("at most three, critical only, in the order shown", () => {
    const flags = [
      { label: "a", severity: "critical" as const, impact: 0 }, { label: "w", severity: "warning" as const, impact: 0 },
      { label: "b", severity: "critical" as const, impact: 0 }, { label: "c", severity: "critical" as const, impact: 0 },
      { label: "d", severity: "critical" as const, impact: 0 },
    ];
    const e = condemnedEntryOf({ flags }, MINT, "GONE", 123);
    expect(e).toEqual({ mint: MINT, symbol: "GONE", condemnedAt: 123, evidence: ["a", "b", "c"] });
  });
});

// A fake Upstash with the two commands the store uses: GET, and SET with NX (the first record wins).
function fakeRedis() {
  const data = new Map<string, unknown>();
  const sets: Array<{ key: string; opts: Record<string, unknown> | undefined }> = [];
  const r = {
    get: vi.fn(async (k: string) => data.get(k) ?? null),
    set: vi.fn(async (k: string, v: unknown, opts?: Record<string, unknown>) => {
      sets.push({ key: k, opts });
      if (opts?.nx && data.has(k)) return null;
      data.set(k, v);
      return "OK";
    }),
  };
  return { r, data, sets };
}

describe("the store: kept for good, first record wins, a failure never changes a verdict", () => {
  beforeEach(() => initCondemned(undefined as unknown as Redis));

  it("without Redis: nobody is condemned, and condemning does nothing", async () => {
    expect(await getCondemned(MINT)).toBeNull();
    await expect(condemn(entry)).resolves.toBeUndefined();
  });

  it("writes under condemned:<mint> with no expiry", async () => {
    const f = fakeRedis();
    initCondemned(f.r as unknown as Redis);
    await condemn(entry);
    expect(f.sets).toHaveLength(1);
    expect(f.sets[0].key).toBe(`condemned:${MINT}`);
    expect(f.sets[0].opts).toEqual({ nx: true }); // no `ex`, no `px`: it never expires
    expect(await getCondemned(MINT)).toEqual(entry);
  });

  it("a second flag does not move the date of the first", async () => {
    const f = fakeRedis();
    initCondemned(f.r as unknown as Redis);
    await condemn(entry);
    await condemn({ ...entry, condemnedAt: FLAGGED_AT + 90 * 24 * 3600 * 1000, evidence: ["later"] });
    expect((await getCondemned(MINT))?.condemnedAt).toBe(FLAGGED_AT);
    expect((await getCondemned(MINT))?.evidence).toEqual(entry.evidence);
  });

  it("a token that was never condemned is null; a value that is not a record is null", async () => {
    const f = fakeRedis();
    initCondemned(f.r as unknown as Redis);
    expect(await getCondemned("Other")).toBeNull();
    f.data.set("condemned:Junk", "oops");
    expect(await getCondemned("Junk")).toBeNull();
  });

  it("Redis failing: reading gives 'not condemned', writing stays silent", async () => {
    const boom = { get: vi.fn().mockRejectedValue(new Error("down")), set: vi.fn().mockRejectedValue(new Error("down")) };
    initCondemned(boom as unknown as Redis);
    expect(await getCondemned(MINT)).toBeNull();
    await expect(condemn(entry)).resolves.toBeUndefined();
  });
});
