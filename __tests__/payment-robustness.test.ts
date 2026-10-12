// __tests__/payment-robustness.test.ts — audit A-04 / A-06 / A-16.
//
//   A-04  a real but slow payment must not find its intent expired and deleted, and a license that fails to issue must not
//         leave the intent "confirmed" with nothing behind it;
//   A-06  two callers confirming the same payment at the same moment (status poll, IPN, cron) get ONE license;
//   A-16  the underpayment guard compares what the buyer sent with what was asked, not the invoiced price with itself.
//
// Real code under test: payments.ts, payment-confirm.ts, payment-reconcile.ts, license.ts, nowpayments.ts (paidRatio,
// pickMostProgressed, strict lookups). Faked: Redis (in memory, with SET NX, MULTI and key lifetimes), the two NOWPayments
// lookups, and setUserTier.
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  sets: new Map<string, Set<string>>(),
  ttl: new Map<string, number | undefined>(),
  getPayment: vi.fn(),
  listPaymentsForInvoice: vi.fn(),
  setUserTier: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@upstash/redis", () => {
  class MockRedis {
    set = vi.fn(async (k: string, v: unknown, opts?: { nx?: boolean; ex?: number }) => {
      if (opts?.nx && mocks.store.has(k)) return null; // SET NX: already taken
      mocks.store.set(k, v);
      mocks.ttl.set(k, opts?.ex);
      return "OK";
    });
    get = vi.fn(async (k: string) => mocks.store.get(k) ?? null);
    del = vi.fn(async (k: string) => (mocks.store.delete(k) ? 1 : 0));
    hset = vi.fn(async (k: string, fields: Record<string, string>) => {
      const existing = (mocks.store.get(k) as Record<string, string>) ?? {};
      mocks.store.set(k, { ...existing, ...fields });
      return Object.keys(fields).length;
    });
    hgetall = vi.fn(async (k: string) => {
      const v = mocks.store.get(k);
      return v ? { ...(v as Record<string, string>) } : null;
    });
    sadd = vi.fn(async (k: string, ...members: string[]) => {
      const set = mocks.sets.get(k) ?? new Set<string>();
      members.forEach((m) => set.add(m));
      mocks.sets.set(k, set);
      return members.length;
    });
    srem = vi.fn(async (k: string, ...members: string[]) => {
      const set = mocks.sets.get(k);
      let n = 0;
      members.forEach((m) => { if (set?.delete(m)) n++; });
      return n;
    });
    smembers = vi.fn(async (k: string) => Array.from(mocks.sets.get(k) ?? []));
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

vi.mock("../api/_lib/nowpayments", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/nowpayments")>("../api/_lib/nowpayments");
  return { ...actual, getPayment: mocks.getPayment, listPaymentsForInvoice: mocks.listPaymentsForInvoice };
});

vi.mock("../api/_lib/user", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/user")>("../api/_lib/user");
  return { ...actual, initUserStorage: vi.fn(), setUserTier: mocks.setUserTier };
});

import { Redis } from "@upstash/redis";
import { reconcileIntent, findCanonicalPayment } from "../api/_lib/payment-reconcile";
import { confirmIntent } from "../api/_lib/payment-confirm";
import { issueLicense, INTENT_LICENSE_KEY, INTENT_LICENSE_LOCK_KEY, EMAIL_LICENSES_KEY, LICENSE_KEY } from "../api/_lib/license";
import {
  INTENT_KEY, INTENT_INDEX_KEY, INTENT_RETENTION_SECONDS, saveNewIntent, getPaymentIntent, type PaymentIntent,
} from "../api/_lib/payments";
import { paidRatio, pickMostProgressed, type NpPayment, type NpPaymentStatus } from "../api/_lib/nowpayments";

const REF = "c".repeat(64);
const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

const redis = () => new Redis({ url: "x", token: "y" });

function intent(over: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    reference: REF,
    installId: "install-test-aaaaaaaaaaaa",
    email: "buyer@example.com",
    tier: "monthly",
    amountUsd: 24.99,
    payUrl: "https://nowpayments.io/payment?iid=inv-1",
    npInvoiceId: "inv-1",
    createdAt: NOW - 2 * HOUR,
    expiresAt: NOW - HOUR, // the 1 h checkout window ended an hour ago
    status: "pending",
    ...over,
  };
}

const payment = (status: string, over: Partial<NpPayment> = {}): NpPayment => ({
  payment_id: "pay-1", payment_status: status as NpPaymentStatus, invoice_id: "inv-1", order_id: REF,
  price_amount: 24.99, price_currency: "usd", pay_amount: 0.4, actually_paid: 0.4, payin_hash: "0xabc", ...over,
});

const licenseHashes = () => [...mocks.store.keys()].filter((k) => k.startsWith("license:"));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.store.clear();
  mocks.sets.clear();
  mocks.ttl.clear();
  mocks.getPayment.mockReset().mockResolvedValue(null);
  mocks.listPaymentsForInvoice.mockReset().mockResolvedValue([]);
  mocks.setUserTier.mockReset().mockResolvedValue(undefined);
});

afterEach(() => { vi.useRealTimers(); });

// ═══ A-04 — a slow payment is not lost ═════════════════════════════════════════════════════════
describe("A-04: reconcileIntent expires on the provider's word, not on the clock alone", () => {
  it("a payment that finishes AFTER the checkout window still confirms the intent and issues the license", async () => {
    const r = redis();
    mocks.listPaymentsForInvoice.mockResolvedValue([payment("finished")]);
    const res = await reconcileIntent(r, intent(), NOW);
    expect(res.state).toBe("confirmed");
    expect(res.state === "confirmed" && res.licenseKey).toMatch(/^ANT-/);
    expect(mocks.setUserTier).toHaveBeenCalledOnce();
  });

  it("window over and NO payment on the invoice: expired", async () => {
    const r = redis();
    const res = await reconcileIntent(r, intent(), NOW);
    expect(res.state).toBe("expired");
    expect(mocks.setUserTier).not.toHaveBeenCalled();
  });

  it("window not over and no payment yet: pending", async () => {
    const res = await reconcileIntent(redis(), intent({ expiresAt: NOW + HOUR }), NOW);
    expect(res.state).toBe("pending");
  });

  it("window over but a payment is in flight (confirming / waiting / partially paid / no longer 'waiting' for the buyer): stays pending", async () => {
    for (const status of ["waiting", "confirming", "partially_paid"]) {
      mocks.listPaymentsForInvoice.mockResolvedValue([payment(status)]);
      const res = await reconcileIntent(redis(), intent(), NOW);
      expect(res.state, status).toBe("pending");
    }
  });

  it("NOWPayments cannot be asked (strict lookup throws): the intent is NOT expired, the error comes back to the caller", async () => {
    mocks.listPaymentsForInvoice.mockRejectedValue(new Error("NOWPayments /payment/ failed: 503"));
    await expect(reconcileIntent(redis(), intent(), NOW)).rejects.toThrow(/503/);
    expect(mocks.listPaymentsForInvoice).toHaveBeenCalledWith("inv-1", { strict: true });
  });

  it("the provider says the payment is dead (failed / expired / refunded): expired", async () => {
    for (const status of ["failed", "expired", "refunded"]) {
      mocks.listPaymentsForInvoice.mockResolvedValue([payment(status)]);
      const res = await reconcileIntent(redis(), intent({ expiresAt: NOW + HOUR }), NOW);
      expect(res.state, status).toBe("expired");
    }
  });

  it("a bound payment that died but a retry on the same invoice finished: the retry wins", async () => {
    mocks.getPayment.mockResolvedValue(payment("failed", { payment_id: "pay-old" }));
    mocks.listPaymentsForInvoice.mockResolvedValue([payment("failed", { payment_id: "pay-old" }), payment("finished", { payment_id: "pay-new" })]);
    const res = await reconcileIntent(redis(), intent({ npPaymentId: "pay-old" }), NOW);
    expect(res.state).toBe("confirmed");
    expect(mocks.getPayment).toHaveBeenCalledWith("pay-old", { strict: true });
  });

  it("findCanonicalPayment takes the bound payment when it is alive (fast path, no listing)", async () => {
    mocks.getPayment.mockResolvedValue(payment("confirming", { payment_id: "pay-bound" }));
    const p = await findCanonicalPayment(intent({ npPaymentId: "pay-bound" }));
    expect(p?.payment_id).toBe("pay-bound");
    expect(mocks.listPaymentsForInvoice).not.toHaveBeenCalled();
  });

  it("every key of an intent lives 7 days (not 1 h), including an intent marked expired", async () => {
    const r = redis();
    await saveNewIntent(r, intent({ expiresAt: NOW + HOUR }));
    expect(mocks.ttl.get(INTENT_KEY(REF))).toBe(INTENT_RETENTION_SECONDS);
    expect(mocks.ttl.get("payment-intent-by-inv:inv-1")).toBe(INTENT_RETENTION_SECONDS);
    expect(INTENT_RETENTION_SECONDS).toBe(7 * 24 * 60 * 60);

    await reconcileIntent(r, intent(), NOW); // no payment, window over: marked expired
    expect((await getPaymentIntent(r, REF))?.status).toBe("expired");
    expect(mocks.ttl.get(INTENT_KEY(REF))).toBe(INTENT_RETENTION_SECONDS); // markIntentExpired used to keep it 1 h
    expect(mocks.sets.get(INTENT_INDEX_KEY)?.has(REF) ?? false).toBe(false);
  });

  it("a payment that lands after the intent was marked expired (late IPN) still confirms it", async () => {
    const r = redis();
    const res = await confirmIntent(r, intent({ status: "expired" }), { paidRatio: 1 });
    expect(res.ok).toBe(true);
    expect(res.ok && res.intent.status).toBe("confirmed");
    expect(mocks.setUserTier).toHaveBeenCalledOnce();
  });
});

describe("A-04: a license that fails to issue leaves the intent pending, to be retried", () => {
  it("confirmIntent rethrows, the intent is NOT marked confirmed; the retry then succeeds with ONE license", async () => {
    const r = redis();
    const pending = intent({ expiresAt: NOW + HOUR });
    await saveNewIntent(r, pending);

    // The multi() that writes the license fails once (a Redis hiccup).
    const multiSpy = vi.spyOn(r as unknown as { multi: () => unknown }, "multi").mockImplementationOnce(() => { throw new Error("redis hiccup"); });
    await expect(confirmIntent(r, pending, { paidRatio: 1 })).rejects.toThrow(/redis hiccup/);
    multiSpy.mockRestore();

    expect((await getPaymentIntent(r, REF))?.status).toBe("pending");
    expect(mocks.sets.get(INTENT_INDEX_KEY)?.has(REF)).toBe(true); // still in the index: the cron will come back to it
    expect(licenseHashes()).toHaveLength(0);

    const retry = await confirmIntent(r, pending, { paidRatio: 1 });
    expect(retry.ok && retry.licenseKey).toMatch(/^ANT-/);
    expect((await getPaymentIntent(r, REF))?.status).toBe("confirmed");
    expect(licenseHashes()).toHaveLength(1);
  });

  it("reconcileIntent propagates the failure (the poll and the cron log it, the IPN answers 500 so NOWPayments retries)", async () => {
    const r = redis();
    mocks.listPaymentsForInvoice.mockResolvedValue([payment("finished")]);
    vi.spyOn(r as unknown as { multi: () => unknown }, "multi").mockImplementationOnce(() => { throw new Error("redis hiccup"); });
    await expect(reconcileIntent(r, intent({ expiresAt: NOW + HOUR }), NOW)).rejects.toThrow(/redis hiccup/);
  });
});

// ═══ A-06 — one payment, one license ═══════════════════════════════════════════════════════════
describe("A-06: concurrent issueLicense calls for one payment produce ONE license", () => {
  const params = { email: "buyer@example.com", tier: "monthly" as const, intentReference: REF, amountUsd: 24.99 };

  it("two callers at the same moment get the same key and one license is stored", async () => {
    const r = redis();
    const [a, b] = await Promise.all([issueLicense(r, params), issueLicense(r, params)]);
    expect(a.key).toBe(b.key);
    expect(licenseHashes()).toHaveLength(1);
    expect(mocks.sets.get(EMAIL_LICENSES_KEY("buyer@example.com"))?.size).toBe(1);
    expect(mocks.store.get(INTENT_LICENSE_KEY(REF))).toBe(a.key);
  });

  it("six callers (poll + IPN + cron, retried) still make one license", async () => {
    const r = redis();
    const all = await Promise.all(Array.from({ length: 6 }, () => issueLicense(r, params)));
    expect(new Set(all.map((l) => l.key)).size).toBe(1);
    expect(licenseHashes()).toHaveLength(1);
  });

  it("the mutex is released afterwards, and a different payment gets its own license", async () => {
    const r = redis();
    await issueLicense(r, params);
    expect(mocks.store.has(INTENT_LICENSE_LOCK_KEY(REF))).toBe(false);
    const other = await issueLicense(r, { ...params, intentReference: "d".repeat(64) });
    expect(licenseHashes()).toHaveLength(2);
    expect(other.intentReference).toBe("d".repeat(64));
  });

  it("the mutex is released when the write fails, so the retry is not blocked", async () => {
    const r = redis();
    vi.spyOn(r as unknown as { multi: () => unknown }, "multi").mockImplementationOnce(() => { throw new Error("boom"); });
    await expect(issueLicense(r, params)).rejects.toThrow(/boom/);
    expect(mocks.store.has(INTENT_LICENSE_LOCK_KEY(REF))).toBe(false);
    expect((await issueLicense(r, params)).key).toMatch(/^ANT-/);
  });

  it("a mutex whose holder died blocks only until it is cleared: the waiter gives up with a clear error, then succeeds", async () => {
    vi.useFakeTimers();
    const r = redis();
    mocks.store.set(INTENT_LICENSE_LOCK_KEY(REF), "1"); // a dead holder's lock (a real one expires after 30 s)
    const pending = issueLicense(r, params);
    const assertion = expect(pending).rejects.toThrow(/still issuing/);
    await vi.advanceTimersByTimeAsync(6000);
    await assertion;
    mocks.store.delete(INTENT_LICENSE_LOCK_KEY(REF)); // the lock expired
    expect((await issueLicense(r, params)).key).toMatch(/^ANT-/);
  });

  it("a pointer to a license that no longer exists is replaced by a fresh key (old behaviour kept)", async () => {
    const r = redis();
    mocks.store.set(INTENT_LICENSE_KEY(REF), "ANT-AAAA-BBBB-CCCC-DDDD");
    const lic = await issueLicense(r, params);
    expect(lic.key).not.toBe("ANT-AAAA-BBBB-CCCC-DDDD");
    expect(mocks.store.get(INTENT_LICENSE_KEY(REF))).toBe(lic.key);
    expect(mocks.store.has(LICENSE_KEY(lic.key))).toBe(true);
  });
});

// ═══ A-16 — the underpayment guard looks at what was sent ══════════════════════════════════════
describe("A-16: paidRatio = actually_paid / pay_amount", () => {
  it("is the share of the asked amount that was sent", () => {
    expect(paidRatio({ pay_amount: 0.4, actually_paid: 0.4 })).toBe(1);
    expect(paidRatio({ pay_amount: "100", actually_paid: "10" })).toBe(0.1);
    expect(paidRatio({ pay_amount: 2, actually_paid: 1.99 })).toBeCloseTo(0.995);
    expect(paidRatio({ pay_amount: 2, actually_paid: 0 })).toBe(0);
  });

  it("is undefined when a figure is missing or unusable (nothing to judge from, so no refusal)", () => {
    expect(paidRatio({})).toBeUndefined();
    expect(paidRatio({ pay_amount: 1 })).toBeUndefined();
    expect(paidRatio({ actually_paid: 1 })).toBeUndefined();
    expect(paidRatio({ pay_amount: 0, actually_paid: 1 })).toBeUndefined();
    expect(paidRatio({ pay_amount: "abc", actually_paid: 1 })).toBeUndefined();
    expect(paidRatio({ pay_amount: 1, actually_paid: -1 })).toBeUndefined();
  });

  it("the invoiced price_amount no longer matters: a payment of a tenth of the asked amount is refused", async () => {
    const r = redis();
    const p = payment("finished", { price_amount: 24.99, pay_amount: 100, actually_paid: 10 });
    mocks.listPaymentsForInvoice.mockResolvedValue([p]);
    const res = await reconcileIntent(r, intent({ expiresAt: NOW + HOUR }), NOW);
    expect(res.state).toBe("underpaid");
    expect(res.state === "underpaid" && res.paidRatio).toBeCloseTo(0.1);
    expect(mocks.setUserTier).not.toHaveBeenCalled();
    expect(licenseHashes()).toHaveLength(0);
  });

  it("confirmIntent: refuses below 0.99, accepts 0.99 and above, accepts when the ratio is unknown", async () => {
    const r = redis();
    const refused = await confirmIntent(r, intent(), { paidRatio: 0.98 });
    expect(refused).toEqual({ ok: false, reason: "underpaid", paidRatio: 0.98 });
    expect((await confirmIntent(r, intent({ reference: "e".repeat(64) }), { paidRatio: 0.99 })).ok).toBe(true);
    expect((await confirmIntent(r, intent({ reference: "f".repeat(64) }), { paidRatio: 1.5 })).ok).toBe(true);
    expect((await confirmIntent(r, intent({ reference: "9".repeat(64) }), {})).ok).toBe(true);
  });
});

// ═══ shared helpers ═══════════════════════════════════════════════════════════════════════════
describe("pickMostProgressed (one copy, shared by the poll and the cron)", () => {
  it("returns the furthest-along payment, null for none, and does not reorder its input", () => {
    const list = [payment("waiting", { payment_id: "a" }), payment("finished", { payment_id: "b" }), payment("failed", { payment_id: "c" })];
    expect(pickMostProgressed(list)?.payment_id).toBe("b");
    expect(list.map((p) => p.payment_id)).toEqual(["a", "b", "c"]);
    expect(pickMostProgressed([])).toBeNull();
  });
});

describe("strict lookups: 'could not ask' is not 'nothing found'", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => { process.env.NOWPAYMENTS_API_KEY = "k"; });
  afterEach(() => { globalThis.fetch = realFetch; delete process.env.NOWPAYMENTS_API_KEY; });

  it("a 404 is 'no payment' even in strict mode; a 503 throws in strict mode and gives null / [] otherwise", async () => {
    // The module is mocked above (getPayment / listPaymentsForInvoice): take the real functions.
    const { getPayment: realGetPayment, listPaymentsForInvoice: realList } =
      await vi.importActual<typeof import("../api/_lib/nowpayments")>("../api/_lib/nowpayments");
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    expect(await realGetPayment("p", { strict: true })).toBeNull();

    globalThis.fetch = vi.fn(async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    await expect(realGetPayment("p", { strict: true })).rejects.toThrow(/503/);
    await expect(realList("inv", { strict: true })).rejects.toThrow(/503/);
    expect(await realGetPayment("p")).toBeNull();
    expect(await realList("inv")).toEqual([]);
  });
});
