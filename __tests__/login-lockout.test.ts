// __tests__/login-lockout.test.ts
//
// The lock on the login of one account (audit A-11). The only limit on /api/auth/login used to be per network address (about 60 a minute):
// 3,600 guesses an hour on one account, and a new address starts again from zero. Now every failed login counts against the e-mail it tried:
// 10 failures in 15 minutes lock that e-mail's login until the 15 minutes end (429 and Retry-After), and a good login wipes the count.
//
// Pinned here:
//   1. the guesses are counted PER ACCOUNT, from whatever address they come;
//   2. the lock tells nothing about who has an account: an unknown e-mail is counted and locked exactly like a known one;
//   3. a legitimate user is not bothered: a good login before the 10th failure wipes the count, the lock ends by itself, and the sessions already
//      signed in keep working while somebody else is guessing;
//   4. the guard never stops the login from working when Redis does not answer it, and a counter that lost its end date cannot lock for ever;
//   5. the website, the extension and the overlay's badge stay in step (login -> sync-token -> tier), and a login costs its count (INCR, and its end date the first time) and, when it works, the wipe.
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const mocks = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  expires: new Map<string, number>(), // key -> epoch ms
  calls: [] as string[],
  deserialise: false,
  down: false, // Redis answers the guard with an error
}));

vi.mock("@upstash/redis", () => {
  const alive = (k: string) => {
    const at = mocks.expires.get(k);
    if (at !== undefined && at <= Date.now()) { mocks.store.delete(k); mocks.expires.delete(k); }
    return mocks.store.has(k);
  };
  class MockRedis {
    private log(name: string) { mocks.calls.push(name); }
    set = vi.fn(async (k: string, v: unknown, opts?: { nx?: boolean }) => {
      this.log("set");
      if (opts?.nx && alive(k)) return null;
      mocks.store.set(k, v); mocks.expires.delete(k);
      return "OK";
    });
    get = vi.fn(async (k: string) => {
      this.log("get");
      if (mocks.down && k.startsWith("auth_fail:")) throw new Error("redis down");
      if (!alive(k)) return null;
      const v = mocks.store.get(k);
      return mocks.deserialise && typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
    });
    del = vi.fn(async (k: string) => { this.log("del"); mocks.expires.delete(k); return mocks.store.delete(k) ? 1 : 0; });
    incr = vi.fn(async (k: string) => {
      this.log("incr");
      if (mocks.down) throw new Error("redis down");
      const n = (alive(k) ? Number(mocks.store.get(k)) : 0) + 1;
      mocks.store.set(k, String(n)); // a new counter has no end date until expire() gives it one
      return n;
    });
    expire = vi.fn(async (k: string, seconds: number) => { this.log("expire"); if (!alive(k)) return 0; mocks.expires.set(k, Date.now() + seconds * 1000); return 1; });
    ttl = vi.fn(async (k: string) => {
      this.log("ttl");
      if (!alive(k)) return -2;
      const at = mocks.expires.get(k);
      return at === undefined ? -1 : Math.ceil((at - Date.now()) / 1000);
    });
    pipeline = () => {
      const queued: Array<() => Promise<unknown>> = [];
      const p = {
        get: (k: string) => { queued.push(() => this.get(k)); return p; },
        ttl: (k: string) => { queued.push(() => this.ttl(k)); return p; },
        exec: async () => { const out: unknown[] = []; for (const q of queued) out.push(await q()); return out; },
      };
      return p;
    };
    hset = vi.fn(async (k: string, fields: Record<string, string>) => {
      this.log("hset");
      mocks.store.set(k, { ...((mocks.store.get(k) as Record<string, string>) ?? {}), ...fields });
      return Object.keys(fields).length;
    });
    hget = vi.fn(async (k: string, f: string) => { this.log("hget"); const h = mocks.store.get(k) as Record<string, string> | undefined; return h && f in h ? h[f] : null; });
    hgetall = vi.fn(async (k: string) => { this.log("hgetall"); const v = mocks.store.get(k); return v ? { ...(v as Record<string, string>) } : null; });
    hincrby = vi.fn(async (k: string, f: string, by: number) => {
      this.log("hincrby");
      const h = (mocks.store.get(k) as Record<string, string>) ?? {};
      const n = Number(h[f] ?? 0) + by;
      mocks.store.set(k, { ...h, [f]: String(n) });
      return n;
    });
    sadd = vi.fn(async (k: string, ...m: string[]) => {
      this.log("sadd");
      const s = (mocks.store.get(k) as Set<string>) ?? new Set<string>();
      let added = 0;
      for (const x of m) if (!s.has(x)) { s.add(x); added++; }
      mocks.store.set(k, s);
      return added;
    });
    smembers = vi.fn(async (k: string) => { this.log("smembers"); const v = mocks.store.get(k); return v ? [...(v as Set<string>)] : []; });
    multi = () => {
      const queued: Array<() => Promise<unknown>> = [];
      const tx = {
        hset: (k: string, f: Record<string, string>) => { queued.push(() => this.hset(k, f)); return tx; },
        sadd: (k: string, ...m: string[]) => { queued.push(() => this.sadd(k, ...m)); return tx; },
        set: (k: string, v: unknown) => { queued.push(() => this.set(k, v)); return tx; },
        expire: (k: string, sec: number) => { queued.push(() => this.expire(k, sec)); return tx; },
        exec: async () => { const out: unknown[] = []; for (const q of queued) out.push(await q()); return out; },
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

import { Redis } from "@upstash/redis";
import { createConfirmedAccount } from "./_helpers/confirmed-account";
import dispatcher from "../api/auth/[action]";
import { loginFailuresKey, checkLoginLock, clearLoginFailures, LOGIN_MAX_FAILURES, LOGIN_FAILURE_WINDOW_SECONDS } from "../api/_lib/login-guard";
import { initUserStorage, resolveTier } from "../api/_lib/user";
import { issueLicense } from "../api/_lib/license";
import { SESSION_COOKIE_NAME } from "../api/_lib/session-cookie";

const ORIGIN = "https://antares-website.vercel.app";
const INSTALL = "11111111-1111-4111-8111-111111111111";
const ALICE = "alice@example.com";
const BOB = "bob@example.com";
const PASSWORD = "a-long-enough-password";
const WRONG = "not-the-password";
const T0 = new Date("2026-10-15T12:00:00Z").getTime();

const redis = () => new Redis({ url: "x", token: "y" });
const counterKeys = () => [...mocks.store.keys()].filter((k) => k.startsWith("auth_fail:"));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: T0 });
  mocks.store.clear();
  mocks.expires.clear();
  mocks.calls.length = 0;
  mocks.deserialise = false;
  mocks.down = false;
  process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash";
  process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token-thirty-two-chars-min-required";
  process.env.SESSION_SECRET = "0".repeat(64);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  initUserStorage(redis());
});
afterEach(() => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.SESSION_SECRET;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── helpers: the real dispatcher, called the way Vercel calls it ───────────────────────────────────
interface Out { status: number; body: Record<string, unknown>; setCookie: string | null; headers: Record<string, string> }
function call(action: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Out> {
  const req = { method: opts.method ?? "POST", headers: { origin: ORIGIN, ...(opts.headers ?? {}) }, query: { action }, body: opts.body, socket: {} } as unknown as VercelRequest;
  const out: Out = { status: 200, body: {}, setCookie: null, headers: {} };
  const res = {
    setHeader: (k: string, v: string) => { if (k === "Set-Cookie") out.setCookie = v; else out.headers[k] = v; return res; },
    status: (c: number) => { out.status = c; return res; },
    json: (b: Record<string, unknown>) => { out.body = b; return res; },
    end: () => res,
    headersSent: false,
  } as unknown as VercelResponse;
  return Promise.resolve(dispatcher(req, res)).then(() => out);
}
const tokenOf = (setCookie: string | null) => decodeURIComponent((setCookie ?? "").split(";")[0].split("=")[1] ?? "");
const withCookie = (token: string) => ({ cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}` });
const login = (email: string, password: string, ip = "203.0.113.7") =>
  call("login", { headers: { "x-forwarded-for": ip }, body: { email, password } });
// A-01: a sign-up sends a link and signs nobody in; these tests are about the login lock, so the account is created confirmed (see _helpers).
const signUp = async (email: string) => { await createConfirmedAccount(new Redis({ url: "x", token: "y" }), mocks.store, email, PASSWORD); };
async function failTimes(email: string, n: number, ipFor: (i: number) => string = () => "203.0.113.7") {
  const statuses: number[] = [];
  for (let i = 0; i < n; i++) statuses.push((await login(email, WRONG, ipFor(i))).status);
  return statuses;
}

// ── 1. the guard ───────────────────────────────────────────────────────────────────────────────────
describe("the guard: the key, the count, the window", () => {
  it("the key holds the SHA-256 of the normalised address, never the address, and is the same whatever the case or spacing", () => {
    const k = loginFailuresKey("Alice@Example.COM ");
    expect(k).toMatch(/^auth_fail:[0-9a-f]{64}$/);
    expect(k).toBe(loginFailuresKey(ALICE));
    expect(k).not.toContain("alice");
    expect(loginFailuresKey(BOB)).not.toBe(k);
  });

  it("something that is not an address is keyed by what was typed, and nothing is thrown", () => {
    expect(loginFailuresKey("not an email")).toMatch(/^auth_fail:[0-9a-f]{64}$/);
    expect(loginFailuresKey(undefined)).toMatch(/^auth_fail:[0-9a-f]{64}$/);
    expect(loginFailuresKey("x".repeat(5000))).toMatch(/^auth_fail:[0-9a-f]{64}$/);
  });

  it("10 attempts go on, the 11th is locked, with the seconds left (between 1 and 15 minutes)", async () => {
    for (let i = 1; i <= LOGIN_MAX_FAILURES; i++) expect(await checkLoginLock(redis(), ALICE)).toEqual({ locked: false, attempts: i });
    const lock = await checkLoginLock(redis(), ALICE);
    expect(lock.locked).toBe(true);
    if (lock.locked) {
      expect(lock.retryAfterSec).toBeGreaterThanOrEqual(1);
      expect(lock.retryAfterSec).toBeLessThanOrEqual(LOGIN_FAILURE_WINDOW_SECONDS);
    }
  });

  it("guesses sent at the same moment cannot slip under the lock: of 30 concurrent attempts, exactly 10 go on (audit lot 4)", async () => {
    const all = await Promise.all(Array.from({ length: 30 }, () => checkLoginLock(redis(), ALICE)));
    expect(all.filter((l) => !l.locked)).toHaveLength(LOGIN_MAX_FAILURES);
  });

  it("the window starts at the first attempt and the following ones do not extend it", async () => {
    await checkLoginLock(redis(), ALICE);
    vi.setSystemTime(T0 + 10 * 60 * 1000); // 10 minutes later
    await checkLoginLock(redis(), ALICE);
    const k = loginFailuresKey(ALICE);
    expect(mocks.expires.get(k)).toBe(T0 + LOGIN_FAILURE_WINDOW_SECONDS * 1000); // still 15 minutes from the FIRST one
  });

  it("the count ends by itself: after 15 minutes the e-mail is not locked any more", async () => {
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) await checkLoginLock(redis(), ALICE);
    expect((await checkLoginLock(redis(), ALICE)).locked).toBe(true);
    vi.setSystemTime(T0 + (LOGIN_FAILURE_WINDOW_SECONDS + 1) * 1000);
    expect(await checkLoginLock(redis(), ALICE)).toEqual({ locked: false, attempts: 1 });
  });

  it("a counter that lost its end date is given one when it reaches the lock, so it cannot lock for ever", async () => {
    const k = loginFailuresKey(ALICE);
    mocks.store.set(k, String(LOGIN_MAX_FAILURES)); // the INCRs happened, the EXPIRE after the first one never did
    expect(mocks.expires.has(k)).toBe(false);
    const lock = await checkLoginLock(redis(), ALICE);
    expect(lock.locked).toBe(true);
    expect(mocks.expires.get(k)).toBe(T0 + LOGIN_FAILURE_WINDOW_SECONDS * 1000);
    vi.setSystemTime(T0 + (LOGIN_FAILURE_WINDOW_SECONDS + 1) * 1000);
    expect((await checkLoginLock(redis(), ALICE)).locked).toBe(false);
  });

  it("reads the count whether it is stored as text or as a number", async () => {
    mocks.store.set(loginFailuresKey(ALICE), LOGIN_MAX_FAILURES); // a number, as a client that deserialises would leave it
    expect((await checkLoginLock(redis(), ALICE)).locked).toBe(true);
  });

  it("clearLoginFailures wipes the count, and with nothing counted (Redis did not answer) it makes no round trip at all", async () => {
    const lock = await checkLoginLock(redis(), ALICE);
    mocks.calls.length = 0;
    await clearLoginFailures(redis(), ALICE, 0);
    expect(mocks.calls).toEqual([]);
    await clearLoginFailures(redis(), ALICE, lock.locked ? 0 : lock.attempts);
    expect(mocks.calls).toEqual(["del"]);
    expect(counterKeys()).toEqual([]);
  });

  it("when Redis does not answer the guard, the attempt goes through and nothing is thrown", async () => {
    mocks.down = true;
    expect(await checkLoginLock(redis(), ALICE)).toEqual({ locked: false, attempts: 0 });
  });
});

// ── 2. the login endpoint ──────────────────────────────────────────────────────────────────────────
describe("POST /api/auth/login", () => {
  it("10 wrong passwords are answered 401; the 11th is answered 429 with Retry-After and a message the website's form shows as it is", async () => {
    await signUp(ALICE);
    expect(await failTimes(ALICE, 10)).toEqual(Array(10).fill(401));
    const r = await login(ALICE, WRONG);
    expect(r.status).toBe(429);
    expect(r.body.reason).toBe("too_many_attempts");
    expect(r.body.ok).toBe(false);
    expect(String(r.body.error)).toMatch(/^Too many failed attempts\. Try again in 15 minutes\.$/);
    expect(Number(r.headers["Retry-After"])).toBe(r.body.retryAfterSec);
    expect(Number(r.headers["Retry-After"])).toBeGreaterThan(0);
    expect(Number(r.headers["Retry-After"])).toBeLessThanOrEqual(900);
  });

  it("locked means locked: the RIGHT password is refused too until the window ends", async () => {
    await signUp(ALICE);
    await failTimes(ALICE, 10);
    const r = await login(ALICE, PASSWORD);
    expect(r.status).toBe(429);
    expect(r.setCookie).toBeNull(); // no session
  });

  it("the guesses are counted per ACCOUNT, whatever the address: ten different addresses lock it just the same", async () => {
    await signUp(ALICE);
    const statuses = await failTimes(ALICE, 10, (i) => `198.51.100.${i + 1}`);
    expect(statuses).toEqual(Array(10).fill(401));
    expect((await login(ALICE, WRONG, "192.0.2.99")).status).toBe(429); // an eleventh, new address
    expect((await login(ALICE, PASSWORD, "192.0.2.100")).status).toBe(429);
  });

  it("another account is not affected by the lock of this one", async () => {
    await signUp(ALICE);
    await signUp(BOB);
    await failTimes(ALICE, 10);
    expect((await login(ALICE, PASSWORD)).status).toBe(429);
    expect((await login(BOB, PASSWORD)).status).toBe(200);
  });

  it("an e-mail with NO account is counted and locked exactly like one that has an account: the lock tells nothing about who is a customer", async () => {
    await signUp(ALICE);
    const known = await failTimes(ALICE, 11);
    const unknown = await failTimes("nobody@example.com", 11);
    expect(unknown).toEqual(known); // the same ten 401 and the same 429
    const a = await login(ALICE, WRONG);
    const n = await login("nobody@example.com", WRONG);
    expect(n.status).toBe(a.status);
    expect(Object.keys(n.body).sort()).toEqual(Object.keys(a.body).sort());
    expect(n.body.reason).toBe(a.body.reason);
    expect(n.body.error).toBe(a.body.error);
  });

  it("a good login before the 10th failure wipes the count: 9 failures, a success, then 9 more failures are still not a lock", async () => {
    await signUp(ALICE);
    await failTimes(ALICE, 9);
    expect((await login(ALICE, PASSWORD)).status).toBe(200);
    expect(counterKeys()).toEqual([]);
    expect(await failTimes(ALICE, 9)).toEqual(Array(9).fill(401));
    expect((await login(ALICE, PASSWORD)).status).toBe(200);
  });

  it("the lock ends by itself: after 15 minutes the right password works, and the count is gone", async () => {
    await signUp(ALICE);
    await failTimes(ALICE, 10);
    expect((await login(ALICE, PASSWORD)).status).toBe(429);
    vi.setSystemTime(T0 + (LOGIN_FAILURE_WINDOW_SECONDS + 1) * 1000);
    expect((await login(ALICE, PASSWORD)).status).toBe(200);
    expect(counterKeys()).toEqual([]);
  });

  it("the Retry-After tells how long is LEFT: it shrinks as the window runs", async () => {
    await signUp(ALICE);
    await failTimes(ALICE, 10);
    const first = Number((await login(ALICE, WRONG)).headers["Retry-After"]);
    vi.setSystemTime(T0 + 5 * 60 * 1000);
    const later = Number((await login(ALICE, WRONG)).headers["Retry-After"]);
    expect(later).toBeLessThan(first);
    expect(first - later).toBeGreaterThanOrEqual(290);
  });

  it("somebody guessing does not bother the owner who is already signed in: the session still works while the login is locked", async () => {
    await signUp(ALICE);
    const owner = tokenOf((await login(ALICE, PASSWORD)).setCookie);
    await failTimes(ALICE, 10);
    expect((await login(ALICE, PASSWORD)).status).toBe(429);
    expect((await call("me", { method: "GET", headers: withCookie(owner) })).status).toBe(200);
    expect((await call("sync-token", { headers: withCookie(owner) })).status).toBe(200);
  });

  it("when Redis does not answer the guard, the right password still logs in", async () => {
    await signUp(ALICE);
    mocks.down = true;
    const r = await login(ALICE, PASSWORD);
    expect(r.status).toBe(200);
    expect(r.setCookie).not.toBeNull();
  });

  it("the counter is per e-mail as typed: case and spaces do not give an attacker a fresh count", async () => {
    await signUp(ALICE);
    for (let i = 0; i < 10; i++) await login(i % 2 ? "ALICE@example.com " : ALICE, WRONG);
    expect((await login(" Alice@EXAMPLE.com", PASSWORD)).status).toBe(429);
  });

  it("nothing about the address is written to Redis: the keys hold a hash", async () => {
    await signUp(ALICE);
    await failTimes(ALICE, 3);
    expect(counterKeys().length).toBe(1);
    for (const k of counterKeys()) expect(k).not.toContain("alice");
  });

  it("signup is untouched by this lock, and since A-01 an address that already has an account gets the SAME answer as a new one (no more 409 that says who has an account)", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200 })));
    try {
      await signUp(ALICE);
      await failTimes(ALICE, 12); // Alice's LOGIN is locked now
      const again = await call("signup", { body: { email: ALICE, password: PASSWORD } });
      const fresh = await call("signup", { body: { email: "new-person@example.com", password: PASSWORD } });
      expect(again.status).toBe(200);
      expect(again.body).toEqual({ ok: true, status: "check_email" });
      expect(fresh.status).toBe(again.status);
      expect(fresh.body).toEqual(again.body);
    } finally {
      delete process.env.RESEND_API_KEY;
      vi.unstubAllGlobals();
    }
  });
});

// ── 3. the cost of a login ─────────────────────────────────────────────────────────────────────────
describe("what a login costs", () => {
  it("a good login with no failure behind it: the attempt is counted before the password is checked (INCR + its end date), then wiped (DEL)", async () => {
    await signUp(ALICE);
    mocks.calls.length = 0;
    expect((await login(ALICE, PASSWORD)).status).toBe(200);
    expect(mocks.calls.filter((c) => ["get", "ttl", "incr", "expire", "del"].includes(c))).toEqual(["incr", "expire", "del"]);
  });

  it("a failed login is counted BEFORE the account is read: the increment and the end date (once), then the account read", async () => {
    await signUp(ALICE);
    mocks.calls.length = 0;
    expect((await login(ALICE, WRONG)).status).toBe(401);
    expect(mocks.calls).toEqual(["incr", "expire", "hgetall"]);
    mocks.calls.length = 0;
    await login(ALICE, WRONG);
    expect(mocks.calls).toEqual(["incr", "hgetall"]); // no second end date: the window is fixed
  });

  it("a locked login stops at the count: the account is not even read", async () => {
    await signUp(ALICE);
    await failTimes(ALICE, 10);
    mocks.calls.length = 0;
    expect((await login(ALICE, PASSWORD)).status).toBe(429);
    expect(mocks.calls).toEqual(["incr", "ttl"]);
  });
});

// ── 4. the website, the extension and the badge stay in step ───────────────────────────────────────
describe("the overlay follows the site, whatever happened to the password before", () => {
  it("a Pro account that mistyped its password 3 times logs in, the website hands the token to the extension, and the overlay's badge says Pro", async () => {
    await signUp(ALICE);
    await issueLicense(redis(), { email: ALICE, tier: "monthly", intentReference: "test-a11-pro", amountUsd: 0 });
    await failTimes(ALICE, 3);

    const ok = await login(ALICE, PASSWORD);
    expect(ok.status).toBe(200);
    const sync = await call("sync-token", { headers: { ...withCookie(tokenOf(ok.setCookie)), "x-antares-install": INSTALL } });
    expect(sync.status).toBe(200);
    const extensionCopy = sync.body.token as string;

    const overlayTier = async (token: string | null) =>
      (await resolveTier({ headers: token ? { "x-antares-session": token } : {} } as unknown as VercelRequest, INSTALL)).tier;
    expect(await overlayTier(extensionCopy)).toBe("pro");
    expect(await overlayTier(null)).toBe("free");
    expect(counterKeys()).toEqual([]); // the good login wiped the 3 failures
  });

  it("a locked Pro owner who is already signed in keeps the Pro badge: the lock never touches a session", async () => {
    await signUp(ALICE);
    await issueLicense(redis(), { email: ALICE, tier: "monthly", intentReference: "test-a11-pro2", amountUsd: 0 });
    const owner = tokenOf((await login(ALICE, PASSWORD)).setCookie);
    const copy = ((await call("sync-token", { headers: withCookie(owner) })).body.token) as string;
    await failTimes(ALICE, 10);
    expect((await login(ALICE, PASSWORD)).status).toBe(429);
    const tier = (await resolveTier({ headers: { "x-antares-session": copy } } as unknown as VercelRequest, INSTALL)).tier;
    expect(tier).toBe("pro");
  });
});
