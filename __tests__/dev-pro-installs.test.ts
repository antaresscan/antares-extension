import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

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
    del = vi.fn(async (...keys: string[]) => {
      for (const k of keys) mocks.store.delete(k);
      return keys.length;
    });
    multi = () => {
      const queued: Array<() => void> = [];
      const tx = {
        set: (k: string, v: unknown) => { queued.push(() => mocks.store.set(k, v)); return tx; },
        del: (k: string) => { queued.push(() => mocks.store.delete(k)); return tx; },
        exec: async () => { for (const apply of queued) apply(); return queued.map(() => "OK"); },
      };
      return tx;
    };
    incr = vi.fn(async (k: string) => {
      const cur = (mocks.store.get(k) as number | undefined) ?? 0;
      const next = cur + 1;
      mocks.store.set(k, next);
      return next;
    });
    expire = vi.fn(async () => 1);
    hset = vi.fn();
    hgetall = vi.fn(async () => null);
  }
  return { Redis: MockRedis };
});

import { Redis } from "@upstash/redis";
import {
  isDevProInstall,
  getUserTier,
  setUserTier,
  initUserStorage,
  _resetUserStorageForTests,
} from "../api/_lib/user";
import { unlimitedQuota } from "../api/_lib/quota";

const DEV_INSTALL_A = "install-dev-a-aaaaaaa";
const DEV_INSTALL_B = "install-dev-b-bbbbbbb";
const REGULAR_INSTALL = "install-test-cccccccccccc";

beforeEach(() => {
  mocks.store.clear();
  const redis = new Redis({ url: "x", token: "y" });
  initUserStorage(redis);
});

afterEach(() => {
  delete process.env.DEV_PRO_INSTALLS;
  _resetUserStorageForTests();
});

describe("isDevProInstall", () => {
  it("returns false when DEV_PRO_INSTALLS is unset", () => {
    expect(isDevProInstall(DEV_INSTALL_A)).toBe(false);
  });

  it("returns true for ids in the comma-separated list", () => {
    process.env.DEV_PRO_INSTALLS = `${DEV_INSTALL_A},${DEV_INSTALL_B}`;
    expect(isDevProInstall(DEV_INSTALL_A)).toBe(true);
    expect(isDevProInstall(DEV_INSTALL_B)).toBe(true);
  });

  it("returns false for ids not in the list", () => {
    process.env.DEV_PRO_INSTALLS = DEV_INSTALL_A;
    expect(isDevProInstall(REGULAR_INSTALL)).toBe(false);
  });

  it("trims whitespace around ids", () => {
    process.env.DEV_PRO_INSTALLS = `  ${DEV_INSTALL_A}  ,  ${DEV_INSTALL_B} `;
    expect(isDevProInstall(DEV_INSTALL_A)).toBe(true);
    expect(isDevProInstall(DEV_INSTALL_B)).toBe(true);
  });

  it("returns false for empty string input", () => {
    process.env.DEV_PRO_INSTALLS = DEV_INSTALL_A;
    expect(isDevProInstall("")).toBe(false);
  });
});

describe("getUserTier with DEV_PRO_INSTALLS override", () => {
  it("forces yearly for dev installs without consulting Redis", async () => {
    process.env.DEV_PRO_INSTALLS = DEV_INSTALL_A;
    expect(await getUserTier(DEV_INSTALL_A)).toBe("yearly");
  });

  it("dev override wins over a stored 'free' tier", async () => {
    process.env.DEV_PRO_INSTALLS = DEV_INSTALL_A;
    // Even if we stored nothing or "free", dev install stays yearly.
    // (Was "lifetime" pre-2026-05; rename keeps the same semantics —
    // unlimited dev access — under the new product name.)
    expect(await getUserTier(DEV_INSTALL_A)).toBe("yearly");
  });

  it("regular installs still default to free", async () => {
    process.env.DEV_PRO_INSTALLS = DEV_INSTALL_A;
    expect(await getUserTier(REGULAR_INSTALL)).toBe("free");
  });

  it("regular installs see their stored tier", async () => {
    process.env.DEV_PRO_INSTALLS = DEV_INSTALL_A;
    await setUserTier(REGULAR_INSTALL, "pro");
    expect(await getUserTier(REGULAR_INSTALL)).toBe("pro");
    // dev install still yearly regardless
    expect(await getUserTier(DEV_INSTALL_A)).toBe("yearly");
  });
});

describe("what the quota headers say about dev and regular installs (unlimited for everyone)", () => {
  it("a dev install is unlimited Yearly", async () => {
    process.env.DEV_PRO_INSTALLS = DEV_INSTALL_A;
    const result = unlimitedQuota(await getUserTier(DEV_INSTALL_A));
    expect(result.tier).toBe("yearly");
    expect(result.limit).toBe(-1);
    expect(result.remaining).toBe(-1);
  });

  it("a regular Free install is unlimited too (the tier is only for gating the explanation)", async () => {
    process.env.DEV_PRO_INSTALLS = DEV_INSTALL_A;
    const result = unlimitedQuota(await getUserTier(REGULAR_INSTALL));
    expect(result.tier).toBe("free");
    expect(result.limit).toBe(-1);
  });
});

// The X-Antares-Dev-Tier header of a dev install (row 1 of the table) is tested through decideTier in entitlements.test.ts: the
// session-less getEffectiveTier these tests drove was removed in the audit of 2026-10-17 (nothing called it, and it skipped the session).
