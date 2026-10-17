import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Redis } from "@upstash/redis";
import {
  initUserStorage,
  getUserTier,
  setUserTier,
  pushScanHistory,
  getScanHistory,
  isDevProInstall,
  getEffectiveTierFromRequest,
  resolveTier,
  HISTORY_HARD_CAP,
  HISTORY_DAY_WINDOW,
  _resetUserStorageForTests,
  type ScanHistoryEntry,
} from "../api/_lib/user";
import { signSession } from "../api/_lib/account";
import { SESSION_COOKIE_NAME } from "../api/_lib/session-cookie";

// ─── In-memory Redis mock ─────────────────────────────────────────────────────

interface MockStore {
  strings: Map<string, string>;
  lists: Map<string, string[]>;
  zsets: Map<string, Map<string, number>>;
  hashes: Map<string, Record<string, string>>;
  fail: boolean;
}

interface MockBundle {
  redis: Redis;
  store: MockStore;
  setFailing: (fail: boolean) => void;
}

function mockRedis(initialStrings: Record<string, string> = {}): MockBundle {
  const store: MockStore = {
    strings: new Map(Object.entries(initialStrings)),
    lists: new Map(),
    zsets: new Map(),
    hashes: new Map(),
    fail: false,
  };

  const guard = () => {
    if (store.fail) throw new Error("redis down");
  };

  const redis = {
    get: vi.fn(async (key: string) => {
      guard();
      return store.strings.get(key) ?? null;
    }),
    set: vi.fn(async (key: string, val: string | number) => {
      guard();
      store.strings.set(key, String(val));
      return "OK";
    }),
    del: vi.fn(async (...keys: string[]) => {
      guard();
      let n = 0;
      for (const key of keys) {
        const had =
          store.strings.delete(key) ||
          store.lists.delete(key) ||
          store.zsets.delete(key);
        if (had) n++;
      }
      return n;
    }),
    // MULTI/EXEC: the commands are queued, then applied all together when exec runs (none of them if Redis is down).
    multi: vi.fn(() => {
      const queued: Array<() => void> = [];
      const tx = {
        set: (key: string, val: string | number) => { queued.push(() => { store.strings.set(key, String(val)); }); return tx; },
        del: (key: string) => { queued.push(() => { store.strings.delete(key); }); return tx; },
        exec: async () => { guard(); for (const apply of queued) apply(); return queued.map(() => "OK"); },
      };
      return tx;
    }),
    lpush: vi.fn(async (key: string, ...values: string[]) => {
      guard();
      const list = store.lists.get(key) ?? [];
      for (const v of values) list.unshift(v);
      store.lists.set(key, list);
      return list.length;
    }),
    ltrim: vi.fn(async (key: string, start: number, end: number) => {
      guard();
      const list = store.lists.get(key);
      if (!list) return "OK";
      const realEnd = end < 0 ? list.length + end + 1 : end + 1;
      store.lists.set(key, list.slice(start, realEnd));
      return "OK";
    }),
    lrange: vi.fn(async (key: string, start: number, end: number) => {
      guard();
      const list = store.lists.get(key) ?? [];
      const realEnd = end < 0 ? list.length + end + 1 : end + 1;
      return list.slice(start, realEnd);
    }),
    zadd: vi.fn(async (key: string, arg: { score: number; member: string }) => {
      guard();
      const zset = store.zsets.get(key) ?? new Map();
      const isNew = !zset.has(arg.member);
      zset.set(arg.member, arg.score);
      store.zsets.set(key, zset);
      return isNew ? 1 : 0;
    }),
    zrem: vi.fn(async (key: string, member: string) => {
      guard();
      const zset = store.zsets.get(key);
      if (!zset) return 0;
      return zset.delete(member) ? 1 : 0;
    }),
    zrange: vi.fn(
      async (
        key: string,
        start: number,
        end: number,
        opts?: { withScores?: boolean },
      ) => {
        guard();
        const zset = store.zsets.get(key) ?? new Map<string, number>();
        const sorted = [...zset.entries()].sort((a, b) => a[1] - b[1]);
        const realEnd = end < 0 ? sorted.length + end + 1 : end + 1;
        const slice = sorted.slice(start, realEnd);
        if (opts?.withScores) {
          const flat: (string | number)[] = [];
          for (const [member, score] of slice) {
            flat.push(member);
            flat.push(score);
          }
          return flat;
        }
        return slice.map(([member]) => member);
      },
    ),
    zcard: vi.fn(async (key: string) => {
      guard();
      return store.zsets.get(key)?.size ?? 0;
    }),
    zscore: vi.fn(async (key: string, member: string) => {
      guard();
      return store.zsets.get(key)?.get(member) ?? null;
    }),
    hset: vi.fn(async (key: string, fields: Record<string, string>) => {
      guard();
      const existing = store.hashes.get(key) ?? {};
      store.hashes.set(key, { ...existing, ...fields });
      return Object.keys(fields).length;
    }),
    hgetall: vi.fn(async (key: string) => {
      guard();
      const v = store.hashes.get(key);
      return v ? { ...v } : null;
    }),
  } as unknown as Redis;

  return {
    redis,
    store,
    setFailing: (fail: boolean) => {
      store.fail = fail;
    },
  };
}

// Dev/founder allowlist is now env-var only (was previously hardcoded in
// api/_lib/account.ts). Tests that probe the bound-email allowlist path
// rely on this value being set before any account/user logic runs.
process.env.DEV_LIFETIME_EMAILS = "test-dev@example.com";
process.env.DEV_PRO_EMAILS = "test-dev@example.com";

beforeEach(() => {
  _resetUserStorageForTests();
});

// ─── Tier read / write ────────────────────────────────────────────────────────

describe("getUserTier", () => {
  it("returns 'free' when Redis is not configured", async () => {
    const tier = await getUserTier("install-x");
    expect(tier).toBe("free");
  });

  it("returns the stored tier when set", async () => {
    const m = mockRedis({ "user:install-pro:tier": "pro" });
    initUserStorage(m.redis);
    expect(await getUserTier("install-pro")).toBe("pro");
  });

  it("returns 'free' for unknown tier values (defensive)", async () => {
    const m = mockRedis({ "user:install-x:tier": "premium-plus-ultra" });
    initUserStorage(m.redis);
    expect(await getUserTier("install-x")).toBe("free");
  });

  it("downgrades expired Pro to free automatically", async () => {
    const past = Date.now() - 60_000;
    const m = mockRedis({
      "user:install-lapsed:tier": "pro",
      "user:install-lapsed:tierExpires": String(past),
    });
    initUserStorage(m.redis);
    expect(await getUserTier("install-lapsed")).toBe("free");
  });

  it("keeps Pro when expiry is in the future", async () => {
    const future = Date.now() + 60_000;
    const m = mockRedis({
      "user:install-active:tier": "pro",
      "user:install-active:tierExpires": String(future),
    });
    initUserStorage(m.redis);
    expect(await getUserTier("install-active")).toBe("pro");
  });

  it("keeps Lifetime indefinitely (no expiry)", async () => {
    const m = mockRedis({ "user:install-lifer:tier": "lifetime" });
    initUserStorage(m.redis);
    expect(await getUserTier("install-lifer")).toBe("lifetime");
  });

  it("returns 'free' on Redis error (safe fallback)", async () => {
    const m = mockRedis();
    m.setFailing(true);
    initUserStorage(m.redis);
    expect(await getUserTier("install-x")).toBe("free");
  });
});

describe("setUserTier", () => {
  it("writes tier and clears expiry for Lifetime", async () => {
    const m = mockRedis({ "user:install-x:tierExpires": "12345" });
    initUserStorage(m.redis);

    await setUserTier("install-x", "lifetime");

    expect(m.store.strings.get("user:install-x:tier")).toBe("lifetime");
    expect(m.store.strings.has("user:install-x:tierExpires")).toBe(false);
  });

  it("writes tier with expiry for time-bounded Pro", async () => {
    const m = mockRedis();
    initUserStorage(m.redis);

    const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
    await setUserTier("install-x", "pro", expiresAt);

    expect(m.store.strings.get("user:install-x:tier")).toBe("pro");
    expect(m.store.strings.get("user:install-x:tierExpires")).toBe(String(expiresAt));
  });

  it("clears tier and expiry when downgrading to free", async () => {
    const m = mockRedis({
      "user:install-x:tier": "pro",
      "user:install-x:tierExpires": "12345",
    });
    initUserStorage(m.redis);

    await setUserTier("install-x", "free");

    expect(m.store.strings.has("user:install-x:tier")).toBe(false);
    expect(m.store.strings.has("user:install-x:tierExpires")).toBe(false);
  });
});

// ─── Scan history ─────────────────────────────────────────────────────────────

const sampleEntry = (overrides: Partial<ScanHistoryEntry> = {}): ScanHistoryEntry => ({
  ca: "So11111111111111111111111111111111111111112",
  score: 850,
  verdict: "SAFE",
  scannedAt: Date.now(),
  ...overrides,
});

describe("pushScanHistory", () => {
  it("LPUSHes on every call and samples LTRIM at ~1% (Upstash audit 2026-05-11)", async () => {
    // Pre-2026-05-11 every push did 2 Redis commands: LPUSH + LTRIM.
    // The Upstash-budget audit deduced that LTRIM doesn't need to
    // fire every push — HISTORY_HARD_CAP is 1000 and a 1% sample
    // keeps worst-case overshoot bounded (~1010 entries) without
    // breaking the read-time filtering. This test pins the new
    // contract: LPUSH always fires; LTRIM is sampled, so we force
    // Math.random to return 0.5 (above the 1% threshold) and assert
    // it does NOT fire on this push.
    const m = mockRedis();
    initUserStorage(m.redis);

    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      await pushScanHistory("install-x", sampleEntry({ ca: "A".padEnd(43, "1") }));
      expect(m.redis.lpush).toHaveBeenCalledOnce();
      expect(m.redis.ltrim).not.toHaveBeenCalled();
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("LTRIM fires when the sample bucket lands (~1% of calls)", async () => {
    // Inverse of the above — force the random draw under the 1%
    // threshold and assert LTRIM does fire with the correct args.
    const m = mockRedis();
    initUserStorage(m.redis);

    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.005);
    try {
      await pushScanHistory("install-x", sampleEntry({ ca: "A".padEnd(43, "1") }));
      expect(m.redis.lpush).toHaveBeenCalledOnce();
      expect(m.redis.ltrim).toHaveBeenCalledWith(
        "user:install-x:history",
        0,
        HISTORY_HARD_CAP - 1,
      );
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("doesn't throw if Redis push fails", async () => {
    const m = mockRedis();
    m.setFailing(true);
    initUserStorage(m.redis);

    await expect(pushScanHistory("install-x", sampleEntry())).resolves.toBeUndefined();
  });

  it("is a no-op when storage is not initialised", async () => {
    await expect(pushScanHistory("install-x", sampleEntry())).resolves.toBeUndefined();
  });
});

describe("getScanHistory", () => {
  it("returns entries newest-first within the 30-day window", async () => {
    const m = mockRedis();
    initUserStorage(m.redis);

    const now = Date.now();
    await pushScanHistory("install-x", sampleEntry({ scannedAt: now - 10_000 }));
    await pushScanHistory("install-x", sampleEntry({ scannedAt: now - 5_000 }));
    await pushScanHistory("install-x", sampleEntry({ scannedAt: now }));

    const items = await getScanHistory("install-x");

    expect(items.length).toBe(3);
    // LPUSH prepends, so the list order on disk is [newest, ..., oldest]
    expect(items[0].scannedAt).toBe(now);
    expect(items[2].scannedAt).toBe(now - 10_000);
  });

  it("filters out entries older than the since cutoff", async () => {
    const m = mockRedis();
    initUserStorage(m.redis);

    const now = Date.now();
    const ancient = now - HISTORY_DAY_WINDOW * 24 * 60 * 60 * 1000 - 60_000;
    await pushScanHistory("install-x", sampleEntry({ scannedAt: ancient }));
    await pushScanHistory("install-x", sampleEntry({ scannedAt: now }));

    const items = await getScanHistory("install-x");

    expect(items.length).toBe(1);
    expect(items[0].scannedAt).toBe(now);
  });

  it("respects custom limit", async () => {
    const m = mockRedis();
    initUserStorage(m.redis);

    for (let i = 0; i < 10; i++) {
      await pushScanHistory("install-x", sampleEntry({ scannedAt: Date.now() - i * 1000 }));
    }

    const items = await getScanHistory("install-x", { limit: 3 });
    expect(items.length).toBe(3);
  });

  it("returns empty array if Redis fails", async () => {
    const m = mockRedis();
    m.setFailing(true);
    initUserStorage(m.redis);

    const items = await getScanHistory("install-x");
    expect(items).toEqual([]);
  });

  it("drops malformed entries silently", async () => {
    const m = mockRedis();
    initUserStorage(m.redis);

    // Inject one valid + one corrupt
    await pushScanHistory("install-x", sampleEntry());
    m.store.lists.get("user:install-x:history")!.push("{not json");

    const items = await getScanHistory("install-x");
    expect(items.length).toBe(1);
  });
});

// ─── Dev-tier override (env var + bound-email) ────────────────────────────────
//
// These tests cover the resolution chain that lets the founder flip
// Free/Pro/Lifetime from the extension Options dropdown without managing
// install_id UUIDs manually:
//   1. install_id in DEV_PRO_INSTALLS env var → allowlisted (legacy)
//   2. install_id has a bound email AND that email is dev-allowlisted → allowlisted
//   3. otherwise → header is ignored, fall back to stored tier

describe("isDevProInstall (env-var path)", () => {
  const origEnv = process.env.DEV_PRO_INSTALLS;

  afterEach(() => {
    if (origEnv === undefined) delete process.env.DEV_PRO_INSTALLS;
    else process.env.DEV_PRO_INSTALLS = origEnv;
  });

  it("returns false for empty installId", () => {
    expect(isDevProInstall("")).toBe(false);
  });

  it("returns false when env var is unset", () => {
    delete process.env.DEV_PRO_INSTALLS;
    expect(isDevProInstall("install-aaa")).toBe(false);
  });

  it("returns true for installs listed in env var", () => {
    process.env.DEV_PRO_INSTALLS = "install-aaa,install-bbb,install-ccc";
    expect(isDevProInstall("install-bbb")).toBe(true);
  });

  it("ignores whitespace around comma-separated values", () => {
    process.env.DEV_PRO_INSTALLS = "  install-aaa  ,  install-bbb  ";
    expect(isDevProInstall("install-aaa")).toBe(true);
    expect(isDevProInstall("install-bbb")).toBe(true);
  });
});

// (isDevAllowlistedInstall and getEffectiveTier were removed in the audit of 2026-10-17: nothing called them, and they read a tier
// without the session. The X-Antares-Dev-Tier header is tested through resolveTier below and through decideTier in entitlements.test.ts.)

// ─── Session-gated tier (the main production resolver) ────────────────────────
//
// `getEffectiveTierFromRequest` is what every HTTP handler calls. It
// resolves to:
//   - lifetime/header value if install is in DEV_PRO_INSTALLS env var
//   - free if no valid session cookie
//   - free if session valid but install bound to a different email
//   - free if session valid but install has no binding yet (needs redeem)
//   - stored install tier otherwise (or dev header for dev-allowlisted email)
//
// The "free if signed out" property is what makes "log out → I'm Free again"
// true server-side for everyone, paying customers included.

describe("getEffectiveTierFromRequest (session-gated)", () => {
  const ORIG_ENV = { ...process.env };

  beforeEach(() => {
    // signSession needs SESSION_SECRET; pad to 64 hex chars so verifySession
    // doesn't reject it.
    process.env.SESSION_SECRET = "0".repeat(64);
  });

  afterEach(() => {
    if (ORIG_ENV.DEV_PRO_INSTALLS === undefined) delete process.env.DEV_PRO_INSTALLS;
    else process.env.DEV_PRO_INSTALLS = ORIG_ENV.DEV_PRO_INSTALLS;
    if (ORIG_ENV.SESSION_SECRET === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = ORIG_ENV.SESSION_SECRET;
  });

  function reqWithCookie(token: string | null, devTier?: string) {
    const headers: Record<string, string | string[]> = {};
    if (token) headers.cookie = `${SESSION_COOKIE_NAME}=${token}`;
    if (devTier) headers["x-antares-dev-tier"] = devTier;
    return { headers } as unknown as Parameters<typeof getEffectiveTierFromRequest>[0];
  }

  function seedAccount(m: MockBundle, email: string) {
    // getAccount reads the hash; seed minimal fields (email + status active).
    m.store.hashes.set(`account:${email}`, {
      email,
      status: "active",
      emailVerified: "1",
      createdAt: String(Date.now()),
    });
  }

  it("returns 'free' when no cookie is present (signed-out user)", async () => {
    const m = mockRedis({
      "account:install:install-paid": "alice@example.com",
      "user:install-paid:tier": "lifetime",
    });
    initUserStorage(m.redis);
    seedAccount(m, "alice@example.com");

    expect(await getEffectiveTierFromRequest(reqWithCookie(null), "install-paid")).toBe("free");
  });

  it("returns stored tier when cookie matches install binding", async () => {
    const m = mockRedis({
      "account:install:install-paid": "alice@example.com",
      "user:install-paid:tier": "lifetime",
    });
    initUserStorage(m.redis);
    seedAccount(m, "alice@example.com");

    const token = signSession("alice@example.com");
    expect(await getEffectiveTierFromRequest(reqWithCookie(token), "install-paid")).toBe(
      "lifetime",
    );
  });

  it("returns 'free' when cookie email doesn't match install binding (anti-hijack)", async () => {
    const m = mockRedis({
      // Install was paid for by Bob.
      "account:install:install-bob": "bob@example.com",
      "user:install-bob:tier": "lifetime",
    });
    initUserStorage(m.redis);
    seedAccount(m, "bob@example.com");
    seedAccount(m, "eve@example.com");

    // Eve signs in on Bob's browser — should not get Bob's tier.
    const token = signSession("eve@example.com");
    expect(await getEffectiveTierFromRequest(reqWithCookie(token), "install-bob")).toBe("free");
  });

  it("returns 'free' when cookie is valid but install has no binding yet", async () => {
    // User signed up but never redeemed/linked an install.
    const m = mockRedis({});
    initUserStorage(m.redis);
    seedAccount(m, "alice@example.com");

    const token = signSession("alice@example.com");
    expect(await getEffectiveTierFromRequest(reqWithCookie(token), "install-fresh")).toBe(
      "free",
    );
  });

  it("env-var DEV_PRO_INSTALLS bypasses the session check", async () => {
    process.env.DEV_PRO_INSTALLS = "install-headless";
    const m = mockRedis({});
    initUserStorage(m.redis);

    // No cookie — would normally return Free. Env-var dev escape returns
    // yearly (was "lifetime" pre-2026-05; same unlimited dev access).
    expect(await getEffectiveTierFromRequest(reqWithCookie(null), "install-headless")).toBe(
      "yearly",
    );
  });

  it("env-var DEV_PRO_INSTALLS still honours dev-tier header for headless tests", async () => {
    process.env.DEV_PRO_INSTALLS = "install-headless";
    const m = mockRedis({});
    initUserStorage(m.redis);

    expect(await getEffectiveTierFromRequest(reqWithCookie(null, "free"), "install-headless")).toBe(
      "free",
    );
  });

  it("honours dev-tier header for signed-in dev-allowlisted email", async () => {
    const m = mockRedis({
      "account:install:install-dev": "test-dev@example.com",
      "user:install-dev:tier": "lifetime",
    });
    initUserStorage(m.redis);
    seedAccount(m, "test-dev@example.com");

    const token = signSession("test-dev@example.com");
    // Even though stored tier is lifetime, header forces Free.
    expect(
      await getEffectiveTierFromRequest(reqWithCookie(token, "free"), "install-dev"),
    ).toBe("free");
    expect(
      await getEffectiveTierFromRequest(reqWithCookie(token, "pro"), "install-dev"),
    ).toBe("pro");
  });

  it("ignores dev-tier header for signed-in non-dev email (anti-spoof)", async () => {
    const m = mockRedis({
      "account:install:install-paid": "alice@example.com",
      "user:install-paid:tier": "lifetime",
    });
    initUserStorage(m.redis);
    seedAccount(m, "alice@example.com");

    const token = signSession("alice@example.com");
    // Alice tries to send dev-tier=free; header is ignored, stored tier wins.
    expect(
      await getEffectiveTierFromRequest(reqWithCookie(token, "free"), "install-paid"),
    ).toBe("lifetime");
  });

  it("returns 'free' when storage is not initialised", async () => {
    // _resetUserStorageForTests already ran in beforeEach (top of file).
    const token = signSession("alice@example.com");
    expect(await getEffectiveTierFromRequest(reqWithCookie(token), "install-x")).toBe("free");
  });
});

// ─── Dev quota bypass (free tier unlimited for the founder/QA) ────────────────

describe("resolveTier (dev quota bypass)", () => {
  const ORIG_ENV = { ...process.env };

  beforeEach(() => {
    process.env.SESSION_SECRET = "0".repeat(64);
  });

  afterEach(() => {
    if (ORIG_ENV.DEV_PRO_INSTALLS === undefined) delete process.env.DEV_PRO_INSTALLS;
    else process.env.DEV_PRO_INSTALLS = ORIG_ENV.DEV_PRO_INSTALLS;
    if (ORIG_ENV.SESSION_SECRET === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = ORIG_ENV.SESSION_SECRET;
  });

  function reqWithCookie(token: string | null, devTier?: string) {
    const headers: Record<string, string | string[]> = {};
    if (token) headers.cookie = `${SESSION_COOKIE_NAME}=${token}`;
    if (devTier) headers["x-antares-dev-tier"] = devTier;
    return { headers } as unknown as Parameters<typeof resolveTier>[0];
  }

  function seedAccount(m: MockBundle, email: string) {
    m.store.hashes.set(`account:${email}`, {
      email,
      status: "active",
      emailVerified: "1",
      createdAt: String(Date.now()),
    });
  }

  it("an env-var dev install is Yearly (legacy headless path)", async () => {
    process.env.DEV_PRO_INSTALLS = "install-headless";
    const m = mockRedis({});
    initUserStorage(m.redis);

    const result = await resolveTier(reqWithCookie(null), "install-headless");
    // No header + env-var dev → getUserTier short-circuits to yearly (was
    // "lifetime" pre-2026-05; rename keeps the same dev-unlimited semantics)
    expect(result.tier).toBe("yearly");
  });

  it("a signed-in dev-allowlisted email gets the Yearly grant", async () => {
    const m = mockRedis({
      "account:install:install-dev": "test-dev@example.com",
      // Stored tier is "yearly" (the new dev-grant tier post-2026-05).
      "user:install-dev:tier": "yearly",
    });
    initUserStorage(m.redis);
    seedAccount(m, "test-dev@example.com");

    const token = signSession("test-dev@example.com");
    const result = await resolveTier(reqWithCookie(token), "install-dev");
    expect(result.tier).toBe("yearly");
  });

  it("a dev forcing Free from the Options dropdown is Free (so the overlay locks)", async () => {
    const m = mockRedis({
      "account:install:install-dev": "test-dev@example.com",
      "user:install-dev:tier": "lifetime",
    });
    initUserStorage(m.redis);
    seedAccount(m, "test-dev@example.com");

    const token = signSession("test-dev@example.com");
    // Dev sets dropdown to Free → tier reports as Free (so overlay locks).
    const result = await resolveTier(reqWithCookie(token, "free"), "install-dev");
    expect(result.tier).toBe("free");
  });

  it("a signed-in non-dev user gets the tier they paid for", async () => {
    const m = mockRedis({
      "account:install:install-paid": "alice@example.com",
      "user:install-paid:tier": "lifetime",
    });
    initUserStorage(m.redis);
    seedAccount(m, "alice@example.com");

    const token = signSession("alice@example.com");
    const result = await resolveTier(reqWithCookie(token), "install-paid");
    expect(result.tier).toBe("lifetime");
  });

  it("a signed-out user is Free, whatever tier the install has stored", async () => {
    const m = mockRedis({
      "account:install:install-paid": "alice@example.com",
      "user:install-paid:tier": "lifetime",
    });
    initUserStorage(m.redis);

    const result = await resolveTier(reqWithCookie(null), "install-paid");
    expect(result.tier).toBe("free");
  });
});

