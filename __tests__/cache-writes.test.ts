// __tests__/cache-writes.test.ts
//
// setCachedResult / setShortCachedResult used to fire their Redis write and return nothing, so the caller could not hand it to
// waitUntil. They now RETURN the write's promise, which resolves once it has landed and never rejects (a failed write is logged).
import { describe, it, expect, vi, beforeEach } from "vitest";

const warn = vi.fn();
vi.mock("../api/_lib/logger", () => ({
  logger: { info: vi.fn(), warn: (...a: unknown[]) => warn(...a), error: vi.fn() },
}));

import { initCache, setCachedResult, setShortCachedResult } from "../api/_lib/cache";

const fakeRedis = (setex: (...a: unknown[]) => Promise<unknown>) => ({ setex: vi.fn(setex) }) as unknown as Parameters<typeof initCache>[0] & { setex: ReturnType<typeof vi.fn> };

beforeEach(() => warn.mockReset());

describe("cache writers return their write", () => {
  it("setCachedResult resolves only once Redis has answered", async () => {
    let answer!: () => void;
    const redis = fakeRedis(() => new Promise((resolve) => { answer = () => resolve("OK"); }));
    initCache(redis);
    let landed = false;
    const write = setCachedResult("MINT", { a: 1 }, 60 * 24 * 10, "SAFE").then(() => { landed = true; });
    await Promise.resolve();
    expect(landed).toBe(false);
    expect((redis as unknown as { setex: ReturnType<typeof vi.fn> }).setex).toHaveBeenCalledTimes(1);
    answer();
    await write;
    expect(landed).toBe(true);
  });

  it("setShortCachedResult writes with the given TTL and resolves", async () => {
    const redis = fakeRedis(async () => "OK");
    initCache(redis);
    await expect(setShortCachedResult("MINT", { a: 1 }, 30)).resolves.toBeUndefined();
    const call = (redis as unknown as { setex: ReturnType<typeof vi.fn> }).setex.mock.calls[0];
    expect(call[1]).toBe(30);
  });

  it("a failed write is logged and the promise still resolves (the user already has an answer)", async () => {
    initCache(fakeRedis(async () => { throw new Error("upstash 500"); }));
    await expect(setCachedResult("MINT", {}, 100, "RUG")).resolves.toBeUndefined();
    await expect(setShortCachedResult("MINT", {}, 30)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("without Redis there is nothing to wait for", async () => {
    initCache(null as unknown as Parameters<typeof initCache>[0]);
    await expect(setCachedResult("MINT", {}, 100, "SAFE")).resolves.toBeUndefined();
    await expect(setShortCachedResult("MINT", {}, 30)).resolves.toBeUndefined();
  });
});
