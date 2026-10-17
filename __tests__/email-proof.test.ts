// __tests__/email-proof.test.ts
//
// E-mail proof (audit A-01). Anybody could sign up with ANY address, and licences are keyed by e-mail: knowing the address a customer paid with was
// enough to see, and use, their licences (and an address on DEV_LIFETIME_EMAILS / DEV_PRO_EMAILS was even given a licence). Now a sign-up creates an
// account that is UNCONFIRMED: it owns nothing until its owner opens the link in an e-mail AND types the password.
//
// What is pinned here, in the order it matters:
//   1. an unconfirmed account owns NOTHING: no plan, no licence in the list, no dev grant, no install bound to it;
//   2. the link alone does not confirm: the PASSWORD is asked too, which closes the "pre-hijack" (somebody signs up first with your address and a
//      password they know, then you click the link of the e-mail that arrives): that account can never be confirmed by you, nor by them;
//   3. a sign-up answers the same for every address (new, waiting, already an account): the form no longer tells who has an account;
//   4. the link works once, for 24 hours, and only as long as the account it was made for is the same one; a wrong password does not burn it and
//      counts against the same lock as the login;
//   5. the accounts that existed before the rule are honoured for a grace period and are sent their link, so nobody loses a plan overnight;
//   6. no secret in a log: no address, no link, no password, no key;
//   7. the mail service is only reached through one call, and when it is down nothing half-made is left behind.
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const mocks = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  /** key -> epoch ms when it disappears (set by EX / EXPIRE, removed by PERSIST). Read against Date.now(), which the tests can move. */
  expiresAt: new Map<string, number>(),
}));

vi.mock("@upstash/redis", () => {
  const alive = (k: string) => {
    const at = mocks.expiresAt.get(k);
    if (at !== undefined && at <= Date.now()) { mocks.store.delete(k); mocks.expiresAt.delete(k); }
    return mocks.store.has(k);
  };
  class MockRedis {
    set = vi.fn(async (k: string, v: unknown, opts?: { nx?: boolean; ex?: number }) => {
      if (opts?.nx && alive(k)) return null;
      mocks.store.set(k, v);
      if (opts?.ex) mocks.expiresAt.set(k, Date.now() + opts.ex * 1000); else mocks.expiresAt.delete(k);
      return "OK";
    });
    get = vi.fn(async (k: string) => (alive(k) ? mocks.store.get(k) ?? null : null));
    del = vi.fn(async (...keys: string[]) => { let n = 0; for (const k of keys) { mocks.expiresAt.delete(k); if (mocks.store.delete(k)) n++; } return n; });
    incr = vi.fn(async (k: string) => { const n = (alive(k) ? Number(mocks.store.get(k)) : 0) + 1; mocks.store.set(k, String(n)); return n; });
    expire = vi.fn(async (k: string, seconds: number) => { if (!alive(k)) return 0; mocks.expiresAt.set(k, Date.now() + seconds * 1000); return 1; });
    persist = vi.fn(async (k: string) => (mocks.expiresAt.delete(k) ? 1 : 0));
    ttl = vi.fn(async (k: string) => {
      if (!alive(k)) return -2;
      const at = mocks.expiresAt.get(k);
      return at === undefined ? -1 : Math.ceil((at - Date.now()) / 1000);
    });
    hset = vi.fn(async (k: string, fields: Record<string, string>) => {
      alive(k);
      mocks.store.set(k, { ...((mocks.store.get(k) as Record<string, string>) ?? {}), ...fields });
      return Object.keys(fields).length;
    });
    hsetnx = vi.fn(async (k: string, f: string, v: string) => { const h = (mocks.store.get(k) as Record<string, string>) ?? {}; if (f in h) return 0; mocks.store.set(k, { ...h, [f]: v }); return 1; });
    hget = vi.fn(async (k: string, f: string) => { if (!alive(k)) return null; const h = mocks.store.get(k) as Record<string, string> | undefined; return h && f in h ? h[f] : null; });
    hgetall = vi.fn(async (k: string) => (alive(k) && mocks.store.get(k) ? { ...(mocks.store.get(k) as Record<string, string>) } : null));
    hdel = vi.fn(async (k: string, ...fields: string[]) => { const h = mocks.store.get(k) as Record<string, string> | undefined; if (!h) return 0; let n = 0; for (const f of fields) if (f in h) { delete h[f]; n++; } return n; });
    hincrby = vi.fn(async (k: string, f: string, by: number) => { const h = (mocks.store.get(k) as Record<string, string>) ?? {}; const n = Number(h[f] ?? 0) + by; mocks.store.set(k, { ...h, [f]: String(n) }); return n; });
    sadd = vi.fn(async (k: string, ...members: string[]) => {
      const set = (mocks.store.get(k) as Set<string>) ?? new Set<string>();
      let added = 0;
      for (const m of members) if (!set.has(m)) { set.add(m); added++; }
      mocks.store.set(k, set);
      return added;
    });
    smembers = vi.fn(async (k: string) => { const v = mocks.store.get(k); return v ? [...(v as Set<string>)] : []; });
    mget = vi.fn(async (...keys: string[]) => keys.map((k) => (alive(k) ? mocks.store.get(k) ?? null : null)));
    scan = vi.fn(async (_cursor: string | number, opts?: { match?: string }) => {
      const prefix = (opts?.match ?? "*").replace(/\*$/, "");
      return ["0", [...mocks.store.keys()].filter((k) => alive(k) && k.startsWith(prefix))] as [string, string[]];
    });
    pipeline = () => {
      const queued: Array<() => Promise<unknown>> = [];
      const p = { get: (k: string) => { queued.push(() => this.get(k)); return p; }, ttl: (k: string) => { queued.push(() => this.ttl(k)); return p; }, exec: async () => { const out: unknown[] = []; for (const q of queued) out.push(await q()); return out; } };
      return p;
    };
    multi = () => {
      const queued: Array<() => Promise<unknown>> = [];
      const tx = {
        hset: (k: string, f: Record<string, string>) => { queued.push(() => this.hset(k, f)); return tx; },
        hdel: (k: string, ...f: string[]) => { queued.push(() => this.hdel(k, ...f)); return tx; },
        persist: (k: string) => { queued.push(() => this.persist(k)); return tx; },
        expire: (k: string, s: number) => { queued.push(() => this.expire(k, s)); return tx; },
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
import accountLicenses from "../api/account-licenses";
import { signSession, verifySession, getAccount, _resetSessionSecretCacheForTests } from "../api/_lib/account";
import { SESSION_COOKIE_NAME } from "../api/_lib/session-cookie";
import { initUserStorage, resolveTier } from "../api/_lib/user";
import { issueLicense } from "../api/_lib/license";
import { LOGIN_MAX_FAILURES } from "../api/_lib/login-guard";
import { signVerifyToken, parseVerifyToken } from "../api/_lib/email-verify";
import {
  emailProofOf, isEmailProven, LEGACY_ACCOUNTS_CREATED_BEFORE, LEGACY_GRACE_ENDS_AT, PENDING_ACCOUNT_TTL_SECONDS, VERIFY_TOKEN_TTL_MS,
  VERIFY_MAIL_COOLDOWN_MS, VERIFY_MAIL_ON_LOGIN_COOLDOWN_MS,
} from "../api/_lib/email-proof";
import { hashPassword } from "../api/_lib/account";

const SITE = "https://antaresscan.com";
const INSTALL = "11111111-1111-4111-8111-111111111111";
const ALICE = "alice@example.com";
const VICTIM = "victim@example.com";
const FOUNDER = "founder@example.com";
const PASSWORD = "a-long-enough-password";
const OTHER_PW = "another-long-password";
const HOUR = 3_600_000;

// ── the world around the handlers: the mail service, the log, the clock ─────────────────────────────
interface SentMail { url: string; method: string; headers: Record<string, string>; body: { from: string; to: string[]; subject: string; text: string; html: string } }
const sent: SentMail[] = [];
let resend: { status: number; throws: boolean } = { status: 200, throws: false };
const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
  if (resend.throws) throw new Error("network down");
  sent.push({ url: String(url), method: String(init?.method), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) as SentMail["body"] });
  return { ok: resend.status >= 200 && resend.status < 300, status: resend.status };
});
const logged: string[] = [];

const mailsTo = (address: string) => sent.filter((m) => m.body.to.includes(address));
const tokenOfMail = (m: SentMail): string => /verify\.html#t=([A-Za-z0-9_.-]+)/.exec(m.body.text)?.[1] ?? "";
const lastToken = (address: string): string => tokenOfMail(mailsTo(address).at(-1) as SentMail);
/** The secret inside a link (two links for the same account differ in their expiry, never in this). */
const nonceOf = (token: string): string => { const p = parseVerifyToken(token); return p.ok ? p.nonce : "not-a-token"; };

const redis = () => new Redis({ url: "x", token: "y" });
const acct = (email: string) => mocks.store.get(`account:${email}`) as Record<string, string> | undefined;
const expiresInMs = (key: string) => (mocks.expiresAt.get(key) ?? Infinity) - Date.now();

beforeEach(() => {
  mocks.store.clear();
  mocks.expiresAt.clear();
  sent.length = 0;
  logged.length = 0;
  resend = { status: 200, throws: false };
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash";
  process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token-thirty-two-chars-min-required";
  process.env.SESSION_SECRET = "0".repeat(64);
  process.env.RESEND_API_KEY = "re_test_key_value";
  delete process.env.MAIL_FROM;
  delete process.env.VERIFY_LINK_BASE;
  delete process.env.DEV_LIFETIME_EMAILS;
  delete process.env.DEV_PRO_EMAILS;
  _resetSessionSecretCacheForTests();
  for (const level of ["log", "info", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); });
  initUserStorage(redis());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "SESSION_SECRET", "RESEND_API_KEY", "MAIL_FROM", "VERIFY_LINK_BASE", "DEV_LIFETIME_EMAILS", "DEV_PRO_EMAILS"]) delete process.env[k];
});

// ── the real dispatcher, called the way Vercel calls it ──────────────────────────────────────────────
interface Out { status: number; body: unknown; setCookie: string | null; headers: Record<string, string> }
function call(action: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Out> {
  const req = { method: opts.method ?? "POST", headers: { origin: SITE, ...(opts.headers ?? {}) }, query: { action }, body: opts.body, socket: {} } as unknown as VercelRequest;
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
const reqFor = (headers: Record<string, string>) => ({ headers }) as unknown as VercelRequest;

const signup = (email: string, password = PASSWORD) => call("signup", { body: { email, password } });
const login = (email: string, password = PASSWORD) => call("login", { body: { email, password } });
const verify = (token: string, password = PASSWORD) => call("verify-email", { body: { token, password } });
const me = (cookie: string) => call("me", { method: "GET", headers: withCookie(cookie) });

/** Sign up, then open the link of the e-mail and type the password: the account is confirmed. Returns the cookie of the confirmation. */
async function signUpAndConfirm(email: string, password = PASSWORD): Promise<string> {
  expect((await signup(email, password)).status).toBe(200);
  const r = await verify(lastToken(email), password);
  expect(r.status).toBe(200);
  return tokenOf(r.setCookie);
}
/** A signed-in UNCONFIRMED account: sign-up, no click, login. */
async function signUpUnconfirmed(email: string, password = PASSWORD): Promise<string> {
  expect((await signup(email, password)).status).toBe(200);
  const r = await login(email, password);
  expect(r.status).toBe(200);
  return tokenOf(r.setCookie);
}
/** An account made before the rule: unconfirmed, no secret, no expiry, created a month before the cut-off. */
function seedLegacyAccount(email: string, password = PASSWORD, over: Record<string, string> = {}) {
  mocks.store.set(`account:${email}`, {
    id: "legacy-" + email, email, passwordHash: hashPassword(password), createdAt: String(LEGACY_ACCOUNTS_CREATED_BEFORE - 30 * 24 * HOUR), emailVerified: "0", ...over,
  });
}
const buy = (email: string, tier: "monthly" | "yearly" = "yearly") => issueLicense(redis(), { email, tier, intentReference: `ref-${email}-${tier}`, amountUsd: 149.99 });
const tierOf = async (cookie: string) => (await resolveTier(reqFor(withCookie(cookie)), INSTALL)).tier;

async function licensesOf(cookie: string): Promise<{ status: number; body: { ok: boolean; licenses: Array<{ key: string }>; emailProof?: string } }> {
  let status = 200; let body: unknown = null;
  const res = { setHeader: () => res, status: (c: number) => { status = c; return res; }, json: (b: unknown) => { body = b; return res; }, end: () => res } as unknown as VercelResponse;
  await accountLicenses({ method: "POST", headers: { origin: SITE, ...withCookie(cookie) }, query: {}, body: {}, socket: {} } as unknown as VercelRequest, res);
  return { status, body: body as { ok: boolean; licenses: Array<{ key: string }>; emailProof?: string } };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("the rule: who has proved their e-mail (pure)", () => {
  const confirmed = { emailVerified: true, createdAt: Date.now() };
  const brandNew = { emailVerified: false, createdAt: Date.now() };
  const legacy = { emailVerified: false, createdAt: LEGACY_ACCOUNTS_CREATED_BEFORE - 1 };

  it("a confirmed account is proven, whatever its age", () => {
    expect(emailProofOf(confirmed)).toBe("verified");
    expect(emailProofOf({ emailVerified: true, createdAt: 0 })).toBe("verified");
    expect(isEmailProven(confirmed)).toBe(true);
  });

  it("an account made after the rule and not confirmed is unverified: it owns nothing", () => {
    expect(emailProofOf(brandNew)).toBe("unverified");
    expect(isEmailProven(brandNew)).toBe(false);
  });

  it("an account made BEFORE the rule is honoured until the grace ends, and not a moment longer", () => {
    expect(emailProofOf(legacy, LEGACY_GRACE_ENDS_AT - 1)).toBe("grace");
    expect(isEmailProven(legacy, LEGACY_GRACE_ENDS_AT - 1)).toBe(true);
    expect(emailProofOf(legacy, LEGACY_GRACE_ENDS_AT)).toBe("unverified");
    expect(emailProofOf(legacy, LEGACY_GRACE_ENDS_AT + 400 * 24 * HOUR)).toBe("unverified");
  });

  it("the cut-off is exact: an account created AT it is new; one without a creation date is never granted the grace", () => {
    expect(emailProofOf({ emailVerified: false, createdAt: LEGACY_ACCOUNTS_CREATED_BEFORE }, 0)).toBe("unverified");
    expect(emailProofOf({ emailVerified: false, createdAt: 0 }, 0)).toBe("unverified");
  });

  it("the grace is a window, in the right order, and the numbers are the ones the page and the e-mails promise", () => {
    expect(LEGACY_GRACE_ENDS_AT).toBeGreaterThan(LEGACY_ACCOUNTS_CREATED_BEFORE);
    expect(PENDING_ACCOUNT_TTL_SECONDS).toBe(48 * 3600);
    expect(VERIFY_TOKEN_TTL_MS).toBe(24 * HOUR);
    expect(VERIFY_MAIL_COOLDOWN_MS).toBe(60_000);
    expect(VERIFY_MAIL_ON_LOGIN_COOLDOWN_MS).toBe(10 * 60_000);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("the link (the token)", () => {
  const NONCE = "n" + "a".repeat(32);

  it("carries the address and the secret, and says them back", () => {
    const parsed = parseVerifyToken(signVerifyToken(ALICE, NONCE));
    expect(parsed).toEqual({ ok: true, email: ALICE, nonce: NONCE });
  });

  it("is only made of characters that survive in a link and in the fragment of an address", () => {
    expect(signVerifyToken(ALICE, NONCE)).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("refuses a token whose text or signature was touched by one character", () => {
    const t = signVerifyToken(ALICE, NONCE);
    const [payload, sig] = t.split(".");
    const flip = (s: string) => s.slice(0, 5) + (s[5] === "A" ? "B" : "A") + s.slice(6);
    expect(parseVerifyToken(`${flip(payload)}.${sig}`).ok).toBe(false);
    expect(parseVerifyToken(`${payload}.${flip(sig)}`).ok).toBe(false);
    expect(parseVerifyToken(`${payload}.`).ok).toBe(false);
    expect(parseVerifyToken(`.${sig}`).ok).toBe(false);
    expect(parseVerifyToken(t + "x").ok).toBe(false);
    expect(parseVerifyToken(t.slice(0, -3)).ok).toBe(false);
  });

  it("refuses anything that is not a token, without throwing", () => {
    for (const v of [undefined, null, 42, {}, [], "", "abc", "a.b.c", "x".repeat(2000), "!!!.???"]) expect(parseVerifyToken(v).ok, String(v)).toBe(false);
  });

  it("runs out after 24 hours, to the millisecond", () => {
    const now = Date.now();
    const t = signVerifyToken(ALICE, NONCE, now);
    expect(parseVerifyToken(t, now + VERIFY_TOKEN_TTL_MS - 1).ok).toBe(true);
    expect(parseVerifyToken(t, now + VERIFY_TOKEN_TTL_MS + 1).ok).toBe(false);
  });

  it("cannot pass for a session token, and a session token cannot pass for a link (each has its own key)", () => {
    const session = signSession(ALICE);
    expect(parseVerifyToken(session).ok).toBe(false);
    expect(verifySession(signVerifyToken(ALICE, NONCE))).toBeNull();
  });

  it("is refused once the server secret changes", () => {
    const t = signVerifyToken(ALICE, NONCE);
    process.env.SESSION_SECRET = "f".repeat(64);
    _resetSessionSecretCacheForTests();
    expect(parseVerifyToken(t).ok).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("sign-up: the e-mail, and what it never does", () => {
  it("a new address: 200 'check_email', NO session cookie, the account is created UNCONFIRMED and expires by itself after 48 hours", async () => {
    const r = await signup(ALICE);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, status: "check_email" });
    expect(r.setCookie).toBeNull();
    expect(acct(ALICE)?.emailVerified).toBe("0");
    expect(acct(ALICE)?.verifyNonce).toMatch(/^n[0-9a-f]{32}$/);
    expect(expiresInMs(`account:${ALICE}`)).toBeLessThanOrEqual(PENDING_ACCOUNT_TTL_SECONDS * 1000);
    expect(expiresInMs(`account:${ALICE}`)).toBeGreaterThan(PENDING_ACCOUNT_TTL_SECONDS * 1000 - 5000);
  });

  it("sends ONE e-mail, to that address, through Resend, with the link in the fragment and no password in it", async () => {
    await signup(ALICE);
    expect(sent).toHaveLength(1);
    const m = sent[0];
    expect(m.url).toBe("https://api.resend.com/emails");
    expect(m.method).toBe("POST");
    expect(m.headers.Authorization).toBe("Bearer re_test_key_value");
    expect(m.headers["Content-Type"]).toBe("application/json");
    expect(m.body.to).toEqual([ALICE]);
    expect(m.body.from).toBe("Antares <contact@antaresscan.com>");
    expect(m.body.subject).toBe("Confirm your Antares account");
    for (const part of [m.body.text, m.body.html]) {
      expect(part).toContain("https://antares-extension.vercel.app/verify.html#t=");
      expect(part).not.toContain("?t=");
      expect(part).not.toContain(PASSWORD);
    }
    expect(parseVerifyToken(tokenOfMail(m))).toMatchObject({ ok: true, email: ALICE, nonce: acct(ALICE)?.verifyNonce });
  });

  it("the sender and the link base can be set on the deployment (MAIL_FROM, VERIFY_LINK_BASE)", async () => {
    process.env.MAIL_FROM = "Antares <no-reply@antaresscan.com>";
    process.env.VERIFY_LINK_BASE = "https://preview.example.vercel.app/";
    await signup(ALICE);
    expect(sent[0].body.from).toBe("Antares <no-reply@antaresscan.com>");
    expect(sent[0].body.text).toContain("https://preview.example.vercel.app/verify.html#t=");
  });

  it("the answer is the SAME for a new address, an address waiting for its confirmation, and an address that already has an account", async () => {
    const fresh = await signup("brand-new@example.com");
    const pending = await (async () => { await signup(ALICE); return signup(ALICE); })();
    await signUpAndConfirm(VICTIM);
    const taken = await signup(VICTIM, OTHER_PW);
    for (const r of [pending, taken]) {
      expect(r.status).toBe(fresh.status);
      expect(r.body).toEqual(fresh.body);
      expect(r.setCookie).toBeNull();
    }
  });

  it("an address that is waiting for its confirmation KEEPS the password it had: a second sign-up never replaces it", async () => {
    await signup(ALICE, PASSWORD); // the first one holds the address
    const second = await signup(ALICE, OTHER_PW);
    expect(second.status).toBe(200);
    expect((await login(ALICE, PASSWORD)).status).toBe(200);
    expect((await login(ALICE, OTHER_PW)).status).toBe(401);
  });

  it("the link is sent again by a second sign-up, but never more than once a minute, and it is the SAME link (the first e-mail keeps working)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now());
    await signup(ALICE);
    await signup(ALICE);
    expect(mailsTo(ALICE)).toHaveLength(1); // inside the minute: nothing more is sent
    vi.setSystemTime(Date.now() + VERIFY_MAIL_COOLDOWN_MS + 1000);
    await signup(ALICE);
    expect(mailsTo(ALICE)).toHaveLength(2);
    expect(nonceOf(tokenOfMail(mailsTo(ALICE)[1]))).toBe(nonceOf(tokenOfMail(mailsTo(ALICE)[0])));
    expect((await verify(tokenOfMail(mailsTo(ALICE)[0]))).status).toBe(200); // the first e-mail's link still opens it
  });

  it("an address that already has a (confirmed) account gets an e-mail that SAYS so, with no link to confirm anything, and not more than once an hour", async () => {
    await signUpAndConfirm(ALICE);
    sent.length = 0;
    await signup(ALICE, OTHER_PW);
    expect(mailsTo(ALICE)).toHaveLength(1);
    expect(mailsTo(ALICE)[0].body.subject).toBe("You already have an Antares account");
    expect(mailsTo(ALICE)[0].body.text).not.toContain("verify.html");
    expect(mailsTo(ALICE)[0].body.html).not.toContain("verify.html");
    await signup(ALICE, OTHER_PW);
    expect(mailsTo(ALICE)).toHaveLength(1);
    expect((await login(ALICE, PASSWORD)).status).toBe(200); // and nothing changed in the account
    expect((await login(ALICE, OTHER_PW)).status).toBe(401);
  });

  it("the cooldown key of that notice holds a hash of the address, never the address", async () => {
    await signUpAndConfirm(ALICE);
    await signup(ALICE, OTHER_PW);
    const keys = [...mocks.store.keys()].filter((k) => k.startsWith("signup-notice:"));
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^signup-notice:[0-9a-f]{64}$/);
  });

  it("what is wrong with the input is a 400, with no e-mail sent, whether or not the mail service is up", async () => {
    for (const withService of [true, false]) {
      if (!withService) delete process.env.RESEND_API_KEY;
      const bad = await signup("not-an-email");
      const weak = await signup(ALICE, "short");
      expect(bad.status).toBe(400);
      expect(bad.body).toEqual({ ok: false, reason: "invalid_email" });
      expect(weak.status).toBe(400);
      expect(weak.body).toEqual({ ok: false, reason: "weak_password" });
    }
    expect(sent).toHaveLength(0);
    expect(mocks.store.has(`account:${ALICE}`)).toBe(false);
  });

  it("with no RESEND_API_KEY nothing is created and the answer is 503, the same for every address (an account that could never be confirmed is useless)", async () => {
    delete process.env.RESEND_API_KEY;
    const a = await signup(ALICE);
    expect(a.status).toBe(503);
    expect(a.body).toEqual({ ok: false, reason: "email_unavailable" });
    expect(mocks.store.has(`account:${ALICE}`)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("when Resend refuses or cannot be reached, the answer is 503, and the person can simply try again (the address is not lost)", async () => {
    resend = { status: 500, throws: false };
    expect((await signup(ALICE)).status).toBe(503);
    resend = { status: 200, throws: true };
    expect((await signup(ALICE)).status).toBe(503);
    expect(acct(ALICE)?.emailVerified).toBe("0"); // it was created: the next sign-up (or login) sends the link again
    resend = { status: 200, throws: false };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + VERIFY_MAIL_COOLDOWN_MS + 1000);
    expect((await signup(ALICE)).status).toBe(200);
    // the refused attempt reached Resend (and is recorded), the one that could not connect never did, the last one went through
    expect(mailsTo(ALICE)).toHaveLength(2);
    expect(parseVerifyToken(lastToken(ALICE)).ok).toBe(true);
    expect((await verify(lastToken(ALICE))).status).toBe(200); // and the link of that last e-mail confirms the account
  });

  it("two sign-ups for the same new address at the same moment make ONE account and send ONE e-mail", async () => {
    const [a, b] = await Promise.all([signup(ALICE), signup(ALICE, OTHER_PW)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual(b.body);
    expect(mailsTo(ALICE)).toHaveLength(1);
    expect([...mocks.store.keys()].filter((k) => k.startsWith("account:") && !k.startsWith("account:install:"))).toEqual([`account:${ALICE}`]);
  });

  it("only POST, and only from the website, the extension or the API's own pages", async () => {
    expect((await call("signup", { method: "GET" })).status).toBe(405);
    expect((await call("signup", { headers: { origin: "https://attacker.example.com" } })).status).toBe(403);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("confirming: the link AND the password", () => {
  it("opens the account: confirmed, the secret is gone, the 48 h expiry is lifted, and the owner is signed in", async () => {
    await signup(ALICE);
    const r = await verify(lastToken(ALICE));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, email: ALICE });
    expect(r.setCookie).toContain(SESSION_COOKIE_NAME);
    expect(acct(ALICE)?.emailVerified).toBe("1");
    expect(acct(ALICE)?.verifyNonce).toBeUndefined();
    expect(mocks.expiresAt.has(`account:${ALICE}`)).toBe(false);
    const who = await me(tokenOf(r.setCookie));
    expect(who.body).toMatchObject({ ok: true, email: ALICE, emailVerified: true, emailProof: "verified" });
  });

  it("works ONCE: the same link a second time is refused", async () => {
    await signup(ALICE);
    const t = lastToken(ALICE);
    expect((await verify(t)).status).toBe(200);
    const again = await verify(t);
    expect(again.status).toBe(400);
    expect(again.body).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("a WRONG password does not confirm, does not burn the link, and the right one still works afterwards", async () => {
    await signup(ALICE);
    const t = lastToken(ALICE);
    const bad = await verify(t, OTHER_PW);
    expect(bad.status).toBe(401);
    expect(bad.body).toEqual({ ok: false, reason: "invalid_credentials" });
    expect(bad.setCookie).toBeNull();
    expect(acct(ALICE)?.emailVerified).toBe("0");
    expect((await verify(t, PASSWORD)).status).toBe(200);
  });

  it("wrong passwords count against the same lock as the login: 10 of them and even the right one is refused (429), on the login too", async () => {
    await signup(ALICE);
    const t = lastToken(ALICE);
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) expect((await verify(t, OTHER_PW)).status).toBe(401);
    const locked = await verify(t, PASSWORD);
    expect(locked.status).toBe(429);
    expect(locked.headers["Retry-After"]).toBeDefined();
    expect(acct(ALICE)?.emailVerified).toBe("0");
    expect((await login(ALICE, PASSWORD)).status).toBe(429);
  });

  it("a good confirmation wipes the failures counted before", async () => {
    await signup(ALICE);
    const t = lastToken(ALICE);
    for (let i = 0; i < 3; i++) await verify(t, OTHER_PW);
    expect((await verify(t, PASSWORD)).status).toBe(200);
    expect([...mocks.store.keys()].some((k) => k.startsWith("auth_fail:"))).toBe(false);
  });

  it("the link runs out after 24 hours", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now());
    await signup(ALICE);
    const t = lastToken(ALICE);
    vi.setSystemTime(Date.now() + VERIFY_TOKEN_TTL_MS + 60_000);
    const r = await verify(t);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, reason: "invalid_token" });
    expect(acct(ALICE)?.emailVerified).toBe("0");
  });

  it("a token that is not ours, was touched, is empty or missing is refused the same way, and changes nothing", async () => {
    await signup(ALICE);
    const t = lastToken(ALICE);
    const before = JSON.stringify(acct(ALICE));
    for (const bad of [undefined, "", "garbage", t.slice(0, -2) + "xx", t + "A", signSession(ALICE)]) {
      const r = await call("verify-email", { body: { token: bad, password: PASSWORD } });
      expect(r.status, String(bad)).toBe(400);
      expect(r.body).toEqual({ ok: false, reason: "invalid_token" });
    }
    expect((await call("verify-email", { body: {} })).status).toBe(400);
    expect(JSON.stringify(acct(ALICE))).toBe(before);
  });

  it("the account that the link was made for must still be there: a link for a deleted account, or one that was already confirmed, is refused", async () => {
    await signup(ALICE);
    const t = lastToken(ALICE);
    mocks.store.delete(`account:${ALICE}`);
    expect((await verify(t)).status).toBe(400);
    mocks.store.set(`account:${ALICE}`, { id: "x", email: ALICE, passwordHash: hashPassword(PASSWORD), createdAt: String(Date.now()), emailVerified: "1" });
    expect((await verify(t)).status).toBe(400);
  });

  it("the secret of the link must be the account's own: the link of an account that was deleted and made again does not open the new one", async () => {
    await signup(ALICE);
    const oldLink = lastToken(ALICE);
    mocks.store.delete(`account:${ALICE}`);
    mocks.expiresAt.delete(`account:${ALICE}`);
    await signup(ALICE);
    expect((await verify(oldLink)).status).toBe(400);
    expect((await verify(lastToken(ALICE))).status).toBe(200);
  });

  it("an account nobody confirms disappears after 48 hours, and the address can be used again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now());
    await signup(ALICE);
    vi.setSystemTime(Date.now() + (PENDING_ACCOUNT_TTL_SECONDS + 60) * 1000);
    expect((await login(ALICE)).status).toBe(401);
    expect(await getAccount(redis(), ALICE)).toBeNull();
    expect((await signup(ALICE, OTHER_PW)).status).toBe(200);
    expect((await login(ALICE, OTHER_PW)).status).toBe(200);
  });

  it("only POST, and only from the API's own pages, the website or the extension", async () => {
    expect((await call("verify-email", { method: "GET" })).status).toBe(405);
    expect((await call("verify-email", { headers: { origin: "https://attacker.example.com" }, body: { token: "x" } })).status).toBe(403);
    expect((await call("verify-email", { headers: { origin: "https://antares-extension.vercel.app" }, body: { token: "x" } })).status).toBe(400); // verify.html's own origin gets through
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("the pre-hijack: signing up first with somebody else's address", () => {
  it("the owner of the mailbox cannot confirm the account of someone who signed up first (they do not know that password), and the account stays unconfirmed", async () => {
    await signup(VICTIM, "attackers-password-1"); // the attacker, with the victim's address
    // the e-mail with the link lands in the VICTIM's mailbox; the victim opens it and types THEIR password
    const r = await verify(lastToken(VICTIM), "victims-own-password-1");
    expect(r.status).toBe(401);
    expect(r.setCookie).toBeNull();
    expect(acct(VICTIM)?.emailVerified).toBe("0");
  });

  it("the attacker cannot confirm it either: they cannot read the mailbox, and no token of their own passes", async () => {
    await signup(VICTIM, "attackers-password-1");
    for (const forged of [signVerifyToken(VICTIM, "n" + "0".repeat(32)), signSession(VICTIM), "x.y", "n" + "0".repeat(32)]) {
      expect((await verify(forged, "attackers-password-1")).status).toBe(400);
    }
    expect(acct(VICTIM)?.emailVerified).toBe("0");
  });

  it("the attacker's account owns nothing meanwhile: the victim's licence is not theirs, and it disappears with the 48 hours", async () => {
    await buy(VICTIM, "yearly"); // the victim paid on the site, with no account
    const cookie = await signUpUnconfirmed(VICTIM, "attackers-password-1");
    expect(await tierOf(cookie)).toBe("free");
    expect((await licensesOf(cookie)).body.licenses).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("what an unconfirmed account owns: nothing", () => {
  it("it can log in (to see why it is Free, and to ask for its link), and the login says it is not confirmed", async () => {
    await signup(ALICE);
    const r = await login(ALICE);
    expect(r.status).toBe(200);
    expect(r.setCookie).toContain(SESSION_COOKIE_NAME);
    expect(r.body).toMatchObject({ ok: true, email: ALICE, emailVerified: false, emailProof: "unverified" });
  });

  it("its plan is Free even though its e-mail owns a licence; once confirmed, the same account is Yearly", async () => {
    await buy(ALICE, "yearly");
    const cookie = await signUpUnconfirmed(ALICE);
    expect(await tierOf(cookie)).toBe("free");
    const confirmed = tokenOf((await verify(lastToken(ALICE))).setCookie);
    expect(await tierOf(confirmed)).toBe("yearly");
    // the old cookie of the same account sees it too, from the next request on (the plan is read from the account, not from the cookie)
    expect(await tierOf(cookie)).toBe("yearly");
  });

  it("the list of licences is empty and says why, and it gets the licences once confirmed", async () => {
    const lic = await buy(ALICE, "yearly");
    const cookie = await signUpUnconfirmed(ALICE);
    const before = await licensesOf(cookie);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ ok: true, licenses: [], emailProof: "unverified" });
    await verify(lastToken(ALICE));
    expect((await licensesOf(cookie)).body.licenses.map((l) => l.key)).toEqual([lic.key]);
  });

  it("no install is bound to it (sync-token still answers, it just binds nothing); the binding is written once it is confirmed", async () => {
    const cookie = await signUpUnconfirmed(ALICE);
    const headers = { ...withCookie(cookie), "x-antares-install": INSTALL };
    expect((await call("sync-token", { headers })).status).toBe(200);
    expect(mocks.store.has(`account:install:${INSTALL}`)).toBe(false);
    await verify(lastToken(ALICE));
    expect((await call("sync-token", { headers })).status).toBe(200);
    expect(mocks.store.get(`account:install:${INSTALL}`)).toBe(ALICE);
  });

  it("an address on the dev lists gets NO licence at sign-up, at login or while unconfirmed: anybody can type a founder's address", async () => {
    process.env.DEV_LIFETIME_EMAILS = FOUNDER;
    process.env.DEV_PRO_EMAILS = FOUNDER;
    await signUpUnconfirmed(FOUNDER);
    await login(FOUNDER);
    expect(mocks.store.has(`email:licenses:${FOUNDER}`)).toBe(false);
  });

  it("the founder, once the address is confirmed, gets the licences the dev lists promise", async () => {
    process.env.DEV_LIFETIME_EMAILS = FOUNDER;
    process.env.DEV_PRO_EMAILS = FOUNDER;
    await signUpAndConfirm(FOUNDER);
    expect((mocks.store.get(`email:licenses:${FOUNDER}`) as Set<string>).size).toBe(2);
  });

  it("it can still delete itself (the right to erasure does not wait for a confirmation)", async () => {
    const cookie = await signUpUnconfirmed(ALICE);
    const r = await call("delete-account", { headers: withCookie(cookie), body: { password: PASSWORD } });
    expect(r.status).toBe(200);
    expect(mocks.store.has(`account:${ALICE}`)).toBe(false);
  });

  it("`me` says where the account stands", async () => {
    const cookie = await signUpUnconfirmed(ALICE);
    expect((await me(cookie)).body).toMatchObject({ ok: true, emailVerified: false, emailProof: "unverified" });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("accounts that existed before the rule: a grace, and the link at the next login", () => {
  it("until the grace ends such an account keeps its plan and its licences, and `me` says it is on borrowed time", async () => {
    seedLegacyAccount(ALICE);
    await buy(ALICE, "yearly");
    const cookie = tokenOf((await login(ALICE)).setCookie);
    expect(await tierOf(cookie)).toBe("yearly");
    expect((await licensesOf(cookie)).body.licenses).toHaveLength(1);
    expect((await me(cookie)).body).toMatchObject({ emailVerified: false, emailProof: "grace", graceEndsAt: LEGACY_GRACE_ENDS_AT });
  });

  it("its next login sends the confirmation link, no more than once every 10 minutes, and never blocks the login", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LEGACY_ACCOUNTS_CREATED_BEFORE + HOUR);
    seedLegacyAccount(ALICE);
    expect((await login(ALICE)).status).toBe(200);
    expect(mailsTo(ALICE)).toHaveLength(1);
    expect(acct(ALICE)?.verifyNonce).toMatch(/^n[0-9a-f]{32}$/);
    expect((await login(ALICE)).status).toBe(200);
    expect(mailsTo(ALICE)).toHaveLength(1);
    vi.setSystemTime(Date.now() + VERIFY_MAIL_ON_LOGIN_COOLDOWN_MS + 1000);
    expect((await login(ALICE)).status).toBe(200);
    expect(mailsTo(ALICE)).toHaveLength(2);
    expect(nonceOf(tokenOfMail(mailsTo(ALICE)[1]))).toBe(nonceOf(tokenOfMail(mailsTo(ALICE)[0])));
    // and when the mail service is down the login still works
    resend = { status: 200, throws: true };
    vi.setSystemTime(Date.now() + VERIFY_MAIL_ON_LOGIN_COOLDOWN_MS + 1000);
    expect((await login(ALICE)).status).toBe(200);
  });

  it("when the grace ends, an account that never confirmed is Free and sees no licence", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LEGACY_ACCOUNTS_CREATED_BEFORE + HOUR);
    seedLegacyAccount(ALICE);
    await buy(ALICE, "yearly");
    const cookie = tokenOf((await login(ALICE)).setCookie);
    expect(await tierOf(cookie)).toBe("yearly");
    vi.setSystemTime(LEGACY_GRACE_ENDS_AT + HOUR);
    const later = tokenOf((await login(ALICE)).setCookie); // the first session ran out meanwhile (30 days)
    expect(await tierOf(later)).toBe("free");
    expect((await licensesOf(later)).body.licenses).toEqual([]);
    expect((await me(later)).body).toMatchObject({ emailProof: "unverified" });
  });

  it("confirming through the link makes it permanent: still Yearly long after the grace, and never deleted", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LEGACY_ACCOUNTS_CREATED_BEFORE + HOUR);
    seedLegacyAccount(ALICE);
    await buy(ALICE, "yearly");
    await login(ALICE); // sends the link
    expect(mocks.expiresAt.has(`account:${ALICE}`)).toBe(false); // an old account was never given an expiry
    expect((await verify(lastToken(ALICE))).status).toBe(200);
    vi.setSystemTime(LEGACY_GRACE_ENDS_AT + 90 * 24 * HOUR);
    const later = tokenOf((await login(ALICE)).setCookie); // the first session ran out meanwhile (30 days)
    expect(await tierOf(later)).toBe("yearly");
    expect(acct(ALICE)?.emailVerified).toBe("1");
  });

  it("an address with an old unconfirmed account that signs up again is not replaced: it gets its link (the password stays the old one)", async () => {
    seedLegacyAccount(ALICE, PASSWORD);
    expect((await signup(ALICE, OTHER_PW)).status).toBe(200);
    expect(mailsTo(ALICE)).toHaveLength(1);
    expect((await login(ALICE, PASSWORD)).status).toBe(200);
    expect((await login(ALICE, OTHER_PW)).status).toBe(401);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("asking for the link again (resend-verification)", () => {
  it("needs a session, and only POST", async () => {
    expect((await call("resend-verification")).status).toBe(401);
    expect((await call("resend-verification", { method: "GET" })).status).toBe(405);
  });

  it("a confirmed account has nothing to resend, and nothing is sent", async () => {
    const cookie = await signUpAndConfirm(ALICE);
    sent.length = 0;
    const r = await call("resend-verification", { headers: withCookie(cookie) });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, status: "already_verified" });
    expect(sent).toHaveLength(0);
  });

  it("an unconfirmed account gets its link again (the same one), never faster than once a minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now());
    const cookie = await signUpUnconfirmed(ALICE); // the sign-up sent the first link
    const first = await call("resend-verification", { headers: withCookie(cookie) });
    expect(first.status).toBe(429); // the sign-up's e-mail left a second ago
    expect(first.body).toMatchObject({ ok: false, reason: "too_soon" });
    expect(first.headers["Retry-After"]).toBeDefined();
    vi.setSystemTime(Date.now() + VERIFY_MAIL_COOLDOWN_MS + 1000);
    const ok = await call("resend-verification", { headers: withCookie(cookie) });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, status: "sent" });
    expect(mailsTo(ALICE)).toHaveLength(2);
    expect(nonceOf(tokenOfMail(mailsTo(ALICE)[1]))).toBe(nonceOf(tokenOfMail(mailsTo(ALICE)[0])));
    expect((await call("resend-verification", { headers: withCookie(cookie) })).status).toBe(429);
  });

  it("without the mail service, 503 (and nothing is sent)", async () => {
    const cookie = await signUpUnconfirmed(ALICE);
    sent.length = 0;
    delete process.env.RESEND_API_KEY;
    expect((await call("resend-verification", { headers: withCookie(cookie) })).status).toBe(503);
    expect(sent).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("nothing secret is ever written to a log", () => {
  it("not the address, the link, the secret, the password, nor the mail key: through a sign-up, a login, a wrong password, a confirmation, a resend and a failed send", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now());
    const cookie = await signUpUnconfirmed(ALICE, PASSWORD);
    const token = lastToken(ALICE);
    const nonce = acct(ALICE)?.verifyNonce ?? "never";
    await verify(token, OTHER_PW);
    vi.setSystemTime(Date.now() + VERIFY_MAIL_COOLDOWN_MS + 1000);
    await call("resend-verification", { headers: withCookie(cookie) });
    resend = { status: 500, throws: false };
    vi.setSystemTime(Date.now() + VERIFY_MAIL_COOLDOWN_MS + 1000);
    await call("resend-verification", { headers: withCookie(cookie) });
    resend = { status: 200, throws: true };
    vi.setSystemTime(Date.now() + VERIFY_MAIL_COOLDOWN_MS + 1000);
    await call("resend-verification", { headers: withCookie(cookie) });
    resend = { status: 200, throws: false };
    await verify(token, PASSWORD);
    await signup(ALICE, OTHER_PW); // the "already registered" notice

    const everything = logged.join("\n");
    expect(logged.length).toBeGreaterThan(0); // the flows did log something: the check below is not about silence
    for (const secret of [ALICE, "alice@", token, token.split(".")[0], nonce, PASSWORD, OTHER_PW, "re_test_key_value", "verify.html#t="]) {
      expect(everything, secret).not.toContain(secret);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("the source keeps it that way", () => {
  const src = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8").split(String.fromCharCode(13)).join("");
  const code = (file: string) => src(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const handlers = code("api/auth/[action].ts");
  const between = (from: string, to: string) => handlers.slice(handlers.indexOf(from), handlers.indexOf(to, handlers.indexOf(from) + 1));

  it("the sign-up never signs anybody in: no cookie is set between the start of handleSignup and the helper that follows it", () => {
    const signupCode = between("async function handleSignup", "async function sendVerificationMail");
    expect(signupCode.length).toBeGreaterThan(500);
    expect(signupCode).not.toMatch(/setSessionCookie|signSession|ensureDev/);
  });

  it("confirming reads the token, asks the lock, then confirms; a wrong password is counted; the link is never in a query string", () => {
    const v = between("async function handleVerifyEmail", "async function handleResendVerification");
    const order = ["parseVerifyToken(", "checkLoginLock(", "confirmEmail(", "clearLoginFailures("].map((s) => v.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // A wrong password is counted by checkLoginLock, which takes the count BEFORE confirmEmail checks the password (audit lot 4).
    expect(v).not.toMatch(/recordLoginFailure\(/);
    expect(v).not.toMatch(/req\.query|\.token\b.*query/);
  });

  it("the table of rights asks 'proven?' BEFORE it reads the bound e-mail, the dev e-mails or the licences", () => {
    const e = code("api/_lib/entitlements.ts");
    const at = (s: string) => e.indexOf(s);
    expect(at("!session.proven")).toBeGreaterThan(0);
    expect(at("!session.proven")).toBeLessThan(at("f.boundEmail()"));
    expect(at("!session.proven")).toBeLessThan(at("f.isDevEmail("));
    expect(at("!session.proven")).toBeLessThan(at("f.licenseTier("));
  });

  it("the e-mails carry the link in the FRAGMENT, and verify.html reads it there, wipes it from the address bar and posts it to the API", () => {
    expect(code("api/_lib/mail-templates.ts")).toContain("/verify.html#t=");
    expect(code("api/_lib/mail-templates.ts")).not.toMatch(/verify\.html\?/);
    const page = src("verify.html");
    expect(page).toContain("window.location.hash");
    expect(page).toContain("history.replaceState");
    expect(page).toContain("/api/auth/verify-email");
    expect(page).toMatch(/name="robots" content="noindex/);
    expect(page).toMatch(/name="referrer" content="no-referrer"/);
    expect(page).not.toMatch(/location\.search/);
  });

  it("the mailer logs the outcome and the status, never the address, the text or the key", () => {
    const m = code("api/_lib/mailer.ts");
    const loggerCalls = m.split("\n").filter((l) => /logger\./.test(l)).join("\n");
    expect(loggerCalls.length).toBeGreaterThan(0);
    expect(loggerCalls).not.toMatch(/mail\.(to|text|html|subject)|\bkey\b|Authorization/);
  });

  it("the licence list, the install binding and the dev grants all ask whether the e-mail is proven", () => {
    expect(code("api/account-licenses.ts")).toMatch(/isEmailProven\(account\)/);
    expect(handlers).toMatch(/installId && isEmailProven\(account\)/);
    expect(between("async function handleLogin", "// ── logout ──")).toMatch(/if \(isEmailProven\(outcome\.account\)\)[\s\S]*ensureDev/);
  });
});
