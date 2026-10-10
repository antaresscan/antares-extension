// __tests__/network-rate-limit.test.ts
//
// The per-install windows of checkRateLimit are keyed by (network, install id), and the install id is chosen by the CLIENT: a script
// that sends a new one with every request gets a fresh window each time, so it was never limited (audit C6). The cold-scan limiter
// (cold-scan-limit.test.ts) bounds the EXPENSIVE requests; this ceiling bounds every other request by network alone, whatever install
// id is sent. It fails open, and an address that cannot be identified has no bucket.
import { describe, it, expect, vi, beforeEach } from "vitest";

const rl = vi.hoisted(() => ({
  constructed: [] as Array<{ prefix: string; n: number; window: string }>,
  counts: new Map<string, number>(),
  calls: [] as string[],
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
      rl.calls.push(`${this.prefix}:${key}`);
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
import type { VercelResponse } from "@vercel/node";

async function freshModule() {
  vi.resetModules();
  const mod = await import("../api/_lib/middleware");
  mod.initRateLimiters({} as Redis);
  return mod;
}

function fakeRes() {
  const out = { status: 200, headers: {} as Record<string, string>, body: undefined as unknown };
  const res = {
    setHeader: (k: string, v: string) => { out.headers[k] = v; return res; },
    status: (code: number) => { out.status = code; return res; },
    json: (b: unknown) => { out.body = b; return res; },
  };
  return { res: res as unknown as VercelResponse, out };
}

beforeEach(() => {
  rl.constructed.length = 0;
  rl.counts.clear();
  rl.calls.length = 0;
  rl.throwOn = "";
});

describe("the network ceiling", () => {
  it("is built at 600 requests a minute, under its own prefix", async () => {
    await freshModule();
    expect(rl.constructed).toContainEqual({ prefix: "antares_net", n: 600, window: "60 s" });
  });

  it("rotating the install id gets a script nowhere: from one network, 600 pass and the rest are refused", async () => {
    const { checkRateLimit } = await freshModule();
    let passed = 0, refused = 0;
    let last = fakeRes();
    for (let i = 0; i < 650; i++) {
      last = fakeRes();
      // a new random install id for every request: every per-install window is fresh
      if (await checkRateLimit(last.res, "203.0.113.7", `install-${String(i).padStart(8, "0")}`)) passed++; else refused++;
    }
    expect(passed).toBe(600);
    expect(refused).toBe(50);
    expect(last.out.status).toBe(429);
    expect(last.out.body).toMatchObject({ error: expect.stringMatching(/from this network/i) });
    const retry = Number(last.out.headers["Retry-After"]);
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(60);
  });

  it("another network is not affected by the first one being exhausted", async () => {
    const { checkRateLimit } = await freshModule();
    for (let i = 0; i < 650; i++) await checkRateLimit(fakeRes().res, "203.0.113.7", `install-${String(i).padStart(8, "0")}`);
    const other = fakeRes();
    expect(await checkRateLimit(other.res, "198.51.100.9", "install-00000001")).toBe(true);
  });

  it("an install id never seen before does not escape an exhausted network", async () => {
    const { checkRateLimit } = await freshModule();
    for (let i = 0; i < 600; i++) await checkRateLimit(fakeRes().res, "203.0.113.7");
    const fresh = fakeRes();
    expect(await checkRateLimit(fresh.res, "203.0.113.7", "brand-new-install-id")).toBe(false);
    expect(fresh.out.status).toBe(429);
  });

  it("IPv6 addresses of one /64 share the bucket, another /64 has its own", async () => {
    const { checkRateLimit } = await freshModule();
    for (let i = 0; i < 600; i++) {
      // 600 different addresses of the SAME /64: a customer owns 2^64 of them
      await checkRateLimit(fakeRes().res, `2001:db8:abcd:12::${(i + 1).toString(16)}`, `install-${String(i).padStart(8, "0")}`);
    }
    const sameNet = fakeRes();
    expect(await checkRateLimit(sameNet.res, "2001:db8:abcd:12:ffff:eeee:dddd:cccc", "install-other-0001")).toBe(false);
    const otherNet = fakeRes();
    expect(await checkRateLimit(otherNet.res, "2001:db8:abcd:13::1", "install-other-0002")).toBe(true);
  });

  it("an address that cannot be identified has no bucket of its own: nothing is counted against 'unknown'", async () => {
    const { checkRateLimit } = await freshModule();
    // (with distinct install ids so that the per-install windows, which still key on the address, are not what refuses them)
    for (let i = 0; i < 700; i++) expect(await checkRateLimit(fakeRes().res, "unknown", `install-${String(i).padStart(8, "0")}`)).toBe(true);
    expect(rl.calls.some((c) => c.startsWith("antares_net:"))).toBe(false);
  });

  it("fails OPEN: a Redis error on the network ceiling lets the request through", async () => {
    const { checkRateLimit } = await freshModule();
    rl.throwOn = "antares_net";
    const { res, out } = fakeRes();
    expect(await checkRateLimit(res, "203.0.113.7", "install-00000001")).toBe(true);
    expect(out.status).toBe(200);
  });
});

describe("the three windows are asked together, and keep their order of precedence", () => {
  it("one request consults the per-install, burst and network windows once each", async () => {
    const { checkRateLimit } = await freshModule();
    await checkRateLimit(fakeRes().res, "203.0.113.7", "install-00000001");
    expect(rl.calls.sort()).toEqual([
      "antares_burst:203.0.113.7:install-00000001",
      "antares_net:203.0.113.7",
      "antares_rl:203.0.113.7:install-00000001",
    ]);
  });

  it("an exhausted per-install window is refused with its own message, even when the others are fine", async () => {
    const { checkRateLimit } = await freshModule();
    for (let i = 0; i < 60; i++) await checkRateLimit(fakeRes().res, "203.0.113.7", "install-00000001");
    const { res, out } = fakeRes();
    expect(await checkRateLimit(res, "203.0.113.7", "install-00000001")).toBe(false);
    expect(out.body).toMatchObject({ error: "Too many requests. Please slow down." });
  });

  it("an exhausted burst window is refused with Retry-After 10", async () => {
    const { checkRateLimit } = await freshModule();
    rl.counts.set("antares_burst:203.0.113.7:install-00000001", 20); // 20 used in the last 10 s: the next one is the 21st
    const { res, out } = fakeRes();
    expect(await checkRateLimit(res, "203.0.113.7", "install-00000001")).toBe(false);
    expect(out.headers["Retry-After"]).toBe("10");
    expect(out.body).toMatchObject({ error: expect.stringMatching(/burst/i) });
  });

  it("no install id: the network is the key of the per-install window too (legacy clients)", async () => {
    const { checkRateLimit } = await freshModule();
    await checkRateLimit(fakeRes().res, "203.0.113.7");
    expect(rl.calls).toContain("antares_rl:203.0.113.7");
    expect(rl.calls).toContain("antares_burst:203.0.113.7");
  });

  it("the headers the client reads stay those of the per-install window", async () => {
    const { checkRateLimit } = await freshModule();
    const { res, out } = fakeRes();
    await checkRateLimit(res, "203.0.113.7", "install-00000001");
    expect(out.headers["X-RateLimit-Limit"]).toBe("60");
    expect(out.headers["X-RateLimit-Remaining"]).toBe("59");
  });
});
