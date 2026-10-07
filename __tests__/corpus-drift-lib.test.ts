// __tests__/corpus-drift-lib.test.ts
//
// The drift check used to scan the whole corpus every day on production, count
// failed captures as "stable", and exit 0 even when every scan had failed, so
// the workflow was green while measuring nothing. These helpers decide what a
// run reports; the I/O around them lives in scripts/corpus-drift-check.ts.
import { describe, it, expect } from "vitest";
import {
  EXIT_DRIFT,
  EXIT_OK,
  EXIT_UNRELIABLE,
  MAX_CAPTURE_FAILURE_RATE,
  evaluateDrift,
  isoWeek,
  pickSample,
} from "../scripts/corpus-drift-lib";

const entries = Array.from({ length: 10 }, (_, i) => `t${i}`);

describe("pickSample", () => {
  it("returns every entry when no size is given", () => {
    expect(pickSample(entries, null, 5)).toEqual(entries);
  });

  it("returns every entry when the size covers the whole list", () => {
    expect(pickSample(entries, 10, 3)).toEqual(entries);
    expect(pickSample(entries, 25, 3)).toEqual(entries);
  });

  it("ignores a size that is zero or negative instead of returning nothing", () => {
    expect(pickSample(entries, 0, 1)).toEqual(entries);
    expect(pickSample(entries, -4, 1)).toEqual(entries);
  });

  it("returns a window of the requested size", () => {
    expect(pickSample(entries, 4, 0)).toEqual(["t0", "t1", "t2", "t3"]);
    expect(pickSample(entries, 4, 1)).toEqual(["t4", "t5", "t6", "t7"]);
  });

  it("wraps around the end of the list", () => {
    expect(pickSample(entries, 4, 2)).toEqual(["t8", "t9", "t0", "t1"]);
  });

  it("is deterministic for a given rotation", () => {
    expect(pickSample(entries, 4, 7)).toEqual(pickSample(entries, 4, 7));
  });

  it("covers the whole list over enough rotations", () => {
    const seen = new Set<string>();
    for (let rotation = 0; rotation < Math.ceil(entries.length / 4); rotation++) {
      for (const e of pickSample(entries, 4, rotation)) seen.add(e);
    }
    expect(seen.size).toBe(entries.length);
  });

  it("copes with a negative rotation and an empty list", () => {
    expect(pickSample(entries, 4, -1)).toHaveLength(4);
    expect(pickSample([], 4, 3)).toEqual([]);
  });
});

describe("isoWeek", () => {
  it("numbers ordinary weeks", () => {
    expect(isoWeek(new Date("2026-10-07T12:00:00Z"))).toBe(41);
  });

  it("puts the first days of January in week 1 or in the last week of the previous year", () => {
    expect(isoWeek(new Date("2026-01-01T00:00:00Z"))).toBe(1);
    expect(isoWeek(new Date("2024-12-30T00:00:00Z"))).toBe(1);
    expect(isoWeek(new Date("2021-01-03T00:00:00Z"))).toBe(53);
  });
});

describe("evaluateDrift", () => {
  const base = { stable: 0, verdictChanges: 0, scoreDrifts: 0, failures: 0, noBaseline: 0 };

  it("passes when nothing moved", () => {
    const out = evaluateDrift({ ...base, stable: 20 }, 0.05);
    expect(out).toMatchObject({ comparable: 20, driftPct: 0, unreliableReason: null, exitCode: EXIT_OK });
  });

  it("reports drift above the threshold as a finding, not as a broken check", () => {
    const out = evaluateDrift({ ...base, stable: 15, verdictChanges: 3, scoreDrifts: 2 }, 0.05);
    expect(out.driftPct).toBeCloseTo(0.25, 5);
    expect(out.exitCode).toBe(EXIT_DRIFT);
  });

  it("does not fail at exactly the threshold", () => {
    expect(evaluateDrift({ ...base, stable: 95, verdictChanges: 5 }, 0.05).exitCode).toBe(EXIT_OK);
  });

  it("never reports drift when no threshold is set (manual runs)", () => {
    expect(evaluateDrift({ ...base, stable: 1, verdictChanges: 9 }, 0).exitCode).toBe(EXIT_OK);
  });

  it("measures drift over the compared entries, not over the failed ones", () => {
    // 4 of 20 compared entries drifted: 20%, whatever happened to the 2 failed captures.
    const out = evaluateDrift({ ...base, stable: 16, verdictChanges: 4, failures: 2 }, 0.05);
    expect(out.comparable).toBe(20);
    expect(out.driftPct).toBeCloseTo(0.2, 5);
    expect(out.exitCode).toBe(EXIT_DRIFT);
  });

  it("is unreliable, not green, when every capture failed", () => {
    const out = evaluateDrift({ ...base, failures: 100 }, 0.05);
    expect(out.exitCode).toBe(EXIT_UNRELIABLE);
    expect(out.driftPct).toBe(0);
    expect(out.unreliableReason).toMatch(/all 100 live captures failed/);
  });

  it("is unreliable when there was nothing to compare", () => {
    const out = evaluateDrift({ ...base, noBaseline: 12 }, 0.05);
    expect(out.exitCode).toBe(EXIT_UNRELIABLE);
    expect(out.unreliableReason).toMatch(/no entry had a fixture/);
  });

  it("is unreliable when too many captures failed, even if the rest looks calm", () => {
    const out = evaluateDrift({ ...base, stable: 7, failures: 3 }, 0.05);
    expect(out.exitCode).toBe(EXIT_UNRELIABLE);
    expect(out.unreliableReason).toMatch(/3 of 10 live captures failed/);
  });

  it("tolerates a few failed captures", () => {
    const failures = Math.floor(10 * MAX_CAPTURE_FAILURE_RATE);
    const out = evaluateDrift({ ...base, stable: 10 - failures, failures }, 0.05);
    expect(out.unreliableReason).toBeNull();
    expect(out.exitCode).toBe(EXIT_OK);
  });

  it("reports an unreliable check even when no threshold is set", () => {
    expect(evaluateDrift({ ...base, failures: 5 }, 0).exitCode).toBe(EXIT_UNRELIABLE);
  });

  it("keeps the three exit codes distinct, so the workflow can tell them apart", () => {
    expect(new Set([EXIT_OK, EXIT_DRIFT, EXIT_UNRELIABLE]).size).toBe(3);
  });
});
