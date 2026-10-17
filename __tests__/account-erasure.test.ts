// __tests__/account-erasure.test.ts
//
// "Delete my account" (audit A-14b, GDPR article 17). privacy.html used to say "there is no data to access or delete"; it was false (accounts,
// licences, a scan history per install), and there was no way to delete anything. POST /api/auth/delete-account now erases the account, the
// link between its installs and its e-mail, their scan history and their stored plan. The record of what was bought is KEPT on purpose.
//
// Pinned here, in the order it matters to a user:
//   1. what is erased, and that NOTHING that names the e-mail is left behind except the record of purchases;
//   2. what is kept: the licences, so a customer who signs up again with the same e-mail gets their plan back and nothing paid is lost;
//   3. what is not touched: another account, and an install that belongs to somebody else (a shared browser);
//   4. who may ask: a session that counts AND the password; a wrong password counts against the login lock; a stolen session alone is not enough;
//   5. the old sessions stay dead even if the same e-mail signs up again; the plan stored on an erased install is not inherited by the next person
//      who signs in on that browser;
//   6. all or nothing: if the search for the installs does not finish, nothing is deleted and the account stays, so the request can be repeated;
//   7. the overlay of everybody else keeps working (the badge of an untouched Pro account is still Pro).
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const mocks = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  expires: new Map<string, number>(),
  /** Keys per page of SCAN, so that the walk needs several round trips. */
  scanPage: 1000,
  /** SCAN never reaches its end (cursor always 1), and every page costs 10 s of the clock. */
  scanNeverEnds: false,
  /** A DEL that names one of these keys throws (Redis hiccup in the middle of the erasure). */
  failDelOn: new Set<string>(),
}));

vi.mock("@upstash/redis", () => {
  const alive = (k: string) => {
    const at = mocks.expires.get(k);
    if (at !== undefined && at <= Date.now()) { mocks.store.delete(k); mocks.expires.delete(k); }
    return mocks.store.has(k);
  };
  class MockRedis {
    set = vi.fn(async (k: string, v: unknown, opts?: { nx?: boolean }) => {
      if (opts?.nx && alive(k)) return null;
      mocks.store.set(k, v); mocks.expires.delete(k);
      return "OK";
    });
    get = vi.fn(async (k: string) => (alive(k) ? mocks.store.get(k) ?? null : null));
    mget = vi.fn(async (...keys: string[]) => keys.map((k) => (alive(k) ? mocks.store.get(k) ?? null : null)));
    del = vi.fn(async (...keys: string[]) => {
      if (keys.some((k) => mocks.failDelOn.has(k))) throw new Error("redis hiccup");
      let n = 0;
      for (const k of keys) { mocks.expires.delete(k); if (mocks.store.delete(k)) n++; }
      return n;
    });
    scan = vi.fn(async (cursor: string | number, opts?: { match?: string; count?: number }) => {
      if (mocks.scanNeverEnds) { vi.setSystemTime(Date.now() + 10_000); return ["1", []] as [string, string[]]; }
      const prefix = (opts?.match ?? "*").replace(/\*$/, "");
      const all = [...mocks.store.keys()].filter((k) => alive(k) && k.startsWith(prefix));
      const from = Number(cursor);
      const page = all.slice(from, from + mocks.scanPage);
      const next = from + mocks.scanPage >= all.length ? "0" : String(from + mocks.scanPage);
      return [next, page] as [string, string[]];
    });
    incr = vi.fn(async (k: string) => {
      const n = (alive(k) ? Number(mocks.store.get(k)) : 0) + 1;
      mocks.store.set(k, String(n));
      return n;
    });
    expire = vi.fn(async (k: string, seconds: number) => { if (!alive(k)) return 0; mocks.expires.set(k, Date.now() + seconds * 1000); return 1; });
    ttl = vi.fn(async (k: string) => {
      if (!alive(k)) return -2;
      const at = mocks.expires.get(k);
      return at === undefined ? -1 : Math.ceil((at - Date.now()) / 1000);
    });
    lpush = vi.fn(async (k: string, ...v: string[]) => { const l = (mocks.store.get(k) as string[]) ?? []; mocks.store.set(k, [...v.reverse(), ...l]); return l.length + v.length; });
    lrange = vi.fn(async (k: string, a: number, b: number) => ((mocks.store.get(k) as string[]) ?? []).slice(a, b + 1));
    ltrim = vi.fn(async () => "OK");
    hset = vi.fn(async (k: string, fields: Record<string, string>) => {
      mocks.store.set(k, { ...((mocks.store.get(k) as Record<string, string>) ?? {}), ...fields });
      return Object.keys(fields).length;
    });
    hsetnx = vi.fn(async (k: string, f: string, v: string) => {
      const h = (mocks.store.get(k) as Record<string, string>) ?? {};
      if (f in h) return 0;
      mocks.store.set(k, { ...h, [f]: v });
      return 1;
    });
    hget = vi.fn(async (k: string, f: string) => { const h = mocks.store.get(k) as Record<string, string> | undefined; return h && f in h ? h[f] : null; });
    hgetall = vi.fn(async (k: string) => { const v = mocks.store.get(k); return v ? { ...(v as Record<string, string>) } : null; });
    hincrby = vi.fn(async (k: string, f: string, by: number) => {
      const h = (mocks.store.get(k) as Record<string, string>) ?? {};
      const n = Number(h[f] ?? 0) + by;
      mocks.store.set(k, { ...h, [f]: String(n) });
      return n;
    });
    sadd = vi.fn(async (k: string, ...members: string[]) => {
      const existing = (mocks.store.get(k) as Set<string>) ?? new Set<string>();
      let added = 0;
      for (const m of members) if (!existing.has(m)) { existing.add(m); added++; }
      mocks.store.set(k, existing);
      return added;
    });
    smembers = vi.fn(async (k: string) => { const v = mocks.store.get(k); return v ? [...(v as Set<string>)] : []; });
    pipeline = () => {
      const queued: Array<() => Promise<unknown>> = [];
      const p = {
        get: (k: string) => { queued.push(() => this.get(k)); return p; },
        ttl: (k: string) => { queued.push(() => this.ttl(k)); return p; },
        exec: async () => { const out: unknown[] = []; for (const q of queued) out.push(await q()); return out; },
      };
      return p;
    };
    multi = () => {
      const queued: Array<() => Promise<unknown>> = [];
      const tx = {
        hset: (k: string, f: Record<string, string>) => { queued.push(() => this.hset(k, f)); return tx; },
        sadd: (k: string, ...m: string[]) => { queued.push(() => this.sadd(k, ...m)); return tx; },
        set: (k: string, v: unknown) => { queued.push(() => this.set(k, v)); return tx; },
        del: (...k: string[]) => { queued.push(() => this.del(...k)); return tx; },
        expire: () => { queued.push(() => Promise.resolve(1)); return tx; },
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
import { eraseAccount, ERASURE_SCAN_BUDGET_MS } from "../api/_lib/account-erasure";
import { createAccount, getAccount } from "../api/_lib/account";
import { SESSION_COOKIE_NAME } from "../api/_lib/session-cookie";
import { LOGIN_MAX_FAILURES } from "../api/_lib/login-guard";
import { initUserStorage, resolveTier, setUserTier, pushScanHistory, getScanHistory, getUserTier } from "../api/_lib/user";
import { issueLicense, redeemLicense, getLicensesByEmail } from "../api/_lib/license";
import { ACCOUNT_KEY, ACCOUNT_INSTALL_KEY, TIER_KEY, TIER_EXPIRES_KEY, HISTORY_KEY } from "../api/_lib/keys";

const ORIGIN = "https://antares-website.vercel.app";
const INSTALL_A = "11111111-1111-4111-8111-111111111111";
const INSTALL_B = "22222222-2222-4222-8222-222222222222";
const INSTALL_C = "33333333-3333-4333-8333-333333333333";
const ALICE = "alice@example.com";
const BOB = "bob@example.com";
const CAROL = "carol@example.com";
const PASSWORD = "a-long-enough-password";

const redis = () => new Redis({ url: "x", token: "y" });
const has = (k: string) => mocks.store.has(k);
const entry = (n: number) => ({ ca: `Mint${n}`, score: 900, verdict: "SAFE", scannedAt: Date.now() - n * 1000 });

beforeEach(() => {
  mocks.store.clear();
  mocks.expires.clear();
  mocks.scanPage = 1000;
  mocks.scanNeverEnds = false;
  mocks.failDelOn.clear();
  process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash";
  process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token-thirty-two-chars-min-required";
  process.env.SESSION_SECRET = "0".repeat(64);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  initUserStorage(redis());
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.SESSION_SECRET;
  vi.restoreAllMocks();
});

// ── the real dispatcher, called the way Vercel calls it ────────────────────────────────────────────
interface Out { status: number; body: unknown; setCookie: string | null; headers: Record<string, string> }
function call(action: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Out> {
  const req = { method: opts.method ?? "POST", headers: { origin: ORIGIN, ...(opts.headers ?? {}) }, query: { action }, body: opts.body, socket: {} } as unknown as VercelRequest;
  const out: Out = { status: 200, body: null, setCookie: null, headers: {} };
  const res = {
    setHeader: (k: string, v: string) => { if (k === "Set-Cookie") out.setCookie = v; else out.headers[k] = v; return res; },
    status: (c: number) => { out.status = c; return res; },
    json: (b: unknown) => { out.body = b; return res; },
    end: () => res,
    headersSent: false,
  } as unknown as VercelResponse;
  return Promise.resolve(dispatcher(req, res)).then(() => out);
}
const tokenOf = (setCookie: string | null) => decodeURIComponent((setCookie ?? "").split(";")[0].split("=")[1] ?? "");
const withCookie = (token: string) => ({ cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}` });
const withHeader = (token: string) => ({ "x-antares-session": token });
const reqFor = (headers: Record<string, string>) => ({ headers }) as unknown as VercelRequest;

// A-01: a sign-up sends a link and signs nobody in, and an account owns nothing until its e-mail is confirmed: these tests start from an account that
// is confirmed (the real createAccount, then the flag the click would set), and log in.
async function signUp(email: string, password = PASSWORD): Promise<string> {
  await createConfirmedAccount(redis(), mocks.store, email, password);
  return tokenOf((await logIn(email, password)).setCookie);
}
async function logIn(email: string, password = PASSWORD): Promise<Out> {
  return call("login", { body: { email, password } });
}
async function buy(email: string, tier: "monthly" | "yearly" = "monthly") {
  return issueLicense(redis(), { email, tier, intentReference: `test-${email}-${tier}`, amountUsd: tier === "yearly" ? 149.99 : 24.99 });
}
/** The e-mail uses an install the way a real one does: redeems a licence on it (which binds it and stores the plan) and scans a few tokens. */
async function useInstall(email: string, installId: string, licenseKey: string) {
  const r = await redeemLicense(redis(), licenseKey, installId);
  expect(r.ok).toBe(true);
  await pushScanHistory(installId, entry(1));
  await pushScanHistory(installId, entry(2));
}
const del = (token: string, body: unknown = { password: PASSWORD }, extra: Record<string, string> = {}) =>
  call("delete-account", { headers: { ...withCookie(token), ...extra }, body });

/** Every key of the store, and every value, as text: used to ask "is there still something that names this e-mail?" */
function whatNames(email: string): string[] {
  const out: string[] = [];
  for (const [k, v] of mocks.store) {
    const value = v instanceof Set ? [...v].join(",") : JSON.stringify(v);
    if (k.includes(email) || value.includes(email)) out.push(k);
  }
  return out;
}

// ── 1. what is erased ──────────────────────────────────────────────────────────────────────────────
describe("what the erasure removes", () => {
  it("the account, the binding, the history and the stored plan of every install of the account: found through a licence, through the request, and through the walk", async () => {
    await createAccount(redis(), { email: ALICE, password: PASSWORD });
    const lic = await buy(ALICE);
    await useInstall(ALICE, INSTALL_A, lic.key);                                 // 1. found through the licence (redeemedBy)
    mocks.store.set(ACCOUNT_INSTALL_KEY(INSTALL_B), ALICE);                      // 3. found only by the walk (website sync, no licence)
    await pushScanHistory(INSTALL_B, entry(3));
    await setUserTier(INSTALL_B, "pro", Date.now() + 1e9);
    await pushScanHistory(INSTALL_C, entry(4));                                  // 2. found through the request: not bound at all
    await setUserTier(INSTALL_C, "pro");

    const r = await eraseAccount(redis(), ALICE, { installHint: INSTALL_C });
    expect(r).toEqual({ ok: true, installsErased: 3 });

    expect(has(ACCOUNT_KEY(ALICE))).toBe(false);
    for (const id of [INSTALL_A, INSTALL_B, INSTALL_C]) {
      expect(has(ACCOUNT_INSTALL_KEY(id)), `binding ${id}`).toBe(false);
      expect(has(HISTORY_KEY(id)), `history ${id}`).toBe(false);
      expect(has(TIER_KEY(id)), `tier ${id}`).toBe(false);
      expect(has(TIER_EXPIRES_KEY(id)), `tierExpires ${id}`).toBe(false);
    }
    expect(await getScanHistory(INSTALL_A)).toEqual([]);
    expect(await getUserTier(INSTALL_A)).toBe("free");
  });

  it("nothing that names the e-mail is left behind, except the record of purchases", async () => {
    await createAccount(redis(), { email: ALICE, password: PASSWORD });
    const lic = await buy(ALICE, "yearly");
    await useInstall(ALICE, INSTALL_A, lic.key);
    mocks.store.set(ACCOUNT_INSTALL_KEY(INSTALL_B), ALICE);

    expect(whatNames(ALICE).length).toBeGreaterThan(0); // the question is meaningful: before, there is something
    await eraseAccount(redis(), ALICE);

    const left = whatNames(ALICE);
    expect(left.every((k) => k.startsWith("license:") || k.startsWith("email:licenses:") || k.startsWith("intent:license:"))).toBe(true);
    expect(left.some((k) => k.startsWith("account:"))).toBe(false);
    expect(left.some((k) => k.startsWith("user:"))).toBe(false);
  });

  it("the walk goes through every page", async () => {
    await createAccount(redis(), { email: ALICE, password: PASSWORD });
    mocks.scanPage = 2;
    const ids = Array.from({ length: 7 }, (_, i) => `55555555-5555-4555-8555-55555555555${i}`);
    for (const id of ids) mocks.store.set(ACCOUNT_INSTALL_KEY(id), ALICE);
    for (let i = 0; i < 9; i++) mocks.store.set(`noise:${i}`, "x"); // other keys do not matter
    const r = await eraseAccount(redis(), ALICE);
    expect(r).toEqual({ ok: true, installsErased: 7 });
    for (const id of ids) expect(has(ACCOUNT_INSTALL_KEY(id))).toBe(false);
  });
});

// ── 2. what is kept ────────────────────────────────────────────────────────────────────────────────
describe("what the erasure keeps: the record of purchases", () => {
  it("the licences, their index by e-mail and the pointer from the payment stay exactly as they were", async () => {
    await createAccount(redis(), { email: ALICE, password: PASSWORD });
    const lic = await buy(ALICE);
    await useInstall(ALICE, INSTALL_A, lic.key);
    const snapshot = JSON.stringify([...mocks.store].filter(([k]) => k.startsWith("license:") || k.startsWith("email:licenses:") || k.startsWith("intent:license:")).map(([k, v]) => [k, v instanceof Set ? [...v] : v]));
    expect(snapshot.length).toBeGreaterThan(10);

    await eraseAccount(redis(), ALICE);

    const after = JSON.stringify([...mocks.store].filter(([k]) => k.startsWith("license:") || k.startsWith("email:licenses:") || k.startsWith("intent:license:")).map(([k, v]) => [k, v instanceof Set ? [...v] : v]));
    expect(after).toBe(snapshot);
    expect((await getLicensesByEmail(redis(), ALICE)).map((l) => l.key)).toEqual([lic.key]);
  });

  it("a customer who signs up again with the same e-mail gets their plan back: nothing paid is lost", async () => {
    const token = await signUp(ALICE);
    await buy(ALICE, "yearly");
    expect((await resolveTier(reqFor(withCookie(token)), INSTALL_A)).tier).toBe("yearly");

    expect((await del(token)).status).toBe(200);

    const again = await signUp(ALICE, "another-long-password"); // sign-up + confirmation of the new account, then login
    expect((await resolveTier(reqFor(withCookie(again)), INSTALL_A)).tier).toBe("yearly");
  });
});

// ── 3. what is not touched ─────────────────────────────────────────────────────────────────────────
describe("what the erasure never touches", () => {
  it("another account, with its installs, its history and its plan", async () => {
    await createAccount(redis(), { email: ALICE, password: PASSWORD });
    await createAccount(redis(), { email: BOB, password: PASSWORD });
    const a = await buy(ALICE);
    const b = await buy(BOB);
    await useInstall(ALICE, INSTALL_A, a.key);
    await useInstall(BOB, INSTALL_B, b.key);

    await eraseAccount(redis(), ALICE);

    expect((await getAccount(redis(), BOB))?.email).toBe(BOB);
    expect(mocks.store.get(ACCOUNT_INSTALL_KEY(INSTALL_B))).toBe(BOB);
    expect((await getScanHistory(INSTALL_B)).length).toBe(2);
    expect(await getUserTier(INSTALL_B)).toBe("pro");
  });

  it("an install bound to somebody else, however it was found (a licence, the request, the walk): a shared browser keeps the other person's data", async () => {
    await createAccount(redis(), { email: ALICE, password: PASSWORD });
    await createAccount(redis(), { email: BOB, password: PASSWORD });
    const a = await buy(ALICE);
    await useInstall(ALICE, INSTALL_A, a.key);
    // the install Alice redeemed on is now Bob's (he signed in on that browser and it was re-bound)
    mocks.store.set(ACCOUNT_INSTALL_KEY(INSTALL_A), BOB);

    const r = await eraseAccount(redis(), ALICE, { installHint: INSTALL_A });
    expect(r).toEqual({ ok: true, installsErased: 0 });
    expect(mocks.store.get(ACCOUNT_INSTALL_KEY(INSTALL_A))).toBe(BOB);
    expect((await getScanHistory(INSTALL_A)).length).toBe(2);
    expect(await getUserTier(INSTALL_A)).toBe("pro");
    expect(has(ACCOUNT_KEY(ALICE))).toBe(false); // her own account is gone all the same
  });

  it("an e-mail with no account: nothing to erase, nothing broken", async () => {
    const r = await eraseAccount(redis(), "ghost@example.com");
    expect(r.ok).toBe(true);
    expect(await eraseAccount(redis(), "not an e-mail")).toEqual({ ok: false, reason: "search_incomplete" });
  });
});

// ── 4. who may ask ─────────────────────────────────────────────────────────────────────────────────
describe("POST /api/auth/delete-account: who may ask", () => {
  it("only POST, and only from the website or the extension", async () => {
    expect((await call("delete-account", { method: "GET" })).status).toBe(405);
    expect((await call("delete-account", { headers: { origin: "https://attacker.example.com" } })).status).toBe(403);
  });

  it("nobody signed in: 401, nothing deleted", async () => {
    await signUp(ALICE);
    const r = await call("delete-account", { body: { email: ALICE, password: PASSWORD } });
    expect(r.status).toBe(401);
    expect(has(ACCOUNT_KEY(ALICE))).toBe(true);
  });

  it("a stolen session is not enough: without the password, nothing is deleted", async () => {
    const token = await signUp(ALICE);
    for (const body of [null, {}, { password: "" }, { password: "wrong-password-here" }, { password: 12345678 }]) {
      const r = await del(token, body);
      expect(r.status, JSON.stringify(body)).toBe(401);
      expect(r.body).toEqual({ ok: false, reason: "invalid_credentials" });
    }
    expect(has(ACCOUNT_KEY(ALICE))).toBe(true);
    expect((await call("me", { method: "GET", headers: withCookie(token) })).status).toBe(200); // and the session still works
  });

  it("a wrong password counts against the same lock as the login: 10 of them and even the right password is refused", async () => {
    const token = await signUp(ALICE);
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) expect((await del(token, { password: "wrong-password-here" })).status).toBe(401);
    const locked = await del(token, { password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(locked.headers["Retry-After"]).toBeDefined();
    expect(has(ACCOUNT_KEY(ALICE))).toBe(true);
    // the login of this e-mail is locked too: it is one lock, not two
    expect((await logIn(ALICE)).status).toBe(429);
  });

  it("a good password wipes the failures counted before", async () => {
    const token = await signUp(ALICE);
    for (let i = 0; i < 3; i++) await del(token, { password: "wrong-password-here" });
    expect((await del(token)).status).toBe(200);
    expect([...mocks.store.keys()].some((k) => k.startsWith("auth_fail:"))).toBe(false);
  });
});

// ── 5. the answer, and the sessions afterwards ─────────────────────────────────────────────────────
describe("after the erasure", () => {
  it("200 with the number of installs, the cookie is cleared, and the account cannot sign in or be read any more", async () => {
    const token = await signUp(ALICE);
    const lic = await buy(ALICE);
    await useInstall(ALICE, INSTALL_A, lic.key);

    const r = await del(token, { password: PASSWORD }, { "x-antares-install": INSTALL_A });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, installsErased: 1 });
    expect(r.setCookie).toContain("Max-Age=0");

    expect((await logIn(ALICE)).status).toBe(401);
    expect((await call("me", { method: "GET", headers: withCookie(token) })).status).toBe(401);
    expect((await call("sync-token", { headers: withCookie(token) })).status).toBe(401);
    expect((await call("me", { method: "GET", headers: withHeader(token) })).status).toBe(401); // the extension's copy
    expect((await resolveTier(reqFor(withHeader(token)), INSTALL_A)).tier).toBe("free");
  });

  it("the old sessions stay dead even when the same e-mail signs up again: its tokens (cookie, the extension's copy) are refused by the new account", async () => {
    const oldCookie = await signUp(ALICE);
    const oldExtensionCopy = ((await call("sync-token", { headers: withCookie(oldCookie) })).body as { token: string }).token;
    await buy(ALICE);
    expect((await del(oldCookie)).status).toBe(200);

    const newCookie = await signUp(ALICE); // the same e-mail signs up again, confirms, logs in
    expect((await call("me", { method: "GET", headers: withCookie(newCookie) })).status).toBe(200);
    expect((await call("me", { method: "GET", headers: withCookie(oldCookie) })).status).toBe(401);
    expect((await call("me", { method: "GET", headers: withHeader(oldExtensionCopy) })).status).toBe(401);
    expect((await resolveTier(reqFor(withHeader(oldExtensionCopy)), INSTALL_A)).tier).toBe("free"); // the badge of a stolen copy stays Free
    expect((await resolveTier(reqFor(withHeader(newCookie)), INSTALL_A)).tier).toBe("pro");
  });

  it("the plan stored on an erased install is not inherited by the next person who signs in on that browser", async () => {
    const aliceToken = await signUp(ALICE);
    const lic = await buy(ALICE, "yearly");
    await useInstall(ALICE, INSTALL_A, lic.key); // the install is bound to Alice and carries the yearly plan
    expect(await getUserTier(INSTALL_A)).toBe("yearly");

    expect((await del(aliceToken)).status).toBe(200);

    // Bob signs up on the same browser: the website binds the install to him (it is free now)
    const bobToken = await signUp(BOB);
    expect((await call("sync-token", { headers: { ...withCookie(bobToken), "x-antares-install": INSTALL_A } })).status).toBe(200);
    expect(mocks.store.get(ACCOUNT_INSTALL_KEY(INSTALL_A))).toBe(BOB);
    expect((await resolveTier(reqFor(withHeader(bobToken)), INSTALL_A)).tier).toBe("free");
  });

  it("the overlay of everybody else keeps working: an untouched Pro account is still Pro, the extension's copy of its session included", async () => {
    const aliceToken = await signUp(ALICE);
    const carolToken = await signUp(CAROL);
    const c = await buy(CAROL);
    await useInstall(CAROL, INSTALL_C, c.key);
    const carolCopy = ((await call("sync-token", { headers: { ...withCookie(carolToken), "x-antares-install": INSTALL_C } })).body as { token: string }).token;
    expect((await resolveTier(reqFor(withHeader(carolCopy)), INSTALL_C)).tier).toBe("pro");

    expect((await del(aliceToken)).status).toBe(200);

    expect((await resolveTier(reqFor(withHeader(carolCopy)), INSTALL_C)).tier).toBe("pro");
    expect((await call("me", { method: "GET", headers: withCookie(carolToken) })).status).toBe(200);
  });
});

// ── 6. all or nothing ──────────────────────────────────────────────────────────────────────────────
describe("all or nothing", () => {
  it("if the search for the installs does not finish in time, nothing is deleted and the answer says to try again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const token = await signUp(ALICE);
    const lic = await buy(ALICE);
    await useInstall(ALICE, INSTALL_A, lic.key);
    mocks.scanNeverEnds = true;

    const r = await del(token);
    expect(r.status).toBe(503);
    expect((r.body as { reason: string }).reason).toBe("try_again");
    expect(has(ACCOUNT_KEY(ALICE))).toBe(true);
    expect(has(ACCOUNT_INSTALL_KEY(INSTALL_A))).toBe(true);
    expect(has(HISTORY_KEY(INSTALL_A))).toBe(true);
    expect(has(TIER_KEY(INSTALL_A))).toBe(true);
    expect((await call("me", { method: "GET", headers: withCookie(token) })).status).toBe(200); // still signed in, can ask again

    mocks.scanNeverEnds = false; // the database answers again: the same request now works
    expect((await del(token)).status).toBe(200);
    expect(has(ACCOUNT_KEY(ALICE))).toBe(false);
  });

  it("the budget is small enough for a serverless call (10 s on the Hobby plan)", () => {
    expect(ERASURE_SCAN_BUDGET_MS).toBeLessThanOrEqual(7000);
  });

  it("the account goes LAST: a failure in the middle leaves it in place, and the request can be sent again", async () => {
    const token = await signUp(ALICE);
    const lic = await buy(ALICE);
    await useInstall(ALICE, INSTALL_A, lic.key);
    mocks.failDelOn.add(HISTORY_KEY(INSTALL_A));

    const r = await del(token);
    expect(r.status).toBe(500);
    expect(has(ACCOUNT_KEY(ALICE))).toBe(true);
    expect((await call("me", { method: "GET", headers: withCookie(token) })).status).toBe(200);

    mocks.failDelOn.clear();
    expect((await del(token)).status).toBe(200);
    expect(has(ACCOUNT_KEY(ALICE))).toBe(false);
    expect(has(HISTORY_KEY(INSTALL_A))).toBe(false);
  });
});

// ── 7. the source keeps it that way ────────────────────────────────────────────────────────────────
describe("the source keeps it that way", () => {
  const src = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8").split(String.fromCharCode(13)).join("");

  it("every key that is stored PER INSTALL (keys.ts) is erased by account-erasure.ts: a new per-install key cannot be forgotten", () => {
    const keys = src("api/_lib/keys.ts");
    const perInstall = [...keys.matchAll(/export const (\w+) = \((?:id|installId)\w*: string\) => `(?:user|account:install):/g)].map((m) => m[1]);
    expect(perInstall.sort()).toEqual(["ACCOUNT_INSTALL_KEY", "HISTORY_KEY", "TIER_EXPIRES_KEY", "TIER_KEY"]);
    const erasure = src("api/_lib/account-erasure.ts");
    for (const name of perInstall) expect(erasure, name).toMatch(new RegExp(`\\b${name}\\(installId\\)`));
  });

  it("the handler checks the session, the lock and the password BEFORE it erases anything, and never trusts an e-mail from the body", () => {
    const file = src("api/auth/[action].ts");
    const start = file.indexOf("async function handleDeleteAccount");
    const handler = file.slice(start, file.indexOf("// ── sync-token", start));
    const order = ["getAccountFromRequest(", "checkLoginLock(", "authenticate(", "eraseAccount("].map((s) => handler.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The attempt is counted by checkLoginLock itself, BEFORE the password is checked (audit lot 4: counting after the check let
    // concurrent guesses slip under the lock). A good password wipes the count.
    expect(handler).toMatch(/clearLoginFailures\(/);
    expect(handler).not.toMatch(/body\.email|readBody\(req\)\.email/);
  });

  it("the licences are not in the list of what is deleted", () => {
    const code = src("api/_lib/account-erasure.ts").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/LICENSE_KEY|EMAIL_LICENSES_KEY|INTENT_LICENSE_KEY|INTENT_KEY/);
  });
});
