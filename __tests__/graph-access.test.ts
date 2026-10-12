// __tests__/graph-access.test.ts
//
// The guards of /api/graph (audit A-03): a limiter per USER (10 a minute, prefix antares_graph), a ceiling per UTC day for the whole
// service (500 unless GRAPH_GLOBAL_PER_DAY says otherwise), and no service at all without Redis. Unlike the cold-scan limiter, which
// fails open because a scan is the core product, these fail CLOSED: an expensive endpoint never runs unguarded.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Redis } from "@upstash/redis";

const rl = vi.hoisted(() => ({
  constructed: [] as Array<{ prefix: string; n: number; window: string }>,
  counts: new Map<string, number>(),
  throwOn: false,
}));

vi.mock("@upstash/ratelimit", () => {
  class FakeRatelimit {
    prefix: string;
    n: number;
    static slidingWindow(n: number, window: string) { return { n, window }; }
    constructor(o: { prefix: string; limiter: { n: number; window: string } }) {
      this.prefix = o.prefix;
      this.n = o.limiter.n;
      rl.constructed.push({ prefix: o.prefix, n: o.limiter.n, window: o.limiter.window });
    }
    async limit(key: string) {
      if (rl.throwOn) throw new Error("redis down");
      const k = `${this.prefix}:${key}`;
      const used = (rl.counts.get(k) ?? 0) + 1;
      rl.counts.set(k, used);
      return { success: used <= this.n, remaining: Math.max(0, this.n - used), reset: Date.now() + 12_400 };
    }
  }
  return { Ratelimit: FakeRatelimit };
});

const mockAccount = vi.fn();
vi.mock("../api/_lib/session-cookie", () => ({ getAccountFromRequest: (...a: unknown[]) => mockAccount(...a) }));

/** A Redis that only knows INCR/EXPIRE through a pipeline, and can be made to fail. */
function fakeRedis() {
  const counters = new Map<string, number>();
  const ttls = new Map<string, number>();
  const state = { fail: false, calls: 0 };
  const redis = {
    pipeline() {
      const ops: Array<() => number> = [];
      const p = {
        incr(key: string) { ops.push(() => { const n = (counters.get(key) ?? 0) + 1; counters.set(key, n); return n; }); return p; },
        expire(key: string, ttl: number) { ops.push(() => { ttls.set(key, ttl); return 1; }); return p; },
        async exec() { state.calls++; if (state.fail) throw new Error("redis down"); return ops.map((f) => f()); },
      };
      return p;
    },
  };
  return { redis: redis as unknown as Redis, counters, ttls, state };
}

async function freshModule() {
  vi.resetModules();
  return import("../api/_lib/graph-access");
}

beforeEach(() => {
  rl.constructed.length = 0;
  rl.counts.clear();
  rl.throwOn = false;
  mockAccount.mockReset();
  delete process.env.GRAPH_GLOBAL_PER_DAY;
});
afterEach(() => { delete process.env.GRAPH_GLOBAL_PER_DAY; });

describe("availability: no Redis, no service", () => {
  it("is not available until initGraphAccess has been given a Redis", async () => {
    const m = await freshModule();
    expect(m.graphAccessAvailable()).toBe(false);
    m.initGraphAccess(fakeRedis().redis);
    expect(m.graphAccessAvailable()).toBe(true);
    m._resetGraphAccessForTests();
    expect(m.graphAccessAvailable()).toBe(false);
  });

  it("without Redis both guards say unavailable, never ok", async () => {
    const m = await freshModule();
    expect(await m.checkGraphUserLimit("u:x")).toEqual({ ok: false, reason: "unavailable" });
    expect(await m.takeGraphDailyBudget()).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("the limiter per user", () => {
  it("is 10 a minute, under its own prefix", async () => {
    const m = await freshModule();
    m.initGraphAccess(fakeRedis().redis);
    expect(rl.constructed).toEqual([{ prefix: "antares_graph", n: 10, window: "60 s" }]);
  });

  it("lets 10 requests through, then asks the 11th to wait (Retry-After between 1 and 60)", async () => {
    const m = await freshModule();
    m.initGraphAccess(fakeRedis().redis);
    for (let i = 0; i < 10; i++) expect(await m.checkGraphUserLimit("u:a")).toEqual({ ok: true });
    const eleventh = await m.checkGraphUserLimit("u:a");
    expect(eleventh.ok).toBe(false);
    if (!eleventh.ok && eleventh.reason === "limited") {
      expect(eleventh.retryAfterSec).toBeGreaterThanOrEqual(1);
      expect(eleventh.retryAfterSec).toBeLessThanOrEqual(60);
    } else {
      throw new Error("expected a 'limited' answer");
    }
  });

  it("each user has their own window", async () => {
    const m = await freshModule();
    m.initGraphAccess(fakeRedis().redis);
    for (let i = 0; i < 10; i++) await m.checkGraphUserLimit("u:a");
    expect((await m.checkGraphUserLimit("u:a")).ok).toBe(false);
    expect((await m.checkGraphUserLimit("u:b")).ok).toBe(true);
  });

  it("fails CLOSED when Redis errors", async () => {
    const m = await freshModule();
    m.initGraphAccess(fakeRedis().redis);
    rl.throwOn = true;
    expect(await m.checkGraphUserLimit("u:a")).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("the ceiling per day for the whole service", () => {
  const noon = new Date("2026-10-11T12:00:00Z");

  it("500 by default, GRAPH_GLOBAL_PER_DAY when it is a positive integer, the default again when it is garbage", async () => {
    const m = await freshModule();
    expect(m.graphDailyCap()).toBe(500);
    process.env.GRAPH_GLOBAL_PER_DAY = "40";
    expect(m.graphDailyCap()).toBe(40);
    for (const bad of ["", "0", "-5", "abc", "1.5", "Infinity"]) {
      process.env.GRAPH_GLOBAL_PER_DAY = bad;
      expect(m.graphDailyCap()).toBe(500);
    }
  });

  it("counts under antares_graph_day:<UTC date> and gives the key a lifetime of two days", async () => {
    const m = await freshModule();
    const r = fakeRedis();
    m.initGraphAccess(r.redis);
    await m.takeGraphDailyBudget(noon);
    expect(r.counters.get("antares_graph_day:2026-10-11")).toBe(1);
    expect(r.ttls.get("antares_graph_day:2026-10-11")).toBe(172_800);
  });

  it("answers up to the cap, refuses beyond it, with the seconds until 00:00 UTC", async () => {
    process.env.GRAPH_GLOBAL_PER_DAY = "3";
    const m = await freshModule();
    m.initGraphAccess(fakeRedis().redis);
    for (let i = 0; i < 3; i++) expect(await m.takeGraphDailyBudget(noon)).toEqual({ ok: true });
    expect(await m.takeGraphDailyBudget(noon)).toEqual({ ok: false, reason: "limited", retryAfterSec: 12 * 3600 });
  });

  it("a new UTC day starts a new count", async () => {
    process.env.GRAPH_GLOBAL_PER_DAY = "1";
    const m = await freshModule();
    m.initGraphAccess(fakeRedis().redis);
    expect((await m.takeGraphDailyBudget(noon)).ok).toBe(true);
    expect((await m.takeGraphDailyBudget(noon)).ok).toBe(false);
    expect((await m.takeGraphDailyBudget(new Date("2026-10-12T00:00:01Z"))).ok).toBe(true);
  });

  it("fails CLOSED when Redis errors", async () => {
    const m = await freshModule();
    const r = fakeRedis();
    m.initGraphAccess(r.redis);
    r.state.fail = true;
    expect(await m.takeGraphDailyBudget(noon)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("secondsUntilUtcMidnight is never below 1", async () => {
    const m = await freshModule();
    expect(m.secondsUntilUtcMidnight(new Date("2026-10-11T23:59:59.999Z"))).toBe(1);
    expect(m.secondsUntilUtcMidnight(new Date("2026-10-11T00:00:00Z"))).toBe(86_400);
  });
});

describe("the key of a caller", () => {
  const fakeReq = {} as never;

  it("a session gives a hashed key that does not contain the e-mail, whatever its case or spacing", async () => {
    const m = await freshModule();
    const a = m.graphUserKey("Someone@Example.com", "install-1");
    expect(a).toMatch(/^u:[0-9a-f]{32}$/);
    expect(a).not.toContain("example");
    expect(m.graphUserKey("  someone@example.com ", "install-2")).toBe(a); // same user, another install: the same window
    expect(m.graphUserKey("other@example.com", "install-1")).not.toBe(a);
  });

  it("no session falls back to the install id (or address) the caller sent", async () => {
    const m = await freshModule();
    expect(m.graphUserKey(null, "install-1")).toBe("i:install-1");
  });

  it("graphUserKeyOf reads the session of the request", async () => {
    const m = await freshModule();
    m.initGraphAccess(fakeRedis().redis);
    mockAccount.mockResolvedValue({ email: "someone@example.com" });
    expect(await m.graphUserKeyOf(fakeReq, "install-1")).toBe(m.graphUserKey("someone@example.com", "install-1"));
  });

  it("graphUserKeyOf falls back when the session cannot be read", async () => {
    const m = await freshModule();
    m.initGraphAccess(fakeRedis().redis);
    mockAccount.mockRejectedValue(new Error("SESSION_SECRET unset"));
    expect(await m.graphUserKeyOf(fakeReq, "install-1")).toBe("i:install-1");
    mockAccount.mockResolvedValue(null);
    expect(await m.graphUserKeyOf(fakeReq, "install-1")).toBe("i:install-1");
  });
});
