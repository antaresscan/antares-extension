// __tests__/audit-lot14.test.ts — Lot 14 of the file-by-file audit (2026-10-17): api/_lib/constants.ts, helpers.ts.
// Fails on the previous code.
import { describe, it, expect, vi, afterEach } from "vitest";
import { withBudget } from "../api/_lib/helpers";

afterEach(() => { vi.useRealTimers(); });

describe("withBudget — no timer left armed once the race is decided", () => {
  it("a promise that answers before its budget leaves no pending timer (one stayed armed for the whole budget)", async () => {
    vi.useFakeTimers();
    const out = await withBudget(Promise.resolve(42), 9_000);
    expect(out).toBe(42);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the budget still wins against a promise that never answers", async () => {
    vi.useFakeTimers();
    const pending = withBudget(new Promise<number>(() => undefined), 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
