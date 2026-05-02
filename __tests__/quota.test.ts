import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Redis } from "@upstash/redis";
import type { VercelResponse } from "@vercel/node";
import {
  FREE_TIER_DAILY_LIMIT,
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
  it("returns permissive Free result when Redis is not initialised", async () => {
    const result = await checkDailyQuota("install-abc");
    expect(result.allowed).toBe(true);
    expect(result.tier).toBe("free");
    expect(result.limit).toBe(FREE_TIER_DAILY_LIMIT);
    expect(result.remaining).toBe(FREE_TIER_DAILY_LIMIT);
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

  it("treats unknown tier values as Free", async () => {
    const redis = mockRedis({ tier: { "install-x": "premium-plus-ultra" } });
    initQuota(redis);
    initUserStorage(redis);

    const result = await checkDailyQuota("install-x");

    expect(result.tier).toBe("free");
    expect(redis.incr).toHaveBeenCalledOnce();
  });
});

// ─── checkDailyQuota — Free tier counting ─────────────────────────────────────

describe("checkDailyQuota — Free tier", () => {
  it("allows the first scan and returns remaining = limit-1", async () => {
    const redis = mockRedis();
    initQuota(redis);
    initUserStorage(redis);

    const result = await checkDailyQuota("install-fresh");

    expect(result.allowed).toBe(true);
    expect(result.used).toBe(1);
    expect(result.remaining).toBe(FREE_TIER_DAILY_LIMIT - 1);
    expect(result.tier).toBe("free");
  });

  it("allows up to the daily limit then denies", async () => {
    const counter: Record<string, number> = {};
    const redis = mockRedis({ counter });
    initQuota(redis);
    initUserStorage(redis);

    // First N scans (where N = FREE_TIER_DAILY_LIMIT) → all allowed
    for (let i = 1; i <= FREE_TIER_DAILY_LIMIT; i++) {
      const result = await checkDailyQuota("install-heavy");
      expect(result.allowed).toBe(true);
      expect(result.used).toBe(i);
    }

    // 51st scan → denied
    const denied = await checkDailyQuota("install-heavy");
    expect(denied.allowed).toBe(false);
    expect(denied.used).toBe(FREE_TIER_DAILY_LIMIT + 1);
    expect(denied.remaining).toBe(0);
  });

  it("sets TTL on the first INCR of the day only", async () => {
    const redis = mockRedis();
    initQuota(redis);
    initUserStorage(redis);

    await checkDailyQuota("install-ttl");
    await checkDailyQuota("install-ttl");
    await checkDailyQuota("install-ttl");

    expect(redis.expire).toHaveBeenCalledOnce();
  });

  it("uses anonymous bucket when identityKey is null", async () => {
    const counter: Record<string, number> = {};
    const redis = mockRedis({ counter });
    initQuota(redis);
    initUserStorage(redis);

    const r1 = await checkDailyQuota(null);
    const r2 = await checkDailyQuota(null);

    expect(r1.used).toBe(1);
    expect(r2.used).toBe(2);
    // Both should have hit the same anonymous key
    const keys = Object.keys(counter);
    expect(keys.length).toBe(1);
    expect(keys[0]).toContain("anonymous");
  });

  it("isolates buckets across distinct install ids", async () => {
    const counter: Record<string, number> = {};
    const redis = mockRedis({ counter });
    initQuota(redis);
    initUserStorage(redis);

    const a = await checkDailyQuota("install-a");
    const b = await checkDailyQuota("install-b");

    expect(a.used).toBe(1);
    expect(b.used).toBe(1);
    expect(Object.keys(counter).length).toBe(2);
  });
});

// ─── checkDailyQuota — fail-open ──────────────────────────────────────────────

describe("checkDailyQuota — fail-open on Redis errors", () => {
  it("returns permissive result when INCR throws", async () => {
    const redis = mockRedis({ fail: true });
    initQuota(redis);
    initUserStorage(redis);

    const result = await checkDailyQuota("install-broken");

    // Fail-open: don't lock everyone out on a transient outage
    expect(result.allowed).toBe(true);
    expect(result.tier).toBe("free");
    expect(result.remaining).toBe(FREE_TIER_DAILY_LIMIT);
  });
});

// ─── peekDailyQuota ───────────────────────────────────────────────────────────

describe("peekDailyQuota — read-only", () => {
  it("returns permissive Free result without Redis", async () => {
    const result = await peekDailyQuota("install-x");
    expect(result.allowed).toBe(true);
    expect(result.tier).toBe("free");
    expect(result.used).toBe(0);
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

  it("reflects the current counter value when present", async () => {
    const today = getUtcDateKey();
    const counter: Record<string, number> = {
      [`quota:install-mid:${today}`]: 12,
    };
    const redis = mockRedis({ counter });
    initQuota(redis);
    initUserStorage(redis);

    const result = await peekDailyQuota("install-mid");

    expect(result.used).toBe(12);
    expect(result.remaining).toBe(FREE_TIER_DAILY_LIMIT - 12);
    expect(result.allowed).toBe(true);
  });

  it("reports allowed=false when at the limit", async () => {
    const today = getUtcDateKey();
    const counter: Record<string, number> = {
      [`quota:install-full:${today}`]: FREE_TIER_DAILY_LIMIT,
    };
    const redis = mockRedis({ counter });
    initQuota(redis);
    initUserStorage(redis);

    const result = await peekDailyQuota("install-full");

    expect(result.used).toBe(FREE_TIER_DAILY_LIMIT);
    expect(result.remaining).toBe(0);
    expect(result.allowed).toBe(false);
  });

  it("returns unlimited result for Pro tier without reading the counter", async () => {
    const redis = mockRedis({ tier: { "install-pro": "pro" } });
    initQuota(redis);
    initUserStorage(redis);

    const result = await peekDailyQuota("install-pro");

    expect(result.tier).toBe("pro");
    expect(result.remaining).toBe(-1);
    // Tier lookup is 2 reads (tier + tierExpires for downgrade-on-expiry).
    // The counter MUST NOT be touched — we'd be wasting a Redis op for a Pro user.
    const counterReads = (redis.get as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).startsWith("quota:"),
    );
    expect(counterReads.length).toBe(0);
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
