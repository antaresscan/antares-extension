// __tests__/audit-lot08.test.ts — Lot 8 of the file-by-file audit (2026-10-17): api/_lib/license.ts, api/redeem.ts,
// api/account-licenses.ts. Each test fails on the previous code.
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { Redis } from "@upstash/redis";

const mocks = vi.hoisted(() => ({ getLicensesByEmail: vi.fn() }));

vi.mock("@upstash/redis", () => {
  class MockRedis {
    get = vi.fn().mockResolvedValue(null);
    set = vi.fn().mockResolvedValue("OK");
  }
  return { Redis: MockRedis };
});
vi.mock("../api/_lib/license", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/license")>("../api/_lib/license");
  return { ...actual, getLicensesByEmail: mocks.getLicensesByEmail };
});
vi.mock("../api/_lib/middleware", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/middleware")>("../api/_lib/middleware");
  return { ...actual, checkRateLimit: vi.fn().mockResolvedValue(true), initRateLimiters: vi.fn() };
});

import accountLicenses from "../api/account-licenses";

const ORIGIN = "https://antaresscan.com";
const KEY_GIVEN = "ANT-AAAA-BBBB-CCCC-DDDD";
const KEY_KEPT = "ANT-1111-2222-3333-4444";
const REFERENCE = "cd".repeat(32);

const license = (key: string) => ({
  key, email: "buyer@example.com", tier: "yearly", intentReference: REFERENCE, amountUsd: 149.99, createdAt: 1_000_000, redeemed: false,
  expiresAt: Date.now() + 300 * 86_400_000,
});

async function call(body: unknown) {
  const out = { status: 200, body: {} as Record<string, unknown> };
  const req = { method: "POST", headers: { origin: ORIGIN }, query: {}, body, socket: {} } as unknown as VercelRequest;
  const res = {
    setHeader: () => res, status: (c: number) => { out.status = c; return res; },
    json: (b: Record<string, unknown>) => { out.body = b; return res; }, end: () => res,
  } as unknown as VercelResponse;
  await accountLicenses(req, res);
  return out;
}

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash";
  process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
  mocks.getLicensesByEmail.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("account-licenses — one key never hands out the others", () => {
  it("e-mail + the key given to a friend: the buyer's other, unredeemed key comes back masked (it came back whole, ready to redeem)", async () => {
    mocks.getLicensesByEmail.mockResolvedValue([license(KEY_GIVEN), license(KEY_KEPT)]);
    const r = await call({ email: "buyer@example.com", license_key: KEY_GIVEN });
    expect(r.status).toBe(200);
    const keys = (r.body.licenses as Array<{ key: string }>).map((l) => l.key);
    expect(keys).toContain(KEY_GIVEN);
    expect(keys).not.toContain(KEY_KEPT);
    expect(keys.some((k) => k.startsWith("ANT-1111") && k.length < KEY_KEPT.length + 2 && k !== KEY_KEPT)).toBe(true); // the purchase is still listed
  });
});

describe("license.ts — a checkout reference is never logged whole", () => {
  it("the warning about a dangling intent pointer writes the reference's fingerprint, not the reference (it hands out the licence key)", async () => {
    const actual = await vi.importActual<typeof import("../api/_lib/license")>("../api/_lib/license");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const store = new Map<string, unknown>([[`intent:license:${REFERENCE}`, "ANT-9999-8888-7777-6666"]]);
    const redis = {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      hgetall: vi.fn(async () => null), // the pointed licence is gone
      set: vi.fn(async (k: string, v: unknown, o?: { nx?: boolean }) => { if (o?.nx && store.has(k)) return null; store.set(k, v); return "OK"; }),
      del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
      multi: vi.fn(() => {
        const tx = { hset: () => tx, sadd: () => tx, set: () => tx, exec: async () => ["OK"] };
        return tx;
      }),
    } as unknown as Redis;
    await actual.issueLicense(redis, { email: "buyer@example.com", tier: "yearly", intentReference: REFERENCE, amountUsd: 149.99 });
    const lines = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(lines).toContain("intent index points at missing license");
    expect(lines).not.toContain(REFERENCE);
  });
});
