import { vi, describe, it, expect, beforeEach } from "vitest";

// Hoisted so the @upstash/redis mock factory can read these.
const mocks = vi.hoisted(() => {
  // In-memory replacement for the Redis methods we use. Each Redis() call
  // gets its own state so tests can be isolated by re-calling new MockRedis()
  // — but since the license module always passes the same redis instance
  // we hand back the same map across the suite via a closure.
  return {
    store: new Map<string, unknown>(),
    sets: new Map<string, Set<string>>(),
  };
});

vi.mock("@upstash/redis", () => {
  class MockRedis {
    set = vi.fn(async (k: string, v: unknown) => {
      mocks.store.set(k, v);
      return "OK";
    });
    get = vi.fn(async (k: string) => mocks.store.get(k) ?? null);
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
      const set = mocks.sets.get(k) ?? new Set();
      members.forEach((m) => set.add(m));
      mocks.sets.set(k, set);
      return members.length;
    });
    smembers = vi.fn(async (k: string) =>
      Array.from(mocks.sets.get(k) ?? []),
    );
    srem = vi.fn(async (k: string, ...members: string[]) => {
      const set = mocks.sets.get(k);
      if (!set) return 0;
      let removed = 0;
      members.forEach((m) => {
        if (set.delete(m)) removed++;
      });
      return removed;
    });
    del = vi.fn(async (k: string) => {
      mocks.store.delete(k);
      mocks.sets.delete(k);
      return 1;
    });
  }
  return { Redis: MockRedis };
});

const setUserTierMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../api/_lib/user", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/user")>(
    "../api/_lib/user",
  );
  return { ...actual, setUserTier: setUserTierMock, initUserStorage: vi.fn() };
});

import { Redis } from "@upstash/redis";
import {
  generateLicenseKey,
  isValidLicenseKey,
  normalizeEmail,
  issueLicense,
  getLicense,
  getLicensesByEmail,
  redeemLicense,
  intentTierToLicenseTier,
} from "../api/_lib/license";

const VALID_INSTALL = "install-test-aaaaaaaaaaaa";

beforeEach(() => {
  mocks.store.clear();
  mocks.sets.clear();
  setUserTierMock.mockClear();
});

describe("generateLicenseKey", () => {
  it("returns a string in the ANT-XXXX-XXXX-XXXX-XXXX format", () => {
    const key = generateLicenseKey();
    expect(key).toMatch(/^ANT-[0-9A-HJ-NP-TV-Z]{4}-[0-9A-HJ-NP-TV-Z]{4}-[0-9A-HJ-NP-TV-Z]{4}-[0-9A-HJ-NP-TV-Z]{4}$/);
  });

  it("returns distinct keys across many calls (sanity check on entropy)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generateLicenseKey());
    expect(seen.size).toBe(200);
  });
});

describe("isValidLicenseKey", () => {
  it("accepts a freshly-generated key", () => {
    expect(isValidLicenseKey(generateLicenseKey())).toBe(true);
  });
  it("rejects format mismatches", () => {
    expect(isValidLicenseKey("")).toBe(false);
    expect(isValidLicenseKey("not-a-key")).toBe(false);
    expect(isValidLicenseKey("ant-aaaa-bbbb-cccc-dddd")).toBe(false); // lowercase
    expect(isValidLicenseKey("ANT-AAAA-BBBB-CCCC")).toBe(false); // 3 groups
    expect(isValidLicenseKey("ANT-IIII-LLLL-OOOO-UUUU")).toBe(false); // disallowed chars
    expect(isValidLicenseKey(null)).toBe(false);
    expect(isValidLicenseKey(undefined)).toBe(false);
    expect(isValidLicenseKey(42)).toBe(false);
  });
});

describe("normalizeEmail", () => {
  it("lowercases and trims valid emails", () => {
    expect(normalizeEmail("  Foo@Bar.com  ")).toBe("foo@bar.com");
  });
  it("rejects malformed input", () => {
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizeEmail("@bar.com")).toBeNull();
    expect(normalizeEmail("foo@")).toBeNull();
    expect(normalizeEmail("foo@bar")).toBeNull(); // no TLD
    expect(normalizeEmail(123)).toBeNull();
    expect(normalizeEmail("a".repeat(255) + "@b.co")).toBeNull(); // > 254
  });
});

describe("intentTierToLicenseTier", () => {
  it("maps monthly → pro and yearly → yearly", () => {
    expect(intentTierToLicenseTier("monthly")).toBe("pro");
    expect(intentTierToLicenseTier("yearly")).toBe("yearly");
  });

  it("legacy lifetime intents map to yearly (rename rollout fallback)", () => {
    // Cast: stale intents created before the 2026-05 rename may still
    // arrive with tier="lifetime"; runtime guard inside the helper
    // routes them to "yearly" so they get the new product.
    expect(intentTierToLicenseTier("lifetime" as never)).toBe("yearly");
  });
});

describe("issueLicense + getLicense", () => {
  it("issues a license tied to email + tier and stores it", async () => {
    const redis = new Redis({ url: "x", token: "y" });
    const lic = await issueLicense(redis, {
      email: "buyer@example.com",
      tier: "monthly",
      intentReference: "ref-1",
      amountUsd: 24.99,
    });

    expect(lic.email).toBe("buyer@example.com");
    expect(lic.tier).toBe("pro"); // monthly → pro at the user-tier vocabulary
    expect(lic.intentReference).toBe("ref-1");
    expect(lic.amountUsd).toBe(24.99);
    expect(lic.redeemed).toBe(false);
    expect(lic.expiresAt).toBeDefined();
    expect(lic.expiresAt).toBeGreaterThan(Date.now());

    const fetched = await getLicense(redis, lic.key);
    expect(fetched?.key).toBe(lic.key);
    expect(fetched?.email).toBe("buyer@example.com");
  });

  it("yearly intents produce a 365-day expiry on the license", async () => {
    const redis = new Redis({ url: "x", token: "y" });
    const lic = await issueLicense(redis, {
      email: "buyer@example.com",
      tier: "yearly",
      intentReference: "ref-year",
      amountUsd: 149.99,
    });
    expect(lic.tier).toBe("yearly");
    expect(lic.expiresAt).toBeDefined();
    const oneYearMs = 365 * 24 * 60 * 60 * 1000;
    expect(lic.expiresAt).toBeGreaterThan(Date.now() + oneYearMs - 60_000);
    expect(lic.expiresAt).toBeLessThan(Date.now() + oneYearMs + 60_000);
  });

  it("is idempotent on the intent reference (cron retries don't duplicate)", async () => {
    const redis = new Redis({ url: "x", token: "y" });
    const first = await issueLicense(redis, {
      email: "buyer@example.com",
      tier: "monthly",
      intentReference: "ref-2",
      amountUsd: 24.99,
    });
    const second = await issueLicense(redis, {
      email: "buyer@example.com",
      tier: "monthly",
      intentReference: "ref-2", // same reference
      amountUsd: 24.99,
    });
    expect(second.key).toBe(first.key);
  });

  it("rejects invalid email", async () => {
    const redis = new Redis({ url: "x", token: "y" });
    await expect(
      issueLicense(redis, {
        email: "not-an-email",
        tier: "monthly",
        intentReference: "ref-3",
        amountUsd: 24.99,
      }),
    ).rejects.toThrow();
  });

  it("getLicense returns null for unknown key or invalid format", async () => {
    const redis = new Redis({ url: "x", token: "y" });
    expect(await getLicense(redis, "ANT-AAAA-BBBB-CCCC-DDDD")).toBeNull();
    expect(await getLicense(redis, "garbage")).toBeNull();
  });
});

describe("getLicensesByEmail", () => {
  it("returns all licenses for an email, newest first", async () => {
    const redis = new Redis({ url: "x", token: "y" });
    const a = await issueLicense(redis, {
      email: "buyer@example.com",
      tier: "monthly",
      intentReference: "ref-A",
      amountUsd: 24.99,
      now: 1000,
    });
    const b = await issueLicense(redis, {
      email: "buyer@example.com",
      tier: "yearly",
      intentReference: "ref-B",
      amountUsd: 149.99,
      now: 2000,
    });

    const list = await getLicensesByEmail(redis, "Buyer@Example.com"); // case-insensitive
    expect(list.map((l) => l.key)).toEqual([b.key, a.key]); // newest first
  });

  it("returns [] for an unknown email", async () => {
    const redis = new Redis({ url: "x", token: "y" });
    expect(await getLicensesByEmail(redis, "nobody@nowhere.com")).toEqual([]);
  });

  it("returns [] for malformed email", async () => {
    const redis = new Redis({ url: "x", token: "y" });
    expect(await getLicensesByEmail(redis, "not-an-email")).toEqual([]);
  });
});

describe("redeemLicense", () => {
  it("flips tier on first redemption + marks license redeemed", async () => {
    const redis = new Redis({ url: "x", token: "y" });
    const lic = await issueLicense(redis, {
      email: "buyer@example.com",
      tier: "monthly",
      intentReference: "ref-R1",
      amountUsd: 24.99,
    });

    const result = await redeemLicense(redis, lic.key, VALID_INSTALL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.license.redeemed).toBe(true);
    expect(result.license.redeemedBy).toBe(VALID_INSTALL);
    expect(setUserTierMock).toHaveBeenCalledWith(
      VALID_INSTALL,
      "pro",
      expect.any(Number),
    );
  });

  it("yearly redemption flips to yearly with 365-day expiry", async () => {
    const redis = new Redis({ url: "x", token: "y" });
    const lic = await issueLicense(redis, {
      email: "buyer@example.com",
      tier: "yearly",
      intentReference: "ref-Ryear",
      amountUsd: 149.99,
    });

    await redeemLicense(redis, lic.key, VALID_INSTALL);
    expect(setUserTierMock).toHaveBeenCalledWith(
      VALID_INSTALL,
      "yearly",
      expect.any(Number),
    );
  });

  it("returns not_found for unknown but valid-format key", async () => {
    const redis = new Redis({ url: "x", token: "y" });
    const result = await redeemLicense(
      redis,
      "ANT-AAAA-BBBB-CCCC-DDDD",
      VALID_INSTALL,
    );
    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(setUserTierMock).not.toHaveBeenCalled();
  });

  it("returns invalid_format for garbage", async () => {
    const redis = new Redis({ url: "x", token: "y" });
    const result = await redeemLicense(redis, "garbage", VALID_INSTALL);
    expect(result).toEqual({ ok: false, reason: "invalid_format" });
  });

  it("same install can re-redeem (idempotent reclaim)", async () => {
    const redis = new Redis({ url: "x", token: "y" });
    const lic = await issueLicense(redis, {
      email: "buyer@example.com",
      tier: "monthly",
      intentReference: "ref-R2",
      amountUsd: 24.99,
    });
    await redeemLicense(redis, lic.key, VALID_INSTALL);
    setUserTierMock.mockClear();
    const second = await redeemLicense(redis, lic.key, VALID_INSTALL);
    expect(second.ok).toBe(true);
    // Re-flips tier in case Redis lost the user record (the comment in
    // license.ts explains why).
    expect(setUserTierMock).toHaveBeenCalledWith(
      VALID_INSTALL,
      "pro",
      expect.any(Number),
    );
  });

  it("different install gets already_redeemed", async () => {
    const redis = new Redis({ url: "x", token: "y" });
    const lic = await issueLicense(redis, {
      email: "buyer@example.com",
      tier: "monthly",
      intentReference: "ref-R3",
      amountUsd: 24.99,
    });
    await redeemLicense(redis, lic.key, VALID_INSTALL);
    setUserTierMock.mockClear();

    const otherInstall = "install-test-bbbbbbbbbbbb";
    const second = await redeemLicense(redis, lic.key, otherInstall);
    expect(second).toEqual({ ok: false, reason: "already_redeemed" });
    expect(setUserTierMock).not.toHaveBeenCalled();
  });
});
