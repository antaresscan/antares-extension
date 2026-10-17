// __tests__/audit-lot07.test.ts — Lot 7 of the file-by-file audit (2026-10-17): api/_lib/user.ts, entitlements.ts, pro-gate.ts,
// quota.ts. Each test fails on the previous code.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Redis } from "@upstash/redis";
import * as userModule from "../api/_lib/user";
import { initUserStorage, setUserTier, getUserTier, resolveTier, _resetUserStorageForTests } from "../api/_lib/user";
import { signSession, _resetSessionSecretCacheForTests } from "../api/_lib/account";

/**
 * A Redis whose network drops the Nth request (counted from 1). A MULTI/EXEC is one request, applied all or nothing, as on Upstash
 * (the REST API sends the whole transaction in one call).
 */
function flakyRedis(initial: Record<string, string>, dropRequest: number) {
  const strings = new Map(Object.entries(initial));
  const hashes = new Map<string, Record<string, string>>();
  let requests = 0;
  const request = () => {
    requests += 1;
    if (requests === dropRequest) throw new Error("fetch failed (simulated)");
  };
  const redis = {
    get: vi.fn(async (k: string) => strings.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { request(); strings.set(k, String(v)); return "OK"; }),
    del: vi.fn(async (...keys: string[]) => { request(); let n = 0; for (const k of keys) if (strings.delete(k)) n++; return n; }),
    hgetall: vi.fn(async (k: string) => hashes.get(k) ?? null),
    multi: vi.fn(() => {
      const queued: Array<() => void> = [];
      const tx = {
        set: (k: string, v: string) => { queued.push(() => { strings.set(k, String(v)); }); return tx; },
        del: (k: string) => { queued.push(() => { strings.delete(k); }); return tx; },
        exec: async () => { request(); for (const apply of queued) apply(); return queued.map(() => "OK"); },
      };
      return tx;
    }),
  };
  return { redis: redis as unknown as Redis, strings, hashes };
}

beforeEach(() => {
  _resetUserStorageForTests();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  _resetUserStorageForTests();
});

describe("setUserTier — the tier and its end date are written together or not at all", () => {
  it("a 30-day Pro is never stored without its end date (the second request lost made it a Pro for ever)", async () => {
    const m = flakyRedis({}, 2);
    initUserStorage(m.redis);
    await setUserTier("install-x", "pro", Date.now() + 30 * 24 * 3600_000).catch(() => undefined);
    const tier = m.strings.get("user:install-x:tier");
    const end = m.strings.get("user:install-x:tierExpires");
    expect(tier === undefined || (tier === "pro" && end !== undefined)).toBe(true);
  });

  it("a Lifetime redeemed on an install with an old, past Pro end date is not read as Free (the lost DEL left the old date)", async () => {
    const m = flakyRedis({ "user:install-y:tier": "pro", "user:install-y:tierExpires": String(Date.now() - 86_400_000) }, 2);
    initUserStorage(m.redis);
    await setUserTier("install-y", "lifetime").catch(() => undefined);
    const tier = await getUserTier("install-y");
    // Either the write went through (Lifetime) or nothing changed (the old Pro, already over: Free). Never "Lifetime, but over".
    const stored = m.strings.get("user:install-y:tier");
    if (stored === "lifetime") expect(tier).toBe("lifetime");
    else expect(stored).toBe("pro");
  });
});

describe("resolveTier — every row of the table leaves its metric", () => {
  it("an account whose e-mail is not confirmed is Free, and the log says why (it said nothing)", async () => {
    process.env.SESSION_SECRET = "7".repeat(64);
    _resetSessionSecretCacheForTests();
    const m = flakyRedis({}, 0);
    m.hashes.set("account:new@example.com", {
      id: "id-1", email: "new@example.com", passwordHash: "scrypt$00$00", createdAt: String(Date.now()), emailVerified: "0", sessionVersion: "0",
    });
    initUserStorage(m.redis);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const token = signSession("new@example.com", Date.now(), 0);
    const r = await resolveTier({ headers: { "x-antares-session": token } as Record<string, string> }, "install-z");
    expect(r.tier).toBe("free");
    expect(log.mock.calls.map((c) => String(c[0])).some((l) => l.includes("tier-resolve.email-unverified"))).toBe(true);
  });
});

describe("user.ts — no tier read without the session", () => {
  it("getEffectiveTier and isDevAllowlistedInstall are gone (nothing called them; they honoured the dev header with no session)", () => {
    expect("getEffectiveTier" in userModule).toBe(false);
    expect("isDevAllowlistedInstall" in userModule).toBe(false);
  });
});
