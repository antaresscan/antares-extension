// __tests__/integration-tier-from-email.test.ts
//
// Integration-level proof that the overlay's tier follows the user's
// SIGNED-IN EMAIL — not the install_id's stored tier or the install→
// email binding. This is the architecture the founder asked for after
// 5+ failed attempts:
//
//   "if i have a Pro account and i'm connected, the overlay is Pro"
//   "if i don't have a Pro account or i'm not connected, it's Free"
//
// The previous design walked install_id → binding → install tier, which
// required several state writes to all happen correctly. This design
// walks session cookie → email → license-of-record → tier. Email is
// the single source of truth and matches /account.html's display logic.
import { vi, describe, it, expect, beforeEach } from "vitest";
import type { VercelRequest } from "@vercel/node";

const mocks = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
}));

vi.mock("@upstash/redis", () => {
  class MockRedis {
    set = vi.fn(async (k: string, v: unknown) => {
      mocks.store.set(k, v);
      return "OK";
    });
    get = vi.fn(async (k: string) => mocks.store.get(k) ?? null);
    del = vi.fn(async (k: string) => {
      const had = mocks.store.delete(k);
      return had ? 1 : 0;
    });
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
      const existing = (mocks.store.get(k) as Set<string>) ?? new Set<string>();
      let added = 0;
      for (const m of members) {
        if (!existing.has(m)) {
          existing.add(m);
          added++;
        }
      }
      mocks.store.set(k, existing);
      return added;
    });
    smembers = vi.fn(async (k: string) => {
      const v = mocks.store.get(k);
      return v ? [...(v as Set<string>)] : [];
    });
  }
  return { Redis: MockRedis };
});

import { Redis } from "@upstash/redis";
import { initUserStorage, resolveTierAndBypass } from "../api/_lib/user";
import { signSession } from "../api/_lib/account";
import { issueLicense } from "../api/_lib/license";
import { SESSION_COOKIE_NAME } from "../api/_lib/session-cookie";

const VALID_INSTALL = "11111111-1111-4111-8111-111111111111";
const OTHER_INSTALL = "22222222-2222-4222-8222-222222222222";

// Dev/founder allowlist is env-var only (no hardcoded list in account.ts).
process.env.DEV_LIFETIME_EMAILS = "test-dev@example.com";
process.env.DEV_PRO_EMAILS = "test-dev@example.com";

beforeEach(() => {
  mocks.store.clear();
  process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash";
  process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token-thirty-two-chars-min-required";
  process.env.SESSION_SECRET = "0".repeat(64);
  initUserStorage(new Redis({ url: "x", token: "y" }));
});

function reqWithCookie(token: string | null, headers: Record<string, string> = {}) {
  const merged: Record<string, string> = { ...headers };
  if (token) merged.cookie = `${SESSION_COOKIE_NAME}=${token}`;
  return { headers: merged } as unknown as VercelRequest;
}

// Seed the account hash + an issued+redeemed-or-not license owned by email.
// For Pro/Yearly we go through `issueLicense` (the production code path).
// For Lifetime we hand-write the Redis state because issueLicense maps
// the legacy `lifetime` intent tier to `yearly` (lifetime SKU is removed
// for new buyers as of 2026-05). Grandfathered Lifetime licences still
// exist in Redis with `tier: "lifetime"` and the resolver must honour
// them — that's what these tests cover.
async function seedEmailWithLicense(
  email: string,
  tier: "pro" | "yearly" | "lifetime",
) {
  if (tier === "lifetime") {
    seedGrandfatheredLifetime(email);
    return;
  }
  const redis = new Redis({ url: "x", token: "y" });
  mocks.store.set(`account:${email}`, {
    email,
    status: "active",
    emailVerified: "0",
    createdAt: String(Date.now()),
  });
  // Intent vocabulary uses "monthly" for Pro 30-day passes; licence
  // vocabulary uses "pro". issueLicense translates internally via
  // intentTierToLicenseTier.
  const intentTier = tier === "pro" ? "monthly" : "yearly";
  await issueLicense(redis, {
    email,
    tier: intentTier,
    intentReference: `test-${email}-${tier}-${Date.now()}`,
    amountUsd: 0,
  });
}

function seedGrandfatheredLifetime(email: string) {
  mocks.store.set(`account:${email}`, {
    email,
    status: "active",
    emailVerified: "0",
    createdAt: String(Date.now()),
  });
  // Valid licence-key format. Crockford-base32 alphabet excludes I/O/U
  // so we use safe characters (no L either to be conservative even though
  // L is technically allowed). Format: ANT-XXXX-XXXX-XXXX-XXXX with [0-9A-HJ-NP-TV-Z].
  const key = "ANT-FAKE-AAAA-BBBB-CCCC";
  // License hash — same shape as parseLicense expects.
  mocks.store.set(`license:${key}`, {
    key,
    email,
    tier: "lifetime", // grandfathered legacy tier
    intentReference: `legacy-${email}`,
    amountUsd: "0",
    createdAt: String(Date.now()),
    redeemed: "0",
    expiresAt: "0", // no expiry
  });
  // Email's licence index set
  const set = (mocks.store.get(`email:licenses:${email}`) as Set<string>) ?? new Set<string>();
  set.add(key);
  mocks.store.set(`email:licenses:${email}`, set);
}

describe("Integration: overlay tier follows the user's SIGNED-IN EMAIL", () => {
  it("signed in + email has Lifetime licence → overlay returns Lifetime — even with no install binding", async () => {
    await seedEmailWithLicense("alice@example.com", "lifetime");

    // Sanity check: NO install→email binding exists. This is the
    // scenario the founder kept hitting — redeem hadn't written the
    // binding (or the user paid via Solana without an account yet).
    expect(mocks.store.get(`account:install:${VALID_INSTALL}`)).toBeUndefined();

    const token = signSession("alice@example.com");
    const result = await resolveTierAndBypass(reqWithCookie(token), VALID_INSTALL);

    expect(
      result.tier,
      "Signed in + has Lifetime licence → MUST return lifetime regardless of install binding",
    ).toBe("lifetime");
  });

  it("signed in + email has active Yearly licence → returns Yearly", async () => {
    await seedEmailWithLicense("alice@example.com", "yearly");
    const token = signSession("alice@example.com");
    const result = await resolveTierAndBypass(reqWithCookie(token), VALID_INSTALL);
    expect(result.tier).toBe("yearly");
  });

  it("signed in + email has active Pro licence → returns Pro", async () => {
    await seedEmailWithLicense("alice@example.com", "pro");
    const token = signSession("alice@example.com");
    const result = await resolveTierAndBypass(reqWithCookie(token), VALID_INSTALL);
    expect(result.tier).toBe("pro");
  });

  it("signed in + email has NO licences → returns Free", async () => {
    // Account exists but never paid for anything
    mocks.store.set(`account:alice@example.com`, {
      email: "alice@example.com",
      status: "active",
      emailVerified: "0",
      createdAt: String(Date.now()),
    });

    const token = signSession("alice@example.com");
    const result = await resolveTierAndBypass(reqWithCookie(token), VALID_INSTALL);
    expect(result.tier).toBe("free");
  });

  it("not signed in → returns Free, even when the install has a stored tier from a previous user", async () => {
    // Bob paid + linked previously, install_id has lifetime stored.
    mocks.store.set(`user:${VALID_INSTALL}:tier`, "lifetime");

    const result = await resolveTierAndBypass(reqWithCookie(null), VALID_INSTALL);
    expect(result.tier).toBe("free");
  });

  it("legitimate account switch: A signs in with own Pro license, install was bound to B → A sees Pro", async () => {
    // A has her own paid Pro license — she's not hijacking B's anything,
    // she's just signing in with her own credentials on a browser where B
    // signed in before. The strict pre-fix behaviour would have shown her
    // Free because the install was bound to B; user-reported bug "I switch
    // accounts and the overlay never updates". Session with its own paid
    // license always wins.
    await seedEmailWithLicense("alice@example.com", "pro");
    mocks.store.set(`account:install:${OTHER_INSTALL}`, "bob@example.com");

    const token = signSession("alice@example.com");
    const result = await resolveTierAndBypass(reqWithCookie(token), OTHER_INSTALL);
    expect(
      result.tier,
      "Alice has her own Pro license — must see Pro, not Free, even when install was bound to Bob first",
    ).toBe("pro");
  });

  it("anti-hijack still applies: session has NO license + install bound to someone else → Free", async () => {
    // Eve signs in but has no licenses of her own. The install is bound
    // to Bob who paid. Without Eve's own license to fall back on, the
    // anti-hijack denies her any tier elevation from the install binding.
    // This is the actual hijack case the binding was built to protect.
    mocks.store.set(`account:install:${OTHER_INSTALL}`, "bob@example.com");

    const token = signSession("eve@example.com"); // no license seeded
    const result = await resolveTierAndBypass(reqWithCookie(token), OTHER_INSTALL);
    expect(
      result.tier,
      "Eve (no license) on Bob's install must stay Free — anti-hijack",
    ).toBe("free");
  });

  it("Lifetime trumps a still-active Yearly (priority order)", async () => {
    await seedEmailWithLicense("alice@example.com", "yearly");
    await seedEmailWithLicense("alice@example.com", "lifetime");

    const token = signSession("alice@example.com");
    const result = await resolveTierAndBypass(reqWithCookie(token), VALID_INSTALL);
    expect(result.tier).toBe("lifetime");
  });

  it("expired Pro licence → returns Free", async () => {
    // Manually seed an expired pro license
    const redis = new Redis({ url: "x", token: "y" });
    mocks.store.set(`account:alice@example.com`, {
      email: "alice@example.com",
      status: "active",
      emailVerified: "0",
      createdAt: String(Date.now()),
    });
    await issueLicense(redis, {
      email: "alice@example.com",
      tier: "monthly", // intent vocabulary; maps to license tier "pro"
      intentReference: "test-expired",
      amountUsd: 0,
      now: Date.now() - 60 * 24 * 60 * 60 * 1000, // 60 days ago — Pro pass is 30 days
    });

    const token = signSession("alice@example.com");
    const result = await resolveTierAndBypass(reqWithCookie(token), VALID_INSTALL);
    expect(result.tier).toBe("free");
  });

  it("FOUNDER's bug scenario REPRO: signs up + has dev Yearly license → overlay is Yearly with NO redeem step", async () => {
    // The dev grant fires on signup (ensureDevLifetimeLicense → issueLicense).
    // After my fix, the founder shouldn't need to redeem or click any
    // button on /account.html — the overlay reflects their tier the
    // moment they're signed in.
    await seedEmailWithLicense("test-dev@example.com", "yearly");

    const token = signSession("test-dev@example.com");
    const result = await resolveTierAndBypass(
      reqWithCookie(token),
      VALID_INSTALL,
    );

    expect(
      result.tier,
      "Founder signs in → email has Yearly licence → overlay returns Yearly. No clicks, no redeem, no binding required.",
    ).toBe("yearly");
    // Founder is dev-allowlisted → bypassQuota fires
    expect(result.bypassQuota).toBe(true);
  });
});
