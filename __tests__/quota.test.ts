import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Redis } from "@upstash/redis";
import type { VercelResponse } from "@vercel/node";
import {
  initQuota,
  checkDailyQuota,
  peekDailyQuota,
  setQuotaHeaders,
  secondsUntilReset,
  getResetAt,
  getUtcDateKey,
  _resetQuotaForTests,
} from "../api/_lib/quota";
import { initUserStorage, _resetUserStorageForTests } from "../api/_lib/user";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockRes(): VercelResponse {
  return {
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as VercelResponse;
}

interface MockRedisStore {
  tier?: Record<string, string>;
  counter?: Record<string, number>;
  /** When set, all calls reject with this error. Used for fail-open tests. */
  fail?: boolean;
}

function mockRedis(store: MockRedisStore = {}): Redis {
  const tier = store.tier ?? {};
  const counter = store.counter ?? {};
  return {
    get: vi.fn(async (key: string) => {
      if (store.fail) throw new Error("redis down");
      if (key.startsWith("user:") && key.endsWith(":tier")) {
        const id = key.slice("user:".length, -":tier".length);
        return tier[id] ?? null;
      }
      if (key.startsWith("quota:")) {
        return counter[key] ?? null;
      }
      return null;
    }),
    incr: vi.fn(async (key: string) => {
      if (store.fail) throw new Error("redis down");
      counter[key] = (counter[key] ?? 0) + 1;
      return counter[key];
    }),
    expire: vi.fn(async () => 1),
  } as unknown as Redis;
}

beforeEach(() => {
  _resetQuotaForTests();
  _resetUserStorageForTests();
});

// ─── getResetAt ───────────────────────────────────────────────────────────────

describe("getResetAt", () => {
  it("returns next 00:00 UTC for an afternoon date", () => {
    const noon = new Date(Date.UTC(2026, 4, 1, 12, 0, 0));
    const reset = getResetAt(noon);
    expect(reset).toBe(Date.UTC(2026, 4, 2, 0, 0, 0, 0));
  });

  it("returns next day 00:00 even one millisecond before midnight", () => {
    const justBefore = new Date(Date.UTC(2026, 4, 1, 23, 59, 59, 999));
    const reset = getResetAt(justBefore);
    expect(reset).toBe(Date.UTC(2026, 4, 2, 0, 0, 0, 0));
  });

  it("crosses month boundary correctly", () => {
    const lastDay = new Date(Date.UTC(2026, 4, 31, 22, 0, 0));
    const reset = getResetAt(lastDay);
    expect(reset).toBe(Date.UTC(2026, 5, 1, 0, 0, 0, 0));
  });
});

// ─── getUtcDateKey ────────────────────────────────────────────────────────────

describe("getUtcDateKey", () => {
  it("formats date as YYYY-MM-DD in UTC", () => {
    expect(getUtcDateKey(new Date(Date.UTC(2026, 4, 1, 12, 0, 0)))).toBe("2026-05-01");
  });

  it("handles single-digit months and days with zero padding", () => {
    expect(getUtcDateKey(new Date(Date.UTC(2026, 0, 5, 0, 0, 0)))).toBe("2026-01-05");
  });
});

// ─── checkDailyQuota — no Redis ───────────────────────────────────────────────

describe("checkDailyQuota — without Redis", () => {
  it("returns unlimited Free result when Redis is not initialised", async () => {
    // Post-2026-05: every tier is unlimited, so without Redis we still
    // hand back an unlimited Free result.
    const result = await checkDailyQuota("install-abc");
    expect(result.allowed).toBe(true);
    expect(result.tier).toBe("free");
    expect(result.limit).toBe(-1);
    expect(result.remaining).toBe(-1);
  });
});

// ─── checkDailyQuota — Pro / Lifetime ─────────────────────────────────────────

describe("checkDailyQuota — paid tiers", () => {
  it("returns unlimited result for Pro tier without touching the counter", async () => {
    const redis = mockRedis({ tier: { "install-pro": "pro" } });
    initQuota(redis);
    initUserStorage(redis);

    const result = await checkDailyQuota("install-pro");

    expect(result.tier).toBe("pro");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(-1);
    expect(result.limit).toBe(-1);
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it("returns unlimited result for Lifetime tier", async () => {
    const redis = mockRedis({ tier: { "install-lifetime": "lifetime" } });
    initQuota(redis);
    initUserStorage(redis);

    const result = await checkDailyQuota("install-lifetime");

    expect(result.tier).toBe("lifetime");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(-1);
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it("treats unknown tier values as Free (still unlimited, just labelled free)", async () => {
    const redis = mockRedis({ tier: { "install-x": "premium-plus-ultra" } });
    initQuota(redis);
    initUserStorage(redis);

    const result = await checkDailyQuota("install-x");

    expect(result.tier).toBe("free");
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(-1);
  });
});

// ─── checkDailyQuota — Free tier (now unlimited) ──────────────────────────────

describe("checkDailyQuota — Free tier", () => {
  it("returns unlimited result on first scan", async () => {
    const redis = mockRedis();
    initQuota(redis);
    initUserStorage(redis);

    const result = await checkDailyQuota("install-fresh");

    expect(result.allowed).toBe(true);
    expect(result.tier).toBe("free");
    expect(result.limit).toBe(-1);
    expect(result.remaining).toBe(-1);
  });

  it("never denies, regardless of how many scans land in a day", async () => {
    const counter: Record<string, number> = {};
    const redis = mockRedis({ counter });
    initQuota(redis);
    initUserStorage(redis);

    // 200 scans in a day all succeed — feature gating remains in the
    // overlay (Pro-locked panels), but quota itself never blocks Free.
    for (let i = 1; i <= 200; i++) {
      const result = await checkDailyQuota("install-heavy");
      expect(result.allowed).toBe(true);
      expect(result.tier).toBe("free");
      expect(result.limit).toBe(-1);
    }
  });

  it("no longer increments any per-day counter (decommissioned 2026-05-11)", async () => {
    // The free-tier daily counter used to fire 1–2 Redis commands per
    // scan (INCR plus EXPIRE on first scan of the UTC day) for a
    // metric no production code consumed — quota gating was removed
    // when all tiers became unlimited. The Upstash-budget audit on
    // 2026-05-11 deleted the writer. This test pins the new
    // behaviour: ZERO Redis ops for the counter, regardless of tier.
    const redis = mockRedis();
    initQuota(redis);
    initUserStorage(redis);

    await checkDailyQuota("install-counted");
    await new Promise((r) => setTimeout(r, 0));

    expect(redis.incr).not.toHaveBeenCalled();
    expect(redis.expire).not.toHaveBeenCalled();
  });

  it("does not increment for paid tiers (Pro/Lifetime are unlimited up-front)", async () => {
    const redis = mockRedis({ tier: { "install-pro": "pro" } });
    initQuota(redis);
    initUserStorage(redis);

    await checkDailyQuota("install-pro");

    expect(redis.incr).not.toHaveBeenCalled();
  });

  it("does not bucket anonymous traffic separately (counter decommissioned)", async () => {
    // Pre-2026-05-11 the function created a `quota:anonymous:<day>`
    // bucket when identityKey was null. With the counter gone there's
    // no bucket to inspect — assert ZERO INCRs regardless of identity.
    const counter: Record<string, number> = {};
    const redis = mockRedis({ counter });
    initQuota(redis);
    initUserStorage(redis);

    await checkDailyQuota(null);
    await checkDailyQuota(null);
    await new Promise((r) => setTimeout(r, 0));

    expect(Object.keys(counter).length).toBe(0);
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it("does not isolate buckets across install ids (counter decommissioned)", async () => {
    const counter: Record<string, number> = {};
    const redis = mockRedis({ counter });
    initQuota(redis);
    initUserStorage(redis);

    await checkDailyQuota("install-a");
    await checkDailyQuota("install-b");
    await new Promise((r) => setTimeout(r, 0));

    // Both install-a and install-b are unlimited Free; neither writes
    // to the counter any more, so the counter remains empty.
    expect(Object.keys(counter).length).toBe(0);
  });
});

// ─── checkDailyQuota — fail-open ──────────────────────────────────────────────

describe("checkDailyQuota — fail-open on Redis errors", () => {
  it("still returns unlimited Free result when INCR throws (counter is best-effort)", async () => {
    const redis = mockRedis({ fail: true });
    initQuota(redis);
    initUserStorage(redis);

    const result = await checkDailyQuota("install-broken");

    // INCR failures don't change the answer — every tier is unlimited.
    expect(result.allowed).toBe(true);
    expect(result.tier).toBe("free");
    expect(result.limit).toBe(-1);
  });
});

// ─── peekDailyQuota ───────────────────────────────────────────────────────────

describe("peekDailyQuota — read-only", () => {
  it("returns unlimited Free result without Redis", async () => {
    const result = await peekDailyQuota("install-x");
    expect(result.allowed).toBe(true);
    expect(result.tier).toBe("free");
    expect(result.limit).toBe(-1);
  });

  it("does NOT increment the counter", async () => {
    const counter: Record<string, number> = {};
    const redis = mockRedis({ counter });
    initQuota(redis);
    initUserStorage(redis);

    await peekDailyQuota("install-peek");
    await peekDailyQuota("install-peek");
    await peekDailyQuota("install-peek");

    expect(redis.incr).not.toHaveBeenCalled();
    expect(Object.keys(counter).length).toBe(0);
  });

  it("returns unlimited regardless of stored counter value (Free is now uncapped)", async () => {
    const today = getUtcDateKey();
    const counter: Record<string, number> = {
      [`quota:install-mid:${today}`]: 12,
    };
    const redis = mockRedis({ counter });
    initQuota(redis);
    initUserStorage(redis);

    const result = await peekDailyQuota("install-mid");

    expect(result.allowed).toBe(true);
    expect(result.tier).toBe("free");
    expect(result.limit).toBe(-1);
  });

  it("returns unlimited result for Pro tier", async () => {
    const redis = mockRedis({ tier: { "install-pro": "pro" } });
    initQuota(redis);
    initUserStorage(redis);

    const result = await peekDailyQuota("install-pro");

    expect(result.tier).toBe("pro");
    expect(result.remaining).toBe(-1);
  });

  it("falls open when Redis throws", async () => {
    const redis = mockRedis({ fail: true });
    initQuota(redis);
    initUserStorage(redis);

    const result = await peekDailyQuota("install-broken");

    expect(result.allowed).toBe(true);
    expect(result.tier).toBe("free");
  });
});

// ─── setQuotaHeaders ──────────────────────────────────────────────────────────

describe("setQuotaHeaders", () => {
  it("sets all 5 quota response headers", () => {
    const res = mockRes();
    setQuotaHeaders(res, {
      allowed: true,
      used: 12,
      remaining: 38,
      limit: 50,
      resetAt: 1714603199999,
      tier: "free",
    });

    expect(res.setHeader).toHaveBeenCalledWith("X-Antares-Quota-Tier", "free");
    expect(res.setHeader).toHaveBeenCalledWith("X-Antares-Quota-Limit", "50");
    expect(res.setHeader).toHaveBeenCalledWith("X-Antares-Quota-Used", "12");
    expect(res.setHeader).toHaveBeenCalledWith("X-Antares-Quota-Remaining", "38");
    expect(res.setHeader).toHaveBeenCalledWith("X-Antares-Quota-Reset", "1714603199999");
  });

  it("encodes -1 as remaining and limit for unlimited tiers", () => {
    const res = mockRes();
    setQuotaHeaders(res, {
      allowed: true,
      used: 0,
      remaining: -1,
      limit: -1,
      resetAt: 0,
      tier: "pro",
    });

    expect(res.setHeader).toHaveBeenCalledWith("X-Antares-Quota-Tier", "pro");
    expect(res.setHeader).toHaveBeenCalledWith("X-Antares-Quota-Limit", "-1");
    expect(res.setHeader).toHaveBeenCalledWith("X-Antares-Quota-Remaining", "-1");
  });
});

// ─── secondsUntilReset ────────────────────────────────────────────────────────

describe("secondsUntilReset", () => {
  it("returns positive seconds until reset", () => {
    const oneHourFromNow = Date.now() + 60 * 60 * 1000;
    const seconds = secondsUntilReset({
      allowed: false,
      used: 50,
      remaining: 0,
      limit: 50,
      resetAt: oneHourFromNow,
      tier: "free",
    });
    expect(seconds).toBeGreaterThanOrEqual(3590);
    expect(seconds).toBeLessThanOrEqual(3601);
  });

  it("returns at least 1 even if resetAt is in the past", () => {
    const seconds = secondsUntilReset({
      allowed: false,
      used: 50,
      remaining: 0,
      limit: 50,
      resetAt: Date.now() - 1000,
      tier: "free",
    });
    expect(seconds).toBe(1);
  });

  it("returns 1 for unlimited tiers (resetAt = 0)", () => {
    const seconds = secondsUntilReset({
      allowed: true,
      used: 0,
      remaining: -1,
      limit: -1,
      resetAt: 0,
      tier: "pro",
    });
    expect(seconds).toBe(1);
  });
});
