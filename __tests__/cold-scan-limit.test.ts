// __tests__/cold-scan-limit.test.ts
//
// The per-install limiters are keyed by (ip, install id) and the install id is
// chosen by the client, so a script that rotates it never hits a limit. The
// cold-scan limiter is keyed by network alone and only counts requests that
// reach a REAL scan (cache hits are never counted). It must never be a reason
// for a legitimate user to be blocked: it fails open.
import { describe, it, expect, vi, beforeEach } from "vitest";

const rl = vi.hoisted(() => ({
  constructed: [] as Array<{ prefix: string; n: number; window: string }>,
  counts: new Map<string, number>(),
  throwOn: "" as string,
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
      if (rl.throwOn === this.prefix) throw new Error("redis down");
      const k = `${this.prefix}:${key}`;
      const used = (rl.counts.get(k) ?? 0) + 1;
      rl.counts.set(k, used);
      return { success: used <= this.n, remaining: Math.max(0, this.n - used), reset: Date.now() + 12_400 };
    }
  }
  return { Ratelimit: FakeRatelimit };
});

import type { Redis } from "@upstash/redis";

async function freshModule() {
  vi.resetModules();
  return import("../api/_lib/middleware");
}

beforeEach(() => {
  rl.constructed.length = 0;
  rl.counts.clear();
  rl.throwOn = "";
});

describe("coldScanKey", () => {
  it("leaves IPv4 and unknown values alone", async () => {
    const { coldScanKey } = await freshModule();
    expect(coldScanKey("203.0.113.7")).toBe("203.0.113.7");
    expect(coldScanKey("unknown")).toBe("unknown");
  });

  it("treats an IPv4-mapped IPv6 address as the IPv4 address", async () => {
    const { coldScanKey } = await freshModule();
    expect(coldScanKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("collapses IPv6 to its /64: a customer owns 2^64 addresses, not one", async () => {
    const { coldScanKey } = await freshModule();
    const a = coldScanKey("2001:db8:abcd:12::1");
    expect(a).toBe("2001:db8:abcd:12::/64");
    expect(coldScanKey("2001:db8:abcd:12:ffff:eeee:dddd:cccc")).toBe(a); // same /64, other host part
    expect(coldScanKey("2001:0DB8:ABCD:0012:0000:0000:0000:0001")).toBe(a); // case and leading zeros
    expect(coldScanKey("2001:db8:abcd:13::1")).not.toBe(a); // another /64 stays separate
  });

  it("expands '::' correctly in the leading groups", async () => {
    const { coldScanKey } = await freshModule();
    expect(coldScanKey("::1")).toBe("0:0:0:0::/64");
    expect(coldScanKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(coldScanKey("2001:db8:0:0:0:0:0:1")).toBe("2001:db8:0:0::/64");
  });

  it("uses an unparseable value as is instead of guessing", async () => {
    const { coldScanKey } = await freshModule();
    expect(coldScanKey("not:an:ip")).toBe("not:an:ip");
    expect(coldScanKey("1::2::3")).toBe("1::2::3");
    expect(coldScanKey("2001:db8:abcd:12:1:2:3:4:5")).toBe("2001:db8:abcd:12:1:2:3:4:5");
  });
});

describe("checkColdScanLimit", () => {
  it("is created with 60 per minute under its own prefix", async () => {
    const m = await freshModule();
    m.initRateLimiters({} as Redis);
    expect(m.COLD_SCANS_PER_MINUTE).toBe(60);
    expect(rl.constructed).toContainEqual({ prefix: "antares_cold", n: 60, window: "60 s" });
  });

  it("lets everything through before the limiters are initialised (no Redis)", async () => {
    const { checkColdScanLimit } = await freshModule();
    expect(await checkColdScanLimit("203.0.113.7")).toEqual({ ok: true, retryAfterSec: 0 });
  });

  it("allows 60 cold scans a minute from one network, then refuses with a bounded Retry-After", async () => {
    const m = await freshModule();
    m.initRateLimiters({} as Redis);
    for (let i = 0; i < 60; i++) expect((await m.checkColdScanLimit("203.0.113.7")).ok, `scan ${i + 1}`).toBe(true);

    const refused = await m.checkColdScanLimit("203.0.113.7");

    expect(refused.ok).toBe(false);
    expect(refused.retryAfterSec).toBe(13); // 12.4 s -> rounded up
    expect(refused.retryAfterSec).toBeLessThanOrEqual(30);
  });

  it("keeps networks independent: one noisy IP does not touch another", async () => {
    const m = await freshModule();
    m.initRateLimiters({} as Redis);
    for (let i = 0; i < 61; i++) await m.checkColdScanLimit("203.0.113.7");

    expect((await m.checkColdScanLimit("198.51.100.9")).ok).toBe(true);
  });

  it("counts two addresses of the same IPv6 /64 together", async () => {
    const m = await freshModule();
    m.initRateLimiters({} as Redis);
    for (let i = 0; i < 60; i++) await m.checkColdScanLimit(`2001:db8:abcd:12::${i + 1}`);

    expect((await m.checkColdScanLimit("2001:db8:abcd:12:ffff::1")).ok).toBe(false);
    expect((await m.checkColdScanLimit("2001:db8:abcd:99::1")).ok).toBe(true); // other /64
  });

  it("never throttles clients it cannot identify (they would all share one bucket)", async () => {
    const m = await freshModule();
    m.initRateLimiters({} as Redis);
    for (let i = 0; i < 200; i++) expect((await m.checkColdScanLimit("unknown")).ok).toBe(true);
  });

  it("fails OPEN when the limiter errors: an abuse guard must not take the service down", async () => {
    const m = await freshModule();
    m.initRateLimiters({} as Redis);
    rl.throwOn = "antares_cold";

    expect(await m.checkColdScanLimit("203.0.113.7")).toEqual({ ok: true, retryAfterSec: 0 });
  });
});
