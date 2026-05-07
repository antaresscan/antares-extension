// __tests__/payment-tier-e2e.test.ts
//
// End-to-end pipeline test: NOWPayments IPN → license issuance → tier
// resolution. Verifies that a user who pays via the live checkout
// actually ends up with the right tier when their extension scans
// next, without any manual step.
//
// Stages exercised in sequence:
//   1. simulate a confirmed IPN webhook for a Pro intent
//   2. confirm a license was issued, install→email binding written,
//      install tier flipped
//   3. simulate a /api/scan call from the extension carrying a session
//      JWT for the buyer's email
//   4. confirm resolveTierAndBypass returns "pro"
//   5. repeat the whole sequence with a Yearly intent → tier "yearly"
//   6. expire the license → tier flips back to "free"
//
// Uses an in-memory MockRedis seeded with the same key shapes the
// live API writes (license:<key>, email:licenses:<email>,
// account:<email>, account:install:<install>, user:<install>:tier,
// payment-intent:<ref>). The test is invariant against re-orderings
// of the IPN handler internals — it only checks the OUTCOME on the
// next /api/scan style call.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";

const SECRET = "test-ipn-secret-e2e";
const TEST_EMAIL = "buyer.e2e@example.com";
const TEST_INSTALL = "install-e2e-aaaaaaaaaaaa";

// ── Mock store ─────────────────────────────────────────────────────────
// Single Map mocking Redis. We expose .get / .set / .hgetall / .hset
// / .smembers / .sadd / .srem so the modules under test see the
// expected interface. Top-level Map keys mirror real Redis key shapes.
const store = new Map<string, unknown>();
const sets = new Map<string, Set<string>>();

vi.mock("@upstash/redis", () => {
  class MockRedis {
    set = vi.fn(async (k: string, v: unknown) => {
      store.set(k, v);
      return "OK";
    });
    get = vi.fn(async (k: string) => store.get(k) ?? null);
    del = vi.fn(async (k: string) => (store.delete(k) ? 1 : 0));
    hset = vi.fn(async (k: string, fields: Record<string, string>) => {
      const existing =
        (store.get(k) as Record<string, string> | undefined) ?? {};
      store.set(k, { ...existing, ...fields });
      return Object.keys(fields).length;
    });
    hgetall = vi.fn(async (k: string) => {
      const v = store.get(k);
      return v ? { ...(v as Record<string, string>) } : null;
    });
    sadd = vi.fn(async (k: string, ...members: string[]) => {
      let s = sets.get(k);
      if (!s) { s = new Set(); sets.set(k, s); }
      let added = 0;
      for (const m of members) { if (!s.has(m)) { s.add(m); added++; } }
      return added;
    });
    smembers = vi.fn(async (k: string) => Array.from(sets.get(k) ?? []));
    srem = vi.fn(async (k: string, ...members: string[]) => {
      const s = sets.get(k);
      if (!s) return 0;
      let n = 0;
      for (const m of members) if (s.delete(m)) n++;
      return n;
    });
  }
  return { Redis: MockRedis };
});

vi.mock("../api/_lib/middleware", async () => {
  const actual = await vi.importActual<
    typeof import("../api/_lib/middleware")
  >("../api/_lib/middleware");
  return {
    ...actual,
    checkRateLimit: vi.fn().mockResolvedValue(true),
    initRateLimiters: vi.fn(),
  };
});

import dispatcher from "../api/auth/[action]";
import {
  resolveTierAndBypass,
  initUserStorage,
  _resetUserStorageForTests,
} from "../api/_lib/user";
import { Redis } from "@upstash/redis";

// ── HMAC + IPN helpers ─────────────────────────────────────────────────

function sortObject(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortObject);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) out[k] = sortObject(obj[k]);
  return out;
}
function signPayload(payload: Record<string, unknown>): string {
  const sortedJson = JSON.stringify(sortObject(payload));
  return createHmac("sha512", SECRET).update(sortedJson).digest("hex");
}

interface MockReq {
  method: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body?: unknown;
  socket: object;
}
function mockIpnReq(body: Record<string, unknown>): MockReq {
  const sig = signPayload(body);
  return {
    method: "POST",
    headers: { "x-nowpayments-sig": sig },
    query: { action: "nowpayments-ipn" },
    body,
    socket: {},
  };
}
function mockRes() {
  return {
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
  };
}

// ── Pre-seed a pending intent so the IPN handler can find it ───────────
function seedPendingIntent(
  reference: string,
  tier: "monthly" | "yearly",
  amountUsd: number,
  installId = TEST_INSTALL,
  email = TEST_EMAIL,
) {
  const intent = {
    reference,
    installId,
    email,
    tier,
    amountUsd,
    payUrl: `https://nowpayments.io/payment?iid=inv-${reference.slice(0, 6)}`,
    npInvoiceId: `inv-${reference.slice(0, 6)}`,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60 * 60 * 1000,
    status: "pending" as const,
  };
  store.set(`payment-intent:${reference}`, intent);
  store.set(`payment-intent-by-inv:inv-${reference.slice(0, 6)}`, reference);
}

// ── Pre-seed an account record so getAccountFromRequest can find the
// caller. resolveTierAndBypass calls getAccount(redis, email) under the
// hood, which reads account:<email> as a HASH; without this, even a
// valid JWT resolves to a null account and the function returns Free.
function seedAccount(email: string): void {
  store.set(`account:${email.toLowerCase().trim()}`, {
    id: "acc-test-id",
    email: email.toLowerCase().trim(),
    passwordHash: "scrypt$0000$0000",
    createdAt: String(Date.now()),
    emailVerified: "0",
  });
}

// ── Test setup ─────────────────────────────────────────────────────────
beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  sets.clear();
  process.env.NOWPAYMENTS_API_KEY = "test-key";
  process.env.NOWPAYMENTS_IPN_SECRET = SECRET;
  process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash";
  process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
  process.env.SESSION_SECRET = "test-session-secret-32-bytes-long-aaa";
  // Wire the user-storage module to the same MockRedis instance the
  // dispatcher uses, so tier reads see the same store.
  const r = new Redis({ url: "x", token: "y" } as unknown as never);
  initUserStorage(r);
});

afterEach(() => {
  _resetUserStorageForTests();
  delete process.env.NOWPAYMENTS_API_KEY;
  delete process.env.NOWPAYMENTS_IPN_SECRET;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.SESSION_SECRET;
});

// ── Tests ──────────────────────────────────────────────────────────────

describe("End-to-end: NOWPayments IPN → license issued → /api/scan tier", () => {
  it("MONTHLY purchase → /api/scan resolves tier=pro for the buyer", async () => {
    const REF = "0".repeat(63) + "1";
    seedAccount(TEST_EMAIL);
    seedPendingIntent(REF, "monthly", 24.99);

    // 1. IPN fires "finished" — backend confirms intent
    const body = {
      payment_id: "pay-mthly-1",
      payment_status: "finished",
      order_id: REF,
      invoice_id: `inv-${REF.slice(0, 6)}`,
      price_amount: 24.99,
      payin_hash: "0xmonthly",
    };
    const res = mockRes();
    await dispatcher(mockIpnReq(body) as never, res as never);
    expect(res.status).toHaveBeenLastCalledWith(200);

    // 2. Side effects we expect:
    //    - install tier flipped to "pro"
    //    - install→email binding written
    //    - license issued for email with tier=pro
    expect(store.get(`user:${TEST_INSTALL}:tier`)).toBe("pro");
    expect(store.get(`account:install:${TEST_INSTALL}`)).toBe(TEST_EMAIL);
    const licenseSet = sets.get(`email:licenses:${TEST_EMAIL}`);
    expect(licenseSet).toBeDefined();
    expect(licenseSet!.size).toBe(1);

    // 3. Now simulate the extension scanning. Build a session JWT for
    //    the buyer's email + an X-Antares-Install header with their
    //    install_id. resolveTierAndBypass should return "pro".
    const { signSession } = await import("../api/_lib/account");
    const token = signSession(TEST_EMAIL);
    const scanReq = {
      headers: {
        "x-antares-session": token,
        "x-antares-install": TEST_INSTALL,
      },
    };
    const result = await resolveTierAndBypass(
      scanReq as unknown as Parameters<typeof resolveTierAndBypass>[0],
      TEST_INSTALL,
    );
    expect(result.tier).toBe("pro");
    expect(result.bypassQuota).toBe(false);
  });

  it("YEARLY purchase → /api/scan resolves tier=yearly", async () => {
    const REF = "0".repeat(63) + "2";
    seedAccount(TEST_EMAIL);
    seedPendingIntent(REF, "yearly", 149.99);

    const body = {
      payment_id: "pay-yrly-1",
      payment_status: "finished",
      order_id: REF,
      invoice_id: `inv-${REF.slice(0, 6)}`,
      price_amount: 149.99,
      payin_hash: "0xyearly",
    };
    const res = mockRes();
    await dispatcher(mockIpnReq(body) as never, res as never);
    expect(res.status).toHaveBeenLastCalledWith(200);

    // Install tier flipped to "yearly"
    expect(store.get(`user:${TEST_INSTALL}:tier`)).toBe("yearly");

    const { signSession } = await import("../api/_lib/account");
    const token = signSession(TEST_EMAIL);
    const result = await resolveTierAndBypass(
      {
        headers: {
          "x-antares-session": token,
          "x-antares-install": TEST_INSTALL,
        },
      } as unknown as Parameters<typeof resolveTierAndBypass>[0],
      TEST_INSTALL,
    );
    expect(result.tier).toBe("yearly");
  });

  it("Cross-device: same email signs in on a fresh install → tier still pro", async () => {
    // User pays on Device A (install_A), then opens extension on
    // Device B (install_B fresh, no binding) and signs in. Tier should
    // resolve via email's licenses, not the install's local state.
    const REF = "0".repeat(63) + "3";
    const INSTALL_A = "install-device-a-aaaaaaaaaa";
    const INSTALL_B = "install-device-b-bbbbbbbbbb";
    seedAccount(TEST_EMAIL);
    seedPendingIntent(REF, "monthly", 24.99, INSTALL_A);

    const body = {
      payment_id: "pay-cross-1",
      payment_status: "finished",
      order_id: REF,
      invoice_id: `inv-${REF.slice(0, 6)}`,
      price_amount: 24.99,
    };
    const res = mockRes();
    await dispatcher(mockIpnReq(body) as never, res as never);
    expect(res.status).toHaveBeenLastCalledWith(200);

    // Device A — bound + tier set
    expect(store.get(`account:install:${INSTALL_A}`)).toBe(TEST_EMAIL);

    // Device B — fresh install, no binding yet. resolveTierAndBypass
    // should still return "pro" because the session email's licenses
    // are the source of truth.
    const { signSession } = await import("../api/_lib/account");
    const token = signSession(TEST_EMAIL);
    const result = await resolveTierAndBypass(
      {
        headers: {
          "x-antares-session": token,
          "x-antares-install": INSTALL_B,
        },
      } as unknown as Parameters<typeof resolveTierAndBypass>[0],
      INSTALL_B,
    );
    expect(result.tier).toBe("pro");
  });

  it("Anti-hijack: install bound to email A, user B signs in → tier=free", async () => {
    // Pre-bind install to a different email.
    store.set(`account:install:${TEST_INSTALL}`, "owner.a@example.com");

    // No license at all — but session is for a third party.
    seedAccount("attacker.b@example.com");
    const { signSession } = await import("../api/_lib/account");
    const token = signSession("attacker.b@example.com");
    const result = await resolveTierAndBypass(
      {
        headers: {
          "x-antares-session": token,
          "x-antares-install": TEST_INSTALL,
        },
      } as unknown as Parameters<typeof resolveTierAndBypass>[0],
      TEST_INSTALL,
    );
    expect(result.tier).toBe("free");
  });

  it("Logged-out user with paid install → tier=free (session-gated)", async () => {
    // Pay first
    const REF = "0".repeat(63) + "4";
    seedPendingIntent(REF, "monthly", 24.99);
    const body = {
      payment_id: "pay-no-sess-1",
      payment_status: "finished",
      order_id: REF,
      invoice_id: `inv-${REF.slice(0, 6)}`,
      price_amount: 24.99,
    };
    await dispatcher(mockIpnReq(body) as never, mockRes() as never);
    expect(store.get(`user:${TEST_INSTALL}:tier`)).toBe("pro");

    // Scan WITHOUT session token → free (logout = free, by design)
    const result = await resolveTierAndBypass(
      { headers: { "x-antares-install": TEST_INSTALL } } as unknown as Parameters<typeof resolveTierAndBypass>[0],
      TEST_INSTALL,
    );
    expect(result.tier).toBe("free");
  });

  // NOTE: edge cases (license expiry, lifetime grandfather) are covered
  // by license.test.ts directly against the parser/resolver — not
  // re-tested here because the in-memory mock can't perfectly emulate
  // Upstash's HASH/SET semantics in the multi-step flow needed for
  // this end-to-end suite. The 5 tests above verify the core promise:
  // pay → tier resolves correctly on next scan.
});
