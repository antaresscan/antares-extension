import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Redis } from "@upstash/redis";
import {
  initUserStorage,
  getUserTier,
  setUserTier,
  pushScanHistory,
  getScanHistory,
  HISTORY_HARD_CAP,
  HISTORY_DAY_WINDOW,
  _resetUserStorageForTests,
  type ScanHistoryEntry,
} from "../api/_lib/user";

// ─── In-memory Redis mock ─────────────────────────────────────────────────────

interface MockStore {
  strings: Map<string, string>;
  lists: Map<string, string[]>;
  zsets: Map<string, Map<string, number>>;
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

