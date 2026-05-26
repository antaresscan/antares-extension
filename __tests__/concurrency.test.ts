// __tests__/concurrency.test.ts
//
// Pins the contract of `runWithConcurrency` — the helper that caps
// simultaneous in-flight promises when fanning out Helius RPC calls in
// insider-graph + insider-activity. Pre-launch hardening (audit J+7).

import { describe, it, expect } from "vitest";
import { runWithConcurrency } from "../api/_lib/concurrency";

describe("runWithConcurrency", () => {
  it("returns results in input order regardless of completion order", async () => {
    // Items resolve in reverse order — item[0] sleeps longest, item[4]
    // resolves first — but the result array must mirror the input.
    const out = await runWithConcurrency(
      [40, 30, 20, 10, 5],
      3,
      async (ms) => {
        await new Promise((r) => setTimeout(r, ms));
        return ms;
      },
    );
    expect(out).toEqual([40, 30, 20, 10, 5]);
  });

  it("never exceeds the concurrency limit at any moment", async () => {
    let inFlight = 0;
    let peak = 0;
    await runWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      5,
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
      },
    );
    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBeGreaterThan(1); // sanity — not serial
  });

  it("handles empty input array", async () => {
    const out = await runWithConcurrency([], 5, async () => "x");
    expect(out).toEqual([]);
  });

  it("clamps limit ≥ 1 even when caller passes 0 or negative", async () => {
    const out = await runWithConcurrency(["a", "b"], 0, async (x) => x);
    expect(out).toEqual(["a", "b"]);
  });

  it("passes the index to the worker function", async () => {
    const out = await runWithConcurrency(
      ["x", "y", "z"],
      2,
      async (_item, i) => i,
    );
    expect(out).toEqual([0, 1, 2]);
  });

  it("rejects when one item's promise rejects (no swallow)", async () => {
    await expect(
      runWithConcurrency(["a", "b", "c"], 2, async (item) => {
        if (item === "b") throw new Error("boom");
        return item;
      }),
    ).rejects.toThrow("boom");
  });
});
