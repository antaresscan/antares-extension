// __tests__/audit-lot05.test.ts — Lot 5 of the file-by-file audit (2026-10-17): api/auth/[action].ts, the sign-up.
// Each test fails on the previous code.
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const mocks = vi.hoisted(() => ({ store: new Map<string, unknown>(), expires: new Map<string, number>() }));

vi.mock("@upstash/redis", () => {
  const alive = (k: string) => {
    const at = mocks.expires.get(k);
    if (at !== undefined && at <= Date.now()) { mocks.store.delete(k); mocks.expires.delete(k); }
    return mocks.store.has(k);
  };
  class MockRedis {
    set = vi.fn(async (k: string, v: unknown, opts?: { nx?: boolean; ex?: number }) => {
      if (opts?.nx && alive(k)) return null;
      mocks.store.set(k, v);
      if (opts?.ex) mocks.expires.set(k, Date.now() + opts.ex * 1000); else mocks.expires.delete(k);
      return "OK";
    });
    get = vi.fn(async (k: string) => (alive(k) ? mocks.store.get(k) : null));
    del = vi.fn(async (...keys: string[]) => { let n = 0; for (const k of keys) { mocks.expires.delete(k); if (mocks.store.delete(k)) n++; } return n; });
    incr = vi.fn(async (k: string) => { const n = (alive(k) ? Number(mocks.store.get(k)) : 0) + 1; mocks.store.set(k, String(n)); return n; });
    expire = vi.fn(async (k: string, s: number) => { if (!alive(k)) return 0; mocks.expires.set(k, Date.now() + s * 1000); return 1; });
    hset = vi.fn(async (k: string, f: Record<string, string>) => { mocks.store.set(k, { ...((alive(k) ? mocks.store.get(k) : {}) as object), ...f }); return 1; });
    hget = vi.fn(async (k: string, f: string) => ((alive(k) ? mocks.store.get(k) : {}) as Record<string, string>)[f] ?? null);
    hgetall = vi.fn(async (k: string) => (alive(k) ? { ...(mocks.store.get(k) as object) } : null));
    multi = () => {
      const q: Array<() => Promise<unknown>> = [];
      const tx = {
        hset: (k: string, f: Record<string, string>) => { q.push(() => this.hset(k, f)); return tx; },
        expire: (k: string, s: number) => { q.push(() => this.expire(k, s)); return tx; },
        exec: async () => { const out: unknown[] = []; for (const f of q) out.push(await f()); return out; },
      };
      return tx;
    };
  }
  return { Redis: MockRedis };
});
vi.mock("../api/_lib/middleware", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/middleware")>("../api/_lib/middleware");
  return { ...actual, checkRateLimit: vi.fn().mockResolvedValue(true), initRateLimiters: vi.fn() };
});

const ORIGIN = "https://antaresscan.com";
let mailsSent: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-17T10:00:00Z").getTime() });
  mocks.store.clear();
  mocks.expires.clear();
  mailsSent = [];
  process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash";
  process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token-thirty-two-chars-min-required";
  process.env.SESSION_SECRET = "0".repeat(64);
  process.env.RESEND_API_KEY = "re_test";
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    mailsSent.push(String(JSON.parse(String(init?.body ?? "{}")).to?.[0] ?? ""));
    return new Response("{}", { status: 200 });
  }));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function call(dispatcher: (req: VercelRequest, res: VercelResponse) => unknown, body: unknown, ip = "203.0.113.7") {
  const out = { status: 200, body: {} as Record<string, unknown> };
  const req = { method: "POST", headers: { origin: ORIGIN, "x-real-ip": ip }, query: { action: "signup" }, body, socket: {} } as unknown as VercelRequest;
  const res = {
    setHeader: () => res, status: (c: number) => { out.status = c; return res; },
    json: (b: Record<string, unknown>) => { out.body = b; return res; }, end: () => res, headersSent: false,
  } as unknown as VercelResponse;
  await dispatcher(req, res);
  return out;
}

describe("sign-up — the form cannot be used to mail-bomb an inbox", () => {
  it("a script re-signing a stranger's address every minute gets at most 5 e-mails sent to it in a day (it got one a minute: 1 440)", async () => {
    const { default: dispatcher } = await import("../api/auth/[action]");
    for (let i = 0; i < 30; i++) {
      // from a different network each time, so that only the per-address ceiling can stop it
      expect((await call(dispatcher, { email: "victim@example.com", password: "attacker-password" }, `198.51.100.${i + 1}`)).status).toBe(200);
      vi.setSystemTime(Date.now() + 61_000); // past the 1-minute cooldown of the link, every time
    }
    expect(mailsSent.filter((to) => to === "victim@example.com").length).toBeLessThanOrEqual(5);
  });

  it("one network may start at most 20 sign-ups an hour (each one makes us write to an inbox of its choosing)", async () => {
    const { default: dispatcher } = await import("../api/auth/[action]");
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push((await call(dispatcher, { email: `target${i}@example.com`, password: "a-long-enough-password" })).status);
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(20).every((s) => s === 429)).toBe(true);
    expect(mailsSent.length).toBe(20);
  });
});

describe("sign-up — its duration does not tell whether the address has an account", () => {
  it("on a deployment, a new address and a known one both take at least the minimum answer time", async () => {
    vi.useRealTimers();
    vi.stubEnv("VERCEL_ENV", "production");
    vi.resetModules();
    const mod = await import("../api/auth/[action]");
    expect(mod.SIGNUP_MIN_ANSWER_MS).toBeGreaterThanOrEqual(1000);
    const t0 = Date.now();
    await call(mod.default, { email: "fresh@example.com", password: "a-long-enough-password" });
    const tNew = Date.now() - t0;
    const t1 = Date.now();
    await call(mod.default, { email: "fresh@example.com", password: "another-long-password" }); // the address now has an account
    const tKnown = Date.now() - t1;
    expect(tNew).toBeGreaterThanOrEqual(mod.SIGNUP_MIN_ANSWER_MS - 5);
    expect(tKnown).toBeGreaterThanOrEqual(mod.SIGNUP_MIN_ANSWER_MS - 5);
  }, 10_000);
});
