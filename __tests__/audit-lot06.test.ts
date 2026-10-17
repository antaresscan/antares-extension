// __tests__/audit-lot06.test.ts — Lot 6 of the file-by-file audit (2026-10-17): api/auth/[action].ts, sync-token, me, the NOWPayments
// IPN and the dispatcher. Each test fails on the previous code.
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const mocks = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  failGets: new Set<string>(),
  writes: new Map<string, number>(),
  setUserTier: vi.fn(),
  issueLicense: vi.fn(),
  captureError: vi.fn(),
}));

vi.mock("@upstash/redis", () => {
  class MockRedis {
    set = vi.fn(async (k: string, v: unknown, opts?: { nx?: boolean; ex?: number }) => {
      await Promise.resolve(); // a network round trip: concurrent callers interleave here
      if (opts?.nx && mocks.store.has(k)) return null;
      mocks.store.set(k, v);
      mocks.writes.set(k, (mocks.writes.get(k) ?? 0) + 1);
      return "OK";
    });
    get = vi.fn(async (k: string) => {
      await Promise.resolve();
      if (mocks.failGets.has(k)) throw new Error("ECONNRESET (simulated)");
      return mocks.store.get(k) ?? null;
    });
    del = vi.fn(async (...keys: string[]) => { let n = 0; for (const k of keys) if (mocks.store.delete(k)) n++; return n; });
    hgetall = vi.fn(async (k: string) => {
      await Promise.resolve();
      const v = mocks.store.get(k);
      return v && typeof v === "object" ? { ...(v as object) } : null;
    });
    sadd = vi.fn().mockResolvedValue(1);
    srem = vi.fn().mockResolvedValue(1);
    smembers = vi.fn().mockResolvedValue([]);
  }
  return { Redis: MockRedis };
});
vi.mock("../api/_lib/middleware", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/middleware")>("../api/_lib/middleware");
  return { ...actual, checkRateLimit: vi.fn().mockResolvedValue(true), initRateLimiters: vi.fn() };
});
vi.mock("../api/_lib/user", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/user")>("../api/_lib/user");
  return { ...actual, initUserStorage: vi.fn(), setUserTier: mocks.setUserTier };
});
vi.mock("../api/_lib/license", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/license")>("../api/_lib/license");
  return { ...actual, issueLicense: mocks.issueLicense };
});
vi.mock("../api/_lib/sentry", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/sentry")>("../api/_lib/sentry");
  return { ...actual, captureError: mocks.captureError };
});

import dispatcher from "../api/auth/[action]";
import { signSession, verifySession } from "../api/_lib/account";
import { logger } from "../api/_lib/logger";
import { paymentRef } from "../api/_lib/log-ref";
import { scrubEvent } from "../shared/sentry-scrub";

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-10-17T10:00:00Z").getTime();
const ORIGIN = "https://antaresscan.com";
const IPN_SECRET = "ipn-test-secret-1234567890abcdef";
const REFERENCE = "ab".repeat(32);
const INSTALL = "install-audit-lot06-aaaa";

function seedAccount(email: string) {
  mocks.store.set(`account:${email}`, {
    id: `id-${email}`, email, passwordHash: "scrypt$00$00", createdAt: String(T0 - 400 * DAY), emailVerified: "1", sessionVersion: "0",
  });
}

async function call(action: string, opts: { headers?: Record<string, string>; body?: unknown } = {}) {
  const out = { status: 200, body: {} as Record<string, unknown> };
  const req = {
    method: "POST", headers: { "x-real-ip": "203.0.113.9", ...(opts.headers ?? {}) }, query: { action }, body: opts.body ?? {}, socket: {},
  } as unknown as VercelRequest;
  const res = {
    setHeader: () => res, status: (c: number) => { out.status = c; return res; },
    json: (b: Record<string, unknown>) => { out.body = b; return res; }, end: () => res, headersSent: false,
  } as unknown as VercelResponse;
  await dispatcher(req, res);
  return out;
}

function sortObject(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortObject);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as object).sort()) out[key] = sortObject((value as Record<string, unknown>)[key]);
  return out;
}
const ipn = (body: Record<string, unknown>) =>
  call("nowpayments-ipn", { headers: { "x-nowpayments-sig": createHmac("sha512", IPN_SECRET).update(JSON.stringify(sortObject(body))).digest("hex") }, body });

function seedPendingIntent() {
  mocks.store.set(`payment-intent:${REFERENCE}`, {
    reference: REFERENCE, installId: INSTALL, email: "buyer@example.com", tier: "monthly", amountUsd: 24.99,
    payUrl: "https://nowpayments.io/payment?iid=inv-9", npInvoiceId: "inv-9", createdAt: Date.now(), expiresAt: Date.now() + 3600_000,
    status: "pending",
  });
  mocks.store.set("payment-intent-by-inv:inv-9", REFERENCE);
}
const storedIntent = () => mocks.store.get(`payment-intent:${REFERENCE}`) as { status: string };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: T0 });
  mocks.store.clear();
  mocks.failGets.clear();
  mocks.writes.clear();
  mocks.setUserTier.mockReset().mockResolvedValue(undefined);
  mocks.captureError.mockReset();
  mocks.issueLicense.mockReset().mockResolvedValue({ key: "ANT-AAAA-BBBB-CCCC-DDDD" });
  process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash";
  process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
  process.env.SESSION_SECRET = "1".repeat(64);
  process.env.NOWPAYMENTS_IPN_SECRET = IPN_SECRET;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.NOWPAYMENTS_IPN_SECRET;
});

describe("sync-token — a session ends 60 days after the password was typed, however often it is re-issued", () => {
  it("a token handed back to sync-token every 29 days stops working on day 60 (it used to live for ever)", async () => {
    seedAccount("owner@example.com");
    let token = signSession("owner@example.com", T0, 0); // the sign-in
    for (const day of [29, 58]) {
      vi.setSystemTime(T0 + day * DAY);
      const r = await call("sync-token", { headers: { origin: ORIGIN, "x-antares-session": token } });
      expect(r.status).toBe(200);
      token = String(r.body.token);
    }
    expect(verifySession(token, T0 + 59 * DAY)).not.toBeNull(); // still inside the 60 days
    expect(verifySession(token, T0 + 61 * DAY)).toBeNull();     // was valid until day 88, and so on for ever
  });

  it("the website's path is unchanged: sync-token on the last day of the 30-day cookie gives a token that works until day 59", async () => {
    seedAccount("owner@example.com");
    const cookie = signSession("owner@example.com", T0, 0);
    vi.setSystemTime(T0 + 29 * DAY);
    const r = await call("sync-token", { headers: { origin: ORIGIN, cookie: `antares_session=${encodeURIComponent(cookie)}` } });
    expect(r.status).toBe(200);
    expect(verifySession(String(r.body.token), T0 + 59 * DAY - 1000)).not.toBeNull();
  });
});

describe("sync-token — an install is bound once: two sign-ins at the same moment do not both write", () => {
  it("two accounts syncing the same install concurrently: the binding is written once and is the first one", async () => {
    seedAccount("alice@example.com");
    seedAccount("bob@example.com");
    const a = signSession("alice@example.com", T0, 0);
    const b = signSession("bob@example.com", T0, 0);
    await Promise.all([
      call("sync-token", { headers: { origin: ORIGIN, "x-antares-session": a, "x-antares-install": INSTALL } }),
      call("sync-token", { headers: { origin: ORIGIN, "x-antares-session": b, "x-antares-install": INSTALL } }),
    ]);
    expect(mocks.writes.get(`account:install:${INSTALL}`)).toBe(1); // the read-then-write wrote twice, the second replacing the first
    expect(mocks.store.get(`account:install:${INSTALL}`)).toBe("alice@example.com");
  });
});

describe("nowpayments-ipn — a dead payment never undoes a paid intent", () => {
  it("the abandoned first attempt of an invoice expires AFTER the second one paid: the intent stays confirmed, and a re-delivered 'finished' does not grant the tier again", async () => {
    seedPendingIntent();
    const paid = { payment_id: "pay-2", payment_status: "finished", order_id: REFERENCE, invoice_id: "inv-9", actually_paid: 1, pay_amount: 1, payin_hash: "0xpaid" };
    expect((await ipn(paid)).status).toBe(200);
    expect(storedIntent().status).toBe("confirmed");
    expect(mocks.setUserTier).toHaveBeenCalledTimes(1);

    // The buyer had first picked another coin, then left that payment: NOWPayments now reports it expired, same order id.
    expect((await ipn({ payment_id: "pay-1", payment_status: "expired", order_id: REFERENCE, invoice_id: "inv-9" })).status).toBe(200);
    expect(storedIntent().status).toBe("confirmed"); // was "expired": the buyer's page lost its licence key

    expect((await ipn(paid)).status).toBe(200); // NOWPayments re-delivers the 'finished' event
    expect(mocks.setUserTier).toHaveBeenCalledTimes(1); // was 2: the tier was granted again, with a new end date
  });
});

describe("nowpayments-ipn — 'could not read the intent' is not 'no intent'", () => {
  it("a Redis error while looking the intent up answers 500 (NOWPayments retries), not 200 'ignored' (NOWPayments stops: paid, no licence)", async () => {
    seedPendingIntent();
    mocks.failGets.add(`payment-intent:${REFERENCE}`);
    const r = await ipn({ payment_id: "pay-3", payment_status: "finished", order_id: REFERENCE, invoice_id: "inv-9", actually_paid: 1, pay_amount: 1 });
    expect(r.status).toBe(500);
    expect(r.body.ignored).toBeUndefined();
    expect(mocks.issueLicense).not.toHaveBeenCalled();
  });
});

describe("logs — a checkout reference is never written whole (it hands out the licence key of a paid checkout)", () => {
  it("logger: the reference becomes its fingerprint, in every field the code uses for it; a readable reference stays readable", () => {
    const log = vi.mocked(console.log);
    logger.metric("audit.lot06", { reference: REFERENCE, orderId: REFERENCE, order_id: REFERENCE, intentReference: REFERENCE });
    logger.metric("audit.lot06.dev", { reference: "dev-grant-yearly" });
    const lines = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(lines).not.toContain(REFERENCE);
    expect(lines).toContain(String(paymentRef(REFERENCE)));
    expect(lines).toContain("dev-grant-yearly");
  });

  it("Sentry: orderId and intentReference are scrubbed like reference", () => {
    const ev: unknown = scrubEvent({ extra: { orderId: REFERENCE, intentReference: REFERENCE, order_id: REFERENCE } });
    expect(JSON.stringify(ev)).not.toContain(REFERENCE);
  });
});
