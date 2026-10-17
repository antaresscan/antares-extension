// __tests__/audit-lot09.test.ts — Lot 9 of the file-by-file audit (2026-10-17): api/_lib/payments.ts, payment-confirm.ts,
// payment-reconcile.ts, nowpayments.ts. Each test fails on the previous code.
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Redis } from "@upstash/redis";

const mocks = vi.hoisted(() => ({ setUserTier: vi.fn(), issueLicense: vi.fn() }));
vi.mock("../api/_lib/user", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/user")>("../api/_lib/user");
  return { ...actual, setUserTier: mocks.setUserTier };
});
vi.mock("../api/_lib/license", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/license")>("../api/_lib/license");
  return { ...actual, issueLicense: mocks.issueLicense };
});

import { getPayment } from "../api/_lib/nowpayments";
import { confirmIntent } from "../api/_lib/payment-confirm";
import { reconcileIntent } from "../api/_lib/payment-reconcile";
import type { PaymentIntent } from "../api/_lib/payments";

function memoryRedis() {
  const store = new Map<string, unknown>();
  const writes = new Map<string, number>();
  const tick = () => Promise.resolve();
  const redis = {
    get: vi.fn(async (k: string) => { await tick(); return store.get(k) ?? null; }),
    set: vi.fn(async (k: string, v: unknown, o?: { nx?: boolean }) => {
      await tick();
      if (o?.nx && store.has(k)) return null;
      store.set(k, v);
      writes.set(k, (writes.get(k) ?? 0) + 1);
      return "OK";
    }),
    srem: vi.fn(async () => 1),
    sadd: vi.fn(async () => 1),
  };
  return { redis: redis as unknown as Redis, store, writes };
}

const intent = (over: Partial<PaymentIntent> = {}): PaymentIntent => ({
  reference: "ef".repeat(32), installId: "install-lot09-aaaa", tier: "monthly", amountUsd: 24.99, payUrl: "https://nowpayments.io/x",
  npInvoiceId: "inv-1", npPaymentId: "5404123456", createdAt: Date.now(), expiresAt: Date.now() + 3600_000, status: "pending", ...over,
});

beforeEach(() => {
  process.env.NOWPAYMENTS_API_KEY = "np-test-key";
  mocks.setUserTier.mockReset().mockResolvedValue(undefined);
  mocks.issueLicense.mockReset().mockResolvedValue({ key: "ANT-AAAA-BBBB-CCCC-DDDD" });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.NOWPAYMENTS_API_KEY;
});

describe("nowpayments — a call that hangs is cut, and 'not found' is read from the status", () => {
  it("a NOWPayments that never answers is given up after 8 s (it held the poll and the cron until Vercel killed them)", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_u: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")));
    })));
    let outcome = "hung";
    void getPayment("123", { strict: true }).then(() => { outcome = "resolved"; }, () => { outcome = "rejected"; });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(outcome).toBe("rejected");
  });

  it("a 500 on a payment whose id contains '404' is 'could not ask' (it was read as 'no payment', strict mode included)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream error", { status: 500 })));
    await expect(getPayment("5404123456", { strict: true })).rejects.toThrow();
  });
});

describe("payment-confirm — nothing is marked confirmed without being delivered", () => {
  it("a checkout without e-mail whose tier cannot be written stays pending (it was confirmed with nothing delivered, for good)", async () => {
    const m = memoryRedis();
    mocks.setUserTier.mockRejectedValue(new Error("ECONNRESET (simulated)"));
    await expect(confirmIntent(m.redis, intent())).rejects.toThrow();
    expect(m.store.get(`payment-intent:${"ef".repeat(32)}`)).toBeUndefined(); // not written as confirmed
  });

  it("two confirmations at the same moment for one install: the binding is written once (read-then-write wrote it twice)", async () => {
    const m = memoryRedis();
    await Promise.all([
      confirmIntent(m.redis, intent({ reference: "a1".repeat(32), email: "first@example.com" })),
      confirmIntent(m.redis, intent({ reference: "b2".repeat(32), email: "second@example.com" })),
    ]);
    expect(m.writes.get("account:install:install-lot09-aaaa")).toBe(1);
    expect(m.store.get("account:install:install-lot09-aaaa")).toBe("first@example.com");
  });
});

describe("payment-reconcile — the buyer is never shown the merchant's payout", () => {
  it("a finished payment with only payout_hash (NOWPayments paying us) stores no txSignature (it stored and showed the merchant's transaction)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      payment_id: "5404123456", payment_status: "finished", price_amount: 24.99, price_currency: "usd", actually_paid: 1, pay_amount: 1,
      payout_hash: "0xMERCHANT_PAYOUT",
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const m = memoryRedis();
    const r = await reconcileIntent(m.redis, intent({ email: "buyer@example.com" }));
    expect(r.state).toBe("confirmed");
    expect(JSON.stringify(r.intent)).not.toContain("0xMERCHANT_PAYOUT");
  });
});
