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
    del = vi.fn(async (k: string) => {
      mocks.store.delete(k);
      return 1;
    });
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
  getEffectiveTier,
  setUserTier,
  initUserStorage,
  _resetUserStorageForTests,
} from "../api/_lib/user";
import {
  checkDailyQuota,
  peekDailyQuota,
  initQuota,
  _resetQuotaForTests,
} from "../api/_lib/quota";

const DEV_INSTALL_A = "install-dev-a-aaaaaaa";
const DEV_INSTALL_B = "install-dev-b-bbbbbbb";
const REGULAR_INSTALL = "install-test-cccccccccccc";

beforeEach(() => {
  mocks.store.clear();
  const redis = new Redis({ url: "x", token: "y" });
  initUserStorage(redis);
  initQuota(redis);
});

afterEach(() => {
  delete process.env.DEV_PRO_INSTALLS;
  _resetUserStorageForTests();
  _resetQuotaForTests();
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
  it("forces lifetime for dev installs without consulting Redis", async () => {
    process.env.DEV_PRO_INSTALLS = DEV_INSTALL_A;
    expect(await getUserTier(DEV_INSTALL_A)).toBe("lifetime");
  });

  it("dev override wins over a stored 'free' tier", async () => {
    process.env.DEV_PRO_INSTALLS = DEV_INSTALL_A;
    // Even if we stored nothing or "free", dev install stays lifetime
    expect(await getUserTier(DEV_INSTALL_A)).toBe("lifetime");
  });

  it("regular installs still default to free", async () => {
    process.env.DEV_PRO_INSTALLS = DEV_INSTALL_A;
    expect(await getUserTier(REGULAR_INSTALL)).toBe("free");
  });

  it("regular installs see their stored tier", async () => {
    process.env.DEV_PRO_INSTALLS = DEV_INSTALL_A;
    await setUserTier(REGULAR_INSTALL, "pro");
    expect(await getUserTier(REGULAR_INSTALL)).toBe("pro");
    // dev install still lifetime regardless
    expect(await getUserTier(DEV_INSTALL_A)).toBe("lifetime");
  });
});

describe("checkDailyQuota — unlimited for everyone post-2026-05", () => {
  it("dev installs return unlimited Lifetime", async () => {
    process.env.DEV_PRO_INSTALLS = DEV_INSTALL_A;
    const result = await checkDailyQuota(DEV_INSTALL_A);
    expect(result.tier).toBe("lifetime");
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(-1);
    expect(result.remaining).toBe(-1);
  });

  it("regular Free installs are also unlimited (feature gating only)", async () => {
    process.env.DEV_PRO_INSTALLS = DEV_INSTALL_A;
    // 200 scans — every one allowed under the new uncapped Free model.
    for (let i = 0; i < 200; i++) {
      const r = await checkDailyQuota(REGULAR_INSTALL);
      expect(r.allowed).toBe(true);
      expect(r.tier).toBe("free");
      expect(r.limit).toBe(-1);
    }
  });
});

describe("peekDailyQuota matches checkDailyQuota for dev installs", () => {
  it("returns unlimited for dev installs", async () => {
    process.env.DEV_PRO_INSTALLS = DEV_INSTALL_A;
    const result = await peekDailyQuota(DEV_INSTALL_A);
    expect(result.tier).toBe("lifetime");
    expect(result.limit).toBe(-1);
  });
});

describe("getEffectiveTier with X-Antares-Dev-Tier header", () => {
  it("dev install + valid header → header tier wins", async () => {
    process.env.DEV_PRO_INSTALLS = DEV_INSTALL_A;
    expect(await getEffectiveTier(DEV_INSTALL_A, "free")).toBe("free");
    expect(await getEffectiveTier(DEV_INSTALL_A, "pro")).toBe("pro");
    expect(await getEffectiveTier(DEV_INSTALL_A, "lifetime")).toBe("lifetime");
  });

  it("dev install + no header → default lifetime (DEV_PRO_INSTALLS shortcut)", async () => {
    process.env.DEV_PRO_INSTALLS = DEV_INSTALL_A;
    expect(await getEffectiveTier(DEV_INSTALL_A)).toBe("lifetime");
    expect(await getEffectiveTier(DEV_INSTALL_A, null)).toBe("lifetime");
  });

  it("dev install + invalid header → ignored, falls back to default", async () => {
    process.env.DEV_PRO_INSTALLS = DEV_INSTALL_A;
    expect(await getEffectiveTier(DEV_INSTALL_A, "admin")).toBe("lifetime");
    expect(await getEffectiveTier(DEV_INSTALL_A, "")).toBe("lifetime");
  });

  it("non-dev install + valid header → header IGNORED, normal tier read", async () => {
    process.env.DEV_PRO_INSTALLS = DEV_INSTALL_A;
    // Server trusts the header only for dev-listed installs.
    expect(await getEffectiveTier(REGULAR_INSTALL, "lifetime")).toBe("free");
    await setUserTier(REGULAR_INSTALL, "pro");
    expect(await getEffectiveTier(REGULAR_INSTALL, "lifetime")).toBe("pro");
  });

  it("array-shaped header (Vercel sometimes wraps) → first value used", async () => {
    process.env.DEV_PRO_INSTALLS = DEV_INSTALL_A;
    expect(
      await getEffectiveTier(DEV_INSTALL_A, ["pro", "ignored"]),
    ).toBe("pro");
  });

  it("header case-insensitive ('PRO' = 'pro')", async () => {
    process.env.DEV_PRO_INSTALLS = DEV_INSTALL_A;
    expect(await getEffectiveTier(DEV_INSTALL_A, "PRO")).toBe("pro");
    expect(await getEffectiveTier(DEV_INSTALL_A, "  Lifetime  ")).toBe("lifetime");
  });
});
