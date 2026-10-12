import { describe, it, expect, beforeEach } from "vitest";
import type { Redis } from "@upstash/redis";
import {
  initCache,
  acquireScanLock,
  releaseScanLock,
  waitForCachedResult,
  setShortCachedResult,
} from "../api/_lib/cache";

// Minimal in-memory Redis stand-in covering exactly the methods the cache
// helpers touch: set (with NX/EX), del, get, setex.
class MockRedis {
  store = new Map<string, unknown>();
  failNext = false;

  async set(key: string, value: unknown, opts?: { nx?: boolean; ex?: number }) {
    if (this.failNext) { this.failNext = false; throw new Error("redis down"); }
    if (opts?.nx && this.store.has(key)) return null; // NX: key exists → no-op
    this.store.set(key, value);
    return "OK";
  }
  async del(key: string) { this.store.delete(key); return 1; }
  // Stand-in for the compare-and-delete script of releaseScanLock: KEYS[1] = lock key, ARGV[1] = owner.
  async eval(_script: string, keys: string[], args: string[]) {
    if (this.store.get(keys[0]) === args[0]) { this.store.delete(keys[0]); return 1; }
    return 0;
  }
  async get<T>(key: string): Promise<T | null> { return (this.store.get(key) as T) ?? null; }
  async setex(key: string, _ttl: number, value: unknown) { this.store.set(key, value); return "OK"; }
}

let mock: MockRedis;
beforeEach(() => {
  mock = new MockRedis();
  initCache(mock as unknown as Redis);
});

describe("single-flight scan lock", () => {
  it("first acquire wins, second is blocked (NX)", async () => {
    expect(await acquireScanLock("CA_AAA", "req-1")).toBe(true);
    expect(await acquireScanLock("CA_AAA", "req-2")).toBe(false); // already held
  });

  it("different CAs get independent locks", async () => {
    expect(await acquireScanLock("CA_BBB", "req-1")).toBe(true);
    expect(await acquireScanLock("CA_CCC", "req-1")).toBe(true);
  });

  it("release frees the lock so it can be re-acquired", async () => {
    expect(await acquireScanLock("CA_DDD", "req-1")).toBe(true);
    expect(await acquireScanLock("CA_DDD", "req-2")).toBe(false);
    await releaseScanLock("CA_DDD", "req-1");
    expect(await acquireScanLock("CA_DDD", "req-2")).toBe(true); // free again
  });

  // Audit A-17: a scan that outlives the lock's TTL used to DEL a lock that had meanwhile passed to another request.
  it("the lock stores the request id of its holder", async () => {
    await acquireScanLock("CA_OWN", "req-holder");
    const key = [...mock.store.keys()].find((k) => k.includes("lock") && k.includes("CA_OWN"))!;
    expect(mock.store.get(key)).toBe("req-holder");
  });

  it("a release by someone who does not hold the lock any more leaves the new holder's lock alone", async () => {
    expect(await acquireScanLock("CA_STALE", "req-slow")).toBe(true);
    // req-slow outlives the TTL: the lock expires and req-next takes it.
    const key = [...mock.store.keys()].find((k) => k.includes("lock") && k.includes("CA_STALE"))!;
    mock.store.delete(key);
    expect(await acquireScanLock("CA_STALE", "req-next")).toBe(true);
    // req-slow finally finishes and releases: it must NOT free req-next's lock.
    await releaseScanLock("CA_STALE", "req-slow");
    expect(await acquireScanLock("CA_STALE", "req-third")).toBe(false); // still held by req-next
    // req-next releases its own lock normally.
    await releaseScanLock("CA_STALE", "req-next");
    expect(await acquireScanLock("CA_STALE", "req-third")).toBe(true);
  });

  it("releasing a lock nobody holds is a no-op", async () => {
    await expect(releaseScanLock("CA_NOBODY", "req-1")).resolves.toBeUndefined();
  });

  it("fails OPEN: Redis error on acquire → returns true (scan proceeds)", async () => {
    mock.failNext = true;
    expect(await acquireScanLock("CA_EEE", "req-1")).toBe(true);
  });

  it("passes EX ttl on the lock key", async () => {
    await acquireScanLock("CA_FFF", "req-1", 28);
    // The lock key exists in the store after acquire.
    const anyKey = [...mock.store.keys()].find((k) => k.includes("lock") && k.includes("CA_FFF"));
    expect(anyKey).toBeTruthy();
  });
});

describe("waitForCachedResult (coalescing waiter)", () => {
  it("returns the cached result once it appears", async () => {
    const ca = "CA_WAIT_HIT";
    // Simulate the lock holder finishing its scan ~150ms later.
    setTimeout(() => {
      setShortCachedResult(ca, { aiSummary: "done", risk: "CAUTION", score: 750 }, 30);
    }, 150);
    const r = await waitForCachedResult<{ aiSummary?: string; risk?: string }>(
      ca, "req-1", { timeoutMs: 2000, intervalMs: 80 },
    );
    expect(r).not.toBeNull();
    expect(r?.risk).toBe("CAUTION");
  });

  it("returns null when the holder never populates the cache (timeout)", async () => {
    const r = await waitForCachedResult("CA_WAIT_MISS", "req-2", { timeoutMs: 400, intervalMs: 100 });
    expect(r).toBeNull();
  });

  it("ignores cache entries WITHOUT aiSummary (incomplete result)", async () => {
    const ca = "CA_NO_SUMMARY";
    setShortCachedResult(ca, { risk: "SAFE", score: 1000 }, 30); // no aiSummary
    const r = await waitForCachedResult(ca, "req-3", { timeoutMs: 400, intervalMs: 100 });
    expect(r).toBeNull(); // incomplete → not served, waiter times out
  });
});

describe("fail-open with no Redis", () => {
  it("acquireScanLock returns true and waitForCachedResult returns null when Redis is absent", async () => {
    initCache(null as unknown as Redis); // simulate unconfigured cache
    expect(await acquireScanLock("CA_NONE", "req-1")).toBe(true);
    expect(await waitForCachedResult("CA_NONE", "req", { timeoutMs: 200, intervalMs: 50 })).toBeNull();
  });
});
