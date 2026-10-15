// __tests__/session-revocation.test.ts
//
// "Log out everywhere" (audit A-12). A session is a signed token valid 30 days and the server kept no list of them: logging out only forgot
// the token in one browser, and a copy that was stolen or left on another machine worked until it expired. Now every account has a session
// number, every token carries the number it was signed with, and a token only counts while the two are equal; POST /api/auth/logout-all
// raises the number.
//
// What is pinned here, in the order it matters to a user:
//   1. NOBODY is logged out by the deployment: a token signed before the number existed carries none, which reads as 0, the number of every
//      account until its first revocation. The cookie in the browser and the copy the extension keeps (synced from the website) both go on working.
//   2. After "log out everywhere", every token signed before is refused, in the website and in the extension; a fresh login works.
//   3. The site and the overlay stay in step: website sync-token -> the extension's X-Antares-Session -> the tier of the overlay's badge
//      (Pro, then Free after the revocation, then Pro again after a new login).
//   4. Nothing gets slower: the number is a field of the account hash that was already read on every request, so the session still costs
//      exactly ONE Redis command.
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const mocks = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  calls: [] as string[],
  /** What the client hands back for a hash value: "2" (a string, as stored) or 2 (when the client deserialises, which Upstash does). */
  deserialise: false,
}));

vi.mock("@upstash/redis", () => {
  class MockRedis {
    private log(name: string) { mocks.calls.push(name); }
    set = vi.fn(async (k: string, v: unknown, opts?: { nx?: boolean }) => {
      this.log("set");
      if (opts?.nx && mocks.store.has(k)) return null;
      mocks.store.set(k, v);
      return "OK";
    });
    get = vi.fn(async (k: string) => { this.log("get"); return mocks.store.get(k) ?? null; });
    del = vi.fn(async (k: string) => { this.log("del"); return mocks.store.delete(k) ? 1 : 0; });
    hset = vi.fn(async (k: string, fields: Record<string, string>) => {
      this.log("hset");
      const existing = (mocks.store.get(k) as Record<string, string>) ?? {};
      mocks.store.set(k, { ...existing, ...fields });
      return Object.keys(fields).length;
    });
    hget = vi.fn(async (k: string, field: string) => {
      this.log("hget");
      const h = mocks.store.get(k) as Record<string, string> | undefined;
      return h && field in h ? h[field] : null;
    });
    hgetall = vi.fn(async (k: string) => {
      this.log("hgetall");
      const v = mocks.store.get(k) as Record<string, unknown> | undefined;
      if (!v) return null;
      const out: Record<string, unknown> = { ...v };
      if (mocks.deserialise) for (const [f, x] of Object.entries(out)) if (typeof x === "string" && /^-?\d+$/.test(x) && f === "sessionVersion") out[f] = Number(x);
      return out;
    });
    hincrby = vi.fn(async (k: string, field: string, by: number) => {
      this.log("hincrby");
      const h = (mocks.store.get(k) as Record<string, string>) ?? {};
      const next = Number(h[field] ?? 0) + by;
      mocks.store.set(k, { ...h, [field]: String(next) });
      return next;
    });
    sadd = vi.fn(async (k: string, ...members: string[]) => {
      this.log("sadd");
      const existing = (mocks.store.get(k) as Set<string>) ?? new Set<string>();
      let added = 0;
      for (const m of members) if (!existing.has(m)) { existing.add(m); added++; }
      mocks.store.set(k, existing);
      return added;
    });
    smembers = vi.fn(async (k: string) => { this.log("smembers"); const v = mocks.store.get(k); return v ? [...(v as Set<string>)] : []; });
    multi = () => {
      const queued: Array<() => Promise<unknown>> = [];
      const tx = {
        hset: (k: string, f: Record<string, string>) => { queued.push(() => this.hset(k, f)); return tx; },
        sadd: (k: string, ...m: string[]) => { queued.push(() => this.sadd(k, ...m)); return tx; },
        set: (k: string, v: unknown) => { queued.push(() => this.set(k, v)); return tx; },
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
import dispatcher from "../api/auth/[action]";
import {
  signSession, verifySession, getAccount, createAccount, revokeAllSessions, parseSessionVersion, isCurrentSession,
  type SessionPayload, type Account,
} from "../api/_lib/account";
import { getAccountFromRequest, SESSION_COOKIE_NAME } from "../api/_lib/session-cookie";
import { initUserStorage, resolveTier } from "../api/_lib/user";
import { issueLicense } from "../api/_lib/license";

const ORIGIN = "https://antares-website.vercel.app";
const INSTALL = "11111111-1111-4111-8111-111111111111";
const ALICE = "alice@example.com";
const BOB = "bob@example.com";
const PASSWORD = "a-long-enough-password";

const redis = () => new Redis({ url: "x", token: "y" });
const account = (email: string) => mocks.store.get(`account:${email}`) as Record<string, string> | undefined;
/** The session number a new account was given: the time of its creation, not 0 (see createAccount). */
const startOf = (email: string) => Number(account(email)?.sessionVersion);

beforeEach(() => {
  mocks.store.clear();
  mocks.calls.length = 0;
  mocks.deserialise = false;
  process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash";
  process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token-thirty-two-chars-min-required";
  process.env.SESSION_SECRET = "0".repeat(64);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  initUserStorage(redis());
});
afterEach(() => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.SESSION_SECRET;
  vi.restoreAllMocks();
});

// ── helpers: the real dispatcher, called the way Vercel calls it ───────────────────────────────────
interface Out { status: number; body: unknown; setCookie: string | null }
function call(action: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Out> {
  const req = { method: opts.method ?? "POST", headers: { origin: ORIGIN, ...(opts.headers ?? {}) }, query: { action }, body: opts.body, socket: {} } as unknown as VercelRequest;
  const out: Out = { status: 200, body: null, setCookie: null };
  const res = {
    setHeader: (k: string, v: string) => { if (k === "Set-Cookie") out.setCookie = v; return res; },
    status: (c: number) => { out.status = c; return res; },
    json: (b: unknown) => { out.body = b; return res; },
    end: () => res,
    headersSent: false,
  } as unknown as VercelResponse;
  return Promise.resolve(dispatcher(req, res)).then(() => out);
}
const cookieOf = (setCookie: string | null) => (setCookie ?? "").split(";")[0]; // "antares_session=<token>"
const tokenOf = (setCookie: string | null) => decodeURIComponent(cookieOf(setCookie).split("=")[1] ?? "");
const withCookie = (token: string) => ({ cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}` });
const withHeader = (token: string) => ({ "x-antares-session": token });
const payloadOf = (token: string) => verifySession(token) as SessionPayload;

async function signUp(email: string): Promise<string> {
  const r = await call("signup", { body: { email, password: PASSWORD } });
  expect(r.status).toBe(200);
  return tokenOf(r.setCookie);
}
async function logIn(email: string): Promise<string> {
  const r = await call("login", { body: { email, password: PASSWORD } });
  expect(r.status).toBe(200);
  return tokenOf(r.setCookie);
}
async function givePro(email: string) {
  await issueLicense(redis(), { email, tier: "monthly", intentReference: `test-${email}-${Math.random()}`, amountUsd: 0 });
}
const reqFor = (headers: Record<string, string>) => ({ headers }) as unknown as VercelRequest;

// ── 1. the token and the number ────────────────────────────────────────────────────────────────────
describe("the session number in the token", () => {
  it("a token carries the number it was signed with (0 by default)", () => {
    expect(payloadOf(signSession(ALICE)).sv).toBe(0);
    expect(payloadOf(signSession(ALICE, Date.now(), 3)).sv).toBe(3);
  });

  it("a token whose number is not a whole number from 0 up is not one we signed", () => {
    const forge = (sv: unknown) => {
      const [h, , s] = signSession(ALICE).split(".");
      const payload = Buffer.from(JSON.stringify({ sub: ALICE, iat: 1, exp: Math.floor(Date.now() / 1000) + 3600, sv })).toString("base64url");
      return `${h}.${payload}.${s}`; // the signature no longer matches anyway: the number cannot be edited in a token
    };
    for (const sv of [-1, 1.5, "1", null, {}]) expect(verifySession(forge(sv))).toBeNull();
  });

  it("the number cannot be edited in a signed token: the signature fails", () => {
    const [h, p, s] = signSession(ALICE, Date.now(), 0).split(".");
    const edited = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString("utf8")), sv: 5 })).toString("base64url");
    expect(verifySession(`${h}.${edited}.${s}`)).toBeNull();
  });

  it("parseSessionVersion reads a string or a number, and treats anything else as 0", () => {
    expect(parseSessionVersion("2")).toBe(2);
    expect(parseSessionVersion(2)).toBe(2);
    for (const v of [undefined, null, "", "abc", -1, 1.5, "1.5", NaN]) expect(parseSessionVersion(v)).toBe(0);
  });

  it("getAccount reads the number whether the client gives it back as a string or as a number (Upstash deserialises)", async () => {
    mocks.store.set(`account:${ALICE}`, { email: ALICE, passwordHash: "x", createdAt: "1", emailVerified: "0", sessionVersion: "2" });
    expect((await getAccount(redis(), ALICE))?.sessionVersion).toBe(2);
    mocks.deserialise = true;
    expect((await getAccount(redis(), ALICE))?.sessionVersion).toBe(2);
    mocks.store.set(`account:${ALICE}`, { email: ALICE, passwordHash: "x", createdAt: "1", emailVerified: "0" }); // an account from before the number
    expect((await getAccount(redis(), ALICE))?.sessionVersion).toBe(0);
  });

  it("a new account starts at the time of its creation, never at 0: the tokens of a deleted account of the same e-mail must not revive", async () => {
    const before = Date.now();
    const r = await createAccount(redis(), { email: ALICE, password: PASSWORD });
    const after = Date.now();
    expect(r.ok).toBe(true);
    const n = r.ok ? r.account.sessionVersion : 0;
    expect(n).toBeGreaterThanOrEqual(before);
    expect(n).toBeLessThanOrEqual(after);
    expect(account(ALICE)?.sessionVersion).toBe(String(n)); // stored, so the account reads the same afterwards
    // a token of an older account of this e-mail (the number 0 of before this change, or any smaller one) is refused by the new account
    expect(isCurrentSession({ sub: ALICE, iat: 0, exp: 0 }, { sessionVersion: n } as Account)).toBe(false);
    expect(isCurrentSession({ sub: ALICE, iat: 0, exp: 0, sv: 5 }, { sessionVersion: n } as Account)).toBe(false);
  });

  it("isCurrentSession: equal numbers only; a token with no number reads as 0", () => {
    const acc = (n: number) => ({ sessionVersion: n }) as Account;
    expect(isCurrentSession({ sub: "a", iat: 0, exp: 0, sv: 2 }, acc(2))).toBe(true);
    expect(isCurrentSession({ sub: "a", iat: 0, exp: 0 }, acc(0))).toBe(true);
    expect(isCurrentSession({ sub: "a", iat: 0, exp: 0 }, acc(1))).toBe(false);
    expect(isCurrentSession({ sub: "a", iat: 0, exp: 0, sv: 0 }, acc(1))).toBe(false);
    expect(isCurrentSession({ sub: "a", iat: 0, exp: 0, sv: 3 }, acc(2))).toBe(false); // a number the account never reached
  });
});

// ── 2. nobody is logged out by the deployment ──────────────────────────────────────────────────────
describe("the deployment logs nobody out", () => {
  /** A token exactly as the code BEFORE this change signed it: no `sv` in it. */
  function legacyToken(email: string): string {
    const [h, p] = signSession(email).split(".");
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, unknown>;
    delete payload.sv;
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = createHmac("sha256", Buffer.from("0".repeat(64), "utf8")).update(`${h}.${body}`).digest("base64url");
    return `${h}.${body}.${sig}`;
  }

  it("a token signed before the number existed (no sv) still works for an account that has no number stored", async () => {
    mocks.store.set(`account:${ALICE}`, { email: ALICE, id: "1", passwordHash: "x", createdAt: "1", emailVerified: "0" }); // an account of before
    const token = legacyToken(ALICE);
    expect(payloadOf(token).sv).toBeUndefined(); // really the old shape
    const acc = await getAccountFromRequest(reqFor(withCookie(token)), redis());
    expect(acc?.email).toBe(ALICE);
    // and as the header the extension sends
    expect((await getAccountFromRequest(reqFor(withHeader(token)), redis()))?.email).toBe(ALICE);
  });

  it("the old-shape cookie and the extension's copy both still say Pro the day after the deployment", async () => {
    mocks.store.set(`account:${ALICE}`, { email: ALICE, id: "1", passwordHash: "x", createdAt: "1", emailVerified: "0" });
    await givePro(ALICE);
    const token = legacyToken(ALICE);
    expect((await resolveTier(reqFor(withCookie(token)), INSTALL)).tier).toBe("pro");
    expect((await resolveTier(reqFor(withHeader(token)), INSTALL)).tier).toBe("pro");
  });
});

// ── 3. the gate ────────────────────────────────────────────────────────────────────────────────────
describe("a token only counts while it carries the account's current number", () => {
  it("login signs the token with the account's number, and /me answers", async () => {
    await signUp(ALICE);
    const token = await logIn(ALICE);
    expect(payloadOf(token).sv).toBe(startOf(ALICE));
    const me = await call("me", { method: "GET", headers: withCookie(token) });
    expect(me.status).toBe(200);
    expect((me.body as { email: string }).email).toBe(ALICE);
  });

  it("after revokeAllSessions the tokens signed before are refused, and a token signed with the new number is accepted", async () => {
    await signUp(ALICE);
    const oldToken = await logIn(ALICE);
    const start = startOf(ALICE);
    expect(await revokeAllSessions(redis(), ALICE)).toBe(start + 1);
    expect(await getAccountFromRequest(reqFor(withCookie(oldToken)), redis())).toBeNull();
    expect(await getAccountFromRequest(reqFor(withHeader(oldToken)), redis())).toBeNull();
    const fresh = signSession(ALICE, Date.now(), start + 1);
    expect((await getAccountFromRequest(reqFor(withCookie(fresh)), redis()))?.email).toBe(ALICE);
  });

  it("a token with a number the account never reached is refused", async () => {
    await signUp(ALICE);
    expect(await getAccountFromRequest(reqFor(withCookie(signSession(ALICE, Date.now(), 7))), redis())).toBeNull();
  });

  it("revokeAllSessions raises the number by one each time, touches no other account, and creates nothing for an unknown one", async () => {
    await signUp(ALICE);
    await signUp(BOB);
    const start = startOf(ALICE);
    const bobStart = startOf(BOB);
    expect(await revokeAllSessions(redis(), ALICE)).toBe(start + 1);
    expect(await revokeAllSessions(redis(), ALICE)).toBe(start + 2);
    expect(account(ALICE)?.sessionVersion).toBe(String(start + 2));
    expect(account(BOB)?.sessionVersion).toBe(String(bobStart));
    expect(await revokeAllSessions(redis(), "ghost@example.com")).toBeNull();
    expect(mocks.store.has("account:ghost@example.com")).toBe(false);
    expect(await revokeAllSessions(redis(), "not an email")).toBeNull();
  });

  it("works when the client gives the number back as a number", async () => {
    await signUp(ALICE);
    const start = startOf(ALICE);
    await revokeAllSessions(redis(), ALICE);
    mocks.deserialise = true;
    expect(await getAccountFromRequest(reqFor(withCookie(signSession(ALICE, Date.now(), start + 1))), redis())).not.toBeNull();
    expect(await getAccountFromRequest(reqFor(withCookie(signSession(ALICE, Date.now(), start))), redis())).toBeNull();
  });
});

// ── 4. POST /api/auth/logout-all ───────────────────────────────────────────────────────────────────
describe("POST /api/auth/logout-all", () => {
  it("only POST", async () => {
    const r = await call("logout-all", { method: "GET" });
    expect(r.status).toBe(405);
  });

  it("an origin that is not the website or the extension is refused", async () => {
    const r = await call("logout-all", { headers: { origin: "https://attacker.example.com" } });
    expect(r.status).toBe(403);
  });

  it("nobody signed in: 401, and nothing is raised", async () => {
    await signUp(ALICE);
    const start = startOf(ALICE);
    const r = await call("logout-all");
    expect(r.status).toBe(401);
    expect(account(ALICE)?.sessionVersion).toBe(String(start));
  });

  it("a token that no longer counts cannot revoke anything either", async () => {
    await signUp(ALICE);
    const old = await logIn(ALICE);
    const start = startOf(ALICE);
    await revokeAllSessions(redis(), ALICE);
    const r = await call("logout-all", { headers: withCookie(old) });
    expect(r.status).toBe(401);
    expect(account(ALICE)?.sessionVersion).toBe(String(start + 1));
  });

  it("signed in: 200, this browser's cookie is cleared, the number is raised, and the OLD cookie is refused from then on", async () => {
    await signUp(ALICE);
    const token = await logIn(ALICE);
    const start = startOf(ALICE);

    const r = await call("logout-all", { headers: withCookie(token) });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(r.setCookie).toContain("Max-Age=0"); // cleared in the same answer
    expect(account(ALICE)?.sessionVersion).toBe(String(start + 1));

    expect((await call("me", { method: "GET", headers: withCookie(token) })).status).toBe(401);
    expect((await call("sync-token", { headers: withCookie(token) })).status).toBe(401);

    // signing in again works, with the new number
    const fresh = await logIn(ALICE);
    expect(payloadOf(fresh).sv).toBe(start + 1);
    expect((await call("me", { method: "GET", headers: withCookie(fresh) })).status).toBe(200);
  });

  it("the extension's header works the same way: it can ask, and its old copy is refused afterwards", async () => {
    await signUp(ALICE);
    const token = await logIn(ALICE);
    const r = await call("logout-all", { headers: withHeader(token) });
    expect(r.status).toBe(200);
    expect((await call("me", { method: "GET", headers: withHeader(token) })).status).toBe(401);
  });

  it("another account is not touched: bob keeps his session", async () => {
    await signUp(ALICE);
    await signUp(BOB);
    const aliceToken = await logIn(ALICE);
    const bobToken = await logIn(BOB);
    const bobStart = startOf(BOB);
    await call("logout-all", { headers: withCookie(aliceToken) });
    expect((await call("me", { method: "GET", headers: withCookie(bobToken) })).status).toBe(200);
    expect(account(BOB)?.sessionVersion).toBe(String(bobStart));
  });

  it("two browsers: signing out everywhere from one logs the other one out", async () => {
    await signUp(ALICE);
    const browserA = await logIn(ALICE);
    const browserB = await logIn(ALICE);
    expect((await call("me", { method: "GET", headers: withCookie(browserB) })).status).toBe(200);
    await call("logout-all", { headers: withCookie(browserA) });
    expect((await call("me", { method: "GET", headers: withCookie(browserA) })).status).toBe(401);
    expect((await call("me", { method: "GET", headers: withCookie(browserB) })).status).toBe(401);
  });

  it("the plain logout is unchanged: it clears the cookie and revokes nothing", async () => {
    await signUp(ALICE);
    const token = await logIn(ALICE);
    const start = startOf(ALICE);
    const r = await call("logout", { headers: withCookie(token) });
    expect(r.status).toBe(200);
    expect(r.setCookie).toContain("Max-Age=0");
    expect(account(ALICE)?.sessionVersion).toBe(String(start));
    expect((await call("me", { method: "GET", headers: withCookie(token) })).status).toBe(200); // the same token, if somebody kept a copy
  });
});

// ── 5. the website, the extension and the badge stay in step ───────────────────────────────────────
describe("the overlay follows the site: website -> sync-token -> the extension's header -> the tier of the badge", () => {
  const tierOfOverlay = async (token: string | null) =>
    (await resolveTier(reqFor(token ? withHeader(token) : {}), INSTALL)).tier;

  it("Pro with the token the website hands to the extension; Free once the account is logged out everywhere; Pro again after a new login", async () => {
    await signUp(ALICE);
    await givePro(ALICE);
    const cookie = await logIn(ALICE);

    // 1. the website asks for the token it will post to the extension's bridge
    const sync = await call("sync-token", { headers: { ...withCookie(cookie), "x-antares-install": INSTALL } });
    expect(sync.status).toBe(200);
    const extensionCopy = (sync.body as { token: string }).token;
    const start = startOf(ALICE);
    expect(payloadOf(extensionCopy).sv).toBe(start);

    // 2. the overlay's scans send it as X-Antares-Session: the badge says Pro
    expect(await tierOfOverlay(extensionCopy)).toBe("pro");
    // and without a session (logged out of the extension) it says Free, as before
    expect(await tierOfOverlay(null)).toBe("free");

    // 3. "log me out everywhere" from the website
    expect((await call("logout-all", { headers: withCookie(cookie) })).status).toBe(200);
    expect(await tierOfOverlay(extensionCopy)).toBe("free"); // the extension's stored copy no longer counts

    // 4. the user logs in again on the website: the new token reaches the extension, the badge is back
    const cookie2 = await logIn(ALICE);
    const sync2 = await call("sync-token", { headers: { ...withCookie(cookie2), "x-antares-install": INSTALL } });
    const extensionCopy2 = (sync2.body as { token: string }).token;
    expect(payloadOf(extensionCopy2).sv).toBe(start + 1);
    expect(await tierOfOverlay(extensionCopy2)).toBe("pro");
    expect(await tierOfOverlay(extensionCopy)).toBe("free"); // the old copy stays refused
  });

  it("a Free account stays Free through all of it (the badge never appears)", async () => {
    await signUp(BOB);
    const cookie = await logIn(BOB);
    const copy = ((await call("sync-token", { headers: withCookie(cookie) })).body as { token: string }).token;
    expect(await tierOfOverlay(copy)).toBe("free");
    await call("logout-all", { headers: withCookie(cookie) });
    expect(await tierOfOverlay(copy)).toBe("free");
  });
});

// ── 6. nothing gets slower ─────────────────────────────────────────────────────────────────────────
describe("nothing gets slower", () => {
  it("checking a session still costs exactly one Redis command (the number is a field of the account hash that was already read)", async () => {
    await signUp(ALICE);
    const token = await logIn(ALICE);
    mocks.calls.length = 0;
    const acc = await getAccountFromRequest(reqFor(withCookie(token)), redis());
    expect(acc?.email).toBe(ALICE);
    expect(mocks.calls).toEqual(["hgetall"]);
  });

  it("a refused token also costs one command, and a token with a bad signature costs none", async () => {
    await signUp(ALICE);
    const old = await logIn(ALICE);
    await revokeAllSessions(redis(), ALICE);
    mocks.calls.length = 0;
    expect(await getAccountFromRequest(reqFor(withCookie(old)), redis())).toBeNull();
    expect(mocks.calls).toEqual(["hgetall"]);
    mocks.calls.length = 0;
    expect(await getAccountFromRequest(reqFor(withCookie(`${old}x`)), redis())).toBeNull();
    expect(mocks.calls).toEqual([]);
  });

  it("the whole tier resolution of a signed-in Pro scan reads the same keys as before: the session adds nothing", async () => {
    await signUp(ALICE);
    await givePro(ALICE);
    const token = await logIn(ALICE);
    mocks.calls.length = 0;
    await resolveTier(reqFor(withHeader(token)), INSTALL);
    // the session (1 hgetall) + the install binding (1 get) + the licences (smembers, hgetall): nothing for the number
    expect(mocks.calls.filter((c) => c === "hgetall").length).toBe(2);
    expect(mocks.calls).not.toContain("hincrby");
    expect(mocks.calls).not.toContain("hget");
  });
});
