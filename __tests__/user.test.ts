import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Redis } from "@upstash/redis";
import {
  initUserStorage,
  getUserTier,
  setUserTier,
  pushScanHistory,
  getScanHistory,
  isDevProInstall,
  isDevAllowlistedInstall,
  getEffectiveTier,
  getEffectiveTierFromRequest,
  resolveTierAndBypass,
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
    del: vi.fn(async (key: string) => {
      guard();
      const had =
        store.strings.delete(key) ||
        store.lists.delete(key) ||
        store.zsets.delete(key);
      return had ? 1 : 0;
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
  it("LPUSHes the JSON entry and trims to HISTORY_HARD_CAP", async () => {
    const m = mockRedis();
    initUserStorage(m.redis);

    await pushScanHistory("install-x", sampleEntry({ ca: "A".padEnd(43, "1") }));

    expect(m.redis.lpush).toHaveBeenCalledOnce();
    expect(m.redis.ltrim).toHaveBeenCalledWith(
      "user:install-x:history",
      0,
      HISTORY_HARD_CAP - 1,
    );
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

describe("isDevAllowlistedInstall (env-var + bound-email path)", () => {
  const origEnv = process.env.DEV_PRO_INSTALLS;

  afterEach(() => {
    if (origEnv === undefined) delete process.env.DEV_PRO_INSTALLS;
    else process.env.DEV_PRO_INSTALLS = origEnv;
  });

  it("returns true for installs listed directly in DEV_PRO_INSTALLS", async () => {
    process.env.DEV_PRO_INSTALLS = "install-direct";
    // No Redis needed — env-var path short-circuits.
    expect(await isDevAllowlistedInstall("install-direct")).toBe(true);
  });

  it("returns true for installs whose bound email is in DEV_LIFETIME_EMAILS_HARDCODED", async () => {
    delete process.env.DEV_PRO_INSTALLS;
    const m = mockRedis({
      // The reverse-index key written by license redeem.
      "account:install:install-bound-lifetime": "lennypierrepro@gmail.com",
    });
    initUserStorage(m.redis);
    expect(await isDevAllowlistedInstall("install-bound-lifetime")).toBe(true);
  });

  it("returns false for installs with no bound email and not in env var", async () => {
    delete process.env.DEV_PRO_INSTALLS;
    const m = mockRedis(); // no account:install:* key
    initUserStorage(m.redis);
    expect(await isDevAllowlistedInstall("install-unknown")).toBe(false);
  });

  it("returns false for installs whose bound email is NOT in any dev allowlist", async () => {
    delete process.env.DEV_PRO_INSTALLS;
    const m = mockRedis({
      "account:install:install-bound-random": "random-user@example.com",
    });
    initUserStorage(m.redis);
    expect(await isDevAllowlistedInstall("install-bound-random")).toBe(false);
  });

  it("returns false for empty installId without touching Redis", async () => {
    const m = mockRedis();
    initUserStorage(m.redis);
    expect(await isDevAllowlistedInstall("")).toBe(false);
    expect(m.redis.get).not.toHaveBeenCalled();
  });

  it("returns false (fail-closed) when Redis throws", async () => {
    delete process.env.DEV_PRO_INSTALLS;
    const m = mockRedis();
    m.setFailing(true);
    initUserStorage(m.redis);
    expect(await isDevAllowlistedInstall("install-anything")).toBe(false);
  });

  it("returns false when storage is not initialised", async () => {
    delete process.env.DEV_PRO_INSTALLS;
    // _resetUserStorageForTests already ran in beforeEach
    expect(await isDevAllowlistedInstall("install-anything")).toBe(false);
  });
});

describe("getEffectiveTier (header honoured for dev-allowlisted installs)", () => {
  const origEnv = process.env.DEV_PRO_INSTALLS;

  afterEach(() => {
    if (origEnv === undefined) delete process.env.DEV_PRO_INSTALLS;
    else process.env.DEV_PRO_INSTALLS = origEnv;
  });

  it("honours X-Antares-Dev-Tier header for env-var dev installs", async () => {
    process.env.DEV_PRO_INSTALLS = "install-dev";
    expect(await getEffectiveTier("install-dev", "free")).toBe("free");
    expect(await getEffectiveTier("install-dev", "pro")).toBe("pro");
    expect(await getEffectiveTier("install-dev", "lifetime")).toBe("lifetime");
  });

  it("honours the header for bound-email dev installs", async () => {
    delete process.env.DEV_PRO_INSTALLS;
    const m = mockRedis({
      "account:install:install-bound": "lennypierrepro@gmail.com",
      // Stored tier is pro, but header says free → header should win.
      "user:install-bound:tier": "pro",
    });
    initUserStorage(m.redis);
    expect(await getEffectiveTier("install-bound", "free")).toBe("free");
    expect(await getEffectiveTier("install-bound", "lifetime")).toBe("lifetime");
  });

  it("ignores the header for non-allowlisted installs (anti-spoofing)", async () => {
    delete process.env.DEV_PRO_INSTALLS;
    const m = mockRedis({
      // Install has stored tier=free, but a malicious request claims lifetime.
      "user:install-attacker:tier": "free",
    });
    initUserStorage(m.redis);
    expect(await getEffectiveTier("install-attacker", "lifetime")).toBe("free");
    expect(await getEffectiveTier("install-attacker", "pro")).toBe("free");
  });

  it("ignores invalid header values from dev installs (defensive)", async () => {
    process.env.DEV_PRO_INSTALLS = "install-dev";
    // Garbage header → should fall through to getUserTier (yearly for dev installs)
    expect(await getEffectiveTier("install-dev", "premium-plus-ultra")).toBe("yearly");
  });

  it("defaults to stored tier when no header is provided", async () => {
    process.env.DEV_PRO_INSTALLS = "install-dev";
    expect(await getEffectiveTier("install-dev")).toBe("yearly");
    expect(await getEffectiveTier("install-dev", null)).toBe("yearly");
    expect(await getEffectiveTier("install-dev", undefined)).toBe("yearly");
  });

  it("normalises array headers (Vercel multi-value form) to first value", async () => {
    process.env.DEV_PRO_INSTALLS = "install-dev";
    expect(await getEffectiveTier("install-dev", ["free", "pro"])).toBe("free");
  });
});

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
      emailVerified: "0",
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
      "account:install:install-dev": "lennypierrepro@gmail.com",
      "user:install-dev:tier": "lifetime",
    });
    initUserStorage(m.redis);
    seedAccount(m, "lennypierrepro@gmail.com");

    const token = signSession("lennypierrepro@gmail.com");
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

describe("resolveTierAndBypass (dev quota bypass)", () => {
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
    return { headers } as unknown as Parameters<typeof resolveTierAndBypass>[0];
  }

  function seedAccount(m: MockBundle, email: string) {
    m.store.hashes.set(`account:${email}`, {
      email,
      status: "active",
      emailVerified: "0",
      createdAt: String(Date.now()),
    });
  }

  it("bypassQuota=true for env-var dev installs (legacy headless path)", async () => {
    process.env.DEV_PRO_INSTALLS = "install-headless";
    const m = mockRedis({});
    initUserStorage(m.redis);

    const result = await resolveTierAndBypass(reqWithCookie(null), "install-headless");
    expect(result.bypassQuota).toBe(true);
    // No header + env-var dev → getUserTier short-circuits to yearly (was
    // "lifetime" pre-2026-05; rename keeps the same dev-unlimited semantics)
    expect(result.tier).toBe("yearly");
  });

  it("bypassQuota=true for signed-in dev-allowlisted email (Yearly grant)", async () => {
    const m = mockRedis({
      "account:install:install-dev": "lennypierrepro@gmail.com",
      // Stored tier is "yearly" (the new dev-grant tier post-2026-05).
      "user:install-dev:tier": "yearly",
    });
    initUserStorage(m.redis);
    seedAccount(m, "lennypierrepro@gmail.com");

    const token = signSession("lennypierrepro@gmail.com");
    const result = await resolveTierAndBypass(reqWithCookie(token), "install-dev");
    expect(result.bypassQuota).toBe(true);
    expect(result.tier).toBe("yearly");
  });

  it("dev forcing Free still bypasses quota (the use case from the user)", async () => {
    const m = mockRedis({
      "account:install:install-dev": "lennypierrepro@gmail.com",
      "user:install-dev:tier": "lifetime",
    });
    initUserStorage(m.redis);
    seedAccount(m, "lennypierrepro@gmail.com");

    const token = signSession("lennypierrepro@gmail.com");
    // Dev sets dropdown to Free → tier reports as Free (so overlay locks),
    // but bypassQuota is still true (so no 429 hit on every scan).
    const result = await resolveTierAndBypass(reqWithCookie(token, "free"), "install-dev");
    expect(result.tier).toBe("free");
    expect(result.bypassQuota).toBe(true);
  });

  it("bypassQuota=false for signed-in non-dev users (paying customers)", async () => {
    const m = mockRedis({
      "account:install:install-paid": "alice@example.com",
      "user:install-paid:tier": "lifetime",
    });
    initUserStorage(m.redis);
    seedAccount(m, "alice@example.com");

    const token = signSession("alice@example.com");
    const result = await resolveTierAndBypass(reqWithCookie(token), "install-paid");
    expect(result.bypassQuota).toBe(false);
    expect(result.tier).toBe("lifetime");
  });

  it("bypassQuota=false for signed-out users (Free with real quota)", async () => {
    const m = mockRedis({
      "account:install:install-paid": "alice@example.com",
      "user:install-paid:tier": "lifetime",
    });
    initUserStorage(m.redis);

    const result = await resolveTierAndBypass(reqWithCookie(null), "install-paid");
    expect(result.bypassQuota).toBe(false);
    expect(result.tier).toBe("free");
  });
});

