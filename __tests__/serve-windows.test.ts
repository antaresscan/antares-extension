import { describe, it, expect } from "vitest";
import { staleWindowSec, serveWindows, withServeWindows, OVERLAY_FRESH_SEC, OVERLAY_FRESH_DEGRADED_SEC, STALE_MAX_MOVE_1H_PCT, type ServeWindowSource } from "../api/_lib/helpers";

// What the overlay may do with an answer it holds (api/_lib/helpers.ts, "What the overlay may do with an answer it holds"):
//   freshForSec  - reuse it without asking again;  staleLeftSec - still show it, marked as old, when the scanner cannot be reached.
// A stale bad verdict is safe (a token not bought); a stale good one is not (a token can rug in the window): the window depends on the verdict
// and, for SAFE and CAUTION, on how old and how agitated the token is.

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOW = 1_800_000_000_000;

/** A verdict made `ageMs` ago for a token that is `tokenAgeMs` old. */
const src = (over: Partial<ServeWindowSource> & { tokenAgeMs?: number | null } = {}): ServeWindowSource => {
  const { tokenAgeMs = 400 * DAY, ...rest } = over;
  return {
    risk: "SAFE", rugKind: null, degraded: false,
    pairCreatedAt: tokenAgeMs === null ? null : NOW - tokenAgeMs, solscanTokenAgeHours: null,
    priceChange1h: 1, fetchedAt: NOW, ...rest,
  };
};

describe("staleWindowSec: how long an old verdict may still be shown when the scanner cannot be reached", () => {
  it("a RUG confirmed by a fact: 24 h; a RUG as a risk: 2 h; a DANGER: 1 h — whatever the age of the token", () => {
    for (const tokenAgeMs of [null, 5 * MIN, 3 * DAY, 400 * DAY]) {
      expect(staleWindowSec(src({ risk: "RUG", rugKind: "confirmed", tokenAgeMs }))).toBe(24 * 3600);
      expect(staleWindowSec(src({ risk: "RUG", rugKind: "risk", tokenAgeMs }))).toBe(2 * 3600);
      expect(staleWindowSec(src({ risk: "RUG", rugKind: null, tokenAgeMs }))).toBe(2 * 3600); // an answer cached before rugKind existed: the weaker claim
      expect(staleWindowSec(src({ risk: "DANGER", tokenAgeMs }))).toBe(3600);
    }
  });

  it("SAFE and CAUTION: by the age of the token — never under 1 h or unknown, then 3 min, 10 min, 20 min, 45 min", () => {
    for (const risk of ["SAFE", "CAUTION"] as const) {
      expect(staleWindowSec(src({ risk, tokenAgeMs: null }))).toBe(0);
      expect(staleWindowSec(src({ risk, tokenAgeMs: 59 * MIN }))).toBe(0);
      expect(staleWindowSec(src({ risk, tokenAgeMs: 60 * MIN }))).toBe(180);
      expect(staleWindowSec(src({ risk, tokenAgeMs: 23 * 60 * MIN }))).toBe(180);
      expect(staleWindowSec(src({ risk, tokenAgeMs: 1 * DAY }))).toBe(600);
      expect(staleWindowSec(src({ risk, tokenAgeMs: 6 * DAY }))).toBe(600);
      expect(staleWindowSec(src({ risk, tokenAgeMs: 7 * DAY }))).toBe(1200);
      expect(staleWindowSec(src({ risk, tokenAgeMs: 29 * DAY }))).toBe(1200);
      expect(staleWindowSec(src({ risk, tokenAgeMs: 30 * DAY }))).toBe(2700);
      expect(staleWindowSec(src({ risk, tokenAgeMs: 900 * DAY }))).toBe(2700);
    }
  });

  it("the window never shrinks as the token gets older, for a good verdict (monotonic)", () => {
    let last = -1;
    for (let hours = 0; hours <= 24 * 90; hours += 1) {
      const w = staleWindowSec(src({ risk: "SAFE", tokenAgeMs: hours * 60 * MIN }));
      expect(w).toBeGreaterThanOrEqual(last);
      last = w;
    }
  });

  it("the age is the younger of the pool (DexScreener) and the creation (Solscan): an old token with a new pool is treated as young", () => {
    expect(staleWindowSec(src({ tokenAgeMs: 30 * MIN, solscanTokenAgeHours: 24 * 400 }))).toBe(0);
    expect(staleWindowSec(src({ tokenAgeMs: 400 * DAY, solscanTokenAgeHours: 0.5 }))).toBe(0);
    expect(staleWindowSec(src({ tokenAgeMs: null, solscanTokenAgeHours: 24 * 400 }))).toBe(2700);
    expect(staleWindowSec(src({ tokenAgeMs: 400 * DAY, solscanTokenAgeHours: 24 * 400 }))).toBe(2700);
  });

  it("a SAFE or CAUTION on a token that moved 25 % or more in the last hour (up or down) is never shown stale; a bad verdict is", () => {
    for (const priceChange1h of [-STALE_MAX_MOVE_1H_PCT, STALE_MAX_MOVE_1H_PCT, -80, 300]) {
      expect(staleWindowSec(src({ risk: "SAFE", priceChange1h }))).toBe(0);
      expect(staleWindowSec(src({ risk: "CAUTION", priceChange1h }))).toBe(0);
      expect(staleWindowSec(src({ risk: "DANGER", priceChange1h }))).toBe(3600);
    }
    for (const priceChange1h of [24.9, -24.9, 0, null]) expect(staleWindowSec(src({ risk: "SAFE", priceChange1h }))).toBe(2700);
  });

  it("a degraded answer: never stale as SAFE or CAUTION; a bad one at most 10 min (it may be a false alarm born from missing data)", () => {
    expect(staleWindowSec(src({ risk: "SAFE", degraded: true }))).toBe(0);
    expect(staleWindowSec(src({ risk: "CAUTION", degraded: true }))).toBe(0);
    expect(staleWindowSec(src({ risk: "DANGER", degraded: true }))).toBe(600);
    expect(staleWindowSec(src({ risk: "RUG", rugKind: "risk", degraded: true }))).toBe(600);
    expect(staleWindowSec(src({ risk: "RUG", rugKind: "confirmed", degraded: true }))).toBe(600);
  });

  it("a stale SAFE is never allowed longer than a stale bad verdict (the asymmetry that makes it safe)", () => {
    for (const tokenAgeMs of [null, 2 * MIN, 3 * DAY, 400 * DAY]) {
      const good = staleWindowSec(src({ risk: "SAFE", tokenAgeMs }));
      for (const bad of [src({ risk: "DANGER", tokenAgeMs }), src({ risk: "RUG", rugKind: "risk", tokenAgeMs })]) expect(good).toBeLessThanOrEqual(staleWindowSec(bad));
    }
  });
});

describe("serveWindows: the two numbers sent with an answer", () => {
  it("a normal answer may be reused for 5 min; a degraded one for 30 s", () => {
    expect(serveWindows(src(), NOW).freshForSec).toBe(OVERLAY_FRESH_SEC);
    expect(OVERLAY_FRESH_SEC).toBe(300);
    expect(serveWindows(src({ degraded: true }), NOW).freshForSec).toBe(OVERLAY_FRESH_DEGRADED_SEC);
    expect(OVERLAY_FRESH_DEGRADED_SEC).toBe(30);
  });

  it("the stale window counts from the moment the verdict was MADE: an answer the server held 100 s has 100 s less", () => {
    expect(serveWindows(src({ fetchedAt: NOW }), NOW).staleLeftSec).toBe(2700);
    expect(serveWindows(src({ fetchedAt: NOW - 100_000 }), NOW).staleLeftSec).toBe(2600);
    expect(serveWindows(src({ fetchedAt: NOW - 2700_000 }), NOW).staleLeftSec).toBe(0);
    expect(serveWindows(src({ fetchedAt: NOW - 9999_000 }), NOW).staleLeftSec).toBe(0);
  });

  it("never negative, never fractional; an unknown time of verdict gives 0; a time a few seconds in the future never gives more than the full window", () => {
    expect(serveWindows(src({ fetchedAt: NaN as unknown as number }), NOW).staleLeftSec).toBe(0);
    expect(serveWindows(src({ fetchedAt: NOW + 5_000 }), NOW).staleLeftSec).toBe(2700);
    expect(Number.isInteger(serveWindows(src({ fetchedAt: NOW - 1234 }), NOW).staleLeftSec)).toBe(true);
  });

  it("withServeWindows returns a copy: the answer that is stored is not modified", () => {
    const stored = { ...src(), score: 900, flags: [] as unknown[] };
    const sent = withServeWindows(stored, NOW);
    expect(sent.freshForSec).toBe(300);
    expect(sent.staleLeftSec).toBe(2700);
    expect(sent.score).toBe(900);
    expect("freshForSec" in stored).toBe(false);
    expect("staleLeftSec" in stored).toBe(false);
  });
});
