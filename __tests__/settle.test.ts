// __tests__/settle.test.ts
//
// settleWithin waits for the writes that remember a RUG, but never for long and never with an error: a slow or dead Redis cannot hold an
// answer that is ready, and a failed write cannot break it.
import { describe, it, expect } from "vitest";
import { settleWithin } from "../api/_lib/settle";

describe("settleWithin", () => {
  it("returns at once when there is nothing to wait for", async () => {
    const t0 = Date.now();
    await settleWithin([], 1000);
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it("waits until every write has settled", async () => {
    let done = 0;
    const slow = (ms: number) => new Promise<void>((r) => setTimeout(() => { done++; r(); }, ms));
    await settleWithin([slow(30), slow(60)], 1000);
    expect(done).toBe(2);
  });

  it("gives up after the delay when a write never settles, without an error", async () => {
    const t0 = Date.now();
    await expect(settleWithin([new Promise(() => {})], 120)).resolves.toBeUndefined();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(1000);
  });

  it("never rejects: a failed write is the writer's business", async () => {
    await expect(settleWithin([Promise.reject(new Error("redis down")), Promise.resolve(1)], 500)).resolves.toBeUndefined();
  });

  it("accepts entries that are not promises (a mocked writer returns nothing)", async () => {
    await expect(settleWithin([undefined, 42], 500)).resolves.toBeUndefined();
  });

  it("leaves no timer behind once the writes are done", async () => {
    const t0 = Date.now();
    await settleWithin([Promise.resolve()], 5000);
    expect(Date.now() - t0).toBeLessThan(200); // would be 5 s if the delay were always waited
  });
});
